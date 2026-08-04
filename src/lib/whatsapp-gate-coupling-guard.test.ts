/**
 * Guardrail ESTÁTICO do acoplamento entre `_shared/whatsapp-service-gate.ts` e
 * `process-whatsapp-enforcement/index.ts`: as duas resolvem a assinatura
 * financeira do WhatsApp e PRECISAM chegar à mesma resposta.
 *
 * Um teste que chama `resolveWhatsAppSubscription` duas vezes prova
 * determinismo — não prova que os dois consumidores o importam, nem que a
 * query antiga com `.maybeSingle()` não voltou, nem que nenhum dos dois
 * mantém uma implementação paralela da precedência de status.
 *
 * O guardrail é TEXTUAL de propósito: os `index.ts` importam `deno.land` /
 * `esm.sh` e chamam `serve()` no carregamento, então o vitest não consegue
 * importá-los. Análise estática de texto é o que resta — e é mais do que
 * existia antes.
 *
 * A asserção mais importante é a que proíbe `.eq("billing_plans.category", …)`:
 * esse filtro devolvia ZERO linha para uma organização do Plano 2 (componente
 * de WhatsApp embutido na mensalidade do sistema), que pagaria e cairia em
 * `NOT_ENTITLED`. O filtro estrito por categoria é do NÚCLEO, que enxerga
 * todas as candidatas antes de decidir.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CONSUMIDORES = [
  "supabase/functions/_shared/whatsapp-service-gate.ts",
  "supabase/functions/process-whatsapp-enforcement/index.ts",
] as const;

const ler = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("teste 27 — gate e enforcement usam O MESMO resolvedor", () => {
  for (const arquivo of CONSUMIDORES) {
    describe(arquivo, () => {
      const src = ler(arquivo);

      it("importa resolveWhatsAppSubscription", () => {
        expect(src).toMatch(/whatsapp-subscription-resolver-core\.ts/);
        expect(src).toMatch(/resolveWhatsAppSubscription/);
      });

      it("CHAMA resolveWhatsAppSubscription, nao so importa", () => {
        expect(src).toMatch(/resolveWhatsAppSubscription\s*\(/);
      });

      it("nao resolve a assinatura financeira com maybeSingle", () => {
        // maybeSingle LANCA com duas linhas — e a transicao produz duas.
        const trechos = src.split(/\n/).filter((l) => /maybeSingle/.test(l));
        for (const l of trechos) {
          expect(l).not.toMatch(/billing_subscriptions/);
        }
        expect(src).not.toMatch(/billing_plans\.category[\s\S]{0,400}?maybeSingle/);
      });

      it("nao filtra exclusivamente por WHATSAPP_SUBSCRIPTION para decidir", () => {
        // O filtro estrito por categoria e do NUCLEO. Um .eq() aqui devolveria
        // zero linha para uma organizacao do Plano 2 — o bug que este plano mata.
        expect(src).not.toMatch(/\.eq\(\s*["'`]billing_plans\.category["'`]/);
      });

      it("nao reimplementa a precedencia de status localmente", () => {
        expect(src).not.toMatch(/STATUS_RANK/);
        expect(src).not.toMatch(/LEGACY_WHATSAPP_SUBSCRIPTION_OPEN\s*=/);
      });

      it("propaga subscriptionAmbiguous ao provisionamento", () => {
        expect(src).toMatch(/subscriptionAmbiguous/);
      });
    });
  }

  it("existe exatamente UMA implementacao da precedencia", () => {
    const nucleo = ler(
      "supabase/functions/_shared/whatsapp-subscription-resolver-core.ts",
    );
    expect(nucleo).toMatch(/STATUS_RANK/);
  });
});
