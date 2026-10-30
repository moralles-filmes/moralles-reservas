// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INSTAGRAM_CONTACT_RATE_LIMIT,
  INSTAGRAM_PROCESSED_RETENTION_DAYS,
  RESERVATION_LIMIT_ERROR_CODE,
  extractAccountItems,
  ignoredOutcome,
  instagramRateLimitKey,
  isEchoOwn,
  mapContactReservationRpc,
  sendInstagramParts,
  buildInstagramConversationMessage,
  conversationTimestamp,
  instagramInboundEventId,
  recordedMessageOutcome,
  safeErrorLabel,
  INSTAGRAM_LINK_CHANGES_MAX,
  INSTAGRAM_LINK_CHANGES_WINDOW_DAYS,
  linkChangeCapReached,
} from "../../supabase/functions/_shared/instagram-inbound-core.ts";
import { cleanInstagramProfileName } from "../../supabase/functions/_shared/instagram-format.ts";
import { isOrgBillingBlocked } from "../../supabase/functions/_shared/org-billing-gate-core.ts";
import { buildAgentUnit } from "../../supabase/functions/_shared/agent/unit-context.ts";
import { MEDIA_REPLY_TEXT } from "../../supabase/functions/_shared/media-reply-text.ts";

/**
 * Núcleo do worker do Direct (Task 4.1): classificação dos itens do corpo
 * guardado na fila, eco próprio, envio dividido que nunca lança, mapeamento da
 * RPC atômica de reserva e os predicados compartilhados com o WhatsApp.
 */

const ME = "17841400000000001";
const OTHER = "17841400000000002";

const msg = (over: Record<string, unknown>, ts = 1000, sender = "555", recipient = ME) => ({
  sender: { id: sender }, recipient: { id: recipient }, timestamp: ts, ...over,
});
const body = (...entries: unknown[]) => ({ object: "instagram", entry: entries });

describe("extractAccountItems", () => {
  it("corpo com duas contas devolve só as da conta pedida", () => {
    const b = body(
      { id: ME, time: 1, messaging: [msg({ message: { mid: "m-me", text: "oi" } })] },
      { id: OTHER, time: 1, messaging: [msg({ message: { mid: "m-other", text: "oi" } }, 1000, "777", OTHER)] },
    );
    expect(extractAccountItems(b, ME)).toEqual([
      { kind: "text", mid: "m-me", igsid: "555", text: "oi", timestamp: 1000 },
    ]);
    expect(extractAccountItems(b, OTHER).map((i) => (i as { mid: string }).mid)).toEqual(["m-other"]);
  });

  it("fora de ordem sai ordenado por timestamp (também entre entradas da mesma conta)", () => {
    const b = body(
      { id: ME, messaging: [msg({ message: { mid: "c", text: "3" } }, 3000), msg({ message: { mid: "a", text: "1" } }, 1000)] },
      { id: ME, messaging: [msg({ message: { mid: "b", text: "2" } }, 2000)] },
    );
    expect(extractAccountItems(b, ME).map((i) => (i as { mid: string }).mid)).toEqual(["a", "b", "c"]);
  });

  it("classifica eco, self, story_mention, media, deleted, unsupported, reply_to e não-mensagem", () => {
    const b = body({
      id: ME,
      messaging: [
        msg({ message: { mid: "echo", text: "resp", is_echo: true } }, 1, ME, "555"),
        msg({ message: { mid: "self", text: "x" } }, 2, ME, "555"),
        msg({ message: { mid: "story", attachments: [{ type: "story_mention", payload: { url: "https://cdn.invalid/s" } }] } }, 3),
        msg({ message: { mid: "img", attachments: [{ type: "image", payload: { url: "https://cdn.invalid/i" } }] } }, 4),
        msg({ message: { mid: "del", is_deleted: true } }, 5),
        msg({ message: { mid: "unsup", is_unsupported: true } }, 6),
        msg({ message: { mid: "reply", text: "que lindo", reply_to: { story: { id: "s1", url: "https://cdn.invalid/s" } } } }, 7),
        msg({ read: { mid: "lido" } }, 8),
        msg({ message: { mid: "mix", attachments: [{ type: "story_mention" }, { type: "image" }] } }, 9),
        msg({ message: { mid: "vazio" } }, 10),
      ],
    });
    expect(extractAccountItems(b, ME)).toEqual([
      { kind: "echo", mid: "echo", igsid: "555", timestamp: 1 },
      { kind: "ignored", mid: "self", reason: "self" },
      { kind: "story_mention", mid: "story", igsid: "555", timestamp: 3 },
      { kind: "media", mid: "img", igsid: "555", timestamp: 4 },
      { kind: "ignored", mid: "del", reason: "deleted" },
      { kind: "ignored", mid: "unsup", reason: "unsupported" },
      { kind: "text", mid: "reply", igsid: "555", text: "que lindo", timestamp: 7 },
      { kind: "ignored", mid: null, reason: "non_message" },
      { kind: "media", mid: "mix", igsid: "555", timestamp: 9 },
      { kind: "ignored", mid: "vazio", reason: "unsupported" },
    ]);
  });

  it("ids numéricos só se forem inteiros seguros; mid ou remetente faltando é malformed", () => {
    const b = body({
      id: Number(ME.slice(0, 15)),
      messaging: [msg({ message: { mid: "n", text: "a" } }, 1, 12345 as unknown as string, ME.slice(0, 15))],
    });
    expect(extractAccountItems(b, ME.slice(0, 15))).toEqual([
      { kind: "text", mid: "n", igsid: "12345", text: "a", timestamp: 1 },
    ]);
    const bad = body({ id: ME, messaging: [msg({ message: { text: "sem mid" } }, 1), { recipient: { id: ME }, timestamp: 2, message: { mid: "x", text: "a" } }] });
    expect(extractAccountItems(bad, ME)).toEqual([
      { kind: "ignored", mid: null, reason: "malformed" },
      { kind: "ignored", mid: "x", reason: "malformed" },
    ]);
  });

  it("corpo malformado dá [] sem lançar", () => {
    for (const b of [null, undefined, 1, "x", [], {}, { object: "page", entry: [] }, { object: "instagram" },
      { object: "instagram", entry: "x" }, { object: "instagram", entry: [null, 1, { id: ME, messaging: "x" }] }]) {
      expect(() => extractAccountItems(b, ME)).not.toThrow();
      expect(extractAccountItems(b, ME)).toEqual([]);
    }
  });
});

describe("eco próprio e desfechos", () => {
  it("echo_own só com o mid em provider_message_ids de mensagem assistant/human", () => {
    const messages = [
      { role: "user", content: "x", provider_message_ids: ["m1"] },
      { role: "assistant", content: "y", provider_message_ids: ["m2", "m3"] },
      { role: "human", content: "z", provider_message_ids: ["m4"] },
    ];
    expect(isEchoOwn(messages, "m3")).toBe(true);
    expect(isEchoOwn(messages, "m4")).toBe(true);
    expect(isEchoOwn(messages, "m1")).toBe(false);
    expect(isEchoOwn(messages, "m9")).toBe(false);
    expect(isEchoOwn(null, "m3")).toBe(false);
  });

  it("os desfechos seguem o CHECK ^[a-z0-9_]{1,64}$", () => {
    for (const r of ["deleted", "unsupported", "non_message", "self", "malformed"] as const) {
      expect(ignoredOutcome(r)).toMatch(/^[a-z0-9_]{1,64}$/);
    }
    expect(ignoredOutcome("self")).toBe("ignored_self");
  });

  it("rate limit por contato: chave ig:<igsid>, 60 s e 10 mensagens", () => {
    expect(instagramRateLimitKey("555")).toBe("ig:555");
    expect(INSTAGRAM_CONTACT_RATE_LIMIT).toEqual({ windowSeconds: 60, max: 10 });
    expect(INSTAGRAM_PROCESSED_RETENTION_DAYS).toBe(30);
  });
});

describe("sendInstagramParts", () => {
  const ok = (id: string) => ({ ok: true as const, value: { messageId: id } });
  const fail = (errorClass: string, httpStatus: number | null, code: number | null = null) =>
    ({ ok: false as const, errorClass, httpStatus, code }) as never;

  it("divide por bytes, envia na ordem e guarda os messageId", async () => {
    const sent: string[] = [];
    const r = await sendInstagramParts("a".repeat(900) + "\n\n" + "b".repeat(600), async (t) => {
      sent.push(t);
      return ok(`mid-${sent.length}`);
    });
    expect(sent).toEqual(["a".repeat(900), "b".repeat(600)]);
    expect(r).toEqual({ result: { ok: true, status: 200 }, messageIds: ["mid-1", "mid-2"], reauthRequired: false });
  });

  it("para na primeira falha: ok só com todas", async () => {
    let n = 0;
    const r = await sendInstagramParts("a".repeat(900) + "\n\n" + "b".repeat(600), async () =>
      ++n === 1 ? ok("mid-1") : fail("invalid_request", 400));
    expect(n).toBe(2);
    expect(r.result).toEqual({ ok: false, status: 400, error: "invalid_request" });
    expect(r.messageIds).toEqual(["mid-1"]);
  });

  it("desfecho desconhecido vira provider_timeout (não é falha definitiva) e para", async () => {
    for (const unknown of [fail("transient", null), fail("transient", 503), fail("invalid_request", 200)]) {
      let n = 0;
      const r = await sendInstagramParts("a".repeat(900) + "\n\n" + "b".repeat(600), async () => { n++; return unknown; });
      expect(n).toBe(1);
      expect(r.result.ok).toBe(false);
      expect(r.result.error).toBe("provider_timeout");
    }
  });

  it("erro 190 sinaliza reauth_required", async () => {
    const r = await sendInstagramParts("oi", async () => fail("reauth_required", 400, 190));
    expect(r.reauthRequired).toBe(true);
    expect(r.result).toEqual({ ok: false, status: 400, error: "reauth_required" });
  });

  it("nunca lança: exceção no envio é desfecho desconhecido (provider_timeout), com os ids que já saíram; texto vazio não envia", async () => {
    await expect(sendInstagramParts("oi", async () => { throw new Error("boom https://x?access_token=s"); }))
      .resolves.toEqual({ result: { ok: false, error: "provider_timeout" }, messageIds: [], reauthRequired: false });
    let k = 0;
    await expect(sendInstagramParts("a".repeat(900) + "\n\n" + "b".repeat(600), async () => {
      if (++k === 2) throw new TypeError("quebrou no meio");
      return ok("mid-1");
    })).resolves.toEqual({ result: { ok: false, error: "provider_timeout" }, messageIds: ["mid-1"], reauthRequired: false });
    let n = 0;
    const r = await sendInstagramParts("   ", async () => { n++; return ok("x"); });
    expect(n).toBe(0);
    expect(r.result).toEqual({ ok: false, error: "empty_text" });
  });
});

describe("mapContactReservationRpc", () => {
  it("linha devolvida vira data", () => {
    expect(mapContactReservationRpc([{ id: "r1", status: "confirmed", payment_status: null }], null))
      .toEqual({ data: { id: "r1", status: "confirmed", payment_status: null }, error: null });
    expect(mapContactReservationRpc({ id: "r1", status: "pending", payment_status: "not_required" }, null))
      .toEqual({ data: { id: "r1", status: "pending", payment_status: "not_required" }, error: null });
  });

  it("23505 passa o code (retry de mesa); teto vira código próprio; o resto só o code", () => {
    expect(mapContactReservationRpc(null, { code: "23505", message: "dup" })).toEqual({ data: null, error: { code: "23505" } });
    expect(mapContactReservationRpc(null, { code: "P0001", message: "instagram_contact_reservation_limit" }))
      .toEqual({ data: null, error: { code: RESERVATION_LIMIT_ERROR_CODE } });
    expect(mapContactReservationRpc(null, { code: "P0001", message: "outra coisa" })).toEqual({ data: null, error: { code: "P0001" } });
    expect(mapContactReservationRpc(null, { code: "42501", message: "instagram_contact_reservation_forbidden" }))
      .toEqual({ data: null, error: { code: "42501" } });
    expect(mapContactReservationRpc([], null)).toEqual({ data: null, error: { code: "no_row" } });
    expect(mapContactReservationRpc([{ id: 1 }], null)).toEqual({ data: null, error: { code: "no_row" } });
  });
});

describe("predicados compartilhados com o webhook-whatsapp", () => {
  it("org bloqueada = blocked ou suspended; leitura que falha (null) não bloqueia (polaridade aberta)", () => {
    expect(isOrgBillingBlocked({ billing_status: "blocked" })).toBe(true);
    expect(isOrgBillingBlocked({ billing_status: "suspended" })).toBe(true);
    expect(isOrgBillingBlocked({ billing_status: "active" })).toBe(false);
    expect(isOrgBillingBlocked({ billing_status: "trialing" })).toBe(false);
    expect(isOrgBillingBlocked(null)).toBe(false);
    expect(isOrgBillingBlocked(undefined)).toBe(false);
  });

  it("buildAgentUnit monta a unidade como o webhook-whatsapp", () => {
    const row = { id: "u", name: "Loja", slug: "loja", price_range_max: 80,
      address: { street: "Rua A", number: "1", neighborhood: null, city: "SP", state: " " } };
    expect(buildAgentUnit(row)).toEqual({ row, name: "Loja", slug: "loja", address: "Rua A, 1, SP", ticketMax: 80 });
    expect(buildAgentUnit({ ...row, address: { full: " Av. B, 2 ", street: "x" } }).address).toBe("Av. B, 2");
    expect(buildAgentUnit(null)).toEqual({ row: null, name: "", slug: null, address: "", ticketMax: null });
  });

  it("MEDIA_REPLY_TEXT mantém o valor do WhatsApp", () => {
    expect(MEDIA_REPLY_TEXT).toBe("Por aqui só consigo ler texto. Pode me escrever a informação que precisa? Se quiser falar com a equipe, é só pedir.");
  });
});

describe("mensagem da conversa e desfecho gravado", () => {
  it("provider_message_ids só em mensagem nossa com ids; user nunca leva", () => {
    const now = Date.UTC(2026, 9, 5, 15);
    expect(buildInstagramConversationMessage({ role: "assistant", content: "oi", eventId: "e1", providerMessageIds: ["a", "b"], nowMs: now }))
      .toEqual({ event_id: "e1", role: "assistant", content: "oi", timestamp: new Date(now).toISOString(), author: "automation", provider_message_ids: ["a", "b"] });
    expect(buildInstagramConversationMessage({ role: "user", content: "x", eventId: "e2", providerMessageIds: ["a"], timestamp: now - 1000, receivedAt: "r", nowMs: now }))
      .toEqual({ event_id: "e2", role: "user", content: "x", timestamp: new Date(now - 1000).toISOString(), author: "customer", received_at: "r" });
    expect(buildInstagramConversationMessage({ role: "assistant", content: "y", eventId: "e3", author: "ai", providerMessageIds: [], nowMs: now }))
      .not.toHaveProperty("provider_message_ids");
  });

  it("timestamp fora da janela vira agora", () => {
    const now = Date.UTC(2026, 9, 5, 15);
    expect(conversationTimestamp(1_000, now)).toBe(new Date(now).toISOString());
    expect(conversationTimestamp(now + 3_600_000, now)).toBe(new Date(now).toISOString());
    expect(conversationTimestamp(null, now)).toBe(new Date(now).toISOString());
  });

  it("send_error com provider_timeout é desfecho desconhecido; histórico degradado ganha sufixo", () => {
    expect(recordedMessageOutcome("send_error", "provider_timeout", false)).toBe("send_outcome_unknown");
    expect(recordedMessageOutcome("send_error", "invalid_request", false)).toBe("send_error");
    expect(recordedMessageOutcome("success", null, true)).toBe("success_history_degraded");
    expect(recordedMessageOutcome("success_history_degraded", null, true)).toBe("success_history_degraded");
    expect(recordedMessageOutcome("Fora Do Check!", null, false)).toBe("unknown_outcome");
    expect(instagramInboundEventId("acc", "m1")).toBe("ig-in:acc:m1");
  });

  it("nome informado no link passa pela allowlist do nome de perfil", () => {
    expect(cleanInstagramProfileName("Ana <script>‮Silva​")).toBe("Ana scriptSilva");
    expect(cleanInstagramProfileName("  \n ")).toBe("");
    expect(cleanInstagramProfileName(null)).toBe("");
    expect(Array.from(cleanInstagramProfileName("é".repeat(200)))).toHaveLength(80);
  });
});

describe("safeErrorLabel", () => {
  it("código interno passa; texto livre vira a classe", () => {
    expect(safeErrorLabel(new Error("conversation_handoff_fence_failed"))).toBe("conversation_handoff_fence_failed");
    expect(safeErrorLabel(new TypeError("fetch failed https://x.invalid?key=segredo"))).toBe("TypeError");
    expect(safeErrorLabel(Object.assign(new Error("duplicate key (phone)=(11988887777)"), { name: "PostgrestError" }))).toBe("PostgrestError");
    expect(safeErrorLabel("x")).toBe("string");
  });
});

describe("teto de trocas de cliente do contato (R4-l)", () => {
  const now = Date.UTC(2026, 9, 5, 15);
  const day = 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString();

  it("mesma regra da RPC: 3 trocas numa janela viva de 30 dias, com cliente atual", () => {
    expect(linkChangeCapReached({ currentCustomerId: "c1", changesCount: 3, windowStartedAt: iso(now - day), nowMs: now })).toBe(true);
    expect(linkChangeCapReached({ currentCustomerId: "c1", changesCount: 2, windowStartedAt: iso(now - day), nowMs: now })).toBe(false);
    // Sem cliente atual: ligar o primeiro não é troca.
    expect(linkChangeCapReached({ currentCustomerId: null, changesCount: 9, windowStartedAt: iso(now - day), nowMs: now })).toBe(false);
    // Janela nula ou vencida zera.
    expect(linkChangeCapReached({ currentCustomerId: "c1", changesCount: 3, windowStartedAt: null, nowMs: now })).toBe(false);
    expect(linkChangeCapReached({ currentCustomerId: "c1", changesCount: 3, windowStartedAt: iso(now - 30 * day), nowMs: now })).toBe(false);
    expect(linkChangeCapReached({ currentCustomerId: "c1", changesCount: 3, windowStartedAt: iso(now - 30 * day + 1000), nowMs: now })).toBe(true);
  });

  it("valor ilegível falha fechado", () => {
    expect(linkChangeCapReached({ currentCustomerId: "c1", changesCount: 0, windowStartedAt: "lixo", nowMs: now })).toBe(true);
    expect(linkChangeCapReached({ currentCustomerId: "c1", changesCount: null, windowStartedAt: iso(now), nowMs: now })).toBe(true);
  });

  it("gêmeos do SQL: c_max_link_changes e c_link_window de link_instagram_contact_customer (200600)", () => {
    const sql = readFileSync(resolve(__dirname, "../../supabase/migrations/20261029200600_instagram_contact_reservation_atomic.sql"), "utf8")
      .replace(/--[^\n]*/g, "");
    const ini = sql.indexOf("create or replace function public.link_instagram_contact_customer(");
    expect(ini).toBeGreaterThan(-1);
    const corpo = sql.slice(ini, sql.indexOf("$$;", ini));
    const max = /c_max_link_changes\s+constant\s+integer\s*:=\s*(\d+)/i.exec(corpo)?.[1];
    const janela = /c_link_window\s+constant\s+interval\s*:=\s*interval\s*'(\d+) days'/i.exec(corpo)?.[1];
    expect(max, "constante do teto não encontrada no corpo").toBeDefined();
    expect(janela, "janela não encontrada no corpo").toBeDefined();
    expect(Number(max)).toBe(INSTAGRAM_LINK_CHANGES_MAX);
    expect(Number(janela)).toBe(INSTAGRAM_LINK_CHANGES_WINDOW_DAYS);
    // Controle: o mesmo número só num comentário não conta.
    expect(/c_max_link_changes\s+constant/i.test("-- c_max_link_changes constant integer := 3".replace(/--[^\n]*/g, ""))).toBe(false);
  });
});
