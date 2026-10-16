import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PLATFORM_NAV, isPlatformNavItemActive } from "./platform-nav";

const allItems = PLATFORM_NAV.flatMap((section) => section.items);
const item = (to: string) => {
  const found = allItems.find((candidate) => candidate.to === to);
  if (!found) throw new Error(`item ${to} ausente do menu`);
  return found;
};

describe("isPlatformNavItemActive", () => {
  it("Cobranças acende na lista e no detalhe da empresa", () => {
    const cobrancas = item("/platform/billing");
    expect(isPlatformNavItemActive("/platform/billing", cobrancas)).toBe(true);
    expect(
      isPlatformNavItemActive("/platform/billing/622a0dc1-0e23-4a98-932c-a1c583619354", cobrancas),
    ).toBe(true);
  });

  it("Cobranças NÃO acende em Planos nem em Implantações, que têm item próprio", () => {
    const cobrancas = item("/platform/billing");
    expect(isPlatformNavItemActive("/platform/billing/planos", cobrancas)).toBe(false);
    expect(isPlatformNavItemActive("/platform/billing/implementacoes", cobrancas)).toBe(false);
    expect(isPlatformNavItemActive("/platform/billing/planos", item("/platform/billing/planos"))).toBe(true);
    expect(
      isPlatformNavItemActive("/platform/billing/implementacoes", item("/platform/billing/implementacoes")),
    ).toBe(true);
  });

  it("Unidades acende na lista e na configuração de uma loja", () => {
    const unidades = item("/platform/unidades");
    expect(isPlatformNavItemActive("/platform/unidades", unidades)).toBe(true);
    expect(isPlatformNavItemActive("/platform/unidades/ren-sushi", unidades)).toBe(true);
  });

  it("casa por segmento, não por prefixo de texto", () => {
    expect(isPlatformNavItemActive("/platform/empresas-x", item("/platform/empresas"))).toBe(false);
    expect(isPlatformNavItemActive("/platform/billingx", item("/platform/billing"))).toBe(false);
  });

  it("no máximo um item aceso por endereço", () => {
    const paths = [
      "/platform/empresas",
      "/platform/unidades/ren-sushi",
      "/platform/billing",
      "/platform/billing/planos",
      "/platform/billing/implementacoes",
      "/platform/billing/622a0dc1-0e23-4a98-932c-a1c583619354",
      "/platform/instancias-whatsapp",
      "/platform/integracoes",
    ];
    for (const path of paths) {
      const active = allItems.filter((candidate) => isPlatformNavItemActive(path, candidate));
      expect(active.map((candidate) => candidate.to), path).toHaveLength(1);
    }
  });
});

describe("PLATFORM_NAV × rotas", () => {
  // Item de menu sem rota declarada vira link para a tela em branco do router;
  // ler a fonte é o que o vitest consegue, porque App.tsx monta o app inteiro.
  const app = readFileSync(resolve(__dirname, "../../App.tsx"), "utf8");

  it.each(allItems.map((candidate) => candidate.to))("%s tem Route declarada em App.tsx", (to) => {
    expect(app).toContain(`path="${to}"`);
  });
});
