import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { resolveUnitChannelBinding } from "../../supabase/functions/_shared/whatsapp-org-provider-core";
import { selectDatafyOfflineLegacy } from "../../supabase/functions/_shared/datafy-onboarding-core";

const webhook = readFileSync(resolve(__dirname, "../../supabase/functions/webhook-whatsapp/index.ts"), "utf8");
const start = webhook.indexOf("    const ownMessageEchoes = parseOwnMessageEchoes(provider, payload);");
const end = webhook.indexOf("    // Eco das mensagens da loja", start);
const echoBlock = webhook.slice(start, end);
const manage = readFileSync(resolve(__dirname, "../../supabase/functions/manage-channels/index.ts"), "utf8");
const actionsPath = resolve(__dirname, "../../supabase/functions/_shared/datafy-onboarding-actions.ts");
const actions = existsSync(actionsPath) ? readFileSync(actionsPath, "utf8") : "";

const switchBegin = manage.indexOf('    if (action === "begin_switch")');
const switchEnd = manage.indexOf("    // ── list", switchBegin);
const switchBlock = manage.slice(switchBegin, switchEnd);
const connectionBlock = manage.slice(manage.indexOf("function clientConnection("), manage.indexOf("function supportsClientLifecycle("));
const loadBlock = manage.slice(manage.indexOf("async function loadChannel("), manage.indexOf("async function findUazChannel("));

function switchHarness(options: {
  provider?: string; binding?: { id?: string; provider: string; is_active: boolean | null; status: string; created_at?: string }[];
  listError?: boolean; readError?: boolean; readMissing?: boolean; missingProof?: boolean;
  withoutTargetId?: boolean; migrationGrant?: boolean; grantReadError?: boolean;
  connected?: boolean; writeMissing?: boolean; writeError?: boolean; activationError?: boolean;
} = {}) {
  const stored = { id: "target", unit_id: "unit", provider: options.provider ?? "datafy", status: "connected",
    credentials: { access_token: "synthetic-channel-token" }, webhook_secret: "synthetic-secret",
    manual_echo_verified_at: options.missingProof ? null : "proof", is_active: false };
  const calls: string[] = [], filters: string[][] = [];
  const db = {
    from() {
      let updating = false, projection = "";
      const predicates: string[] = []; filters.push(predicates);
      const result = () => {
        calls.push(updating ? "persist" : "reload");
        if (updating) return { data: options.writeMissing ? null : projection ? { id: stored.id } : null,
          error: options.writeError ? { code: "synthetic_write_error" } : null };
        return { data: options.readMissing ? null : { ...stored }, error: options.readError ? { message: "sensitive database error" } : null };
      };
      const query = {
        select(value: string) { projection = value; return query; },
        update() { updating = true; return query; },
        eq(key: string, value: unknown) { predicates.push(`${key}:${value}`); return query; },
        order() { return query; },
        limit() { return query; },
        maybeSingle() { return Promise.resolve(result()); },
        then(fulfilled: (value: ReturnType<typeof result>) => unknown) { return Promise.resolve(result()).then(fulfilled); },
      };
      return query;
    },
    async rpc(name: string) {
      calls.push(name === "request_whatsapp_channel_activation" ? "intent" : "activate");
      if (name === "activate_whatsapp_channel") {
        if (options.activationError) return { error: { code: "synthetic_activation_error" } };
        stored.is_active = true;
      }
      return { error: null };
    },
  };
  class ChannelActionError extends Error {
    constructor(readonly httpStatus: number, readonly code: string, message: string) { super(message); }
  }
  const adapter = { capabilities: { automaticProvisioning: false }, getConnectionStatus: async () => {
    calls.push("health"); return { connected: options.connected !== false };
  } };
  const execute = new Function("supabase", "ChannelActionError", "loadClientChannels", "resolveDatafyMigrationCandidate", "findDatafyMigrationGrant",
    "getWhatsAppProvider", "tryGetWhatsAppProvider", "supportsClientQr", "resolveChannelCredentials", "jsonResponse", "publicErrorForLifecycle",
    `return (async () => {
      const action = "begin_switch", body = {target_provider: "${options.provider ?? "datafy"}", channel_id:"${options.withoutTargetId ? "" : "target"}"};
      const unitId = "unit", callerId = "actor", requestId = "request", req = {};
      const CLIENT_CHANNEL_COLUMNS = "internal columns";
      ${ts.transpile(connectionBlock + loadBlock + switchBlock, { target: ts.ScriptTarget.ES2022 })}
    })();`);
  const grantLookups: unknown[][] = [];
  return { calls, filters, grantLookups, run: () => execute(db, ChannelActionError,
    async () => { calls.push("binding"); if (options.listError) throw new ChannelActionError(500, "CHANNEL_LIST_FAILED", "Falha ao consultar a conexão."); return (options.binding ?? []).map((channel, index) => ({ id: `channel-${index}`, ...channel })); },
    (channels: { id: string; provider: string; is_active: boolean | null; status: string; created_at?: string }[]) => resolveUnitChannelBinding(channels) ?? selectDatafyOfflineLegacy(channels),
    // O helper real é o mesmo das ações (datafy-onboarding-actions.test.ts cobre o predicado).
    async (...args: unknown[]) => {
      calls.push("grant"); grantLookups.push(args);
      if (options.grantReadError) throw new Error("GRANT_READ_FAILED");
      return options.migrationGrant ? { id: "grant", revoked_at: null, consumed_channel_id: "target", replaces_channel_id: "uaz" } : null;
    },
    () => adapter, () => adapter, () => false,
    async () => stored.credentials,
    (_req: unknown, body: unknown, status = 200) => ({ body, status }),
    (error: Error) => error instanceof ChannelActionError
      ? error : { message: "Falha ao atualizar a conexão.", code: "CHANNEL_ACTION_FAILED", httpStatus: 500 }) };
}

describe("Datafy parceiro: primeira configuração em begin_switch", () => {
  it("inclui Datafy na allowlist e recusa migração sem liberação com 409", () => {
    expect(switchBlock).toMatch(/\["zapi", "uazapi", "waha", "official", "datafy"\]\.includes\(targetProvider\)/);
    expect(switchBlock).toMatch(/409,\s*"DATAFY_MIGRATION_NOT_SUPPORTED",\s*"Esta unidade usa outro provedor\. Libere a migração para a API oficial antes de trocar\."/);
    // Predicado único: o mesmo helper das ações, nunca reimplementado no handler.
    expect(switchBlock).toContain("findDatafyMigrationGrant(supabase, unitId, channels)");
    expect(switchBlock).not.toContain("replaces_channel_id");
    expect(switchBlock).not.toContain("primeira configuração desta unidade");
  });
  it("primeira configuração mantém intenção → prova → saúde → persistência → ativação e DTO seguro", async () => {
    const h = switchHarness(); const response = await h.run();
    expect(response.status).toBe(200);
    expect(h.calls).toEqual(["binding", "reload", "intent", "reload", "health", "persist", "activate", "reload"]);
    expect(response.body).toMatchObject({ success: true, channel: { channel_id: "target", status: "connected" } });
    const serialized = JSON.stringify(response.body);
    for (const secret of ["credentials", "webhook_secret", "synthetic-channel-token", "synthetic-secret"]) expect(serialized).not.toContain(secret);
    expect(h.filters.every((predicates) => predicates.includes("id:target") && predicates.includes("unit_id:unit"))).toBe(true);
  });
  it.each([
    { provider: "zapi", is_active: true, status: "connected" },
    { provider: "zapi", is_active: true, status: "disconnected" },
    { provider: "waha", is_active: null, status: "connected" },
  ])("recusa binding de outro provider sem liberação de migração antes de qualquer mutação: %j", async (binding) => {
    const h = switchHarness({ binding: [binding] });
    expect(await h.run()).toMatchObject({ status: 409, body: {
      code: "DATAFY_MIGRATION_NOT_SUPPORTED",
      error: "Esta unidade usa outro provedor. Libere a migração para a API oficial antes de trocar.",
    } });
    expect(h.calls).toEqual(["binding", "grant"]);
  });
  it("corte da migração: liberação presa ao binding UazAPI segue o fluxo existente até a ativação", async () => {
    const binding = [{ id: "uaz", provider: "uazapi", is_active: true, status: "connected" }];
    const h = switchHarness({ binding, migrationGrant: true });
    const response = await h.run();
    expect(response.status).toBe(200);
    // Migração confere eco e conexão viva ANTES de gravar a intenção.
    expect(h.calls).toEqual(["binding", "grant", "reload", "health", "intent", "reload", "persist", "activate", "reload"]);
    // O helper recebe a MESMA leitura de canais que decidiu o binding, com a unidade do caller.
    expect(h.grantLookups).toHaveLength(1);
    expect(h.grantLookups[0][1]).toBe("unit");
    expect(h.grantLookups[0][2]).toEqual(binding);
  });
  it.each([
    [{ missingProof: true }, "TARGET_CONVERSATION_PARITY_UNVERIFIED", ["binding", "grant", "reload"]],
    [{ connected: false }, "TARGET_NOT_CONNECTED", ["binding", "grant", "reload", "health"]],
  ] as const)("corte de migração sem prontidão (%j) recusa sem armar intenção", async (failure, code, calls) => {
    const h = switchHarness({ binding: [{ id: "uaz", provider: "uazapi", is_active: true, status: "connected" }], migrationGrant: true, ...failure });
    expect(await h.run()).toMatchObject({ status: 409, body: { code } });
    expect(h.calls).toEqual(calls);
    expect(h.calls).not.toContain("intent");
    expect(h.calls).not.toContain("activate");
  });
  it.each([
    [{ missingProof: true }, "TARGET_CONVERSATION_PARITY_UNVERIFIED", ["binding", "grant", "reload"]],
    [{ connected: false }, "TARGET_NOT_CONNECTED", ["binding", "grant", "reload", "health"]],
  ] as const)("legado NULL/desconectado com liberação consumida protege a intenção (%j)", async (failure, code, calls) => {
    const h = switchHarness({
      binding: [{ id: "uaz", provider: "uazapi", is_active: null, status: "disconnected" }],
      migrationGrant: true,
      ...failure,
    });
    expect(await h.run()).toMatchObject({ status: 409, body: { code } });
    expect(h.calls).toEqual(calls);
    expect(h.calls).not.toContain("intent");
    expect(h.calls).not.toContain("activate");
  });
  it("legado NULL/desconectado preparado e pronto confere saúde antes da intenção", async () => {
    const h = switchHarness({
      binding: [{ id: "uaz", provider: "uazapi", is_active: null, status: "disconnected" }],
      migrationGrant: true,
    });
    expect((await h.run()).status).toBe(200);
    expect(h.calls).toEqual(["binding", "grant", "reload", "health", "intent", "reload", "persist", "activate", "reload"]);
  });
  it("legado NULL/desconectado sem liberação recusa antes de intenção", async () => {
    const h = switchHarness({
      binding: [{ id: "uaz", provider: "uazapi", is_active: null, status: "disconnected" }],
    });
    expect(await h.run()).toMatchObject({ status: 409, body: { code: "DATAFY_MIGRATION_NOT_SUPPORTED" } });
    expect(h.calls).toEqual(["binding", "grant"]);
  });
  it("erro na proveniência do alvo sem binding falha fechado antes da intenção", async () => {
    const h = switchHarness({
      binding: [{ id: "uaz", provider: "uazapi", is_active: null, status: "disconnected" }],
      grantReadError: true,
    });
    expect(await h.run()).toMatchObject({ status: 503, body: { code: "MIGRATION_GRANT_UNAVAILABLE" } });
    expect(h.calls).toEqual(["binding", "grant"]);
    expect(h.calls).not.toContain("intent");
  });
  it("troca comum mantém a intenção durável antes da prontidão (comportamento documentado)", async () => {
    const h = switchHarness({ missingProof: true });
    expect(await h.run()).toMatchObject({ status: 409, body: { code: "TARGET_CONVERSATION_PARITY_UNVERIFIED" } });
    expect(h.calls).toEqual(["binding", "reload", "intent", "reload"]);
  });
  it("falha ao ler a liberação de migração é inverificável (503) e recusa antes da intenção", async () => {
    const h = switchHarness({ binding: [{ id: "uaz", provider: "uazapi", is_active: true, status: "connected" }], grantReadError: true });
    const response = await h.run();
    expect(response).toMatchObject({ status: 503, body: { code: "MIGRATION_GRANT_UNAVAILABLE" } });
    expect(JSON.stringify(response)).not.toContain("GRANT_READ_FAILED");
    expect(h.calls).toEqual(["binding", "grant"]);
  });
  it("binding Datafy e primeira configuração não consultam liberação de migração", async () => {
    for (const binding of [[], [{ provider: "datafy", is_active: true, status: "connected" }]]) {
      const h = switchHarness({ binding });
      expect((await h.run()).status).toBe(200);
      expect(h.calls).not.toContain("grant");
    }
  });
  it.each([
    { provider: "datafy", is_active: true, status: "connected" },
    { provider: "datafy", is_active: null, status: "connected" },
    { provider: "zapi", is_active: false, status: "connected" },
  ])("permite binding Datafy ou canal sem binding: %j", async (binding) => {
    expect((await switchHarness({ binding: [binding] }).run()).status).toBe(200);
  });
  it("usa primeiro legado connected e prioriza ativo explícito", async () => {
    const legacy = { provider: "waha", is_active: null, status: "connected", created_at: "2026-01-01" };
    const datafy = { provider: "datafy", is_active: null, status: "connected", created_at: "2026-02-01" };
    expect((await switchHarness({ binding: [datafy, legacy] }).run()).status).toBe(409);
    expect((await switchHarness({ binding: [legacy, { ...datafy, is_active: true }] }).run()).status).toBe(200);
  });
  it.each([{ writeMissing: true }, { writeError: true }])("não ativa sem escrita de saúde confirmada: %j", async (failure) => {
    const h = switchHarness(failure); expect((await h.run()).status).toBe(500); expect(h.calls).not.toContain("activate");
  });
  it.each([{ missingProof: true }, { connected: false }])("conserva gates manuais: %j", async (failure) => {
    const h = switchHarness(failure); expect((await h.run()).status).toBe(409); expect(h.calls).not.toContain("activate");
  });
  it("erro de leitura difere de ausência e é sanitizado", async () => {
    const failed = switchHarness({ readError: true });
    const response = await failed.run();
    expect(response).toMatchObject({ status: 500, body: { code: "CHANNEL_READ_FAILED" } });
    expect(JSON.stringify(response)).not.toContain("sensitive database error");
    expect(failed.calls).not.toContain("intent");
    expect(await switchHarness({ readMissing: true }).run()).toMatchObject({ status: 404, body: { code: "TARGET_CHANNEL_NOT_FOUND" } });
  });
  it("recusa falha na leitura de binding e propaga falha de ativação", async () => {
    const h = switchHarness({ listError: true }); expect((await h.run()).status).toBe(500); expect(h.calls).toEqual(["binding"]);
    expect((await switchHarness({ activationError: true }).run()).status).toBe(500);
  });
  it("descoberta de alvo sem id também falha fechado em erro de leitura", async () => {
    const h = switchHarness({ withoutTargetId: true, readError: true });
    expect(await h.run()).toMatchObject({ status: 500, body: { code: "CHANNEL_READ_FAILED" } });
    expect(h.calls).not.toContain("intent");
  });
  it("preserva troca manual entre providers anteriores", async () => {
    const h = switchHarness({ provider: "waha", binding: [{ provider: "zapi", is_active: true, status: "connected" }] });
    expect((await h.run()).status).toBe(200); expect(h.calls).not.toContain("binding");
  });
});

describe("Datafy parceiro: fronteira das ações", () => {
  it("a preparação de templates só observa conexão confirmada e nunca o preview", async () => {
    const begin = manage.indexOf("    if (DATAFY_ACTIONS.has(String(action))) {");
    const end = manage.indexOf("    const resolveLifecycleChannel", begin);
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    const block = ts.transpile(manage.slice(begin, end), { target: ts.ScriptTarget.ES2022 });
    const execute = new Function("action", "body", "response", "refreshed", `
      const DATAFY_ACTIONS = new Set(["datafy_link_existing", "official_connect_confirm", "datafy_subscribe"]);
      const unitId = "unit", callerId = "caller", requestId = "request", req = {};
      const datafyActions = { handle: async () => response };
      const refreshTemplateConnection = async (...args) => refreshed.push(args);
      const jsonResponse = (_req, payload, status) => ({ payload, status });
      return (async () => { ${block} })();
    `);
    const cases = [
      { action: "datafy_link_existing", body: { phase: "preview" }, response: { status: 200, body: {} }, refresh: false },
      { action: "datafy_link_existing", body: { phase: "link", channel_id: "channel" }, response: { status: 200, body: {} }, refresh: true },
      { action: "official_connect_confirm", body: {}, response: { status: 200, body: { onboardingState: "subscription_pending" } }, refresh: false },
      { action: "official_connect_confirm", body: {}, response: { status: 200, body: { onboardingState: "connected" } }, refresh: true },
      { action: "official_connect_confirm", body: {}, response: { status: 503, body: { onboardingState: "connected" } }, refresh: false },
    ] as const;
    for (const scenario of cases) {
      const refreshed: unknown[][] = [];
      const result = await execute(scenario.action, scenario.body, scenario.response, refreshed);
      expect(result.status).toBe(scenario.response.status);
      expect(refreshed.length).toBe(scenario.refresh ? 1 : 0);
      if (scenario.refresh && scenario.action === "datafy_link_existing") {
        expect(refreshed[0]).toEqual(["unit", "channel"]);
      }
    }
  });

  it("delega depois de autenticar e autorizar owner/gerente ou admin", () => {
    const delegated = manage.indexOf("datafyActions.handle(");
    expect(delegated).toBeGreaterThan(manage.indexOf("await memberLifecycleRole(callerId, unitId)"));
    for (const action of ["official_connection_state", "official_connect_start", "official_connect_confirm"]) {
      expect(manage.slice(manage.indexOf("const CLIENT_LIFECYCLE_ACTIONS"), manage.indexOf("const MANUAL_STATUS"))).toContain(`"${action}"`);
    }
  });

  it("migração: a decisão do teto mora no núcleo; o wiring só faz I/O e fecha os gates se inverificável", () => {
    const wiring = manage.slice(manage.indexOf("const datafyActions = createDatafyOnboardingActions("), manage.indexOf("serve(async (req)"));
    expect(wiring).toContain("gatesAllowed: async (unitId, adminDecisionRecorded, replacementConnection = false)");
    expect(wiring).toContain("await decideReplacementConnectionRecorded({");
    // Só desconta o que o teto conta: instâncias vivas do canal NA organização da unidade.
    expect(wiring).toMatch(/\.from\("whatsapp_instances"\)[\s\S]*\.eq\("channel_id", channelId\)[\s\S]*\.eq\("organization_id", organizationId\)[\s\S]*\.neq\("lifecycle_state", "ENDED"\)/);
    expect(wiring).toContain("const { organizationId } = await getUnitContext(unitId);");
    expect(wiring.match(/if \(error\) throw new Error\(/g)).toHaveLength(2);
    expect(wiring).toContain("if (replacement.ok === false) return false;");
    expect(wiring).toMatch(/"NEW_PROVISIONING",\s*adminDecisionRecorded,\s*replacement\.recorded,?\s*\)/);
    // Nada de regra reimplementada no handler.
    expect(wiring).not.toMatch(/=== 1/);
  });

  it("provisiona com decisão administrativa persistida e allowance NEW_PROVISIONING", () => {
    expect(manage).toMatch(/checkChannelConnectionAllowance\(\s*unitId,\s*"datafy",\s*\{\},\s*"NEW_PROVISIONING",\s*adminDecisionRecorded/);
    expect(actions).toContain("decideStartStep(");
    expect(actions).toContain("decideConfirm(");
    expect(actions).toContain("decideSubscribeStep(");
    expect(actions).toContain("claim_datafy_onboarding_step");
    expect(actions).toContain("datafyMutationMayHaveApplied(");
  });

  it("canal remoto vem do banco e nenhum corpo fornece identidade ou Coexistence", () => {
    expect(actions).not.toMatch(/body\.(?:datafy_channel_id|phone_number_id|waba_id|external_instance_id|coexistence)/);
    // Admin may select a LOCAL row, always loaded by unit + provider + id.
    expect(actions).toContain('loadChannel(unitId, body.channel_id as string | undefined)');
    expect(actions).toContain('.eq("unit_id", unitId).eq("provider", "datafy")');
    expect(actions).toContain('if (id) query = query.eq("id", id)');
    expect(actions.indexOf('if (action === "official_connect_confirm") return await confirmConnection')).toBeLessThan(actions.indexOf('body.channel_id'));
    expect(actions).not.toMatch(/coexistence\s*:/i);
    expect(manage).not.toContain("alreadyConnected");
    expect(actions).not.toContain("alreadyConnected");
    expect(actions).toContain('.eq("unit_id", unitId)');
  });

  it("logs e DTO não expõem credenciais; o link tem no-store", () => {
    expect(actions).toContain('"Cache-Control": "no-store"');
    expect(actions).not.toMatch(/(?:console\.\w+|jsonLog)\([^;]*(?:channel_token|webhook_secret|accountToken|\.url)/);
    expect(actions).toContain("isDisposableRemoteChannel(");
  });
  it("cada POST de custo possui claim e cada DELETE exige descartabilidade no bloco executor", () => {
    const create = actions.slice(actions.indexOf("async function startConnection"), actions.indexOf("async function identities"));
    expect(create.indexOf('await claimStep(o, "create_channel"')).toBeGreaterThan(-1);
    expect(create.indexOf("client.createChannel(")).toBeGreaterThan(create.indexOf('await claimStep(o, "create_channel"'));
    const subscribe = actions.slice(actions.indexOf("async function subscribeChannel"), actions.indexOf("async function confirmConnection"));
    expect(subscribe).toContain('claimOperation(unitId, channel.id, actorId, "subscribe")');
    expect(actions).toContain('"claim_datafy_channel_operation"');
    expect(subscribe.indexOf("client.subscribe(")).toBeGreaterThan(subscribe.indexOf('await claimStep(o!, "subscribe"'));
    const remove = actions.slice(actions.indexOf("async function deleteDisposable"), actions.indexOf("async function state"));
    expect(remove.indexOf("client.deleteChannel(")).toBeGreaterThan(remove.indexOf("isDisposableRemoteChannel(snapshot)"));
    expect(actions.match(/\.deleteChannel\(/g)).toHaveLength(1);
    expect(actions.match(/\.createChannel\(/g)).toHaveLength(1);
    expect(actions.match(/\.subscribe\(/g)).toHaveLength(1);
  });
});

type Channel = {
  status: string;
  activation_requested_at: string | null;
  manual_echo_verified_at: string | null;
  is_active: boolean;
  template_credential_revision: number;
  external_instance_id: string | null;
};
const eligible = (): Channel => ({
  status: "connected",
  activation_requested_at: "2026-10-14T12:00:00Z",
  manual_echo_verified_at: null,
  is_active: false,
  template_credential_revision: 0,
  external_instance_id: "remote-id",
});

// Executa só o bloco real de wiring, sem importar a EF (Deno/env/provedores).
// O fake devolve respostas PostgREST; decisões e ordem são as do index.ts.
function harness(options: {
  channel?: Channel;
  fresh?: Partial<Channel>;
  manual?: boolean;
  identityMatches?: boolean;
  writeError?: boolean;
  writeMissing?: boolean;
  readError?: boolean;
  readMissing?: boolean;
  activationError?: boolean;
} = {}) {
  const channel = { ...(options.channel ?? eligible()) };
  const stored = { ...channel, ...options.fresh };
  const calls: string[] = [];
  const finishes: string[] = [];
  const filters: string[][] = [];
  const rpcArgs: unknown[] = [];
  let activationError = options.activationError;
  const supabase = {
    from(table: string) {
      expect(table).toBe("whatsapp_channels");
      let updating = false;
      let counting = false;
      let projection = "";
      let patch: Partial<Channel> = {};
      let expectedRevision: unknown;
      let expectedExternal: unknown;
      const queryFilters: string[] = [];
      filters.push(queryFilters);
      const result = () => {
        if (updating) {
          calls.push("persist");
          if ((expectedRevision !== undefined && expectedRevision !== stored.template_credential_revision)
            || (expectedExternal !== undefined && expectedExternal !== stored.external_instance_id)) return { data: null, error: null };
          if (options.writeError) return { data: null, error: { code: "write_failed" } };
          if (options.writeMissing) return { data: null, error: null };
          Object.assign(stored, patch);
          return { data: projection ? { id: "channel-id" } : null, error: null };
        }
        if (counting) return { count: 1, error: null };
        calls.push("reload");
        if ((expectedRevision !== undefined && expectedRevision !== stored.template_credential_revision)
          || (expectedExternal !== undefined && expectedExternal !== stored.external_instance_id)) return { data: null, error: null };
        if (options.readError) return { data: null, error: { code: "read_failed" } };
        return { data: options.readMissing ? null : { ...stored }, error: null };
      };
      const builder = {
        update(value: Partial<Channel>) { updating = true; patch = value; return builder; },
        select(value: string, opts?: { head?: boolean }) {
          projection = value;
          counting = opts?.head === true;
          return builder;
        },
        eq(key: string, value: unknown) { queryFilters.push(`${key}:${value}`); if (key === "template_credential_revision") expectedRevision = value; if (key === "external_instance_id") expectedExternal = value; return builder; },
        is(key: string, value: unknown) { queryFilters.push(`${key}:${value}`); if (key === "external_instance_id") expectedExternal = value; return builder; },
        maybeSingle() { return Promise.resolve(result()); },
        single() { return Promise.resolve(result()); },
        then(fulfilled: (value: ReturnType<typeof result>) => unknown) {
          return Promise.resolve(result()).then(fulfilled);
        },
      };
      return builder;
    },
    async rpc(name: string, args: unknown) {
      expect(name).toBe("activate_whatsapp_channel");
      calls.push("activate");
      rpcArgs.push(args);
      // A ativação não pode anteceder a prova persistida, inclusive no replay.
      expect(stored.manual_echo_verified_at).toBeTruthy();
      if (activationError) return { error: { code: "activation_failed" } };
      stored.is_active = true;
      stored.activation_requested_at = null;
      return { error: null };
    },
  };
  const compiled = ts.transpile(echoBlock, { target: ts.ScriptTarget.ES2022 });
  const execute = new Function(
    "supabase", "channel", "parseOwnMessageEchoes", "manualEchoMatchesConfiguredChannel", "finish",
    `return (async () => {
      const provider = "datafy", payload = {}, credentials = {};
      const unitId = "unit-id", channelId = "channel-id", requestId = "request-id";
      const jsonLog = () => {};
      ${compiled}
    })();`,
  );
  return {
    calls, finishes, filters, rpcArgs, stored,
    retry() { activationError = false; },
    run(snapshot = channel) {
      return execute(supabase, snapshot,
        () => options.manual === false ? [{ source: "provider_api" }] : [{ source: "manual_device" }],
        () => options.identityMatches !== false,
        async (outcome: string) => { finishes.push(outcome); },
      );
    },
  };
}

describe("Datafy parceiro: wiring de ativação pelo eco", () => {
  it("mantém RPC no bloco do eco, após persistência confirmada e releitura elegível", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const persist = echoBlock.indexOf("manual_echo_verified_at: new Date().toISOString()");
    const activation = echoBlock.indexOf('rpc("activate_whatsapp_channel"');
    expect(persist).toBeGreaterThan(-1);
    expect(activation).toBeGreaterThan(persist);
    expect(echoBlock).toContain('verificationQuery.select("id").maybeSingle()');
    expect(echoBlock).toMatch(/if \(verificationError \|\| !verifiedChannel\) throw new Error/);
    expect(echoBlock).toContain('.select("status, activation_requested_at, manual_echo_verified_at, template_credential_revision")');
    expect(echoBlock).toMatch(/activationChannel\.activation_requested_at\s*&&\s*activationChannel\.status === "connected"/);
    expect(echoBlock).toMatch(/if \(activateError\) throw new Error\("manual_echo_activation_failed"\)/);
    expect(echoBlock).toContain('"conversation_parity_verified_activated"');
  });

  it("persiste, recarrega e ativa nessa ordem com tenant e intenção do banco", async () => {
    const h = harness();
    await h.run();
    expect(h.calls).toEqual(["persist", "reload", "activate"]);
    expect(h.filters[0]).toEqual(["id:channel-id", "unit_id:unit-id", "template_credential_revision:0", "external_instance_id:remote-id"]);
    expect(h.filters[1]).toEqual(["id:channel-id", "unit_id:unit-id", "template_credential_revision:0", "external_instance_id:remote-id"]);
    expect(h.rpcArgs).toEqual([{
      p_unit_id: "unit-id", p_channel_id: "channel-id", p_actor_id: null, p_request_id: "request-id",
    }]);
    expect(h.finishes).toEqual(["conversation_parity_verified_activated"]);
  });

  it.each(["disconnected", "connecting", "provider_error"])("não ativa canal %s", async (status) => {
    const h = harness({ fresh: { status } });
    await h.run();
    expect(h.calls).toEqual(["persist", "reload"]);
    expect(h.finishes).toEqual(["conversation_parity_verified"]);
  });

  it("não ativa sem pedido, mesmo se o snapshot inicial tinha intenção", async () => {
    const h = harness({ fresh: { activation_requested_at: null } });
    await h.run();
    expect(h.calls).toEqual(["persist", "reload"]);
  });

  it("usa status atual: connected depois do snapshot também pode ativar", async () => {
    const h = harness({ channel: { ...eligible(), status: "connecting" }, fresh: { status: "connected" } });
    await h.run();
    expect(h.calls).toEqual(["persist", "reload", "activate"]);
  });

  it.each([{ writeError: true }, { writeMissing: true }])("recusa persistência não confirmada: %j", async (failure) => {
    const h = harness(failure);
    await expect(h.run()).rejects.toThrow("channel_parity_verification_persist_failed");
    expect(h.calls).toEqual(["persist"]);
    expect(h.finishes).toEqual([]);
  });

  it.each([{ readError: true }, { readMissing: true }])("recusa releitura não confirmada: %j", async (failure) => {
    const h = harness(failure);
    await expect(h.run()).rejects.toThrow("channel_parity_activation_read_failed");
    expect(h.calls).toEqual(["persist", "reload"]);
    expect(h.finishes).toEqual([]);
  });

  it("reentrega recupera falha de ativação depois da prova já persistida", async () => {
    const h = harness({ activationError: true });
    await expect(h.run()).rejects.toThrow("manual_echo_activation_failed");
    expect(h.stored.manual_echo_verified_at).toBeTruthy();
    expect(h.finishes).toEqual([]);
    h.retry();
    await h.run({ ...h.stored });
    expect(h.calls).toEqual(["persist", "reload", "activate", "reload", "activate"]);
    expect(h.finishes).toEqual(["conversation_parity_verified_activated"]);
  });

  it("prova removida depois do snapshot não autoriza ativação", async () => {
    const h = harness({ channel: { ...eligible(), manual_echo_verified_at: "earlier-proof" }, fresh: { manual_echo_verified_at: null } });
    await h.run();
    expect(h.calls).toEqual(["reload"]);
  });

  it.each([{ manual: false }, { identityMatches: false }])("eco sem prova humana válida não ativa: %j", async (input) => {
    const h = harness(input);
    await h.run();
    expect(h.calls).toEqual([]);
    expect(h.rpcArgs).toEqual([]);
  });
  it("rotação/relink após admissão recusa prova de eco de geração antiga", async () => {
    const h = harness({ fresh: { template_credential_revision: 1 } });
    await expect(h.run()).rejects.toThrow("channel_parity_verification_persist_failed");
    expect(h.stored.manual_echo_verified_at).toBeNull();
    expect(h.calls).toEqual(["persist"]);
  });
  it("replay que já tinha prova também não ativa geração trocada", async () => {
    const h = harness({ channel: { ...eligible(), manual_echo_verified_at: "proof" },
      fresh: { template_credential_revision: 1, manual_echo_verified_at: null } });
    await expect(h.run()).rejects.toThrow("channel_parity_activation_read_failed");
    expect(h.calls).toEqual(["reload"]);
  });
  it("troca do remoto também recusa eco antigo mesmo sem mudança de token/segredo", async () => {
    const h = harness({ fresh: { external_instance_id: "new-remote" } });
    await expect(h.run()).rejects.toThrow("channel_parity_verification_persist_failed");
    expect(h.calls).toEqual(["persist"]);
  });
});
