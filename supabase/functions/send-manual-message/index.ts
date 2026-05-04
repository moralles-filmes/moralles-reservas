import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  sendOutbound,
  type WhatsAppProvider,
  type ChannelCredentials,
} from "../_shared/whatsapp-providers.ts";
import { fetchWithRetry } from "../_shared/retry.ts";
import { jsonLog, sanitizePhone } from "../_shared/security.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const LEGACY_ZAPI_INSTANCE_ID = Deno.env.get("ZAPI_INSTANCE_ID");
const LEGACY_ZAPI_TOKEN = Deno.env.get("ZAPI_TOKEN");
const LEGACY_ZAPI_CLIENT_TOKEN = Deno.env.get("ZAPI_CLIENT_TOKEN");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

async function sendZApiLegacy(phone: string, message: string): Promise<boolean> {
  if (!LEGACY_ZAPI_INSTANCE_ID || !LEGACY_ZAPI_TOKEN) return false;
  const digits = phone.replace(/\D/g, "");
  const formatted = digits.startsWith("55") ? digits : `55${digits}`;
  const url = `https://api.z-api.io/instances/${LEGACY_ZAPI_INSTANCE_ID}/token/${LEGACY_ZAPI_TOKEN}/send-text`;
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(LEGACY_ZAPI_CLIENT_TOKEN ? { "Client-Token": LEGACY_ZAPI_CLIENT_TOKEN } : {}),
      },
      body: JSON.stringify({ phone: formatted, message }),
    },
    { retries: 3, baseDelayMs: 500 }
  );
  if (!res.ok) {
    jsonLog("error", { evt: "zapi_send_failed", status: res.status, phone: sanitizePhone(phone) });
  }
  return res.ok;
}

async function sendWhatsAppViaUnit(
  supabase: ReturnType<typeof createClient>,
  unitId: string,
  phone: string,
  message: string
): Promise<boolean> {
  const { data: channel } = await supabase
    .from("whatsapp_channels")
    .select("provider, credentials")
    .eq("unit_id", unitId)
    .eq("status", "connected")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (channel) {
    return sendOutbound(
      channel.provider as WhatsAppProvider,
      channel.credentials as ChannelCredentials,
      { toPhone: phone, text: message }
    );
  }

  return sendZApiLegacy(phone, message);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Identify the calling user via their JWT
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Service role client for privileged operations
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const { conversation_id, message } = await req.json();
    if (!conversation_id || !message?.trim()) {
      return new Response(JSON.stringify({ error: "conversation_id e message são obrigatórios" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load conversation + customer phone + unit
    const { data: conv, error: convErr } = await supabase
      .from("conversations")
      .select("id, unit_id, status, messages, customer:customers(phone)")
      .eq("id", conversation_id)
      .maybeSingle();

    if (convErr || !conv) {
      return new Response(JSON.stringify({ error: "conversa não encontrada" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify caller is a member of this unit
    const { data: isMember } = await supabase.rpc("is_unit_member", {
      p_user_id: user.id,
      p_unit_id: conv.unit_id,
    });
    if (!isMember) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Only allow sending when conversation is in human hands
    if (conv.status !== "human_active" && conv.status !== "awaiting_human") {
      return new Response(JSON.stringify({ error: "conversa não está em atendimento humano" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // deno-lint-ignore no-explicit-any
    const customerPhone: string = (conv.customer as any)?.phone ?? "";
    if (!customerPhone) {
      return new Response(JSON.stringify({ error: "telefone do cliente não encontrado" }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Send WhatsApp message
    const sent = await sendWhatsAppViaUnit(supabase, conv.unit_id, customerPhone, message.trim());
    if (!sent) {
      jsonLog("error", { evt: "manual_send_failed", convId: conversation_id, phone: sanitizePhone(customerPhone) });
      return new Response(JSON.stringify({ error: "falha ao enviar mensagem WhatsApp" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Append human message to conversation history
    const now = new Date().toISOString();
    const humanMsg = {
      role: "human",
      content: message.trim(),
      timestamp: now,
      human_user_id: user.id,
    };
    const updatedMessages = [...(conv.messages || []), humanMsg];

    await supabase
      .from("conversations")
      .update({
        messages: updatedMessages,
        status: "human_active",
        last_message_at: now,
        updated_at: now,
      })
      .eq("id", conversation_id);

    jsonLog("info", { evt: "human_replied", convId: conversation_id, userId: user.id });

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    jsonLog("error", { evt: "send_manual_message_error", err: String(err) });
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
