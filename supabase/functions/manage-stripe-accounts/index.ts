import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { genRequestId, jsonLog } from "../_shared/security.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import { getStripeSecretKey } from "../_shared/stripe-config.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const STRIPE_API = "https://api.stripe.com/v1";

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

async function stripeRequest(
  path: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: Record<string, string>,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const secretKey = await getStripeSecretKey();
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (body) opts.body = new URLSearchParams(body).toString();
  const res = await fetch(`${STRIPE_API}${path}`, opts);
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeadersFor(req) });
  }

  const reqId = genRequestId();

  try {
    const stripeKey = await getStripeSecretKey();
    if (!stripeKey) {
      return jsonResponse(req, { error: "Stripe não configurado na plataforma." }, 500);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse(req, { error: "Não autenticado." }, 401);

    const { data: callerData, error: callerErr } = await supabase.auth.getUser(jwt);
    if (callerErr || !callerData.user) {
      return jsonResponse(req, { error: "Sessão inválida." }, 401);
    }
    const callerId = callerData.user.id;

    const body = await req.json().catch(() => ({}));
    const { action, unit_id: unitId } = body;

    if (!unitId) return jsonResponse(req, { error: "unit_id é obrigatório." }, 400);

    if (!(await isPlatformAdmin(callerId))) {
      return jsonResponse(req, { error: "Apenas administradores da plataforma." }, 403);
    }

    // ── list ─────────────────────────────────────────────────────────────────
    if (action === "list") {
      const { data, error } = await supabase
        .from("stripe_accounts")
        .select(
          "id, unit_id, stripe_account_id, charges_enabled, payouts_enabled, onboarding_complete, display_name, livemode, created_at, updated_at",
        )
        .eq("unit_id", unitId)
        .maybeSingle();

      if (error) {
        jsonLog("error", { reqId, evt: "stripe_list_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao consultar conta Stripe." }, 500);
      }

      return jsonResponse(req, { success: true, account: data });
    }

    // ── create_onboarding_link ───────────────────────────────────────────────
    if (action === "create_onboarding_link") {
      const { data: existing } = await supabase
        .from("stripe_accounts")
        .select("stripe_account_id")
        .eq("unit_id", unitId)
        .maybeSingle();

      let stripeAccountId: string;

      if (existing?.stripe_account_id) {
        stripeAccountId = existing.stripe_account_id;
      } else {
        const createRes = await stripeRequest("/accounts", "POST", {
          type: "standard",
        });
        if (!createRes.ok) {
          jsonLog("error", {
            reqId,
            evt: "stripe_create_account_error",
            status: createRes.status,
            err: createRes.data,
          });
          return jsonResponse(req, { error: "Falha ao criar conta Stripe." }, 500);
        }
        stripeAccountId = createRes.data.id as string;

        const { error: insertErr } = await supabase.from("stripe_accounts").upsert(
          {
            unit_id: unitId,
            stripe_account_id: stripeAccountId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "unit_id" },
        );
        if (insertErr) {
          jsonLog("error", {
            reqId,
            evt: "stripe_insert_error",
            err: insertErr.message,
          });
        }
      }

      const returnUrl = body.return_url || `${Deno.env.get("APP_BASE_URL") ?? "https://reservas.moralles.com.br"}/platform/automacao/${body.unit_slug ?? ""}?stripe=complete`;
      const refreshUrl = body.refresh_url || returnUrl.replace("stripe=complete", "stripe=refresh");

      const linkRes = await stripeRequest("/account_links", "POST", {
        account: stripeAccountId,
        type: "account_onboarding",
        return_url: returnUrl,
        refresh_url: refreshUrl,
      });

      if (!linkRes.ok) {
        jsonLog("error", {
          reqId,
          evt: "stripe_account_link_error",
          status: linkRes.status,
          err: linkRes.data,
        });
        return jsonResponse(req, { error: "Falha ao gerar link de onboarding." }, 500);
      }

      jsonLog("info", {
        reqId,
        evt: "stripe_onboarding_link_created",
        unit_id: unitId,
        stripe_account_id: stripeAccountId,
      });

      return jsonResponse(req, {
        success: true,
        url: linkRes.data.url,
        stripe_account_id: stripeAccountId,
      });
    }

    // ── check_status ─────────────────────────────────────────────────────────
    if (action === "check_status") {
      const { data: row } = await supabase
        .from("stripe_accounts")
        .select("stripe_account_id")
        .eq("unit_id", unitId)
        .maybeSingle();

      if (!row?.stripe_account_id) {
        return jsonResponse(req, { error: "Nenhuma conta Stripe conectada." }, 404);
      }

      const acctRes = await stripeRequest(`/accounts/${row.stripe_account_id}`);
      if (!acctRes.ok) {
        jsonLog("error", {
          reqId,
          evt: "stripe_check_status_error",
          status: acctRes.status,
          err: acctRes.data,
        });
        return jsonResponse(req, { error: "Falha ao consultar status no Stripe." }, 500);
      }

      const acct = acctRes.data;
      const updates = {
        charges_enabled: acct.charges_enabled === true,
        payouts_enabled: acct.payouts_enabled === true,
        onboarding_complete: acct.details_submitted === true,
        display_name:
          (acct.business_profile as Record<string, unknown>)?.name ??
          (acct.settings as Record<string, Record<string, unknown>>)?.dashboard
            ?.display_name ??
          null,
        livemode: acct.livemode === true,
        updated_at: new Date().toISOString(),
      };

      await supabase
        .from("stripe_accounts")
        .update(updates)
        .eq("unit_id", unitId);

      jsonLog("info", {
        reqId,
        evt: "stripe_status_synced",
        unit_id: unitId,
        charges_enabled: updates.charges_enabled,
        payouts_enabled: updates.payouts_enabled,
      });

      return jsonResponse(req, { success: true, ...updates });
    }

    // ── disconnect ───────────────────────────────────────────────────────────
    if (action === "disconnect") {
      const { error } = await supabase
        .from("stripe_accounts")
        .delete()
        .eq("unit_id", unitId);

      if (error) {
        jsonLog("error", { reqId, evt: "stripe_disconnect_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao desconectar Stripe." }, 500);
      }

      jsonLog("info", { reqId, evt: "stripe_disconnected", unit_id: unitId });
      return jsonResponse(req, { success: true });
    }

    return jsonResponse(req, { error: "Ação inválida." }, 400);
  } catch (err) {
    jsonLog("error", { reqId, evt: "manage_stripe_unhandled", err: String(err) });
    return jsonResponse(req, { error: "Falha ao processar solicitação." }, 500);
  }
});
