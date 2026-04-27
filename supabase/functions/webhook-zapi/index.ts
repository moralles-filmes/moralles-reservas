import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  runAgentLoop,
  DEFAULT_MODELS,
  type AIProvider,
  type AgentTool,
} from "../_shared/ai-providers.ts";
import { sendWhatsApp } from "../send-whatsapp/index.ts";
import {
  genRequestId,
  jsonLog,
  sanitizePhone,
  validateWebhookSecret,
} from "../_shared/security.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// ─── API key resolver ─────────────────────────────────────────────────────────
// Keys are stored as Supabase secrets (never in the DB).
// Names: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GROK_API_KEY, DEEPSEEK_API_KEY

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

// ─── Neutral tool definitions ─────────────────────────────────────────────────

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
        reservation_code: { type: "string", description: "Código da reserva (ex: AB1C2D)" },
        phone: { type: "string", description: "Telefone do cliente para buscar reserva mais recente" },
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
        date: { type: "string", description: "Nova data YYYY-MM-DD (opcional)" },
        time: { type: "string", description: "Novo horário HH:MM (opcional)" },
        party_size: { type: "number", description: "Novo número de pessoas (opcional)" },
        notes: { type: "string", description: "Novas observações (opcional)" },
      },
      required: ["reservation_code"],
    },
  },
  {
    name: "cancel_reservation",
    description: "Cancela uma reserva existente.",
    parameters: {
      type: "object",
      properties: {
        reservation_code: { type: "string" },
      },
      required: ["reservation_code"],
    },
  },
  {
    name: "list_customer_reservations",
    description:
      "Lista as reservas ativas (pending/confirmed) do cliente. Use quando o cliente perguntar sobre reservas em aberto, sem informar o código.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
];

// ─── Tool implementations ──────────────────────────────────────────────────────

async function checkAvailability(date: string, time: string, partySize: number) {
  const { data: tables } = await supabase
    .from("tables")
    .select("*")
    .eq("active", true)
    .gte("capacity", partySize);

  const { data: conflicts } = await supabase
    .from("reservations")
    .select("table_id")
    .eq("date", date)
    .eq("time", time)
    .in("status", ["confirmed", "pending"]);

  const conflictIds = new Set((conflicts || []).map((r: any) => r.table_id));
  const available = (tables || []).filter((t: any) => !conflictIds.has(t.id));

  if (available.length === 0) {
    return { available: false, message: "Não há mesas disponíveis para esse horário." };
  }
  return {
    available: true,
    tables_count: available.length,
    message: `Há ${available.length} mesa(s) disponível(is) para ${partySize} pessoas em ${date} às ${time}.`,
  };
}

async function createReservation(params: {
  customer_name: string;
  customer_email?: string;
  date: string;
  time: string;
  party_size: number;
  notes?: string;
  phone: string;
}) {
  const { data: customer, error: custError } = await supabase
    .from("customers")
    .upsert(
      { name: params.customer_name, phone: params.phone, email: params.customer_email || null },
      { onConflict: "phone" }
    )
    .select()
    .single();

  if (custError) return { success: false, error: custError.message };

  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const { error } = await supabase.from("reservations").insert({
    customer_id: customer.id,
    date: params.date,
    time: params.time,
    party_size: params.party_size,
    notes: params.notes || null,
    reservation_code: code,
    status: "confirmed",
  });

  if (error) return { success: false, error: error.message };

  const [y, m, d] = params.date.split("-");
  return {
    success: true,
    reservation_code: code,
    message: `Reserva criada! Código: #${code}. Data: ${d}/${m}/${y} às ${params.time} para ${params.party_size} pessoas.`,
  };
}

async function getReservation(params: { reservation_code?: string; phone?: string }) {
  let query = supabase
    .from("reservations")
    .select("*, customer:customers(*)")
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
    query = query
      .eq("customer_id", customer.id)
      .order("created_at", { ascending: false })
      .limit(1);
  } else {
    return { found: false, message: "Informe o código ou o telefone." };
  }

  const { data } = await query.maybeSingle();
  if (!data) return { found: false, message: "Reserva não encontrada ou já cancelada." };

  const [y, m, d] = data.date.split("-");
  return {
    found: true,
    reservation_code: data.reservation_code,
    date: `${d}/${m}/${y}`,
    time: data.time,
    party_size: data.party_size,
    status: data.status,
    notes: data.notes,
  };
}

async function updateReservation(params: {
  reservation_code: string;
  date?: string;
  time?: string;
  party_size?: number;
  notes?: string;
}) {
  const updates: Record<string, any> = {};
  if (params.date) updates.date = params.date;
  if (params.time) updates.time = params.time;
  if (params.party_size) updates.party_size = params.party_size;
  if (params.notes !== undefined) updates.notes = params.notes;

  if (!Object.keys(updates).length) {
    return { success: false, message: "Nenhuma alteração informada." };
  }

  const { error } = await supabase
    .from("reservations")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("reservation_code", params.reservation_code.toUpperCase());

  if (error) return { success: false, error: error.message };
  return { success: true, message: "Reserva atualizada com sucesso!" };
}

async function cancelReservation(code: string) {
  const { error } = await supabase
    .from("reservations")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("reservation_code", code.toUpperCase())
    .in("status", ["confirmed", "pending"]);

  if (error) return { success: false, error: error.message };
  return { success: true, message: `Reserva #${code} cancelada.` };
}

async function listCustomerReservations(customerId: string) {
  const { data } = await supabase
    .from("reservations")
    .select("reservation_code, date, time, party_size, status, notes")
    .eq("customer_id", customerId)
    .in("status", ["pending", "confirmed"])
    .gte("date", new Date().toISOString().slice(0, 10))
    .order("date", { ascending: true })
    .order("time", { ascending: true })
    .limit(10);

  if (!data || data.length === 0) {
    return { found: false, message: "Você não tem reservas ativas no momento." };
  }
  return {
    found: true,
    count: data.length,
    reservations: data.map((r) => {
      const [y, m, d] = r.date.split("-");
      return {
        reservation_code: r.reservation_code,
        date: `${d}/${m}/${y}`,
        time: r.time,
        party_size: r.party_size,
        status: r.status,
        notes: r.notes,
      };
    }),
  };
}

// ─── Conversation helpers ──────────────────────────────────────────────────────

async function getOrCreateConversation(customerId: string) {
  const { data } = await supabase
    .from("conversations")
    .select("*")
    .eq("customer_id", customerId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (data) return data;

  const { data: newConv } = await supabase
    .from("conversations")
    .insert({ customer_id: customerId, messages: [] })
    .select()
    .single();
  return newConv;
}

async function appendToConversation(
  convId: string,
  existing: any[],
  role: "user" | "assistant",
  content: string
) {
  const updated = [...existing, { role, content, timestamp: new Date().toISOString() }];
  await supabase
    .from("conversations")
    .update({ messages: updated, updated_at: new Date().toISOString() })
    .eq("id", convId);
  return updated;
}

// ─── Main handler ──────────────────────────────────────────────────────────────

interface ZApiPayload {
  phone: string;
  text?: { message: string };
  isFromMe?: boolean;
  messageId?: string;
  message?: { id?: string };
  id?: string;
}

const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX = 10;

function extractMessageId(payload: ZApiPayload, phone: string, text: string): string {
  const id = payload.messageId ?? payload.message?.id ?? payload.id;
  if (id) return id;
  // Fallback determinístico (mesmo phone+text dentro do mesmo segundo é deduplicado).
  const ts = Math.floor(Date.now() / 1000);
  return `${phone}:${ts}:${text.slice(0, 32)}`;
}

serve(async (req) => {
  const requestId = genRequestId();

  if (!validateWebhookSecret(req)) {
    jsonLog("warn", { requestId, evt: "webhook_unauthorized" });
    return new Response("unauthorized", { status: 401 });
  }

  try {
    const payload: ZApiPayload = await req.json();

    if (payload.isFromMe || !payload.text?.message) {
      return new Response("ok");
    }

    const phone = payload.phone.replace(/\D/g, "").replace(/^55/, "");
    const incomingText = payload.text.message.trim();

    // Idempotência — descarta retransmissões da Z-API.
    const messageId = extractMessageId(payload, phone, incomingText);
    const { error: idemError } = await supabase
      .from("processed_messages")
      .insert({ message_id: messageId });
    if (idemError) {
      // Unique violation = já processado; qualquer outro erro também loga e segue ok
      // (preferimos perder uma mensagem do que duplicar).
      jsonLog("info", {
        requestId,
        evt: "duplicate_message",
        phone: sanitizePhone(phone),
      });
      return new Response("ok");
    }

    // Rate limit por telefone (sliding window).
    const { data: allowed, error: rlError } = await supabase.rpc("check_rate_limit", {
      p_phone: phone,
      p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
      p_max: RATE_LIMIT_MAX,
    });
    if (rlError) {
      jsonLog("error", { requestId, evt: "rate_limit_check_failed", err: String(rlError) });
    } else if (allowed === false) {
      jsonLog("warn", {
        requestId,
        evt: "rate_limited",
        phone: sanitizePhone(phone),
      });
      return new Response("ok"); // silencioso para evitar loop com o usuário
    }

    // Upsert customer
    const { data: customer } = await supabase
      .from("customers")
      .upsert({ phone, name: phone }, { onConflict: "phone" })
      .select()
      .single();

    if (!customer) return new Response("error", { status: 500 });

    // Survey response intercept — captura nota 1-5 de pesquisa D+1 antes do agente
    // IA (mais barato e determinístico). Janela de 36h cobre quem responde no dia
    // seguinte ao envio.
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
          .update({
            satisfaction_rating: rating,
            satisfaction_at: new Date().toISOString(),
          })
          .eq("id", pending.reservation_id);

        await sendWhatsApp(phone, "Obrigado pelo feedback! 🙏");

        jsonLog("info", {
          requestId,
          evt: "survey_response_captured",
          rating,
          phone: sanitizePhone(phone),
        });

        return new Response("ok");
      }
    }

    // Load conversation history
    const conv = await getOrCreateConversation(customer.id);
    const history: Array<{ role: "user" | "assistant"; content: string }> = (
      conv.messages || []
    ).map((m: any) => ({ role: m.role, content: m.content }));

    // Save incoming message
    await appendToConversation(conv.id, conv.messages, "user", incomingText);

    // Load AI config from settings
    const { data: configSetting } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "ai_config")
      .maybeSingle();

    const aiConfig = configSetting?.value ?? {};
    const provider: AIProvider = aiConfig.provider ?? "claude";
    const modelOverride: string | undefined = aiConfig.models?.[provider];

    const apiKey = getApiKey(provider);

    // Load restaurant name + system prompt
    const { data: settings } = await supabase
      .from("settings")
      .select("key, value")
      .in("key", ["restaurant_name", "ai_system_prompt"]);

    const settingsMap = Object.fromEntries(
      (settings || []).map((s: any) => [s.key, s.value])
    );

    const restaurantName = settingsMap["restaurant_name"] ?? "Moralles Restaurante";
    const customPrompt = settingsMap["ai_system_prompt"] ?? "";

    // Contexto do restaurante: horários da semana + próximas datas especiais.
    const { data: hoursRows } = await supabase
      .from("business_hours")
      .select("day_of_week, open_time, close_time, is_closed")
      .order("day_of_week");

    const dayNames = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
    const hoursLines = (hoursRows ?? []).map((h: any) =>
      h.is_closed
        ? `- ${dayNames[h.day_of_week]}: fechado`
        : `- ${dayNames[h.day_of_week]}: ${h.open_time?.slice(0, 5)} às ${h.close_time?.slice(0, 5)}`
    );

    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: specialDates } = await supabase
      .from("special_dates")
      .select("date, name, is_closed, open_time, close_time")
      .gte("date", today)
      .lte("date", horizon)
      .order("date", { ascending: true });

    const specialLines = (specialDates ?? []).map((s: any) => {
      const [y, m, d] = s.date.split("-");
      const ymd = `${d}/${m}/${y}`;
      if (s.is_closed) return `- ${ymd} (${s.name}): fechado`;
      return `- ${ymd} (${s.name}): ${s.open_time?.slice(0, 5)} às ${s.close_time?.slice(0, 5)}`;
    });

    // Preferências do cliente — se já cadastradas, alimentamos o prompt.
    const prefsLines: string[] = [];
    if (customer.allergies) prefsLines.push(`- Alergias: ${customer.allergies}`);
    if (customer.dietary_restrictions) prefsLines.push(`- Restrições alimentares: ${customer.dietary_restrictions}`);
    if (customer.vip_notes) prefsLines.push(`- VIP: ${customer.vip_notes}`);
    if (customer.preferred_table_location)
      prefsLines.push(
        `- Mesa preferida: ${customer.preferred_table_location === "internal" ? "interna" : "externa"}`,
      );

    const todayBR = new Date().toLocaleDateString("pt-BR", {
      weekday: "long",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });

    const systemPrompt =
      `Você é o assistente de reservas do ${restaurantName}. ` +
      `Seja cordial, eficiente e responda sempre em português brasileiro. ` +
      `O número de WhatsApp do cliente é ${phone}. Hoje é ${todayBR}. ` +
      `Use as ferramentas disponíveis para consultar disponibilidade, criar, alterar, cancelar ou listar reservas. ` +
      `Ao criar uma reserva, sempre confirme todos os detalhes antes de finalizar. ` +
      `Não invente horários — só ofereça horários dentro da janela de funcionamento.` +
      (hoursLines.length ? `\n\nHorário de funcionamento:\n${hoursLines.join("\n")}` : "") +
      (specialLines.length
        ? `\n\nDatas especiais nos próximos 60 dias (sobrescrevem o horário acima):\n${specialLines.join("\n")}`
        : "") +
      (prefsLines.length ? `\n\nO que sabemos sobre este cliente:\n${prefsLines.join("\n")}` : "") +
      (customPrompt ? `\n\nInstruções adicionais: ${customPrompt}` : "");

    // Acumula o uso de tokens ao longo das múltiplas chamadas do loop.
    const totalUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    };

    // Run AI agent loop
    const finalText = await runAgentLoop({
      provider,
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
      onToolCall: async (name, input) => {
        try {
          let result: any;
          switch (name) {
            case "check_availability":
              result = await checkAvailability(input.date, input.time, input.party_size);
              break;
            case "create_reservation":
              result = await createReservation({ ...input, phone });
              break;
            case "get_reservation":
              result = await getReservation(
                input.reservation_code ? input : { ...input, phone }
              );
              break;
            case "update_reservation":
              result = await updateReservation(input);
              break;
            case "cancel_reservation":
              result = await cancelReservation(input.reservation_code);
              break;
            case "list_customer_reservations":
              result = await listCustomerReservations(customer.id);
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
      provider,
      model: modelOverride ?? DEFAULT_MODELS[provider],
      ...totalUsage,
    });

    if (finalText) {
      await appendToConversation(conv.id, [...conv.messages, { role: "user", content: incomingText }], "assistant", finalText);
      await sendWhatsApp(phone, finalText);
    }

    return new Response("ok");
  } catch (err) {
    jsonLog("error", { requestId, evt: "webhook_error", err: String(err) });
    return new Response("error", { status: 500 });
  }
});
