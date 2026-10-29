import { describe, expect, it } from "vitest";
import { normalizeNewlines } from "./text-normalize";

describe("normalizeNewlines", () => {
  it("troca \r\n por \n", () => {
    expect(normalizeNewlines("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  it("troca \r solto por \n", () => {
    expect(normalizeNewlines("a\rb")).toBe("a\nb");
  });

  it("não duplica quebra em \r\r\n misto", () => {
    expect(normalizeNewlines("a\r\r\nb")).toBe("a\n\nb");
  });

  it("texto sem \r volta igual", () => {
    expect(normalizeNewlines("a\nb\n\nc")).toBe("a\nb\n\nc");
    expect(normalizeNewlines("")).toBe("");
  });
});
