/**
 * Webhook do Asaas. Recebe eventos de pagamento/assinatura/checkout, persiste
 * em `billing_events` e APLICA o efeito de negócio via `applyAsaasEvent`
 * (registrar o pagamento, ativar a assinatura, liberar
 * `organizations.billing_status`). A aplicação é compartilhada com
 * `process-asaas-reconcile` — a lógica mora em
 * `_shared/asaas-billing-events-apply.ts` e não pode divergir entre os dois.
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
 * INSERT em billing_events, falha ao LER platform_flags, ou falha ao LER o
 * corpo da requisição — TCP resetado/stream truncado no meio do body, que é
 * diferente de "o Asaas mandou JSON quebrado" e por isso pede retry em vez de
 * descarte). O Asaas só
 * conta HTTP 200 como entrega bem-sucedida (doc §2): 201/204/qualquer outro
 * 2xx conta como FALHA, 15 falhas seguidas interrompem a fila, e eventos
 * parados nela são apagados após 14 dias (só um e-mail avisa) — mas até lá
 * eles SOBREVIVEM e são reentregues em ordem cronológica na reativação.
 *
 * Por isso a régua não é "200 = sucesso, resto = erro" — é "200 = já está
 * durável ou foi deliberadamente descartado; não-200 = não consegui guardar,
 * tenta de novo". Duplicata, envelope inválido, evento desconhecido, flag
 * GENUINAMENTE off e erro de PROCESSAMENTO — inclusive falha ao APLICAR o
 * efeito de negócio, que vira `processing_status='failed'` e é a linha já
 * durável que o reconcile reprocessa — respondem 200. Só
 * falha de PERSISTÊNCIA (a linha nunca chegou a existir — INSERT quebrou, ou
 * nem sabemos se a flag está ligada porque a leitura falhou) é 503: um 200
 * aí apagaria um evento de pagamento pra sempre, sem nada pro reconcile
 * encontrar. Nunca "corrigir" um branch de sucesso pra 204/202 achando mais
 * correto com HTTP; nunca "corrigir" o 503 pra 200 achando mais consistente
 * com os vizinhos — são classes de erro diferentes de propósito.
 *
 * ⏱ Além do código HTTP, o TEMPO também é contrato: o Asaas corta em 10s e
 * conta o estouro como falha de entrega, com o mesmo efeito de fila
 * interrompida. Por isso todo I/O com a API do Asaas feito aqui dentro é
 * limitado por `ASAAS_IO_BUDGET_MS` (ver constante abaixo) — falha rápida,
 * nunca `EdgeRuntime.waitUntil`. Qualquer chamada externa nova neste caminho
 * entra no mesmo orçamento.
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
import { applyAsaasEvent } from "../_shared/asaas-billing-events-apply.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

/**
 * Teto de wall-clock pro I/O com a API do Asaas dentro desta resposta.
 *
 * O Asaas concede 10s (doc §2) e conta o estouro como FALHA de entrega; 15
 * seguidas INTERROMPEM a fila de eventos de todos os clientes, que é apagada
 * em 14 dias. ~5s deixa margem confortável pro INSERT já feito, pelo UPDATE de
 * carimbo e pelas escritas do aplicador.
 *
 * Sem este teto, um único `getPayment` lento estoura os 10s sozinho (15s de
 * timeout por tentativa × 3 tentativas + backoff + até 30s honrando
 * `RateLimit-Reset`) — e o cenário é auto-amplificante: numa rajada, o limite
 * de 50 GETs concorrentes (§10) gera 429 em massa, todas as invocações dormem
 * juntas e todas estouram. Estourar o orçamento vira `failed` (o reconcile
 * retenta), NUNCA 503: a linha já está persistida, e 503 dispararia redelivery
 * queimando justamente o contador de 15.
 */
const ASAAS_IO_BUDGET_MS = 5_000;

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

    // Ler o corpo é uma etapa DISTINTA de parsear o JSON — conflar as duas
    // (ex.: um `req.json()` só com try/catch em volta) esconde uma falha de
    // TRANSPORTE (conexão resetada/stream truncado a meio do body) atrás do
    // mesmo log de "envelope inválido" que cobre JSON genuinamente malformado.
    // São classes diferentes: JSON malformado é o Asaas mandando lixo — retry
    // traria o MESMO lixo de novo, 200 é correto. Falha de LEITURA é a rede
    // comendo bytes no meio do caminho — o corpo real nunca chegou a existir
    // pra gente, e um retry teria toda chance de entregá-lo intacto; 200 aqui
    // destruiria o evento pra sempre sem o reconcile (Task 5) ter o que achar
    // (a linha nunca é inserida em billing_events). Por isso separado do
    // erro de INSERT abaixo, mas na MESMA classe de resposta (503).
    let rawText: string;
    try {
      rawText = await req.text();
    } catch (err) {
      jsonLog("error", { reqId, evt: "asaas_webhook_body_read_error", err: String(err) });
      return new Response("Erro ao ler corpo da requisição", { status: 503 });
    }

    let rawBody: unknown = null;
    try {
      rawBody = JSON.parse(rawText);
    } catch (err) {
      // Corpo foi lido por completo (não é falha de transporte) — só não é
      // JSON válido. Loga o motivo (antes isso era descartado em silêncio) e
      // cai no branch de envelope inválido abaixo, que responde 200.
      jsonLog("warn", { reqId, evt: "asaas_webhook_json_parse_error", err: String(err) });
      rawBody = null;
    }

    const parsed = parseAsaasWebhookEnvelope(rawBody);
    if (!parsed.valid) {
      // Payload quebrado não se beneficia de retry — o Asaas mandaria o
      // mesmo lixo de novo e só queimaria o contador de falhas.
      jsonLog("warn", { reqId, evt: "asaas_webhook_invalid_envelope", reason: parsed.reason });
      return new Response("OK", { status: 200 });
    }

    // INSERT ANTES de processar (invariante desta EF). `organization_id` entra
    // null de propósito: quem resolve a org é `applyAsaasEvent` (invoice →
    // externalReference → customer Asaas), e o valor resolvido é carimbado de
    // volta no UPDATE lá embaixo. Persistir primeiro e correlacionar depois é
    // o que garante que um evento sobreviva mesmo se a correlação falhar.
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

    // "Processar" é DUAS coisas: classificar (known/unknown) e APLICAR o efeito
    // de negócio. A linha já está durável, então daqui pra baixo TODO caminho
    // responde 200 — inclusive falha de negócio, que vira
    // `processing_status='failed'` + `error_message` pro reconcile reprocessar.
    // Um 503 aqui faria o Asaas reenviar um evento que já está salvo e queimaria
    // o contador de falhas da fila (doc §2) sem nada a ganhar.
    try {
      // Evento fora do catálogo NUNCA vira erro (doc §2: o Asaas adiciona
      // eventos novos) e nem entra no aplicador: sem catálogo não há efeito a
      // decidir, e `applyAsaasEvent` gastaria uma chamada à API do Asaas pra
      // chegar na mesma conclusão de 'ignored'.
      if (classifyAsaasEvent(parsed.event) === "unknown") {
        const { error: ignoreError } = await supabase
          .from("billing_events")
          .update({ processing_status: "ignored" })
          .eq("id", billingEventId);

        if (ignoreError) throw ignoreError;

        jsonLog("info", {
          reqId,
          evt: "asaas_webhook_ignored",
          eventType: parsed.event,
          providerEventId: parsed.id,
        });
        return new Response("OK", { status: 200 });
      }

      // `applyAsaasEvent` por contrato NUNCA lança — todo caminho de erro volta
      // como `{status:'failed'}` justamente pra este 200 continuar valendo.
      const result = await applyAsaasEvent(supabase, {
        id: billingEventId,
        provider_event_id: parsed.id,
        event_type: parsed.event,
        // `parsed.valid` já provou que o corpo é objeto não-nulo e não-array
        // (`parseAsaasWebhookEnvelope`), então o cast não esconde nada aqui.
        data: rawBody as Record<string, unknown>,
        // Sempre null: a linha acabou de ser inserida sem org. Quem resolve é o
        // aplicador, e o resultado é carimbado no UPDATE logo abaixo.
        organization_id: null,
      }, {
        // O orçamento é DESTE caller — o `process-asaas-reconcile` chama o
        // mesmo aplicador SEM ele e mantém os retries completos, porque roda em
        // cron sem ninguém esperando a resposta.
        asaasIoBudgetMs: ASAAS_IO_BUDGET_MS,
      });

      // `error_message` é gravado SEMPRE, inclusive `null` no sucesso — senão um
      // diagnóstico velho ficaria colado numa linha que reprocessou com êxito.
      const { error: stampError } = await supabase
        .from("billing_events")
        .update({
          processing_status: result.status,
          organization_id: result.organizationId,
          error_message: result.error ?? null,
        })
        .eq("id", billingEventId);

      if (stampError) {
        // Deliberadamente NÃO é `throw`: o efeito pode ter sido aplicado por
        // completo e só o carimbo falhou — cair no catch gravaria 'failed' por
        // cima de um evento que deu certo, usando o mesmo UPDATE que acabou de
        // provar que não está funcionando. A linha fica em 'received' e o
        // reconcile reprocessa (o aplicador é idempotente por UPDATE
        // condicional). supabase-js RESOLVE com `{ error }` em vez de rejeitar,
        // por isso `if` e não `catch`.
        jsonLog("error", {
          reqId,
          evt: "asaas_webhook_stamp_failed",
          billingEventId,
          err: stampError.message,
        });
      }

      // `failed` sobe pra nível error: é evento de dinheiro que NÃO surtiu
      // efeito e depende do reconcile — não pode se esconder num log "info".
      jsonLog(result.status === "failed" ? "error" : "info", {
        reqId,
        evt: "asaas_webhook_applied",
        eventType: parsed.event,
        providerEventId: parsed.id,
        status: result.status,
        effect: result.effect,
        organizationId: result.organizationId,
      });
      return new Response("OK", { status: 200 });
    } catch (processErr) {
      // Rede de segurança do bloco de processamento. Com `applyAsaasEvent` não
      // lançando por contrato, na prática só o UPDATE da classificação chega
      // aqui. Já está persistido (`processing_status='received'`) — o
      // reconcile reprocessa. Mensagem curta, sem vazar detalhe sensível; o
      // detalhe completo vai só pro jsonLog.
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
          // Texto LIVRE desde a Fase 4a: o `process-asaas-reconcile` deixou de
          // depender de uma whitelist de mensagens (ele reaplica o efeito e
          // sobrescreve `error_message` com o resultado real, inclusive `null`),
          // então mudar esta string não gruda mais diagnóstico velho em linha
          // resolvida. Continua sendo mensagem curta, sem detalhe do Postgres.
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
