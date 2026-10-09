import { afterEach, describe, it, expect, vi } from "vitest";
import {
  DATAFY_BASE_URL,
  buildDatafyRequest,
  classifyDatafyStatus,
  parseDatafyAccount,
  pickDatafyMessageId,
  createDatafyTemplateTransport,
  DATAFY_TEMPLATE_FIELDS,
} from "../../supabase/functions/_shared/datafy-client";
import { TEMPLATE_CATALOG } from "../../supabase/functions/_shared/whatsapp-template-catalog-core.ts";
import type { WhatsAppProviderAdapter } from "../../supabase/functions/_shared/whatsapp-provider-core.ts";

const modules = import.meta.glob<{
  getWhatsAppProvider(name: string): WhatsAppProviderAdapter;
}>("../../supabase/functions/_shared/whatsapp-providers.ts", { eager: true });
const { getWhatsAppProvider } = modules["../../supabase/functions/_shared/whatsapp-providers.ts"];

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("buildDatafyRequest", () => {
  it("monta URL absoluta e Bearer a partir do path relativo", () => {
    const { url, init } = buildDatafyRequest({ token: "sk_live_x", method: "GET", path: "me" });
    expect(url).toBe(`${DATAFY_BASE_URL}/me`);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk_live_x");
    expect(init.body).toBeUndefined();
  });

  it("aceita path com barra inicial sem duplicar", () => {
    expect(buildDatafyRequest({ token: "t", method: "GET", path: "/v1/123/messages" }).url)
      .toBe(`${DATAFY_BASE_URL}/v1/123/messages`);
  });

  it("serializa corpo e declara Content-Type só quando há corpo", () => {
    const { init } = buildDatafyRequest({
      token: "t", method: "POST", path: "v1/1/messages", body: { a: 1 },
    });
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("nunca coloca o token na URL", () => {
    const { url } = buildDatafyRequest({ token: "sk_live_segredo", method: "GET", path: "me" });
    expect(url).not.toContain("sk_live_segredo");
  });
});

describe('Datafy native template transport (same factory wired in the real adapter)', () => {
  const credentials = { access_token: 'fixture-private-bearer', phone_number_id: '123456789' };
  const sendInput = { phoneNumberId: '123456789', toPhone: '55999990000',
    name: 'res_pesquisa_reserva_v1', language: 'pt_BR', parameters: ['Marina', 'RES123', 'Exemplo', '19/10/2026'] };
  const createInput = { wabaId: '987654321', definition: TEMPLATE_CATALOG.res_pesquisa_reserva_v1 };
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const remote = { id: '5400801403478858', name: 'res_pesquisa_reserva_v1', language: 'pt_BR',
    status: 'APPROVED', category: 'UTILITY', parameter_format: 'POSITIONAL',
    components: [{ type: 'BODY', text: createInput.definition.body, extra_field: 'retain' }] };

  it('o adapter real envia BODY posicional com token só no header', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(reply({ messages: [{ id: 'wamid.fixture-1', message_status: 'accepted' }] }));
    vi.stubGlobal('fetch', fakeFetch);
    const outcome = await getWhatsAppProvider('datafy').sendTemplate!(credentials, sendInput);
    expect(outcome).toEqual({ state: 'accepted', status: 200, providerMessageId: 'wamid.fixture-1' });
    expect(fakeFetch).toHaveBeenCalledOnce();
    const [url, init] = fakeFetch.mock.calls[0];
    expect(url).toBe(`${DATAFY_BASE_URL}/v1/123456789/messages`);
    expect(url).not.toContain(credentials.access_token);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${credentials.access_token}` } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toMatchObject({ to: '5555999990000', type: 'template',
      template: { language: { code: 'pt_BR' }, components: [{ type: 'body',
        parameters: [{ type: 'text', text: 'Marina' }, { type: 'text', text: 'RES123' },
          { type: 'text', text: 'Exemplo' }, { type: 'text', text: '19/10/2026' }] }] } });
  });

  it('sendText real conserva endpoint, payload textual e falta de credenciais; /me fica sem v1', async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce(reply({ messages: [{ id: 'wamid.text' }] }))
      .mockResolvedValueOnce(reply({ phone_number_id: credentials.phone_number_id, waba_id: createInput.wabaId }));
    vi.stubGlobal('fetch', fakeFetch);
    const adapter = getWhatsAppProvider('datafy');
    expect(await adapter.sendText(credentials, { toPhone: sendInput.toPhone, text: 'Texto humano/IA\nintacto' }))
      .toEqual({ ok: true, status: 200, providerMessageId: 'wamid.text' });
    expect(fakeFetch.mock.calls[0][0]).toBe(`${DATAFY_BASE_URL}/v1/123456789/messages`);
    expect(JSON.parse(fakeFetch.mock.calls[0][1].body)).toEqual({ messaging_product: 'whatsapp',
      recipient_type: 'individual', to: '5555999990000', type: 'text', text: { body: 'Texto humano/IA\nintacto' } });
    expect(await adapter.getConnectionStatus!(credentials)).toMatchObject({ status: 'connected', connected: true });
    expect(fakeFetch.mock.calls[1][0]).toBe(`${DATAFY_BASE_URL}/me`);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await adapter.sendText({}, { toPhone: sendInput.toPhone, text: 'hello' }))
      .toMatchObject({ ok: false, error: 'missing_credentials', missingCreds: ['phone_number_id', 'access_token'] });
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledOnce();
  });

  it('duas páginas na origem fixa ignoram URL remota e codificam cursor opaco', async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce(reply({ data: [remote], paging: {
      next: 'https://attacker.invalid?access_token=never-follow', cursors: { after: 'next+/=&token=opaque' },
    } })).mockResolvedValueOnce(reply({ data: [], paging: { cursors: { after: 'terminal' } } }));
    const adapter = createDatafyTemplateTransport({ fetchImpl: fakeFetch });
    const first = await adapter.listTemplates(credentials, { wabaId: createInput.wabaId });
    expect(first.templates[0]).toMatchObject({ remoteId: remote.id, status: 'APPROVED', quality: null, components: remote.components });
    expect(first.nextCursor).toBe('next+/=&token=opaque');
    const last = await adapter.listTemplates(credentials, { wabaId: createInput.wabaId, after: first.nextCursor! });
    expect(last.nextCursor).toBeNull();
    for (const [url] of fakeFetch.mock.calls) {
      const parsed = new URL(url);
      expect(parsed.origin).toBe(DATAFY_BASE_URL);
      expect(parsed.pathname).toBe('/v1/987654321/message_templates');
      expect(parsed.searchParams.get('fields')).toBe(DATAFY_TEMPLATE_FIELDS);
      expect(url).not.toContain('attacker.invalid');
    }
    expect(new URL(fakeFetch.mock.calls[1][0]).searchParams.get('after')).toBe(first.nextCursor);
    expect(fakeFetch.mock.calls[1][0]).toContain('after=next%2B%2F%3D%26token%3Dopaque');
  });

  it('cursor repetido pelo provider falha fechado, e cursor de entrada inválido não chama fetch', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(reply({ data: [], paging: { next: 'https://remote.invalid', cursors: { after: 'a' } } }));
    const adapter = createDatafyTemplateTransport({ fetchImpl: fakeFetch });
    await expect(adapter.listTemplates(credentials, { wabaId: createInput.wabaId, after: 'a' })).rejects.toThrow('template_cursor_cycle');
    await expect(adapter.listTemplates(credentials, { wabaId: createInput.wabaId, after: 'a\n' })).rejects.toThrow('template_cursor_invalid');
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it('create é submissão aceita, preserva categoria efetiva sem declarar usable/approved', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(reply({ id: '5400801403478858', status: 'PENDING', category: 'MARKETING' }));
    const adapter = createDatafyTemplateTransport({ fetchImpl: fakeFetch });
    expect(await adapter.createTemplate(credentials, createInput)).toEqual({ state: 'accepted', status: 200,
      remoteId: '5400801403478858', remoteStatus: 'PENDING', category: 'MARKETING' });
    const [url, init] = fakeFetch.mock.calls[0];
    expect(url).toBe(`${DATAFY_BASE_URL}/v1/987654321/message_templates`);
    expect(JSON.parse(init.body)).toMatchObject({ category: 'UTILITY', parameter_format: 'POSITIONAL',
      components: [{ type: 'BODY', example: { body_text: createInput.definition.examples } }] });
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it.each(['sendTemplate', 'createTemplate'] as const)('%s não inventa aceite/ID em resposta 2xx incompleta', async method => {
    for (const payload of [{}, { id: 12 }, { messages: [{ message_status: 'accepted' }] }]) {
      const fakeFetch = vi.fn().mockResolvedValue(reply(payload));
      const adapter = createDatafyTemplateTransport({ fetchImpl: fakeFetch });
      const result = method === 'sendTemplate' ? await adapter.sendTemplate(credentials, sendInput)
        : await adapter.createTemplate(credentials, createInput);
      expect(result).toMatchObject({ state: 'uncertain', error: 'datafy_template_response_invalid' });
      expect(result).not.toHaveProperty('providerMessageId');
      expect(fakeFetch).toHaveBeenCalledOnce();
    }
  });

  it('200 contraditório com erro e message ID não confirma aceite', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(reply({ messages: [{ id: 'wamid.ambiguous' }], error: { code: 132000 } }));
    const result = await createDatafyTemplateTransport({ fetchImpl: fakeFetch }).sendTemplate(credentials, sendInput);
    expect(result).toMatchObject({ state: 'uncertain' });
    expect(result).not.toHaveProperty('providerMessageId');
  });

  it.each(['sendTemplate', 'createTemplate'] as const)('%s só marca o 429 preproxy como seguro para reagendar', async method => {
    for (const [status, body, state, retryable] of [
      [429, { statusCode: 429, message: 'Rate limit excedido (60 req/min). Tente novamente em 12s.' }, 'rejected', true],
      [401, { statusCode: 401, message: 'Token inválido.' }, 'rejected', false],
      [403, { statusCode: 403, message: 'Operação não permitida via proxy' }, 'rejected', false],
      [409, { statusCode: 409, message: 'Canal pausado' }, 'rejected', false],
      [400, { error: { code: 132000, message: 'private-body' } }, 'rejected', false],
      [429, { error: { code: 4, message: 'private-body' } }, 'uncertain', undefined],
      [500, { error: { message: 'private-body' } }, 'uncertain', undefined],
      [503, { statusCode: 503, message: 'private-body' }, 'uncertain', undefined],
    ] as const) {
      const fakeFetch = vi.fn().mockResolvedValue(reply(body, status));
      const adapter = createDatafyTemplateTransport({ fetchImpl: fakeFetch });
      const result = method === 'sendTemplate' ? await adapter.sendTemplate(credentials, sendInput)
        : await adapter.createTemplate(credentials, createInput);
      expect(result.state).toBe(state);
      expect('retryable' in result ? result.retryable : undefined).toBe(retryable);
      expect(JSON.stringify(result)).not.toContain('private-body');
      expect(fakeFetch).toHaveBeenCalledOnce();
    }
  });

  it.each(['sendTemplate', 'createTemplate'] as const)('%s redige falha fetch pós-POST e retorna uncertain sem retry', async method => {
    const original = new TypeError(`request failed ${credentials.access_token} https://sensitive.invalid/body=private-parameters`);
    const fakeFetch = vi.fn().mockRejectedValue(original);
    const adapter = createDatafyTemplateTransport({ fetchImpl: fakeFetch });
    const result = method === 'sendTemplate' ? await adapter.sendTemplate(credentials, sendInput)
      : await adapter.createTemplate(credentials, createInput);
    expect(result).toEqual({ state: 'uncertain', errorCode: 'PROVIDER_UNAVAILABLE', error: 'datafy_template_fetch_failed' });
    expect(JSON.stringify(result)).not.toContain(credentials.access_token);
    expect(JSON.stringify(result)).not.toContain('private-parameters');
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it('POST aborta em 15s e conserva incerteza; não executa segundo POST', async () => {
    vi.useFakeTimers();
    const fakeFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('private detail', 'AbortError')), { once: true });
    }));
    const result = createDatafyTemplateTransport({ fetchImpl: fakeFetch }).sendTemplate(credentials, sendInput);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fakeFetch.mock.calls[0][1]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ state: 'uncertain', errorCode: 'TIMEOUT', error: 'datafy_template_timeout' });
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it('falha de GET nunca divulga corpo/erro original', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(reply({ statusCode: 403, message: 'private account token' }, 403));
    const adapter = createDatafyTemplateTransport({ fetchImpl: fakeFetch });
    await expect(adapter.listTemplates(credentials, { wabaId: createInput.wabaId })).rejects.toThrow('datafy_template_http_403');
    fakeFetch.mockRejectedValue(new Error(`${credentials.access_token} private URL`));
    await expect(adapter.listTemplates(credentials, { wabaId: createInput.wabaId })).rejects.toThrow('datafy_template_fetch_failed');
  });

  it('credencial/ID/telefone inválido recusa antes de POST e não encaminha segredo/URL', async () => {
    const fakeFetch = vi.fn();
    const adapter = createDatafyTemplateTransport({ fetchImpl: fakeFetch });
    expect(await adapter.sendTemplate({}, sendInput)).toMatchObject({ state: 'rejected', retryable: false, error: 'missing_credentials' });
    expect(await adapter.sendTemplate(credentials, { ...sendInput, phoneNumberId: '../secret' })).toMatchObject({ state: 'rejected', error: 'template_target_invalid' });
    expect(await adapter.sendTemplate(credentials, { ...sendInput, toPhone: '123' })).toMatchObject({ state: 'rejected', error: 'template_input_invalid' });
    expect(await adapter.createTemplate(credentials, { ...createInput, wabaId: 'https://remote.invalid' })).toMatchObject({ state: 'rejected', error: 'template_target_invalid' });
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});

describe("classifyDatafyStatus", () => {
  it("mapeia os códigos próprios da Datafy", () => {
    expect(classifyDatafyStatus(401)).toBe("AUTH_ERROR");
    expect(classifyDatafyStatus(402)).toBe("AUTH_ERROR");
    expect(classifyDatafyStatus(403)).toBe("AUTH_ERROR");
    expect(classifyDatafyStatus(429)).toBe("RATE_LIMITED");
    expect(classifyDatafyStatus(404)).toBe("INSTANCE_NOT_FOUND");
    expect(classifyDatafyStatus(400)).toBe("INVALID_REQUEST");
    expect(classifyDatafyStatus(422)).toBe("INVALID_REQUEST");
    expect(classifyDatafyStatus(500)).toBe("PROVIDER_UNAVAILABLE");
    expect(classifyDatafyStatus(503)).toBe("PROVIDER_UNAVAILABLE");
    expect(classifyDatafyStatus(418)).toBe("UNKNOWN_PROVIDER_ERROR");
  });

  it("devolve null em 2xx", () => {
    expect(classifyDatafyStatus(200)).toBeNull();
    expect(classifyDatafyStatus(201)).toBeNull();
  });
});

describe("parseDatafyAccount", () => {
  it("extrai os quatro ids do /me", () => {
    expect(parseDatafyAccount({
      cliente_id: "cli_123",
      phone_number_id: "123456789012345",
      waba_id: "234567890123456",
      business_id: "345678901234567",
    })).toEqual({
      clienteId: "cli_123",
      phoneNumberId: "123456789012345",
      wabaId: "234567890123456",
      businessId: "345678901234567",
    });
  });

  it("devolve null para corpo que não é objeto", () => {
    for (const body of [null, undefined, "x", 1, []]) {
      expect(parseDatafyAccount(body)).toBeNull();
    }
  });

  it("devolve null quando falta o phone_number_id, que é o que identifica o canal", () => {
    expect(parseDatafyAccount({ cliente_id: "cli_1", waba_id: "w" })).toBeNull();
  });

  it("tolera campos extras e ausência dos opcionais", () => {
    expect(parseDatafyAccount({ phone_number_id: "1", novidade: true })).toEqual({
      clienteId: null, phoneNumberId: "1", wabaId: null, businessId: null,
    });
  });
});

describe("pickDatafyMessageId", () => {
  it("extrai o wamid da resposta de envio", () => {
    expect(pickDatafyMessageId({
      messaging_product: "whatsapp",
      messages: [{ id: "wamid.HBgNNTUxMTk5", message_status: "accepted" }],
    })).toBe("wamid.HBgNNTUxMTk5");
  });

  // Review Focus 5: 200 sem id quebraria o rastreio em silêncio.
  it("devolve undefined quando o 200 não traz id, em vez de inventar", () => {
    for (const body of [{}, { messages: [] }, { messages: [{}] }, { messages: [{ id: "" }] }, null]) {
      expect(pickDatafyMessageId(body)).toBeUndefined();
    }
  });
});
