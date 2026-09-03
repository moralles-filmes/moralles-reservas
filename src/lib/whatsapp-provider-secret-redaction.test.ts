import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { redactProviderFetchError } from "../../supabase/functions/_shared/provider-error-redaction-core.ts";

/**
 * A Z-API é o único provider que carrega credencial NO PATH da URL
 * (`/instances/<id>/token/<token>/status`); os outros usam header. Quando o
 * `fetch` do Deno falha, a mensagem do `TypeError` inclui a URL inteira — e os
 * dois consumidores da consulta de status (a guarda de envio em
 * `whatsapp-send.ts` e o worker `process-whatsapp-channel-health`, que roda
 * 288x/dia por canal) registram `String(error)` em log.
 *
 * Nenhum scanner de secret pega isso: o token é hex de 32 sem prefixo, dentro
 * de uma URL. Este teste é o guardrail real.
 */

const INSTANCE_ID = "3ABCDEF0123456789";
const TOKEN = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const URL_COM_SEGREDO = `https://api.z-api.io/instances/${INSTANCE_ID}/token/${TOKEN}/status`;

/** Reproduz a forma exata do erro do fetch do Deno, com a URL embutida. */
function erroDeRedeDoDeno(url: string): TypeError {
  return new TypeError(`error sending request for url (${url}): connection closed`);
}

describe("redactProviderFetchError", () => {
  it("CONTROLE POSITIVO: o erro de origem realmente contém a credencial", () => {
    // Sem este assert, os testes abaixo poderiam passar por vacuidade — se o
    // cenário montado não reproduzisse o vazamento, a redação não estaria
    // sendo exercida contra nada.
    const original = String(erroDeRedeDoDeno(URL_COM_SEGREDO));
    expect(original).toContain(TOKEN);
    expect(original).toContain(INSTANCE_ID);
  });

  it("descarta token, instance_id e host do erro de rede", () => {
    const redacted = String(redactProviderFetchError(erroDeRedeDoDeno(URL_COM_SEGREDO)));
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).not.toContain(INSTANCE_ID);
    expect(redacted).not.toContain("z-api.io");
    expect(redacted).toContain("connection_status_fetch_failed");
  });

  it("timeout continua distinguível de falha de rede", () => {
    const abort = new Error("The signal has been aborted");
    abort.name = "AbortError";
    expect(String(redactProviderFetchError(abort))).toContain("timeout");
    expect(String(redactProviderFetchError(erroDeRedeDoDeno(URL_COM_SEGREDO))))
      .toContain("TypeError");
  });

  it("erro que não é Error não quebra nem vaza o que carregava", () => {
    expect(String(redactProviderFetchError(URL_COM_SEGREDO))).not.toContain(TOKEN);
    expect(String(redactProviderFetchError(null))).toContain("unknown");
  });
});

describe("acoplamento: fetchConnectionStatus usa a redação", () => {
  // O teste acima prova que a função redige. Este prova que ela é CHAMADA no
  // ponto que importa — sem ele, alguém remove o try/catch de
  // `fetchConnectionStatus` e a suíte inteira continua verde.
  //
  // Verificação estática porque `whatsapp-providers.ts` usa `Deno`, que o
  // `tsc -b` do frontend não conhece: importá-lo aqui quebraria o typecheck.
  const source = readFileSync(
    resolve(__dirname, "../../supabase/functions/_shared/whatsapp-providers.ts"),
    "utf8",
  );

  it("importa o núcleo de redação", () => {
    expect(source).toMatch(
      /import\s*\{\s*redactProviderFetchError\s*\}\s*from\s*"\.\/provider-error-redaction-core\.ts"/,
    );
  });

  it("o catch de fetchConnectionStatus relança pela redação, não o erro cru", () => {
    const fn = source.slice(
      source.indexOf("async function fetchConnectionStatus"),
      source.indexOf("async function fetchSafeWahaQrJson"),
    );
    expect(fn).toContain("throw redactProviderFetchError(error)");
    // O erro original não pode escapar por nenhuma outra porta deste bloco.
    expect(fn).not.toMatch(/throw\s+error\b/);
  });

  it("a URL da Z-API com credencial no path só é montada dentro de fetchConnectionStatus", () => {
    // Se algum caminho novo passar a montar essa URL com um fetch próprio, ele
    // fica fora da redação — e este assert é o que obriga a revisitar.
    const ocorrencias = source.match(/api\.z-api\.io\/instances\/\$\{instance_id\}\/token\//g) ?? [];
    expect(ocorrencias.length).toBe(1);
  });
});
