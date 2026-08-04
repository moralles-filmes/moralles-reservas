import { describe, it, expect } from "vitest";
import {
  formatCents,
  formatMargin,
  lastAccessDayLabel,
  cycleSourceLabel,
  divergenceLabel,
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
