// CORS compartilhado para Edge Functions de management (manage-*).
// Para webhooks que recebem requests de provedores externos (Z-API/WAHA/Meta)
// continuamos usando "*" — esses endpoints já são protegidos por
// validateChannelSecret e o atacante não tem o JWT do user.
//
// Para manage-* / send-* invocadas pelo frontend autenticado, ecoamos a
// origin apenas se ela bater com a whitelist (defense-in-depth: o JWT já
// protege, isso só impede que um site terceiro malicioso execute fetches
// contra a Edge Function via browser do usuário logado).

const ALLOWED_ORIGINS: RegExp[] = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https:\/\/reservas\.moralles\.com\.br$/,
  /^https:\/\/[a-z0-9-]+\.vercel\.app$/,
];

const STATIC_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

export function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const isAllowed = origin && ALLOWED_ORIGINS.some((rx) => rx.test(origin));
  return {
    ...STATIC_HEADERS,
    // "null" faz o browser bloquear a resposta sem credentials, em vez de
    // ecoar uma origin não-confiável.
    "Access-Control-Allow-Origin": isAllowed ? origin : "null",
  };
}
