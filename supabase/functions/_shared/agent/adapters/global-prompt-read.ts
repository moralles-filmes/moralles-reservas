/**
 * Adapter de banco da camada global do prompt: a única leitura de
 * `ai_prompt_slots`/`ai_prompt_versions` do agente (GCP_MIGRATION §6). Devolve
 * o resultado cru para o núcleo decidir; nunca lança.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GLOBAL_PROMPT_SLOT, type GlobalPromptRead } from "../global-prompt-core.ts";

/** Slot → versão ativa, filtrando também a versão pelo slot. Sem id de escopo do caller. */
export async function readActiveGlobalPrompt(supabase: SupabaseClient): Promise<GlobalPromptRead> {
  try {
    const { data: slot, error: slotError } = await supabase
      .from("ai_prompt_slots")
      .select("active_version_id")
      .eq("slot", GLOBAL_PROMPT_SLOT)
      .maybeSingle();
    if (slotError) return { ok: false, reason: "slot_read_error", code: slotError.code ?? null };
    const activeId = (slot as { active_version_id?: unknown } | null)?.active_version_id;
    if (typeof activeId !== "string") return { ok: false, reason: "slot_missing" };

    const { data: version, error: versionError } = await supabase
      .from("ai_prompt_versions")
      .select("id, body")
      .eq("slot", GLOBAL_PROMPT_SLOT)
      .eq("id", activeId)
      .maybeSingle();
    if (versionError) return { ok: false, reason: "version_read_error", code: versionError.code ?? null };
    if (!version) return { ok: false, reason: "version_missing" };
    const row = version as { id?: unknown; body?: unknown };
    return { ok: true, versionId: row.id, body: row.body };
  } catch {
    return { ok: false, reason: "read_threw" };
  }
}
