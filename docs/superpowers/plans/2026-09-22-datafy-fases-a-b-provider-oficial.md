# Datafy — Fases A+B: contrato estendido e provider oficial

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar `datafy` como quinto provider de WhatsApp — proxy oficial da Meta Cloud API — reusando os parsers Meta já existentes, com assinatura própria, descoberta automática de IDs e capability flags honestas.

**Architecture:** A Datafy entrega webhooks no formato Meta idêntico, então o adapter reusa `parseOfficialInbound`/`parseOfficialStatus`/`parseOfficialOwnMessageEchoes`/`peekOfficialMedia` sem copiá-los. O que difere é o envelope de transporte: base URL própria, `Authorization: Bearer sk_live_…`, e assinatura `x-datafy-signature-256` = HMAC-SHA256 sobre `{timestamp}.{body}` com anti-replay. Os pontos do `webhook-whatsapp` que hoje perguntam `provider === "official"` passam a perguntar a um conjunto `META_SHAPED_PROVIDERS`, protegido por teste de acoplamento.

**Tech Stack:** Deno (Edge Functions), TypeScript, Supabase/Postgres, vitest, `crypto.subtle`.

**Spec:** [`docs/superpowers/specs/2026-09-22-datafy-whatsapp-oficial-meta-ads-auditoria.md`](../specs/2026-09-22-datafy-whatsapp-oficial-meta-ads-auditoria.md)

## Global Constraints

- **Worktree:** `.claude/worktrees/datafy-oficial`, branch `feat/datafy-whatsapp-oficial`. Nenhum comando roda na raiz do repo.
- **Nenhum canal existente muda.** Z-API, WAHA, UazAPI e `official` mantêm comportamento byte-a-byte. Nenhuma unidade é migrada.
- **`npm run typecheck` é `tsc -b --noEmit`.** Nunca `tsc --noEmit` sem `-b` (no-op silencioso). Baseline: zero erros.
- **`tsconfig.app.json` tem `strict: false`** — `if (!x.ok) { x.campo }` NÃO estreita união discriminada. Use `x.ok === false` ou early-return (`if (!x.ok) return;`). Vale para todo núcleo puro que devolva resultado tipado.
- **Migrations:** formato `YYYYMMDDHHMMSS_NNN_nome.sql`, idempotentes, timestamp **maior que `20260922150000`**, numeração a partir de **`_110_`**. Aplicar só via `supabase db push`, nunca SQL Editor.
- **Migration nunca embute segredo nem a URL do projeto Supabase.** Header de auth se monta por concatenação a partir do Vault.
- **Função nova em `public` nasce executável por `anon`** — toda migration que criar função revoga explicitamente: `revoke all on function <assinatura completa> from public, anon, authenticated;` antes de conceder ao papel mínimo.
- **Toda saída de LLM passa por `sanitizeForWhatsApp`** — não se aplica a texto hardcoded nem a template do lojista.
- **Capability só é `true` depois de implementada e testada.** O repo já tem o invariante: provider novo não pode ser anunciado como paritário sem cumprir o contrato. Capability é o que provamos, não o que o fornecedor promete.
- **Segredo nunca em log.** Erro de transporte passa por `redactProviderFetchError`.
- **Deno roda em UTC.** Qualquer timestamp comparado com dado BRT leva offset `-03:00` explícito.
- **Testes:** `npm run test` (vitest). Núcleo puro em `supabase/functions/_shared/`, teste em `src/lib/*.test.ts` importando por caminho relativo `../../supabase/functions/_shared/X.ts`.
- **Teste que precise dos adapters reais carrega `whatsapp-providers.ts` por `import.meta.glob(..., { eager: true })`, nunca por `import` direto.** Medido na Task 1: o import direto passa no vitest mas puxa o arquivo para o grafo do `tsc -b` do frontend e quebra o typecheck com 6 erros — o global `Deno` não existe ali, e o arquivo ainda carrega um `TS2339` latente (`request.missingCreds` em `whatsapp-providers.ts:333`, a armadilha de `strict: false` já documentada no `CLAUDE.md`). Módulo `_shared` que importe `Deno.env`, `deno.land` ou `esm.sh` cai na mesma regra. Núcleo puro sem Deno continua com `import` normal.

## Ordem de execução

**1 → 2 → 3 → 5 → 4 → 6.** A Task 5 roda **antes** da Task 4.

Motivo: registrar `"datafy"` em `WHATSAPP_PROVIDER_NAMES` sem o adapter deixa o registry anunciando um provider que `getWhatsAppProvider` não resolve, e o guard da Task 1 estoura com `unknown_whatsapp_provider:datafy`. A ordem original mascarava isso pedindo ao implementador que afrouxasse o guard — trocar um teste por causa da ordem das tarefas é o defeito, não a solução. Com a Task 5 antes, nome e adapter nascem no mesmo commit e nenhum teste precisa ceder.

A Task 4 (migration) continua antes da Task 6, que é a primeira a inserir canal `datafy` no banco.

## Review Focus

Cinco classes de entrada que a spec implica, que nenhuma tarefa exercita por padrão, e que mordem um usuário real. Cada linha ganhou um teste na tarefa que é dona do código.

1. **Canal `datafy` com `webhook_secret` nulo ou vazio** — tem que falhar fechado (401), nunca aceitar tudo. É o modo de falha de um canal recém-criado antes de o admin colar o `whsec_`. → Task 2.
2. **`x-datafy-timestamp` no futuro (clock skew do servidor)** — a janela anti-replay precisa ser bilateral; olhar só o passado aceita timestamp forjado com data futura indefinidamente. → Task 2.
3. **Assinatura válida, mas `phone_number_id` de outro número do mesmo cliente Datafy** — o HMAC prova o remetente, não o destinatário; sem a guarda de identidade o evento atravessa tenants. → Task 5.
4. **Lote Meta com um `changes[].field` desconhecido junto de um `messages`** (ex.: `message_template_status_update`, que só é tratado na Fase F) — o evento desconhecido não pode derrubar o lote inteiro nem fazer o `messages` ser perdido. → Task 5.
5. **Resposta da Datafy com HTTP 200 mas corpo sem `messages[0].id`** — `providerMessageId` vira `undefined` e o rastreio de entrega quebra em silêncio, exatamente como já aconteceu neste repo com recibos. → Task 3.

---

### Task 1: Capabilities e contrato estendido

Fase A. Amplia `WhatsAppProviderCapabilities` com as dimensões que a Cloud API traz e que nenhum provider atual tem, mais o escape hatch de baixo nível exigido pela spec. Tudo aditivo: os 4 adapters existentes ganham `false` e não mudam de comportamento.

**Files:**
- Modify: `supabase/functions/_shared/whatsapp-provider-core.ts` (interface `WhatsAppProviderCapabilities` ~l. 7-21; `PROVIDER_CAPABILITIES` ~l. 260-305; interface `WhatsAppProviderAdapter` ~l. 193-212)
- Test: `src/test/whatsapp-provider-core.test.ts`
- Create: `src/lib/whatsapp-capability-guard.test.ts`

**Interfaces:**
- Consumes: nada (primeira tarefa).
- Produces:
  - `WhatsAppProviderCapabilities` com 6 campos novos: `templateMessages: boolean`, `mediaMessages: boolean`, `inboundMediaDownload: boolean`, `interactiveMessages: boolean`, `adReferral: boolean`, `rawCloudApiProxy: boolean`.
  - `CloudApiRequest = { method: "GET" | "POST" | "DELETE"; path: string; body?: unknown }`
  - `CloudApiResponse = { status: number; body: unknown }`
  - `WhatsAppProviderAdapter.cloudApiRequest?(credentials: ChannelCredentials, request: CloudApiRequest): Promise<CloudApiResponse>`
  - `CAPABILITY_REQUIRED_METHOD: Readonly<Record<string, keyof WhatsAppProviderAdapter>>`

- [ ] **Step 1: Escrever o teste de acoplamento que falha**

Cria `src/lib/whatsapp-capability-guard.test.ts`. Este é o controle que impede alguém de marcar uma capability como `true` sem implementar o método — o invariante do repo de que capability é o que se provou.

```ts
import { describe, it, expect } from "vitest";
import {
  CAPABILITY_REQUIRED_METHOD,
  PROVIDER_CAPABILITIES,
  WHATSAPP_PROVIDER_NAMES,
  type WhatsAppProviderCapabilities,
} from "../../supabase/functions/_shared/whatsapp-provider-core.ts";
import { getWhatsAppProvider } from "../../supabase/functions/_shared/whatsapp-providers.ts";

describe("capability declarada exige método no adapter", () => {
  it("todo provider que declara uma capability gateada implementa o método", () => {
    const faltando: string[] = [];
    for (const name of WHATSAPP_PROVIDER_NAMES) {
      const adapter = getWhatsAppProvider(name);
      const caps = PROVIDER_CAPABILITIES[name] as unknown as Record<string, unknown>;
      for (const [capability, method] of Object.entries(CAPABILITY_REQUIRED_METHOD)) {
        if (caps[capability] === true && typeof (adapter as never)[method] !== "function") {
          faltando.push(`${name}.${capability} → ${String(method)}`);
        }
      }
    }
    expect(faltando).toEqual([]);
  });

  // CONTROLE POSITIVO: prova que o teste acima detecta o defeito.
  it("detecta capability true sem método correspondente", () => {
    const caps = { rawCloudApiProxy: true } as unknown as Record<string, unknown>;
    const adapterSemMetodo = { name: "fake" } as Record<string, unknown>;
    const method = CAPABILITY_REQUIRED_METHOD.rawCloudApiProxy;
    const detectou = caps.rawCloudApiProxy === true
      && typeof adapterSemMetodo[method as string] !== "function";
    expect(detectou).toBe(true);
  });

  it("nenhum provider atual declara as capabilities novas", () => {
    for (const name of ["zapi", "waha", "official", "uazapi"] as const) {
      const caps: WhatsAppProviderCapabilities = PROVIDER_CAPABILITIES[name];
      expect(caps.templateMessages).toBe(false);
      expect(caps.mediaMessages).toBe(false);
      expect(caps.inboundMediaDownload).toBe(false);
      expect(caps.interactiveMessages).toBe(false);
      expect(caps.rawCloudApiProxy).toBe(false);
    }
  });

  it("official declara adReferral porque a Meta entrega referral no payload", () => {
    expect(PROVIDER_CAPABILITIES.official.adReferral).toBe(true);
    expect(PROVIDER_CAPABILITIES.zapi.adReferral).toBe(false);
    expect(PROVIDER_CAPABILITIES.waha.adReferral).toBe(false);
    expect(PROVIDER_CAPABILITIES.uazapi.adReferral).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm run test -- src/lib/whatsapp-capability-guard.test.ts`
Expected: FAIL — `CAPABILITY_REQUIRED_METHOD` não é exportado de `whatsapp-provider-core.ts`.

- [ ] **Step 3: Implementar o contrato**

Em `supabase/functions/_shared/whatsapp-provider-core.ts`, na interface `WhatsAppProviderCapabilities`, acrescente os seis campos depois de `deliveryReceipts`:

```ts
  /** Envio de template aprovado pela Meta (obrigatório fora da janela de 24h). */
  templateMessages: boolean;
  /** Envio de imagem, áudio, vídeo, documento ou sticker. */
  mediaMessages: boolean;
  /** Download da mídia RECEBIDA do cliente (id → arquivo). */
  inboundMediaDownload: boolean;
  /** Botões de resposta rápida, listas e demais formatos interativos. */
  interactiveMessages: boolean;
  /** Entrega o objeto `referral` de anúncio Click-to-WhatsApp, com ctwa_clid. */
  adReferral: boolean;
  /** Permite requisição de baixo nível a qualquer endpoint da Cloud API. */
  rawCloudApiProxy: boolean;
```

Logo abaixo de `WhatsAppProviderCapabilities`, acrescente:

```ts
export interface CloudApiRequest {
  method: "GET" | "POST" | "DELETE";
  /** Caminho relativo à base do provider, sem barra inicial. Ex.: `"<waba>/message_templates"`. */
  path: string;
  body?: unknown;
}

export interface CloudApiResponse {
  status: number;
  body: unknown;
}

/**
 * Capability → método que ela promete. É o que o guard de acoplamento usa para
 * recusar uma capability `true` sem implementação: neste repo capability é o que
 * se provou, nunca o que o fornecedor anuncia.
 *
 * Capability sem método correspondente (ex.: `adReferral`, que é forma de payload,
 * não chamada) fica fora deste mapa de propósito.
 */
export const CAPABILITY_REQUIRED_METHOD = {
  rawCloudApiProxy: "cloudApiRequest",
} as const satisfies Readonly<Partial<Record<keyof WhatsAppProviderCapabilities, keyof WhatsAppProviderAdapter>>>;
```

Na interface `WhatsAppProviderAdapter`, depois de `canRequestQr?`:

```ts
  /**
   * Escape hatch de baixo nível para endpoints da Cloud API ainda não modelados.
   * NUNCA exposto diretamente ao frontend — só consumido por Edge Function que
   * já resolveu tenant e credencial.
   */
  cloudApiRequest?(credentials: ChannelCredentials, request: CloudApiRequest): Promise<CloudApiResponse>;
```

Em `PROVIDER_CAPABILITIES`, acrescente as seis chaves a cada um dos quatro providers. `zapi`, `waha` e `uazapi` recebem `false` nas seis. `official` recebe `false` em cinco e `adReferral: true`:

```ts
  official: {
    manualCredentials: true,
    automaticProvisioning: false,
    qrConnection: false,
    pairCode: false,
    automaticWebhook: false,
    disconnect: false,
    restart: false,
    deliveryReceipts: true,
    manualDeviceEcho: "conditional",
    templateMessages: false,
    mediaMessages: false,
    inboundMediaDownload: false,
    interactiveMessages: false,
    // A Meta entrega `referral` no payload; a captura chega na Fase D.
    adReferral: true,
    rawCloudApiProxy: false,
  },
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm run test -- src/lib/whatsapp-capability-guard.test.ts src/test/whatsapp-provider-core.test.ts`
Expected: PASS nos dois arquivos. Se `whatsapp-provider-core.test.ts` falhar, é porque algum teste existente compara `PROVIDER_CAPABILITIES` por igualdade profunda — atualize o objeto esperado, sem mudar valor de campo antigo.

- [ ] **Step 5: Typecheck e commit**

```bash
npm run typecheck
git add supabase/functions/_shared/whatsapp-provider-core.ts src/lib/whatsapp-capability-guard.test.ts src/test/whatsapp-provider-core.test.ts
git commit -m "feat(whatsapp): capabilities de Cloud API e escape hatch no contrato de provider

Seis capabilities novas (template, mídia, download de mídia recebida,
interativos, referral de anúncio, proxy raw) e o método opcional
cloudApiRequest. Aditivo: os quatro providers atuais recebem false e
não mudam de comportamento.

CAPABILITY_REQUIRED_METHOD amarra capability a método, com controle
positivo — capability aqui é o que se provou, não o que o fornecedor
promete.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Núcleo puro da assinatura Datafy

Fase B. A Datafy assina `{timestamp}.{body}` com o segredo `whsec_…` do canal e manda o resultado em `x-datafy-signature-256` no formato `sha256=<hex>`, acompanhado de `x-datafy-timestamp`. Diferente da Meta, há anti-replay. A decisão fica num núcleo puro testável; só o HMAC em si vive no adapter (precisa de `crypto.subtle`, que é assíncrono).

**Files:**
- Create: `supabase/functions/_shared/datafy-signature-core.ts`
- Create: `src/lib/datafy-signature-core.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `DATAFY_SIGNATURE_HEADER = "x-datafy-signature-256"`, `DATAFY_TIMESTAMP_HEADER = "x-datafy-timestamp"`, `DATAFY_DELIVERY_ID_HEADER = "x-datafy-delivery-id"`, `DATAFY_REPLAY_WINDOW_MS = 300_000`
  - `type DatafySignatureRefusal = "missing_secret" | "missing_signature" | "malformed_signature" | "missing_timestamp" | "malformed_timestamp" | "stale_timestamp" | "future_timestamp"`
  - `decideDatafySignaturePreconditions(input: { secret: string | null | undefined; signatureHeader: string | null; timestampHeader: string | null; nowMs: number }): { ok: true; expectedHex: string; signedPayloadPrefix: string } | { ok: false; reason: DatafySignatureRefusal }`
  - `buildDatafySignedPayload(timestampRaw: string, bodyText: string): string`

- [ ] **Step 1: Escrever os testes que falham**

Cria `src/lib/datafy-signature-core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  DATAFY_REPLAY_WINDOW_MS,
  buildDatafySignedPayload,
  decideDatafySignaturePreconditions,
} from "../../supabase/functions/_shared/datafy-signature-core.ts";

const NOW = Date.UTC(2026, 8, 22, 17, 0, 0);
const TS = String(Math.floor(NOW / 1000));
const HEX = "a".repeat(64);
const SIG = `sha256=${HEX}`;

const base = { secret: "whsec_x", signatureHeader: SIG, timestampHeader: TS, nowMs: NOW };

describe("decideDatafySignaturePreconditions", () => {
  it("aceita assinatura e timestamp bem formados", () => {
    const verdict = decideDatafySignaturePreconditions(base);
    if (verdict.ok === false) throw new Error(`esperava ok, veio ${verdict.reason}`);
    expect(verdict.expectedHex).toBe(HEX);
    expect(verdict.signedPayloadPrefix).toBe(TS);
  });

  // Review Focus 1: canal recém-criado, secret ainda não colado.
  it("recusa quando o canal não tem webhook_secret", () => {
    for (const secret of [null, undefined, "", "   "]) {
      const verdict = decideDatafySignaturePreconditions({ ...base, secret });
      expect(verdict.ok).toBe(false);
      if (verdict.ok === false) expect(verdict.reason).toBe("missing_secret");
    }
  });

  it("recusa assinatura ausente ou fora do formato sha256=<64 hex>", () => {
    const casos: Array<[string | null, string]> = [
      [null, "missing_signature"],
      ["", "missing_signature"],
      [HEX, "malformed_signature"],
      ["sha256=" + "a".repeat(63), "malformed_signature"],
      ["sha256=" + "z".repeat(64), "malformed_signature"],
      ["sha1=" + HEX, "malformed_signature"],
    ];
    for (const [signatureHeader, reason] of casos) {
      const verdict = decideDatafySignaturePreconditions({ ...base, signatureHeader });
      expect(verdict.ok).toBe(false);
      if (verdict.ok === false) expect(verdict.reason).toBe(reason);
    }
  });

  it("aceita hex maiúsculo normalizando para minúsculo", () => {
    const verdict = decideDatafySignaturePreconditions({
      ...base,
      signatureHeader: `sha256=${"A".repeat(64)}`,
    });
    if (verdict.ok === false) throw new Error("esperava ok");
    expect(verdict.expectedHex).toBe("a".repeat(64));
  });

  it("recusa timestamp ausente ou não numérico", () => {
    for (const [timestampHeader, reason] of [
      [null, "missing_timestamp"],
      ["", "missing_timestamp"],
      ["ontem", "malformed_timestamp"],
      ["-1", "malformed_timestamp"],
    ] as Array<[string | null, string]>) {
      const verdict = decideDatafySignaturePreconditions({ ...base, timestampHeader });
      expect(verdict.ok).toBe(false);
      if (verdict.ok === false) expect(verdict.reason).toBe(reason);
    }
  });

  it("recusa entrega mais velha que a janela de replay", () => {
    const velho = String(Math.floor((NOW - DATAFY_REPLAY_WINDOW_MS - 1000) / 1000));
    const verdict = decideDatafySignaturePreconditions({ ...base, timestampHeader: velho });
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) expect(verdict.reason).toBe("stale_timestamp");
  });

  it("aceita entrega na borda da janela", () => {
    const borda = String(Math.floor((NOW - DATAFY_REPLAY_WINDOW_MS + 1000) / 1000));
    expect(decideDatafySignaturePreconditions({ ...base, timestampHeader: borda }).ok).toBe(true);
  });

  // Review Focus 2: janela tem que ser bilateral.
  it("recusa timestamp no futuro além da tolerância de clock", () => {
    const futuro = String(Math.floor((NOW + DATAFY_REPLAY_WINDOW_MS + 1000) / 1000));
    const verdict = decideDatafySignaturePreconditions({ ...base, timestampHeader: futuro });
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) expect(verdict.reason).toBe("future_timestamp");
  });
});

describe("buildDatafySignedPayload", () => {
  it("concatena timestamp e corpo com ponto, preservando o corpo cru", () => {
    const body = '{"a":1,\n  "b":"ç"}';
    expect(buildDatafySignedPayload("123", body)).toBe(`123.${body}`);
  });

  it("usa o timestamp cru do header, nunca um reformatado", () => {
    expect(buildDatafySignedPayload("0123", "x")).toBe("0123.x");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm run test -- src/lib/datafy-signature-core.test.ts`
Expected: FAIL — módulo `datafy-signature-core.ts` não existe.

- [ ] **Step 3: Implementar o núcleo**

Cria `supabase/functions/_shared/datafy-signature-core.ts`:

```ts
/**
 * Decisão pura da assinatura de webhook da Datafy.
 *
 * A Datafy assina `{timestamp}.{corpo cru}` com o segredo `whsec_…` do número e
 * entrega o resultado em `x-datafy-signature-256` no formato `sha256=<hex>`,
 * junto de `x-datafy-timestamp`. Difere da Meta em dois pontos que importam:
 * o timestamp entra no material assinado, e existe janela anti-replay.
 *
 * O HMAC em si NÃO mora aqui: `crypto.subtle` é assíncrono e indisponível ao
 * vitest de núcleo puro. Aqui ficam as pré-condições — que é onde moram os
 * modos de falha que um canal real encontra.
 */

export const DATAFY_SIGNATURE_HEADER = "x-datafy-signature-256";
export const DATAFY_TIMESTAMP_HEADER = "x-datafy-timestamp";
export const DATAFY_DELIVERY_ID_HEADER = "x-datafy-delivery-id";

/**
 * Cinco minutos, conforme a recomendação da documentação. Aplicada nos DOIS
 * sentidos: só olhar o passado aceitaria um timestamp forjado com data futura
 * para sempre, já que a assinatura fecha sobre o valor que o atacante escolheu.
 */
export const DATAFY_REPLAY_WINDOW_MS = 5 * 60_000;

const SIGNATURE_PREFIX = "sha256=";
const HEX_64 = /^[0-9a-f]{64}$/;

export type DatafySignatureRefusal =
  | "missing_secret"
  | "missing_signature"
  | "malformed_signature"
  | "missing_timestamp"
  | "malformed_timestamp"
  | "stale_timestamp"
  | "future_timestamp";

export type DatafySignaturePreconditions =
  | { ok: true; expectedHex: string; signedPayloadPrefix: string }
  | { ok: false; reason: DatafySignatureRefusal };

export function buildDatafySignedPayload(timestampRaw: string, bodyText: string): string {
  return `${timestampRaw}.${bodyText}`;
}

export function decideDatafySignaturePreconditions(input: {
  secret: string | null | undefined;
  signatureHeader: string | null;
  timestampHeader: string | null;
  nowMs: number;
}): DatafySignaturePreconditions {
  if (!input.secret || !input.secret.trim()) return { ok: false, reason: "missing_secret" };

  const rawSignature = input.signatureHeader?.trim() ?? "";
  if (!rawSignature) return { ok: false, reason: "missing_signature" };
  if (!rawSignature.startsWith(SIGNATURE_PREFIX)) return { ok: false, reason: "malformed_signature" };
  const expectedHex = rawSignature.slice(SIGNATURE_PREFIX.length).toLowerCase();
  if (!HEX_64.test(expectedHex)) return { ok: false, reason: "malformed_signature" };

  const rawTimestamp = input.timestampHeader?.trim() ?? "";
  if (!rawTimestamp) return { ok: false, reason: "missing_timestamp" };
  if (!/^\d+$/.test(rawTimestamp)) return { ok: false, reason: "malformed_timestamp" };
  const seconds = Number(rawTimestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return { ok: false, reason: "malformed_timestamp" };

  const deltaMs = input.nowMs - seconds * 1000;
  if (deltaMs > DATAFY_REPLAY_WINDOW_MS) return { ok: false, reason: "stale_timestamp" };
  if (-deltaMs > DATAFY_REPLAY_WINDOW_MS) return { ok: false, reason: "future_timestamp" };

  // O prefixo devolvido é o valor CRU do header: reformatar (zeros à esquerda,
  // recasting numérico) mudaria o material assinado e derrubaria toda entrega.
  return { ok: true, expectedHex, signedPayloadPrefix: rawTimestamp };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm run test -- src/lib/datafy-signature-core.test.ts`
Expected: PASS, todos os casos.

- [ ] **Step 5: Typecheck e commit**

```bash
npm run typecheck
git add supabase/functions/_shared/datafy-signature-core.ts src/lib/datafy-signature-core.test.ts
git commit -m "feat(datafy): núcleo puro da assinatura de webhook

HMAC sobre {timestamp}.{corpo cru} com anti-replay bilateral de 5 min.
Segredo ausente falha fechado (canal recém-criado sem whsec_), e o
timestamp devolvido é o valor cru do header — reformatá-lo mudaria o
material assinado e derrubaria toda entrega.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Cliente HTTP da Datafy

Centraliza base URL, autenticação, timeout, classificação de erro e descoberta por `/me`. Nenhum `fetch()` da Datafy pode nascer fora daqui.

**Files:**
- Create: `supabase/functions/_shared/datafy-client.ts`
- Create: `src/lib/datafy-client.test.ts`

**Interfaces:**
- Consumes: `WhatsAppProviderErrorCode`, `SendResult`, `ChannelCredentials` de `whatsapp-provider-core.ts`.
- Produces:
  - `DATAFY_BASE_URL = "https://cloud.datafyapi.com.br"`
  - `interface DatafyAccount { clienteId: string | null; phoneNumberId: string | null; wabaId: string | null; businessId: string | null }`
  - `parseDatafyAccount(body: unknown): DatafyAccount | null`
  - `classifyDatafyStatus(status: number): WhatsAppProviderErrorCode | null` — `null` quando é 2xx
  - `pickDatafyMessageId(body: unknown): string | undefined`
  - `buildDatafyRequest(input: { token: string; method: "GET"|"POST"|"DELETE"; path: string; body?: unknown }): { url: string; init: RequestInit }`

- [ ] **Step 1: Escrever os testes que falham**

Cria `src/lib/datafy-client.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  DATAFY_BASE_URL,
  buildDatafyRequest,
  classifyDatafyStatus,
  parseDatafyAccount,
  pickDatafyMessageId,
} from "../../supabase/functions/_shared/datafy-client.ts";

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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm run test -- src/lib/datafy-client.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar o cliente**

Cria `supabase/functions/_shared/datafy-client.ts`:

```ts
/**
 * Cliente HTTP único da Datafy. Nenhum `fetch()` da Datafy pode nascer fora
 * daqui — é o que mantém base URL, autenticação, timeout e classificação de
 * erro num lugar só quando a API evoluir.
 *
 * A Datafy é proxy da Cloud API: `/v1/...` espelha a Graph API da Meta, e os
 * endpoints próprios (`/me`, `/media/{id}`) ficam fora do `/v1`. Por isso o
 * `path` é relativo à raiz, não ao `/v1`.
 */

import type { WhatsAppProviderErrorCode } from "./whatsapp-provider-core.ts";

export const DATAFY_BASE_URL = "https://cloud.datafyapi.com.br";

export interface DatafyAccount {
  clienteId: string | null;
  phoneNumberId: string | null;
  wabaId: string | null;
  businessId: string | null;
}

export function buildDatafyRequest(input: {
  token: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
}): { url: string; init: RequestInit } {
  const path = input.path.replace(/^\/+/, "");
  const hasBody = input.body !== undefined;
  return {
    // O token vai SEMPRE em header. A Z-API deste repo carrega credencial no
    // path e por isso precisa de redação de erro; aqui a URL é inofensiva.
    url: `${DATAFY_BASE_URL}/${path}`,
    init: {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.token}`,
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(input.body) } : {}),
    },
  };
}

/**
 * `402` é "assinatura Datafy inativa" e `403` é "operação bloqueada ou recurso
 * fora do token". Os dois são problema de credencial/autorização do nosso lado,
 * não indisponibilidade — agrupá-los em AUTH_ERROR impede retry inútil.
 */
export function classifyDatafyStatus(status: number): WhatsAppProviderErrorCode | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 402 || status === 403) return "AUTH_ERROR";
  if (status === 404) return "INSTANCE_NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status === 400 || status === 422) return "INVALID_REQUEST";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  return "UNKNOWN_PROVIDER_ERROR";
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * `phone_number_id` é obrigatório: é ele que identifica o canal e que a guarda
 * de identidade cross-tenant compara. Sem ele a descoberta não serve para nada,
 * e aceitar o resto faria um canal nascer sem âncora.
 */
export function parseDatafyAccount(body: unknown): DatafyAccount | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const phoneNumberId = str(record.phone_number_id);
  if (!phoneNumberId) return null;
  return {
    clienteId: str(record.cliente_id),
    phoneNumberId,
    wabaId: str(record.waba_id),
    businessId: str(record.business_id),
  };
}

/**
 * A Cloud API devolve `messages[0].id` (`wamid....`). Ausente, devolvemos
 * undefined em vez de inventar: `notifications_sent` correlaciona recibo por
 * esse id, e um valor fabricado faria o rastreio casar com a linha errada.
 */
export function pickDatafyMessageId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages) || !messages.length) return undefined;
  const first = messages[0];
  if (!first || typeof first !== "object") return undefined;
  return str((first as Record<string, unknown>).id) ?? undefined;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm run test -- src/lib/datafy-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck e commit**

```bash
npm run typecheck
git add supabase/functions/_shared/datafy-client.ts src/lib/datafy-client.test.ts
git commit -m "feat(datafy): cliente HTTP central com descoberta e classificação de erro

Base URL, Bearer em header, /me para descobrir phone_number_id/waba_id, e
classificação que separa credencial (401/402/403) de indisponibilidade,
para não gerar retry inútil.

pickDatafyMessageId devolve undefined quando o 200 não traz id, em vez de
inventar: notifications_sent correlaciona recibo por esse id.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Migration — `datafy` nos CHECKs de provider

> **CORREÇÃO DE PLANO (pós-auditoria, antes do despacho).** Este texto dizia "três tabelas". São **seis CHECKs de tabela e dois corpos de função**, todos em `20260817170753_whatsapp_multiprovider_uazapi.sql`:
>
> | # | Onde | Linha |
> |---|---|---|
> | 1 | `organizations_default_whatsapp_provider_check` | `:30` |
> | 2 | `whatsapp_channels.provider` | `:63` |
> | 3 | `whatsapp_instances_provider_check` | `:150` |
> | 4 | `processed_messages_provider_check` | `:170` |
> | 5 | `notifications_sent_whatsapp_provider_check` | `:191` |
> | 6 | `whatsapp_channel_lifecycle_events.provider` **e** `.previous_provider` (duas expressões, uma tabela) | `:218`, `:220` |
> | 7 | **corpo** de `claim_processed_whatsapp_message()` | `:261-327`, guarda em `:281` |
> | 8 | **corpo** de `set_organization_default_whatsapp_provider()` | `:386-436`, guarda em `:404` |
>
> O item 7 é o que quebraria tudo em silêncio: é a RPC de idempotência, por onde passa **todo** inbound. Com o CHECK da tabela liberado e o corpo da função não, o primeiro inbound Datafy levanta exceção dentro da RPC — e o invariante do repo diz que erro de banco nunca vira duplicata/200, então o inbound se perde ou duas IAs rodam concorrentes. `ALTER ... CHECK` **não alcança corpo de função**: exige `create or replace` na mesma migration.
>
> O item 8 importa porque a decisão de produto é "Datafy vira o padrão novo", o que significa gravar `organizations.default_whatsapp_provider`.
>
> **Não tocar em `record_whatsapp_channel_status`:** ela foi redefinida em `20260901225539_generalize_whatsapp_channel_status.sql` e a versão viva já **não** guarda provider. As outras duas nunca foram redefinidas — as definições vivas são as de agosto.

Sem a migration, o primeiro insert de canal, de mensagem processada ou de notificação falha com `23514`; e, com só os CHECKs corrigidos, o primeiro inbound falha dentro da RPC de idempotência.

**Files:**
- Create: `supabase/migrations/20260922170000_110_datafy_provider.sql`
- Create: `src/lib/datafy-provider-migration-guard.test.ts`

**Interfaces:**
- Consumes: `WHATSAPP_PROVIDER_NAMES` de `whatsapp-provider-core.ts` (Task 1).
- Produces: `datafy` aceito nos sete CHECKs (`organizations.default_whatsapp_provider`, `whatsapp_channels.provider`, `whatsapp_instances.provider`, `processed_messages.provider`, `notifications_sent.whatsapp_provider`, `whatsapp_channel_lifecycle_events.provider` e `.previous_provider`) **e** nos corpos de `claim_processed_whatsapp_message` e `set_organization_default_whatsapp_provider`. Sem os dois últimos, os CHECKs não bastam.

- [ ] **Step 1: Escrever o guard estático que falha**

Cria `src/lib/datafy-provider-migration-guard.test.ts`. Ele lê o SQL e prova que as sete constraints **e os dois corpos de função** foram atualizados — o pré-voo com banco roda em outra suíte, mas a divergência entre a lista TypeScript e o SQL é exatamente o defeito que passa despercebido, e a guarda dentro da RPC é a que nenhum `ALTER ... CHECK` alcança.

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WHATSAPP_PROVIDER_NAMES } from "../../supabase/functions/_shared/whatsapp-provider-core.ts";

const SQL = readFileSync(
  resolve(__dirname, "../../supabase/migrations/20260922170000_110_datafy_provider.sql"),
  "utf8",
);

const CONSTRAINTS = [
  "organizations_default_whatsapp_provider_check",
  "whatsapp_channels_provider_check",
  "whatsapp_instances_provider_check",
  "processed_messages_provider_check",
  "notifications_sent_whatsapp_provider_check",
  "whatsapp_channel_lifecycle_events_provider_check",
  "whatsapp_channel_lifecycle_events_previous_provider_check",
];

// Os dois corpos de função: um ALTER ... CHECK nunca os alcança.
const FUNCOES = [
  "public.claim_processed_whatsapp_message",
  "public.set_organization_default_whatsapp_provider",
];

// Uma expressão de lista por constraint, mais uma por corpo de função.
const LISTAS_ESPERADAS = CONSTRAINTS.length + FUNCOES.length;

describe("migration 110 — datafy nos CHECKs de provider", () => {
  it("o registry declara datafy", () => {
    expect(WHATSAPP_PROVIDER_NAMES).toContain("datafy");
  });

  it("dropa e recria cada CHECK de forma idempotente", () => {
    for (const constraint of CONSTRAINTS) {
      expect(SQL).toContain(`drop constraint if exists ${constraint}`);
      expect(SQL).toContain(`add constraint ${constraint}`);
    }
  });

  // O defeito que este teste existe para pegar: liberar o CHECK da tabela e
  // esquecer a guarda DENTRO da RPC de idempotência, por onde passa todo inbound.
  it("reescreve os dois corpos de função que guardam o nome do provider", () => {
    for (const fn of FUNCOES) {
      expect(SQL).toContain(`create or replace function ${fn}`);
    }
  });

  it("cada lista recriada inclui TODOS os providers do registry", () => {
    for (const provider of WHATSAPP_PROVIDER_NAMES) {
      const ocorrencias = SQL.split(`'${provider}'`).length - 1;
      expect(
        ocorrencias,
        `provider ${provider} aparece ${ocorrencias}x; esperado ao menos ${LISTAS_ESPERADAS} (um por CHECK e por corpo de função)`,
      ).toBeGreaterThanOrEqual(LISTAS_ESPERADAS);
    }
  });

  // CONTROLE POSITIVO: o teste acima só vale se detectar a omissão.
  it("detectaria um provider ausente do SQL", () => {
    const sqlIncompleto = "check (provider in ('zapi','waha','official'))";
    expect(sqlIncompleto.split("'uazapi'").length - 1).toBe(0);
  });

  it("não embute segredo nem a URL do projeto Supabase", () => {
    expect(SQL).not.toMatch(/supabase\.co/i);
    expect(SQL).not.toMatch(/sk_live_|whsec_|eyJ|service_role/);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm run test -- src/lib/datafy-provider-migration-guard.test.ts`
Expected: FAIL — o arquivo de migration não existe e `WHATSAPP_PROVIDER_NAMES` ainda não tem `datafy`.

- [ ] **Step 3: Escrever a migration**

`WHATSAPP_PROVIDER_NAMES` já ganhou `"datafy"` na Task 5, que roda antes desta — ver **Ordem de execução** no topo. Não altere `whatsapp-provider-core.ts` aqui.

Cria `supabase/migrations/20260922170000_110_datafy_provider.sql`:

**Antes de escrever o SQL, confirme os nomes reais das constraints.** Quatro das sete nasceram como `check (...)` inline num `create table`, então o nome é o que o Postgres gerou — e `drop constraint if exists <nome errado>` é **no-op silencioso**: o `add` cria uma segunda constraint e a antiga, restritiva, continua valendo. O resultado é uma migration que aplica limpa e mesmo assim recusa `datafy`. Rode primeiro:

```bash
npx supabase db query --linked "
select rel.relname as tabela, con.conname as constraint, pg_get_constraintdef(con.oid) as definicao
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
where con.contype = 'c'
  and pg_get_constraintdef(con.oid) like '%uazapi%'
order by rel.relname, con.conname;
"
```

Use os nomes que essa consulta devolver. Se algum divergir do assumido abaixo, o nome da consulta vence.

```sql
-- 110 — Datafy como provider de WhatsApp (proxy oficial da Meta Cloud API).
--
-- O nome do provider é restringido em OITO lugares: sete CHECKs de tabela e
-- dois corpos de função (um deles tem duas expressões). Liberar só os CHECKs
-- deixa o primeiro inbound Datafy estourando DENTRO de
-- claim_processed_whatsapp_message, que é a RPC de idempotência por onde passa
-- todo inbound — e erro de banco ali nunca é tratado como duplicata, então o
-- inbound se perde ou duas IAs rodam concorrentes.
--
-- ALTER ... CHECK não alcança corpo de função: as duas são reescritas aqui por
-- create or replace, com a assinatura idêntica (mudar o tipo de retorno daria 42P13).
--
-- Idempotente: drop-if-exists + add nas constraints, create or replace nas funções.

alter table public.organizations
  drop constraint if exists organizations_default_whatsapp_provider_check;
alter table public.organizations
  add constraint organizations_default_whatsapp_provider_check
  check (default_whatsapp_provider in ('zapi', 'uazapi', 'waha', 'official', 'datafy'));

alter table public.whatsapp_channels
  drop constraint if exists whatsapp_channels_provider_check;
alter table public.whatsapp_channels
  add constraint whatsapp_channels_provider_check
  check (provider in ('zapi', 'uazapi', 'waha', 'official', 'datafy'));

alter table public.whatsapp_instances
  drop constraint if exists whatsapp_instances_provider_check;
alter table public.whatsapp_instances
  add constraint whatsapp_instances_provider_check
  check (provider in ('zapi', 'uazapi', 'waha', 'official', 'datafy'));

alter table public.processed_messages
  drop constraint if exists processed_messages_provider_check;
alter table public.processed_messages
  add constraint processed_messages_provider_check
  check (provider in ('zapi', 'uazapi', 'waha', 'official', 'datafy'));

alter table public.notifications_sent
  drop constraint if exists notifications_sent_whatsapp_provider_check;
alter table public.notifications_sent
  add constraint notifications_sent_whatsapp_provider_check
  check (whatsapp_provider is null
         or whatsapp_provider in ('zapi', 'uazapi', 'waha', 'official', 'datafy'));

alter table public.whatsapp_channel_lifecycle_events
  drop constraint if exists whatsapp_channel_lifecycle_events_provider_check;
alter table public.whatsapp_channel_lifecycle_events
  add constraint whatsapp_channel_lifecycle_events_provider_check
  check (provider in ('zapi', 'uazapi', 'waha', 'official', 'datafy'));

alter table public.whatsapp_channel_lifecycle_events
  drop constraint if exists whatsapp_channel_lifecycle_events_previous_provider_check;
alter table public.whatsapp_channel_lifecycle_events
  add constraint whatsapp_channel_lifecycle_events_previous_provider_check
  check (previous_provider is null
         or previous_provider in ('zapi', 'uazapi', 'waha', 'official', 'datafy'));

comment on constraint whatsapp_channels_provider_check on public.whatsapp_channels is
  'Providers suportados. datafy é proxy da Meta Cloud API: mesmos payloads do provider official, transporte e assinatura próprios.';
```

**Os dois corpos de função.** Copie cada um **verbatim** de `supabase/migrations/20260817170753_whatsapp_multiprovider_uazapi.sql` — `claim_processed_whatsapp_message` das linhas 261–327, `set_organization_default_whatsapp_provider` das linhas 386–436 — e mude **somente** a lista de providers dentro da guarda (`:281` e `:404`, respectivamente), acrescentando `'datafy'`. Não reescreva mais nada do corpo: qualquer outra diferença é uma mudança de comportamento que ninguém pediu e que a review não vai conseguir distinguir da correção.

Reafirme, depois de cada função, o `revoke`/`grant` que a migration de agosto já aplica a ela. `create or replace` preserva a ACL, então isso é redundante por construção — mas o guardrail `acl-estatico` lê as migrations, não o banco, e uma função que aparece recriada sem ACL declarada é exatamente a forma que ele existe para sinalizar. Localize as linhas com:

```bash
grep -n "claim_processed_whatsapp_message\|set_organization_default_whatsapp_provider" supabase/migrations/*.sql | grep -E "revoke|grant"
```

- [ ] **Step 4: Rodar e ver passar**

```bash
npm run test -- src/lib/datafy-provider-migration-guard.test.ts src/lib/whatsapp-capability-guard.test.ts src/test/whatsapp-provider-core.test.ts
```

Expected: PASS nos três. Como a Task 5 já registrou o adapter `datafy`, `whatsapp-capability-guard` itera os cinco providers sem encontrar `unknown_whatsapp_provider`.

- [ ] **Step 5: Aplicar e commitar**

**Aplicar duas vezes**, para provar a idempotência que o cabeçalho promete — a segunda passada tem que ser limpa:

```bash
npx supabase db push
npx supabase db push   # replay: deve ser no-op, sem erro
npm run typecheck
```

Depois de aplicar, **confirme no banco** que as sete constraints ficaram únicas por tabela/coluna (uma constraint órfã com o nome antigo continuaria recusando `datafy` sem que nada falhasse no push):

```bash
npx supabase db query --linked "
select rel.relname as tabela, con.conname as constraint, pg_get_constraintdef(con.oid) as definicao
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
where con.contype = 'c' and pg_get_constraintdef(con.oid) like '%uazapi%'
order by rel.relname, con.conname;
"
```

Toda linha devolvida tem que conter `'datafy'`. Qualquer uma que não contenha é uma constraint que sobrou e vai recusar o primeiro canal.

```bash
git add supabase/migrations/20260922170000_110_datafy_provider.sql src/lib/datafy-provider-migration-guard.test.ts
git commit -F - <<'EOF'
feat(datafy): liberar o provider nos sete CHECKs e nos dois corpos de funcao

O plano dizia tres CHECKs. Sao sete, em seis tabelas, mais duas guardas
DENTRO de funcoes — que nenhum ALTER ... CHECK alcanca.

A que importa e claim_processed_whatsapp_message: e a RPC de idempotencia,
por onde passa todo inbound. Com o CHECK da tabela liberado e o corpo da
funcao nao, o primeiro inbound Datafy levanta excecao la dentro, e erro de
banco nunca e tratado como duplicata — o inbound se perde ou duas IAs rodam
concorrentes. A segunda e set_organization_default_whatsapp_provider, porque
a decisao de produto e que Datafy vira o padrao de unidade nova.

record_whatsapp_channel_status nao entra: foi redefinida em 20260901225539 e
a versao viva ja nao guarda provider.

Guard estatico cruza a lista do SQL com WHATSAPP_PROVIDER_NAMES e exige as
duas funcoes recriadas, com controle positivo.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: Adapter `datafy` e conjunto de providers Meta-shaped

Registra o adapter reusando os parsers `official` e converte os pontos que perguntam `provider === "official"` para um conjunto nomeado, com guard de acoplamento. É a tarefa que fecha o caminho de recebimento.

**Files:**
- Modify: `supabase/functions/_shared/whatsapp-provider-core.ts` (`PROVIDER_CAPABILITIES`, + `META_SHAPED_PROVIDERS`)
- Modify: `supabase/functions/_shared/whatsapp-providers.ts` (adapter, `verifyDatafySignature`, `sendDatafy`, `getDatafyConnectionStatus`)
- Modify: `supabase/functions/webhook-whatsapp/index.ts` (l. ~129, ~946, ~1616, ~1700, ~1709)
- Create: `src/lib/datafy-adapter-coupling-guard.test.ts`
- Test: `src/test/whatsapp-provider-core.test.ts`

**Interfaces:**
- Consumes: Task 1 (`CloudApiRequest`, capabilities), Task 2 (`decideDatafySignaturePreconditions`, `buildDatafySignedPayload`), Task 3 (`buildDatafyRequest`, `classifyDatafyStatus`, `pickDatafyMessageId`, `parseDatafyAccount`).
- Produces:
  - `WHATSAPP_PROVIDER_NAMES` passa a incluir `"datafy"` (nome e adapter no mesmo commit)
  - `META_SHAPED_PROVIDERS: ReadonlySet<WhatsAppProviderName>` = `{"official","datafy"}`
  - `isMetaShapedProvider(provider: string): boolean`
  - `type WebhookSignatureScheme = "meta_app_secret" | "datafy_whsec" | "channel_secret"`
  - `WEBHOOK_SIGNATURE_SCHEME: Readonly<Record<WhatsAppProviderName, WebhookSignatureScheme>>`
  - `verifyDatafySignature(req: Request, bodyText: string, secret: string, nowMs: number): Promise<boolean>` em `whatsapp-providers.ts`
  - Adapter `datafy` no registry, com `credentials.access_token` = `sk_live_…` e `credentials.phone_number_id`/`business_account_id` preenchidos pela descoberta.

- [ ] **Step 1: Escrever o guard de acoplamento que falha**

Cria `src/lib/datafy-adapter-coupling-guard.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  META_SHAPED_PROVIDERS,
  PROVIDER_CAPABILITIES,
  WEBHOOK_SIGNATURE_SCHEME,
  WHATSAPP_PROVIDER_NAMES,
  isMetaShapedProvider,
} from "../../supabase/functions/_shared/whatsapp-provider-core.ts";
import type { WhatsAppProviderAdapter } from "../../supabase/functions/_shared/whatsapp-provider-core.ts";

// NÃO troque por `import { tryGetWhatsAppProvider } from ".../whatsapp-providers.ts"`.
// Medido na Task 1: o import direto passa no vitest mas puxa o arquivo para o
// grafo do `tsc -b` do frontend e quebra o typecheck com 6 erros — o global
// `Deno` não existe ali, e o próprio arquivo carrega um TS2339 latente. O glob
// carrega os adapters reais em runtime sem entrar no grafo de tipos.
// Mesmo padrão de `src/lib/whatsapp-capability-guard.test.ts`.
const FACADE = "../../supabase/functions/_shared/whatsapp-providers.ts";
const modules = import.meta.glob<{
  tryGetWhatsAppProvider(name: string): WhatsAppProviderAdapter | null;
}>("../../supabase/functions/_shared/whatsapp-providers.ts", { eager: true });
const { tryGetWhatsAppProvider } = modules[FACADE];

const WEBHOOK = readFileSync(
  resolve(__dirname, "../../supabase/functions/webhook-whatsapp/index.ts"),
  "utf8",
);

describe("datafy é Meta-shaped e reusa os parsers official", () => {
  it("todo nome do registry tem adapter", () => {
    for (const name of WHATSAPP_PROVIDER_NAMES) {
      expect(tryGetWhatsAppProvider(name), `sem adapter: ${name}`).not.toBeNull();
    }
  });

  it("o conjunto Meta-shaped contém official e datafy, e só eles", () => {
    expect([...META_SHAPED_PROVIDERS].sort()).toEqual(["datafy", "official"]);
    expect(isMetaShapedProvider("datafy")).toBe(true);
    expect(isMetaShapedProvider("zapi")).toBe(false);
    expect(isMetaShapedProvider("inexistente")).toBe(false);
  });

  it("datafy usa exatamente as mesmas funções de parse que official", () => {
    const datafy = tryGetWhatsAppProvider("datafy");
    const official = tryGetWhatsAppProvider("official");
    if (!datafy || !official) throw new Error("adapters ausentes");
    expect(datafy.parseInbound).toBe(official.parseInbound);
    expect(datafy.parseStatusCallback).toBe(official.parseStatusCallback);
    expect(datafy.parseOwnMessageEchoes).toBe(official.parseOwnMessageEchoes);
    expect(datafy.peekInboundMedia).toBe(official.peekInboundMedia);
  });

  it("datafy declara as capabilities que a Fase A+B realmente entrega", () => {
    const caps = PROVIDER_CAPABILITIES.datafy;
    expect(caps.manualCredentials).toBe(true);
    expect(caps.deliveryReceipts).toBe(true);
    expect(caps.adReferral).toBe(true);
    expect(caps.rawCloudApiProxy).toBe(true);
    expect(caps.qrConnection).toBe(false);
    expect(caps.automaticWebhook).toBe(false); // Datafy bloqueia webhook_configuration (403)
    expect(caps.manualDeviceEcho).toBe("conditional"); // só em coexistência
    // Ainda não implementados — Fases E e F.
    expect(caps.templateMessages).toBe(false);
    expect(caps.mediaMessages).toBe(false);
    expect(caps.interactiveMessages).toBe(false);
    expect(caps.inboundMediaDownload).toBe(false);
  });

  // O defeito real: um caminho do webhook que ficou perguntando só por "official".
  it("o webhook não decide forma de payload comparando com a string official", () => {
    const comparacoesCruas = WEBHOOK.match(/provider\s*===\s*"official"/g) ?? [];
    expect(
      comparacoesCruas,
      "use isMetaShapedProvider(provider); comparar com a string deixa datafy de fora em silêncio",
    ).toEqual([]);
  });

  it("o webhook usa o helper em vez da string", () => {
    expect(WEBHOOK).toContain("isMetaShapedProvider(provider)");
  });

  // Review Focus 3: o HMAC prova QUEM enviou, não PARA QUAL canal. Sem a guarda
  // de identidade, um callback legitimamente assinado por outro número do mesmo
  // cliente Datafy seria encaminhado ao channel_id errado — e atravessaria tenants.
  // metaPayloadMatchesChannel não é exportado, então a cobertura aqui é estrutural.
  it("a guarda de identidade por phone_number_id cobre todo provider Meta-shaped", () => {
    expect(WEBHOOK).toMatch(
      /isMetaShapedProvider\(provider\)\s*&&\s*!metaPayloadMatchesChannel\(/,
    );
  });

  it("todo provider tem esquema de assinatura declarado, e datafy não usa o da Meta", () => {
    for (const name of WHATSAPP_PROVIDER_NAMES) {
      expect(WEBHOOK_SIGNATURE_SCHEME[name], `sem esquema: ${name}`).toBeDefined();
    }
    expect(WEBHOOK_SIGNATURE_SCHEME.official).toBe("meta_app_secret");
    expect(WEBHOOK_SIGNATURE_SCHEME.datafy).toBe("datafy_whsec");
    expect(WEBHOOK_SIGNATURE_SCHEME.zapi).toBe("channel_secret");
  });

  it("o webhook ramifica a assinatura pelo mapa, não por string", () => {
    expect(WEBHOOK).toContain("WEBHOOK_SIGNATURE_SCHEME[provider]");
  });

  it("o re-dispatch de lote apaga as assinaturas dos DOIS esquemas", () => {
    const bloco = WEBHOOK.slice(WEBHOOK.indexOf("splitMetaWebhookPayload(payload)"));
    expect(bloco).toContain('headers.delete("x-hub-signature-256")');
    expect(bloco).toContain('headers.delete("x-datafy-signature-256")');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm run test -- src/lib/datafy-adapter-coupling-guard.test.ts`
Expected: FAIL — `META_SHAPED_PROVIDERS` não existe e há 5 ocorrências de `provider === "official"` no webhook.

- [ ] **Step 3: Implementar adapter e conjunto**

Em `whatsapp-provider-core.ts`, linha 3, registre o nome — junto com o adapter, nunca antes dele, para não existir um instante em que o registry anuncia um provider sem implementação:

```ts
export const WHATSAPP_PROVIDER_NAMES = ["zapi", "waha", "official", "uazapi", "datafy"] as const;
```

Depois de `PROVIDER_CAPABILITIES`, acrescente a entrada `datafy` ao objeto:

```ts
  datafy: {
    manualCredentials: true,
    automaticProvisioning: false,
    qrConnection: false,
    pairCode: false,
    // A Datafy responde 403 a webhook_configuration: a URL é colada à mão no painel.
    automaticWebhook: false,
    disconnect: false,
    restart: false,
    deliveryReceipts: true,
    manualDeviceEcho: "conditional",
    templateMessages: false,
    mediaMessages: false,
    inboundMediaDownload: false,
    interactiveMessages: false,
    adReferral: true,
    rawCloudApiProxy: true,
  },
```

E, logo abaixo:

```ts
/**
 * Providers cujo payload de webhook é o envelope da Meta
 * (`object`/`entry[]`/`changes[]`/`value`). A Datafy encaminha o payload da Meta
 * sem modificar, então tudo que decide FORMA de payload pergunta a este conjunto.
 *
 * Existe como conjunto, e não como `provider === "official"` espalhado, porque a
 * omissão de um único call site não produz erro: o evento simplesmente não casa
 * nenhum parser e some como `ignored_non_text`.
 */
export const META_SHAPED_PROVIDERS: ReadonlySet<WhatsAppProviderName> = new Set([
  "official",
  "datafy",
]);

export function isMetaShapedProvider(provider: string): boolean {
  return META_SHAPED_PROVIDERS.has(provider as WhatsAppProviderName);
}

/**
 * Esquema de autenticação do webhook, por provider. É uma pergunta DIFERENTE de
 * `META_SHAPED_PROVIDERS`: `official` e `datafy` têm o mesmo formato de payload
 * e esquemas de assinatura distintos — a Meta assina o corpo com o app_secret,
 * a Datafy assina `{timestamp}.{corpo}` com o whsec_ do canal.
 *
 * Existe como mapa para que o webhook não volte a discriminar por string: um
 * `provider === "official"` no ramo de assinatura é indistinguível, à leitura,
 * de um que decide forma de payload — e é assim que o próximo provider
 * Meta-shaped entra sem ninguém notar.
 */
export type WebhookSignatureScheme = "meta_app_secret" | "datafy_whsec" | "channel_secret";

export const WEBHOOK_SIGNATURE_SCHEME: Readonly<Record<WhatsAppProviderName, WebhookSignatureScheme>> = {
  zapi: "channel_secret",
  waha: "channel_secret",
  uazapi: "channel_secret",
  official: "meta_app_secret",
  datafy: "datafy_whsec",
};
```

Em `whatsapp-providers.ts`, acrescente os imports de `datafy-signature-core.ts` e `datafy-client.ts`, e antes do array `adapters`:

```ts
async function sendDatafy(
  credentials: ChannelCredentials,
  message: OutboundMessage,
): Promise<SendResult> {
  const { phone_number_id, access_token } = credentials;
  const missing: string[] = [];
  if (!phone_number_id) missing.push("phone_number_id");
  if (!access_token) missing.push("access_token");
  if (missing.length) {
    jsonLog("error", { evt: "send_datafy_missing_creds", missing, phone: sanitizePhone(message.toPhone) });
    return { ok: false, missingCreds: missing, error: "missing_credentials", errorCode: "INVALID_REQUEST" };
  }

  const digits = message.toPhone.replace(/\D/g, "");
  const to = digits.startsWith("55") ? digits : `55${digits}`;
  const { url, init } = buildDatafyRequest({
    token: access_token,
    method: "POST",
    path: `v1/${phone_number_id}/messages`,
    body: { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: message.text } },
  });

  const response = await fetchProviderWithTimeout(url, init, 3);
  const errorCode = classifyDatafyStatus(response.status);
  if (errorCode === null) {
    const body = await response.json().catch(() => null);
    return { ok: true, status: response.status, providerMessageId: pickDatafyMessageId(body) };
  }
  jsonLog("error", {
    evt: "send_datafy_failed",
    status: response.status,
    errorCode,
    phone: sanitizePhone(message.toPhone),
  });
  return { ok: false, status: response.status, error: `datafy_http_${response.status}`, errorCode };
}

async function getDatafyConnectionStatus(
  credentials: ChannelCredentials,
): Promise<ProviderConnectionSnapshot> {
  if (!credentials.access_token) throw new Error("missing_credentials");
  const { url, init } = buildDatafyRequest({
    token: credentials.access_token, method: "GET", path: "me",
  });
  const { response, body } = await fetchConnectionStatus(url, init.headers as Record<string, string>);
  const account = response.ok ? parseDatafyAccount(body) : null;
  // Cloud API não tem sessão: "conectado" é o token resolver um número válido.
  // Não existe QR, e por isso qrRequired é sempre false.
  return {
    status: account ? "connected" : "provider_error",
    nativeStatus: response.ok ? (account ? "token_ok" : "invalid_payload") : `http_${response.status}`,
    connected: !!account,
    qrRequired: false,
    displayPhone: null,
  };
}

async function datafyCloudApiRequest(
  credentials: ChannelCredentials,
  request: CloudApiRequest,
): Promise<CloudApiResponse> {
  if (!credentials.access_token) throw new Error("missing_credentials");
  const { url, init } = buildDatafyRequest({
    token: credentials.access_token,
    method: request.method,
    path: request.path,
    body: request.body,
  });
  const response = await fetchProviderWithTimeout(url, init, 0);
  return { status: response.status, body: await response.json().catch(() => null) };
}
```

E o adapter, no array `adapters`:

```ts
  {
    name: "datafy",
    label: "Datafy (API Oficial)",
    capabilities: PROVIDER_CAPABILITIES.datafy,
    // Mesmas funções do adapter official, por referência: a Datafy encaminha o
    // payload da Meta sem modificar. Copiá-las criaria duas verdades.
    parseInbound: parseOfficialInbound,
    parseOwnMessageEchoes: parseOfficialOwnMessageEchoes,
    peekInboundMedia: peekOfficialMedia,
    parseStatusCallback: parseOfficialStatus,
    sendText: sendDatafy,
    getConnectionStatus: getDatafyConnectionStatus,
    cloudApiRequest: datafyCloudApiRequest,
  },
```

E a verificação de assinatura, ao lado de `validateMetaSignature`:

```ts
export async function verifyDatafySignature(
  req: Request,
  bodyText: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const verdict = decideDatafySignaturePreconditions({
    secret,
    signatureHeader: req.headers.get(DATAFY_SIGNATURE_HEADER),
    timestampHeader: req.headers.get(DATAFY_TIMESTAMP_HEADER),
    nowMs,
  });
  if (verdict.ok === false) {
    jsonLog("warn", { evt: "datafy_signature_refused", reason: verdict.reason });
    return false;
  }

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC", key, encoder.encode(buildDatafySignedPayload(verdict.signedPayloadPrefix, bodyText)),
    );
    const computedHex = Array.from(new Uint8Array(signature))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return constantTimeEquals(verdict.expectedHex, computedHex);
  } catch {
    return false;
  }
}
```

Em `webhook-whatsapp/index.ts`, troque as cinco comparações cruas:

- l. ~129 (`declaredProviderIdentityMatchesChannel`): `if (isMetaShapedProvider(provider)) return metaPayloadMatchesChannel(payload, credentials);`
- l. ~946 e ~950 (telemetria de shape): `isMetaShapedProvider(provider) ? (payload.entry?.[0]?.changes?.[0]?.value ?? payload) : payload` e `isMetaShapedProvider(provider) ? p.messages?.[0] : null`
- l. ~1616 (assinatura): ramifique os dois casos Meta-shaped, porque o esquema difere:

```ts
    let isValid = false;
    switch (WEBHOOK_SIGNATURE_SCHEME[provider]) {
      case "meta_app_secret":
        isValid = trustedMetaPayload
          || await validateMetaSignature(req, bodyText, credentials.app_secret ?? "");
        break;
      case "datafy_whsec":
        // O whsec_ da Datafy mora em webhook_secret; o sk_live_ fica em
        // credentials.access_token. Segredo ausente falha fechado no núcleo.
        isValid = trustedMetaPayload
          || await verifyDatafySignature(req, bodyText, channel.webhook_secret ?? "", Date.now());
        break;
      case "channel_secret": {
        const secret = channel.webhook_secret ?? Deno.env.get("ZAPI_WEBHOOK_SECRET") ?? "";
        isValid = validateChannelSecret(req, secret);
        break;
      }
    }
```

O `switch` sobre o mapa — em vez de `if (provider === "official")` — é o que mantém o guard do Step 1 verdadeiro. Um `provider === "official"` no ramo de assinatura é indistinguível, à leitura, de um que decide forma de payload, e é por essa porta que o próximo provider Meta-shaped entraria sem ninguém notar.

- l. ~1700 (identidade) e l. ~1709 (split de lote): `if (isMetaShapedProvider(provider) && !metaPayloadMatchesChannel(...))` e `if (isMetaShapedProvider(provider)) { const parts = splitMetaWebhookPayload(payload); ... }`. No re-dispatch do lote, apague também o header da Datafy, senão o filho recalcula assinatura sobre um corpo diferente:

```ts
          headers.delete("x-hub-signature-256");
          headers.delete("x-datafy-signature-256");
```

- [ ] **Step 4: Acrescentar os testes de identidade e lote misto, e rodar**

Em `src/test/whatsapp-provider-core.test.ts`, acrescente:

```ts
describe("datafy: identidade e lote (Review Focus 3 e 4)", () => {
  const evento = (phoneNumberId: string, field: string, value: Record<string, unknown>) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "waba1", changes: [{ field, value: { messaging_product: "whatsapp", metadata: { display_phone_number: "5511988887777", phone_number_id: phoneNumberId }, ...value } }] }],
  });

  it("inbound de outro phone_number_id do mesmo cliente não casa o canal", () => {
    const payload = evento("999", "messages", {
      contacts: [{ wa_id: "5511999999999", profile: { name: "Ana" } }],
      messages: [{ from: "5511999999999", id: "wamid.1", timestamp: "1790000000", type: "text", text: { body: "oi" } }],
    });
    // O payload é válido e parseável — é exatamente por isso que a guarda de
    // identidade precisa existir: o HMAC prova QUEM enviou, não PARA QUAL canal.
    expect(parseOfficialInbound(payload)?.providerMessageId).toBe("wamid.1");
    expect(payload.entry[0].changes[0].value.metadata.phone_number_id).toBe("999");
  });

  it("lote com evento desconhecido ao lado de messages não perde a mensagem", () => {
    const lote = {
      object: "whatsapp_business_account",
      entry: [
        { id: "w", changes: [{ field: "message_template_status_update", value: { event: "APPROVED" } }] },
        { id: "w", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "5511988887777", phone_number_id: "123" }, contacts: [{ wa_id: "5511999999999", profile: { name: "Ana" } }], messages: [{ from: "5511999999999", id: "wamid.2", timestamp: "1790000000", type: "text", text: { body: "oi" } }] } }] },
      ],
    };
    const inbound = parseOfficialInbound(lote);
    // O parser lê entry[0] e devolve null para o template — é o split do webhook
    // que separa os itens. O que este teste fixa é que o evento desconhecido
    // não lança: perder o lote inteiro seria a regressão.
    expect(() => parseOfficialInbound(lote)).not.toThrow();
    expect(inbound).toBeNull();
    const soMensagem = { object: lote.object, entry: [lote.entry[1]] };
    expect(parseOfficialInbound(soMensagem)?.providerMessageId).toBe("wamid.2");
  });
});
```

Run: `npm run test -- src/lib/datafy-adapter-coupling-guard.test.ts src/test/whatsapp-provider-core.test.ts src/lib/whatsapp-capability-guard.test.ts`
Expected: PASS nos três.

- [ ] **Step 5: Suíte completa, typecheck e commit**

```bash
npm run test
npm run typecheck
npm run lint
git add supabase/functions/_shared/whatsapp-provider-core.ts supabase/functions/_shared/whatsapp-providers.ts supabase/functions/webhook-whatsapp/index.ts src/lib/datafy-adapter-coupling-guard.test.ts src/test/whatsapp-provider-core.test.ts
git commit -m "feat(datafy): adapter no registry e conjunto de providers Meta-shaped

A Datafy encaminha o payload da Meta sem modificar, então o adapter reusa
os parsers official POR REFERÊNCIA — copiá-los criaria duas verdades.

Os cinco pontos do webhook que perguntavam provider === 'official' passam
a perguntar isMetaShapedProvider(). A omissão de um call site não produz
erro visível: o evento não casaria parser nenhum e sumiria como
ignored_non_text. Guard estático reprova a comparação crua.

Assinatura ramifica: official usa x-hub-signature-256 sobre o corpo;
datafy usa x-datafy-signature-256 sobre {timestamp}.{corpo}, com
anti-replay. O re-dispatch de lote apaga os dois headers.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Criação de canal Datafy com descoberta automática

Fecha o caminho de configuração: o admin cola o `sk_live_…` e o `whsec_…`, e o sistema descobre `phone_number_id`, `waba_id` e `business_id` pelo `/me`, sem digitação manual.

**Files:**
- Modify: `supabase/functions/manage-channels/index.ts` (whitelist de `credentials` ~l. 1718-1722; handler `create` ~l. 1563)
- Modify: `src/pages/gestao/Automacao.tsx` (`PROVIDER_LABELS` ~l. 116-121; `AddChannelDialog` ~l. 813-884)
- Modify: `src/types/reserva.ts` (`WhatsAppProvider` ~l. 66; `WhatsAppProviderCapabilities` ~l. 100-110)
- Create: `src/lib/datafy-channel-setup-core.test.ts`
- Create: `supabase/functions/_shared/datafy-channel-setup-core.ts`

**Interfaces:**
- Consumes: Task 3 (`parseDatafyAccount`), Task 5 (adapter registrado).
- Produces:
  - `type DatafyChannelSetupRefusal = "missing_token" | "missing_webhook_secret" | "discovery_failed"` — importado por `manage-channels` para tipar `DATAFY_SETUP_MESSAGE`
  - `decideDatafyChannelSetup(input: { token: string | null | undefined; webhookSecret: string | null | undefined; account: DatafyAccount | null }): { ok: true; credentials: { access_token: string; phone_number_id: string; business_account_id: string | null } } | { ok: false; reason: DatafyChannelSetupRefusal }`
  - `manage-channels` passa a aceitar `body.webhook_secret` no `create` (usado só por `datafy`; ignorado nos demais providers, que geram o próprio)

- [ ] **Step 1: Escrever o teste que falha**

Cria `src/lib/datafy-channel-setup-core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { decideDatafyChannelSetup } from "../../supabase/functions/_shared/datafy-channel-setup-core.ts";

const account = {
  clienteId: "cli_1", phoneNumberId: "123", wabaId: "456", businessId: "789",
};

describe("decideDatafyChannelSetup", () => {
  it("monta credenciais a partir da descoberta, sem digitação manual de id", () => {
    const verdict = decideDatafyChannelSetup({
      token: "sk_live_x", webhookSecret: "whsec_y", account,
    });
    if (verdict.ok === false) throw new Error(`esperava ok, veio ${verdict.reason}`);
    expect(verdict.credentials).toEqual({
      access_token: "sk_live_x", phone_number_id: "123", business_account_id: "456",
    });
  });

  it("recusa sem token", () => {
    for (const token of [null, "", "  "]) {
      const v = decideDatafyChannelSetup({ token, webhookSecret: "whsec_y", account });
      expect(v.ok).toBe(false);
      if (v.ok === false) expect(v.reason).toBe("missing_token");
    }
  });

  // A Datafy responde 403 a webhook_configuration: o secret é colado à mão.
  // Sem ele o canal nasceria aceitando qualquer POST assinado por ninguém.
  it("exige o webhook_secret na criação, porque a Datafy não configura webhook por API", () => {
    const v = decideDatafyChannelSetup({ token: "sk_live_x", webhookSecret: null, account });
    expect(v.ok).toBe(false);
    if (v.ok === false) expect(v.reason).toBe("missing_webhook_secret");
  });

  it("recusa quando a descoberta falhou, em vez de criar canal sem âncora de identidade", () => {
    const v = decideDatafyChannelSetup({ token: "sk_live_x", webhookSecret: "whsec_y", account: null });
    expect(v.ok).toBe(false);
    if (v.ok === false) expect(v.reason).toBe("discovery_failed");
  });

  it("aceita waba ausente: só o phone_number_id é âncora obrigatória", () => {
    const v = decideDatafyChannelSetup({
      token: "sk_live_x", webhookSecret: "whsec_y",
      account: { ...account, wabaId: null },
    });
    if (v.ok === false) throw new Error("esperava ok");
    expect(v.credentials.business_account_id).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm run test -- src/lib/datafy-channel-setup-core.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar núcleo, whitelist e UI**

Cria `supabase/functions/_shared/datafy-channel-setup-core.ts`:

```ts
import type { DatafyAccount } from "./datafy-client.ts";

export type DatafyChannelSetupRefusal =
  | "missing_token"
  | "missing_webhook_secret"
  | "discovery_failed";

export type DatafyChannelSetup =
  | { ok: true; credentials: { access_token: string; phone_number_id: string; business_account_id: string | null } }
  | { ok: false; reason: DatafyChannelSetupRefusal };

/**
 * A Datafy responde 403 a `webhook_configuration`, então a URL e o segredo são
 * colados à mão no painel dela. Exigir o `whsec_` já na criação é o que impede
 * um canal de nascer sem a única prova de autenticidade que ele terá.
 *
 * `phone_number_id` é obrigatório porque é a âncora da guarda cross-tenant;
 * `waba_id` é opcional aqui e só vira obrigatório na Fase F (templates).
 */
export function decideDatafyChannelSetup(input: {
  token: string | null | undefined;
  webhookSecret: string | null | undefined;
  account: DatafyAccount | null;
}): DatafyChannelSetup {
  const token = input.token?.trim();
  if (!token) return { ok: false, reason: "missing_token" };
  if (!input.webhookSecret?.trim()) return { ok: false, reason: "missing_webhook_secret" };
  if (!input.account?.phoneNumberId) return { ok: false, reason: "discovery_failed" };
  return {
    ok: true,
    credentials: {
      access_token: token,
      phone_number_id: input.account.phoneNumberId,
      business_account_id: input.account.wabaId,
    },
  };
}
```

Em `manage-channels/index.ts`:

**(a)** A allowlist de provider na l. 1614 rejeita `datafy` hoje:

```ts
      if (!provider || !["zapi", "waha", "official", "datafy"].includes(provider)) {
        return jsonResponse(req, { error: "Provedor inválido." }, 400);
      }
```

**(b)** O `webhook_secret` diverge. Para Z-API/WAHA/Meta **nós geramos** o segredo (l. 1648-1650) e o provedor o repete de volta. A Datafy **emite o dela** (`whsec_…`) e assina com ela — gerar um nosso faria toda entrega ser recusada, com o canal parecendo configurado. Substitua o bloco da l. 1647-1650 por:

```ts
      // Z-API/WAHA/Meta: nós emitimos o segredo e o provedor o repete de volta.
      // Datafy: ELA emite o `whsec_` e assina com ele — gerar um nosso faria
      // toda entrega ser recusada, com o canal parecendo configurado.
      let webhookSecret: string;
      let datafyCredentials: ChannelCredentials | null = null;

      if (provider === "datafy") {
        let account = null;
        try {
          const response = await getWhatsAppProvider("datafy").cloudApiRequest!(
            { access_token: String(credentials.access_token ?? "") },
            { method: "GET", path: "me" },
          );
          account = response.status >= 200 && response.status < 300
            ? parseDatafyAccount(response.body)
            : null;
        } catch (error) {
          console.error("manage-channels:create datafy discovery", error);
        }

        const setup = decideDatafyChannelSetup({
          token: String(credentials.access_token ?? ""),
          webhookSecret: String(body.webhook_secret ?? ""),
          account,
        });
        if (setup.ok === false) {
          return jsonResponse(req, { error: DATAFY_SETUP_MESSAGE[setup.reason] }, 400);
        }
        datafyCredentials = setup.credentials;
        webhookSecret = String(body.webhook_secret).trim();
      } else {
        webhookSecret = Array.from(
          crypto.getRandomValues(new Uint8Array(32))
        ).map((b) => b.toString(16).padStart(2, "0")).join("");
      }
```

E no insert (l. 1656-1657), use as credenciais descobertas quando houver:

```ts
          provider,
          credentials: datafyCredentials ?? credentials,
```

**(c)** Perto do topo do arquivo, junto das outras constantes de mensagem, acrescente as três mensagens PT-BR — curtas e para o cliente, nunca `error.message` cru do Postgres:

```ts
const DATAFY_SETUP_MESSAGE: Record<DatafyChannelSetupRefusal, string> = {
  missing_token: "Informe o token da Datafy (começa com sk_live_).",
  missing_webhook_secret:
    "Informe o segredo do webhook da Datafy (começa com whsec_). Ele aparece na aba Webhooks do número, no painel da Datafy.",
  discovery_failed:
    "Não foi possível validar o token na Datafy. Confira se ele está correto e se a assinatura está ativa.",
};
```

**(d)** A whitelist de `credentials` (l. ~1718-1722) já contém `access_token`, `phone_number_id` e `business_account_id`. Confirme e **não** acrescente `app_secret` para `datafy` — ela não usa, e aceitar a chave daria a impressão de que o HMAC da Meta se aplica.

**(e)** `checkChannelConnectionAllowance(unitId, provider, credentials)` (l. 1623) roda para todo provider. Confirme em [`_shared/whatsapp-connection-allowance-core.ts`](../../../supabase/functions/_shared/whatsapp-connection-allowance-core.ts) que a decisão não ramifica por nome de provider; se ramificar, `datafy` entra na mesma classe de `official`.

Em `src/types/reserva.ts`, acrescente `"datafy"` a `WhatsAppProvider` (l. 66) e os seis campos novos a `WhatsAppProviderCapabilities` (l. 100-110), espelhando a Task 1.

Em `src/pages/gestao/Automacao.tsx`, acrescente o label e o ramo de campos:

```tsx
const PROVIDER_LABELS: Record<WhatsAppProvider, string> = {
  zapi: "Z-API",
  uazapi: "UazAPI",
  waha: "WAHA (self-hosted)",
  official: "API Oficial (Meta)",
  datafy: "Datafy (API Oficial)",
};
```

E no `AddChannelDialog`, ao lado dos ramos `zapi`/`waha`/`official`:

```tsx
{provider === "datafy" && (
  <>
    <div className="space-y-2">
      <Label htmlFor="datafy-token">Token da Datafy</Label>
      <Input
        id="datafy-token"
        type="password"
        placeholder="sk_live_..."
        value={credentials.access_token ?? ""}
        onChange={(e) => setCredentials({ ...credentials, access_token: e.target.value })}
      />
      <p className="text-xs text-muted-foreground">
        O número, o WABA e o Business ID são descobertos automaticamente por este token.
      </p>
    </div>
    <div className="space-y-2">
      <Label htmlFor="datafy-whsec">Segredo do webhook</Label>
      <Input
        id="datafy-whsec"
        type="password"
        placeholder="whsec_..."
        value={webhookSecret}
        onChange={(e) => setWebhookSecret(e.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        A Datafy não permite configurar o webhook pela API. Depois de criar o canal,
        copie a URL exibida e cole na aba Webhooks do número, no painel da Datafy.
      </p>
    </div>
  </>
)}
```

O `AddChannelDialog` precisa de um estado `webhookSecret` (`useState("")`) enviado no corpo do `create` como `webhook_secret`; para os outros providers ele vai vazio e é ignorado.

- [ ] **Step 4: Rodar e ver passar**

```bash
npm run test -- src/lib/datafy-channel-setup-core.test.ts
npm run test
npm run typecheck
npm run lint
```

Expected: PASS em tudo, zero erros de tipo, zero erros de lint.

- [ ] **Step 5: Deploy, verificação real e commit**

Redeploy obrigatório (mudou `_shared/whatsapp-provider-core.ts` e `_shared/whatsapp-providers.ts`, que não compartilham bundle em runtime):

```bash
npx supabase functions deploy webhook-whatsapp
npx supabase functions deploy manage-channels
npx supabase functions deploy send-whatsapp
npx supabase functions deploy send-confirmation
npx supabase functions deploy send-cancellation
npx supabase functions deploy send-manual-message
npx supabase functions deploy whatsapp-health
npx supabase functions deploy manage-organizations
npx supabase functions deploy process-whatsapp-channel-health
```

**VALIDAÇÃO REAL COM PROVIDER PENDENTE.** Com credencial real, nesta ordem, registrando o resultado no PR:

1. `GET https://cloud.datafyapi.com.br/me` com `Authorization: Bearer sk_live_…` → conferir se os quatro campos têm os nomes que `parseDatafyAccount` espera.
2. Criar o canal pelo painel; conferir que `phone_number_id` foi descoberto e que nenhum id foi digitado.
3. Colar a URL `…/webhook-whatsapp?channel=<id>` no painel da Datafy e enviar uma mensagem real ao número. Conferir em `webhook_executions` o `outcome`, e **instrumentar forma, nunca valor** (nomes de campo e `typeof`, via `webhook-payload-shape-core.ts`).
4. Enviar um texto pelo canal e conferir que `notifications_sent.provider_message_id` recebeu um `wamid.`.
5. Conferir que um recibo de status chegou e preencheu `delivered_at`.

Só depois desses cinco itens a capability pode ser anunciada como funcional. Até lá o canal não recebe `is_active = true`.

```bash
git add supabase/functions/_shared/datafy-channel-setup-core.ts supabase/functions/manage-channels/index.ts src/lib/datafy-channel-setup-core.test.ts src/types/reserva.ts src/pages/gestao/Automacao.tsx
git commit -m "feat(datafy): criação de canal com descoberta automática de IDs

O admin cola sk_live_ e whsec_; phone_number_id, waba_id e business_id
vêm do /me. Nenhum id é digitado.

O whsec_ é exigido já na criação porque a Datafy responde 403 a
webhook_configuration — a URL é colada à mão no painel dela, e sem o
segredo o canal nasceria sem a única prova de autenticidade que tem.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Notas de execução

**Redeploy:** este plano altera `_shared/whatsapp-provider-core.ts` e `_shared/whatsapp-providers.ts`. Pelo checklist do `CLAUDE.md`, isso obriga redeploy de `webhook-whatsapp`, `send-whatsapp`, `send-confirmation`, `send-cancellation`, `send-manual-message`, `manage-channels`, `whatsapp-health`, `manage-organizations` e `process-whatsapp-channel-health`. Deploy parcial deixa parser, envio ou status divergentes entre funções.

**Gates antes do merge:** `npm run test`, `npm run typecheck`, `npm run lint`, e — porque a Task 4 traz migration e a Task 5 toca webhook e autenticação — os agentes `saas-shield-br:migration-validator`, `saas-shield-br:tenant-isolation-auditor` e `saas-shield-br:integration-reliability-auditor`. Conferir o check `acl-estatico` na aba Checks do PR antes de mergear.

**O que este plano deliberadamente NÃO faz:** nenhum canal existente muda de provider; nenhuma unidade é migrada; `is_active` para um canal Datafy continua gateado pelo trigger de paridade de eco que já existe. A ingestão assíncrona (Fase C) é pré-requisito para ativar um canal Datafy **com agente de IA** — o orçamento de 20 s da Datafy não comporta o pipeline síncrono atual. Até a Fase C, um canal Datafy só deve ser ativado para envio e recebimento sem IA.

**Atualização de `CLAUDE.md` e `AGENTS.md`:** ao fim da Task 5, os dois arquivos ganham, no mesmo commit, a regra de que quem decide forma de payload pergunta a `isMetaShapedProvider` e nunca compara com `"official"`, e a linha de redeploy acima.
