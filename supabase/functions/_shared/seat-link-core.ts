// Token do link de escolha de mesa enviado pelo agente no WhatsApp.
// O banco guarda só o SHA-256 hex (seat_choice_links.token_hash); o token em
// claro existe apenas na URL /mesa/:token.

/** Validade do link (a tabela aceita no máximo 24 h). */
export const SEAT_LINK_TTL_HOURS = 6;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** 32 bytes aleatórios em base64url sem padding (43 caracteres). */
export function createSeatLinkToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isSeatLinkToken(s: string): boolean {
  return typeof s === "string" && TOKEN_RE.test(s);
}

/** SHA-256 hex (64 caracteres minúsculos), o formato de token_hash. */
export async function hashSeatLinkToken(t: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
