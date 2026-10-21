import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { normalizeNewlines } from "@/lib/text-normalize";
import { GLOBAL_PROMPT_SLOT } from "../../supabase/functions/_shared/agent/global-prompt-core";

/** Prefixo comum: invalidar este prefixo cobre o slot e a lista. */
export const AI_PROMPT_QUERY_KEY = ["ai-prompt"] as const;

export const AI_PROMPT_PAGE_SIZE = 50;

// Sem `body_sha256`: a tela não usa. O corpo vem junto porque "Ver diff" e
// "Restaurar" comparam contra ele (4000 caracteres × 50 por página).
const VERSION_COLUMNS = "id, slot, version, body, note, created_at, created_by";

export interface AiPromptVersion {
  id: string;
  slot: string;
  version: number;
  body: string;
  note: string;
  created_at: string;
  /** `null` na versão 1 (seed do sistema). */
  created_by: string | null;
}

export interface AiPromptSlotState {
  activeVersionId: string;
  activatedAt: string;
  activatedBy: string | null;
  active: AiPromptVersion;
}

/**
 * Versão ativa do slot global (id, quando/quem ativou e a linha da versão).
 * Slot ausente (antes do `db push`) devolve `null`; erro de leitura é `isError`.
 */
export function useAiPromptSlot() {
  return useQuery({
    queryKey: [...AI_PROMPT_QUERY_KEY, "slot"],
    queryFn: async (): Promise<AiPromptSlotState | null> => {
      const { data: slot, error } = await supabase
        .from("ai_prompt_slots")
        .select("slot, active_version_id, activated_at, activated_by")
        .eq("slot", GLOBAL_PROMPT_SLOT)
        .maybeSingle();
      if (error) throw error;
      if (!slot) return null;
      const { data: active, error: versionError } = await supabase
        .from("ai_prompt_versions")
        .select(VERSION_COLUMNS)
        .eq("slot", GLOBAL_PROMPT_SLOT)
        .eq("id", slot.active_version_id)
        .maybeSingle();
      if (versionError) throw versionError;
      if (!active) throw new Error("ai_prompt_active_version_missing");
      return {
        activeVersionId: slot.active_version_id as string,
        activatedAt: slot.activated_at as string,
        activatedBy: (slot.activated_by as string | null) ?? null,
        active: active as AiPromptVersion,
      };
    },
  });
}

/** Histórico paginado (50 por vez, da versão maior para a menor). */
export function useAiPromptVersionList() {
  return useInfiniteQuery({
    queryKey: [...AI_PROMPT_QUERY_KEY, "versions"],
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<AiPromptVersion[]> => {
      const { data, error } = await supabase
        .from("ai_prompt_versions")
        .select(VERSION_COLUMNS)
        .eq("slot", GLOBAL_PROMPT_SLOT)
        .order("version", { ascending: false })
        .range(pageParam, pageParam + AI_PROMPT_PAGE_SIZE - 1);
      if (error) throw error;
      return (data ?? []) as AiPromptVersion[];
    },
    // Página cheia: pode haver mais; incompleta: acabou.
    getNextPageParam: (lastPage, _pages, lastPageParam) =>
      lastPage.length === AI_PROMPT_PAGE_SIZE ? lastPageParam + AI_PROMPT_PAGE_SIZE : undefined,
  });
}

function useInvalidateOnWrite() {
  const queryClient = useQueryClient();
  return {
    onSuccess: () => queryClient.invalidateQueries({ queryKey: AI_PROMPT_QUERY_KEY }),
    // 40001: outra pessoa mudou a ativa; recarregar para a tela ver a nova.
    onError: (error: unknown) => {
      if ((error as { code?: unknown } | null)?.code === "40001") {
        return queryClient.invalidateQueries({ queryKey: AI_PROMPT_QUERY_KEY });
      }
    },
  };
}

export interface PublishAiPromptInput {
  body: string;
  note: string;
  /** Id da versão ativa lida pela tela: a RPC recusa (`40001`) se mudou. */
  expectedActiveVersionId: string;
}

/** Publica uma versão nova. Escrita só pela RPC; lança o objeto do PostgREST (decida por `code`). */
export function usePublishAiPromptVersion() {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: async ({ body, note, expectedActiveVersionId }: PublishAiPromptInput) => {
      const { data, error } = await supabase.rpc("publish_ai_prompt_version", {
        p_slot: GLOBAL_PROMPT_SLOT,
        p_body: normalizeNewlines(body),
        p_note: note,
        p_expected_active_version_id: expectedActiveVersionId,
      });
      if (error) throw error;
      return data as string;
    },
    ...invalidate,
  });
}

export interface ActivateAiPromptInput {
  versionId: string;
  expectedActiveVersionId: string;
  note: string;
}

/** Restaura uma versão antiga (a RPC recusa a já ativa). */
export function useActivateAiPromptVersion() {
  const invalidate = useInvalidateOnWrite();
  return useMutation({
    mutationFn: async ({ versionId, expectedActiveVersionId, note }: ActivateAiPromptInput) => {
      const { error } = await supabase.rpc("activate_ai_prompt_version", {
        p_slot: GLOBAL_PROMPT_SLOT,
        p_version_id: versionId,
        p_expected_active_version_id: expectedActiveVersionId,
        p_note: note,
      });
      if (error) throw error;
    },
    ...invalidate,
  });
}
