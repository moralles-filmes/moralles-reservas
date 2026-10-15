import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { DATAFY_BASE_URL } from "../../supabase/functions/_shared/datafy-client.ts";
import {
  DATAFY_ADMIN_MAX_BODY_BYTES,
  DATAFY_ADMIN_MAX_TIMEOUT_MS,
  DATAFY_ADMIN_TIMEOUT_MS,
  DATAFY_CONNECT_LINK_HOST,
  classifyDatafyAdminStatus,
  createDatafyAdminClient,
  datafyMutationMayHaveApplied,
  type DatafyAdminErrorKind,
  type DatafyAdminResult,
} from "../../supabase/functions/_shared/datafy-admin-client.ts";
import { DATAFY_CONNECT_ORIGIN } from "../../supabase/functions/_shared/datafy-onboarding-core.ts";
import { shapeOf } from "../../supabase/functions/_shared/webhook-payload-shape-core.ts";

// Valores-isca: se qualquer um aparecer num resultado de erro ou numa chamada de
// `onUnrecognized`, o teste de redação reprova.
const ACCOUNT_TOKEN = "sk_acct_FIXTURE_ACCOUNT_TOKEN_9f3a";
const CHANNEL_TOKEN = "sk_live_FIXTURE_CHANNEL_TOKEN_77b1";
const WEBHOOK_SECRET = "whsec_FIXTURE_WEBHOOK_SECRET_55c2";
const CONNECT_TOKEN = "ct_FIXTURE_CONNECT_TOKEN_31d4";
const LINK_URL = `https://app.datafyapi.com.br/connect/9a8b7c?t=${CONNECT_TOKEN}`;
const CHANNEL_ID = "6d869b02-1c2e-4f5a-9b7d-0a1b2c3d4e5f";
const WEBHOOK_URL = "https://project.supabase.co/functions/v1/webhook-whatsapp?channel=11111111-2222-3333-4444-555555555555";
const EVENTS = ["messages", "smb_message_echoes"];

const FORBIDDEN = [
  ACCOUNT_TOKEN, CHANNEL_TOKEN, WEBHOOK_SECRET, CONNECT_TOKEN, LINK_URL,
  "sk_acct_", "sk_live_", "whsec_", "ct_",
];

// --- Formas medidas na Fase 0 (plano, Task 4) -----------------------------

const listItem = (over: Record<string, unknown> = {}) => ({
  id: CHANNEL_ID,
  name: "7f0c2d1e-0000-4000-8000-000000000001",
  description: "",
  subscribed: false,
  on_trial: true,
  trial_ends_at: "2026-10-16T12:00:00.000-03:00",
  paused: false,
  waba_id: null,
  phone_number_id: null,
  business_id: null,
  display_name: null,
  ...over,
});

const connectedItem = listItem({
  id: "chan_conectado-2",
  name: "Moralles Reservas - Canal Teste",
  subscribed: true,
  on_trial: false,
  trial_ends_at: null,
  waba_id: "940664000000001",
  phone_number_id: "520000000000001",
  business_id: "880000000000001",
  display_name: "Moralles Reservas",
});

const listBody = { subscription: "active", channels: [listItem(), connectedItem] };

// GET de canal SEM número: identidade e `phone` vêm `null` PRESENTES; `description` vazio.
const getBodyNoNumber = {
  ...listItem(),
  phone: null,
  webhooks: [],
  token: CHANNEL_TOKEN,
  webhook_secret: WEBHOOK_SECRET,
};

const getBodyWithNumber = {
  ...connectedItem,
  phone: "+55 11 99999-0000",
  webhooks: [{ id: "wh_01", url: WEBHOOK_URL, events: EVENTS, enabled: true }],
  token: CHANNEL_TOKEN,
  webhook_secret: WEBHOOK_SECRET,
};

const createBody = {
  id: CHANNEL_ID,
  name: "7f0c2d1e-0000-4000-8000-000000000001",
  description: "",
  token: CHANNEL_TOKEN,
  webhook_secret: WEBHOOK_SECRET,
  subscribed: false,
};

const webhookBody = { id: "wh_01", url: WEBHOOK_URL, events: EVENTS, enabled: true };
const linkBody = { url: LINK_URL, token: CONNECT_TOKEN, expires_in: 86400 };
const subscribeBody = { id: CHANNEL_ID, subscribed: true };
const deleteBody = { ok: true };

// --- Harness ---------------------------------------------------------------

type Client = ReturnType<typeof createDatafyAdminClient>;
type FetchMock = ReturnType<typeof vi.fn>;

function reply(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rawReply(text: string | null, status = 200): Response {
  return new Response(text, { status });
}

function fetchReturning(response: Response | (() => Response)): FetchMock {
  return vi.fn(async () => (typeof response === "function" ? response() : response));
}

function makeClient(fetchImpl: FetchMock, extra: Partial<Parameters<typeof createDatafyAdminClient>[0]> = {}) {
  const onUnrecognized = vi.fn();
  const client = createDatafyAdminClient({
    token: ACCOUNT_TOKEN,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    onUnrecognized,
    ...extra,
  });
  return { client, onUnrecognized };
}

type AnyResult = Promise<DatafyAdminResult<unknown>>;

interface OpCase {
  name: string;
  call: (c: Client) => AnyResult;
  /** Só nas operações que recebem id de canal. */
  withId?: (c: Client, id: string) => AnyResult;
  method: "GET" | "POST" | "DELETE";
  path: string;
  requestBody?: unknown;
  ok: unknown;
  /** Exige forma de corpo no 2xx (falso = operação não medida). */
  measured: boolean;
}

const channelPath = `/channels/whatsapp/${CHANNEL_ID}`;

function idOp(
  name: string, withId: (c: Client, id: string) => AnyResult,
  rest: Omit<OpCase, "name" | "call" | "withId">,
): OpCase {
  return { name, withId, call: (c) => withId(c, CHANNEL_ID), ...rest };
}

const OPS: OpCase[] = [
  { name: "listChannels", call: (c) => c.listChannels(), method: "GET", path: "/channels/whatsapp", ok: listBody, measured: true },
  {
    name: "createChannel",
    call: (c) => c.createChannel({ name: "7f0c2d1e-0000-4000-8000-000000000001", description: "Unidade Centro" }),
    method: "POST", path: "/channels/whatsapp",
    requestBody: { name: "7f0c2d1e-0000-4000-8000-000000000001", description: "Unidade Centro" },
    ok: createBody, measured: true,
  },
  idOp("getChannel", (c, id) => c.getChannel(id), { method: "GET", path: channelPath, ok: getBodyNoNumber, measured: true }),
  idOp("createWebhook", (c, id) => c.createWebhook(id, { url: WEBHOOK_URL, events: EVENTS }), {
    method: "POST", path: `${channelPath}/webhooks`, requestBody: { url: WEBHOOK_URL, events: EVENTS },
    ok: webhookBody, measured: true,
  }),
  idOp("createConnectLink", (c, id) => c.createConnectLink(id), { method: "POST", path: `${channelPath}/connect-link`, ok: linkBody, measured: true }),
  idOp("subscribe", (c, id) => c.subscribe(id), { method: "POST", path: `${channelPath}/subscribe`, ok: subscribeBody, measured: true }),
  idOp("cancel", (c, id) => c.cancel(id), { method: "POST", path: `${channelPath}/cancel`, ok: { ok: true }, measured: false }),
  idOp("pause", (c, id) => c.pause(id), { method: "POST", path: `${channelPath}/pause`, ok: { ok: true }, measured: false }),
  idOp("resume", (c, id) => c.resume(id), { method: "POST", path: `${channelPath}/resume`, ok: { ok: true }, measured: false }),
  idOp("deleteChannel", (c, id) => c.deleteChannel(id), { method: "DELETE", path: channelPath, ok: deleteBody, measured: false }),
];

const MEASURED_OPS = OPS.filter((op) => op.measured);
const ID_OPS = OPS.filter((op) => op.withId !== undefined);

function errorWithCause(message: string, cause: string): TypeError {
  const error = new TypeError(message);
  // `cause` por atribuição: o lib do tsconfig é ES2021, sem `ErrorOptions`.
  (error as { cause?: unknown }).cause = new Error(cause);
  return error;
}

/** Resposta cujo corpo falha ao ser lido, depois de o status já ter chegado. */
function brokenBodyReply(message: string, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error(message));
    },
  });
  return new Response(stream, { status });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- Requisição -------------------------------------------------------------

describe("requisição", () => {
  it.each(OPS)("$name: método, caminho, Bearer só no header, redirect error e signal", async (op) => {
    const fetchImpl = fetchReturning(reply(op.ok));
    const { client } = makeClient(fetchImpl);
    await op.call(client);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DATAFY_BASE_URL}${op.path}`);
    expect(url).not.toContain(ACCOUNT_TOKEN);
    expect(init.method).toBe(op.method);
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${ACCOUNT_TOKEN}`);
    expect(headers.Accept).toBe("application/json");
    if (op.requestBody === undefined) {
      expect(init.body).toBeUndefined();
    } else {
      expect(JSON.parse(init.body as string)).toEqual(op.requestBody);
      expect(headers["Content-Type"]).toBe("application/json");
    }
  });

  it("id aceito vai literal no caminho (o alfabeto aceito não precisa de codificação)", async () => {
    const id = "Ab_9-xY";
    const fetchImpl = fetchReturning(reply(getBodyNoNumber));
    const { client } = makeClient(fetchImpl);
    await client.getChannel(id);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${DATAFY_BASE_URL}/channels/whatsapp/Ab_9-xY`);
  });

  it("baseUrl injetada sem barra duplicada", async () => {
    const fetchImpl = fetchReturning(reply(listBody));
    const { client } = makeClient(fetchImpl, { baseUrl: "https://datafy.test/" });
    await client.listChannels();
    expect(fetchImpl.mock.calls[0][0]).toBe("https://datafy.test/channels/whatsapp");
  });

  it("sem fetchImpl usa o fetch global", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(listBody));
    const client = createDatafyAdminClient({ token: ACCOUNT_TOKEN });
    const result = await client.listChannels();
    expect(result.ok).toBe(true);
    expect(globalFetch).toHaveBeenCalledOnce();
  });
});

// --- Sucesso com as formas medidas --------------------------------------------

describe("sucesso com a forma medida", () => {
  it("listChannels mapeia snake_case e conserva os null presentes", async () => {
    const { client } = makeClient(fetchReturning(reply(listBody)));
    expect(await client.listChannels()).toEqual({
      ok: true,
      value: {
        accountSubscription: "active",
        channels: [
          {
            id: CHANNEL_ID, name: "7f0c2d1e-0000-4000-8000-000000000001", subscribed: false, onTrial: true,
            trialEndsAt: "2026-10-16T12:00:00.000-03:00", paused: false,
            phoneNumberId: null, wabaId: null, businessId: null,
          },
          {
            id: "chan_conectado-2", name: "Moralles Reservas - Canal Teste", subscribed: true, onTrial: false,
            trialEndsAt: null, paused: false,
            phoneNumberId: "520000000000001", wabaId: "940664000000001", businessId: "880000000000001",
          },
        ],
      },
    });
  });

  it("listChannels aceita lista vazia e subscription ausente vira null", async () => {
    const { client } = makeClient(fetchReturning(reply({ channels: [] })));
    expect(await client.listChannels()).toEqual({ ok: true, value: { accountSubscription: null, channels: [] } });
  });

  it("createChannel devolve id e credenciais do canal (200, não 201)", async () => {
    const { client } = makeClient(fetchReturning(reply(createBody, 200)));
    expect(await client.createChannel({ name: "n", description: "" })).toEqual({
      ok: true,
      value: { id: CHANNEL_ID, token: CHANNEL_TOKEN, webhookSecret: WEBHOOK_SECRET, subscribed: false },
    });
  });

  it("getChannel sem número: campos de identidade e phone null presentes, description vazia", async () => {
    const { client } = makeClient(fetchReturning(reply(getBodyNoNumber)));
    expect(await client.getChannel(CHANNEL_ID)).toEqual({
      ok: true,
      value: {
        id: CHANNEL_ID, name: "7f0c2d1e-0000-4000-8000-000000000001", subscribed: false, onTrial: true,
        trialEndsAt: "2026-10-16T12:00:00.000-03:00", paused: false,
        phoneNumberId: null, wabaId: null, businessId: null,
        displayPhone: null, token: CHANNEL_TOKEN, webhookSecret: WEBHOOK_SECRET, webhooks: [],
      },
    });
  });

  it("getChannel com número e webhook cadastrado", async () => {
    const { client } = makeClient(fetchReturning(reply(getBodyWithNumber)));
    expect(await client.getChannel("chan_conectado-2")).toEqual({
      ok: true,
      value: {
        id: "chan_conectado-2", name: "Moralles Reservas - Canal Teste", subscribed: true, onTrial: false,
        trialEndsAt: null, paused: false,
        phoneNumberId: "520000000000001", wabaId: "940664000000001", businessId: "880000000000001",
        displayPhone: "+55 11 99999-0000", token: CHANNEL_TOKEN, webhookSecret: WEBHOOK_SECRET,
        webhooks: [{ id: "wh_01", url: WEBHOOK_URL, events: EVENTS, enabled: true }],
      },
    });
  });

  it("getChannel: webhooks ausente vira [], token e secret ausentes viram null", async () => {
    const { webhooks: _w, token: _t, webhook_secret: _s, ...rest } = getBodyNoNumber;
    const { client } = makeClient(fetchReturning(reply(rest)));
    const result = await client.getChannel(CHANNEL_ID);
    expect(result).toMatchObject({ ok: true, value: { webhooks: [], token: null, webhookSecret: null } });
  });

  it("getChannel: string vazia em campo de identidade vira null", async () => {
    const { client } = makeClient(fetchReturning(reply({ ...getBodyNoNumber, phone_number_id: "", waba_id: "", business_id: "" })));
    expect(await client.getChannel(CHANNEL_ID)).toMatchObject({
      ok: true, value: { phoneNumberId: null, wabaId: null, businessId: null },
    });
  });

  it("createWebhook devolve o id do webhook", async () => {
    const { client } = makeClient(fetchReturning(reply(webhookBody)));
    expect(await client.createWebhook(CHANNEL_ID, { url: WEBHOOK_URL, events: EVENTS }))
      .toEqual({ ok: true, value: { webhookId: "wh_01" } });
  });

  it("createConnectLink devolve só url e validade; o ct_ é descartado", async () => {
    const { client } = makeClient(fetchReturning(reply(linkBody)));
    const result = await client.createConnectLink(CHANNEL_ID);
    expect(result).toEqual({ ok: true, value: { url: LINK_URL, expiresInSeconds: 86400 } });
    // O token de conexão só existe dentro da URL (que é o próprio link), nunca como campo.
    expect(Object.keys((result as { value: object }).value).sort()).toEqual(["expiresInSeconds", "url"]);
  });

  it("subscribe devolve o subscribed medido", async () => {
    const { client } = makeClient(fetchReturning(reply(subscribeBody)));
    expect(await client.subscribe(CHANNEL_ID)).toEqual({ ok: true, value: { subscribed: true } });
  });

  it("deleteChannel com o { ok: true } medido", async () => {
    const { client } = makeClient(fetchReturning(reply(deleteBody)));
    expect(await client.deleteChannel(CHANNEL_ID)).toEqual({ ok: true, value: { deleted: true } });
  });

  it.each([
    ["cancel", (c: Client) => c.cancel(CHANNEL_ID)],
    ["pause", (c: Client) => c.pause(CHANNEL_ID)],
    ["resume", (c: Client) => c.resume(CHANNEL_ID)],
  ] as const)("%s (não medido): qualquer 2xx é acknowledged, sem exigir forma", async (_name, call) => {
    for (const response of [
      () => reply({ ok: true }),
      () => reply({ formato: "inesperado", lista: [1, 2] }, 200),
      () => rawReply("", 200),
      () => rawReply("<html>ok</html>", 202),
      () => rawReply(null, 204),
    ]) {
      const { client, onUnrecognized } = makeClient(fetchReturning(response));
      expect(await call(client)).toEqual({ ok: true, value: { acknowledged: true } });
      expect(onUnrecognized).not.toHaveBeenCalled();
    }
  });

  it("deleteChannel: qualquer 2xx é deleted", async () => {
    for (const response of [() => reply({ outro: 1 }), () => rawReply(null, 204), () => rawReply("texto", 200)]) {
      const { client } = makeClient(fetchReturning(response));
      expect(await client.deleteChannel(CHANNEL_ID)).toEqual({ ok: true, value: { deleted: true } });
    }
  });
});

// --- Status HTTP ---------------------------------------------------------------

const STATUS_TABLE = [
  [401, "unauthorized", "DATAFY_UNAUTHORIZED"],
  [402, "payment_declined", "DATAFY_PAYMENT_DECLINED"],
  [403, "account_inactive", "DATAFY_ACCOUNT_INACTIVE"],
  [404, "not_found", "DATAFY_NOT_FOUND"],
  [409, "conflict", "DATAFY_CONFLICT"],
  [400, "invalid", "DATAFY_INVALID_REQUEST"],
  [422, "invalid", "DATAFY_INVALID_REQUEST"],
  [429, "rate_limited", "DATAFY_RATE_LIMITED"],
  [500, "server_error", "DATAFY_SERVER_ERROR"],
  [502, "server_error", "DATAFY_SERVER_ERROR"],
  [503, "server_error", "DATAFY_SERVER_ERROR"],
  [599, "server_error", "DATAFY_SERVER_ERROR"],
  [418, "unrecognized", "DATAFY_UNRECOGNIZED"],
  [302, "unrecognized", "DATAFY_UNRECOGNIZED"],
] as const;

describe("classificação só por status HTTP", () => {
  it.each(OPS)("$name: cada status mapeia para o kind e o code fixos", async (op) => {
    for (const [status, kind, code] of STATUS_TABLE) {
      // O texto da Datafy carrega dado e nunca decide: duas mensagens diferentes, mesmo desfecho.
      for (const message of ["O canal não está assinado (teste encerrado).", "Este é o único canal ativo."]) {
        const errorBody = { message, statusCode: status };
        const { client, onUnrecognized } = makeClient(fetchReturning(reply(errorBody, status)));
        expect(await op.call(client)).toEqual({ ok: false, kind, httpStatus: status, code });
        if (kind === "unrecognized") {
          expect(onUnrecognized).toHaveBeenCalledWith({ operation: op.name, httpStatus: status, shape: shapeOf(errorBody) });
        } else {
          expect(onUnrecognized).not.toHaveBeenCalled();
        }
      }
    }
  });

  it("classifyDatafyAdminStatus: 2xx é sucesso", () => {
    for (const status of [200, 201, 202, 204, 299]) expect(classifyDatafyAdminStatus(status)).toBeNull();
    expect(classifyDatafyAdminStatus(300)).toBe("unrecognized");
    expect(classifyDatafyAdminStatus(600)).toBe("unrecognized");
  });

  it("datafyMutationMayHaveApplied: só transport, server_error e unrecognized deixam a mutação incerta", () => {
    const all: DatafyAdminErrorKind[] = [
      "unauthorized", "account_inactive", "not_found", "conflict", "payment_declined",
      "invalid", "rate_limited", "server_error", "transport", "unrecognized",
    ];
    expect(all.filter(datafyMutationMayHaveApplied).sort()).toEqual(["server_error", "transport", "unrecognized"]);
  });

  it("subscribe: 2xx com subscribed false é ok e o chamador decide pelo GET", async () => {
    const { client } = makeClient(fetchReturning(reply({ id: CHANNEL_ID, subscribed: false })));
    expect(await client.subscribe(CHANNEL_ID)).toEqual({ ok: true, value: { subscribed: false } });
  });

  it("deleteChannel: 404 é not_found (o chamador lê como 'já não existe')", async () => {
    const { client } = makeClient(fetchReturning(reply({ message: "Canal não encontrado", statusCode: 404 }, 404)));
    expect(await client.deleteChannel(CHANNEL_ID)).toEqual({ ok: false, kind: "not_found", httpStatus: 404, code: "DATAFY_NOT_FOUND" });
  });

  it("erro com corpo vazio ou não-JSON classifica igual", async () => {
    const { client: c1 } = makeClient(fetchReturning(rawReply("", 409)));
    expect(await c1.getChannel(CHANNEL_ID)).toEqual({ ok: false, kind: "conflict", httpStatus: 409, code: "DATAFY_CONFLICT" });
    const { client: c2 } = makeClient(fetchReturning(rawReply("<html>bad gateway</html>", 502)));
    expect(await c2.getChannel(CHANNEL_ID)).toEqual({ ok: false, kind: "server_error", httpStatus: 502, code: "DATAFY_SERVER_ERROR" });
  });
});

// --- Transporte e timeout --------------------------------------------------------

describe("transporte", () => {
  it.each(OPS)("$name: fetch que lança vira transport sem a exceção original", async (op) => {
    const error = errorWithCause(
      `fetch failed POST ${DATAFY_BASE_URL}${op.path} Authorization: Bearer ${ACCOUNT_TOKEN} -> ${LINK_URL}`,
      `connect ECONNRESET ${CHANNEL_TOKEN}`,
    );
    const fetchImpl = vi.fn(async () => { throw error; });
    const { client, onUnrecognized } = makeClient(fetchImpl);
    const result = await op.call(client);
    expect(result).toEqual({ ok: false, kind: "transport", httpStatus: null, code: "DATAFY_TRANSPORT" });
    expect(onUnrecognized).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("falha ao ler o corpo depois do status também é transport", async () => {
    const { client } = makeClient(fetchReturning(brokenBodyReply(`stream broke ${CHANNEL_TOKEN}`)));
    expect(await client.createChannel({ name: "n", description: "" }))
      .toEqual({ ok: false, kind: "transport", httpStatus: null, code: "DATAFY_TRANSPORT" });
  });

  function hangingFetch(): FetchMock {
    return vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException(`aborted ${ACCOUNT_TOKEN}`, "AbortError")), { once: true });
    }));
  }

  it("o timeout cobre o corpo: cabeçalho chegou, corpo pendurado vira transport no prazo", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":'));
          // Nunca fecha: só o abort do nosso timeout encerra a leitura.
          init!.signal!.addEventListener("abort", () => {
            controller.error(new DOMException(`aborted ${ACCOUNT_TOKEN}`, "AbortError"));
          }, { once: true });
        },
      });
      return new Response(stream, { status: 200 });
    });
    const { client } = makeClient(fetchImpl);
    let settled = false;
    const pending = client.createChannel({ name: "n", description: "" }).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(DATAFY_ADMIN_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, kind: "transport", httpStatus: null, code: "DATAFY_TRANSPORT" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("nenhum timer sobra depois de sucesso, de erro HTTP ou de transporte", async () => {
    vi.useFakeTimers();
    expect(await makeClient(fetchReturning(reply(subscribeBody))).client.subscribe(CHANNEL_ID)).toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(await makeClient(fetchReturning(reply({ message: "x", statusCode: 409 }, 409))).client.subscribe(CHANNEL_ID))
      .toMatchObject({ ok: false, kind: "conflict" });
    expect(vi.getTimerCount()).toBe(0);
    expect(await makeClient(vi.fn(async () => { throw new TypeError("x"); })).client.subscribe(CHANNEL_ID))
      .toMatchObject({ ok: false, kind: "transport" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("timeout fica abaixo do piso de 30 s do claim, e timeoutMs injetado é limitado ao teto", async () => {
    // O piso do TTL do claim do onboarding é 30 s (migration
    // 20261014120000_datafy_partner_onboarding.sql): um POST em voo nunca pode
    // sobreviver ao claim que o autorizou, senão outro chamador assume e posta de novo.
    expect(DATAFY_ADMIN_TIMEOUT_MS).toBeLessThan(30_000);
    expect(DATAFY_ADMIN_MAX_TIMEOUT_MS).toBeLessThan(30_000);

    vi.useFakeTimers();
    const fetchImpl = hangingFetch();
    const pending = makeClient(fetchImpl, { timeoutMs: 60_000 }).client.subscribe(CHANNEL_ID);
    await vi.advanceTimersByTimeAsync(DATAFY_ADMIN_MAX_TIMEOUT_MS - 1);
    expect((fetchImpl.mock.calls[0][1] as RequestInit).signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ ok: false, kind: "transport" });
  });

  it("timeout padrão de 10 s vira transport, sem retry", async () => {
    vi.useFakeTimers();
    expect(DATAFY_ADMIN_TIMEOUT_MS).toBe(10_000);
    const fetchImpl = hangingFetch();
    const { client } = makeClient(fetchImpl);
    const pending = client.subscribe(CHANNEL_ID);
    await vi.advanceTimersByTimeAsync(9_999);
    expect((fetchImpl.mock.calls[0][1] as RequestInit).signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, kind: "transport", httpStatus: null, code: "DATAFY_TRANSPORT" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("timeoutMs injetado é respeitado; valor inválido cai no padrão", async () => {
    vi.useFakeTimers();
    const fast = hangingFetch();
    const pendingFast = makeClient(fast, { timeoutMs: 2_000 }).client.getChannel(CHANNEL_ID);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pendingFast).toMatchObject({ ok: false, kind: "transport" });

    const fallback = hangingFetch();
    const pendingFallback = makeClient(fallback, { timeoutMs: -5 }).client.getChannel(CHANNEL_ID);
    await vi.advanceTimersByTimeAsync(9_999);
    expect((fallback.mock.calls[0][1] as RequestInit).signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pendingFallback).toMatchObject({ ok: false, kind: "transport" });
  });
});

// --- 2xx fora da forma medida ---------------------------------------------------------

/** Corpo fora da forma; `item` é o sub-objeto culpado quando o defeito está num item. */
interface Fixture { body: unknown; item?: { value: unknown } }
const top = (body: unknown): Fixture => ({ body });
const inItem = (body: unknown, value: unknown): Fixture => ({ body, item: { value } });

const badSubscribedItem = { ...listItem(), subscribed: "true" };
const noPhoneItem = (({ phone_number_id: _p, ...rest }) => rest)(listItem());
const badIdItem = listItem({ id: "../outro" });
const numericPhoneItem = listItem({ phone_number_id: 520000000000001 });
const numericNameItem = listItem({ token: CHANNEL_TOKEN, name: 9 });
const badWebhookEntry = { id: "wh_01", url: WEBHOOK_URL, events: "messages", enabled: true };

const UNRECOGNIZED_BODIES: Record<string, Fixture[]> = {
  listChannels: [
    top([listItem()]),
    top({ subscription: "active" }),
    top({ subscription: "active", channels: null }),
    top({ subscription: 7, channels: [] }),
    // Um item ruim derruba a lista inteira: a reconciliação por nome não pode ver lista parcial.
    inItem({ subscription: "active", channels: [listItem(), badSubscribedItem] }, badSubscribedItem),
    inItem({ subscription: "active", channels: [noPhoneItem] }, noPhoneItem),
    inItem({ subscription: "active", channels: [badIdItem] }, badIdItem),
    inItem({ subscription: "active", channels: [numericPhoneItem] }, numericPhoneItem),
    inItem({ subscription: "active", channels: [numericNameItem] }, numericNameItem),
  ],
  createChannel: [
    top({ ...createBody, token: undefined }),
    top({ ...createBody, token: "" }),
    top({ ...createBody, webhook_secret: { value: WEBHOOK_SECRET } }),
    // `String([x])` passaria; só `typeof` recusa.
    top({ ...createBody, token: [CHANNEL_TOKEN] }),
    top({ ...createBody, id: 12 }),
    top({ ...createBody, subscribed: "false" }),
    top({ data: createBody }),
  ],
  getChannel: [
    // Ausente ≠ null: sem a chave, "não tem número" seria inferido e o link trocaria o número.
    top((({ phone_number_id: _p, ...rest }) => rest)(getBodyNoNumber)),
    top((({ waba_id: _w, ...rest }) => rest)(getBodyNoNumber)),
    top((({ business_id: _b, ...rest }) => rest)(getBodyNoNumber)),
    inItem({ ...getBodyNoNumber, webhooks: null }, null),
    inItem({ ...getBodyNoNumber, webhooks: { id: "wh_01" } }, { id: "wh_01" }),
    inItem({ ...getBodyNoNumber, webhooks: [webhookBody, badWebhookEntry] }, badWebhookEntry),
    top({ ...getBodyNoNumber, token: 123 }),
    top({ ...getBodyNoNumber, paused: null }),
    top({ channel: getBodyNoNumber }),
  ],
  createWebhook: [
    top({ ...webhookBody, id: "" }),
    top({ ...webhookBody, enabled: "yes" }),
    top({ ...webhookBody, events: [1] }),
    top([webhookBody]),
  ],
  createConnectLink: [
    top({ ...linkBody, url: "https://evil.example.com/connect?t=ct_FIXTURE_CONNECT_TOKEN_31d4" }),
    top({ ...linkBody, url: LINK_URL.replace("https:", "http:") }),
    top({ ...linkBody, url: "https://app.datafyapi.com.br.evil.example/connect?t=ct_FIXTURE_CONNECT_TOKEN_31d4" }),
    top({ ...linkBody, url: "https://user:pw@app.datafyapi.com.br/connect?t=ct_FIXTURE_CONNECT_TOKEN_31d4" }),
    top({ ...linkBody, url: "https://app.datafyapi.com.br:8443/connect?t=ct_FIXTURE_CONNECT_TOKEN_31d4" }),
    top({ ...linkBody, url: "javascript:alert(1)//app.datafyapi.com.br" }),
    top({ ...linkBody, url: "não é url" }),
    top({ ...linkBody, url: undefined }),
    top({ ...linkBody, expires_in: "86400" }),
    top({ ...linkBody, expires_in: 0 }),
    top({ token: CONNECT_TOKEN, expires_in: 86400 }),
  ],
  subscribe: [
    top({ id: CHANNEL_ID }),
    top({ id: CHANNEL_ID, subscribed: "true" }),
    top([subscribeBody]),
  ],
};

// Segredo como NOME de chave: `shapeOf` emite nomes do primeiro nível, então o
// filtro de chave é o que impede o vazamento. Todos os proibidos aparecem aqui.
const SECRET_KEYS = {
  [ACCOUNT_TOKEN]: true, [CHANNEL_TOKEN]: true, [WEBHOOK_SECRET]: "x", [CONNECT_TOKEN]: 1, [LINK_URL]: 1,
};

const roundTrip = (value: unknown) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

describe("2xx fora da forma medida", () => {
  it.each(MEASURED_OPS)("$name: unrecognized com shapeOf (e do item culpado), nunca o corpo", async (op) => {
    for (const fixture of UNRECOGNIZED_BODIES[op.name]) {
      const { client, onUnrecognized } = makeClient(fetchReturning(reply(fixture.body)));
      expect(await op.call(client)).toEqual({ ok: false, kind: "unrecognized", httpStatus: 200, code: "DATAFY_UNRECOGNIZED" });
      expect(onUnrecognized).toHaveBeenCalledOnce();
      // O que se compara é o que o JSON ida-e-volta deixa (como a Datafy enviaria).
      const topShape = shapeOf(roundTrip(fixture.body));
      const shape = fixture.item ? { top: topShape, item: shapeOf(roundTrip(fixture.item.value)) } : topShape;
      expect(onUnrecognized).toHaveBeenCalledWith({ operation: op.name, httpStatus: 200, shape });
    }
  });

  it("item da lista com campo novo: a telemetria mostra a forma do item, não só array[N]", async () => {
    const drifted = { ...listItem(), phone_number_id: { id: "520000000000001" } };
    const { client, onUnrecognized } = makeClient(fetchReturning(reply({ subscription: "active", channels: [listItem(), drifted] })));
    await client.listChannels();
    expect(onUnrecognized.mock.calls[0][0].shape).toEqual({
      top: { subscription: "string", channels: "array[2]" },
      item: { ...(shapeOf(listItem()) as Record<string, unknown>), phone_number_id: "object" },
    });
  });

  it("nome de chave fora do vocabulário vira <key>, no topo e no item", async () => {
    const odd = {
      ...SECRET_KEYS, whsec_abc: "s", Ct_Upper: "s", plan_v2: [1], ["a".repeat(41)]: true, subscribed: "yes",
    };
    const { client, onUnrecognized } = makeClient(fetchReturning(reply(odd)));
    await client.subscribe(CHANNEL_ID);
    expect(onUnrecognized.mock.calls[0][0].shape).toEqual({
      subscribed: "string",
      "<key>": "array[1]|boolean|number|string",
    });

    const badItem = { ...listItem(), ...SECRET_KEYS, paused: "no" };
    const listed = makeClient(fetchReturning(reply({ subscription: "active", [WEBHOOK_SECRET]: 1, channels: [badItem] })));
    await listed.client.listChannels();
    expect(listed.onUnrecognized.mock.calls[0][0].shape).toEqual({
      top: { subscription: "string", channels: "array[1]", "<key>": "number" },
      item: { ...(shapeOf(listItem()) as Record<string, unknown>), paused: "string", "<key>": "boolean|number|string" },
    });
  });

  it.each(MEASURED_OPS)("$name: corpo vazio ou não-JSON em 2xx é unrecognized com marcador", async (op) => {
    for (const [text, marker] of [["", "empty_body"], [`token=${CHANNEL_TOKEN}&url=${LINK_URL}`, "non_json_body"]] as const) {
      const { client, onUnrecognized } = makeClient(fetchReturning(rawReply(text, 200)));
      expect(await op.call(client)).toEqual({ ok: false, kind: "unrecognized", httpStatus: 200, code: "DATAFY_UNRECOGNIZED" });
      expect(onUnrecognized).toHaveBeenCalledWith({ operation: op.name, httpStatus: 200, shape: marker });
    }
  });

  it("onUnrecognized que lança não muda o desfecho", async () => {
    const onUnrecognized = vi.fn(() => { throw new Error("log caiu"); });
    const client = createDatafyAdminClient({
      token: ACCOUNT_TOKEN,
      fetchImpl: fetchReturning(reply({ inesperado: true })) as unknown as typeof fetch,
      onUnrecognized,
    });
    expect(await client.subscribe(CHANNEL_ID)).toEqual({ ok: false, kind: "unrecognized", httpStatus: 200, code: "DATAFY_UNRECOGNIZED" });
    expect(onUnrecognized).toHaveBeenCalledOnce();
  });

  it("onUnrecognized assíncrono que rejeita não vira unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      // Função crua, não `vi.fn`: o mock do vitest assina a promise devolvida (para
      // `settledResults`) e a marcaria como tratada, escondendo o defeito.
      let calls = 0;
      const onUnrecognized = async () => {
        calls += 1;
        throw new Error("log caiu");
      };
      const client = createDatafyAdminClient({
        token: ACCOUNT_TOKEN,
        fetchImpl: fetchReturning(reply({ inesperado: true })) as unknown as typeof fetch,
        onUnrecognized,
      });
      expect(await client.subscribe(CHANNEL_ID)).toEqual({ ok: false, kind: "unrecognized", httpStatus: 200, code: "DATAFY_UNRECOGNIZED" });
      expect(calls).toBe(1);
      // O Node só dispara `unhandledRejection` depois de drenar as microtasks.
      await new Promise((settle) => setTimeout(settle, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("sem onUnrecognized também classifica", async () => {
    const client = createDatafyAdminClient({
      token: ACCOUNT_TOKEN,
      fetchImpl: fetchReturning(reply({ inesperado: true })) as unknown as typeof fetch,
    });
    expect(await client.getChannel(CHANNEL_ID)).toMatchObject({ ok: false, kind: "unrecognized" });
  });
});

// --- Teto de corpo --------------------------------------------------------------------

describe("teto de corpo", () => {
  const oversizedJson = JSON.stringify({ ...createBody, padding: "x".repeat(DATAFY_ADMIN_MAX_BODY_BYTES) });

  it("2xx maior que o teto é unrecognized (na mutação: pode ter sido aplicada)", async () => {
    const { client, onUnrecognized } = makeClient(fetchReturning(rawReply(oversizedJson, 200)));
    const result = await client.createChannel({ name: "n", description: "" });
    expect(result).toEqual({ ok: false, kind: "unrecognized", httpStatus: 200, code: "DATAFY_UNRECOGNIZED" });
    expect(datafyMutationMayHaveApplied((result as { kind: DatafyAdminErrorKind }).kind)).toBe(true);
    expect(onUnrecognized).toHaveBeenCalledWith({ operation: "createChannel", httpStatus: 200, shape: "oversized_body" });
  });

  it("4xx maior que o teto também é unrecognized", async () => {
    const { client } = makeClient(fetchReturning(rawReply(oversizedJson, 409)));
    expect(await client.getChannel(CHANNEL_ID)).toEqual({ ok: false, kind: "unrecognized", httpStatus: 409, code: "DATAFY_UNRECOGNIZED" });
  });

  it("Content-Length declarado acima do teto recusa sem ler, mesmo com corpo válido", async () => {
    const response = new Response(JSON.stringify(createBody), {
      status: 200,
      headers: { "Content-Type": "application/json", "Content-Length": String(DATAFY_ADMIN_MAX_BODY_BYTES + 1) },
    });
    const { client } = makeClient(fetchReturning(response));
    expect(await client.createChannel({ name: "n", description: "" }))
      .toEqual({ ok: false, kind: "unrecognized", httpStatus: 200, code: "DATAFY_UNRECOGNIZED" });
  });

  it("corpo com exatamente o teto ainda é lido", async () => {
    const base = JSON.stringify({ ...createBody, padding: "" });
    const exact = JSON.stringify({ ...createBody, padding: "x".repeat(DATAFY_ADMIN_MAX_BODY_BYTES - base.length) });
    expect(exact.length).toBe(DATAFY_ADMIN_MAX_BODY_BYTES);
    const { client } = makeClient(fetchReturning(rawReply(exact, 200)));
    expect(await client.createChannel({ name: "n", description: "" })).toMatchObject({ ok: true, value: { id: CHANNEL_ID } });
  });
});

// --- Gêmeo com o onboarding -----------------------------------------------------------

describe("gêmeo com o onboarding", () => {
  it("a origem aceita no postMessage é o host aceito no link de conexão", () => {
    expect(DATAFY_CONNECT_ORIGIN).toBe(`https://${DATAFY_CONNECT_LINK_HOST}`);
  });
});

// --- Validação antes do fetch ---------------------------------------------------------

describe("validação antes do fetch", () => {
  const INVALID_IDS: unknown[] = [
    "", "../channels", "a/b", "a%2Fb", "a b", "a?b=1", "a#b", "a.b", "ç", `${CHANNEL_ID}\n`,
    "x".repeat(129), null, undefined, 12, ["abc"], { id: "abc" },
  ];

  it.each(ID_OPS)("$name: id inválido não chama fetch", async (op) => {
    for (const id of INVALID_IDS) {
      const fetchImpl = vi.fn();
      const client = createDatafyAdminClient({ token: ACCOUNT_TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(await op.withId!(client, id as string))
        .toEqual({ ok: false, kind: "invalid", httpStatus: null, code: "DATAFY_INVALID_ID" });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("id de 128 caracteres no alfabeto aceito segue", async () => {
    const fetchImpl = fetchReturning(reply(getBodyNoNumber));
    const { client } = makeClient(fetchImpl);
    await client.getChannel("a".repeat(128));
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("token de conta ausente ou fora do formato de header não chama fetch", async () => {
    for (const token of ["", "   ", `${ACCOUNT_TOKEN}\r\nX-Injected: 1`, 42 as unknown as string, null as unknown as string]) {
      const fetchImpl = vi.fn();
      const client = createDatafyAdminClient({ token, fetchImpl: fetchImpl as unknown as typeof fetch });
      for (const op of OPS) {
        expect(await op.call(client)).toEqual({ ok: false, kind: "invalid", httpStatus: null, code: "DATAFY_INVALID_REQUEST" });
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("entrada de criação malformada não chega ao POST não idempotente", async () => {
    const fetchImpl = vi.fn();
    const client = createDatafyAdminClient({ token: ACCOUNT_TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    const bad = { ok: false, kind: "invalid", httpStatus: null, code: "DATAFY_INVALID_REQUEST" };
    expect(await client.createChannel({ name: "", description: "" })).toEqual(bad);
    expect(await client.createChannel({ name: { x: 1 } as unknown as string, description: "" })).toEqual(bad);
    expect(await client.createChannel({ name: "n", description: null as unknown as string })).toEqual(bad);
    expect(await client.createWebhook(CHANNEL_ID, { url: 7 as unknown as string, events: EVENTS })).toEqual(bad);
    expect(await client.createWebhook(CHANNEL_ID, { url: WEBHOOK_URL, events: "messages" as unknown as string[] })).toEqual(bad);
    expect(await client.createWebhook(CHANNEL_ID, { url: WEBHOOK_URL, events: [1] as unknown as string[] })).toEqual(bad);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// --- Contrato do `code` e redação -------------------------------------------------------

describe("code e redação", () => {
  // Cada veículo de vazamento carrega TODOS os proibidos; o controle positivo
  // abaixo confere isso, senão a redação poderia passar por vacuidade.
  const secretMessage =
    `token ${ACCOUNT_TOKEN} ${CHANNEL_TOKEN} secret ${WEBHOOK_SECRET} link ${LINK_URL} ct ${CONNECT_TOKEN}`;
  const transportError = (path: string) =>
    errorWithCause(`fetch failed ${DATAFY_BASE_URL}${path} Authorization: Bearer ${secretMessage}`, secretMessage);
  const secretValueBody = { token: CHANNEL_TOKEN, webhook_secret: WEBHOOK_SECRET, url: LINK_URL, ct: CONNECT_TOKEN, acct: ACCOUNT_TOKEN };

  async function collectFailures() {
    const failures: unknown[] = [];
    const unrecognizedCalls: unknown[] = [];

    const run = async (op: OpCase, fetchImpl: FetchMock, extra: Partial<Parameters<typeof createDatafyAdminClient>[0]> = {}) => {
      const { client, onUnrecognized } = makeClient(fetchImpl, extra);
      const result = await op.call(client);
      if (result.ok === false) failures.push(result);
      unrecognizedCalls.push(...onUnrecognized.mock.calls);
    };

    for (const op of OPS) {
      // Status de erro com a mensagem da Datafy carregando dado, inclusive segredo como nome de chave.
      for (const [status] of STATUS_TABLE) {
        await run(op, fetchReturning(reply({ message: secretMessage, statusCode: status, token: CHANNEL_TOKEN }, status)));
        await run(op, fetchReturning(reply({ ...SECRET_KEYS, message: secretMessage, statusCode: status }, status)));
        await run(op, fetchReturning(rawReply(secretMessage, status)));
      }
      // Exceção de rede com URL, header e link na mensagem e na causa.
      const error = transportError(op.path);
      await run(op, vi.fn(async () => { throw error; }));
      // Leitura de corpo que falha.
      await run(op, fetchReturning(brokenBodyReply(secretMessage)));
    }

    // 2xx fora da forma, inclusive corpos recheados de segredo (como valor e como nome de chave).
    for (const op of MEASURED_OPS) {
      for (const fixture of UNRECOGNIZED_BODIES[op.name]) await run(op, fetchReturning(reply(fixture.body)));
      await run(op, fetchReturning(reply(secretValueBody)));
      await run(op, fetchReturning(reply(SECRET_KEYS)));
      await run(op, fetchReturning(rawReply(secretMessage, 200)));
    }
    // Segredo como nome de chave DENTRO do item culpado.
    const [listOp] = OPS.filter((op) => op.name === "listChannels");
    await run(listOp, fetchReturning(reply({ subscription: "active", ...SECRET_KEYS, channels: [{ ...listItem(), ...SECRET_KEYS, paused: "no" }] })));
    const [getOp] = OPS.filter((op) => op.name === "getChannel");
    await run(getOp, fetchReturning(reply({ ...getBodyNoNumber, webhooks: [{ ...webhookBody, ...SECRET_KEYS, enabled: "no" }] })));
    return { failures, unrecognizedCalls };
  }

  it("CONTROLE POSITIVO: os insumos injetados contêm cada string proibida", () => {
    const vehicles = {
      mensagem: secretMessage,
      excecao: String(transportError("/channels/whatsapp")),
      causa: String((transportError("/x") as { cause?: unknown }).cause),
      chaves: Object.keys(SECRET_KEYS).join(" "),
      valores: JSON.stringify(secretValueBody),
    };
    for (const [vehicle, text] of Object.entries(vehicles)) {
      for (const forbidden of FORBIDDEN) expect(text, `${vehicle} deveria carregar ${forbidden}`).toContain(forbidden);
    }
  });

  it("todo code é token fixo ^[A-Z0-9_]{1,64}$", async () => {
    const { failures } = await collectFailures();
    expect(failures.length).toBeGreaterThan(100);
    const codes = new Set(failures.map((f) => (f as { code: string }).code));
    for (const code of codes) expect(code).toMatch(/^[A-Z0-9_]{1,64}$/);
    for (const failure of failures) expect(Object.keys(failure as object).sort()).toEqual(["code", "httpStatus", "kind", "ok"]);
  });

  it("nenhum resultado de erro nem chamada de onUnrecognized carrega token, segredo, ct_ ou o link", async () => {
    const { failures, unrecognizedCalls } = await collectFailures();
    expect(unrecognizedCalls.length).toBeGreaterThan(20);
    const serialized = JSON.stringify({ failures, unrecognizedCalls });
    for (const forbidden of FORBIDDEN) expect(serialized).not.toContain(forbidden);
  });
});

// --- fetch da Datafy só em dois arquivos --------------------------------------------------

describe("base URL da Datafy só em datafy-client.ts e datafy-admin-client.ts", () => {
  const FUNCTIONS_DIR = resolve(__dirname, "../../supabase/functions");
  const ALLOWED = ["_shared/datafy-admin-client.ts", "_shared/datafy-client.ts"];
  const BASE_URL_MENTION = /cloud\.datafyapi\.com\.br|DATAFY_BASE_URL/;

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
      return entry.isFile() ? [full] : [];
    });
  }

  function filesMentioningBaseUrl(files: Array<{ path: string; content: string }>): string[] {
    return files.filter((file) => BASE_URL_MENTION.test(file.content)).map((file) => file.path).sort();
  }

  it("nenhum outro arquivo de supabase/functions cita a base URL", () => {
    const files = walk(FUNCTIONS_DIR).map((full) => ({
      path: relative(FUNCTIONS_DIR, full).split(sep).join("/"),
      content: readFileSync(full, "utf8"),
    }));
    expect(files.length).toBeGreaterThan(50);
    expect(filesMentioningBaseUrl(files)).toEqual(ALLOWED);
  });

  it("CONTROLE POSITIVO: um terceiro arquivo com fetch para a Datafy seria acusado", () => {
    const synthetic = [
      { path: "_shared/datafy-client.ts", content: 'export const DATAFY_BASE_URL = "https://cloud.datafyapi.com.br";' },
      { path: "_shared/datafy-admin-client.ts", content: 'import { DATAFY_BASE_URL } from "./datafy-client.ts";' },
      { path: "manage-channels/index.ts", content: 'await fetch("https://cloud.datafyapi.com.br/channels/whatsapp");' },
      { path: "outra/index.ts", content: "import { DATAFY_BASE_URL } from '../_shared/datafy-client.ts';" },
      { path: "portal/index.ts", content: 'const origin = "https://app.datafyapi.com.br";' },
    ];
    expect(filesMentioningBaseUrl(synthetic)).toEqual([...ALLOWED, "manage-channels/index.ts", "outra/index.ts"].sort());
  });
});
