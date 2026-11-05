// Mapa público de mesas (sem JWT): a página online e o link do WhatsApp
// mostram o salão e as mesas livres para o cliente escolher. Devolve só
// geometria e disponibilidade, nunca dado de reserva ou cliente. Service role
// porque as tabelas de ocupação e links não têm leitura anon; toda leitura
// filtra a unidade resolvida pelo próprio recurso (unidade pública ou link).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { loadSeatMap } from "../_shared/availability.ts";
import { loadSeatChoiceEnabled } from "../_shared/adapters/hall-seating.ts";
import { ipRateKeyFor } from "../_shared/ip-rate-key.ts";
import { toE164BrPhone } from "../_shared/phone.ts";
import { genRequestId, jsonLog } from "../_shared/security.ts";
import { handleSeatMap } from "./core.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ ok: false, reason: "method_not_allowed" }, 405);

  const requestId = genRequestId();
  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 16_384) return jsonResponse({ ok: false, reason: "invalid_input" }, 400);
    body = JSON.parse(raw);
  } catch {
    return jsonResponse({ ok: false, reason: "invalid_input" }, 400);
  }

  let rateKey: string | null;
  try { rateKey = await ipRateKeyFor(req.headers, "public-seat-map"); }
  catch { rateKey = null; }
  if (!rateKey) return jsonResponse({ ok: false, reason: "dependency_unavailable" }, 503);
  const ipKey = rateKey;

  const result = await handleSeatMap(body, {
    publicUnit: async (unitId) => {
      const { data: unit, error: unitError } = await supabase.from("units")
        .select("name, organization_id, is_public").eq("id", unitId).maybeSingle();
      if (unitError) throw unitError;
      if (!unit || unit.is_public !== true) return null;
      const { data: org, error: orgError } = await supabase.from("organizations")
        .select("is_public, billing_status").eq("id", unit.organization_id).maybeSingle();
      if (orgError) throw orgError;
      if (!org || org.is_public !== true) return null;
      return { name: unit.name, billingStatus: org.billing_status };
    },
    rateLimit: async (unitId) => {
      const { data, error } = await supabase.rpc("check_public_seat_map_rate_limit", {
        p_unit_id: unitId,
        p_ip_hash: ipKey,
      });
      if (error) throw error;
      return data === true;
    },
    link: async (tokenHash) => {
      const { data, error } = await supabase.from("seat_choice_links")
        .select("unit_id, hall_id, channel_id, date, time, party_size, expires_at")
        .eq("token_hash", tokenHash)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        unitId: data.unit_id,
        hallId: data.hall_id,
        channelId: data.channel_id,
        date: data.date,
        time: data.time,
        partySize: data.party_size,
        expiresAt: data.expires_at,
      };
    },
    seatChoiceEnabled: (unitId) => loadSeatChoiceEnabled(supabase, unitId),
    seatMap: (args) => loadSeatMap(supabase, args),
    channelPhone: async (channelId, unitId) => {
      const { data, error } = await supabase.from("whatsapp_channels")
        .select("display_phone").eq("id", channelId).eq("unit_id", unitId).maybeSingle();
      if (error) throw error;
      const raw = typeof data?.display_phone === "string" ? data.display_phone : "";
      if (!raw) return null;
      const e164 = toE164BrPhone(raw);
      return /^\d{12,13}$/.test(e164) ? e164 : null;
    },
    now: () => new Date(),
    onError: (err) => {
      const e = err as { code?: unknown; message?: unknown } | null;
      jsonLog("error", {
        requestId,
        evt: "public_seat_map_unavailable",
        code: typeof e?.code === "string" ? e.code : null,
        // readFailed lança só "availability_read_failed"; o `where` vai no próprio log dele.
        kind: e?.message === "availability_read_failed" ? "availability_read_failed" : "dependency_error",
      });
    },
  });
  return jsonResponse(result.json, result.status);
});
