// Processador diário dos gatilhos automáticos de Giftback.
//
// Chamado via pg_cron 1x ao dia (12:00 UTC = 09:00 BRT). Faz 3 etapas:
//   1. Expira vouchers vencidos (chama RPC expire_vouchers).
//   2. Aniversário: pra cada rule trigger_type='birthday', emite voucher pra
//      customers da org cuja data de nascimento é hoje E que já visitaram a
//      unit dona da rule. Idempotente (skip se voucher dessa rule emitido nos
//      últimos 365 dias).
//   3. Frequência: pra cada rule trigger_type='frequency', emite voucher pra
//      customers que tiveram >= visits_required reservations confirmed/no_show
//      nos últimos days_window dias. Idempotente (skip se já emitiu nesse
//      mesmo days_window).
//
// Auth via x-internal-key (mesmo padrão das outras edge functions internas).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog, requireInternalAuth } from "../_shared/security.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_API_KEY = Deno.env.get("INTERNAL_API_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const DEFAULT_GIFTBACK_TEMPLATE =
  "🎁 Você ganhou {{discount}}% de desconto na sua próxima visita ao {{unidade}}!\n\n" +
  "Código: *{{codigo}}*\nVálido até *{{validade}}*.\n\n" +
  "Apresente esse código quando for pagar.";

const VOUCHER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateVoucherCode(): string {
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += VOUCHER_CODE_ALPHABET[Math.floor(Math.random() * VOUCHER_CODE_ALPHABET.length)];
  }
  return out;
}

function renderTemplate(
  template: string,
  vars: { discount: number; unidade: string; codigo: string; validade: string },
): string {
  return template
    .replace(/\{\{discount\}\}/g, String(vars.discount))
    .replace(/\{\{unidade\}\}/g, vars.unidade)
    .replace(/\{\{codigo\}\}/g, vars.codigo)
    .replace(/\{\{validade\}\}/g, vars.validade);
}

interface UnitContext {
  unit_id: string;
  unit_name: string;
  whatsapp_enabled: boolean;
  template: string;
}

const unitCache = new Map<string, UnitContext>();

async function loadUnitContext(unitId: string): Promise<UnitContext> {
  const cached = unitCache.get(unitId);
  if (cached) return cached;

  const [unitRes, settingsRes] = await Promise.all([
    supabase.from("units").select("name").eq("id", unitId).maybeSingle(),
    supabase
      .from("settings")
      .select("key, value")
      .eq("unit_id", unitId)
      .in("key", ["giftback_whatsapp_enabled", "giftback_message_template"]),
  ]);

  // deno-lint-ignore no-explicit-any
  const settings = Object.fromEntries(((settingsRes.data ?? []) as any[]).map((r) => [r.key, r.value]));
  const whatsappEnabled =
    settings.giftback_whatsapp_enabled === false ||
    settings.giftback_whatsapp_enabled === "false"
      ? false
      : true;
  const template: string =
    typeof settings.giftback_message_template === "string" && settings.giftback_message_template
      ? settings.giftback_message_template
      : DEFAULT_GIFTBACK_TEMPLATE;

  const ctx: UnitContext = {
    unit_id: unitId,
    unit_name: (unitRes.data?.name as string) ?? "nosso restaurante",
    whatsapp_enabled: whatsappEnabled,
    template,
  };
  unitCache.set(unitId, ctx);
  return ctx;
}

async function ensureUniqueCode(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateVoucherCode();
    const { data } = await supabase
      .from("vouchers")
      .select("id")
      .eq("code", code)
      .eq("status", "active")
      .maybeSingle();
    if (!data) return code;
  }
  return `${generateVoucherCode()}${Date.now().toString(36).slice(-2).toUpperCase()}`;
}

interface IssueArgs {
  unitId: string;
  ruleId: string;
  customerId: string;
  customerPhone: string;
  discountPercent: number;
  validityDays: number;
}

async function issueAndSend(args: IssueArgs): Promise<{ ok: boolean; reason?: string }> {
  const { unitId, ruleId, customerId, customerPhone, discountPercent, validityDays } = args;

  const ctx = await loadUnitContext(unitId);

  const code = await ensureUniqueCode();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + validityDays);

  const { error: insertErr } = await supabase
    .from("vouchers")
    .insert({
      unit_id: unitId,
      rule_id: ruleId,
      customer_id: customerId,
      code,
      discount_percent: discountPercent,
      expires_at: expiresAt.toISOString(),
    });

  if (insertErr) {
    jsonLog("warn", { evt: "voucher_insert_failed", error: insertErr.message });
    return { ok: false, reason: insertErr.message };
  }

  if (!ctx.whatsapp_enabled) {
    jsonLog("info", { evt: "voucher_whatsapp_skipped", reason: "channel_disabled", unit_id: unitId });
    return { ok: true, reason: "whatsapp_disabled" };
  }

  const validadeStr = expiresAt.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  const message = renderTemplate(ctx.template, {
    discount: discountPercent,
    unidade: ctx.unit_name,
    codigo: code,
    validade: validadeStr,
  });

  // Dispara send-whatsapp internamente. Ele grava notifications_sent.
  try {
    const sendRes = await fetch(`${SUPABASE_URL}/functions/v1/send-whatsapp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-key": INTERNAL_API_KEY,
      },
      body: JSON.stringify({
        phone: customerPhone,
        message,
        unit_id: unitId,
        kind: "voucher_issued",
      }),
    });

    if (!sendRes.ok) {
      const errText = await sendRes.text().catch(() => "");
      jsonLog("warn", {
        evt: "voucher_whatsapp_failed",
        unit_id: unitId,
        code,
        status: sendRes.status,
        body: errText.slice(0, 200),
      });
      return { ok: true, reason: `whatsapp_send_${sendRes.status}` };
    }
  } catch (err) {
    jsonLog("warn", {
      evt: "voucher_whatsapp_error",
      unit_id: unitId,
      code,
      err: String(err),
    });
    return { ok: true, reason: "whatsapp_send_error" };
  }

  jsonLog("info", { evt: "voucher_emitted", unit_id: unitId, rule_id: ruleId, code });
  return { ok: true };
}

// ─── Step: Aniversário ────────────────────────────────────────────────────────

async function processBirthday(): Promise<{ issued: number; errors: string[] }> {
  const errors: string[] = [];
  let issued = 0;

  const { data: rules } = await supabase
    .from("voucher_rules")
    .select("id, unit_id, discount_percent, validity_days")
    .eq("trigger_type", "birthday")
    .eq("active", true);

  if (!rules || rules.length === 0) return { issued, errors };

  const today = new Date();
  const todayMmdd = `${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  for (const rule of rules) {
    // Pega org_id da unit
    const { data: unitRow } = await supabase
      .from("units")
      .select("organization_id")
      .eq("id", rule.unit_id)
      .maybeSingle();
    if (!unitRow) continue;

    // Customers da org com aniversário hoje
    const { data: customers } = await supabase
      .from("customers")
      .select("id, name, phone, birthday")
      .eq("organization_id", unitRow.organization_id)
      .not("birthday", "is", null)
      .is("deleted_at", null);

    if (!customers) continue;

    // deno-lint-ignore no-explicit-any
    const matching = (customers as any[]).filter((c) => {
      if (!c.birthday) return false;
      const mmdd = String(c.birthday).slice(5, 10); // YYYY-MM-DD → MM-DD
      return mmdd === todayMmdd;
    });

    for (const customer of matching) {
      // Visitou esta unit?
      const { count: visits } = await supabase
        .from("reservations")
        .select("id", { count: "exact", head: true })
        .eq("unit_id", rule.unit_id)
        .eq("customer_id", customer.id)
        .in("status", ["confirmed", "no_show"]);
      if (!visits || visits === 0) continue;

      // Idempotência: já emitiu voucher dessa rule pra esse customer no último ano?
      const oneYearAgo = new Date();
      oneYearAgo.setDate(oneYearAgo.getDate() - 365);
      const { data: existing } = await supabase
        .from("vouchers")
        .select("id")
        .eq("rule_id", rule.id)
        .eq("customer_id", customer.id)
        .gt("issued_at", oneYearAgo.toISOString())
        .limit(1)
        .maybeSingle();
      if (existing) continue;

      const result = await issueAndSend({
        unitId: rule.unit_id,
        ruleId: rule.id,
        customerId: customer.id,
        customerPhone: customer.phone,
        discountPercent: rule.discount_percent,
        validityDays: rule.validity_days,
      });

      if (result.ok) issued++;
      else errors.push(`birthday rule=${rule.id} customer=${customer.id}: ${result.reason}`);
    }
  }

  return { issued, errors };
}

// ─── Step: Frequência ─────────────────────────────────────────────────────────

async function processFrequency(): Promise<{ issued: number; errors: string[] }> {
  const errors: string[] = [];
  let issued = 0;

  const { data: rules } = await supabase
    .from("voucher_rules")
    .select("id, unit_id, discount_percent, validity_days, visits_required, days_window")
    .eq("trigger_type", "frequency")
    .eq("active", true);

  if (!rules || rules.length === 0) return { issued, errors };

  for (const rule of rules) {
    if (!rule.visits_required || !rule.days_window) continue;

    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - (rule.days_window as number));
    const windowStartIso = windowStart.toISOString().slice(0, 10);

    // Pega reservations da unit no windows
    const { data: reservations } = await supabase
      .from("reservations")
      .select("customer_id")
      .eq("unit_id", rule.unit_id)
      .in("status", ["confirmed", "no_show"])
      .gte("date", windowStartIso);

    if (!reservations || reservations.length === 0) continue;

    // Conta por customer
    const counts = new Map<string, number>();
    for (const r of reservations) {
      const cid = (r as { customer_id: string }).customer_id;
      counts.set(cid, (counts.get(cid) ?? 0) + 1);
    }

    const eligible = [...counts.entries()]
      .filter(([, count]) => count >= (rule.visits_required as number))
      .map(([id]) => id);

    if (eligible.length === 0) continue;

    // Idempotência: skip customers que já receberam dessa rule dentro do window
    const { data: recentVouchers } = await supabase
      .from("vouchers")
      .select("customer_id")
      .eq("rule_id", rule.id)
      .in("customer_id", eligible)
      .gt("issued_at", windowStart.toISOString());

    const alreadyIssued = new Set(
      // deno-lint-ignore no-explicit-any
      ((recentVouchers ?? []) as any[]).map((v) => v.customer_id),
    );

    const remaining = eligible.filter((id) => !alreadyIssued.has(id));
    if (remaining.length === 0) continue;

    // Carrega phones
    const { data: customers } = await supabase
      .from("customers")
      .select("id, phone")
      .in("id", remaining)
      .is("deleted_at", null);

    if (!customers) continue;

    for (const c of customers) {
      const result = await issueAndSend({
        unitId: rule.unit_id,
        ruleId: rule.id,
        customerId: c.id,
        customerPhone: (c as { phone: string }).phone,
        discountPercent: rule.discount_percent,
        validityDays: rule.validity_days,
      });

      if (result.ok) issued++;
      else errors.push(`frequency rule=${rule.id} customer=${c.id}: ${result.reason}`);
    }
  }

  return { issued, errors };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const t0 = Date.now();
  const errors: string[] = [];

  // 1. Expira vencidos
  let expiredCount = 0;
  try {
    const { data, error } = await supabase.rpc("expire_vouchers");
    if (error) {
      errors.push(`expire_vouchers: ${error.message}`);
    } else {
      expiredCount = (data as number | null) ?? 0;
    }
  } catch (err) {
    errors.push(`expire_vouchers: ${String(err).slice(0, 200)}`);
  }

  // 2. Aniversários
  const birthday = await processBirthday().catch((err) => {
    errors.push(`processBirthday: ${String(err).slice(0, 200)}`);
    return { issued: 0, errors: [] as string[] };
  });

  // 3. Frequência
  const frequency = await processFrequency().catch((err) => {
    errors.push(`processFrequency: ${String(err).slice(0, 200)}`);
    return { issued: 0, errors: [] as string[] };
  });

  errors.push(...birthday.errors, ...frequency.errors);

  jsonLog("info", {
    evt: "voucher_triggers_done",
    expired: expiredCount,
    birthday_issued: birthday.issued,
    frequency_issued: frequency.issued,
    errors_count: errors.length,
    duration_ms: Date.now() - t0,
  });

  return new Response(
    JSON.stringify({
      expired_count: expiredCount,
      birthday_issued: birthday.issued,
      frequency_issued: frequency.issued,
      errors,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
});
