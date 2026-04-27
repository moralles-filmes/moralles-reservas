import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  runAgentLoop,
  DEFAULT_MODELS,
  type AIProvider,
  type AgentTool,
} from "../_shared/ai-providers.ts";
import { sendWhatsApp } from "../send-whatsapp/index.ts";

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
}

serve(async (req) => {
  try {
    const payload: ZApiPayload = await req.json();

    if (payload.isFromMe || !payload.text?.message) {
      return new Response("ok");
    }

    const phone = payload.phone.replace(/\D/g, "").replace(/^55/, "");
    const incomingText = payload.text.message.trim();

    // Upsert customer
    const { data: customer } = await supabase
      .from("customers")
      .upsert({ phone, name: phone }, { onConflict: "phone" })
      .select()
      .single();

    if (!customer) return new Response("error", { status: 500 });

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

    const systemPrompt =
      `Você é o assistente de reservas do ${restaurantName}. ` +
      `Seja cordial, eficiente e responda sempre em português brasileiro. ` +
      `O número de WhatsApp do cliente é ${phone}. ` +
      `Use as ferramentas disponíveis para consultar disponibilidade, criar, alterar ou cancelar reservas. ` +
      `Ao criar uma reserva, sempre confirme todos os detalhes antes de finalizar.` +
      (customPrompt ? `\n\nInstruções adicionais: ${customPrompt}` : "");

    // Run AI agent loop
    const finalText = await runAgentLoop({
      provider,
      apiKey,
      model: modelOverride,
      systemPrompt,
      history,
      userMessage: incomingText,
      tools: agentTools,
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
            default:
              result = { error: `Tool desconhecida: ${name}` };
          }
          return JSON.stringify(result);
        } catch (err) {
          return JSON.stringify({ error: String(err) });
        }
      },
    });

    if (finalText) {
      await appendToConversation(conv.id, [...conv.messages, { role: "user", content: incomingText }], "assistant", finalText);
      await sendWhatsApp(phone, finalText);
    }

    return new Response("ok");
  } catch (err) {
    console.error("webhook-zapi error:", err);
    return new Response("error", { status: 500 });
  }
});
