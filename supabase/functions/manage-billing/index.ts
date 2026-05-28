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
  cancelStripeSubscription,
  createStripeInvoice,
  retrieveStripeSubscription,
  retrieveStripeInvoice,
  voidStripeInvoice,
} from "../_shared/stripe-billing.ts";

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

    if (!(await isPlatformAdmin(callerId))) {
      return jsonResponse(req, { error: "Apenas administradores da plataforma." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const { action } = body;

    // ═════════════════════════════════════════════════════════════════════════
    // PLANS
    // ═════════════════════════════════════════════════════════════════════════

    if (action === "list_plans") {
      const { data, error } = await supabase
        .from("billing_plans")
        .select("*")
        .order("sort_order");

      if (error) {
        jsonLog("error", { reqId, evt: "billing_list_plans_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao listar planos." }, 500);
      }
      return jsonResponse(req, { success: true, plans: data });
    }

    if (action === "create_plan") {
      const { name, slug, amount_cents, interval, stripe_price_id_card, stripe_price_id_boleto, stripe_price_id_pix, max_units, max_members_per_unit, features, sort_order } = body;
      if (!name || !slug || amount_cents == null) {
        return jsonResponse(req, { error: "name, slug e amount_cents são obrigatórios." }, 400);
      }

      const { data, error } = await supabase
        .from("billing_plans")
        .insert({
          name, slug,
          amount_cents: Number(amount_cents),
          interval: interval ?? "month",
          stripe_price_id_card: stripe_price_id_card ?? null,
          stripe_price_id_boleto: stripe_price_id_boleto ?? null,
          stripe_price_id_pix: stripe_price_id_pix ?? null,
          max_units: max_units ?? null,
          max_members_per_unit: max_members_per_unit ?? null,
          features: features ?? {},
          sort_order: sort_order ?? 0,
        })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          return jsonResponse(req, { error: "Já existe um plano com esse slug." }, 409);
        }
        jsonLog("error", { reqId, evt: "billing_create_plan_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao criar plano." }, 500);
      }
      jsonLog("info", { reqId, evt: "billing_plan_created", planId: data.id });
      return jsonResponse(req, { success: true, plan: data });
    }

    if (action === "update_plan") {
      const { plan_id, ...fields } = body;
      if (!plan_id) return jsonResponse(req, { error: "plan_id é obrigatório." }, 400);

      delete fields.action;
      fields.updated_at = new Date().toISOString();

      const { data, error } = await supabase
        .from("billing_plans")
        .update(fields)
        .eq("id", plan_id)
        .select()
        .single();

      if (error) {
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

      const { data: unitsCount } = await supabase
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

      const billingStatus = trial_days ? "trialing" : "active";
      await supabase.from("organizations").update({
        billing_status: billingStatus,
        trial_ends_at: trialEnd,
      }).eq("id", organization_id);

      jsonLog("info", { reqId, evt: "billing_subscription_created", orgId: organization_id, subId: sub.id, stripeSubscriptionId });
      return jsonResponse(req, { success: true, subscription: sub, client_secret: clientSecret ?? null });
    }

    if (action === "cancel_subscription") {
      const { subscription_id, at_period_end = true } = body;
      if (!subscription_id) return jsonResponse(req, { error: "subscription_id é obrigatório." }, 400);

      const { data: sub } = await supabase
        .from("billing_subscriptions")
        .select("id, stripe_subscription_id, organization_id")
        .eq("id", subscription_id)
        .single();

      if (!sub) return jsonResponse(req, { error: "Assinatura não encontrada." }, 404);

      if (sub.stripe_subscription_id) {
        const res = await cancelStripeSubscription(sub.stripe_subscription_id, at_period_end);
        if (!res.ok) {
          jsonLog("error", { reqId, evt: "billing_cancel_stripe_error", err: res.error });
          return jsonResponse(req, { error: res.error ?? "Falha ao cancelar no Stripe." }, 500);
        }
      }

      if (at_period_end) {
        await supabase.from("billing_subscriptions").update({
          cancel_at_period_end: true,
          updated_at: new Date().toISOString(),
        }).eq("id", subscription_id);
      } else {
        await supabase.from("billing_subscriptions").update({
          status: "canceled",
          canceled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", subscription_id);

        await supabase.from("organizations").update({
          billing_status: "canceled",
        }).eq("id", sub.organization_id);
      }

      jsonLog("info", { reqId, evt: "billing_subscription_cancelled", subId: subscription_id, atPeriodEnd: at_period_end });
      return jsonResponse(req, { success: true });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // INVOICES
    // ═════════════════════════════════════════════════════════════════════════

    if (action === "list_invoices") {
      const { organization_id, status: filterStatus, page = 0, page_size = 20 } = body;
      const from = Number(page) * Number(page_size);
      const to = from + Number(page_size) - 1;

      let query = supabase
        .from("billing_invoices")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(from, to);

      if (organization_id) query = query.eq("organization_id", organization_id);
      if (filterStatus) query = query.eq("status", filterStatus);

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

      const { data: activeSub } = await supabase
        .from("billing_subscriptions")
        .select("id")
        .eq("organization_id", organization_id)
        .neq("status", "canceled")
        .maybeSingle();

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

      const { data: activeSub } = await supabase
        .from("billing_subscriptions")
        .select("status")
        .eq("organization_id", organization_id)
        .neq("status", "canceled")
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

    return jsonResponse(req, { error: "Ação inválida." }, 400);
  } catch (err) {
    jsonLog("error", { reqId, evt: "manage_billing_unhandled", err: String(err) });
    return jsonResponse(req, { error: "Falha ao processar solicitação." }, 500);
  }
});
