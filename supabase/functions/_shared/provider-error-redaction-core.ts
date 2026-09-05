// supabase/functions/_shared/provider-error-redaction-core.ts
/**
 * Redação de erro de transporte para providers que carregam credencial na URL.
 *
 * A Z-API é o único assim — `https://api.z-api.io/instances/<id>/token/<token>/status`;
 * WAHA usa `X-Api-Key`, UazAPI usa `token` em header, Meta usa `Authorization`.
 * Quando o `fetch` do Deno falha, a mensagem do `TypeError` embute a URL
 * inteira: `error sending request for url (https://.../token/<TOKEN>/status)`.
 * Qualquer caller que registre `String(error)` publica a credencial no log —
 * e o worker `process-whatsapp-channel-health` faria isso 288 vezes por dia
 * por canal durante uma indisponibilidade do provedor.
 *
 * Nenhum scanner de secret pega essa forma: token da Z-API é hex de 32 sem
 * prefixo reconhecível, dentro de uma URL. O guardrail é o teste, não o grep.
 *
 * Núcleo PURO e em arquivo próprio por dois motivos: `whatsapp-providers.ts`
 * usa `Deno`, que o `tsc -b` do frontend não conhece — importá-lo de um teste
 * quebra o typecheck; e a decisão de "o que sobra do erro" merece ser testada
 * sozinha, com controle positivo.
 */

/**
 * Descarta a mensagem original inteira e conserva só a CLASSE da falha.
 *
 * Descartar tudo é deliberado: uma redação por regex (`/token/[^/]+` → `***`)
 * depende de o provedor manter o formato da URL, e a próxima rota com
 * credencial em query string passaria intacta. O que o diagnóstico realmente
 * usa é "foi timeout ou foi rede?", e isso o nome do erro já responde.
 */
export function redactProviderFetchError(error: unknown): Error {
  const kind = isAbortError(error)
    ? "timeout"
    : error instanceof Error && error.name
      ? error.name
      : "unknown";
  return new Error(`connection_status_fetch_failed:${kind}`);
}

/**
 * `DOMException` com `name === "AbortError"` é como o Deno sinaliza o
 * `AbortController` do timeout. Checado por `name`, não por `instanceof
 * DOMException` isolado, porque runtimes diferentes (Deno, Node do vitest)
 * constroem o objeto de forma diferente e o `name` é o que os dois preservam.
 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
