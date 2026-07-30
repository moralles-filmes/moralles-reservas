// Worker: suspende e restaura o SERVIÇO de WhatsApp por inadimplência da
// mensalidade da instância. Roda diariamente via pg_cron.
//
// Suspender = billing_subscriptions.status='unpaid' + suspended_at. O núcleo de
// entitlements já trata `unpaid` como sem acesso, então nada nele muda; e
// `unpaid` não é `canceled`, então resolve_or_activate_subscription continua
// encontrando a linha e não cria uma segunda assinatura (e, no caminho do
// pagamento via Asaas, já restaura suspended_at/restored_at sozinha — este
// worker é a defesa dupla para quando aquele caminho não passa por lá,
// mesmo padrão de process-billing-unblock para invoice.paid).
//
// NUNCA escreve organizations.billing_status — essa coluna representa o acesso
// ao SISTEMA, e a mensalidade da instância não governa o sistema.
// NUNCA escreve em organization_entitlement_overrides — override é ação
// administrativa; worker financeiro não mexe.
//
// GATE DE FLAG (`whatsapp_service_enforcement`): governa só a ESCRITA em
// billing_subscriptions (suspender/restaurar) e as notificações de cliente
// que dependem dela. OFF ou ilegível = calcula tudo, não escreve nada, emite
// `evt:"whatsapp_enforcement_dryrun_worker"` por organização que teria mudado
// de estado. Ambiguidade de assinatura e o skip por override ativo são
// observações de DADO, não a consequência que a flag gateia — ficam sempre
// visíveis, mesmo em dry-run.
//
// AMBIGUIDADE (mais de uma assinatura WHATSAPP_SUBSCRIPTION viva para a mesma
// organização): não escolhe, não movimenta a organização, avisa o admin da
// plataforma. Mesma política de `resolve_or_activate_subscription`
// (`ambiguous_subscription_category`, migration 073/079) e da nota da Task 13
// sobre o `.maybeSingle()` de `resolveWhatsAppGateByOrg` devolver PGRST116
// nesse cenário — por isso a contagem é feita aqui, ANTES de chamar o gate,
// numa query própria que nunca lança.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalAuth, genRequestId, jsonLog } from "../_shared/security.ts";
import { checkFlagEnabled } from "../_shared/platform-flags.ts";
import {
  normalizeFinancialState,
  isBillingInvoiceStatus,
  type BillingInvoiceStatus,
} from "../_shared/billing-financial-state-core.ts";
import { resolveWhatsAppGateByOrg, clearWhatsAppGateCache } from "../_shared/whatsapp-service-gate.ts";
import {
  resolveBillingRecipient,
  resolvePlatformAdminRecipients,
  enqueueBillingNotification,
} from "../_shared/billing-notify.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const WHATSAPP_CATEGORY = "WHATSAPP_SUBSCRIPTION";

interface WhatsAppSub {
  id: string;
  organization_id: string;
  status: string;
  canceled_at: string | null;
}

serve(async (req) => {
  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  // Sem isso, um isolate quente serviria o veredito da invocação anterior —
  // este worker varre MUITAS organizações numa só passagem, e um resultado
  // velho aplicado a quem acabou de pagar é exatamente o bug que o cache por
  // invocação existe para evitar (ver header de whatsapp-service-gate.ts).
  clearWhatsAppGateCache();

  const reqId = genRequestId();
  jsonLog("info", { reqId, evt: "whatsapp_enforcement_start" });

  try {
    // Flag ilegível é tratada como OFF para efeito de ESCREVER — fail-open
    // pro cliente: um soluço na leitura da flag não pode virar suspensão.
    const flagCheck = await checkFlagEnabled("whatsapp_service_enforcement");
    const apply = flagCheck.enabled && !flagCheck.readFailed;

    const { data: subsRaw, error: subsErr } = await supabase
      .from("billing_subscriptions")
      .select("id, organization_id, status, canceled_at, billing_plans!inner(category)")
      .eq("billing_plans.category", WHATSAPP_CATEGORY)
      .neq("status", "canceled");

    if (subsErr) {
      jsonLog("error", { reqId, evt: "whatsapp_enforcement_query_failed", err: subsErr.message });
      return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
    }

    const subs = (subsRaw ?? []) as unknown as WhatsAppSub[];

    // Agrupar por organização é o que permite detectar ambiguidade SEM passar
    // por .maybeSingle() (que lançaria PGRST116 em vez de devolver uma
    // contagem utilizável).
    const byOrg = new Map<string, WhatsAppSub[]>();
    for (const s of subs) {
      const list = byOrg.get(s.organization_id) ?? [];
      list.push(s);
      byOrg.set(s.organization_id, list);
    }

    let suspended = 0;
    let restored = 0;
    let skippedOverride = 0;
    let ambiguous = 0;
    let wouldSuspend = 0;
    let wouldRestore = 0;

    for (const [orgId, orgSubs] of byOrg) {
      if (orgSubs.length > 1) {
        ambiguous++;
        jsonLog("warn", {
          reqId,
          evt: "whatsapp_ambiguous_subscription",
          org: orgId,
          count: orgSubs.length,
        });
        const recipients = await resolvePlatformAdminRecipients(supabase);
        for (const recipient of recipients) {
          await enqueueBillingNotification(supabase, {
            organizationId: orgId,
            eventType: "admin_whatsapp_ambiguous_subscription",
            invoiceId: null,
            recipient,
          });
        }
        continue;
      }

      const sub = orgSubs[0];

      // Fatura em aberto mais antiga desta assinatura, excluindo as retidas —
      // mesmo padrão de whatsapp-service-gate.ts / process-billing-overdue:
      // fatura em revisão administrativa não conta como atraso.
      const { data: inv, error: invErr } = await supabase
        .from("billing_invoices")
        .select("due_date, status")
        .eq("billing_subscription_id", sub.id)
        .eq("status", "open")
        .eq("enforcement_hold", false)
        .not("due_date", "is", null)
        .order("due_date", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (invErr) {
        jsonLog("warn", {
          reqId,
          evt: "whatsapp_enforcement_invoice_read_failed",
          org: orgId,
          sub: sub.id,
          err: invErr.message,
        });
        continue;
      }

      let oldestOpenInvoice: { dueDate: string; status: BillingInvoiceStatus } | null = null;
      if (inv?.due_date) {
        // Defesa em profundidade contra drift de schema — o CHECK do banco já
        // deveria garantir que status='open' é sempre um valor conhecido.
        if (isBillingInvoiceStatus(inv.status)) {
          oldestOpenInvoice = { dueDate: inv.due_date as string, status: inv.status };
        } else {
          jsonLog("warn", {
            reqId,
            evt: "whatsapp_enforcement_invalid_invoice_status",
            org: orgId,
            sub: sub.id,
            status: inv.status,
          });
          continue;
        }
      }

      const financial = normalizeFinancialState({
        now: new Date().toISOString(),
        subscriptionStatus: sub.status,
        canceledAt: sub.canceled_at,
        oldestOpenInvoice,
      });

      // Override ativo de whatsapp: reusa o helper de I/O da Task 13 em vez de
      // duplicar a leitura de organization_entitlement_overrides. Com
      // exatamente 1 assinatura confirmada acima, o .maybeSingle() interno do
      // gate não pode mais lançar PGRST116 por ambiguidade.
      const gate = await resolveWhatsAppGateByOrg(supabase, orgId);
      if (gate.readFailed) {
        jsonLog("warn", {
          reqId,
          evt: "whatsapp_enforcement_gate_read_failed",
          org: orgId,
          sub: sub.id,
        });
        continue;
      }
      const overrideActive = gate.state === "OVERRIDE_ACTIVE";

      if (financial.state === "OVERDUE_BEYOND_GRACE") {
        if (overrideActive) {
          // Custo patrocinado pela plataforma — precisa ficar visível mesmo
          // quando não há nada a suspender por causa disso.
          skippedOverride++;
          jsonLog("info", {
            reqId,
            evt: "whatsapp_suspension_skipped_override",
            org: orgId,
            sub: sub.id,
          });
          continue;
        }

        if (sub.status !== "active" && sub.status !== "past_due") {
          // Já suspensa (unpaid) ou estado que este worker não movimenta
          // (ex.: paused) — nada a fazer.
          continue;
        }

        if (!apply) {
          wouldSuspend++;
          jsonLog("info", {
            reqId,
            evt: "whatsapp_enforcement_dryrun_worker",
            org: orgId,
            sub: sub.id,
            would_suspend: true,
          });
          continue;
        }

        // Condicional em ["active","past_due"]: aceita tanto quem já passou
        // pela tolerância quanto quem nunca recebeu o webhook de vencimento
        // (nunca virou past_due). O `.select("id")` é o que distingue "eu
        // suspendi agora" de "já estava suspensa" — só quem de fato mudou a
        // linha enfileira o aviso.
        const { data: changed, error: updErr } = await supabase
          .from("billing_subscriptions")
          .update({ status: "unpaid", suspended_at: new Date().toISOString() })
          .eq("id", sub.id)
          .in("status", ["active", "past_due"])
          .select("id");

        if (updErr) {
          jsonLog("error", {
            reqId,
            evt: "whatsapp_enforcement_suspend_failed",
            org: orgId,
            sub: sub.id,
            err: updErr.message,
          });
          continue;
        }

        if ((changed?.length ?? 0) > 0) {
          suspended++;
          jsonLog("info", { reqId, evt: "whatsapp_suspended", org: orgId, sub: sub.id });
          const recipient = await resolveBillingRecipient(supabase, orgId);
          if (recipient) {
            await enqueueBillingNotification(supabase, {
              organizationId: orgId,
              eventType: "whatsapp_suspended",
              invoiceId: null,
              recipient,
            });
          }
        }
        continue;
      }

      if (sub.status === "unpaid" && financial.state === "PAID") {
        if (!apply) {
          wouldRestore++;
          jsonLog("info", {
            reqId,
            evt: "whatsapp_enforcement_dryrun_worker",
            org: orgId,
            sub: sub.id,
            would_restore: true,
          });
          continue;
        }

        const { data: restoredRows, error: restoreErr } = await supabase
          .from("billing_subscriptions")
          .update({ status: "active", restored_at: new Date().toISOString(), suspended_at: null })
          .eq("id", sub.id)
          .eq("status", "unpaid")
          .select("id");

        if (restoreErr) {
          jsonLog("error", {
            reqId,
            evt: "whatsapp_enforcement_restore_failed",
            org: orgId,
            sub: sub.id,
            err: restoreErr.message,
          });
          continue;
        }

        if ((restoredRows?.length ?? 0) > 0) {
          restored++;
          jsonLog("info", { reqId, evt: "whatsapp_restored", org: orgId, sub: sub.id });
          const recipient = await resolveBillingRecipient(supabase, orgId);
          if (recipient) {
            await enqueueBillingNotification(supabase, {
              organizationId: orgId,
              eventType: "whatsapp_restored",
              invoiceId: null,
              recipient,
            });
          }
        }
      }
    }

    const summary = {
      dry_run: !apply,
      subscriptions_scanned: subs.length,
      suspended,
      restored,
      would_suspend: wouldSuspend,
      would_restore: wouldRestore,
      skipped_override: skippedOverride,
      ambiguous,
    };

    jsonLog("info", { reqId, evt: "whatsapp_enforcement_done", ...summary });
    return new Response(JSON.stringify({ success: true, ...summary }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    jsonLog("error", { reqId, evt: "whatsapp_enforcement_error", err: String(err) });
    return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
  }
});
