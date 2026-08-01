import { grossMarginDisplay } from "../../supabase/functions/_shared/whatsapp-instance-revenue-core";

/**
 * Formatação do painel de instâncias (Fase 6b).
 *
 * Importa o núcleo puro direto de `supabase/functions/_shared/` — cross-boundary
 * deliberado, mesmo padrão de `whatsapp-implementation-core.ts`: duas fórmulas
 * de margem divergentes é pior que um import fora do padrão.
 */

/**
 * Desconhecido é travessão, NUNCA "R$ 0,00": zero é um fato ("não custa nada")
 * e exibi-lo no lugar de "não sei" mente sobre a margem.
 */
export function formatCents(cents: number | null): string {
  if (cents === null || cents === undefined) return "—";
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function formatMargin(revenueCents: number | null, costCents: number | null): string {
  const d = grossMarginDisplay(revenueCents, costCents);
  if (d.kind === "NOT_APPLICABLE") return "não aplicável";
  if (d.kind === "PENDING") return "pendente";
  return `${d.value.toLocaleString("pt-BR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

/**
 * `provider_access_until` é EXCLUSIVO — primeiro dia NÃO coberto. A UI escreve
 * "acesso até <until - 1>" para o leitor humano, senão o operador lê um dia a
 * mais de acesso do que existe.
 */
export function lastAccessDayLabel(providerAccessUntil: string | null): string | null {
  if (!providerAccessUntil) return null;
  const y = Number(providerAccessUntil.slice(0, 4));
  const m = Number(providerAccessUntil.slice(5, 7));
  const d = Number(providerAccessUntil.slice(8, 10));
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  const dd = String(prev.getUTCDate()).padStart(2, "0");
  const mm = String(prev.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${prev.getUTCFullYear()}`;
}

const CYCLE_SOURCE_LABEL: Record<string, string> = {
  // "data não confirmada" e não "desconhecida": diz o que falta fazer.
  UNKNOWN: "data não confirmada",
  ADMIN_CONFIRMED: "confirmada pelo administrador",
  SYSTEM_ROLLED: "rolagem automática",
};

export function cycleSourceLabel(source: string): string {
  return CYCLE_SOURCE_LABEL[source] ?? source;
}

/**
 * Rótulos das cinco divergências canônicas. NENHUM afirma que o fornecedor
 * continua cobrando — a evidência é local, e o que se pede é verificação.
 */
const DIVERGENCE_LABEL: Record<string, string> = {
  CHANNEL_WITHOUT_INSTANCE: "canal fora do inventário",
  PAYING_WITHOUT_CHANNEL: "instância ativa sem canal",
  INSTANCE_REF_MISMATCH: "identificador divergente",
  LIFECYCLE_VS_CHANNEL_STATE: "canal desconectado há dias",
  ALIVE_AFTER_END: "sinais após o encerramento",
};

/** Tipo desconhecido devolve o próprio código: melhor um código na tela que
 *  um texto inventado sobre um fato que a UI não conhece. */
export function divergenceLabel(kind: string): string {
  return DIVERGENCE_LABEL[kind] ?? kind;
}
