// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  MEDIA_BURST_SECONDS,
  MEDIA_DEBOUNCE_GRACE_SECONDS,
  MEDIA_NOTICE_MAX_AGE_SECONDS,
  MEDIA_NOTICE_TEXTS,
  mediaNoticeText,
} from "../../supabase/functions/_shared/media-reply-text";
import {
  claimDeferredMediaNotices,
  recordInboundMedia,
} from "../../supabase/functions/_shared/adapters/conversation-media-notice";

const text = (word: string) =>
  `Recebi também ${word}, mas por aqui só consigo ler texto. Se tiver mais alguma dúvida, é só me escrever.`;

function fakeClient(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { client: { rpc } as never, rpc };
}

describe("mediaNoticeText", () => {
  it("mapeia cada tipo", () => {
    expect(mediaNoticeText(["image"])).toBe(text("sua foto"));
    expect(mediaNoticeText(["audio", "audio"])).toBe(text("seu áudio"));
    expect(mediaNoticeText(["video"])).toBe(text("seu vídeo"));
    expect(mediaNoticeText(["document"])).toBe(text("seu documento"));
    expect(mediaNoticeText(["sticker"])).toBe(text("sua figurinha"));
    expect(mediaNoticeText(["location"])).toBe(text("sua localização"));
    expect(mediaNoticeText(["contacts"])).toBe(text("seu contato"));
  });
  it("tipos mistos, desconhecidos ou vazio caem em seu arquivo", () => {
    expect(mediaNoticeText(["image", "audio"])).toBe(text("seu arquivo"));
    expect(mediaNoticeText(["media"])).toBe(text("seu arquivo"));
    expect(mediaNoticeText(["other"])).toBe(text("seu arquivo"));
    expect(mediaNoticeText([])).toBe(text("seu arquivo"));
  });
  it("MEDIA_NOTICE_TEXTS tem 8 variantes distintas", () => {
    expect(MEDIA_NOTICE_TEXTS).toHaveLength(8);
    expect(new Set(MEDIA_NOTICE_TEXTS).size).toBe(8);
    expect(MEDIA_NOTICE_TEXTS).toContain(text("sua foto"));
    expect(MEDIA_NOTICE_TEXTS).toContain(text("seu áudio"));
    expect(MEDIA_NOTICE_TEXTS).toContain(text("seu arquivo"));
  });
  it("constantes", () => {
    expect(MEDIA_BURST_SECONDS).toBe(60);
    expect(MEDIA_DEBOUNCE_GRACE_SECONDS).toBe(11);
    expect(MEDIA_NOTICE_MAX_AGE_SECONDS).toBe(120);
  });
});

describe("recordInboundMedia", () => {
  const input = { conversationId: "c1", message: { a: 1 }, noticeAllowed: true };
  it("chama o RPC e devolve a decisão", async () => {
    const { client, rpc } = fakeClient({ data: { decision: "deferred", variant: true }, error: null });
    await expect(recordInboundMedia(client, input)).resolves.toEqual({ decision: "deferred", variant: true });
    expect(rpc).toHaveBeenCalledWith("record_conversation_media", {
      p_conversation_id: "c1",
      p_message: { a: 1 },
      p_notice_allowed: true,
      p_burst_seconds: 60,
      p_debounce_grace_seconds: 11,
    });
  });
  it("erro do RPC lança", async () => {
    const { client } = fakeClient({ data: null, error: { message: "x" } });
    await expect(recordInboundMedia(client, input)).rejects.toThrow("media_message_persist_failed");
  });
  it("resposta fora do contrato lança", async () => {
    for (const data of [{ decision: "nope", variant: false }, { decision: "duplicate", variant: "x" }, null, "x"]) {
      const { client } = fakeClient({ data, error: null });
      await expect(recordInboundMedia(client, input)).rejects.toThrow("media_message_persist_failed");
    }
  });
});

describe("claimDeferredMediaNotices", () => {
  it("passa p_since e devolve a lista", async () => {
    const { client, rpc } = fakeClient({ data: ["image"], error: null });
    await expect(claimDeferredMediaNotices(client, "c1", "2026-01-01T00:00:00Z")).resolves.toEqual(["image"]);
    expect(rpc).toHaveBeenCalledWith("claim_conversation_media_notices", {
      p_conversation_id: "c1",
      p_since: "2026-01-01T00:00:00Z",
    });
  });
  it("null vira lista vazia", async () => {
    const { client } = fakeClient({ data: null, error: null });
    await expect(claimDeferredMediaNotices(client, "c1", "x")).resolves.toEqual([]);
  });
  it("erro lança", async () => {
    const { client } = fakeClient({ data: null, error: { message: "x" } });
    await expect(claimDeferredMediaNotices(client, "c1", "x")).rejects.toThrow();
  });
});
