import { describe, it, expect } from "vitest";
import {
  resolveCorrelation,
  type CorrelationCandidate,
} from "../../supabase/functions/_shared/billing-correlation-core";
import {
  isAsaasPurpose,
  type AsaasPurpose,
} from "../../supabase/functions/_shared/asaas-billing-events";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PLAN = "33333333-3333-3333-3333-333333333333";
const SUB = "44444444-4444-4444-4444-444444444444";

function c(p: Partial<CorrelationCandidate> & { source: CorrelationCandidate["source"] }): CorrelationCandidate {
  return {
    organizationId: null, subscriptionId: null, planId: null, purpose: null, ...p,
  };
}

describe("resolveCorrelation", () => {
  it("sem candidato com organização devolve unresolved", () => {
    expect(resolveCorrelation([]).kind).toBe("unresolved");
    expect(resolveCorrelation([c({ source: "billing_customer" })]).kind).toBe("unresolved");
  });

  it("resolve a renovação apenas pela assinatura do provedor", () => {
    const out = resolveCorrelation([
      c({ source: "provider_subscription", organizationId: ORG_A, subscriptionId: SUB, planId: PLAN, purpose: "subscription" }),
    ]);
    expect(out).toMatchObject({
      kind: "resolved", organizationId: ORG_A, subscriptionId: SUB,
      planId: PLAN, purpose: "subscription",
    });
  });

  it("degrau superior vence e o inferior só completa campo faltante", () => {
    const out = resolveCorrelation([
      c({ source: "checkout_session", organizationId: ORG_A, planId: "outro-plano", purpose: "implementation" }),
      c({ source: "provider_subscription", organizationId: ORG_A, subscriptionId: SUB, purpose: "subscription" }),
    ]);
    // provider_subscription (rank 2) vence checkout_session (rank 4) em purpose;
    // planId vem do checkout porque a assinatura não trouxe.
    expect(out).toMatchObject({ kind: "resolved", purpose: "subscription", planId: "outro-plano", subscriptionId: SUB });
  });

  it("divergência de organização entre degraus é conflito, não escolha", () => {
    const out = resolveCorrelation([
      c({ source: "provider_subscription", organizationId: ORG_A }),
      c({ source: "checkout_session", organizationId: ORG_B }),
    ]);
    expect(out.kind).toBe("conflict");
    if (out.kind === "conflict") {
      expect(out.reason).toBe("organization_divergence");
      expect(out.sources.map((s) => s.organizationId).sort()).toEqual([ORG_A, ORG_B].sort());
    }
  });

  it("candidato sem organização nunca gera conflito", () => {
    const out = resolveCorrelation([
      c({ source: "provider_subscription", organizationId: ORG_A }),
      c({ source: "billing_customer" }),
    ]);
    expect(out.kind).toBe("resolved");
  });

  it("registra em `via` todos os degraus que contribuíram", () => {
    const out = resolveCorrelation([
      c({ source: "external_reference", organizationId: ORG_A, planId: PLAN }),
      c({ source: "provider_subscription", organizationId: ORG_A, subscriptionId: SUB }),
    ]);
    if (out.kind !== "resolved") throw new Error("esperado resolved");
    expect(out.via).toEqual(["provider_subscription", "external_reference"]);
  });

  it("divergência de plano não é fatal — o degrau superior vence", () => {
    const out = resolveCorrelation([
      c({ source: "provider_subscription", organizationId: ORG_A, planId: "plano-da-assinatura" }),
      c({ source: "external_reference", organizationId: ORG_A, planId: "plano-do-checkout" }),
    ]);
    expect(out).toMatchObject({ kind: "resolved", planId: "plano-da-assinatura" });
  });
});

describe("CorrelationCandidate.purpose — contrato tipado (Fix round 1, achado Important)", () => {
  it("não aceita string arbitrária — teste de COMPILAÇÃO, não de runtime", () => {
    // `purpose` foi apertado de `string | null` para `AsaasPurpose | null`
    // (fonte única: asaas-billing-events.ts). Se o tipo afrouxar de volta pra
    // `string | null`, a linha abaixo passa a compilar sem erro, o
    // `@ts-expect-error` fica "sem erro pra suprimir" e o PRÓPRIO
    // `@ts-expect-error` vira erro de "unused directive" — é o alarme
    // desejado: `npm run typecheck` (tsc -b --noEmit) quebra sozinho.
    const invalid: CorrelationCandidate = {
      source: "checkout_session",
      organizationId: null,
      subscriptionId: null,
      planId: null,
      // @ts-expect-error — "pagamento_avulso" não está no CHECK de billing_invoices.purpose
      purpose: "pagamento_avulso",
    };
    expect(invalid.source).toBe("checkout_session");
  });

  it("exaustividade de AsaasPurpose — Record completo trava a fonte única em compilação e em runtime", () => {
    // Record<AsaasPurpose, true> só compila com EXATAMENTE as 4 chaves do tipo
    // (Record exige todas; um objeto literal recusa chave a mais). Se
    // asaas-billing-events.ts adicionar, renomear ou remover um purpose, este
    // Record deixa de compilar — `npm run typecheck` quebra na hora.
    const ALL_PURPOSES: Record<AsaasPurpose, true> = {
      subscription: true,
      implementation: true,
      ai_topup: true,
      other: true,
    };
    const recordKeys = Object.keys(ALL_PURPOSES) as AsaasPurpose[];

    // Runtime: cobre a divergência que o compilador NÃO pega — alguém editar
    // o Set `PURPOSES` de asaas-billing-events.ts sem tocar no tipo
    // `AsaasPurpose` (ou vice-versa de um jeito que ainda compila). Aqui prova
    // que toda chave do Record é de fato aceita pelo guard...
    for (const key of recordKeys) {
      expect(isAsaasPurpose(key)).toBe(true);
    }
    // ...e que o Record não ficou nem maior nem menor que a fonte única.
    expect(recordKeys.sort()).toEqual(["ai_topup", "implementation", "other", "subscription"]);
  });
});
