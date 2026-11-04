import { describe, expect, it } from "vitest";
import { conversationHref } from "./conversation-link";

describe("conversationHref", () => {
  it("codifica o id do cliente", () => {
    expect(conversationHref("/o/moralles-centro", "a b")).toBe("/o/moralles-centro/conversas?cliente=a%20b");
  });
  it("funciona com /g/", () => {
    expect(conversationHref("/g/x", "123")).toBe("/g/x/conversas?cliente=123");
  });
});
