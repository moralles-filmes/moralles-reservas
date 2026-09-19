/**
 * Guardrail ESTÁTICO do guard de autorização das Edge Functions.
 *
 * Um tema, um arquivo: *o guard de unidade não pode voltar a ser uma RPC*. Desde
 * a migration 106 os helpers `is_unit_member`/`is_platform_admin`/`is_org_member`
 * vivem em `app_private`, schema que o PostgREST não expõe — uma chamada
 * `supabase.rpc("is_unit_member", …)` que reapareça responde 404 e o `!data`
 * seguinte lê isso como "não é membro". Falha fechada, mas 403 para TODO MUNDO,
 * inclusive o dono da loja.
 *
 * POR QUE TEXTUAL. Os `index.ts` importam `deno.land`/`esm.sh` e chamam `serve()`
 * no carregamento, então o vitest não consegue importá-los — mesma razão
 * registrada em `whatsapp-instance-ef-write-guard.test.ts`.
 *
 * O QUE ISTO NÃO É. Não é "a autorização foi exercitada". É a afirmação estreita
 * de que o padrão removido não volta sem teste vermelho.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const FUNCTIONS_DIR = resolve(process.cwd(), "supabase", "functions");

/** Todos os index.ts de Edge Function, mais os arquivos de `_shared/`. */
function fontesDeEdgeFunction(): string[] {
  const out: string[] = [];
  for (const entrada of readdirSync(FUNCTIONS_DIR)) {
    const caminho = join(FUNCTIONS_DIR, entrada);
    if (!statSync(caminho).isDirectory()) continue;
    if (entrada === "_shared") {
      for (const arquivo of readdirSync(caminho)) {
        if (arquivo.endsWith(".ts")) out.push(join(caminho, arquivo));
      }
      continue;
    }
    const index = join(caminho, "index.ts");
    try {
      if (statSync(index).isFile()) out.push(index);
    } catch {
      // Diretório sem index.ts não é Edge Function.
    }
  }
  return out;
}

const HELPERS_PRIVADOS = ["is_unit_member", "is_platform_admin", "is_org_member"];

describe("guard de unidade nas Edge Functions", () => {
  const fontes = fontesDeEdgeFunction();

  it("encontra Edge Functions para auditar", () => {
    // Zero arquivos passaria vacuamente em tudo abaixo.
    expect(fontes.length).toBeGreaterThan(10);
  });

  it.each(HELPERS_PRIVADOS)(
    "nenhuma Edge Function chama %s como RPC — o helper vive em app_private",
    (helper) => {
      const padrao = new RegExp(`rpc\\(\\s*["']${helper}["']`);
      const culpados = fontes.filter((f) => padrao.test(readFileSync(f, "utf8")));
      expect(
        culpados,
        `use hasUnitAccess() de _shared/authz.ts em vez de rpc("${helper}")`,
      ).toEqual([]);
    },
  );

  it("as 4 Edge Functions com guard de unidade importam o helper compartilhado", () => {
    const comGuard = [
      "create-manual-reservation",
      "update-reservation",
      "send-cancellation",
      "send-manual-message",
    ];
    for (const nome of comGuard) {
      const src = readFileSync(join(FUNCTIONS_DIR, nome, "index.ts"), "utf8");
      expect(src, `${nome} deveria importar hasUnitAccess`).toContain(
        "hasUnitAccess",
      );
    }
  });
});
