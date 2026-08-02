// Núcleo puro (Fase 6b): tipos de alerta, motivos do D-1 e chaves de dedupe.
// ZERO IMPORTS — `RevenueSource` é replicado como string para não importar
// whatsapp-instance-revenue-core.ts (nem `import type`, que também quebra o
// Vite quando o alvo tiver qualquer import futuro).
//
// FONTE CANÔNICA ÚNICA dos seis event_type. Nenhum produtor pode emitir string
// fora daqui, e o teste de acoplamento reprova as duas direções: evento sem
// template no dispatcher, e evento produzido fora desta lista.

export type AlertType =
  | "CYCLE_DUE_SOON"
  | "CYCLE_DUE_TOMORROW"
  | "END_CONFIRMATION_REQUIRED"
  | "DATE_REVIEW_REQUIRED"
  | "DIVERGENCE"
  | "ECONOMIC_IMBALANCE";

/**
 * ACOPLAMENTO POR STRING com TEMPLATE_BY_EVENT de process-billing-notifications.
 * Sem a entrada lá, a linha enfileirada morre em `failed/unknown_event_type` e o
 * aviso some. Mexer aqui exige mexer lá NO MESMO COMMIT, com deploy conjunto.
 *
 * SEIS entradas, e não sete: **custo desconhecido não tem event_type próprio**.
 * Ele é pendência financeira exibida no painel (ciclo em `PENDING_REVIEW`) e
 * entra como MOTIVO do D-1 (`COST_UNKNOWN` em `resolveD1Reasons`) quando há
 * algo acionável — criar um tipo só porque um valor está `NULL` multiplicaria
 * avisos sem multiplicar decisão.
 */
export const EVENT_TYPE_BY_ALERT: Record<AlertType, string> = {
  CYCLE_DUE_SOON: "admin_zapi_cycle_d7",
  CYCLE_DUE_TOMORROW: "admin_zapi_cycle_d1_action_required",
  END_CONFIRMATION_REQUIRED: "admin_zapi_end_confirmation_required",
  DATE_REVIEW_REQUIRED: "admin_zapi_date_review_required",
  DIVERGENCE: "admin_zapi_divergence",
  ECONOMIC_IMBALANCE: "admin_zapi_economic_imbalance",
};

/** Lista canônica achatada, para quem precisa validar strings soltas. */
export const CANONICAL_EVENT_TYPES: string[] = Object.keys(EVENT_TYPE_BY_ALERT)
  .map((k) => EVENT_TYPE_BY_ALERT[k as AlertType])
  .sort();

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
 *
 * `COST_UNKNOWN` vive aqui, e é o lugar certo dele: custo desconhecido importa
 * quando há uma cobrança chegando, não como aviso isolado.
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

/**
 * Ancorada SÓ no ciclo — os motivos ficam no `payload`, que é reescrito a cada
 * passada.
 *
 * Os motivos NÃO entram na chave porque eles são recalculados a cada execução e
 * a janela do D-1 tem dois dias (D-1 e D-0): um custo que sincroniza ou uma
 * divergência que abre no meio muda o conjunto e abriria uma linha NOVA —
 * dois avisos "created" para o mesmo vencimento, e o primeiro deles congelado
 * com uma lista de motivos que já não vale. Um vencimento, uma ocorrência.
 */
export function dedupeKeyD1(cycleStart: string): string {
  return `cycle_d1:${cycleStart}`;
}

export function dedupeKeyEndConfirmation(providerAccessUntil: string): string {
  return `end_confirmation_required:${providerAccessUntil}`;
}

/**
 * Formato aprovado: `<YYYY-MM BRT>:<instance_id>`.
 *
 * O mês na frente é o que produz "no máximo um lembrete por mês enquanto a
 * data continuar desconhecida": cada mês abre UMA ocorrência nova em vez de
 * reemitir a mesma linha indefinidamente. Quando data e âncora forem
 * confirmadas, TODAS as ocorrências abertas da instância são resolvidas.
 */
export function dedupeKeyDateReview(monthBrt: string, instanceId: string): string {
  return `${monthBrt}:${instanceId}`;
}

export function dedupeKeyEconomicImbalance(monthBrt: string, hash: string): string {
  return `economic_imbalance:${monthBrt}:${hash}`;
}
