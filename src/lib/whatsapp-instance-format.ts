import { grossMarginDisplay } from "../../supabase/functions/_shared/whatsapp-instance-revenue-core";
import { COST_SOURCES } from "../../supabase/functions/_shared/whatsapp-instance-core";
import { INSTANCE_NOTE_ACTIONS } from "../../supabase/functions/_shared/whatsapp-instance-notes-core";

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

/**
 * Procedência do custo, em português.
 *
 * `COST_SOURCES` é a fonte canônica (a whitelist é a ÚNICA barreira: `cost_source`
 * é `text` sem CHECK no banco). O mapa abaixo é derivado dela — nunca redigitado —
 * e o teste reprova nas duas direções.
 */
const COST_SOURCE_LABEL: Record<(typeof COST_SOURCES)[number], string> = {
  ADMIN_INFORMED: "informado pelo administrador",
  PROVIDER_INVOICE: "fatura do fornecedor",
  PROVIDER_PANEL: "painel do fornecedor",
  ESTIMATED: "estimado",
};

export const COST_SOURCE_OPTIONS: readonly { value: string; label: string }[] =
  COST_SOURCES.map((value) => ({ value, label: COST_SOURCE_LABEL[value] }));

/** Ausente é travessão, nunca um rótulo inventado — custo sem procedência é um fato. */
export function costSourceLabel(source: string | null): string {
  if (!source) return "—";
  return COST_SOURCE_LABEL[source as (typeof COST_SOURCES)[number]] ?? source;
}

/** Ações do ledger de observações, em português. */
const NOTE_ACTION_LABEL: Record<(typeof INSTANCE_NOTE_ACTIONS)[number], string> = {
  REGISTER: "registro da instância",
  UPDATE: "correção de vínculo",
  REACTIVATE: "reativação",
  SET_COST: "custo informado",
  CONFIRM_CYCLE_DATE: "data do ciclo confirmada",
  REQUEST_CANCELLATION: "cancelamento solicitado",
  CONFIRM_END: "encerramento confirmado",
  CORRECT_CYCLE_COST: "custo de ciclo corrigido",
};

export function instanceNoteActionLabel(action: string): string {
  return NOTE_ACTION_LABEL[action as (typeof INSTANCE_NOTE_ACTIONS)[number]] ?? action;
}

/**
 * Copy do toast das duas ações que a EF sabe descrever e a tela não usava.
 *
 * O PROBLEMA QUE ISTO FECHA: `"Custo atualizado."` seco afirma que a promessa
 * do diálogo ("o ciclo fica pendente de revisão até o número existir") foi
 * cumprida — mesmo quando `cycle_filled` é `false` e o ciclo aberto não mudou.
 * E o `PENDING_REVIEW` só aparece DENTRO da seção expandida, que o operador
 * precisa abrir: o toast é o único retorno no instante da ação.
 *
 * `hasOpenCycle: null` é *a EF não disse* — janela entre os deploys. Ele não
 * afirma nada sobre o ciclo, em vez de afirmar o negativo por default.
 */
export function setCostToast(r: { filled: boolean; hasOpenCycle: boolean | null }): string {
  // `filled` é fato próprio: só é `true` se havia ciclo aberto para preencher.
  if (r.filled) return "Custo atualizado e aplicado ao ciclo em aberto.";
  if (r.hasOpenCycle === true) {
    // "não mudou", não "manteve o valor congelado": com custo submetido nulo o
    // ciclo pode não ter valor nenhum a manter. A frase precisa ser verdadeira
    // nos dois casos.
    return "Custo atualizado na instância. O ciclo em aberto não mudou.";
  }
  if (r.hasOpenCycle === false) return "Custo atualizado na instância. Não há ciclo em aberto.";
  return "Custo atualizado na instância.";
}

export function confirmEndToast(closedCycleStatus: string | null): string {
  if (closedCycleStatus === "CLOSED") return "Encerramento confirmado. O último ciclo foi fechado.";
  if (closedCycleStatus === "PENDING_REVIEW") {
    return "Encerramento confirmado. O último ciclo fechou sem custo — informe o valor em Ciclos e margem.";
  }
  return "Encerramento confirmado. Não havia ciclo em aberto.";
}

/** Lê a resposta da EF sem confiar no formato — `unknown` é o que o hook entrega. */
export function setCostToastFromResponse(data: unknown): string {
  const d = (data ?? {}) as { cycle_filled?: unknown; has_open_cycle?: unknown };
  let hasOpenCycle: boolean | null;
  if (typeof d.has_open_cycle === "boolean") {
    hasOpenCycle = d.has_open_cycle;
  } else {
    hasOpenCycle = null;
  }
  return setCostToast({ filled: d.cycle_filled === true, hasOpenCycle });
}

export function confirmEndToastFromResponse(data: unknown): string {
  const d = (data ?? {}) as { closed_cycle_status?: unknown };
  return confirmEndToast(typeof d.closed_cycle_status === "string" ? d.closed_cycle_status : null);
}
