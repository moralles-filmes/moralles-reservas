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
 * ⚠ Responde SEMPRE 200 — exceto 405 (não-POST), 401 (token inválido), 500
 * (token não configurado no servidor) e 503 (evento NÃO PERSISTIDO: erro no
 * INSERT em billing_events, ou falha ao LER platform_flags). O Asaas só
 * conta HTTP 200 como entrega bem-sucedida (doc §2): 201/204/qualquer outro
 * 2xx conta como FALHA, 15 falhas seguidas interrompem a fila, e eventos
 * parados nela são apagados após 14 dias (só um e-mail avisa) — mas até lá
 * eles SOBREVIVEM e são reentregues em ordem cronológica na reativação.
 *
 * Por isso a régua não é "200 = sucesso, resto = erro" — é "200 = já está
 * durável ou foi deliberadamente descartado; não-200 = não consegui guardar,
 * tenta de novo". Duplicata, envelope inválido, evento desconhecido, flag
 * GENUINAMENTE off e erro de PROCESSAMENTO (a linha já está em
 * `billing_events`, o reconcile da Task 5 reprocessa) respondem 200. Só
 * falha de PERSISTÊNCIA (a linha nunca chegou a existir — INSERT quebrou, ou
 * nem sabemos se a flag está ligada porque a leitura falhou) é 503: um 200
 * aí apagaria um evento de pagamento pra sempre, sem nada pro reconcile
 * encontrar. Nunca "corrigir" um branch de sucesso pra 204/202 achando mais
 * correto com HTTP; nunca "corrigir" o 503 pra 200 achando mais consistente
 * com os vizinhos — são classes de erro diferentes de propósito.
 *
 * Gate: só processa se platform_flags.asaas_enabled=true (fail-closed pra
 * flag GENUINAMENTE ausente/false, via `checkFlagEnabled`); com a flag OFF
 * responde 200 sem persistir nada. Falha ao LER a flag é tratada como falha
 * de persistência (503) — não pode virar "OFF" e descartar o evento.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { genRequestId, jsonLog, validateStaticTokenHeader } from "../_shared/security.ts";
import { getAsaasWebhookToken } from "../_shared/asaas-config.ts";
import { checkFlagEnabled } from "../_shared/platform-flags.ts";
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

  // ── A partir daqui: 200 na maioria dos casos, 503 se não persistir (ver
  // header do arquivo) ─────────────────────────────────────────────────────
  try {
    // Flag GENUINAMENTE desligada → não processa NEM persiste, 200 (um
    // não-200 numa feature desligada mataria a fila do Asaas à toa). Falha
    // ao LER a flag é outra coisa — ver branch abaixo.
    const flagCheck = await checkFlagEnabled("asaas_enabled");
    if (flagCheck.readFailed) {
      // Não sabemos se está ligada. Se estiver (produção real), um 200 aqui
      // descartaria um evento de pagamento pra sempre — mesma classe do
      // erro de INSERT abaixo. 503 pede retry; doc §2 garante 14 dias de
      // fila e reentrega em ordem cronológica.
      jsonLog("error", { reqId, evt: "asaas_webhook_flag_read_error" });
      return new Response("Erro ao verificar configuração", { status: 503 });
    }
    if (!flagCheck.enabled) {
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

      // Erro inesperado no INSERT (fora de duplicata): nada foi persistido —
      // diferente do erro de PROCESSAMENTO lá embaixo, aqui a linha nunca
      // chegou a existir em `billing_events`, então o reconcile (Task 5) não
      // tem o que encontrar. Um 200 aqui destruiria o evento pra sempre (o
      // Asaas marca como entregue e não reenvia); 503 custa um atraso na
      // fila (doc §2: até 14 dias, reentregue em ordem cronológica), mas o
      // evento sobrevive. NÃO "consertar" isso pra 200 por simetria com os
      // branches vizinhos — aqueles já persistiram a linha, este não.
      // Nunca devolver error.message cru pro Asaas; o detalhe vai só pro log.
      jsonLog("error", { reqId, evt: "asaas_webhook_insert_error", err: insertError.message });
      return new Response("Erro ao persistir evento", { status: 503 });
    }

    if (!inserted) {
      // Defensivo: com `strictNullChecks:false` um `inserted` null aqui não
      // é sinalizado pelo compilador, e `inserted.id` abaixo estouraria
      // TypeError pro catch mais externo → 200 → evento perdido em silêncio.
      // `.single()` torna este branch quase inalcançável (é erro-ou-linha),
      // mas o tratamento é o mesmo do INSERT que falhou: nada persistido,
      // então retry (503), não descarte (200).
      jsonLog("error", {
        reqId,
        evt: "asaas_webhook_insert_no_row",
        eventType: parsed.event,
        providerEventId: parsed.id,
      });
      return new Response("Erro ao persistir evento", { status: 503 });
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

      const { error: statusUpdateError } = await supabase
        .from("billing_events")
        .update({
          processing_status: "failed",
          error_message: "Erro inesperado ao classificar evento — ver logs.",
        })
        .eq("id", billingEventId);

      if (statusUpdateError) {
        // Best-effort: o UPDATE também falhou — a linha fica em 'received' e
        // o reconcile (Task 5) reprocessa do jeito que está. supabase-js
        // RESOLVE com `{ error }` em vez de rejeitar, por isso é um `if` e
        // não um `catch` (um catch aqui nunca dispararia de verdade).
        jsonLog("error", {
          reqId,
          evt: "asaas_webhook_status_update_failed",
          billingEventId,
          err: statusUpdateError.message,
        });
      }

      return new Response("OK", { status: 200 });
    }
  } catch (err) {
    // Rede de segurança final. Responde 503 (não 200) porque aqui NÃO dá pra
    // saber se o evento chegou a ser persistido: um throw inesperado antes do
    // INSERT com 200 perderia o evento pra sempre. Pedir retry é seguro nos
    // dois casos — se já tinha persistido, a redelivery bate na UNIQUE
    // (provider, provider_event_id) e vira dedupe silencioso com 200.
    jsonLog("error", { reqId, evt: "asaas_webhook_unexpected", err: String(err) });
    return new Response("Erro inesperado", { status: 503 });
  }
});
