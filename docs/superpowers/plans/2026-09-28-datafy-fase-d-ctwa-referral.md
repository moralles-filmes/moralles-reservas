# Fase D — Captura do `referral` CTWA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capturar o `referral` de anúncio Click-to-WhatsApp (com o `ctwa_clid`) de todo inbound `official`/`datafy`, em texto ou mídia, e persistir como touchpoint imutável em `whatsapp_ad_touchpoints`, sem mudar nada para Z-API, WAHA e UazAPI.

**Architecture:** O adapter ganha o método opcional `parseAdReferral` (só `official`/`datafy`, que já declaram `adReferral`), e o guard de capability passa a exigir capability ⇔ método nas duas direções. Um núcleo puro novo (`_shared/whatsapp-ad-touchpoint-core.ts`) decide tudo: monta a linha, neutraliza o que o Postgres recusaria, classifica o INSERT e descreve a forma para log. O `webhook-whatsapp` só faz I/O, chamando `captureAdTouchpoint` nos dois caminhos de inbound, depois do claim de `processed_messages` e antes de rate limit/billing/suspensão/efeito externo. A migration 115 cria a tabela `FORCE RLS` sem policies, com trigger de coerência de tenant + imutabilidade e trigger `SECURITY DEFINER` de anonimização.

**Tech Stack:** Supabase Edge Functions (Deno, TypeScript), Postgres (migration SQL + pré-voo local em PostgreSQL 18.4), vitest.

**Spec:** [docs/superpowers/specs/2026-09-27-datafy-fase-d-ctwa-referral-design.md](../specs/2026-09-27-datafy-fase-d-ctwa-referral-design.md) — aprovada pelo dono em 2026-09-28. Leia-a inteira antes da sua task.

**Worktree:** `C:/Users/Yuri/Documents/Desenvolvedor/moralles.reservas/.claude/worktrees/fase-d-ctwa`, branch `feat/datafy-fase-d-ctwa`. **Todo comando roda daqui.** Nunca `cd` para a raiz do repo principal.

## Global Constraints

- **Leia `CLAUDE.md` e `AGENTS.md` da worktree antes de começar.** As regras de lá valem como critério de aceite.
- **Git:** `git add <caminho>` explícito, nunca `git add .`/`-A`. Nunca `git stash` cru. Nunca `git reset --hard`. Commit em PT-BR no estilo do repo, terminando com a linha `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Nenhum `supabase db push`, nenhum deploy, nenhum `git push`.** A Fase C (111–114) está mergeada e NÃO aplicada; empurrar a 115 aplicaria as cinco juntas. Isto é decisão do dono, fora desta execução.
- **`tsconfig.app.json` tem `strict: false`:** resultado de união discriminada se consome com `r.ok === false` ou early-return, nunca `if (!r.ok) { r.reason }`.
- **Teste que carrega `whatsapp-providers.ts` usa `import.meta.glob`, nunca import direto** — o import direto puxa o arquivo para o `tsc -b` do frontend e quebra o typecheck (global `Deno`). `whatsapp-provider-core.ts` e núcleos puros podem ser importados direto.
- **Campo vindo de payload só entra como `string` por `typeof === "string"`, nunca `String(...)`** — `String({})` é `"[object Object]"`.
- **Log de payload é forma, nunca valor:** nome de campo e `typeof`, via `shapeOf` de `_shared/webhook-payload-shape-core.ts`.
- **Caso novo entra com controle positivo:** reintroduzir o defeito e ver o teste ficar vermelho.
- **Gates por task:** `npx vitest run <arquivos da task>`; ao fim de cada task que toque TypeScript, `npm run typecheck` (é `tsc -b --noEmit`; NUNCA `tsc --noEmit` sem `-b`) e `npm run lint`. Baseline: zero erros.
- **Números fixos da spec:** `REFERRAL_RAW_MAX_BYTES = 16384` (bytes UTF-8); CHECK do banco `octet_length(referral::text) <= 65536`; limites de coluna `provider_message_id` 512, `message_type` 32, `ctwa_clid` 512, `source_type` 64, `source_id` 256. Migration `20260927120000_115_whatsapp_ad_touchpoints.sql`.

## Review Focus

1. **Texto que o Postgres recusa dentro do `referral`** — `\u0000`, surrogate UTF-16 órfão (em valor OU em chave), número em notação exponencial (`1e300` vira 301 dígitos no `jsonb::text` e estoura o CHECK que o `JSON.stringify` media folgado), aninhamento de 40 níveis. Esperado: campo tipado nulo e/ou `referral` omitido, **nunca** um INSERT recusado — pela D8, recusa persistente vira reentrega eterna com o cliente sem resposta. Testes na Task 2.
2. **`referral` presente mas não-objeto** (string, array, número, booleano). Esperado: sem exceção, campos tipados nulos, `raw` preservado. Testes na Task 1.
3. **Mesmo `change`, duas mensagens do MESMO cliente, referral só na segunda.** Esperado: depois do split, só a parte da segunda devolve referral, com o id dela. Teste na Task 1.
4. **`message_at` fora do que o Postgres aceita** (timestamp absurdo, ano > 9999 — `toISOString` devolve `+033658-...`). Esperado: recusa `invalid_message_at` sem `throw`. Teste na Task 2.
5. **Reentrega depois de o touchpoint já gravado** (falha posterior, anterior a efeito externo, liberou o claim). Esperado: `23505` → `duplicate`, sem `throw`, o fluxo segue. Testes nas Tasks 2 e 5.

---

## File Structure

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `supabase/functions/_shared/whatsapp-provider-core.ts` | Modificar | Tipo `AdReferral`, método opcional `parseAdReferral?` no adapter, `parseOfficialAdReferral`, `CAPABILITY_REQUIRED_METHOD.adReferral` |
| `supabase/functions/_shared/whatsapp-providers.ts` | Modificar | Registra o método em `official`/`datafy`; fachadas `parseAdReferral` e `hasAdReferralCapture` |
| `supabase/functions/_shared/whatsapp-ad-touchpoint-core.ts` | Criar | Núcleo puro: montar linha, neutralizar, classificar INSERT, descrever forma |
| `supabase/migrations/20260927120000_115_whatsapp_ad_touchpoints.sql` | Criar | Tabela, índices, RLS forçada, dois triggers, ACL |
| `supabase/functions/webhook-whatsapp/index.ts` | Modificar | `captureAdTouchpoint` + duas chamadas |
| `src/lib/whatsapp-ad-referral-parser.test.ts` | Criar | Parser, lote, fachada |
| `src/lib/whatsapp-capability-guard.test.ts` | Modificar | Guard nas duas direções |
| `src/lib/datafy-adapter-coupling-guard.test.ts` | Modificar | `datafy.parseAdReferral === official.parseAdReferral` |
| `src/lib/whatsapp-ad-touchpoint-core.test.ts` | Criar | Núcleo |
| `src/lib/whatsapp-ad-touchpoint-migration-twin.test.ts` | Criar | Gêmeos declarados núcleo ⇔ SQL |
| `src/lib/whatsapp-ad-touchpoint-coupling.test.ts` | Criar | Acoplamento estrutural do `index.ts` |
| `supabase/tests/local-preflight/22a-ad-touchpoints-bootstrap.sql` | Criar | Default privileges + `customers` fiel mínimo |
| `supabase/tests/local-preflight/22-ad-touchpoints-115.sql` | Criar | TP-1..TP-11 |
| `supabase/tests/local-preflight/23-controles-115.sql` | Criar | C-115-1..C-115-5 |
| `supabase/tests/local-preflight/README.md` | Modificar | Tabela de arquivos + seção da 115 |
| `scripts/function-acl-allowlist.json` | Modificar | `_doc` do lint 0008: 17 → 19 tabelas |
| `docs/superpowers/specs/2026-09-27-datafy-fase-d-ctwa-referral-design.md` | Modificar | §4.5: corrigir 17→18 para 17→19 |
| `CLAUDE.md` + `AGENTS.md` | Modificar | Regras permanentes e checklist de redeploy, no MESMO commit |

---

### Task 1: Contrato do provider — `parseAdReferral` e o guard nas duas direções

**Files:**
- Modify: `supabase/functions/_shared/whatsapp-provider-core.ts` (linhas 47–54, 122–129, 226–247, e depois de `peekOfficialMedia` ~837)
- Modify: `supabase/functions/_shared/whatsapp-providers.ts` (imports ~7–58, `export type {` ~328, adapters ~551–600, fachadas depois de `peekInboundMedia` ~651)
- Create: `src/lib/whatsapp-ad-referral-parser.test.ts`
- Modify: `src/lib/whatsapp-capability-guard.test.ts`
- Modify: `src/lib/datafy-adapter-coupling-guard.test.ts`

**Interfaces:**
- Produces (em `whatsapp-provider-core.ts`):
  ```ts
  export interface AdReferral {
    providerMessageId: string;
    messageType: string | null;
    ctwaClid: string | null;
    sourceType: string | null;
    sourceId: string | null;
    raw: unknown;
  }
  export function parseOfficialAdReferral(p: any): AdReferral | null;
  // WhatsAppProviderAdapter.parseAdReferral?(payload: any): AdReferral | null
  // CAPABILITY_REQUIRED_METHOD.adReferral === "parseAdReferral"
  ```
- Produces (em `whatsapp-providers.ts`):
  ```ts
  export function parseAdReferral(provider: WhatsAppProvider, payload: any): AdReferral | null;
  export function hasAdReferralCapture(provider: WhatsAppProvider): boolean;
  // e `AdReferral` no bloco `export type { ... }`
  ```

- [ ] **Step 1: Escrever o teste do parser, do lote e da fachada (falha)**

Criar `src/lib/whatsapp-ad-referral-parser.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  parseOfficialAdReferral,
  type AdReferral,
} from "../../supabase/functions/_shared/whatsapp-provider-core";
import { splitMetaWebhookPayloadCore } from "../../supabase/functions/_shared/whatsapp-meta-batch-core";

// Fachada pelo glob, nunca por import direto: o import direto puxa
// whatsapp-providers.ts para o grafo do `tsc -b` do frontend e quebra o
// typecheck (global `Deno`). Mesmo padrão de whatsapp-capability-guard.test.ts.
const FACADE = "../../supabase/functions/_shared/whatsapp-providers.ts";
const modules = import.meta.glob<{
  parseAdReferral(provider: string, payload: unknown): AdReferral | null;
  hasAdReferralCapture(provider: string): boolean;
}>("../../supabase/functions/_shared/whatsapp-providers.ts", { eager: true });
const { parseAdReferral, hasAdReferralCapture } = modules[FACADE];

// Forma DOCUMENTADA pela Meta. Não foi medida (não há anúncio rodando): é
// exatamente por isso que o parser guarda a subárvore crua.
const REFERRAL = {
  source_url: "https://fb.me/abc",
  source_type: "ad",
  source_id: "120000000000001",
  headline: "Reserve sua mesa",
  body: "Clique e reserve",
  media_type: "image",
  image_url: "https://scontent.example/img.jpg",
  ctwa_clid: "ARAkLkA8rmlFeiCktEJQ",
};

function metaPost(messages: unknown[], contacts: unknown[] = []) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA_ID",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "5511900000000", phone_number_id: "PNID" },
          contacts,
          messages,
        },
      }],
    }],
  };
}

function msg(id: string, from: string, extra: Record<string, unknown> = {}) {
  return { from, id, timestamp: "1727500000", type: "text", text: { body: "Oi" }, ...extra };
}

describe("parseOfficialAdReferral — referral de QUALQUER tipo de mensagem", () => {
  it("texto: campos tipados e a subárvore crua é a MESMA referência do payload", () => {
    const post = metaPost([msg("wamid.A", "5511911110001", { referral: REFERRAL })]);
    const r = parseOfficialAdReferral(post);
    expect(r).toEqual({
      providerMessageId: "wamid.A",
      messageType: "text",
      ctwaClid: "ARAkLkA8rmlFeiCktEJQ",
      sourceType: "ad",
      sourceId: "120000000000001",
      raw: REFERRAL,
    });
    expect(r?.raw).toBe(post.entry[0].changes[0].value.messages[0].referral);
  });

  it("imagem: o caminho que parseOfficialInbound recusa também devolve referral", () => {
    const post = metaPost([{ from: "5511911110001", id: "wamid.IMG", timestamp: "1727500000", type: "image", image: { id: "m1" }, referral: REFERRAL }]);
    expect(parseOfficialAdReferral(post)?.messageType).toBe("image");
    expect(parseOfficialAdReferral(post)?.ctwaClid).toBe("ARAkLkA8rmlFeiCktEJQ");
  });

  it("tipo desconhecido: devolve referral e não normaliza o type", () => {
    const post = metaPost([msg("wamid.U", "5511911110001", { type: "unsupported", referral: REFERRAL })]);
    expect(parseOfficialAdReferral(post)?.messageType).toBe("unsupported");
  });

  it("sem referral, ou referral null → null", () => {
    expect(parseOfficialAdReferral(metaPost([msg("wamid.N", "5511911110001")]))).toBeNull();
    expect(parseOfficialAdReferral(metaPost([msg("wamid.N", "5511911110001", { referral: null })]))).toBeNull();
  });

  it("mensagem sem id → null (sem id não há como amarrar o touchpoint à mensagem)", () => {
    expect(parseOfficialAdReferral(metaPost([{ from: "5511911110001", type: "text", referral: REFERRAL }]))).toBeNull();
  });

  it("campo não-string vira null: o valor só sobrevive na subárvore crua", () => {
    const referral = { ctwa_clid: 12345, source_type: { x: 1 }, source_id: ["a"] };
    const r = parseOfficialAdReferral(metaPost([msg("wamid.B", "5511911110001", { referral })]));
    expect(r?.ctwaClid).toBeNull();
    expect(r?.sourceType).toBeNull();
    expect(r?.sourceId).toBeNull();
    expect(r?.raw).toBe(referral);
  });

  // Review Focus 2.
  it.each([
    ["string", "abc"],
    ["array", ["x", "y"]],
    ["número", 7],
    ["booleano", true],
  ])("referral %s: sem exceção, tipados nulos, raw preservado", (_rotulo, referral) => {
    const r = parseOfficialAdReferral(metaPost([msg("wamid.R", "5511911110001", { referral })]));
    expect(r?.providerMessageId).toBe("wamid.R");
    expect(r?.ctwaClid).toBeNull();
    expect(r?.sourceType).toBeNull();
    expect(r?.sourceId).toBeNull();
    expect(r?.raw).toEqual(referral);
  });

  it("payload que não é envelope Meta → null, sem exceção", () => {
    for (const p of [null, undefined, "x", 1, {}, { entry: [] }, { entry: [{ changes: [{ value: { messages: ["x"] } }] }] }]) {
      expect(parseOfficialAdReferral(p)).toBeNull();
    }
  });
});

describe("lote Meta: o referral é POR MENSAGEM, nunca por POST", () => {
  it("dois clientes, só o segundo com referral: depois do split, só a parte dele devolve referral", () => {
    const post = metaPost(
      [msg("wamid.SEM", "5511911110001"), msg("wamid.COM", "5511911110002", { referral: REFERRAL })],
      [{ wa_id: "5511911110001", profile: { name: "A" } }, { wa_id: "5511911110002", profile: { name: "B" } }],
    );
    const parts = splitMetaWebhookPayloadCore(post);
    expect(parts).toHaveLength(2);
    expect(parseOfficialAdReferral(parts[0])).toBeNull();
    expect(parseOfficialAdReferral(parts[1])?.providerMessageId).toBe("wamid.COM");
  });

  it("CONTROLE POSITIVO: ler do POST inteiro carrega o id de OUTRA mensagem — o id é o que denuncia a atribuição errada", () => {
    const post = metaPost(
      [msg("wamid.COM", "5511911110001", { referral: REFERRAL }), msg("wamid.OUTRO", "5511911110002")],
      [{ wa_id: "5511911110001" }, { wa_id: "5511911110002" }],
    );
    // A leitura "uma vez por requisição", aplicada à mensagem do outro cliente:
    const doPostInteiro = parseOfficialAdReferral(post);
    const parteDoOutro = splitMetaWebhookPayloadCore(post)[1];
    expect(parseOfficialAdReferral(parteDoOutro)).toBeNull();
    expect(doPostInteiro).not.toBeNull();
    expect(doPostInteiro?.providerMessageId).not.toBe("wamid.OUTRO");
  });

  // Review Focus 3.
  it("mesmo change, duas mensagens do MESMO cliente, referral só na segunda", () => {
    const post = metaPost(
      [msg("wamid.1", "5511911110001"), msg("wamid.2", "5511911110001", { referral: REFERRAL })],
      [{ wa_id: "5511911110001" }],
    );
    const parts = splitMetaWebhookPayloadCore(post);
    expect(parts).toHaveLength(2);
    expect(parseOfficialAdReferral(parts[0])).toBeNull();
    expect(parseOfficialAdReferral(parts[1])?.providerMessageId).toBe("wamid.2");
  });
});

describe("fachada parseAdReferral / hasAdReferralCapture", () => {
  const post = metaPost([msg("wamid.F", "5511911110001", { referral: REFERRAL })]);

  it.each(["zapi", "waha", "uazapi"])("%s não captura, mesmo com referral no payload", (provider) => {
    expect(parseAdReferral(provider, post)).toBeNull();
    expect(hasAdReferralCapture(provider)).toBe(false);
  });

  it.each(["official", "datafy"])("%s captura", (provider) => {
    expect(hasAdReferralCapture(provider)).toBe(true);
    expect(parseAdReferral(provider, post)?.ctwaClid).toBe("ARAkLkA8rmlFeiCktEJQ");
  });

  it("provider desconhecido → null e false, sem exceção", () => {
    expect(parseAdReferral("inexistente", post)).toBeNull();
    expect(hasAdReferralCapture("inexistente")).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/whatsapp-ad-referral-parser.test.ts`
Expected: FAIL — `parseOfficialAdReferral` não é exportado / `parseAdReferral` indefinido.

- [ ] **Step 3: Implementar em `whatsapp-provider-core.ts`**

3a. Substituir o comentário e a constante das linhas 47–54 por:

```ts
/**
 * Capability → método exigido pelo guard de acoplamento, nas DUAS direções:
 * capability `true` exige o método, e método presente exige capability `true`.
 * Capability de payload também exige método: `adReferral` declarada sem
 * `parseAdReferral` foi a Fase A afirmando uma captura que ninguém fazia, e a
 * frase antiga deste comentário ("capabilities de payload não exigem chamada
 * própria") era o que deixava essa mentira passar.
 * Acrescentar o método ao contrato exige mapear sua capability aqui.
 */
export const CAPABILITY_REQUIRED_METHOD = {
  rawCloudApiProxy: "cloudApiRequest",
  adReferral: "parseAdReferral",
} as const satisfies Readonly<Partial<Record<keyof WhatsAppProviderCapabilities, keyof WhatsAppProviderAdapter>>>;
```

3b. Logo depois de `interface InboundMediaPeek { ... }` (termina ~linha 129), acrescentar:

```ts
/**
 * `referral` de anúncio Click-to-WhatsApp (Fase D). Existe só em provider que
 * declara `adReferral`. Campos tipados só quando o valor é `string`; `raw` é a
 * subárvore EXATAMENTE como chegou — o envelope não foi medido, e se o
 * identificador vier sob outro nome é na `raw` que ele sobrevive.
 */
export interface AdReferral {
  /** Id da mensagem que carregou o referral — conferido contra o do inbound. */
  providerMessageId: string;
  /** `messages[0].type` como veio, sem normalizar. */
  messageType: string | null;
  ctwaClid: string | null;
  sourceType: string | null;
  sourceId: string | null;
  /** Subárvore `referral` CRUA. Nunca redigitada. */
  raw: unknown;
}
```

3c. Na interface `WhatsAppProviderAdapter`, logo depois de `peekInboundMedia(payload: any): InboundMediaPeek | null;`:

```ts
  /**
   * Referral CTWA da mensagem do payload (Fase D). Só em adapter que declara
   * `adReferral` — o guard de capability confere as duas direções. Lê QUALQUER
   * `type` (texto e mídia) sobre o payload de UMA mensagem: o lote Meta já foi
   * dividido a montante.
   */
  // deno-lint-ignore no-explicit-any
  parseAdReferral?(payload: any): AdReferral | null;
```

3d. Logo depois de `peekOfficialMedia` (termina ~linha 837), acrescentar:

```ts
// Fase D. Lê `messages[0].referral` para QUALQUER `type`: o clique de anúncio
// pode chegar como texto ou como mídia, e `parseOfficialInbound` só vê texto.
// Campo tipado só entra se for `string` — `String({})` viraria
// "[object Object]" e passaria como identificador. `raw` é a subárvore como
// chegou, nunca redigitada.
// deno-lint-ignore no-explicit-any
export function parseOfficialAdReferral(p: any): AdReferral | null {
  const msgObj = p?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msgObj || typeof msgObj !== "object") return null;
  const referral = msgObj.referral;
  if (referral === undefined || referral === null) return null;
  const id = nonEmptyString(msgObj.id);
  if (!id) return null;
  const fields: Record<string, unknown> =
    typeof referral === "object" && !Array.isArray(referral) ? referral : {};
  return {
    providerMessageId: id,
    messageType: typeof msgObj.type === "string" ? msgObj.type : null,
    ctwaClid: typeof fields.ctwa_clid === "string" ? fields.ctwa_clid : null,
    sourceType: typeof fields.source_type === "string" ? fields.source_type : null,
    sourceId: typeof fields.source_id === "string" ? fields.source_id : null,
    raw: referral,
  };
}
```

- [ ] **Step 4: Implementar em `whatsapp-providers.ts`**

4a. No import de `./whatsapp-provider-core.ts`, acrescentar `parseOfficialAdReferral,` (ordem alfabética perto de `parseOfficialInbound`) e `type AdReferral,` (perto dos outros `type`).

4b. No bloco `export type {` (~linha 328), acrescentar `AdReferral,`.

4c. No adapter `official`, depois de `peekInboundMedia: peekOfficialMedia,`: `parseAdReferral: parseOfficialAdReferral,`. No adapter `datafy`, depois de `peekInboundMedia: peekOfficialMedia,`: `parseAdReferral: parseOfficialAdReferral,` (o comentário existente ali — "Mesmas funções do adapter official, por referência" — já cobre).

4d. Logo depois da função `peekInboundMedia` (fachada, ~linha 651):

```ts
/**
 * Fase D. `null` para todo provider sem o método — Z-API, WAHA e UazAPI não
 * declaram `adReferral` e não fazem nada aqui. Nunca lança: referral ilegível
 * não pode derrubar o inbound.
 */
// deno-lint-ignore no-explicit-any
export function parseAdReferral(provider: WhatsAppProvider, payload: any): AdReferral | null {
  try {
    return providerRegistry.tryGet(provider)?.parseAdReferral?.(payload) ?? null;
  } catch {
    return null;
  }
}

/** Se o provider captura referral CTWA. Método ⇔ capability, pelo guard. */
export function hasAdReferralCapture(provider: WhatsAppProvider): boolean {
  return typeof providerRegistry.tryGet(provider)?.parseAdReferral === "function";
}
```

- [ ] **Step 5: Rodar o teste do parser e ver passar**

Run: `npx vitest run src/lib/whatsapp-ad-referral-parser.test.ts`
Expected: PASS.

- [ ] **Step 6: Guard de capability nas duas direções (teste que falha primeiro)**

Em `src/lib/whatsapp-capability-guard.test.ts`:

6a. Depois de `missingCapabilityMethods`, acrescentar:

```ts
// Direção 2: método presente exige capability `true`. É o que impede um adapter
// legado de ganhar a leitura do referral sem declarar a capability.
function undeclaredCapabilityMethods(adapter: WhatsAppProviderAdapter): string[] {
  return Object.entries(CAPABILITY_REQUIRED_METHOD)
    .filter(([capability, method]) =>
      typeof adapter[method] === "function" && adapter.capabilities[capability] !== true
    )
    .map(([capability, method]) => `${adapter.name}.${method} sem ${capability}`);
}
```

6b. Renomear o `describe` para `"capability ⇔ método no adapter, nas duas direções"`. Acrescentar ao lado do teste de `rawCloudApiProxy`:

```ts
  it("mapeia adReferral ao método opcional parseAdReferral", () => {
    expect(CAPABILITY_REQUIRED_METHOD.adReferral).toBe("parseAdReferral");
  });
```

6c. No `it.each(WHATSAPP_PROVIDER_NAMES)`, acrescentar `expect(undeclaredCapabilityMethods(adapter)).toEqual([]);`.

6d. Acrescentar ao fim do `describe`:

```ts
  it("CONTROLE POSITIVO (direção 1): adReferral declarada sem parseAdReferral reprova", () => {
    const adapter: WhatsAppProviderAdapter = {
      ...getWhatsAppProvider("official"),
      parseAdReferral: undefined,
    };
    expect(missingCapabilityMethods(adapter)).toEqual([
      "official.adReferral → parseAdReferral",
    ]);
  });

  it("CONTROLE POSITIVO (direção 2): adapter legado com parseAdReferral e sem a capability reprova", () => {
    const adapter: WhatsAppProviderAdapter = {
      ...getWhatsAppProvider("zapi"),
      parseAdReferral: () => null,
    };
    expect(undeclaredCapabilityMethods(adapter)).toEqual(["zapi.parseAdReferral sem adReferral"]);

    adapter.capabilities = { ...PROVIDER_CAPABILITIES.zapi, adReferral: true };
    expect(undeclaredCapabilityMethods(adapter)).toEqual([]);
  });

  it("CONTROLE POSITIVO (direção 2): cloudApiRequest sem rawCloudApiProxy reprova", () => {
    const adapter: WhatsAppProviderAdapter = {
      ...getWhatsAppProvider("waha"),
      cloudApiRequest: async () => ({ status: 200, body: {} }),
    };
    expect(undeclaredCapabilityMethods(adapter)).toEqual(["waha.cloudApiRequest sem rawCloudApiProxy"]);
  });
```

Run: `npx vitest run src/lib/whatsapp-capability-guard.test.ts` → PASS (a implementação do Step 3/4 já satisfaz). Para confirmar que o teste tem dentes: comente temporariamente a linha `parseAdReferral: parseOfficialAdReferral,` do adapter `datafy`, rode, veja `datafy.adReferral → parseAdReferral` vermelho, e desfaça.

- [ ] **Step 7: Acoplamento datafy ⇔ official**

Em `src/lib/datafy-adapter-coupling-guard.test.ts`, no teste `"datafy usa exatamente as mesmas funções de parse que official"`, acrescentar:

```ts
    expect(typeof official.parseAdReferral).toBe("function");
    expect(datafy.parseAdReferral).toBe(official.parseAdReferral);
```

E no teste `"datafy declara as capabilities que a Fase A+B realmente entrega"`, acima de `expect(caps.adReferral).toBe(true);`, o comentário `// Capturado desde a Fase D (parseAdReferral).`

- [ ] **Step 8: Gates da task**

Run: `npx vitest run src/lib/whatsapp-ad-referral-parser.test.ts src/lib/whatsapp-capability-guard.test.ts src/lib/datafy-adapter-coupling-guard.test.ts src/test/whatsapp-provider-core.test.ts`
Expected: PASS.
Run: `npm run typecheck` → 0 erros. `npm run lint` → 0 erros.

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/_shared/whatsapp-provider-core.ts supabase/functions/_shared/whatsapp-providers.ts src/lib/whatsapp-ad-referral-parser.test.ts src/lib/whatsapp-capability-guard.test.ts src/lib/datafy-adapter-coupling-guard.test.ts
git commit -m "feat(whatsapp): parseAdReferral no contrato, e capability passa a exigir metodo nas duas direcoes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Núcleo puro `whatsapp-ad-touchpoint-core.ts`

**Files:**
- Create: `supabase/functions/_shared/whatsapp-ad-touchpoint-core.ts`
- Create: `src/lib/whatsapp-ad-touchpoint-core.test.ts`

**Interfaces:**
- Consumes: `AdReferral`, `PROVIDER_CAPABILITIES`, `WhatsAppProviderName` de `whatsapp-provider-core.ts` (Task 1); `shapeOf` de `webhook-payload-shape-core.ts`.
- Produces:
  ```ts
  export const AD_TOUCHPOINT_PROVIDERS: ReadonlySet<string>;
  export const PROVIDER_MESSAGE_ID_MAX_LEN = 512;
  export const MESSAGE_TYPE_MAX_LEN = 32;
  export const CTWA_CLID_MAX_LEN = 512;
  export const SOURCE_TYPE_MAX_LEN = 64;
  export const SOURCE_ID_MAX_LEN = 256;
  export const REFERRAL_RAW_MAX_BYTES = 16_384;
  export const REFERRAL_RAW_DB_MAX_BYTES = 65_536;
  export const REFERRAL_RAW_MAX_DEPTH = 32;
  export const MESSAGE_AT_MAX_MS = 253_402_300_799_999;
  export function isPgSafeText(value: string): boolean;
  export function normalizeTouchpointText(value: string | null | undefined, maxLen: number): string | null;
  export function utf8ByteLength(text: string): number;
  export interface AdTouchpointInput { provider: string; unitId: string; channelId: string | null; customerId: string; inboundProviderMessageId: string; messageAtMs: number; referral: AdReferral; }
  export interface AdTouchpointRow { unit_id: string; channel_id: string | null; customer_id: string; provider: string; provider_message_id: string; message_type: string | null; message_at: string; ctwa_clid: string | null; source_type: string | null; source_id: string | null; referral: unknown; }
  export type AdTouchpointRejectReason = "provider_not_capable" | "invalid_provider_message_id" | "message_id_mismatch" | "invalid_message_at";
  export type RawOmittedReason = "too_large" | "not_storable";
  export type BuildAdTouchpointResult =
    | { ok: true; row: AdTouchpointRow; rawOmittedReason: RawOmittedReason | null }
    | { ok: false; reason: AdTouchpointRejectReason };
  export function buildAdTouchpointRow(input: AdTouchpointInput): BuildAdTouchpointResult;
  export type TouchpointInsertOutcome = "inserted" | "duplicate" | "failed";
  export function classifyTouchpointInsert(error: { code?: string | null } | null | undefined): TouchpointInsertOutcome;
  export function describeReferralProbe(payload: unknown): { has_referral: boolean; message_shape: unknown };
  export type TouchpointCaptureOutcome = TouchpointInsertOutcome | "rejected";
  export function describeCapturedReferral(args: { provider: string; outcome: TouchpointCaptureOutcome; referral: AdReferral; rawOmittedReason?: RawOmittedReason | null; rejectReason?: AdTouchpointRejectReason }): Record<string, unknown>;
  ```

- [ ] **Step 1: Escrever o teste (falha)**

Criar `src/lib/whatsapp-ad-touchpoint-core.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AD_TOUCHPOINT_PROVIDERS,
  CTWA_CLID_MAX_LEN,
  MESSAGE_AT_MAX_MS,
  REFERRAL_RAW_MAX_BYTES,
  REFERRAL_RAW_MAX_DEPTH,
  buildAdTouchpointRow,
  classifyTouchpointInsert,
  describeCapturedReferral,
  describeReferralProbe,
  isPgSafeText,
  normalizeTouchpointText,
  utf8ByteLength,
  type AdTouchpointInput,
  type BuildAdTouchpointResult,
} from "../../supabase/functions/_shared/whatsapp-ad-touchpoint-core";
import type { AdReferral } from "../../supabase/functions/_shared/whatsapp-provider-core";

const T0 = Date.UTC(2026, 8, 28, 15, 0, 0);

function referral(over: Partial<AdReferral> = {}): AdReferral {
  return {
    providerMessageId: "wamid.X",
    messageType: "text",
    ctwaClid: "clid-1",
    sourceType: "ad",
    sourceId: "ad-1",
    raw: { ctwa_clid: "clid-1", source_type: "ad" },
    ...over,
  };
}

function input(over: Partial<AdTouchpointInput> = {}): AdTouchpointInput {
  return {
    provider: "datafy",
    unitId: "u-1",
    channelId: "ch-1",
    customerId: "c-1",
    inboundProviderMessageId: "wamid.X",
    messageAtMs: T0,
    referral: referral(),
    ...over,
  };
}

function aceito(r: BuildAdTouchpointResult) {
  if (r.ok === false) throw new Error(`recusado: ${r.reason}`);
  return r;
}

function aninhado(niveis: number): unknown {
  let v: unknown = "folha";
  for (let i = 0; i < niveis; i++) v = { n: v };
  return v;
}

describe("AD_TOUCHPOINT_PROVIDERS é derivado da capability", () => {
  it("contém official e datafy, e só eles", () => {
    expect([...AD_TOUCHPOINT_PROVIDERS].sort()).toEqual(["datafy", "official"]);
  });
});

describe("buildAdTouchpointRow — caminho feliz", () => {
  it("monta a linha com escopo, tipados, message_at ISO e a subárvore crua", () => {
    const r = aceito(buildAdTouchpointRow(input()));
    expect(r.rawOmittedReason).toBeNull();
    expect(r.row).toEqual({
      unit_id: "u-1",
      channel_id: "ch-1",
      customer_id: "c-1",
      provider: "datafy",
      provider_message_id: "wamid.X",
      message_type: "text",
      message_at: new Date(T0).toISOString(),
      ctwa_clid: "clid-1",
      source_type: "ad",
      source_id: "ad-1",
      referral: { ctwa_clid: "clid-1", source_type: "ad" },
    });
  });

  it("channel_id nulo é aceito", () => {
    expect(aceito(buildAdTouchpointRow(input({ channelId: null }))).row.channel_id).toBeNull();
  });

  it("source_type desconhecido entra como veio — sem enum, porque recusa viraria reentrega eterna", () => {
    expect(aceito(buildAdTouchpointRow(input({ referral: referral({ sourceType: "reel" }) }))).row.source_type).toBe("reel");
  });

  it("trim; vazio e só-espaço viram null", () => {
    const r = aceito(buildAdTouchpointRow(input({ referral: referral({ ctwaClid: "  clid-2 ", sourceType: "   ", sourceId: "" }) })));
    expect(r.row.ctwa_clid).toBe("clid-2");
    expect(r.row.source_type).toBeNull();
    expect(r.row.source_id).toBeNull();
  });

  it("acima do limite vira null — nunca trunca (truncar um identificador o corrompe)", () => {
    expect(aceito(buildAdTouchpointRow(input({ referral: referral({ ctwaClid: "a".repeat(CTWA_CLID_MAX_LEN) }) }))).row.ctwa_clid)
      .toBe("a".repeat(CTWA_CLID_MAX_LEN));
    expect(aceito(buildAdTouchpointRow(input({ referral: referral({ ctwaClid: "a".repeat(CTWA_CLID_MAX_LEN + 1) }) }))).row.ctwa_clid)
      .toBeNull();
  });
});

describe("subárvore crua — limite em BYTES UTF-8", () => {
  it("multibyte: poucos caracteres, muitos bytes → omitida; os tipados ficam", () => {
    const raw = { body: "ç".repeat(9000) };
    const serializado = JSON.stringify(raw);
    // Premissa do caso: contar caracteres aceitaria, contar bytes recusa.
    expect(serializado.length).toBeLessThan(REFERRAL_RAW_MAX_BYTES);
    expect(utf8ByteLength(serializado)).toBeGreaterThan(REFERRAL_RAW_MAX_BYTES);
    const r = aceito(buildAdTouchpointRow(input({ referral: referral({ raw }) })));
    expect(r.row.referral).toBeNull();
    expect(r.rawOmittedReason).toBe("too_large");
    expect(r.row.ctwa_clid).toBe("clid-1");
  });

  it("CONTROLE: o mesmo tamanho em ASCII cabe", () => {
    const raw = { body: "c".repeat(9000) };
    const r = aceito(buildAdTouchpointRow(input({ referral: referral({ raw }) })));
    expect(r.row.referral).toEqual(raw);
    expect(r.rawOmittedReason).toBeNull();
  });
});

// Review Focus 1: tudo que o Postgres recusaria é neutralizado AQUI.
describe("texto que o Postgres recusa nunca chega ao INSERT", () => {
  it("isPgSafeText: NUL e surrogate órfão recusados; par válido aceito", () => {
    expect(isPgSafeText("abc")).toBe(true);
    expect(isPgSafeText("a\u0000b")).toBe(false);
    expect(isPgSafeText("a\ud800b")).toBe(false);
    expect(isPgSafeText("a\udc00b")).toBe(false);
    expect(isPgSafeText("sushi 🍣")).toBe(true);
  });

  it("NUL em campo tipado → null", () => {
    expect(aceito(buildAdTouchpointRow(input({ referral: referral({ ctwaClid: "cl\u0000id" }) }))).row.ctwa_clid).toBeNull();
  });

  it("surrogate órfão em campo tipado → null; par válido fica", () => {
    expect(aceito(buildAdTouchpointRow(input({ referral: referral({ sourceId: "ad\ud800" }) }))).row.source_id).toBeNull();
    expect(aceito(buildAdTouchpointRow(input({ referral: referral({ sourceId: "ad🍣" }) }))).row.source_id).toBe("ad🍣");
  });

  it.each([
    ["NUL em valor", { a: "x\u0000y" }],
    ["NUL em chave", { ["k\u0000"]: "v" }],
    ["surrogate órfão em valor", { a: "\ud800" }],
    ["surrogate órfão em chave", { ["\udc00"]: 1 }],
    ["número exponencial grande", { n: 1e300 }],
    ["número exponencial pequeno", { n: 1e-7 }],
    [`aninhamento acima de ${REFERRAL_RAW_MAX_DEPTH}`, aninhado(40)],
  ])("%s → subárvore omitida (not_storable), linha gravável", (_rotulo, raw) => {
    const r = aceito(buildAdTouchpointRow(input({ referral: referral({ raw }) })));
    expect(r.row.referral).toBeNull();
    expect(r.rawOmittedReason).toBe("not_storable");
    expect(r.row.ctwa_clid).toBe("clid-1");
  });

  it("CONTROLE: números comuns, emoji e aninhamento raso ficam", () => {
    const raw = { id: 120000000000001, x: 0.5, e: "🍣", ok: true, nada: null, lista: [1, "a"], fundo: aninhado(5) };
    expect(aceito(buildAdTouchpointRow(input({ referral: referral({ raw }) }))).row.referral).toEqual(raw);
  });

  it("message_type com NUL → null (e o log não o repete)", () => {
    const r = aceito(buildAdTouchpointRow(input({ referral: referral({ messageType: "te\u0000xt" }) })));
    expect(r.row.message_type).toBeNull();
  });
});

describe("recusas — o núcleo diz não, o handler não lança", () => {
  it("provider sem a capability → provider_not_capable (o CHECK do banco recusaria, e recusa é reentrega eterna)", () => {
    expect(buildAdTouchpointRow(input({ provider: "zapi" }))).toEqual({ ok: false, reason: "provider_not_capable" });
  });

  it("id do referral diferente do id do inbound → message_id_mismatch", () => {
    expect(buildAdTouchpointRow(input({ inboundProviderMessageId: "wamid.OUTRO" })))
      .toEqual({ ok: false, reason: "message_id_mismatch" });
  });

  it("id do inbound vazio → invalid_provider_message_id", () => {
    expect(buildAdTouchpointRow(input({ inboundProviderMessageId: "   " })))
      .toEqual({ ok: false, reason: "invalid_provider_message_id" });
  });

  // Review Focus 4.
  it.each([
    ["NaN", Number.NaN],
    ["negativo", -1],
    ["depois de 9999-12-31", MESSAGE_AT_MAX_MS + 1],
    ["ano 33658", 1e12 * 1000],
  ])("message_at %s → invalid_message_at", (_rotulo, ms) => {
    expect(buildAdTouchpointRow(input({ messageAtMs: ms }))).toEqual({ ok: false, reason: "invalid_message_at" });
  });

  it("CONTROLE: o último milissegundo de 9999 é aceito", () => {
    expect(aceito(buildAdTouchpointRow(input({ messageAtMs: MESSAGE_AT_MAX_MS }))).row.message_at)
      .toBe("9999-12-31T23:59:59.999Z");
  });
});

// Review Focus 5.
describe("classifyTouchpointInsert", () => {
  it("sem erro → inserted; 23505 → duplicate; qualquer outro código → failed", () => {
    expect(classifyTouchpointInsert(null)).toBe("inserted");
    expect(classifyTouchpointInsert(undefined)).toBe("inserted");
    expect(classifyTouchpointInsert({ code: "23505" })).toBe("duplicate");
    expect(classifyTouchpointInsert({ code: "23514" })).toBe("failed");
    expect(classifyTouchpointInsert({ code: "PGRST204" })).toBe("failed");
    expect(classifyTouchpointInsert({})).toBe("failed");
  });
});

describe("logs de forma — nomes e typeof, nunca valor", () => {
  const SEGREDOS = ["ARAkLkA8rmlFeiCktEJQ", "5511911110001", "Oi quero reservar", "120000000000001"];
  const msg = {
    from: "5511911110001",
    id: "wamid.P",
    timestamp: "1727500000",
    type: "text",
    text: { body: "Oi quero reservar" },
    referral: { ctwa_clid: "ARAkLkA8rmlFeiCktEJQ", source_id: "120000000000001", source_type: "ad" },
  };
  const post = { entry: [{ changes: [{ value: { messages: [msg] } }] }] };
  const vaza = (saida: unknown) => SEGREDOS.filter((s) => JSON.stringify(saida).includes(s));

  it("describeReferralProbe: has_referral e a forma da mensagem, sem valor", () => {
    const out = describeReferralProbe(post);
    expect(out.has_referral).toBe(true);
    expect(out.message_shape).toMatchObject({ from: "string", id: "string", referral: "object", text: "object" });
    expect(vaza(out)).toEqual([]);
  });

  it("describeReferralProbe: sem referral e payload não-Meta", () => {
    const semReferral = { entry: [{ changes: [{ value: { messages: [{ ...msg, referral: undefined }] } }] }] };
    expect(describeReferralProbe(semReferral).has_referral).toBe(false);
    expect(describeReferralProbe({ foo: 1 })).toEqual({ has_referral: false, message_shape: null });
    expect(describeReferralProbe(null)).toEqual({ has_referral: false, message_shape: null });
  });

  it("describeCapturedReferral: forma do referral, sem valor", () => {
    const out = describeCapturedReferral({
      provider: "datafy",
      outcome: "inserted",
      referral: referral({ raw: msg.referral, ctwaClid: msg.referral.ctwa_clid }),
      rawOmittedReason: null,
    });
    expect(out).toMatchObject({
      provider: "datafy",
      outcome: "inserted",
      message_type: "text",
      referral_shape: { ctwa_clid: "string", source_id: "string", source_type: "string" },
      raw_omitted: null,
    });
    expect(vaza(out)).toEqual([]);
  });

  it("describeCapturedReferral de recusa carrega o motivo", () => {
    expect(describeCapturedReferral({ provider: "official", outcome: "rejected", referral: referral(), rejectReason: "message_id_mismatch" }))
      .toMatchObject({ outcome: "rejected", reason: "message_id_mismatch" });
  });

  it("CONTROLE POSITIVO: a mesma asserção reprova uma folha trocada por String(value)", () => {
    const folhaQueVaza = (v: unknown): unknown =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, folhaQueVaza(x)]))
        : String(v);
    expect(vaza({ message_shape: folhaQueVaza(msg) }).length).toBeGreaterThan(0);
  });
});

describe("normalizeTouchpointText", () => {
  it("não-string → null", () => {
    expect(normalizeTouchpointText(null, 10)).toBeNull();
    expect(normalizeTouchpointText(undefined, 10)).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/whatsapp-ad-touchpoint-core.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar o núcleo**

Criar `supabase/functions/_shared/whatsapp-ad-touchpoint-core.ts`:

```ts
// Fase D — decisão da captura do `referral` de anúncio Click-to-WhatsApp (CTWA).
//
// Núcleo puro: TUDO que a Fase D decide mora aqui, e `webhook-whatsapp/index.ts`
// só faz I/O. O vitest não importa aquele arquivo (`serve()` no carregamento +
// `deno.land`), e regra que só se confere por leitura já deixou passar defeito
// duas vezes neste repo.
//
// O CONTRATO QUE ESTE ARQUIVO SUSTENTA (D8 da spec): falha de INSERT do
// touchpoint é reentregável — o handler lança antes de qualquer efeito externo e
// o provider reentrega. Por isso NENHUMA entrada de provider pode produzir uma
// linha que o banco recuse: recusa persistente viraria reentrega eterna, com o
// cliente sem resposta. O que o Postgres recusaria é neutralizado AQUI:
//   - `\u0000` (`text` recusa com 22021, `jsonb` com 22P05);
//   - surrogate UTF-16 órfão (não existe em UTF-8);
//   - número em notação exponencial: o `jsonb` o expande (`1e300` vira 301
//     dígitos no `jsonb::text`) e estouraria o CHECK de tamanho que o
//     `JSON.stringify` media folgado;
//   - aninhamento acima de REFERRAL_RAW_MAX_DEPTH;
//   - tamanho, medido em BYTES UTF-8 para a subárvore.
// Provider fora de AD_TOUCHPOINT_PROVIDERS é RECUSADO aqui pelo mesmo motivo: o
// CHECK de `provider` da 115 o recusaria.
//
// Spec: docs/superpowers/specs/2026-09-27-datafy-fase-d-ctwa-referral-design.md

import {
  PROVIDER_CAPABILITIES,
  type AdReferral,
  type WhatsAppProviderName,
} from "./whatsapp-provider-core.ts";
import { shapeOf } from "./webhook-payload-shape-core.ts";

/**
 * Providers cujo touchpoint o banco aceita. DERIVADO da capability, nunca
 * digitado. Gêmeo declarado do `check (provider in (...))` da migration 115 —
 * SQL não importa TypeScript, e `whatsapp-ad-touchpoint-migration-twin.test.ts`
 * lê o arquivo da migration e reprova divergência.
 */
export const AD_TOUCHPOINT_PROVIDERS: ReadonlySet<string> = new Set(
  (Object.keys(PROVIDER_CAPABILITIES) as WhatsAppProviderName[])
    .filter((name) => PROVIDER_CAPABILITIES[name].adReferral === true),
);

// Gêmeos declarados dos CHECKs de `whatsapp_ad_touchpoints` na migration 115.
// Mudar um lado sem o outro é o começo do drift: o teste gêmeo reprova.
// `.length` do JS conta unidades UTF-16 e o `length()` do Postgres conta
// caracteres — o JS nunca é MENOR, então aceitar aqui garante aceitar lá.
export const PROVIDER_MESSAGE_ID_MAX_LEN = 512;
export const MESSAGE_TYPE_MAX_LEN = 32;
export const CTWA_CLID_MAX_LEN = 512;
export const SOURCE_TYPE_MAX_LEN = 64;
export const SOURCE_ID_MAX_LEN = 256;

/** A REGRA: acima disto a subárvore crua é descartada e os tipados ficam. */
export const REFERRAL_RAW_MAX_BYTES = 16_384;
/**
 * A REDE do banco (`octet_length(referral::text) <= 65536`), não a regra. O
 * `jsonb::text` insere espaço depois de `:` e `,` e fica mais longo que o
 * `JSON.stringify`; com os dois no mesmo número, o banco recusaria o que o
 * núcleo aceitou.
 */
export const REFERRAL_RAW_DB_MAX_BYTES = 65_536;
export const REFERRAL_RAW_MAX_DEPTH = 32;
/** 9999-12-31T23:59:59.999Z. Acima disto `toISOString` devolve `+010000-…`. */
export const MESSAGE_AT_MAX_MS = 253_402_300_799_999;

const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Texto que o Postgres aceita em `text` e em `jsonb`: sem NUL e UTF-16 bem formado. */
export function isPgSafeText(value: string): boolean {
  return !value.includes("\u0000") && !UNPAIRED_SURROGATE.test(value);
}

/** Campo tipado: trim; vazio, acima do limite ou recusável pelo banco → null. Nunca trunca. */
export function normalizeTouchpointText(value: string | null | undefined, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen || !isPgSafeText(trimmed)) return null;
  return trimmed;
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isStorableJsonTree(value: unknown, depth: number): boolean {
  if (depth > REFERRAL_RAW_MAX_DEPTH) return false;
  if (typeof value === "string") return isPgSafeText(value);
  if (typeof value === "number") return Number.isFinite(value) && !/e/i.test(String(value));
  if (value === null || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every((item) => isStorableJsonTree(item, depth + 1));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).every(
      ([key, item]) => isPgSafeText(key) && isStorableJsonTree(item, depth + 1),
    );
  }
  return false; // undefined, function, bigint, symbol: não vêm de JSON.parse
}

export type RawOmittedReason = "too_large" | "not_storable";

function storableRaw(raw: unknown): { raw: unknown; omitted: RawOmittedReason | null } {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    return { raw: null, omitted: "not_storable" };
  }
  if (serialized === undefined) return { raw: null, omitted: "not_storable" };
  if (utf8ByteLength(serialized) > REFERRAL_RAW_MAX_BYTES) return { raw: null, omitted: "too_large" };
  if (!isStorableJsonTree(raw, 0)) return { raw: null, omitted: "not_storable" };
  return { raw, omitted: null };
}

export interface AdTouchpointInput {
  /** `whatsapp_channels.provider` do canal da querystring. */
  provider: string;
  /** `channel.unit_id` do MESMO SELECT que resolveu o canal — nunca do payload. */
  unitId: string;
  channelId: string | null;
  customerId: string;
  /** Id do inbound já reivindicado em `processed_messages`. */
  inboundProviderMessageId: string;
  /** Epoch em ms, normalizado pelo parser do provider. */
  messageAtMs: number;
  referral: AdReferral;
}

export interface AdTouchpointRow {
  unit_id: string;
  channel_id: string | null;
  customer_id: string;
  provider: string;
  provider_message_id: string;
  message_type: string | null;
  message_at: string;
  ctwa_clid: string | null;
  source_type: string | null;
  source_id: string | null;
  referral: unknown;
}

export type AdTouchpointRejectReason =
  | "provider_not_capable"
  | "invalid_provider_message_id"
  | "message_id_mismatch"
  | "invalid_message_at";

export type BuildAdTouchpointResult =
  | { ok: true; row: AdTouchpointRow; rawOmittedReason: RawOmittedReason | null }
  | { ok: false; reason: AdTouchpointRejectReason };

/**
 * Monta a linha ou recusa com motivo. Recusa NÃO é falha: o handler loga e
 * segue — um bug nosso de split não pode calar o cliente.
 */
export function buildAdTouchpointRow(input: AdTouchpointInput): BuildAdTouchpointResult {
  if (!AD_TOUCHPOINT_PROVIDERS.has(input.provider)) return { ok: false, reason: "provider_not_capable" };

  const messageId = normalizeTouchpointText(input.inboundProviderMessageId, PROVIDER_MESSAGE_ID_MAX_LEN);
  if (!messageId) return { ok: false, reason: "invalid_provider_message_id" };
  // Cinto contra atribuir o anúncio de uma mensagem a outra se o split mudar.
  if (normalizeTouchpointText(input.referral.providerMessageId, PROVIDER_MESSAGE_ID_MAX_LEN) !== messageId) {
    return { ok: false, reason: "message_id_mismatch" };
  }

  const ms = input.messageAtMs;
  if (!Number.isFinite(ms) || ms < 0 || ms > MESSAGE_AT_MAX_MS) return { ok: false, reason: "invalid_message_at" };

  const { raw, omitted } = storableRaw(input.referral.raw);
  return {
    ok: true,
    rawOmittedReason: omitted,
    row: {
      unit_id: input.unitId,
      channel_id: input.channelId,
      customer_id: input.customerId,
      provider: input.provider,
      provider_message_id: messageId,
      message_type: normalizeTouchpointText(input.referral.messageType, MESSAGE_TYPE_MAX_LEN),
      message_at: new Date(ms).toISOString(),
      ctwa_clid: normalizeTouchpointText(input.referral.ctwaClid, CTWA_CLID_MAX_LEN),
      source_type: normalizeTouchpointText(input.referral.sourceType, SOURCE_TYPE_MAX_LEN),
      source_id: normalizeTouchpointText(input.referral.sourceId, SOURCE_ID_MAX_LEN),
      referral: raw,
    },
  };
}

export type TouchpointInsertOutcome = "inserted" | "duplicate" | "failed";

/** `23505` é dedupe silencioso (reentrega); qualquer outro erro é falha reentregável. */
export function classifyTouchpointInsert(
  error: { code?: string | null } | null | undefined,
): TouchpointInsertOutcome {
  if (!error) return "inserted";
  return error.code === "23505" ? "duplicate" : "failed";
}

function firstMetaMessage(payload: unknown): Record<string, unknown> | null {
  // deno-lint-ignore no-explicit-any
  const msg = (payload as any)?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  return msg && typeof msg === "object" && !Array.isArray(msg) ? msg as Record<string, unknown> : null;
}

/**
 * `meta_inbound_referral_probe`: responde o que `ad_referral_captured` não
 * alcança — o clique chegou com o referral em OUTRO lugar? Sem ele, envelope
 * divergente é silêncio, e silêncio é indistinguível de "ninguém clicou".
 */
export function describeReferralProbe(payload: unknown): { has_referral: boolean; message_shape: unknown } {
  const msg = firstMetaMessage(payload);
  if (!msg) return { has_referral: false, message_shape: null };
  return {
    has_referral: msg.referral !== undefined && msg.referral !== null,
    message_shape: shapeOf(msg),
  };
}

export type TouchpointCaptureOutcome = TouchpointInsertOutcome | "rejected";

/** `ad_referral_captured` / `ad_referral_rejected`: os campos têm o nome que a documentação diz? */
export function describeCapturedReferral(args: {
  provider: string;
  outcome: TouchpointCaptureOutcome;
  referral: AdReferral;
  rawOmittedReason?: RawOmittedReason | null;
  rejectReason?: AdTouchpointRejectReason;
}): Record<string, unknown> {
  return {
    provider: args.provider,
    outcome: args.outcome,
    message_type: normalizeTouchpointText(args.referral.messageType, MESSAGE_TYPE_MAX_LEN),
    referral_shape: shapeOf(args.referral.raw),
    raw_omitted: args.rawOmittedReason ?? null,
    ...(args.rejectReason ? { reason: args.rejectReason } : {}),
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/whatsapp-ad-touchpoint-core.test.ts`
Expected: PASS. Se algum caso do `it.each` "not_storable" passar a `toBeNull` por outro motivo (ex.: `too_large`), o teste reprova pelo `rawOmittedReason` — é intencional.

- [ ] **Step 5: Gates e commit**

Run: `npm run typecheck` e `npm run lint` → 0 erros.

```bash
git add supabase/functions/_shared/whatsapp-ad-touchpoint-core.ts src/lib/whatsapp-ad-touchpoint-core.test.ts
git commit -m "feat(whatsapp): nucleo puro do touchpoint CTWA, que neutraliza tudo que o banco recusaria

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Migration 115 e os gêmeos declarados

**Files:**
- Create: `supabase/migrations/20260927120000_115_whatsapp_ad_touchpoints.sql`
- Create: `src/lib/whatsapp-ad-touchpoint-migration-twin.test.ts`
- Modify: `scripts/function-acl-allowlist.json` (linha ~39 do `_doc`)
- Modify: `docs/superpowers/specs/2026-09-27-datafy-fase-d-ctwa-referral-design.md` (§4.5, última linha)

**Interfaces:**
- Consumes: constantes e `AD_TOUCHPOINT_PROVIDERS` da Task 2.
- Produces: tabela `public.whatsapp_ad_touchpoints`; funções `public.whatsapp_ad_touchpoints_guard()` e `public.purge_ad_touchpoints_on_customer_anonymize()`; triggers `whatsapp_ad_touchpoints_guard_trg` e `customers_purge_ad_touchpoints_trg`; os marcadores de comentário `-- <excecao-set-null>`, `-- <coerencia-tenant>` e `-- <guarda-update>` (com os fechamentos `-- </...>`) DENTRO do corpo do guard — a Task 4 os usa para sabotar por delta mínimo.

- [ ] **Step 1: Escrever o teste gêmeo (falha)**

Criar `src/lib/whatsapp-ad-touchpoint-migration-twin.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AD_TOUCHPOINT_PROVIDERS,
  CTWA_CLID_MAX_LEN,
  MESSAGE_TYPE_MAX_LEN,
  PROVIDER_MESSAGE_ID_MAX_LEN,
  REFERRAL_RAW_DB_MAX_BYTES,
  REFERRAL_RAW_MAX_BYTES,
  SOURCE_ID_MAX_LEN,
  SOURCE_TYPE_MAX_LEN,
} from "../../supabase/functions/_shared/whatsapp-ad-touchpoint-core";

// Gêmeos declarados: SQL não importa TypeScript. Este teste é o único ponto
// que amarra os dois lados.
const MIGRATIONS = resolve(__dirname, "../../supabase/migrations");
const ARQUIVO = readdirSync(MIGRATIONS).find((f) => /^\d{14}_115_whatsapp_ad_touchpoints\.sql$/.test(f));
const SQL = ARQUIVO ? readFileSync(resolve(MIGRATIONS, ARQUIVO), "utf8") : "";

function semComentarios(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function providersDoCheck(sql: string): string[] {
  const m = semComentarios(sql).match(/provider\s+text\s+not\s+null\s+check\s*\(\s*provider\s+in\s*\(([^)]*)\)\s*\)/i);
  if (!m) throw new Error("CHECK de provider não encontrado");
  return m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort();
}

function limiteDaColuna(sql: string, coluna: string): number {
  const m = semComentarios(sql).match(new RegExp(`\\b${coluna}\\s+text\\b[^\\n]*?between\\s+1\\s+and\\s+(\\d+)`, "i"));
  if (!m) throw new Error(`limite de ${coluna} não encontrado`);
  return Number(m[1]);
}

describe("migration 115 ⇔ núcleo do touchpoint", () => {
  it("o arquivo existe e vem depois da 114 (20260924120300)", () => {
    expect(ARQUIVO).toBeDefined();
    expect(Number(ARQUIVO!.slice(0, 14))).toBeGreaterThan(20260924120300);
  });

  it("o CHECK de provider é o conjunto de providers com adReferral", () => {
    expect(providersDoCheck(SQL)).toEqual([...AD_TOUCHPOINT_PROVIDERS].sort());
  });

  it("CONTROLE POSITIVO: um provider a mais no CHECK reprova", () => {
    const sabotado = SQL.replace("in ('official','datafy')", "in ('official','datafy','zapi')");
    expect(sabotado).not.toBe(SQL);
    expect(providersDoCheck(sabotado)).not.toEqual([...AD_TOUCHPOINT_PROVIDERS].sort());
  });

  it("os limites de coluna são os do núcleo", () => {
    expect(limiteDaColuna(SQL, "provider_message_id")).toBe(PROVIDER_MESSAGE_ID_MAX_LEN);
    expect(limiteDaColuna(SQL, "message_type")).toBe(MESSAGE_TYPE_MAX_LEN);
    expect(limiteDaColuna(SQL, "ctwa_clid")).toBe(CTWA_CLID_MAX_LEN);
    expect(limiteDaColuna(SQL, "source_type")).toBe(SOURCE_TYPE_MAX_LEN);
    expect(limiteDaColuna(SQL, "source_id")).toBe(SOURCE_ID_MAX_LEN);
  });

  it("o CHECK da subárvore é a REDE (65536) e a regra do núcleo cabe nela com folga de 2x", () => {
    const m = semComentarios(SQL).match(/octet_length\(referral::text\)\s*<=\s*(\d+)/i);
    expect(Number(m?.[1])).toBe(REFERRAL_RAW_DB_MAX_BYTES);
    expect(REFERRAL_RAW_MAX_BYTES * 2).toBeLessThanOrEqual(REFERRAL_RAW_DB_MAX_BYTES);
  });

  it("RLS forçada, nenhuma policy", () => {
    const sql = semComentarios(SQL).toLowerCase();
    expect(sql).toContain("alter table whatsapp_ad_touchpoints enable row level security");
    expect(sql).toContain("alter table whatsapp_ad_touchpoints force row level security");
    expect(sql).not.toMatch(/create\s+policy/);
  });

  it("as duas funções de trigger são revogadas de public, anon e authenticated com a assinatura completa", () => {
    const sql = semComentarios(SQL).toLowerCase();
    expect(sql).toContain("revoke all on function public.whatsapp_ad_touchpoints_guard() from public, anon, authenticated");
    expect(sql).toContain("revoke all on function public.purge_ad_touchpoints_on_customer_anonymize() from public, anon, authenticated");
    expect(sql).not.toMatch(/grant\s+[^;]*\bon\s+function\b/);
  });

  it("os marcadores de que os controles do pré-voo dependem estão no corpo do guard", () => {
    for (const marcador of ["excecao-set-null", "coerencia-tenant", "guarda-update"]) {
      expect(SQL).toContain(`-- <${marcador}>`);
      expect(SQL).toContain(`-- </${marcador}>`);
    }
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/whatsapp-ad-touchpoint-migration-twin.test.ts`
Expected: FAIL — `ARQUIVO` indefinido.

- [ ] **Step 3: Escrever a migration**

Criar `supabase/migrations/20260927120000_115_whatsapp_ad_touchpoints.sql`:

```sql
-- Fase D — touchpoint de anúncio Click-to-WhatsApp (CTWA).
--
-- Uma linha por MENSAGEM que chegou com `referral`, gravada pelo
-- `webhook-whatsapp` (service_role) depois do claim de `processed_messages`.
-- Spec: docs/superpowers/specs/2026-09-27-datafy-fase-d-ctwa-referral-design.md
--
-- ESCOPO (D1): o touchpoint é da UNIDADE que recebeu o clique (`unit_id` +
-- `channel_id`, lidos do canal da querystring) e aponta para o CLIENTE da
-- organização (`customer_id`). Não há `organization_id`: a visão da organização
-- é `where customer_id = K`, porque `customers` já é da organização. A coerência
-- entre as três FKs é amarrada no banco pelo guard abaixo.
--
-- IMUTÁVEL: o histórico é o dado de atribuição. Nenhum UPDATE é aceito, com UMA
-- exceção obrigatória — a coerção do `on delete set null` de `channel_id`. Sem
-- ela, apagar o canal abortaria o DELETE inteiro (o conflito FK × CHECK da 089).
--
-- RETENÇÃO (D3): sem purga por tempo nesta fase. Anonimizar o cliente
-- (`customers.deleted_at`) apaga os touchpoints dele, por trigger SECURITY
-- DEFINER; exclusão física do cliente ou da unidade, por cascade.
--
-- Os limites dos CHECKs são GÊMEOS DECLARADOS das constantes de
-- `_shared/whatsapp-ad-touchpoint-core.ts`, e a lista de `provider` é gêmea de
-- `PROVIDER_CAPABILITIES[*].adReferral === true`. SQL não importa TypeScript:
-- `src/lib/whatsapp-ad-touchpoint-migration-twin.test.ts` lê este arquivo e
-- reprova divergência. O 65536 da subárvore é a REDE, não a regra: a regra é
-- 16384 bytes no núcleo, porque o `jsonb::text` fica mais longo que o
-- `JSON.stringify`, e recusa do banco viraria reentrega eterna (D8).

create table if not exists whatsapp_ad_touchpoints (
  id                   uuid        primary key default gen_random_uuid(),
  unit_id              uuid        not null references units(id) on delete cascade,
  channel_id           uuid                 references whatsapp_channels(id) on delete set null,
  customer_id          uuid        not null references customers(id) on delete cascade,
  provider             text        not null check (provider in ('official','datafy')),
  provider_message_id  text        not null check (length(btrim(provider_message_id)) between 1 and 512),
  message_type         text        check (message_type is null or length(message_type) between 1 and 32),
  message_at           timestamptz not null,
  received_at          timestamptz not null default now(),
  ctwa_clid            text        check (ctwa_clid   is null or length(ctwa_clid)   between 1 and 512),
  source_type          text        check (source_type is null or length(source_type) between 1 and 64),
  source_id            text        check (source_id   is null or length(source_id)   between 1 and 256),
  referral             jsonb       check (referral is null or octet_length(referral::text) <= 65536)
);

comment on table whatsapp_ad_touchpoints is
  'Fase D: touchpoint de anuncio Click-to-WhatsApp, uma linha por mensagem com referral. Imutavel (trigger). FORCE RLS sem policies: so service_role, via Edge Function. Escopo: unit_id + channel_id do canal, customer_id do cliente da organizacao.';
comment on column whatsapp_ad_touchpoints.ctwa_clid is
  'Identificador pessoal pseudonimizado do clique: a Meta o resolve ate a pessoa. Chave da Fase I (Conversions API). Apagado na anonimizacao do cliente.';
comment on column whatsapp_ad_touchpoints.referral is
  'Subarvore referral CRUA como chegou (ate 16 KiB no nucleo; o CHECK de 64 KiB e rede). Nunca o corpo da mensagem: sem telefone, nome ou texto. Existe porque o envelope da Datafy nao foi medido: se o identificador vier sob outro nome, e aqui que ele sobrevive.';
comment on column whatsapp_ad_touchpoints.provider is
  'So quem declara adReferral. Gemeo declarado de PROVIDER_CAPABILITIES[*].adReferral (teste em src/lib/whatsapp-ad-touchpoint-migration-twin.test.ts).';

-- Um touchpoint por mensagem: mesma chave de `processed_messages`. Reentrega é
-- 23505, tratado como dedupe silencioso no núcleo.
create unique index if not exists whatsapp_ad_touchpoints_message_idx
  on whatsapp_ad_touchpoints (provider, provider_message_id);

-- A consulta da Fase I.
create index if not exists whatsapp_ad_touchpoints_unit_customer_idx
  on whatsapp_ad_touchpoints (unit_id, customer_id, message_at desc);

-- O DELETE da anonimização.
create index if not exists whatsapp_ad_touchpoints_customer_idx
  on whatsapp_ad_touchpoints (customer_id);

alter table whatsapp_ad_touchpoints enable row level security;
alter table whatsapp_ad_touchpoints force row level security;
-- Sem policies: só service_role, via Edge Function. Mesma disciplina de
-- whatsapp_channels, processed_messages e whatsapp_inbound_events: a separação
-- entre clientes depende do `.eq(...)` no código e, aqui, do guard abaixo.

-- ─── Guarda da linha ────────────────────────────────────────────────────────
-- SECURITY INVOKER: só o service_role escreve (ele ignora RLS); qualquer outro
-- papel já é barrado pela RLS forçada. `search_path = ''` obriga a qualificar.
--
-- Os comentários `-- <marcador>` / `-- </marcador>` NÃO são decoração: os
-- controles positivos do pré-voo (supabase/tests/local-preflight/
-- 23-controles-115.sql) sabotam o corpo por delta mínimo sobre
-- `pg_get_functiondef`, recortando entre eles. Não os remova.
create or replace function public.whatsapp_ad_touchpoints_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_unit_org     uuid;
  v_cust_org     uuid;
  v_cust_deleted timestamptz;
begin
  -- <guarda-update>
  if tg_op = 'UPDATE' then
    -- <excecao-set-null>
    -- Única exceção: a coerção do `on delete set null` de channel_id — não nulo
    -- para nulo, com TODAS as outras colunas iguais. Sem ela, apagar o canal
    -- aborta o DELETE inteiro (conflito FK × CHECK da migration 089).
    if old.channel_id is not null
       and new.channel_id is null
       and (to_jsonb(new) - 'channel_id') = (to_jsonb(old) - 'channel_id') then
      return new;
    end if;
    -- </excecao-set-null>
    raise exception 'whatsapp_ad_touchpoints e imutavel: touchpoint nunca e reescrito (id %)', old.id
      using errcode = 'check_violation';
  end if;
  -- </guarda-update>

  -- <coerencia-tenant>
  if new.channel_id is not null and not exists (
    select 1 from public.whatsapp_channels ch
     where ch.id = new.channel_id and ch.unit_id = new.unit_id
  ) then
    raise exception 'whatsapp_ad_touchpoints: canal % nao pertence a unidade %', new.channel_id, new.unit_id
      using errcode = 'check_violation';
  end if;

  select u.organization_id into v_unit_org from public.units u where u.id = new.unit_id;
  select c.organization_id, c.deleted_at into v_cust_org, v_cust_deleted
    from public.customers c where c.id = new.customer_id;

  if v_unit_org is null or v_cust_org is distinct from v_unit_org then
    raise exception 'whatsapp_ad_touchpoints: cliente % nao pertence a organizacao da unidade %', new.customer_id, new.unit_id
      using errcode = 'check_violation';
  end if;
  -- </coerencia-tenant>

  -- Cliente vivo: sem isto, uma anonimização entre o resolveOrCreateCustomer e
  -- o INSERT deixaria um ctwa_clid preso a cliente já anonimizado, depois de o
  -- trigger de purga ter rodado. A recusa é reentregável e se cura sozinha: a
  -- anonimização troca o telefone, e a reentrega cria um cliente novo.
  if v_cust_deleted is not null then
    raise exception 'whatsapp_ad_touchpoints: cliente % anonimizado', new.customer_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists whatsapp_ad_touchpoints_guard_trg on whatsapp_ad_touchpoints;
create trigger whatsapp_ad_touchpoints_guard_trg
  before insert or update on whatsapp_ad_touchpoints
  for each row execute function public.whatsapp_ad_touchpoints_guard();

-- ─── Anonimização LGPD ──────────────────────────────────────────────────────
-- `anonymize_customer` faz SOFT delete (`deleted_at = now()`), então o cascade
-- da FK não dispara. Trigger em `customers`, e não uma linha a mais na RPC:
-- cobre QUALQUER caminho que marque `deleted_at` e não reescreve o corpo de uma
-- SECURITY DEFINER com três versões de histórico.
--
-- TEM de ser SECURITY DEFINER: a tabela é FORCE RLS sem policies, e um DELETE
-- rodado como `authenticated` (um membro fazendo soft delete pelo PostgREST)
-- apagaria ZERO linhas em silêncio — o ctwa_clid do cliente anonimizado
-- sobreviveria. Como dono (`postgres`, rolbypassrls = true, medido em produção)
-- o DELETE alcança as linhas. Controle positivo C-115-4 no pré-voo.
create or replace function public.purge_ad_touchpoints_on_customer_anonymize()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.whatsapp_ad_touchpoints where customer_id = new.id;
  return null;
end;
$$;

drop trigger if exists customers_purge_ad_touchpoints_trg on public.customers;
create trigger customers_purge_ad_touchpoints_trg
  after update of deleted_at on public.customers
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function public.purge_ad_touchpoints_on_customer_anonymize();

-- ─── ACL ────────────────────────────────────────────────────────────────────
-- `CREATE FUNCTION` concede EXECUTE a PUBLIC. Trigger function não precisa de
-- EXECUTE de ninguém para disparar; revogar fecha a chamada direta pelo
-- PostgREST. Nenhuma das duas é concedida: nenhuma entra na allowlist de ACL.
revoke all on function public.whatsapp_ad_touchpoints_guard() from public, anon, authenticated;
revoke all on function public.purge_ad_touchpoints_on_customer_anonymize() from public, anon, authenticated;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. RLS forçada e sem policies (esperado: t, t, 0):
--   select relrowsecurity, relforcerowsecurity from pg_class where relname = 'whatsapp_ad_touchpoints';
--   select count(*) from pg_policies where tablename = 'whatsapp_ad_touchpoints';
-- 2. Nenhuma das funções executável por anon/authenticated (esperado: f, f, f, f):
--   select has_function_privilege('anon', 'public.whatsapp_ad_touchpoints_guard()', 'execute'),
--          has_function_privilege('authenticated', 'public.whatsapp_ad_touchpoints_guard()', 'execute'),
--          has_function_privilege('anon', 'public.purge_ad_touchpoints_on_customer_anonymize()', 'execute'),
--          has_function_privilege('authenticated', 'public.purge_ad_touchpoints_on_customer_anonymize()', 'execute');
-- 3. Triggers presentes (esperado: 2 linhas):
--   select tgname from pg_trigger where not tgisinternal
--    and tgname in ('whatsapp_ad_touchpoints_guard_trg', 'customers_purge_ad_touchpoints_trg');
--
-- Rollback:
--   drop trigger if exists customers_purge_ad_touchpoints_trg on public.customers;
--   drop table if exists whatsapp_ad_touchpoints;
--   drop function if exists public.purge_ad_touchpoints_on_customer_anonymize();
--   drop function if exists public.whatsapp_ad_touchpoints_guard();
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/whatsapp-ad-touchpoint-migration-twin.test.ts scripts/function-acl-allowlist.test.ts scripts/migration-static-guard.test.ts`
Expected: PASS nos três (os dois de `scripts/` são o `acl-estatico` e o guard de migration do CI; a 115 não concede nada e não embute URL nem segredo).

- [ ] **Step 5: Corrigir o número do lint 0008 e a spec**

5a. Em `scripts/function-acl-allowlist.json`, a linha `"NÃO cobre o lint INFO 0008 (rls_enabled_no_policy, 17 tabelas): ele vem de",` passa a:

```json
      "NÃO cobre o lint INFO 0008 (rls_enabled_no_policy, 19 tabelas depois da 111",
      "e da 115 — 17 medidas em 2026-09-18, mais whatsapp_inbound_events e",
      "whatsapp_ad_touchpoints): ele vem de",
```

Run: `npx vitest run scripts/function-acl-allowlist.test.ts` → PASS (o `_doc` é array de strings; o teste "está bem formada" confere isso).

5b. Na spec, §4.5, a linha `- O lint INFO 0008 (\`rls_enabled_no_policy\`) passa de 17 para 18 tabelas; o \`_doc\` da allowlist cita o número e é atualizado.` passa a:

```md
- O lint INFO 0008 (`rls_enabled_no_policy`) passa de 17 para **19** tabelas depois da 111 e da 115 (o 17 foi medido em 2026-09-18, antes da `whatsapp_inbound_events` da Fase C); o `_doc` da allowlist cita o número e é atualizado. *Corrigido na execução: a redação original dizia 18 e esquecia a tabela da Fase C.*
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260927120000_115_whatsapp_ad_touchpoints.sql src/lib/whatsapp-ad-touchpoint-migration-twin.test.ts scripts/function-acl-allowlist.json docs/superpowers/specs/2026-09-27-datafy-fase-d-ctwa-referral-design.md
git commit -m "feat(db): migration 115, touchpoint CTWA imutavel com coerencia de tenant no banco

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Pré-voo local da 115 (TP-1..TP-11 e C-115-1..C-115-5)

**Files:**
- Create: `supabase/tests/local-preflight/22a-ad-touchpoints-bootstrap.sql`
- Create: `supabase/tests/local-preflight/22-ad-touchpoints-115.sql`
- Create: `supabase/tests/local-preflight/23-controles-115.sql`
- Modify: `supabase/tests/local-preflight/README.md` (tabela "Os arquivos" + seção nova depois da "Sequência da migration 113")

**Interfaces:**
- Consumes: a migration 115 (Task 3), com os marcadores `-- <excecao-set-null>`, `-- <coerencia-tenant>`, `-- <guarda-update>`.
- Produces: vereditos em `t_res` nos ordinais 85–101 (e sentinela −23).

**Antes de escrever, LEIA:** `supabase/tests/local-preflight/README.md` (seções "Rodar", "Sequência da migration 111" e a nota "Por que reaplicar a 111 não restaura"), `16-inbound-events-111.sql` (guarda do topo, subtransação `ZZ111`, upsert em `t_res`) e `17-controles-111.sql` (sentinela `ord = 0`, captura → sabota → mede → rollback → confere restore). Este conjunto segue o mesmo desenho, com `ZZ115`.

**Ambiente (medido em 2026-09-28):** PostgreSQL 18.4 do scoop **já está no ar na porta 55432** — NÃO rode `pg_ctl start` nem `stop`; só crie e apague o banco `fased115`. `PGCLIENTENCODING=UTF8` é obrigatório.

- [ ] **Step 1: Escrever o bootstrap `22a-ad-touchpoints-bootstrap.sql`**

```sql
-- Fase D (migration 115): o mínimo que a 115 referencia e o 00 não tem.
--
-- SEQUÊNCIA (banco PRÓPRIO `fased115`, ver a seção da 115 no README):
--   00-bootstrap.sql -> 00a-whatsapp-legacy-seed.sql -> 22a (este) -> 115 -> 22 -> 23
--
-- 1. DEFAULT PRIVILEGES — emula o Supabase, que concede ALL nas tabelas novas de
--    `public` a anon/authenticated/service_role. Tem de vir ANTES da 115: é o
--    que dá a `authenticated` o DELETE que torna o C-115-4 honesto. Sem o grant,
--    o trigger INVOKER estouraria 42501 em vez de apagar ZERO linhas em silêncio
--    — e o defeito real é o silêncio.
-- 2. `customers` fiel MÍNIMO (id, organization_id, name, phone, deleted_at), com
--    RLS e uma policy PERMISSIVA de fixture para `authenticated`: representa "um
--    membro fazendo soft delete pelo PostgREST". Não é a policy de produção.
-- 3. Três clientes: dois da org A (o TP-9 prova "só os dele") e um da org B.

do $$
begin
  if to_regclass('public.whatsapp_ad_touchpoints') is not null then
    raise exception '22a exige rodar ANTES da migration 115: a tabela ja existe e nasceu sem os default privileges, o que muda o que o TP-9 e o C-115-4 medem. Recrie o banco.';
  end if;
  if not exists (select 1 from units where id = 'bbbbbbbb-0000-0000-0000-000000000001')
     or not exists (select 1 from whatsapp_channels where id = 'dddddddd-0000-0000-0000-000000000002') then
    raise exception '22a exige 00-bootstrap.sql e 00a-whatsapp-legacy-seed.sql aplicados.';
  end if;
end $$;

alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;

create table if not exists public.customers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name            text not null,
  phone           text not null,
  deleted_at      timestamptz
);

alter table public.customers enable row level security;
drop policy if exists customers_fixture_authenticated_all on public.customers;
create policy customers_fixture_authenticated_all on public.customers
  for all to authenticated using (true) with check (true);

insert into public.customers (id, organization_id, name, phone) values
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Cliente A1', '11911110001'),
  ('cccccccc-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Cliente A2', '11911110002'),
  ('cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002', 'Cliente B1', '11911110003')
on conflict (id) do nothing;
```

- [ ] **Step 2: Escrever `22-ad-touchpoints-115.sql` (casos)**

Cabeçalho explicando: o que prova (trigger, CHECK, FK, cascade, RLS forçada com papel real `authenticated`, ACL de função, idempotência) e o que NÃO prova (PostgREST); sequência; convenção `ZZ115` de rollback de subtransação; upsert em `t_res`. Depois:

```sql
-- ─── GUARDA: só faz sentido DEPOIS da 115 e do 22a ──────────────────────────
-- Rodado antes, TP-5/6/6b/7 passariam POR ACIDENTE: sem a tabela todo insert
-- "falha" e todo caso negativo fica verde medindo nada.
do $$
begin
  if to_regclass('public.whatsapp_ad_touchpoints') is null then
    raise exception '22-ad-touchpoints-115.sql exige a migration 115 aplicada (tabela public.whatsapp_ad_touchpoints ausente). Sequencia: 00 -> 00a -> 22a -> 115 -> 22 -> 23.';
  end if;
  if not exists (select 1 from public.customers where id = 'cccccccc-0000-0000-0000-000000000003') then
    raise exception '22-ad-touchpoints-115.sql exige o 22a-ad-touchpoints-bootstrap.sql (clientes cccccccc-... ausentes).';
  end if;
end $$;

create table if not exists t_res (ord int primary key, caso text, veredito text);
create table if not exists t_snap115 (k text primary key, v text not null);

create or replace function pg_temp.tp_res(p_ord int, p_caso text, p_veredito text)
returns void language sql as $$
  insert into t_res values (p_ord, p_caso, p_veredito)
  on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
$$;

-- Insert válido por default: unidade A1, canal A1, cliente A1, datafy.
create or replace function pg_temp.tp_ins(
  p_msg      text,
  p_unit     uuid  default 'bbbbbbbb-0000-0000-0000-000000000001',
  p_channel  uuid  default 'dddddddd-0000-0000-0000-000000000001',
  p_customer uuid  default 'cccccccc-0000-0000-0000-000000000001',
  p_provider text  default 'datafy',
  p_referral jsonb default '{"ctwa_clid":"clid","source_type":"ad"}'::jsonb
) returns uuid language sql as $$
  insert into public.whatsapp_ad_touchpoints
    (unit_id, channel_id, customer_id, provider, provider_message_id, message_type,
     message_at, ctwa_clid, source_type, source_id, referral)
  values (p_unit, p_channel, p_customer, p_provider, p_msg, 'text',
          now(), 'clid-' || p_msg, 'ad', 'ad-1', p_referral)
  returning id;
$$;

-- ─── TP-1 (85): insert válido; source_type desconhecido entra ───────────────
do $$
declare v_id uuid; v_recv timestamptz; v_src text; v_ok boolean := false;
begin
  begin
    insert into public.whatsapp_ad_touchpoints
      (unit_id, channel_id, customer_id, provider, provider_message_id, message_type,
       message_at, ctwa_clid, source_type, source_id, referral)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001',
            'cccccccc-0000-0000-0000-000000000001', 'official', 'wamid.TP1', 'image',
            now(), 'clid-tp1', 'reel', 'ad-1', '{"ctwa_clid":"clid-tp1","source_type":"reel"}'::jsonb)
    returning id, received_at, source_type into v_id, v_recv, v_src;
    v_ok := v_id is not null and v_recv is not null and v_src = 'reel';
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  perform pg_temp.tp_res(85, 'TP-1', case when v_ok then 'OK'
    else 'FALHOU: insert valido nao gravou (source_type desconhecido tem de entrar: recusa viraria reentrega eterna)' end);
exception when others then
  perform pg_temp.tp_res(85, 'TP-1', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-2 (86): reentrega da mesma mensagem → 23505 ─────────────────────────
do $$
declare v_state text;
begin
  begin
    perform pg_temp.tp_ins('wamid.TP2');
    begin
      perform pg_temp.tp_ins('wamid.TP2');
      v_state := 'aceitou';
    exception when unique_violation then v_state := '23505';
    end;
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  perform pg_temp.tp_res(86, 'TP-2', case when v_state = '23505' then 'OK'
    else 'FALHOU: reentrega da mesma (provider, provider_message_id) nao estourou 23505: ' || coalesce(v_state, 'null') end);
exception when others then
  perform pg_temp.tp_res(86, 'TP-2', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-3 (87): nenhum UPDATE é aceito, nem o que não muda nada ─────────────
do $$
declare
  v_id uuid;
  v_stmt text;
  v_passaram text[] := '{}';
  v_stmts text[] := array[
    'update public.whatsapp_ad_touchpoints set ctwa_clid = ''outro'' where id = $1',
    'update public.whatsapp_ad_touchpoints set referral = ''{}''::jsonb where id = $1',
    'update public.whatsapp_ad_touchpoints set customer_id = ''cccccccc-0000-0000-0000-000000000002'' where id = $1',
    'update public.whatsapp_ad_touchpoints set message_at = now() - interval ''1 day'' where id = $1',
    'update public.whatsapp_ad_touchpoints set source_id = ''ad-2'' where id = $1',
    'update public.whatsapp_ad_touchpoints set channel_id = channel_id where id = $1',
    'update public.whatsapp_ad_touchpoints set channel_id = null, ctwa_clid = ''outro'' where id = $1'
  ];
begin
  begin
    v_id := pg_temp.tp_ins('wamid.TP3');
    foreach v_stmt in array v_stmts loop
      begin
        execute v_stmt using v_id;
        v_passaram := v_passaram || v_stmt;
      exception when check_violation then null;
      end;
    end loop;
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  perform pg_temp.tp_res(87, 'TP-3', case when cardinality(v_passaram) = 0 then 'OK'
    else 'FALHOU: UPDATE aceito num touchpoint: ' || array_to_string(v_passaram, ' | ') end);
exception when others then
  perform pg_temp.tp_res(87, 'TP-3', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-4 (88): DELETE do canal conclui e a linha fica com channel_id nulo ──
do $$
declare
  v_chan uuid := 'dddddddd-0000-0000-0000-0000000000f4';
  v_id uuid; v_existe boolean := false; v_canal uuid; v_erro text;
begin
  begin
    insert into whatsapp_channels (id, unit_id, provider, status, display_phone)
    values (v_chan, 'bbbbbbbb-0000-0000-0000-000000000001', 'official', 'disconnected', '5511000000f4');
    v_id := pg_temp.tp_ins('wamid.TP4', p_channel => v_chan);
    delete from whatsapp_channels where id = v_chan;
    select true, channel_id into v_existe, v_canal from public.whatsapp_ad_touchpoints where id = v_id;
    raise exception using errcode = 'ZZ115';
  exception
    when sqlstate 'ZZ115' then null;
    when others then v_erro := sqlstate || ' ' || sqlerrm;
  end;
  perform pg_temp.tp_res(88, 'TP-4', case
    when v_erro is not null then 'FALHOU: DELETE do canal abortou (a excecao do set null sumiu?): ' || v_erro
    when v_existe and v_canal is null then 'OK'
    else 'FALHOU: touchpoint sumiu ou manteve channel_id apos apagar o canal' end);
exception when others then
  perform pg_temp.tp_res(88, 'TP-4', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-5 (89) e TP-6 (90): coerência de tenant ─────────────────────────────
-- Nos casos NEGATIVOS o `ZZ115` também é obrigatório: com o guard defeituoso o
-- insert PASSA, e sem o rollback a linha ficaria — o arquivo deixaria de ser
-- re-runnable e o TP-11 acusaria "sobrou linha" apontando o lugar errado.
do $$
declare v_state text; v_msg text;
begin
  begin
    -- canal dddd...02 é da unidade B1; a linha diz unidade A1.
    perform pg_temp.tp_ins('wamid.TP5', p_channel => 'dddddddd-0000-0000-0000-000000000002');
    v_state := 'aceitou';
    raise exception using errcode = 'ZZ115';
  exception
    when check_violation then v_state := '23514'; v_msg := sqlerrm;
    when sqlstate 'ZZ115' then null;
  end;
  perform pg_temp.tp_res(89, 'TP-5', case when v_state = '23514' and v_msg ilike '%canal%' then 'OK'
    else 'FALHOU: canal de outra unidade aceito ou recusado pela perna errada: ' || coalesce(v_state, 'null') || ' ' || coalesce(v_msg, '') end);
exception when others then
  perform pg_temp.tp_res(89, 'TP-5', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

do $$
declare v_state text; v_msg text;
begin
  begin
    -- cliente cccc...03 é da org B; a unidade A1 é da org A.
    perform pg_temp.tp_ins('wamid.TP6', p_channel => null, p_customer => 'cccccccc-0000-0000-0000-000000000003');
    v_state := 'aceitou';
    raise exception using errcode = 'ZZ115';
  exception
    when check_violation then v_state := '23514'; v_msg := sqlerrm;
    when sqlstate 'ZZ115' then null;
  end;
  perform pg_temp.tp_res(90, 'TP-6', case when v_state = '23514' and v_msg ilike '%organizacao%' then 'OK'
    else 'FALHOU: cliente de outra organizacao aceito ou recusado pela perna errada: ' || coalesce(v_state, 'null') || ' ' || coalesce(v_msg, '') end);
exception when others then
  perform pg_temp.tp_res(90, 'TP-6', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-6b (91): cliente anonimizado recusado ───────────────────────────────
do $$
declare v_state text; v_msg text;
begin
  begin
    update public.customers set deleted_at = now() where id = 'cccccccc-0000-0000-0000-000000000002';
    begin
      perform pg_temp.tp_ins('wamid.TP6b', p_customer => 'cccccccc-0000-0000-0000-000000000002');
      v_state := 'aceitou';
    exception when check_violation then v_state := '23514'; v_msg := sqlerrm;
    end;
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  perform pg_temp.tp_res(91, 'TP-6b', case when v_state = '23514' and v_msg ilike '%anonimizado%' then 'OK'
    else 'FALHOU: cliente com deleted_at aceito: ' || coalesce(v_state, 'null') || ' ' || coalesce(v_msg, '') end);
exception when others then
  perform pg_temp.tp_res(91, 'TP-6b', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-7 (92): provider sem adReferral recusado pelo CHECK ─────────────────
do $$
declare v_state text; v_msg text;
begin
  begin
    perform pg_temp.tp_ins('wamid.TP7', p_provider => 'zapi');
    v_state := 'aceitou';
    raise exception using errcode = 'ZZ115';
  exception
    when check_violation then v_state := '23514'; v_msg := sqlerrm;
    when sqlstate 'ZZ115' then null;
  end;
  perform pg_temp.tp_res(92, 'TP-7', case when v_state = '23514' and v_msg ilike '%provider%' then 'OK'
    else 'FALHOU: provider zapi aceito: ' || coalesce(v_state, 'null') || ' ' || coalesce(v_msg, '') end);
exception when others then
  perform pg_temp.tp_res(92, 'TP-7', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-8 (93): CHECK de tamanho da subárvore (a REDE, 64 KiB) ──────────────
do $$
declare v_grande text; v_pequeno boolean := false; v_msg text;
begin
  begin
    begin
      perform pg_temp.tp_ins('wamid.TP8g', p_referral => jsonb_build_object('x', repeat('a', 70000)));
      v_grande := 'aceitou';
    exception when check_violation then v_grande := '23514'; v_msg := sqlerrm;
    end;
    perform pg_temp.tp_ins('wamid.TP8p', p_referral => jsonb_build_object('x', repeat('a', 1000)));
    v_pequeno := true;
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  perform pg_temp.tp_res(93, 'TP-8', case when v_grande = '23514' and v_msg ilike '%referral%' and v_pequeno then 'OK'
    else 'FALHOU: CHECK de tamanho: grande=' || coalesce(v_grande, 'null') || ' pequeno=' || v_pequeno end);
exception when others then
  perform pg_temp.tp_res(93, 'TP-8', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-9 (94): soft delete COMO authenticated apaga os touchpoints dele, e só os dele
do $$
declare v_antes int; v_depois int; v_outro int; v_linhas int;
begin
  begin
    perform pg_temp.tp_ins('wamid.TP9a');
    perform pg_temp.tp_ins('wamid.TP9b');
    perform pg_temp.tp_ins('wamid.TP9c', p_customer => 'cccccccc-0000-0000-0000-000000000002');
    select count(*) into v_antes from public.whatsapp_ad_touchpoints where customer_id = 'cccccccc-0000-0000-0000-000000000001';
    set local role authenticated;
    update public.customers set deleted_at = now() where id = 'cccccccc-0000-0000-0000-000000000001';
    get diagnostics v_linhas = row_count;
    reset role;
    select count(*) into v_depois from public.whatsapp_ad_touchpoints where customer_id = 'cccccccc-0000-0000-0000-000000000001';
    select count(*) into v_outro  from public.whatsapp_ad_touchpoints where customer_id = 'cccccccc-0000-0000-0000-000000000002';
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  perform pg_temp.tp_res(94, 'TP-9', case when v_antes = 2 and v_linhas = 1 and v_depois = 0 and v_outro = 1 then 'OK'
    else format('FALHOU: antes=%s update=%s depois=%s outro_cliente=%s (esperado 2/1/0/1)', v_antes, v_linhas, v_depois, v_outro) end);
exception when others then
  perform pg_temp.tp_res(94, 'TP-9', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-10 (95): RLS forçada, zero policies, triggers, ACL e forma das funções
do $$
declare
  v_rls boolean; v_force boolean; v_pol int; v_trg int; v_fn regprocedure; v_def boolean;
  v_falhas text[] := '{}';
begin
  select relrowsecurity, relforcerowsecurity into v_rls, v_force
    from pg_class where oid = 'public.whatsapp_ad_touchpoints'::regclass;
  select count(*) into v_pol from pg_policy where polrelid = 'public.whatsapp_ad_touchpoints'::regclass;
  if not (v_rls and v_force) then v_falhas := v_falhas || 'rls nao forcada'; end if;
  if v_pol <> 0 then v_falhas := v_falhas || ('policies=' || v_pol); end if;

  select count(*) into v_trg from pg_trigger
   where not tgisinternal
     and tgname in ('whatsapp_ad_touchpoints_guard_trg', 'customers_purge_ad_touchpoints_trg');
  if v_trg <> 2 then v_falhas := v_falhas || ('triggers=' || v_trg); end if;

  foreach v_fn in array array[
    'public.whatsapp_ad_touchpoints_guard()'::regprocedure,
    'public.purge_ad_touchpoints_on_customer_anonymize()'::regprocedure
  ] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE') then v_falhas := v_falhas || (v_fn::text || ' anon'); end if;
    if has_function_privilege('authenticated', v_fn, 'EXECUTE') then v_falhas := v_falhas || (v_fn::text || ' authenticated'); end if;
    if exists (
      select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.oid = v_fn and a.grantee = 0 and a.privilege_type = 'EXECUTE'
    ) then v_falhas := v_falhas || (v_fn::text || ' PUBLIC'); end if;
    if not exists (select 1 from pg_proc where oid = v_fn and 'search_path=""' = any(proconfig)) then
      v_falhas := v_falhas || (v_fn::text || ' sem search_path vazio');
    end if;
  end loop;

  select prosecdef into v_def from pg_proc where oid = 'public.whatsapp_ad_touchpoints_guard()'::regprocedure;
  if v_def then v_falhas := v_falhas || 'guard deveria ser INVOKER'; end if;
  select prosecdef into v_def from pg_proc where oid = 'public.purge_ad_touchpoints_on_customer_anonymize()'::regprocedure;
  if not v_def then v_falhas := v_falhas || 'purga deveria ser DEFINER'; end if;

  -- Se o formato gravado em `proconfig` para `set search_path = ''` não for
  -- `search_path=""` nesta versão, MEÇA (`select proconfig from pg_proc where
  -- proname = 'whatsapp_ad_touchpoints_guard'`) e ajuste a comparação acima,
  -- registrando aqui o que foi medido. Nunca afrouxe para "tem search_path".
  perform pg_temp.tp_res(95, 'TP-10', case when cardinality(v_falhas) = 0 then 'OK'
    else 'FALHOU: ' || array_to_string(v_falhas, '; ') end);
exception when others then
  perform pg_temp.tp_res(95, 'TP-10', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-11 (96): idempotência ATRAVÉS DE EXECUÇÕES ──────────────────────────
-- A 1a execução deste arquivo grava a assinatura do catálogo; o README manda
-- reaplicar a 115 duas vezes e rodar este arquivo de novo, e a 2a compara. As
-- duas leituras num único `do $$` veriam o mesmo estado e não mediriam nada.
do $$
declare v_assinatura text; v_gravada text; v_linhas bigint;
begin
  select string_agg(x, E'\n' order by x) into v_assinatura from (
    select 'col:' || attname || ':' || format_type(atttypid, atttypmod) || ':' || attnotnull
      from pg_attribute where attrelid = 'public.whatsapp_ad_touchpoints'::regclass and attnum > 0 and not attisdropped
    union all
    select 'con:' || conname || ':' || pg_get_constraintdef(oid)
      from pg_constraint where conrelid = 'public.whatsapp_ad_touchpoints'::regclass
    union all
    select 'idx:' || indexrelid::regclass::text || ':' || pg_get_indexdef(indexrelid)
      from pg_index where indrelid = 'public.whatsapp_ad_touchpoints'::regclass
    union all
    select 'trg:' || tgname || ':' || pg_get_triggerdef(oid)
      from pg_trigger where not tgisinternal
       and tgrelid in ('public.whatsapp_ad_touchpoints'::regclass, 'public.customers'::regclass)
    union all
    select 'fn:' || p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(p.proacl::text, 'null')
      from pg_proc p where p.proname in ('whatsapp_ad_touchpoints_guard', 'purge_ad_touchpoints_on_customer_anonymize')
    union all
    select 'rls:' || relrowsecurity || ':' || relforcerowsecurity
      from pg_class where oid = 'public.whatsapp_ad_touchpoints'::regclass
  ) s(x);
  select count(*) into v_linhas from public.whatsapp_ad_touchpoints;
  select v into v_gravada from t_snap115 where k = 'assinatura';

  if v_gravada is null then
    insert into t_snap115 values ('assinatura', v_assinatura);
    perform pg_temp.tp_res(96, 'TP-11', 'PENDENTE: assinatura gravada — reaplique a 115 duas vezes e rode este arquivo de novo');
  elsif v_gravada = v_assinatura and v_linhas = 0 then
    perform pg_temp.tp_res(96, 'TP-11', 'OK');
  else
    perform pg_temp.tp_res(96, 'TP-11', format('FALHOU: catalogo mudou entre execucoes da 115 (%s) ou sobrou linha (%s)',
      case when v_gravada = v_assinatura then 'igual' else 'diferente' end, v_linhas));
  end if;
exception when others then
  perform pg_temp.tp_res(96, 'TP-11', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

select ord, caso, veredito from t_res where ord between 85 and 96 order by ord;
```

- [ ] **Step 3: Escrever `23-controles-115.sql` (controles positivos)**

Cabeçalho: roda **SEM** `ON_ERROR_STOP`; por que a 115 não restaura nada ao ser reaplicada (`create table if not exists`/`create index if not exists`); convenção capturar → sabotar → confirmar que mudou → medir o defeito → `raise ... using errcode = 'ZZ115'` → conferir restore contra o catálogo; veredito `OK` só se as três metades casarem. Sabotagem por **delta mínimo** sobre `pg_get_functiondef`, recortando entre os marcadores.

```sql
-- ─── GUARDA com SENTINELA (ord = -23) ───────────────────────────────────────
-- Este arquivo roda SEM ON_ERROR_STOP: um `raise` aqui imprimiria ERROR e o psql
-- seguiria, e os controles "passariam" sobre zero caso TP. A linha sentinela é o
-- que faz a falha aparecer no topo de `select ... order by ord`.
--
-- Gravar e levantar em DOIS statements, não num só: o `raise` desfaz a
-- transação do próprio `do $$`, e a sentinela gravada nele sumiria junto.
-- Confira o desenho da guarda do `17-controles-111.sql` (sentinela `ord = 0`).
create table if not exists t_res (ord int primary key, caso text, veredito text);

do $$
begin
  delete from t_res where ord = -23;
  if to_regclass('public.whatsapp_ad_touchpoints') is null
     or not exists (select 1 from t_res where ord = 94) then
    insert into t_res values (-23, 'GUARDA-23', 'FALHOU: rode 00 -> 00a -> 22a -> 115 -> 22 antes deste arquivo');
  end if;
end $$;

do $$
begin
  if exists (select 1 from t_res where ord = -23) then
    raise exception '23-controles-115.sql: pre-requisitos ausentes (ver sentinela ord -23)';
  end if;
end $$;

create or replace function pg_temp.tp_res(p_ord int, p_caso text, p_veredito text)
returns void language sql as $$
  insert into t_res values (p_ord, p_caso, p_veredito)
  on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
$$;

create or replace function pg_temp.tp_ins(
  p_msg text,
  p_unit uuid default 'bbbbbbbb-0000-0000-0000-000000000001',
  p_channel uuid default 'dddddddd-0000-0000-0000-000000000001',
  p_customer uuid default 'cccccccc-0000-0000-0000-000000000001'
) returns uuid language sql as $$
  insert into public.whatsapp_ad_touchpoints
    (unit_id, channel_id, customer_id, provider, provider_message_id, message_at, ctwa_clid)
  values (p_unit, p_channel, p_customer, 'datafy', p_msg, now(), 'clid-' || p_msg)
  returning id;
$$;

-- Recorta o trecho entre `-- <marcador>` e `-- </marcador>` do corpo real.
create or replace function pg_temp.sem_trecho(p_def text, p_marcador text)
returns text language sql as $$
  select regexp_replace(p_def, '-- <' || p_marcador || '>.*?-- </' || p_marcador || '>', '')
$$;

-- ─── C-115-1 (97): sem a exceção do set null, apagar o canal ABORTA ─────────
do $$
declare
  v_fn regprocedure := 'public.whatsapp_ad_touchpoints_guard()'::regprocedure;
  v_real text := pg_get_functiondef('public.whatsapp_ad_touchpoints_guard()'::regprocedure);
  v_sabotado text; v_mudou boolean := false; v_abortou boolean := false; v_restaurou boolean;
  v_chan uuid := 'dddddddd-0000-0000-0000-0000000000c1';
begin
  begin
    v_sabotado := pg_temp.sem_trecho(v_real, 'excecao-set-null');
    execute v_sabotado;
    v_mudou := pg_get_functiondef(v_fn) <> v_real;
    insert into whatsapp_channels (id, unit_id, provider, status, display_phone)
    values (v_chan, 'bbbbbbbb-0000-0000-0000-000000000001', 'official', 'disconnected', '5511000000c1');
    perform pg_temp.tp_ins('wamid.C1151', p_channel => v_chan);
    begin
      delete from whatsapp_channels where id = v_chan;
    exception when check_violation then v_abortou := true;
    end;
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  v_restaurou := pg_get_functiondef(v_fn) = v_real;
  perform pg_temp.tp_res(97, 'C-115-1', case when v_mudou and v_abortou and v_restaurou then 'OK'
    else format('FALHOU: mudou=%s abortou=%s restaurou=%s (sem a excecao, o DELETE do canal TEM de abortar)', v_mudou, v_abortou, v_restaurou) end);
exception when others then
  perform pg_temp.tp_res(97, 'C-115-1', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C-115-2 (98): sem as pernas de coerência, TP-5 e TP-6 passam ───────────
do $$
declare
  v_fn regprocedure := 'public.whatsapp_ad_touchpoints_guard()'::regprocedure;
  v_real text := pg_get_functiondef('public.whatsapp_ad_touchpoints_guard()'::regprocedure);
  v_mudou boolean := false; v_canal_passou boolean := false; v_org_passou boolean := false; v_restaurou boolean;
begin
  begin
    execute pg_temp.sem_trecho(v_real, 'coerencia-tenant');
    v_mudou := pg_get_functiondef(v_fn) <> v_real;
    perform pg_temp.tp_ins('wamid.C1152a', p_channel => 'dddddddd-0000-0000-0000-000000000002');
    v_canal_passou := true;
    perform pg_temp.tp_ins('wamid.C1152b', p_channel => null, p_customer => 'cccccccc-0000-0000-0000-000000000003');
    v_org_passou := true;
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  v_restaurou := pg_get_functiondef(v_fn) = v_real;
  perform pg_temp.tp_res(98, 'C-115-2', case when v_mudou and v_canal_passou and v_org_passou and v_restaurou then 'OK'
    else format('FALHOU: mudou=%s canal_alheio=%s org_alheia=%s restaurou=%s', v_mudou, v_canal_passou, v_org_passou, v_restaurou) end);
exception when others then
  perform pg_temp.tp_res(98, 'C-115-2', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C-115-3 (99): sem a guarda de UPDATE, o touchpoint é reescrito ─────────
do $$
declare
  v_fn regprocedure := 'public.whatsapp_ad_touchpoints_guard()'::regprocedure;
  v_real text := pg_get_functiondef('public.whatsapp_ad_touchpoints_guard()'::regprocedure);
  v_mudou boolean := false; v_reescrito boolean := false; v_restaurou boolean; v_id uuid; v_clid text;
begin
  begin
    execute pg_temp.sem_trecho(v_real, 'guarda-update');
    v_mudou := pg_get_functiondef(v_fn) <> v_real;
    v_id := pg_temp.tp_ins('wamid.C1153');
    update public.whatsapp_ad_touchpoints set ctwa_clid = 'reescrito' where id = v_id;
    select ctwa_clid into v_clid from public.whatsapp_ad_touchpoints where id = v_id;
    v_reescrito := v_clid = 'reescrito';
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  v_restaurou := pg_get_functiondef(v_fn) = v_real;
  perform pg_temp.tp_res(99, 'C-115-3', case when v_mudou and v_reescrito and v_restaurou then 'OK'
    else format('FALHOU: mudou=%s reescrito=%s restaurou=%s', v_mudou, v_reescrito, v_restaurou) end);
exception when others then
  perform pg_temp.tp_res(99, 'C-115-3', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C-115-4 (100): purga como INVOKER apaga ZERO linhas em silêncio ────────
do $$
declare
  v_fn regprocedure := 'public.purge_ad_touchpoints_on_customer_anonymize()'::regprocedure;
  v_mudou boolean := false; v_sobraram int; v_restaurou boolean;
begin
  begin
    alter function public.purge_ad_touchpoints_on_customer_anonymize() security invoker;
    select not prosecdef into v_mudou from pg_proc where oid = v_fn;
    perform pg_temp.tp_ins('wamid.C1154a');
    perform pg_temp.tp_ins('wamid.C1154b');
    set local role authenticated;
    update public.customers set deleted_at = now() where id = 'cccccccc-0000-0000-0000-000000000001';
    reset role;
    select count(*) into v_sobraram from public.whatsapp_ad_touchpoints where customer_id = 'cccccccc-0000-0000-0000-000000000001';
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  select prosecdef into v_restaurou from pg_proc where oid = v_fn;
  perform pg_temp.tp_res(100, 'C-115-4', case when v_mudou and v_sobraram = 2 and v_restaurou then 'OK'
    else format('FALHOU: mudou=%s sobraram=%s (esperado 2: o defeito e o silencio) restaurou=%s', v_mudou, v_sobraram, v_restaurou) end);
exception when others then
  perform pg_temp.tp_res(100, 'C-115-4', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C-115-5 (101): drop + create sem revoke reabre EXECUTE a anon ──────────
do $$
declare
  v_real text := pg_get_functiondef('public.whatsapp_ad_touchpoints_guard()'::regprocedure);
  v_reabriu boolean := false; v_fechado boolean; v_trg boolean;
begin
  begin
    drop function public.whatsapp_ad_touchpoints_guard() cascade;
    execute v_real;
    v_reabriu := has_function_privilege('anon', 'public.whatsapp_ad_touchpoints_guard()', 'EXECUTE');
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  v_fechado := not has_function_privilege('anon', 'public.whatsapp_ad_touchpoints_guard()', 'EXECUTE');
  select exists (select 1 from pg_trigger where tgname = 'whatsapp_ad_touchpoints_guard_trg' and not tgisinternal) into v_trg;
  perform pg_temp.tp_res(101, 'C-115-5', case when v_reabriu and v_fechado and v_trg then 'OK'
    else format('FALHOU: reabriu=%s fechado_apos_restore=%s trigger_restaurado=%s', v_reabriu, v_fechado, v_trg) end);
exception when others then
  perform pg_temp.tp_res(101, 'C-115-5', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

select ord, caso, veredito from t_res order by ord;
```

Se o `regexp_replace` não casar (o `.*?` não atravessa quebra de linha na sua build), o controle reporta `mudou=f` — **não** afrouxe a asserção: ajuste o padrão (ex.: flags `'s'`/`'n'` do Postgres) até `mudou=t`, e registre no cabeçalho do arquivo o que foi medido.

- [ ] **Step 4: Rodar a sequência inteira, com o RED primeiro**

```bash
export PGCLIENTENCODING=UTF8
PG="$USERPROFILE/scoop/apps/postgresql/current/bin"
"$PG/dropdb.exe"   -h 127.0.0.1 -p 55432 -U postgres --if-exists fased115
"$PG/createdb.exe" -h 127.0.0.1 -p 55432 -U postgres fased115
P() { "$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d fased115 -v ON_ERROR_STOP=1 "$@"; }

P -f supabase/tests/local-preflight/00-bootstrap.sql
P -f supabase/tests/local-preflight/00a-whatsapp-legacy-seed.sql
P -f supabase/tests/local-preflight/22a-ad-touchpoints-bootstrap.sql

P -f supabase/tests/local-preflight/22-ad-touchpoints-115.sql   # esperado: ERROR (guarda: tabela ausente)
P -f supabase/tests/local-preflight/23-controles-115.sql        # esperado: ERROR (guarda)

P -f supabase/migrations/20260927120000_115_whatsapp_ad_touchpoints.sql
P -f supabase/tests/local-preflight/22-ad-touchpoints-115.sql   # TP-11 = PENDENTE
P -f supabase/migrations/20260927120000_115_whatsapp_ad_touchpoints.sql
P -f supabase/migrations/20260927120000_115_whatsapp_ad_touchpoints.sql
P -f supabase/tests/local-preflight/22-ad-touchpoints-115.sql   # TP-11 = OK

"$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d fased115 \
  -f supabase/tests/local-preflight/23-controles-115.sql        # SEM ON_ERROR_STOP

P -c "select ord, caso, veredito from t_res order by ord;"
```

Expected: **17 linhas**, ordinais 85–101, todas `OK`, nenhuma sentinela −23. Conte as linhas — não confie em "nenhum FALHOU": um erro de compilação de plpgsql num arquivo sem `ON_ERROR_STOP` derruba o bloco inteiro sem gravar veredito.

Se algum caso falhar, o defeito pode estar no caso OU na migration: leia a mensagem, corrija o lado errado, e se for a migration, rode de novo `npx vitest run src/lib/whatsapp-ad-touchpoint-migration-twin.test.ts`.

Ao terminar: `"$PG/dropdb.exe" -h 127.0.0.1 -p 55432 -U postgres fased115`. **Não pare o servidor.**

- [ ] **Step 5: README do pré-voo**

5a. Na tabela "Os arquivos", três linhas novas depois da do `21`: `22a-ad-touchpoints-bootstrap.sql` (default privileges que emulam o Supabase + `customers` fiel mínimo com policy de fixture; recusa rodar depois da 115), `22-ad-touchpoints-115.sql` (TP-1..TP-11, ordinais 85–96) e `23-controles-115.sql` (C-115-1..5, ordinais 97–101, sabotagem por delta mínimo entre os marcadores do corpo do guard).

5b. Seção nova `### Sequência da migration 115 (Fase D — touchpoints CTWA)` depois da seção da 113, com: banco PRÓPRIO `fased115` e por quê (`t_res` com `ord` PK, e o `22a` tem de rodar antes da 115); o bloco de comandos do Step 4; a tabela `ord | caso | arquivo` (−23 sentinela; 85–96 `TP-1`..`TP-11` com `TP-6b` em 91; 97–101 `C-115-1`..`C-115-5`); o parágrafo "Conte as 17 linhas"; a nota de que o servidor pode já estar no ar e não deve ser parado; e o parágrafo "O que o pré-voo NÃO prova aqui": exposição PostgREST da tabela e o `rolbypassrls` do `postgres` de produção (medido lá em 2026-09-27, spec §1.2 — localmente o `postgres` é superusuário).

- [ ] **Step 6: Commit**

```bash
git add supabase/tests/local-preflight/22a-ad-touchpoints-bootstrap.sql supabase/tests/local-preflight/22-ad-touchpoints-115.sql supabase/tests/local-preflight/23-controles-115.sql supabase/tests/local-preflight/README.md
git commit -m "test(db): pre-voo da 115, onze casos e cinco controles positivos

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Se algum caso exigiu mudança na migration, ela entra no mesmo commit (`git add` do arquivo da 115) e a mensagem diz o que o pré-voo pegou.

---

### Task 5: Captura no `webhook-whatsapp`

**Files:**
- Modify: `supabase/functions/webhook-whatsapp/index.ts` (imports ~64–80 e depois de ~87; função nova depois de `persistInboundOnly` ~750; chamada no caminho de mídia depois de ~2860; chamada no caminho de texto depois de ~3038)
- Create: `src/lib/whatsapp-ad-touchpoint-coupling.test.ts`

**Interfaces:**
- Consumes: `parseAdReferral`, `hasAdReferralCapture` (Task 1, `whatsapp-providers.ts`); `buildAdTouchpointRow`, `classifyTouchpointInsert`, `describeCapturedReferral`, `describeReferralProbe` (Task 2); `resolveOrCreateCustomer` (existente); tabela da Task 3.
- Produces: `async function captureAdTouchpoint(args)` no módulo do webhook; eventos de log `meta_inbound_referral_probe`, `ad_referral_captured`, `ad_referral_rejected`; erro `ad_touchpoint_persist_failed`.

- [ ] **Step 1: Escrever o teste de acoplamento (falha)**

Criar `src/lib/whatsapp-ad-touchpoint-coupling.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// O vitest não importa o webhook (`serve()` no carregamento + `deno.land`): a
// cobertura do ADAPTER é estrutural. A decisão está no núcleo, testado à parte.
const WEBHOOK = readFileSync(resolve(__dirname, "../../supabase/functions/webhook-whatsapp/index.ts"), "utf8");
const FUNCTIONS = resolve(__dirname, "../../supabase/functions");

function definicao(): string {
  const inicio = WEBHOOK.indexOf("async function captureAdTouchpoint(");
  if (inicio < 0) throw new Error("captureAdTouchpoint não definida");
  const fim = WEBHOOK.indexOf("\n}\n", inicio);
  return WEBHOOK.slice(inicio, fim + 2);
}

function chamadas(): { idx: number; texto: string }[] {
  const out: { idx: number; texto: string }[] = [];
  let i = WEBHOOK.indexOf("await captureAdTouchpoint(");
  while (i >= 0) {
    out.push({ idx: i, texto: WEBHOOK.slice(i, WEBHOOK.indexOf("});", i) + 3) });
    i = WEBHOOK.indexOf("await captureAdTouchpoint(", i + 1);
  }
  return out;
}

function arquivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const p = join(dir, nome);
    return statSync(p).isDirectory() ? arquivosTs(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Operações de escrita diferentes de INSERT na tabela de touchpoints. */
function escritasProibidas(fonte: string): string[] {
  const achados: string[] = [];
  const re = /from\(\s*["']whatsapp_ad_touchpoints["']\s*\)\s*\.(\w+)\(/g;
  for (const m of fonte.matchAll(re)) if (m[1] !== "insert") achados.push(m[1]);
  return achados;
}

describe("webhook-whatsapp captura o referral nos DOIS caminhos, no ponto certo", () => {
  it("há exatamente duas chamadas", () => {
    expect(chamadas()).toHaveLength(2);
  });

  it("mídia: depois do claim e antes de qualquer resolução, gate ou envio", () => {
    const [midia] = chamadas();
    const claim = WEBHOOK.indexOf("p_message_id: media.providerMessageId");
    expect(claim).toBeGreaterThan(0);
    expect(midia.idx).toBeGreaterThan(claim);
    expect(midia.idx).toBeLessThan(WEBHOOK.indexOf('"media_unit_lookup_failed"'));
    expect(midia.idx).toBeLessThan(WEBHOOK.indexOf("toPhone: mediaPhone, text: MEDIA_REPLY_TEXT"));
    expect(midia.texto).toContain("inboundProviderMessageId: media.providerMessageId");
  });

  it("texto: depois do claim e ANTES de rate limit, billing e suspensão", () => {
    const [, texto] = chamadas();
    const claim = WEBHOOK.indexOf("p_message_id: inbound.providerMessageId");
    expect(claim).toBeGreaterThan(0);
    expect(texto.idx).toBeGreaterThan(claim);
    expect(texto.idx).toBeLessThan(WEBHOOK.indexOf('"check_rate_limit"'));
    expect(texto.idx).toBeLessThan(WEBHOOK.indexOf('"webhook_org_billing_blocked"'));
    expect(texto.idx).toBeLessThan(WEBHOOK.indexOf('"webhook_whatsapp_service_suspended"'));
    expect(texto.texto).toContain("inboundProviderMessageId: inbound.providerMessageId");
  });

  it("escopo vem do canal da querystring, nunca do payload", () => {
    for (const c of chamadas()) {
      expect(c.texto).toContain("unitId: channel.unit_id");
      expect(c.texto).toContain("channelId: channel.id");
    }
  });

  it("a definição só faz I/O: decide pelo núcleo e não redigita o 23505", () => {
    const def = definicao();
    for (const chamada of [
      "hasAdReferralCapture(",
      "parseAdReferral(",
      "describeReferralProbe(",
      "buildAdTouchpointRow(",
      "classifyTouchpointInsert(",
      "describeCapturedReferral(",
    ]) expect(def).toContain(chamada);
    expect(def).not.toContain("23505");
    expect(def).not.toContain("shapeOf(");
  });

  it("provider sem a capability sai antes de qualquer I/O e de qualquer log", () => {
    const def = definicao();
    const saida = def.indexOf("if (!hasAdReferralCapture(");
    expect(saida).toBeGreaterThan(0);
    expect(saida).toBeLessThan(def.indexOf("jsonLog("));
    expect(saida).toBeLessThan(def.indexOf("supabase"));
  });

  // Review Focus 5: só a falha lança; duplicata e recusa seguem.
  it("lança ad_touchpoint_persist_failed só quando o INSERT falhou", () => {
    const def = definicao();
    expect(def).toContain('if (outcome === "failed") throw new Error("ad_touchpoint_persist_failed")');
    expect(def).toMatch(/if \(built\.ok === false\) \{[\s\S]*?return;\s*\}/);
  });

  it("nenhum código de Edge Function faz UPDATE, UPSERT ou DELETE na tabela", () => {
    const achados = arquivosTs(FUNCTIONS).flatMap((f) =>
      escritasProibidas(readFileSync(f, "utf8")).map((op) => `${f}: ${op}`)
    );
    expect(achados).toEqual([]);
  });

  it("CONTROLE POSITIVO: o detector acha update e upsert", () => {
    expect(escritasProibidas(`supabase.from("whatsapp_ad_touchpoints").update({ x: 1 })`)).toEqual(["update"]);
    expect(escritasProibidas(`supabase.from('whatsapp_ad_touchpoints').upsert(row)`)).toEqual(["upsert"]);
    expect(escritasProibidas(`supabase.from("whatsapp_ad_touchpoints").insert(row)`)).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/whatsapp-ad-touchpoint-coupling.test.ts`
Expected: FAIL — `captureAdTouchpoint` não definida (e o controle positivo do detector já passa).

- [ ] **Step 3: Imports**

No import de `../_shared/whatsapp-providers.ts` (~linha 64), acrescentar `hasAdReferralCapture,` e `parseAdReferral,`. Depois da linha `import { shapeOf } from "../_shared/webhook-payload-shape-core.ts";` (~87), acrescentar:

```ts
// ─── Referral CTWA (Fase D) ──────────────────────────────────────────────────
// Adapter de I/O; a decisão é do núcleo. Nada aqui reimplementa limite, dedupe
// ou forma de log.
import {
  buildAdTouchpointRow,
  classifyTouchpointInsert,
  describeCapturedReferral,
  describeReferralProbe,
} from "../_shared/whatsapp-ad-touchpoint-core.ts";
```

- [ ] **Step 4: A função, depois de `persistInboundOnly`**

Logo depois do fechamento de `persistInboundOnly` (~linha 750):

```ts
/**
 * Fase D — captura do `referral` de anúncio Click-to-WhatsApp.
 *
 * Adapter de I/O: toda decisão está em `_shared/whatsapp-ad-touchpoint-core.ts`.
 * Chamado nos DOIS caminhos de inbound (texto e mídia), sempre DEPOIS do claim de
 * `processed_messages` (reentrega barrada não chega aqui; o UNIQUE é a segunda
 * barreira) e ANTES de rate limit, billing, suspensão e de qualquer efeito
 * externo — "esta pessoa chegou por este anúncio" não depende de a loja estar
 * adimplente, e é o "antes de efeito externo" que torna a falha reentregável.
 *
 * - Provider sem `adReferral` (Z-API, WAHA, UazAPI): sai antes de qualquer I/O e
 *   de qualquer log — comportamento de hoje, byte a byte.
 * - Falha de banco LANÇA `ad_touchpoint_persist_failed`: o `catch` externo libera
 *   o claim e o provider reentrega (D8 da spec). `23505` é dedupe silencioso.
 * - Recusa do núcleo NÃO lança: bug nosso de split não pode calar o cliente.
 *
 * `unitId`/`channelId` vêm do canal lido pela querystring — nunca do payload: o
 * referral é dado do cliente, não identidade de tenant.
 */
async function captureAdTouchpoint(args: {
  requestId: string;
  provider: WhatsAppProvider;
  payload: unknown;
  unitId: string;
  channelId: string;
  inboundProviderMessageId: string;
  phone: string;
  contactName: string | null;
  messageAtMs: number;
}): Promise<void> {
  if (!hasAdReferralCapture(args.provider)) return;

  jsonLog("info", {
    requestId: args.requestId,
    evt: "meta_inbound_referral_probe",
    provider: args.provider,
    ...describeReferralProbe(args.payload),
  });

  const referral = parseAdReferral(args.provider, args.payload);
  if (!referral) return;

  const { data: unitRow, error: unitError } = await supabase
    .from("units")
    .select("organization_id")
    .eq("id", args.unitId)
    .maybeSingle();
  if (unitError || !unitRow?.organization_id) throw new Error("ad_touchpoint_persist_failed");

  let customerId: string;
  try {
    // Idempotente. No caminho de texto o cliente ainda não foi resolvido neste
    // ponto; no de mídia será resolvido de novo logo adiante — uma consulta a
    // mais, só quando há referral.
    const customer = await resolveOrCreateCustomer(supabase, {
      organizationId: String(unitRow.organization_id),
      phone: args.phone,
      name: args.contactName ?? args.phone,
    });
    customerId = customer.id;
  } catch {
    throw new Error("ad_touchpoint_persist_failed");
  }

  const built = buildAdTouchpointRow({
    provider: args.provider,
    unitId: args.unitId,
    channelId: args.channelId,
    customerId,
    inboundProviderMessageId: args.inboundProviderMessageId,
    messageAtMs: args.messageAtMs,
    referral,
  });
  if (built.ok === false) {
    jsonLog("warn", {
      requestId: args.requestId,
      evt: "ad_referral_rejected",
      ...describeCapturedReferral({ provider: args.provider, outcome: "rejected", referral, rejectReason: built.reason }),
    });
    return;
  }

  const { error: insertError } = await supabase.from("whatsapp_ad_touchpoints").insert(built.row);
  const outcome = classifyTouchpointInsert(insertError);
  jsonLog(outcome === "failed" ? "error" : "info", {
    requestId: args.requestId,
    evt: "ad_referral_captured",
    ...describeCapturedReferral({ provider: args.provider, outcome, referral, rawOmittedReason: built.rawOmittedReason }),
    // Só o SQLSTATE: a mensagem do Postgres pode repetir valores da linha.
    ...(outcome === "failed" ? { code: insertError?.code ?? null } : {}),
  });
  if (outcome === "failed") throw new Error("ad_touchpoint_persist_failed");
}
```

- [ ] **Step 5: Chamada no caminho de mídia**

Logo depois de `messageProcessingClaimId = String(mediaClaim.claim_id);` (~linha 2860) e ANTES de `// Resolve org → customer → conversation`:

```ts
      // Fase D: depois do claim e antes de qualquer efeito externo (falha aqui é
      // reentregável). Zero I/O para provider sem `adReferral`.
      await captureAdTouchpoint({
        requestId,
        provider,
        payload,
        unitId: channel.unit_id,
        channelId: channel.id,
        inboundProviderMessageId: media.providerMessageId,
        phone: mediaPhone,
        contactName: media.contactName ?? null,
        messageAtMs: media.timestamp,
      });
```

- [ ] **Step 6: Chamada no caminho de texto**

Logo depois do bloco `if (processingClaim.previous_outcome !== null) { ... }` (termina ~linha 3038) e ANTES de `// Rate limit por telefone`:

```ts
    // Fase D: depois do claim e ANTES de rate limit, billing e suspensão — os três
    // desviam antes de o cliente ser resolvido, e "esta pessoa chegou por este
    // anúncio" não depende de a loja estar adimplente (mesmo raciocínio do
    // persistInboundOnly). Antes de qualquer efeito externo: falha é reentregável.
    await captureAdTouchpoint({
      requestId,
      provider,
      payload,
      unitId: channel.unit_id,
      channelId: channel.id,
      inboundProviderMessageId: inbound.providerMessageId,
      phone,
      contactName: inbound.contactName ?? null,
      messageAtMs: inbound.timestamp,
    });
```

Confira que `payload` nesse escopo é o payload da PARTE (depois do split do lote) — é o mesmo que `parseInbound(provider, payload)` recebe na linha ~2813. Se não for, pare e reporte.

- [ ] **Step 7: Rodar e ver passar; gates**

Run: `npx vitest run src/lib/whatsapp-ad-touchpoint-coupling.test.ts src/lib/datafy-adapter-coupling-guard.test.ts`
Expected: PASS (o segundo confere que nenhuma comparação crua `provider === "official"` entrou no webhook).
Run: `npm run lint` → 0 erros (o `no-undef` das Edge Functions pega identificador fora de escopo, que o `tsc -b` não alcança). `npm run typecheck` → 0 erros.

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/webhook-whatsapp/index.ts src/lib/whatsapp-ad-touchpoint-coupling.test.ts
git commit -m "feat(whatsapp): webhook captura o referral CTWA nos dois caminhos, depois do claim e antes dos desvios

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `CLAUDE.md` + `AGENTS.md` (par obrigatório, mesmo commit)

**Files:**
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`

**Antes de escrever:** leia a seção "🧭 O que pertence neste arquivo" do `CLAUDE.md` e "Manutenção deste par" do `AGENTS.md`. Formato: `**regra em 1 frase.** Por quê (1 frase). Ponteiro arquivo.` Sem storytelling, sem data de bug. O `CLAUDE.md` já está muito acima do alvo de 40K: seja curto.

- [ ] **Step 1: `CLAUDE.md`**

1a. Em "### Invariantes de tabelas", na lista de "**Tabelas com credenciais usam `FORCE RLS` sem policies**", acrescentar `whatsapp_ad_touchpoints` ao fim da lista.

1b. Nova subseção `### Touchpoint de anúncio CTWA (Fase D)` logo depois da subseção "### Ingestão assíncrona do webhook" (antes de "### Provedores"), com estes bullets:

```md
- **Touchpoint CTWA nunca é reescrito: o guard de `whatsapp_ad_touchpoints` recusa todo `UPDATE`, exceto a coerção do `on delete set null` de `channel_id`.** O histórico é o dado de atribuição, e sem a exceção apagar o canal abortaria o `DELETE` (o conflito FK × CHECK da 089). Os marcadores `-- <...>` no corpo do guard são usados pelos controles do pré-voo — não remover. [migration 115](supabase/migrations/20260927120000_115_whatsapp_ad_touchpoints.sql).
- **O touchpoint é da UNIDADE (`unit_id` + `channel_id` do canal da querystring) e aponta ao cliente da organização (`customer_id`); não existe `organization_id`, e o guard amarra a coerência das três FKs.** O `ctwa_clid` só vale para o WABA que recebeu o clique; atribuir entre unidades é decisão da Fase I, não padrão.
- **A captura roda DEPOIS do claim de `processed_messages` e ANTES de rate limit, billing, suspensão e de qualquer efeito externo, nos DOIS caminhos (texto e mídia).** Antes do claim a reentrega duplicaria; depois dos desvios o touchpoint morreria neles; depois de efeito externo a falha deixaria de ser reentregável. `captureAdTouchpoint` em [webhook-whatsapp/index.ts](supabase/functions/webhook-whatsapp/index.ts).
- **Falha ao gravar o touchpoint é reentregável (lança antes de efeito externo), então todo valor que o Postgres recusaria é neutralizado no NÚCLEO, nunca deixado para o banco: NUL, surrogate órfão, número exponencial, aninhamento > 32, tamanho e provider fora do CHECK.** Recusa persistente do banco viraria reentrega eterna com o cliente sem resposta. [whatsapp-ad-touchpoint-core.ts](supabase/functions/_shared/whatsapp-ad-touchpoint-core.ts).
- **Anonimizar o cliente apaga os touchpoints dele por trigger `SECURITY DEFINER` em `customers.deleted_at`.** Com a tabela `FORCE RLS` sem policy, a versão `SECURITY INVOKER` apagaria ZERO linhas em silêncio quando o soft delete vem de `authenticated`, e o `ctwa_clid` sobreviveria (controle C-115-4 do pré-voo).
- **Capability ⇔ método nas DUAS direções (`CAPABILITY_REQUIRED_METHOD`): capability `true` exige o método, e método presente exige capability `true`.** `adReferral` declarada sem `parseAdReferral` foi uma capability afirmando captura que ninguém fazia; a segunda direção impede adapter legado de ganhar a leitura sem declarar. [whatsapp-capability-guard.test.ts](src/lib/whatsapp-capability-guard.test.ts).
- **Sem purga por tempo do `ctwa_clid` nesta fase: a Fase I não começa sem definir a retenção a partir da janela de atribuição da Meta, medida.** Linha acumula sem prazo se um anúncio rodar antes dela — troca consciente da decisão nº 4 ("preservar o dado desde já").
```

1c. No checklist "Checklist de redeploy quando `_shared/X.ts` muda", depois da linha do `whatsapp-inbound-queue-core.ts`, acrescentar:

```md
- **`whatsapp-ad-touchpoint-core.ts`** (núcleo puro, testado em [src/lib/whatsapp-ad-touchpoint-core.test.ts](src/lib/whatsapp-ad-touchpoint-core.test.ts)) → `webhook-whatsapp` (único consumidor). Os limites de campo e o conjunto `AD_TOUCHPOINT_PROVIDERS` (derivado de `PROVIDER_CAPABILITIES[*].adReferral`) são gêmeos declarados dos CHECKs da [migration 115](supabase/migrations/20260927120000_115_whatsapp_ad_touchpoints.sql) — SQL não importa TypeScript, e [o teste gêmeo](src/lib/whatsapp-ad-touchpoint-migration-twin.test.ts) reprova divergência. Provider novo que declare `adReferral` exige migration que o libere no CHECK **antes** do deploy: sem isso o INSERT falha e todo inbound com referral dele vira reentrega eterna.
```

- [ ] **Step 2: `AGENTS.md` (espelho condensado)**

Em "## WhatsApp, IA e conversas", um bullet novo:

```md
- Touchpoint CTWA (Fase D, migration 115): `whatsapp_ad_touchpoints` é imutável por trigger (única exceção: o `set null` de `channel_id`), pertence à unidade (`unit_id` + `channel_id` do canal) e aponta ao `customer_id`, sem `organization_id`. A captura (`captureAdTouchpoint`) roda nos dois caminhos, depois do claim e antes de rate limit/billing/suspensão/efeito externo; falha lança e é reentregável, por isso o núcleo `_shared/whatsapp-ad-touchpoint-core.ts` neutraliza tudo que o banco recusaria. Anonimização apaga por trigger `SECURITY DEFINER` (INVOKER apagaria zero linhas em silêncio). Capability ⇔ método vale nas duas direções (`CAPABILITY_REQUIRED_METHOD`). Sem purga por tempo até a Fase I definir a retenção.
```

Em "## Deploy e acoplamentos", um bullet novo:

```md
- `_shared/whatsapp-ad-touchpoint-core.ts` → `webhook-whatsapp` (único consumidor). Limites e `AD_TOUCHPOINT_PROVIDERS` são gêmeos declarados dos CHECKs da migration 115 (teste gêmeo em `src/lib/whatsapp-ad-touchpoint-migration-twin.test.ts`); provider novo com `adReferral` exige migration liberando o CHECK antes do deploy.
```

- [ ] **Step 3: Conferir o par e commitar**

Run: `git diff -- CLAUDE.md AGENTS.md` — confira que os dois dizem a mesma coisa (AGENTS condensado).
Run: `npx vitest run` (suíte inteira) → PASS. `npm run typecheck` e `npm run lint` → 0 erros.

```bash
git add CLAUDE.md AGENTS.md
git commit -m "docs: invariantes do touchpoint CTWA no par CLAUDE.md/AGENTS.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Depois das tasks (orquestrador, não implementer)

1. Review whole-branch (`superpowers:requesting-code-review`).
2. Gates `saas-shield-br:*`: `migration-validator` (115), `rls-auditor` (tabela + duas funções), `tenant-isolation-auditor` (guard, escopo pelo canal, D1), `integration-reliability-auditor` (dedupe, falha reentregável, parser).
3. `npm run test`, `npm run typecheck`, `npm run lint`, pré-voo (20/20) + `24-concorrencia-115.sh`, conferência estática do `acl-estatico` (`npx vitest run scripts/function-acl-allowlist.test.ts`).
4. Merge em `main` local; **sem push** (decisão do dono).
5. Relatório de fechamento A–D.
