/**
 * Catálogo ÚNICO de modelos de IA do agente: lista, papel, sucessor de
 * aposentado, perfil de requisição e fallback do mesmo provider.
 *
 * POR QUE ESTE ARQUIVO EXISTE: a lista de modelos vivia em 4 lugares
 * sincronizados à mão (UI, defaults, KNOWN_MODELS, FALLBACK_MODELS). Aqui há uma
 * fonte só; as demais estruturas são DERIVADAS dela.
 *
 * É importado pelo backend (Edge Functions Deno) E pelo front (Vite, por caminho
 * relativo `../../supabase/functions/_shared/ai-model-catalog`). A travessia da
 * fronteira é proposital: mudar este arquivo exige redeploy das Edge Functions
 * consumidoras E deploy do front.
 *
 * Sem I/O, sem `Deno`, sem import (nem de tipo): o `tsc -b` do app e o
 * `deno check` precisam compilá-lo isolado. A união de providers é redeclarada
 * aqui pelo mesmo motivo de `agent-output-core.ts`.
 */
export type AIProvider = "claude" | "openai" | "gemini" | "grok" | "deepseek";

export type AIModelRole = "default" | "strong" | "light";

export type AIRequestProfile =
  | "gemini-2.5"
  | "gemini-3-low"
  | "gemini-3-minimal"
  | "claude-haiku-5"
  | "claude-sonnet-5"
  | "openai-gpt6-tools"
  | "openai-gpt5-reasoning-low"
  | "grok-4-non-reasoning"
  | "grok-4-reasoning"
  | "deepseek-v4-thinking-off"
  /** Aposentado: nunca chega ao runner (`resolveModel` troca pelo sucessor). */
  | "retired";

export type AIModelEntry = {
  provider: AIProvider;
  id: string;
  label: string;
  hint?: string;
  status: "active" | "retired";
  /** Obrigatório se `retired`: modelo ATIVO, do mesmo provider e do mesmo papel. */
  successor?: string;
  /** Exatamente um `default` ativo por provider. */
  role: AIModelRole;
  capabilities: { vision: boolean; reasoning: "none" | "budget" | "level" | "adaptive" };
  requestProfile: AIRequestProfile;
  /** Já rodou em produção com chave real. `false` = entra como "não verificado". */
  verifiedInProduction: boolean;
  sameProviderFallback?: string | null;
};

/**
 * Evidência de cada linha: plano §8.1 (conferida nas páginas oficiais em
 * 2026-10-20). Aposentar = mudar `status` + `successor` aqui, PR e redeploy;
 * nenhuma migration toca `settings`.
 */
export const AI_MODEL_CATALOG: readonly AIModelEntry[] = [
  {
    provider: "gemini",
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    hint: "Recomendado",
    status: "active",
    role: "default",
    capabilities: { vision: true, reasoning: "budget" },
    requestProfile: "gemini-2.5",
    verifiedInProduction: true,
    sameProviderFallback: "gemini-2.5-pro",
  },
  {
    provider: "gemini",
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    hint: "Mais inteligente",
    status: "active",
    role: "strong",
    capabilities: { vision: true, reasoning: "budget" },
    requestProfile: "gemini-2.5",
    verifiedInProduction: true,
    // Ele mesmo: com o Pro como principal, a resposta vazia ganha UMA
    // re-tentativa no Pro, como antes do catálogo (FALLBACK_MODELS.gemini).
    sameProviderFallback: "gemini-2.5-pro",
  },
  {
    provider: "gemini",
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    hint: "Geração nova",
    status: "active",
    role: "strong",
    capabilities: { vision: true, reasoning: "level" },
    requestProfile: "gemini-3-low",
    verifiedInProduction: false,
    sameProviderFallback: null,
  },
  {
    provider: "gemini",
    id: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    hint: "Mais barato",
    status: "active",
    role: "light",
    capabilities: { vision: true, reasoning: "level" },
    requestProfile: "gemini-3-minimal",
    verifiedInProduction: false,
    sameProviderFallback: null,
  },
  {
    provider: "claude",
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    hint: "Recomendado — rápido e barato",
    status: "active",
    role: "default",
    capabilities: { vision: true, reasoning: "adaptive" },
    requestProfile: "claude-haiku-5",
    verifiedInProduction: false,
    sameProviderFallback: null,
  },
  {
    provider: "claude",
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    hint: "Mais inteligente",
    status: "active",
    role: "strong",
    capabilities: { vision: true, reasoning: "adaptive" },
    requestProfile: "claude-sonnet-5",
    verifiedInProduction: false,
    sameProviderFallback: null,
  },
  {
    provider: "claude",
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    status: "retired",
    successor: "claude-haiku-5-5",
    role: "default",
    capabilities: { vision: true, reasoning: "budget" },
    requestProfile: "retired",
    verifiedInProduction: false,
    sameProviderFallback: null,
  },
  {
    provider: "claude",
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    status: "retired",
    successor: "claude-sonnet-5-5",
    role: "strong",
    capabilities: { vision: true, reasoning: "adaptive" },
    requestProfile: "retired",
    verifiedInProduction: false,
    sameProviderFallback: null,
  },
  {
    provider: "openai",
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    hint: "Recomendado",
    status: "active",
    role: "default",
    capabilities: { vision: true, reasoning: "level" },
    requestProfile: "openai-gpt6-tools",
    verifiedInProduction: false,
    sameProviderFallback: null,
  },
  {
    provider: "openai",
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    hint: "Mais inteligente",
    status: "active",
    role: "strong",
    capabilities: { vision: true, reasoning: "level" },
    requestProfile: "openai-gpt5-reasoning-low",
    verifiedInProduction: false,
    sameProviderFallback: null,
  },
  {
    provider: "openai",
    id: "gpt-4o",
    label: "GPT-4o",
    status: "retired",
    successor: "gpt-6-luna",
    role: "default",
    capabilities: { vision: true, reasoning: "none" },
    requestProfile: "retired",
    verifiedInProduction: false,
    sameProviderFallback: null,
  },
  {
    // Substituto oficial é o default (gpt-6-luna), então o papel é "default".
    provider: "openai",
    id: "gpt-4o-mini",
    label: "GPT-4o Mini",
    status: "retired",
    successor: "gpt-6-luna",
    role: "default",
    capabilities: { vision: true, reasoning: "none" },
    requestProfile: "retired",
    verifiedInProduction: false,
    sameProviderFallback: null,
  },
  {
    provider: "grok",
    id: "grok-4.20-0309-non-reasoning",
    label: "Grok 4.20 (sem raciocínio)",
    hint: "Recomendado",
    status: "active",
    role: "default",
    capabilities: { vision: true, reasoning: "none" },
    requestProfile: "grok-4-non-reasoning",
    verifiedInProduction: false,
    sameProviderFallback: null,
  },
  {
    provider: "grok",
    id: "grok-4.3",
    label: "Grok 4.3",
    hint: "Mais inteligente",
    status: "active",
    role: "strong",
    capabilities: { vision: true, reasoning: "level" },
    requestProfile: "grok-4-reasoning",
    verifiedInProduction: false,
    sameProviderFallback: null,
  },
  {
    provider: "grok",
    id: "grok-3",
    label: "Grok 3",
    status: "retired",
    successor: "grok-4.20-0309-non-reasoning",
    role: "default",
    capabilities: { vision: false, reasoning: "none" },
    requestProfile: "retired",
    verifiedInProduction: false,
    sameProviderFallback: null,
  },
  {
    provider: "deepseek",
    id: "deepseek-flash",
    label: "DeepSeek Flash (V4.1)",
    hint: "Recomendado",
    status: "active",
    role: "default",
    capabilities: { vision: true, reasoning: "level" },
    requestProfile: "deepseek-v4-thinking-off",
    verifiedInProduction: false,
    sameProviderFallback: null,
  },
  {
    provider: "deepseek",
    id: "deepseek-chat",
    label: "DeepSeek Chat",
    status: "retired",
    successor: "deepseek-flash",
    role: "default",
    capabilities: { vision: false, reasoning: "none" },
    requestProfile: "retired",
    verifiedInProduction: false,
    sameProviderFallback: null,
  },
];

export function getModelEntry(provider: AIProvider, id: string): AIModelEntry | undefined {
  return AI_MODEL_CATALOG.find((e) => e.provider === provider && e.id === id);
}

/** O único `default` ativo do provider (o teste do catálogo garante que existe um só). */
export function defaultModelFor(provider: AIProvider): AIModelEntry {
  const found = AI_MODEL_CATALOG.find((e) => e.provider === provider && e.status === "active" && e.role === "default");
  if (!found) throw new Error(`catalogo_sem_default:${provider}`);
  return found;
}

/** Ativos do provider: o default primeiro, os demais na ordem do catálogo. */
export function activeModelsFor(provider: AIProvider): AIModelEntry[] {
  const def = defaultModelFor(provider);
  return [
    def,
    ...AI_MODEL_CATALOG.filter((e) => e.provider === provider && e.status === "active" && e !== def),
  ];
}

export type ResolvedModel = {
  model: string;
  reason: "saved" | "default" | "retired_successor" | "unknown_default";
  /** Valor salvo que foi recusado (aposentado ou desconhecido). */
  rejected?: string;
};

/**
 * Modelo a usar dado o que está salvo na unidade. Nunca lança: valor vazio,
 * aposentado ou desconhecido sempre resolve para um modelo ativo do provider.
 * Aposentado vira o sucessor (que o teste do catálogo garante ser ativo), sem
 * seguir cadeia.
 */
export function resolveModel(provider: AIProvider, saved?: string | null): ResolvedModel {
  const trimmed = typeof saved === "string" ? saved.trim() : "";
  if (!trimmed) return { model: defaultModelFor(provider).id, reason: "default" };
  const entry = getModelEntry(provider, trimmed);
  if (entry?.status === "active") return { model: trimmed, reason: "saved" };
  if (entry?.status === "retired" && entry.successor) {
    return { model: entry.successor, reason: "retired_successor", rejected: trimmed };
  }
  return { model: defaultModelFor(provider).id, reason: "unknown_default", rejected: trimmed };
}
