// Edge Function de diagnóstico do canal WhatsApp por unidade.
//
// Lê do servidor (service_role) o estado do canal, da chave de IA e as
// estatísticas das últimas 24h em `webhook_executions` + `processed_messages`.
// Alimenta a aba "Diagnóstico" em /platform/automacao/<slug>.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeadersFor } from "../_shared/cors.ts";
import {
  getWhatsAppProvider,
  type ChannelCredentials,
  type WhatsAppProvider,
} from "../_shared/whatsapp-providers.ts";
import { resolveChannelCredentials } from "../_shared/whatsapp-channel-credentials.ts";
import { selectHealthChannel } from "../_shared/whatsapp-health-core.ts";
import { readSecureOpsAlertReadiness } from "../_shared/secure-ops-alert-sender.ts";
import { checkFlagEnabled } from "../_shared/platform-flags.ts";
import { readHealthIngestionMode } from "../_shared/whatsapp-health-runtime.ts";
// As janelas de retenção vêm do núcleo da fila, não redigitadas: elas já são
// gêmeas declaradas do SQL da purga (migration 113), e um terceiro lugar com os
// mesmos números é como a divergência nasce. Núcleo PURO — sem I/O, sem Deno.
import {
  PURGE_DEAD_AFTER_DAYS,
  PURGE_DONE_AFTER_DAYS,
} from "../_shared/whatsapp-inbound-queue-core.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const AI_KEY_ENV: Record<string, string> = {
  claude: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  grok: "GROK_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

function jsonResponse(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

function presentCredentialKeys(provider: WhatsAppProvider, creds: ChannelCredentials): string[] {
  // Não expomos os valores — apenas quais chaves estão preenchidas.
  // O `else` final cobre `official` E `datafy` — acerta para a Datafy só
  // porque as chaves dela (`phone_number_id`/`access_token`/`business_account_id`)
  // coincidem com as da `official`, não por decisão deste código. O próximo
  // provider Meta-shaped com uma chave de credencial própria não terá essa
  // sorte; se acontecer, discrimine por `provider === "..."` aqui.
  const keys: Array<keyof ChannelCredentials> =
    provider === "zapi"
      ? ["instance_id", "token", "client_token"]
      : provider === "uazapi"
        ? []
      : provider === "waha"
        ? ["base_url", "api_key", "session_name"]
        : ["phone_number_id", "business_account_id", "access_token", "app_secret"];
  return keys.filter((k) => {
    const v = creds[k];
    return typeof v === "string" && v.length > 0;
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeadersFor(req) });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse(req, { error: "Não autenticado." }, 401);

    const { data: callerData, error: callerErr } = await supabase.auth.getUser(jwt);
    if (callerErr || !callerData.user) return jsonResponse(req, { error: "Sessão inválida." }, 401);

    if (!(await isPlatformAdmin(callerData.user.id))) {
      return jsonResponse(req, { error: "Apenas administradores da plataforma." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const unitId: string = body.unit_id ?? "";
    if (!unitId) return jsonResponse(req, { error: "unit_id é obrigatório." }, 400);

    // ── Channel ────────────────────────────────────────────────────────────────
    const { data: channelRows, error: channelReadError } = await supabase
      .from("whatsapp_channels")
      .select("id, unit_id, provider, status, display_phone, last_event_at, last_error, credentials, is_active, instance_token_secret_id, external_instance_id, connected_at, last_health_check_at, async_ingestion_enabled, created_at, updated_at")
      .eq("unit_id", unitId)
      .order("created_at", { ascending: true });

    if (channelReadError) return jsonResponse(req, { error: "Não foi possível consultar o canal." }, 503);
    const rows = channelRows ?? [];
    const channelRow = selectHealthChannel(rows);
    const providerRedelivery = channelRow ? getWhatsAppProvider(channelRow.provider).capabilities.inboundRedelivery : undefined;
    const ingestionMode = await readHealthIngestionMode(channelRow, providerRedelivery, () => checkFlagEnabled("whatsapp_async_ingestion"));

    let providerObserved: unknown = null;
    if (channelRow) {
      try {
        const provider = channelRow.provider as WhatsAppProvider;
        const adapter = getWhatsAppProvider(provider);
        if (adapter.getConnectionStatus) {
          const credentials = await resolveChannelCredentials(supabase, {
            id: channelRow.id,
            provider,
            credentials: (channelRow.credentials ?? {}) as ChannelCredentials,
            instance_token_secret_id: channelRow.instance_token_secret_id,
          });
          providerObserved = await adapter.getConnectionStatus(credentials);
        }
      } catch (error) {
        providerObserved = { status: "provider_error", error: "provider_status_unavailable" };
        console.error("whatsapp-health:provider status", String(error));
      }
    }

    const channelInfo = channelRow
      ? {
          id: channelRow.id,
          provider: channelRow.provider,
          status: channelRow.status,
          is_active: channelRow.is_active,
          ingestion_mode_effective: ingestionMode,
          display_phone: channelRow.display_phone,
          last_event_at: channelRow.last_event_at,
          last_error: channelRow.last_error,
          credentials_present: presentCredentialKeys(
            channelRow.provider as WhatsAppProvider,
            (channelRow.credentials ?? {}) as ChannelCredentials
          ),
          instance_token_configured: channelRow.provider === "uazapi"
            ? !!channelRow.instance_token_secret_id
            : null,
          provider_observed: providerObserved,
          external_instance_id: channelRow.external_instance_id,
          connected_at: channelRow.connected_at,
          last_health_check_at: channelRow.last_health_check_at,
          created_at: channelRow.created_at,
          updated_at: channelRow.updated_at,
        }
      : null;

    // ── AI provider ────────────────────────────────────────────────────────────
    const { data: aiConfigRow } = await supabase
      .from("settings")
      .select("value")
      .eq("unit_id", unitId)
      .eq("key", "ai_config")
      .maybeSingle();

    const aiConfig = (aiConfigRow?.value ?? {}) as { provider?: string; models?: Record<string, string> };
    const aiProvider = aiConfig.provider ?? "claude";
    const aiModel = aiConfig.models?.[aiProvider];

    const { data: aiKeyRow } = await supabase
      .from("ai_provider_credentials")
      .select("last4, active, updated_at")
      .eq("unit_id", unitId)
      .eq("provider", aiProvider)
      .eq("active", true)
      .maybeSingle();

    const globalKeyEnv = AI_KEY_ENV[aiProvider];
    const hasGlobalKey = !!Deno.env.get(globalKeyEnv);

    const aiInfo = {
      provider: aiProvider,
      model: aiModel ?? null,
      key_source: aiKeyRow ? "byok" : (hasGlobalKey ? "global" : "missing"),
      byok_last4: aiKeyRow?.last4 ?? null,
      byok_updated_at: aiKeyRow?.updated_at ?? null,
      global_env: globalKeyEnv,
    };

    // ── Webhook executions (24h) ──────────────────────────────────────────────
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: execs } = await supabase
      .from("webhook_executions")
      .select("id, request_id, outcome, error, duration_ms, created_at, phone_hash, meta")
      .eq("unit_id", unitId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(50);

    const lastExecutions = execs ?? [];

    // Agrega outcomes
    const byOutcome: Record<string, number> = {};
    for (const e of lastExecutions) {
      byOutcome[e.outcome] = (byOutcome[e.outcome] ?? 0) + 1;
    }

    // Total real (sem cap) — segunda query rápida
    const { count: total24h } = await supabase
      .from("webhook_executions")
      .select("id", { count: "exact", head: true })
      .eq("unit_id", unitId)
      .gte("created_at", since);

    const stats24h = {
      total: total24h ?? 0,
      by_outcome: byOutcome,
      sample_size: lastExecutions.length,
    };

    // ── Fila de inbound: dead letter e recusa terminal de 401 ─────────────────
    //
    // DUAS CONTAGENS EXATAS, E NENHUMA SAI DE `by_outcome`. Aquele mapa é
    // calculado sobre as ÚLTIMAS 50 execuções (por isso o `sample_size` ao
    // lado): uma contagem tirada dali sub-reporta em silêncio justamente na
    // unidade movimentada, que é onde o problema aparece. Aqui é
    // `{ count: "exact", head: true }`, como o `total24h`.
    //
    // E é OUTRA TABELA. O que vai para `webhook_executions` é o outcome da
    // REQUISIÇÃO (`webhook_unauthorized`); o que se conta aqui é o outcome da
    // LINHA da fila, em `whatsapp_inbound_events`. Nomes parecidos, lugares
    // diferentes — não trocar um pelo outro.
    //
    // ISOLAMENTO ENTRE CLIENTES É O `.eq("unit_id", unitId)`, E SÓ ELE:
    // `whatsapp_inbound_events` é FORCE RLS sem policies e esta EF usa
    // `service_role`, então não há segunda barreira. O `unitId` é o do corpo da
    // requisição, já validado contra `platform_admin` no JWT lá em cima — nunca
    // um id vindo de outro lugar.
    const { count: deadLetterCount, error: deadLetterError } = await supabase
      .from("whatsapp_inbound_events")
      .select("id", { count: "exact", head: true })
      .eq("unit_id", unitId)
      .eq("status", "dead");

    // Esta é a VISIBILIDADE que paga o preço aceito do 401 terminal: a recusa
    // por identidade é descartada em silêncio (acusar o tenant errado é pior),
    // e sem contá-la "a mensagem sumiu" nunca se liga a "alguém rodou uma
    // rotação de credencial". Conta por OUTCOME e não por status: essas linhas
    // terminam em `done`, misturadas com todo sucesso.
    const { count: unauthorizedTerminalCount, error: unauthorizedError } = await supabase
      .from("whatsapp_inbound_events")
      .select("id", { count: "exact", head: true })
      .eq("unit_id", unitId)
      .eq("outcome", "queue_unauthorized_terminal");

    // ── O BACKLOG: a única pergunta que as duas contagens acima NÃO respondem ──
    //
    // "O PIPELINE ESTÁ ANDANDO?" Nenhuma contagem de estado terminal responde
    // isso, e a de `dead` responde com a verdade mais enganosa possível: quem faz
    // uma linha virar `dead` é a VARREDURA, incrementando `attempts` (no takeover
    // do claim e na finalização — migration 113, e não há terceiro escritor). Se a
    // varredura não roda, a escada de retentativa nunca avança e NENHUMA linha
    // alcança `dead`. O painel devolve `dead_letter: 0` com toda a verdade,
    // enquanto a fila enche e cada cliente daquele canal fica sem resposta.
    //
    // A varredura pode parar em silêncio de duas formas, e nenhuma delas reporta a
    // ninguém: o job desagendado, ou o `pg_net` levando 401 desde uma rotação de
    // `internal_api_key` — `pg_net` é fire-and-forget. É a MESMA forma do incidente
    // de 2026-09-03 com `whatsapp_channels.status`: o filtro sempre funcionou,
    // faltava quem dissesse a verdade a ele, e quem descobriu descobriu por acaso,
    // no quinto dia.
    //
    // O caminho rápido (`EdgeRuntime.waitUntil`) continua processando o que chega
    // mesmo sem varredura — então "nada avança" seria forte demais. O que morre é
    // o BACKSTOP: retentativa de quem falhou, takeover de lease órfão, promoção a
    // `dead` e a própria purga (que roda DENTRO da varredura, logo o `raw_body`
    // com PII passa a ficar retido indefinidamente).
    //
    // DUAS FACES DO MESMO FATO, numa consulta só. A contagem DIMENSIONA o dano; a
    // idade da mais antiga é o SINAL. Uma linha `received` de três horas não pode
    // ser rajada legítima: a escada tem três degraus e acaba (~7,5 min de espera,
    // `MAX_PENDING_BACKLOG_AGE_MS` no núcleo é o teto folgado).
    //
    // A CONSULTA É UMA SÓ DE PROPÓSITO: contagem e mais-antiga saem do MESMO
    // instantâneo e não podem se contradizer (contar 5 e não achar a mais antiga,
    // ou contar 0 com uma data na mão). Duas consultas sequenciais é o defeito que
    // `asaas-invoice-reconcile-core.ts` já pagou por outro caminho.
    //
    // ─── O RELÓGIO: POR QUE SAI O `received_at` CRU E NÃO UM BOOLEANO ──────────
    //
    // Tentador seria contar aqui o que está VENCIDO — ou o lease órfão
    // (`status='processing' and claimed_until < now()`). As duas coisas exigiriam
    // filtro do supabase-js contra um instante do DENO, e o relógio desta fase é
    // UM: o do banco (cabeçalho da 113). O que decide não é a forma, é a MARGEM e o
    // que uma inversão custa. `claimed_until` é escrito como `now() + 90 s` pelo
    // banco: ali 90 segundos de defasagem invertem a resposta, e a resposta decide
    // QUEM É O DONO de uma linha — duas IAs respondendo ao mesmo cliente, ou uma
    // linha presa. Já a janela de 24 h do `stats_24h` logo acima também é do Deno,
    // e ninguém se importa: a margem é um dia e a consequência é cosmética.
    //
    // Idade para EXIBIÇÃO cai no segundo grupo, e ainda assim não precisa do Deno:
    // sai daqui o `received_at` CRU, escrito pelo banco, e quem calcula a idade é
    // `src/lib/whatsapp-inbound-backlog.ts` contra o `generated_at` desta resposta.
    // Defasagem de milissegundos desloca uma idade de três horas em
    // milissegundos, e o veredito fica num núcleo puro que o vitest alcança — coisa
    // que um filtro de PostgREST nunca seria.
    //
    // CONTAGEM DE LEASE ÓRFÃO NÃO ENTRA, e a razão não é o relógio: seria uma RPC,
    // logo uma migration, e a 115 está prometida à Fase D. Nada se perde na
    // detecção — lease órfão é linha não-terminal, então já está nesta contagem e
    // seu `received_at` já disputa o posto de mais antiga. O que falta é só o
    // refinamento do diagnóstico (worker morrendo no meio vs. ninguém buscando).
    const { data: pendingRows, count: pendingCount, error: pendingError } = await supabase
      .from("whatsapp_inbound_events")
      .select("received_at", { count: "exact" })
      .eq("unit_id", unitId)
      .in("status", ["received", "processing"])
      .order("received_at", { ascending: true })
      .limit(1);

    // A JANELA VIAJA COM O NÚMERO. Contagem sem janela é número que o operador
    // interpreta errado uma vez e para de olhar: as duas são ACUMULADAS até a
    // purga, e as purgas são diferentes — `dead` fica 30 dias, o 401 terminal
    // morre em `done` e sai em 7.
    //
    // E O BACKLOG NÃO TEM JANELA, por isso NÃO CARREGA `window_days` — a forma dele
    // é OUTRA, não a mesma com um número diferente. Linha não-terminal não é
    // purgada (`purge_whatsapp_inbound_events` só alcança `done` e `dead`), então
    // qualquer janela anexada a esse número seria afirmação falsa: ele é o estado
    // AGORA, não um acumulado de N dias. Copiar a forma das duas contagens acima
    // por simetria é exatamente o erro que esta ausência evita; quem "unificar" os
    // tipos reintroduz a mentira.
    //
    // `count: null` É "NÃO CONSEGUI CONTAR", NUNCA ZERO. Leitura que falha —
    // tabela ainda inexistente porque a EF foi deployada antes do `db push`,
    // banco fora — devolveria `count: null` no supabase-js, e um `?? 0`
    // afirmaria "nenhum dead letter" no exato momento em que ninguém sabe. É a
    // mesma régua de `hasOpenCycle: null` no painel de instâncias: quem não
    // disse não afirma o negativo.
    const inboundQueue = {
      dead_letter: {
        count: deadLetterError ? null : (deadLetterCount ?? 0),
        window_days: PURGE_DEAD_AFTER_DAYS,
      },
      unauthorized_terminal: {
        count: unauthorizedError ? null : (unauthorizedTerminalCount ?? 0),
        window_days: PURGE_DONE_AFTER_DAYS,
      },
      // `count: null` é "não consegui contar", e aqui ele é LOAD-BEARING de um jeito
      // que não é nas duas de cima: `oldest_received_at: null` é AMBÍGUO por
      // natureza — "fila vazia" e "não consegui ler" produzem o mesmo `null`. Quem
      // desempata é o `count`, e é por isso que o consumidor tem de lê-lo PRIMEIRO:
      // `count: 0` com data nula é fila vazia; `count: null` com data nula é
      // ignorância. `describeInboundBacklog` faz essa ordem valer.
      pending: {
        count: pendingError ? null : (pendingCount ?? 0),
        oldest_received_at: pendingError
          ? null
          : (pendingRows?.[0]?.received_at ?? null),
      },
    };

    const opsAlertReadiness = await readSecureOpsAlertReadiness({
      endpoint: Deno.env.get("WHATSAPP_OPS_ALERT_URL"),
      projectUrl: Deno.env.get("SUPABASE_URL"),
      token: Deno.env.get("WHATSAPP_OPS_ALERT_TOKEN"),
    });

    return jsonResponse(req, {
      success: true,
      generated_at: new Date().toISOString(),
      ops_alert_sender_configured: opsAlertReadiness.senderConfigured,
      ops_alert_configured: opsAlertReadiness.receiverReady,
      channel: channelInfo,
      ai: aiInfo,
      stats_24h: stats24h,
      inbound_queue: inboundQueue,
      last_executions: lastExecutions,
    });
  } catch (err) {
    console.error("whatsapp-health unhandled", err);
    return jsonResponse(req, { error: "Falha ao obter diagnóstico." }, 500);
  }
});
