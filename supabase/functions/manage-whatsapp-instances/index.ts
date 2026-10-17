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
//
// ORDEM DE APLICAÇÃO — QUATRO migrations precedem esta versão:
//
// 1. `register_instance` lê `billing_plans.included_features` e
//    `billing_plans.included_whatsapp_connections` (migration 094). A guarda de
//    allowance é FAIL-CLOSED: coluna inexistente vira 400 do PostgREST →
//    leitura falha → todo registro passa a responder 503.
//
// 2. O ledger `whatsapp_instance_notes` (migration 096). Aqui a consequência é
//    MENOR de propósito: o insert é best-effort, então a EF subir antes da
//    migration deixa o histórico vazio e um log com `needsAdminAction`, sem
//    quebrar nenhuma operação. Ainda assim, aplicar a migration primeiro evita
//    o buraco.
//
// 3. As RPCs `set_whatsapp_instance_cost` e `confirm_whatsapp_instance_end` e a
//    ação `CORRECT_CYCLE_COST` no CHECK de `whatsapp_instance_notes` (migration
//    104). Consequência TOTAL, não degradada: sem ela, `set_cost` e
//    `confirm_end` respondem 500 em toda invocação, e as notas de correção são
//    recusadas pelo CHECK e somem em silêncio.
//
// 4. A RPC `delete_whatsapp_instance_without_cost` e a ação `DELETE` no CHECK de
//    `whatsapp_instance_notes` (migration 20261015223000). Sem ela,
//    `delete_instance` responde 500; nenhuma outra ação depende dela.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeadersFor } from "../_shared/cors.ts";
import { genRequestId, jsonLog } from "../_shared/security.ts";
import {
  assertProvisioningAllowed,
  canTransition,
  normalizeCostSource,
  parseCostCents,
  parseUuid,
  validateProviderInstanceRef,
  type LifecycleState,
  type ProvisioningIntent,
} from "../_shared/whatsapp-instance-core.ts";
import { nextDueFromAnchor } from "../_shared/whatsapp-instance-cycle-core.ts";
import { simulatePartner } from "../_shared/whatsapp-partner-simulator-core.ts";
import {
  checkConnectionAllowance,
  type ConnectionAllowance,
  type ConnectionFundingSource,
} from "../_shared/whatsapp-connection-allowance-core.ts";
import {
  resolveWhatsAppSubscription,
  type WhatsAppSubscriptionFact,
} from "../_shared/whatsapp-subscription-resolver-core.ts";
import {
  checkUnitInstanceConflict,
  UNIT_ALREADY_HAS_INSTANCE_MESSAGE,
} from "../_shared/whatsapp-instance-registration-core.ts";
import type { InstanceNoteAction } from "../_shared/whatsapp-instance-notes-core.ts";
import {
  deleteInstanceOutcomeResponse,
  hasCostHistory,
} from "../_shared/whatsapp-instance-delete-core.ts";

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

// Projeção explícita, como as três listas acima.
const NOTE_COLUMNS = [
  "id", "instance_ref", "instance_id", "organization_id",
  "action", "note", "created_by", "created_at",
].join(", ");

/** Teto de autores distintos resolvidos por listagem — ver `list_instance_notes`. */
const NOTE_AUTHOR_LOOKUP_CAP = 12;

function jsonResponse(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

/**
 * `reqId` vem por PARÂMETRO, como em `create-billing-checkout`,
 * `manage-billing`, `process-billing-overdue` e `stripe-webhook`. Não promover a
 * `let` de módulo: seria exatamente o defeito do `adminRecipient` que o worker
 * acabou de corrigir — estado de invocação sobrevivendo ao isolate.
 */
async function isPlatformAdmin(userId: string, reqId: string): Promise<boolean> {
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

/** Motivo é obrigatório NA PRÓPRIA ação. String vazia ou " " não passa. */
function requireReason(body: Record<string, unknown>): string | null {
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  return reason.length >= MIN_REASON_LENGTH ? reason : null;
}

/**
 * Estado da instância para as ações que decidem transição.
 *
 * Erro de leitura NÃO pode virar "não encontrada": as quatro ações liam com
 * `const { data } = await …maybeSingle()` e um banco indisponível produzia 404
 * — o operador legítimo via "essa instância não existe" e ia procurar o
 * problema no lugar errado. Ausência e indisponibilidade são desfechos
 * distintos porque exigem reações distintas.
 */
async function loadInstanceState(
  id: string,
  columns: string,
  reqId: string,
  evt: string,
): Promise<
  | { ok: true; row: Record<string, unknown> }
  | { ok: false; status: 404 | 503; message: string }
> {
  const { data, error } = await supabase
    .from("whatsapp_instances")
    .select(columns)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    jsonLog("error", { reqId, evt, err: error.message, needsAdminAction: true });
    return {
      ok: false,
      status: 503,
      message: "Não foi possível consultar a instância agora. Tente novamente.",
    };
  }
  if (!data) return { ok: false, status: 404, message: "Instância não encontrada." };
  return { ok: true, row: data as Record<string, unknown> };
}

/**
 * Uma linha no ledger de observações — o HISTÓRICO que `whatsapp_instances.notes`
 * não guardava (ela é sobrescrita a cada ação; cada uma apagava a justificativa
 * da anterior).
 *
 * BEST-EFFORT E NUNCA LANÇA. Falha aqui não derruba a operação já concluída:
 * devolver erro depois de o efeito ter ocorrido faria o operador repetir uma
 * ação já feita — que, em `request_cancellation` ou `confirm_end`, é pior que o
 * buraco no histórico. A divergência entre `notes` e o ledger fica detectável
 * pela telemetria `needsAdminAction`.
 *
 * CHAMAR SEMPRE DEPOIS DA MUTAÇÃO. Observação sobre operação que não aconteceu
 * é pior que observação ausente.
 */
async function recordInstanceNote(args: {
  instanceId: string;
  organizationId: string;
  action: InstanceNoteAction;
  note: string;
  callerId: string;
  reqId: string;
}): Promise<void> {
  const { error } = await supabase.from("whatsapp_instance_notes").insert({
    // `instance_ref` é identidade histórica: quando a instância for apagada, a
    // FK nula `instance_id` e é `instance_ref` que continua dizendo de quem era
    // a observação. No INSERT os dois são o mesmo id — a trigger exige.
    instance_ref: args.instanceId,
    instance_id: args.instanceId,
    organization_id: args.organizationId,
    action: args.action,
    note: args.note,
    created_by: args.callerId,
  });

  if (error) {
    jsonLog("error", {
      reqId: args.reqId,
      evt: "wa_instance_note_write_failed",
      instanceId: args.instanceId,
      action: args.action,
      err: error.message,
      needsAdminAction: true,
    });
  }
}

/**
 * UUID obrigatório na ação — validado na FORMA, não só na presença.
 *
 * Pedido malformado é 400. Validar só a presença deixava `"abc"` chegar ao
 * PostgREST, o Postgres levantar `22P02` e o erro subir pelo caminho de
 * indisponibilidade: 503 "tente novamente" mais alarme `needsAdminAction` para
 * algo que repetição nenhuma conserta.
 */
function requireInstanceId(body: Record<string, unknown>): string | null {
  return parseUuid(body.instance_id);
}

/**
 * Mesma regra, para o id de ALERTA — ver o comentário acima.
 *
 * As duas ações de alerta ficaram de fora quando a validação de forma foi
 * introduzida, e checavam só a presença. Um id malformado chegava ao
 * PostgREST, virava `22P02` e subia como 500 "Não foi possível resolver o
 * alerta" — mensagem que culpa o servidor por um pedido inválido e manda o
 * operador procurar o problema no lugar errado.
 */
function requireAlertId(body: Record<string, unknown>): string | null {
  return parseUuid(body.alert_id);
}

/**
 * Linha crua de `billing_subscriptions` com o plano embutido. A relação
 * aninhada volta do PostgREST como objeto OU array — normalizada abaixo, mesmo
 * padrão de `whatsapp-service-gate.ts`, `entitlements.ts` e
 * `process-whatsapp-instance-cycles`.
 *
 * `included_features` / `included_whatsapp_connections` podem vir `null` numa
 * base anterior à migration 094; o `?? []` trata a primeira como plano LEGADO,
 * que é exatamente o que ela é nesse ponto do rollout, e a segunda vira `null`
 * = allowance desconhecida, que o núcleo já trata fail-closed.
 */
interface SubscriptionPlanRef {
  category: string | null;
  included_features: string[] | null;
  included_whatsapp_connections: number | null;
}

interface SubscriptionAllowanceRow {
  id: string;
  status: string;
  canceled_at: string | null;
  suspended_at: string | null;
  billing_plans: SubscriptionPlanRef | SubscriptionPlanRef[] | null;
}

type FundingResolution =
  | {
      ok: true;
      fundingSource: ConnectionFundingSource;
      includedConnections: number | null;
      provisioningAmbiguous: boolean;
    }
  | { ok: false; reason: "READ_FAILED" | "AMBIGUOUS" };

/**
 * QUEM FINANCIA a conexão de WhatsApp desta organização — pelo núcleo puro
 * compartilhado `whatsapp-subscription-resolver-core.ts`, o MESMO que o gate de
 * envio e o worker de suspensão usam. Uma query nova com regra própria aqui é
 * como duas fontes de verdade nascem: o gate diria que a organização tem
 * assinatura e o inventário diria que não, sobre a mesma linha e no mesmo dia.
 *
 * AMBIGUIDADE COMERCIAL NÃO É AUSÊNCIA DE CONTRATO. "Existe fonte, não sei
 * qual" é diferente de "não existe fonte", e a segunda é uma acusação. Por isso
 * `AMBIGUOUS` sai daqui como desfecho PRÓPRIO em vez de virar `fundingSource:
 * "NONE"` — que faria o núcleo negar um backfill legítimo com
 * `NO_FUNDING_SOURCE`, o motivo errado. Mesmo tratamento que
 * `resolveRevenueForOrg` dá ao caso em `process-whatsapp-instance-cycles`.
 *
 * Falha de leitura também é desfecho próprio: fail-closed, mas com 503 e não
 * com um veredito comercial inventado.
 */
async function resolveConnectionFunding(
  organizationId: string,
  reqId: string,
): Promise<FundingResolution> {
  const [subRes, overrideRes] = await Promise.all([
    // TODAS as candidatas, sem filtro de categoria e sem `.maybeSingle()` —
    // campo-a-campo a mesma forma da query do gate. `.maybeSingle()` LANÇA com
    // duas linhas, e a transição entre o modelo antigo e o de dois planos produz
    // exatamente duas; o filtro por categoria devolvia ZERO linha para uma
    // organização do Plano 2, que paga o pacote dentro da mensalidade.
    supabase
      .from("billing_subscriptions")
      .select(
        "id, status, canceled_at, suspended_at, billing_plans!inner(category, included_features, included_whatsapp_connections)",
      )
      .eq("organization_id", organizationId)
      .neq("status", "canceled"),
    // Cortesia vitalícia não tem assinatura — é o caso do único cliente ativo.
    // Sem este degrau, ele cairia em `NONE` e nem o backfill do que já existe
    // passaria.
    supabase
      .from("organization_entitlement_overrides")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("feature", "whatsapp")
      .eq("grant_type", "LIFETIME")
      .eq("enabled", true)
      .is("revoked_at", null)
      .limit(1)
      .maybeSingle(),
  ]);

  if (subRes.error || overrideRes.error) {
    jsonLog("error", {
      reqId,
      evt: "wa_allowance_funding_read_failed",
      organizationId,
      subErr: subRes.error?.message ?? null,
      overrideErr: overrideRes.error?.message ?? null,
      needsAdminAction: true,
    });
    return { ok: false, reason: "READ_FAILED" };
  }

  // O resolvedor devolve `subscriptionId`, não a linha do plano. A correlação de
  // volta é por CHAVE, nunca por posição: o PostgREST não garante ordem sem
  // ORDER BY, e um índice de array casaria o teto de conexões de um plano com a
  // assinatura de outro sem que nada reclamasse.
  const planBySubscriptionId = new Map<string, SubscriptionPlanRef>();
  const facts: WhatsAppSubscriptionFact[] = (
    (subRes.data ?? []) as unknown as SubscriptionAllowanceRow[]
  ).map((row) => {
    const plan = Array.isArray(row.billing_plans) ? row.billing_plans[0] : row.billing_plans;
    if (plan) planBySubscriptionId.set(row.id, plan);
    return {
      id: row.id,
      status: row.status,
      category: plan?.category ?? "SYSTEM_SUBSCRIPTION",
      includedFeatures: plan?.included_features ?? [],
      canceledAt: row.canceled_at,
      suspendedAt: row.suspended_at,
    };
  });

  const resolution = resolveWhatsAppSubscription({ subscriptions: facts });

  if (resolution.kind === "AMBIGUOUS") {
    jsonLog("warn", {
      reqId,
      evt: "wa_allowance_ambiguous_subscription",
      organizationId,
      reason: resolution.reasonCode,
      candidates: resolution.candidateIds.length,
      needsAdminAction: true,
    });
    return { ok: false, reason: "AMBIGUOUS" };
  }

  if (resolution.kind === "NONE") {
    return {
      ok: true,
      fundingSource: overrideRes.data ? "LIFETIME_OVERRIDE" : "NONE",
      includedConnections: null,
      provisioningAmbiguous: false,
    };
  }

  const plan = planBySubscriptionId.get(resolution.subscriptionId);
  // `!inner` garante o plano; chegar aqui sem ele significa que a correlação não
  // fechou. Seguir com `null` afirmaria "plano sem teto declarado" sobre uma
  // assinatura que o resolvedor acabou de escolher.
  if (!plan) {
    jsonLog("error", {
      reqId,
      evt: "wa_allowance_plan_not_correlated",
      organizationId,
      subscriptionId: resolution.subscriptionId,
      needsAdminAction: true,
    });
    return { ok: false, reason: "READ_FAILED" };
  }

  return {
    ok: true,
    fundingSource: resolution.source,
    includedConnections:
      typeof plan.included_whatsapp_connections === "number"
        ? plan.included_whatsapp_connections
        : null,
    provisioningAmbiguous: resolution.provisioningAmbiguous,
  };
}

/**
 * Mensagem por motivo de recusa. Curta, em PT-BR, e SEM número de custo ou de
 * preço: esta EF é exclusiva de platform_admin, mas o corpo da resposta viaja
 * até um navegador e nada aqui precisa do valor pago.
 *
 * `Record` exaustivo de propósito — motivo novo no núcleo cobra a mensagem.
 */
const ALLOWANCE_DENIED_MESSAGE: Record<
  Extract<ConnectionAllowance, { allowed: false }>["reasonCode"],
  string
> = {
  CONNECTION_LIMIT_REACHED:
    "O plano desta organização não tem conexão de WhatsApp disponível para mais um registro.",
  ALLOWANCE_UNKNOWN:
    "O plano desta organização não declara quantas conexões de WhatsApp inclui. Revise o plano antes de registrar.",
  SUBSCRIPTION_AMBIGUOUS:
    "Há mais de um contrato de automação de WhatsApp em aberto para esta organização. Resolva a pendência antes de registrar.",
  BACKFILL_WITHOUT_PROVIDER_REF:
    "Informe o identificador da instância no fornecedor: só é possível registrar instância que já existe lá.",
  OVERRIDE_REQUIRES_ADMIN_DECISION:
    "Esta organização usa a automação em cortesia vitalícia. Conexão nova exige decisão administrativa registrada.",
  NO_FUNDING_SOURCE:
    "Não há contrato de automação de WhatsApp que financie uma conexão para esta organização.",
};

const ALLOWANCE_UNVERIFIABLE =
  "Não foi possível verificar o direito de uso da automação de WhatsApp agora. Tente novamente em alguns minutos.";

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
    if (!(await isPlatformAdmin(callerId, reqId))) {
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

      // `has_cost_history` decide se a tela OFERECE "Apagar"; quem decide se
      // PODE é a RPC. Falha desta leitura é 500 como a principal: devolver
      // "sem custo" por default mostraria o botão onde o banco vai recusar.
      // PAGINADA: a tabela ganha uma linha por instância por mês e o PostgREST
      // trunca em 1000 sem avisar — um Set incompleto seria "sem custo" em
      // silêncio. `.order("id")` dá páginas determinísticas.
      const PAGE = 1000;
      const idsWithCycleCost = new Set<string>();
      for (let from = 0; ; from += PAGE) {
        const { data: chunk, error: costedErr } = await supabase
          .from("whatsapp_instance_cycles")
          .select("instance_id")
          .not("provider_cost_cents", "is", null)
          .order("id", { ascending: true })
          .range(from, from + PAGE - 1);
        if (costedErr) {
          jsonLog("error", { reqId, evt: "wa_instances_cost_history_failed", err: costedErr.message });
          return jsonResponse(req, { error: "Não foi possível carregar as instâncias." }, 500);
        }
        for (const r of chunk ?? []) idsWithCycleCost.add((r as { instance_id: string }).instance_id);
        if ((chunk ?? []).length < PAGE) break;
      }

      const instances = (data ?? []).map((row) => {
        // `select(INSTANCE_COLUMNS)` com string não literal tipa a linha como
        // GenericStringError no SDK Deno; o cast passa por `unknown` de propósito.
        const r = row as unknown as Record<string, unknown>;
        return {
          ...r,
          has_cost_history: hasCostHistory(r.current_monthly_cost_cents, r.id as string, idsWithCycleCost),
        };
      });
      return jsonResponse(req, { instances });
    }

    if (action === "get_instance") {
      const id = requireInstanceId(body);
      if (!id) return jsonResponse(req, { error: "instance_id inválido." }, 400);

      const [inst, cycles, alerts] = await Promise.all([
        supabase.from("whatsapp_instances").select(INSTANCE_COLUMNS).eq("id", id).maybeSingle(),
        supabase.from("whatsapp_instance_cycles").select(CYCLE_COLUMNS)
          .eq("instance_id", id).order("cycle_start", { ascending: false }),
        supabase.from("whatsapp_instance_alerts").select(ALERT_COLUMNS)
          .eq("instance_id", id).order("first_detected_at", { ascending: false }),
      ]);

      // Indisponibilidade NÃO é ausência. `inst.error || !inst.data` colapsava
      // as duas em 404 e descartava a causa — o quinto caminho de leitura, que
      // escapou da primeira passada do F-09.
      if (inst.error) {
        jsonLog("error", {
          reqId, evt: "wa_get_instance_lookup_failed",
          err: inst.error.message, needsAdminAction: true,
        });
        return jsonResponse(req, {
          error: "Não foi possível consultar a instância agora. Tente novamente.",
        }, 503);
      }
      if (!inst.data) return jsonResponse(req, { error: "Instância não encontrada." }, 404);
      // Ciclos e alertas são acessórios: falha neles não esconde a instância,
      // mas some do painel sem explicação se não for registrada.
      for (const [name, res] of [["cycles", cycles], ["alerts", alerts]] as const) {
        if (res.error) {
          jsonLog("error", {
            reqId, evt: "wa_get_instance_related_failed", related: name,
            err: res.error.message, needsAdminAction: true,
          });
        }
      }
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

    /**
     * Histórico de observações de UMA instância.
     *
     * Chaveado por `instance_ref` e NÃO por `instance_id`: depois de a instância
     * ser apagada, `instance_id` é NULL e o histórico ficaria inalcançável — que
     * é justamente o oposto do contrato da tabela.
     *
     * `instance_id` validado na FORMA e não só na presença — a mesma lição do
     * defeito de `alert_id` corrigido na 6b: `"abc"` chegava ao PostgREST,
     * virava `22P02` e subia como 500, culpando o servidor por um pedido
     * inválido.
     */
    if (action === "list_instance_notes") {
      const id = requireInstanceId(body);
      if (!id) return jsonResponse(req, { error: "instance_id inválido." }, 400);

      const { data, error } = await supabase
        .from("whatsapp_instance_notes")
        .select(NOTE_COLUMNS)
        .eq("instance_ref", id)
        .order("created_at", { ascending: false });

      if (error) {
        jsonLog("error", { reqId, evt: "wa_instance_notes_list_failed", err: error.message });
        return jsonResponse(req, { error: "Não foi possível carregar o histórico." }, 500);
      }

      const rows = (data ?? []) as Record<string, unknown>[];

      // O autor é um uuid na linha; o painel precisa de um nome. Os autores
      // distintos de um histórico são platform_admins — realisticamente um ou
      // dois — mas o teto existe para que um histórico longo não vire dezenas de
      // chamadas ao Auth Admin dentro de uma resposta. Acima do teto o painel
      // mostra "autor não identificado", que é honesto: a informação existe,
      // não foi resolvida aqui.
      const ids = Array.from(
        new Set(rows.map((r) => r.created_by).filter((v): v is string => typeof v === "string")),
      ).slice(0, NOTE_AUTHOR_LOOKUP_CAP);

      const emailById = new Map<string, string>();
      await Promise.all(
        ids.map(async (uid) => {
          const { data: u, error: uErr } = await supabase.auth.admin.getUserById(uid);
          // Falha de lookup NÃO esconde a observação: o histórico é o dado,
          // o nome do autor é o enfeite.
          if (uErr || !u?.user?.email) return;
          emailById.set(uid, u.user.email);
        }),
      );

      return jsonResponse(req, {
        notes: rows.map((r) => ({
          ...r,
          created_by_email:
            typeof r.created_by === "string" ? emailById.get(r.created_by) ?? null : null,
        })),
      });
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

      // UUID validado na FORMA, não só na presença — mesma razão de
      // `requireInstanceId`. Sem isso, `"abc"` chegava ao PostgREST, virava
      // `22P02` e subia pelo caminho de indisponibilidade (503 "tente
      // novamente") para um pedido que repetição nenhuma conserta. A guarda de
      // allowance abaixo consulta o banco POR esta org, o que tornaria esse
      // desvio de motivo o caminho comum.
      const orgId = parseUuid(body.organization_id);
      if (!orgId) return jsonResponse(req, { error: "organization_id inválido." }, 400);

      let ref: string | null = null;
      if (body.provider_instance_ref) {
        const v = validateProviderInstanceRef(String(body.provider_instance_ref));
        if (v.ok === false) return jsonResponse(req, { error: v.message, code: v.code }, 400);
        ref = v.value;
      }

      // MESMA função de `set_cost` — núcleo puro, testado. A validação
      // duplicada nas duas ações já divergiu uma vez.
      const cost = parseCostCents(body.current_monthly_cost_cents ?? null);
      if (cost.ok === false) return jsonResponse(req, { error: cost.message, code: cost.code }, 400);
      const hasCost = cost.unknownCost === false;

      // Backfill NASCE em UNKNOWN quando a data não for confirmada: data
      // ausente não vira vencimento inventado, vira fila de revisão.
      const costSource = hasCost ? normalizeCostSource(body.cost_source) : null;
      if (hasCost && costSource === null) {
        return jsonResponse(req, { error: "Procedência do custo inválida." }, 400);
      }

      // ── Allowance comercial de conexões ──────────────────────────────────
      // Pergunta DIFERENTE da de `assertProvisioningAllowed`, que já rodou lá em
      // cima: aquela responde "a plataforma sabe provisionar?", esta responde "o
      // modelo comercial permite mais uma conexão?". As duas coexistem — uma não
      // substitui a outra, e responder só uma deixa a outra porta aberta.
      //
      // `BACKFILL_EXISTING` fixo: nesta action toda instância nasce na Z-API e
      // só depois é registrada (decisão da Fase 6c). Não existe caminho de
      // `NEW_PROVISIONING` aqui hoje — `assertProvisioningAllowed` recusa
      // `NEW_PROVISION` antes de chegar neste ponto.
      //
      // `providerInstanceRefKnown` vem da MESMA validação de
      // `provider_instance_ref` que já rodou acima: registrar "backfill" sem
      // referência da instância real no fornecedor é criar conexão nova por
      // outra porta.
      const [countRes, funding] = await Promise.all([
        // `lifecycle_state <> 'ENDED'`, não `= 'ACTIVE'`: instância em
        // CANCELLATION_REQUESTED ainda custa até a confirmação de encerramento.
        supabase
          .from("whatsapp_instances")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
          .neq("lifecycle_state", "ENDED"),
        resolveConnectionFunding(orgId, reqId),
      ]);

      // FALHA em vez de degradar: `count ?? 0` viraria "zero instâncias" e
      // liberaria exatamente o registro que o teto existe para barrar.
      if (countRes.error) {
        jsonLog("error", {
          reqId, evt: "wa_allowance_count_failed", organizationId: orgId,
          err: countRes.error.message, needsAdminAction: true,
        });
        return jsonResponse(req, { error: ALLOWANCE_UNVERIFIABLE }, 503);
      }
      if (funding.ok === false) {
        if (funding.reason === "AMBIGUOUS") {
          return jsonResponse(req, {
            error: ALLOWANCE_DENIED_MESSAGE.SUBSCRIPTION_AMBIGUOUS,
            code: "SUBSCRIPTION_AMBIGUOUS",
          }, 409);
        }
        return jsonResponse(req, { error: ALLOWANCE_UNVERIFIABLE }, 503);
      }

      const allowance = checkConnectionAllowance({
        fundingSource: funding.fundingSource,
        includedConnections: funding.includedConnections,
        operation: "BACKFILL_EXISTING",
        activeInstanceCount: countRes.count ?? 0,
        provisioningAmbiguous: funding.provisioningAmbiguous,
        providerInstanceRefKnown: ref !== null,
      });

      if (allowance.allowed === false) {
        jsonLog("warn", {
          reqId, evt: "wa_allowance_denied", organizationId: orgId,
          reasonCode: allowance.reasonCode, fundingSource: funding.fundingSource,
          activeInstances: countRes.count ?? 0, callerId,
        });
        return jsonResponse(req, {
          error: ALLOWANCE_DENIED_MESSAGE[allowance.reasonCode],
          code: allowance.reasonCode,
        }, 409);
      }

      // ── Unidade já ocupada ───────────────────────────────────────────────
      // TERCEIRA pergunta, independente das duas acima. `assertProvisioningAllowed`
      // responde "a plataforma sabe provisionar?"; `checkConnectionAllowance`
      // responde "o modelo comercial permite mais uma conexão?"; esta responde
      // "esta unidade já está ocupada?".
      //
      // Ela existe porque a segunda NÃO cobre a cortesia vitalícia: naquele
      // núcleo, `activeInstanceCount` só é lido no ramo PLAN_DECLARED, então sob
      // override vitalício duas instâncias na mesma unidade coexistiam sem que
      // nada reclamasse (§2.1 da verificação manual).
      //
      // FORA do `checkConnectionAllowance` de propósito: aquele núcleo é
      // compartilhado com `manage-channels`, que não tem nada a ver com unidade
      // duplicada.
      // Trata a PRESENÇA da chave, não a verdade dela: `unit_id: ""` é falsy e
      // cairia no ramo "sem unidade" em silêncio, nascendo sem a guarda de
      // unidade duplicada acima (NO_UNIT_SCOPE). Ausente ou `null` explícito
      // continua significando "sem unidade".
      const unitIdProvided = "unit_id" in body && body.unit_id != null;
      const unitId = unitIdProvided ? parseUuid(body.unit_id) : null;
      if (unitIdProvided && !unitId) {
        return jsonResponse(req, { error: "unit_id inválido." }, 400);
      }

      let unitConflicts: Record<string, unknown>[] = [];
      if (unitId) {
        const { data: sameUnit, error: sameUnitErr } = await supabase
          .from("whatsapp_instances")
          .select("id, lifecycle_state, provider_instance_ref, created_at")
          .eq("unit_id", unitId)
          .neq("lifecycle_state", "ENDED");

        // FALHA em vez de degradar, como a contagem de allowance acima: lista
        // vazia por erro de leitura liberaria exatamente o registro que a guarda
        // existe para barrar.
        if (sameUnitErr) {
          jsonLog("error", {
            reqId, evt: "wa_unit_conflict_read_failed", unitId,
            err: sameUnitErr.message, needsAdminAction: true,
          });
          return jsonResponse(req, { error: ALLOWANCE_UNVERIFIABLE }, 503);
        }
        unitConflicts = (sameUnit ?? []) as Record<string, unknown>[];
      }

      const unitCheck = checkUnitInstanceConflict({
        unitScoped: unitId !== null,
        conflicts: unitConflicts.map((c) => ({
          id: String(c.id),
          lifecycleState: String(c.lifecycle_state),
        })),
        acknowledged: body.acknowledge_unit_conflict === true,
      });

      if (unitCheck.ok === false) {
        jsonLog("warn", {
          reqId, evt: "wa_unit_conflict_denied", unitId,
          conflicts: unitConflicts.length, callerId,
        });
        // Devolve as conflitantes para a tela poder mostrá-las. São
        // identificadores e datas — `provider_instance_ref` é identificador no
        // painel do fornecedor, não credencial, e esta EF é exclusiva de
        // platform_admin.
        return jsonResponse(req, {
          error: UNIT_ALREADY_HAS_INSTANCE_MESSAGE,
          code: "UNIT_ALREADY_HAS_INSTANCE",
          conflicts: unitConflicts,
        }, 409);
      }

      const { data, error } = await supabase
        .from("whatsapp_instances")
        .insert({
          organization_id: orgId,
          unit_id: unitId,
          channel_id: body.channel_id ?? null,
          provider: String(body.provider ?? "zapi"),
          provider_instance_ref: ref,
          lifecycle_state: "ACTIVE",
          cycle_source: "UNKNOWN",
          current_monthly_cost_cents: cost.ok && cost.unknownCost === false ? cost.cents : null,
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

      await recordInstanceNote({
        instanceId: data.id, organizationId: orgId,
        action: "REGISTER", note: reason, callerId, reqId,
      });

      jsonLog("info", {
        reqId, evt: "wa_instance_registered", instanceId: data.id, intent,
        allowancePolicy: allowance.policy, fundingSource: funding.fundingSource,
        unitConflictPolicy: unitCheck.ok === true ? unitCheck.policy : null,
      });
      return jsonResponse(req, { instance: data });
    }

    // ── Confirmação da data do ciclo ─────────────────────────────────────
    // Cria o ciclo OPEN, projeta na instância e resolve a pendência de data.
    // Só aqui `cycle_source` vira ADMIN_CONFIRMED e o D-7/D-1 daquele ciclo em
    // diante é liberado.
    if (action === "confirm_cycle_date") {
      const reason = requireReason(body);
      if (!reason) return jsonResponse(req, { error: "Informe a origem da informação da data." }, 400);

      const id = requireInstanceId(body);
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

      // Lê TAMBÉM o custo: o ciclo que nasce aqui precisa fotografá-lo, como a
      // rolagem 090 faz. Sem isso, o PRIMEIRO ciclo de toda instância nasce
      // cego mesmo quando o número já está gravado, e só a correção manual o
      // conserta depois.
      const found = await loadInstanceState(
        id,
        "id, organization_id, current_monthly_cost_cents, cost_source",
        reqId,
        "wa_cycle_lookup_failed",
      );
      if (found.ok === false) return jsonResponse(req, { error: found.message }, found.status);

      const dueOn = nextDueFromAnchor(cycleStart, anchorDay);

      // MESMA FORMA DA 090: `cost_snapshot_at` é nulo quando o custo é nulo —
      // carimbo sem valor afirmaria que alguém informou algo.
      const snapshotCost = found.row.current_monthly_cost_cents as number | null;
      const { error: cycleErr } = await supabase.from("whatsapp_instance_cycles").insert({
        instance_id: id,
        organization_id: found.row.organization_id,
        cycle_start: cycleStart,
        provider_due_on: dueOn,
        status: "OPEN",
        provider_cost_cents: snapshotCost,
        cost_source: snapshotCost === null ? null : found.row.cost_source,
        cost_snapshot_at: snapshotCost === null ? null : new Date().toISOString(),
        notes: reason,
        created_by: callerId,
      });
      if (cycleErr) {
        if (cycleErr.code === "23505") {
          // DOIS índices produzem 23505 aqui, e significam coisas OPOSTAS:
          //
          //   whatsapp_cycles_instance_start_idx (instance_id, cycle_start)
          //     -> reexecução com a MESMA data. Idempotência genuína.
          //   whatsapp_cycles_one_open_idx (instance_id) WHERE status='OPEN'
          //     -> já existe OUTRO ciclo aberto, com data DIFERENTE.
          //
          // Tratar os dois como reexecução gravava a projeção com a data NOVA
          // sobre um ciclo que guarda outra: instância e ciclo passavam a
          // discordar da janela em silêncio, o D-7/D-1 disparava pela data
          // errada e a rolagem 090 abria o ciclo seguinte a partir do
          // `provider_due_on` do CICLO, deixando um buraco permanente.
          //
          // ALCANÇÁVEL por uma porta só, rastreada: a falha parcial logo abaixo
          // (insert OK, projeção falha) deixa `cycle_source = 'UNKNOWN'` COM
          // ciclo OPEN, e o botão "Confirmar data" continua visível.
          //
          // O DISCRIMINADOR É O CICLO OPEN, não "existe linha com esta
          // cycle_start". Os dois não são equivalentes: com um ciclo CLOSED
          // começando em X e um OPEN começando em Y, confirmar X encontraria a
          // linha de X e concluiria "reexecução" — gravando a projeção
          // divergente, que é exatamente o dano que este ramo existe para
          // impedir. Perguntar pelo ciclo OPEN responde a pergunta certa:
          //
          //   OPEN com a MESMA data      -> o instance_start_idx recusou. Reexecução.
          //   OPEN com data DIFERENTE    -> o one_open_idx recusou. Divergência.
          //   nenhum OPEN                -> só o instance_start_idx pode ter recusado,
          //                                 e sem ciclo aberto não há do que divergir.
          //
          // `maybeSingle` é seguro: `whatsapp_cycles_one_open_idx` é UNIQUE
          // PARCIAL em (instance_id) WHERE status='OPEN', então há no máximo um.
          const { data: openCycle, error: openCycleErr } = await supabase
            .from("whatsapp_instance_cycles")
            .select("id, cycle_start")
            .eq("instance_id", id)
            .eq("status", "OPEN")
            .maybeSingle();

          if (openCycleErr) {
            jsonLog("error", {
              reqId, evt: "wa_cycle_conflict_read_failed", instanceId: id,
              err: openCycleErr.message, needsAdminAction: true,
            });
            // FAIL-CLOSED: gravar a projeção sem saber qual índice recusou é
            // exatamente a divergência que este ramo existe para impedir.
            return jsonResponse(req, {
              error: "Não foi possível verificar o ciclo já existente. Tente novamente.",
            }, 503);
          }

          // Coluna `date` do Postgres volta como 'YYYY-MM-DD', e `cycleStart` já
          // passou pelo mesmo formato na validação acima — comparação de string
          // é exata aqui.
          if (openCycle && openCycle.cycle_start !== cycleStart) {
            jsonLog("warn", {
              reqId, evt: "wa_cycle_open_date_mismatch", instanceId: id,
              cycleStart, openCycleStart: openCycle.cycle_start, needsAdminAction: true,
            });
            return jsonResponse(req, {
              error: "Já existe um ciclo em aberto com outra data de início. Confira os ciclos desta instância antes de confirmar a data.",
              code: "OPEN_CYCLE_DATE_MISMATCH",
            }, 409);
          }

          // Mesma data: reexecução. Segue — e o ciclo que já estava lá NÃO é
          // preenchido por este caminho: ele pode ter sido rolado ou fechado
          // desde então, e mexer nele como efeito colateral de uma reexecução é
          // o tipo de escrita não-auditada que esta frente combate. Reparo de
          // ciclo existente tem porta própria (`correct_cycle_cost`).
        } else {
          jsonLog("error", { reqId, evt: "wa_cycle_confirm_failed", err: cycleErr.message });
          return jsonResponse(req, { error: "Não foi possível registrar o ciclo." }, 500);
        }
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

      await recordInstanceNote({
        instanceId: id, organizationId: found.row.organization_id as string,
        action: "CONFIRM_CYCLE_DATE", note: reason, callerId, reqId,
      });

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
    // Grava na instância E PREENCHE o ciclo aberto quando ele está sem custo.
    //
    // Valor JÁ CONGELADO no ciclo não é sobrescrito — o princípio da
    // competência continua de pé, porque preencher um nulo não é reescrever
    // história: é registrar o que nunca se soube. Custo errado já gravado tem
    // porta própria (`correct_cycle_cost`, restrita a PENDING_REVIEW).
    //
    // VIA RPC porque são DUAS tabelas e PostgREST não tem transação: com duas
    // escritas soltas, a segunda falhando devolve exatamente o bug que esta
    // frente corrige, em silêncio. A RPC toma `FOR UPDATE` na mesma linha de
    // instância que a rolagem 090 trava, o que fecha a corrida com o worker
    // diário.
    if (action === "set_cost") {
      const reason = requireReason(body);
      if (!reason) return jsonResponse(req, { error: "Informe o motivo e a procedência do custo." }, 400);

      const id = requireInstanceId(body);
      if (!id) return jsonResponse(req, { error: "instance_id é obrigatório." }, 400);

      const cost = parseCostCents(body.current_monthly_cost_cents ?? null);
      if (cost.ok === false) return jsonResponse(req, { error: cost.message, code: cost.code }, 400);
      const isNull = cost.unknownCost === true;

      const setCostSource = isNull ? null : normalizeCostSource(body.cost_source);
      if (!isNull && setCostSource === null) {
        return jsonResponse(req, { error: "Procedência do custo inválida." }, 400);
      }

      // `strict: false` não estreita a união por verdade crua do campo — o
      // if/else explícito estreita nos dois modos.
      let cents: number | null;
      if (cost.unknownCost === true) {
        cents = null;
      } else {
        cents = cost.cents;
      }

      const { data: rpc, error: rpcErr } = await supabase.rpc("set_whatsapp_instance_cost", {
        p_instance_id: id,
        p_cost_cents: cents,
        p_cost_source: setCostSource,
        p_cost_note: reason,
        p_actor: callerId,
      });
      if (rpcErr) {
        jsonLog("error", { reqId, evt: "wa_cost_update_failed", err: rpcErr.message });
        return jsonResponse(req, { error: "Não foi possível atualizar o custo." }, 500);
      }

      // A RPC devolve `returns table`, que o PostgREST entrega como array.
      const outcome = (Array.isArray(rpc) ? rpc[0] : rpc) as
        | { instance_found: boolean; open_cycle_id: string | null; cycle_filled: boolean }
        | undefined;
      if (!outcome?.instance_found) {
        return jsonResponse(req, { error: "Instância não encontrada." }, 404);
      }

      const after = await loadInstanceState(id, INSTANCE_COLUMNS, reqId, "wa_cost_reload_failed");
      if (after.ok === false) return jsonResponse(req, { error: after.message }, after.status);

      await recordInstanceNote({
        instanceId: id, organizationId: after.row.organization_id as string,
        action: "SET_COST", note: reason, callerId, reqId,
      });

      // `has_open_cycle` é BOOLEANO, não o id: a tela precisa distinguir "o
      // ciclo manteve o valor dele" de "não há ciclo aberto", e não precisa do
      // identificador para isso.
      return jsonResponse(req, {
        instance: after.row,
        cycle_filled: outcome.cycle_filled,
        has_open_cycle: outcome.open_cycle_id !== null,
      });
    }

    // ── Correção de custo de ciclo passado ───────────────────────────────
    // A ÚNICA porta que muda custo já gravado, e ela é estreita de propósito.
    //
    // Só `PENDING_REVIEW` — o estado que significa "terminou sem custo". Ciclo
    // `CLOSED` fechou financeiramente concluído, e reabrir esse caso exigiria
    // política própria que não existe. Ciclo `OPEN` não precisa daqui: `set_cost`
    // o preenche.
    //
    // NÃO PRECISA DE RPC: escreve UMA tabela, e o predicado `status =
    // 'PENDING_REVIEW'` no próprio UPDATE é o compare-and-set que a trava faria.
    if (action === "correct_cycle_cost") {
      const reason = requireReason(body);
      if (!reason) {
        return jsonResponse(req, { error: "Informe a origem do valor corrigido." }, 400);
      }

      const cycleId = parseUuid(body.cycle_id);
      if (!cycleId) return jsonResponse(req, { error: "cycle_id inválido." }, 400);

      const cost = parseCostCents(body.current_monthly_cost_cents ?? null);
      if (cost.ok === false) return jsonResponse(req, { error: cost.message, code: cost.code }, 400);
      // Corrigir para "não sei" não é correção — e deixaria o ciclo num estado
      // que o CHECK `whatsapp_cycles_closed_needs_cost_chk` recusaria.
      if (cost.unknownCost === true) {
        return jsonResponse(req, { error: "A correção precisa de um valor. Deixar em branco não corrige." }, 400);
      }

      const costSource = normalizeCostSource(body.cost_source);
      if (costSource === null) {
        return jsonResponse(req, { error: "Procedência do custo inválida." }, 400);
      }

      const { data: current, error: readErr } = await supabase
        .from("whatsapp_instance_cycles")
        .select("id, instance_id, organization_id, status, notes")
        .eq("id", cycleId)
        .maybeSingle();
      if (readErr) {
        jsonLog("error", {
          reqId, evt: "wa_cycle_correct_lookup_failed", err: readErr.message,
          needsAdminAction: true,
        });
        return jsonResponse(req, { error: "Não foi possível consultar o ciclo agora. Tente novamente." }, 503);
      }
      if (!current) return jsonResponse(req, { error: "Ciclo não encontrado." }, 404);

      // APPEND, nunca sobrescrita: a nota original do ciclo é registro próprio.
      const mergedNotes = current.notes
        ? `${current.notes}\n[correção de custo] ${reason}`
        : `[correção de custo] ${reason}`;

      const { data: updated, error: updErr } = await supabase
        .from("whatsapp_instance_cycles")
        .update({
          provider_cost_cents: cost.cents,
          cost_source: costSource,
          cost_snapshot_at: new Date().toISOString(),
          // Custo e status mudam JUNTOS — é isso que satisfaz o CHECK
          // `whatsapp_cycles_closed_needs_cost_chk`. `closed_at` já é não-nulo:
          // PENDING_REVIEW o exige.
          status: "CLOSED",
          closed_by: callerId,
          notes: mergedNotes,
        })
        .eq("id", cycleId)
        .eq("status", "PENDING_REVIEW")
        .select(CYCLE_COLUMNS);

      if (updErr) {
        jsonLog("error", { reqId, evt: "wa_cycle_correct_failed", err: updErr.message });
        return jsonResponse(req, { error: "Não foi possível corrigir o custo do ciclo." }, 500);
      }
      // UPDATE que casa ZERO linhas devolve `error: null` no Supabase JS. Sem
      // esta conferência, "o predicado negou" seria indistinguível de "gravei".
      if (!updated || updated.length === 0) {
        return jsonResponse(req, {
          error: "Só é possível corrigir ciclo pendente de revisão. Ciclo já fechado não é reaberto.",
          code: "CYCLE_NOT_PENDING_REVIEW",
        }, 409);
      }

      await recordInstanceNote({
        instanceId: current.instance_id as string,
        organizationId: current.organization_id as string,
        action: "CORRECT_CYCLE_COST",
        note: reason,
        callerId,
        reqId,
      });

      jsonLog("info", {
        reqId, evt: "wa_cycle_cost_corrected", cycleId,
        instanceId: current.instance_id, callerId,
      });
      return jsonResponse(req, { cycle: updated[0] });
    }

    // ── Cancelamento: congela no ato ─────────────────────────────────────
    // NÃO altera assinatura, billing_status, entitlement, envio, canal nem
    // credencial. Registra o término planejado do CUSTO — nada mais.
    if (action === "request_cancellation") {
      const reason = requireReason(body);
      if (!reason) return jsonResponse(req, { error: "Informe o motivo do cancelamento." }, 400);

      const id = requireInstanceId(body);
      const until = String(body.provider_access_until ?? "");
      if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
        return jsonResponse(req, { error: "Informe a instância e a data-limite de acesso." }, 400);
      }

      const cur = await loadInstanceState(id, "lifecycle_state", reqId, "wa_cancel_lookup_failed");
      if (cur.ok === false) return jsonResponse(req, { error: cur.message }, cur.status);

      const t = canTransition(cur.row.lifecycle_state as LifecycleState, "CANCELLATION_REQUESTED", {
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

      await recordInstanceNote({
        instanceId: id, organizationId: data.organization_id as string,
        action: "REQUEST_CANCELLATION", note: reason, callerId, reqId,
      });

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

      const id = requireInstanceId(body);
      if (!id) return jsonResponse(req, { error: "instance_id é obrigatório." }, 400);

      const cur = await loadInstanceState(id, "lifecycle_state", reqId, "wa_confirm_end_lookup_failed");
      if (cur.ok === false) return jsonResponse(req, { error: cur.message }, cur.status);

      const t = canTransition(cur.row.lifecycle_state as LifecycleState, "ENDED", {
        hasProviderEvidence: true,
      });
      if (t.ok === false) return jsonResponse(req, { error: t.message, code: t.code }, 409);

      // VIA RPC: marcar ENDED e fechar o ciclo aberto são duas tabelas, e sem
      // transação a segunda falhando deixa o ciclo OPEN para sempre — a rolagem
      // 090 pula `lifecycle_state` fora de ACTIVE/CANCELLATION_REQUESTED, então
      // nada o fecharia depois. A transição já foi validada por `canTransition`
      // acima; a RPC não a revalida, de propósito.
      const { data: rpc, error: rpcErr } = await supabase.rpc("confirm_whatsapp_instance_end", {
        p_instance_id: id,
        p_note: reason,
        p_actor: callerId,
      });
      if (rpcErr) {
        jsonLog("error", { reqId, evt: "wa_confirm_end_failed", err: rpcErr.message });
        return jsonResponse(req, { error: "Não foi possível confirmar o encerramento." }, 500);
      }

      const outcome = (Array.isArray(rpc) ? rpc[0] : rpc) as
        | {
            instance_found: boolean;
            lifecycle_before: string | null;
            closed_cycle_id: string | null;
            closed_cycle_status: string | null;
          }
        | undefined;
      if (!outcome?.instance_found) {
        return jsonResponse(req, { error: "Instância não encontrada." }, 404);
      }

      const after = await loadInstanceState(id, INSTANCE_COLUMNS, reqId, "wa_confirm_end_reload_failed");
      if (after.ok === false) return jsonResponse(req, { error: after.message }, after.status);

      await recordInstanceNote({
        instanceId: id, organizationId: after.row.organization_id as string,
        action: "CONFIRM_END", note: reason, callerId, reqId,
      });

      jsonLog("info", {
        reqId, evt: "wa_instance_ended", instanceId: id,
        closedCycleStatus: outcome.closed_cycle_status,
      });
      return jsonResponse(req, {
        instance: after.row,
        closed_cycle_status: outcome.closed_cycle_status,
      });
    }

    // ── Reversão do cancelamento, só com evidência ───────────────────────
    if (action === "reactivate") {
      const reason = requireReason(body);
      if (!reason) {
        return jsonResponse(req, {
          error: "Descreva a evidência de que o cancelamento foi desfeito no fornecedor.",
        }, 400);
      }

      const id = requireInstanceId(body);
      if (!id) return jsonResponse(req, { error: "instance_id é obrigatório." }, 400);

      const cur = await loadInstanceState(id, "lifecycle_state", reqId, "wa_reactivate_lookup_failed");
      if (cur.ok === false) return jsonResponse(req, { error: cur.message }, cur.status);

      // ENDED nunca volta: o núcleo recusa mesmo com evidência. Instância
      // encerrada que reapareça exige linha NOVA (outra instância física).
      const t = canTransition(cur.row.lifecycle_state as LifecycleState, "ACTIVE", {
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

      await recordInstanceNote({
        instanceId: id, organizationId: data.organization_id as string,
        action: "REACTIVATE", note: reason, callerId, reqId,
      });

      return jsonResponse(req, { instance: data });
    }

    // ── Exclusão: só encerrada, sem custo e sem alerta aberto, decidido pelo banco ──
    if (action === "delete_instance") {
      const reason = requireReason(body);
      if (!reason) {
        return jsonResponse(req, { error: "Descreva por que esta instância pode ser apagada." }, 400);
      }

      const id = requireInstanceId(body);
      if (!id) return jsonResponse(req, { error: "instance_id é obrigatório." }, 400);

      // VIA RPC e SEM pré-checagem aqui: trava instância e ciclos, confere
      // estado, custo (atual, de ciclo e o do histórico em audit_log) e
      // alertas abertos, grava o retrato dos ciclos em audit_log e a nota
      // DELETE, e apaga, numa transação. Conferir antes na EF reabriria a
      // janela entre conferir e apagar.
      const { data: rpc, error: rpcErr } = await supabase.rpc("delete_whatsapp_instance_without_cost", {
        p_instance_id: id,
        p_note: reason,
        p_actor: callerId,
      });
      if (rpcErr) {
        jsonLog("error", {
          reqId, evt: "wa_instance_delete_failed", instanceId: id,
          err: rpcErr.message, needsAdminAction: true,
        });
        const failed = deleteInstanceOutcomeResponse(null);
        return jsonResponse(req, failed.body, failed.status);
      }

      const row = (Array.isArray(rpc) ? rpc[0] : rpc) as { outcome?: unknown } | undefined;
      const res = deleteInstanceOutcomeResponse(row?.outcome);
      // 500 aqui = desfecho fora do contrato da RPC (resposta vazia, RPC
      // alterada): é defeito que exige ação do admin, não recusa de negócio.
      if (res.status === 500) {
        jsonLog("error", {
          reqId, evt: "wa_instance_delete_unexpected_outcome", instanceId: id,
          outcome: row?.outcome ?? null, needsAdminAction: true,
        });
      } else {
        jsonLog(res.status === 200 ? "info" : "warn", {
          reqId, evt: "wa_instance_delete", instanceId: id, outcome: row?.outcome ?? null,
        });
      }
      return jsonResponse(req, res.body, res.status);
    }

    // ── Vínculo e metadados ──────────────────────────────────────────────
    if (action === "update_instance") {
      const reason = requireReason(body);
      if (!reason) return jsonResponse(req, { error: "Informe o motivo da alteração." }, 400);

      const id = requireInstanceId(body);
      if (!id) return jsonResponse(req, { error: "instance_id inválido." }, 400);

      const patch: Record<string, unknown> = { updated_by: callerId, notes: reason };
      // `parseUuid` como no registro. Sem ele, um valor malformado cairia na
      // consulta de conflito abaixo e viraria 503 — mensagem errada para o que é
      // erro do cliente (hoje o banco recusa com 22P02 e a EF devolve 500).
      if ("unit_id" in body) {
        if (body.unit_id == null) {
          patch.unit_id = null;
        } else {
          const parsedUnitId = parseUuid(body.unit_id);
          if (!parsedUnitId) return jsonResponse(req, { error: "unit_id inválido." }, 400);
          patch.unit_id = parsedUnitId;
        }
      }
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

      // A GUARDA DE UNIDADE DUPLICADA VALE NAS DUAS PORTAS. O registro a tem
      // desde a 6c; sem ela aqui, mover uma instância para uma unidade já
      // ocupada produz exatamente o estado que o registro recusa — e "registro
      // recusa, mover aceita" é pior que nenhum dos dois conferir: cria
      // confiança falsa numa guarda que existe.
      //
      // MESMO núcleo do registro (`checkUnitInstanceConflict`), não uma segunda
      // regra. `whatsapp-connection-allowance-core.ts` continua fora disto: ele
      // responde "o modelo comercial permite mais uma conexão?" e é
      // compartilhado com `manage-channels`, que não tem nada a ver com unidade
      // ocupada.
      const nextUnitId = typeof patch.unit_id === "string" ? patch.unit_id : null;
      if (nextUnitId) {
        const cur = await loadInstanceState(
          id, "unit_id, lifecycle_state", reqId, "wa_instance_update_lookup_failed",
        );
        if (cur.ok === false) return jsonResponse(req, { error: cur.message }, cur.status);

        // DUAS razões para pular, e as duas evitam recusa de operação legítima:
        //
        // 1. Patch que reenvia a MESMA unidade não é conflito — sem isto, uma
        //    unidade com duas instâncias legitimamente reconhecidas no passado
        //    exigiria nova confirmação a cada correção de identificador.
        // 2. Instância JÁ ENCERRADA não pode produzir "duas vivas na mesma
        //    unidade" (a consulta abaixo exclui ENDED). Corrigir o vínculo
        //    histórico de uma encerrada é registro, não custo novo — e recusá-lo
        //    diria "a unidade passa a ter duas", que é falso.
        const movingLiveInstance =
          cur.row.unit_id !== nextUnitId && cur.row.lifecycle_state !== "ENDED";
        if (movingLiveInstance) {
          const { data: sameUnit, error: sameUnitErr } = await supabase
            .from("whatsapp_instances")
            .select("id, lifecycle_state, provider_instance_ref, created_at")
            .eq("unit_id", nextUnitId)
            .neq("lifecycle_state", "ENDED")
            // Única diferença de desenho contra o registro. Redundante DADO o
            // pulo acima — e de propósito: mantém a consulta correta por si só,
            // para que reestruturar o pulo não reintroduza o auto-conflito em
            // silêncio.
            .neq("id", id);

          // FALHA em vez de degradar, como no registro: lista vazia por erro de
          // leitura liberaria exatamente o que a guarda existe para barrar.
          if (sameUnitErr) {
            jsonLog("error", {
              reqId, evt: "wa_unit_conflict_read_failed", unitId: nextUnitId,
              err: sameUnitErr.message, needsAdminAction: true,
            });
            return jsonResponse(req, { error: ALLOWANCE_UNVERIFIABLE }, 503);
          }

          const moveConflicts = (sameUnit ?? []) as Record<string, unknown>[];
          const moveCheck = checkUnitInstanceConflict({
            unitScoped: true,
            conflicts: moveConflicts.map((c) => ({
              id: String(c.id),
              lifecycleState: String(c.lifecycle_state),
            })),
            acknowledged: body.acknowledge_unit_conflict === true,
          });

          if (moveCheck.ok === false) {
            jsonLog("warn", {
              reqId, evt: "wa_unit_conflict_denied", unitId: nextUnitId,
              conflicts: moveConflicts.length, callerId, whichAction: "update_instance",
            });
            return jsonResponse(req, {
              // MESMO `code` do registro (a tela trata os dois igual), mensagem
              // PRÓPRIA: `UNIT_ALREADY_HAS_INSTANCE_MESSAGE` diz "confirme que
              // quer REGISTRAR uma segunda", e aqui nada é registrado. O
              // diálogo intercepta o 409 e nunca exibe este texto, então quem o
              // lê é chamador de API — justamente para quem a frase do registro
              // seria falsa.
              error: "Esta unidade já tem instância registrada. Confirme que quer mover uma segunda para ela.",
              code: "UNIT_ALREADY_HAS_INSTANCE",
              conflicts: moveConflicts,
            }, 409);
          }
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

      await recordInstanceNote({
        instanceId: id, organizationId: data.organization_id as string,
        action: "UPDATE", note: reason, callerId, reqId,
      });

      return jsonResponse(req, { instance: data });
    }

    // ── Alertas ──────────────────────────────────────────────────────────
    // ACKNOWLEDGED interrompe o LEMBRETE, não fecha o fato. RESOLVED diz que o
    // fato deixou de existir. Fato que desaparece sozinho é resolvido pelo
    // worker com nota do sistema — NUNCA apagado.
    if (action === "acknowledge_alert") {
      const id = requireAlertId(body);
      if (!id) return jsonResponse(req, { error: "Informe um alert_id válido." }, 400);

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

      const id = requireAlertId(body);
      if (!id) return jsonResponse(req, { error: "Informe um alert_id válido." }, 400);

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
