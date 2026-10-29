/**
 * Rotas públicas e de login: sempre no tema Dia, independente da escolha salva.
 * O restante (painéis) pode usar a escolha do usuário (padrão Noite).
 * O script anti-flash do index.html repete esta lista; theme-routes.test.ts
 * confere que os dois concordam.
 */
const LIGHT_PREFIXES = ["/r/", "/w/", "/m/", "/acompanhar/", "/preferencias/"] as const;

const LIGHT_EXACT = new Set<string>(["/", "/admin/login", "/reset-password"]);

export function isLightOnlyRoute(pathname: string): boolean {
  // O React Router casa rotas sem diferenciar maiúsculas e aceita barra final.
  const path = pathname.toLowerCase().replace(/\/+$/, "") || "/";
  if (LIGHT_EXACT.has(path)) return true;
  return LIGHT_PREFIXES.some((prefix) => `${path}/`.startsWith(prefix));
}
