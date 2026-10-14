import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const webhook = readFileSync(resolve(__dirname, "../../supabase/functions/webhook-whatsapp/index.ts"), "utf8");
const start = webhook.indexOf("    const ownMessageEchoes = parseOwnMessageEchoes(provider, payload);");
const end = webhook.indexOf("    // Eco das mensagens da loja", start);
const echoBlock = webhook.slice(start, end);
const manage = readFileSync(resolve(__dirname, "../../supabase/functions/manage-channels/index.ts"), "utf8");
const actionsPath = resolve(__dirname, "../../supabase/functions/_shared/datafy-onboarding-actions.ts");
const actions = existsSync(actionsPath) ? readFileSync(actionsPath, "utf8") : "";

describe("Datafy parceiro: fronteira das ações", () => {
  it("delega depois de autenticar e autorizar owner/gerente ou admin", () => {
    const delegated = manage.indexOf("datafyActions.handle(");
    expect(delegated).toBeGreaterThan(manage.indexOf("await memberLifecycleRole(callerId, unitId)"));
    for (const action of ["official_connection_state", "official_connect_start", "official_connect_confirm"]) {
      expect(manage.slice(manage.indexOf("const CLIENT_LIFECYCLE_ACTIONS"), manage.indexOf("const MANUAL_STATUS"))).toContain(`"${action}"`);
    }
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
    expect(actions).not.toMatch(/body\.(?:datafy_channel_id|phone_number_id|waba_id|channel_id|coexistence)/);
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
    expect(subscribe).toContain('"claim_datafy_existing_subscription"');
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
};
const eligible = (): Channel => ({
  status: "connected",
  activation_requested_at: "2026-10-14T12:00:00Z",
  manual_echo_verified_at: null,
  is_active: false,
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
      const queryFilters: string[] = [];
      filters.push(queryFilters);
      const result = () => {
        if (updating) {
          calls.push("persist");
          if (options.writeError) return { data: null, error: { code: "write_failed" } };
          if (options.writeMissing) return { data: null, error: null };
          Object.assign(stored, patch);
          return { data: projection ? { id: "channel-id" } : null, error: null };
        }
        if (counting) return { count: 1, error: null };
        calls.push("reload");
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
        eq(key: string, value: unknown) { queryFilters.push(`${key}:${value}`); return builder; },
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
    expect(echoBlock).toMatch(/\.select\("id"\)\s*\.maybeSingle\(\)/);
    expect(echoBlock).toMatch(/if \(verificationError \|\| !verifiedChannel\) throw new Error/);
    expect(echoBlock).toContain('.select("status, activation_requested_at, manual_echo_verified_at")');
    expect(echoBlock).toMatch(/activationChannel\.activation_requested_at\s*&&\s*activationChannel\.status === "connected"/);
    expect(echoBlock).toMatch(/if \(activateError\) throw new Error\("manual_echo_activation_failed"\)/);
    expect(echoBlock).toContain('"conversation_parity_verified_activated"');
  });

  it("persiste, recarrega e ativa nessa ordem com tenant e intenção do banco", async () => {
    const h = harness();
    await h.run();
    expect(h.calls).toEqual(["persist", "reload", "activate"]);
    expect(h.filters[0]).toEqual(["id:channel-id", "unit_id:unit-id"]);
    expect(h.filters[1]).toEqual(["id:channel-id", "unit_id:unit-id"]);
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
});
