/**
 * process-instagram-inbound — worker da fila do Direct (Task 4.1).
 *
 * Entradas (ambas só com `x-internal-key`; `verify_jwt = false`):
 * - kick do `webhook-instagram`: POST `{ event_id }`. O worker NUNCA recebe
 *   payload: relê a linha pelo id e a reivindica;
 * - varredura do pg_cron: `?sweep=1`, sem corpo; lê só a tabela.
 *
 * Por linha da fila (claim cercado por UUID, lease de 90 s):
 * 1. `claim_instagram_inbound_event`; `attempts` estourado (espelho de
 *    `INBOUND_MAX_ATTEMPTS` do WhatsApp) fecha como `dead` logo depois do claim.
 * 2. Gates de novo, SEM cache: conta `connected` (da própria linha), grant ativo
 *    e `dm_enabled`. Descarte fecha `done/discarded_<motivo>`; erro de leitura
 *    reagenda pela escada `nextAttemptDelayMs` (e vira `dead` no fim).
 *    BILLING: mesmo predicado (`isOrgBillingBlocked`) e MESMA POLARIDADE do
 *    `webhook-whatsapp` — FALHA ABERTA: erro de leitura de `organizations`
 *    chega como `null` e NÃO bloqueia. Org bloqueada não descarta o evento:
 *    como no WhatsApp, o inbound entra no histórico e a mensagem fecha
 *    `org_billing_blocked`, sem LLM nem envio.
 * 3. Itens só das entradas da conta da linha (`extractAccountItems`): eco →
 *    `echo_own`/`echo_unknown`; `story_mention` e ignorados → desfecho; texto e
 *    mídia → `claim_instagram_message` (`null` = já feita ou em voo).
 * 4–6. Contato (perfil best-effort no 1º contato) → conversa
 *    (`get_or_create_instagram_conversation`) → cliente ligado (só `{id, phone}`)
 *    → `check_rate_limit('ig:'||igsid, 60, 10, unit_id)`.
 * 7. Mídia: inbound no histórico e `MEDIA_REPLY_TEXT`, salvo handoff humano.
 * 8. Texto: turno do núcleo do agente com o `ChannelContext` do Instagram.
 * 9. Fecha o evento (`done`, ou reagenda se um item pediu nova tentativa).
 *
 * Tenant: unidade e organização vêm da CONTA da linha e da unidade lida, nunca
 * do payload; o contato e a conversa são conferidos contra elas antes do turno
 * (divergência = terminal com alerta, sem LLM).
 *
 * Catch do turno (`agente-ia.md`): `settleTurnBudget("RELEASED")` e depois
 * `releaseAiLock()`, ANTES de completar a mensagem e de fechar o evento. Exceção
 * antes de qualquer efeito externo libera o claim da mensagem pela cerca
 * (`release_instagram_message_claim`, R4-k; se a liberação falhar, o lease de
 * 90 s cobre) e reagenda o evento; depois do efeito externo, a mensagem fecha
 * `webhook_error` e não se repete.
 *
 * Erro 190 marca `reauth_required` com o `connected_at` lido nos gates (CAS,
 * 20261029200800): reconexão no meio do turno não é derrubada.
 *
 * Logs: ids internos, classes e códigos; nunca texto do cliente, IGSID, token
 * ou texto da Meta. Adapter de I/O: as decisões moram em
 * `_shared/instagram-inbound-core.ts` e nos núcleos do agente.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog, requireInternalAuth } from "../_shared/security.ts";
import { createAgentTurn, type AppendToConversation } from "../_shared/agent/turn.ts";
import { buildAgentUnit } from "../_shared/agent/unit-context.ts";
import type { AgentConversation, ChannelContext, ClaimedIdentityPort, LinkPhoneResult } from "../_shared/agent/channel-context.ts";
import { createInstagramGraph } from "../_shared/instagram-graph.ts";
import {
  INSTAGRAM_CHANNEL_RULES,
  INSTAGRAM_FORMATTING_RULES,
  buildInstagramIdentityLine,
  cleanInstagramProfileName,
  sanitizeForInstagram,
} from "../_shared/instagram-format.ts";
import {
  INSTAGRAM_CONTACT_RATE_LIMIT,
  INSTAGRAM_MEDIA_PLACEHOLDER,
  STORY_MENTION_OUTCOME,
  buildInstagramConversationMessage,
  extractAccountItems,
  ignoredOutcome,
  instagramInboundEventId,
  instagramRateLimitKey,
  isEchoOwn,
  linkChangeCapReached,
  mapContactReservationRpc,
  recordedMessageOutcome,
  safeErrorLabel,
  sendInstagramParts,
  type InstagramItem,
} from "../_shared/instagram-inbound-core.ts";
import {
  decodeRawBodyHex,
  nextAttemptDelayMs,
  parseSelectedEventIds,
  sanitizeQueueErrorText,
  shouldPromoteToDead,
  sweepShouldStartAnother,
  SWEEP_SELECT_LIMIT,
} from "../_shared/whatsapp-inbound-queue-core.ts";
import { isOrgBillingBlocked } from "../_shared/org-billing-gate-core.ts";
import { MEDIA_REPLY_TEXT } from "../_shared/media-reply-text.ts";
import { validateBrPhone } from "../_shared/public-br-phone.ts";
import { canonicalBrPhone } from "../_shared/phone.ts";
import { resolveOrCreateCustomer } from "../_shared/resolve-customer.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const graph = createInstagramGraph((input, init) => fetch(input, init));
const APP_BASE_URL = () => Deno.env.get("APP_BASE_URL") ?? "https://reservas.moralles.com.br";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEDGER_PAGE = 1000;

/** Falha antes de qualquer efeito externo: a linha da fila tenta de novo. */
class RetryableItemError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "RetryableItemError";
  }
}

function pgCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

type ClaimedRow = {
  id: string;
  instagram_account_id: string;
  unit_id: string;
  raw_body: string;
  attempts: number;
  claim_id: string;
};

type Account = { id: string; unit_id: string; organization_id: string; ig_user_id: string; status: string; connected_at: string };

type Contact = {
  id: string;
  unit_id: string;
  instagram_account_id: string;
  customer_id: string | null;
  username: string | null;
  name: string | null;
};

type EventVerdict =
  | { kind: "done"; outcome: string }
  | { kind: "retry"; outcome: string }
  | { kind: "dead"; outcome: string };

// ─── Fila ───────────────────────────────────────────────────────────────────

async function finalizeEvent(row: ClaimedRow, verdict: EventVerdict, error: string | null): Promise<void> {
  let status: "done" | "received" | "dead" = verdict.kind === "done" ? "done" : verdict.kind === "dead" ? "dead" : "received";
  let delaySeconds: number | null = null;
  if (verdict.kind === "retry") {
    const delay = nextAttemptDelayMs(row.attempts);
    if (delay === null) status = "dead";
    else delaySeconds = Math.round(delay / 1000);
  }
  if (status === "dead") {
    // Dead letter: alerta, a linha fica 30 dias para diagnóstico.
    jsonLog("error", { evt: "instagram_inbound_dead_letter", eventId: row.id, unitId: row.unit_id, outcome: verdict.outcome });
  }
  const { data, error: rpcError } = await supabase.rpc("finalize_instagram_inbound_event", {
    p_event_id: row.id,
    p_claim_id: row.claim_id,
    p_status: status,
    p_outcome: verdict.outcome,
    p_error: sanitizeQueueErrorText(error),
    p_retry_delay_seconds: delaySeconds,
  });
  if (rpcError || data !== 1) {
    // Cerca perdida (outro worker reivindicou depois do lease) ou banco fora:
    // o lease de 90 s devolve a linha à fila.
    jsonLog("warn", { evt: "instagram_inbound_finalize_not_applied", eventId: row.id, code: pgCode(rpcError) });
    return;
  }
  jsonLog("info", { evt: "instagram_inbound_finalized", eventId: row.id, status, outcome: verdict.outcome });
}

async function claimEvent(eventId: string): Promise<{ ok: true; row: ClaimedRow | null } | { ok: false }> {
  const { data, error } = await supabase.rpc("claim_instagram_inbound_event", { p_event_id: eventId });
  if (error) {
    jsonLog("error", { evt: "instagram_inbound_claim_failed", eventId, code: pgCode(error) });
    return { ok: false };
  }
  const row = (Array.isArray(data) ? data[0] : data) as Partial<ClaimedRow> | null | undefined;
  if (
    !row || typeof row.id !== "string" || typeof row.instagram_account_id !== "string" ||
    typeof row.unit_id !== "string" || typeof row.raw_body !== "string" ||
    typeof row.attempts !== "number" || typeof row.claim_id !== "string"
  ) {
    return { ok: true, row: null };
  }
  return { ok: true, row: row as ClaimedRow };
}

// ─── Gates ──────────────────────────────────────────────────────────────────

type GateResult =
  | { kind: "pass"; account: Account; billingBlocked: boolean }
  | { kind: "discard"; reason: string }
  | { kind: "retry"; reason: string };

async function readGates(row: ClaimedRow): Promise<GateResult> {
  // Conta da PRÓPRIA linha (id e unidade): nunca do payload.
  const { data: acc, error: accError } = await supabase
    .from("instagram_accounts")
    .select("id, unit_id, organization_id, ig_user_id, status, connected_at")
    .eq("id", row.instagram_account_id)
    .eq("unit_id", row.unit_id)
    .maybeSingle();
  if (accError) return { kind: "retry", reason: "account_read_failed" };
  const account = acc as Account | null;
  if (
    !account || account.status !== "connected" || typeof account.ig_user_id !== "string" ||
    typeof account.organization_id !== "string" || typeof account.connected_at !== "string"
  ) {
    return { kind: "discard", reason: "account_not_connected" };
  }

  const { data: grants, error: grantError } = await supabase
    .from("unit_module_grants")
    .select("unit_id")
    .eq("unit_id", account.unit_id)
    .eq("module", "instagram")
    .is("revoked_at", null)
    .limit(1);
  if (grantError) return { kind: "retry", reason: "grant_read_failed" };
  if (!Array.isArray(grants) || grants.length === 0) return { kind: "discard", reason: "no_grant" };

  const { data: settings, error: settingsError } = await supabase
    .from("instagram_settings")
    .select("dm_enabled")
    .eq("unit_id", account.unit_id)
    .maybeSingle();
  if (settingsError) return { kind: "retry", reason: "settings_read_failed" };
  if ((settings as { dm_enabled?: unknown } | null)?.dm_enabled !== true) return { kind: "discard", reason: "dm_disabled" };

  // Billing: mesmo predicado e mesma polaridade do webhook-whatsapp (falha ABERTA).
  const { data: orgBilling, error: billingError } = await supabase
    .from("organizations")
    .select("billing_status")
    .eq("id", account.organization_id)
    .single();
  if (billingError) {
    jsonLog("warn", { evt: "instagram_inbound_billing_read_failed", unitId: account.unit_id, code: pgCode(billingError) });
  }
  return { kind: "pass", account, billingBlocked: isOrgBillingBlocked(orgBilling) };
}

// ─── Evento ─────────────────────────────────────────────────────────────────

/** Processa uma linha da fila. Nunca lança. */
async function processEventById(eventId: string): Promise<string> {
  const claimed = await claimEvent(eventId);
  if (claimed.ok === false) return "claim_failed";
  const row = claimed.row;
  if (!row) return "not_claimable";

  try {
    if (shouldPromoteToDead(row.attempts)) {
      await finalizeEvent(row, { kind: "dead", outcome: "attempts_exhausted" }, null);
      return "attempts_exhausted";
    }

    const gate = await readGates(row);
    if (gate.kind === "retry") {
      jsonLog("warn", { evt: "instagram_inbound_gate_unavailable", eventId: row.id, reason: gate.reason });
      await finalizeEvent(row, { kind: "retry", outcome: gate.reason }, gate.reason);
      return gate.reason;
    }
    if (gate.kind === "discard") {
      jsonLog("info", { evt: "instagram_inbound_discarded", eventId: row.id, reason: gate.reason });
      await finalizeEvent(row, { kind: "done", outcome: `discarded_${gate.reason}` }, null);
      return `discarded_${gate.reason}`;
    }
    const account = gate.account;

    // Unidade com `SELECT *` (mesma leitura do webhook-whatsapp).
    const { data: unitRow, error: unitError } = await supabase
      .from("units")
      .select("*")
      .eq("id", account.unit_id)
      .maybeSingle();
    if (unitError || !unitRow) {
      await finalizeEvent(row, { kind: "retry", outcome: "unit_read_failed" }, "unit_read_failed");
      return "unit_read_failed";
    }
    if (unitRow.organization_id !== account.organization_id) {
      jsonLog("error", { evt: "instagram_inbound_tenant_mismatch_alert", eventId: row.id, unitId: account.unit_id });
      await finalizeEvent(row, { kind: "dead", outcome: "tenant_mismatch" }, null);
      return "tenant_mismatch";
    }

    let body: unknown;
    try {
      body = JSON.parse(decodeRawBodyHex(row.raw_body));
    } catch {
      jsonLog("error", { evt: "instagram_inbound_body_unreadable", eventId: row.id });
      await finalizeEvent(row, { kind: "done", outcome: "malformed_body" }, null);
      return "malformed_body";
    }

    const items = extractAccountItems(body, account.ig_user_id);
    const worker = createEventWorker({ row, account, unitRow, billingBlocked: gate.billingBlocked });
    for (const item of items) {
      const result = await worker.processItem(item);
      if (result === "retry") {
        // Para no primeiro item que pede nova tentativa: a ordem do Direct
        // se mantém e os já feitos são deduplicados pelo ledger por `mid`.
        await finalizeEvent(row, { kind: "retry", outcome: "item_retry" }, worker.lastRetryReason());
        return "item_retry";
      }
    }
    await finalizeEvent(row, { kind: "done", outcome: items.length > 0 ? "processed" : "no_items" }, null);
    return "processed";
  } catch (err) {
    jsonLog("error", { evt: "instagram_inbound_event_error", eventId: row.id, err: safeErrorLabel(err) });
    try {
      await finalizeEvent(row, { kind: "retry", outcome: "worker_error" }, "worker_error");
    } catch {
      // o lease de 90 s devolve a linha
    }
    return "worker_error";
  }
}

// ─── Itens ──────────────────────────────────────────────────────────────────

function createEventWorker(a: {
  row: ClaimedRow;
  account: Account;
  // deno-lint-ignore no-explicit-any
  unitRow: Record<string, any>;
  billingBlocked: boolean;
}) {
  const { row, account, unitRow, billingBlocked } = a;
  const unitId = account.unit_id;
  const organizationId = account.organization_id;
  let retryReason: string | null = null;
  let token: string | null = null;
  let reauthMarked = false;

  async function accountToken(): Promise<string> {
    if (token) return token;
    const { data, error } = await supabase.rpc("get_instagram_account_token", { p_account_id: account.id });
    if (error || typeof data !== "string" || data === "") throw new RetryableItemError("token_read_failed");
    token = data;
    return data;
  }

  async function markReauth(): Promise<void> {
    if (reauthMarked) return;
    reauthMarked = true;
    const { data, error } = await supabase.rpc("set_instagram_account_status", {
      p_account_id: account.id,
      p_status: "reauth_required",
      p_error_code: "190",
      p_expected_connected_at: account.connected_at,
    });
    if (!error && data === false) {
      // CAS: o dono reconectou depois da leitura; a conexão nova fica intacta.
      jsonLog("info", { evt: "instagram_account_reauth_stale", accountId: account.id });
      return;
    }
    jsonLog(error || data !== true ? "error" : "warn", {
      evt: "instagram_account_reauth_required", accountId: account.id, code: pgCode(error) ?? (data === true ? undefined : "unexpected_result"),
    });
  }

  async function recordOutcome(mid: string, outcome: string): Promise<void> {
    const { error } = await supabase.rpc("record_instagram_message_outcome", {
      p_account_id: account.id,
      p_mid: mid,
      p_outcome: outcome,
      p_meta: { event_id: row.id },
    });
    if (error) throw new RetryableItemError("outcome_record_failed");
  }

  async function findContact(igsid: string): Promise<Contact | null> {
    const { data, error } = await supabase
      .from("instagram_contacts")
      .select("id, unit_id, instagram_account_id, customer_id, username, name")
      .eq("instagram_account_id", account.id)
      .eq("igsid", igsid)
      .maybeSingle();
    if (error) throw new RetryableItemError("contact_read_failed");
    return (data as Contact | null) ?? null;
  }

  async function contactById(id: string): Promise<Contact | null> {
    const { data, error } = await supabase
      .from("instagram_contacts")
      .select("id, unit_id, instagram_account_id, customer_id, username, name")
      .eq("id", id)
      .eq("instagram_account_id", account.id)
      .maybeSingle();
    if (error) throw new RetryableItemError("contact_read_failed");
    return (data as Contact | null) ?? null;
  }

  async function ensureContact(igsid: string): Promise<Contact | null> {
    const found = await findContact(igsid);
    if (found) return found;
    // Primeiro contato: perfil best-effort (falha não impede o atendimento).
    let username: string | null = null;
    let name: string | null = null;
    try {
      const profile = await graph.profile({ igsid, token: await accountToken() });
      if (profile.ok === true) {
        username = profile.value.username;
        name = profile.value.name;
      } else {
        jsonLog("info", { evt: "instagram_profile_unavailable", accountId: account.id, errorClass: profile.errorClass });
      }
    } catch (err) {
      if (err instanceof RetryableItemError) throw err;
      jsonLog("info", { evt: "instagram_profile_unavailable", accountId: account.id });
    }
    const { data: contactId, error } = await supabase.rpc("upsert_instagram_contact", {
      p_account_id: account.id,
      p_igsid: igsid,
      p_username: username,
      p_name: name,
    });
    if (error || typeof contactId !== "string") throw new RetryableItemError("contact_upsert_failed");
    return await contactById(contactId);
  }

  async function loadConversation(contact: Contact): Promise<{ conv: AgentConversation & { unit_id: string; channel: string; instagram_contact_id: string | null } } | null> {
    const { data: convId, error } = await supabase.rpc("get_or_create_instagram_conversation", { p_contact_id: contact.id });
    if (error || typeof convId !== "string") throw new RetryableItemError("conversation_resolve_failed");
    const { data, error: readError } = await supabase
      .from("conversations")
      .select("id, unit_id, channel, instagram_contact_id, messages, status, handoff_reason, handoff_at, last_silenced_reply_at")
      .eq("id", convId)
      // Filtro de tenant na própria query (a conferência abaixo continua).
      .eq("unit_id", unitId)
      .maybeSingle();
    if (readError) throw new RetryableItemError("conversation_read_failed");
    if (!data) return null;
    // deno-lint-ignore no-explicit-any
    const conv = data as any;
    conv.messages = Array.isArray(conv.messages) ? conv.messages : [];
    return { conv };
  }

  async function linkedCustomer(contact: Contact): Promise<{ id: string; phone: string } | null> {
    if (!contact.customer_id) return null;
    const { data, error } = await supabase
      .from("customers")
      .select("id, phone")
      .eq("id", contact.customer_id)
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw new RetryableItemError("customer_read_failed");
    const c = data as { id?: unknown; phone?: unknown } | null;
    return c && typeof c.id === "string" && typeof c.phone === "string" ? { id: c.id, phone: c.phone } : null;
  }

  /**
   * `claim_instagram_message` devolveu `null`: ou a mensagem já foi concluída
   * (pula), ou está em voo noutro worker / num lease de tentativa anterior
   * (o evento tenta de novo depois).
   */
  async function claimedElsewhereIsInFlight(mid: string): Promise<boolean> {
    const { data, error } = await supabase
      .from("instagram_processed_messages")
      .select("status")
      .eq("instagram_account_id", account.id)
      .eq("mid", mid)
      .maybeSingle();
    if (error) return true;
    return (data as { status?: unknown } | null)?.status === "processing";
  }

  async function processItem(item: InstagramItem): Promise<"done" | "retry"> {
    try {
      switch (item.kind) {
        case "ignored":
          if (item.mid) await recordOutcome(item.mid, ignoredOutcome(item.reason));
          return "done";
        case "story_mention":
          await recordOutcome(item.mid, STORY_MENTION_OUTCOME);
          return "done";
        case "echo": {
          // Eco: só o desfecho, sem append e sem silenciar a IA (D5).
          let own = false;
          const contact = await findContact(item.igsid);
          if (contact) {
            const { data, error } = await supabase
              .from("conversations")
              .select("messages")
              .eq("instagram_contact_id", contact.id)
              .eq("unit_id", unitId)
              .maybeSingle();
            if (error) throw new RetryableItemError("conversation_read_failed");
            own = isEchoOwn((data as { messages?: unknown } | null)?.messages, item.mid);
          }
          await recordOutcome(item.mid, own ? "echo_own" : "echo_unknown");
          return "done";
        }
        case "text":
        case "media": {
          const { data: claimId, error } = await supabase.rpc("claim_instagram_message", {
            p_account_id: account.id,
            p_mid: item.mid,
          });
          if (error) throw new RetryableItemError("message_claim_failed");
          if (typeof claimId !== "string") {
            if (await claimedElsewhereIsInFlight(item.mid)) throw new RetryableItemError("message_in_flight");
            return "done";
          }
          return await processMessage(item, claimId);
        }
      }
    } catch (err) {
      if (err instanceof RetryableItemError) {
        retryReason = err.reason;
        jsonLog("warn", { evt: "instagram_inbound_item_retry", eventId: row.id, reason: err.reason });
        return "retry";
      }
      throw err;
    }
  }

  async function processMessage(
    item: Extract<InstagramItem, { kind: "text" | "media" }>,
    claimId: string,
  ): Promise<"done" | "retry"> {
    const requestId = crypto.randomUUID();
    const t0 = Date.now();
    let historyDegraded = false;
    let externalSideEffect = false;
    let pendingMessageIds: string[] = [];
    // Envio parcial (parte 1 saiu, parte 2 falhou): o núcleo não appenda, então
    // os ids vão só no `meta` do desfecho, para diagnóstico (sem conteúdo).
    let partialSentIds: string[] = [];

    /**
     * R4-k: falha ANTES de qualquer efeito externo devolve a mensagem à fila na
     * hora, pela mesma cerca do claim. Nunca lança; falhar aqui só deixa o lease
     * de 90 s fazer o mesmo.
     */
    const releaseClaim = async () => {
      try {
        const { data, error } = await supabase.rpc("release_instagram_message_claim", {
          p_account_id: account.id,
          p_mid: item.mid,
          p_claim_id: claimId,
        });
        if (error || data !== true) {
          jsonLog("warn", { evt: "instagram_message_claim_release_failed", requestId, eventId: row.id, code: pgCode(error) });
        }
      } catch {
        jsonLog("warn", { evt: "instagram_message_claim_release_failed", requestId, eventId: row.id });
      }
    };

    /** `complete_instagram_message`: desfecho e meta, sem conteúdo. Nunca lança. */
    const finish = async (outcome: string, error?: string | null, meta?: Record<string, unknown>) => {
      if (outcome === "invalid_channel_context") {
        // Terminal com alerta: contexto que o núcleo recusou não se repete.
        jsonLog("error", { evt: "instagram_agent_context_invalid_alert", requestId, eventId: row.id, unitId });
      }
      const recorded = recordedMessageOutcome(outcome, error, historyDegraded);
      try {
        const { data, error: rpcError } = await supabase.rpc("complete_instagram_message", {
          p_account_id: account.id,
          p_mid: item.mid,
          p_claim_id: claimId,
          p_outcome: recorded,
          p_error: sanitizeQueueErrorText(error ?? null),
          p_meta: {
            ...(meta ?? {}),
            event_id: row.id,
            request_id: requestId,
            ...(partialSentIds.length > 0 ? { sent_message_ids: [...partialSentIds] } : {}),
          },
        });
        if (rpcError || data !== true) {
          jsonLog("warn", { evt: "instagram_message_complete_not_applied", requestId, eventId: row.id, code: pgCode(rpcError) });
        }
      } catch {
        jsonLog("warn", { evt: "instagram_message_complete_not_applied", requestId, eventId: row.id });
      }
      jsonLog("info", { evt: "instagram_message_finished", requestId, eventId: row.id, outcome: recorded, duration_ms: Date.now() - t0 });
    };

    const appendToConversation: AppendToConversation = async (convId, existing, role, content, options = {}) => {
      const msg = buildInstagramConversationMessage({
        role,
        content,
        eventId: options.eventId ?? crypto.randomUUID(),
        author: options.author,
        timestamp: options.timestamp,
        receivedAt: options.receivedAt,
        providerMessageIds: role === "user" ? undefined : pendingMessageIds,
      });
      if (role !== "user") pendingMessageIds = [];
      let persisted = false;
      for (let attempt = 0; attempt < 2 && !persisted; attempt++) {
        const { error } = await supabase.rpc("append_conversation_message", { p_conversation_id: convId, p_message: msg });
        if (!error) persisted = true;
        else jsonLog("warn", { evt: "append_conversation_message_failed", convId, attempt, code: pgCode(error) });
      }
      if (options.required && !persisted) throw new RetryableItemError("conversation_message_persist_failed");
      if (!persisted) historyDegraded = true;
      return { messages: [...existing, msg], persisted };
    };

    // Envio pelo Graph. NUNCA lança (contrato do `ChannelContext.send`).
    const send = async (text: string) => {
      pendingMessageIds = [];
      partialSentIds = [];
      let accessToken: string;
      try {
        accessToken = await accountToken();
      } catch {
        return { ok: false, error: "token_unavailable" };
      }
      const out = await sendInstagramParts(text, (part) =>
        graph.sendText({ igUserId: account.ig_user_id, token: accessToken, igsid: item.igsid, text: part }));
      if (out.reauthRequired) {
        try {
          await markReauth();
        } catch {
          jsonLog("error", { evt: "instagram_account_reauth_mark_failed", accountId: account.id });
        }
      }
      if (out.result.ok === true) {
        pendingMessageIds = out.messageIds;
      } else {
        partialSentIds = out.messageIds;
        jsonLog("warn", {
          evt: "instagram_send_failed",
          requestId,
          accountId: account.id,
          error: out.result.error,
          status: out.result.status ?? null,
          sentParts: out.messageIds.length,
        });
      }
      return out.result;
    };

    try {
      // Token antes de qualquer efeito: sem ele não há envio possível.
      await accountToken();
      const contact = await ensureContact(item.igsid);
      if (!contact || contact.unit_id !== unitId || contact.instagram_account_id !== account.id) {
        jsonLog("error", { evt: "instagram_contact_tenant_mismatch_alert", requestId, eventId: row.id, unitId });
        await finish("tenant_mismatch");
        return "done";
      }
      const loaded = await loadConversation(contact);
      const conv = loaded?.conv;
      if (!conv || conv.unit_id !== unitId || conv.channel !== "instagram" || conv.instagram_contact_id !== contact.id) {
        // Divergência de tenant: terminal, com alerta, sem LLM.
        jsonLog("error", { evt: "instagram_conversation_tenant_mismatch_alert", requestId, eventId: row.id, unitId });
        await finish("conversation_tenant_mismatch");
        return "done";
      }
      const customer = await linkedCustomer(contact);

      // Rate limit por contato (mesma polaridade do WhatsApp: só `false` limita).
      const { data: allowed } = await supabase.rpc("check_rate_limit", {
        p_phone: instagramRateLimitKey(item.igsid),
        p_window_seconds: INSTAGRAM_CONTACT_RATE_LIMIT.windowSeconds,
        p_max: INSTAGRAM_CONTACT_RATE_LIMIT.max,
        p_unit_id: unitId,
      });
      if (allowed === false) {
        jsonLog("warn", { evt: "instagram_rate_limited", requestId, unitId });
        await finish("rate_limited");
        return "done";
      }

      const inboundEventId = instagramInboundEventId(account.id, item.mid);
      const receivedAt = new Date().toISOString();
      const inboundText = item.kind === "text" ? item.text : INSTAGRAM_MEDIA_PLACEHOLDER;

      if (billingBlocked) {
        // Org bloqueada: o inbound entra no histórico; sem IA e sem resposta.
        await appendToConversation(conv.id, conv.messages, "user", inboundText, {
          author: "customer", timestamp: item.timestamp, receivedAt, eventId: inboundEventId, required: true,
        });
        jsonLog("warn", { evt: "instagram_org_billing_blocked", requestId, unitId, organizationId });
        await finish("org_billing_blocked");
        return "done";
      }

      if (item.kind === "media") {
        const appended = await appendToConversation(conv.id, conv.messages, "user", inboundText, {
          author: "customer", timestamp: item.timestamp, receivedAt, eventId: inboundEventId, required: true,
        });
        if (conv.status === "human_active" || conv.status === "awaiting_human") {
          await finish("media_during_handoff");
          return "done";
        }
        externalSideEffect = true;
        const sendRes = await send(MEDIA_REPLY_TEXT);
        if (sendRes.ok) {
          await appendToConversation(conv.id, appended.messages, "assistant", MEDIA_REPLY_TEXT, { author: "automation" });
          await finish("media_response");
        } else {
          await finish("send_error", sendRes.error ?? null);
        }
        return "done";
      }

      // Texto: turno do agente.
      const agentTurn = createAgentTurn({
        supabase,
        requestId,
        requestStartedAt: t0,
        ingestionSource: "queue",
        finish,
        appendToConversation,
        markExternalSideEffect: () => {
          externalSideEffect = true;
        },
      });
      const { settleTurnBudget, releaseAiLock } = agentTurn;

      const port: ClaimedIdentityPort = {
        // Ledger do contato NA UNIDADE, paginado até o fim; erro lança (nunca `[]`).
        reservationIds: async () => {
          const ids: string[] = [];
          for (let from = 0;; from += LEDGER_PAGE) {
            const { data, error } = await supabase
              .from("instagram_contact_reservations")
              .select("reservation_id")
              .eq("instagram_contact_id", contact.id)
              .eq("unit_id", unitId)
              .order("reservation_id", { ascending: true })
              .range(from, from + LEDGER_PAGE - 1);
            if (error || !Array.isArray(data)) throw new Error("instagram_ledger_read_failed");
            for (const r of data as Array<{ reservation_id?: unknown }>) {
              if (typeof r.reservation_id === "string") ids.push(r.reservation_id);
            }
            if (data.length < LEDGER_PAGE) return ids;
          }
        },
        // Reserva e ledger numa transação (RPC atômica, teto de 3 ativas).
        insertReservation: async (reservationRow) => {
          const { data, error } = await supabase.rpc("create_instagram_contact_reservation", {
            p_contact_id: contact.id,
            p_reservation: reservationRow,
          });
          const mapped = mapContactReservationRpc(data, error);
          if (mapped.error) {
            jsonLog("warn", { evt: "instagram_contact_reservation_refused", requestId, unitId, code: mapped.error.code ?? null });
          }
          return mapped;
        },
        // Telefone declarado → cliente da organização do contato. Qualquer erro
        // é `unavailable`, sem revelar se o cadastro existe.
        linkPhone: async ({ phone, name }): Promise<LinkPhoneResult> => {
          if (typeof phone !== "string" || !validateBrPhone(phone)) return { ok: false, reason: "invalid_phone" };
          const canonical = canonicalBrPhone(phone);
          // R4-l: o teto de trocas também limita a CRIAÇÃO de cadastro. Antes de
          // qualquer escrita em `customers`, relê o contato e, se ligar outro
          // telefone estouraria o teto (mesma regra da RPC), devolve
          // `unavailable` sem tocar `customers`. A RPC segue autoritativa.
          try {
            const { data: fresh, error: freshError } = await supabase
              .from("instagram_contacts")
              .select("customer_id, link_changes_count, link_changes_window_started_at")
              .eq("id", contact.id)
              .eq("unit_id", unitId)
              .maybeSingle();
            if (freshError || !fresh) {
              jsonLog("warn", { evt: "instagram_link_phone_precheck_failed", requestId, unitId, code: pgCode(freshError) });
              return { ok: false, reason: "unavailable" };
            }
            const f = fresh as { customer_id?: unknown; link_changes_count?: unknown; link_changes_window_started_at?: unknown };
            if (linkChangeCapReached({
              currentCustomerId: f.customer_id,
              changesCount: f.link_changes_count,
              windowStartedAt: f.link_changes_window_started_at,
              nowMs: Date.now(),
            })) {
              // Religar o MESMO cliente não é troca: só segue se o telefone
              // declarado é o do cliente ligado hoje (leitura, sem escrita).
              const { data: current, error: currentError } = await supabase
                .from("customers")
                .select("phone")
                .eq("id", f.customer_id as string)
                .eq("organization_id", organizationId)
                .maybeSingle();
              const currentPhone = (current as { phone?: unknown } | null)?.phone;
              if (currentError || typeof currentPhone !== "string" || canonicalBrPhone(currentPhone) !== canonical) {
                jsonLog("warn", { evt: "instagram_link_phone_cap_reached", requestId, unitId });
                return { ok: false, reason: "unavailable" };
              }
            }
          } catch {
            return { ok: false, reason: "unavailable" };
          }
          try {
            // Nome limpo só para cadastro NOVO; o existente preserva o nome e
            // nenhum e-mail é gravado (`email: null`).
            const resolved = await resolveOrCreateCustomer(supabase, {
              organizationId,
              phone: canonical,
              name: cleanInstagramProfileName(name) || canonical,
              email: null,
            });
            const { error } = await supabase.rpc("link_instagram_contact_customer", {
              p_contact_id: contact.id,
              p_customer_id: resolved.id,
            });
            if (error) {
              jsonLog("warn", { evt: "instagram_link_phone_refused", requestId, unitId, code: pgCode(error) });
              return { ok: false, reason: "unavailable" };
            }
            return { ok: true, customer: { id: resolved.id, phone: canonicalBrPhone(resolved.phone) } };
          } catch (err) {
            jsonLog("warn", {
              evt: "instagram_link_phone_failed",
              requestId,
              unitId,
              errorClass: err instanceof Error ? err.name : typeof err,
              code: pgCode(err),
            });
            return { ok: false, reason: "unavailable" };
          }
        },
      };

      const ctx: ChannelContext = {
        channel: "instagram",
        // Tenant da conta e da unidade lida; nunca do payload.
        unitId,
        organizationId,
        unit: buildAgentUnit(unitRow),
        conversation: conv,
        // Só `{ id, phone }` do cliente ligado: nada do cadastro privado.
        customer: customer ? { id: customer.id, phone: customer.phone } : null,
        phone: customer?.phone ?? null,
        claimedIdentity: port,
        // Remontada a cada turno: perfil do Instagram + telefone ligado hoje.
        identityLine: buildInstagramIdentityLine({
          username: contact.username,
          name: contact.name,
          linkedPhone: customer?.phone ?? null,
        }),
        formattingRules: INSTAGRAM_FORMATTING_RULES,
        channelLabel: "Instagram",
        channelRules: INSTAGRAM_CHANNEL_RULES,
        sanitize: sanitizeForInstagram,
        send,
        reservationSource: "instagram",
        appBaseUrl: APP_BASE_URL,
        channelId: account.id,
      };

      try {
        await agentTurn.run(ctx, {
          text: item.text,
          timestamp: item.timestamp,
          receivedAt,
          eventId: inboundEventId,
        });
        return "done";
      } catch (err) {
        jsonLog("error", { evt: "instagram_turn_error", requestId, eventId: row.id, err: safeErrorLabel(err) });
        // Ordem do contrato (agente-ia.md): liquida, solta o lock, e só então
        // completa a mensagem / fecha o evento.
        try {
          await settleTurnBudget("RELEASED");
        } catch {
          // settle não lança por contrato; defesa
        }
        await releaseAiLock();
        if (!externalSideEffect) {
          // Nada saiu: libera o claim (depois de soltar o lock) e o evento tenta
          // de novo.
          await releaseClaim();
          retryReason = "turn_error_before_side_effect";
          return "retry";
        }
        await finish("webhook_error", safeErrorLabel(err));
        return "done";
      }
    } catch (err) {
      if (err instanceof RetryableItemError && !externalSideEffect) {
        await releaseClaim();
        throw err;
      }
      jsonLog("error", { evt: "instagram_message_error", requestId, eventId: row.id, err: safeErrorLabel(err) });
      if (!externalSideEffect) {
        await releaseClaim();
        retryReason = "message_error_before_side_effect";
        return "retry";
      }
      await finish("webhook_error", safeErrorLabel(err));
      return "done";
    }
  }

  return { processItem, lastRetryReason: () => retryReason };
}

// ─── Varredura ──────────────────────────────────────────────────────────────

async function runSweep(): Promise<Response> {
  const startedAt = Date.now();
  const { data, error } = await supabase.rpc("select_due_instagram_inbound_events", { p_limit: SWEEP_SELECT_LIMIT });
  if (error) {
    jsonLog("error", { evt: "instagram_sweep_select_failed", code: pgCode(error) });
    return json(500, { error: "sweep_select_failed" });
  }
  const { ids, descartados } = parseSelectedEventIds(data);
  if (descartados > 0) jsonLog("error", { evt: "instagram_sweep_select_shape_unexpected", descartados, reconhecidos: ids.length });
  let processed = 0;
  for (const id of ids) {
    if (!sweepShouldStartAnother({ startedAt, now: Date.now(), processed })) break;
    await processEventById(id);
    processed++;
  }
  jsonLog("info", { evt: "instagram_sweep_processed", selected: ids.length, processed, skipped: ids.length - processed, duration_ms: Date.now() - startedAt });
  return json(200, { selected: ids.length, processed, skipped: ids.length - processed });
}

serve(async (req: Request): Promise<Response> => {
  // Primeira instrução: o kick e o cron mandam só `x-internal-key`.
  if (!requireInternalAuth(req)) {
    jsonLog("warn", { evt: "instagram_inbound_unauthorized" });
    return json(401, { error: "unauthorized" });
  }
  try {
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    const url = new URL(req.url);
    // A varredura não aceita payload: lê só a tabela.
    if (url.searchParams.get("sweep") === "1") return await runSweep();

    let eventId: unknown = null;
    try {
      eventId = ((await req.json()) as { event_id?: unknown } | null)?.event_id;
    } catch {
      eventId = null;
    }
    if (typeof eventId !== "string" || !UUID_RE.test(eventId)) return json(400, { error: "invalid_event_id" });
    const outcome = await processEventById(eventId);
    return json(outcome === "claim_failed" ? 503 : 200, { outcome });
  } catch (err) {
    jsonLog("error", { evt: "instagram_inbound_unhandled", err: safeErrorLabel(err) });
    return json(500, { error: "internal_error" });
  }
});
