import { describe, expect, it, vi } from "vitest";
import {
  UazApiClient,
  UazApiError,
} from "../../supabase/functions/_shared/uazapi-client.ts";

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("UazApiClient", () => {
  it("cria instância uma única vez com admintoken e correlação estável", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      instance: { id: "provider-instance", name: "unit-channel" },
      token: "instance-token",
      status: "disconnected",
    }));
    const client = new UazApiClient({
      baseUrl: "https://uaz.example.test/",
      adminToken: "admin-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const created = await client.createInstance({
      name: "unit-channel",
      adminField01: "channel-id",
      adminField02: "unit-id",
    });

    expect(created.id).toBe("provider-instance");
    expect(created.token).toBe("instance-token");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://uaz.example.test/instance/create",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ admintoken: "admin-token" }),
        body: JSON.stringify({
          name: "unit-channel",
          adminField01: "channel-id",
          adminField02: "unit-id",
        }),
      }),
    );
  });

  it("usa token de instância, não admintoken, no status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      instance: { id: "provider-instance", status: "connected", jid: "5511999999999@s.whatsapp.net" },
      connected: true,
    }));
    const client = new UazApiClient({
      baseUrl: "https://uaz.example.test",
      adminToken: "admin-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const status = await client.getStatus("instance-token");

    expect(status.connected).toBe(true);
    expect(status.jid).toBe("5511999999999@s.whatsapp.net");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://uaz.example.test/instance/status",
      expect.objectContaining({ headers: expect.objectContaining({ token: "instance-token" }) }),
    );
    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.admintoken).toBeUndefined();
  });

  it("normaliza o status oficial com jid aninhado", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      status: {
        status: "connected",
        connected: true,
        loggedIn: true,
        jid: { user: "5511988887777" },
      },
    }));
    const client = new UazApiClient({
      baseUrl: "https://uaz.example.test",
      adminToken: "admin-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.getStatus("instance-token")).resolves.toMatchObject({
      status: "connected",
      connected: true,
      loggedIn: true,
      jid: "5511988887777",
    });
  });

  it("descarta QR residual do status passivo depois de timeout", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      status: "disconnected",
      qrcode: "expired-qr",
      paircode: "expired-pair-code",
    }));
    const client = new UazApiClient({
      baseUrl: "https://uaz.example.test",
      adminToken: "admin-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.getStatus("instance-token")).resolves.toMatchObject({
      status: "disconnected",
      connected: false,
      qrCode: null,
      pairCode: null,
    });
  });

  it("preserva o QR novo retornado pelo connect explícito", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      status: "connecting",
      qrcode: "fresh-qr",
      paircode: "fresh-pair-code",
    }));
    const client = new UazApiClient({
      baseUrl: "https://uaz.example.test",
      adminToken: "admin-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.connect("instance-token")).resolves.toMatchObject({
      status: "connecting",
      qrCode: "fresh-qr",
      pairCode: "fresh-pair-code",
    });
  });

  it("normaliza 429 de connect como capacidade e preserva Retry-After", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(
      { error: "connection limit" },
      429,
      { "Retry-After": "15" },
    ));
    const client = new UazApiClient({
      baseUrl: "https://uaz.example.test",
      adminToken: "admin-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.connect("instance-token")).rejects.toMatchObject({
      code: "CAPACITY_EXCEEDED",
      status: 429,
      retryAfterSeconds: 15,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("não repete create depois de falha de rede", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("network down"));
    const client = new UazApiClient({
      baseUrl: "https://uaz.example.test",
      adminToken: "admin-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const promise = client.createInstance({ name: "unit-channel", adminField01: "channel-id" });
    await expect(promise).rejects.toBeInstanceOf(UazApiError);
    await expect(promise).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("lista instâncias para reconciliação por adminField01", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      instances: [{
        id: "provider-instance",
        token: "instance-token",
        adminField01: "channel-id",
        adminField02: "unit-id",
      }],
    }));
    const client = new UazApiClient({
      baseUrl: "https://uaz.example.test",
      adminToken: "admin-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const rows = await client.listInstances();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "provider-instance",
      token: "instance-token",
      adminField01: "channel-id",
    });
  });
});
