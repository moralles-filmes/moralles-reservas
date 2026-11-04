/** Mensagem do backend (PT-BR) só quando vem de InstagramApiError; nunca texto técnico cru. */
export function actionError(error: unknown, fallback: string): string {
  const name = (error as { name?: string } | null)?.name;
  const message = error instanceof Error ? error.message : "";
  return name === "InstagramApiError" && message ? message : fallback;
}
