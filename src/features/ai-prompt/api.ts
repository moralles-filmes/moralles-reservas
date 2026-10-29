import { supabase } from "@/lib/supabase";
import { normalizeNewlines } from "@/lib/text-normalize";
import { GLOBAL_PROMPT_SLOT } from "../../../supabase/functions/_shared/agent/global-prompt-core";

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
 * Slot ausente (antes do `db push`) devolve `null`. O erro do PostgREST sobe como está.
 */
export async function fetchAiPromptSlot(): Promise<AiPromptSlotState | null> {
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
}

/**
 * Uma página do histórico (50, da versão maior para a menor), sempre com
 * `.range(0, 49)`. Keyset: `beforeVersion` lê `version < beforeVersion`, então
 * uma publicação no meio não desloca o que já foi carregado (offset repetiria
 * linha). `null` = primeira página.
 */
export async function fetchAiPromptVersionPage(beforeVersion: number | null): Promise<AiPromptVersion[]> {
  let query = supabase
    .from("ai_prompt_versions")
    .select(VERSION_COLUMNS)
    .eq("slot", GLOBAL_PROMPT_SLOT)
    .order("version", { ascending: false });
  if (beforeVersion !== null) query = query.lt("version", beforeVersion);
  const { data, error } = await query.range(0, AI_PROMPT_PAGE_SIZE - 1);
  if (error) throw error;
  return (data ?? []) as AiPromptVersion[];
}

export interface PublishAiPromptInput {
  body: string;
  note: string;
  /** Id da versão ativa em que o rascunho se baseou: a RPC recusa (`40001`) se mudou. */
  expectedActiveVersionId: string;
}

/** Publica uma versão nova. Escrita só pela RPC; o erro do PostgREST sobe como está (decida por `code`). */
export async function publishAiPromptVersion({ body, note, expectedActiveVersionId }: PublishAiPromptInput) {
  const { data, error } = await supabase.rpc("publish_ai_prompt_version", {
    p_slot: GLOBAL_PROMPT_SLOT,
    p_body: normalizeNewlines(body),
    p_note: note,
    p_expected_active_version_id: expectedActiveVersionId,
  });
  if (error) throw error;
  return data as string;
}

export interface ActivateAiPromptInput {
  versionId: string;
  expectedActiveVersionId: string;
  note: string;
}

/** Restaura uma versão antiga (a RPC recusa a já ativa). Só por RPC; o erro sobe como está. */
export async function activateAiPromptVersion({ versionId, expectedActiveVersionId, note }: ActivateAiPromptInput) {
  const { error } = await supabase.rpc("activate_ai_prompt_version", {
    p_slot: GLOBAL_PROMPT_SLOT,
    p_version_id: versionId,
    p_expected_active_version_id: expectedActiveVersionId,
    p_note: note,
  });
  if (error) throw error;
}
