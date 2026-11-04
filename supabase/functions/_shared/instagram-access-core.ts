/**
 * Decisão de acesso do `instagram-connect` (Task 2.4, contratos C1/C2).
 *
 * Módulo puro (sem runtime nem import remoto): o Vitest importa direto.
 *
 * - Operador e não membro são sempre negados, em toda ação.
 * - `platform_admin` vale como owner em qualquer unidade (paralelo obrigatório
 *   do guard por `unit_id`, AGENTS.md §8).
 * - `start`, `callback` e `resubscribe` exigem o grant ativo do módulo
 *   (`unit_module_grants`, `module = 'instagram'`, `revoked_at is null`),
 *   inclusive para `platform_admin`. `status` e `disconnect` não: desconectar
 *   tem de funcionar depois da revogação do módulo.
 * - O papel é conferido antes do grant: quem não tem papel recebe `deny_role`
 *   e nunca descobre se a unidade tem o módulo.
 * - Valor inesperado em runtime (ação ou papel fora do contrato) falha fechado.
 *
 * O chamador lê papel, admin e grant; erro de leitura é 503 lá, nunca chega
 * aqui como "permitido".
 */

export const INSTAGRAM_CONNECT_ACTIONS = ["start", "callback", "status", "disconnect", "resubscribe"] as const;
export type InstagramConnectAction = (typeof INSTAGRAM_CONNECT_ACTIONS)[number];

export type InstagramAccessDecision = "allow" | "deny_role" | "deny_grant";

const GRANT_REQUIRED: ReadonlySet<string> = new Set(["start", "callback", "resubscribe"]);
const KNOWN_ACTIONS: ReadonlySet<string> = new Set(INSTAGRAM_CONNECT_ACTIONS);

export function isInstagramConnectAction(v: unknown): v is InstagramConnectAction {
  return typeof v === "string" && KNOWN_ACTIONS.has(v);
}

export function instagramActionRequiresGrant(action: InstagramConnectAction): boolean {
  return GRANT_REQUIRED.has(action);
}

export function decideInstagramAccess(i: {
  action: InstagramConnectAction;
  isPlatformAdmin: boolean;
  role: "owner" | "gerente" | "operador" | null;
  grantActive: boolean;
}): InstagramAccessDecision {
  if (!isInstagramConnectAction(i.action)) return "deny_role";
  const roleOk = i.isPlatformAdmin === true || i.role === "owner" || i.role === "gerente";
  if (!roleOk) return "deny_role";
  if (GRANT_REQUIRED.has(i.action) && i.grantActive !== true) return "deny_grant";
  return "allow";
}

/**
 * `42501` do `store_…` pode ser papel/grant (403) ou divergência do cofre
 * (`instagram_account_secret_mismatch`, falha do servidor: 503). Só roteia; o
 * texto do Postgres nunca é devolvido nem registrado.
 */
export function isSecretMismatchError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as Record<string, unknown>)["message"] === "instagram_account_secret_mismatch";
}
