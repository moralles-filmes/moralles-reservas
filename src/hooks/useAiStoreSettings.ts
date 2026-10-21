import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchSettingRows, upsertSettingRows } from "@/features/ai-store/api";
import { AI_STORE_SETTING_KEYS, type AiStoreSettingKey } from "@/lib/ai-store-settings";
import { isValidStoreText, settingsNotWrittenError } from "@/lib/store-text";
import { normalizeNewlines } from "@/lib/text-normalize";
import { AGENT_MODES } from "../../supabase/functions/_shared/agent/global-prompt-core";

export type AiStoreTexts = Record<AiStoreSettingKey, string>;
export type AgentMode = (typeof AGENT_MODES)[number];

export interface AiStoreSettings {
  texts: AiStoreTexts;
  /** Só para exibir o modo; a Gestão não grava `agent_mode` (é da plataforma). */
  agentMode: AgentMode;
}

function asText(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

function asAgentMode(raw: unknown): AgentMode {
  return (AGENT_MODES as readonly unknown[]).includes(raw) ? (raw as AgentMode) : "reservations";
}

/** Textos factuais da loja que o agente usa no modo reservas + dúvidas, mais o modo atual. */
export function useAiStoreSettings(unitId: string) {
  return useQuery({
    queryKey: ["settings", unitId, "ai-store"],
    queryFn: async (): Promise<AiStoreSettings> => {
      const rows = await fetchSettingRows(unitId, [...AI_STORE_SETTING_KEYS, "agent_mode"]);
      const map = Object.fromEntries(rows.map((s) => [s.key, s.value]));
      return {
        texts: Object.fromEntries(AI_STORE_SETTING_KEYS.map((k) => [k, asText(map[k])])) as AiStoreTexts,
        agentMode: asAgentMode(map.agent_mode),
      };
    },
    enabled: !!unitId,
  });
}

/**
 * Grava as 3 chaves num `upsert` só. O erro do PostgREST é relançado como está
 * (a tela decide a cópia por `error.code`); texto inválido nem sai do navegador
 * (`22023`, o mesmo código do guard de valor do banco).
 */
export function useSaveAiStoreSettings(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (texts: AiStoreTexts) => {
      if (!unitId) throw new Error("Unidade não carregada.");
      const rows = AI_STORE_SETTING_KEYS.map((key) => ({ unit_id: unitId, key, value: normalizeNewlines(texts[key]) }));
      if (rows.some((r) => !isValidStoreText(r.key, r.value))) {
        throw Object.assign(new Error("setting_value_invalid"), { code: "22023" });
      }
      const saved = await upsertSettingRows(rows);
      // UPDATE que casa zero linhas volta `error: null`: sem conferir o tamanho, "salvou" mentiria.
      if (saved.length !== rows.length) throw settingsNotWrittenError();
    },
    // Devolve a promessa: o `onSuccess` da tela só roda depois da releitura, sem piscar o valor antigo.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", unitId] }),
  });
}
