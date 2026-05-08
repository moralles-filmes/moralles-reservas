import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendWhatsApp } from "../_shared/whatsapp-send.ts";
import { jsonLog, sanitizePhone } from "../_shared/security.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

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

    // Send WhatsApp message via shared helper (canal da unit, com fallback ZAPI legacy)
    const result = await sendWhatsApp(customerPhone, message.trim(), { unit_id: conv.unit_id });
    if (!result.ok) {
      jsonLog("error", {
        evt: "manual_send_failed",
        convId: conversation_id,
        phone: sanitizePhone(customerPhone),
        error: result.error,
        status: result.status,
        missingCreds: result.missingCreds,
      });
      return new Response(
        JSON.stringify({ error: "falha ao enviar mensagem WhatsApp", reason: result.error }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
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
