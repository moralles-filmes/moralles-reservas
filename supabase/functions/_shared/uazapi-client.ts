// Cliente administrativo UazAPI v2.1.1.
//
// Regras deliberadas:
// - toda chamada tem timeout;
// - POST mutante nunca é repetido automaticamente;
// - create incerto é reconciliado pelo caller via listInstances/adminField01;
// - erros nunca carregam token, body integral ou URL autenticada.

export type UazApiErrorCode =
  | "AUTH_ERROR"
  | "INSTANCE_NOT_FOUND"
  | "NOT_CONNECTED"
  | "QR_REQUIRED"
  | "CAPACITY_EXCEEDED"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "TIMEOUT"
  | "INVALID_REQUEST"
  | "UNKNOWN_PROVIDER_ERROR";

export class UazApiError extends Error {
  readonly code: UazApiErrorCode;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: UazApiErrorCode,
    message: string,
    options: { status?: number | null; retryAfterSeconds?: number | null } = {},
  ) {
    super(message);
    this.name = "UazApiError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export interface UazApiClientOptions {
  baseUrl: string;
  adminToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface UazInstanceSnapshot {
  id: string;
  name: string | null;
  token: string | null;
  adminField01: string | null;
  adminField02: string | null;
  status: string | null;
  connected: boolean;
  loggedIn: boolean;
  jid: string | null;
  qrCode: string | null;
  pairCode: string | null;
}

export interface UazCreateInstanceInput {
  name: string;
  adminField01: string;
  adminField02?: string;
}

export interface UazWebhookInput {
  url: string;
  events?: string[];
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function normalizeInstance(value: unknown, envelope: JsonObject = {}): UazInstanceSnapshot {
  const row = asObject(value);
  const envelopeStatus = asObject(envelope.status);
  const rowStatus = asObject(row.status);
  const status = nonEmptyString(row.status)
    ?? nonEmptyString(envelope.status)
    ?? nonEmptyString(rowStatus.status)
    ?? nonEmptyString(envelopeStatus.status);
  const jidObject = asObject(row.jid);
  const envelopeJidObject = asObject(envelope.jid);
  const statusJidObject = asObject(rowStatus.jid);
  const envelopeStatusJidObject = asObject(envelopeStatus.jid);
  const jid = nonEmptyString(row.jid)
    ?? nonEmptyString(row.ownerJid)
    ?? nonEmptyString(envelope.jid)
    ?? nonEmptyString(jidObject.user)
    ?? nonEmptyString(envelopeJidObject.user)
    ?? nonEmptyString(statusJidObject.user)
    ?? nonEmptyString(envelopeStatusJidObject.user);
  const id = nonEmptyString(row.id)
    ?? nonEmptyString(row.instanceId)
    ?? nonEmptyString(row.instance_id)
    ?? nonEmptyString(row.instance)
    ?? "";

  return {
    id,
    name: nonEmptyString(row.name),
    token: nonEmptyString(envelope.token) ?? nonEmptyString(row.token),
    adminField01: nonEmptyString(row.adminField01),
    adminField02: nonEmptyString(row.adminField02),
    status,
    connected: booleanValue(envelope.connected)
      || booleanValue(row.connected)
      || booleanValue(rowStatus.connected)
      || booleanValue(envelopeStatus.connected)
      || status === "connected",
    loggedIn: booleanValue(envelope.loggedIn)
      || booleanValue(row.loggedIn)
      || booleanValue(rowStatus.loggedIn)
      || booleanValue(envelopeStatus.loggedIn),
    jid,
    qrCode: nonEmptyString(envelope.qrcode)
      ?? nonEmptyString(envelope.qrCode)
      ?? nonEmptyString(envelope.qr)
      ?? nonEmptyString(row.qrcode)
      ?? nonEmptyString(row.qrCode)
      ?? nonEmptyString(row.qr),
    pairCode: nonEmptyString(envelope.paircode)
      ?? nonEmptyString(envelope.pairCode)
      ?? nonEmptyString(row.paircode)
      ?? nonEmptyString(row.pairCode),
  };
}

function errorForStatus(status: number, operation: string, retryAfter: number | null): UazApiError {
  if (status === 401 || status === 403) {
    return new UazApiError("AUTH_ERROR", "A autenticação com a UazAPI falhou.", { status });
  }
  if (status === 404) {
    return new UazApiError("INSTANCE_NOT_FOUND", "A instância UazAPI não foi encontrada.", { status });
  }
  if (status === 429) {
    const code: UazApiErrorCode = operation === "create" || operation === "connect"
      ? "CAPACITY_EXCEEDED"
      : "RATE_LIMITED";
    return new UazApiError(code, "A UazAPI recusou temporariamente a operação.", {
      status,
      retryAfterSeconds: retryAfter,
    });
  }
  if (status === 400 || status === 422) {
    return new UazApiError("INVALID_REQUEST", "A UazAPI recusou os dados enviados.", { status });
  }
  if (status >= 500) {
    return new UazApiError("PROVIDER_UNAVAILABLE", "A UazAPI está indisponível no momento.", {
      status,
      retryAfterSeconds: retryAfter,
    });
  }
  return new UazApiError("UNKNOWN_PROVIDER_ERROR", "A operação na UazAPI falhou.", { status });
}

export class UazApiClient {
  private readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: UazApiClientOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    const adminToken = options.adminToken.trim();
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
      throw new UazApiError("INVALID_REQUEST", "UAZAPI_BASE_URL não está configurada corretamente.");
    }
    if (!adminToken) {
      throw new UazApiError("AUTH_ERROR", "UAZAPI_ADMIN_TOKEN não está configurado.");
    }
    this.baseUrl = baseUrl;
    this.adminToken = adminToken;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(
    path: string,
    options: {
      operation: string;
      method?: "GET" | "POST";
      token?: string;
      body?: JsonObject;
    },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers: {
          "Content-Type": "application/json",
          ...(options.token
            ? { token: options.token }
            : { admintoken: this.adminToken }),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw errorForStatus(
          response.status,
          options.operation,
          parseRetryAfter(response.headers.get("Retry-After")),
        );
      }

      const text = await response.text();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new UazApiError("UNKNOWN_PROVIDER_ERROR", "A UazAPI retornou uma resposta inválida.", {
          status: response.status,
        });
      }
    } catch (error) {
      if (error instanceof UazApiError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new UazApiError("TIMEOUT", "A UazAPI excedeu o tempo limite.");
      }
      throw new UazApiError("PROVIDER_UNAVAILABLE", "Não foi possível acessar a UazAPI.");
    } finally {
      clearTimeout(timer);
    }
  }

  async listInstances(): Promise<UazInstanceSnapshot[]> {
    const payload = await this.request("/instance/all", { operation: "list" });
    const envelope = asObject(payload);
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(envelope.instances)
        ? envelope.instances
        : Array.isArray(envelope.data)
          ? envelope.data
          : [];
    return rows.map((row) => normalizeInstance(row));
  }

  async createInstance(input: UazCreateInstanceInput): Promise<UazInstanceSnapshot> {
    const payload = await this.request("/instance/create", {
      operation: "create",
      method: "POST",
      body: {
        name: input.name,
        adminField01: input.adminField01,
        ...(input.adminField02 ? { adminField02: input.adminField02 } : {}),
      },
    });
    const envelope = asObject(payload);
    const snapshot = normalizeInstance(envelope.instance ?? envelope.data ?? envelope, envelope);
    if (!snapshot.id || !snapshot.token) {
      throw new UazApiError("UNKNOWN_PROVIDER_ERROR", "A UazAPI não retornou os dados da instância criada.");
    }
    return snapshot;
  }

  async configureWebhook(instanceToken: string, input: UazWebhookInput): Promise<void> {
    await this.request("/webhook", {
      operation: "webhook",
      method: "POST",
      token: instanceToken,
      body: {
        enabled: true,
        url: input.url,
        events: input.events ?? ["messages", "messages_update", "connection"],
        excludeMessages: ["wasSentByApi"],
        addUrlEvents: false,
        addUrlTypesMessages: false,
      },
    });
  }

  async connect(instanceToken: string): Promise<UazInstanceSnapshot> {
    const payload = await this.request("/instance/connect", {
      operation: "connect",
      method: "POST",
      token: instanceToken,
      body: {},
    });
    const envelope = asObject(payload);
    return normalizeInstance(envelope.instance ?? envelope.data ?? envelope, envelope);
  }

  async getStatus(instanceToken: string): Promise<UazInstanceSnapshot> {
    const payload = await this.request("/instance/status", {
      operation: "status",
      token: instanceToken,
    });
    const envelope = asObject(payload);
    return normalizeInstance(envelope.instance ?? envelope.data ?? envelope, envelope);
  }

  async disconnect(instanceToken: string): Promise<void> {
    await this.request("/instance/disconnect", {
      operation: "disconnect",
      method: "POST",
      token: instanceToken,
      body: {},
    });
  }

  async reset(instanceToken: string): Promise<void> {
    await this.request("/instance/reset", {
      operation: "reset",
      method: "POST",
      token: instanceToken,
      body: {},
    });
  }
}

export function createUazApiClientFromEnv(): UazApiClient {
  const runtime = globalThis as typeof globalThis & {
    Deno?: { env: { get(name: string): string | undefined } };
  };
  return new UazApiClient({
    baseUrl: runtime.Deno?.env.get("UAZAPI_BASE_URL") ?? "",
    adminToken: runtime.Deno?.env.get("UAZAPI_ADMIN_TOKEN") ?? "",
  });
}
