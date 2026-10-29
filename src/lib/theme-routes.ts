/**
 * Rotas públicas e de login: sempre no tema Dia, independente da escolha salva.
 * O restante (painéis) pode usar a escolha do usuário (padrão Noite).
 */
const LIGHT_PREFIXES = ["/r/", "/w/", "/m/", "/acompanhar/", "/preferencias/"] as const;

const LIGHT_EXACT = new Set<string>(["/", "/admin/login", "/reset-password"]);

export function isLightOnlyRoute(pathname: string): boolean {
  if (LIGHT_EXACT.has(pathname)) return true;
  return LIGHT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
