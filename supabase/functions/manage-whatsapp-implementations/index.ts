// Edge Function: manage-whatsapp-implementations
// Painel da implantação do WhatsApp (Fase 5a).
//
// Auth: JWT obrigatório. Todas as actions exigem platform_admin, EXCETO
// get_service_status, que aceita owner/gerente da própria organização e devolve
// uma PROJEÇÃO SEGURA (nunca a linha crua — ela carrega notas internas, motivo
// da cortesia, referência de pagamento e responsáveis).
//
// Nada aqui suspende serviço: enforcement é a Fase 5b.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { genRequestId, jsonLog } from "../_shared/security.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import {
  validateOriginPayment,
  canTransitionOperational,
  ORIGIN_PAYMENT_MATRIX,
  type ImplementationOrigin,
  type ImplementationPaymentStatus,
  type ImplementationOperationalStatus,
} from "../_shared/whatsapp-implementation-core.ts";
import {
  loadImplementationPlan,
  openImplementationCheckout,
} from "../_shared/implementation-checkout.ts";
import {
  reserveCheckoutSession,
  finalizeCheckoutSession,
  failCheckoutSession,
  CHECKOUT_EXPIRY_MINUTES,
} from "../_shared/checkout-sessions.ts";
import { checkFlagEnabled } from "../_shared/platform-flags.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://reservas.moralles.com.br";

/** Colunas completas — só para platform_admin. */
const ADMIN_COLUMNS =
  "id, organization_id, origin, payment_status, operational_status, amount_cents, " +
  "billing_plan_id, billing_invoice_id, provider_checkout_id, paid_at, payment_method, " +
  "external_payment_reference, reason, notes, owner_admin_id, scheduled_for, started_at, " +
  "completed_at, canceled_at, cancel_reason, created_by, updated_by, created_at, updated_at";

/** Única action liberada para não-admin. Ver Task 14. */
const CLIENT_FRIENDLY_ACTIONS = new Set(["get_service_status"]);

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

async function canReadOrg(userId: string, organizationId: string): Promise<boolean> {
  if (await isPlatformAdmin(userId)) return true;
  const { data } = await supabase
    .from("unit_members")
    .select("role, units!inner(organization_id)")
    .eq("user_id", userId)
    .in("role", ["owner", "gerente"])
    .eq("units.organization_id", organizationId)
    .limit(1);
  return !!(data && data.length > 0);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeadersFor(req) });
  if (req.method !== "POST") return jsonResponse(req, { error: "Método não permitido." }, 405);

  const reqId = genRequestId();

  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse(req, { error: "Não autenticado." }, 401);

    const { data: callerData, error: callerErr } = await supabase.auth.getUser(jwt);
    if (callerErr || !callerData.user) return jsonResponse(req, { error: "Sessão inválida." }, 401);
    const callerId = callerData.user.id;

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action ?? "");
    if (!action) return jsonResponse(req, { error: "action é obrigatória." }, 400);

    // Autorização ANTES do dispatch: nenhuma action roda sem passar por aqui.
    if (CLIENT_FRIENDLY_ACTIONS.has(action)) {
      const orgId = String(body.organization_id ?? "");
      if (!orgId) return jsonResponse(req, { error: "organization_id é obrigatório." }, 400);
      if (!(await canReadOrg(callerId, orgId))) {
        return jsonResponse(req, { error: "Sem permissão para esta organização." }, 403);
      }
    } else if (!(await isPlatformAdmin(callerId))) {
      return jsonResponse(req, { error: "Acesso restrito." }, 403);
    }

    if (action === "list") {
      const { status, organization_id, page = 0, page_size = 50 } = body as {
        status?: string; organization_id?: string; page?: number; page_size?: number;
      };
      const from = Number(page) * Number(page_size);
      let query = supabase
        .from("whatsapp_implementations")
        .select(`${ADMIN_COLUMNS}, organizations!inner(name, slug)`, { count: "exact" })
        .order("created_at", { ascending: false })
        .range(from, from + Number(page_size) - 1);
      if (status) query = query.eq("operational_status", status);
      if (organization_id) query = query.eq("organization_id", organization_id);

      const { data, error, count } = await query;
      if (error) {
        jsonLog("error", { reqId, evt: "whatsapp_impl_list_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao listar implantações." }, 500);
      }
      return jsonResponse(req, { success: true, implementations: data ?? [], total: count });
    }

    if (action === "get") {
      const id = String(body.id ?? "");
      if (!id) return jsonResponse(req, { error: "id é obrigatório." }, 400);
      const { data, error } = await supabase
        .from("whatsapp_implementations")
        .select(`${ADMIN_COLUMNS}, organizations!inner(name, slug)`)
        .eq("id", id)
        .maybeSingle();
      if (error) {
        jsonLog("error", { reqId, evt: "whatsapp_impl_get_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao carregar a implantação." }, 500);
      }
      if (!data) return jsonResponse(req, { error: "Implantação não encontrada." }, 404);
      return jsonResponse(req, { success: true, implementation: data });
    }

    if (action === "create" || action === "register_external_payment") {
      const {
        organization_id, origin, amount_cents, payment_method,
        external_payment_reference, reason, notes, owner_admin_id, scheduled_for, paid_at,
      } = body as Record<string, unknown>;

      if (!organization_id) return jsonResponse(req, { error: "organization_id é obrigatório." }, 400);

      // `create` aceita as três origens manuais; `register_external_payment` é o
      // atalho da UI e força a origem — o admin não escolhe errado por descuido.
      const resolvedOrigin: ImplementationOrigin = action === "register_external_payment"
        ? "EXTERNAL_PAYMENT"
        : (origin as ImplementationOrigin);

      // `origin` ausente/inválida cairia direto em validateOriginPayment com
      // WAIVED e devolveria "combinação inválida" — mensagem que manda o admin
      // procurar um problema de matriz que não existe. Checagem contra a MESMA
      // matriz do núcleo puro (nenhuma lista nova aqui) dá o erro certo.
      // register_external_payment não precisa: a origem já vem travada acima.
      if (action === "create" && !(resolvedOrigin in ORIGIN_PAYMENT_MATRIX)) {
        return jsonResponse(req, { error: "Informe uma origem válida." }, 400);
      }

      if (resolvedOrigin === "ASAAS") {
        // Cobrança real tem fluxo próprio: create_asaas_charge. Aceitar aqui
        // criaria uma linha ASAAS sem checkout, que nunca seria confirmada.
        return jsonResponse(req, {
          error: "Para cobrar pelo Asaas use a ação de gerar cobrança.",
        }, 400);
      }

      const paymentStatus: ImplementationPaymentStatus =
        resolvedOrigin === "EXTERNAL_PAYMENT" ? "CONFIRMED" : "WAIVED";

      if (!validateOriginPayment(resolvedOrigin, paymentStatus)) {
        return jsonResponse(req, { error: "Combinação de origem e pagamento inválida." }, 400);
      }
      if (resolvedOrigin !== "EXTERNAL_PAYMENT" && !String(reason ?? "").trim()) {
        return jsonResponse(req, { error: "Informe o motivo da cortesia ou do override." }, 400);
      }
      if (resolvedOrigin === "EXTERNAL_PAYMENT") {
        const cents = Number(amount_cents);
        if (!Number.isFinite(cents) || cents <= 0) {
          return jsonResponse(req, { error: "Informe o valor recebido." }, 400);
        }
        if (!String(payment_method ?? "").trim()) {
          return jsonResponse(req, { error: "Informe a forma de pagamento." }, 400);
        }
      }

      const { data: plan, error: planErr } = await supabase
        .from("billing_plans")
        .select("id")
        .eq("slug", "implementacao-whatsapp")
        .maybeSingle();
      // Não aborta: billing_plan_id é nullable e a linha manual sobrevive sem
      // ele (não é uma cobrança Asaas, então não precisa do link pro plano
      // pra conciliação). Só loga pra não esconder uma falha de leitura real.
      if (planErr) {
        jsonLog("warn", { reqId, evt: "whatsapp_impl_plan_lookup_warn", err: planErr.message });
      }

      const { data: created, error: insErr } = await supabase
        .from("whatsapp_implementations")
        .insert({
          organization_id,
          origin: resolvedOrigin,
          payment_status: paymentStatus,
          operational_status: "NOT_STARTED",
          // WAIVED não tem valor recebido — gravar 75000 inflaria o faturamento.
          amount_cents: resolvedOrigin === "EXTERNAL_PAYMENT" ? Number(amount_cents) : null,
          billing_plan_id: plan?.id ?? null,
          paid_at: resolvedOrigin === "EXTERNAL_PAYMENT"
            ? (paid_at ?? new Date().toISOString())
            : null,
          payment_method: resolvedOrigin === "EXTERNAL_PAYMENT" ? payment_method : null,
          external_payment_reference: external_payment_reference ?? null,
          reason: reason ?? null,
          notes: notes ?? null,
          owner_admin_id: owner_admin_id ?? null,
          scheduled_for: scheduled_for ?? null,
          created_by: callerId,
          updated_by: callerId,
        })
        .select("id")
        .maybeSingle();

      if (insErr) {
        // 23505 = já existe implantação aberta para a org (UNIQUE parcial).
        if (insErr.code === "23505") {
          return jsonResponse(req, {
            error: "Esta empresa já tem uma implantação registrada. Cancele a atual antes de criar outra.",
          }, 409);
        }
        jsonLog("error", { reqId, evt: "whatsapp_impl_create_error", err: insErr.message });
        return jsonResponse(req, { error: "Falha ao registrar a implantação." }, 500);
      }

      jsonLog("info", {
        reqId, evt: "whatsapp_impl_created_manual",
        orgId: organization_id, origin: resolvedOrigin, by: callerId,
      });
      return jsonResponse(req, { success: true, id: created?.id });
    }

    if (action === "create_asaas_charge") {
      const organizationId = String(body.organization_id ?? "");
      if (!organizationId) return jsonResponse(req, { error: "organization_id é obrigatório." }, 400);

      const flag = await checkFlagEnabled("asaas_enabled");
      if (!flag.enabled) {
        return jsonResponse(req, {
          error: "A cobrança pelo Asaas está temporariamente indisponível.",
        }, 503);
      }

      const plan = await loadImplementationPlan(supabase);
      if (!plan) return jsonResponse(req, { error: "Produto não encontrado." }, 404);

      const { data: customer, error: customerErr } = await supabase
        .from("billing_customers")
        .select("asaas_customer_id, tax_id")
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (customerErr) {
        // Falha de leitura real (banco indisponível, etc.) NÃO pode virar
        // "esta empresa não tem cadastro" — o admin iria cobrar por fora um
        // cliente que já tem asaas_customer_id, achando que não tem.
        jsonLog("error", {
          reqId, evt: "whatsapp_impl_customer_read_error", err: customerErr.message,
        });
        return jsonResponse(req, { error: "Falha ao consultar o cadastro da empresa." }, 500);
      }
      if (!customer?.asaas_customer_id) {
        // O admin não cria cliente Asaas por aqui: o cadastro fiscal é fluxo do
        // onboarding, e criar um `cus_` a partir deste painel duplicaria o que
        // o checkout do cliente cria (o Asaas não deduplica).
        return jsonResponse(req, {
          error: "Esta empresa ainda não tem cadastro no Asaas. Peça ao cliente para concluir o cadastro fiscal.",
        }, 409);
      }

      const { data: unit } = await supabase
        .from("units").select("slug").eq("organization_id", organizationId)
        .order("created_at", { ascending: true }).limit(1).maybeSingle();
      const successBase = unit?.slug
        ? `${APP_BASE_URL}/g/${unit.slug}/cobranca`
        : `${APP_BASE_URL}/platform/billing/${organizationId}`;

      const result = await openImplementationCheckout({
        supabase, reqId, organizationId, plan,
        asaasCustomerId: customer.asaas_customer_id,
        successUrl: `${successBase}?session=success`,
        cancelUrl: `${successBase}?session=cancel`,
        minutesToExpire: CHECKOUT_EXPIRY_MINUTES,
        createdBy: callerId,
        reserve: (a) => reserveCheckoutSession(supabase, a),
        finalize: (id, a) => finalizeCheckoutSession(supabase, id, a),
        fail: (id) => failCheckoutSession(supabase, id),
      });

      if (!result.ok) return jsonResponse(req, { error: result.error }, result.status);
      return jsonResponse(req, {
        success: true,
        url: result.url,
        implementation_id: result.implementationId,
      });
    }

    if (action === "set_operational_status") {
      const id = String(body.id ?? "");
      const to = String(body.operational_status ?? "") as ImplementationOperationalStatus;
      if (!id || !to) {
        return jsonResponse(req, { error: "id e operational_status são obrigatórios." }, 400);
      }
      if (to === "CANCELED") {
        // Cancelamento tem action própria (exige motivo, grava canceled_at +
        // cancel_reason e checa a janela do checkout Asaas). Deixar passar por
        // aqui tiraria a linha do índice de "uma aberta" sem nada disso.
        return jsonResponse(req, {
          error: "Para cancelar use a ação de cancelamento, que exige o motivo.",
        }, 400);
      }

      const { data: row, error: readErr } = await supabase
        .from("whatsapp_implementations")
        .select("id, payment_status, operational_status, started_at")
        .eq("id", id)
        .maybeSingle();
      if (readErr) {
        jsonLog("error", { reqId, evt: "whatsapp_impl_read_error", err: readErr.message });
        return jsonResponse(req, { error: "Falha ao carregar a implantação." }, 500);
      }
      if (!row) return jsonResponse(req, { error: "Implantação não encontrada." }, 404);

      const verdict = canTransitionOperational(
        row.operational_status as ImplementationOperationalStatus,
        to,
        row.payment_status as ImplementationPaymentStatus,
      );
      if (!verdict.ok) {
        return jsonResponse(req, {
          error: verdict.reason === "payment_not_settled"
            ? "Só é possível concluir a implantação depois que o pagamento estiver confirmado (ou registrado como cortesia)."
            : "Esta mudança de etapa não é permitida a partir da etapa atual.",
        }, 409);
      }

      const patch: Record<string, unknown> = { operational_status: to, updated_by: callerId };
      if (to === "IN_PROGRESS" && !row.started_at) patch.started_at = new Date().toISOString();
      if (to === "COMPLETED") patch.completed_at = new Date().toISOString();
      if (body.scheduled_for !== undefined) patch.scheduled_for = body.scheduled_for;
      if (body.owner_admin_id !== undefined) patch.owner_admin_id = body.owner_admin_id;
      if (body.notes !== undefined) patch.notes = body.notes;

      // UPDATE condicional na etapa lida: se outro admin mudou no meio, este
      // não sobrescreve em silêncio.
      const { data: updated, error: updErr } = await supabase
        .from("whatsapp_implementations")
        .update(patch)
        .eq("id", id)
        .eq("operational_status", row.operational_status)
        .select("id");
      if (updErr) {
        jsonLog("error", { reqId, evt: "whatsapp_impl_status_error", err: updErr.message });
        return jsonResponse(req, { error: "Falha ao atualizar a etapa." }, 500);
      }
      if (!updated || updated.length === 0) {
        return jsonResponse(req, {
          error: "A etapa mudou enquanto você editava. Recarregue e tente de novo.",
        }, 409);
      }

      jsonLog("info", {
        reqId, evt: "whatsapp_impl_status_changed",
        id, from: row.operational_status, to, by: callerId,
      });
      return jsonResponse(req, { success: true });
    }

    if (action === "cancel") {
      const id = String(body.id ?? "");
      const cancelReason = String(body.cancel_reason ?? "").trim();
      if (!id) return jsonResponse(req, { error: "id é obrigatório." }, 400);
      if (!cancelReason) return jsonResponse(req, { error: "Informe o motivo do cancelamento." }, 400);

      const { data: row, error: readErr } = await supabase
        .from("whatsapp_implementations")
        .select("id, origin, payment_status, operational_status, created_at")
        .eq("id", id)
        .maybeSingle();
      if (readErr) {
        jsonLog("error", { reqId, evt: "whatsapp_impl_cancel_read_error", err: readErr.message });
        return jsonResponse(req, { error: "Falha ao carregar a implantação." }, 500);
      }
      // CANCELED já é o estado final desejado — mesmo 404 idempotente de
      // antes, decidido ANTES de consultar o núcleo (que rejeitaria com 409
      // por CANCELED ser terminal, mudando o contrato de resposta à toa).
      if (!row || row.operational_status === "CANCELED") {
        return jsonResponse(req, { error: "Implantação não encontrada ou já cancelada." }, 404);
      }

      // Checkout Asaas ainda pode ser pago pelo cliente dentro da janela de
      // expiração que foi passada ao Asaas (minutesToExpire em
      // openImplementationCheckout). Cancelar agora deixaria a cobrança viva
      // no provedor sem nenhuma linha local pra correlacionar a confirmação —
      // confirmImplementationPayment casa por origin/payment_status/
      // provider_checkout_id, sem olhar operational_status. Usa created_at da
      // própria linha (não uma consulta a billing_checkout_sessions): a linha
      // nasce segundos DEPOIS da reserva da sessão, então created_at+30min
      // termina um pouco depois do expires_at real — erra para o lado seguro.
      if (
        row.origin === "ASAAS" &&
        row.payment_status === "PENDING" &&
        Date.now() - new Date(row.created_at as string).getTime() < CHECKOUT_EXPIRY_MINUTES * 60_000
      ) {
        return jsonResponse(req, {
          error: "Esta cobrança ainda pode ser paga pelo cliente. Aguarde o checkout expirar (até 30 minutos) e cancele depois.",
        }, 409);
      }

      // A decisão de "pode cancelar daqui" é do núcleo puro, não de um filtro
      // ad hoc — COMPLETED é terminal em OPERATIONAL_TRANSITIONS e não pode
      // virar CANCELED por aqui (senão a org perde a elegibilidade de
      // contratar a mensalidade pra sempre, sem poder desfazer).
      const verdict = canTransitionOperational(
        row.operational_status as ImplementationOperationalStatus,
        "CANCELED",
        row.payment_status as ImplementationPaymentStatus,
      );
      if (!verdict.ok) {
        return jsonResponse(req, {
          error: "Esta implantação não pode ser cancelada a partir da etapa atual.",
        }, 409);
      }

      // NUNCA apaga: o histórico financeiro (pagamento externo confirmado, por
      // exemplo) mora nesta linha. CANCELED só a tira do índice de "uma aberta".
      // UPDATE condicional na etapa lida (mesmo lock otimista do
      // set_operational_status): corrida entre dois admins não sobrescreve em
      // silêncio.
      const { data: updated, error } = await supabase
        .from("whatsapp_implementations")
        .update({
          operational_status: "CANCELED",
          canceled_at: new Date().toISOString(),
          cancel_reason: cancelReason,
          updated_by: callerId,
        })
        .eq("id", id)
        .eq("operational_status", row.operational_status)
        .select("id");
      if (error) {
        jsonLog("error", { reqId, evt: "whatsapp_impl_cancel_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao cancelar a implantação." }, 500);
      }
      if (!updated || updated.length === 0) {
        return jsonResponse(req, {
          error: "A etapa mudou enquanto você editava. Recarregue e tente de novo.",
        }, 409);
      }
      jsonLog("info", { reqId, evt: "whatsapp_impl_canceled", id, by: callerId });
      return jsonResponse(req, { success: true });
    }

    // ... dispatch de get_service_status (Task 14)

    return jsonResponse(req, { error: "Ação desconhecida." }, 400);
  } catch (err) {
    jsonLog("error", {
      reqId,
      evt: "whatsapp_impl_unexpected_error",
      err: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse(req, { error: "Erro inesperado." }, 500);
  }
});
