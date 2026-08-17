import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { corsHeadersFor } from "../_shared/cors.ts";
import { isValidTaxId, normalizeTaxId } from "../_shared/tax-id.ts";
import { getWhatsAppProvider } from "../_shared/whatsapp-providers.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

function jsonResponse(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

function slugValid(s: string) {
  return /^[a-z0-9-]+$/.test(s) && s.length >= 2 && s.length <= 60;
}

const DEFAULT_WHATSAPP_PROVIDERS = new Set(["zapi", "uazapi"]);

function parseDefaultWhatsAppProvider(value: unknown): string | null {
  const provider = String(value ?? "").trim().toLowerCase();
  return DEFAULT_WHATSAPP_PROVIDERS.has(provider) ? provider : null;
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
    return new Response(null, { headers: corsHeadersFor(req) });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse(req, { error: "Não autenticado." }, 401);

    const { data: callerData, error: callerErr } = await supabase.auth.getUser(jwt);
    if (callerErr || !callerData.user) return jsonResponse(req, { error: "Sessão inválida." }, 401);
    const callerId = callerData.user.id;

    if (!(await isPlatformAdmin(callerId))) {
      return jsonResponse(req, { error: "Acesso restrito a administradores da plataforma." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const { action } = body;

    // ── list_organizations ──────────────────────────────────────────────────────
    if (action === "list_organizations") {
      const { data, error } = await supabase
        .from("organizations")
        .select(`
          id, name, slug, plan, default_whatsapp_provider, created_at,
          units(id, slug, name,
            unit_members(id)
          )
        `)
        .order("created_at", { ascending: true })
        .order("name", { ascending: true, referencedTable: "units" });

      if (error) return jsonResponse(req, { error: error.message }, 500);

      const rows = (data ?? []).map((org: any) => ({
        id: org.id,
        name: org.name,
        slug: org.slug,
        plan: org.plan,
        default_whatsapp_provider: org.default_whatsapp_provider,
        default_whatsapp_provider_label: getWhatsAppProvider(
          String(org.default_whatsapp_provider ?? "zapi"),
        ).label,
        created_at: org.created_at,
        units_count: (org.units ?? []).length,
        members_count: (org.units ?? []).reduce(
          (acc: number, u: any) => acc + (u.unit_members ?? []).length,
          0
        ),
        first_unit_slug: (org.units ?? [])[0]?.slug ?? null,
      }));

      return jsonResponse(req, { organizations: rows });
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
      const taxId = normalizeTaxId(String(body.tax_id ?? ""));
      const billingEmail = String(body.billing_email ?? "").trim().toLowerCase();
      const defaultWhatsappProvider = parseDefaultWhatsAppProvider(
        body.default_whatsapp_provider ?? "zapi",
      );

      if (!orgName) return jsonResponse(req, { error: "Nome da empresa é obrigatório." }, 400);
      if (!slugValid(orgSlug)) return jsonResponse(req, { error: "Slug da empresa inválido (letras minúsculas, números e hífens)." }, 400);
      if (!unitName) return jsonResponse(req, { error: "Nome da unidade é obrigatório." }, 400);
      if (!slugValid(unitSlug)) return jsonResponse(req, { error: "Slug da unidade inválido." }, 400);
      if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
        return jsonResponse(req, { error: "E-mail do proprietário inválido." }, 400);
      }
      if (ownerPassword.length < 10) {
        return jsonResponse(req, { error: "Senha deve ter pelo menos 10 caracteres." }, 400);
      }
      if (!isValidTaxId(taxId)) {
        return jsonResponse(req, { error: "CPF/CNPJ da empresa é inválido." }, 400);
      }
      if (!billingEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billingEmail)) {
        return jsonResponse(req, { error: "E-mail de cobrança inválido." }, 400);
      }
      if (!defaultWhatsappProvider) {
        return jsonResponse(req, { error: "Provider padrão do WhatsApp inválido." }, 400);
      }

      // 1. Criar auth user do owner.
      // Exceção à regra de não vazar error.message: o Supabase Auth retorna
      // mensagens já amigáveis ("User already registered", "Password is too weak"
      // etc.) que o super-admin precisa ver para reagir.
      const { data: created, error: createErr } = await supabase.auth.admin.createUser({
        email: ownerEmail,
        password: ownerPassword,
        email_confirm: true,
      });
      if (createErr || !created.user) {
        return jsonResponse(req, { error: createErr?.message ?? "Falha ao criar usuário." }, 400);
      }
      const ownerId = created.user.id;

      // 2. Criar organization (com rollback em falha)
      const { data: org, error: orgErr } = await supabase
        .from("organizations")
        .insert({
          name: orgName,
          slug: orgSlug,
          billing_email: billingEmail,
          default_whatsapp_provider: defaultWhatsappProvider,
        })
        .select("id")
        .single();

      if (orgErr || !org) {
        console.error("manage-organizations:create org insert failed", orgErr);
        await supabase.auth.admin.deleteUser(ownerId).catch((e) =>
          console.error("manage-organizations:rollback deleteUser failed", e)
        );
        return jsonResponse(req, { error: "Falha ao criar empresa." }, 500);
      }

      // A preferência não provisiona nada, mas é a decisão administrativa
      // auditável que autoriza o owner/gerente a iniciar UazAPI depois. A RPC
      // grava escolha + ledger na mesma transação.
      const { error: providerAuditErr } = await supabase.rpc(
        "set_organization_default_whatsapp_provider",
        {
          p_organization_id: org.id,
          p_provider: defaultWhatsappProvider,
          p_actor_id: callerData.user.id,
          p_request_id: crypto.randomUUID(),
        },
      );
      if (providerAuditErr) {
        console.error("manage-organizations:create provider audit failed", providerAuditErr);
        await supabase.from("organizations").delete().eq("id", org.id);
        await supabase.auth.admin.deleteUser(ownerId).catch((e) =>
          console.error("manage-organizations:rollback deleteUser failed", e)
        );
        return jsonResponse(req, { error: "Falha ao registrar preferência do WhatsApp." }, 500);
      }

      // 3. Criar unit
      const { data: unit, error: unitErr } = await supabase
        .from("units")
        .insert({ organization_id: org.id, name: unitName, slug: unitSlug, timezone })
        .select("id")
        .single();

      if (unitErr || !unit) {
        console.error("manage-organizations:create unit insert failed", unitErr);
        await supabase.from("organizations").delete().eq("id", org.id).then(({ error }) => {
          if (error) console.error("manage-organizations:rollback deleteOrg failed", error);
        });
        await supabase.auth.admin.deleteUser(ownerId).catch((e) =>
          console.error("manage-organizations:rollback deleteUser failed", e)
        );
        return jsonResponse(req, { error: "Falha ao criar unidade." }, 500);
      }

      // 4. Criar unit_member owner
      const { error: memberErr } = await supabase.from("unit_members").insert({
        user_id: ownerId,
        unit_id: unit.id,
        role: "owner",
      });

      if (memberErr) {
        console.error("manage-organizations:create unit_member insert failed", memberErr);
        await supabase.from("units").delete().eq("id", unit.id).then(({ error }) => {
          if (error) console.error("manage-organizations:rollback deleteUnit failed", error);
        });
        await supabase.from("organizations").delete().eq("id", org.id).then(({ error }) => {
          if (error) console.error("manage-organizations:rollback deleteOrg failed", error);
        });
        await supabase.auth.admin.deleteUser(ownerId).catch((e) =>
          console.error("manage-organizations:rollback deleteUser failed", e)
        );
        return jsonResponse(req, { error: "Falha ao vincular proprietário à unidade." }, 500);
      }

      // 4.5. Criar billing_customer com o documento fiscal.
      // Antes desta fase a linha só nascia quando um admin abria BillingDetail e
      // salvava à mão — e sem tax_id o checkout Asaas falha antes da primeira
      // chamada de API (billing-provider.ts valida cpfCnpj e recusa).
      // Falha aqui NÃO faz rollback: a org é utilizável sem billing_customer, e
      // o admin pode criar depois em BillingDetail. Só loga.
      const { error: customerErr } = await supabase.from("billing_customers").insert({
        organization_id: org.id,
        name: orgName,
        email: billingEmail,
        tax_id: taxId,
      });
      if (customerErr) {
        console.error("manage-organizations:create billing_customer insert failed", customerErr);
      }

      // 5. Auto-aplicar plano trial automático (se cadastrado).
      // Busca o plano com is_trial=true AND active=true. UNIQUE PARTIAL garante
      // no máximo 1. Se não houver plano trial, org nasce em billing_status
      // 'active' (default) — fallback seguro. Falha aqui não rollback as etapas
      // anteriores (admin pode aplicar trial manual via extend_trial override).
      const { data: trialPlan } = await supabase
        .from("billing_plans")
        .select("trial_days")
        .eq("is_trial", true)
        .eq("active", true)
        .maybeSingle();

      let trialApplied = false;
      if (trialPlan && trialPlan.trial_days > 0) {
        const trialEndsAt = new Date(Date.now() + trialPlan.trial_days * 86400000).toISOString();
        const { error: trialErr } = await supabase
          .from("organizations")
          .update({
            billing_status: "trialing",
            trial_ends_at: trialEndsAt,
          })
          .eq("id", org.id);

        if (trialErr) {
          console.error("manage-organizations:auto trial apply failed", trialErr);
        } else {
          trialApplied = true;
        }
      }

      return jsonResponse(req, {
        success: true,
        organization_id: org.id,
        unit_id: unit.id,
        owner_id: ownerId,
        trial_applied: trialApplied,
        billing_customer_created: !customerErr,
      });
    }

    // ── update_organization ─────────────────────────────────────────────────────
    if (action === "update_organization") {
      const orgId = String(body.org_id ?? "").trim();
      const orgName = String(body.org_name ?? "").trim();
      const plan = body.plan ? String(body.plan).trim() : undefined;
      const hasDefaultWhatsappProvider = body.default_whatsapp_provider !== undefined;
      const defaultWhatsappProvider = hasDefaultWhatsappProvider
        ? parseDefaultWhatsAppProvider(body.default_whatsapp_provider)
        : null;

      if (!orgId) return jsonResponse(req, { error: "org_id é obrigatório." }, 400);
      if (!orgName) return jsonResponse(req, { error: "Nome da empresa é obrigatório." }, 400);
      if (hasDefaultWhatsappProvider && !defaultWhatsappProvider) {
        return jsonResponse(req, { error: "Provider padrão do WhatsApp inválido." }, 400);
      }

      const updatePayload: Record<string, string> = { name: orgName };
      if (plan) updatePayload.plan = plan;
      const { error: updateErr } = await supabase
        .from("organizations")
        .update(updatePayload)
        .eq("id", orgId);

      if (updateErr) {
        console.error("manage-organizations:update", updateErr);
        return jsonResponse(req, { error: "Falha ao atualizar empresa." }, 500);
      }

      if (defaultWhatsappProvider) {
        const { error: providerErr } = await supabase.rpc(
          "set_organization_default_whatsapp_provider",
          {
            p_organization_id: orgId,
            p_provider: defaultWhatsappProvider,
            p_actor_id: callerData.user.id,
            p_request_id: crypto.randomUUID(),
          },
        );
        if (providerErr) {
          console.error("manage-organizations:update provider", providerErr);
          return jsonResponse(req, {
            error: "Empresa atualizada, mas a preferência do WhatsApp precisa ser reconciliada.",
            code: "WHATSAPP_PROVIDER_RECONCILIATION_REQUIRED",
          }, 500);
        }
      }
      return jsonResponse(req, { success: true });
    }

    return jsonResponse(req, { error: "Ação inválida." }, 400);
  } catch (err) {
    console.error("manage-organizations unhandled", err);
    return jsonResponse(req, { error: "Falha ao processar solicitação." }, 500);
  }
});
