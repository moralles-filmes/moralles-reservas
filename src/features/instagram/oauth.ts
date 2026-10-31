/**
 * Guarda do `state` do OAuth do Instagram (R2-d: a EF não tem nonce store).
 * O state vai para o sessionStorage antes do redirecionamento e é comparado e
 * apagado no retorno. Todo acesso ao storage é protegido: pode lançar.
 */
export const INSTAGRAM_OAUTH_STATE_KEY = "instagram-oauth-state";

export function saveOauthState(state: string): boolean {
  try {
    sessionStorage.setItem(INSTAGRAM_OAUTH_STATE_KEY, state);
    return true;
  } catch {
    return false;
  }
}

/** Lê e apaga o state guardado. Devolve null se não houver (ou storage indisponível). */
export function takeOauthState(): string | null {
  try {
    const value = sessionStorage.getItem(INSTAGRAM_OAUTH_STATE_KEY);
    sessionStorage.removeItem(INSTAGRAM_OAUTH_STATE_KEY);
    return value;
  } catch {
    return null;
  }
}

/** Só redireciona para https; separado para os testes substituírem. */
export function redirectToAuthorize(url: string): boolean {
  if (!/^https:\/\//i.test(url)) return false;
  window.location.assign(url);
  return true;
}
