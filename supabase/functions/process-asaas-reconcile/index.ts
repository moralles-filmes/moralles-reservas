/**
 * Worker: reprocessa `billing_events` do Asaas presos em 'received'/'failed'.
 *
 * O `asaas-webhook` (Task 4) persiste o evento ANTES de processar. Se a
 * classificação estourar ou o isolate morrer no meio, a linha fica em
 * `billing_events` sem ninguém revisitar — este worker fecha esse buraco.
 * Roda diariamente via pg_cron (ver migration
 * `20260716140000_064_process_asaas_reconcile_cron.sql`).
 *
 * Reclassifica com o MESMO `classifyAsaasEvent` de `_shared/asaas-core.ts`
 * que o `asaas-webhook` usa — não duplica a lista de eventos known/unknown.
 * known → `processed`; unknown → `ignored`. `retry_count` é SEMPRE
 * incrementado (sucesso ou falha do item) — sem isso uma linha venenosa
 * seria reprocessada pra sempre; ao passar de `MAX_RETRY_COUNT` ela some da
 * query e o operador precisa olhar `error_message` manualmente.
 *
 * Escopo estritamente Fase 2 — o que este worker NÃO faz (de propósito):
 * - NÃO ativa assinatura, NÃO credita saldo, NÃO muda
 *   `organizations.billing_status`, NÃO resolve `organization_id` do evento.
 *   Isso é lógica de negócio da Fase 4.
 * - NÃO consulta a API do Asaas (`getPayment`) pra conferir cobranças
 *   `PENDING` (segundo motivo do worker, doc §2: fila apagada após 14 dias
 *   sem entrega). Decisão deliberada: nenhuma EF cria cobrança Asaas ainda
 *   (`AsaasBillingProvider` sem consumidor) — `billing_invoices` não tem
 *   nenhuma linha com `provider='asaas'` pra essa consulta encontrar. Essa
 *   parte fica pra Fase 4, quando existir cobrança real pra conciliar.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalAuth, genRequestId, jsonLog } from "../_shared/security.ts";
import { checkFlagEnabled } from "../_shared/platform-flags.ts";
import { classifyAsaasEvent } from "../_shared/asaas-core.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

/** Teto de tentativas por linha — depois disso ela para de aparecer na query
 *  (ver filtro abaixo) e exige olhar `error_message` manualmente. Mesma
 *  ordem de grandeza do `max 5` do process-notification-outbox (CLAUDE.md). */
const MAX_RETRY_COUNT = 5;

/** Teto de linhas por execução. CLAUDE.md: PostgREST trunca em `db-max-rows`
 *  (default 1000) sem avisar — fica bem abaixo disso; o resto sobra pra
 *  próxima execução diária, não precisa de loop `.range()` aqui. */
const BATCH_LIMIT = 200;

/**
 * As ÚNICAS mensagens que hoje populam `billing_events.error_message` — a de
 * classificação do próprio `asaas-webhook` e a deste worker. Reclassificar
 * com sucesso RESOLVE exatamente esse erro, então é seguro apagar. Qualquer
 * mensagem FORA deste set (ex.: um diagnóstico de lógica de negócio que a
 * Fase 4 vier a gravar no webhook) NÃO é apagada por este worker — ver aviso
 * completo no loop abaixo, perto do UPDATE.
 */
const CLASSIFICATION_ERROR_MESSAGES = new Set([
  "Erro inesperado ao classificar evento — ver logs.",
  "Erro ao reprocessar no worker de reconcile — ver logs.",
]);

interface StuckEvent {
  id: string;
  event_type: string;
  retry_count: number;
  error_message: string | null;
}

serve(async (req) => {
  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const reqId = genRequestId();
  jsonLog("info", { reqId, evt: "asaas_reconcile_start" });

  try {
    // Flag genuinamente OFF → sem trabalho. Falha de LEITURA é outra coisa
    // (platform-flags.ts): não é o mesmo que "off" — loga separado pra não
    // mascarar um problema de leitura do DB como feature desligada. Skip nos
    // dois casos é seguro aqui (diferente do asaas-webhook): não processar
    // hoje só atrasa pro cron de amanhã, não perde evento nenhum — a linha
    // continua em `billing_events` esperando a próxima execução.
    const flagCheck = await checkFlagEnabled("asaas_enabled");
    if (flagCheck.readFailed) {
      jsonLog("warn", { reqId, evt: "asaas_reconcile_flag_read_error" });
      return new Response(JSON.stringify({ success: true, skipped: "flag_read_error" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!flagCheck.enabled) {
      jsonLog("info", { reqId, evt: "asaas_reconcile_flag_off" });
      return new Response(JSON.stringify({ success: true, skipped: "flag_off" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { data: stuckEvents, error: fetchError } = await supabase
      .from("billing_events")
      .select("id, event_type, retry_count, error_message")
      .eq("provider", "asaas")
      .in("processing_status", ["received", "failed"])
      .lt("retry_count", MAX_RETRY_COUNT)
      .order("processed_at", { ascending: true })
      .limit(BATCH_LIMIT);

    if (fetchError) {
      // Best-effort: sem a lista não há o que reprocessar agora, mas não é
      // motivo pra 500 o worker inteiro — tenta de novo amanhã. O status 200
      // não muda (pg_net não olha), mas o corpo PRECISA marcar o skip — senão
      // fica idêntico a uma execução saudável que não achou nada a fazer.
      jsonLog("error", { reqId, evt: "asaas_reconcile_fetch_error", err: fetchError.message });
      return new Response(JSON.stringify({ success: true, skipped: "fetch_error" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    let processedCount = 0;
    let ignoredCount = 0;
    let errorCount = 0;

    for (const event of (stuckEvents ?? []) as StuckEvent[]) {
      try {
        const classification = classifyAsaasEvent(event.event_type);
        const newStatus = classification === "known" ? "processed" : "ignored";

        // ⚠️ HOJE 'processed' SÓ significa "classificado known/unknown" — este
        // worker nunca fez mais que isso, então apagar `error_message` junto
        // é coerente (é o próprio erro que a reclassificação resolveu). QUANDO
        // A FASE 4 ADICIONAR LÓGICA DE NEGÓCIO ao `asaas-webhook` (ativar
        // assinatura, creditar saldo, mudar billing_status), 'processed' passa
        // a significar "lógica de negócio aplicada" — e ESTE WORKER PRECISA
        // RODAR ESSA MESMA LÓGICA, não só reclassificar. Sem isso, uma linha
        // 'failed' por erro de negócio (com um `error_message` diagnóstico
        // gravado pelo webhook) seria pega aqui, reclassificada (sempre
        // funciona, é só known/unknown), marcada 'processed' e o diagnóstico
        // apagado — a assinatura nunca ativou, mas a linha parece resolvida e
        // ninguém mais revisita (`.in("processing_status", ["received",
        // "failed"])` não pega mais 'processed'). Por isso só apaga
        // `error_message` quando ele é uma das DUAS mensagens que este worker
        // (ou o classificador do webhook) realmente resolve — ver
        // CLASSIFICATION_ERROR_MESSAGES acima; qualquer outra mensagem (ex.:
        // diagnóstico de negócio futuro) fica de fora do payload do UPDATE e
        // sobrevive intacta.
        const shouldClearErrorMessage =
          event.error_message !== null && CLASSIFICATION_ERROR_MESSAGES.has(event.error_message);

        const { error: updateError } = await supabase
          .from("billing_events")
          .update({
            processing_status: newStatus,
            retry_count: event.retry_count + 1,
            ...(shouldClearErrorMessage ? { error_message: null } : {}),
          })
          .eq("id", event.id);

        if (updateError) throw updateError;

        if (classification === "known") processedCount++;
        else ignoredCount++;
      } catch (itemErr) {
        errorCount++;
        jsonLog("error", {
          reqId,
          evt: "asaas_reconcile_item_error",
          billingEventId: event.id,
          err: String(itemErr),
        });

        // Incrementa retry_count MESMO na falha — best-effort separado do
        // update acima (que pode ter sido justamente o que falhou). Sem
        // isso, uma linha com erro persistente reaparece pra sempre nesta
        // query em vez de eventualmente cair fora do filtro `< MAX_RETRY_COUNT`.
        const { error: bumpError } = await supabase
          .from("billing_events")
          .update({
            retry_count: event.retry_count + 1,
            error_message: "Erro ao reprocessar no worker de reconcile — ver logs.",
          })
          .eq("id", event.id);

        if (bumpError) {
          jsonLog("error", {
            reqId,
            evt: "asaas_reconcile_retry_bump_failed",
            billingEventId: event.id,
            err: bumpError.message,
          });
        }
      }
    }

    const reprocessed = (stuckEvents ?? []).length;
    jsonLog("info", {
      reqId,
      evt: "asaas_reconcile_done",
      reprocessed,
      processed: processedCount,
      ignored: ignoredCount,
      errors: errorCount,
    });

    return new Response(
      JSON.stringify({
        success: true,
        reprocessed,
        processed: processedCount,
        ignored: ignoredCount,
        errors: errorCount,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    jsonLog("error", { reqId, evt: "asaas_reconcile_error", err: String(err) });
    return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
  }
});
