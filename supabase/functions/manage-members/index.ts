import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { corsHeadersFor } from "../_shared/cors.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

function jsonResponse(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
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
    return new Response(null, { headers: corsHeadersFor(req) });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse(req, { error: "Não autenticado." }, 401);

    const { data: callerData, error: callerErr } = await supabase.auth.getUser(jwt);
    if (callerErr || !callerData.user) return jsonResponse(req, { error: "Sessão inválida." }, 401);
    const callerId = callerData.user.id;

    const body = await req.json().catch(() => ({}));
    const { action, unit_id: unitId } = body;

    if (!unitId) return jsonResponse(req, { error: "unit_id é obrigatório." }, 400);

    const callerRole = await getCallerRole(callerId, unitId);
    if (!callerRole) return jsonResponse(req, { error: "Sem acesso a esta unidade." }, 403);

    // ── create_member: requires owner ──────────────────────────────────────────
    if (action === "create_member") {
      if (callerRole !== "owner") {
        return jsonResponse(req, { error: "Apenas o proprietário pode adicionar membros." }, 403);
      }

      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      const role = body.role ?? "operador";
      const name = body.name != null ? String(body.name).trim() : null;

      if (!email || !password) return jsonResponse(req, { error: "E-mail e senha são obrigatórios." }, 400);
      if (!EMAIL_RE.test(email)) return jsonResponse(req, { error: "Formato de e-mail inválido." }, 400);
      if (password.length < 6) return jsonResponse(req, { error: "Senha deve ter pelo menos 6 caracteres." }, 400);
      if (!["gerente", "operador"].includes(role)) return jsonResponse(req, { error: "Papel inválido." }, 400);

      let userId: string;
      let reused = false;

      const { data: created, error: createErr } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

      if (createErr || !created?.user) {
        const errCode = (createErr as { code?: string } | null)?.code;
        const status = (createErr as { status?: number } | null)?.status;
        const errMsg = (createErr?.message ?? "").toLowerCase();

        // Prefere detecção estruturada (Supabase auth v2): code === "email_exists" ou status 422.
        // Mantém fallback string-match apenas como segunda linha — se disparar, loga warn
        // para que a próxima quebra do contrato fique visível em produção.
        let isDuplicate = errCode === "email_exists" || status === 422;
        if (!isDuplicate && (errMsg.includes("already registered") || errMsg.includes("already exists"))) {
          console.warn("[manage-members] duplicate detected via fallback string-match", { errMsg, errCode, status });
          isDuplicate = true;
        }

        if (!isDuplicate) {
          console.error("[manage-members] create_user failed", createErr);
          return jsonResponse(req, { error: "Não foi possível criar o usuário. Tente novamente." }, 400);
        }

        const { data: existingId, error: rpcErr } = await supabase.rpc("find_auth_user_by_email", {
          p_email: email,
        });
        if (rpcErr || !existingId) {
          return jsonResponse(
            req,
            { error: "E-mail já cadastrado, mas não foi possível localizá-lo." },
            500
          );
        }
        userId = existingId as string;
        reused = true;
      } else {
        userId = created.user.id;
      }

      const { error: insertErr } = await supabase.from("unit_members").insert({
        user_id: userId,
        unit_id: unitId,
        role,
        email,
        name: name || null,
      });

      if (insertErr) {
        if (!reused) await supabase.auth.admin.deleteUser(userId);
        const isUniqueViolation = (insertErr as { code?: string }).code === "23505";
        const status = isUniqueViolation ? 409 : 500;
        const message = isUniqueViolation
          ? "Este e-mail já é membro desta unidade."
          : insertErr.message;
        return jsonResponse(req, { error: message }, status);
      }

      return jsonResponse(req, { success: true, id: userId, reused });
    }

    // ── update_member: nome (owner+gerente; gerente só edita a si mesmo) ──────
    if (action === "update_member") {
      const memberId = String(body.member_id ?? "");
      if (!memberId) return jsonResponse(req, { error: "member_id é obrigatório." }, 400);

      const name = body.name != null ? String(body.name).trim() : null;

      const { data: member } = await supabase
        .from("unit_members")
        .select("user_id, role")
        .eq("id", memberId)
        .eq("unit_id", unitId)
        .maybeSingle();

      if (!member) return jsonResponse(req, { error: "Membro não encontrado." }, 404);

      // owner pode editar qualquer um; gerente só a si mesmo; operador nada
      const isSelf = member.user_id === callerId;
      const canEdit =
        callerRole === "owner" || (callerRole === "gerente" && isSelf);

      if (!canEdit) {
        return jsonResponse(req, { error: "Sem permissão para editar este membro." }, 403);
      }

      const { error: updateErr } = await supabase
        .from("unit_members")
        .update({ name: name || null })
        .eq("id", memberId);

      if (updateErr) return jsonResponse(req, { error: updateErr.message }, 500);
      return jsonResponse(req, { success: true });
    }

    // ── delete_member: requires owner ──────────────────────────────────────────
    if (action === "delete_member") {
      if (callerRole !== "owner") {
        return jsonResponse(req, { error: "Apenas o proprietário pode remover membros." }, 403);
      }

      const memberId = String(body.member_id ?? "");
      if (!memberId) return jsonResponse(req, { error: "member_id é obrigatório." }, 400);

      const { data: member } = await supabase
        .from("unit_members")
        .select("user_id, role")
        .eq("id", memberId)
        .eq("unit_id", unitId)
        .maybeSingle();

      if (!member) return jsonResponse(req, { error: "Membro não encontrado." }, 404);
      if (member.role === "owner") return jsonResponse(req, { error: "Não é permitido remover o proprietário." }, 400);
      if (member.user_id === callerId) return jsonResponse(req, { error: "Você não pode remover a si mesmo." }, 400);

      const { error: delErr } = await supabase
        .from("unit_members")
        .delete()
        .eq("id", memberId);

      if (delErr) return jsonResponse(req, { error: delErr.message }, 500);
      return jsonResponse(req, { success: true });
    }

    // ── update_role: requires owner ────────────────────────────────────────────
    if (action === "update_role") {
      if (callerRole !== "owner") {
        return jsonResponse(req, { error: "Apenas o proprietário pode alterar papéis." }, 403);
      }

      const memberId = String(body.member_id ?? "");
      const newRole = body.role;
      if (!memberId || !newRole) return jsonResponse(req, { error: "member_id e role são obrigatórios." }, 400);
      if (!["gerente", "operador"].includes(newRole)) return jsonResponse(req, { error: "Papel inválido." }, 400);

      const { data: member } = await supabase
        .from("unit_members")
        .select("role")
        .eq("id", memberId)
        .eq("unit_id", unitId)
        .maybeSingle();

      if (!member) return jsonResponse(req, { error: "Membro não encontrado." }, 404);
      if (member.role === "owner") return jsonResponse(req, { error: "Não é possível alterar o papel do proprietário." }, 400);

      const { error: updateErr } = await supabase
        .from("unit_members")
        .update({ role: newRole })
        .eq("id", memberId);

      if (updateErr) return jsonResponse(req, { error: updateErr.message }, 500);
      return jsonResponse(req, { success: true });
    }

    return jsonResponse(req, { error: "Ação inválida." }, 400);
  } catch (err) {
    console.error(err);
    return jsonResponse(req, { error: String(err) }, 500);
  }
});
