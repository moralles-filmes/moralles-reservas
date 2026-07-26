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
import {
  resolveBillingRecipient,
  resolvePlatformAdminRecipients,
  enqueueBillingNotification,
} from "./billing-notify.ts";

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

/**
 * Opções do CALLER — não do aplicador. Cada chamador tem um orçamento de tempo
 * diferente e é ele quem sabe qual é o seu.
 *
 * `asaasIoBudgetMs`: teto de wall-clock pro I/O com a API do Asaas
 * (`getPayment`). O `asaas-webhook` passa um valor confortavelmente abaixo dos
 * 10s que o Asaas concede pra resposta (§2 de
 * docs/billing-asaas/03-ASAAS-API-VERIFICADO.md), deixando margem pro INSERT e
 * pelas demais escritas; estourar o teto vira `failed` (nunca `processed`), e o
 * reconcile retenta. O `process-asaas-reconcile` roda em cron, sem cliente
 * esperando, e OMITE o campo — mantendo os retries completos do cliente HTTP.
 *
 * NUNCA transformar isso em trabalho de background (`EdgeRuntime.waitUntil`):
 * uma continuação depois da resposta pode ser morta sem deixar ninguém pra
 * marcar a linha, trocando uma falha visível por uma silenciosa. Sob
 * degradação do Asaas a ativação atrasa até o reconcile — ruim, mas muito
 * melhor que interromper a fila de eventos de TODOS os clientes (15 timeouts
 * seguidos), que só se resolve manualmente.
 */
export interface ApplyOptions {
  asaasIoBudgetMs?: number;
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
 * Confirma a implantação paga pelo checkout do Asaas.
 *
 * IDEMPOTENTE por UPDATE condicional em `payment_status = 'PENDING'`: o cartão
 * emite PAYMENT_CONFIRMED e depois PAYMENT_RECEIVED (até ~30 dias), e o
 * reconcile pode reprocessar a mesma linha. Só a execução que de fato mudou a
 * linha enfileira o aviso — `.select("id")` é o que distingue "eu mudei" de
 * "já estava assim".
 *
 * `.eq('PENDING')` e não `.neq('CONFIRMED')`: a matriz origem×pagamento só
 * admite PENDING→CONFIRMED para origin='ASAAS', e um `.neq` também casaria
 * linhas CANCELED ou estornadas.
 *
 * Best-effort no aviso: falha ao resolver destinatário NUNCA derruba a
 * confirmação financeira (mesma filosofia do enqueue de `regularized`).
 */
async function confirmImplementationPayment(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    checkoutSessionId: string | null;
    invoiceId: string | null;
    paidValueCents: number | null;
    paymentMethod: string | null;
  },
): Promise<void> {
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    payment_status: "CONFIRMED",
    paid_at: nowIso,
  };
  if (args.invoiceId) patch.billing_invoice_id = args.invoiceId;
  if (args.paidValueCents !== null) patch.amount_cents = args.paidValueCents;
  if (args.paymentMethod) patch.payment_method = args.paymentMethod;

  let query = supabase
    .from("whatsapp_implementations")
    .update(patch)
    .eq("origin", "ASAAS")
    .eq("payment_status", "PENDING");

  // Correlação precisa quando temos o checkout; senão cai na organização, que é
  // suficiente porque só existe UMA implantação aberta por org (UNIQUE parcial).
  query = args.checkoutSessionId
    ? query.eq("provider_checkout_id", args.checkoutSessionId)
    : query.eq("organization_id", args.organizationId);

  const { data: updated, error } = await query.select("id");

  if (error) {
    jsonLog("error", {
      evt: "implementation_confirm_failed",
      organization_id: args.organizationId,
      error: String(error),
    });
    return;
  }
  if (!updated || updated.length === 0) {
    // Duplicata benigna (2º evento do cartão) ou pagamento de implantação sem
    // linha correspondente. Log em info: não é erro, mas precisa ser visível.
    jsonLog("info", {
      evt: "implementation_confirm_noop",
      organization_id: args.organizationId,
      checkout: args.checkoutSessionId,
    });
    return;
  }

  jsonLog("info", {
    evt: "implementation_confirmed",
    organization_id: args.organizationId,
    implementation_id: updated[0].id,
  });

  const recipients = await resolvePlatformAdminRecipients(supabase);
  if (recipients.length === 0) return;
  // UMA linha só: o UNIQUE (organization_id, event_type, invoice_id) deduplica,
  // e sendEmail aceita um único `to`. Enfileirar uma por admin faria N-1
  // desaparecerem em 23505 silencioso. A lista completa vai para o log, e quem
  // recebe é o admin mais antigo (ordem determinística).
  if (recipients.length > 1) {
    jsonLog("info", {
      evt: "implementation_notify_single_recipient",
      chosen: recipients[0],
      total_admins: recipients.length,
    });
  }
  await enqueueBillingNotification(supabase, {
    organizationId: args.organizationId,
    eventType: "implementation_paid",
    invoiceId: args.invoiceId,
    recipient: recipients[0],
  });
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
  opts: ApplyOptions = {},
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
    let checkoutSessionId: string | null = null;

    // 4. PORTÕES de noop/unknown — ANTES de qualquer I/O com o Asaas.
    //
    //    ~31 dos 40 eventos do catálogo são informativos (`PAYMENT_CREATED`
    //    dispara em TODA cobrança). Consultar `getPayment` pra depois descartar
    //    o payload inteiro paga um round-trip por evento: multiplica o consumo
    //    da quota (25k req/12h, §10) e — pior — coloca latência de rede no
    //    caminho crítico de eventos que não produzem efeito nenhum, que é o
    //    multiplicador direto do risco de estourar os 10s de resposta.
    //
    //    CUSTO CONHECIDO E ACEITO: linha `noop` sem invoice correlacionada
    //    deixa de ter `organization_id` carimbado (o SELECT do passo 1 é DB
    //    barato e continua resolvendo as demais). Verificado que nenhum
    //    consumidor depende disso — `billing_events.organization_id` não é
    //    lido por src/ nem pelo process-asaas-reconcile; só existe o índice
    //    `billing_events_org_idx`. Consumidor NOVO dessa coluna precisa saber
    //    que ela é esparsa em linhas informativas.
    if (effect.kind === "unknown") {
      // NÃO usa `error`: o webhook grava esse campo em `billing_events.
      // error_message`, e "evento fora do catálogo" é diagnóstico, não erro —
      // carimbá-lo ali faria uma linha saudável parecer quebrada pro operador.
      // Inalcançável pelo webhook (os catálogos batem), mas alcançável pelo
      // reconcile. O motivo vai pro log.
      jsonLog("info", {
        evt: "asaas_apply_unknown_effect",
        billing_event_id: row.id,
        event_type: row.event_type,
        reason: effect.reason,
      });
      return { status: "ignored", organizationId, effect: effect.kind };
    }
    if (effect.kind === "noop") {
      return { status: "processed", organizationId, effect: effect.kind };
    }

    // 5. Enriquecer com o payload do Asaas — só para efeitos que de fato
    //    produzem escrita.
    if (paymentId) {
      const provider = getBillingProvider("asaas");
      // `asaasIoBudgetMs` corta tentativa/retry/sleep de rate limit lá no
      // cliente HTTP (asaas.ts). Estourar volta como `{ok:false}` — mesmo
      // shape de "Asaas indisponível" — e o branch abaixo já degrada pra
      // `failed`, que é o que mantém o evento na fila do reconcile.
      const res = await provider.getPayment(
        paymentId,
        opts.asaasIoBudgetMs !== undefined ? { budgetMs: opts.asaasIoBudgetMs } : undefined,
      );
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

        // Terceiro fallback: checkout hospedado. Verificado ao vivo (§13.7) que o
        // Asaas NÃO propaga o externalReference do checkout para a assinatura NEM
        // para a cobrança (ambas nascem com externalReference=null), e o pagador
        // digita os dados na página gerando um customer NOVO — então nem o
        // externalReference (acima) nem o customer resolvem a org. O elo que
        // sobrevive é o `checkoutSession` (id do checkout que a
        // create-billing-checkout criou), presente na cobrança E na assinatura.
        // Mapeamos esse id → org na criação (billing_checkout_sessions) e
        // reidratamos org+plano+purpose aqui.
        //
        // ESCOPO 4a (1ª cobrança/ativação): a renovação do mês 2+ NÃO carrega
        // checkoutSession (a cobrança nasce da assinatura, não do checkout) — a
        // correlação dela é por provider_subscription_id (backfillado abaixo na
        // ativação), trabalho da Fase 4b.
        const checkoutRef = res.data.checkoutSession;
        if (typeof checkoutRef === "string" && checkoutRef) {
          checkoutSessionId = checkoutRef;
        }

        if (!organizationId) {
          if (typeof checkoutRef === "string" && checkoutRef) {
            const { data: sess, error: sessErr } = await supabase
              .from("billing_checkout_sessions")
              .select("organization_id, external_reference")
              .eq("provider_checkout_id", checkoutRef)
              .maybeSingle();
            if (sessErr) {
              return failWith(
                null,
                "unknown",
                "select_checkout_session",
                sessErr,
                "Falha ao correlacionar o checkout do evento — ver logs.",
              );
            }
            if (sess) {
              organizationId = sess.organization_id;
              // Reidrata plano+purpose: no checkout hospedado o payment vem SEM
              // externalReference, então planId ficaria null e purpose "other"
              // → o gate purpose!=="subscription" daria break antes de ativar e
              // o INSERT de assinatura não teria billing_plan_id. Mesmo parse do
              // caminho primário; só preenche o que ainda está no default.
              externalReferenceRaw = externalReferenceRaw ?? sess.external_reference;
              const parsedSess = parseExternalReference(sess.external_reference);
              if (parsedSess) {
                planId = planId ?? parsedSess.planId;
                if (purpose === "other") purpose = parsedSess.purpose;
              }
            }
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

    // 6. Categoria do plano do PAGAMENTO e a assinatura correspondente.
    //
    // O código antigo perguntava "qual é a assinatura desta organização?" com
    // maybeSingle(). A partir da Fase 5a uma org pode ter DUAS (sistema R$449 +
    // instância R$149) e aquela pergunta não tem resposta única — devolvia
    // PGRST116 e o pagamento falhava. A pergunta certa é "qual é a assinatura
    // desta organização NA CATEGORIA deste plano?".
    let planCategory: string | null = null;
    if (planId) {
      const { data: planRow, error: planErr } = await supabase
        .from("billing_plans")
        .select("category")
        .eq("id", planId)
        .maybeSingle();
      if (planErr) {
        return failWith(
          organizationId,
          effect.kind,
          "select_plan_category",
          planErr,
          "Falha ao consultar a categoria do plano — ver logs.",
        );
      }
      planCategory = (planRow?.category as string | undefined) ?? null;
    }

    // Só serve para carimbar billing_subscription_id na fatura. A ativação em si
    // é feita pela RPC mais abaixo, que é quem tem o lock.
    let subscription: { id: string; status: string } | null = null;
    if (organizationId && planCategory) {
      // `.select()` de lista (não maybeSingle): ambiguidade aqui precisa ser
      // detectada, não convertida em null. Duas assinaturas vivas na mesma
      // categoria é estado inválido, e escolher uma em silêncio carimbaria a
      // fatura na assinatura errada.
      const { data, error } = await supabase
        .from("billing_subscriptions")
        .select("id, status, billing_plans!inner(category)")
        .eq("organization_id", organizationId)
        .neq("status", "canceled")
        .eq("billing_plans.category", planCategory);
      if (error) {
        return failWith(
          organizationId,
          "unknown",
          "select_subscription_by_category",
          error,
          "Falha ao consultar a assinatura da organização — ver logs.",
        );
      }
      if ((data ?? []).length > 1) {
        return failWith(
          organizationId,
          effect.kind,
          "ambiguous_subscription_category",
          `org ${organizationId} tem ${data!.length} assinaturas vivas na categoria ${planCategory}`,
          "Organização com mais de uma assinatura ativa na mesma categoria — ver logs.",
        );
      }
      const row = (data ?? [])[0] as { id: string; status: string } | undefined;
      subscription = row ? { id: row.id, status: row.status } : null;
    }

    // 7. Último portão. Fica AQUI, e não junto da decisão do passo 2, para que
    //    `organizationId` já tenha passado por toda a cadeia de resolução
    //    (invoice → externalReference → customer) antes de desistir.
    if (!organizationId) {
      return {
        status: "failed",
        organizationId: null,
        effect: effect.kind,
        error: "Não foi possível correlacionar o evento a uma organização.",
      };
    }

    // 8. Executar. Transições por UPDATE CONDICIONAL — o `.neq`/`.eq` no status
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
        //
        // ⚠️ NÃO É CÓDIGO MORTO, apesar de inalcançável pelo asaas-webhook: por
        // aquele caminho, sem `paymentId` não há invoice nem payload, então o
        // `!organizationId` do passo 7 já retornou `failed` antes de chegar
        // aqui. Quem mantém este guard vivo é o caller reconcile, que passa
        // `row.organization_id` JÁ preenchido (carimbado pelo webhook na
        // primeira passagem) e portanto atravessa aquele portão.
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

        // Id da fatura deste pagamento, resolvido nos DOIS ramos: o UPDATE não
        // devolve id, e o INSERT pode ter virado 23505 numa corrida com o
        // reconcile. Um SELECT pelo UNIQUE (provider, provider_payment_id)
        // responde nos dois casos.
        let settledInvoiceId: string | null = invoice?.id ?? null;
        if (!settledInvoiceId) {
          const { data: inv } = await supabase
            .from("billing_invoices")
            .select("id")
            .eq("provider", "asaas")
            .eq("provider_payment_id", paymentId)
            .maybeSingle();
          settledInvoiceId = (inv?.id as string | undefined) ?? null;
        }

        // Sessão de checkout consumida — vale para QUALQUER purpose. Sem isto a
        // linha fica 'pending' para sempre e o UNIQUE parcial de sessão ativa
        // barra a próxima contratação do mesmo produto.
        if (checkoutSessionId) {
          const { error: sessErr } = await supabase
            .from("billing_checkout_sessions")
            .update({ status: "used" })
            .eq("provider_checkout_id", checkoutSessionId)
            .neq("status", "used");
          if (sessErr) {
            // Cosmético para o acesso — loga e segue, como o backfill do
            // provider_subscription_id.
            jsonLog("warn", {
              evt: "checkout_session_mark_used_failed",
              checkout: checkoutSessionId,
              error: String(sessErr),
            });
          }
        }

        if (purpose === "implementation") {
          await confirmImplementationPayment(supabase, {
            organizationId,
            checkoutSessionId,
            invoiceId: settledInvoiceId,
            paidValueCents,
            paymentMethod,
          });
        }

        // OBRIGAÇÃO 2 do contrato: conceder acesso SOMENTE quando o pagamento
        // for de assinatura do sistema. Um pacote de IA ou uma taxa de
        // implantação registram dinheiro mas NÃO liberam o sistema — senão uma
        // org inadimplente compraria R$ 50 de crédito e voltaria a ter acesso.
        if (purpose !== "subscription") {
          break;
        }

        // A criação/ativação é da RPC, não daqui: ela roda sob
        // pg_advisory_xact_lock por (org, categoria), que é o que impede duas
        // assinaturas de planos DIFERENTES da mesma categoria nascerem em
        // paralelo — corrida que nenhuma UNIQUE consegue expressar. A RPC
        // também faz o backfill do provider_subscription_id.
        if (!planId) {
          return failWith(
            organizationId,
            effect.kind,
            "missing_plan_id",
            `externalReference sem plano (raw=${externalReferenceRaw ?? "ausente"})`,
            "Pagamento de assinatura sem plano identificável — ver logs.",
          );
        }

        const { data: rpcData, error: rpcErr } = await supabase.rpc(
          "resolve_or_activate_subscription",
          {
            p_org: organizationId,
            p_plan_id: planId,
            p_provider_subscription_id: providerSubscriptionId,
            // Coluna NOT NULL. O fallback 'card' é regra de produto (o checkout
            // RECURRENT do Asaas só aceita cartão), não chute.
            p_payment_method: paymentMethod ?? "card",
          },
        );
        if (rpcErr) {
          // Inclui ambiguous_subscription_category, plan_not_found e
          // missing_billing_customer. Todos são falha ALTA: o evento continua na
          // fila e o reconcile reprocessa depois que um humano resolver.
          return failWith(
            organizationId,
            effect.kind,
            "resolve_or_activate_subscription",
            rpcErr,
            "Falha ao ativar a assinatura da organização — ver logs.",
          );
        }

        const activated = rpcData as
          | {
              action?: string;
              subscription_id?: string;
              category?: string;
              plan_changed?: { from: string; to: string } | null;
              provider_changed?: { from: string; to: string } | null;
            }
          | null;

        jsonLog("info", {
          evt: "asaas_subscription_resolved",
          organization_id: organizationId,
          action: activated?.action ?? null,
          category: activated?.category ?? null,
          plan_changed: activated?.plan_changed ?? null,
          provider_changed: activated?.provider_changed ?? null,
        });

        // ── INVARIANTE DA FASE 5a ────────────────────────────────────────────
        // SÓ assinatura de categoria SYSTEM_SUBSCRIPTION escreve em
        // organizations.billing_status. Sem este gate, pagar os R$149 da
        // instância reativaria uma organização cujo SISTEMA está inadimplente —
        // e carimbaria restored_at + aviso "voltou" por uma dívida que continua
        // aberta.
        if (activated?.category !== "SYSTEM_SUBSCRIPTION") {
          jsonLog("info", {
            evt: "asaas_activation_scoped_to_service",
            organization_id: organizationId,
            category: activated?.category ?? null,
          });
          break;
        }

        // Espelha em organizations, que é a coluna autoritativa do
        // BillingGuard e dos guards server-side. É o último passo de propósito:
        // só liberamos acesso depois que assinatura e fatura ficaram duráveis.
        //
        // Regularização (Fase 4b): se a org estava em atraso, carimba restored_at
        // e enfileira o aviso "regularized". Ler o status ANTES do update.
        const { data: prevOrg, error: prevOrgErr } = await supabase
          .from("organizations")
          .select("billing_status")
          .eq("id", organizationId)
          .maybeSingle();
        if (prevOrgErr) {
          jsonLog("warn", {
            evt: "regularize_prevorg_read_failed",
            organization_id: organizationId,
            err: prevOrgErr.message,
          });
        }
        const wasDelinquent =
          prevOrg?.billing_status === "grace_period" ||
          prevOrg?.billing_status === "blocked" ||
          prevOrg?.billing_status === "past_due";

        const orgUpdate: Record<string, unknown> = {
          billing_status: "active",
          blocked_at: null,
          blocked_reason: null,
        };
        if (wasDelinquent) orgUpdate.restored_at = new Date().toISOString();

        const { error: orgErr } = await supabase
          .from("organizations")
          .update(orgUpdate)
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

        if (wasDelinquent) {
          const recipient = await resolveBillingRecipient(supabase, organizationId);
          if (recipient) {
            await enqueueBillingNotification(supabase, {
              organizationId,
              eventType: "regularized",
              invoiceId: invoice?.id ?? null,
              recipient,
            });
          }
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
