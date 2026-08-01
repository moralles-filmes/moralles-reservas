// Núcleo puro (Fase 6b): tipos de alerta, motivos do D-1 e chaves de dedupe.
// ZERO IMPORTS — `RevenueSource` é replicado como string para não importar
// whatsapp-instance-revenue-core.ts (nem `import type`, que também quebra o
// Vite quando o alvo tiver qualquer import futuro).

export type AlertType =
  | "CYCLE_DUE_SOON"
  | "CYCLE_DUE_TOMORROW"
  | "END_CONFIRMATION_REQUIRED"
  | "DIVERGENCE"
  | "CYCLE_COST_UNKNOWN"
  | "ECONOMIC_IMBALANCE"
  // Pendência de PAINEL, sem e-mail: nenhum aviso pode afirmar uma data que
  // ninguém confirmou (§6.2). Fora de EVENT_TYPE_BY_ALERT de propósito.
  | "DATE_REVIEW_REQUIRED";

export type NotifiableAlertType = Exclude<AlertType, "DATE_REVIEW_REQUIRED">;

/**
 * ACOPLAMENTO POR STRING com TEMPLATE_BY_EVENT de process-billing-notifications
 * (§10.6). Sem a entrada lá, a linha morre em `failed/unknown_event_type` e o
 * aviso some. Mexer aqui exige mexer lá NO MESMO COMMIT, com deploy conjunto.
 * SEIS entradas — `DATE_REVIEW_REQUIRED` fica fora, e o tipo garante isso.
 */
export const EVENT_TYPE_BY_ALERT: Record<NotifiableAlertType, string> = {
  CYCLE_DUE_SOON: "admin_zapi_cycle_due_soon",
  CYCLE_DUE_TOMORROW: "admin_zapi_cycle_due_tomorrow",
  END_CONFIRMATION_REQUIRED: "admin_zapi_end_confirmation_required",
  DIVERGENCE: "admin_zapi_instance_divergence",
  CYCLE_COST_UNKNOWN: "admin_zapi_cycle_cost_unknown",
  ECONOMIC_IMBALANCE: "admin_zapi_org_economic_imbalance",
};

export const D7_WINDOW_DAYS = 7;

export type D1Reason =
  | "COST_UNKNOWN"
  | "OPEN_DIVERGENCE"
  | "CANCELLATION_INTENDED_NOT_REGISTERED"
  | "REVENUE_UNKNOWN";

export type D1Input = {
  costCents: number | null;
  hasOpenDivergence: boolean;
  cancellationIntendedNotRegistered: boolean;
  revenueSource: string;
  customerRevenueCents: number | null;
};

// Receita NULL nestes dois casos é PREVISTA pela política de §7.3, não lacuna.
const REVENUE_NULL_EXPECTED = ["AMBIGUOUS_MULTI_INSTANCE", "LIFETIME_OVERRIDE"];

/**
 * Ordem fixa: a chave de dedupe do D-1 depende do conjunto, não da ordem — mas
 * a lista exibida ao admin precisa ser estável entre execuções.
 */
export function resolveD1Reasons(input: D1Input): D1Reason[] {
  const out: D1Reason[] = [];
  if (input.costCents === null || input.costCents === undefined) out.push("COST_UNKNOWN");
  if (input.hasOpenDivergence) out.push("OPEN_DIVERGENCE");
  if (input.cancellationIntendedNotRegistered) out.push("CANCELLATION_INTENDED_NOT_REGISTERED");
  if (
    (input.customerRevenueCents === null || input.customerRevenueCents === undefined) &&
    REVENUE_NULL_EXPECTED.indexOf(input.revenueSource) === -1
  ) {
    out.push("REVENUE_UNKNOWN");
  }
  return out;
}

/**
 * Janela 1..7 e não "exatamente 7": o worker é diário e `pg_net` é
 * fire-and-forget. Um dia perdido não pode apagar o único alerta que dá tempo
 * de cancelar antes da cobrança. A unicidade por ciclo vem do dedupe_key.
 */
export function shouldEmitD7(daysUntilDue: number): boolean {
  return daysUntilDue >= 1 && daysUntilDue <= D7_WINDOW_DAYS;
}

export function shouldEmitD1(daysUntilDue: number, reasons: D1Reason[]): boolean {
  return daysUntilDue >= 0 && daysUntilDue <= 1 && reasons.length > 0;
}

/** FNV-1a 32 bits em hex. Implementado aqui porque núcleo puro não importa. */
export function fnv1a32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Hash da COMPOSIÇÃO econômica da organização. Ordenado por instanceId para
 * ser independente da ordem que o banco devolveu; custo desconhecido escreve
 * "null" e não "0", porque desconhecido não é zero.
 */
export function economicImbalanceHash(
  items: { instanceId: string; costCents: number | null }[],
  revenueCents: number | null,
): string {
  const sorted = items
    .map(
      (i) =>
        `${i.instanceId}:${i.costCents === null || i.costCents === undefined ? "null" : i.costCents}`,
    )
    .sort();
  return fnv1a32(
    `${sorted.join("|")}#${revenueCents === null || revenueCents === undefined ? "null" : revenueCents}`,
  );
}

export function dedupeKeyD7(cycleStart: string): string {
  return `cycle_d7:${cycleStart}`;
}

export function dedupeKeyD1(cycleStart: string, reasons: D1Reason[]): string {
  return `cycle_d1:${cycleStart}:${reasons.slice().sort().join(",")}`;
}

export function dedupeKeyEndConfirmation(providerAccessUntil: string): string {
  return `end_confirmation_required:${providerAccessUntil}`;
}

export function dedupeKeyCostUnknown(cycleStart: string): string {
  return `cycle_cost_unknown:${cycleStart}`;
}

/**
 * Uma pendência de data por instância — ela não se repete por ciclo, porque
 * enquanto a data não for confirmada não existe ciclo.
 */
export function dedupeKeyDateReview(instanceId: string): string {
  return `date_review_required:${instanceId}`;
}

export function dedupeKeyEconomicImbalance(monthBrt: string, hash: string): string {
  return `economic_imbalance:${monthBrt}:${hash}`;
}
