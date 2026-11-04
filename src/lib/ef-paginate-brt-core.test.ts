import { describe, expect, it } from "vitest";
import {
  calendarDayDiff,
  daysUntilBirthdayBrt,
  todayBrtIso,
} from "../../supabase/functions/_shared/brt-date-core";
import { chunk, fetchAllByIdKeyset, fetchAllPages as efFetchAllPages } from "../../supabase/functions/_shared/paginate-core";
import { fetchAllPages as clientFetchAllPages } from "./fetch-all-pages";

const at = (iso: string) => Date.parse(iso);

describe("brt-date-core", () => {
  it("hoje em BRT não vira o dia seguinte das 21h à meia-noite", () => {
    expect(todayBrtIso(at("2026-11-04T23:30:00-03:00"))).toBe("2026-11-04");
    expect(todayBrtIso(at("2026-11-05T00:00:00-03:00"))).toBe("2026-11-05");
    expect(todayBrtIso(at("2026-11-04T00:10:00-03:00"))).toBe("2026-11-04");
  });

  it("calendarDayDiff conta dias de calendário", () => {
    expect(calendarDayDiff("2026-11-04", "2026-11-04")).toBe(0);
    expect(calendarDayDiff("2026-11-04", "2026-12-04")).toBe(30);
    expect(calendarDayDiff("2026-12-31", "2027-01-01")).toBe(1);
    expect(calendarDayDiff("2026-11-04", "2026-11-03")).toBe(-1);
  });

  it("aniversário hoje em BRT às 22h (UTC já é amanhã)", () => {
    const now = at("2026-11-04T22:00:00-03:00");
    expect(daysUntilBirthdayBrt("1990-11-04", now)).toBe(0);
    expect(daysUntilBirthdayBrt("1990-11-05", now)).toBe(1);
  });

  it("aniversário nos próximos dias e virada de ano", () => {
    const now = at("2026-12-29T10:00:00-03:00");
    expect(daysUntilBirthdayBrt("1990-01-02", now)).toBe(4);
    expect(daysUntilBirthdayBrt("1990-12-28", now)).toBe(364);
  });

  it("29/02 cai em 28/02 em ano não-bissexto (mesma regra do cron)", () => {
    expect(daysUntilBirthdayBrt("2000-02-29", at("2027-02-28T09:00:00-03:00"))).toBe(0);
    expect(daysUntilBirthdayBrt("2000-02-29", at("2028-02-29T09:00:00-03:00"))).toBe(0);
    expect(daysUntilBirthdayBrt("2000-02-29", at("2027-02-25T09:00:00-03:00"))).toBe(3);
  });

  it("data inválida devolve null", () => {
    expect(daysUntilBirthdayBrt("", at("2026-11-04T12:00:00Z"))).toBeNull();
    expect(daysUntilBirthdayBrt("1990-13-01", at("2026-11-04T12:00:00Z"))).toBeNull();
  });
});

function pagedSource(total: number) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
  const calls: [number, number][] = [];
  const build = async (from: number, to: number) => {
    calls.push([from, to]);
    return { data: rows.slice(from, to + 1), error: null };
  };
  return { build, calls };
}

describe("paginate-core (gêmeo de src/lib/fetch-all-pages.ts)", () => {
  it.each([0, 999, 1000, 2500])("lê %i linhas inteiras, igual ao gêmeo do cliente", async (total) => {
    const ef = pagedSource(total);
    const client = pagedSource(total);
    const efRows = await efFetchAllPages(ef.build);
    const clientRows = await clientFetchAllPages(client.build);
    expect(efRows).toHaveLength(total);
    expect(efRows).toEqual(clientRows);
    expect(ef.calls).toEqual(client.calls);
  });

  it("erro em qualquer página sobe, sem resultado parcial", async () => {
    let n = 0;
    const build = async (from: number, to: number) => {
      n++;
      if (n === 2) return { data: null, error: { message: "boom" } };
      return { data: Array.from({ length: to - from + 1 }, (_, i) => from + i), error: null };
    };
    await expect(efFetchAllPages(build)).rejects.toEqual({ message: "boom" });
  });

  it("keyset lê tudo, para na página vazia e não depende de max_rows", async () => {
    const ids = Array.from({ length: 2300 }, (_, i) => ({ id: `id-${String(i).padStart(5, "0")}` }));
    // Servidor com max_rows=500 (< pageSize): offset pararia na 1ª página.
    const build = async (afterId: string | null, limit: number) => {
      const rest = afterId ? ids.filter((r) => r.id > afterId) : ids;
      return { data: rest.slice(0, Math.min(limit, 500)), error: null };
    };
    const rows = await fetchAllByIdKeyset(build, 1000);
    expect(rows.map((r) => r.id)).toEqual(ids.map((r) => r.id));
  });

  it("keyset não repete nem pula linha quando outra escrita entra entre páginas", async () => {
    const live = Array.from({ length: 1500 }, (_, i) => ({ id: `id-${String(i * 2).padStart(5, "0")}` }));
    let page = 0;
    const build = async (afterId: string | null, limit: number) => {
      if (page++ === 1) live.unshift({ id: "id-00000a" }); // entra antes do cursor
      const sorted = [...live].sort((a, b) => (a.id < b.id ? -1 : 1));
      const rest = afterId ? sorted.filter((r) => r.id > afterId) : sorted;
      return { data: rest.slice(0, limit), error: null };
    };
    const rows = await fetchAllByIdKeyset(build, 1000);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(rows).toHaveLength(1500);
  });

  it("keyset propaga erro", async () => {
    const build = async () => ({ data: null, error: { message: "boom" } });
    await expect(fetchAllByIdKeyset(build)).rejects.toEqual({ message: "boom" });
  });

  it("chunk divide em lotes e recusa tamanho inválido", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 200)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow();
  });
});
