/**
 * Worker: reconcilia cobranças do Asaas com `billing_invoices`, POR
 * ASSINATURA. Roda diariamente via pg_cron (migration
 * `20260727100400_082_cron_asaas_invoice_reconcile.sql`).
 *
 * REDE DE SEGURANÇA DO ELO FINANCEIRO — o webhook (`asaas-webhook`, Fase 5b
 * Task 9) abre a fatura interna quando o Asaas avisa que uma cobrança nasceu
 * (`PAYMENT_CREATED`), mas webhook se perde, chega fora de ordem, e ANTES
 * desta fase não existia de jeito nenhum. Este worker anda por CADA
 * assinatura Asaas viva e confere as cobranças do provedor contra
 * `billing_invoices`. TODA a decisão de negócio mora em
 * `_shared/asaas-invoice-reconcile-core.ts` (`decideReconcileAction`, ÚNICA
 * função chamada por cobrança) — aqui só I/O e orquestração.
 *
 * Ramos possíveis (ver `decideReconcileAction` pro contrato completo):
 *
 *   (a) Cobrança cobrável que existe no Asaas e não existe aqui → CRIA a
 *       fatura (o buraco que este worker existe para tapar).
 *   (b) Fatura `open` aqui, liquidada lá → LIQUIDA (webhook de pagamento
 *       perdido).
 *   (c) Valor local diverge do valor remoto → RETÉM para revisão humana —
 *       nunca corrige silenciosamente pra nenhum dos dois lados.
 *   (d) Cobrança estornada/contestada/cancelada ou de status desconhecido →
 *       NUNCA fabrica fatura nova; fatura existente é CONGELADA
 *       (`enforcement_hold`, motivo `MANUAL_REVIEW`) pra revisão humana, nunca
 *       settle automático, nunca segunda fatura.
 *
 * SÓ LEITURA contra o Asaas. Nunca cria cobrança nem assinatura no provedor:
 * `POST` não é retry-safe lá (Asaas não tem Idempotency-Key, §11 da doc
 * verificada) e um retry cego duplicaria cobrança para o cliente. Este
 * worker só lê (`GET /subscriptions/{id}/payments`) e escreve no NOSSO
 * banco.
 *
 * NUNCA sobrescreve estado administrativo: fatura `void`/`uncollectible`, ou
 * já retida, só muda por ação humana — todas as decisões passam pelo núcleo
 * puro testado por vitest.
 *
 * NUNCA escreve `organizations.billing_status` — essa coluna só pode ser
 * escrita por caminho que passe pela categoria do plano (CLAUDE.md,
 * `_shared/billing-category.ts`). Este worker só mexe em `billing_invoices`.
 * NENHUM worker hoje honra `enforcement_hold` pra pausar a régua de
 * inadimplência (D+1/D+3/D+5/D+6) — essa é a Task 12, ainda não implementada.
 * Reter uma fatura aqui a tira da régua SÓ quando o worker de inadimplência
 * (futuro) souber checar o campo; até lá, ligar `billing_invoice_ingestion`
 * em produção depende da Task 12 estar pronta, não só desta.
 *
 * "Assinatura ambígua" (mais de uma linha viva da mesma categoria para a
 * organização) NÃO é detectada aqui — a varredura é por linha de
 * `billing_subscriptions`, não por organização, então duas linhas viram duas
 * iterações independentes. Quem detecta e avisa é o worker da Task 17, que
 * varre por organização.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalAuth, genRequestId, jsonLog } from "../_shared/security.ts";
// `checkFlagEnabled`/`checkFlagString`, NÃO `isFlagEnabled`:
// uma leitura que FALHA (DB indisponível) não pode parecer "flag OFF" — com a
// ingestão de fato ligada, um soluço transitório faria este worker "rodar com
// sucesso" sem checar nada, todo dia, até alguém notar. Mesma regra da
// Fase 5b em asaas-billing-events-apply.ts.
import { checkFlagEnabled, checkFlagString } from "../_shared/platform-flags.ts";
import { listAsaasSubscriptionPayments } from "../_shared/asaas.ts";
import { parseAsaasAmountCents, mapAsaasBillingTypeToPaymentMethod } from "../_shared/asaas-core.ts";
import { isBillingInvoiceStatus, type BillingInvoiceStatus } from "../_shared/billing-financial-state-core.ts";
import { resolvePlatformAdminRecipients, enqueueBillingNotification } from "../_shared/billing-notify.ts";
import {
  classifyPaymentCollectibility,
  parseBillingIngestionSince,
  decideReconcileAction,
  type LocalInvoiceSnapshot,
  type ReconcileInvoiceAction,
} from "../_shared/asaas-invoice-reconcile-core.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

/**
 * Teto de assinaturas por execução. Mesmo raciocínio do `BATCH_LIMIT` de
 * process-asaas-reconcile/index.ts: o resto sobra pra execução de amanhã DE
 * PROPÓSITO (não é um `.range()` em loop) — cada assinatura já paga várias
 * chamadas HTTP ao Asaas (uma página de até 100 cobranças por vez), e a
 * quota da conta é compartilhada com o resto do produto (§10: 25k req/12h).
 * Atingir o teto é logado explicitamente — nunca um corte silencioso que lê
 * como cobertura completa.
 *
 * `ORDER BY updated_at ASC, id ASC` (fix round 1, minor 1): sem ordenação,
 * `.limit()` do PostgREST devolve um subconjunto ARBITRÁRIO — acima do teto,
 * o mesmo grupo de 200 podia voltar todo dia e o resto nunca ser reconciliado
 * (o comentário antigo dizia "sobra pra amanhã", o que só é verdade com
 * alguma forma de rodízio). `updated_at` não é um cursor dedicado de
 * reconciliação (não existe coluna própria pra isso, e criar uma é migration
 * fora do escopo deste worker) — mas é honesto: assinatura tocada por
 * qualquer outra escrita (troca de plano, mudança de status, backfill do
 * `provider_subscription_id`) volta pro fim da fila, e as que ficam paradas
 * por mais tempo entram primeiro. Empate quebrado por `id` pra determinismo
 * total.
 */
const BATCH_LIMIT = 200;

interface AsaasSubscriptionRow {
  id: string;
  organization_id: string;
  provider_subscription_id: string;
}

interface LocalInvoiceRow {
  id: string;
  status: string;
  amount_cents: number;
  enforcement_hold: boolean;
}

serve(async (req) => {
  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const reqId = genRequestId();
  jsonLog("info", { reqId, evt: "asaas_invoice_reconcile_start" });

  try {
    // Gate 1: mesma flag que abre a porta pro webhook criar fatura
    // (`billing_invoice_ingestion`, Task 9) — as duas pontas da ingestão
    // ligam JUNTAS. Com ela OFF, este worker não toca em nada: senão a
    // reconciliação criaria fatura que o webhook nunca criaria, ou vice-versa,
    // e as duas pontas divergiriam sobre "o que é uma fatura válida agora".
    //
    // `readFailed` aqui continua `success:true` (skip retomável amanhã) —
    // DIFERENTE do gate 2 abaixo. É uma leitura transitória (o worker roda de
    // novo em 24h e o DB provavelmente já respondeu), mesma régua do irmão
    // process-asaas-reconcile pro seu próprio flagCheck.readFailed.
    const ingestionCheck = await checkFlagEnabled("billing_invoice_ingestion");
    if (ingestionCheck.readFailed) {
      jsonLog("warn", { reqId, evt: "asaas_invoice_reconcile_flag_read_error" });
      return new Response(JSON.stringify({ success: true, skipped: "flag_read_error" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!ingestionCheck.enabled) {
      jsonLog("info", { reqId, evt: "asaas_invoice_reconcile_flag_off" });
      return new Response(JSON.stringify({ success: true, skipped: "flag_off" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Gate 2 (fix round 1, achado 2 — decisão do dono): com a ingestão
    // LIGADA, `billing_invoice_ingestion_since` é OBRIGATÓRIA. Ausente, vazia,
    // só espaços, formato inválido ou data impossível é ERRO FATAL DE
    // CONFIGURAÇÃO — aborta ANTES de qualquer consulta a `billing_subscriptions`/
    // `billing_invoices` e antes de qualquer chamada ao Asaas. SEM efeito
    // parcial: nenhuma fatura criada, nenhuma assinatura tocada,
    // `organizations.billing_status` nunca entra em jogo neste worker de
    // qualquer forma. `success: false` nos dois sub-casos — nem leitura
    // ilegível nem "since" ausente/inválida podem ser reportadas como
    // execução bem-sucedida, porque nenhum trabalho real foi feito.
    //
    // Por quê é fatal e não "assume sem corte": um `since` vazio faria
    // `decideMissingInvoiceIngestion` tratar TODO o histórico como RECONCILE
    // comum, sem retenção — cobrança antiga vira fatura `open` vencida, entra
    // direto na régua de inadimplência (D+1..D+6). Exatamente o cenário que a
    // migration 077 existe para evitar.
    const sinceCheck = await checkFlagString("billing_invoice_ingestion_since", "");
    if (sinceCheck.readFailed) {
      jsonLog("warn", { reqId, evt: "asaas_invoice_reconcile_since_read_error" });
      return new Response(
        JSON.stringify({
          success: false,
          code: "SINCE_FLAG_READ_ERROR",
          retryable: true,
          configurationError: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    const sinceParsed = parseBillingIngestionSince(sinceCheck.value);
    if (sinceParsed.ok === false) {
      jsonLog("error", {
        reqId,
        evt: "asaas_invoice_reconcile_since_required",
        code: sinceParsed.code,
        message:
          "A ingestão automática de faturas está habilitada, mas a data de corte não foi " +
          "configurada. Defina billing_invoice_ingestion_since antes de executar o worker.",
      });
      return new Response(
        JSON.stringify({
          success: false,
          code: "BILLING_INGESTION_SINCE_REQUIRED",
          reason: sinceParsed.code,
          retryable: false,
          configurationError: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    const sinceValue = sinceParsed.value;

    const stats = {
      subscriptions_scanned: 0,
      subscriptions_list_failed: 0,
      payments_seen: 0,
      payments_amount_invalid: 0,
      payments_skipped_non_collectible: 0,
      payments_skipped_unknown_status: 0,
      invoices_created: 0,
      invoices_settled: 0,
      invoices_held: 0,
      value_mismatches: 0,
      non_collectible_holds: 0,
    };

    const { data: subs, error: subsErr } = await supabase
      .from("billing_subscriptions")
      .select("id, organization_id, provider_subscription_id")
      .eq("provider", "asaas")
      .neq("status", "canceled")
      .not("provider_subscription_id", "is", null)
      .order("updated_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(BATCH_LIMIT);

    if (subsErr) {
      // Best-effort, como no irmão process-asaas-reconcile: sem a lista não
      // há assinatura pra conferir agora, mas não é motivo pra 500 — o corpo
      // da resposta marca o skip explicitamente (ver `subscriptions_skipped`
      // abaixo), nunca some como se fosse "nada a fazer".
      jsonLog("error", { reqId, evt: "asaas_invoice_reconcile_subs_fetch_error", err: subsErr.message });
    }

    const subscriptions = (subs ?? []) as AsaasSubscriptionRow[];
    if (subscriptions.length === BATCH_LIMIT) {
      jsonLog("warn", {
        reqId,
        evt: "asaas_invoice_reconcile_subs_capped",
        cap: BATCH_LIMIT,
      });
    }

    for (const sub of subscriptions) {
      stats.subscriptions_scanned++;

      // SEM `budgetMs`: este worker é cron, sem cliente esperando — mantém
      // os retries completos do cliente HTTP. `listAsaasSubscriptionPayments`
      // nunca devolve coleção parcial como se fosse completa (Task 10):
      // `ok:false` cobre tanto erro de rede/HTTP quanto teto de páginas
      // atingido, sempre com log explícito de quanto foi lido antes.
      const res = await listAsaasSubscriptionPayments(sub.provider_subscription_id);
      if (res.ok === false) {
        stats.subscriptions_list_failed++;
        jsonLog("warn", {
          reqId,
          evt: "asaas_invoice_reconcile_list_failed",
          subscription: sub.id,
          err: res.error,
        });
        continue;
      }

      for (const pay of res.data ?? []) {
        stats.payments_seen++;

        // Fronteira de dinheiro: `AsaasPaymentSummary.value` vem em REAIS,
        // nunca convertido pelo parser de lista (Task 10, de propósito — a
        // responsabilidade de converter é de quem compara com
        // `amount_cents`). `parseAsaasAmountCents` faz a conversão E o guard
        // `Number.isSafeInteger` num só lugar, e NUNCA lança — valor
        // ausente/inválido bloqueia esta cobrança específica (nunca vira
        // R$ 0,00), o resto do lote continua.
        const amountParse = parseAsaasAmountCents(pay.value);
        if (amountParse.ok === false) {
          stats.payments_amount_invalid++;
          jsonLog("error", {
            reqId,
            evt: "asaas_invoice_reconcile_bad_amount",
            subscription: sub.id,
            payment: pay.id,
            code: amountParse.code,
          });
          continue;
        }
        const remoteCents = amountParse.cents;
        const collectibility = classifyPaymentCollectibility(pay.status);

        // Fronteira cross-tenant (fix round 1, minor 3): escopar a busca da
        // fatura pela organização da assinatura que estamos varrendo, não só
        // por (provider, provider_payment_id). Custa nada e é defesa em
        // profundidade — o UNIQUE (provider, provider_payment_id) já
        // garantiria isolamento na prática, mas validar o tenant contra o
        // recurso é a regra permanente deste repo (CLAUDE.md).
        const { data: invData, error: invErr } = await supabase
          .from("billing_invoices")
          .select("id, status, amount_cents, enforcement_hold")
          .eq("provider", "asaas")
          .eq("provider_payment_id", pay.id)
          .eq("organization_id", sub.organization_id)
          .maybeSingle();
        const invRaw = invData as LocalInvoiceRow | null;
        if (invErr) {
          jsonLog("warn", {
            reqId,
            evt: "asaas_invoice_reconcile_invoice_read_failed",
            payment: pay.id,
            err: invErr.message,
          });
          continue;
        }

        // Fronteira: `status` sai do banco como `string` solta — validar
        // ANTES de entrar em qualquer decisão tipada (mesmo guard que as
        // Tasks 6/7 fixaram pro resto da fase). Desconhecido nunca vira
        // "aberto" ou "pago" em silêncio — só loga e pula esta cobrança.
        let localInvoice: LocalInvoiceSnapshot | null = null;
        if (invRaw) {
          if (!isBillingInvoiceStatus(invRaw.status)) {
            jsonLog("error", {
              reqId,
              evt: "asaas_invoice_reconcile_unknown_local_status",
              invoice: invRaw.id,
              status: invRaw.status,
            });
            continue;
          }
          localInvoice = {
            id: invRaw.id,
            status: invRaw.status as BillingInvoiceStatus,
            amountCents: invRaw.amount_cents,
            enforcementHold: invRaw.enforcement_hold,
          };
        }

        // DECISÃO ÚNICA, a partir de um snapshot coerente — ver o header do
        // núcleo puro pro porquê disto ser uma função só (achado 1 do fix
        // round 1: bug de composição entre "liquidar" e "reter por
        // divergência" quando eram duas consultas sequenciais ao núcleo).
        const action: ReconcileInvoiceAction = decideReconcileAction({
          collectibility,
          localInvoice,
          remoteAmountCents: remoteCents,
          dueDate: pay.dueDate,
          sinceValue,
        });

        switch (action.kind) {
          case "CREATE_INVOICE": {
            const { error: insErr } = await supabase.from("billing_invoices").insert({
              organization_id: sub.organization_id,
              billing_subscription_id: sub.id,
              provider: "asaas",
              provider_payment_id: pay.id,
              // Toda linha de `billing_subscriptions` é SYSTEM_SUBSCRIPTION ou
              // WHATSAPP_SUBSCRIPTION (implantação/recarga de IA são avulsas,
              // nunca viram assinatura) — as duas usam purpose 'subscription'
              // (CLAUDE.md/`_shared/billing-category.ts`: quem distingue
              // sistema de instância é `billing_subscription_id` → categoria
              // do plano, não o `purpose` da fatura).
              purpose: "subscription",
              status: action.status,
              amount_cents: remoteCents,
              payment_method: mapAsaasBillingTypeToPaymentMethod(pay.billingType),
              due_date: pay.dueDate,
              external_reference: pay.externalReference,
              paid_at: action.status === "paid" ? new Date().toISOString() : null,
              ingestion_source: action.ingestionSource,
              enforcement_hold: action.hold,
              enforcement_hold_reason: action.holdReason,
              enforcement_held_at: action.hold ? new Date().toISOString() : null,
            });
            // 23505 = corrida ganha pelo webhook ou por outra passagem deste
            // mesmo worker — UNIQUE (provider, provider_payment_id). Caminho
            // feliz da idempotência, não erro.
            if (insErr && insErr.code !== "23505") {
              jsonLog("error", {
                reqId,
                evt: "asaas_invoice_reconcile_insert_failed",
                payment: pay.id,
                err: insErr.message,
              });
              break;
            }
            if (!insErr) {
              stats.invoices_created++;
              if (action.hold) stats.invoices_held++;
              jsonLog(action.hold ? "warn" : "info", {
                reqId,
                evt: "asaas_invoice_reconcile_invoice_created",
                subscription: sub.id,
                payment: pay.id,
                ingestion_source: action.ingestionSource,
                held: action.hold,
              });
            }
            break;
          }

          case "SETTLE_INVOICE": {
            // `invoiceId` vem da própria ação (não de `invRaw` fora dela) —
            // fix round 1: a ação é autossuficiente de propósito, pra nunca
            // depender de um snapshot lido antes e possivelmente obsoleto.
            const { invoiceId } = action;
            const { data: upd, error: updErr } = await supabase
              .from("billing_invoices")
              .update({ status: "paid", paid_at: new Date().toISOString() })
              .eq("id", invoiceId)
              .eq("organization_id", sub.organization_id)
              .eq("status", "open")
              .select("id");
            if (updErr) {
              jsonLog("warn", {
                reqId,
                evt: "asaas_invoice_reconcile_settle_failed",
                invoice: invoiceId,
                err: updErr.message,
              });
            } else if (upd?.length) {
              stats.invoices_settled++;
              jsonLog("info", {
                reqId,
                evt: "asaas_invoice_reconcile_invoice_settled",
                invoice: invoiceId,
                payment: pay.id,
              });
            }
            break;
          }

          case "HOLD_VALUE_MISMATCH": {
            const { invoiceId, localAmountCents } = action;
            // `.eq("status","open")` ACRESCENTADO no fix round 1 (achado 1):
            // defesa em profundidade no BANCO, além da decisão já coerente em
            // memória (`decideReconcileAction` não devolve `HOLD_VALUE_MISMATCH`
            // pra uma fatura que a MESMA passagem acabou de liquidar) — cobre
            // a janela entre o SELECT e este UPDATE, onde outro processo
            // (webhook) pode ter liquidado a linha nesse meio-tempo.
            const { data: heldRow, error: holdErr } = await supabase
              .from("billing_invoices")
              .update({
                enforcement_hold: true,
                enforcement_hold_reason: "VALUE_MISMATCH",
                enforcement_held_at: new Date().toISOString(),
              })
              .eq("id", invoiceId)
              .eq("organization_id", sub.organization_id)
              .eq("enforcement_hold", false)
              .eq("status", "open")
              .select("id");
            if (holdErr) {
              jsonLog("error", {
                reqId,
                evt: "asaas_invoice_reconcile_hold_failed",
                invoice: invoiceId,
                err: holdErr.message,
              });
              break;
            }
            if (!heldRow?.length) break;
            stats.value_mismatches++;
            stats.invoices_held++;
            jsonLog("error", {
              reqId,
              evt: "asaas_invoice_reconcile_value_mismatch",
              invoice: invoiceId,
              payment: pay.id,
              local_cents: localAmountCents,
              provider_cents: remoteCents,
            });
            const mismatchRecipients = await resolvePlatformAdminRecipients(supabase);
            if (mismatchRecipients.length > 0) {
              await enqueueBillingNotification(supabase, {
                organizationId: sub.organization_id,
                eventType: "admin_invoice_value_mismatch",
                invoiceId,
                recipient: mismatchRecipients[0],
              });
            }
            break;
          }

          case "HOLD_NON_COLLECTIBLE": {
            const { invoiceId } = action;
            const { data: heldRow, error: holdErr } = await supabase
              .from("billing_invoices")
              .update({
                enforcement_hold: true,
                enforcement_hold_reason: "MANUAL_REVIEW",
                enforcement_held_at: new Date().toISOString(),
              })
              .eq("id", invoiceId)
              .eq("organization_id", sub.organization_id)
              .eq("enforcement_hold", false)
              .eq("status", "open")
              .select("id");
            if (holdErr) {
              jsonLog("error", {
                reqId,
                evt: "asaas_invoice_reconcile_non_collectible_hold_failed",
                invoice: invoiceId,
                err: holdErr.message,
              });
              break;
            }
            if (!heldRow?.length) break;
            stats.non_collectible_holds++;
            stats.invoices_held++;
            jsonLog("error", {
              reqId,
              evt: "asaas_invoice_reconcile_non_collectible_hold",
              invoice: invoiceId,
              payment: pay.id,
              subscription: sub.id,
              remoteStatus: pay.status,
              collectibility,
            });
            const nonCollectibleRecipients = await resolvePlatformAdminRecipients(supabase);
            if (nonCollectibleRecipients.length > 0) {
              await enqueueBillingNotification(supabase, {
                organizationId: sub.organization_id,
                eventType: "admin_invoice_non_collectible_hold",
                invoiceId,
                recipient: nonCollectibleRecipients[0],
              });
            }
            break;
          }

          case "SKIP_NON_COLLECTIBLE_NO_INVOICE": {
            stats.payments_skipped_non_collectible++;
            jsonLog("info", {
              reqId,
              evt: "asaas_invoice_reconcile_skipped_non_collectible",
              outcome: "SKIPPED_NON_COLLECTIBLE_PAYMENT",
              subscription: sub.id,
              payment: pay.id,
              remoteStatus: pay.status,
              collectibility,
              invoiceCreated: false,
              enforcementApplied: false,
            });
            break;
          }

          case "SKIP_UNKNOWN_NO_INVOICE": {
            stats.payments_skipped_unknown_status++;
            // Nível error de propósito: status fora do catálogo documentado
            // pode ser API introduzindo valor novo — merece atenção mais
            // rápida que um estorno/chargeback rotineiro.
            jsonLog("error", {
              reqId,
              evt: "asaas_invoice_reconcile_skipped_unknown_status",
              outcome: "SKIPPED_UNKNOWN_STATUS_PAYMENT",
              subscription: sub.id,
              payment: pay.id,
              remoteStatus: pay.status,
              invoiceCreated: false,
              enforcementApplied: false,
            });
            break;
          }

          case "NO_ACTION":
            break;
        }
      }
    }

    jsonLog("info", { reqId, evt: "asaas_invoice_reconcile_done", ...stats });
    return new Response(
      JSON.stringify({
        success: true,
        ...stats,
        // Marcadores de estágio degradado: sem eles uma execução que não
        // conseguiu LER a lista de assinaturas, ou que bateu no teto, é
        // indistinguível de uma que não achou nada a fazer.
        ...(subsErr ? { subscriptions_skipped: "fetch_error" } : {}),
        ...(subscriptions.length === BATCH_LIMIT ? { subscriptions_capped: true } : {}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    jsonLog("error", { reqId, evt: "asaas_invoice_reconcile_error", err: String(err) });
    return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
  }
});
