import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function getCallerRole(userId: string, unitId: string): Promise<string | null> {
  const { data } = await supabase
    .from("unit_members")
    .select("role")
    .eq("user_id", userId)
    .eq("unit_id", unitId)
    .maybeSingle();

  // Platform admins can act as owners on any unit
  if (!data) {
    const { data: pa } = await supabase
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (pa) return "owner";
  }

  return data?.role ?? null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse({ error: "Não autenticado." }, 401);

    const { data: callerData, error: callerErr } = await supabase.auth.getUser(jwt);
    if (callerErr || !callerData.user) return jsonResponse({ error: "Sessão inválida." }, 401);
    const callerId = callerData.user.id;

    const body = await req.json().catch(() => ({}));
    const { action, unit_id: unitId } = body;

    if (!unitId) return jsonResponse({ error: "unit_id é obrigatório." }, 400);

    const callerRole = await getCallerRole(callerId, unitId);
    if (!callerRole) return jsonResponse({ error: "Sem acesso a esta unidade." }, 403);

    // ── create_member: requires owner ──────────────────────────────────────────
    if (action === "create_member") {
      if (callerRole !== "owner") {
        return jsonResponse({ error: "Apenas o proprietário pode adicionar membros." }, 403);
      }

      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      const role = body.role ?? "operador";

      if (!email || !password) return jsonResponse({ error: "E-mail e senha são obrigatórios." }, 400);
      if (password.length < 6) return jsonResponse({ error: "Senha deve ter pelo menos 6 caracteres." }, 400);
      if (!["gerente", "operador"].includes(role)) return jsonResponse({ error: "Papel inválido." }, 400);

      const { data: created, error: createErr } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (createErr || !created.user) {
        return jsonResponse({ error: createErr?.message ?? "Falha ao criar usuário." }, 400);
      }

      const { error: insertErr } = await supabase.from("unit_members").insert({
        user_id: created.user.id,
        unit_id: unitId,
        role,
      });

      if (insertErr) {
        await supabase.auth.admin.deleteUser(created.user.id);
        return jsonResponse({ error: insertErr.message }, 500);
      }

      return jsonResponse({ success: true, id: created.user.id });
    }

    // ── delete_member: requires owner ──────────────────────────────────────────
    if (action === "delete_member") {
      if (callerRole !== "owner") {
        return jsonResponse({ error: "Apenas o proprietário pode remover membros." }, 403);
      }

      const memberId = String(body.member_id ?? "");
      if (!memberId) return jsonResponse({ error: "member_id é obrigatório." }, 400);

      const { data: member } = await supabase
        .from("unit_members")
        .select("user_id, role")
        .eq("id", memberId)
        .eq("unit_id", unitId)
        .maybeSingle();

      if (!member) return jsonResponse({ error: "Membro não encontrado." }, 404);
      if (member.role === "owner") return jsonResponse({ error: "Não é permitido remover o proprietário." }, 400);
      if (member.user_id === callerId) return jsonResponse({ error: "Você não pode remover a si mesmo." }, 400);

      const { error: delErr } = await supabase
        .from("unit_members")
        .delete()
        .eq("id", memberId);

      if (delErr) return jsonResponse({ error: delErr.message }, 500);
      return jsonResponse({ success: true });
    }

    // ── update_role: requires owner ────────────────────────────────────────────
    if (action === "update_role") {
      if (callerRole !== "owner") {
        return jsonResponse({ error: "Apenas o proprietário pode alterar papéis." }, 403);
      }

      const memberId = String(body.member_id ?? "");
      const newRole = body.role;
      if (!memberId || !newRole) return jsonResponse({ error: "member_id e role são obrigatórios." }, 400);
      if (!["gerente", "operador"].includes(newRole)) return jsonResponse({ error: "Papel inválido." }, 400);

      const { data: member } = await supabase
        .from("unit_members")
        .select("role")
        .eq("id", memberId)
        .eq("unit_id", unitId)
        .maybeSingle();

      if (!member) return jsonResponse({ error: "Membro não encontrado." }, 404);
      if (member.role === "owner") return jsonResponse({ error: "Não é possível alterar o papel do proprietário." }, 400);

      const { error: updateErr } = await supabase
        .from("unit_members")
        .update({ role: newRole })
        .eq("id", memberId);

      if (updateErr) return jsonResponse({ error: updateErr.message }, 500);
      return jsonResponse({ success: true });
    }

    return jsonResponse({ error: "Ação inválida." }, 400);
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: String(err) }, 500);
  }
});
