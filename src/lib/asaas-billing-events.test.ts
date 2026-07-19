import { describe, it, expect } from "vitest";
import {
  buildExternalReference,
  parseExternalReference,
  decideEventEffect,
  ACTIVATING_EVENTS,
  REFUND_EVENTS,
} from "../../supabase/functions/_shared/asaas-billing-events";
import {
  ASAAS_PAYMENT_EVENTS,
  ASAAS_SUBSCRIPTION_EVENTS,
  ASAAS_CHECKOUT_EVENTS,
  classifyAsaasEvent,
} from "../../supabase/functions/_shared/asaas-core";

const ORG = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const PLAN = "9c858901-8a57-4791-81fe-4c455b099bc9";

describe("buildExternalReference", () => {
  it("builds the canonical shape", () => {
    expect(buildExternalReference({ orgId: ORG, planId: PLAN, purpose: "subscription" }))
      .toBe(`org:${ORG}|plan:${PLAN}|purpose:subscription`);
  });

  it("emits plan:none when there is no plan", () => {
    expect(buildExternalReference({ orgId: ORG, planId: null, purpose: "other" }))
      .toBe(`org:${ORG}|plan:none|purpose:other`);
  });

  it("stays within the Asaas 200-char limit", () => {
    const ref = buildExternalReference({ orgId: ORG, planId: PLAN, purpose: "implementation" });
    expect(ref.length).toBeLessThanOrEqual(200);
  });
});

describe("parseExternalReference", () => {
  it("round-trips what build produced", () => {
    const parts = { orgId: ORG, planId: PLAN, purpose: "subscription" as const };
    expect(parseExternalReference(buildExternalReference(parts))).toEqual(parts);
  });

  it("round-trips the no-plan form back to null", () => {
    const parts = { orgId: ORG, planId: null, purpose: "ai_topup" as const };
    expect(parseExternalReference(buildExternalReference(parts))).toEqual(parts);
  });

  it("rejects non-string input without throwing", () => {
    expect(parseExternalReference(null)).toBeNull();
    expect(parseExternalReference(undefined)).toBeNull();
    expect(parseExternalReference(42)).toBeNull();
    expect(parseExternalReference({})).toBeNull();
    expect(parseExternalReference([])).toBeNull();
  });

  it("rejects malformed shapes", () => {
    expect(parseExternalReference("")).toBeNull();
    expect(parseExternalReference("garbage")).toBeNull();
    expect(parseExternalReference(`org:${ORG}`)).toBeNull();
    expect(parseExternalReference(`org:${ORG}|plan:${PLAN}`)).toBeNull();
    expect(parseExternalReference(`plan:${PLAN}|org:${ORG}|purpose:subscription`)).toBeNull();
  });

  it("rejects a non-UUID org", () => {
    expect(parseExternalReference("org:not-a-uuid|plan:none|purpose:subscription")).toBeNull();
  });

  it("rejects a non-UUID plan that is not the literal none", () => {
    expect(parseExternalReference(`org:${ORG}|plan:nope|purpose:subscription`)).toBeNull();
  });

  it("rejects an unknown purpose", () => {
    expect(parseExternalReference(`org:${ORG}|plan:none|purpose:mystery`)).toBeNull();
  });

  it("accepts every purpose in the billing_invoices CHECK", () => {
    for (const p of ["subscription", "implementation", "ai_topup", "other"]) {
      const ref = `org:${ORG}|plan:none|purpose:${p}`;
      expect(parseExternalReference(ref)?.purpose).toBe(p);
    }
  });
});

describe("decideEventEffect — gate de ativação", () => {
  it("activates on PAYMENT_CONFIRMED when the invoice is still open", () => {
    const e = decideEventEffect({
      eventType: "PAYMENT_CONFIRMED",
      invoiceStatus: "open",
    });
    expect(e.kind).toBe("activate_subscription");
  });

  it("activates on PAYMENT_RECEIVED when the invoice is still open", () => {
    // PIX/boleto NUNCA emite CONFIRMED — provado ao vivo em 18/07/2026 (§5 do
    // doc 03). Um gate só-CONFIRMED deixaria todo cliente de PIX pagando sem
    // receber acesso, e funcionaria no cartão, escondendo o bug.
    const e = decideEventEffect({
      eventType: "PAYMENT_RECEIVED",
      invoiceStatus: "open",
    });
    expect(e.kind).toBe("activate_subscription");
  });

  it("is idempotent: the card's second event is a noop", () => {
    // Cartão emite CONFIRMED e depois RECEIVED (até ~30d). O primeiro marcou a
    // invoice como paid; o segundo não pode ativar de novo.
    const e = decideEventEffect({
      eventType: "PAYMENT_RECEIVED",
      invoiceStatus: "paid",
    });
    expect(e.kind).toBe("noop");
  });

  it("is idempotent for CONFIRMED arriving after paid", () => {
    const e = decideEventEffect({
      eventType: "PAYMENT_CONFIRMED",
      invoiceStatus: "paid",
    });
    expect(e.kind).toBe("noop");
  });

  it("activates on invoiceStatus: null — first-ever payment and monthly renewal alike", () => {
    // Fusão de dois testes que o Fix B (remoção de `subscriptionStatus` do
    // contrato) tornou idênticos: (a) primeiro pagamento de sempre, nenhuma
    // invoice ainda existe; (b) renovação mensal — `PAYMENT_CREATED` é
    // informativo (não cria invoice), então quando o `PAYMENT_RECEIVED` da
    // renovação chega, a busca por invoice correlacionada também dá `null`,
    // mesmo com assinatura já `active` de um ciclo anterior. Antes do Fix 1,
    // o código lia esse `invoiceStatus === null` combinado com
    // `subscriptionStatus === "active"` como "nada a fazer" (`noop`),
    // descartando silenciosamente um pagamento genuíno. Provado que
    // `decideEventEffect` nunca precisou de `subscriptionStatus` pra decidir
    // isso — o gate é binário sobre `invoiceStatus`, sem depender de
    // assinatura.
    const e = decideEventEffect({
      eventType: "PAYMENT_RECEIVED",
      invoiceStatus: null,
    });
    expect(e.kind).toBe("activate_subscription");
  });

  it("covers the previously untested invoice statuses on the activating path", () => {
    // 'void': terminal, mas é anomalia (pagamento sobre cobrança anulada) —
    // ainda assim não deve ativar de novo.
    expect(decideEventEffect({
      eventType: "PAYMENT_RECEIVED",
      invoiceStatus: "void",
    }).kind).toBe("noop");

    // 'draft': nunca é terminal — ativa normalmente.
    expect(decideEventEffect({
      eventType: "PAYMENT_RECEIVED",
      invoiceStatus: "draft",
    }).kind).toBe("activate_subscription");

    // 'uncollectible': DELIBERADAMENTE não é terminal — uma invoice baixada
    // como incobrável que acaba sendo paga deve restaurar o acesso, não ficar
    // presa em 'noop' pra sempre.
    expect(decideEventEffect({
      eventType: "PAYMENT_RECEIVED",
      invoiceStatus: "uncollectible",
    }).kind).toBe("activate_subscription");
  });

  it("gives a distinct reason for a payment landing on a void invoice", () => {
    // Fix 4: 'void' não é "duplicado ou tardio" (caminho feliz do cartão) —
    // é uma anomalia que precisa de conferência humana. A string de motivo
    // precisa refletir isso, não reusar a mensagem de duplicata benigna.
    const voidCase = decideEventEffect({
      eventType: "PAYMENT_RECEIVED",
      invoiceStatus: "void",
    });
    expect(voidCase.reason).toMatch(/void/);
    expect(voidCase.reason).toMatch(/conferência/);

    const paidCase = decideEventEffect({
      eventType: "PAYMENT_RECEIVED",
      invoiceStatus: "paid",
    });
    expect(paidCase.reason).toMatch(/duplicado ou tardio/);
  });
});

describe("decideEventEffect — demais eventos", () => {
  it("marks overdue on PAYMENT_OVERDUE", () => {
    expect(decideEventEffect({
      eventType: "PAYMENT_OVERDUE",
      invoiceStatus: "open",
    }).kind).toBe("mark_invoice_overdue");
  });

  it("does not re-mark an already paid invoice as overdue", () => {
    expect(decideEventEffect({
      eventType: "PAYMENT_OVERDUE",
      invoiceStatus: "paid",
    }).kind).toBe("noop");
  });

  it("marks overdue even with no correlated invoice row (Fix C — pinned, consumer treats as no-op)", () => {
    // Cobrança vencida no Asaas sem nenhuma invoice nossa correlacionada
    // (`invoiceStatus: null`). O contrato acima de `decideEventEffect` (item 3)
    // manda o consumidor tratar esse caso como no-op, não como erro: o
    // registro existe só do lado do Asaas, e é o `process-asaas-reconcile`
    // quem fecha essa lacuna depois — não este evento.
    expect(decideEventEffect({
      eventType: "PAYMENT_OVERDUE",
      invoiceStatus: null,
    }).kind).toBe("mark_invoice_overdue");
  });

  it("records refunds and chargebacks", () => {
    for (const ev of [
      "PAYMENT_REFUNDED",
      "PAYMENT_PARTIALLY_REFUNDED",
      "PAYMENT_REFUND_IN_PROGRESS",
      "PAYMENT_CHARGEBACK_REQUESTED",
      "PAYMENT_CHARGEBACK_DISPUTE",
      "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
    ]) {
      expect(decideEventEffect({
        eventType: ev,
        invoiceStatus: "paid",
      }).kind).toBe("record_refund");
    }
  });

  it("records a refund for PAYMENT_RECEIVED_IN_CASH_UNDONE (cash receipt reversed)", () => {
    expect(decideEventEffect({
      eventType: "PAYMENT_RECEIVED_IN_CASH_UNDONE",
      invoiceStatus: "paid",
    }).kind).toBe("record_refund");
  });

  it("treats PAYMENT_REFUND_DENIED as noop, not record_refund (the payment stands)", () => {
    expect(decideEventEffect({
      eventType: "PAYMENT_REFUND_DENIED",
      invoiceStatus: "paid",
    }).kind).toBe("noop");
  });

  it("treats informational payment events as noop, not unknown", () => {
    for (const ev of ["PAYMENT_CREATED", "PAYMENT_UPDATED", "PAYMENT_BANK_SLIP_VIEWED"]) {
      expect(decideEventEffect({
        eventType: ev,
        invoiceStatus: "open",
      }).kind).toBe("noop");
    }
  });

  it("returns unknown for an event outside the Asaas catalogue", () => {
    expect(decideEventEffect({
      eventType: "SOMETHING_NEW",
      invoiceStatus: null,
    }).kind).toBe("unknown");
  });

  it("does not match chargeback events by prefix", () => {
    // PAYMENT_AWAITING_CHARGEBACK_REVERSAL não começa com PAYMENT_CHARGEBACK_.
    // Um matcher por prefixo erraria justamente esse.
    expect(decideEventEffect({
      eventType: "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
      invoiceStatus: "paid",
    }).kind).toBe("record_refund");
  });

  it("always fills a reason for observability", () => {
    // Propriedade universal — testar com um único input não a prova. Cobre um
    // representante de cada branch de decideEventEffect (ativação, overdue,
    // estorno, informativo, desconhecido).
    const cases: Array<{ eventType: string; invoiceStatus: string | null }> = [
      { eventType: "PAYMENT_RECEIVED", invoiceStatus: "open" },
      { eventType: "PAYMENT_CONFIRMED", invoiceStatus: "paid" },
      { eventType: "PAYMENT_OVERDUE", invoiceStatus: "open" },
      { eventType: "PAYMENT_OVERDUE", invoiceStatus: "paid" },
      { eventType: "PAYMENT_REFUNDED", invoiceStatus: "paid" },
      { eventType: "PAYMENT_CREATED", invoiceStatus: null },
      { eventType: "SOMETHING_NEW", invoiceStatus: null },
    ];
    for (const c of cases) {
      const e = decideEventEffect(c);
      expect(e.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("decideEventEffect — catálogo Asaas completo", () => {
  // Guarda ESTRUTURAL pedida na revisão: enumera o catálogo real de
  // supabase/functions/_shared/asaas-core.ts (fonte única de nomes de evento)
  // em vez de re-derivar os Sets da própria implementação — isso não é
  // tautológico, e falha sozinho quando o Asaas adicionar um evento novo que
  // ninguém classificou ainda em asaas-billing-events.ts.
  const ALL_KNOWN_EVENTS = [
    ...ASAAS_PAYMENT_EVENTS,
    ...ASAAS_SUBSCRIPTION_EVENTS,
    ...ASAAS_CHECKOUT_EVENTS,
  ];

  it("has exactly 40 catalogued event names (29 + 7 + 4)", () => {
    // Sem essa asserção de tamanho, um catálogo vazio ou truncado faria o
    // teste abaixo passar por vacuidade sem checar nada de verdade.
    expect(ALL_KNOWN_EVENTS.length).toBe(40);
  });

  it("classifies every catalogued event to something other than 'unknown'", () => {
    for (const eventType of ALL_KNOWN_EVENTS) {
      const e = decideEventEffect({
        eventType,
        invoiceStatus: null,
      });
      expect(e.kind, `${eventType} deveria ter uma classificação conhecida`).not.toBe("unknown");
    }
  });
});

describe("catálogo REVERSO — todo ativador espelhado no short-circuit do webhook", () => {
  // O asaas-webhook chama `classifyAsaasEvent` (asaas-core) ANTES do aplicador:
  // evento 'unknown' vira `processing_status='ignored'` e o reconcile nunca o
  // revisita. Logo, TODO evento que `decideEventEffect` trate como ACIONÁVEL
  // (kind ≠ noop e ≠ unknown — ativação, estorno, overdue) TEM que estar no
  // catálogo do webhook; senão a ativação/estorno é perdida em silêncio.
  //
  // O teste acima cobre a direção catálogo → não-unknown. Este cobre a REVERSA.
  // Iterar SÓ o catálogo seria tautológico (todo evento do catálogo classifica
  // 'known' por construção, e um ativador novo adicionado só em
  // asaas-billing-events.ts nem entraria no corpus). Por isso o corpus UNE o
  // catálogo (importado de asaas-core, nunca redeclarado) aos sets acionáveis do
  // núcleo de decisão (ACTIVATING_EVENTS/REFUND_EVENTS, importados de
  // asaas-billing-events — não redeclarados). Assim, um ativador adicionado só em
  // asaas-billing-events.ts sem espelhar no catálogo entra no corpus e é
  // flagrado aqui. `PAYMENT_OVERDUE` (acionável inline) já vem via o catálogo.
  const corpus = new Set<string>([
    ...ASAAS_PAYMENT_EVENTS,
    ...ASAAS_SUBSCRIPTION_EVENTS,
    ...ASAAS_CHECKOUT_EVENTS,
    ...ACTIVATING_EVENTS,
    ...REFUND_EVENTS,
  ]);

  const actionable = [...corpus].filter((eventType) => {
    const kind = decideEventEffect({ eventType, invoiceStatus: null }).kind;
    return kind !== "noop" && kind !== "unknown";
  });

  it("encontra ao menos um evento acionável (guarda de não-vacuidade)", () => {
    // Sem esta guarda, um corpus vazio ou um decideEventEffect que nunca aciona
    // faria a asserção principal passar sem verificar nada.
    expect(actionable.length).toBeGreaterThan(0);
  });

  it("todo evento acionável está no catálogo do short-circuit (classifyAsaasEvent === 'known')", () => {
    for (const eventType of actionable) {
      // `classifyAsaasEvent` é EXATAMENTE o gate do asaas-webhook: 'known' ⟺ o
      // evento está num dos sets de asaas-core. Um ativador fora do catálogo
      // classifica 'unknown' aqui e derruba o teste.
      expect(
        classifyAsaasEvent(eventType),
        `${eventType} tem efeito acionável em decideEventEffect mas NÃO está no catálogo do webhook — o asaas-webhook o carimbaria 'ignored' e a ativação seria perdida`,
      ).toBe("known");
    }
  });
});
