import { describe, expect, it } from "vitest";
import { fetchAllPages } from "./fetch-all-pages";

describe("fetchAllPages", () => {
  it("2500 linhas: 3 chamadas com os ranges certos", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => i);
    const calls: Array<[number, number]> = [];
    const out = await fetchAllPages<number>(async (from, to) => {
      calls.push([from, to]);
      return { data: rows.slice(from, to + 1), error: null };
    });
    expect(out).toHaveLength(2500);
    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("erro na 2ª página lança", async () => {
    const boom = new Error("falhou");
    let n = 0;
    await expect(
      fetchAllPages<number>(async () => {
        n += 1;
        if (n === 2) return { data: null, error: boom };
        return { data: Array.from({ length: 1000 }, (_, i) => i), error: null };
      }),
    ).rejects.toBe(boom);
  });

  it("página cheia seguida de vazia termina", async () => {
    let n = 0;
    const out = await fetchAllPages<number>(async () => {
      n += 1;
      return { data: n === 1 ? Array.from({ length: 1000 }, (_, i) => i) : [], error: null };
    });
    expect(out).toHaveLength(1000);
    expect(n).toBe(2);
  });
});
