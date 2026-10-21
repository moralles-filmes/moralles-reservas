import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AI_PROMPT_PAGE_SIZE,
  activateAiPromptVersion,
  fetchAiPromptSlot,
  fetchAiPromptVersionPage,
  publishAiPromptVersion,
  type AiPromptSlotState,
  type AiPromptVersion,
} from "@/features/ai-prompt/api";

export type { AiPromptSlotState, AiPromptVersion };

/** Prefixo comum: invalidar este prefixo cobre o slot e a lista. */
export const AI_PROMPT_QUERY_KEY = ["ai-prompt"] as const;

/** Versão ativa do slot global. Slot ausente (antes do `db push`) vem `null`; erro de leitura é `isError`. */
export function useAiPromptSlot() {
  return useQuery({
    queryKey: [...AI_PROMPT_QUERY_KEY, "slot"],
    queryFn: fetchAiPromptSlot,
  });
}

/** Histórico paginado (50 por vez, da versão maior para a menor), por keyset na última `version`. */
export function useAiPromptVersionList() {
  return useInfiniteQuery({
    queryKey: [...AI_PROMPT_QUERY_KEY, "versions"],
    // `null` = primeira página; depois, a última `version` da página anterior.
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => fetchAiPromptVersionPage(pageParam),
    // Página cheia: pode haver mais; incompleta: acabou.
    getNextPageParam: (lastPage) =>
      lastPage.length === AI_PROMPT_PAGE_SIZE ? lastPage[lastPage.length - 1].version : undefined,
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

/** Publica uma versão nova. Lança o objeto do PostgREST (decida por `code`). */
export function usePublishAiPromptVersion() {
  const invalidate = useInvalidateOnWrite();
  return useMutation({ mutationFn: publishAiPromptVersion, ...invalidate });
}

/** Restaura uma versão antiga (a RPC recusa a já ativa). */
export function useActivateAiPromptVersion() {
  const invalidate = useInvalidateOnWrite();
  return useMutation({ mutationFn: activateAiPromptVersion, ...invalidate });
}
