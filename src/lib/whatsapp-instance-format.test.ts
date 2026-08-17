import { describe, it, expect } from "vitest";
import { COST_SOURCES } from "../../supabase/functions/_shared/whatsapp-instance-core";
import { INSTANCE_NOTE_ACTIONS } from "../../supabase/functions/_shared/whatsapp-instance-notes-core";
import {
  formatCents,
  formatMargin,
  lastAccessDayLabel,
  cycleSourceLabel,
  divergenceLabel,
  COST_SOURCE_OPTIONS,
  costSourceLabel,
  instanceNoteActionLabel,
  setCostToast,
  setCostToastFromResponse,
  confirmEndToast,
  confirmEndToastFromResponse,
  conflictLifecycleLabel,
} from "./whatsapp-instance-format";

describe("formatCents — desconhecido nunca vira R$ 0,00", () => {
  it("valor conhecido", () => {
    expect(formatCents(14900)).toMatch(/149,00/);
  });
  it("zero é zero de verdade", () => {
    expect(formatCents(0)).toMatch(/0,00/);
  });
  it("desconhecido é travessão", () => {
    expect(formatCents(null)).toBe("—");
  });
});

describe("formatMargin — nunca 0% para desconhecido", () => {
  it("receita positiva mostra percentual", () => {
    expect(formatMargin(14900, 10000)).toBe("32,9%");
  });
  it("receita zero é 'não aplicável', não 0%", () => {
    expect(formatMargin(0, 10000)).toBe("não aplicável");
  });
  it("receita desconhecida é 'pendente'", () => {
    expect(formatMargin(null, 10000)).toBe("pendente");
  });
  it("custo desconhecido é 'pendente'", () => {
    expect(formatMargin(14900, null)).toBe("pendente");
  });
});

describe("lastAccessDayLabel — provider_access_until é EXCLUSIVO", () => {
  it("o último dia de acesso real é a véspera", () => {
    expect(lastAccessDayLabel("2026-09-01")).toBe("31/08/2026");
  });
  it("atravessa mês e ano corretamente", () => {
    expect(lastAccessDayLabel("2027-01-01")).toBe("31/12/2026");
  });
  it("atravessa o fim de fevereiro bissexto", () => {
    expect(lastAccessDayLabel("2028-03-01")).toBe("29/02/2028");
  });
  it("sem data não inventa rótulo", () => {
    expect(lastAccessDayLabel(null)).toBeNull();
  });
});

describe("cycleSourceLabel — UNKNOWN nunca parece uma data confirmada", () => {
  it("UNKNOWN é explícito sobre a pendência", () => {
    expect(cycleSourceLabel("UNKNOWN")).toBe("data não confirmada");
  });
  it("confirmado pelo admin", () => {
    expect(cycleSourceLabel("ADMIN_CONFIRMED")).toBe("confirmada pelo administrador");
  });
  it("rolagem do sistema", () => {
    expect(cycleSourceLabel("SYSTEM_ROLLED")).toBe("rolagem automática");
  });
});

describe("divergenceLabel — nenhuma copy afirma cobrança do fornecedor", () => {
  const kinds = [
    "CHANNEL_WITHOUT_INSTANCE",
    "PAYING_WITHOUT_CHANNEL",
    "INSTANCE_REF_MISMATCH",
    "LIFECYCLE_VS_CHANNEL_STATE",
    "ALIVE_AFTER_END",
  ];

  it("os cinco tipos têm rótulo", () => {
    for (const k of kinds) expect(divergenceLabel(k)).not.toBe(k);
  });

  it("nenhum rótulo afirma que a Z-API continua cobrando", () => {
    for (const k of kinds) {
      expect(divergenceLabel(k)).not.toMatch(/continua cobrando|segue cobrando/i);
    }
  });

  it("tipo desconhecido cai no próprio código, sem inventar texto", () => {
    expect(divergenceLabel("QUALQUER_COISA")).toBe("QUALQUER_COISA");
  });
});

/**
 * Acoplamento nas DUAS direções, como o teste dos `event_type` da 6b.
 *
 * Só "toda constante tem rótulo" deixaria passar rótulo órfão — o resto de uma
 * constante removida, que continua oferecendo no `<select>` um valor que a EF
 * recusa com 400. As duas perguntas são independentes e as duas importam.
 */
describe("rótulos de COST_SOURCES", () => {
  it("toda constante do núcleo tem rótulo em português", () => {
    for (const source of COST_SOURCES) {
      const label = costSourceLabel(source);
      expect(label).not.toBe(source);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("nenhum rótulo sobra sem constante correspondente", () => {
    const canonical = new Set<string>(COST_SOURCES as readonly string[]);
    for (const opt of COST_SOURCE_OPTIONS) expect(canonical.has(opt.value)).toBe(true);
  });

  it("as opções do select cobrem exatamente o núcleo, sem faltar nem sobrar", () => {
    expect(COST_SOURCE_OPTIONS.map((o) => o.value).sort()).toEqual(
      [...COST_SOURCES].sort(),
    );
  });

  it("valor desconhecido volta como ele mesmo, sem quebrar a tela", () => {
    expect(costSourceLabel("QUALQUER_COISA")).toBe("QUALQUER_COISA");
  });

  it("custo sem procedência não inventa rótulo", () => {
    expect(costSourceLabel(null)).toBe("—");
  });
});

describe("rótulos das ações do ledger de observações", () => {
  it("toda ação canônica tem rótulo em português", () => {
    for (const action of INSTANCE_NOTE_ACTIONS) {
      const label = instanceNoteActionLabel(action);
      expect(label).not.toBe(action);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("ação desconhecida volta como ela mesma", () => {
    expect(instanceNoteActionLabel("ACKNOWLEDGE_ALERT")).toBe("ACKNOWLEDGE_ALERT");
  });
});

describe("copy do toast — a tela não afirma o que não sabe", () => {
  it("custo aplicado ao ciclo aberto", () => {
    expect(setCostToast({ filled: true, hasOpenCycle: true })).toBe(
      "Custo atualizado e aplicado ao ciclo em aberto.",
    );
  });

  it("ciclo aberto existe mas não mudou", () => {
    expect(setCostToast({ filled: false, hasOpenCycle: true })).toBe(
      "Custo atualizado na instância. O ciclo em aberto não mudou.",
    );
  });

  it("não há ciclo aberto", () => {
    expect(setCostToast({ filled: false, hasOpenCycle: false })).toBe(
      "Custo atualizado na instância. Não há ciclo em aberto.",
    );
  });

  it("a EF não disse se há ciclo aberto: NÃO afirma nada sobre o ciclo", () => {
    // Janela de deploy (EF antiga, frontend novo). Tratar ausente como `false`
    // faria a tela afirmar "não há ciclo em aberto" sem saber — o mesmo defeito
    // que este item fecha, por outra porta.
    const msg = setCostToast({ filled: false, hasOpenCycle: null });
    expect(msg).toBe("Custo atualizado na instância.");
    expect(msg).not.toMatch(/ciclo/);
  });

  it("filled=true vence mesmo com hasOpenCycle desconhecido", () => {
    // `filled` só pode ser true se havia ciclo aberto — é fato próprio.
    expect(setCostToast({ filled: true, hasOpenCycle: null })).toBe(
      "Custo atualizado e aplicado ao ciclo em aberto.",
    );
  });

  it("encerramento com o último ciclo fechado", () => {
    expect(confirmEndToast("CLOSED")).toBe(
      "Encerramento confirmado. O último ciclo foi fechado.",
    );
  });

  it("encerramento com o último ciclo sem custo aponta a tarefa pendente", () => {
    expect(confirmEndToast("PENDING_REVIEW")).toBe(
      "Encerramento confirmado. O último ciclo fechou sem custo — informe o valor em Ciclos e margem.",
    );
  });

  it("encerramento sem ciclo aberto", () => {
    expect(confirmEndToast(null)).toBe(
      "Encerramento confirmado. Não havia ciclo em aberto.",
    );
  });

  it("lê a resposta da EF sem confiar no formato", () => {
    expect(setCostToastFromResponse({ cycle_filled: true, has_open_cycle: true })).toBe(
      "Custo atualizado e aplicado ao ciclo em aberto.",
    );
    expect(setCostToastFromResponse({ cycle_filled: false, has_open_cycle: false })).toBe(
      "Custo atualizado na instância. Não há ciclo em aberto.",
    );
    // EF antiga: `has_open_cycle` ausente.
    expect(setCostToastFromResponse({ cycle_filled: false })).toBe(
      "Custo atualizado na instância.",
    );
    expect(setCostToastFromResponse(null)).toBe("Custo atualizado na instância.");

    expect(confirmEndToastFromResponse({ closed_cycle_status: "PENDING_REVIEW" })).toMatch(
      /sem custo/,
    );
    expect(confirmEndToastFromResponse({})).toBe(
      "Encerramento confirmado. Não havia ciclo em aberto.",
    );
    expect(confirmEndToastFromResponse(undefined)).toBe(
      "Encerramento confirmado. Não havia ciclo em aberto.",
    );
  });
});

describe("conflictLifecycleLabel — AWAITING_PROVISION nunca é 'ativa'", () => {
  it("cancelamento solicitado diz que ainda custa", () => {
    expect(conflictLifecycleLabel("CANCELLATION_REQUESTED")).toBe(
      "cancelamento solicitado (ainda custa)",
    );
  });

  it("aguardando provisionamento NÃO é rotulada como ativa", () => {
    // A forma antiga era um ternário contra CANCELLATION_REQUESTED com "ativa"
    // no else — e o operador está decidindo se aceita pagar uma segunda
    // instância, então o rótulo pesa numa decisão que custa dinheiro.
    const label = conflictLifecycleLabel("AWAITING_PROVISION");
    expect(label).toBe("aguardando provisionamento");
    expect(label).not.toBe("ativa");
  });

  it("ativa é ativa", () => {
    expect(conflictLifecycleLabel("ACTIVE")).toBe("ativa");
  });

  it("estado desconhecido volta como ele mesmo, sem inventar rótulo", () => {
    expect(conflictLifecycleLabel("QUALQUER_COISA")).toBe("QUALQUER_COISA");
  });
});
