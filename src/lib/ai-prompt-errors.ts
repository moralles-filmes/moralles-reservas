import {
  GLOBAL_PROMPT_MAX_CHARS,
  GLOBAL_PROMPT_NOTE_MAX_CHARS,
  GLOBAL_PROMPT_PLACEHOLDERS,
} from "../../supabase/functions/_shared/agent/global-prompt-core";

const GENERIC = "Não foi possível concluir. Tente novamente.";
const PLACEHOLDERS = GLOBAL_PROMPT_PLACEHOLDERS.map((p) => `{{${p}}}`).join(" e ");

const BODY_INVALID = `Texto inválido: até ${GLOBAL_PROMPT_MAX_CHARS} caracteres, só ${PLACEHOLDERS}, sem <<< ou >>> e sem caracteres de controle.`;
const NOTE_INVALID = `Motivo inválido: escreva de 1 a ${GLOBAL_PROMPT_NOTE_MAX_CHARS} caracteres.`;

/**
 * Cópia para o admin de um erro das RPCs do prompt global. Decide por
 * `error.code` do PostgREST (o `40001` chega como HTTP 500, então o status
 * não serve); o token da mensagem só escolhe a cópia dentro de `22023`.
 * `error.message` nunca vai para a tela.
 */
export function promptErrorMessage(error: unknown): string {
  if (typeof error !== "object" || error === null) return GENERIC;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === "42501") return "Sem permissão.";
  if (code === "40001") return "A versão ativa mudou. Revise as mudanças e confirme de novo.";
  if (code === "22023") {
    if (message === "prompt_note_invalid") return NOTE_INVALID;
    if (message === "prompt_version_invalid") return "Versão inválida ou já ativa.";
    return BODY_INVALID;
  }
  return GENERIC;
}
