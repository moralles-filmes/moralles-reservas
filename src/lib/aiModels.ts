import {
  activeModelsFor,
  defaultModelFor,
  getModelEntry,
  resolveModel,
  type AIProvider,
} from "../../supabase/functions/_shared/ai-model-catalog";

export type { AIProvider };

export interface AIModelOption {
  value: string;
  label: string;
  hint?: string;
  /** Já rodou em produção com chave real; `false` = a tela avisa "não testado em produção". */
  verified: boolean;
}

/** Ordem canônica dos provedores na UI (seletores e listas). */
export const AI_PROVIDER_ORDER: readonly AIProvider[] = [
  "claude",
  "openai",
  "gemini",
  "grok",
  "deepseek",
];

// Derivados do catálogo (única fonte da lista de modelos): só ativos, default primeiro.
export const MODELS_BY_PROVIDER = Object.fromEntries(
  AI_PROVIDER_ORDER.map((p) => [
    p,
    activeModelsFor(p).map((e): AIModelOption => ({ value: e.id, label: e.label, hint: e.hint, verified: e.verifiedInProduction })),
  ]),
) as Record<AIProvider, AIModelOption[]>;

export const DEFAULT_MODEL_BY_PROVIDER = Object.fromEntries(
  AI_PROVIDER_ORDER.map((p) => [p, defaultModelFor(p).id]),
) as Record<AIProvider, string>;

/** O que a tela mostra sobre o modelo SALVO da unidade (nunca reescreve o valor salvo). */
export type SavedModelState =
  | { kind: "empty"; used: string; usedLabel: string; verified: boolean }
  | { kind: "active"; id: string; verified: boolean }
  | { kind: "retired"; saved: string; used: string; usedLabel: string }
  | { kind: "unknown"; saved: string; used: string; usedLabel: string };

/**
 * Classifica o valor salvo pela MESMA regra do backend (`resolveModel`), para a
 * tela nunca divergir do que o agente de fato usa.
 */
export function describeSavedModel(provider: AIProvider, saved?: string | null): SavedModelState {
  const r = resolveModel(provider, saved);
  const label = () => getModelEntry(provider, r.model)?.label ?? r.model;
  switch (r.reason) {
    case "default":
      // O padrão também pode nunca ter rodado em produção (todo provider fora o
      // Gemini, hoje): o selo vale para ele.
      return {
        kind: "empty",
        used: r.model,
        usedLabel: label(),
        verified: getModelEntry(provider, r.model)?.verifiedInProduction === true,
      };
    case "saved":
      return { kind: "active", id: r.model, verified: getModelEntry(provider, r.model)?.verifiedInProduction === true };
    case "retired_successor":
      return { kind: "retired", saved: r.rejected ?? "", used: r.model, usedLabel: label() };
    case "unknown_default":
      return { kind: "unknown", saved: r.rejected ?? "", used: r.model, usedLabel: label() };
  }
}
