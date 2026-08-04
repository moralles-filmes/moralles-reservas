import { describe, it, expect } from "vitest";
import {
  decideInvoiceCategory,
  isLegacyInvoice,
  isTerminalSubscriptionStatus,
  mayGovernSystemAccess,
  SYSTEM_CATEGORY,
  type FactRead,
  type InvoiceCategoryFacts,
} from "../../supabase/functions/_shared/billing-category-core";

const resolved = <T>(value: T): FactRead<T> => ({ kind: "RESOLVED", value });
const notFound = <T>(): FactRead<T> => ({ kind: "NOT_FOUND" });
const readFailed = <T>(): FactRead<T> => ({ kind: "READ_FAILED" });

/** Fatura moderna, sem vínculo nenhum — o esqueleto do caminho perigoso. */
const modern = (over: Partial<InvoiceCategoryFacts> = {}): InvoiceCategoryFacts => ({
  purpose: "subscription",
  legacy: false,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// A. O caminho perigoso documentado como Risco 7
// ─────────────────────────────────────────────────────────────────────────────

describe("A. fatura moderna sem vínculo confiável", () => {
  it("NUNCA é presumida de sistema — vai para revisão", () => {
    const d = decideInvoiceCategory(modern());
    expect(d.verdict).toBe("NEEDS_REVIEW");
    expect(d.reason).toBe("MODERN_WITHOUT_LINK");
    expect(d.holdRequired).toBe(true);
    expect(mayGovernSystemAccess(d)).toBe(false);
  });

  it("continua em revisão mesmo com purpose='subscription' e organização conhecida", () => {
    // Nem `purpose`, nem a organização associada valem como prova de categoria.
    const d = decideInvoiceCategory(modern({ purpose: "subscription" }));
    expect(d.verdict).toBe("NEEDS_REVIEW");
  });

  it("purpose 'other' também não promove a sistema", () => {
    expect(decideInvoiceCategory(modern({ purpose: "other" })).verdict).toBe("NEEDS_REVIEW");
    expect(decideInvoiceCategory(modern({ purpose: null })).verdict).toBe("NEEDS_REVIEW");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Assinatura de WhatsApp (R$149) nunca governa o acesso ao sistema
// ─────────────────────────────────────────────────────────────────────────────

describe("B. mensalidade da instância de WhatsApp", () => {
  it("é NON_SYSTEM quando vem por vínculo de assinatura", () => {
    const d = decideInvoiceCategory(
      modern({
        subscription: {
          category: resolved("WHATSAPP_SUBSCRIPTION"),
          status: resolved("active"),
        },
      }),
    );
    expect(d.verdict).toBe("NON_SYSTEM");
    expect(mayGovernSystemAccess(d)).toBe(false);
    expect(d.holdRequired).toBe(false);
  });

  it("é NON_SYSTEM quando vem pelo plano do external_reference", () => {
    const d = decideInvoiceCategory(
      modern({ externalReferencePlanCategory: resolved("WHATSAPP_SUBSCRIPTION") }),
    );
    expect(d.verdict).toBe("NON_SYSTEM");
    expect(mayGovernSystemAccess(d)).toBe(false);
  });

  it("implantação e recarga de IA também nunca governam o sistema", () => {
    expect(decideInvoiceCategory(modern({ purpose: "implementation" })).verdict).toBe("NON_SYSTEM");
    expect(decideInvoiceCategory(modern({ purpose: "ai_topup" })).verdict).toBe("NON_SYSTEM");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Assinatura correlacionada porém CANCELADA localmente (rescaldo do bug 08)
// ─────────────────────────────────────────────────────────────────────────────

describe("C. assinatura em status terminal", () => {
  it("não escala, mesmo sendo de categoria SISTEMA", () => {
    const d = decideInvoiceCategory(
      modern({
        subscription: {
          category: resolved(SYSTEM_CATEGORY),
          status: resolved("canceled"),
        },
      }),
    );
    expect(d.verdict).toBe("NEEDS_REVIEW");
    expect(d.reason).toBe("SUBSCRIPTION_TERMINAL_STATUS");
    expect(d.holdRequired).toBe(true);
    expect(mayGovernSystemAccess(d)).toBe(false);
  });

  it("o status terminal vence a categoria também quando a categoria é de WhatsApp", () => {
    const d = decideInvoiceCategory(
      modern({
        subscription: {
          category: resolved("WHATSAPP_SUBSCRIPTION"),
          status: resolved("canceled"),
        },
      }),
    );
    expect(d.verdict).toBe("NEEDS_REVIEW");
    expect(d.reason).toBe("SUBSCRIPTION_TERMINAL_STATUS");
  });

  it("assinatura ativa de sistema segue escalando normalmente", () => {
    const d = decideInvoiceCategory(
      modern({
        subscription: { category: resolved(SYSTEM_CATEGORY), status: resolved("active") },
      }),
    );
    expect(d.verdict).toBe("SYSTEM");
    expect(mayGovernSystemAccess(d)).toBe(true);
  });

  it("isTerminalSubscriptionStatus normaliza caixa e espaço, e não confunde 'unpaid'", () => {
    expect(isTerminalSubscriptionStatus(" Canceled ")).toBe(true);
    expect(isTerminalSubscriptionStatus("unpaid")).toBe(false);
    expect(isTerminalSubscriptionStatus("active")).toBe(false);
    expect(isTerminalSubscriptionStatus(null)).toBe(false);
    expect(isTerminalSubscriptionStatus(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Renovação normal de sistema
// ─────────────────────────────────────────────────────────────────────────────

describe("D. renovação de assinatura de sistema", () => {
  it("com vínculo inequívoco é SYSTEM e autoriza escrever billing_status", () => {
    const d = decideInvoiceCategory(
      modern({
        subscription: { category: resolved(SYSTEM_CATEGORY), status: resolved("active") },
      }),
    );
    expect(d.verdict).toBe("SYSTEM");
    expect(d.reason).toBe("SUBSCRIPTION_CATEGORY_SYSTEM");
    expect(d.holdRequired).toBe(false);
    expect(mayGovernSystemAccess(d)).toBe(true);
  });

  it("assinatura em atraso (unpaid) não é status terminal — continua classificando", () => {
    const d = decideInvoiceCategory(
      modern({
        subscription: { category: resolved(SYSTEM_CATEGORY), status: resolved("unpaid") },
      }),
    );
    expect(d.verdict).toBe("SYSTEM");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Compatibilidade legada, delimitada por fato objetivo
// ─────────────────────────────────────────────────────────────────────────────

describe("E. fatura legada", () => {
  it("sem vínculo nenhum continua sendo de sistema (compatibilidade preservada)", () => {
    const d = decideInvoiceCategory({ purpose: "subscription", legacy: true });
    expect(d.verdict).toBe("SYSTEM");
    expect(d.reason).toBe("LEGACY_COMPAT_SYSTEM");
    expect(d.holdRequired).toBe(false);
  });

  it("isLegacyInvoice: Stripe é sempre legada", () => {
    expect(isLegacyInvoice({ provider: "stripe" })).toBe(true);
    expect(isLegacyInvoice({ provider: "STRIPE" })).toBe(true);
  });

  it("isLegacyInvoice: Asaas antes do marco é legada; a partir do marco não é", () => {
    const since = "2026-07-31";
    expect(isLegacyInvoice({ provider: "asaas", createdAt: "2026-07-30T22:38:14Z", ingestionSince: since })).toBe(true);
    expect(isLegacyInvoice({ provider: "asaas", createdAt: "2026-07-31T15:13:45Z", ingestionSince: since })).toBe(false);
    expect(isLegacyInvoice({ provider: "asaas", createdAt: "2026-08-01T00:00:00Z", ingestionSince: since })).toBe(false);
  });

  it("isLegacyInvoice: SEM marco conhecido, fatura Asaas NÃO é presumida legada", () => {
    // Presumir legada por ausência de marco reintroduziria o default removido.
    expect(isLegacyInvoice({ provider: "asaas", createdAt: "2026-07-30T00:00:00Z" })).toBe(false);
    expect(isLegacyInvoice({ provider: "asaas", createdAt: "2026-07-30T00:00:00Z", ingestionSince: "" })).toBe(false);
    expect(isLegacyInvoice({ provider: "asaas", createdAt: "2026-07-30T00:00:00Z", ingestionSince: "31/07/2026" })).toBe(false);
  });

  it("isLegacyInvoice: sem data de criação utilizável não presume legada", () => {
    expect(isLegacyInvoice({ provider: "asaas", createdAt: null, ingestionSince: "2026-07-31" })).toBe(false);
    expect(isLegacyInvoice({ provider: "asaas", createdAt: "2026-07", ingestionSince: "2026-07-31" })).toBe(false);
  });

  it("legada com vínculo de WhatsApp continua NON_SYSTEM — legado não promove", () => {
    const d = decideInvoiceCategory({
      purpose: "subscription",
      legacy: true,
      subscription: { category: resolved("WHATSAPP_SUBSCRIPTION"), status: resolved("active") },
    });
    expect(d.verdict).toBe("NON_SYSTEM");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. Duplicidade — nunca escolher "a mais recente"
// ─────────────────────────────────────────────────────────────────────────────

describe("F. duplicidade de assinatura", () => {
  it("duas assinaturas vivas da mesma categoria vão para revisão", () => {
    const d = decideInvoiceCategory(
      modern({
        subscription: {
          category: resolved(SYSTEM_CATEGORY),
          status: resolved("active"),
          ambiguous: true,
        },
      }),
    );
    expect(d.verdict).toBe("NEEDS_REVIEW");
    expect(d.reason).toBe("SUBSCRIPTION_AMBIGUOUS");
    expect(d.holdRequired).toBe(true);
  });

  it("ambiguidade vence até a categoria resolvida — não há desempate silencioso", () => {
    const d = decideInvoiceCategory(
      modern({
        subscription: {
          category: resolved("WHATSAPP_SUBSCRIPTION"),
          status: resolved("active"),
          ambiguous: true,
        },
      }),
    );
    expect(d.verdict).toBe("NEEDS_REVIEW");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. Conflito entre purpose e categoria — nunca coerção silenciosa
// ─────────────────────────────────────────────────────────────────────────────

describe("G. conflito purpose × categoria", () => {
  it("purpose de implantação com plano de SISTEMA vai para revisão", () => {
    const d = decideInvoiceCategory(
      modern({
        purpose: "implementation",
        subscription: { category: resolved(SYSTEM_CATEGORY), status: resolved("active") },
      }),
    );
    expect(d.verdict).toBe("NEEDS_REVIEW");
    expect(d.reason).toBe("PURPOSE_CATEGORY_CONFLICT");
    expect(d.holdRequired).toBe(true);
  });

  it("purpose de recarga de IA com plano de SISTEMA vai para revisão", () => {
    const d = decideInvoiceCategory(
      modern({
        purpose: "ai_topup",
        externalReferencePlanCategory: resolved(SYSTEM_CATEGORY),
      }),
    );
    expect(d.verdict).toBe("NEEDS_REVIEW");
    expect(d.reason).toBe("PURPOSE_CATEGORY_CONFLICT");
  });

  it("purpose de implantação com plano de implantação é coerente — NON_SYSTEM", () => {
    const d = decideInvoiceCategory(
      modern({
        purpose: "implementation",
        externalReferencePlanCategory: resolved("WHATSAPP_IMPLEMENTATION"),
      }),
    );
    expect(d.verdict).toBe("NON_SYSTEM");
    expect(d.reason).toBe("PURPOSE_NON_SYSTEM");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H. Renovação sem checkoutSession — correlação pela assinatura basta
// ─────────────────────────────────────────────────────────────────────────────

describe("H. ausência de checkoutSession", () => {
  it("renovação sem external_reference classifica pelo vínculo de assinatura", () => {
    const d = decideInvoiceCategory({
      purpose: "subscription",
      legacy: false,
      // sem externalReferencePlanCategory — a renovação do Asaas não o carrega
      subscription: { category: resolved(SYSTEM_CATEGORY), status: resolved("active") },
    });
    expect(d.verdict).toBe("SYSTEM");
    expect(d.reason).toBe("SUBSCRIPTION_CATEGORY_SYSTEM");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Leituras que falharam ou não encontraram — os dois viram revisão
// ─────────────────────────────────────────────────────────────────────────────

describe("leitura indisponível ou inconsistente", () => {
  it("categoria da assinatura ilegível vai para revisão, não para false silencioso", () => {
    const d = decideInvoiceCategory(
      modern({ subscription: { category: readFailed(), status: resolved("active") } }),
    );
    expect(d.verdict).toBe("NEEDS_REVIEW");
    expect(d.reason).toBe("SUBSCRIPTION_UNREADABLE");
    expect(d.holdRequired).toBe(true);
  });

  it("status da assinatura ilegível vai para revisão", () => {
    const d = decideInvoiceCategory(
      modern({ subscription: { category: resolved(SYSTEM_CATEGORY), status: readFailed() } }),
    );
    expect(d.verdict).toBe("NEEDS_REVIEW");
    expect(d.reason).toBe("SUBSCRIPTION_UNREADABLE");
  });

  it("assinatura vinculada que não existe mais vai para revisão", () => {
    const d = decideInvoiceCategory(
      modern({ subscription: { category: notFound(), status: notFound() } }),
    );
    expect(d.verdict).toBe("NEEDS_REVIEW");
  });

  it("plano do external_reference órfão ou ilegível vai para revisão", () => {
    expect(decideInvoiceCategory(modern({ externalReferencePlanCategory: notFound() })).reason)
      .toBe("PLAN_UNREADABLE");
    expect(decideInvoiceCategory(modern({ externalReferencePlanCategory: readFailed() })).verdict)
      .toBe("NEEDS_REVIEW");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// O invariante central, afirmado diretamente
// ─────────────────────────────────────────────────────────────────────────────

describe("INVARIANTE: só SYSTEM inequívoco governa organizations.billing_status", () => {
  const casosQueNuncaGovernam: Array<[string, InvoiceCategoryFacts]> = [
    [
      "WHATSAPP_SUBSCRIPTION",
      modern({ subscription: { category: resolved("WHATSAPP_SUBSCRIPTION"), status: resolved("active") } }),
    ],
    [
      "WHATSAPP_IMPLEMENTATION",
      modern({ externalReferencePlanCategory: resolved("WHATSAPP_IMPLEMENTATION") }),
    ],
    [
      "AI_CREDIT_PACKAGE",
      modern({ externalReferencePlanCategory: resolved("AI_CREDIT_PACKAGE") }),
    ],
    ["purpose implementation", modern({ purpose: "implementation" })],
    ["purpose ai_topup", modern({ purpose: "ai_topup" })],
    ["moderna sem vínculo", modern()],
    [
      "assinatura cancelada",
      modern({ subscription: { category: resolved(SYSTEM_CATEGORY), status: resolved("canceled") } }),
    ],
    [
      "assinatura ambígua",
      modern({ subscription: { category: resolved(SYSTEM_CATEGORY), status: resolved("active"), ambiguous: true } }),
    ],
    [
      "categoria ilegível",
      modern({ subscription: { category: readFailed(), status: resolved("active") } }),
    ],
    [
      "conflito purpose × categoria",
      modern({ purpose: "implementation", externalReferencePlanCategory: resolved(SYSTEM_CATEGORY) }),
    ],
  ];

  it.each(casosQueNuncaGovernam)("%s nunca autoriza escrever billing_status", (_nome, facts) => {
    expect(mayGovernSystemAccess(decideInvoiceCategory(facts))).toBe(false);
  });

  const casosQueGovernam: Array<[string, InvoiceCategoryFacts]> = [
    [
      "assinatura de sistema ativa",
      modern({ subscription: { category: resolved(SYSTEM_CATEGORY), status: resolved("active") } }),
    ],
    ["plano de sistema no external_reference", modern({ externalReferencePlanCategory: resolved(SYSTEM_CATEGORY) })],
    ["fatura legada sem vínculo", { purpose: "subscription", legacy: true }],
  ];

  it.each(casosQueGovernam)("%s autoriza", (_nome, facts) => {
    expect(mayGovernSystemAccess(decideInvoiceCategory(facts))).toBe(true);
  });

  it("todo veredito NEEDS_REVIEW exige retenção, e nenhum outro exige", () => {
    const todos = [...casosQueNuncaGovernam, ...casosQueGovernam].map(([, f]) =>
      decideInvoiceCategory(f),
    );
    for (const d of todos) {
      expect(d.holdRequired).toBe(d.verdict === "NEEDS_REVIEW");
    }
  });
});
