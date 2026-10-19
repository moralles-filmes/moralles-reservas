import { describe, expect, it } from "vitest";
import {
  buildUpcomingDaysLines,
  WEEKDAY_NAMES_PT,
} from "../../supabase/functions/_shared/agent-calendar-core";

// Mesmo deslocamento que o webhook-whatsapp aplica ao instante UTC.
const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;
const brtFrom = (utcIso: string) => new Date(new Date(utcIso).getTime() - BRT_OFFSET_MS);

describe("buildUpcomingDaysLines", () => {
  it("devolve 8 linhas por padrão no formato esperado", () => {
    const lines = buildUpcomingDaysLines(brtFrom("2026-10-14T15:00:00Z"));
    expect(lines).toHaveLength(8);
    expect(lines).toEqual([
      "- hoje: quarta-feira, 14/10",
      "- amanhã: quinta-feira, 15/10",
      "- sexta-feira, 16/10",
      "- sábado, 17/10",
      "- domingo, 18/10",
      "- segunda-feira, 19/10",
      "- terça-feira, 20/10",
      "- quarta-feira, 21/10",
    ]);
  });

  it("respeita o parâmetro days", () => {
    expect(buildUpcomingDaysLines(brtFrom("2026-10-14T15:00:00Z"), 3)).toHaveLength(3);
  });

  it("vira o mês (31/10 -> 01/11)", () => {
    const lines = buildUpcomingDaysLines(brtFrom("2026-10-31T15:00:00Z"));
    expect(lines[0]).toBe("- hoje: sábado, 31/10");
    expect(lines[1]).toBe("- amanhã: domingo, 01/11");
    expect(lines[2]).toBe("- segunda-feira, 02/11");
  });

  it("vira o ano (31/12 -> 01/01)", () => {
    const lines = buildUpcomingDaysLines(brtFrom("2026-12-31T15:00:00Z"));
    expect(lines[0]).toBe("- hoje: quinta-feira, 31/12");
    expect(lines[1]).toBe("- amanhã: sexta-feira, 01/01");
  });

  it("passa por 29/02 em ano bissexto", () => {
    const lines = buildUpcomingDaysLines(brtFrom("2028-02-28T15:00:00Z"));
    expect(lines[0]).toBe("- hoje: segunda-feira, 28/02");
    expect(lines[1]).toBe("- amanhã: terça-feira, 29/02");
    expect(lines[2]).toBe("- quarta-feira, 01/03");
  });

  it("não cria 29/02 em ano não bissexto", () => {
    const lines = buildUpcomingDaysLines(brtFrom("2027-02-28T15:00:00Z"));
    expect(lines[1]).toBe("- amanhã: segunda-feira, 01/03");
  });

  it("22h BRT (já é o dia seguinte em UTC) continua no dia BRT correto", () => {
    // 2026-10-15T01:00:00Z = 14/10 22:00 BRT
    const lines = buildUpcomingDaysLines(brtFrom("2026-10-15T01:00:00Z"));
    expect(lines[0]).toBe("- hoje: quarta-feira, 14/10");
    expect(lines[1]).toBe("- amanhã: quinta-feira, 15/10");
  });

  it("exporta os nomes de dia começando no domingo", () => {
    expect(WEEKDAY_NAMES_PT).toHaveLength(7);
    expect(WEEKDAY_NAMES_PT[0]).toBe("domingo");
    expect(WEEKDAY_NAMES_PT[6]).toBe("sábado");
  });
});
