// Edge Function: create-billing-checkout
// Abre o checkout hospedado da assinatura, roteado por provedor (Fase 4a).
//
// Auth: JWT obrigatório. Caller precisa ser:
//   - platform_admin OU
//   - member (role owner|gerente) de qualquer unit da organization_id alvo
//
// mode=subscription → cliente cadastra cartão e ativa subscription do plano
// mode=setup        → cliente só troca o cartão (sem mudar plano) — só Stripe
//
// Roteamento: plano com provider='asaas' abre checkout no Asaas; o resto segue
// o caminho Stripe legado, intocado. Nada aqui ativa acesso — quem ativa é o
// webhook do provedor.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { genRequestId, jsonLog } from "../_shared/security.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import { getStripeSecretKey } from "../_shared/stripe-config.ts";
import { createStripeCustomer } from "../_shared/stripe-billing.ts";
import { getFlagString } from "../_shared/platform-flags.ts";
import { getBillingProvider } from "../_shared/billing-provider.ts";
import { buildExternalReference } from "../_shared/asaas-billing-events.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const STRIPE_API = "https://api.stripe.com/v1";
const APP_BASE_URL =
  Deno.env.get("APP_BASE_URL") ?? "https://reservas.moralles.com.br";

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
  if (await isPlatformAdmin(userId)) return true;

  // owner/gerente de qualquer unit da org pode iniciar checkout
  const { data } = await supabase
    .from("unit_members")
    .select("role, units!inner(organization_id)")
    .eq("user_id", userId)
    .in("role", ["owner", "gerente"])
    .eq("units.organization_id", organizationId)
    .limit(1);

  return !!(data && data.length > 0);
}

interface OrgRow {
  slug: string | null;
  name: string | null;
  billing_email: string | null;
}

/** Slug pra log/URL + nome e e-mail que servem de fallback no cadastro Asaas. */
async function resolveOrg(organizationId: string): Promise<OrgRow | null> {
  const { data } = await supabase
    .from("organizations")
    .select("slug, name, billing_email")
    .eq("id", organizationId)
    .maybeSingle();
  return (data as OrgRow | null) ?? null;
}

/** Colunas de billing_plans que o roteamento e os dois ramos consomem. */
interface PlanRow {
  id: string;
  name: string;
  slug: string | null;
  stripe_price_id_card: string | null;
  trial_days: number | null;
  active: boolean;
  amount_cents: number | null;
  provider: string | null;
  billing_type: string | null;
}

async function resolveUnitSlug(organizationId: string): Promise<string | null> {
  // Pra montar success_url precisamos do unit_slug. Pegamos a primeira unit
  // da org (a UI cliente sempre acessa via /g/<unit_slug>/cobranca).
  const { data } = await supabase
    .from("units")
    .select("slug")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.slug ?? null;
}

async function getOrCreateBillingCustomer(organizationId: string, fallbackEmail: string | null): Promise<{ id: string; stripe_customer_id: string | null } | null> {
  const { data: existing } = await supabase
    .from("billing_customers")
    .select("id, stripe_customer_id")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (existing) {
    // Garante que tem stripe_customer_id; se não, cria no Stripe agora
    if (existing.stripe_customer_id) return existing;

    const { data: org } = await supabase
      .from("organizations")
      .select("name, slug, billing_email")
      .eq("id", organizationId)
      .single();

    const stripeRes = await createStripeCustomer({
      email: org?.billing_email ?? fallbackEmail ?? undefined,
      name: org?.name ?? undefined,
      metadata: { organization_id: organizationId, slug: org?.slug ?? "" },
    });

    if (!stripeRes.ok) return null;

    await supabase
      .from("billing_customers")
      .update({ stripe_customer_id: stripeRes.customerId })
      .eq("id", existing.id);

    return { id: existing.id, stripe_customer_id: stripeRes.customerId! };
  }

  // Não existe — cria do zero
  const { data: org } = await supabase
    .from("organizations")
    .select("name, slug, billing_email")
    .eq("id", organizationId)
    .single();

  const stripeRes = await createStripeCustomer({
    email: org?.billing_email ?? fallbackEmail ?? undefined,
    name: org?.name ?? undefined,
    metadata: { organization_id: organizationId, slug: org?.slug ?? "" },
  });

  if (!stripeRes.ok) return null;

  const { data: created, error } = await supabase
    .from("billing_customers")
    .insert({
      organization_id: organizationId,
      stripe_customer_id: stripeRes.customerId,
      email: org?.billing_email ?? fallbackEmail ?? null,
      name: org?.name ?? null,
    })
    .select("id, stripe_customer_id")
    .single();

  if (error) return null;
  return created;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeadersFor(req) });
  }
  if (req.method !== "POST") {
    return jsonResponse(req, { error: "Método não permitido." }, 405);
  }

  const reqId = genRequestId();

  try {
    // A chave da Stripe é resolvida DENTRO do ramo Stripe, não aqui: um
    // checkout Asaas não depende dela, e falhar de saída com "Stripe não
    // configurado" travaria a contratação inteira numa plataforma que já
    // migrou.

    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse(req, { error: "Não autenticado." }, 401);

    const { data: callerData, error: callerErr } = await supabase.auth.getUser(jwt);
    if (callerErr || !callerData.user) {
      return jsonResponse(req, { error: "Sessão inválida." }, 401);
    }
    const callerId = callerData.user.id;
    const callerEmail = callerData.user.email ?? null;

    const body = await req.json().catch(() => ({}));
    const { organization_id, plan_id, mode = "subscription" } = body as {
      organization_id?: string;
      plan_id?: string;
      mode?: "subscription" | "setup";
    };

    if (!organization_id) {
      return jsonResponse(req, { error: "organization_id é obrigatório." }, 400);
    }
    if (mode === "subscription" && !plan_id) {
      return jsonResponse(req, { error: "plan_id é obrigatório para mode=subscription." }, 400);
    }
    if (!["subscription", "setup"].includes(mode)) {
      return jsonResponse(req, { error: "mode inválido (use 'subscription' ou 'setup')." }, 400);
    }

    if (!(await canManageOrgBilling(callerId, organization_id))) {
      return jsonResponse(req, { error: "Sem permissão para esta organização." }, 403);
    }

    // Resolve plano (se subscription). A rejeição por stripe_price_id_card
    // ausente NÃO mora aqui — ela é específica do ramo Stripe, e plano Asaas
    // legitimamente não tem Price ID.
    let plan: PlanRow | null = null;
    if (mode === "subscription") {
      const { data: planData, error: planErr } = await supabase
        .from("billing_plans")
        .select("id, name, slug, stripe_price_id_card, trial_days, active, amount_cents, provider, billing_type")
        .eq("id", plan_id)
        .maybeSingle();

      if (planErr || !planData) {
        return jsonResponse(req, { error: "Plano não encontrado." }, 404);
      }
      if (!planData.active) {
        return jsonResponse(req, { error: "Plano inativo." }, 400);
      }
      plan = planData as PlanRow;
      // Produto de cobrança única (implementação WhatsApp, recarga de IA) não
      // é assinatura: seguir aqui abriria um checkout RECURRENT e cobraria
      // todo mês por algo avulso. Esses produtos têm fluxo próprio.
      if (plan.billing_type === "one_time") {
        return jsonResponse(req, {
          error: "Este produto é de cobrança única e não pode ser contratado como assinatura.",
        }, 400);
      }
    }

    const unitSlug = await resolveUnitSlug(organization_id);
    const org = await resolveOrg(organization_id);
    const orgSlug = org?.slug ?? null;
    const successBase = unitSlug
      ? `${APP_BASE_URL}/g/${unitSlug}/cobranca`
      : `${APP_BASE_URL}/platform/billing/${organization_id}`;

    // ── Roteamento por provedor ───────────────────────────────────────────
    // A flag é lida SERVER-SIDE — o frontend nunca lê platform_flags (FORCE
    // RLS sem policies) e não decide provedor.
    // Precedência: o provider do próprio plano vence a flag global, porque um
    // plano Asaas não tem Price ID e não existe caminho Stripe pra ele.
    const defaultProvider = await getFlagString("billing_provider_default", "stripe");
    const provider = plan?.provider === "asaas" || plan?.provider === "stripe"
      ? plan.provider
      : defaultProvider;

    if (provider === "asaas") {
      if (mode !== "subscription" || !plan) {
        return jsonResponse(req, {
          error: "Cadastro de cartão avulso ainda não está disponível para cobranças Asaas.",
        }, 400);
      }
      if (!plan.amount_cents || plan.amount_cents <= 0) {
        return jsonResponse(req, { error: "Plano sem valor configurado." }, 400);
      }

      // 1. Resolver o cliente Asaas da org (criando se ainda não existe).
      // `error` destrinchado à parte: leitura que FALHA e linha ausente viram
      // o mesmo `null`, e tratar as duas como "sem CPF/CNPJ" mandaria o
      // cliente conferir um cadastro que provavelmente está certo.
      const { data: customerRow, error: customerErr } = await supabase
        .from("billing_customers")
        .select("id, asaas_customer_id, name, email, tax_id")
        .eq("organization_id", organization_id)
        .maybeSingle();

      if (customerErr) {
        jsonLog("error", {
          reqId,
          evt: "checkout_billing_customer_read_error",
          orgId: organization_id,
          err: customerErr.message,
        });
        return jsonResponse(req, { error: "Falha ao carregar o cadastro de cobrança." }, 500);
      }
      if (!customerRow?.tax_id) {
        return jsonResponse(req, {
          error: "CPF/CNPJ da empresa não está cadastrado. Preencha o cadastro fiscal antes de contratar.",
        }, 400);
      }

      const asaas = getBillingProvider("asaas");
      let asaasCustomerId: string | null = customerRow.asaas_customer_id;

      if (!asaasCustomerId) {
        const created = await asaas.createCustomer({
          organizationId: organization_id,
          // Asaas exige nome; billing_customers.name é opcional, então cai
          // pro nome da organization antes de deixar o provider recusar.
          name: customerRow.name ?? org?.name ?? undefined,
          email: customerRow.email ?? org?.billing_email ?? callerEmail ?? undefined,
          taxId: customerRow.tax_id,
        });
        if (!created.ok || !created.data) {
          jsonLog("error", {
            reqId,
            evt: "checkout_asaas_customer_error",
            orgId: organization_id,
            err: created.error ?? null,
          });
          return jsonResponse(req, {
            error: created.error ?? "Falha ao cadastrar a empresa no provedor de pagamento.",
          }, 502);
        }
        asaasCustomerId = created.data.customerId;

        const { error: persistErr } = await supabase
          .from("billing_customers")
          .update({ asaas_customer_id: asaasCustomerId })
          .eq("id", customerRow.id);
        if (persistErr) {
          // O cliente EXISTE no Asaas mas não conseguimos gravar o id. Abortar
          // é mais seguro que seguir: a próxima tentativa criaria um cliente
          // duplicado lá (o Asaas não deduplica por externalReference).
          jsonLog("error", {
            reqId,
            evt: "checkout_asaas_customer_persist_error",
            orgId: organization_id,
            err: persistErr.message,
          });
          return jsonResponse(req, {
            error: "Falha ao salvar o cadastro no provedor. Tente novamente em instantes.",
          }, 500);
        }
      }

      // 2. Criar o checkout. Valor SEMPRE do banco, nunca do request. A
      // conversão centavos→reais fica no provider (centsToAsaasValue).
      const checkout = await asaas.createCheckout({
        providerCustomerId: asaasCustomerId,
        amountCents: plan.amount_cents,
        description: plan.name,
        // É deste externalReference que o webhook tira o purpose que libera o
        // acesso — e a cobrança de cada ciclo o herda da assinatura (§13.5.1).
        externalReference: buildExternalReference({
          orgId: organization_id,
          planId: plan.id,
          purpose: "subscription",
        }),
        mode: "subscription",
        // O Asaas não interpola id de sessão na URL (a Stripe usa
        // {CHECKOUT_SESSION_ID}); as URLs vão no corpo da criação, antes de o
        // id existir. Logo, sem `sid` — o frontend tolera a ausência.
        successUrl: `${successBase}?session=success`,
        cancelUrl: `${successBase}?session=cancel`,
      });

      if (!checkout.ok || !checkout.data) {
        jsonLog("error", {
          reqId,
          evt: "checkout_asaas_error",
          orgId: organization_id,
          planId: plan.id,
          err: checkout.error ?? null,
        });
        return jsonResponse(req, {
          error: checkout.error ?? "Falha ao abrir o checkout.",
        }, 502);
      }

      jsonLog("info", {
        reqId,
        evt: "checkout_session_created",
        provider: "asaas",
        orgId: organization_id,
        planId: plan.id,
        mode,
        sessionId: checkout.data.checkoutId ?? null,
        orgSlug,
      });

      return jsonResponse(req, {
        success: true,
        url: checkout.data.url,
        session_id: checkout.data.checkoutId ?? "",
      });
    }

    // ── daqui pra baixo: caminho Stripe, inalterado ───────────────────────

    const STRIPE_SECRET_KEY = await getStripeSecretKey();
    if (!STRIPE_SECRET_KEY) {
      return jsonResponse(req, { error: "Stripe não configurado." }, 500);
    }

    if (mode === "subscription" && !plan?.stripe_price_id_card) {
      return jsonResponse(req, { error: "Plano sem stripe_price_id_card configurado." }, 400);
    }

    // Resolve/cria billing_customer (com stripe_customer_id)
    const customer = await getOrCreateBillingCustomer(organization_id, callerEmail);
    if (!customer || !customer.stripe_customer_id) {
      jsonLog("error", { reqId, evt: "checkout_no_stripe_customer", orgId: organization_id });
      return jsonResponse(req, { error: "Falha ao preparar customer Stripe." }, 500);
    }

    // Monta payload do Checkout Session
    const sessionBody: Record<string, string> = {
      "customer": customer.stripe_customer_id,
      "mode": mode,
      "success_url": `${successBase}?session=success&sid={CHECKOUT_SESSION_ID}`,
      "cancel_url": `${successBase}?session=cancel`,
      "metadata[organization_id]": organization_id,
      "metadata[caller_user_id]": callerId,
    };

    if (mode === "subscription" && plan) {
      sessionBody["line_items[0][price]"] = plan.stripe_price_id_card!;
      sessionBody["line_items[0][quantity]"] = "1";
      sessionBody["metadata[plan_id]"] = plan.id;
      sessionBody["subscription_data[metadata][organization_id]"] = organization_id;
      sessionBody["subscription_data[metadata][plan_id]"] = plan.id;

      const trialDays = plan.trial_days ?? 0;
      if (trialDays > 0) {
        sessionBody["subscription_data[trial_period_days]"] = String(trialDays);
      }

      // BR aceita só cartão pra subscription recorrente
      sessionBody["payment_method_types[0]"] = "card";
    } else if (mode === "setup") {
      // Stripe exige payment_method_types em mode=setup
      sessionBody["payment_method_types[0]"] = "card";
    }

    const stripeRes = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(sessionBody).toString(),
    });

    const stripeData = await stripeRes.json();
    if (!stripeRes.ok) {
      const errMsg = (stripeData.error as Record<string, string> | undefined)?.message ?? "Falha no Stripe.";
      jsonLog("error", { reqId, evt: "checkout_stripe_error", err: errMsg, status: stripeRes.status });
      return jsonResponse(req, { error: errMsg }, 500);
    }

    jsonLog("info", {
      reqId,
      evt: "checkout_session_created",
      provider: "stripe",
      orgId: organization_id,
      planId: plan?.id ?? null,
      mode,
      sessionId: stripeData.id,
      orgSlug,
    });

    return jsonResponse(req, {
      success: true,
      url: stripeData.url,
      session_id: stripeData.id,
    });
  } catch (err) {
    jsonLog("error", { reqId, evt: "checkout_unexpected_error", err: err instanceof Error ? err.message : String(err) });
    return jsonResponse(req, { error: "Erro inesperado ao criar checkout." }, 500);
  }
});
