// Painel administrativo do inventário de instâncias Z-API (Fase 6b).
// EXCLUSIVO de platform_admin: esta tabela contém o que a PLATAFORMA paga.
//
// PROJEÇÃO SEGURA, NÃO FILTRO TARDIO: as respostas montam lista EXPLÍCITA de
// colunas. É a lição paga duas vezes — o vazamento de billing_email por
// privilégio de coluna (migration 086) e o molde de ORG_BILLING_PUBLIC_COLUMNS
// em manage-billing. Com `select("*")` moldado depois, campo novo entra e vaza
// sozinho.
//
// NÃO ESCREVE em organizations.billing_status, billing_subscriptions,
// organization_entitlement_overrides nem whatsapp_channels. NÃO chama a Z-API.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeadersFor } from "../_shared/cors.ts";
import { genRequestId, jsonLog } from "../_shared/security.ts";
import {
  assertProvisioningAllowed,
  canTransition,
  validateProviderInstanceRef,
  type LifecycleState,
  type ProvisioningIntent,
} from "../_shared/whatsapp-instance-core.ts";
import { nextDueFromAnchor } from "../_shared/whatsapp-instance-cycle-core.ts";
import { simulatePartner } from "../_shared/whatsapp-partner-simulator-core.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Listas EXPLÍCITAS. `provider_instance_ref` entra porque o admin precisa
// identificar a instância no painel do fornecedor — é identificador, não
// credencial. Nenhuma coluna de segredo existe nestas tabelas.
const INSTANCE_COLUMNS = [
  "id", "organization_id", "unit_id", "channel_id", "provider", "provider_instance_ref",
  "lifecycle_state", "provider_cycle_anchor_day", "current_cycle_started_on",
  "current_cycle_due_on", "cycle_source", "current_monthly_cost_cents", "cost_source",
  "cost_updated_at", "cost_note", "cancellation_requested_at", "cancellation_reason",
  "provider_access_until", "end_confirmation_required_at", "ended_at",
  "end_confirmation_note", "planned_provision_on", "last_synced_at",
  "last_seen_provider_status", "last_divergence_kind", "last_divergence_at",
  "notes", "created_at", "updated_at",
].join(", ");

const CYCLE_COLUMNS = [
  "id", "instance_id", "cycle_start", "provider_due_on", "status",
  "provider_cost_cents", "cost_source", "customer_revenue_cents", "revenue_source",
  "gross_margin_cents", "closed_at", "notes", "created_at",
].join(", ");

const ALERT_COLUMNS = [
  "id", "subject_type", "subject_id", "organization_id", "instance_id", "channel_id",
  "alert_type", "dedupe_key", "status", "first_detected_at", "last_seen_at",
  "occurrences", "last_reminder_at", "acknowledged_at", "resolved_at",
  "resolution_note", "payload", "dispatch_enabled_at_enqueue",
].join(", ");

const MIN_REASON_LENGTH = 5;

function jsonResponse(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  // Continua fail-closed: indisponibilidade nega. Mas sem este log, "banco
  // fora do ar" e "não é admin" produziam o MESMO 403 mudo — o operador
  // legítimo veria "sem permissão" e nada indicaria a causa real.
  if (error) {
    jsonLog("error", {
      reqId, evt: "platform_admin_lookup_failed",
      err: error.message, needsAdminAction: true,
    });
    return false;
  }
  return !!data;
}

/**
 * Procedência do custo. `cost_source` é `text` sem CHECK no banco (diferente de
 * `provider`, `lifecycle_state` e `cycle_source`), então a whitelist mora aqui:
 * valor livre vindo do payload poluiria justamente o campo que diz de onde veio
 * o número que a fase inteira existe para registrar.
 */
const COST_SOURCES = ["ADMIN_INFORMED", "PROVIDER_INVOICE", "PROVIDER_PANEL", "ESTIMATED"];

function normalizeCostSource(raw: unknown): string | null {
  if (raw === undefined || raw === null) return "ADMIN_INFORMED";
  const v = String(raw);
  return COST_SOURCES.indexOf(v) === -1 ? null : v;
}

/** Motivo é obrigatório NA PRÓPRIA ação. String vazia ou " " não passa. */
function requireReason(body: Record<string, unknown>): string | null {
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  return reason.length >= MIN_REASON_LENGTH ? reason : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeadersFor(req) });

  const reqId = genRequestId();

  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse(req, { error: "Não autenticado." }, 401);

    const { data: callerData, error: callerErr } = await supabase.auth.getUser(jwt);
    if (callerErr || !callerData.user) return jsonResponse(req, { error: "Sessão inválida." }, 401);
    const callerId = callerData.user.id;

    // Sem exceção org-scoped nesta fase: NENHUMA action desta EF é
    // client-friendly. O lojista não vê o que a plataforma paga.
    if (!(await isPlatformAdmin(callerId))) {
      return jsonResponse(req, { error: "Acesso restrito a administradores da plataforma." }, 403);
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action ?? "");
    if (!action) return jsonResponse(req, { error: "action é obrigatória." }, 400);

    // ── Leitura ──────────────────────────────────────────────────────────

    if (action === "list_instances") {
      const { data, error } = await supabase
        .from("whatsapp_instances")
        .select(INSTANCE_COLUMNS)
        .order("created_at", { ascending: false });
      if (error) {
        jsonLog("error", { reqId, evt: "wa_instances_list_failed", err: error.message });
        return jsonResponse(req, { error: "Não foi possível carregar as instâncias." }, 500);
      }
      return jsonResponse(req, { instances: data ?? [] });
    }

    if (action === "get_instance") {
      const id = String(body.instance_id ?? "");
      if (!id) return jsonResponse(req, { error: "instance_id é obrigatório." }, 400);

      const [inst, cycles, alerts] = await Promise.all([
        supabase.from("whatsapp_instances").select(INSTANCE_COLUMNS).eq("id", id).maybeSingle(),
        supabase.from("whatsapp_instance_cycles").select(CYCLE_COLUMNS)
          .eq("instance_id", id).order("cycle_start", { ascending: false }),
        supabase.from("whatsapp_instance_alerts").select(ALERT_COLUMNS)
          .eq("instance_id", id).order("first_detected_at", { ascending: false }),
      ]);

      if (inst.error || !inst.data) return jsonResponse(req, { error: "Instância não encontrada." }, 404);
      return jsonResponse(req, {
        instance: inst.data,
        cycles: cycles.data ?? [],
        alerts: alerts.data ?? [],
      });
    }

    if (action === "list_alerts") {
      const status = body.status ? String(body.status) : null;
      let q = supabase.from("whatsapp_instance_alerts").select(ALERT_COLUMNS)
        .order("first_detected_at", { ascending: false });
      if (status) q = q.eq("status", status);
      const { data, error } = await q;
      if (error) {
        jsonLog("error", { reqId, evt: "wa_alerts_list_failed", err: error.message });
        return jsonResponse(req, { error: "Não foi possível carregar os alertas." }, 500);
      }
      return jsonResponse(req, { alerts: data ?? [] });
    }

    if (action === "simulate_partner") {
      // NÃO ESCREVE NADA — nem instância, nem ciclo, nem alerta.
      const orgId = body.organization_id ? String(body.organization_id) : null;
      let q = supabase.from("whatsapp_instances")
        .select("id, current_monthly_cost_cents")
        .in("lifecycle_state", ["ACTIVE", "CANCELLATION_REQUESTED"]);
      if (orgId) q = q.eq("organization_id", orgId);
      const { data, error } = await q;
      if (error) {
        jsonLog("error", { reqId, evt: "wa_partner_sim_failed", err: error.message });
        return jsonResponse(req, { error: "Não foi possível carregar os custos para simular." }, 500);
      }

      const result = simulatePartner({
        instanceCosts: (data ?? []).map((r) => r.current_monthly_cost_cents),
        partnerMonthlyTargetCents: Number(body.partner_monthly_target_cents),
      });
      if (result.ok === false) {
        return jsonResponse(req, { error: result.message, code: result.code }, 400);
      }
      return jsonResponse(req, { simulation: result });
    }

    // ── Registro de instância ────────────────────────────────────────────
    // `intent` é EXPLÍCITO e obrigatório: a EF não adivinha se é backfill de
    // algo que já existe no fornecedor ou criação nova. Ausente ou
    // irreconhecível vira AMBIGUOUS, que o núcleo bloqueia (fail-closed).
    if (action === "register_instance") {
      const rawIntent = String(body.intent ?? "");
      const intent: ProvisioningIntent =
        rawIntent === "BACKFILL_EXISTING" || rawIntent === "NEW_PROVISION"
          ? (rawIntent as ProvisioningIntent)
          : "AMBIGUOUS";

      const gate = assertProvisioningAllowed(intent);
      if (gate.ok === false) {
        jsonLog("warn", { reqId, evt: "wa_provisioning_blocked", intent, callerId });
        return jsonResponse(req, { error: gate.message, code: gate.code }, 409);
      }

      const reason = requireReason(body);
      if (!reason) return jsonResponse(req, { error: "Informe o motivo do registro." }, 400);

      const orgId = String(body.organization_id ?? "");
      if (!orgId) return jsonResponse(req, { error: "organization_id é obrigatório." }, 400);

      let ref: string | null = null;
      if (body.provider_instance_ref) {
        const v = validateProviderInstanceRef(String(body.provider_instance_ref));
        if (v.ok === false) return jsonResponse(req, { error: v.message, code: v.code }, 400);
        ref = v.value;
      }

      const costCents = body.current_monthly_cost_cents ?? null;
      const hasCost = costCents !== null && costCents !== undefined;

      // Backfill NASCE em UNKNOWN quando a data não for confirmada: data
      // ausente não vira vencimento inventado, vira fila de revisão.
      const costSource = hasCost ? normalizeCostSource(body.cost_source) : null;
      if (hasCost && costSource === null) {
        return jsonResponse(req, { error: "Procedência do custo inválida." }, 400);
      }

      const { data, error } = await supabase
        .from("whatsapp_instances")
        .insert({
          organization_id: orgId,
          unit_id: body.unit_id ?? null,
          channel_id: body.channel_id ?? null,
          provider: String(body.provider ?? "zapi"),
          provider_instance_ref: ref,
          lifecycle_state: "ACTIVE",
          cycle_source: "UNKNOWN",
          current_monthly_cost_cents: hasCost ? costCents : null,
          cost_source: costSource,
          cost_updated_at: hasCost ? new Date().toISOString() : null,
          cost_updated_by: hasCost ? callerId : null,
          notes: reason,
          created_by: callerId,
          updated_by: callerId,
        })
        .select(INSTANCE_COLUMNS)
        .single();

      if (error) {
        // 23505 = a instância física já está registrada (índice provider+ref)
        // ou o canal já aponta para outra instância.
        if (error.code === "23505") {
          return jsonResponse(req, { error: "Esta instância ou este canal já está registrado." }, 409);
        }
        // 23514 = a trigger de tenant recusou (check_violation).
        if (error.code === "23514") {
          return jsonResponse(req, { error: "Unidade ou canal pertence a outra organização." }, 409);
        }
        jsonLog("error", { reqId, evt: "wa_instance_register_failed", err: error.message });
        return jsonResponse(req, { error: "Não foi possível registrar a instância." }, 500);
      }

      jsonLog("info", { reqId, evt: "wa_instance_registered", instanceId: data.id, intent });
      return jsonResponse(req, { instance: data });
    }

    // ── Confirmação da data do ciclo ─────────────────────────────────────
    // Cria o ciclo OPEN, projeta na instância e resolve a pendência de data.
    // Só aqui `cycle_source` vira ADMIN_CONFIRMED e o D-7/D-1 daquele ciclo em
    // diante é liberado.
    if (action === "confirm_cycle_date") {
      const reason = requireReason(body);
      if (!reason) return jsonResponse(req, { error: "Informe a origem da informação da data." }, 400);

      const id = String(body.instance_id ?? "");
      const cycleStart = String(body.cycle_start ?? "");
      const anchorDay = Number(body.provider_cycle_anchor_day);

      if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(cycleStart)) {
        return jsonResponse(req, { error: "Informe a instância e a data de início do ciclo." }, 400);
      }
      // A âncora é PERSISTIDA e nunca re-derivada: 31/01 → 28/02 → 31/03 só
      // funciona porque o 31 original sobrevive ao clamp. Quando a data cai em
      // 28, 29 ou 30, o painel PEDE a âncora explícita em vez de adivinhar —
      // por isso ela é obrigatória aqui.
      if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
        return jsonResponse(req, { error: "Informe o dia-âncora do ciclo (1 a 31)." }, 400);
      }

      const { data: inst } = await supabase
        .from("whatsapp_instances")
        .select("id, organization_id")
        .eq("id", id)
        .maybeSingle();
      if (!inst) return jsonResponse(req, { error: "Instância não encontrada." }, 404);

      const dueOn = nextDueFromAnchor(cycleStart, anchorDay);

      const { error: cycleErr } = await supabase.from("whatsapp_instance_cycles").insert({
        instance_id: id,
        organization_id: inst.organization_id,
        cycle_start: cycleStart,
        provider_due_on: dueOn,
        status: "OPEN",
        notes: reason,
        created_by: callerId,
      });
      // 23505 = o ciclo já existia (reexecução). Idempotente, não é erro.
      if (cycleErr && cycleErr.code !== "23505") {
        jsonLog("error", { reqId, evt: "wa_cycle_confirm_failed", err: cycleErr.message });
        return jsonResponse(req, { error: "Não foi possível registrar o ciclo." }, 500);
      }

      const { data, error } = await supabase
        .from("whatsapp_instances")
        .update({
          provider_cycle_anchor_day: anchorDay,
          current_cycle_started_on: cycleStart,
          current_cycle_due_on: dueOn,
          cycle_source: "ADMIN_CONFIRMED",
          updated_by: callerId,
        })
        .eq("id", id)
        .select(INSTANCE_COLUMNS)
        .single();
      if (error) {
        jsonLog("error", {
          reqId, evt: "wa_cycle_project_failed", instanceId: id, err: error.message,
          needsAdminAction: true,
        });
        return jsonResponse(req, {
          error: "Ciclo registrado, mas a projeção na instância falhou. Verifique o painel.",
        }, 500);
      }

      // A pendência de data deixa de existir — RESOLVIDA, nunca apagada: o
      // histórico de alerta é registro administrativo.
      await supabase.from("whatsapp_instance_alerts")
        .update({
          status: "RESOLVED",
          resolved_at: new Date().toISOString(),
          resolved_by: callerId,
          resolution_note: "Data confirmada pelo administrador.",
        })
        .eq("instance_id", id)
        .eq("alert_type", "DATE_REVIEW_REQUIRED")
        .in("status", ["OPEN", "ACKNOWLEDGED"]);

      return jsonResponse(req, { instance: data });
    }

    // ── Custo ────────────────────────────────────────────────────────────
    // Muda SÓ ciclos futuros: o custo do ciclo corrente foi congelado na
    // abertura e representa a competência que já começou.
    if (action === "set_cost") {
      const reason = requireReason(body);
      if (!reason) return jsonResponse(req, { error: "Informe o motivo e a procedência do custo." }, 400);

      const id = String(body.instance_id ?? "");
      if (!id) return jsonResponse(req, { error: "instance_id é obrigatório." }, 400);

      const raw = body.current_monthly_cost_cents;
      const isNull = raw === null || raw === undefined;
      if (!isNull && (!Number.isInteger(raw) || (raw as number) < 0)) {
        return jsonResponse(req, {
          error: "Custo deve ser inteiro em centavos, ou nulo se desconhecido.",
        }, 400);
      }

      const setCostSource = isNull ? null : normalizeCostSource(body.cost_source);
      if (!isNull && setCostSource === null) {
        return jsonResponse(req, { error: "Procedência do custo inválida." }, 400);
      }

      const { data, error } = await supabase
        .from("whatsapp_instances")
        .update({
          current_monthly_cost_cents: isNull ? null : raw,
          cost_source: setCostSource,
          cost_updated_at: isNull ? null : new Date().toISOString(),
          cost_updated_by: isNull ? null : callerId,
          cost_note: reason,
          updated_by: callerId,
        })
        .eq("id", id)
        .select(INSTANCE_COLUMNS)
        .single();
      if (error) {
        jsonLog("error", { reqId, evt: "wa_cost_update_failed", err: error.message });
        return jsonResponse(req, { error: "Não foi possível atualizar o custo." }, 500);
      }
      return jsonResponse(req, { instance: data });
    }

    // ── Cancelamento: congela no ato ─────────────────────────────────────
    // NÃO altera assinatura, billing_status, entitlement, envio, canal nem
    // credencial. Registra o término planejado do CUSTO — nada mais.
    if (action === "request_cancellation") {
      const reason = requireReason(body);
      if (!reason) return jsonResponse(req, { error: "Informe o motivo do cancelamento." }, 400);

      const id = String(body.instance_id ?? "");
      const until = String(body.provider_access_until ?? "");
      if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
        return jsonResponse(req, { error: "Informe a instância e a data-limite de acesso." }, 400);
      }

      const { data: cur } = await supabase
        .from("whatsapp_instances").select("lifecycle_state").eq("id", id).maybeSingle();
      if (!cur) return jsonResponse(req, { error: "Instância não encontrada." }, 404);

      const t = canTransition(cur.lifecycle_state as LifecycleState, "CANCELLATION_REQUESTED", {
        hasProviderEvidence: false,
      });
      if (t.ok === false) return jsonResponse(req, { error: t.message, code: t.code }, 409);

      const { data, error } = await supabase
        .from("whatsapp_instances")
        .update({
          lifecycle_state: "CANCELLATION_REQUESTED",
          cancellation_requested_at: new Date().toISOString(),
          cancellation_requested_by: callerId,
          cancellation_reason: reason,
          // Congelado. O worker NÃO recalcula isto a cada execução.
          provider_access_until: until,
          updated_by: callerId,
        })
        .eq("id", id)
        .select(INSTANCE_COLUMNS)
        .single();
      if (error) {
        jsonLog("error", { reqId, evt: "wa_cancel_failed", err: error.message });
        return jsonResponse(req, { error: "Não foi possível registrar o cancelamento." }, 500);
      }
      jsonLog("info", { reqId, evt: "wa_cancellation_requested", instanceId: id });
      return jsonResponse(req, { instance: data });
    }

    // ── Confirmação humana do encerramento ───────────────────────────────
    if (action === "confirm_end") {
      const reason = requireReason(body);
      if (!reason) {
        return jsonResponse(req, {
          error: "Descreva o que foi verificado no painel do fornecedor.",
        }, 400);
      }

      const id = String(body.instance_id ?? "");
      const { data: cur } = await supabase
        .from("whatsapp_instances").select("lifecycle_state").eq("id", id).maybeSingle();
      if (!cur) return jsonResponse(req, { error: "Instância não encontrada." }, 404);

      const t = canTransition(cur.lifecycle_state as LifecycleState, "ENDED", {
        hasProviderEvidence: true,
      });
      if (t.ok === false) return jsonResponse(req, { error: t.message, code: t.code }, 409);

      const { data, error } = await supabase
        .from("whatsapp_instances")
        .update({
          lifecycle_state: "ENDED",
          ended_at: new Date().toISOString(),
          ended_by: callerId,
          end_confirmation_note: reason,
          // Encerrada não guarda vínculo de canal: libera o índice único para
          // uma instância futura no mesmo canal.
          channel_id: null,
          updated_by: callerId,
        })
        .eq("id", id)
        .select(INSTANCE_COLUMNS)
        .single();
      if (error) {
        jsonLog("error", { reqId, evt: "wa_confirm_end_failed", err: error.message });
        return jsonResponse(req, { error: "Não foi possível confirmar o encerramento." }, 500);
      }
      return jsonResponse(req, { instance: data });
    }

    // ── Reversão do cancelamento, só com evidência ───────────────────────
    if (action === "reactivate") {
      const reason = requireReason(body);
      if (!reason) {
        return jsonResponse(req, {
          error: "Descreva a evidência de que o cancelamento foi desfeito no fornecedor.",
        }, 400);
      }

      const id = String(body.instance_id ?? "");
      const { data: cur } = await supabase
        .from("whatsapp_instances").select("lifecycle_state").eq("id", id).maybeSingle();
      if (!cur) return jsonResponse(req, { error: "Instância não encontrada." }, 404);

      // ENDED nunca volta: o núcleo recusa mesmo com evidência. Instância
      // encerrada que reapareça exige linha NOVA (outra instância física).
      const t = canTransition(cur.lifecycle_state as LifecycleState, "ACTIVE", {
        hasProviderEvidence: true,
      });
      if (t.ok === false) return jsonResponse(req, { error: t.message, code: t.code }, 409);

      const { data, error } = await supabase
        .from("whatsapp_instances")
        .update({
          lifecycle_state: "ACTIVE",
          cancellation_requested_at: null,
          cancellation_requested_by: null,
          cancellation_reason: null,
          provider_access_until: null,
          end_confirmation_required_at: null,
          notes: reason,
          updated_by: callerId,
        })
        .eq("id", id)
        .select(INSTANCE_COLUMNS)
        .single();
      if (error) {
        jsonLog("error", { reqId, evt: "wa_reactivate_failed", err: error.message });
        return jsonResponse(req, { error: "Não foi possível reverter o cancelamento." }, 500);
      }
      return jsonResponse(req, { instance: data });
    }

    // ── Vínculo e metadados ──────────────────────────────────────────────
    if (action === "update_instance") {
      const reason = requireReason(body);
      if (!reason) return jsonResponse(req, { error: "Informe o motivo da alteração." }, 400);

      const id = String(body.instance_id ?? "");
      if (!id) return jsonResponse(req, { error: "instance_id é obrigatório." }, 400);

      const patch: Record<string, unknown> = { updated_by: callerId, notes: reason };
      if ("unit_id" in body) patch.unit_id = body.unit_id ?? null;
      if ("channel_id" in body) patch.channel_id = body.channel_id ?? null;
      if ("planned_provision_on" in body) patch.planned_provision_on = body.planned_provision_on ?? null;
      if ("provider_instance_ref" in body) {
        if (body.provider_instance_ref === null) patch.provider_instance_ref = null;
        else {
          const v = validateProviderInstanceRef(String(body.provider_instance_ref));
          if (v.ok === false) return jsonResponse(req, { error: v.message, code: v.code }, 400);
          patch.provider_instance_ref = v.value;
        }
      }

      const { data, error } = await supabase
        .from("whatsapp_instances").update(patch).eq("id", id)
        .select(INSTANCE_COLUMNS).single();
      if (error) {
        if (error.code === "23505") {
          return jsonResponse(req, { error: "Este canal já está vinculado a outra instância." }, 409);
        }
        if (error.code === "23514") {
          return jsonResponse(req, { error: "Unidade ou canal pertence a outra organização." }, 409);
        }
        jsonLog("error", { reqId, evt: "wa_instance_update_failed", err: error.message });
        return jsonResponse(req, { error: "Não foi possível atualizar a instância." }, 500);
      }
      return jsonResponse(req, { instance: data });
    }

    // ── Alertas ──────────────────────────────────────────────────────────
    // ACKNOWLEDGED interrompe o LEMBRETE, não fecha o fato. RESOLVED diz que o
    // fato deixou de existir. Fato que desaparece sozinho é resolvido pelo
    // worker com nota do sistema — NUNCA apagado.
    if (action === "acknowledge_alert") {
      const id = String(body.alert_id ?? "");
      if (!id) return jsonResponse(req, { error: "alert_id é obrigatório." }, 400);

      const { data, error } = await supabase
        .from("whatsapp_instance_alerts")
        .update({
          status: "ACKNOWLEDGED",
          acknowledged_at: new Date().toISOString(),
          acknowledged_by: callerId,
        })
        .eq("id", id)
        .eq("status", "OPEN")
        .select(ALERT_COLUMNS)
        .maybeSingle();
      if (error) {
        jsonLog("error", { reqId, evt: "wa_alert_ack_failed", err: error.message });
        return jsonResponse(req, { error: "Não foi possível reconhecer o alerta." }, 500);
      }
      if (!data) return jsonResponse(req, { error: "Alerta não está aberto." }, 409);
      return jsonResponse(req, { alert: data });
    }

    if (action === "resolve_alert") {
      const note = requireReason(body);
      if (!note) return jsonResponse(req, { error: "Informe o motivo da resolução." }, 400);

      const id = String(body.alert_id ?? "");
      if (!id) return jsonResponse(req, { error: "alert_id é obrigatório." }, 400);

      const { data, error } = await supabase
        .from("whatsapp_instance_alerts")
        .update({
          status: "RESOLVED",
          resolved_at: new Date().toISOString(),
          resolved_by: callerId,
          resolution_note: note,
        })
        .eq("id", id)
        .in("status", ["OPEN", "ACKNOWLEDGED"])
        .select(ALERT_COLUMNS)
        .maybeSingle();
      if (error) {
        jsonLog("error", { reqId, evt: "wa_alert_resolve_failed", err: error.message });
        return jsonResponse(req, { error: "Não foi possível resolver o alerta." }, 500);
      }
      if (!data) return jsonResponse(req, { error: "Alerta já foi encerrado." }, 409);
      return jsonResponse(req, { alert: data });
    }

    return jsonResponse(req, { error: "Ação desconhecida." }, 400);
  } catch (err) {
    // Nunca devolver error.message cru do Postgres: mensagem curta em PT-BR
    // para o cliente, detalhe no log.
    jsonLog("error", { reqId, evt: "wa_instances_unhandled", err: String(err) });
    return jsonResponse(req, { error: "Erro interno." }, 500);
  }
});
