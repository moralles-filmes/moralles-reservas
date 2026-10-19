export type AIProvider = "claude" | "openai" | "gemini" | "grok" | "deepseek";

export interface AIModelOption {
  value: string;
  label: string;
  hint?: string;
}

export const MODELS_BY_PROVIDER: Record<AIProvider, AIModelOption[]> = {
  claude: [
    { value: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "Recomendado — rápido e barato" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "Mais inteligente" },
  ],
  openai: [
    { value: "gpt-4o", label: "GPT-4o", hint: "Recomendado" },
    { value: "gpt-4o-mini", label: "GPT-4o Mini", hint: "Mais barato" },
  ],
  gemini: [
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "Recomendado" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", hint: "Mais inteligente" },
  ],
  grok: [
    { value: "grok-3", label: "Grok 3", hint: "Recomendado" },
  ],
  deepseek: [
    { value: "deepseek-chat", label: "DeepSeek Chat", hint: "Recomendado" },
  ],
};

export const DEFAULT_MODEL_BY_PROVIDER: Record<AIProvider, string> = {
  claude: "claude-haiku-4-5",
  openai: "gpt-4o",
  gemini: "gemini-2.5-flash",
  grok: "grok-3",
  deepseek: "deepseek-chat",
};

/** Ordem canônica dos provedores na UI (seletores e listas). */
export const AI_PROVIDER_ORDER: readonly AIProvider[] = [
  "claude",
  "openai",
  "gemini",
  "grok",
  "deepseek",
];
