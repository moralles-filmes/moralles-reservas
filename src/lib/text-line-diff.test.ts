import { describe, expect, it } from "vitest";
import { diffLines } from "./text-line-diff";

describe("diffLines", () => {
  it("textos iguais: tudo same", () => {
    expect(diffLines("a\nb", "a\nb")).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
    ]);
  });

  it("linha inserida", () => {
    expect(diffLines("a\nc", "a\nb\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "add", text: "b" },
      { kind: "same", text: "c" },
    ]);
  });

  it("linha removida", () => {
    expect(diffLines("a\nb\nc", "a\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "same", text: "c" },
    ]);
  });

  it("troca de linha vira remove seguido de add, na posição", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
    ]);
  });

  it("vazio dos dois lados não tem linhas", () => {
    expect(diffLines("", "")).toEqual([]);
  });

  it("vazio de um lado: tudo add ou tudo remove", () => {
    expect(diffLines("", "a\nb")).toEqual([
      { kind: "add", text: "a" },
      { kind: "add", text: "b" },
    ]);
    expect(diffLines("a\nb", "")).toEqual([
      { kind: "remove", text: "a" },
      { kind: "remove", text: "b" },
    ]);
  });

  it("linhas que diferem só no espaço são linhas diferentes", () => {
    expect(diffLines("a\n b", "a\nb")).toEqual([
      { kind: "same", text: "a" },
      { kind: "remove", text: " b" },
      { kind: "add", text: "b" },
    ]);
  });

  it("tolera \r\n sem marcar linha inteira como mudada", () => {
    expect(diffLines("a\r\nb", "a\nb").every((l) => l.kind === "same")).toBe(true);
  });

  it("preserva linhas em branco e a ordem com linhas repetidas", () => {
    expect(diffLines("a\n\na", "a\n\nb\na")).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "" },
      { kind: "add", text: "b" },
      { kind: "same", text: "a" },
    ]);
  });
});

describe("diffLines — texto grande com edição pequena", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `linha ${i}`);

  it("10000 linhas iguais com uma trocada no meio: resultado correto e rápido (prefixo/sufixo)", () => {
    const before = lines(10000);
    const after = [...before];
    after[5000] = "TROCADA";
    const t0 = performance.now();
    const diff = diffLines(before.join("\n"), after.join("\n"));
    const ms = performance.now() - t0;
    expect(diff).toHaveLength(10001);
    expect(diff[4999]).toEqual({ kind: "same", text: "linha 4999" });
    expect(diff[5000]).toEqual({ kind: "remove", text: "linha 5000" });
    expect(diff[5001]).toEqual({ kind: "add", text: "TROCADA" });
    expect(diff[5002]).toEqual({ kind: "same", text: "linha 5001" });
    expect(diff.filter((l) => l.kind !== "same")).toHaveLength(2);
    expect(ms).toBeLessThan(100);
  });

  it("prefixo e sufixo comuns com miolo diferente nos dois lados", () => {
    expect(diffLines("a\nb\nc\nd", "a\nX\nY\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "remove", text: "c" },
      { kind: "add", text: "X" },
      { kind: "add", text: "Y" },
      { kind: "same", text: "d" },
    ]);
  });

  it("um texto contido no outro (só prefixo ou só sufixo em comum)", () => {
    expect(diffLines("a\nb", "a\nb\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
      { kind: "add", text: "c" },
    ]);
    expect(diffLines("b\nc", "a\nb\nc")).toEqual([
      { kind: "add", text: "a" },
      { kind: "same", text: "b" },
      { kind: "same", text: "c" },
    ]);
  });
});

describe("diffLines — tamanho máximo do corpo (4000 caracteres = 4001 linhas)", () => {
  it("4001 linhas todas diferentes dos dois lados: LCS cabe no contador e o resultado é completo", () => {
    const before = Array.from({ length: 4001 }, () => "").join("\n");
    const after = Array.from({ length: 4001 }, (_, i) => `x${i}`).join("\n");
    const diff = diffLines(before, after);
    expect(diff.filter((l) => l.kind === "remove")).toHaveLength(4001);
    expect(diff.filter((l) => l.kind === "add")).toHaveLength(4001);
    expect(diff.filter((l) => l.kind === "same")).toHaveLength(0);
  });

  it("4001 linhas com metade em comum alternada: LCS correto", () => {
    const before = Array.from({ length: 4001 }, (_, i) => (i % 2 === 0 ? "a" : `b${i}`)).join("\n");
    const after = Array.from({ length: 4001 }, (_, i) => (i % 2 === 0 ? "a" : `c${i}`)).join("\n");
    const diff = diffLines(before, after);
    expect(diff.filter((l) => l.kind === "same")).toHaveLength(2001);
    expect(diff.filter((l) => l.kind === "remove")).toHaveLength(2000);
    expect(diff.filter((l) => l.kind === "add")).toHaveLength(2000);
  });
});
