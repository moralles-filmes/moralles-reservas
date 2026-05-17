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
//      nos últimos days_window dias E até ontem (não conta reservas futuras).
//      Cooldown = validity_days da própria regra: skip se já emitiu nesse
//      período.
//
// Auth via x-internal-key (mesmo padrão das outras edge functions internas).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog, requireInternalAuth } from "../_shared/security.ts";
import {
  DEFAULT_GIFTBACK_TEMPLATE,
  ensureUniqueVoucherCode,
  expiresAtEndOfDayBrt,
  formatExpiryBR,
  renderGiftbackTemplate,
} from "../_shared/giftback.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_API_KEY = Deno.env.get("INTERNAL_API_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;

interface UnitContext {
  unit_id: string;
  unit_name: string;
  whatsapp_enabled: boolean;
  template: string;
}

// Cache invalidado no início de cada invocação (B10).
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

  // B8: defesa final contra phone vazio/curto. Caller já filtra, mas guarda.
  const phoneDigits = (customerPhone ?? "").replace(/\D/g, "");
  if (phoneDigits.length < 10) {
    jsonLog("info", { evt: "voucher_skipped_no_phone", unit_id: unitId, rule_id: ruleId });
    return { ok: false, reason: "no_phone" };
  }

  const ctx = await loadUnitContext(unitId);

  const code = await ensureUniqueVoucherCode(supabase);
  // B6: fim do dia BRT — alinhado ao webhook-whatsapp.
  const expiresAtIso = expiresAtEndOfDayBrt(validityDays);

  const { error: insertErr } = await supabase
    .from("vouchers")
    .insert({
      unit_id: unitId,
      rule_id: ruleId,
      customer_id: customerId,
      code,
      discount_percent: discountPercent,
      expires_at: expiresAtIso,
    });

  if (insertErr) {
    // 23505 = UNIQUE violation (vouchers_unit_rule_customer_active_idx).
    // Outra execução em paralelo já emitiu — tratamos como idempotente.
    const isDuplicate = String((insertErr as { code?: string }).code ?? "") === "23505";
    jsonLog(isDuplicate ? "info" : "warn", {
      evt: isDuplicate ? "voucher_dedup_race" : "voucher_insert_failed",
      error: insertErr.message,
    });
    return { ok: false, reason: isDuplicate ? "duplicate" : insertErr.message };
  }

  if (!ctx.whatsapp_enabled) {
    jsonLog("info", { evt: "voucher_whatsapp_skipped", reason: "channel_disabled", unit_id: unitId });
    return { ok: true, reason: "whatsapp_disabled" };
  }

  const message = renderGiftbackTemplate(ctx.template, {
    discount: discountPercent,
    unidade: ctx.unit_name,
    codigo: code,
    validade: formatExpiryBR(expiresAtIso),
  });

  // Dispara send-whatsapp internamente. Ele grava notifications_sent e
  // appenda à conversation. customer_id é resolvido via phone no helper.
  try {
    const sendRes = await fetch(`${SUPABASE_URL}/functions/v1/send-whatsapp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-key": INTERNAL_API_KEY,
      },
      body: JSON.stringify({
        phone: phoneDigits,
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

/**
 * Resolve o "today" em BRT. Cron roda 12:00 UTC (09:00 BRT), runtime UTC.
 * Subtrai o offset e usa UTC accessors pra ler o calendário BRT.
 */
function getTodayBrtParts(): { mm: string; dd: string; isoDate: string; isLeapYear: boolean } {
  const nowBrt = new Date(Date.now() - BRT_OFFSET_MS);
  const y = nowBrt.getUTCFullYear();
  const m = nowBrt.getUTCMonth() + 1; // 1-12
  const d = nowBrt.getUTCDate();
  const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return {
    mm: String(m).padStart(2, "0"),
    dd: String(d).padStart(2, "0"),
    isoDate: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    isLeapYear: isLeap,
  };
}

async function processBirthday(): Promise<{ issued: number; errors: string[] }> {
  const errors: string[] = [];
  let issued = 0;

  const { data: rules } = await supabase
    .from("voucher_rules")
    .select("id, unit_id, discount_percent, validity_days")
    .eq("trigger_type", "birthday")
    .eq("active", true);

  if (!rules || rules.length === 0) return { issued, errors };

  const today = getTodayBrtParts();
  const todayMmdd = `${today.mm}-${today.dd}`;
  // B11: em ano não-bissexto, clientes nascidos 29/02 recebem em 28/02
  // (regra civil brasileira).
  const acceptLeapBirthday = !today.isLeapYear && todayMmdd === "02-28";

  for (const rule of rules) {
    const { data: unitRow } = await supabase
      .from("units")
      .select("organization_id")
      .eq("id", rule.unit_id)
      .maybeSingle();
    if (!unitRow) continue;

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
      if (mmdd === todayMmdd) return true;
      if (acceptLeapBirthday && mmdd === "02-29") return true;
      return false;
    });

    for (const customer of matching) {
      // B8: filtro defensivo de phone antes do issueAndSend.
      const phoneDigits = (customer.phone ?? "").replace(/\D/g, "");
      if (phoneDigits.length < 10) {
        jsonLog("info", { evt: "birthday_skipped_no_phone", customer_id: customer.id });
        continue;
      }

      // Visitou esta unit? (confirmed efetivada OU no_show; ambos contam como visita registrada)
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
        customerPhone: phoneDigits,
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

  // B7: limite superior — exclui reservas futuras. Conta só visitas até ontem (BRT).
  const yesterdayBrt = new Date(Date.now() - BRT_OFFSET_MS);
  yesterdayBrt.setUTCDate(yesterdayBrt.getUTCDate() - 1);
  const yesterdayIso = yesterdayBrt.toISOString().slice(0, 10);

  for (const rule of rules) {
    if (!rule.visits_required || !rule.days_window) continue;

    const windowStart = new Date(Date.now() - BRT_OFFSET_MS);
    windowStart.setUTCDate(windowStart.getUTCDate() - (rule.days_window as number));
    const windowStartIso = windowStart.toISOString().slice(0, 10);

    // B7: window agora tem upper bound (yesterday, inclusivo).
    const { data: reservations } = await supabase
      .from("reservations")
      .select("customer_id")
      .eq("unit_id", rule.unit_id)
      .in("status", ["confirmed", "no_show"])
      .gte("date", windowStartIso)
      .lte("date", yesterdayIso);

    if (!reservations || reservations.length === 0) continue;

    const counts = new Map<string, number>();
    for (const r of reservations) {
      const cid = (r as { customer_id: string }).customer_id;
      counts.set(cid, (counts.get(cid) ?? 0) + 1);
    }

    const eligible = [...counts.entries()]
      .filter(([, count]) => count >= (rule.visits_required as number))
      .map(([id]) => id);

    if (eligible.length === 0) continue;

    // B9: cooldown estável usa `validity_days` da regra. Cliente só pode
    // ganhar de novo após esse período. Antes o filtro era "issued_at >
    // windowStart" — windowStart desliza dia a dia, então cliente que
    // ganhou há `days_window + 1` dias virava re-elegível.
    const cooldownStart = new Date();
    cooldownStart.setUTCDate(cooldownStart.getUTCDate() - (rule.validity_days as number));

    const { data: recentVouchers } = await supabase
      .from("vouchers")
      .select("customer_id")
      .eq("rule_id", rule.id)
      .in("customer_id", eligible)
      .gt("issued_at", cooldownStart.toISOString());

    const alreadyIssued = new Set(
      // deno-lint-ignore no-explicit-any
      ((recentVouchers ?? []) as any[]).map((v) => v.customer_id),
    );

    const remaining = eligible.filter((id) => !alreadyIssued.has(id));
    if (remaining.length === 0) continue;

    // B8: já filtra phone non-empty no DB.
    const { data: customers } = await supabase
      .from("customers")
      .select("id, phone")
      .in("id", remaining)
      .is("deleted_at", null)
      .not("phone", "is", null);

    if (!customers) continue;

    for (const c of customers) {
      const phoneDigits = String((c as { phone: string }).phone ?? "").replace(/\D/g, "");
      if (phoneDigits.length < 10) {
        jsonLog("info", { evt: "frequency_skipped_no_phone", customer_id: c.id });
        continue;
      }

      const result = await issueAndSend({
        unitId: rule.unit_id,
        ruleId: rule.id,
        customerId: c.id,
        customerPhone: phoneDigits,
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

  // B10: invalida cache de unit settings no início de cada invocação.
  unitCache.clear();

  // B12: advisory lock — evita duas execuções concorrentes (cron + chamada
  // manual de debug) duplicarem trabalho. Wrappers em migration 20260517110000.
  // Fallback: se RPC indisponível, prossegue (UNIQUE PARTIAL em vouchers
  // protege contra duplicar (rule, customer) ativos).
  let hasLock = false;
  try {
    const { data: lockData, error: lockErr } = await supabase.rpc("try_giftback_lock");
    if (lockErr) {
      jsonLog("info", { evt: "advisory_lock_unavailable", err: lockErr.message });
    } else {
      hasLock = lockData === true;
      if (!hasLock) {
        jsonLog("info", { evt: "voucher_triggers_already_running" });
        return new Response(
          JSON.stringify({ skipped: true, reason: "already_running" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }
  } catch (err) {
    jsonLog("info", { evt: "advisory_lock_error", err: String(err).slice(0, 200) });
  }

  const t0 = Date.now();
  const errors: string[] = [];

  try {
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
  } finally {
    if (hasLock) {
      try {
        await supabase.rpc("release_giftback_lock");
      } catch (err) {
        jsonLog("warn", { evt: "advisory_unlock_failed", err: String(err).slice(0, 200) });
      }
    }
  }
});
