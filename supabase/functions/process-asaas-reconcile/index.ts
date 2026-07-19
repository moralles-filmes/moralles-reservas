/**
 * Worker de reconciliação do Asaas. Roda diariamente via pg_cron (migration
 * `20260716140000_064_process_asaas_reconcile_cron.sql`).
 *
 * REDE DE SEGURANÇA DO DINHEIRO — dois estágios, dois buracos diferentes:
 *
 * 1. EVENTOS PRESOS: `billing_events` do Asaas em 'received'/'failed'. O
 *    `asaas-webhook` persiste ANTES de aplicar; se o aplicador falhar (Asaas
 *    fora do ar, orçamento de 5s estourado, UPDATE com timeout) ou o isolate
 *    morrer no meio, a linha fica parada. Aqui ela é REPROCESSADA pelo MESMO
 *    `applyAsaasEvent` de `_shared/asaas-billing-events-apply.ts` que o webhook
 *    usa — nunca por uma cópia da lógica, e nunca por uma mera reclassificação
 *    (ver aviso abaixo).
 *
 * 2. EVENTOS PERDIDOS: cobrança que consta paga no Asaas mas continua
 *    'open'/'draft' aqui. Quando a fila do Asaas é interrompida (15 falhas
 *    seguidas), os eventos são apagados em 14 dias e ninguém mais nos conta que
 *    o cliente pagou — nenhuma linha de `billing_events` existe pro estágio 1
 *    encontrar. Este estágio PERGUNTA à API (`getPayment`) e, ao achar
 *    divergência, aplica o mesmo efeito por um evento SINTÉTICO.
 *
 * ⚠️ POR QUE NÃO RECLASSIFICAR: até a Fase 4a este worker só rodava
 * `classifyAsaasEvent` e carimbava known→'processed' / unknown→'ignored'. Com o
 * webhook aplicando efeito de negócio, 'processed' passou a significar "a
 * assinatura foi ativada de verdade" — reclassificar pegaria uma linha 'failed'
 * com diagnóstico legítimo, marcaria 'processed' (a classificação sempre
 * funciona, é só known/unknown) e tiraria o evento da fila sem nada ter sido
 * ativado: cliente pago e bloqueado, sem rastro. A classificação continua
 * acontecendo, mas DENTRO do aplicador (`decideEventEffect` devolve `unknown` →
 * 'ignored'), antes de qualquer I/O com o Asaas.
 *
 * ⏱ SEM orçamento de tempo (`ApplyOptions.asaasIoBudgetMs`) de propósito: o
 * corte existe pros 10s que o Asaas concede ao webhook, com um cliente
 * esperando. Aqui é cron, ninguém espera, e apertar o tempo degradaria
 * justamente a rede de segurança que este worker é.
 *
 * `retry_count` é SEMPRE incrementado no estágio 1 (sucesso ou falha do item) —
 * sem isso uma linha venenosa seria reprocessada pra sempre; ao passar de
 * `MAX_RETRY_COUNT` ela some da query e o operador precisa olhar
 * `error_message` manualmente.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalAuth, genRequestId, jsonLog } from "../_shared/security.ts";
import { checkFlagEnabled } from "../_shared/platform-flags.ts";
import { asaasValueToCents } from "../_shared/asaas-core.ts";
import { getBillingProvider } from "../_shared/billing-provider.ts";
import { applyAsaasEvent } from "../_shared/asaas-billing-events-apply.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

/** Teto de tentativas por linha — depois disso ela para de aparecer na query
 *  (ver filtro abaixo) e exige olhar `error_message` manualmente. Mesma
 *  ordem de grandeza do `max 5` do process-notification-outbox (CLAUDE.md). */
const MAX_RETRY_COUNT = 5;

/** Teto de linhas por execução, nos DOIS estágios. CLAUDE.md: PostgREST trunca
 *  em `db-max-rows` (default 1000) sem avisar — fica bem abaixo disso. O resto
 *  sobra pra próxima execução de propósito (não é um `.range()` em loop): o
 *  estágio 2 gasta um GET na API do Asaas por linha, e a quota é de 25k req/12h
 *  (§10) compartilhada com o resto do produto. Se o volume crescer, o que muda
 *  é a CADÊNCIA do cron, não este teto. */
const BATCH_LIMIT = 200;

/**
 * Status do Asaas que significam "o dinheiro entrou" (§3/§9). `CONFIRMED` é
 * cartão aprovado e `RECEIVED` é liquidado — os dois liberam acesso, mesma
 * régua de `ACTIVATING_EVENTS` em `_shared/asaas-billing-events.ts`.
 */
const REMOTE_PAID_STATUSES: ReadonlySet<string> = new Set(["RECEIVED", "CONFIRMED"]);

/**
 * Evento sintético do estágio 2. Não existe linha em `billing_events` para
 * ele — é só o veículo que faz o `applyAsaasEvent` decidir
 * `activate_subscription` a partir de uma cobrança que o Asaas já deu por paga.
 * `PAYMENT_RECEIVED` de propósito: é o evento que teríamos recebido se a fila
 * não tivesse sido interrompida.
 */
const SYNTHETIC_EVENT_TYPE = "PAYMENT_RECEIVED";

interface StuckEvent {
  id: string;
  provider_event_id: string | null;
  event_type: string;
  data: Record<string, unknown> | null;
  organization_id: string | null;
  retry_count: number;
}

interface OpenInvoice {
  id: string;
  organization_id: string;
  provider_payment_id: string | null;
  status: string;
  amount_cents: number;
  purpose: string | null;
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

    // ═══════════════════════════════════════════════════════════════════════
    // ESTÁGIO 1 — eventos presos em 'received'/'failed'
    // ═══════════════════════════════════════════════════════════════════════

    // `provider_event_id`, `data` e `organization_id` entram no SELECT porque
    // são o input de `applyAsaasEvent`. `organization_id` em especial: é ele
    // que mantém vivo o guard `missing_payment_id` do aplicador — pelo caminho
    // do webhook aquele guard é inalcançável (sem `payment.id` não há org a
    // resolver e o portão anterior já retorna), e é o carimbo feito na primeira
    // passagem do webhook que faz o reconcile atravessar até lá.
    const { data: stuckEvents, error: fetchError } = await supabase
      .from("billing_events")
      .select("id, provider_event_id, event_type, data, organization_id, retry_count")
      .eq("provider", "asaas")
      .in("processing_status", ["received", "failed"])
      .lt("retry_count", MAX_RETRY_COUNT)
      .order("processed_at", { ascending: true })
      .limit(BATCH_LIMIT);

    if (fetchError) {
      // Best-effort: sem a lista não há evento a reprocessar agora, mas não é
      // motivo pra 500 nem pra pular o estágio 2, que é INDEPENDENTE (lê
      // `billing_invoices`, não `billing_events`) e é justamente o que recupera
      // pagamento sem evento nenhum. O corpo da resposta PRECISA marcar o skip
      // — senão fica idêntico a uma execução saudável que não achou nada.
      jsonLog("error", { reqId, evt: "asaas_reconcile_fetch_error", err: fetchError.message });
    }

    let processedCount = 0;
    let ignoredCount = 0;
    let errorCount = 0;

    for (const event of (stuckEvents ?? []) as StuckEvent[]) {
      try {
        // MESMA lógica do webhook, sem orçamento de tempo (ver header). Nunca
        // lança por contrato — todo erro volta como `{status:'failed'}`.
        const result = await applyAsaasEvent(supabase, {
          id: event.id,
          // Coluna é nullable no schema (linhas legadas da Stripe), mas o
          // aplicador só a carrega pra rastreio; `""` evita propagar null num
          // campo que o contrato declara string.
          provider_event_id: event.provider_event_id ?? "",
          event_type: event.event_type,
          data: event.data,
          organization_id: event.organization_id,
        });

        // `error_message` é gravado SEMPRE, inclusive `null` no sucesso — senão
        // um diagnóstico velho ficaria colado numa linha que reprocessou com
        // êxito. (Antes da Fase 4a isto exigia uma whitelist de mensagens,
        // porque a reclassificação não resolvia erro de negócio nenhum; agora o
        // aplicador escreve a própria mensagem e limpá-la é coerente.)
        const { error: updateError } = await supabase
          .from("billing_events")
          .update({
            processing_status: result.status,
            organization_id: result.organizationId,
            error_message: result.error ?? null,
            retry_count: event.retry_count + 1,
          })
          .eq("id", event.id);

        if (updateError) throw updateError;

        if (result.status === "processed") processedCount++;
        else if (result.status === "ignored") ignoredCount++;
        else errorCount++;

        // `failed` sobe pra error: é evento de dinheiro que ainda NÃO surtiu
        // efeito, mesma régua do asaas-webhook.
        jsonLog(result.status === "failed" ? "error" : "info", {
          reqId,
          evt: "asaas_reconcile_event_applied",
          billingEventId: event.id,
          eventType: event.event_type,
          status: result.status,
          effect: result.effect,
          organizationId: result.organizationId,
        });
      } catch (itemErr) {
        // `applyAsaasEvent` não lança; na prática só o UPDATE acima chega aqui.
        // Um item ruim não pode derrubar o lote.
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

    // ═══════════════════════════════════════════════════════════════════════
    // ESTÁGIO 2 — divergências: pago no Asaas, em aberto aqui
    // ═══════════════════════════════════════════════════════════════════════

    let checked = 0;
    let divergences = 0;
    let reconciled = 0;

    const { data: openInvoices, error: invoicesError } = await supabase
      .from("billing_invoices")
      .select("id, organization_id, provider_payment_id, status, amount_cents, purpose")
      .eq("provider", "asaas")
      .in("status", ["open", "draft"])
      .not("provider_payment_id", "is", null)
      .limit(BATCH_LIMIT);

    if (invoicesError) {
      jsonLog("error", {
        reqId,
        evt: "asaas_reconcile_invoices_fetch_error",
        err: invoicesError.message,
      });
    }

    const provider = getBillingProvider("asaas");

    for (const inv of (openInvoices ?? []) as OpenInvoice[]) {
      // `.not(..., "is", null)` já filtra, mas o compilador não sabe.
      const paymentId = inv.provider_payment_id;
      if (!paymentId) continue;

      checked++;

      // SEM `budgetMs`: retries completos do cliente HTTP (ver header).
      const res = await provider.getPayment(paymentId);
      if (!res.ok || !res.data) {
        // Não é divergência — é indisponibilidade. Loga (silenciar esconderia
        // um Asaas fora do ar por dias) e deixa a fatura pra próxima execução.
        jsonLog("warn", {
          reqId,
          evt: "asaas_reconcile_payment_unreadable",
          invoiceId: inv.id,
          err: res.error ?? "getPayment devolveu ok sem data",
        });
        continue;
      }

      const remoteStatus = typeof res.data.status === "string" ? res.data.status : "";
      if (!REMOTE_PAID_STATUSES.has(remoteStatus)) continue;

      divergences++;

      // `value` do Asaas é em REAIS — comparar com `amount_cents` sem converter
      // é bug de 100x. `asaasValueToCents` LANÇA em NaN/negativo, daí o guard
      // (mesmo tratamento do aplicador). Só entra no log de divergência: quem
      // registra o valor na fatura é o aplicador, que reconverte por conta.
      const rawValue = res.data.value;
      const paidCents =
        typeof rawValue === "number" && Number.isFinite(rawValue) && rawValue >= 0
          ? asaasValueToCents(rawValue)
          : null;

      // A APLICAÇÃO é delegada ao MESMO `applyAsaasEvent`, por um evento
      // sintético. Reimplementar aqui o "marca fatura paga + ativa assinatura +
      // libera a org" seria uma SEGUNDA cópia da lógica que a Task 8
      // centralizou — e perderia de graça: o portão de `purpose` derivado do
      // `externalReference` (uma recarga de IA registra o dinheiro mas NÃO
      // libera o sistema), a criação da assinatura quando ela ainda não existe
      // (um UPDATE cru afetaria zero linhas e ainda assim liberaria a org, dando
      // acesso sem assinatura), o backfill de `provider_subscription_id` e a
      // checagem de `error` em cada escrita.
      //
      // Custo aceito: um segundo `getPayment` (o aplicador refaz a leitura).
      // Divergência é rara por definição e o worker roda em cron.
      const result = await applyAsaasEvent(supabase, {
        // Marcador explicitamente sintético: não existe `billing_events.id`
        // aqui, e um uuid solto no log seria confundido com um evento real.
        id: `invoice:${inv.id}`,
        provider_event_id: `reconcile:${paymentId}`,
        event_type: SYNTHETIC_EVENT_TYPE,
        data: { payment: { id: paymentId } },
        organization_id: inv.organization_id,
      });

      if (result.status === "processed") reconciled++;

      // Item 3 dos herdados: registro consultável pelo admin. O DISPATCHER de
      // e-mail é entrega da Fase 4b (flag `billing_notifications_dispatch`);
      // até lá isto NÃO envia nada. Gravado mesmo quando a aplicação falha —
      // divergência que não conseguiu ser resolvida é MAIS urgente, não menos.
      const { error: notifError } = await supabase.from("billing_notifications").insert({
        organization_id: inv.organization_id,
        event_type: "asaas_divergence_reconciled",
        channel: "app",
        recipient: "platform_admin",
        status: result.status === "processed" ? "logged" : "failed",
        error: result.error ?? null,
      });

      if (notifError) {
        // Não derruba nada: o dinheiro já foi tratado pelo aplicador; isto é o
        // registro do alerta. Loga e segue.
        jsonLog("warn", {
          reqId,
          evt: "asaas_reconcile_notification_failed",
          invoiceId: inv.id,
          err: notifError.message,
        });
      }

      jsonLog(result.status === "processed" ? "warn" : "error", {
        reqId,
        evt: "asaas_reconcile_divergence",
        invoiceId: inv.id,
        organizationId: inv.organization_id,
        localStatus: inv.status,
        localPurpose: inv.purpose,
        remoteStatus,
        expectedCents: inv.amount_cents,
        paidCents,
        applyStatus: result.status,
        applyEffect: result.effect,
      });
    }

    const reprocessed = (stuckEvents ?? []).length;
    jsonLog("info", {
      reqId,
      evt: "asaas_reconcile_done",
      reprocessed,
      processed: processedCount,
      ignored: ignoredCount,
      errors: errorCount,
      invoicesChecked: checked,
      divergences,
      reconciled,
    });

    return new Response(
      JSON.stringify({
        success: true,
        reprocessed,
        processed: processedCount,
        ignored: ignoredCount,
        errors: errorCount,
        invoices_checked: checked,
        divergences,
        reconciled,
        // Marcadores de estágio pulado: sem eles uma execução que não conseguiu
        // LER é indistinguível de uma que não achou nada a fazer.
        ...(fetchError ? { events_skipped: "fetch_error" } : {}),
        ...(invoicesError ? { invoices_skipped: "fetch_error" } : {}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    jsonLog("error", { reqId, evt: "asaas_reconcile_error", err: String(err) });
    return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
  }
});
