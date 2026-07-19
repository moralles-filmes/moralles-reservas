// Aplicador de I/O dos efeitos de negócio decididos em asaas-billing-events.ts.
//
// Arquivo IRMÃO, não seção do mesmo arquivo: `npm run test -- asaas-billing-events`
// (Task 6, Step 2) provou que o import `https://esm.sh/@supabase/supabase-js` —
// mesmo só de tipo — quebra a resolução do Vite quando vive no MESMO módulo que
// o núcleo puro importado por src/lib/asaas-billing-events.test.ts ("Only URLs
// with a scheme in: file and data are supported by the default ESM loader").
// Mesmo particionamento que existe entre asaas-core.ts (puro) e asaas.ts (I/O)
// — razão de aquele par existir, replicada aqui.
//
// COMPARTILHADO por asaas-webhook e process-asaas-reconcile de propósito: os
// dois chamam `applyAsaasEvent` e não podem divergir na lógica de aplicação.
// NUNCA importado por src/.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  decideEventEffect,
  parseExternalReference,
  type AsaasEffectKind,
  type AsaasPurpose,
} from "./asaas-billing-events.ts";
import { getBillingProvider } from "./billing-provider.ts";
import { asaasValueToCents } from "./asaas-core.ts";
import { jsonLog } from "./security.ts";

export interface BillingEventRow {
  id: string;
  provider_event_id: string;
  event_type: string;
  data: Record<string, unknown> | null;
  organization_id: string | null;
}

export interface ApplyResult {
  status: "processed" | "failed" | "ignored";
  organizationId: string | null;
  effect: AsaasEffectKind;
  error?: string;
}

/** Espelha o CHECK de billing_subscriptions.payment_method (migration 20260528000000). */
type PaymentMethod = "card" | "pix" | "boleto";

const PAYMENT_METHOD_BY_BILLING_TYPE: Readonly<Record<string, PaymentMethod>> = {
  CREDIT_CARD: "card",
  PIX: "pix",
  BOLETO: "boleto",
};

/**
 * `billingType` do payload do Asaas → CHECK `card|pix|boleto`. ESTRITO: devolve
 * `null` para `UNDEFINED`/ausente em vez de chutar, porque o valor é lido por
 * humano no painel (`PAYMENT_METHOD_LABEL` em src/pages/platform/BillingDetail.tsx
 * e Billing.tsx) — chute vira informação errada na tela.
 *
 * O fallback `'card'` é aplicado SÓ no caminho de assinatura, onde ele é regra
 * de produto e não palpite: o checkout `RECURRENT` do Asaas recusa os outros
 * métodos (§13 da doc), então `UNDEFINED` ali só pode ter sido cartão. Em
 * cobrança avulsa (recarga de IA via PIX, por ex.) esse fallback seria falso,
 * e a coluna de `billing_invoices` é nullable justamente para isso.
 */
function mapPaymentMethod(billingType: unknown): PaymentMethod | null {
  if (typeof billingType === "string") {
    return PAYMENT_METHOD_BY_BILLING_TYPE[billingType] ?? null;
  }
  return null;
}

/** Extrai o id do payment do envelope. Shape não é uniforme entre categorias (§3). */
function extractPaymentId(data: Record<string, unknown> | null): string | null {
  const payment = data?.payment;
  if (typeof payment === "string") return payment;
  if (payment && typeof payment === "object") {
    const id = (payment as { id?: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

/**
 * Falha ALTA: devolve `failed` para o evento continuar na fila e o reconcile
 * reprocessar. Nunca vaza `error.message` do Postgres pro chamador — o detalhe
 * vai pro jsonLog.
 */
function failWith(
  organizationId: string | null,
  effect: AsaasEffectKind,
  step: string,
  detail: unknown,
  clientMessage: string,
): ApplyResult {
  jsonLog("error", {
    evt: "asaas_apply_write_failed",
    step,
    organization_id: organizationId,
    effect,
    error: String(detail),
  });
  return { status: "failed", organizationId, effect, error: clientMessage };
}

/**
 * Aplica o efeito de negócio de um evento Asaas já persistido.
 *
 * NUNCA lança: todo caminho de erro vira `{status:'failed'}`, porque o webhook
 * precisa responder 200 (a linha já está durável e o reconcile reprocessa) e o
 * reconcile precisa continuar o lote.
 *
 * INVARIANTE: `processed` significa "o efeito foi aplicado de verdade". Toda
 * escrita que é pré-requisito do resultado tem o `error` checado e degrada para
 * `failed` — senão um UPDATE que falhou por timeout tira o evento da fila e
 * deixa o cliente que pagou bloqueado, sem rastro.
 */
export async function applyAsaasEvent(
  supabase: SupabaseClient,
  row: BillingEventRow,
): Promise<ApplyResult> {
  try {
    const paymentId = extractPaymentId(row.data);

    // 1. Buscar a invoice que já conhecemos deste pagamento, se houver.
    let invoice: {
      id: string;
      status: string;
      organization_id: string;
      billing_subscription_id: string | null;
      amount_cents: number;
    } | null = null;

    if (paymentId) {
      // `error` checado: um erro aqui devolveria `data:null`, que o código
      // abaixo leria como "invoice não existe" e criaria uma segunda linha —
      // exatamente o que a idempotência do 2º evento do cartão depende de não
      // acontecer.
      const { data, error } = await supabase
        .from("billing_invoices")
        .select("id, status, organization_id, billing_subscription_id, amount_cents")
        .eq("provider", "asaas")
        .eq("provider_payment_id", paymentId)
        .maybeSingle();
      if (error) {
        return failWith(
          row.organization_id,
          "unknown",
          "select_invoice",
          error,
          "Falha ao consultar a fatura do evento — ver logs.",
        );
      }
      invoice = data ?? null;
    }

    // 2. Decidir o efeito (puro). ANTECIPADO de propósito para antes do I/O do
    //    Asaas: `decideEventEffect` só depende de `row.event_type` e do status
    //    da invoice, ambos já em mãos aqui. Ter o efeito antes do `getPayment`
    //    é o que permite graduar a severidade de uma falha daquela chamada —
    //    sem isso, todo erro do Asaas teria que ser tratado igual.
    //
    //    NÃO passa status de assinatura — `decideEventEffect` não branchia
    //    nele (removido do input na revisão da Task 5).
    const effect = decideEventEffect({
      eventType: row.event_type,
      invoiceStatus: invoice?.status ?? null,
    });

    // 3. Resolver a organização. Ordem real de precedência: coluna
    //    `organization_id` da própria linha do evento → invoice já conhecida →
    //    externalReference do payment → customer Asaas.
    let organizationId = row.organization_id ?? invoice?.organization_id ?? null;
    let planId: string | null = null;
    // Default deliberado: sem externalReference legível, tratamos como
    // "other" — que NÃO concede acesso. Errar para o lado de não liberar.
    let purpose: AsaasPurpose = "other";
    let externalReferenceRaw: string | null = null;
    let paidValueCents: number | null = null;
    let paymentMethod: PaymentMethod | null = null;
    let providerSubscriptionId: string | null = null;

    if (paymentId) {
      const provider = getBillingProvider("asaas");
      const res = await provider.getPayment(paymentId);
      if (res.ok && res.data) {
        if (typeof res.data.externalReference === "string") {
          externalReferenceRaw = res.data.externalReference;
        }
        const parsed = parseExternalReference(res.data.externalReference);
        if (parsed) {
          organizationId = organizationId ?? parsed.orgId;
          planId = parsed.planId;
          purpose = parsed.purpose;
        }

        paymentMethod = mapPaymentMethod(res.data.billingType);

        // §13.6: cobrança gerada por assinatura traz `subscription: "sub_…"`;
        // cobrança avulsa OMITE o campo (não vem `null`). Daí o typeof guard.
        const subRef = res.data.subscription;
        if (typeof subRef === "string" && subRef) {
          providerSubscriptionId = subRef;
        }

        // getPayment devolve payload CRU do Asaas: `value` é em REAIS.
        // Comparar com amount_cents sem converter é bug de 100x.
        // `asaasValueToCents` LANÇA em NaN/negativo e `typeof === "number"`
        // deixa NaN passar — sem este guard, um `value` corrompido derrubaria
        // o evento inteiro no catch genérico.
        const rawValue = res.data.value;
        if (typeof rawValue === "number" && Number.isFinite(rawValue) && rawValue >= 0) {
          paidValueCents = asaasValueToCents(rawValue);
        } else {
          // Campo AUSENTE também loga: num PAYMENT_RECEIVED, `value` não vir é
          // anomalia de payload tão relevante quanto um NaN, e o silêncio
          // esconderia a causa do `missing_payment_value` logo adiante.
          jsonLog("warn", {
            evt: "asaas_payment_value_invalid",
            payment_id: paymentId,
            raw_value: rawValue === undefined ? "ausente" : String(rawValue),
          });
        }

        if (!organizationId) {
          const customerRef = res.data.customer;
          if (typeof customerRef === "string" && customerRef) {
            const { data: cust, error: custErr } = await supabase
              .from("billing_customers")
              .select("organization_id")
              .eq("asaas_customer_id", customerRef)
              .maybeSingle();
            if (custErr) {
              return failWith(
                null,
                "unknown",
                "select_customer_by_asaas_id",
                custErr,
                "Falha ao correlacionar o cliente do evento — ver logs.",
              );
            }
            organizationId = cust?.organization_id ?? null;
          }
        }
      } else if (effect.kind === "activate_subscription") {
        // Indisponibilidade do Asaas (rede, 5xx, token expirado) NÃO pode virar
        // `processed`. Sem o payload, `purpose` fica no default "other",
        // `paidValueCents` e `planId` ficam `null` — e o `purpose !==
        // "subscription"` mais abaixo daria `break` ANTES de ativar a
        // assinatura e antes de tocar `organizations.billing_status`. O evento
        // sairia da fila com o cliente pago e bloqueado, sem rastro.
        //
        // Sem invoice prévia é pior: o INSERT gravaria `amount_cents` errado e
        // `purpose:'other'` sob o UNIQUE (provider, provider_payment_id), e
        // qualquer reprocessamento futuro reencontraria `status='paid'` →
        // `noop` → `processed`. Envenenamento permanente, sem auto-cura.
        //
        // Falha SÓ neste efeito: só a ativação depende do payload. Derrubar
        // também um `PAYMENT_CREATED` informativo (ou um `PAYMENT_OVERDUE`,
        // que não lê nada do payment) transformaria ruído em `failed` e
        // inflaria a fila do reconcile à toa.
        return failWith(
          organizationId,
          effect.kind,
          "get_payment",
          res.error ?? "getPayment devolveu ok sem data",
          "Falha ao consultar o pagamento no Asaas — ver logs.",
        );
      }
    }

    // 4. Estado atual da assinatura da org.
    let subscription: { id: string; status: string } | null = null;
    if (organizationId) {
      // `error` checado: `maybeSingle()` devolve PGRST116 quando casa MAIS de
      // uma linha. Só destruturar `data` transformaria "duas assinaturas
      // não-canceladas" em `null` — e o código abaixo inseriria uma terceira.
      // Ambiguidade é falha, não vazio.
      const { data, error } = await supabase
        .from("billing_subscriptions")
        .select("id, status")
        .eq("organization_id", organizationId)
        .neq("status", "canceled")
        .maybeSingle();
      if (error) {
        return failWith(
          organizationId,
          "unknown",
          "select_subscription",
          error,
          "Falha ao consultar a assinatura da organização — ver logs.",
        );
      }
      subscription = data ?? null;
    }

    // 5. Portões do efeito já decidido no passo 2. Ficam AQUI, e não junto da
    //    decisão, para que `organizationId` reportado no retorno seja o
    //    resolvido por completo (invoice → externalReference → customer).
    if (effect.kind === "unknown") {
      return { status: "ignored", organizationId, effect: effect.kind, error: effect.reason };
    }
    if (effect.kind === "noop") {
      return { status: "processed", organizationId, effect: effect.kind };
    }
    if (!organizationId) {
      return {
        status: "failed",
        organizationId: null,
        effect: effect.kind,
        error: "Não foi possível correlacionar o evento a uma organização.",
      };
    }

    // 6. Executar. Transições por UPDATE CONDICIONAL — o `.neq`/`.eq` no status
    //    anterior é o que garante idempotência sob concorrência (webhook e
    //    reconcile podem tocar a mesma linha).
    switch (effect.kind) {
      case "activate_subscription": {
        // Sem `payment.id` no envelope, TUDO abaixo vira no-op silencioso:
        // `invoice` é null e o `else if (paymentId)` não dispara, então o
        // dinheiro não é registrado; `purpose` fica no default "other" e o
        // `break` mais abaixo pula a ativação. O evento sairia daqui como
        // `processed`, fora da fila do reconcile, com o cliente pago e sem
        // acesso — e sem invoice paga nenhum reprocessamento futuro se
        // corrigiria. `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED` SEMPRE trazem o
        // `payment` (§3), então isto é payload anômalo: falha ALTO pra linha
        // continuar na fila. Guard só neste efeito — `mark_invoice_overdue` sem
        // invoice correlacionada é no-op POR CONTRATO (obrigação 3 do JSDoc de
        // decideEventEffect), não anomalia.
        if (!paymentId) {
          return failWith(
            organizationId,
            effect.kind,
            "missing_payment_id",
            `evento ${row.event_type} sem 'payment.id' no envelope`,
            "Evento de pagamento sem identificador da cobrança — ver logs.",
          );
        }

        // OBRIGAÇÃO 1 do contrato (JSDoc de decideEventEffect): registrar o
        // dinheiro SEMPRE — inclusive criando a linha quando ela não existe.
        // A idempotência do 2º evento do cartão (CONFIRMED e depois RECEIVED,
        // até ~30 dias) depende INTEIRAMENTE desta escrita: sem ela o segundo
        // evento reencontra a invoice não-paga e ativa de novo. Por isso o
        // `error` derruba o evento para `failed` em vez de seguir.
        if (invoice) {
          const { error: updErr } = await supabase
            .from("billing_invoices")
            .update({ status: "paid", paid_at: new Date().toISOString() })
            .eq("id", invoice.id)
            .neq("status", "paid");
          if (updErr) {
            return failWith(
              organizationId,
              effect.kind,
              "update_invoice_paid",
              updErr,
              "Falha ao registrar o pagamento da fatura — ver logs.",
            );
          }

          if (paidValueCents !== null && paidValueCents !== invoice.amount_cents) {
            jsonLog("error", {
              evt: "asaas_amount_divergence",
              invoice_id: invoice.id,
              expected_cents: invoice.amount_cents,
              paid_cents: paidValueCents,
            });
          }
        } else {
          // `paymentId` é não-nulo aqui — garantido pelo guard no topo do case.
          // Sem linha prévia — caso normal de renovação, porque PAYMENT_CREATED
          // é informativo e não cria invoice. `provider_payment_id` tem UNIQUE
          // parcial, então uma corrida entre webhook e reconcile vira 23505 e
          // não linha duplicada.
          //
          // Sem valor legível NÃO se insere: `status:'paid'` é terminal para
          // `decideEventEffect`, então uma fatura de R$ 0,00 nunca seria
          // revisitada e o valor nunca seria corrigido. Registrar zero é pior
          // que não registrar — `failed` mantém o evento na fila e o reconcile
          // retenta quando o payload voltar íntegro. (Diferente da DIVERGÊNCIA
          // de valor com invoice existente logo acima, que só loga de
          // propósito: lá o valor conhecido é o nosso, não um chute.)
          if (paidValueCents === null) {
            return failWith(
              organizationId,
              effect.kind,
              "missing_payment_value",
              `payment ${paymentId} sem 'value' numérico utilizável`,
              "Pagamento sem valor legível para registrar a fatura — ver logs.",
            );
          }

          const { error: insertErr } = await supabase.from("billing_invoices").insert({
            organization_id: organizationId,
            billing_subscription_id: subscription?.id ?? null,
            provider: "asaas",
            provider_payment_id: paymentId,
            purpose,
            external_reference: externalReferenceRaw,
            status: "paid",
            amount_cents: paidValueCents,
            // Coluna tem default 'brl' minúsculo — gravar "BRL" criaria duas
            // grafias pra mesma moeda.
            currency: "brl",
            payment_method: paymentMethod,
            paid_at: new Date().toISOString(),
          });
          // 23505 = corrida ganha pelo irmão; a linha existe e está paga.
          if (insertErr && insertErr.code !== "23505") {
            return failWith(
              organizationId,
              effect.kind,
              "insert_invoice_paid",
              insertErr,
              "Falha ao registrar a fatura paga — ver logs.",
            );
          }
        }

        // OBRIGAÇÃO 2 do contrato: conceder acesso SOMENTE quando o pagamento
        // for de assinatura do sistema. Um pacote de IA ou uma taxa de
        // implantação registram dinheiro mas NÃO liberam o sistema — senão uma
        // org inadimplente compraria R$ 50 de crédito e voltaria a ter acesso.
        if (purpose !== "subscription") {
          break;
        }

        if (subscription) {
          const { error: subErr } = await supabase
            .from("billing_subscriptions")
            .update({ status: "active" })
            .eq("id", subscription.id)
            .neq("status", "active");
          if (subErr) {
            return failWith(
              organizationId,
              effect.kind,
              "update_subscription_active",
              subErr,
              "Falha ao ativar a assinatura — ver logs.",
            );
          }

          // Backfill do `provider_subscription_id`: a assinatura criada pelo
          // checkout pode não tê-lo (§13.6 — o Asaas só expõe o `sub_…` na
          // cobrança gerada), e este é o instante em que ele está em mãos.
          // Sem isto a coluna fica `null` para sempre.
          //
          // UPDATE SEPARADO porque o de status acima é condicional em
          // `.neq('status','active')`: numa assinatura já ativa ele não afeta
          // linha nenhuma e o backfill nunca aconteceria. O `.is(..., null)`
          // torna este write idempotente e impede sobrescrever id existente.
          if (providerSubscriptionId) {
            const { error: backfillErr } = await supabase
              .from("billing_subscriptions")
              .update({ provider_subscription_id: providerSubscriptionId })
              .eq("id", subscription.id)
              .is("provider_subscription_id", null);
            if (backfillErr) {
              // NÃO derruba o evento: id de correlação não é pré-requisito do
              // acesso — a fatura já está paga e a assinatura já está ativa.
              // Devolver `failed` aqui faria o reconcile reexecutar tudo por
              // causa de um campo cosmético. Loga e segue.
              jsonLog("warn", {
                evt: "asaas_subscription_backfill_failed",
                organization_id: organizationId,
                subscription_id: subscription.id,
                error: String(backfillErr),
              });
            }
          }
        } else {
          // Criar assinatura exige DOIS pais NOT NULL (`billing_customer_id` e
          // `billing_plan_id`, migration 20260528000000 PART 4). Sem qualquer um
          // deles a linha é impossível: `?? null` daria 23502 e um planId
          // inválido daria 23503. Falhar ALTO e deixar o reconcile retentar é a
          // única saída correta — inserir nulo não é opção, e seguir para a
          // ativação daria acesso a uma org SEM assinatura, com o evento
          // marcado como resolvido para sempre.
          if (!planId) {
            return failWith(
              organizationId,
              effect.kind,
              "missing_plan_id",
              `externalReference sem plano (raw=${externalReferenceRaw ?? "ausente"})`,
              "Pagamento de assinatura sem plano identificável — ver logs.",
            );
          }

          const { data: customer, error: custErr } = await supabase
            .from("billing_customers")
            .select("id")
            .eq("organization_id", organizationId)
            .maybeSingle();
          if (custErr) {
            return failWith(
              organizationId,
              effect.kind,
              "select_billing_customer",
              custErr,
              "Falha ao consultar o cadastro de cobrança — ver logs.",
            );
          }
          if (!customer) {
            return failWith(
              organizationId,
              effect.kind,
              "missing_billing_customer",
              "organização sem linha em billing_customers",
              "Organização sem cadastro de cobrança — ver logs.",
            );
          }

          const { error: insErr } = await supabase.from("billing_subscriptions").insert({
            organization_id: organizationId,
            billing_customer_id: customer.id,
            billing_plan_id: planId,
            provider: "asaas",
            // Vem do `payment.subscription` do payload (§13.6). Em cobrança
            // avulsa o campo é omitido e fica null — a coluna é nullable e o
            // UNIQUE (provider, provider_subscription_id) é parcial.
            provider_subscription_id: providerSubscriptionId,
            status: "active",
            // Coluna NOT NULL — aqui o fallback 'card' é regra de produto
            // (checkout RECURRENT só aceita cartão), não chute.
            payment_method: paymentMethod ?? "card",
          });
          if (insErr) {
            return failWith(
              organizationId,
              effect.kind,
              "insert_subscription",
              insErr,
              "Falha ao criar a assinatura — ver logs.",
            );
          }
        }

        // Espelha em organizations, que é a coluna autoritativa do
        // BillingGuard e dos guards server-side. É o último passo de propósito:
        // só liberamos acesso depois que assinatura e fatura ficaram duráveis.
        const { error: orgErr } = await supabase
          .from("organizations")
          .update({ billing_status: "active", blocked_at: null, blocked_reason: null })
          .eq("id", organizationId);
        if (orgErr) {
          return failWith(
            organizationId,
            effect.kind,
            "update_organization_active",
            orgErr,
            "Falha ao liberar o acesso da organização — ver logs.",
          );
        }
        break;
      }

      case "mark_invoice_overdue": {
        if (invoice) {
          const { error: updErr } = await supabase
            .from("billing_invoices")
            .update({ status: "open" })
            .eq("id", invoice.id)
            .not("status", "in", "(paid,void)");
          if (updErr) {
            return failWith(
              organizationId,
              effect.kind,
              "update_invoice_overdue",
              updErr,
              "Falha ao marcar a fatura como vencida — ver logs.",
            );
          }
        }
        break;
      }

      case "record_refund": {
        if (invoice) {
          const { error: updErr } = await supabase
            .from("billing_invoices")
            .update({ status: "void" })
            .eq("id", invoice.id)
            .neq("status", "void");
          if (updErr) {
            return failWith(
              organizationId,
              effect.kind,
              "update_invoice_void",
              updErr,
              "Falha ao registrar o estorno da fatura — ver logs.",
            );
          }
        }
        // Estorno não é erro — é fato de negócio que o operador precisa ver.
        jsonLog("info", {
          evt: "asaas_refund_recorded",
          organization_id: organizationId,
          event_type: row.event_type,
          purpose,
        });
        break;
      }
    }

    return { status: "processed", organizationId, effect: effect.kind };
  } catch (err) {
    jsonLog("error", {
      evt: "asaas_apply_unexpected_error",
      billing_event_id: row.id,
      event_type: row.event_type,
      error: String(err),
    });
    return {
      status: "failed",
      organizationId: row.organization_id,
      effect: "unknown",
      error: "Falha ao aplicar efeito do evento — ver logs.",
    };
  }
}
