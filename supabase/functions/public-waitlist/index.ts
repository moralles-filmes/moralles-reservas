// Public waitlist entry. The service-only wrapper locks public unit/org flags
// through the atomic enter_waitlist INSERT. Anon direct writes are revoked.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveOrCreateCustomer } from "../_shared/resolve-customer.ts";
import { genRequestId, jsonLog } from "../_shared/security.ts";
import { submitPublicWaitlist } from "./core.ts";
import { ipRateKey } from "./ip-rate-key.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ success: false, reason: "method_not_allowed", message: "Método não permitido." }, 405);

  const requestId = genRequestId();
  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 16_384) return jsonResponse({ success: false, reason: "invalid_input", message: "Dados da fila inválidos." }, 400);
    body = JSON.parse(raw);
  } catch {
    return jsonResponse({ success: false, reason: "invalid_input", message: "Dados da fila inválidos." }, 400);
  }

  let rateKey: string | null;
  try { rateKey = await ipRateKey(req.headers); }
  catch { rateKey = null; }
  if (!rateKey) return jsonResponse({ success: false, reason: "dependency_unavailable", message: "Não foi possível conferir o limite de tentativas agora." }, 503);
  const ipKey = rateKey;

  const result = await submitPublicWaitlist(body, {
    publicUnit: async (unitId) => {
      const { data: unit, error: unitError } = await supabase.from("units")
        .select("organization_id, is_public").eq("id", unitId).maybeSingle();
      if (unitError) throw unitError;
      if (!unit || unit.is_public !== true) return null;
      const { data: org, error: orgError } = await supabase.from("organizations")
        .select("is_public, billing_status").eq("id", unit.organization_id).maybeSingle();
      if (orgError) throw orgError;
      if (!org || org.is_public !== true) return null;
      return { organizationId: unit.organization_id, billingStatus: org.billing_status };
    },
    rateLimit: async (unitId) => {
      const { data, error } = await supabase.rpc("check_public_waitlist_rate_limit", {
        p_unit_id: unitId,
        p_ip_hash: ipKey,
      });
      if (error) throw error;
      return data === true;
    },
    enter: async (input) => {
      const { data, error } = await supabase.rpc("enter_public_waitlist", {
        p_unit_id: input.unitId,
        p_customer_name: input.name,
        p_customer_phone: input.phone,
        p_party_size: input.partySize,
        p_notes: input.notes,
        p_priority_category: input.priority,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : null;
      return row ? { id: row.waitlist_id, code: row.code } : null;
    },
    customer: async (input, organizationId) => {
      const customer = await resolveOrCreateCustomer(supabase, {
        organizationId, phone: input.phone, name: input.name,
      });
      return customer.id;
    },
    link: async (waitlistId, unitId, customerId) => {
      const { data, error } = await supabase.from("waitlist")
        .update({ customer_id: customerId })
        .eq("id", waitlistId).eq("unit_id", unitId).is("customer_id", null)
        .select("id");
      if (error) throw error;
      return Array.isArray(data) && data.length === 1;
    },
    consent: async (unitId, customerId, waitlistId) => {
      const { error } = await supabase.rpc("record_public_promotional_opt_in", {
        p_unit_id: unitId,
        p_customer_id: customerId,
        p_reference: `waitlist:${waitlistId};form:v1`,
      });
      return !error;
    },
    onFailure: (failure) => jsonLog("error", {
      requestId, evt: "public_waitlist_post_entry_failed", ...failure,
    }),
  });
  return jsonResponse(result.body, result.status);
});
