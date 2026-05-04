import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  runAgentLoop,
  DEFAULT_MODELS,
  type AIProvider,
  type AgentTool,
} from "../_shared/ai-providers.ts";
import {
  parseInbound,
  sendOutbound,
  validateChannelSecret,
  type WhatsAppProvider,
  type ChannelCredentials,
} from "../_shared/whatsapp-providers.ts";
import {
  genRequestId,
  jsonLog,
  sanitizePhone,
} from "../_shared/security.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const API_KEY_ENV: Record<AIProvider, string> = {
  claude: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  grok: "GROK_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

function getApiKey(provider: AIProvider): string {
  const key = Deno.env.get(API_KEY_ENV[provider]);
  if (!key) throw new Error(`Chave de API não configurada para ${provider}. Defina ${API_KEY_ENV[provider]} nos secrets do Supabase.`);
  return key;
}

// ─── Agent tools ──────────────────────────────────────────────────────────────

const agentTools: AgentTool[] = [
  {
    name: "check_availability",
    description: "Verifica disponibilidade de mesas para uma data, horário e número de pessoas.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Data no formato YYYY-MM-DD" },
        time: { type: "string", description: "Horário no formato HH:MM" },
        party_size: { type: "number", description: "Número de pessoas" },
      },
      required: ["date", "time", "party_size"],
    },
  },
  {
    name: "create_reservation",
    description: "Cria uma nova reserva para o cliente.",
    parameters: {
      type: "object",
      properties: {
        customer_name: { type: "string", description: "Nome completo do cliente" },
        customer_email: { type: "string", description: "E-mail do cliente (opcional)" },
        date: { type: "string", description: "Data YYYY-MM-DD" },
        time: { type: "string", description: "Horário HH:MM" },
        party_size: { type: "number", description: "Número de pessoas" },
        notes: { type: "string", description: "Observações opcionais" },
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

// deno-lint-ignore no-explicit-any
async function checkAvailability(date: string, time: string, partySize: number, unitId: string): Promise<any> {
  const { data: tables } = await supabase
    .from("tables")
    .select("*")
    .eq("unit_id", unitId)
    .eq("active", true)
    .gte("capacity", partySize);

  const { data: conflicts } = await supabase
    .from("reservations")
    .select("table_id")
    .eq("unit_id", unitId)
    .eq("date", date)
    .eq("time", time)
    .in("status", ["confirmed", "pending"]);

  const conflictIds = new Set((conflicts || []).map((r: { table_id: string }) => r.table_id));
  const available = (tables || []).filter((t: { id: string }) => !conflictIds.has(t.id));

  if (available.length === 0) return { available: false, message: "Não há mesas disponíveis para esse horário." };
  return { available: true, tables_count: available.length, message: `Há ${available.length} mesa(s) disponível(is) para ${partySize} pessoas em ${date} às ${time}.` };
}

async function createReservation(params: {
  customer_name: string;
  customer_email?: string;
  date: string;
  time: string;
  party_size: number;
  notes?: string;
  phone: string;
  unit_id: string;
  organization_id: string;
// deno-lint-ignore no-explicit-any
}): Promise<any> {
  const { data: customer, error: custError } = await supabase
    .from("customers")
    .upsert(
      { name: params.customer_name, phone: params.phone, email: params.customer_email || null, organization_id: params.organization_id },
      { onConflict: "organization_id,phone" }
    )
    .select()
    .single();

  if (custError) return { success: false, error: custError.message };

  // 8-char code for multi-tenant (less collision chance globally)
  const code = Math.random().toString(36).substring(2, 10).toUpperCase();
  const { error } = await supabase.from("reservations").insert({
    customer_id: customer.id,
    unit_id: params.unit_id,
    date: params.date,
    time: params.time,
    party_size: params.party_size,
    notes: params.notes || null,
    reservation_code: code,
    status: "confirmed",
  });

  if (error) return { success: false, error: error.message };
  const [y, m, d] = params.date.split("-");
  return { success: true, reservation_code: code, message: `Reserva criada! Código: #${code}. Data: ${d}/${m}/${y} às ${params.time} para ${params.party_size} pessoas.` };
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

async function getOrCreateConversation(customerId: string, unitId: string) {
  const { data } = await supabase
    .from("conversations")
    .select("*")
    .eq("customer_id", customerId)
    .eq("unit_id", unitId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (data) return data;

  const { data: newConv } = await supabase
    .from("conversations")
    .insert({ customer_id: customerId, unit_id: unitId, messages: [] })
    .select()
    .single();
  return newConv;
}

// deno-lint-ignore no-explicit-any
async function appendToConversation(convId: string, existing: any[], role: "user" | "assistant", content: string) {
  const updated = [...existing, { role, content, timestamp: new Date().toISOString() }];
  await supabase
    .from("conversations")
    .update({ messages: updated, updated_at: new Date().toISOString() })
    .eq("id", convId);
  return updated;
}

// ─── Main handler ──────────────────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX = 10;

serve(async (req) => {
  const requestId = genRequestId();

  try {
    const url = new URL(req.url);
    const channelId = url.searchParams.get("channel");

    if (!channelId) {
      jsonLog("warn", { requestId, evt: "missing_channel_param" });
      return new Response("missing channel", { status: 400 });
    }

    // Resolve channel → unit_id, provider, credentials, webhook_secret
    const { data: channel, error: channelErr } = await supabase
      .from("whatsapp_channels")
      .select("id, unit_id, provider, credentials, webhook_secret")
      .eq("id", channelId)
      .maybeSingle();

    if (channelErr || !channel) {
      jsonLog("warn", { requestId, evt: "channel_not_found", channelId });
      return new Response("channel not found", { status: 404 });
    }

    // Validate per-channel webhook secret (falls back to global ZAPI secret for legacy channels)
    const secret = channel.webhook_secret ?? Deno.env.get("ZAPI_WEBHOOK_SECRET") ?? "";
    if (!validateChannelSecret(req, secret)) {
      // For Meta Official, the validation is different (signature-based) — allow through
      // and let the payload parsing fail naturally for invalid messages.
      // For Z-API and WAHA, block unauthorized requests.
      if (channel.provider !== "official") {
        jsonLog("warn", { requestId, evt: "webhook_unauthorized", channelId });
        return new Response("unauthorized", { status: 401 });
      }
    }

    const payload = await req.json();
    const unitId: string = channel.unit_id;
    const provider: WhatsAppProvider = channel.provider;
    const credentials: ChannelCredentials = channel.credentials ?? {};

    // Parse inbound message using provider-specific adapter
    const inbound = parseInbound(provider, payload);
    if (!inbound) {
      // Not a text message or sent by us — ignore silently
      return new Response("ok");
    }

    const phone = inbound.fromPhone;
    const incomingText = inbound.text;

    // Update channel last_event_at
    await supabase
      .from("whatsapp_channels")
      .update({ last_event_at: new Date().toISOString(), status: "connected", last_error: null })
      .eq("id", channelId);

    // Idempotência — descarta retransmissões
    const { error: idemError } = await supabase
      .from("processed_messages")
      .insert({ message_id: inbound.providerMessageId });
    if (idemError) {
      jsonLog("info", { requestId, evt: "duplicate_message", phone: sanitizePhone(phone) });
      return new Response("ok");
    }

    // Rate limit por telefone (sliding window, por unidade)
    const { data: allowed } = await supabase.rpc("check_rate_limit", {
      p_phone: phone,
      p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
      p_max: RATE_LIMIT_MAX,
      p_unit_id: unitId,
    });
    if (allowed === false) {
      jsonLog("warn", { requestId, evt: "rate_limited", phone: sanitizePhone(phone) });
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

    // Upsert customer (org-scoped)
    const { data: customer } = await supabase
      .from("customers")
      .upsert(
        { phone, name: phone, organization_id: organizationId },
        { onConflict: "organization_id,phone" }
      )
      .select()
      .single();

    if (!customer) return new Response("error", { status: 500 });

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

        await sendOutbound(provider, credentials, { toPhone: phone, text: "Obrigado pelo feedback! 🙏" });
        jsonLog("info", { requestId, evt: "survey_response_captured", rating, phone: sanitizePhone(phone) });
        return new Response("ok");
      }
    }

    // Load conversation history
    const conv = await getOrCreateConversation(customer.id, unitId);

    // Short-circuit: conversa em atendimento humano — só registra a mensagem, IA silenciada
    if (conv.status === "human_active" || conv.status === "awaiting_human") {
      await appendToConversation(conv.id, conv.messages, "user", incomingText);
      await supabase.from("conversations")
        .update({ last_message_at: new Date().toISOString() })
        .eq("id", conv.id);
      jsonLog("info", { requestId, evt: "skipped_ai_human_active", convId: conv.id, status: conv.status });
      return new Response("ok");
    }

    // deno-lint-ignore no-explicit-any
    const history: Array<{ role: "user" | "assistant"; content: string }> = (conv.messages || []).map((m: any) => ({ role: m.role, content: m.content }));

    await appendToConversation(conv.id, conv.messages, "user", incomingText);

    // Load AI config from settings (unit-scoped)
    const { data: configSetting } = await supabase
      .from("settings")
      .select("value")
      .eq("unit_id", unitId)
      .eq("key", "ai_config")
      .maybeSingle();

    const aiConfig = (configSetting?.value ?? {}) as Record<string, unknown>;
    const provider_ai: AIProvider = (aiConfig.provider as AIProvider) ?? "claude";
    const modelOverride: string | undefined = (aiConfig.models as Record<string, string>)?.[provider_ai];
    const apiKey = getApiKey(provider_ai);

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

    const prefsLines: string[] = [];
    if (customer.allergies) prefsLines.push(`- Alergias: ${customer.allergies}`);
    if (customer.dietary_restrictions) prefsLines.push(`- Restrições alimentares: ${customer.dietary_restrictions}`);
    if (customer.vip_notes) prefsLines.push(`- VIP: ${customer.vip_notes}`);
    if (customer.preferred_table_location) prefsLines.push(`- Mesa preferida: ${customer.preferred_table_location === "internal" ? "interna" : "externa"}`);

    const todayBR = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });

    const agentMode = (settingsMap["agent_mode"] as string) ?? "reservations";
    const agentHeader = agentMode === "reservations_faq"
      ? `Você é o assistente do ${restaurantName}. Atende reservas e dúvidas gerais (cardápio, horário, endereço, estacionamento). `
      : `Você é o assistente de reservas do ${restaurantName}. `;

    const systemPrompt =
      agentHeader +
      `Seja cordial, eficiente e responda sempre em português brasileiro. ` +
      `O número de WhatsApp do cliente é ${phone}. Hoje é ${todayBR}. ` +
      `Use as ferramentas disponíveis para reservas. ` +
      `Ao criar uma reserva, sempre confirme todos os detalhes antes de finalizar. ` +
      `Não invente horários, cardápio ou serviços — só use o que está documentado abaixo. ` +
      `Se o pedido fugir do escopo (reclamação, evento corporativo, delivery não suportado, qualquer coisa que as ferramentas não cobrem), use a tool 'request_human_handoff' informando o motivo.` +
      (unitAddress ? `\n\nEndereço: ${unitAddress}` : "") +
      (hoursLines.length ? `\n\nHorário de funcionamento:\n${hoursLines.join("\n")}` : "") +
      (specialLines.length ? `\n\nDatas especiais nos próximos 60 dias:\n${specialLines.join("\n")}` : "") +
      (settingsMap["restaurant_menu"] ? `\n\nCardápio:\n${settingsMap["restaurant_menu"]}` : "") +
      (settingsMap["delivery_response"] ? `\n\nSobre delivery/take-away:\n${settingsMap["delivery_response"]}` : "") +
      (settingsMap["restaurant_extra_info"] ? `\n\nOutras informações:\n${settingsMap["restaurant_extra_info"]}` : "") +
      (prefsLines.length ? `\n\nO que sabemos sobre este cliente:\n${prefsLines.join("\n")}` : "") +
      (customPrompt ? `\n\nInstruções adicionais: ${customPrompt}` : "");

    const totalUsage = { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 };

    const finalText = await runAgentLoop({
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
        try {
          // deno-lint-ignore no-explicit-any
          let result: any;
          switch (name) {
            case "check_availability":
              result = await checkAvailability(input.date, input.time, input.party_size, unitId);
              break;
            case "create_reservation":
              result = await createReservation({ ...input, phone, unit_id: unitId, organization_id: organizationId });
              break;
            case "get_reservation":
              result = await getReservation(input.reservation_code ? input : { ...input, phone }, unitId);
              break;
            case "update_reservation":
              result = await updateReservation(input);
              break;
            case "cancel_reservation":
              result = await cancelReservation(input.reservation_code);
              break;
            case "list_customer_reservations":
              result = await listCustomerReservations(customer.id, unitId);
              break;
            case "request_human_handoff":
              await supabase.from("conversations").update({
                status: "awaiting_human",
                handoff_reason: input.reason,
                handoff_at: new Date().toISOString(),
              }).eq("id", conv.id);
              jsonLog("info", { requestId, evt: "handoff_requested", convId: conv.id, reason: input.reason });
              result = { ok: true, message: "Transferência registrada. Informe ao cliente que um atendente humano dará sequência em breve." };
              break;
            default:
              result = { error: `Tool desconhecida: ${name}` };
          }
          return JSON.stringify(result);
        } catch (err) {
          return JSON.stringify({ error: String(err) });
        }
      },
    });

    jsonLog("info", {
      requestId,
      evt: "agent_usage",
      provider: provider_ai,
      model: modelOverride ?? DEFAULT_MODELS[provider_ai],
      channelId,
      unitId,
      ...totalUsage,
    });

    if (finalText) {
      await appendToConversation(conv.id, [...conv.messages, { role: "user", content: incomingText }], "assistant", finalText);
      await sendOutbound(provider, credentials, { toPhone: phone, text: finalText });
    }

    return new Response("ok");
  } catch (err) {
    jsonLog("error", { requestId, evt: "webhook_error", err: String(err) });
    return new Response("error", { status: 500 });
  }
});
