// Aplicador de I/O dos efeitos de negócio decididos em asaas-billing-events.ts.
//
// Arquivo IRMÃO, não seção do mesmo arquivo: `npm run test -- asaas-billing-events`
// (Task 6, Step 2) provou que o import `https://esm.sh/@supabase/supabase-js` —
// mesmo só de tipo — quebra a resolução do Vite quando vive no MESMO módulo que
// o núcleo puro importado por src/lib/asaas-billing-events.test.ts ("Only URLs
// with a scheme in: file and data are supported by the default ESM loader").
// Mesmo particionamento que existe entre asaas-core.ts (puro) e asaas.ts (I/O)
// — razão de aquele par existir, replicada aqui.
//
// COMPARTILHADO por asaas-webhook e process-asaas-reconcile de propósito: os
// dois chamam `applyAsaasEvent` e não podem divergir na lógica de aplicação.
// NUNCA importado por src/.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  decideEventEffect,
  parseExternalReference,
  type AsaasEffectKind,
  type AsaasPurpose,
} from "./asaas-billing-events.ts";
import { getBillingProvider } from "./billing-provider.ts";
import { asaasValueToCents } from "./asaas-core.ts";

export interface BillingEventRow {
  id: string;
  provider_event_id: string;
  event_type: string;
  data: Record<string, unknown> | null;
  organization_id: string | null;
}

export interface ApplyResult {
  status: "processed" | "failed" | "ignored";
  organizationId: string | null;
  effect: AsaasEffectKind;
  error?: string;
}

/** Extrai o id do payment do envelope. Shape não é uniforme entre categorias (§3). */
function extractPaymentId(data: Record<string, unknown> | null): string | null {
  const payment = data?.payment;
  if (typeof payment === "string") return payment;
  if (payment && typeof payment === "object") {
    const id = (payment as { id?: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

/**
 * Aplica o efeito de negócio de um evento Asaas já persistido.
 *
 * NUNCA lança: todo caminho de erro vira `{status:'failed'}`, porque o webhook
 * precisa responder 200 (a linha já está durável e o reconcile reprocessa) e o
 * reconcile precisa continuar o lote.
 */
export async function applyAsaasEvent(
  supabase: SupabaseClient,
  row: BillingEventRow,
): Promise<ApplyResult> {
  try {
    const paymentId = extractPaymentId(row.data);

    // 1. Buscar a invoice que já conhecemos deste pagamento, se houver.
    let invoice: {
      id: string;
      status: string;
      organization_id: string;
      billing_subscription_id: string | null;
      amount_cents: number;
    } | null = null;

    if (paymentId) {
      const { data } = await supabase
        .from("billing_invoices")
        .select("id, status, organization_id, billing_subscription_id, amount_cents")
        .eq("provider", "asaas")
        .eq("provider_payment_id", paymentId)
        .maybeSingle();
      invoice = data ?? null;
    }

    // 2. Resolver a organização. Ordem: invoice conhecida → externalReference
    //    do payment (fonte primária) → customer Asaas.
    let organizationId = row.organization_id ?? invoice?.organization_id ?? null;
    let planId: string | null = null;
    // Default deliberado: sem externalReference legível, tratamos como
    // "other" — que NÃO concede acesso. Errar para o lado de não liberar.
    let purpose: AsaasPurpose = "other";
    let externalReferenceRaw: string | null = null;
    let paidValueCents: number | null = null;

    if (paymentId) {
      const provider = getBillingProvider("asaas");
      const res = await provider.getPayment(paymentId);
      if (res.ok && res.data) {
        if (typeof res.data.externalReference === "string") {
          externalReferenceRaw = res.data.externalReference;
        }
        const parsed = parseExternalReference(res.data.externalReference);
        if (parsed) {
          organizationId = organizationId ?? parsed.orgId;
          planId = parsed.planId;
          purpose = parsed.purpose;
        }

        // getPayment devolve payload CRU do Asaas: `value` é em REAIS.
        // Comparar com amount_cents sem converter é bug de 100x.
        const rawValue = res.data.value;
        if (typeof rawValue === "number") {
          paidValueCents = asaasValueToCents(rawValue);
        }

        if (!organizationId) {
          const customerRef = res.data.customer;
          if (typeof customerRef === "string" && customerRef) {
            const { data: cust } = await supabase
              .from("billing_customers")
              .select("organization_id")
              .eq("asaas_customer_id", customerRef)
              .maybeSingle();
            organizationId = cust?.organization_id ?? null;
          }
        }
      }
    }

    // 3. Estado atual da assinatura da org.
    let subscription: { id: string; status: string } | null = null;
    if (organizationId) {
      const { data } = await supabase
        .from("billing_subscriptions")
        .select("id, status")
        .eq("organization_id", organizationId)
        .neq("status", "canceled")
        .maybeSingle();
      subscription = data ?? null;
    }

    // 4. Decidir (puro). NÃO passa status de assinatura — `decideEventEffect`
    //    não branchia nele (removido do input na revisão da Task 5).
    const effect = decideEventEffect({
      eventType: row.event_type,
      invoiceStatus: invoice?.status ?? null,
    });

    if (effect.kind === "unknown") {
      return { status: "ignored", organizationId, effect: effect.kind, error: effect.reason };
    }
    if (effect.kind === "noop") {
      return { status: "processed", organizationId, effect: effect.kind };
    }
    if (!organizationId) {
      return {
        status: "failed",
        organizationId: null,
        effect: effect.kind,
        error: "Não foi possível correlacionar o evento a uma organização.",
      };
    }

    // 5. Executar. Transições por UPDATE CONDICIONAL — o `.neq`/`.eq` no status
    //    anterior é o que garante idempotência sob concorrência (webhook e
    //    reconcile podem tocar a mesma linha).
    switch (effect.kind) {
      case "activate_subscription": {
        // OBRIGAÇÃO 1 do contrato (JSDoc de decideEventEffect): registrar o
        // dinheiro SEMPRE — inclusive criando a linha quando ela não existe.
        // A idempotência do 2º evento do cartão (CONFIRMED e depois RECEIVED,
        // até ~30 dias) depende INTEIRAMENTE desta escrita: sem ela o segundo
        // evento reencontra a invoice não-paga e ativa de novo.
        if (invoice) {
          await supabase
            .from("billing_invoices")
            .update({ status: "paid", paid_at: new Date().toISOString() })
            .eq("id", invoice.id)
            .neq("status", "paid");

          if (paidValueCents !== null && paidValueCents !== invoice.amount_cents) {
            console.error(
              JSON.stringify({
                evt: "asaas_amount_divergence",
                invoice_id: invoice.id,
                expected_cents: invoice.amount_cents,
                paid_cents: paidValueCents,
              }),
            );
          }
        } else if (paymentId) {
          // Sem linha prévia — caso normal de renovação, porque PAYMENT_CREATED
          // é informativo e não cria invoice. `provider_payment_id` tem UNIQUE
          // parcial, então uma corrida entre webhook e reconcile vira 23505 e
          // não linha duplicada.
          const { error: insertErr } = await supabase.from("billing_invoices").insert({
            organization_id: organizationId,
            billing_subscription_id: subscription?.id ?? null,
            provider: "asaas",
            provider_payment_id: paymentId,
            purpose,
            external_reference: externalReferenceRaw,
            status: "paid",
            amount_cents: paidValueCents ?? 0,
            currency: "BRL",
            paid_at: new Date().toISOString(),
          });
          if (insertErr && insertErr.code !== "23505") {
            console.error("applyAsaasEvent: falha ao criar invoice", insertErr);
          }
        }

        // OBRIGAÇÃO 2 do contrato: conceder acesso SOMENTE quando o pagamento
        // for de assinatura do sistema. Um pacote de IA ou uma taxa de
        // implantação registram dinheiro mas NÃO liberam o sistema — senão uma
        // org inadimplente compraria R$ 50 de crédito e voltaria a ter acesso.
        if (purpose !== "subscription") {
          break;
        }

        if (subscription) {
          await supabase
            .from("billing_subscriptions")
            .update({ status: "active" })
            .eq("id", subscription.id)
            .neq("status", "active");
        } else if (planId) {
          const { data: customer } = await supabase
            .from("billing_customers")
            .select("id")
            .eq("organization_id", organizationId)
            .maybeSingle();

          await supabase.from("billing_subscriptions").insert({
            organization_id: organizationId,
            billing_customer_id: customer?.id ?? null,
            billing_plan_id: planId,
            provider: "asaas",
            status: "active",
            payment_method: "pix",
          });
        }

        // Espelha em organizations, que é a coluna autoritativa do
        // BillingGuard e dos guards server-side.
        await supabase
          .from("organizations")
          .update({ billing_status: "active", blocked_at: null, blocked_reason: null })
          .eq("id", organizationId);
        break;
      }

      case "mark_invoice_overdue": {
        if (invoice) {
          await supabase
            .from("billing_invoices")
            .update({ status: "open" })
            .eq("id", invoice.id)
            .not("status", "in", "(paid,void)");
        }
        break;
      }

      case "record_refund": {
        if (invoice) {
          await supabase
            .from("billing_invoices")
            .update({ status: "void" })
            .eq("id", invoice.id)
            .neq("status", "void");
        }
        console.error(
          JSON.stringify({
            evt: "asaas_refund_recorded",
            organization_id: organizationId,
            event_type: row.event_type,
            purpose,
          }),
        );
        break;
      }
    }

    return { status: "processed", organizationId, effect: effect.kind };
  } catch (err) {
    console.error("applyAsaasEvent failed", err);
    return {
      status: "failed",
      organizationId: row.organization_id,
      effect: "unknown",
      error: "Falha ao aplicar efeito do evento — ver logs.",
    };
  }
}
