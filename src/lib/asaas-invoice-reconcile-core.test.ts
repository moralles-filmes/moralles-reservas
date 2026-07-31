import { describe, it, expect } from "vitest";
import {
  classifyPaymentCollectibility,
  parseBillingIngestionSince,
  decideMissingInvoiceIngestion,
  shouldSettleOpenInvoice,
  shouldHoldValueMismatch,
  decideReconcileAction,
  type CollectibilityState,
  type LocalInvoiceSnapshot,
} from "../../supabase/functions/_shared/asaas-invoice-reconcile-core";

describe("classifyPaymentCollectibility", () => {
  it("PENDING, OVERDUE, AWAITING_RISK_ANALYSIS, DUNNING_REQUESTED, DUNNING_RECEIVED → COLLECTIBLE", () => {
    for (const s of ["PENDING", "OVERDUE", "AWAITING_RISK_ANALYSIS", "DUNNING_REQUESTED", "DUNNING_RECEIVED"]) {
      expect(classifyPaymentCollectibility(s)).toBe("COLLECTIBLE");
    }
  });

  it("RECEIVED, CONFIRMED, RECEIVED_IN_CASH → SETTLED", () => {
    for (const s of ["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"]) {
      expect(classifyPaymentCollectibility(s)).toBe("SETTLED");
    }
  });

  it("REFUNDED, REFUND_REQUESTED, REFUND_IN_PROGRESS → NON_COLLECTIBLE_REFUND", () => {
    for (const s of ["REFUNDED", "REFUND_REQUESTED", "REFUND_IN_PROGRESS"]) {
      expect(classifyPaymentCollectibility(s)).toBe("NON_COLLECTIBLE_REFUND");
    }
  });

  it("CHARGEBACK_REQUESTED, CHARGEBACK_DISPUTE, AWAITING_CHARGEBACK_REVERSAL → NON_COLLECTIBLE_CHARGEBACK", () => {
    for (const s of ["CHARGEBACK_REQUESTED", "CHARGEBACK_DISPUTE", "AWAITING_CHARGEBACK_REVERSAL"]) {
      expect(classifyPaymentCollectibility(s)).toBe("NON_COLLECTIBLE_CHARGEBACK");
    }
  });

  it("status fora do catálogo (API nova, payload degradado, string vazia) → UNKNOWN, nunca um chute", () => {
    expect(classifyPaymentCollectibility("SOME_NEW_STATUS")).toBe("UNKNOWN");
    expect(classifyPaymentCollectibility("")).toBe("UNKNOWN");
    expect(classifyPaymentCollectibility("received")).toBe("UNKNOWN"); // case-sensitive
    expect(classifyPaymentCollectibility("CANCELED")).toBe("UNKNOWN"); // não existe no catálogo real do Asaas
  });

  it("cobre exatamente os 14 status documentados — nenhum a mais, nenhum a menos", () => {
    const known = [
      "PENDING",
      "RECEIVED",
      "CONFIRMED",
      "OVERDUE",
      "REFUNDED",
      "RECEIVED_IN_CASH",
      "REFUND_REQUESTED",
      "REFUND_IN_PROGRESS",
      "CHARGEBACK_REQUESTED",
      "CHARGEBACK_DISPUTE",
      "AWAITING_CHARGEBACK_REVERSAL",
      "DUNNING_REQUESTED",
      "DUNNING_RECEIVED",
      "AWAITING_RISK_ANALYSIS",
    ];
    expect(known).toHaveLength(14);
    for (const s of known) {
      expect(classifyPaymentCollectibility(s)).not.toBe("UNKNOWN");
    }
  });
});

describe("parseBillingIngestionSince", () => {
  it("aceita YYYY-MM-DD válido", () => {
    expect(parseBillingIngestionSince("2026-07-28")).toEqual({ ok: true, value: "2026-07-28" });
    expect(parseBillingIngestionSince("2026-01-01")).toEqual({ ok: true, value: "2026-01-01" });
    expect(parseBillingIngestionSince("2024-02-29")).toEqual({ ok: true, value: "2024-02-29" }); // ano bissexto
  });

  it("recusa ausente — undefined, null, não-string, número", () => {
    expect(parseBillingIngestionSince(undefined)).toEqual({ ok: false, code: "MISSING" });
    expect(parseBillingIngestionSince(null)).toEqual({ ok: false, code: "MISSING" });
    expect(parseBillingIngestionSince(123)).toEqual({ ok: false, code: "MISSING" });
    expect(parseBillingIngestionSince({})).toEqual({ ok: false, code: "MISSING" });
    expect(parseBillingIngestionSince([])).toEqual({ ok: false, code: "MISSING" });
  });

  it("recusa vazia e só-espaços", () => {
    expect(parseBillingIngestionSince("")).toEqual({ ok: false, code: "MISSING" });
    expect(parseBillingIngestionSince("   ")).toEqual({ ok: false, code: "MISSING" });
    expect(parseBillingIngestionSince("\t\n")).toEqual({ ok: false, code: "MISSING" });
  });

  it("recusa formato inválido", () => {
    expect(parseBillingIngestionSince("28/07/2026")).toEqual({ ok: false, code: "INVALID_FORMAT" });
    expect(parseBillingIngestionSince("2026-7-28")).toEqual({ ok: false, code: "INVALID_FORMAT" });
    expect(parseBillingIngestionSince("2026-07-28T00:00:00Z")).toEqual({ ok: false, code: "INVALID_FORMAT" });
    expect(parseBillingIngestionSince("hoje")).toEqual({ ok: false, code: "INVALID_FORMAT" });
    expect(parseBillingIngestionSince("2026-07")).toEqual({ ok: false, code: "INVALID_FORMAT" });
  });

  it("recusa data impossível (calendário não corrigido silenciosamente pelo Date)", () => {
    expect(parseBillingIngestionSince("2026-02-30")).toEqual({ ok: false, code: "IMPOSSIBLE_DATE" });
    expect(parseBillingIngestionSince("2026-13-01")).toEqual({ ok: false, code: "IMPOSSIBLE_DATE" });
    expect(parseBillingIngestionSince("2026-00-10")).toEqual({ ok: false, code: "IMPOSSIBLE_DATE" });
    expect(parseBillingIngestionSince("2025-02-29")).toEqual({ ok: false, code: "IMPOSSIBLE_DATE" }); // não-bissexto
    expect(parseBillingIngestionSince("2026-04-31")).toEqual({ ok: false, code: "IMPOSSIBLE_DATE" });
  });

  it("nunca lança, nunca vira hoje/epoch — só os 3 códigos tipados", () => {
    const hostileInputs: unknown[] = [undefined, null, "", "   ", "abc", NaN, Symbol("x"), new Date()];
    for (const input of hostileInputs) {
      const result = parseBillingIngestionSince(input);
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(["MISSING", "INVALID_FORMAT", "IMPOSSIBLE_DATE"]).toContain(result.code);
      }
    }
  });
});

describe("decideMissingInvoiceIngestion", () => {
  it("since vazia ('' — ingestão nunca configurada) nunca vira BACKFILL", () => {
    const d = decideMissingInvoiceIngestion({ sinceValue: "", dueDate: "2020-01-01", settled: false });
    expect(d).toEqual({ ingestionSource: "RECONCILE", hold: false, holdReason: null });
  });

  it("dueDate anterior a since e não liquidada → BACKFILL retida com INITIAL_BACKFILL", () => {
    const d = decideMissingInvoiceIngestion({
      sinceValue: "2026-07-28",
      dueDate: "2026-07-01",
      settled: false,
    });
    expect(d).toEqual({ ingestionSource: "BACKFILL", hold: true, holdReason: "INITIAL_BACKFILL" });
  });

  it("dueDate anterior a since MAS já liquidada → BACKFILL sem retenção", () => {
    const d = decideMissingInvoiceIngestion({
      sinceValue: "2026-07-28",
      dueDate: "2026-07-01",
      settled: true,
    });
    expect(d).toEqual({ ingestionSource: "BACKFILL", hold: false, holdReason: null });
  });

  it("dueDate == since (fronteira do dia 0) NÃO é backfill — dueDate < since é estrito", () => {
    const d = decideMissingInvoiceIngestion({
      sinceValue: "2026-07-28",
      dueDate: "2026-07-28",
      settled: false,
    });
    expect(d).toEqual({ ingestionSource: "RECONCILE", hold: false, holdReason: null });
  });

  it("dueDate posterior a since → RECONCILE sem retenção, liquidada ou não", () => {
    expect(
      decideMissingInvoiceIngestion({ sinceValue: "2026-07-28", dueDate: "2026-08-01", settled: false }),
    ).toEqual({ ingestionSource: "RECONCILE", hold: false, holdReason: null });
    expect(
      decideMissingInvoiceIngestion({ sinceValue: "2026-07-28", dueDate: "2026-08-01", settled: true }),
    ).toEqual({ ingestionSource: "RECONCILE", hold: false, holdReason: null });
  });
});

describe("shouldSettleOpenInvoice", () => {
  it("open + liquidada remotamente → true", () => {
    expect(shouldSettleOpenInvoice("open", true)).toBe(true);
  });

  it("open + não liquidada remotamente → false", () => {
    expect(shouldSettleOpenInvoice("open", false)).toBe(false);
  });

  it("qualquer status que não seja 'open' nunca liquida por aqui, mesmo remotamente paga", () => {
    expect(shouldSettleOpenInvoice("draft", true)).toBe(false);
    expect(shouldSettleOpenInvoice("paid", true)).toBe(false);
    expect(shouldSettleOpenInvoice("void", true)).toBe(false);
    expect(shouldSettleOpenInvoice("uncollectible", true)).toBe(false);
  });
});

describe("shouldHoldValueMismatch", () => {
  const base = { localStatus: "open" as const, alreadyHeld: false, localAmountCents: 14900, remoteAmountCents: 14900 };

  it("open + não retida + valores divergentes → true", () => {
    expect(shouldHoldValueMismatch({ ...base, remoteAmountCents: 19900 })).toBe(true);
  });

  it("open + não retida + valores iguais → false", () => {
    expect(shouldHoldValueMismatch(base)).toBe(false);
  });

  it("já retida → false, mesmo com valores divergentes (não reescreve retenção existente)", () => {
    expect(shouldHoldValueMismatch({ ...base, alreadyHeld: true, remoteAmountCents: 19900 })).toBe(false);
  });

  it("status fora de 'open' → false, mesmo com valores divergentes", () => {
    for (const status of ["draft", "paid", "void", "uncollectible"] as const) {
      expect(shouldHoldValueMismatch({ ...base, localStatus: status, remoteAmountCents: 19900 })).toBe(false);
    }
  });
});

describe("decideReconcileAction — composição única (fix round 1, achado 1)", () => {
  const INVOICE_ID = "11111111-1111-1111-1111-111111111111";

  const openInvoice = (overrides: Partial<LocalInvoiceSnapshot> = {}): LocalInvoiceSnapshot => ({
    id: INVOICE_ID,
    status: "open",
    amountCents: 14900,
    enforcementHold: false,
    ...overrides,
  });

  it("REGRESSÃO DO ACHADO 1: fatura open liquidada nesta passada, com valor divergente, é SETTLE_INVOICE — NUNCA HOLD_VALUE_MISMATCH", () => {
    const action = decideReconcileAction({
      collectibility: "SETTLED",
      localInvoice: openInvoice({ amountCents: 14900 }),
      remoteAmountCents: 19900, // diverge do local — mas a fatura FOI paga nesta passada
      dueDate: "2026-07-28",
      sinceValue: "2026-01-01",
    });
    expect(action).toEqual({ kind: "SETTLE_INVOICE", invoiceId: INVOICE_ID });
  });

  it("SETTLED + valores iguais → também SETTLE_INVOICE (caso comum, sem divergência)", () => {
    const action = decideReconcileAction({
      collectibility: "SETTLED",
      localInvoice: openInvoice({ amountCents: 14900 }),
      remoteAmountCents: 14900,
      dueDate: "2026-07-28",
      sinceValue: "2026-01-01",
    });
    expect(action.kind).toBe("SETTLE_INVOICE");
  });

  it("SETTLED + fatura já 'draft' (shouldSettleOpenInvoice não se aplica) → NO_ACTION, nunca settle nem hold", () => {
    const action = decideReconcileAction({
      collectibility: "SETTLED",
      localInvoice: openInvoice({ status: "draft", amountCents: 100 }),
      remoteAmountCents: 99999,
      dueDate: "2026-07-28",
      sinceValue: "2026-01-01",
    });
    expect(action.kind).toBe("NO_ACTION");
  });

  it("COLLECTIBLE + fatura open + valor diverge → HOLD_VALUE_MISMATCH (settle não se aplica, é o caminho normal), com invoiceId e localAmountCents propagados", () => {
    const action = decideReconcileAction({
      collectibility: "COLLECTIBLE",
      localInvoice: openInvoice({ amountCents: 14900 }),
      remoteAmountCents: 19900,
      dueDate: "2026-07-28",
      sinceValue: "2026-01-01",
    });
    expect(action).toEqual({ kind: "HOLD_VALUE_MISMATCH", invoiceId: INVOICE_ID, localAmountCents: 14900 });
  });

  it("COLLECTIBLE + fatura open + valores iguais → NO_ACTION", () => {
    const action = decideReconcileAction({
      collectibility: "COLLECTIBLE",
      localInvoice: openInvoice({ amountCents: 14900 }),
      remoteAmountCents: 14900,
      dueDate: "2026-07-28",
      sinceValue: "2026-01-01",
    });
    expect(action.kind).toBe("NO_ACTION");
  });

  it("COLLECTIBLE + já retida + valor diverge → NO_ACTION (não reescreve retenção)", () => {
    const action = decideReconcileAction({
      collectibility: "COLLECTIBLE",
      localInvoice: openInvoice({ enforcementHold: true, amountCents: 14900 }),
      remoteAmountCents: 19900,
      dueDate: "2026-07-28",
      sinceValue: "2026-01-01",
    });
    expect(action.kind).toBe("NO_ACTION");
  });

  it("sem fatura local + COLLECTIBLE → CREATE_INVOICE status 'open'", () => {
    const action = decideReconcileAction({
      collectibility: "COLLECTIBLE",
      localInvoice: null,
      remoteAmountCents: 14900,
      dueDate: "2026-08-01",
      sinceValue: "2026-01-01",
    });
    expect(action).toMatchObject({ kind: "CREATE_INVOICE", status: "open", ingestionSource: "RECONCILE", hold: false });
  });

  it("sem fatura local + SETTLED → CREATE_INVOICE status 'paid'", () => {
    const action = decideReconcileAction({
      collectibility: "SETTLED",
      localInvoice: null,
      remoteAmountCents: 14900,
      dueDate: "2026-08-01",
      sinceValue: "2026-01-01",
    });
    expect(action).toMatchObject({ kind: "CREATE_INVOICE", status: "paid" });
  });

  it("sem fatura local + COLLECTIBLE + dueDate anterior a since → CREATE_INVOICE BACKFILL retida", () => {
    const action = decideReconcileAction({
      collectibility: "COLLECTIBLE",
      localInvoice: null,
      remoteAmountCents: 14900,
      dueDate: "2025-01-01",
      sinceValue: "2026-01-01",
    });
    expect(action).toMatchObject({
      kind: "CREATE_INVOICE",
      status: "open",
      ingestionSource: "BACKFILL",
      hold: true,
      holdReason: "INITIAL_BACKFILL",
    });
  });

  const nonCollectibleStates: CollectibilityState[] = [
    "NON_COLLECTIBLE_REFUND",
    "NON_COLLECTIBLE_CHARGEBACK",
    "CANCELED",
  ];

  for (const state of nonCollectibleStates) {
    it(`${state} sem fatura local → SKIP_NON_COLLECTIBLE_NO_INVOICE (nunca fabrica dívida)`, () => {
      const action = decideReconcileAction({
        collectibility: state,
        localInvoice: null,
        remoteAmountCents: 14900,
        dueDate: "2026-07-28",
        sinceValue: "2026-01-01",
      });
      expect(action.kind).toBe("SKIP_NON_COLLECTIBLE_NO_INVOICE");
    });

    it(`${state} + fatura open não retida → HOLD_NON_COLLECTIBLE (congela, nunca settle), com invoiceId propagado`, () => {
      const action = decideReconcileAction({
        collectibility: state,
        localInvoice: openInvoice(),
        remoteAmountCents: 14900,
        dueDate: "2026-07-28",
        sinceValue: "2026-01-01",
      });
      expect(action).toEqual({ kind: "HOLD_NON_COLLECTIBLE", invoiceId: INVOICE_ID });
    });

    it(`${state} + fatura JÁ retida → NO_ACTION (idempotente, não duplica alerta)`, () => {
      const action = decideReconcileAction({
        collectibility: state,
        localInvoice: openInvoice({ enforcementHold: true }),
        remoteAmountCents: 14900,
        dueDate: "2026-07-28",
        sinceValue: "2026-01-01",
      });
      expect(action.kind).toBe("NO_ACTION");
    });

    it(`${state} + fatura 'paid' → NO_ACTION (nunca reabre dívida quitada)`, () => {
      const action = decideReconcileAction({
        collectibility: state,
        localInvoice: openInvoice({ status: "paid" }),
        remoteAmountCents: 14900,
        dueDate: "2026-07-28",
        sinceValue: "2026-01-01",
      });
      expect(action.kind).toBe("NO_ACTION");
    });
  }

  it("UNKNOWN sem fatura local → SKIP_UNKNOWN_NO_INVOICE (nunca vira open em silêncio)", () => {
    const action = decideReconcileAction({
      collectibility: "UNKNOWN",
      localInvoice: null,
      remoteAmountCents: 14900,
      dueDate: "2026-07-28",
      sinceValue: "2026-01-01",
    });
    expect(action.kind).toBe("SKIP_UNKNOWN_NO_INVOICE");
  });

  it("UNKNOWN + fatura open não retida → HOLD_NON_COLLECTIBLE (ambiguidade também congela)", () => {
    const action = decideReconcileAction({
      collectibility: "UNKNOWN",
      localInvoice: openInvoice(),
      remoteAmountCents: 14900,
      dueDate: "2026-07-28",
      sinceValue: "2026-01-01",
    });
    expect(action.kind).toBe("HOLD_NON_COLLECTIBLE");
  });

  it("UNKNOWN + fatura já retida → NO_ACTION", () => {
    const action = decideReconcileAction({
      collectibility: "UNKNOWN",
      localInvoice: openInvoice({ enforcementHold: true }),
      remoteAmountCents: 14900,
      dueDate: "2026-07-28",
      sinceValue: "2026-01-01",
    });
    expect(action.kind).toBe("NO_ACTION");
  });
});
