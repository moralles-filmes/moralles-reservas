/**
 * Webhook do Asaas (Fase 2 billing-asaas). Recebe eventos de pagamento/
 * assinatura/checkout e SÓ persiste + classifica (known/unknown) em
 * `billing_events`. NÃO ativa assinatura, NÃO credita saldo, NÃO muda
 * `organizations.billing_status` — isso é Fase 4 (ainda não implementada).
 *
 * Sem HMAC: autenticação é um token estático no header `asaas-access-token`
 * (doc §1), comparado em tempo constante via `validateStaticTokenHeader`.
 * Diferente do stripe-webhook, aqui a ordem é INVERTIDA: persiste ANTES de
 * processar (`processing_status='received'` antes de qualquer classificação)
 * — se o processamento estourar ou o isolate morrer depois do INSERT, o
 * evento já está salvo e o worker de reconcile (Task 5) reprocessa.
 *
 * ⚠ Responde SEMPRE 200 — exceto 405 (não-POST), 401 (token inválido) e 500
 * (token não configurado no servidor). O Asaas só conta HTTP 200 como
 * entrega bem-sucedida (doc §2): 201/204/qualquer outro 2xx conta como
 * FALHA, 15 falhas seguidas interrompem a fila, e eventos parados nela são
 * apagados após 14 dias (só um e-mail avisa). Por isso até duplicata, evento
 * desconhecido, flag desligada e erro interno de processamento respondem 200
 * — nunca "corrigir" um branch de sucesso pra 204/202 achando que está mais
 * correto com HTTP.
 *
 * Gate: só processa se platform_flags.asaas_enabled=true (fail-closed,
 * `isFlagEnabled`); com a flag OFF responde 200 sem persistir nada.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { genRequestId, jsonLog, validateStaticTokenHeader } from "../_shared/security.ts";
import { getAsaasWebhookToken } from "../_shared/asaas-config.ts";
import { isFlagEnabled } from "../_shared/platform-flags.ts";
import { classifyAsaasEvent, parseAsaasWebhookEnvelope } from "../_shared/asaas-core.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

serve(async (req) => {
  // Não é entrega de evento — não conta pro contador de falha do Asaas.
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const reqId = genRequestId();

  // ── Auth: as ÚNICAS respostas não-200 além do 405 ──────────────────────
  // Token não configurado no servidor → falha alto (500) em vez de aceitar
  // qualquer requisição sem forma de autenticar quem chamou.
  const expectedToken = await getAsaasWebhookToken();
  if (!expectedToken) {
    jsonLog("error", { reqId, evt: "asaas_webhook_no_token" });
    return new Response("Server misconfigured", { status: 500 });
  }

  if (!validateStaticTokenHeader(req, "asaas-access-token", expectedToken)) {
    jsonLog("warn", { reqId, evt: "asaas_webhook_invalid_token" });
    return new Response("Unauthorized", { status: 401 });
  }

  // ── A partir daqui: SEMPRE 200 (ver header do arquivo) ──────────────────
  try {
    // Flag desligada → não processa NEM persiste. Precisa ser 200: um
    // não-200 numa feature desligada mataria a fila do Asaas do mesmo jeito.
    const enabled = await isFlagEnabled("asaas_enabled");
    if (!enabled) {
      jsonLog("info", { reqId, evt: "asaas_webhook_flag_off" });
      return new Response("OK", { status: 200 });
    }

    let rawBody: unknown = null;
    try {
      rawBody = await req.json();
    } catch {
      rawBody = null;
    }

    const parsed = parseAsaasWebhookEnvelope(rawBody);
    if (!parsed.valid) {
      // Payload quebrado não se beneficia de retry — o Asaas mandaria o
      // mesmo lixo de novo e só queimaria o contador de falhas.
      jsonLog("warn", { reqId, evt: "asaas_webhook_invalid_envelope", reason: parsed.reason });
      return new Response("OK", { status: 200 });
    }

    // INSERT ANTES de processar (invariante desta EF). `organization_id`
    // fica null nesta fase — resolver a org do evento é trabalho da Fase 4.
    const { data: inserted, error: insertError } = await supabase
      .from("billing_events")
      .insert({
        provider: "asaas",
        provider_event_id: parsed.id,
        event_type: parsed.event,
        organization_id: null,
        data: rawBody,
        processing_status: "received",
      })
      .select("id")
      .single();

    if (insertError) {
      if (insertError.code === "23505") {
        // Entrega "at least once" do Asaas — mesmo evento chegando 2x.
        // Dedupe silencioso: já persistido na 1ª entrega, nada a reprocessar.
        jsonLog("info", {
          reqId,
          evt: "asaas_webhook_duplicate",
          eventType: parsed.event,
          providerEventId: parsed.id,
        });
        return new Response("OK", { status: 200 });
      }

      // Erro inesperado no INSERT (fora de duplicata): nada foi persistido,
      // mas um não-200 aqui arrisca derrubar a fila inteira do Asaas — pior
      // que perder este evento pontual. Log carrega o suficiente pra
      // investigar; nunca devolver error.message cru pro Asaas.
      jsonLog("error", { reqId, evt: "asaas_webhook_insert_error", err: insertError.message });
      return new Response("OK", { status: 200 });
    }

    const billingEventId = inserted.id as string;

    // "Processar" nesta fase é só classificar known/unknown — nenhuma ação
    // de negócio (ativar assinatura, creditar saldo, billing_status) mora
    // aqui. Evento desconhecido NUNCA vira erro (doc §2 — foge do escopo da
    // Fase 2, mas ainda é uma entrega válida do Asaas).
    try {
      const classification = classifyAsaasEvent(parsed.event);
      const newStatus = classification === "known" ? "processed" : "ignored";

      const { error: updateError } = await supabase
        .from("billing_events")
        .update({ processing_status: newStatus })
        .eq("id", billingEventId);

      if (updateError) throw updateError;

      jsonLog("info", {
        reqId,
        evt: classification === "known" ? "asaas_webhook_processed" : "asaas_webhook_ignored",
        eventType: parsed.event,
        providerEventId: parsed.id,
      });
      return new Response("OK", { status: 200 });
    } catch (processErr) {
      // Já está persistido (processing_status='received') — o worker de
      // reconcile (Task 5) reprocessa. Mensagem curta, sem vazar detalhe
      // sensível; o detalhe completo vai só pro jsonLog.
      jsonLog("error", {
        reqId,
        evt: "asaas_webhook_process_error",
        eventType: parsed.event,
        providerEventId: parsed.id,
        err: String(processErr),
      });

      try {
        await supabase
          .from("billing_events")
          .update({
            processing_status: "failed",
            error_message: "Erro inesperado ao classificar evento — ver logs.",
          })
          .eq("id", billingEventId);
      } catch {
        // Best-effort: se o UPDATE também falhar, a linha fica em 'received'
        // e o reconcile (Task 5) reprocessa do jeito que está.
      }

      return new Response("OK", { status: 200 });
    }
  } catch (err) {
    // Rede de segurança final — qualquer coisa não prevista acima ainda
    // responde 200 (invariante §2: erro interno nunca é motivo pra não-200).
    jsonLog("error", { reqId, evt: "asaas_webhook_unexpected", err: String(err) });
    return new Response("OK", { status: 200 });
  }
});
