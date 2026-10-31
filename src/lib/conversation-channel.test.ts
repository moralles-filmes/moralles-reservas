// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countByChannel,
  filterByChannel,
  readChannelFilter,
  writeChannelFilter,
  type ChannelFilter,
} from "./conversation-channel";
import { getConversationDisplayName } from "./utils";

const KEY = "conversas-channel-filter";
const wa = { id: "1", channel: "whatsapp" as const };
const ig = { id: "2", channel: "instagram" as const };
const legacy = { id: "3" } as { id: string; channel?: "whatsapp" | "instagram" };

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("filterByChannel / countByChannel", () => {
  const list = [wa, ig, ig, legacy];
  it("all devolve tudo; sem channel conta como whatsapp", () => {
    expect(filterByChannel(list, "all")).toHaveLength(4);
    expect(filterByChannel(list, "whatsapp").map((c) => c.id)).toEqual(["1", "3"]);
    expect(filterByChannel(list, "instagram")).toHaveLength(2);
  });
  it("contagens por canal", () => {
    expect(countByChannel(list)).toEqual({ all: 4, whatsapp: 2, instagram: 2 });
    expect(countByChannel([])).toEqual({ all: 0, whatsapp: 0, instagram: 0 });
  });
});

describe("persistência do filtro", () => {
  it("grava e lê", () => {
    writeChannelFilter("instagram");
    expect(localStorage.getItem(KEY)).toBe("instagram");
    expect(readChannelFilter()).toBe("instagram");
  });
  it("valor inválido ou ausente vira all", () => {
    expect(readChannelFilter()).toBe("all");
    localStorage.setItem(KEY, "telegram");
    expect(readChannelFilter()).toBe("all");
  });
  it("localStorage que lança não quebra leitura nem escrita", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readChannelFilter()).toBe("all");
    expect(() => writeChannelFilter("whatsapp" as ChannelFilter)).not.toThrow();
  });
});

describe("getConversationDisplayName: 6 ordens", () => {
  const igContact = { username: "maria_ig", name: "Maria IG" };
  it("1. nome do cliente (diferente do telefone)", () => {
    expect(getConversationDisplayName({ channel: "instagram", contact_name: "Perfil", instagram_contact: igContact, customer: { name: "Maria Cliente", phone: "11999999999" } })).toBe("Maria Cliente");
  });
  it("2. contact_name quando o cliente só tem o telefone como nome", () => {
    expect(getConversationDisplayName({ channel: "instagram", contact_name: "Perfil", instagram_contact: igContact, customer: { name: "11999999999", phone: "11999999999" } })).toBe("Perfil");
  });
  it("3. @username do contato do Instagram", () => {
    expect(getConversationDisplayName({ channel: "instagram", contact_name: null, instagram_contact: { username: "maria_ig", name: null }, customer: null })).toBe("@maria_ig");
  });
  it("4. telefone formatado", () => {
    expect(getConversationDisplayName({ channel: "whatsapp", contact_name: null, customer: { name: null, phone: "11999999999" } })).toBe("(11) 99999-9999");
  });
  it("5. fallback do Instagram", () => {
    expect(getConversationDisplayName({ channel: "instagram", contact_name: null, instagram_contact: { username: null, name: null }, customer: null })).toBe("Contato do Instagram");
  });
  it("6. fallback do WhatsApp", () => {
    expect(getConversationDisplayName({ channel: "whatsapp", contact_name: null, customer: null })).toBe("Cliente sem nome");
    expect(getConversationDisplayName({ contact_name: "  ", customer: null })).toBe("Cliente sem nome");
  });
});
