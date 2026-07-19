// Decisão e aplicação dos efeitos de negócio dos eventos Asaas.
//
// COMPARTILHADO por asaas-webhook e process-asaas-reconcile de propósito:
// quando `processing_status='processed'` passou a significar "assinatura
// ativada", o reconcile precisou executar a MESMA lógica — senão marca como
// resolvido um evento que nunca ativou nada.
//
// A metade de cima é PURA (zero imports, zero Deno.*) e testada em
// src/lib/asaas-billing-events.test.ts. A metade de baixo faz I/O e nunca é
// importada por src/.

// ─────────────────────────────────────────────────────────────────────────────
// NÚCLEO PURO
// ─────────────────────────────────────────────────────────────────────────────

/** Espelha o CHECK de billing_invoices.purpose (migration 063). */
export type AsaasPurpose = "subscription" | "implementation" | "ai_topup" | "other";

const PURPOSES: ReadonlySet<string> = new Set<AsaasPurpose>([
  "subscription",
  "implementation",
  "ai_topup",
  "other",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExternalReferenceParts {
  orgId: string;
  planId: string | null;
  purpose: AsaasPurpose;
}

/**
 * Correlação que viaja até o Asaas e volta no webhook. Cabe no limite de 200
 * chars de `externalReference` (§9): 3 UUIDs + rótulos ≈ 110.
 */
export function buildExternalReference(parts: ExternalReferenceParts): string {
  return `org:${parts.orgId}|plan:${parts.planId ?? "none"}|purpose:${parts.purpose}`;
}

/**
 * Parse defensivo: é dado NOSSO voltando de terceiro, então qualquer shape
 * inesperado vira `null` e o caller cai nos fallbacks (provider_payment_id,
 * asaas_customer_id). Nunca lança.
 */
export function parseExternalReference(raw: unknown): ExternalReferenceParts | null {
  if (typeof raw !== "string" || !raw) return null;

  const match = /^org:([^|]+)\|plan:([^|]+)\|purpose:([^|]+)$/.exec(raw);
  if (!match) return null;

  const [, orgId, planRaw, purpose] = match;
  if (!UUID_RE.test(orgId)) return null;
  if (planRaw !== "none" && !UUID_RE.test(planRaw)) return null;
  if (!PURPOSES.has(purpose)) return null;

  return {
    orgId,
    planId: planRaw === "none" ? null : planRaw,
    purpose: purpose as AsaasPurpose,
  };
}
