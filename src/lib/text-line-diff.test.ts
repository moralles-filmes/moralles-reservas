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
