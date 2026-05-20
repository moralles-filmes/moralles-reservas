import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  runAgentLoop,
  resolveModel,
  estimateCostUsd,
  type AIProvider,
  type AgentTool,
} from "../_shared/ai-providers.ts";
import {
  parseInbound,
  peekInboundMedia,
  sendOutbound,
  validateChannelSecret,
  validateMetaSignature,
  type WhatsAppProvider,
  type ChannelCredentials,
  type InboundMediaKind,
} from "../_shared/whatsapp-providers.ts";
import { sanitizeForWhatsApp } from "../_shared/whatsapp-format.ts";
import {
  genRequestId,
  jsonLog,
  sanitizePhone,
} from "../_shared/security.ts";
import {
  checkAvailability as checkAvailabilityCore,
  reserveSlot,
} from "../_shared/availability.ts";
import { resolveOrCreateCustomer } from "../_shared/resolve-customer.ts";
import {
  DEFAULT_GIFTBACK_TEMPLATE,
  ensureUniqueVoucherCode,
  expiresAtEndOfDayBrt,
  formatExpiryBR,
  renderGiftbackTemplate,
} from "../_shared/giftback.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Resolve a chave de API: BYOK por unidade no banco.
// Sem fallback global da plataforma (removido em 2026-05-20). Razão: secrets
// globais (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...) compartilhados entre units
// faziam parecer "vazamento de chave entre lojas" e bagunçavam cobrança por
// tenant. Sem chave própria = throw → handoff humano automático no catch do
// caller.
async function resolveApiKey(provider: AIProvider, unitId: string): Promise<string> {
  const { data } = await supabase
    .from("ai_provider_credentials")
    .select("api_key")
    .eq("unit_id", unitId)
    .eq("provider", provider)
    .eq("active", true)
    .maybeSingle();

  if (data?.api_key) return data.api_key;

  throw new Error(`api_key_not_configured:${provider}`);
}

// ─── Agent tools ──────────────────────────────────────────────────────────────

const agentTools: AgentTool[] = [
  {
    name: "check_availability",
    description: "Verifica disponibilidade de mesas. Se o restaurante tem múltiplos salões e o cliente especificou um (ex: 'área externa', 'salão principal'), passe em hall_name; senão deixa em branco que o sistema busca em todos os salões ativos.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Data no formato YYYY-MM-DD" },
        time: { type: "string", description: "Horário no formato HH:MM" },
        party_size: { type: "number", description: "Número de pessoas" },
        hall_name: { type: "string", description: "Opcional: nome do salão preferido (ex: 'Salão Principal', 'Área Externa')." },
      },
      required: ["date", "time", "party_size"],
    },
  },
  {
    name: "create_reservation",
    description: "Cria uma nova reserva para o cliente. Se o restaurante tem múltiplos salões ativos e o cliente não escolheu, pergunte antes de chamar.",
    parameters: {
      type: "object",
      properties: {
        customer_name: { type: "string", description: "Nome completo do cliente" },
        customer_email: { type: "string", description: "E-mail do cliente (opcional)" },
        date: { type: "string", description: "Data YYYY-MM-DD" },
        time: { type: "string", description: "Horário HH:MM" },
        party_size: { type: "number", description: "Número de pessoas" },
        notes: { type: "string", description: "Observações opcionais" },
        hall_name: { type: "string", description: "Opcional: nome do salão preferido." },
      },
      required: ["customer_name", "date", "time", "party_size"],
    },
  },
  {
    name: "get_reservation",
    description: "Busca uma reserva pelo código ou pelo telefone do cliente (última reserva ativa).",
    parameters: {
      type: "object",
      properties: {
        reservation_code: { type: "string", description: "Código da reserva" },
        phone: { type: "string", description: "Telefone do cliente" },
      },
    },
  },
  {
    name: "update_reservation",
    description: "Altera data, horário ou número de pessoas de uma reserva existente.",
    parameters: {
      type: "object",
      properties: {
        reservation_code: { type: "string" },
        date: { type: "string" },
        time: { type: "string" },
        party_size: { type: "number" },
        notes: { type: "string" },
      },
      required: ["reservation_code"],
    },
  },
  {
    name: "cancel_reservation",
    description: "Cancela uma reserva existente.",
    parameters: {
      type: "object",
      properties: { reservation_code: { type: "string" } },
      required: ["reservation_code"],
    },
  },
  {
    name: "list_customer_reservations",
    description: "Lista as reservas ativas (pending/confirmed) do cliente.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "request_human_handoff",
    description: "Use quando o pedido do cliente não puder ser resolvido pelas ferramentas disponíveis (reclamações, eventos especiais, delivery, assuntos que exigem julgamento humano). Transfere a conversa para um atendente humano.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Motivo breve da transferência (ex: 'cliente quer reclamar sobre atendimento')" },
      },
      required: ["reason"],
    },
  },
];

// ─── Tool implementations (all unit-scoped) ───────────────────────────────────

async function resolveHallId(unitId: string, hallName?: string): Promise<string | undefined> {
  if (!hallName?.trim()) return undefined;
  const { data } = await supabase
    .from("halls")
    .select("id")
    .eq("unit_id", unitId)
    .eq("active", true)
    .ilike("name", `%${hallName.trim()}%`)
    .limit(1)
    .maybeSingle();
  return data?.id ?? undefined;
}

// deno-lint-ignore no-explicit-any
async function checkAvailability(date: string, time: string, partySize: number, unitId: string, hallName?: string): Promise<any> {
  const hallId = await resolveHallId(unitId, hallName);
  const result = await checkAvailabilityCore(supabase, { unitId, hallId, date, time, partySize });
  if (!result.available) {
    return { available: false, reason: result.reason, message: result.message };
  }
  return { available: true, message: result.message };
}

async function createReservation(params: {
  customer_name: string;
  customer_email?: string;
  date: string;
  time: string;
  party_size: number;
  notes?: string;
  hall_name?: string;
  phone: string;
  unit_id: string;
  organization_id: string;
// deno-lint-ignore no-explicit-any
}): Promise<any> {
  // Resolve customer com merge preservando dados:
  //   - lookup por (organization_id, phone)
  //   - se existe: PRESERVA nome cadastrado, append em emails[]
  //   - se não existe: cria
  let customer;
  try {
    customer = await resolveOrCreateCustomer(supabase, {
      organizationId: params.organization_id,
      phone: params.phone,
      name: params.customer_name,
      email: params.customer_email ?? null,
    });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  const hallId = await resolveHallId(params.unit_id, params.hall_name);
  const result = await reserveSlot(supabase, {
    unitId: params.unit_id,
    hallId,
    date: params.date,
    time: params.time,
    partySize: params.party_size,
    customerId: customer.id,
    notes: params.notes ?? null,
    status: "confirmed",
    source: "whatsapp",
  });

  if (!result.success) {
    return { success: false, reason: result.reason, message: result.message };
  }

  const [y, m, d] = params.date.split("-");
  return {
    success: true,
    reservation_code: result.reservationCode,
    message: `Reserva criada! Código: #${result.reservationCode}. Data: ${d}/${m}/${y} às ${params.time} para ${params.party_size} pessoas.`,
  };
}

// deno-lint-ignore no-explicit-any
async function getReservation(params: { reservation_code?: string; phone?: string }, unitId: string): Promise<any> {
  let query = supabase
    .from("reservations")
    .select("*, customer:customers(*)")
    .eq("unit_id", unitId)
    .in("status", ["confirmed", "pending"]);

  if (params.reservation_code) {
    query = query.eq("reservation_code", params.reservation_code.toUpperCase());
  } else if (params.phone) {
    const { data: customer } = await supabase
      .from("customers")
      .select("id")
      .eq("phone", params.phone.replace(/\D/g, ""))
      .maybeSingle();
    if (!customer) return { found: false, message: "Nenhuma reserva encontrada." };
    query = query.eq("customer_id", customer.id).order("created_at", { ascending: false }).limit(1);
  } else {
    return { found: false, message: "Informe o código ou o telefone." };
  }

  const { data } = await query.maybeSingle();
  if (!data) return { found: false, message: "Reserva não encontrada ou já cancelada." };
  const [y, m, d] = data.date.split("-");
  return { found: true, reservation_code: data.reservation_code, date: `${d}/${m}/${y}`, time: data.time, party_size: data.party_size, status: data.status, notes: data.notes };
}

// deno-lint-ignore no-explicit-any
async function updateReservation(params: { reservation_code: string; date?: string; time?: string; party_size?: number; notes?: string }): Promise<any> {
  const updates: Record<string, unknown> = {};
  if (params.date) updates.date = params.date;
  if (params.time) updates.time = params.time;
  if (params.party_size) updates.party_size = params.party_size;
  if (params.notes !== undefined) updates.notes = params.notes;
  if (!Object.keys(updates).length) return { success: false, message: "Nenhuma alteração informada." };

  const { error } = await supabase
    .from("reservations")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("reservation_code", params.reservation_code.toUpperCase());

  if (error) return { success: false, error: error.message };
  return { success: true, message: "Reserva atualizada com sucesso!" };
}

// deno-lint-ignore no-explicit-any
async function cancelReservation(code: string): Promise<any> {
  const { error } = await supabase
    .from("reservations")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("reservation_code", code.toUpperCase())
    .in("status", ["confirmed", "pending"]);

  if (error) return { success: false, error: error.message };
  return { success: true, message: `Reserva #${code} cancelada.` };
}

// deno-lint-ignore no-explicit-any
async function listCustomerReservations(customerId: string, unitId: string): Promise<any> {
  const { data } = await supabase
    .from("reservations")
    .select("reservation_code, date, time, party_size, status, notes")
    .eq("customer_id", customerId)
    .eq("unit_id", unitId)
    .in("status", ["pending", "confirmed"])
    .gte("date", new Date().toISOString().slice(0, 10))
    .order("date", { ascending: true })
    .limit(10);

  if (!data || data.length === 0) return { found: false, message: "Você não tem reservas ativas no momento." };
  return {
    found: true,
    count: data.length,
    reservations: data.map((r) => { const [y, m, d] = r.date.split("-"); return { reservation_code: r.reservation_code, date: `${d}/${m}/${y}`, time: r.time, party_size: r.party_size, status: r.status, notes: r.notes }; }),
  };
}

// ─── Conversation helpers ──────────────────────────────────────────────────────

async function getOrCreateConversation(customerId: string, unitId: string, contactName?: string) {
  const { data } = await supabase
    .from("conversations")
    .select("*")
    .eq("customer_id", customerId)
    .eq("unit_id", unitId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (data) {
    if (contactName && data.contact_name !== contactName) {
      await supabase
        .from("conversations")
        .update({ contact_name: contactName })
        .eq("id", data.id);
      data.contact_name = contactName;
    }
    return data;
  }

  const { data: newConv } = await supabase
    .from("conversations")
    .insert({ customer_id: customerId, unit_id: unitId, messages: [], contact_name: contactName ?? null })
    .select()
    .single();
  return newConv;
}

// deno-lint-ignore no-explicit-any
async function appendToConversation(convId: string, existing: any[], role: "user" | "assistant", content: string) {
  // Append atômico via RPC (single UPDATE com `messages || jsonb_build_array(msg)`):
  // evita perda quando dois processos appendam simultaneamente (inbound + worker).
  // O array retornado é uma "previsão local" mantida pra compat com callers que
  // encadeiam appendToConversation (ex.: comment intercept → user + assistant).
  const newMsg = { role, content, timestamp: new Date().toISOString() };
  const { error } = await supabase.rpc("append_conversation_message", {
    p_conversation_id: convId,
    p_message: newMsg,
  });
  if (error) {
    jsonLog("warn", { evt: "append_conversation_message_failed", convId, err: error.message });
  }
  return [...existing, newMsg];
}

function mediaPlaceholder(kind: InboundMediaKind): string {
  switch (kind) {
    case "audio": return "[áudio]";
    case "image": return "[imagem]";
    case "video": return "[vídeo]";
    case "document": return "[documento]";
    case "sticker": return "[figurinha]";
    case "location": return "[localização]";
    case "contacts": return "[contato]";
    default: return "[mídia]";
  }
}

const MEDIA_REPLY_TEXT = "Por aqui só consigo ler texto. Pode me escrever a informação que precisa? Se quiser falar com a equipe, é só pedir.";

// ─── Tool log helpers ──────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
function summarizeToolInput(input: any): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of ["date", "time", "party_size", "reservation_code", "reason"]) {
    if (input[k] !== undefined) out[k] = input[k];
  }
  if (input.customer_name) out.customer_name = "***";
  return out;
}

// deno-lint-ignore no-explicit-any
function summarizeToolResult(result: any): Record<string, unknown> {
  if (!result || typeof result !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of ["available", "success", "found", "ok", "reason", "reservation_code", "count"]) {
    if (result[k] !== undefined) out[k] = result[k];
  }
  if (result.error) out.error = String(result.error).slice(0, 200);
  return out;
}

// ─── Telemetry helpers (idempotência + webhook_executions) ────────────────────

const STUCK_PROCESSING_TIMEOUT_MS = 90_000;
const HANDOFF_AUTO_RESOLVE_MS = 12 * 60 * 60 * 1000;       // 12h
const HANDOFF_REMINDER_THROTTLE_MS = 6 * 60 * 60 * 1000;   // 6h

// Marca o ciclo de vida da mensagem em processed_messages.
async function markProcessed(messageId: string, outcome: string, error?: string): Promise<void> {
  try {
    await supabase
      .from("processed_messages")
      .update({
        completed_at: new Date().toISOString(),
        outcome,
        error: error ?? null,
      })
      .eq("message_id", messageId);
  } catch (e) {
    jsonLog("error", { evt: "mark_processed_failed", messageId, err: String(e) });
  }
}

// Insere uma linha em webhook_executions — best-effort, nunca lança.
async function recordExecution(payload: {
  request_id: string;
  unit_id: string | null;
  channel_id: string | null;
  phone_hash: string | null;
  outcome: string;
  error?: string | null;
  duration_ms: number;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    await supabase.from("webhook_executions").insert({
      request_id: payload.request_id,
      unit_id: payload.unit_id,
      channel_id: payload.channel_id,
      phone_hash: payload.phone_hash,
      outcome: payload.outcome,
      error: payload.error ?? null,
      duration_ms: payload.duration_ms,
      meta: payload.meta ?? {},
    });
  } catch (e) {
    jsonLog("error", { evt: "record_execution_failed", err: String(e) });
  }
}

// ─── Giftback helper ──────────────────────────────────────────────────────────

/**
 * Resolve a regra e código de voucher candidato, mas NÃO persiste ainda.
 * Retorna null quando: WhatsApp desabilitado pra unit, sem regra ativa
 * compatível com a nota, ou já existe voucher ativo (rule, customer).
 *
 * Caller chama `commitGiftbackVoucher` depois do send confirmado.
 */
// deno-lint-ignore no-explicit-any
async function prepareGiftbackVoucher(args: {
  supabase: any;
  unitId: string;
  customerId: string;
  rating: number;
}): Promise<
  | {
      ruleId: string;
      discountPercent: number;
      validityDays: number;
      code: string;
      expiresAtIso: string;
      text: string;
      template: string;
      unitName: string;
    }
  | null
> {
  const { supabase, unitId, customerId, rating } = args;

  // Settings: WhatsApp ligado? Template?
  const { data: settingsRows } = await supabase
    .from("settings")
    .select("key, value")
    .eq("unit_id", unitId)
    .in("key", ["giftback_whatsapp_enabled", "giftback_message_template"]);
  // deno-lint-ignore no-explicit-any
  const settings = Object.fromEntries((settingsRows ?? []).map((r: any) => [r.key, r.value]));
  const whatsappEnabled =
    settings.giftback_whatsapp_enabled === false ||
    settings.giftback_whatsapp_enabled === "false"
      ? false
      : true;
  if (!whatsappEnabled) return null;
  const template: string =
    typeof settings.giftback_message_template === "string" && settings.giftback_message_template
      ? settings.giftback_message_template
      : DEFAULT_GIFTBACK_TEMPLATE;

  // Regra ativa after_rating compatível com a nota.
  // min_rating é NOT NULL via CHECK quando trigger_type='after_rating' (migration
  // 20260517110000), então não testamos IS NULL aqui.
  const { data: rule } = await supabase
    .from("voucher_rules")
    .select("id, discount_percent, validity_days, min_rating")
    .eq("unit_id", unitId)
    .eq("trigger_type", "after_rating")
    .eq("active", true)
    .lte("min_rating", rating)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!rule) return null;

  // Já existe voucher ativo (rule, customer)? Constraint
  // vouchers_unit_rule_customer_active_idx também protege via 23505 no insert,
  // mas o check explícito evita gerar mensagem que nunca vai ser persistida.
  const { data: existing } = await supabase
    .from("vouchers")
    .select("id")
    .eq("unit_id", unitId)
    .eq("customer_id", customerId)
    .eq("rule_id", rule.id)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (existing) return null;

  const code = await ensureUniqueVoucherCode(supabase);
  const expiresAtIso = expiresAtEndOfDayBrt(rule.validity_days as number);

  const { data: unitRow } = await supabase
    .from("units")
    .select("name")
    .eq("id", unitId)
    .maybeSingle();
  const unitName = (unitRow?.name as string) ?? "nosso restaurante";

  const text = renderGiftbackTemplate(template, {
    discount: rule.discount_percent as number,
    unidade: unitName,
    codigo: code,
    validade: formatExpiryBR(expiresAtIso),
  });

  return {
    ruleId: rule.id as string,
    discountPercent: rule.discount_percent as number,
    validityDays: rule.validity_days as number,
    code,
    expiresAtIso,
    text,
    template,
    unitName,
  };
}

/**
 * Persiste o voucher e a notification após confirmação de envio.
 * `sendOk` reflete o resultado real do WhatsApp — `notifications_sent.status`
 * é gravado fiel (sent/failed). Voucher só é inserido quando `sendOk=true`
 * pra evitar voucher fantasma quando o envio falha.
 */
async function commitGiftbackVoucher(args: {
  // deno-lint-ignore no-explicit-any
  supabase: any;
  unitId: string;
  customerId: string;
  prepared: NonNullable<Awaited<ReturnType<typeof prepareGiftbackVoucher>>>;
  sendOk: boolean;
  sendError?: string | null;
  reservationId: string | null;
  requestId: string;
}): Promise<void> {
  const { supabase, unitId, customerId, prepared, sendOk, sendError, reservationId, requestId } = args;

  if (sendOk) {
    const { error: insertErr } = await supabase
      .from("vouchers")
      .insert({
        unit_id: unitId,
        rule_id: prepared.ruleId,
        customer_id: customerId,
        code: prepared.code,
        discount_percent: prepared.discountPercent,
        expires_at: prepared.expiresAtIso,
      });

    if (insertErr) {
      // 23505 = UNIQUE violation. Outro handler em paralelo já inseriu
      // (B4 — race em reprocessing_stuck_message). Tratamos como dedupe.
      const isDuplicate = String(insertErr.code ?? "") === "23505";
      jsonLog(isDuplicate ? "info" : "warn", {
        requestId,
        evt: isDuplicate ? "voucher_dedup_race" : "voucher_insert_failed",
        error: insertErr.message,
      });
      if (!isDuplicate) {
        // Cliente já recebeu a mensagem com o code mas nada está persistido.
        // Caso raríssimo. Loga pra investigação manual.
        return;
      }
    } else {
      jsonLog("info", { requestId, evt: "voucher_issued", code: prepared.code });
    }
  }

  await supabase.from("notifications_sent").insert({
    unit_id: unitId,
    kind: "voucher_issued",
    status: sendOk ? "sent" : "failed",
    sent_at: new Date().toISOString(),
    reservation_id: reservationId ?? null,
    error: sendOk ? null : (sendError ?? "send_failed"),
  });
}

// ─── Main handler ──────────────────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX = 10;

serve(async (req) => {
  const requestId = genRequestId();
  const t0 = Date.now();

  // Estado mutável que vamos completar conforme avançamos no handler — usado
  // pelo finalizador (recordExecution) para registrar a execução de forma
  // consistente, mesmo em early returns.
  let unitId: string | null = null;
  let channelId: string | null = null;
  let phoneHash: string | null = null;
  let messageIdForOutcome: string | null = null;

  // Helper local que finaliza a execução (grava processed_messages.outcome
  // se já houver message_id, e registra webhook_executions). Nunca lança.
  const finish = async (outcome: string, error?: string, meta?: Record<string, unknown>) => {
    const duration_ms = Date.now() - t0;
    if (messageIdForOutcome) {
      await markProcessed(messageIdForOutcome, outcome, error);
    }
    await recordExecution({
      request_id: requestId,
      unit_id: unitId,
      channel_id: channelId,
      phone_hash: phoneHash,
      outcome,
      error: error ?? null,
      duration_ms,
      meta,
    });
  };

  try {
    const url = new URL(req.url);
    channelId = url.searchParams.get("channel");

    if (!channelId) {
      jsonLog("warn", { requestId, evt: "missing_channel_param" });
      await finish("missing_channel_param");
      return new Response("missing channel", { status: 400 });
    }

    // Resolve channel → unit_id, provider, credentials, webhook_secret
    const { data: channel, error: channelErr } = await supabase
      .from("whatsapp_channels")
      .select("id, unit_id, provider, credentials, webhook_secret, status")
      .eq("id", channelId)
      .maybeSingle();

    if (channelErr || !channel) {
      jsonLog("warn", { requestId, evt: "channel_not_found", channelId });
      await finish("channel_not_found", channelErr?.message);
      return new Response("channel not found", { status: 404 });
    }

    unitId = channel.unit_id;
    const provider: WhatsAppProvider = channel.provider;
    const credentials: ChannelCredentials = channel.credentials ?? {};

    // Lê o body como texto antes do parse — para Meta a validação HMAC precisa
    // do body cru (JSON.stringify de volta não preserva whitespace/ordering e
    // quebra a assinatura).
    const bodyText = await req.text();

    // Validate por provider:
    //  - Meta Cloud API: HMAC-SHA256 do body com app_secret (header x-hub-signature-256)
    //  - Z-API / WAHA: secret per-channel (header x-webhook-secret OU query ?secret=)
    let isValid = false;
    if (provider === "official") {
      isValid = await validateMetaSignature(req, bodyText, credentials.app_secret ?? "");
    } else {
      const secret = channel.webhook_secret ?? Deno.env.get("ZAPI_WEBHOOK_SECRET") ?? "";
      isValid = validateChannelSecret(req, secret);
    }

    if (!isValid) {
      jsonLog("warn", { requestId, evt: "webhook_unauthorized", channelId, provider });
      await finish("webhook_unauthorized");
      return new Response("unauthorized", { status: 401 });
    }

    let payload: unknown;
    try {
      payload = bodyText ? JSON.parse(bodyText) : {};
    } catch (e) {
      jsonLog("warn", { requestId, evt: "webhook_invalid_json", channelId, err: String(e) });
      await finish("invalid_json", String(e));
      return new Response("invalid json", { status: 400 });
    }

    // Parse inbound message using provider-specific adapter
    const inbound = parseInbound(provider, payload);
    if (!inbound) {
      // Não é texto. Antes silenciávamos — agora detectamos áudio/foto/sticker/etc
      // e respondemos uma vez pedindo texto, pra cliente não ficar achando que
      // mandou pro vazio. O fluxo de LLM/tools NÃO roda nesse path.
      const media = peekInboundMedia(provider, payload);
      if (!media) {
        await finish("ignored_non_text");
        return new Response("ok");
      }

      const mediaPhone = media.fromPhone;
      phoneHash = sanitizePhone(mediaPhone);
      messageIdForOutcome = media.providerMessageId;

      // Idempotência: se a mensagem já foi processada, não responde de novo.
      const { error: idemErr } = await supabase
        .from("processed_messages")
        .insert({ message_id: media.providerMessageId, unit_id: unitId, started_at: new Date().toISOString() });
      if (idemErr) {
        messageIdForOutcome = null;
        await finish("duplicate_media");
        return new Response("ok");
      }

      // Resolve org → customer → conversation (mesmo padrão do path de texto).
      const { data: unitRow2 } = await supabase
        .from("units")
        .select("organization_id")
        .eq("id", unitId)
        .maybeSingle();
      const orgId2: string = unitRow2?.organization_id ?? "";

      // deno-lint-ignore no-explicit-any
      let mediaCustomer: any = null;
      if (orgId2) {
        const { data: existing } = await supabase
          .from("customers")
          .select("*")
          .eq("organization_id", orgId2)
          .eq("phone", mediaPhone)
          .maybeSingle();
        if (existing) {
          mediaCustomer = existing;
        } else {
          const { data: inserted } = await supabase
            .from("customers")
            .insert({ phone: mediaPhone, name: media.contactName ?? mediaPhone, organization_id: orgId2 })
            .select("*")
            .single();
          mediaCustomer = inserted;
        }
      }

      const userPlaceholder = mediaPlaceholder(media.mediaKind);
      // deno-lint-ignore no-explicit-any
      let mediaConv: any = null;
      if (mediaCustomer && unitId) {
        mediaConv = await getOrCreateConversation(mediaCustomer.id, unitId, media.contactName);
        if (mediaConv) {
          await appendToConversation(mediaConv.id, mediaConv.messages || [], "user", userPlaceholder);
        }
      }

      // Conversa em handoff humano? Não responde — atendente assume.
      if (mediaConv && (mediaConv.status === "human_active" || mediaConv.status === "awaiting_human")) {
        jsonLog("info", { requestId, evt: "media_during_handoff", mediaKind: media.mediaKind, phone: phoneHash });
        await finish("media_during_handoff", null, { mediaKind: media.mediaKind });
        return new Response("ok");
      }

      const sendRes = await sendOutbound(provider, credentials, { toPhone: mediaPhone, text: MEDIA_REPLY_TEXT });
      if (sendRes.ok && mediaConv) {
        await appendToConversation(
          mediaConv.id,
          [...(mediaConv.messages || []), { role: "user", content: userPlaceholder }],
          "assistant",
          MEDIA_REPLY_TEXT,
        );
      }
      jsonLog("info", { requestId, evt: "media_response", mediaKind: media.mediaKind, sent: sendRes.ok });
      await finish(
        sendRes.ok ? "media_response" : "send_error",
        sendRes.ok ? undefined : (sendRes.error ?? `status_${sendRes.status}`),
        { mediaKind: media.mediaKind },
      );
      return new Response("ok");
    }

    const phone = inbound.fromPhone;
    const incomingText = inbound.text;
    phoneHash = sanitizePhone(phone);

    // Receber webhook é sinal de saúde — sempre marca como connected.
    if (channel.status !== "connected") {
      jsonLog("info", { requestId, evt: "channel_recovered", channelId, prevStatus: channel.status });
    }
    await supabase
      .from("whatsapp_channels")
      .update({ last_event_at: new Date().toISOString(), status: "connected", last_error: null })
      .eq("id", channelId);

    // ─── Idempotência segura ──────────────────────────────────────────────────
    // Antes: INSERT do message_id era cego (qualquer falha posterior deixava
    // a mensagem "marcada como processada" sem ter respondido).
    // Agora: se o INSERT falha (já existe), checamos se está "presa"
    // (started_at antigo + completed_at NULL) e, se sim, reprocessamos.
    messageIdForOutcome = inbound.providerMessageId;

    const { error: idemError } = await supabase
      .from("processed_messages")
      .insert({ message_id: inbound.providerMessageId, unit_id: unitId, started_at: new Date().toISOString() });

    if (idemError) {
      const { data: existing } = await supabase
        .from("processed_messages")
        .select("started_at, completed_at, outcome")
        .eq("message_id", inbound.providerMessageId)
        .maybeSingle();

      const isStuck = !!existing
        && !existing.completed_at
        && (Date.now() - new Date(existing.started_at).getTime()) > STUCK_PROCESSING_TIMEOUT_MS;

      if (!isStuck) {
        jsonLog("info", {
          requestId,
          evt: "duplicate_message",
          phone: phoneHash,
          prev_outcome: existing?.outcome ?? null,
        });
        await recordExecution({
          request_id: requestId,
          unit_id: unitId,
          channel_id: channelId,
          phone_hash: phoneHash,
          outcome: "duplicate",
          error: null,
          duration_ms: Date.now() - t0,
          meta: { prev_outcome: existing?.outcome ?? null },
        });
        // Não chama markProcessed (já estava completed_at correto).
        messageIdForOutcome = null;
        return new Response("ok");
      }

      // Take over the stuck record
      await supabase
        .from("processed_messages")
        .update({
          started_at: new Date().toISOString(),
          completed_at: null,
          outcome: null,
          error: null,
          unit_id: unitId,
        })
        .eq("message_id", inbound.providerMessageId);

      jsonLog("warn", {
        requestId,
        evt: "reprocessing_stuck_message",
        message_id: inbound.providerMessageId,
        prev_outcome: existing?.outcome ?? null,
      });
    }

    // Rate limit por telefone (sliding window, por unidade)
    const { data: allowed } = await supabase.rpc("check_rate_limit", {
      p_phone: phone,
      p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
      p_max: RATE_LIMIT_MAX,
      p_unit_id: unitId,
    });
    if (allowed === false) {
      jsonLog("warn", { requestId, evt: "rate_limited", phone: phoneHash });
      await finish("rate_limited");
      return new Response("ok");
    }

    // Load organization_id + address for the unit
    const { data: unitRow } = await supabase
      .from("units")
      .select("organization_id, address")
      .eq("id", unitId)
      .maybeSingle();
    const organizationId: string = unitRow?.organization_id ?? "";
    const unitAddress: string = unitRow?.address ?? "";

    // Upsert customer (org-scoped). Preserva nome real cadastrado via reserva;
    // só preenche/atualiza quando o customer é novo ou ainda tem placeholder
    // (name == phone). Push_name do WhatsApp entra como matéria-prima quando
    // disponível — caso contrário, mantém fallback histórico (name == phone).
    const contactName = inbound.contactName;
    // deno-lint-ignore no-explicit-any
    let customer: any = null;
    {
      const { data: existing } = await supabase
        .from("customers")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("phone", phone)
        .maybeSingle();

      if (existing) {
        customer = existing;
        if (contactName && (!existing.name || existing.name === existing.phone)) {
          const { data: updated } = await supabase
            .from("customers")
            .update({ name: contactName })
            .eq("id", existing.id)
            .select("*")
            .single();
          if (updated) customer = updated;
        }
      } else {
        const { data: inserted } = await supabase
          .from("customers")
          .insert({ phone, name: contactName ?? phone, organization_id: organizationId })
          .select("*")
          .single();
        if (inserted) customer = inserted;
      }
    }

    if (!customer) {
      await finish("customer_upsert_failed");
      return new Response("error", { status: 500 });
    }

    // Survey comment intercept — janela de 30 min após gravar nota.
    // Se o cliente avaliou recentemente e ainda não comentou, qualquer texto
    // livre vira comentário. A mensagem do rating intercept avisa o cliente.
    const commentCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: pendingComment } = await supabase
      .from("reservations")
      .select("id")
      .eq("unit_id", unitId)
      .eq("customer_id", customer.id)
      .gt("satisfaction_at", commentCutoff)
      .is("satisfaction_comment", null)
      .not("satisfaction_rating", "is", null)
      .order("satisfaction_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (pendingComment) {
      await supabase
        .from("reservations")
        .update({ satisfaction_comment: incomingText })
        .eq("id", pendingComment.id);

      const replyText = "Comentário registrado. Obrigado! 🙏";
      const sendRes = await sendOutbound(provider, credentials, { toPhone: phone, text: replyText });

      // B2/B3: appenda incoming + outgoing na conversation pra operador ver
      // o ciclo completo da pesquisa de satisfação na timeline.
      const commentConv = await getOrCreateConversation(customer.id, unitId, contactName);
      const afterUser = await appendToConversation(commentConv.id, commentConv.messages || [], "user", incomingText);
      if (sendRes.ok) {
        await appendToConversation(commentConv.id, afterUser, "assistant", replyText);
      }

      jsonLog("info", { requestId, evt: "survey_comment_captured", phone: phoneHash, sent: sendRes.ok });
      await finish(sendRes.ok ? "survey_comment" : "send_error", sendRes.ok ? undefined : (sendRes.error ?? `status_${sendRes.status}`));
      return new Response("ok");
    }

    // Survey response intercept
    const ratingMatch = /^([1-5])$/.exec(incomingText);
    if (ratingMatch) {
      const rating = parseInt(ratingMatch[1], 10);
      const cutoff = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();

      const { data: pending } = await supabase
        .from("notifications_sent")
        .select("reservation_id, reservations!inner(customer_id, satisfaction_rating)")
        .eq("kind", "survey_d1")
        .eq("status", "sent")
        .gt("sent_at", cutoff)
        .eq("reservations.customer_id", customer.id)
        .is("reservations.satisfaction_rating", null)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (pending) {
        await supabase
          .from("reservations")
          .update({ satisfaction_rating: rating, satisfaction_at: new Date().toISOString() })
          .eq("id", pending.reservation_id);

        // Prepara voucher SEM persistir — code e texto montados, banco intocado.
        // Commit acontece DEPOIS do send pra evitar voucher fantasma (B3).
        const prepared = unitId
          ? await prepareGiftbackVoucher({
              supabase,
              unitId,
              customerId: customer.id,
              rating,
            })
          : null;

        const baseText = "Obrigado pelo feedback! 🙏";
        const tailText = "Se quiser comentar (sugestão, sua experiência), responda agora — sua próxima mensagem vira comentário.";
        const fullText = prepared
          ? `${baseText}\n\n${prepared.text}\n\n${tailText}`
          : `${baseText} ${tailText}`;

        const sendRes = await sendOutbound(provider, credentials, { toPhone: phone, text: fullText });

        // Persiste voucher (se houve) + notifications_sent com status REAL (B1).
        if (prepared && unitId) {
          await commitGiftbackVoucher({
            supabase,
            unitId,
            customerId: customer.id,
            prepared,
            sendOk: sendRes.ok,
            sendError: sendRes.ok ? null : (sendRes.error ?? `status_${sendRes.status}`),
            reservationId: pending.reservation_id ?? null,
            requestId,
          });
        }

        // B2: appenda incoming "5" + outgoing na conversation pra timeline ficar completa.
        if (sendRes.ok && unitId) {
          const ratingConv = await getOrCreateConversation(customer.id, unitId, contactName);
          const afterUser = await appendToConversation(ratingConv.id, ratingConv.messages || [], "user", incomingText);
          await appendToConversation(ratingConv.id, afterUser, "assistant", fullText);
        }

        jsonLog("info", { requestId, evt: "survey_response_captured", rating, phone: phoneHash, sent: sendRes.ok, voucher_emitted: !!prepared && sendRes.ok });
        await finish(sendRes.ok ? "survey_response" : "send_error", sendRes.ok ? undefined : (sendRes.error ?? `status_${sendRes.status}`));
        return new Response("ok");
      }
    }

    // Load conversation history
    const conv = await getOrCreateConversation(customer.id, unitId, contactName);

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
      await appendToConversation(conv.id, conv.messages || [], "user", incomingText);

      const handoffStart = conv.handoff_at ? new Date(conv.handoff_at).getTime() : 0;
      const handoffAge = handoffStart ? Date.now() - handoffStart : 0;

      // Houve resposta humana após o handoff? (mensagens com role 'human' OU
      // 'assistant' enquanto a conv está em human/awaiting_human são
      // consideradas resposta humana — assistant aqui só entra via reply
      // manual fora do agente).
      // deno-lint-ignore no-explicit-any
      const hadHumanReply = (conv.messages ?? []).some((m: any) => {
        if (!m || m.role !== "human") return false;
        const ts = m.timestamp ? new Date(m.timestamp).getTime() : 0;
        return ts >= handoffStart;
      });

      const shouldAutoResolve = handoffStart > 0
        && handoffAge > HANDOFF_AUTO_RESOLVE_MS
        && !hadHumanReply;

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

        await sendOutbound(provider, credentials, {
          toPhone: phone,
          text: "Oi! Voltei a te atender por aqui. Em que posso ajudar?",
        });

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
          const sendRes = await sendOutbound(provider, credentials, {
            toPhone: phone,
            text: "Recebi sua mensagem! Já avisei alguém da equipe — vou te responder por aqui assim que possível. 🙏",
          });
          if (sendRes.ok) {
            await supabase
              .from("conversations")
              .update({
                last_silenced_reply_at: new Date().toISOString(),
                last_message_at: new Date().toISOString(),
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
        return new Response("ok");
      }
    }

    // Mensagens manuais do operador (send-manual-message) ficam salvas com
    // role: "human" — do ponto de vista do modelo isso é "assistant" (resposta
    // que veio do nosso lado). Sem o remap, Anthropic rejeita o request com
    // "Unexpected role 'human'".
    const history: Array<{ role: "user" | "assistant"; content: string }> = (conv.messages || [])
      // deno-lint-ignore no-explicit-any
      .filter((m: any) => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant" || m.role === "human"))
      // deno-lint-ignore no-explicit-any
      .map((m: any) => ({
        role: m.role === "human" ? ("assistant" as const) : (m.role as "user" | "assistant"),
        content: m.content,
      }));

    await appendToConversation(conv.id, conv.messages || [], "user", incomingText);

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
    // Blindagem: ignora modelo desconhecido/descontinuado salvo em settings (ex: legado
    // "gemini-2.0-flash" que o Google removeu pra contas novas → 404 silencioso).
    // resolveModel cai no DEFAULT_MODELS[provider] e marca fellBack pra logar/telemetria.
    const modelResolved = resolveModel(provider_ai, rawModel);
    const modelOverride: string = modelResolved.model;
    if (modelResolved.fellBack) {
      jsonLog("warn", {
        requestId,
        evt: "ai_model_fallback",
        provider: provider_ai,
        rejected: modelResolved.rejected,
        used: modelOverride,
        unitId,
      });
    }

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
      await sendOutbound(provider, credentials, { toPhone: phone, text: handoffText });
      await appendToConversation(
        conv.id,
        [...(conv.messages || []), { role: "user", content: incomingText }],
        "assistant",
        handoffText
      );

      await finish("ai_key_unavailable", String(err), {
        provider: provider_ai,
        channel_id: channelId,
      });
      return new Response("ok");
    }

    // Load restaurant name + system prompt (unit-scoped)
    const { data: settings } = await supabase
      .from("settings")
      .select("key, value")
      .eq("unit_id", unitId)
      .in("key", ["restaurant_name", "ai_system_prompt", "agent_mode", "restaurant_menu", "delivery_response", "restaurant_extra_info"]);

    const settingsMap = Object.fromEntries((settings || []).map((s: { key: string; value: unknown }) => [s.key, s.value]));
    const restaurantName = (settingsMap["restaurant_name"] as string) ?? "Restaurante";
    const customPrompt = (settingsMap["ai_system_prompt"] as string) ?? "";

    // Business hours (unit-scoped)
    const { data: hoursRows } = await supabase
      .from("business_hours")
      .select("day_of_week, open_time, close_time, is_closed")
      .eq("unit_id", unitId)
      .order("day_of_week");

    const dayNames = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
    const hoursLines = (hoursRows ?? []).map((h: { day_of_week: number; open_time: string; close_time: string; is_closed: boolean }) =>
      h.is_closed ? `- ${dayNames[h.day_of_week]}: fechado` : `- ${dayNames[h.day_of_week]}: ${h.open_time?.slice(0, 5)} às ${h.close_time?.slice(0, 5)}`
    );

    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: specialDates } = await supabase
      .from("special_dates")
      .select("date, name, is_closed, open_time, close_time")
      .eq("unit_id", unitId)
      .gte("date", today)
      .lte("date", horizon)
      .order("date", { ascending: true });

    const specialLines = (specialDates ?? []).map((s: { date: string; name: string; is_closed: boolean; open_time: string; close_time: string }) => {
      const [y, m, d] = s.date.split("-");
      const ymd = `${d}/${m}/${y}`;
      return s.is_closed ? `- ${ymd} (${s.name}): fechado` : `- ${ymd} (${s.name}): ${s.open_time?.slice(0, 5)} às ${s.close_time?.slice(0, 5)}`;
    });

    // table_blocks macro (table_id IS NULL) ativos no horizonte de 60 dias.
    // Sem isso o LLM responde "sim, aceitamos reservas pra dia X" sem chamar
    // check_availability pra perguntas genéricas — o bloqueio só era visto
    // quando o cliente já tinha dado data+hora+party (auditoria 2026-05-20).
    const horizonISO = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    const nowISO = new Date().toISOString();
    const { data: tableBlocks } = await supabase
      .from("table_blocks")
      .select("title, reason, hall_id, blocked_from, blocked_to")
      .eq("unit_id", unitId)
      .is("table_id", null)
      .gte("blocked_to", nowISO)
      .lte("blocked_from", horizonISO)
      .order("blocked_from", { ascending: true });

    // Hall names pra sufixar bloqueios hall-específicos
    const blockHallIds = Array.from(
      new Set(((tableBlocks ?? []) as { hall_id: string | null }[]).map((b) => b.hall_id).filter((id): id is string => !!id)),
    );
    const blockHallNameById = new Map<string, string>();
    if (blockHallIds.length > 0) {
      const { data: hallRows } = await supabase
        .from("halls")
        .select("id, name")
        .in("id", blockHallIds);
      for (const h of (hallRows ?? []) as { id: string; name: string }[]) {
        blockHallNameById.set(h.id, h.name);
      }
    }

    // BRT = UTC-3 fixo. Edge Function roda em UTC; subtraímos 3h e lemos UTC*.
    const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;
    const toBrtParts = (iso: string) => {
      const d = new Date(new Date(iso).getTime() - BRT_OFFSET_MS);
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const yyyy = d.getUTCFullYear();
      const hh = String(d.getUTCHours()).padStart(2, "0");
      const min = String(d.getUTCMinutes()).padStart(2, "0");
      return {
        ymd: `${yyyy}-${mm}-${dd}`,
        br: `${dd}/${mm}/${yyyy}`,
        time: `${hh}:${min}`,
        h: d.getUTCHours(),
        m: d.getUTCMinutes(),
      };
    };

    // IMPORTANTE: bloqueio em table_blocks = "não aceitamos reservas" naquela
    // data/horário, NÃO = "restaurante fechado". Walk-in, evento privado já
    // contratado, fila de espera, etc, podem continuar rolando. Por isso o
    // phrasing aqui evita "fechado" — é "sem reservas". `special_dates` com
    // `is_closed=true` é o canal correto pra fechamento real (formatado em
    // `specialLines` acima como "fechado").
    const blockedLines = (tableBlocks ?? []).map(
      (b: { title: string | null; reason: string | null; hall_id: string | null; blocked_from: string; blocked_to: string }) => {
        const from = toBrtParts(b.blocked_from);
        const to = toBrtParts(b.blocked_to);
        const title = b.title ?? b.reason ?? "Bloqueio";
        const hallSuffix = b.hall_id
          ? ` — só no salão ${blockHallNameById.get(b.hall_id) ?? "específico"}`
          : "";
        const sameDay = from.ymd === to.ymd;
        const allDay = from.h === 0 && from.m === 0 && to.h === 23 && to.m === 59;
        if (sameDay && allDay) return `- ${from.br} (${title}): sem reservas o dia inteiro${hallSuffix}`;
        if (sameDay) return `- ${from.br} (${title}): sem reservas das ${from.time} às ${to.time}${hallSuffix}`;
        if (allDay) return `- ${from.br} a ${to.br} (${title}): sem reservas o dia inteiro${hallSuffix}`;
        return `- ${from.br} ${from.time} a ${to.br} ${to.time} (${title}): sem reservas${hallSuffix}`;
      },
    );

    const prefsLines: string[] = [];
    if (customer.allergies) prefsLines.push(`- Alergias: ${customer.allergies}`);
    if (customer.dietary_restrictions) prefsLines.push(`- Restrições alimentares: ${customer.dietary_restrictions}`);
    if (customer.vip_notes) prefsLines.push(`- VIP: ${customer.vip_notes}`);
    if (customer.preferred_table_location) prefsLines.push(`- Mesa preferida: ${customer.preferred_table_location === "internal" ? "interna" : "externa"}`);

    const todayBR = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });

    const agentMode = (settingsMap["agent_mode"] as string) ?? "reservations";
    const includeFaq = agentMode === "reservations_faq";
    const agentHeader = includeFaq
      ? `Você é o assistente do ${restaurantName}. Atende reservas e dúvidas gerais (cardápio, horário, endereço, estacionamento). `
      : `Você é o assistente de reservas do ${restaurantName}. `;

    const systemPrompt =
      agentHeader +
      `Seja cordial, eficiente e responda sempre em português brasileiro. ` +
      `O número de WhatsApp do cliente é ${phone}. Hoje é ${todayBR}. ` +
      `Use as ferramentas disponíveis para reservas. ` +
      `Ao criar uma reserva, sempre confirme todos os detalhes antes de finalizar. ` +
      `Não invente horários, cardápio ou serviços — só use o que está documentado abaixo. ` +
      `Se o pedido fugir do escopo (reclamação, evento corporativo, delivery não suportado, qualquer coisa que as ferramentas não cobrem), use a tool 'request_human_handoff' informando o motivo. ` +
      `IMPORTANTE: ao chamar 'request_human_handoff', SEMPRE envie ao cliente uma mensagem amigável avisando que um atendente humano vai responder em breve, antes de encerrar sua resposta. Nunca silencie sem aviso.` +
      `\n\nREGRAS OBRIGATÓRIAS PARA RESERVAS:\n` +
      `1. SEMPRE chame check_availability ANTES de create_reservation. Nunca atalhe.\n` +
      `2. Se check_availability retornar available: false, NUNCA crie a reserva. Comunique ao cliente que não há mesa naquele horário e ofereça alternativas (outro horário do mesmo dia ou outra data próxima). Use o campo 'reason' para entender o motivo (closed_day, outside_hours, no_capacity, all_blocked).\n` +
      `3. Se create_reservation retornar success: false, informe o cliente o motivo — NÃO tente criar a reserva novamente sem fazer nova consulta com data/horário diferente.\n` +
      `4. Para alterar uma reserva existente (update_reservation) que mude data ou horário, chame check_availability antes para validar o novo slot.\n` +
      `5. Se o cliente perguntar sobre uma data presente na lista 'Datas bloqueadas' (abaixo), NUNCA confirme disponibilidade. Explique que naquela data NÃO ESTAMOS ACEITANDO RESERVAS pelo motivo entre parênteses (ex: evento, alta demanda, manutenção). NUNCA diga que o restaurante está "fechado" — bloqueio de reserva ≠ fechamento; o restaurante pode estar atendendo walk-in, ter evento privado, etc. Use "não estamos aceitando reservas", "agenda de reservas indisponível", ou "estamos com bloqueio de reservas". Se for bloqueio só de um salão (sufixo "— só no salão X"), ofereça reserva em OUTRO salão na mesma data. Para 'Datas especiais' marcadas como 'fechado', aí sim diga "estamos fechados" (é fechamento real). Ofereça datas próximas. NÃO chame check_availability nem create_reservation para datas dessa lista — a resposta é direta com base no contexto.` +
      `\n\nFORMATAÇÃO DA RESPOSTA NO WHATSAPP:\n` +
      `- Negrito é *um único asterisco* (ex: *importante*). NUNCA use **dois asteriscos**, ### header ou markdown — WhatsApp mostra os símbolos literais.\n` +
      `- Itálico com _texto_ entre underlines. Tachado com ~texto~.\n` +
      `- Listas SEMPRE com "- " (hífen + espaço) no começo da linha, uma por linha. NUNCA use "* " — o asterisco solto aparece literal pro cliente.\n` +
      `- Separe blocos lógicos (preços, horários, opções, observação) com UMA linha em branco. Frases e parágrafos curtos — o cliente está lendo no celular.\n` +
      `- Não use tabelas, blocos de código com \`\`\`, nem links no formato [texto](url) — WhatsApp não interpreta. Cole a URL direto.\n` +
      `- Emojis: máximo 1 ou 2 por mensagem, só quando agregam contexto. Sugestões: 📅 data, 🕐 horário, 📍 endereço, 🍽️ cardápio, ✅ confirmação, ❌ cancelamento, 🙏 agradecimento. Não exagere — mensagem cheia de emoji parece spam.` +
      (unitAddress ? `\n\nEndereço: ${unitAddress}` : "") +
      (hoursLines.length ? `\n\nHorário de funcionamento:\n${hoursLines.join("\n")}` : "") +
      (specialLines.length ? `\n\nDatas especiais nos próximos 60 dias:\n${specialLines.join("\n")}` : "") +
      (blockedLines.length ? `\n\nDatas com bloqueio de reservas nos próximos 60 dias (agenda indisponível, mas o restaurante pode estar funcionando):\n${blockedLines.join("\n")}` : "") +
      (includeFaq && settingsMap["restaurant_menu"] ? `\n\nCardápio:\n${settingsMap["restaurant_menu"]}` : "") +
      (includeFaq && settingsMap["delivery_response"] ? `\n\nSobre delivery/take-away:\n${settingsMap["delivery_response"]}` : "") +
      (includeFaq && settingsMap["restaurant_extra_info"] ? `\n\nOutras informações:\n${settingsMap["restaurant_extra_info"]}` : "") +
      (prefsLines.length ? `\n\nO que sabemos sobre este cliente:\n${prefsLines.join("\n")}` : "") +
      (customPrompt ? `\n\nInstruções adicionais: ${customPrompt}` : "");

    const totalUsage = { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 };
    let agentError: string | null = null;
    let finalText = "";

    try {
      finalText = await runAgentLoop({
        provider: provider_ai,
        apiKey,
        model: modelOverride,
        systemPrompt,
        history,
        userMessage: incomingText,
        tools: agentTools,
        onUsage: (u) => {
          totalUsage.input_tokens += u.input_tokens;
          totalUsage.output_tokens += u.output_tokens;
          totalUsage.cache_creation_tokens += u.cache_creation_tokens;
          totalUsage.cache_read_tokens += u.cache_read_tokens;
        },
        // deno-lint-ignore no-explicit-any
        onToolCall: async (name, input: any) => {
          jsonLog("info", { requestId, evt: "tool_call", channelId, unitId, name, input: summarizeToolInput(input) });
          try {
            // deno-lint-ignore no-explicit-any
            let result: any;
            switch (name) {
              case "check_availability":
                result = await checkAvailability(input.date, input.time, input.party_size, unitId!, input.hall_name);
                break;
              case "create_reservation":
                result = await createReservation({ ...input, phone, unit_id: unitId!, organization_id: organizationId });
                break;
              case "get_reservation":
                result = await getReservation(input.reservation_code ? input : { ...input, phone }, unitId!);
                break;
              case "update_reservation":
                result = await updateReservation(input);
                break;
              case "cancel_reservation":
                result = await cancelReservation(input.reservation_code);
                break;
              case "list_customer_reservations":
                result = await listCustomerReservations(customer.id, unitId!);
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
            return JSON.stringify({ error: String(err) });
          }
        },
      });
    } catch (err) {
      agentError = String(err);
      jsonLog("error", { requestId, evt: "agent_loop_error", err: agentError });
    }

    const usedModel = modelOverride;
    jsonLog("info", {
      requestId,
      evt: "agent_usage",
      provider: provider_ai,
      model: usedModel,
      channelId,
      unitId,
      ...totalUsage,
      estimated_cost_usd: estimateCostUsd(usedModel, totalUsage),
    });

    if (agentError) {
      // Agente falhou (timeout, modelo descontinuado, 4xx do provider, tool error
      // não tratado, etc). Em vez de só pedir pro cliente repetir — o que não
      // resolve quando o erro é estrutural —, fazemos auto-handoff: marca a
      // conversa awaiting_human pra atendente assumir, registra provider/model
      // no handoff_reason e em webhook_executions.meta, e avisa o cliente.
      const usedModel = modelOverride;
      await supabase
        .from("conversations")
        .update({
          status: "awaiting_human",
          handoff_reason: `agent_error:${provider_ai}:${usedModel}`,
          handoff_at: new Date().toISOString(),
          last_silenced_reply_at: null,
        })
        .eq("id", conv.id);

      const handoffText = "Tive um instante de instabilidade aqui. Já chamei alguém da equipe pra te responder. Em breve um humano assume.";
      await sendOutbound(provider, credentials, { toPhone: phone, text: handoffText });
      await appendToConversation(conv.id, [...(conv.messages || []), { role: "user", content: incomingText }], "assistant", handoffText);

      jsonLog("warn", { requestId, evt: "agent_error_handoff", provider: provider_ai, model: usedModel, err: agentError });
      await finish("agent_error", agentError, {
        provider: provider_ai,
        model: usedModel,
        channel_id: channelId,
      });
      return new Response("ok");
    }

    if (!finalText || !finalText.trim()) {
      // Modelo não devolveu texto algum — ainda assim respondemos pra não
      // deixar o cliente no escuro.
      jsonLog("warn", { requestId, evt: "agent_empty_response", channelId, unitId });
      await sendOutbound(provider, credentials, {
        toPhone: phone,
        text: "Desculpa, não consegui montar uma resposta agora. Pode reformular ou aguardar um instante?",
      });
      await finish("empty_response");
      return new Response("ok");
    }

    // Sanitiza markdown padrão de LLM (**bold**, # header, `code`, listas com
    // "* ", links [text](url)) pro formato WhatsApp (*bold*, "- " em lista).
    // Rede defensiva — o system prompt já instrui, mas modelos divergem.
    // A versão sanitizada é o que vai pro cliente E o que fica no log da
    // conversa operacional (operador vê o mesmo que cliente recebeu).
    const finalTextForWhatsApp = sanitizeForWhatsApp(finalText);

    await appendToConversation(conv.id, [...(conv.messages || []), { role: "user", content: incomingText }], "assistant", finalTextForWhatsApp);
    const sendRes = await sendOutbound(provider, credentials, { toPhone: phone, text: finalTextForWhatsApp });

    if (!sendRes.ok) {
      await finish("send_error", sendRes.error ?? `status_${sendRes.status}`, {
        missingCreds: sendRes.missingCreds,
        bodySnippet: sendRes.bodySnippet,
      });
      return new Response("ok");
    }

    await finish("success", undefined, { tokens: totalUsage.input_tokens + totalUsage.output_tokens });
    return new Response("ok");
  } catch (err) {
    jsonLog("error", { requestId, evt: "webhook_error", err: String(err) });
    try {
      await finish("webhook_error", String(err));
    } catch {
      // ignore
    }
    return new Response("error", { status: 500 });
  }
});
