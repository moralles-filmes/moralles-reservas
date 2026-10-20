/**
 * Turno do agente de IA, independente de canal.
 *
 * Do status da conversa até a resposta: promoção do `resolved` legado, UX de
 * handoff humano (auto-resolve e lembrete), append imediato + debounce de
 * rajada, lock de exclusão por conversa, franquia de IA (reserva antes,
 * liquidação depois), system prompt, laço do agente com retry silencioso e
 * provedor reserva, e os desfechos (negação, erro → handoff, vazio, envio).
 *
 * O canal entra pelo `ChannelContext` (envio, sanitização, identidade e
 * formatação do prompt, origem da reserva) e pelo `AgentTurnIO` (registro do
 * desfecho, append na conversa, marca de efeito externo). Nada aqui sabe de
 * provider, credencial ou formato de webhook. O comportamento é preso por
 * `src/lib/agent-turn-parity.test.ts` (I/O byte a byte) mais os guardas
 * textuais que leem este arquivo; mudança deliberada vem com teste próprio, e
 * o snapshot só se regrava junto com uma mudança de comportamento decidida.
 *
 * O catch externo é do adapter: `run` lança, e quem o chama liquida
 * (`settleTurnBudget("RELEASED")`) e solta o lock (`releaseAiLock`) antes de
 * qualquer passo que possa lançar.
 *
 * As decisões continuam nos núcleos puros (`ai-budget-*`, `agent-*-core`,
 * `handoff-clock-core`, `whatsapp-inbound-queue-core`); aqui é adapter de I/O.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  runAgentLoop,
  estimateCostUsd,
  isAgentDeadlineError,
  sanitizeProviderError,
  type AgentBudgetHooks,
  type AgentLoopResult,
  type AIProvider,
} from "../ai-providers.ts";
// Catálogo único de modelos: o modelo salvo passa por `resolveModel` (aposentado
// vira sucessor, desconhecido vira default) ANTES de franquia e telemetria.
import { getModelEntry, resolveModel } from "../ai-model-catalog.ts";
// ─── Franquia de IA (Plano D) ────────────────────────────────────────────────
// O adapter faz I/O; a decisão é dos núcleos puros. Nada aqui reimplementa
// "cabe?", "isto é teto ou soluço?" ou "o que dizer ao cliente".
import {
  finalizeTurn,
  loadAiFranchise,
  makeBudgetHooks,
  openTurnBudget,
  recordMilestones,
  type TurnBudget,
} from "../ai-budget-gate.ts";
import {
  AI_BUDGET_HANDOFF_REASON,
  isCommercialHardStop,
  shouldAutoResolveHandoff,
  telemetryEventFor,
} from "../ai-budget-core.ts";
import {
  AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT,
  AI_BUDGET_HARDCODED_TEXTS,
  resolveMutationStopText,
  type MutationOutcome,
} from "../ai-budget-copy.ts";
import { resolveOrgEntitlements } from "../entitlements.ts";
import { isFlagEnabled } from "../platform-flags.ts";
import {
  agentDeadlineVerdict,
  INBOUND_DEBOUNCE_WINDOW_MS,
  type IngestionSource,
} from "../whatsapp-inbound-queue-core.ts";
import { jsonLog } from "../security.ts";
import { checkAvailability as checkAvailabilityCore } from "../availability.ts";
import { resolveHandoffClock } from "../handoff-clock-core.ts";
import {
  decideSameProviderFallback,
  parseFallbackConfig,
  shouldUseFallbackProvider,
} from "../agent-provider-fallback-core.ts";
import {
  cancelReservationScoped,
  getReservationScoped,
  updateReservationScoped,
} from "../agent-reservation-tools.ts";
import {
  agentTools,
  checkAvailability,
  createReservation,
  listCustomerReservations,
  summarizeToolInput,
  summarizeToolResult,
} from "./tools.ts";
import { loadAgentSystemPrompt } from "./system-prompt.ts";
import type { ChannelContext, ChannelSendResult, TurnInbound } from "./channel-context.ts";

const HANDOFF_AUTO_RESOLVE_MS = 12 * 60 * 60 * 1000;       // 12h
const HANDOFF_REMINDER_THROTTLE_MS = 6 * 60 * 60 * 1000;   // 6h

/**
 * Texto de instabilidade — UMA constante, não quatro literais.
 *
 * Ele é enviado em três desfechos diferentes E precisa estar no
 * `HARDCODED_AGENT_NOISE`. Redigitado, editar um sem os outros faz a mensagem
 * escapar do filtro e poluir o histórico das invocações seguintes, que é
 * exatamente a razão de os textos do Plano D entrarem por lista importada.
 */
const AGENT_INSTABILITY_TEXT =
  "Tive um instante de instabilidade aqui. Já chamei alguém da equipe pra te responder. Em breve um humano assume.";

// Janela de agregação (debounce) de rajada: cliente costuma mandar várias
// mensagens picadas em poucos segundos. Esperamos esse intervalo antes de
// acionar o LLM; se chegar mensagem mais nova na MESMA conversa durante a
// espera, esta invocação desiste — quem responde é a invocação da ÚLTIMA
// mensagem, que relê o histórico fresco e responde uma vez só com a rajada
// inteira. Tunável: maior = pega rajadas mais lentas mas atrasa toda resposta.
//
// O valor vem do núcleo (e não é literal aqui) porque a varredura da Fase C
// reserva o pior caso de UM evento, e esta janela é a primeira parcela dele:
// mudar o debounce sem mudar a reserva faria a varredura começar um evento que
// não cabe no que resta do wall clock.
const DEBOUNCE_WINDOW_MS = INBOUND_DEBOUNCE_WINDOW_MS;
// Orçamento de tempo (desde o início da request) para um retry silencioso do
// agente após erro transitório. Acima disso não retentamos, porque uma segunda
// tentativa longa arrisca o cliente não receber NADA.
//
// A versão anterior desta linha justificava o valor com "o limite de 60s da Edge
// Function". Esse número é crença herdada, não medição, e este mesmo arquivo o
// contradiz: `AI_LOCK_TTL_SECONDS` existe porque um turno de pior caso leva
// ~51s, e somado ao debounce de 6s isso já passaria de 60s no caminho síncrono
// que atende loja real hoje. O wall clock, além disso, é do WORKER e não da
// request. Os 30s seguem valendo como política — uma resposta que demora demais
// já é resposta errada —, e não como dedução de um teto que ninguém mediu.
const AGENT_RETRY_BUDGET_MS = 30_000;
// TTL do lock de exclusão do agente por conversa. Auto-expira se a função
// crashar segurando o lock. Ver migration 056_conversation_ai_lock.
//
// O valor deixou de ser adivinhado: `lockTtlSecondsRequired()` o deriva da soma
// declarada — orçamento do prazo + pior turno único + envio —, e um teste de
// acoplamento reprova se ele cair abaixo disso. A justificativa antiga ("pior
// caso de runOnce, ~51 s") media UM turno, não o laço.
//
// A aritmética VINCULA o caminho da FILA, que é onde o prazo vale. No síncrono
// não há teto de parede nenhum (ver a nota em `shouldContinue`), então aqui os
// 90 s são piso de segurança contra lock órfão, nunca prova de que o turno cabe.
const AI_LOCK_TTL_SECONDS = 90;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type ConversationMessageAuthor = "customer" | "ai" | "automation" | "human";

/** Append atômico na conversa (RPC `append_conversation_message`), do adapter. */
export type AppendToConversation = (
  convId: string,
  // deno-lint-ignore no-explicit-any
  existing: any[],
  role: "user" | "assistant" | "human",
  content: string,
  options?: {
    author?: ConversationMessageAuthor;
    timestamp?: number | string | null;
    receivedAt?: string;
    eventId?: string;
    required?: boolean;
  },
  // deno-lint-ignore no-explicit-any
) => Promise<{ messages: any[]; persisted: boolean }>;

/** O que o núcleo pede à invocação que o hospeda. */
export interface AgentTurnIO {
  supabase: SupabaseClient;
  requestId: string;
  /** Início da REQUISIÇÃO (`t0`): relógio do orçamento de retry, nunca do prazo. */
  requestStartedAt: number;
  /** O prazo suave só vale na fila; no síncrono o laço não recebe predicado. */
  ingestionSource: IngestionSource;
  /** Registra o desfecho (idempotência + `webhook_executions`). Nunca lança. */
  finish(outcome: string, error?: string | null, meta?: Record<string, unknown>): Promise<void>;
  appendToConversation: AppendToConversation;
  /** A partir daqui reentregar o evento inteiro deixa de ser comprovadamente seguro. */
  markExternalSideEffect(): void;
}

/**
 * Cria o turno de UMA invocação.
 *
 * O estado do lock e da reserva de orçamento vive aqui, fora de `run`, pelo
 * mesmo motivo de antes estar hasteado no handler: o `catch` externo do
 * adapter é irmão do turno e precisa liquidar a reserva e soltar o lock —
 * nessa ordem — quando algo explode. Por isso `settleTurnBudget` e
 * `releaseAiLock` são devolvidos junto com `run`.
 */
export function createAgentTurn(io: AgentTurnIO) {
  const { supabase, requestId, finish, appendToConversation, markExternalSideEffect } = io;
  const t0 = io.requestStartedAt;
  const ingestionSource = io.ingestionSource;

  // Estado do lock de exclusão do agente por conversa. Hasteado aqui (e não só
  // dentro de `run`) pra que releaseAiLock seja visível no catch externo do
  // adapter — que é irmão do turno e está fora do escopo de `conv`.
  let convIdForLock: string | null = null;
  let aiLockToken: string | null = null;
  let lockAcquired = false;

  // Reserva de orçamento do turno (Plano D). Hasteada aqui pelo MESMO motivo do
  // lock: o catch externo é irmão do turno, e sem enxergar a reserva ele
  // deixaria o custo real do turno fora do teto para sempre.
  let turnBudget: TurnBudget | null = null;
  let turnBudgetOrgId: string | null = null;

  /**
   * REGRA ÚNICA: todo desfecho do turno liquida a reserva.
   *
   * Enquanto a reserva fica `HELD`, o consumido não é `settled_cents` — e só
   * `finalize_ai_reservation` incrementa esse campo. A varredura de expiradas
   * marca `EXPIRED` e devolve `released_cents` SEM incrementar o liquidado
   * (migration 102): deixar um desfecho sem liquidar não atrasa a contabilidade,
   * apaga-a. Custo real de LLM que some do teto é a classe de falha que esta
   * frente existe para impedir.
   *
   * `SETTLED` quando o turno chegou ao fim que pretendia (resposta produzida,
   * ou negação que encerrou o turno de propósito); `RELEASED` quando ele foi
   * interrompido. Os dois movem exatamente o mesmo dinheiro — a RPC só apropria
   * `consumed_cents`, escrito unicamente por `record_ai_call_usage` para
   * chamadas que OCORRERAM —, então a escolha é de rótulo para quem audita, não
   * de valor.
   *
   * No-op fora da franquia e quando não houve reserva.
   *
   * O ESTADO LOCAL SÓ É ZERADO NO SUCESSO. Zerar antes do `await` fazia de uma
   * RPC que falha um custo perdido para sempre: ninguém mais tentava, nem o
   * catch externo, porque o estado já tinha sido apagado — a reserva ficava
   * `HELD`, a varredura marcava `EXPIRED` e o consumido real sumia do teto.
   * Mantido o estado, o catch externo tem uma segunda tentativa (duas no total,
   * nunca um laço). Dupla liquidação continua impossível nos DOIS níveis: a
   * guarda local, e a própria RPC, que devolve sem redebitar quando o status já
   * não é `HELD` (migration 102).
   *
   * ISSO NÃO É COBERTURA COMPLETA, e não deve ser lido como tal: nos desfechos
   * que terminam sem exceção não existe segunda tentativa nenhuma — ou seja, no
   * modo de falha COMUM (a RPC falha e o resto do turno corre normal) a segunda
   * tentativa nunca acontece; ela só cobre "falhou a liquidação E depois algo
   * mais explodiu". Fechar de verdade exige uma varredura que LIQUIDE reserva
   * com `consumed_cents > 0` em vez de expirá-la — trabalho de outra fase.
   *
   * O `if (!fin)` também não distingue "a RPC errou" de `RESERVATION_NOT_FOUND`
   * / `CYCLE_NOT_FOUND`, então o log abaixo pode sair sobre uma reserva que
   * nunca existiu. É ruído no log, não erro de contabilidade.
   */
  const settleTurnBudget = async (status: "SETTLED" | "RELEASED") => {
    if (!turnBudget || !turnBudgetOrgId) return;
    const { reservationId, cycleId } = turnBudget;
    const orgId = turnBudgetOrgId;
    const fin = await finalizeTurn(supabase, { organizationId: orgId, reservationId, status });
    if (!fin) {
      // NÃO zera: a RPC não aplicou (erro, ou reserva/ciclo não encontrados) e o
      // consumido ainda não virou `settled_cents`.
      jsonLog("error", {
        requestId,
        evt: "ai_budget_settle_not_applied",
        reservation: reservationId,
        status,
      });
      return;
    }
    turnBudget = null;
    turnBudgetOrgId = null;
    try {
      // Best-effort por contrato: o custo já está liquidado, e um aviso de
      // marco que falha não pode derrubar a resposta ao cliente.
      await recordMilestones(supabase, {
        organizationId: orgId,
        cycleId,
        settledCents: fin.settledCents,
        limitCents: fin.limitCents,
      });
    } catch (e) {
      jsonLog("error", { requestId, evt: "ai_budget_milestones_failed", err: String(e) });
    }
  };

  // Libera o lock de exclusão do agente. No-op se esta invocação não o detém.
  // Nunca propaga — o TTL de 90s é o backstop se a RPC falhar.
  const releaseAiLock = async () => {
    if (!lockAcquired || !convIdForLock || !aiLockToken) return;
    try {
      // supabase-js devolve `{ error }` em vez de lançar: sem ler, a falha
      // não deixava rastro nenhum.
      const { error } = await supabase.rpc("release_conversation_ai_claim", {
        p_conv: convIdForLock,
        p_token: aiLockToken,
      });
      if (error) {
        jsonLog("warn", { requestId, evt: "ai_lock_release_failed", convId: convIdForLock, code: error.code ?? null });
      }
    } catch (e) {
      jsonLog("warn", { requestId, evt: "ai_lock_release_failed", convId: convIdForLock, err: String(e) });
    }
  };

  // Resolve a chave de API: BYOK por unidade no banco.
  // Sem fallback global da plataforma (removido em 2026-05-20). Razão: secrets
  // globais (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...) compartilhados entre units
  // faziam parecer "vazamento de chave entre lojas" e bagunçavam cobrança por
  // tenant. Sem chave própria = throw → handoff humano automático no catch do
  // caller.
  // Credencial ATIVA da unidade para o provider: o filtro de tenant fica num
  // lugar só para a leitura da chave e para a checagem de existência.
  const activeCredentials = <Columns extends string>(provider: AIProvider, unitId: string, columns: Columns) =>
    supabase
      .from("ai_provider_credentials")
      .select(columns)
      .eq("unit_id", unitId)
      .eq("provider", provider)
      .eq("active", true);

  async function resolveApiKey(provider: AIProvider, unitId: string): Promise<string> {
    const { data } = await activeCredentials(provider, unitId, "api_key").maybeSingle();

    if (data?.api_key) return data.api_key;

    throw new Error(`api_key_not_configured:${provider}`);
  }

  /**
   * A unidade tem chave ATIVA deste provider? Só EXISTÊNCIA: a coluna da chave
   * não é lida, e nada aqui vai a log. Serve à decisão Flash→Pro (D5), que
   * precisa saber antes do turno se o reserva é utilizável.
   *
   * POLARIDADE: erro de leitura = sem chave = o fallback do mesmo provider
   * continua, que é o comportamento de antes desta decisão. O reserva em si
   * segue tentando a chave em `switchToFallback`, como sempre.
   */
  async function hasActiveApiKey(provider: AIProvider, unitId: string): Promise<boolean> {
    const { data, error } = await activeCredentials(provider, unitId, "id").limit(1);
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  }

  /**
   * Um turno sobre a conversa já resolvida pelo canal. Cada saída registra o
   * próprio desfecho via `finish` e devolve; exceção sobe para o catch externo
   * do adapter, que liquida, solta o lock e registra.
   */
  const run = async (ctx: ChannelContext, inbound: TurnInbound): Promise<void> => {
    const conv = ctx.conversation;
    const { unitId, organizationId, customer, phone } = ctx;
    const channelId = ctx.channelId;
    const incomingText = inbound.text;

    // ─── Promove status 'resolved' legado pra 'ai_active' ────────────────────
    // O botão "Resolver" da UI deixou de gravar 'resolved' (vide
    // useConversations.markResolved — agora limpa handoff e volta pra
    // ai_active). Conversas antigas que ainda estão em 'resolved' no banco
    // sobem aqui na próxima inbound; sem isso, handoff_reason/handoff_at
    // poderiam ficar fósseis e a UI mostraria badge "Resolvida" pra sempre.
    if (conv.status === "resolved") {
      const { error: promoteErr } = await supabase
        .from("conversations")
        .update({
          status: "ai_active",
          handoff_reason: null,
          handoff_at: null,
          last_silenced_reply_at: null,
        })
        .eq("id", conv.id);
      if (promoteErr) {
        jsonLog("warn", { requestId, evt: "resolved_promote_failed", convId: conv.id, err: String(promoteErr) });
      } else {
        jsonLog("info", { requestId, evt: "resolved_promoted_to_ai", convId: conv.id });
      }
      conv.status = "ai_active";
      conv.handoff_reason = null;
      conv.handoff_at = null;
      conv.last_silenced_reply_at = null;
    }

    // ─── UX de handoff humano ────────────────────────────────────────────────
    // Auto-resolve quando passar muito tempo sem resposta humana, e responde
    // ao cliente uma vez a cada N horas durante o silêncio para não parecer
    // que o sistema morreu.
    if (conv.status === "human_active" || conv.status === "awaiting_human") {
      // Já registra a mensagem no histórico independente do que decidirmos.
      await appendToConversation(
        conv.id,
        conv.messages || [],
        "user",
        incomingText,
        {
          author: "customer",
          timestamp: inbound.timestamp,
          receivedAt: inbound.receivedAt,
          eventId: inbound.eventId,
          required: true,
        },
      );

      // Relógio do auto-resolve = ÚLTIMA atividade humana (início do handoff ou
      // a mensagem mais recente do atendente, venha do painel ou do celular da
      // loja). Antes bastava UMA resposta humana pra travar o auto-resolve pra
      // sempre; com o eco do celular gravado como `human`, uma única mensagem
      // do atendente silenciaria a IA indefinidamente nessa conversa.
      // deno-lint-ignore no-explicit-any
      const lastHumanTs = (conv.messages ?? []).reduce((acc: number, m: any) => {
        if (!m || m.role !== "human") return acc;
        const ts = m.timestamp ? new Date(m.timestamp).getTime() : 0;
        return ts > acc ? ts : acc;
      }, 0);

      // Sem handoff_at e sem mensagem humana (ex.: "Assumir" legado, que não
      // gravava handoff_at) o relógio nunca partia e a IA ficava silenciada
      // para sempre: inicia agora e persiste, só se ainda estiver NULL.
      const handoffClock = resolveHandoffClock({
        handoffAt: conv.handoff_at ?? null,
        lastHumanTs,
        nowMs: Date.now(),
      });
      const silenceStart = handoffClock.silenceStartMs;
      const handoffAge = silenceStart ? Date.now() - silenceStart : 0;

      if (handoffClock.persistHandoffAt) {
        const { error: clockError } = await supabase
          .from("conversations")
          .update({ handoff_at: handoffClock.persistHandoffAt })
          .eq("id", conv.id)
          .eq("unit_id", unitId)
          .is("handoff_at", null);
        if (clockError) {
          jsonLog("warn", { requestId, evt: "handoff_clock_persist_failed", convId: conv.id, err: clockError.message });
        }
      }

      // Handoff por franquia esgotada NÃO volta para a IA pelo decurso do
      // prazo: devolveria a conversa a uma IA que não pode responder. Só a
      // virada do ciclo — orçamento não mais esgotado — devolve. A leitura do
      // orçamento só acontece quando a razão é essa; nenhum custo nas demais.
      let budgetStillExhausted = false;
      if (conv.handoff_reason === AI_BUDGET_HANDOFF_REASON) {
        const franchise = await loadAiFranchise(supabase, organizationId);
        budgetStillExhausted = franchise?.state === "EXHAUSTED";
      }

      const shouldAutoResolve =
        silenceStart > 0 &&
        shouldAutoResolveHandoff({
          handoffReason: conv.handoff_reason ?? null,
          ageMs: handoffAge,
          thresholdMs: HANDOFF_AUTO_RESOLVE_MS,
          budgetExhausted: budgetStillExhausted,
        });

      if (shouldAutoResolve) {
        await supabase
          .from("conversations")
          .update({
            status: "ai_active",
            handoff_reason: null,
            handoff_at: null,
            last_silenced_reply_at: null,
          })
          .eq("id", conv.id);

        const resumedText = "Oi! Voltei a te atender por aqui. Em que posso ajudar?";
        markExternalSideEffect();
        const resumedSend = await ctx.send(resumedText);
        if (resumedSend.ok) {
          await appendToConversation(conv.id, conv.messages || [], "assistant", resumedText, { author: "automation" });
        }

        jsonLog("info", {
          requestId,
          evt: "handoff_auto_resolved",
          convId: conv.id,
          ageHours: Math.round(handoffAge / 3600000),
        });
        // Atualiza estado local para o agente processar a mensagem normalmente.
        conv.status = "ai_active";
        conv.handoff_reason = null;
        conv.handoff_at = null;
        // Cai pra fora do bloco e segue o fluxo do agente IA.
      } else {
        // Mantém silenciada, mas avisa o cliente uma vez por janela.
        const lastSilenced = conv.last_silenced_reply_at
          ? new Date(conv.last_silenced_reply_at).getTime()
          : 0;
        const shouldRemind = !lastSilenced || (Date.now() - lastSilenced) > HANDOFF_REMINDER_THROTTLE_MS;

        if (shouldRemind) {
          const reminderText = "Recebi sua mensagem! Já avisei alguém da equipe — vou te responder por aqui assim que possível. 🙏";
          markExternalSideEffect();
          const sendRes = await ctx.send(reminderText);
          if (sendRes.ok) {
            await appendToConversation(conv.id, conv.messages || [], "assistant", reminderText, { author: "automation" });
            await supabase
              .from("conversations")
              .update({
                last_silenced_reply_at: new Date().toISOString(),
              })
              .eq("id", conv.id);
          }
        } else {
          await supabase
            .from("conversations")
            .update({ last_message_at: new Date().toISOString() })
            .eq("id", conv.id);
        }

        jsonLog("info", {
          requestId,
          evt: "skipped_ai_human_active",
          convId: conv.id,
          status: conv.status,
          reminded: shouldRemind,
        });
        await finish(shouldRemind ? "human_active_reminded" : "human_active_silent");
        return;
      }
    }

    // ─── Append imediato + debounce de rajada ────────────────────────────────
    // Grava esta mensagem já (append atômico) pra que as invocações irmãs da
    // rajada e a invocação vencedora a enxerguem no histórico. Depois espera a
    // janela de debounce: se durante a espera chegou mensagem MAIS NOVA nesta
    // conversa, esta invocação desiste — quem responde é a invocação da última
    // mensagem, que relê o histórico fresco e responde uma vez só com a rajada
    // inteira. Resolve o "embaralha" (respostas paralelas fora de ordem) e
    // reduz a carga simultânea no provider de IA (menos 503/timeout → handoff).
    const appendedSelf = await appendToConversation(
      conv.id,
      conv.messages || [],
      "user",
      incomingText,
      {
        author: "customer",
        timestamp: inbound.timestamp,
        receivedAt: inbound.receivedAt,
        eventId: inbound.eventId,
        required: true,
      },
    );
    const appendedInbound = appendedSelf.messages[appendedSelf.messages.length - 1];
    const myInboundTs = appendedInbound?.received_at ?? appendedInbound?.timestamp ?? inbound.receivedAt;

    await sleep(DEBOUNCE_WINDOW_MS);
    {
      const { data: latestConv } = await supabase
        .from("conversations")
        .select("messages")
        .eq("id", conv.id)
        .maybeSingle();
      // deno-lint-ignore no-explicit-any
      const latestMsgs = (latestConv?.messages ?? []) as any[];
      // deno-lint-ignore no-explicit-any
      const newestUserTs = latestMsgs.reduce((acc: string, m: any) => {
        const arrival = m?.received_at ?? m?.timestamp;
        if (m && m.role === "user" && typeof arrival === "string" && arrival > acc) return arrival;
        return acc;
      }, "");
      if (newestUserTs && newestUserTs > myInboundTs) {
        jsonLog("info", { requestId, evt: "debounced_superseded", convId: conv.id });
        await finish("debounced_superseded");
        return;
      }
      // Vencedora da rajada: assume o histórico fresco (inclui toda a rajada).
      conv.messages = latestMsgs;
    }

    // ─── Relógio do deadline suave (Fase C) ───────────────────────────────────
    // Começa AQUI, e não em `t0`: o prazo é do PROCESSAMENTO, e o que vem antes
    // desta linha — resolução de canal, CRM, janela de rajada — não é tempo que
    // o agente gastou. Gastar o orçamento com os 6 s de debounce faria o
    // deadline morder uma rodada que ele não deveria alcançar.
    //
    // E é a vizinhança certa do claim logo abaixo: `AI_LOCK_TTL_SECONDS` existe
    // para cobrir `orçamento + pior turno + envio` a partir do instante em que a
    // conversa é reivindicada (`lockTtlSecondsRequired`, no núcleo). Os dois
    // relógios começam juntos porque medem a mesma janela.
    const processingStartedAt = Date.now();

    // ─── Lock de exclusão por conversa ────────────────────────────────────────
    // O debounce acima é OTIMISTA (comparação de timestamp) e NÃO garante
    // exclusão: empate de milissegundo, ou janelas não-sobrepostas (irmão chega
    // logo após esta invocação acordar do sleep), deixam DUAS invocações
    // seguirem. Duas chamadas concorrentes ao LLM saturam o provider → ambas
    // caem em agent_error → handoff DUPLICADO. Após vencer o timestamp, esta
    // invocação reivindica a conversa: só o holder roda o agente.
    aiLockToken = requestId; // único por invocação
    const { data: claimed, error: claimErr } = await supabase.rpc("try_claim_conversation_for_ai", {
      p_conv: conv.id,
      p_token: aiLockToken,
      p_ttl_seconds: AI_LOCK_TTL_SECONDS,
    });
    if (claimErr) {
      jsonLog("warn", { requestId, evt: "ai_lock_claim_failed", convId: conv.id, err: claimErr.message });
      throw new Error("ai_lock_claim_failed");
    } else if (claimed !== true) {
      // Outro irmão da rajada detém o lock. Desiste — mas via finish() pra que
      // markProcessed marque completed_at neste message_id (senão vira "stuck" e
      // reprocessa após 90s). O holder já enxerga esta mensagem no histórico.
      jsonLog("info", { requestId, evt: "conversation_locked", convId: conv.id });
      await finish("conversation_locked");
      return;
    } else {
      lockAcquired = true;
      convIdForLock = conv.id;
    }

    // Re-leitura FRESCA pós-lock: entre o debounce e o claim, um irmão (erro do
    // agente / request_human_handoff) ou o operador podem ter virado o status.
    if (lockAcquired) {
      const { data: freshConv } = await supabase
        .from("conversations")
        .select("status, messages")
        .eq("id", conv.id)
        .maybeSingle();
      if (freshConv && freshConv.status !== "ai_active") {
        jsonLog("info", { requestId, evt: "status_changed_after_lock", convId: conv.id, status: freshConv.status });
        await releaseAiLock();
        await finish("status_changed_locked");
        return;
      }
      // deno-lint-ignore no-explicit-any
      conv.messages = (freshConv?.messages ?? conv.messages) as any[];
    }

    // Toda saída automática depois do claim passa por uma única cerca. O eco
    // humano limpa o token atomicamente; logo mesmo um status sobrescrito pelo
    // próprio ramo de handoff não autoriza envio com token perdido.
    const sendAutomatic = async (text: string): Promise<ChannelSendResult> => {
      const { data: fence, error: fenceError } = await supabase
        .from("conversations")
        .select("status, ai_lock_token")
        .eq("id", conv.id)
        .maybeSingle();
      if (fenceError || !fence) throw new Error("conversation_handoff_fence_failed");
      if (fence.status === "human_active" || fence.ai_lock_token !== aiLockToken) {
        return { ok: false, error: "suppressed_by_human" } as const;
      }
      markExternalSideEffect();
      return await ctx.send(text);
    };

    // Mensagens manuais do operador (send-manual-message) ficam salvas com
    // role: "human" — do ponto de vista do modelo isso é "assistant" (resposta
    // que veio do nosso lado). Sem o remap, Anthropic rejeita o request com
    // "Unexpected role 'human'".
    //
    // Além do remap, aplicamos 2 filtros antes de enviar pro LLM (mensagens
    // continuam no banco e na UI — filtro só afeta o contexto do agente):
    //
    // (a) Lixo de retentativa: respostas hardcoded de erro/handoff/empty
    //     response não agregam contexto pro modelo e ainda viciam o LLM em
    //     achar que "problema técnico" é o padrão. Lista pequena e EXATA pra
    //     evitar falso positivo (cliente reclamando de "problema técnico" do
    //     restaurante NÃO pode ser filtrado).
    //
    // (b) Janela temporal: mensagens com timestamp > 72h atrás raramente são
    //     relevantes pro pedido atual. Cortar reduz input tokens e melhora
    //     latência. Sem timestamp (legado pré-backfill) → mantém.
    const HARDCODED_AGENT_NOISE = new Set<string>([
      AGENT_INSTABILITY_TEXT,
      "Desculpa, não consegui montar uma resposta agora. Pode reformular ou aguardar um instante?",
      "Desculpe, não consegui processar sua solicitação. Tente novamente.",
      // Plano D: os textos determinísticos do bloqueio por franquia entram pela
      // LISTA, nunca redigitados — é o que impede que um texto novo apareça sem
      // entrar no filtro. Mesmo motivo de MEDIA_REPLY_TEXT: sem isso a mensagem
      // polui o histórico das invocações seguintes e ensina o modelo que
      // "atendimento interrompido" é o padrão.
      ...AI_BUDGET_HARDCODED_TEXTS,
    ]);
    const HISTORY_WINDOW_MS = 72 * 60 * 60 * 1000;
    const cutoffMs = Date.now() - HISTORY_WINDOW_MS;

    // Separa o histórico (turnos já respondidos) das mensagens de usuário ainda
    // PENDENTES — a rajada que ainda não respondemos: tudo que veio depois da
    // última resposta do nosso lado (assistant/human). As pendentes viram UMA
    // mensagem combinada pro LLM; o resto vira histórico. Sem isso, a rajada
    // entraria no histórico E como userMessage (duplicada) ou fora de ordem.
    // deno-lint-ignore no-explicit-any
    const allMsgs: any[] = conv.messages || [];
    let lastReplyIdx = -1;
    for (let i = allMsgs.length - 1; i >= 0; i--) {
      const r = allMsgs[i]?.role;
      if (r === "assistant" || r === "human") { lastReplyIdx = i; break; }
    }
    const pendingUserMsgs = allMsgs
      .slice(lastReplyIdx + 1)
      // deno-lint-ignore no-explicit-any
      .filter((m: any) =>
        m && m.role === "user" && typeof m.content === "string"
        && !HARDCODED_AGENT_NOISE.has(m.content.trim()) && m.content.trim());
    const priorMsgs = allMsgs.slice(0, lastReplyIdx + 1);

    const history: Array<{ role: "user" | "assistant"; content: string }> = priorMsgs
      // deno-lint-ignore no-explicit-any
      .filter((m: any) => {
        if (!m || typeof m.content !== "string") return false;
        if (m.role !== "user" && m.role !== "assistant" && m.role !== "human") return false;
        if (HARDCODED_AGENT_NOISE.has(m.content.trim())) return false;
        // Janela temporal: descarta só quando o timestamp É válido E antigo.
        // Mensagem sem timestamp (legado) ou com timestamp inválido → mantém.
        if (m.timestamp) {
          const t = new Date(m.timestamp).getTime();
          if (Number.isFinite(t) && t < cutoffMs) return false;
        }
        return true;
      })
      // deno-lint-ignore no-explicit-any
      .map((m: any) => ({
        role: m.role === "human" ? ("assistant" as const) : (m.role as "user" | "assistant"),
        content: m.content,
      }));

    // Mensagem combinada da rajada (várias linhas se o cliente picou em vários
    // balões). Fallback pro texto desta invocação se a separação vier vazia.
    const combinedUserMessage =
      // deno-lint-ignore no-explicit-any
      pendingUserMsgs.map((m: any) => m.content.trim()).join("\n").trim() || incomingText;

    // ─── Franquia de IA (Plano D) ────────────────────────────────────────────
    // Resolve o entitlement de IA COM o estado do orçamento. Só o ramo
    // `franchise` entra no caminho novo: override vitalício (Ren Sushi),
    // carteira legada e BYOK puro seguem exatamente como antes — `budgetHooks`
    // fica `undefined` e o laço roda byte a byte como hoje.
    //
    // NENHUMA CONTAGEM DE CONVERSA, MENSAGEM OU INTERAÇÃO AUTORIZA NADA AQUI.
    // O único teto é financeiro e por organização.
    const aiFranchiseState = await loadAiFranchise(supabase, organizationId);
    const entitlements = await resolveOrgEntitlements(
      supabase,
      organizationId,
      undefined,
      aiFranchiseState ?? undefined,
    );
    const isFranchise = entitlements.ai.source === "franchise";

    if (entitlements.readFailed) {
      // Leitura degradada resolve com os defaults de quem NÃO leu (sem
      // overrides, sem assinaturas), então a franquia deixa de ser reconhecida
      // e o turno roda SEM ganchos e SEM medição. NÃO negamos — a consequência
      // recairia sobre o cliente do restaurante, e negar é decisão comercial.
      // Mas o silêncio era o defeito: sem esta linha, gasto não medido é
      // invisível justamente quando o banco está com soluço.
      jsonLog("warn", {
        requestId,
        evt: "ai_budget_entitlements_read_failed",
        unitId,
        organizationId,
        franchise: isFranchise,
      });
    }

    // Com `source: "franchise"`, `allowed: false` significa UMA coisa só: o
    // ciclo está EXHAUSTED. É teto comercial, e por isso obedece à mesma flag
    // que `openTurnBudget` — que devolve `UNMETERED` em vez de `EXHAUSTED` com
    // o gate desligado. Esta porta é mais curta e chegaria antes: sem a mesma
    // disciplina, a organização que estourou o teto seria bloqueada pelo
    // atalho, e o modo que existe para MEDIR antes de bloquear nunca mediria
    // nada justamente dela. A flag é lida só quando já se sabe que o teto
    // estourou — nenhuma leitura no caminho comum.
    const budgetExhaustedNow = isFranchise && !entitlements.ai.allowed;
    if (budgetExhaustedNow && (await isFlagEnabled("ai_wallet_enforced"))) {
      // HARD STOP. O canal NÃO é desligado, o sistema NÃO é bloqueado, a
      // conversa continua visível e o atendimento humano continua possível
      // (§18.3). Nada de "falha técnica": não houve falha nenhuma.
      //
      // A mensagem do cliente JÁ ESTÁ no histórico — foi appendada antes do
      // debounce. Reappendá-la aqui duplicaria a linha na thread.
      await supabase
        .from("conversations")
        .update({
          status: "awaiting_human",
          handoff_reason: AI_BUDGET_HANDOFF_REASON,
          handoff_at: new Date().toISOString(),
          last_silenced_reply_at: null,
        })
        .eq("id", conv.id);

      // Texto determinístico, hardcoded. NÃO passa por `ctx.sanitize`
      // (só saída de LLM passa) e NÃO expõe custo, tokens, modelo ou limite.
      const budgetNotice = await sendAutomatic(AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT);
      if (budgetNotice.ok) {
        await appendToConversation(
          conv.id,
          conv.messages || [],
          "assistant",
          AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT,
          { author: "automation" },
        );
      }

      jsonLog("warn", {
        requestId,
        evt: "ai_budget_exhausted_handoff",
        unitId,
        organizationId,
        convId: conv.id,
      });
      await finish("ai_budget_exhausted");
      await releaseAiLock();
      return;
    }

    // Load AI config from settings (unit-scoped)
    const { data: configSetting } = await supabase
      .from("settings")
      .select("value")
      .eq("unit_id", unitId)
      .eq("key", "ai_config")
      .maybeSingle();

    const aiConfig = (configSetting?.value ?? {}) as Record<string, unknown>;
    const provider_ai: AIProvider = (aiConfig.provider as AIProvider) ?? "claude";
    const rawModel: string | undefined = (aiConfig.models as Record<string, string>)?.[provider_ai];

    // A chave vem ANTES da resolução do modelo: `provider` inválido no
    // `ai_config` (o banco não tem CHECK) cai aqui, no handoff de sempre,
    // em vez de lançar no catálogo (que só conhece os 5 providers).
    let apiKey: string;
    try {
      apiKey = await resolveApiKey(provider_ai, unitId);
    } catch (err) {
      // Sem chave própria cadastrada pra esta unit. Vai pra handoff humano —
      // não silenciamos, não pedimos retry (não resolve), não compartilhamos
      // chave global (cobrança ficaria misturada entre tenants).
      jsonLog("error", { requestId, evt: "ai_key_unavailable", provider: provider_ai, unitId, err: String(err) });

      await supabase
        .from("conversations")
        .update({
          status: "awaiting_human",
          handoff_reason: `api_key_not_configured:${provider_ai}`,
          handoff_at: new Date().toISOString(),
          last_silenced_reply_at: null,
        })
        .eq("id", conv.id);

      const handoffText = "Obrigado pela mensagem! Já avisei alguém da equipe pra continuar com você por aqui. Em breve um humano assume.";
      const keyNotice = await sendAutomatic(handoffText);
      if (keyNotice.ok) {
        await appendToConversation(
          conv.id,
          [...(conv.messages || []), { role: "user", content: incomingText }],
          "assistant",
          handoffText,
          { author: "automation" },
        );
      }

      await finish("ai_key_unavailable", String(err), {
        provider: provider_ai,
        channel_id: channelId,
      });
      await releaseAiLock();
      return;
    }

    // Blindagem pelo catálogo (D6): salvo aposentado → sucessor, com
    // `ai_model_retired`; desconhecido (ex: legado "gemini-2.0-flash", 404
    // silencioso) → default, com `ai_model_fallback`. O valor salvo não é
    // reescrito. Daqui em diante só circula o modelo RESOLVIDO: franquia
    // (`openTurnBudget`, `priceFor`), `agent_usage`, `handoff_reason` e `meta`.
    const modelResolved = resolveModel(provider_ai, rawModel);
    const modelOverride: string = modelResolved.model;
    if (modelResolved.reason === "retired_successor") {
      jsonLog("warn", {
        requestId,
        evt: "ai_model_retired",
        provider: provider_ai,
        saved: modelResolved.rejected,
        used: modelOverride,
        unitId,
      });
    } else if (modelResolved.reason === "unknown_default") {
      jsonLog("warn", {
        requestId,
        evt: "ai_model_fallback",
        provider: provider_ai,
        rejected: modelResolved.rejected,
        used: modelOverride,
        unitId,
      });
    }
    // Provedor RESERVA (opcional, por unidade). Config ilegível = sem reserva =
    // comportamento de hoje. A chave dele só é resolvida se ele for usado.
    const fallbackConfig = parseFallbackConfig(aiConfig, provider_ai);
    const fallbackModelResolved = fallbackConfig
      ? resolveModel(fallbackConfig.provider, fallbackConfig.model)
      : null;
    if (fallbackConfig && fallbackModelResolved?.reason === "retired_successor") {
      jsonLog("warn", {
        requestId,
        evt: "ai_model_retired",
        provider: fallbackConfig.provider,
        saved: fallbackModelResolved.rejected,
        used: fallbackModelResolved.model,
        role: "fallback",
        unitId,
      });
    } else if (fallbackConfig && fallbackModelResolved?.reason === "unknown_default") {
      jsonLog("warn", {
        requestId,
        evt: "ai_model_fallback",
        provider: fallbackConfig.provider,
        rejected: fallbackModelResolved.rejected,
        used: fallbackModelResolved.model,
        role: "fallback",
        unitId,
      });
    }

    // System prompt: carga (mesma ordem de leituras) e montagem em
    // `system-prompt.ts`. O canal entra com a identidade e a formatação.
    const systemPrompt = await loadAgentSystemPrompt(supabase, {
      unitId,
      unit: ctx.unit,
      customer,
      phone,
      identityLine: ctx.identityLine,
      formattingRules: ctx.formattingRules,
      appBaseUrl: ctx.appBaseUrl,
    });

    // Reserva ATÔMICA antes de iniciar o turno. O passo é onde o teto é
    // aplicado — verificar depois da chamada não é proteção, é detecção.
    const turnId = `${conv.id}:${requestId}`;
    let budgetHooks: AgentBudgetHooks | undefined;

    if (isFranchise) {
      const opened = await openTurnBudget(supabase, {
        organizationId,
        turnId,
        requestId,
        provider: provider_ai,
        model: modelOverride,
      });

      if (opened.kind === "EXHAUSTED") {
        // A franquia esgotou entre a resolução do entitlement e a reserva
        // (turno concorrente liquidou). Mesmo desfecho do hard stop acima.
        await supabase
          .from("conversations")
          .update({
            status: "awaiting_human",
            handoff_reason: AI_BUDGET_HANDOFF_REASON,
            handoff_at: new Date().toISOString(),
            last_silenced_reply_at: null,
          })
          .eq("id", conv.id);
        const reserveNotice = await sendAutomatic(AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT);
        if (reserveNotice.ok) {
          await appendToConversation(
            conv.id,
            conv.messages || [],
            "assistant",
            AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT,
            { author: "automation" },
          );
        }
        jsonLog("warn", {
          requestId,
          evt: "ai_budget_exhausted_on_reserve",
          unitId,
          organizationId,
          convId: conv.id,
        });
        await finish("ai_budget_exhausted");
        await releaseAiLock();
        return;
      }

      if (opened.kind === "READY") {
        turnBudget = opened.budget;
        turnBudgetOrgId = organizationId;
        budgetHooks = makeBudgetHooks(supabase, {
          organizationId,
          unitId,
          conversationId: conv.id,
          requestId,
          turnId,
          budget: opened.budget,
          // O MESMO resolvedor da estimativa da reserva. Sem o repasse, a
          // reserva e o ledger voltam a ter caches independentes e podem falar
          // de vigências de preço diferentes dentro do mesmo turno.
          resolvePrice: opened.resolvePrice,
        });
      } else if (opened.kind === "UNMETERED") {
        // Flag OFF: nenhuma negação comercial acontece. O turno segue SEM
        // medição — o preço de não bloquear, nunca o contrário.
        jsonLog("warn", {
          requestId,
          evt: "ai_budget_observed_only",
          unitId,
          organizationId,
          reason: opened.reason,
        });
      } else {
        // ERROR de infraestrutura. NÃO é franquia esgotada, e a copy tem de
        // dizer outra coisa. Com o gate LIGADO não podemos chamar o LLM sem
        // medir (consumo não contabilizado); com ele desligado, seguimos.
        //
        // `opened.enforced` é o estado do gate no MOMENTO da abertura, e vem no
        // resultado exatamente para não ser relido: reler traria I/O extra e
        // permitiria que a mesma invocação decidisse com dois valores.
        jsonLog("error", {
          requestId,
          evt: "ai_budget_open_error",
          unitId,
          organizationId,
          code: opened.sanitizedCode,
        });
        // PREÇO DESCONHECIDO FALHA FECHADO EM QUALQUER MODO — é a MESMA
        // política do `beforeCall` do adapter, e duas portas para a mesma
        // ignorância não podem ter políticas opostas. Sem preço não há
        // `price_id` (NOT NULL em `ai_usage_events`) e o evento não pode
        // existir: rodar seria consumo real sem nenhum registro possível. Vale
        // inclusive quando o `null` veio de FALHA DE LEITURA da tabela de
        // preços, que é indistinguível de ausência de linha — e é por isso que
        // o gatilho não é hipotético. O modo observação abranda TETO, nunca
        // preço.
        const failClosed = opened.enforced || opened.sanitizedCode === "price_unknown";
        if (failClosed) {
          await supabase
            .from("conversations")
            .update({
              status: "awaiting_human",
              handoff_reason: `ai_budget_error:${opened.sanitizedCode}`,
              handoff_at: new Date().toISOString(),
              last_silenced_reply_at: null,
            })
            .eq("id", conv.id);
          // Texto de instabilidade JÁ EXISTENTE no noise set — não é franquia
          // esgotada e não pode dizer que é.
          const errText = AGENT_INSTABILITY_TEXT;
          const budgetErrorNotice = await sendAutomatic(errText);
          if (budgetErrorNotice.ok) {
            await appendToConversation(conv.id, conv.messages || [], "assistant", errText, { author: "automation" });
          }
          await finish("ai_budget_error", opened.sanitizedCode);
          await releaseAiLock();
          return;
        }
      }
    }

    const totalUsage = { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0 };
    let agentError: string | null = null;
    // Quem interrompeu o loop: o prazo ou o provedor. Duas consequências
    // diferentes (motivo do handoff, e o retry silencioso que NÃO pode pegar o
    // prazo), e a pergunta é do OBJETO lançado — nunca do texto sanitizado.
    let agentDeadlineReached = false;
    let finalText = "";

    let mutatingToolUsed = false;
    // Desfecho da ÚLTIMA ferramenta mutante. Na dúvida, UNKNOWN: afirmar
    // conclusão de uma ação que ainda exige validação é o erro que produz
    // cliente aparecendo no restaurante sem mesa (§17.7.4).
    let lastMutationOutcome: MutationOutcome = "UNKNOWN";
    // Alvo da PRÓXIMA tentativa. Nasce no principal e só muda por
    // `switchToFallback`, entre a tentativa 0 e a 1 do retry silencioso. O
    // turno recomeça limpo no reserva (histórico em texto é neutro entre
    // provedores; trocar no meio do laço de ferramentas exigiria converter
    // formatos de tool call).
    type AgentTarget = { provider: AIProvider; apiKey: string; model: string };
    const primaryTarget: AgentTarget = { provider: provider_ai, apiKey, model: modelOverride };
    // D5: o fallback DENTRO do provider (Flash→Pro) só vale enquanto o reserva
    // não pode assumir; com reserva ao alcance, a tentativa pós-503 vai direto a
    // ela. A existência da chave ativa do reserva é lida aqui, antes do turno (o
    // valor, só na troca). O ALCANCE é perguntado na hora do fallback: o reserva
    // só entra na tentativa 0 do retry, sem ferramenta mutante e dentro do
    // orçamento de tempo (as mesmas travas do laço abaixo) — fora disso, o Pro.
    const reserveHasActiveKey = fallbackConfig
      ? await hasActiveApiKey(fallbackConfig.provider, unitId)
      : false;
    let currentAttempt = 0;
    const reserveStillUsable = (): boolean =>
      currentAttempt === 0 && !mutatingToolUsed && Date.now() - t0 < AGENT_RETRY_BUDGET_MS;
    // No reserva não há outro reserva atrás dele: vale o fallback do catálogo.
    const sameProviderFallbackFor = (target: AgentTarget) => (): string | null =>
      decideSameProviderFallback({
        entry: getModelEntry(target.provider, target.model) ?? {},
        primaryProvider: target.provider,
        reserve: target === primaryTarget ? fallbackConfig : null,
        reserveHasActiveKey: target === primaryTarget && reserveHasActiveKey,
        reserveStillUsable: target === primaryTarget && reserveStillUsable(),
      });
    let agentTarget: AgentTarget = primaryTarget;
    const switchToFallback = async (reason: string): Promise<boolean> => {
      if (!fallbackConfig || !fallbackModelResolved) return false;
      let fallbackKey: string;
      try {
        // BYOK da PRÓPRIA unidade, como o principal — nunca chave global.
        fallbackKey = await resolveApiKey(fallbackConfig.provider, unitId);
      } catch {
        // Sem chave ativa do reserva: segue o retry de hoje, no principal.
        jsonLog("warn", { requestId, evt: "fallback_unavailable", provider: fallbackConfig.provider, unitId });
        return false;
      }
      jsonLog("warn", {
        requestId,
        evt: "agent_provider_fallback",
        from_provider: agentTarget.provider,
        from_model: agentTarget.model,
        to_provider: fallbackConfig.provider,
        to_model: fallbackModelResolved.model,
        reason,
      });
      agentTarget = { provider: fallbackConfig.provider, apiKey: fallbackKey, model: fallbackModelResolved.model };
      return true;
    };
    const runOnce = () => runAgentLoop({
        provider: agentTarget.provider,
        apiKey: agentTarget.apiKey,
        model: agentTarget.model,
        sameProviderFallbackModel: sameProviderFallbackFor(agentTarget),
        systemPrompt,
        history,
        userMessage: combinedUserMessage,
        tools: agentTools,
        // AUSENTE fora da franquia: nenhuma autorização, nenhuma apropriação,
        // nenhum custo persistido — o caminho legado inteiro depende disso.
        budget: budgetHooks,
        // Deadline SUAVE: só impede COMEÇAR nova rodada de ferramenta. A
        // política é do núcleo; aqui só se entrega o relógio do PROCESSAMENTO
        // (nunca `t0`, que inclui o que veio antes do claim da conversa).
        //
        // ─── ESCOPADO À FILA, e isso é requisito da fase, não cautela ────────
        //
        // O prazo existe por causa do ORÇAMENTO DE PAREDE da varredura: um evento
        // que roda para sempre derruba o worker e adia o inbound de outros
        // tenants. O caminho SÍNCRONO não tem esse orçamento — e não tem teto
        // nenhum, o que é afirmação medida e não conforto: `AGENT_RETRY_BUDGET_MS`
        // só decide se CABE uma retentativa, nunca interrompe o laço em curso, e o
        // TTL do lock de conversa EXPIRA em vez de parar quem o segura (um irmão
        // assume e roda um segundo agente). O que o torna aceitável é outra coisa:
        // ele é o caminho que atende loja real agora, com os quatro providers
        // legados fora da fila pela capability de reentrega (`unmeasured`), não
        // só por chave desligada, e aplicar o prazo a eles seria mudar o
        // comportamento deles por efeito colateral, que esta
        // fase proíbe explicitamente. Teto de parede no síncrono é decisão própria,
        // com sua própria medição — não carona desta.
        //
        // E a aritmética mostra que não seria inócuo: `AGENT_SOFT_DEADLINE_MS`
        // (30 000) é MENOR que `WORST_SINGLE_TURN_MS` (31 000) do próprio repo,
        // então uma rodada de pior caso consome o orçamento inteiro e a SEGUINTE
        // é sempre recusada. No síncrono isso cortaria conversas de duas rodadas
        // que hoje concluem, e tiraria do ar justamente o empty-retry do Gemini —
        // a causa nº 1 de "não consegui montar uma resposta", que existe para
        // resgatar exatamente esses turnos.
        shouldContinue: ingestionSource === "queue"
          ? () =>
            agentDeadlineVerdict({ startedAt: processingStartedAt, now: Date.now() }) === "continue"
          : undefined,
        onUsage: (u) => {
          totalUsage.input_tokens += u.input_tokens;
          totalUsage.output_tokens += u.output_tokens;
          totalUsage.cache_creation_tokens += u.cache_creation_tokens;
          totalUsage.cache_read_tokens += u.cache_read_tokens;
          totalUsage.reasoning_tokens += u.reasoning_tokens ?? 0;
        },
        // deno-lint-ignore no-explicit-any
        onToolCall: async (name, input: any) => {
          jsonLog("info", { requestId, evt: "tool_call", channelId, unitId, name, input: summarizeToolInput(input) });
          try {
            // deno-lint-ignore no-explicit-any
            let result: any;
            switch (name) {
              case "check_availability":
                result = await checkAvailability(supabase, input.date, input.time, input.party_size, unitId, input.hall_name);
                break;
              case "create_reservation":
                mutatingToolUsed = true; // desliga o retry silencioso (evita reserva duplicada)
                result = await createReservation(supabase, {
                  ...input,
                  phone,
                  unit_id: unitId,
                  organization_id: organizationId,
                  source: ctx.reservationSource,
                });
                // Classificação do desfecho para a copy de §17.7.4. A reserva
                // do agente nasce `confirmed` e é ISENTA de caução — não existe
                // desfecho PENDING neste caminho, e inventar um seria afirmar
                // ao cliente uma espera que não vai acontecer. `success: false`
                // é ignorância sobre o que ficou de pé: UNKNOWN.
                lastMutationOutcome = result?.success === true ? "COMPLETED" : "UNKNOWN";
                break;
              case "get_reservation":
                result = await getReservationScoped(supabase, input, { unitId, customerId: customer.id });
                break;
              case "update_reservation":
                mutatingToolUsed = true; // desliga o retry silencioso (evita alteração duplicada)
                result = await updateReservationScoped(
                  supabase,
                  input,
                  { unitId, customerId: customer.id },
                  { checkAvailability: (p) => checkAvailabilityCore(supabase, p) },
                );
                lastMutationOutcome = result?.success === true ? "COMPLETED" : "UNKNOWN";
                break;
              case "cancel_reservation":
                mutatingToolUsed = true; // desliga o retry silencioso (evita cancelamento duplicado)
                result = await cancelReservationScoped(supabase, input.reservation_code, { unitId, customerId: customer.id });
                lastMutationOutcome = result?.success === true ? "COMPLETED" : "UNKNOWN";
                break;
              case "list_customer_reservations":
                result = await listCustomerReservations(supabase, customer.id, unitId);
                break;
              case "request_human_handoff":
                await supabase.from("conversations").update({
                  status: "awaiting_human",
                  handoff_reason: input.reason,
                  handoff_at: new Date().toISOString(),
                  last_silenced_reply_at: null,
                }).eq("id", conv.id);
                jsonLog("info", { requestId, evt: "handoff_requested", convId: conv.id, reason: input.reason });
                result = { ok: true, message: "Transferência registrada. AGORA envie ao cliente uma mensagem cordial dizendo que um atendente humano vai responder em breve, antes de encerrar." };
                break;
              default:
                result = { error: `Tool desconhecida: ${name}` };
            }
            jsonLog("info", { requestId, evt: "tool_result", channelId, unitId, name, result: summarizeToolResult(result) });
            return JSON.stringify(result);
          } catch (err) {
            jsonLog("error", { requestId, evt: "tool_error", channelId, unitId, name, err: String(err) });
            // O texto do erro (PostgREST, rede, host do projeto) fica no log:
            // o que volta ao LLM chega ao cliente parafraseado.
            return JSON.stringify({ error: "Não foi possível concluir esta ação agora. Tente novamente em instantes." });
          }
        },
      });

    // Roda o agente. Em erro transitório (timeout / 5xx / quota momentânea)
    // ANTES de qualquer tool que altere estado, tenta UMA vez mais em silêncio
    // antes de cair pra handoff — desde que ainda dentro do orçamento de tempo.
    // Nunca retenta se uma reserva já foi criada/alterada/cancelada (evita
    // duplicar) nem se o tempo estourar (evita deixar o cliente sem resposta).
    let agentOutcome: AgentLoopResult | null = null;
    // A partir daqui pode haver chamada de LLM e tools mutantes; reentregar o
    // claim inteiro depois de uma exceção já não é comprovadamente seguro.
    markExternalSideEffect();
    for (let attempt = 0; attempt <= 1; attempt++) {
      currentAttempt = attempt;
      try {
        agentOutcome = await runOnce();
        agentError = null;
        agentDeadlineReached = false;
        // Resposta VAZIA do principal também é indisponibilidade quando há
        // reserva: mesmas travas do retry abaixo. Sem reserva (ou sem chave
        // dele), nada muda — o vazio segue para o ramo `empty_response`.
        if (
          attempt === 0 && fallbackConfig && !mutatingToolUsed
          && agentOutcome.kind === "TEXT" && !agentOutcome.text.trim()
          && Date.now() - t0 < AGENT_RETRY_BUDGET_MS
          && await switchToFallback("empty_response")
        ) {
          continue;
        }
        break;
      } catch (err) {
        // A MARCA DO PRAZO É LIDA DO OBJETO, E ANTES DE SANITIZAR.
        // `sanitizeProviderError` devolve `${err.name}: ${err.message}` e ainda
        // passa por redação e `slice(0, 300)`: comparar a string resultante com
        // "agent_deadline" nunca casaria, e casar por `includes` amarraria a
        // decisão à forma de um texto que outra regra pode reescrever.
        agentDeadlineReached = isAgentDeadlineError(err);
        // SANITIZADO, sempre. A chave de IA é per-unit (BYOK) e o erro do
        // provedor pode ecoar o request com o header de autorização — ou a URL
        // do Gemini, que carrega `?key=<chave>` na query string. Este valor é
        // persistido em `webhook_executions.error` e em `processed_messages`.
        agentError = sanitizeProviderError(err);
        jsonLog("error", {
          requestId,
          evt: "agent_loop_error",
          attempt,
          deadline: agentDeadlineReached,
          err: agentError,
        });
        const elapsed = Date.now() - t0;
        // `!agentDeadlineReached` é EXCLUSÃO EXPLÍCITA, e a razão não é o valor
        // das constantes. Sem ela, o `catch` genérico reiniciaria o agente
        // inteiro logo depois de o prazo ter dito para não começar nem mais uma
        // rodada — o deadline anulando a si mesmo no único caso em que importa.
        // Hoje `AGENT_RETRY_BUDGET_MS` e `AGENT_SOFT_DEADLINE_MS` valem os
        // mesmos 30 s, em arquivos diferentes e contados de relógios diferentes
        // (`t0` aqui, `processingStartedAt` lá): coincidência aritmética entre
        // dois números que ninguém declarou gêmeos. Subir o orçamento de retry
        // desligaria o deadline em silêncio.
        if (
          attempt === 0 && !agentDeadlineReached && !mutatingToolUsed
          && elapsed < AGENT_RETRY_BUDGET_MS
        ) {
          jsonLog("warn", { requestId, evt: "agent_retry", elapsed_ms: elapsed });
          // Com reserva configurada e erro de indisponibilidade, a tentativa 1
          // roda no outro provedor; sem isso (ou sem chave dele), no principal.
          if (fallbackConfig && shouldUseFallbackProvider(err)) {
            await switchToFallback(agentError);
          }
          continue;
        }
        break;
      }
    }
    finalText = agentOutcome && agentOutcome.kind === "TEXT" ? agentOutcome.text : "";

    // Quem fez a ÚLTIMA tentativa — o reserva, se a troca aconteceu.
    const usedProvider = agentTarget.provider;
    const usedModel = agentTarget.model;
    const fallbackMeta = agentTarget === primaryTarget
      ? {}
      : { fallback_provider: usedProvider, fallback_model: usedModel };
    jsonLog("info", {
      requestId,
      evt: "agent_usage",
      provider: usedProvider,
      model: usedModel,
      ...fallbackMeta,
      channelId,
      unitId,
      ...totalUsage,
      estimated_cost_usd: estimateCostUsd(usedModel, totalUsage),
    });

    // ─── Negação de orçamento durante o turno ────────────────────────────────
    // O efeito de ferramenta mutante já persistido NÃO é descartado, a
    // ferramenta NÃO é repetida, o turno NÃO recebe retry integral, e a
    // resposta é texto DETERMINÍSTICO — gerar com IA a explicação de que a IA
    // foi bloqueada exigiria justamente a chamada que foi negada.
    if (agentOutcome && agentOutcome.kind === "DENIED") {
      const decision = agentOutcome.decision;
      // A pergunta é do núcleo. `ERROR` e `DENY_BUDGET` levam ao mesmo destino
      // operacional e dizem coisas OPOSTAS: só uma significa que a franquia
      // acabou.
      const hardStop = isCommercialHardStop(decision);

      // Razão PRÓPRIA por variante: `ai_budget_exhausted` é a única que
      // significa que a franquia acabou. As demais são fail-closed técnico e
      // não podem afirmar isso nem ao cliente nem ao admin.
      let handoffReason: string;
      if (hardStop) {
        handoffReason = AI_BUDGET_HANDOFF_REASON;
      } else if (decision.kind === "DENY_PRICE_UNKNOWN") {
        handoffReason = `ai_price_unknown:${decision.provider}:${decision.model}`;
      } else if (decision.kind === "DENY_USAGE_UNRESOLVED") {
        handoffReason = "ai_usage_unresolved";
      } else {
        handoffReason = "ai_budget_error";
      }

      await supabase
        .from("conversations")
        .update({
          status: "awaiting_human",
          handoff_reason: handoffReason,
          handoff_at: new Date().toISOString(),
          last_silenced_reply_at: null,
        })
        .eq("id", conv.id);

      // Copy: só o hard stop usa o texto de franquia. As três situações de
      // ferramenta mutante têm textos distintos — usar a mesma frase para as
      // três é o erro que produz cliente aparecendo no restaurante sem mesa.
      let stopText: string;
      if (!hardStop) {
        stopText = AGENT_INSTABILITY_TEXT;
      } else if (mutatingToolUsed) {
        stopText = resolveMutationStopText(lastMutationOutcome);
      } else {
        stopText = AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT;
      }

      const stopNotice = await sendAutomatic(stopText);
      if (stopNotice.ok) {
        await appendToConversation(conv.id, conv.messages || [], "assistant", stopText, { author: "automation" });
      }

      jsonLog("warn", {
        requestId,
        evt: telemetryEventFor(decision),
        unitId,
        organizationId,
        convId: conv.id,
        provider: usedProvider,
        model: agentOutcome.meta.model,
        ...fallbackMeta,
        iteration: agentOutcome.meta.iteration,
        mutating_tool_used: mutatingToolUsed,
      });

      // DINHEIRO ANTES DE TELEMETRIA, nos seis desfechos. `finish` carimba
      // `processed_messages` como concluída, e a partir daí a reentrega do
      // provedor é DEDUPLICADA: se o isolate morrer entre o `finish` e a
      // liquidação, o custo real nunca vira `settled_cents` e some do teto para
      // sempre. Na ordem certa, a mesma morte custa só o registro — que é
      // telemetria, e reconstituível. `settleTurnBudget` não lança (engole o
      // erro da RPC e volta), então não há registro em risco aqui.
      // O turno terminou onde pretendia terminar: `SETTLED`.
      await settleTurnBudget("SETTLED");
      await finish(hardStop ? "ai_budget_exhausted" : "ai_budget_denied", undefined, {
        decision: decision.kind,
        provider: usedProvider,
        model: agentOutcome.meta.model,
        ...fallbackMeta,
      });
      await releaseAiLock();
      return;
    }

    if (agentError) {
      // Agente falhou (timeout, modelo descontinuado, 4xx do provider, tool error
      // não tratado, etc). Em vez de só pedir pro cliente repetir — o que não
      // resolve quando o erro é estrutural —, fazemos auto-handoff: marca a
      // conversa awaiting_human pra atendente assumir, registra provider/model
      // no handoff_reason e em webhook_executions.meta, e avisa o cliente.
      // Provider/modelo são os da ÚLTIMA tentativa (o reserva, se houve troca).

      // O motivo distingue PRAZO de erro do provedor, e isso não é cosmética: é
      // o campo que se lê ao investigar "por que esta conversa foi para
      // atendimento humano". Um turno interrompido pelo deadline não é
      // instabilidade do provedor, e chamá-lo de `agent_error` mandaria quem
      // investiga procurar defeito onde não há.
      //
      // O NOME é próprio (`agentHandoffReason`, não `handoffReason`): o
      // guardrail que confere que cada porta de handoff manda a conversa para a
      // fila do operador ancora cada porta pelo texto da razão, e duas portas
      // com o mesmo identificador colapsam numa só aos olhos dele.
      const agentHandoffReason = agentDeadlineReached
        ? `agent_deadline:${usedProvider}:${usedModel}`
        : `agent_error:${usedProvider}:${usedModel}`;

      await supabase
        .from("conversations")
        .update({
          status: "awaiting_human",
          handoff_reason: agentHandoffReason,
          handoff_at: new Date().toISOString(),
          last_silenced_reply_at: null,
        })
        .eq("id", conv.id);

      // COPY: mesma disciplina do hard stop de franquia 70 linhas acima, e aqui
      // ela é MODAL e não excepcional. A forma do defeito: a rodada 2 executa
      // `create_reservation`, a rodada 3 — a que CONFIRMA ao cliente — é recusada
      // pelo prazo, e a reserva fica `confirmed` no banco enquanto o cliente é
      // informado de instabilidade técnica. Ele não aparece (mesa segurada vazia)
      // ou aparece achando que não tem reserva. É literalmente o caso que
      // `ai-budget-copy.ts` nomeia: "usar a mesma frase para as três é o erro que
      // produz cliente aparecendo no restaurante sem mesa".
      //
      // A ferramenta mutante é a PRIMEIRA pergunta, com prazo ou com erro de
      // provedor: o desfecho para o cliente é o mesmo (a reserva mudou e a
      // confirmação não saiu). O erro pós-mutação ficou frequente quando a
      // resposta cortada passou a ser `AgentTruncatedError` em vez de meia frase
      // — a rodada final, a que confirma, é a mais longa e a que mais corta.
      //
      // TRÊS pernas, e a terceira não é simetria: sem ela o prazo SEM ferramenta
      // mutante — tão frequente quanto o caso acima — afirma "instabilidade"
      // sobre uma parada PLANEJADA, que é a outra regra que `ai-budget-copy.ts`
      // escreve no próprio cabeçalho ("não pode afirmar falha técnica: não houve
      // falha nenhuma"). O texto reusado é o do hard stop sem mutação porque, do
      // lado do CLIENTE, a situação é a mesma: nada foi alterado, a mensagem
      // ficou registrada e uma pessoa assume. Reusar em vez de redigitar é o que
      // mantém uma frase por situação — e o que garante que ela já está no
      // `HARDCODED_AGENT_NOISE`, pela lista importada.
      let handoffText: string;
      if (mutatingToolUsed) {
        handoffText = resolveMutationStopText(lastMutationOutcome);
      } else if (!agentDeadlineReached) {
        handoffText = AGENT_INSTABILITY_TEXT;
      } else {
        handoffText = AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT;
      }
      const errorNotice = await sendAutomatic(handoffText);
      if (errorNotice.ok) {
        await appendToConversation(
          conv.id,
          [...(conv.messages || []), { role: "user", content: incomingText }],
          "assistant",
          handoffText,
          { author: "automation" },
        );
      }

      jsonLog("warn", {
        requestId,
        evt: "agent_error_handoff",
        provider: usedProvider,
        model: usedModel,
        ...fallbackMeta,
        deadline: agentDeadlineReached,
        err: agentError,
      });
      // Turno INTERROMPIDO (pelo provedor ou pelo prazo): o consumido migra
      // para o liquidado e a diferença volta ao disponível. Antes do `finish` —
      // ver o desfecho de negação acima.
      await settleTurnBudget("RELEASED");
      await finish("agent_error", agentError, {
        provider: usedProvider,
        model: usedModel,
        ...fallbackMeta,
        channel_id: channelId,
        // O outcome continua `agent_error` de propósito: o vocabulário de
        // `webhook_executions.outcome` é consumido por painel e diagnóstico, e
        // trocá-lo é mudança de contrato que esta task não pede. A distinção
        // viaja no `meta` e no `handoff_reason`.
        deadline: agentDeadlineReached,
      });
      await releaseAiLock();
      return;
    }

    if (!finalText || !finalText.trim()) {
      // Modelo não devolveu texto algum — ainda assim respondemos pra não
      // deixar o cliente no escuro.
      jsonLog("warn", { requestId, evt: "agent_empty_response", channelId, unitId });

      const emptyText = "Desculpa, não consegui montar uma resposta agora. Pode reformular ou aguardar um instante?";
      const emptyNotice = await sendAutomatic(emptyText);
      if (emptyNotice.ok) {
        await appendToConversation(conv.id, conv.messages || [], "assistant", emptyText, { author: "automation" });
      }
      // Mesma razão do ramo de erro: turno interrompido sem produzir resposta.
      await settleTurnBudget("RELEASED");
      await finish("empty_response");
      await releaseAiLock();
      return;
    }

    // Sanitiza markdown padrão de LLM (**bold**, # header, `code`, listas com
    // "* ", links [text](url)) pro formato do canal (WhatsApp: *bold*, "- ").
    // Rede defensiva — o system prompt já instrui, mas modelos divergem.
    // A versão sanitizada é o que vai pro cliente E o que fica no log da
    // conversa operacional (operador vê o mesmo que cliente recebeu).
    const finalTextForChannel = ctx.sanitize(finalText);

    const sendRes = await sendAutomatic(finalTextForChannel);

    if (sendRes.error === "suppressed_by_human") {
      await settleTurnBudget("SETTLED");
      await finish("ai_reply_suppressed_by_human");
      await releaseAiLock();
      return;
    }

    if (!sendRes.ok) {
      // O TURNO DE IA ACONTECEU: o que falhou foi a entrega pelo canal. O
      // custo é real e já está em `ai_usage_events`; sem liquidar aqui ele
      // jamais contaria contra o teto — a varredura de expiradas devolve a
      // reserva sem incrementar `settled_cents`.
      await settleTurnBudget("SETTLED");
      await finish("send_error", sendRes.error ?? `status_${sendRes.status}`, {
        missingCreds: sendRes.missingCreds,
        bodySnippet: sendRes.bodySnippet,
      });
      await releaseAiLock();
      return;
    }

    const finalHistoryAppend = await appendToConversation(
      conv.id,
      [...(conv.messages || []), { role: "user", content: incomingText }],
      "assistant",
      finalTextForChannel,
      { author: "ai" },
    );

    // Fim do turno: liquida o custo real e devolve a diferença ao disponível.
    // Os marcos (70/80/90/100%) saem daqui porque é aqui que o liquidado do
    // ciclo muda. Antes do `finish` — ver o desfecho de negação acima.
    await settleTurnBudget("SETTLED");
    await finish(
      finalHistoryAppend.persisted ? "success" : "success_history_degraded",
      finalHistoryAppend.persisted ? undefined : "conversation_message_persist_failed_after_send",
      { tokens: totalUsage.input_tokens + totalUsage.output_tokens, ...fallbackMeta },
    );
    await releaseAiLock();
    return;
  };

  return { run, settleTurnBudget, releaseAiLock };
}
