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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse({ error: "Não autenticado." }, 401);

    const { data: callerData, error: callerErr } = await supabase.auth.getUser(jwt);
    if (callerErr || !callerData.user) {
      return jsonResponse({ error: "Sessão inválida." }, 401);
    }
    const caller = callerData.user;

    const { data: callerRow, error: roleErr } = await supabase
      .from("admin_users")
      .select("role")
      .eq("id", caller.id)
      .maybeSingle();

    if (roleErr) {
      console.error("role lookup error", roleErr);
      return jsonResponse({ error: "Erro ao validar permissão." }, 500);
    }
    if (!callerRow || callerRow.role !== "super_admin") {
      return jsonResponse({ error: "Apenas o super admin pode gerenciar usuários." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action = body?.action as string | undefined;

    if (action === "create_admin") {
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");

      if (!email || !password) {
        return jsonResponse({ error: "E-mail e senha são obrigatórios." }, 400);
      }
      if (password.length < 6) {
        return jsonResponse({ error: "Senha deve ter pelo menos 6 caracteres." }, 400);
      }

      const { data: created, error: createErr } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (createErr || !created.user) {
        return jsonResponse(
          { error: createErr?.message ?? "Falha ao criar usuário no Auth." },
          400
        );
      }

      const { error: insertErr } = await supabase.from("admin_users").insert({
        id: created.user.id,
        email,
        role: "admin",
        created_by: caller.id,
      });

      if (insertErr) {
        // rollback auth user so state stays consistent
        await supabase.auth.admin.deleteUser(created.user.id);
        return jsonResponse({ error: insertErr.message }, 500);
      }

      return jsonResponse({ success: true, id: created.user.id });
    }

    if (action === "delete_admin") {
      const id = String(body.id ?? "");
      if (!id) return jsonResponse({ error: "ID é obrigatório." }, 400);
      if (id === caller.id) {
        return jsonResponse({ error: "Você não pode excluir a si mesmo." }, 400);
      }

      const { data: target, error: targetErr } = await supabase
        .from("admin_users")
        .select("role")
        .eq("id", id)
        .maybeSingle();

      if (targetErr) return jsonResponse({ error: targetErr.message }, 500);
      if (!target) return jsonResponse({ error: "Admin não encontrado." }, 404);
      if (target.role === "super_admin") {
        return jsonResponse({ error: "Não é permitido excluir um super admin." }, 400);
      }

      const { error: deleteErr } = await supabase.auth.admin.deleteUser(id);
      if (deleteErr) return jsonResponse({ error: deleteErr.message }, 500);

      // admin_users row is removed automatically via on delete cascade
      return jsonResponse({ success: true });
    }

    return jsonResponse({ error: "Ação inválida." }, 400);
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: String(err) }, 500);
  }
});
