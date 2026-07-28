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
 * `billing_invoices`, nos dois sentidos:
 *
 *   (a) Cobrança que existe no Asaas e não existe aqui → CRIA a fatura
 *       (o buraco que este worker existe para tapar).
 *   (b) Fatura `open` aqui, liquidada lá → LIQUIDA (webhook de pagamento
 *       perdido).
 *   (c) Valor local diverge do valor remoto → RETÉM para revisão humana —
 *       nunca corrige silenciosamente pra nenhum dos dois lados.
 *
 * SÓ LEITURA contra o Asaas. Nunca cria cobrança nem assinatura no provedor:
 * `POST` não é retry-safe lá (Asaas não tem Idempotency-Key, §11 da doc
 * verificada) e um retry cego duplicaria cobrança para o cliente. Este
 * worker só lê (`GET /subscriptions/{id}/payments`) e escreve no NOSSO
 * banco.
 *
 * NUNCA sobrescreve estado administrativo: fatura `void`/`uncollectible`, ou
 * já retida, só muda por ação humana — ver `shouldHoldValueMismatch` e
 * `shouldSettleOpenInvoice` em `_shared/asaas-invoice-reconcile-core.ts`
 * (núcleo puro, testado por vitest — TODA decisão de negócio deste worker
 * mora lá; aqui só I/O e orquestração).
 *
 * NUNCA escreve `organizations.billing_status` — essa coluna só pode ser
 * escrita por caminho que passe pela categoria do plano (CLAUDE.md,
 * `_shared/billing-category.ts`). Este worker só mexe em `billing_invoices`.
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
// `checkFlagEnabled`/`checkFlagString`, NÃO `isFlagEnabled`/`getFlagString`:
// uma leitura que FALHA (DB indisponível) não pode parecer "flag OFF" — com a
// ingestão de fato ligada, um soluço transitório faria este worker "rodar com
// sucesso" sem checar nada, todo dia, até alguém notar. Mesma regra da
// Fase 5b em asaas-billing-events-apply.ts.
import { checkFlagEnabled, checkFlagString } from "../_shared/platform-flags.ts";
import { listAsaasSubscriptionPayments } from "../_shared/asaas.ts";
import { parseAsaasAmountCents } from "../_shared/asaas-core.ts";
import { isBillingInvoiceStatus, type BillingInvoiceStatus } from "../_shared/billing-financial-state-core.ts";
import { resolvePlatformAdminRecipients, enqueueBillingNotification } from "../_shared/billing-notify.ts";
import {
  isSettledAsaasPaymentStatus,
  mapAsaasBillingTypeToPaymentMethod,
  decideMissingInvoiceIngestion,
  shouldSettleOpenInvoice,
  shouldHoldValueMismatch,
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

    // Gate 2: o carimbo de "quando a ingestão foi ligada" decide RECONCILE
    // vs BACKFILL pra toda fatura nova criada nesta execução (ver
    // `decideMissingInvoiceIngestion`). Uma leitura que FALHA aqui não pode
    // virar "" (sem corte) — isso classificaria cobrança histórica prévia ao
    // go-live como RECONCILE comum, sem retenção, e ela entraria direto na
    // escada de inadimplência na primeira varredura (exatamente o cenário
    // que a migration 077 existe para evitar). Mais seguro parar a execução
    // inteira e tentar de novo amanhã do que arriscar essa classificação.
    const sinceCheck = await checkFlagString("billing_invoice_ingestion_since", "");
    if (sinceCheck.readFailed) {
      jsonLog("warn", { reqId, evt: "asaas_invoice_reconcile_since_read_error" });
      return new Response(JSON.stringify({ success: true, skipped: "since_flag_read_error" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const sinceValue = sinceCheck.value;

    const stats = {
      subscriptions_scanned: 0,
      subscriptions_list_failed: 0,
      payments_seen: 0,
      payments_amount_invalid: 0,
      invoices_created: 0,
      invoices_settled: 0,
      invoices_held: 0,
      value_mismatches: 0,
    };

    const { data: subs, error: subsErr } = await supabase
      .from("billing_subscriptions")
      .select("id, organization_id, provider_subscription_id")
      .eq("provider", "asaas")
      .neq("status", "canceled")
      .not("provider_subscription_id", "is", null)
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
        const settled = isSettledAsaasPaymentStatus(pay.status);

        const { data: invData, error: invErr } = await supabase
          .from("billing_invoices")
          .select("id, status, amount_cents, enforcement_hold")
          .eq("provider", "asaas")
          .eq("provider_payment_id", pay.id)
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

        // (a) Cobrança que existe no Asaas e não existe aqui.
        if (!invRaw) {
          const decision = decideMissingInvoiceIngestion({
            sinceValue,
            dueDate: pay.dueDate,
            settled,
          });

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
            status: settled ? "paid" : "open",
            amount_cents: remoteCents,
            payment_method: mapAsaasBillingTypeToPaymentMethod(pay.billingType),
            due_date: pay.dueDate,
            external_reference: pay.externalReference,
            paid_at: settled ? new Date().toISOString() : null,
            ingestion_source: decision.ingestionSource,
            enforcement_hold: decision.hold,
            enforcement_hold_reason: decision.holdReason,
            enforcement_held_at: decision.hold ? new Date().toISOString() : null,
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
            continue;
          }
          if (!insErr) {
            stats.invoices_created++;
            if (decision.hold) stats.invoices_held++;
            jsonLog(decision.hold ? "warn" : "info", {
              reqId,
              evt: "asaas_invoice_reconcile_invoice_created",
              subscription: sub.id,
              payment: pay.id,
              ingestion_source: decision.ingestionSource,
              held: decision.hold,
            });
          }
          continue;
        }

        // Fronteira: `status` sai do banco como `string` solta — validar
        // ANTES de entrar em qualquer decisão tipada (mesmo guard que as
        // Tasks 6/7 fixaram pro resto da fase). Desconhecido nunca vira
        // "pago" nem "aberto" em silêncio — só loga e pula esta cobrança.
        if (!isBillingInvoiceStatus(invRaw.status)) {
          jsonLog("error", {
            reqId,
            evt: "asaas_invoice_reconcile_unknown_local_status",
            invoice: invRaw.id,
            status: invRaw.status,
          });
          continue;
        }
        const invoice: { id: string; status: BillingInvoiceStatus; amountCents: number; enforcementHold: boolean } = {
          id: invRaw.id,
          status: invRaw.status,
          amountCents: invRaw.amount_cents,
          enforcementHold: invRaw.enforcement_hold,
        };

        // (b) Paga no Asaas, `open` aqui — webhook de pagamento perdido.
        // UPDATE condicional (`.eq('status','open')`): nunca sobrescreve
        // `void`/`uncollectible` (estado administrativo, só muda por ação
        // humana) nem uma fatura já `paid` por outra passagem.
        if (shouldSettleOpenInvoice(invoice.status, settled)) {
          const { data: upd, error: updErr } = await supabase
            .from("billing_invoices")
            .update({ status: "paid", paid_at: new Date().toISOString() })
            .eq("id", invoice.id)
            .eq("status", "open")
            .select("id");
          if (updErr) {
            jsonLog("warn", {
              reqId,
              evt: "asaas_invoice_reconcile_settle_failed",
              invoice: invoice.id,
              err: updErr.message,
            });
          } else if (upd?.length) {
            stats.invoices_settled++;
            jsonLog("info", {
              reqId,
              evt: "asaas_invoice_reconcile_invoice_settled",
              invoice: invoice.id,
              payment: pay.id,
            });
          }
        }

        // (c) Valor divergente — nunca corrige silenciosamente pra nenhum
        // dos dois lados. UPDATE condicional (`.eq('enforcement_hold',
        // false)`) garante que uma retenção já existente não tem motivo/data
        // reescritos por uma segunda divergência encontrada depois.
        if (
          shouldHoldValueMismatch({
            localStatus: invoice.status,
            alreadyHeld: invoice.enforcementHold,
            localAmountCents: invoice.amountCents,
            remoteAmountCents: remoteCents,
          })
        ) {
          const { data: heldRow, error: holdErr } = await supabase
            .from("billing_invoices")
            .update({
              enforcement_hold: true,
              enforcement_hold_reason: "VALUE_MISMATCH",
              enforcement_held_at: new Date().toISOString(),
            })
            .eq("id", invoice.id)
            .eq("enforcement_hold", false)
            .select("id");
          if (holdErr) {
            jsonLog("error", {
              reqId,
              evt: "asaas_invoice_reconcile_hold_failed",
              invoice: invoice.id,
              err: holdErr.message,
            });
          } else if (heldRow?.length) {
            stats.value_mismatches++;
            stats.invoices_held++;
            jsonLog("error", {
              reqId,
              evt: "asaas_invoice_reconcile_value_mismatch",
              invoice: invoice.id,
              payment: pay.id,
              local_cents: invoice.amountCents,
              provider_cents: remoteCents,
            });

            // Ambiguidade financeira é falha de alta severidade: nenhuma
            // escolha silenciosa, o admin da plataforma é avisado. Best-effort
            // (nunca derruba o lote) — `enqueueBillingNotification` já trata
            // dedupe (23505) e erro de escrita internamente.
            const recipients = await resolvePlatformAdminRecipients(supabase);
            if (recipients.length > 0) {
              await enqueueBillingNotification(supabase, {
                organizationId: sub.organization_id,
                eventType: "admin_invoice_value_mismatch",
                invoiceId: invoice.id,
                recipient: recipients[0],
              });
            }
          }
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
