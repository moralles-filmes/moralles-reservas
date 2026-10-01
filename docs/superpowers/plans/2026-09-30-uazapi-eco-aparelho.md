# UazAPI: eco do aparelho — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O eco das mensagens que a equipe manda pelo aparelho no canal UazAPI passa a ser aceito (âncora no `token` da instância) e entra no thread como humano, sem afrouxar a guarda de identidade de canal.

**Architecture:** As três funções de identidade de canal no payload saem do `webhook-whatsapp/index.ts` (inalcançável pelo vitest) para um núcleo puro `_shared/whatsapp-echo-identity-core.ts`. Só o ramo UazAPI de `manualEchoMatchesConfiguredChannel` muda de regra. O handler passa a gravar `meta.reason` em toda recusa `webhook_unauthorized`.

**Tech Stack:** TypeScript (Deno nas Edge Functions, sem Deno local), Vitest, ESLint (só `no-undef` em `supabase/functions/**`), Supabase CLI.

**Spec:** [docs/superpowers/specs/2026-09-30-uazapi-eco-aparelho-design.md](../specs/2026-09-30-uazapi-eco-aparelho-design.md)

## Global Constraints

- Todo comando roda de dentro da worktree `.claude/worktrees/uazapi-eco` (branch `fix/uazapi-eco-aparelho`).
- `npm run typecheck` é `tsc -b --noEmit`; nunca `tsc --noEmit` sem `-b`. Baseline: zero erros.
- `tsc -b` NÃO alcança `supabase/functions/`. Não há Deno local. No `index.ts`, a única checagem automática é o eslint `no-undef` mais o teste estático; leia os imports com cuidado.
- `tsconfig.app.json` tem `strict: false`: use `x.ok === false` / early-return para estreitar uniões, nunca `!x.ok`.
- Z-API, WAHA e Meta-shaped (`official`, `datafy`): comportamento IDÊNTICO ao atual. Só o ramo UazAPI muda.
- Comparação de segredo sempre em tempo constante. Vazio nunca é igual a vazio.
- `meta` de log/outcome só carrega NOME de guarda, nunca valor de payload, telefone ou token.
- `git add <caminho>` com escopo explícito; nunca `git add .`/`-A`. Commits terminam com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `CLAUDE.md` e `AGENTS.md` mudam juntos, no mesmo commit.
- Deploy: apenas `webhook-whatsapp`. Nenhum outro arquivo de `_shared/` muda.

## Review Focus

1. **Token vazio no payload E token de instância vazio no canal** → deve NÃO casar (armadilha "vazio == vazio"). Teste na Task 1.
2. **Token com o prefixo certo e tamanho diferente** (ou com espaço) → NÃO casa; nada de trim nem comparação por prefixo. Teste na Task 1.
3. **`instanceId` presente e plausível, sem `token`** → NÃO casa: a âncora antiga sozinha não prova mais nada. Teste na Task 1.
4. **Lote Meta/Datafy com dois `phone_number_id` diferentes** → NÃO casa (a guarda anti-cross-tenant tem que sobreviver à mudança de arquivo). Teste na Task 1.
5. **Alguém adiciona uma sétima recusa `webhook_unauthorized` sem `reason`** → o teste estático reprova. Teste na Task 2.

---

### Task 1: Núcleo puro de identidade de canal + testes

**Files:**
- Create: `supabase/functions/_shared/whatsapp-echo-identity-core.ts`
- Create: `src/lib/whatsapp-echo-identity-core.test.ts`
- Modify: `docs/superpowers/specs/2026-09-30-uazapi-eco-aparelho-design.md` (assinatura de 3 argumentos)

**Interfaces:**
- Consumes: `isMetaShapedProvider(provider: string): boolean`, `type ChannelCredentials`, `type WhatsAppProviderName` e (só no teste) `parseUazApiOwnMessageEcho(payload)`, todos de `supabase/functions/_shared/whatsapp-provider-core.ts`.
- Produces (usados pela Task 2):
  - `metaPayloadMatchesChannel(payload: unknown, credentials: ChannelCredentials): boolean`
  - `manualEchoMatchesConfiguredChannel(provider: WhatsAppProviderName, payload: unknown, credentials: ChannelCredentials): boolean`. **3 argumentos**: o antigo 4º, `externalInstanceId`, sai.
  - `declaredProviderIdentityMatchesChannel(provider: WhatsAppProviderName, payload: unknown, credentials: ChannelCredentials): boolean`

- [ ] **Step 0: Instalar dependências na worktree**

A worktree nasce sem `node_modules`.

Run: `npm ci`
Expected: termina sem erro (o `.npmrc` já força `legacy-peer-deps`).

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/lib/whatsapp-echo-identity-core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  declaredProviderIdentityMatchesChannel,
  manualEchoMatchesConfiguredChannel,
  metaPayloadMatchesChannel,
} from "../../supabase/functions/_shared/whatsapp-echo-identity-core";
import { parseUazApiOwnMessageEcho } from "../../supabase/functions/_shared/whatsapp-provider-core";

const INSTANCE_TOKEN = "tok-instancia-exemplo-0123456789abcdef";

// Chaves de topo MEDIDAS em produção (instrumentação de forma, 30/09/2026):
// BaseUrl, EventType, chat, chatSource, instanceName, message, owner, token.
// Valores fictícios — nenhum telefone, id ou token real.
function uazApiEcho(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    BaseUrl: "https://exemplo.uazapi.com",
    EventType: "messages",
    chat: {},
    chatSource: "",
    instanceName: "instancia-exemplo",
    message: {
      chatid: "5511988887777@s.whatsapp.net",
      fromMe: true,
      wasSentByApi: false,
      isGroup: false,
      messageid: "3EB0AAAAAAAAAAAAAAAAAA",
      text: "Sua mesa está confirmada.",
      messageTimestamp: Date.UTC(2026, 0, 15, 12, 0, 0),
    },
    owner: "5511900001111",
    token: INSTANCE_TOKEN,
    ...overrides,
  };
}

const uazCreds = { instance_token: INSTANCE_TOKEN };

function metaBatch(...ids: string[]) {
  return { entry: [{ changes: ids.map((id) => ({ value: { metadata: { phone_number_id: id } } })) }] };
}

describe("manualEchoMatchesConfiguredChannel — UazAPI", () => {
  it("o envelope medido é eco do aparelho para o parser de produção e não traz as âncoras antigas", () => {
    // Amarra a fixture ao parser real: é exatamente este payload que chegava à
    // guarda e era recusado com 401.
    expect(parseUazApiOwnMessageEcho(uazApiEcho())?.source).toBe("manual_device");
    for (const anchor of ["instanceId", "instance_id", "instance"]) {
      expect(Object.keys(uazApiEcho())).not.toContain(anchor);
    }
  });

  it("casa quando o token do envelope é o token da instância do canal", () => {
    expect(manualEchoMatchesConfiguredChannel("uazapi", uazApiEcho(), uazCreds)).toBe(true);
  });

  it("não casa sem token, com token vazio ou com token que não é string", () => {
    for (const token of [undefined, null, "", 123, { value: INSTANCE_TOKEN }, [INSTANCE_TOKEN]]) {
      expect(manualEchoMatchesConfiguredChannel("uazapi", uazApiEcho({ token }), uazCreds)).toBe(false);
    }
  });

  // Review Focus 2: sem trim, sem prefixo.
  it("não casa com token de outra instância, nem com prefixo, extensão ou espaço do token certo", () => {
    for (const token of [
      "tok-instancia-OUTRA-0123456789abcdefg",
      INSTANCE_TOKEN.slice(0, -1),
      `${INSTANCE_TOKEN}x`,
      ` ${INSTANCE_TOKEN}`,
    ]) {
      expect(manualEchoMatchesConfiguredChannel("uazapi", uazApiEcho({ token }), uazCreds)).toBe(false);
    }
  });

  // Review Focus 1: vazio contra vazio não pode ser "igual".
  it("não casa quando o canal não tem token de instância resolvido", () => {
    for (const creds of [{}, { instance_token: "" }]) {
      expect(manualEchoMatchesConfiguredChannel("uazapi", uazApiEcho(), creds)).toBe(false);
      expect(manualEchoMatchesConfiguredChannel("uazapi", uazApiEcho({ token: "" }), creds)).toBe(false);
    }
  });

  // Review Focus 3: a âncora antiga, sozinha, não prova mais nada.
  it("instanceId no payload sem token não basta", () => {
    const payload = uazApiEcho({ token: undefined, instanceId: "inst-1", instance: { id: "inst-1" } });
    expect(manualEchoMatchesConfiguredChannel("uazapi", payload, uazCreds)).toBe(false);
  });

  it("payload que não é objeto não casa", () => {
    for (const payload of [null, undefined, "x", 1]) {
      expect(manualEchoMatchesConfiguredChannel("uazapi", payload, uazCreds)).toBe(false);
    }
  });
});

describe("manualEchoMatchesConfiguredChannel — Z-API, WAHA e Meta (regra inalterada)", () => {
  it("Z-API casa pelo instanceId na raiz ou aninhado em payload, com trim", () => {
    const creds = { instance_id: "inst-1" };
    expect(manualEchoMatchesConfiguredChannel("zapi", { instanceId: "inst-1" }, creds)).toBe(true);
    expect(manualEchoMatchesConfiguredChannel("zapi", { instance_id: " inst-1 " }, creds)).toBe(true);
    expect(manualEchoMatchesConfiguredChannel("zapi", { payload: { instanceId: "inst-1" } }, creds)).toBe(true);
  });

  it("Z-API não casa com instância divergente, ausente ou canal sem instance_id", () => {
    const creds = { instance_id: "inst-1" };
    expect(manualEchoMatchesConfiguredChannel("zapi", { instanceId: "inst-2" }, creds)).toBe(false);
    expect(manualEchoMatchesConfiguredChannel("zapi", { fromMe: true }, creds)).toBe(false);
    expect(manualEchoMatchesConfiguredChannel("zapi", { instanceId: "inst-1" }, {})).toBe(false);
  });

  it("WAHA casa pela session, com 'default' quando o canal não define session_name", () => {
    expect(manualEchoMatchesConfiguredChannel("waha", { session: "default" }, {})).toBe(true);
    expect(manualEchoMatchesConfiguredChannel("waha", { session: "loja" }, { session_name: "loja" })).toBe(true);
    expect(
      manualEchoMatchesConfiguredChannel("waha", { payload: { session: "loja" } }, { session_name: "loja" }),
    ).toBe(true);
  });

  it("WAHA não casa com session divergente ou ausente", () => {
    expect(manualEchoMatchesConfiguredChannel("waha", { session: "outra" }, { session_name: "loja" })).toBe(false);
    expect(manualEchoMatchesConfiguredChannel("waha", {}, {})).toBe(false);
  });

  it.each(["official", "datafy"] as const)(
    "%s casa só quando todo change declara o phone_number_id do canal",
    (provider) => {
      const creds = { phone_number_id: "111" };
      expect(manualEchoMatchesConfiguredChannel(provider, metaBatch("111"), creds)).toBe(true);
      expect(manualEchoMatchesConfiguredChannel(provider, metaBatch("111", "111"), creds)).toBe(true);
      // Review Focus 4: lote misturando outro número do mesmo app.
      expect(manualEchoMatchesConfiguredChannel(provider, metaBatch("111", "222"), creds)).toBe(false);
      expect(manualEchoMatchesConfiguredChannel(provider, metaBatch(), creds)).toBe(false);
      expect(manualEchoMatchesConfiguredChannel(provider, metaBatch("111"), {})).toBe(false);
    },
  );
});

describe("metaPayloadMatchesChannel", () => {
  it("ignora espaços no phone_number_id e recusa payload sem entry", () => {
    expect(metaPayloadMatchesChannel(metaBatch(" 111 "), { phone_number_id: "111" })).toBe(true);
    expect(metaPayloadMatchesChannel({}, { phone_number_id: "111" })).toBe(false);
    expect(metaPayloadMatchesChannel(null, { phone_number_id: "111" })).toBe(false);
  });
});

describe("declaredProviderIdentityMatchesChannel", () => {
  it("Z-API e WAHA: ausência de identidade declarada passa, divergência não", () => {
    expect(declaredProviderIdentityMatchesChannel("zapi", { fromMe: false }, { instance_id: "inst-1" })).toBe(true);
    expect(declaredProviderIdentityMatchesChannel("zapi", { instanceId: "inst-1" }, { instance_id: "inst-1" })).toBe(true);
    expect(declaredProviderIdentityMatchesChannel("zapi", { instanceId: "inst-2" }, { instance_id: "inst-1" })).toBe(false);
    expect(declaredProviderIdentityMatchesChannel("waha", {}, {})).toBe(true);
    expect(declaredProviderIdentityMatchesChannel("waha", { session: "default" }, {})).toBe(true);
    expect(declaredProviderIdentityMatchesChannel("waha", { session: "outra" }, { session_name: "loja" })).toBe(false);
  });

  it("demais providers e payload que não é objeto passam (as âncoras deles são outras guardas)", () => {
    expect(declaredProviderIdentityMatchesChannel("uazapi", uazApiEcho({ token: "qualquer" }), {})).toBe(true);
    expect(declaredProviderIdentityMatchesChannel("official", {}, {})).toBe(true);
    expect(declaredProviderIdentityMatchesChannel("zapi", null, { instance_id: "inst-1" })).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npx vitest run src/lib/whatsapp-echo-identity-core.test.ts`
Expected: FAIL. O vitest não resolve o import de `whatsapp-echo-identity-core`, porque o arquivo ainda não existe.

- [ ] **Step 3: Implementar o núcleo**

Criar `supabase/functions/_shared/whatsapp-echo-identity-core.ts`. Os ramos Z-API, WAHA e Meta são cópia literal do código atual de `supabase/functions/webhook-whatsapp/index.ts` (linhas 141–228, funções `metaPhoneNumberIds`, `metaPayloadMatchesChannel`, `manualEchoMatchesConfiguredChannel`, `declaredProviderIdentityMatchesChannel`). Só o ramo UazAPI é novo:

```ts
/**
 * Identidade de canal declarada no PAYLOAD do webhook WhatsApp: "este evento,
 * já autenticado pelo segredo/assinatura do canal, declara o canal certo?".
 *
 * Vive em `_shared/` porque o vitest não importa o `webhook-whatsapp`
 * (`serve()` no carregamento + imports de `deno.land`), e regra de identidade
 * escrita lá só se confere por leitura.
 *
 * UazAPI: o envelope real tem as chaves de topo `BaseUrl, EventType, chat,
 * chatSource, instanceName, message, owner, token` — NÃO há `instanceId`,
 * `instance_id` nem `instance`. A âncora do eco é o `token`, o segredo da
 * instância. A comparação acontece AQUI, e não é herdada da checagem de token
 * que o handler faz antes: se aquela checagem mudar de lugar, esta guarda não
 * pode virar decorativa sem nenhum teste reprovar.
 */
import {
  isMetaShapedProvider,
  type ChannelCredentials,
  type WhatsAppProviderName,
} from "./whatsapp-provider-core.ts";

// Gêmea das cópias privadas em `security.ts` e `whatsapp-providers.ts`.
// Exportar a de `whatsapp-providers.ts` mudaria um arquivo importado por nove
// Edge Functions, todas a redeployar.
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function metaPhoneNumberIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const entries = Array.isArray(record.entry) ? record.entry : [];
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const changes = Array.isArray((entry as Record<string, unknown>).changes)
      ? (entry as Record<string, unknown>).changes as unknown[]
      : [];
    for (const change of changes) {
      if (!change || typeof change !== "object") continue;
      const value = (change as Record<string, unknown>).value;
      if (!value || typeof value !== "object") continue;
      const metadata = (value as Record<string, unknown>).metadata;
      if (!metadata || typeof metadata !== "object") continue;
      const id = (metadata as Record<string, unknown>).phone_number_id;
      if (typeof id === "string" && id.trim()) ids.push(id.trim());
    }
  }
  return ids;
}

/**
 * A assinatura Meta autentica o app, não o tenant/canal escolhido pela URL.
 * Todo change do lote precisa declarar exatamente o phone_number_id do binding.
 */
export function metaPayloadMatchesChannel(payload: unknown, credentials: ChannelCredentials): boolean {
  const expected = credentials.phone_number_id?.trim();
  if (!expected) return false;
  const ids = metaPhoneNumberIds(payload);
  return ids.length > 0 && ids.every((id) => id === expected);
}

/**
 * O eco do aparelho é a prova de paridade de conversa do canal: só conta se o
 * payload declarar POSITIVAMENTE o canal configurado. Ausência de âncora não
 * casa.
 */
export function manualEchoMatchesConfiguredChannel(
  provider: WhatsAppProviderName,
  payload: unknown,
  credentials: ChannelCredentials,
): boolean {
  if (!payload || typeof payload !== "object") return false;
  const root = payload as Record<string, unknown>;
  const nested = root.payload && typeof root.payload === "object"
    ? root.payload as Record<string, unknown>
    : root;

  if (isMetaShapedProvider(provider)) return metaPayloadMatchesChannel(payload, credentials);
  if (provider === "zapi") {
    const actual = [nested.instanceId, nested.instance_id, root.instanceId, root.instance_id]
      .find((value) => typeof value === "string" && value.trim()) as string | undefined;
    return !!actual && actual.trim() === credentials.instance_id?.trim();
  }
  if (provider === "waha") {
    const actual = [root.session, nested.session]
      .find((value) => typeof value === "string" && value.trim()) as string | undefined;
    return !!actual && actual.trim() === (credentials.session_name?.trim() || "default");
  }
  if (provider === "uazapi") {
    const actual = root.token;
    const expected = credentials.instance_token ?? "";
    return typeof actual === "string"
      && actual.length > 0
      && expected.length > 0
      && constantTimeEquals(actual, expected);
  }
  return false;
}

/**
 * Identidade DECLARADA (opcional) de Z-API/WAHA: se o payload diz de qual
 * instância/sessão veio, tem que ser a do canal. Ausência passa — as âncoras dos
 * demais providers são outras guardas do handler.
 */
export function declaredProviderIdentityMatchesChannel(
  provider: WhatsAppProviderName,
  payload: unknown,
  credentials: ChannelCredentials,
): boolean {
  if (!payload || typeof payload !== "object") return true;
  const root = payload as Record<string, unknown>;
  const nested = root.payload && typeof root.payload === "object"
    ? root.payload as Record<string, unknown>
    : root;
  if (provider === "zapi") {
    const actual = [nested.instanceId, nested.instance_id, root.instanceId, root.instance_id]
      .find((value) => typeof value === "string" && value.trim()) as string | undefined;
    return !actual || actual.trim() === credentials.instance_id?.trim();
  }
  if (provider === "waha") {
    const actual = [root.session, nested.session]
      .find((value) => typeof value === "string" && value.trim()) as string | undefined;
    return !actual || actual.trim() === (credentials.session_name?.trim() || "default");
  }
  return true;
}
```

Se `WhatsAppProviderName` não for exportado com esse nome por `whatsapp-provider-core.ts`, pare e reporte. Não crie tipo próprio.

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `npx vitest run src/lib/whatsapp-echo-identity-core.test.ts`
Expected: PASS em todos os casos.

- [ ] **Step 5: Ajustar a assinatura na spec**

Em `docs/superpowers/specs/2026-09-30-uazapi-eco-aparelho-design.md`, trocar:

```
- `manualEchoMatchesConfiguredChannel(provider, payload, credentials, externalInstanceId)`: ramo UazAPI reescrito conforme o contrato. Os demais ficam sem mudança.
```

por:

```
- `manualEchoMatchesConfiguredChannel(provider, payload, credentials)`: ramo UazAPI reescrito conforme o contrato. Os demais ficam sem mudança. O parâmetro `externalInstanceId` sai, porque só o ramo UazAPI o usava.
```

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/whatsapp-echo-identity-core.ts src/lib/whatsapp-echo-identity-core.test.ts docs/superpowers/specs/2026-09-30-uazapi-eco-aparelho-design.md
git commit -m "feat(whatsapp): nucleo puro de identidade de canal; eco UazAPI ancorado no token

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Controle positivo (reintroduzir o defeito e ver o teste reprovar)**

Em `whatsapp-echo-identity-core.ts`, substituir TEMPORARIAMENTE o corpo do `if (provider === "uazapi") { ... }` pela regra antiga:

```ts
  if (provider === "uazapi") {
    const instance = root.instance && typeof root.instance === "object"
      ? root.instance as Record<string, unknown>
      : {};
    const actual = [root.instanceId, root.instance_id, instance.id]
      .find((value) => typeof value === "string" && value.trim()) as string | undefined;
    return !!actual && actual.trim() === "inst-1";
  }
```

Run: `npx vitest run src/lib/whatsapp-echo-identity-core.test.ts`
Expected: FAIL em "casa quando o token do envelope é o token da instância do canal" e em "instanceId no payload sem token não basta". Se algum dos dois PASSAR, o teste não reproduz o defeito: pare e reporte.

Restaurar e confirmar:

Run: `git checkout -- supabase/functions/_shared/whatsapp-echo-identity-core.ts && npx vitest run src/lib/whatsapp-echo-identity-core.test.ts`
Expected: PASS. `git status --short` sem mudanças.

---

### Task 2: Ligar o webhook ao núcleo, `reason` nas recusas 401, docs

**Files:**
- Modify: `supabase/functions/webhook-whatsapp/index.ts` (import; remover linhas 141–228; call site do eco ~2859; seis `finish("webhook_unauthorized")`)
- Modify: `src/lib/whatsapp-conversation-parity-guard.test.ts:66-87` e um caso novo
- Modify: `CLAUDE.md`, `AGENTS.md`

**Interfaces:**
- Consumes: as três funções da Task 1, com as assinaturas listadas lá (`manualEchoMatchesConfiguredChannel` com **3** argumentos).
- Produces: `webhook_executions.meta.reason`, com vocabulário fechado: `signature_invalid`, `declared_identity_mismatch`, `provider_token_mismatch`, `instance_mismatch`, `meta_identity_mismatch`, `manual_echo_identity_mismatch`.

- [ ] **Step 1: Escrever os testes estáticos que falham**

Em `src/lib/whatsapp-conversation-parity-guard.test.ts`, no caso `"cutover exige prova persistida do contrato de conversa"`, trocar a linha:

```ts
    expect(webhook.match(/credentials\.session_name\?\.trim\(\) \|\| "default"/g)).toHaveLength(2);
```

por:

```ts
    const identityCore = read("supabase/functions/_shared/whatsapp-echo-identity-core.ts");
    expect(identityCore.match(/credentials\.session_name\?\.trim\(\) \|\| "default"/g)).toHaveLength(2);
    expect(webhook).toContain('from "../_shared/whatsapp-echo-identity-core.ts"');
    // A decisão de identidade não volta a ser escrita onde o vitest não alcança.
    expect(webhook).not.toMatch(
      /function (manualEchoMatchesConfiguredChannel|declaredProviderIdentityMatchesChannel|metaPayloadMatchesChannel|metaPhoneNumberIds)\b/,
    );
```

E adicionar, antes do caso `"falha transitória libera somente o claim cercado para reentrega"`:

```ts
  it("toda recusa 401 do webhook grava o nome da guarda em meta.reason", () => {
    const webhook = read("supabase/functions/webhook-whatsapp/index.ts");
    const calls = webhook.match(/finish\("webhook_unauthorized"[^)]*\)/g) ?? [];
    const reasons = calls.map((call) => call.match(/\{ reason: "([a-z_]+)" \}/)?.[1] ?? "SEM_REASON");
    expect(reasons.sort()).toEqual([
      "declared_identity_mismatch",
      "instance_mismatch",
      "manual_echo_identity_mismatch",
      "meta_identity_mismatch",
      "provider_token_mismatch",
      "signature_invalid",
    ]);
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/whatsapp-conversation-parity-guard.test.ts`
Expected: FAIL. `identityCore.match(...)` tem 2 e passa, mas `toContain('from "../_shared/whatsapp-echo-identity-core.ts"')` falha, e o caso novo recebe seis `"SEM_REASON"`.

- [ ] **Step 3: Importar o núcleo no `index.ts`**

Em `supabase/functions/webhook-whatsapp/index.ts`, logo depois da linha

```ts
import { splitMetaWebhookPayloadCore } from "../_shared/whatsapp-meta-batch-core.ts";
```

inserir:

```ts
import {
  declaredProviderIdentityMatchesChannel,
  manualEchoMatchesConfiguredChannel,
  metaPayloadMatchesChannel,
} from "../_shared/whatsapp-echo-identity-core.ts";
```

Não remova `isMetaShapedProvider` do import de `whatsapp-providers.ts`: ele continua usado no `index.ts` (ex.: `describeIgnoredPayload` e o split do lote Meta).

- [ ] **Step 4: Remover as definições locais**

Apagar do `index.ts` o bloco inteiro que começa em `function metaPhoneNumberIds(payload: unknown): string[] {` e termina no `}` de fechamento de `function declaredProviderIdentityMatchesChannel(`. Isso inclui o JSDoc `A assinatura Meta autentica o app...` e as quatro funções `metaPhoneNumberIds`, `metaPayloadMatchesChannel`, `manualEchoMatchesConfiguredChannel` e `declaredProviderIdentityMatchesChannel` (hoje linhas 141–228). A função seguinte, `function splitMetaWebhookPayload(payload: unknown): unknown[] {`, fica.

- [ ] **Step 5: Ajustar o call site do eco (3 argumentos)**

Trocar:

```ts
    const manualEchoMatchesChannel = hasManualEcho && manualEchoMatchesConfiguredChannel(
      provider,
      payload,
      credentials,
      channel.external_instance_id,
    );
```

por:

```ts
    const manualEchoMatchesChannel = hasManualEcho && manualEchoMatchesConfiguredChannel(
      provider,
      payload,
      credentials,
    );
```

`credentials` aqui já tem `instance_token` resolvido do Vault para UazAPI: a resolução acontece antes, no bloco `if (provider === "uazapi")` depois da validação de assinatura. Não mova esse bloco.

- [ ] **Step 6: `reason` nas seis recusas**

Seis edições, cada uma identificada pelo `jsonLog` imediatamente anterior (o `finish` é idêntico nas seis, então use a linha do `jsonLog` como âncora):

1. Depois de `jsonLog("warn", { requestId, evt: "webhook_unauthorized", channelId, provider });`:
   `await finish("webhook_unauthorized");` → `await finish("webhook_unauthorized", undefined, { reason: "signature_invalid" });`
2. Depois do PRIMEIRO `jsonLog("warn", { requestId, evt: "webhook_channel_identity_mismatch", channelId, provider });` (dentro de `if (!declaredProviderIdentityMatchesChannel(...))`):
   → `{ reason: "declared_identity_mismatch" }`
3. Depois de `jsonLog("warn", { requestId, evt: "webhook_provider_token_mismatch", channelId, provider });`:
   → `{ reason: "provider_token_mismatch" }`
4. Depois de `jsonLog("warn", { requestId, evt: "webhook_instance_mismatch", channelId, provider });`:
   → `{ reason: "instance_mismatch" }`
5. Depois do SEGUNDO `jsonLog("warn", { requestId, evt: "webhook_channel_identity_mismatch", channelId, provider });` (dentro de `if (isMetaShapedProvider(provider) && !metaPayloadMatchesChannel(payload, credentials))`):
   → `{ reason: "meta_identity_mismatch" }`
6. Depois de `jsonLog("warn", { requestId, evt: "manual_echo_channel_identity_mismatch", channelId, provider });`:
   → `{ reason: "manual_echo_identity_mismatch" }`

Forma exata de cada uma: `await finish("webhook_unauthorized", undefined, { reason: "<valor>" });`. O `outcome` não muda.

- [ ] **Step 7: Rodar os testes e o lint**

Run: `npx vitest run src/lib/whatsapp-conversation-parity-guard.test.ts src/lib/whatsapp-echo-identity-core.test.ts`
Expected: PASS.

Run: `npx eslint supabase/functions/webhook-whatsapp/index.ts supabase/functions/_shared/whatsapp-echo-identity-core.ts`
Expected: zero erros. Um `no-undef` aqui significa função removida e ainda chamada sem import.

- [ ] **Step 8: Documentar a invariante (`CLAUDE.md` + `AGENTS.md`, mesmo commit)**

`CLAUDE.md`. Três inserções:

(a) Logo depois do bullet que começa com `- **UazAPI provisiona com claim cercado por UUID`, inserir:

```markdown
- **O eco do aparelho da UazAPI prova a identidade do canal SÓ pelo `token` do envelope, comparado em tempo constante com o token da instância vindo do Vault — a UazAPI não envia `instanceId`/`instance_id`/`instance.id`.** Âncora em campo que o provider não envia recusa todo eco com 401 sem erro visível: a resposta da equipe pelo aparelho some do painel e não silencia a IA. O núcleo compara sozinho, sem herdar a checagem de token que o handler faz antes. [whatsapp-echo-identity-core.ts](supabase/functions/_shared/whatsapp-echo-identity-core.ts).
```

(b) Na seção `## Observabilidade WhatsApp`, logo depois do bullet que começa com `- **`webhook_executions`** FORCE RLS, TTL 30d.`, inserir:

```markdown
- **Todo `finish("webhook_unauthorized")` grava `meta.reason` com o nome da guarda que recusou** (`signature_invalid`, `declared_identity_mismatch`, `provider_token_mismatch`, `instance_mismatch`, `meta_identity_mismatch`, `manual_echo_identity_mismatch`). Seis guardas produzem o mesmo outcome, e sem o `reason` só o log da função, que expira, diz qual recusou. Guarda nova entra no vocabulário e no teste estático. [whatsapp-conversation-parity-guard.test.ts](src/lib/whatsapp-conversation-parity-guard.test.ts).
```

(c) No checklist de redeploy, logo depois do bullet que começa com `- **`whatsapp-ad-touchpoint-core.ts`**`, inserir:

```markdown
- **`whatsapp-echo-identity-core.ts`** (núcleo puro, testado em [src/lib/whatsapp-echo-identity-core.test.ts](src/lib/whatsapp-echo-identity-core.test.ts)) → `webhook-whatsapp` (único consumidor). Identidade de canal declarada no payload (Meta `phone_number_id`, Z-API `instanceId`, WAHA `session`, UazAPI `token`). Vive em `_shared/` porque o vitest não importa aquela EF, e regra de identidade escrita no `index.ts` só se confere por leitura.
```

`AGENTS.md`. Duas inserções:

(a) Logo depois do bullet que começa com `- UazAPI provisiona idempotente por claim com fence UUID`, inserir:

```markdown
- Eco do aparelho UazAPI prova identidade SÓ pelo `token` do envelope (tempo constante contra o token da instância do Vault); a UazAPI não envia `instanceId`/`instance_id`/`instance.id`, e âncora nesses campos recusa todo eco com 401 em silêncio — a resposta da equipe pelo aparelho some do painel e não silencia a IA. Decisão em `_shared/whatsapp-echo-identity-core.ts`. Todo `finish("webhook_unauthorized")` grava `meta.reason` com o nome da guarda (vocabulário fechado, teste estático em `src/lib/whatsapp-conversation-parity-guard.test.ts`).
```

(b) Logo depois do bullet que começa com `- `_shared/whatsapp-ad-touchpoint-core.ts` → `webhook-whatsapp``, inserir:

```markdown
- `_shared/whatsapp-echo-identity-core.ts` → `webhook-whatsapp` (único consumidor): identidade de canal no payload (Meta `phone_number_id`, Z-API `instanceId`, WAHA `session`, UazAPI `token`), em `_shared/` porque o vitest não importa aquela EF.
```

Run: `npx vitest run src/lib/whatsapp-conversation-parity-guard.test.ts`
Expected: PASS (o caso `"documenta o gate permanente nos dois manuais"` continua verde).

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/webhook-whatsapp/index.ts src/lib/whatsapp-conversation-parity-guard.test.ts CLAUDE.md AGENTS.md
git diff --cached -- CLAUDE.md AGENTS.md
git commit -m "fix(whatsapp): webhook usa o nucleo de identidade; eco UazAPI deixa de ser 401 e recusas gravam reason

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Gates, revisão, merge e deploy

Esta task é do agente principal, não de um implementer. Os passos 4 em diante são ação externa: **parar e pedir autorização do usuário antes do push e antes do deploy.**

- [ ] **Step 1: Gates completos**

Run, da worktree: `npm run typecheck; npm test; npm run lint; npm run build`
Expected: zero erros de tipo e todos os testes verdes. Lint e build sem erro novo em relação à `main`.

- [ ] **Step 2: Gates de segurança**

Disparar em paralelo, apontando para `git diff main...fix/uazapi-eco-aparelho`:
- `saas-shield-br:tenant-isolation-auditor`: a guarda decide se um evento autenticado pertence ao canal/tenant da URL.
- `saas-shield-br:integration-reliability-auditor`: webhook, autenticação por token e semântica 401 terminal da fila (Fase C).

Qualquer achado P0/P1 bloqueia o merge.

- [ ] **Step 3: Revisão de segredos no diff**

Run: `git diff main...HEAD | Select-String -Pattern 'sk-|sk-ant-|xai-|AIza|eyJ|Bearer |service_role|SERVICE_ROLE_KEY|whsec_[A-Za-z0-9]|postgres://'`
Expected: nada além de falso positivo explicável. As fixtures usam token fictício `tok-instancia-exemplo-...`.

- [ ] **Step 4: Medir o que está em produção (rollback)**

Run (checkout principal): `supabase functions list --project-ref gbabxcrntkwgblgqsiit`
Registrar o `updated_at` do `webhook-whatsapp` e confirmar que ele corresponde à `main` atual (`5060ad6`, deploy das Fases C+D em 28/09). Rollback = `git worktree add --detach <scratchpad>/rollback-5060ad6 5060ad6` e `supabase functions deploy webhook-whatsapp --project-ref gbabxcrntkwgblgqsiit` de lá.

- [ ] **Step 5: PR e merge (após autorização)**

Escrever o corpo do PR em `<scratchpad>/pr-uazapi-eco.md` com três seções: **Problema** (179 `webhook_unauthorized` e zero `own_message_echo_*` em 30 dias; o envelope real não tem `instanceId`), **Mudança** (núcleo `whatsapp-echo-identity-core.ts`, âncora `token`, `meta.reason` nas seis recusas, deploy só do `webhook-whatsapp`) e **Verificação** (Steps 7–9 desta task). Terminar com `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

```bash
git push -u origin fix/uazapi-eco-aparelho
gh pr create --base main --title "fix(whatsapp): eco do aparelho UazAPI deixa de ser recusado com 401" --body-file "<scratchpad>/pr-uazapi-eco.md"
```

Sem migration: o `acl-estatico` não é load-bearing aqui. Depois de mergear o PR: `git -C <checkout principal> pull --ff-only`.

- [ ] **Step 6: Deploy (após autorização)**

Run: `supabase functions deploy webhook-whatsapp --project-ref gbabxcrntkwgblgqsiit`
Expected: deploy concluído. `supabase functions list` mostra `updated_at` novo.

- [ ] **Step 7: Sondas pós-deploy (sem segredo, sem tráfego real)**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://gbabxcrntkwgblgqsiit.supabase.co/functions/v1/webhook-whatsapp?channel=a633d938-68c6-4658-9d24-6e6d8f1a3c6f" -H "content-type: application/json" -d "{}"
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://gbabxcrntkwgblgqsiit.supabase.co/functions/v1/webhook-whatsapp?channel=00000000-0000-0000-0000-000000000000" -H "content-type: application/json" -d "{}"
```

Expected: `401` e `404`. Depois:

Run: `supabase db query --linked "select created_at, outcome, meta from webhook_executions where channel_id='a633d938-68c6-4658-9d24-6e6d8f1a3c6f' order by created_at desc limit 3;"`
Expected: a linha da sonda com `outcome = webhook_unauthorized` e `meta = {"reason": "signature_invalid"}`. Avisar o usuário que essa linha é da sonda.

- [ ] **Step 8: Teste real com a loja**

Pedir ao usuário que alguém da loja mande uma mensagem pelo celular para um cliente de teste já cadastrado. Depois:

Run: `supabase db query --linked "select created_at, outcome, meta->>'reason' reason, meta->>'convId' conv from webhook_executions where channel_id='a633d938-68c6-4658-9d24-6e6d8f1a3c6f' and created_at > now() - interval '30 minutes' and outcome like 'own_message_echo%' order by created_at desc;"`
Expected: `own_message_echo_recorded`. A conversa aparece no painel com a mensagem como humano e status "aguardando/atendente". Se vier `own_message_echo_unresolved`, registrar o `reason` (`customer_unknown`/`lid_unknown`/`no_identity`) e reportar sem improvisar conserto.

- [ ] **Step 9: Acompanhamento de 24 h**

Run: `supabase db query --linked "select outcome, meta->>'reason' reason, count(*) from webhook_executions where channel_id='a633d938-68c6-4658-9d24-6e6d8f1a3c6f' and created_at > now() - interval '24 hours' and (outcome like 'own_message_echo%' or outcome = 'webhook_unauthorized') group by 1,2 order by 3 desc;"`
Expected: zero `webhook_unauthorized` com `reason = manual_echo_identity_mismatch`. A contagem `recorded` × `unresolved` por `reason` alimenta a decisão sobre eco só com LID.
