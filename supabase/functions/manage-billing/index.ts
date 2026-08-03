// Edge Function: manage-billing
// Gestao de billing/mensalidades da plataforma.
// Autentica via JWT, exige papel `platform_admin`.
// Billing usa conta principal da plataforma — nao Connected Account, nao transfer_data.
// Nao altera fluxo de caucao de reservas.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { genRequestId, jsonLog } from "../_shared/security.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import {
  createStripeCustomer,
  createStripeSubscription,
  createStripeInvoice,
  retrieveStripeSubscription,
  retrieveStripeInvoice,
  voidStripeInvoice,
} from "../_shared/stripe-billing.ts";
import { resolveOrgEntitlements } from "../_shared/entitlements.ts";
import { applyAsaasEvent } from "../_shared/asaas-billing-events-apply.ts";
import { isSystemSubscription, SYSTEM_CATEGORY } from "../_shared/billing-category.ts";
import { getBillingProvider } from "../_shared/billing-provider.ts";
import { decideCancelTarget, localCancelPatch, type CancelEffective } from "../_shared/billing-cancel-core.ts";
import { enqueueBillingNotification, resolvePlatformAdminRecipients } from "../_shared/billing-notify.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function jsonResponse(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

async function canManageOrgBilling(userId: string, organizationId: string): Promise<boolean> {
  return hasOrgBillingRole(userId, organizationId, ["owner", "gerente"]);
}

/**
 * Só `owner`. Existe porque `unit_members` é escopado por UNIDADE e
 * `organizations.billing_status` é escopado pela ORGANIZAÇÃO: um `gerente` de
 * uma única unidade de uma rede não pode cancelar a assinatura de sistema e
 * derrubar o painel das unidades irmãs — e do próprio dono. Enquanto o
 * cancelamento só marcava a linha em `billing_subscriptions` a diferença era
 * inócua; desde que ele cascateia pra `billing_status`, deixou de ser.
 */
async function canCancelOrgSubscription(userId: string, organizationId: string): Promise<boolean> {
  return hasOrgBillingRole(userId, organizationId, ["owner"]);
}

async function hasOrgBillingRole(
  userId: string,
  organizationId: string,
  roles: string[],
): Promise<boolean> {
  if (await isPlatformAdmin(userId)) return true;
  const { data } = await supabase
    .from("unit_members")
    .select("role, units!inner(organization_id)")
    .eq("user_id", userId)
    .in("role", roles)
    .eq("units.organization_id", organizationId)
    .limit(1);
  return !!(data && data.length > 0);
}

// Actions liberadas pra owner/gerente da org (não só platform_admin).
// Cada action client-friendly checa canManageOrgBilling no próprio handler.
//
// `list_plans` é a exceção: é o CATÁLOGO da plataforma, não tem organization_id
// no payload e portanto não tem o que checar contra a org do caller. Ela se
// protege moldando a RESPOSTA por papel (ver PLAN_PUBLIC_COLUMNS) — o cliente
// recebe só plano ativo e só campo de vitrine. Sem ela aqui, o PricingTable de
// /g/:slug/cobranca leva 403 e fica vazio pra todo owner/gerente não-admin.
const CLIENT_FRIENDLY_ACTIONS = new Set([
  "list_plans",
  "change_plan",
  "preview_plan_change",
  "cancel_subscription_by_owner",
  "get_org_entitlements",
  // `get_organization_billing` faz as DUAS coisas: checa canManageOrgBilling
  // contra a organization_id do payload E molda a resposta por papel. Precisa
  // das duas porque o payload admin agrega seis tabelas, entre elas
  // billing_access_overrides e billing_notifications — histórico administrativo
  // SOBRE o cliente, que ele não pode ler nem da própria org.
  "get_organization_billing",
]);

// ── billing_plans: colunas e enums ──────────────────────────────────────────
// Espelham a migration 063. Divergir daqui devolve 23514 (CHECK) do Postgres
// como 500 genérico, então validamos antes pra dar mensagem útil.
const PLAN_CATEGORIES = new Set([
  "SYSTEM_SUBSCRIPTION",
  "WHATSAPP_IMPLEMENTATION",
  "WHATSAPP_SUBSCRIPTION",
  "AI_CREDIT_PACKAGE",
  "TRIAL",
  "CUSTOM",
]);
const PLAN_PROVIDERS = new Set(["stripe", "asaas", "manual", "lifetime"]);
const PLAN_BILLING_TYPES = new Set(["recurring", "one_time"]);
const PLAN_INTERVALS = new Set(["month", "year"]);

// Colunas graváveis por create_plan/update_plan. Whitelist explícita: o
// update_plan fazia spread cru do body, então qualquer chave virava coluna.
const PLAN_WRITABLE_COLUMNS = [
  "name", "slug", "description", "amount_cents", "currency", "interval",
  "stripe_price_id_card", "stripe_price_id_boleto", "stripe_price_id_pix",
  "max_units", "max_members_per_unit", "features", "trial_days", "popular",
  "is_trial", "active", "sort_order",
  // migration 063 (Fase 1 billing-asaas)
  "category", "provider", "billing_type", "amount_credited_cents",
  "recommended", "requires_plan_id", "provider_metadata",
] as const;

// Campos devolvidos a caller NÃO-admin. Omite os Price IDs da Stripe e o
// provider_metadata (config interna do provedor) — o cliente só precisa da
// vitrine. `active_subscriptions` também é só do admin: quantos clientes cada
// plano tem é informação de negócio da plataforma.
const PLAN_PUBLIC_COLUMNS =
  "id, name, slug, description, amount_cents, currency, interval, features, " +
  "trial_days, is_trial, active, sort_order, category, billing_type, " +
  "recommended, popular, amount_credited_cents, requires_plan_id, max_units, " +
  "max_members_per_unit";

// Colunas de `organizations` devolvidas a caller NÃO-admin em
// `get_organization_billing`. `select("*")` traria `billing_email`,
// `blocked_reason` e o histórico de grandfathering de WhatsApp — o lojista
// precisa só do estado de cobrança da própria org (o que `/g/:slug/cobranca`
// consome) mais nome e id pra rotular a tela.
const ORG_BILLING_PUBLIC_COLUMNS = "id, name, billing_status, trial_ends_at";

// Colunas de `billing_subscriptions` devolvidas a caller NÃO-admin. Omite os
// ids do provedor (`provider_subscription_id`, `stripe_subscription_id`) e o
// `billing_customer_id`: são a identidade do cliente DENTRO do gateway, não
// têm uso na tela e são exatamente o que um cliente não deve enxergar. O
// `provider` fica — a tela precisa dele pra não prometer fim de período onde
// ele não existe.
const SUBSCRIPTION_PUBLIC_COLUMNS =
  "id, organization_id, billing_plan_id, status, payment_method, provider, " +
  "current_period_start, current_period_end, trial_end, cancel_at_period_end, " +
  "canceled_at, created_at, updated_at";

// Aviso INTERNO: o provedor CANCELOU a assinatura e a escrita local falhou.
// Sem transação distribuída alguém fica na frente, e cancelar no provedor
// primeiro erra a favor do cliente — mas deixa o banco dizendo que a assinatura
// segue viva enquanto ninguém mais será cobrado. É divergência produzida pelo
// nosso próprio código, não pelo painel do provedor, e o `jsonLog` sozinho não
// avisa ninguém. `process-billing-notifications` precisa ter a entrada
// correspondente em `TEMPLATE_BY_EVENT` no MESMO deploy — as duas EFs não
// compartilham nada além desta string.
const ADMIN_CANCEL_DIVERGENCE_EVENT_TYPE = "admin_cancel_local_write_failed";

/**
 * Enfileira o aviso de divergência pra todos os platform_admins. Best-effort:
 * nunca lança — a resposta 500 ao caller já aconteceu, e falhar aqui não pode
 * transformar um erro conhecido em exceção não tratada.
 */
async function notifyCancelDivergence(orgId: string, reqId: string): Promise<void> {
  try {
    const recipients = await resolvePlatformAdminRecipients(supabase);
    for (const recipient of recipients) {
      await enqueueBillingNotification(supabase, {
        organizationId: orgId,
        eventType: ADMIN_CANCEL_DIVERGENCE_EVENT_TYPE,
        invoiceId: null,
        recipient,
      });
    }
  } catch (err) {
    jsonLog("error", {
      reqId, evt: "billing_cancel_divergence_notify_failed",
      orgId, err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Valida os enums de billing_plans. Devolve mensagem PT-BR ou null. */
function validatePlanEnums(fields: Record<string, unknown>): string | null {
  if (fields.category != null && !PLAN_CATEGORIES.has(String(fields.category))) {
    return "Categoria inválida.";
  }
  if (fields.provider != null && !PLAN_PROVIDERS.has(String(fields.provider))) {
    return "Provedor inválido.";
  }
  if (fields.billing_type != null && !PLAN_BILLING_TYPES.has(String(fields.billing_type))) {
    return "Tipo de cobrança inválido.";
  }
  if (fields.interval != null && !PLAN_INTERVALS.has(String(fields.interval))) {
    return "Intervalo inválido.";
  }
  for (const key of ["amount_cents", "amount_credited_cents", "trial_days"]) {
    const raw = fields[key];
    if (raw == null) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return "Valores monetários e de trial não podem ser negativos.";
  }
  return null;
}

/**
 * Traduz erro do Postgres em resposta útil.
 *
 * O 23505 aqui não é só slug duplicado: `billing_plans_only_one_active_trial` é
 * UNIQUE PARCIAL, então marcar um segundo plano como trial ativo cai no mesmo
 * código. O frontend tentava detectar isso pela string da mensagem, mas a EF
 * devolvia "Falha ao salvar plano." — o toast amigável nunca disparava.
 */
function planWriteError(
  err: { code?: string; message?: string },
): { message: string; status: number } | null {
  if (err.code === "23505") {
    if ((err.message ?? "").includes("only_one_active_trial")) {
      return {
        message: "Já existe um plano de trial automático ativo. Desative o atual antes.",
        status: 409,
      };
    }
    return { message: "Já existe um plano com esse slug.", status: 409 };
  }
  // 23514 vem de CHECKs com causas MUITO diferentes. A frase genérica abaixo
  // descreve os CHECKs da 063 (enums de categoria/provedor/intervalo) e mente
  // sobre os das 094/097 — quem ligasse o switch de um plano com franquia de IA
  // lia "valor inválido para categoria" e não tinha como descobrir que existe
  // um portão comercial. Discriminar pelo NOME da constraint na mensagem do
  // Postgres, nunca ecoando err.message cru pro cliente.
  if (err.code === "23514") {
    const detail = err.message ?? "";
    if (detail.includes("ai_plan_not_sellable")) {
      return {
        message:
          "Plano com franquia de IA não pode ser ativado enquanto o teto de custo por ciclo não estiver provado (Plano D).",
        status: 409,
      };
    }
    if (detail.includes("included_features_chk")) {
      return {
        message: "Funcionalidades inclusas inválidas: use apenas system, whatsapp e ai, sem valores nulos.",
        status: 400,
      };
    }
    if (detail.includes("included_connections_chk")) {
      return { message: "O número de conexões de WhatsApp inclusas não pode ser negativo.", status: 400 };
    }
    if (detail.includes("whatsapp_component_chk")) {
      return {
        message: "O componente de WhatsApp precisa ficar entre zero e o valor da mensalidade.",
        status: 400,
      };
    }
    return { message: "Valor inválido para categoria, provedor, intervalo ou tipo de cobrança.", status: 400 };
  }
  if (err.code === "23503") {
    return { message: "O plano pré-requisito informado não existe.", status: 400 };
  }
  return null;
}

// Helpers Stripe inline (pra preview_plan_change que não tem wrapper em stripe-billing.ts)
import { getStripeSecretKey } from "../_shared/stripe-config.ts";

async function stripeRequestRaw(
  path: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: Record<string, string>,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const secretKey = await getStripeSecretKey();
  if (!secretKey) throw new Error("Stripe não configurado.");
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (body) opts.body = new URLSearchParams(body).toString();
  const res = await fetch(`https://api.stripe.com/v1${path}`, opts);
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeadersFor(req) });
  }

  const reqId = genRequestId();

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse(req, { error: "Não autenticado." }, 401);

    const { data: callerData, error: callerErr } = await supabase.auth.getUser(jwt);
    if (callerErr || !callerData.user) {
      return jsonResponse(req, { error: "Sessão inválida." }, 401);
    }
    const callerId = callerData.user.id;

    const body = await req.json().catch(() => ({}));
    const { action } = body;

    // Bloqueia non-admins exceto pras client-friendly actions (cada uma checa
    // canManageOrgBilling no próprio handler com a organization_id do payload).
    const callerIsAdmin = await isPlatformAdmin(callerId);
    if (!callerIsAdmin && !CLIENT_FRIENDLY_ACTIONS.has(action)) {
      return jsonResponse(req, { error: "Apenas administradores da plataforma." }, 403);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // PLANS
    // ═════════════════════════════════════════════════════════════════════════

    if (action === "list_plans") {
      // Caller não-admin (owner/gerente na própria área de cobrança) enxerga só
      // plano ativo e só coluna de vitrine. Admin vê o catálogo inteiro.
      const query = callerIsAdmin
        ? supabase.from("billing_plans").select("*")
        : supabase.from("billing_plans").select(PLAN_PUBLIC_COLUMNS).eq("active", true);

      const { data, error } = await query.order("sort_order");

      if (error) {
        jsonLog("error", { reqId, evt: "billing_list_plans_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao listar planos." }, 500);
      }

      const plans = (data ?? []) as Record<string, unknown>[];
      if (!callerIsAdmin) {
        return jsonResponse(req, { success: true, plans });
      }

      // "Empresas usando": organizations distintas com assinatura não-cancelada.
      // FK é billing_plan_id (não plan_id). billing_subscriptions é FORCE RLS
      // sem policies — só service_role conta, por isso vem daqui e não do front.
      //
      // `.range()` em loop é obrigatório (invariante do CLAUDE.md): sem ele o
      // PostgREST trunca em db-max-rows (1000) SEM erro, e a coluna "Empresas
      // usando" passaria a subcontar em silêncio depois da milésima assinatura.
      const PAGE = 1000;
      const byPlan = new Map<string, Set<string>>();
      for (let from = 0; ; from += PAGE) {
        const { data: chunk, error: subsErr } = await supabase
          .from("billing_subscriptions")
          .select("billing_plan_id, organization_id")
          .neq("status", "canceled")
          .range(from, from + PAGE - 1);

        if (subsErr) {
          // Contagem é enriquecimento — nunca derruba a listagem do catálogo.
          jsonLog("error", { reqId, evt: "billing_list_plans_count_error", err: subsErr.message });
          return jsonResponse(req, { success: true, plans });
        }

        for (const sub of chunk ?? []) {
          const planId = String(sub.billing_plan_id);
          if (!byPlan.has(planId)) byPlan.set(planId, new Set());
          byPlan.get(planId)!.add(String(sub.organization_id));
        }

        if (!chunk || chunk.length < PAGE) break;
      }

      return jsonResponse(req, {
        success: true,
        plans: plans.map((p) => ({
          ...p,
          active_subscriptions: byPlan.get(String(p.id))?.size ?? 0,
        })),
      });
    }

    if (action === "create_plan") {
      const { name, slug, amount_cents } = body;
      if (!name || !slug || amount_cents == null) {
        return jsonResponse(req, { error: "name, slug e amount_cents são obrigatórios." }, 400);
      }

      // Whitelist em vez do destructuring campo-a-campo que existia aqui: ele
      // descartava em silêncio description, trial_days, popular e is_trial (a UI
      // mandava, o banco nunca via — criar um plano de trial pelo painel não
      // funcionava, só editar depois). Com a whitelist, coluna nova de migration
      // futura só precisa entrar em PLAN_WRITABLE_COLUMNS.
      const insertPayload: Record<string, unknown> = {};
      for (const col of PLAN_WRITABLE_COLUMNS) {
        if (body[col] !== undefined) insertPayload[col] = body[col];
      }
      insertPayload.amount_cents = Number(amount_cents);
      insertPayload.interval = body.interval ?? "month";
      insertPayload.features = body.features ?? [];
      insertPayload.sort_order = body.sort_order ?? 0;

      const invalid = validatePlanEnums(insertPayload);
      if (invalid) return jsonResponse(req, { error: invalid }, 400);

      const { data, error } = await supabase
        .from("billing_plans")
        .insert(insertPayload)
        .select()
        .single();

      if (error) {
        const known = planWriteError(error);
        if (known) return jsonResponse(req, { error: known.message }, known.status);
        jsonLog("error", { reqId, evt: "billing_create_plan_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao criar plano." }, 500);
      }
      jsonLog("info", { reqId, evt: "billing_plan_created", planId: data.id });
      return jsonResponse(req, { success: true, plan: data });
    }

    if (action === "update_plan") {
      const { plan_id } = body;
      if (!plan_id) return jsonResponse(req, { error: "plan_id é obrigatório." }, 400);

      // Antes era spread cru do body (`{plan_id, ...fields}`), o que deixava
      // qualquer chave do payload virar coluna. Whitelist explícita.
      const updatePayload: Record<string, unknown> = {};
      for (const col of PLAN_WRITABLE_COLUMNS) {
        if (body[col] !== undefined) updatePayload[col] = body[col];
      }
      if (Object.keys(updatePayload).length === 0) {
        return jsonResponse(req, { error: "Nada para atualizar." }, 400);
      }

      const invalid = validatePlanEnums(updatePayload);
      if (invalid) return jsonResponse(req, { error: invalid }, 400);

      // requires_plan_id é FK auto-referencial: plano pré-requisito de si mesmo
      // passa no CHECK e na FK, e só explodiria como ciclo no gate de checkout
      // da Fase 5. A UI já exclui o próprio plano do select — isto fecha o curl.
      if (updatePayload.requires_plan_id === plan_id) {
        return jsonResponse(req, { error: "Um plano não pode ser pré-requisito de si mesmo." }, 400);
      }

      updatePayload.updated_at = new Date().toISOString();

      const { data, error } = await supabase
        .from("billing_plans")
        .update(updatePayload)
        .eq("id", plan_id)
        .select()
        .single();

      if (error) {
        // Trigger da migration 074 (billing_plans_category_guard): recusa
        // mudar categoria de plano com assinatura não-cancelada. Discrimina
        // por MENSAGEM, não por código — o P0001 é o SQLSTATE genérico do
        // plpgsql e colide com `ambiguous_subscription_category` (migration
        // 073, RPC resolve_or_activate_subscription). `only_one_active_trial`
        // é outro erro, 23505 (UNIQUE parcial), tratado por planWriteError()
        // logo abaixo — não é o mesmo código.
        if (error.message?.includes("plan_category_locked")) {
          return jsonResponse(req, {
            error: "Não é possível mudar a categoria de um plano que já tem assinatura ativa. Desative o plano e crie um novo.",
          }, 409);
        }
        const known = planWriteError(error);
        if (known) return jsonResponse(req, { error: known.message }, known.status);
        jsonLog("error", { reqId, evt: "billing_update_plan_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao atualizar plano." }, 500);
      }
      return jsonResponse(req, { success: true, plan: data });
    }

    if (action === "deactivate_plan") {
      const { plan_id } = body;
      if (!plan_id) return jsonResponse(req, { error: "plan_id é obrigatório." }, 400);

      const { error } = await supabase
        .from("billing_plans")
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq("id", plan_id);

      if (error) {
        jsonLog("error", { reqId, evt: "billing_deactivate_plan_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao desativar plano." }, 500);
      }
      return jsonResponse(req, { success: true });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // ORGANIZATIONS BILLING
    // ═════════════════════════════════════════════════════════════════════════

    if (action === "list_organizations_billing") {
      const { status: filterStatus, plan_id: filterPlan, search, page = 0, page_size = 50 } = body;
      const from = Number(page) * Number(page_size);
      const to = from + Number(page_size) - 1;

      let query = supabase
        .from("organizations")
        .select("id, name, slug, plan, billing_status, billing_email, trial_ends_at, blocked_at, blocked_reason, created_at", { count: "exact" })
        .order("name")
        .range(from, to);

      if (filterStatus) query = query.eq("billing_status", filterStatus);
      if (search) query = query.ilike("name", `%${search}%`);

      const { data: orgs, error: orgsErr, count } = await query;
      if (orgsErr) {
        jsonLog("error", { reqId, evt: "billing_list_orgs_error", err: orgsErr.message });
        return jsonResponse(req, { error: "Falha ao listar organizações." }, 500);
      }

      const orgIds = (orgs ?? []).map((o: Record<string, unknown>) => o.id as string);
      let customers: Record<string, unknown>[] = [];
      let subscriptions: Record<string, unknown>[] = [];

      if (orgIds.length > 0) {
        const { data: c } = await supabase
          .from("billing_customers")
          .select("organization_id, stripe_customer_id, email")
          .in("organization_id", orgIds);
        customers = c ?? [];

        const { data: s } = await supabase
          .from("billing_subscriptions")
          .select("organization_id, billing_plan_id, status, payment_method, current_period_end, cancel_at_period_end")
          .in("organization_id", orgIds)
          .neq("status", "canceled");
        subscriptions = s ?? [];
      }

      let plans: Record<string, unknown>[] = [];
      if (filterPlan || subscriptions.length > 0) {
        const { data: p } = await supabase.from("billing_plans").select("id, name, slug, amount_cents");
        plans = p ?? [];
      }
      const planMap = Object.fromEntries(plans.map((p: Record<string, unknown>) => [p.id as string, p]));

      const customerMap = Object.fromEntries(
        customers.map((c: Record<string, unknown>) => [c.organization_id as string, c]),
      );
      const subMap = Object.fromEntries(
        subscriptions.map((s: Record<string, unknown>) => [s.organization_id as string, s]),
      );

      const enriched = (orgs ?? []).map((org: Record<string, unknown>) => {
        const orgId = org.id as string;
        const sub = subMap[orgId] as Record<string, unknown> | undefined;
        const planId = sub?.billing_plan_id as string | undefined;
        return {
          ...org,
          billing_customer: customerMap[orgId] ?? null,
          subscription: sub ? { ...sub, plan: planId ? planMap[planId] ?? null : null } : null,
        };
      });

      let filtered = enriched;
      if (filterPlan) {
        filtered = enriched.filter((o: Record<string, unknown>) => {
          const sub = o.subscription as Record<string, unknown> | null;
          const plan = sub?.plan as Record<string, unknown> | null;
          return plan?.id === filterPlan || plan?.slug === filterPlan;
        });
      }

      return jsonResponse(req, { success: true, organizations: filtered, total: count });
    }

    if (action === "get_organization_billing") {
      const { organization_id } = body;
      if (!organization_id) return jsonResponse(req, { error: "organization_id é obrigatório." }, 400);

      // Owner/gerente lê a PRÓPRIA org; platform_admin lê qualquer uma.
      if (!callerIsAdmin && !(await canManageOrgBilling(callerId, organization_id))) {
        return jsonResponse(req, { error: "Sem permissão." }, 403);
      }

      // Caminho do cliente: resposta MOLDADA, não a do admin filtrada depois.
      // O payload admin agrega seis tabelas com `select("*")` — devolvê-lo a um
      // lojista vazaria ids do provedor, Price IDs da Stripe, external_reference
      // das faturas e o histórico de `billing_access_overrides` /
      // `billing_notifications`, que é registro administrativo SOBRE ele.
      if (!callerIsAdmin) {
        const [orgRes, subRes] = await Promise.all([
          supabase.from("organizations").select(ORG_BILLING_PUBLIC_COLUMNS).eq("id", organization_id).single(),
          supabase.from("billing_subscriptions").select(SUBSCRIPTION_PUBLIC_COLUMNS)
            .eq("organization_id", organization_id).order("created_at", { ascending: false }),
        ]);

        if (orgRes.error) {
          return jsonResponse(req, { error: "Organização não encontrada." }, 404);
        }
        // Falha de leitura NÃO pode virar lista vazia: `Cobranca.tsx` derivaria
        // `sub = null` e mostraria o PricingTable pra quem já assina, como se a
        // assinatura tivesse sumido. Mesmo princípio das listas do frontend —
        // `isError` é um estado, não "zero resultados".
        if (subRes.error) {
          jsonLog("error", {
            reqId, evt: "billing_client_detail_subs_read_failed",
            orgId: organization_id, err: subRes.error.message,
          });
          return jsonResponse(req, { error: "Falha ao carregar a assinatura." }, 500);
        }

        let clientPlan = null;
        const clientActiveSub = (subRes.data ?? []).find((s: Record<string, unknown>) => s.status !== "canceled");
        if (clientActiveSub) {
          const { data: p } = await supabase.from("billing_plans")
            .select(PLAN_PUBLIC_COLUMNS).eq("id", clientActiveSub.billing_plan_id).single();
          clientPlan = p;
        }

        // As chaves de admin são OMITIDAS, não vazias. `invoices: []` afirmaria
        // "esta organização não tem fatura", e uma tela futura de "Suas faturas"
        // mostraria lista vazia pra quem tem fatura vencida. Ausente obriga quem
        // consome a decidir. `subscriptions` e `active_plan` sempre vêm —
        // `Cobranca.tsx` faz `detail.subscriptions.find(...)` direto.
        return jsonResponse(req, {
          success: true,
          organization: orgRes.data,
          subscriptions: subRes.data ?? [],
          active_plan: clientPlan,
        });
      }

      const [orgRes, custRes, subRes, invRes, overRes, notifRes] = await Promise.all([
        supabase.from("organizations").select("*").eq("id", organization_id).single(),
        supabase.from("billing_customers").select("*").eq("organization_id", organization_id).maybeSingle(),
        supabase.from("billing_subscriptions").select("*").eq("organization_id", organization_id).order("created_at", { ascending: false }),
        supabase.from("billing_invoices").select("*").eq("organization_id", organization_id).order("created_at", { ascending: false }).limit(20),
        supabase.from("billing_access_overrides").select("*").eq("organization_id", organization_id).order("created_at", { ascending: false }),
        supabase.from("billing_notifications").select("*").eq("organization_id", organization_id).order("sent_at", { ascending: false }).limit(20),
      ]);

      if (orgRes.error) {
        return jsonResponse(req, { error: "Organização não encontrada." }, 404);
      }

      let plan = null;
      const activeSub = (subRes.data ?? []).find((s: Record<string, unknown>) => s.status !== "canceled");
      if (activeSub) {
        const { data: p } = await supabase.from("billing_plans").select("*").eq("id", activeSub.billing_plan_id).single();
        plan = p;
      }

      // `head: true` devolve a contagem em `count` e SEMPRE `data: null` —
      // destruturar `data` deixava "Unidades: —" fixo no painel.
      const { count: unitsCount } = await supabase
        .from("units")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organization_id);

      return jsonResponse(req, {
        success: true,
        organization: orgRes.data,
        customer: custRes.data ?? null,
        subscriptions: subRes.data ?? [],
        active_plan: plan,
        invoices: invRes.data ?? [],
        overrides: overRes.data ?? [],
        notifications: notifRes.data ?? [],
        units_count: unitsCount,
      });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // BILLING CUSTOMER
    // ═════════════════════════════════════════════════════════════════════════

    if (action === "create_or_get_billing_customer") {
      const { organization_id, email, name, tax_id, create_in_stripe } = body;
      if (!organization_id) return jsonResponse(req, { error: "organization_id é obrigatório." }, 400);

      const { data: existing } = await supabase
        .from("billing_customers")
        .select("*")
        .eq("organization_id", organization_id)
        .maybeSingle();

      if (existing) {
        return jsonResponse(req, { success: true, customer: existing, created: false });
      }

      let stripeCustomerId: string | null = null;

      if (create_in_stripe !== false) {
        const { data: org } = await supabase
          .from("organizations")
          .select("name, slug")
          .eq("id", organization_id)
          .single();

        const stripeRes = await createStripeCustomer({
          email: email ?? undefined,
          name: name ?? org?.name ?? undefined,
          taxId: tax_id ?? undefined,
          metadata: { organization_id, slug: org?.slug ?? "" },
        });

        if (!stripeRes.ok) {
          jsonLog("error", { reqId, evt: "billing_create_stripe_customer_error", err: stripeRes.error });
          return jsonResponse(req, { error: stripeRes.error ?? "Falha ao criar customer no Stripe." }, 500);
        }
        stripeCustomerId = stripeRes.customerId!;
      }

      const { data: customer, error: insertErr } = await supabase
        .from("billing_customers")
        .insert({
          organization_id,
          stripe_customer_id: stripeCustomerId,
          email: email ?? null,
          name: name ?? null,
          tax_id: tax_id ?? null,
        })
        .select()
        .single();

      if (insertErr) {
        if (insertErr.code === "23505") {
          const { data: retry } = await supabase.from("billing_customers").select("*").eq("organization_id", organization_id).single();
          return jsonResponse(req, { success: true, customer: retry, created: false });
        }
        jsonLog("error", { reqId, evt: "billing_insert_customer_error", err: insertErr.message });
        return jsonResponse(req, { error: "Falha ao criar billing customer." }, 500);
      }

      if (email) {
        await supabase.from("organizations").update({ billing_email: email }).eq("id", organization_id);
      }

      jsonLog("info", { reqId, evt: "billing_customer_created", orgId: organization_id, stripeCustomerId });
      return jsonResponse(req, { success: true, customer, created: true });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // SUBSCRIPTION
    // ═════════════════════════════════════════════════════════════════════════

    if (action === "create_subscription") {
      const { organization_id, plan_id, payment_method = "card", trial_days } = body;
      if (!organization_id || !plan_id) {
        return jsonResponse(req, { error: "organization_id e plan_id são obrigatórios." }, 400);
      }

      const { data: customer } = await supabase
        .from("billing_customers")
        .select("id, stripe_customer_id")
        .eq("organization_id", organization_id)
        .maybeSingle();

      if (!customer) {
        return jsonResponse(req, { error: "Crie o billing customer primeiro." }, 400);
      }

      const { data: plan } = await supabase
        .from("billing_plans")
        .select("*")
        .eq("id", plan_id)
        .single();

      if (!plan) return jsonResponse(req, { error: "Plano não encontrado." }, 404);

      const existingSub = await supabase
        .from("billing_subscriptions")
        .select("id, status")
        .eq("organization_id", organization_id)
        .neq("status", "canceled")
        .maybeSingle();

      if (existingSub.data) {
        return jsonResponse(req, { error: "Organização já possui assinatura ativa." }, 409);
      }

      let stripeSubscriptionId: string | null = null;
      let clientSecret: string | undefined;

      if (payment_method === "card" && customer.stripe_customer_id) {
        const priceId = plan.stripe_price_id_card as string | null;
        if (!priceId) {
          return jsonResponse(req, { error: "Plano sem price_id de cartão configurado." }, 400);
        }

        const stripeRes = await createStripeSubscription({
          customerId: customer.stripe_customer_id,
          priceId,
          trialDays: trial_days ?? undefined,
          metadata: { organization_id },
        });

        if (!stripeRes.ok) {
          jsonLog("error", { reqId, evt: "billing_create_stripe_sub_error", err: stripeRes.error });
          return jsonResponse(req, { error: stripeRes.error ?? "Falha ao criar assinatura no Stripe." }, 500);
        }
        stripeSubscriptionId = stripeRes.subscriptionId!;
        clientSecret = stripeRes.clientSecret;
      }

      const trialEnd = trial_days
        ? new Date(Date.now() + trial_days * 86400000).toISOString()
        : null;

      const { data: sub, error: subErr } = await supabase
        .from("billing_subscriptions")
        .insert({
          organization_id,
          billing_customer_id: customer.id,
          billing_plan_id: plan_id,
          stripe_subscription_id: stripeSubscriptionId,
          // `provider` tem default 'stripe' no banco (migration 063). Deixar o
          // default valer numa assinatura sem contraparte na Stripe (boleto/PIX,
          // ou customer sem stripe_customer_id) produz uma linha que se declara
          // Stripe e não tem id nenhum — `decideCancelTarget` a recusa como
          // `unroutable` e ela fica incancelável, travando a org, já que aqui em
          // cima o insert bloqueia criar outra enquanto existir não-cancelada.
          // A honestidade mora na origem: sem id externo, é assinatura `manual`.
          provider: stripeSubscriptionId ? "stripe" : "manual",
          provider_subscription_id: stripeSubscriptionId,
          status: trial_days ? "trialing" : "active",
          payment_method,
          trial_end: trialEnd,
          current_period_start: new Date().toISOString(),
          current_period_end: trialEnd ?? new Date(Date.now() + 30 * 86400000).toISOString(),
        })
        .select()
        .single();

      if (subErr) {
        jsonLog("error", { reqId, evt: "billing_insert_sub_error", err: subErr.message });
        return jsonResponse(req, { error: "Falha ao registrar assinatura." }, 500);
      }

      // Assinatura criada à mão pelo admin. Só a de sistema move o
      // billing_status da organização — criar a instância de WhatsApp para um
      // cliente em atraso não pode marcá-lo como 'active'. Categoria já veio
      // no `select("*")` de `plan` acima — não precisa de nova consulta, e não
      // "conserte" isso de volta pra planCategoryOf(plan.id).
      if (plan.category === SYSTEM_CATEGORY) {
        const billingStatus = trial_days ? "trialing" : "active";
        await supabase.from("organizations").update({
          billing_status: billingStatus,
          trial_ends_at: trialEnd,
        }).eq("id", organization_id);
      }

      jsonLog("info", { reqId, evt: "billing_subscription_created", orgId: organization_id, subId: sub.id, stripeSubscriptionId });
      return jsonResponse(req, { success: true, subscription: sub, client_secret: clientSecret ?? null });
    }

    if (action === "cancel_subscription") {
      const { subscription_id, at_period_end = true } = body;
      if (!subscription_id) return jsonResponse(req, { error: "subscription_id é obrigatório." }, 400);

      const { data: sub } = await supabase
        .from("billing_subscriptions")
        .select("id, provider, provider_subscription_id, stripe_subscription_id, organization_id, status")
        .eq("id", subscription_id)
        .single();

      if (!sub) return jsonResponse(req, { error: "Assinatura não encontrada." }, 404);
      // Reentrância: aba velha, duplo clique, retry. Sem isto, recancelar uma
      // linha já cancelada reescreve `canceled_at` e — pior — re-executa a
      // cascata abaixo, derrubando uma org que já assinou de novo e está em dia.
      if (sub.status === "canceled") {
        return jsonResponse(req, { error: "Assinatura já cancelada." }, 400);
      }

      const target = decideCancelTarget(sub);
      if (target.kind === "unroutable") {
        jsonLog("warn", {
          reqId, evt: "billing_cancel_unroutable", subId: subscription_id,
          provider: target.provider, reason: target.reason,
        });
        return jsonResponse(req, {
          error: "Esta assinatura não tem vínculo com o provedor de pagamento. Não é possível cancelar automaticamente.",
        }, 400);
      }

      // Provedor PRIMEIRO. Falha aqui aborta sem escrever nada — era
      // exatamente o inverso disso que fazia o banco dizer "cancelado"
      // enquanto o Asaas seguia cobrando.
      let effective: CancelEffective = "immediate";
      if (target.kind === "provider") {
        const res = await getBillingProvider(target.provider).cancelSubscription(
          target.providerSubscriptionId,
          at_period_end === true,
        );
        if (!res.ok) {
          jsonLog("error", {
            reqId, evt: "billing_cancel_provider_error",
            provider: target.provider, subId: subscription_id, err: res.error,
          });
          return jsonResponse(req, { error: "Falha ao cancelar a assinatura no provedor de pagamento." }, 500);
        }
        effective = res.data?.effective ?? "immediate";
      }

      const { error: updErr } = await supabase
        .from("billing_subscriptions")
        .update(localCancelPatch(effective, new Date().toISOString()))
        .eq("id", subscription_id);

      if (updErr) {
        // Provedor já cancelou. Sem transação distribuída alguém fica na
        // frente, e cancelar no provedor primeiro erra a favor do cliente —
        // ele para de ser cobrado mesmo com o nosso banco fora. Este log é o
        // que permite achar e conciliar a divergência.
        jsonLog("error", {
          reqId, evt: "billing_cancel_local_write_failed",
          subId: subscription_id, provider: target.provider, effective, err: updErr.message,
        });
        await notifyCancelDivergence(sub.organization_id, reqId);
        return jsonResponse(req, { error: "Assinatura cancelada no provedor, mas o registro local falhou. Ver logs." }, 500);
      }

      // Só o cancelamento da assinatura de SISTEMA cancela a organização.
      // Cancelar a instância de WhatsApp marcava a org inteira como
      // 'canceled' — o cliente perdia o sistema por desistir da automação.
      if (effective === "immediate" && await isSystemSubscription(supabase, subscription_id)) {
        await supabase.from("organizations").update({
          billing_status: "canceled",
        }).eq("id", sub.organization_id);
      }

      jsonLog("info", {
        reqId, evt: "billing_subscription_cancelled",
        subId: subscription_id, target: target.kind, effective,
      });
      return jsonResponse(req, { success: true, effective });
    }

    // ─── change_plan (client-friendly) ────────────────────────────────────
    // Owner/gerente OU platform_admin troca plano da própria sub.
    // Stripe faz proration automático via proration_behavior=create_prorations.
    if (action === "change_plan") {
      const { subscription_id, new_plan_id, organization_id } = body;
      if (!subscription_id || !new_plan_id || !organization_id) {
        return jsonResponse(req, { error: "subscription_id, new_plan_id e organization_id são obrigatórios." }, 400);
      }
      if (!callerIsAdmin && !(await canManageOrgBilling(callerId, organization_id))) {
        return jsonResponse(req, { error: "Sem permissão para esta organização." }, 403);
      }

      const { data: sub } = await supabase
        .from("billing_subscriptions")
        .select("id, stripe_subscription_id, organization_id, billing_plan_id")
        .eq("id", subscription_id)
        .single();

      if (!sub || sub.organization_id !== organization_id) {
        return jsonResponse(req, { error: "Assinatura não encontrada." }, 404);
      }
      if (!sub.stripe_subscription_id) {
        return jsonResponse(req, { error: "Assinatura sem stripe_subscription_id (não pode trocar plano)." }, 400);
      }
      if (sub.billing_plan_id === new_plan_id) {
        return jsonResponse(req, { error: "Plano selecionado é o atual." }, 400);
      }

      const { data: newPlan } = await supabase
        .from("billing_plans")
        .select("id, stripe_price_id_card, active")
        .eq("id", new_plan_id)
        .maybeSingle();

      if (!newPlan || !newPlan.active) {
        return jsonResponse(req, { error: "Novo plano não encontrado ou inativo." }, 404);
      }
      if (!newPlan.stripe_price_id_card) {
        return jsonResponse(req, { error: "Novo plano sem stripe_price_id_card." }, 400);
      }

      // Retrieve subscription pra pegar o item_id atual
      const subRes = await stripeRequestRaw(`/subscriptions/${sub.stripe_subscription_id}`);
      if (!subRes.ok) {
        jsonLog("error", { reqId, evt: "billing_change_plan_retrieve_error", err: subRes.data });
        return jsonResponse(req, { error: "Falha ao buscar assinatura no Stripe." }, 500);
      }

      const items = (subRes.data.items as Record<string, unknown>)?.data as Record<string, unknown>[] | undefined;
      const currentItemId = items?.[0]?.id as string | undefined;
      if (!currentItemId) {
        return jsonResponse(req, { error: "Subscription sem item ativo no Stripe." }, 500);
      }

      const updateRes = await stripeRequestRaw(`/subscriptions/${sub.stripe_subscription_id}`, "POST", {
        "items[0][id]": currentItemId,
        "items[0][price]": newPlan.stripe_price_id_card as string,
        "proration_behavior": "create_prorations",
      });

      if (!updateRes.ok) {
        const errMsg = (updateRes.data.error as Record<string, string> | undefined)?.message ?? "Falha ao trocar plano.";
        jsonLog("error", { reqId, evt: "billing_change_plan_stripe_error", err: errMsg });
        return jsonResponse(req, { error: errMsg }, 500);
      }

      await supabase.from("billing_subscriptions").update({
        billing_plan_id: new_plan_id,
        updated_at: new Date().toISOString(),
      }).eq("id", subscription_id);

      jsonLog("info", { reqId, evt: "billing_plan_changed", subId: subscription_id, newPlanId: new_plan_id, callerId });
      return jsonResponse(req, { success: true });
    }

    // ─── preview_plan_change (client-friendly) ────────────────────────────
    // Owner vê quanto vai cobrar agora (proration) antes de confirmar.
    if (action === "preview_plan_change") {
      const { subscription_id, new_plan_id, organization_id } = body;
      if (!subscription_id || !new_plan_id || !organization_id) {
        return jsonResponse(req, { error: "subscription_id, new_plan_id e organization_id são obrigatórios." }, 400);
      }
      if (!callerIsAdmin && !(await canManageOrgBilling(callerId, organization_id))) {
        return jsonResponse(req, { error: "Sem permissão para esta organização." }, 403);
      }

      const { data: sub } = await supabase
        .from("billing_subscriptions")
        .select("stripe_subscription_id, organization_id")
        .eq("id", subscription_id)
        .single();

      if (!sub || sub.organization_id !== organization_id || !sub.stripe_subscription_id) {
        return jsonResponse(req, { error: "Assinatura inválida." }, 404);
      }

      const { data: newPlan } = await supabase
        .from("billing_plans")
        .select("stripe_price_id_card")
        .eq("id", new_plan_id)
        .maybeSingle();

      if (!newPlan?.stripe_price_id_card) {
        return jsonResponse(req, { error: "Plano sem price_id." }, 400);
      }

      // Retrieve subscription pra pegar item_id
      const subRes = await stripeRequestRaw(`/subscriptions/${sub.stripe_subscription_id}`);
      if (!subRes.ok) {
        return jsonResponse(req, { error: "Falha ao buscar assinatura." }, 500);
      }
      const items = (subRes.data.items as Record<string, unknown>)?.data as Record<string, unknown>[] | undefined;
      const currentItemId = items?.[0]?.id as string | undefined;

      // Stripe /invoices/upcoming exige GET com query string (não aceita body)
      const params = new URLSearchParams({
        subscription: sub.stripe_subscription_id,
        "subscription_items[0][id]": currentItemId ?? "",
        "subscription_items[0][price]": newPlan.stripe_price_id_card,
        "subscription_proration_behavior": "create_prorations",
      });
      const secretKey = await getStripeSecretKey();
      const upcoming = await fetch(`https://api.stripe.com/v1/invoices/upcoming?${params.toString()}`, {
        headers: { Authorization: `Bearer ${secretKey}` },
      });
      const upcomingData = await upcoming.json();

      if (!upcoming.ok) {
        const errMsg = (upcomingData.error as Record<string, string> | undefined)?.message ?? "Falha ao calcular preview.";
        jsonLog("error", { reqId, evt: "billing_preview_stripe_error", err: errMsg });
        return jsonResponse(req, { error: errMsg }, 500);
      }

      return jsonResponse(req, {
        success: true,
        amount_due: upcomingData.amount_due ?? 0,
        amount_remaining: upcomingData.amount_remaining ?? 0,
        currency: upcomingData.currency ?? "brl",
        period_start: upcomingData.period_start ? new Date(upcomingData.period_start * 1000).toISOString() : null,
        period_end: upcomingData.period_end ? new Date(upcomingData.period_end * 1000).toISOString() : null,
      });
    }

    // ─── cancel_subscription_by_owner (client-friendly) ───────────────────
    // Owner cancela a própria sub. Sempre PEDE at_period_end=true; o efeito real
    // vem do provedor (no Asaas volta `immediate`, que não tem período a honrar).
    if (action === "cancel_subscription_by_owner") {
      const { subscription_id, organization_id } = body;
      if (!subscription_id || !organization_id) {
        return jsonResponse(req, { error: "subscription_id e organization_id são obrigatórios." }, 400);
      }
      // `owner`, não `gerente`: este caminho cascateia pra organizations.
      if (!callerIsAdmin && !(await canCancelOrgSubscription(callerId, organization_id))) {
        return jsonResponse(req, { error: "Apenas o proprietário pode cancelar a assinatura." }, 403);
      }

      const { data: sub } = await supabase
        .from("billing_subscriptions")
        .select("id, provider, provider_subscription_id, stripe_subscription_id, organization_id, status")
        .eq("id", subscription_id)
        .single();

      if (!sub || sub.organization_id !== organization_id) {
        return jsonResponse(req, { error: "Assinatura não encontrada." }, 404);
      }
      if (sub.status === "canceled") {
        return jsonResponse(req, { error: "Assinatura já cancelada." }, 400);
      }

      const target = decideCancelTarget(sub);
      if (target.kind === "unroutable") {
        jsonLog("warn", {
          reqId, evt: "billing_cancel_by_owner_unroutable", subId: subscription_id,
          provider: target.provider, reason: target.reason,
        });
        return jsonResponse(req, {
          error: "Esta assinatura não tem vínculo com o provedor de pagamento. Fale com o suporte.",
        }, 400);
      }

      // O lojista sempre pede fim de período; o provedor responde o que de
      // fato deu. No Asaas isso volta como `immediate` — não há período
      // contratual a honrar, e a tela já avisa disso antes de confirmar.
      let effective: CancelEffective = "immediate";
      if (target.kind === "provider") {
        const res = await getBillingProvider(target.provider).cancelSubscription(
          target.providerSubscriptionId,
          true,
        );
        if (!res.ok) {
          jsonLog("error", {
            reqId, evt: "billing_cancel_by_owner_provider_error",
            provider: target.provider, subId: subscription_id, err: res.error,
          });
          return jsonResponse(req, { error: "Falha ao cancelar a assinatura no provedor de pagamento." }, 500);
        }
        effective = res.data?.effective ?? "immediate";
      }

      const { error: updErr } = await supabase
        .from("billing_subscriptions")
        .update(localCancelPatch(effective, new Date().toISOString()))
        .eq("id", subscription_id);

      if (updErr) {
        jsonLog("error", {
          reqId, evt: "billing_cancel_by_owner_local_write_failed",
          subId: subscription_id, provider: target.provider, effective, err: updErr.message,
        });
        await notifyCancelDivergence(sub.organization_id, reqId);
        return jsonResponse(req, { error: "Assinatura cancelada no provedor, mas o registro local falhou. Ver logs." }, 500);
      }

      // Mesma cascata da action admin, e pelo mesmo motivo: `billing_status` é a
      // coluna autoritativa do BillingGuard. Sem isto, cancelamento imediato
      // (Asaas) para de cobrar e NUNCA encerra o acesso — nenhum worker fecha a
      // brecha, porque assinatura INACTIVE não gera mais fatura pra vencer. Só
      // assinatura de SISTEMA cancela a org: desistir da instância de WhatsApp
      // não pode derrubar o sistema inteiro. `sub.organization_id` (linha já
      // conferida contra o payload acima), nunca o `organization_id` do body.
      // `/g/:slug/cobranca` é whitelist do BillingGuard, então o lojista
      // continua alcançando esta tela pra reassinar.
      if (effective === "immediate" && await isSystemSubscription(supabase, subscription_id)) {
        await supabase.from("organizations").update({
          billing_status: "canceled",
        }).eq("id", sub.organization_id);
      }

      jsonLog("info", {
        reqId, evt: "billing_subscription_cancelled_by_owner",
        subId: subscription_id, callerId, target: target.kind, effective,
      });
      return jsonResponse(req, { success: true, effective });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // INVOICES
    // ═════════════════════════════════════════════════════════════════════════

    if (action === "list_invoices") {
      const { organization_id, status: filterStatus, page = 0, page_size = 20, enforcement_hold } = body;
      const from = Number(page) * Number(page_size);
      const to = from + Number(page_size) - 1;

      // `organizations(name, slug)` embutido via FK (billing_invoices.organization_id
      // -> organizations.id) — Task 20, painel de faturas retidas da plataforma
      // precisa do nome da organização na linha, sem consulta separada.
      // Aditivo: consumidores existentes de `invoices` continuam recebendo os
      // mesmos campos, só ganham este a mais.
      let query = supabase
        .from("billing_invoices")
        .select("*, organizations(name, slug)", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(from, to);

      if (organization_id) query = query.eq("organization_id", organization_id);
      if (filterStatus) query = query.eq("status", filterStatus);
      if (enforcement_hold !== undefined) query = query.eq("enforcement_hold", !!enforcement_hold);

      const { data, error, count } = await query;
      if (error) {
        jsonLog("error", { reqId, evt: "billing_list_invoices_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao listar faturas." }, 500);
      }
      return jsonResponse(req, { success: true, invoices: data, total: count });
    }

    if (action === "create_manual_invoice") {
      const { organization_id, amount_cents, description, payment_method = "pix", days_until_due, create_in_stripe } = body;
      if (!organization_id || !amount_cents) {
        return jsonResponse(req, { error: "organization_id e amount_cents são obrigatórios." }, 400);
      }

      const { data: customer } = await supabase
        .from("billing_customers")
        .select("id, stripe_customer_id")
        .eq("organization_id", organization_id)
        .maybeSingle();

      // N2 (review final fase 5a): sem filtro de categoria, uma org com duas
      // assinaturas vivas (sistema + instância de WhatsApp) tanto podia
      // vincular a fatura manual à assinatura ERRADA (instância) — o que faz
      // isSystemInvoice devolver false e a fatura de sistema desaparecer dos
      // lembretes/escalada de inadimplência — quanto estourar PGRST116 no
      // .maybeSingle() com 2 linhas, erro esse que era descartado em
      // silêncio. Mesmo padrão de unblock_organization_manual (linha ~1117
      // abaixo): filtra por billing_plans.category = SYSTEM_CATEGORY e
      // confere o erro.
      const { data: activeSub, error: activeSubErr } = await supabase
        .from("billing_subscriptions")
        .select("id, billing_plans!inner(category)")
        .eq("organization_id", organization_id)
        .neq("status", "canceled")
        .eq("billing_plans.category", SYSTEM_CATEGORY)
        .maybeSingle();

      if (activeSubErr) {
        jsonLog("error", { reqId, evt: "billing_create_manual_invoice_sub_lookup_error", err: activeSubErr.message });
        return jsonResponse(req, { error: "Falha ao localizar a assinatura da organização." }, 500);
      }

      let stripeInvoiceId: string | null = null;
      let hostedUrl: string | null = null;

      if (create_in_stripe !== false && customer?.stripe_customer_id) {
        const stripeRes = await createStripeInvoice({
          customerId: customer.stripe_customer_id,
          amountCents: Number(amount_cents),
          description: description ?? "Mensalidade Moralles Reservas",
          daysUntilDue: days_until_due ?? 7,
          metadata: { organization_id },
        });

        if (!stripeRes.ok) {
          jsonLog("error", { reqId, evt: "billing_create_stripe_invoice_error", err: stripeRes.error });
          return jsonResponse(req, { error: stripeRes.error ?? "Falha ao criar fatura no Stripe." }, 500);
        }
        stripeInvoiceId = stripeRes.invoiceId!;
        hostedUrl = stripeRes.hostedUrl ?? null;
      }

      const dueDate = new Date(Date.now() + (days_until_due ?? 7) * 86400000);

      const { data: invoice, error: invErr } = await supabase
        .from("billing_invoices")
        .insert({
          organization_id,
          billing_subscription_id: activeSub?.id ?? null,
          stripe_invoice_id: stripeInvoiceId,
          status: "open",
          amount_cents: Number(amount_cents),
          payment_method,
          hosted_invoice_url: hostedUrl,
          due_date: dueDate.toISOString().slice(0, 10),
        })
        .select()
        .single();

      if (invErr) {
        jsonLog("error", { reqId, evt: "billing_insert_invoice_error", err: invErr.message });
        return jsonResponse(req, { error: "Falha ao registrar fatura." }, 500);
      }

      jsonLog("info", { reqId, evt: "billing_invoice_created", orgId: organization_id, invoiceId: invoice.id, stripeInvoiceId });
      return jsonResponse(req, { success: true, invoice });
    }

    // ── release_invoice_enforcement_hold (admin) ───────────────────────────
    // Libera uma fatura retida pra revisão (migration 077) — fora de
    // CLIENT_FRIENDLY_ACTIONS, exclusiva de platform_admin (guard já rodou no
    // topo). Sem organization_id no payload pra checar contra o caller: a org
    // sai da própria fatura, mesmo padrão de reprocess_billing_event.
    if (action === "release_invoice_enforcement_hold") {
      const { invoice_id, reason } = body;
      if (!invoice_id || typeof reason !== "string" || reason.trim().length < 5) {
        return jsonResponse(req, { error: "Informe a fatura e o motivo da liberação." }, 400);
      }
      const { data: released, error } = await supabase
        .from("billing_invoices")
        .update({
          enforcement_hold: false,
          enforcement_released_at: new Date().toISOString(),
          enforcement_released_by: callerId,
        })
        .eq("id", invoice_id)
        .eq("enforcement_hold", true) // condicional: liberar duas vezes não reescreve a autoria
        .select("id, organization_id");
      if (error) {
        jsonLog("error", { reqId, evt: "billing_release_hold_failed", invoice_id, err: error.message });
        return jsonResponse(req, { error: "Não foi possível liberar a fatura." }, 500);
      }
      if (!released?.length) {
        return jsonResponse(req, { error: "Fatura não está retida." }, 409);
      }
      // Auditoria: quem liberou, quando e por quê. Sem isso, uma fatura sai da
      // retenção e volta a poder suspender um cliente sem rastro de decisão.
      await supabase.from("billing_events").insert({
        organization_id: released[0].organization_id,
        provider: "asaas",
        event_type: "internal.invoice_hold_released",
        processing_status: "processed",
        data: { invoice_id, reason: reason.trim(), released_by: callerId },
      });
      jsonLog("info", { reqId, evt: "billing_invoice_hold_released", invoice_id, by: callerId });
      return jsonResponse(req, { success: true });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // OVERRIDES
    // ═════════════════════════════════════════════════════════════════════════

    if (action === "create_override") {
      const { organization_id, override_type, reason, valid_until } = body;
      if (!organization_id || !override_type || !reason) {
        return jsonResponse(req, { error: "organization_id, override_type e reason são obrigatórios." }, 400);
      }

      const { data: override, error } = await supabase
        .from("billing_access_overrides")
        .insert({
          organization_id,
          override_type,
          reason,
          granted_by: callerId,
          valid_until: valid_until ?? null,
        })
        .select()
        .single();

      if (error) {
        jsonLog("error", { reqId, evt: "billing_create_override_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao criar override." }, 500);
      }

      if (override_type === "grant_access") {
        await supabase.from("organizations").update({
          billing_status: "manual_override",
          blocked_at: null,
          blocked_reason: null,
        }).eq("id", organization_id);
      } else if (override_type === "block_access") {
        await supabase.from("organizations").update({
          billing_status: "blocked",
          blocked_at: new Date().toISOString(),
          blocked_reason: reason,
        }).eq("id", organization_id);
      } else if (override_type === "extend_trial") {
        await supabase.from("organizations").update({
          billing_status: "trialing",
          trial_ends_at: valid_until ?? null,
          blocked_at: null,
          blocked_reason: null,
        }).eq("id", organization_id);
      }

      jsonLog("info", { reqId, evt: "billing_override_created", orgId: organization_id, type: override_type });
      return jsonResponse(req, { success: true, override });
    }

    if (action === "deactivate_override") {
      const { override_id } = body;
      if (!override_id) return jsonResponse(req, { error: "override_id é obrigatório." }, 400);

      const { error } = await supabase
        .from("billing_access_overrides")
        .update({ active: false })
        .eq("id", override_id);

      if (error) {
        jsonLog("error", { reqId, evt: "billing_deactivate_override_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao desativar override." }, 500);
      }
      return jsonResponse(req, { success: true });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // BLOCK / UNBLOCK
    // ═════════════════════════════════════════════════════════════════════════

    if (action === "block_organization_manual") {
      const { organization_id, reason } = body;
      if (!organization_id || !reason) {
        return jsonResponse(req, { error: "organization_id e reason são obrigatórios." }, 400);
      }

      const { error } = await supabase.from("organizations").update({
        billing_status: "blocked",
        blocked_at: new Date().toISOString(),
        blocked_reason: reason,
      }).eq("id", organization_id);

      if (error) {
        jsonLog("error", { reqId, evt: "billing_block_org_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao bloquear organização." }, 500);
      }

      await supabase.from("billing_access_overrides").insert({
        organization_id,
        override_type: "block_access",
        reason,
        granted_by: callerId,
      });

      jsonLog("info", { reqId, evt: "billing_org_blocked", orgId: organization_id, reason });
      return jsonResponse(req, { success: true });
    }

    if (action === "unblock_organization_manual") {
      const { organization_id } = body;
      if (!organization_id) return jsonResponse(req, { error: "organization_id é obrigatório." }, 400);

      // Só a assinatura de SISTEMA decide se o desbloqueio cai em 'trialing' ou
      // 'active' — uma instância de WhatsApp trialing não pode travar a org
      // num status que não é o dela. Sem match (org sem assinatura de sistema,
      // ou nenhuma linha), newStatus cai em 'active': é desbloqueio manual
      // explícito do admin, e o lado seguro aqui é NÃO deixar de desbloquear.
      const { data: activeSub } = await supabase
        .from("billing_subscriptions")
        .select("status, billing_plans!inner(category)")
        .eq("organization_id", organization_id)
        .neq("status", "canceled")
        .eq("billing_plans.category", SYSTEM_CATEGORY)
        .maybeSingle();

      const newStatus = activeSub ? (activeSub.status as string) === "trialing" ? "trialing" : "active" : "active";

      const { error } = await supabase.from("organizations").update({
        billing_status: newStatus,
        blocked_at: null,
        blocked_reason: null,
      }).eq("id", organization_id);

      if (error) {
        jsonLog("error", { reqId, evt: "billing_unblock_org_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao desbloquear organização." }, 500);
      }

      await supabase.from("billing_access_overrides").insert({
        organization_id,
        override_type: "grant_access",
        reason: "Desbloqueio manual pelo administrador.",
        granted_by: callerId,
      });

      jsonLog("info", { reqId, evt: "billing_org_unblocked", orgId: organization_id });
      return jsonResponse(req, { success: true });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // EXTEND TRIAL
    // ═════════════════════════════════════════════════════════════════════════

    if (action === "extend_trial") {
      const { organization_id, trial_days, reason } = body;
      if (!organization_id || !trial_days) {
        return jsonResponse(req, { error: "organization_id e trial_days são obrigatórios." }, 400);
      }

      const newTrialEnd = new Date(Date.now() + Number(trial_days) * 86400000).toISOString();

      const { error } = await supabase.from("organizations").update({
        billing_status: "trialing",
        trial_ends_at: newTrialEnd,
        blocked_at: null,
        blocked_reason: null,
      }).eq("id", organization_id);

      if (error) {
        jsonLog("error", { reqId, evt: "billing_extend_trial_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao estender trial." }, 500);
      }

      await supabase.from("billing_access_overrides").insert({
        organization_id,
        override_type: "extend_trial",
        reason: reason ?? `Trial estendido por ${trial_days} dias.`,
        granted_by: callerId,
        valid_until: newTrialEnd,
      });

      jsonLog("info", { reqId, evt: "billing_trial_extended", orgId: organization_id, trialDays: trial_days });
      return jsonResponse(req, { success: true, trial_ends_at: newTrialEnd });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // SYNC FROM STRIPE
    // ═════════════════════════════════════════════════════════════════════════

    if (action === "sync_organization_from_stripe") {
      const { organization_id } = body;
      if (!organization_id) return jsonResponse(req, { error: "organization_id é obrigatório." }, 400);

      const { data: customer } = await supabase
        .from("billing_customers")
        .select("stripe_customer_id")
        .eq("organization_id", organization_id)
        .maybeSingle();

      if (!customer?.stripe_customer_id) {
        return jsonResponse(req, { error: "Organização não tem customer Stripe." }, 404);
      }

      const { data: subs } = await supabase
        .from("billing_subscriptions")
        .select("id, stripe_subscription_id")
        .eq("organization_id", organization_id)
        .not("stripe_subscription_id", "is", null);

      let synced = 0;
      for (const sub of (subs ?? [])) {
        const stripeRes = await retrieveStripeSubscription(sub.stripe_subscription_id as string);
        if (!stripeRes.ok) continue;

        const s = stripeRes.data;
        await supabase.from("billing_subscriptions").update({
          status: s.status as string,
          current_period_start: s.current_period_start ? new Date((s.current_period_start as number) * 1000).toISOString() : null,
          current_period_end: s.current_period_end ? new Date((s.current_period_end as number) * 1000).toISOString() : null,
          cancel_at_period_end: s.cancel_at_period_end === true,
          canceled_at: s.canceled_at ? new Date((s.canceled_at as number) * 1000).toISOString() : null,
          updated_at: new Date().toISOString(),
        }).eq("id", sub.id);
        synced++;
      }

      const { data: invoicesData } = await supabase
        .from("billing_invoices")
        .select("id, stripe_invoice_id")
        .eq("organization_id", organization_id)
        .not("stripe_invoice_id", "is", null)
        .in("status", ["draft", "open"]);

      for (const inv of (invoicesData ?? [])) {
        const stripeRes = await retrieveStripeInvoice(inv.stripe_invoice_id as string);
        if (!stripeRes.ok) continue;

        const i = stripeRes.data;
        await supabase.from("billing_invoices").update({
          status: i.status as string,
          hosted_invoice_url: (i.hosted_invoice_url as string) ?? null,
          invoice_pdf: (i.invoice_pdf as string) ?? null,
          paid_at: i.status === "paid" ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        }).eq("id", inv.id);
        synced++;
      }

      jsonLog("info", { reqId, evt: "billing_synced_from_stripe", orgId: organization_id, synced });
      return jsonResponse(req, { success: true, synced });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // REPROCESSAMENTO MANUAL DE EVENTO (admin)
    // ═════════════════════════════════════════════════════════════════════════

    // ── reprocess_billing_event (admin) ───────────────────────────────────────
    // Botão de emergência: reaplica o efeito de um evento Asaas sem esperar o
    // cron diário do `process-asaas-reconcile`. Deliberadamente FORA de
    // `CLIENT_FRIENDLY_ACTIONS` — o guard de platform_admin lá em cima é o que
    // protege esta action, e ela não recebe `organization_id` pra checar contra
    // a org do caller (a org sai do próprio evento).
    if (action === "reprocess_billing_event") {
      const eventId = String(body.billing_event_id ?? "");
      if (!eventId) {
        return jsonResponse(req, { error: "billing_event_id é obrigatório." }, 400);
      }

      const { data: row, error: fetchErr } = await supabase
        .from("billing_events")
        .select("id, provider, provider_event_id, event_type, data, organization_id")
        .eq("id", eventId)
        .maybeSingle();

      if (fetchErr) {
        // Nunca devolve error.message cru do Postgres; detalhe só no log.
        jsonLog("error", { reqId, evt: "billing_reprocess_fetch_failed", eventId, err: fetchErr.message });
        return jsonResponse(req, { error: "Falha ao carregar o evento." }, 500);
      }
      if (!row) {
        return jsonResponse(req, { error: "Evento não encontrado." }, 404);
      }
      if (row.provider !== "asaas") {
        return jsonResponse(
          req,
          { error: "Reprocessamento manual só está disponível para eventos Asaas." },
          400,
        );
      }

      // Quase idempotente, e a diferença importa: os UPDATEs de fatura, sessão,
      // implantação e assinatura são todos condicionais (`.neq`/`.eq` no estado
      // esperado), então reprocessar um evento já aplicado é no-op neles. A
      // ÚNICA escrita incondicional é a de `organizations` no ramo de ativação
      // de assinatura de SISTEMA — reprocessar um pagamento antigo reescreve
      // `billing_status='active'` e limpa o bloqueio mesmo que a organização
      // tenha sido bloqueada DEPOIS, por outra fatura. Não clique aqui sobre um
      // evento antigo de organização atualmente bloqueada sem conferir qual
      // fatura causou o bloqueio. SEM `asaasIoBudgetMs`: é uma ação humana
      // sob demanda, não a resposta de 10s do webhook — vale usar os retries
      // completos do cliente HTTP. COM `recheckDurableEffect`: pela mesma razão.
      // Quem clica neste botão está justamente diante de um evento que não
      // surtiu efeito, e o caso típico é a fatura já estar `paid` (o dinheiro é
      // registrado antes da ativação) — sem a re-checagem o aplicador devolveria
      // `noop`/`processed` e o botão de emergência não faria nada, em silêncio.
      const result = await applyAsaasEvent(
        supabase,
        {
          id: row.id as string,
          provider_event_id: (row.provider_event_id as string) ?? "",
          event_type: row.event_type as string,
          data: row.data as Record<string, unknown> | null,
          organization_id: (row.organization_id as string) ?? null,
        },
        { recheckDurableEffect: true },
      );

      // `retry_count` NÃO é incrementado aqui de propósito: aquele contador é o
      // fusível do worker automático (`MAX_RETRY_COUNT`), e uma tentativa manual
      // do admin não pode consumir as tentativas do cron — queimá-las tiraria a
      // linha da fila justamente quando alguém está tentando resolvê-la.
      const { error: stampErr } = await supabase
        .from("billing_events")
        .update({
          processing_status: result.status,
          organization_id: result.organizationId,
          error_message: result.error ?? null,
        })
        .eq("id", row.id);

      if (stampErr) {
        // O efeito pode ter sido aplicado por completo e só o carimbo falhou —
        // mesma leitura do asaas-webhook. Não vira 500: informa o admin que o
        // estado ficou por carimbar e deixa o reconcile reconciliar.
        jsonLog("error", { reqId, evt: "billing_reprocess_stamp_failed", eventId, err: stampErr.message });
      }

      jsonLog(result.status === "failed" ? "error" : "info", {
        reqId,
        evt: "billing_event_reprocessed",
        eventId,
        eventType: row.event_type,
        status: result.status,
        effect: result.effect,
        organizationId: result.organizationId,
      });

      return jsonResponse(req, {
        success: true,
        status: result.status,
        effect: result.effect,
        organization_id: result.organizationId,
        stamped: !stampErr,
        // `result.error` já é mensagem curta em PT-BR feita pra humano
        // (`applyAsaasEvent` nunca devolve texto cru do Postgres).
        error_message: result.error ?? null,
      });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // ENTITLEMENTS (client-friendly, read-only — Fase 4a, nada aqui bloqueia)
    // ═════════════════════════════════════════════════════════════════════════

    // ── get_org_entitlements (client-friendly) ─────────────────────────────────
    if (action === "get_org_entitlements") {
      const orgId = String(body.organization_id ?? "");
      if (!orgId) return jsonResponse(req, { error: "organization_id é obrigatório." }, 400);
      if (!callerIsAdmin && !(await canManageOrgBilling(callerId, orgId))) {
        return jsonResponse(req, { error: "Acesso negado." }, 403);
      }

      const ent = await resolveOrgEntitlements(supabase, orgId);

      // Moldar: devolve só o que a UI precisa. `reason`, `granted_by` e
      // `grant_type` do override ficam no servidor — quem concedeu a cortesia e
      // por quê é informação interna da plataforma.
      const shape = (f: { allowed: boolean; source: string; status: string; expiresAt: string | null }) => ({
        allowed: f.allowed,
        source: f.source,
        status: f.status,
        expires_at: f.expiresAt,
      });

      return jsonResponse(req, {
        entitlements: {
          system: shape(ent.system),
          whatsapp: shape(ent.whatsapp),
          ai: shape(ent.ai),
        },
      });
    }

    return jsonResponse(req, { error: "Ação inválida." }, 400);
  } catch (err) {
    jsonLog("error", { reqId, evt: "manage_billing_unhandled", err: String(err) });
    return jsonResponse(req, { error: "Falha ao processar solicitação." }, 500);
  }
});
