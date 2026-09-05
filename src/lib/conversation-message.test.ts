import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "@/types/reserva";
import {
  getConversationMessageAuthorLabel,
  sortConversationMessages,
} from "./conversation-message";

function message(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    role: "user",
    content: "Mensagem",
    timestamp: "2026-09-05T15:00:00.000Z",
    ...overrides,
  };
}

describe("getConversationMessageAuthorLabel", () => {
  it.each([
    ["customer", "Cliente"],
    ["ai", "IA"],
    ["automation", "Automação"],
    ["human", "Atendente"],
  ] as const)("mostra autoria explícita %s", (author, label) => {
    expect(getConversationMessageAuthorLabel(message({ author }))).toBe(label);
  });

  it("identifica kind como automação com seu rótulo", () => {
    expect(getConversationMessageAuthorLabel(message({
      role: "assistant",
      author: "ai",
      kind: "confirmation",
    }))).toBe("Automação · Confirmação");
  });

  it("não inventa IA para assistant legado sem author ou kind", () => {
    expect(getConversationMessageAuthorLabel(message({ role: "assistant" })))
      .toBe("IA/Automação (legado)");
  });

  it("mantém rótulos inequívocos dos roles humanos legados", () => {
    expect(getConversationMessageAuthorLabel(message({ role: "user" }))).toBe("Cliente");
    expect(getConversationMessageAuthorLabel(message({ role: "human" }))).toBe("Atendente");
  });
});

describe("sortConversationMessages", () => {
  it("ordena por timestamp, preserva empates e não muta o array recebido", () => {
    const firstAtTen = message({ content: "dez-1", timestamp: "2026-09-05T10:00:00.000Z" });
    const invalid = message({ content: "sem-data", timestamp: "inválido" });
    const atNine = message({ content: "nove", timestamp: "2026-09-05T09:00:00.000Z" });
    const secondAtTen = message({ content: "dez-2", timestamp: "2026-09-05T10:00:00.000Z" });
    const input = Object.freeze([firstAtTen, invalid, atNine, secondAtTen]);

    const sorted = sortConversationMessages(input);

    expect(sorted.map((item) => item.content)).toEqual(["nove", "dez-1", "dez-2", "sem-data"]);
    expect(input.map((item) => item.content)).toEqual(["dez-1", "sem-data", "nove", "dez-2"]);
    expect(sorted).not.toBe(input);
  });
});
