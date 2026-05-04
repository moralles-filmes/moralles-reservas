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

function slugValid(s: string) {
  return /^[a-z0-9-]+$/.test(s) && s.length >= 2 && s.length <= 60;
}

async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
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

    if (!(await isPlatformAdmin(callerId))) {
      return jsonResponse({ error: "Acesso restrito a administradores da plataforma." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const { action } = body;

    // ── list_organizations ──────────────────────────────────────────────────────
    if (action === "list_organizations") {
      const { data, error } = await supabase
        .from("organizations")
        .select(`
          id, name, slug, plan, created_at,
          units(id, slug, name,
            unit_members(id)
          )
        `)
        .order("created_at", { ascending: true });

      if (error) return jsonResponse({ error: error.message }, 500);

      const rows = (data ?? []).map((org: any) => ({
        id: org.id,
        name: org.name,
        slug: org.slug,
        plan: org.plan,
        created_at: org.created_at,
        units_count: (org.units ?? []).length,
        members_count: (org.units ?? []).reduce(
          (acc: number, u: any) => acc + (u.unit_members ?? []).length,
          0
        ),
        first_unit_slug: (org.units ?? [])[0]?.slug ?? null,
      }));

      return jsonResponse({ organizations: rows });
    }

    // ── create_organization ─────────────────────────────────────────────────────
    if (action === "create_organization") {
      const orgName = String(body.org_name ?? "").trim();
      const orgSlug = String(body.org_slug ?? "").trim();
      const unitName = String(body.unit_name ?? "").trim();
      const unitSlug = String(body.unit_slug ?? "").trim();
      const timezone = String(body.unit_timezone ?? "America/Sao_Paulo").trim();
      const ownerEmail = String(body.owner_email ?? "").trim().toLowerCase();
      const ownerPassword = String(body.owner_password ?? "");

      if (!orgName) return jsonResponse({ error: "Nome da empresa é obrigatório." }, 400);
      if (!slugValid(orgSlug)) return jsonResponse({ error: "Slug da empresa inválido (letras minúsculas, números e hífens)." }, 400);
      if (!unitName) return jsonResponse({ error: "Nome da unidade é obrigatório." }, 400);
      if (!slugValid(unitSlug)) return jsonResponse({ error: "Slug da unidade inválido." }, 400);
      if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
        return jsonResponse({ error: "E-mail do proprietário inválido." }, 400);
      }
      if (ownerPassword.length < 6) {
        return jsonResponse({ error: "Senha deve ter pelo menos 6 caracteres." }, 400);
      }

      // 1. Criar auth user do owner
      const { data: created, error: createErr } = await supabase.auth.admin.createUser({
        email: ownerEmail,
        password: ownerPassword,
        email_confirm: true,
      });
      if (createErr || !created.user) {
        return jsonResponse({ error: createErr?.message ?? "Falha ao criar usuário." }, 400);
      }
      const ownerId = created.user.id;

      // 2. Criar organization (com rollback em falha)
      const { data: org, error: orgErr } = await supabase
        .from("organizations")
        .insert({ name: orgName, slug: orgSlug })
        .select("id")
        .single();

      if (orgErr || !org) {
        await supabase.auth.admin.deleteUser(ownerId);
        return jsonResponse({ error: orgErr?.message ?? "Falha ao criar organização." }, 400);
      }

      // 3. Criar unit
      const { data: unit, error: unitErr } = await supabase
        .from("units")
        .insert({ organization_id: org.id, name: unitName, slug: unitSlug, timezone })
        .select("id")
        .single();

      if (unitErr || !unit) {
        await supabase.from("organizations").delete().eq("id", org.id);
        await supabase.auth.admin.deleteUser(ownerId);
        return jsonResponse({ error: unitErr?.message ?? "Falha ao criar unidade." }, 400);
      }

      // 4. Criar unit_member owner
      const { error: memberErr } = await supabase.from("unit_members").insert({
        user_id: ownerId,
        unit_id: unit.id,
        role: "owner",
      });

      if (memberErr) {
        await supabase.from("units").delete().eq("id", unit.id);
        await supabase.from("organizations").delete().eq("id", org.id);
        await supabase.auth.admin.deleteUser(ownerId);
        return jsonResponse({ error: memberErr.message }, 500);
      }

      return jsonResponse({ success: true, organization_id: org.id, unit_id: unit.id, owner_id: ownerId });
    }

    // ── update_organization ─────────────────────────────────────────────────────
    if (action === "update_organization") {
      const orgId = String(body.org_id ?? "").trim();
      const orgName = String(body.org_name ?? "").trim();
      const plan = body.plan ? String(body.plan).trim() : undefined;

      if (!orgId) return jsonResponse({ error: "org_id é obrigatório." }, 400);
      if (!orgName) return jsonResponse({ error: "Nome da empresa é obrigatório." }, 400);

      const updatePayload: Record<string, string> = { name: orgName };
      if (plan) updatePayload.plan = plan;

      const { error: updateErr } = await supabase
        .from("organizations")
        .update(updatePayload)
        .eq("id", orgId);

      if (updateErr) return jsonResponse({ error: updateErr.message }, 500);
      return jsonResponse({ success: true });
    }

    return jsonResponse({ error: "Ação inválida." }, 400);
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: String(err) }, 500);
  }
});
