/**
 * Guardrail ESTÁTICO das DUAS portas do limite de conexões de WhatsApp:
 * `manage-whatsapp-instances` (inventário — onde o custo entra) e
 * `manage-channels` (canal — onde o envio se habilita).
 *
 * Verificar só uma deixa a outra aberta, e é exatamente esse o modo de falha:
 * as duas EFs não compartilham nenhum arquivo além dos núcleos puros, então
 * nada além deste teste percebe se uma delas parar de perguntar.
 *
 * TEXTUAL de propósito: os `index.ts` importam `deno.land` / `esm.sh` e chamam
 * `serve()` no carregamento, então o vitest não consegue importá-los. Junto com
 * o `npx eslint supabase/functions`, é a única cobertura automatizada deles.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PORTAS = [
  "supabase/functions/manage-whatsapp-instances/index.ts",
  "supabase/functions/manage-channels/index.ts",
] as const;

const ler = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

/**
 * Vocabulário de recusa lido do PRÓPRIO núcleo — nunca redigitado aqui. Uma
 * lista paralela envelheceria em silêncio, que é o defeito que este arquivo
 * existe para impedir.
 */
function motivosDeRecusa(): string[] {
  const nucleo = ler("supabase/functions/_shared/whatsapp-connection-allowance-core.ts");
  const bloco = nucleo.split(/reasonCode:/)[1];
  expect(bloco).toBeTruthy();
  const motivos = [...bloco.split(/\n\s*};/)[0].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  // Sanidade: se o formato do núcleo mudar, o teste não pode virar no-op.
  expect(motivos).toContain("CONNECTION_LIMIT_REACHED");
  expect(motivos).toContain("NO_FUNDING_SOURCE");
  expect(motivos).toHaveLength(6);
  return motivos;
}

describe("allowance de conexão é verificado nas DUAS portas", () => {
  for (const arquivo of PORTAS) {
    describe(arquivo, () => {
      const src = ler(arquivo);

      it("importa e CHAMA checkConnectionAllowance", () => {
        expect(src).toMatch(/whatsapp-connection-allowance-core\.ts/);
        expect(src).toMatch(/checkConnectionAllowance\s*\(/);
      });

      it("deriva a fonte de financiamento pelo resolvedor compartilhado", () => {
        // Uma query nova com regra própria aqui faria o gate de envio e esta
        // guarda discordarem sobre quem tem contrato, sobre a mesma linha.
        expect(src).toMatch(/whatsapp-subscription-resolver-core\.ts/);
        expect(src).toMatch(/resolveWhatsAppSubscription\s*\(/);
      });

      it("não resolve a assinatura financeira com maybeSingle", () => {
        // maybeSingle LANÇA com duas linhas — e a transição produz duas.
        for (const linha of src.split(/\n/).filter((l) => /maybeSingle/.test(l))) {
          expect(linha).not.toMatch(/billing_subscriptions/);
        }
      });

      it("não reimplementa a precedência de status nem a política do allowance", () => {
        expect(src).not.toMatch(/STATUS_RANK/);
        expect(src).not.toMatch(/CONNECTION_LIMIT_REACHED\s*=/);
      });

      it("correlaciona o plano por CHAVE, nunca por índice de array", () => {
        // O PostgREST não garante ordem sem ORDER BY; casar o teto de um plano
        // com a assinatura de outro seria silencioso.
        expect(src).toMatch(/planBySubscriptionId\.get\(\s*resolution\.subscriptionId\s*\)/);
      });

      it("conta instâncias por lifecycle_state <> ENDED, não por ACTIVE", () => {
        // CANCELLATION_REQUESTED ainda custa até a confirmação de encerramento.
        expect(src).toMatch(/\.neq\(\s*["'`]lifecycle_state["'`]\s*,\s*["'`]ENDED["'`]\s*\)/);
      });

      it("tem mensagem para TODO motivo de recusa do núcleo", () => {
        // Motivo novo no núcleo sem mensagem aqui devolveria `undefined` como
        // corpo do erro — o cliente veria uma recusa sem texto nenhum.
        for (const motivo of motivosDeRecusa()) {
          expect(src).toMatch(new RegExp(`${motivo}:`));
        }
      });
    });
  }

  it("manage-whatsapp-instances mantém assertProvisioningAllowed ao lado do allowance", () => {
    // As duas guardas respondem perguntas diferentes: uma pergunta se o modelo
    // comercial permite, a outra se a plataforma sabe provisionar. Uma não
    // substitui a outra.
    const src = ler("supabase/functions/manage-whatsapp-instances/index.ts");
    expect(src).toMatch(/assertProvisioningAllowed\s*\(/);
  });

  it("manage-channels mantém o gate de sete estados ao lado do allowance", () => {
    const src = ler("supabase/functions/manage-channels/index.ts");
    expect(src).toMatch(/gate\.provisioning\.allowed/);
  });
});
