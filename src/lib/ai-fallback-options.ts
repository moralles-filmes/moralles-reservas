import { AI_PROVIDER_ORDER, type AIProvider } from "@/lib/aiModels";

/**
 * Provedores elegíveis como reserva: os que têm chave salva (e ativa — quem
 * chama filtra `active`, pois o backend só resolve `active=true`) e que não
 * são o principal. Ordem canônica de `AI_PROVIDER_ORDER`; strings
 * desconhecidas e duplicadas são ignoradas.
 */
export function fallbackProviderOptions(
  savedKeyProviders: readonly string[],
  primary: AIProvider,
): AIProvider[] {
  const saved = new Set(savedKeyProviders);
  return AI_PROVIDER_ORDER.filter((p) => p !== primary && saved.has(p));
}
