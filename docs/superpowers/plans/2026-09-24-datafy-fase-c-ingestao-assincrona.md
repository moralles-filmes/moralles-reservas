# Fase C — Ingestão assíncrona do webhook de WhatsApp: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o `webhook-whatsapp` responder HTTP 200 em menos de 1 s, movendo debounce, agente de IA e envio para fora da requisição do provider, atrás de um gate que nasce desligado.

**Architecture:** O webhook persiste o corpo **cru** numa fila durável (`whatsapp_inbound_events`) logo depois da guarda de identidade, responde 200, e dispara o processamento por `EdgeRuntime.waitUntil`, que **re-entra no próprio `handleWebhookRequest`** pelo mecanismo já usado em produção nos lotes Meta. Um `pg_cron` de 1 minuto chama a mesma função com `?sweep=1` só para recuperar o que o caminho rápido perdeu. Toda decisão que esta fase inventa vive num núcleo puro testado por vitest; as ~1.900 linhas do pipeline não se movem.

**Tech Stack:** Deno (Supabase Edge Functions) · PostgreSQL 15 + `pg_cron` + `pg_net` + Vault · TypeScript · vitest · Supabase CLI

**Spec:** [docs/superpowers/specs/2026-09-24-datafy-fase-c-ingestao-assincrona-design.md](../specs/2026-09-24-datafy-fase-c-ingestao-assincrona-design.md)

## Global Constraints

- **Branch e worktree:** todo trabalho em `.claude/worktrees/datafy-fase-c`, branch `feat/datafy-fase-c-ingestao-assincrona`. Nunca tocar nas outras cinco worktrees.
- **Migrations:** numeração `_111_`, `_112_`, `_113_`, timestamp **> `20260922170000`**. Idempotentes. Aplicar **sempre** por `supabase db push`, nunca colar no Studio.
- **Migration nunca embute segredo nem a URL do projeto.** `internal_api_key` e `project_url` vêm do Vault; header montado por concatenação.
- **Toda função SQL nova:** `revoke all on function <assinatura completa> from public, anon, authenticated;` antes de conceder ao papel mínimo.
- **Tabela nova:** `enable row level security` + `force row level security`, **sem policies**, e carrega `unit_id`.
- **Typecheck é `npm run typecheck` (= `tsc -b --noEmit`).** Nunca `tsc --noEmit` sem `-b`.
- **`tsconfig.app.json` tem `strict: false`:** em união discriminada use `x.ok === false` ou early-return, nunca `if (!x.ok) { x.campo }`.
- **O gate nasce OFF nas duas pernas** e é fail-closed: flag ausente = OFF, coluna ausente/erro de leitura = **503**, nunca "OFF".
- **Ordem de deploy:** `supabase db push` **antes** de `supabase functions deploy webhook-whatsapp`. Invertido, o gate lê coluna inexistente → 400 do PostgREST → 503 em todo inbound de todo canal.
- **Redeploy:** `whatsapp-inbound-queue-core.ts` → `webhook-whatsapp`. `ai-providers.ts` → `webhook-whatsapp` **e** `manage-ai-providers`.
- **Instrumentação de payload/headers de provider: nome de campo e `typeof`, NUNCA valor.**
- **Commits:** `git add <caminho>` explícito, nunca `git add .`. Terminar com `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## Review Focus

Cinco classes de entrada que a spec implica e que nenhum caminho feliz exercita. Cada uma tem teste designado na task que é dona do código.

1. **Corpo cru contendo `\u0000`.** Postgres recusa NUL em coluna `text` (`22021`). Um inbound com NUL faria o INSERT falhar → 503 → a Datafy reentrega 3× → morre. Esperado: o corpo é persistido de forma que sobreviva íntegro e o NUL não derrube o insert. → **Task 2 (coluna) e Task 4 (teste)**.
2. **`delivery_id` presente mas vazio ou só espaço.** O unique parcial é `where delivery_id is not null`; `''` não é null, então duas entregas diferentes com header vazio colidiriam e a segunda seria descartada como duplicata. Esperado: vazio normaliza para `null`. → **Task 1 (núcleo) e Task 2 (CHECK)**.
3. **Re-entrada a partir da fila tentando persistir de novo.** Laço infinito de eventos. Esperado: impossível por construção, com **controle positivo** — remover a guarda faz o teste falhar. → **Task 1 e Task 5**.
4. **Canal apagado entre o insert e o processamento.** A FK é `on delete cascade`, então a linha some; mas um `waitUntil` em curso pode estar segurando-a. Esperado: o processamento falha de forma limpa, sem deixar lease preso nem estourar exceção não tratada. → **Task 2 (pré-voo INBOUND-6) e Task 5 (`queued_event_vanished`)**.
5. **Mistura de fontes de relógio no lease.** `claimed_until` é escrito pelo banco (`now()`) e comparado no Deno (`Date.now()`). Ambos UTC, mas uma das duas pontas trocada por relógio local reabre o defeito de borda que este repo já pagou em `availability.ts`. Esperado: a comparação de expiração acontece **no banco**, numa única fonte. → **Task 6**.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `supabase/functions/_shared/whatsapp-inbound-queue-core.ts` (**novo**) | Toda decisão que a Fase C inventa: modo de ingestão, veredito do ACK, backoff, dead, deadline, chave de dedupe. Puro, sem I/O. |
| `src/lib/whatsapp-inbound-queue-core.test.ts` (**novo**) | vitest do núcleo, com controles positivos. |
| `supabase/migrations/20260924120000_111_whatsapp_inbound_events.sql` (**novo**) | Tabela, coluna `async_ingestion_enabled`, flag semeada OFF, índices, RLS. |
| `supabase/migrations/20260924120100_112_inbound_sweep_trigger.sql` (**novo**) | Wrapper `SECURITY DEFINER` lendo Vault. **Não agenda.** |
| `supabase/migrations/20260924120200_113_inbound_claim_rpc.sql` (**novo**) | RPCs `claim_whatsapp_inbound_events` e `purge_whatsapp_inbound_events`. |
| `supabase/migrations/20260924120300_114_cron_inbound_sweep.sql` (**novo**) | `cron.schedule` da varredura. **Criada por último**, só depois do exercício manual. |

**A numeração é a ordem de aplicação e não é arbitrária:** `db push` aplica por timestamp, então o `cron.schedule` tem de ser o MAIOR. Agendar antes da RPC de claim existir faria a varredura rodar chamando função inexistente, e `pg_net` é fire-and-forget — falharia em silêncio, visível só em `net._http_response`.
| `supabase/functions/webhook-whatsapp/index.ts` (**modificar**) | Insert + ACK, `waitUntil`, modo fila, branch `?sweep=1`, handoff de deadline. |
| `supabase/functions/_shared/ai-providers.ts` (**modificar**) | `shouldContinue?` opcional em `AgentLoopOptions`, checado nos três runners. |
| `supabase/functions/whatsapp-health/index.ts` (**modificar**) | Contagem de `dead` por unidade no diagnóstico. |
| `supabase/tests/local-preflight/16-inbound-events-111.sql` (**novo**) | Comportamento de CHECK, FK, unique parcial e idempotência. |
| `supabase/tests/local-preflight/17-controles-111.sql` (**novo**) | Controles positivos do pré-voo. |
| `supabase/config.toml` (**modificar**) | `[edge_runtime] policy = "per_worker"` para exercitar `waitUntil` local. |
| `CLAUDE.md` / `AGENTS.md` (**modificar**) | Regras permanentes, no mesmo commit. |

---

## Task 1: Núcleo puro de decisão

**Files:**
- Create: `supabase/functions/_shared/whatsapp-inbound-queue-core.ts`
- Test: `src/lib/whatsapp-inbound-queue-core.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `decideIngestionMode`, `decideAckVerdict`, `normalizeDeliveryId`, `deliveryDedupeKey`, `nextAttemptDelayMs`, `agentDeadlineVerdict`, `lockTtlSecondsRequired`, e as constantes `INBOUND_RETRY_DELAYS_MS`, `INBOUND_MAX_ATTEMPTS`, `INBOUND_LEASE_TTL_MS`, `AGENT_SOFT_DEADLINE_MS`, `WORST_SINGLE_TURN_MS`, `POST_LOOP_SEND_MS`, `PURGE_DONE_AFTER_DAYS`, `PURGE_DEAD_AFTER_DAYS`. Tipos `IngestionSource`, `IngestionMode`, `AckVerdict`, `InsertOutcome`.

- [ ] **Step 1: Escrever os testes que falham**

Criar `src/lib/whatsapp-inbound-queue-core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  decideIngestionMode,
  decideAckVerdict,
  normalizeDeliveryId,
  deliveryDedupeKey,
  nextAttemptDelayMs,
  agentDeadlineVerdict,
  lockTtlSecondsRequired,
  INBOUND_RETRY_DELAYS_MS,
  INBOUND_MAX_ATTEMPTS,
  AGENT_SOFT_DEADLINE_MS,
} from "../../supabase/functions/_shared/whatsapp-inbound-queue-core.ts";

describe("decideIngestionMode — as duas pernas do gate, fail-closed", () => {
  it("async só quando origem é provider E flag ON E canal ON", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: true, flagReadFailed: false, channelEnabled: true,
    })).toBe("async");
  });

  it("flag OFF mantém o caminho síncrono de hoje", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: false, flagReadFailed: false, channelEnabled: true,
    })).toBe("sync");
  });

  it("canal não optado mantém o caminho síncrono, mesmo com a flag global ON", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: true, flagReadFailed: false, channelEnabled: false,
    })).toBe("sync");
  });

  it("coluna ausente (null/undefined) é tratada como não optada", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: true, flagReadFailed: false, channelEnabled: null,
    })).toBe("sync");
    expect(decideIngestionMode({
      source: "provider", flagEnabled: true, flagReadFailed: false, channelEnabled: undefined,
    })).toBe("sync");
  });

  it("falha ao LER a flag não vira OFF: devolve unknown, que o caller transforma em 503", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: false, flagReadFailed: true, channelEnabled: true,
    })).toBe("unknown");
  });

  // CONTROLE POSITIVO do anti-laço (Review Focus #3). Se alguém remover a
  // checagem de `source`, este teste falha — é o único guardião contra
  // reinserção infinita de eventos.
  it("origem 'queue' NUNCA é async, ainda que as duas pernas do gate estejam ON", () => {
    expect(decideIngestionMode({
      source: "queue", flagEnabled: true, flagReadFailed: false, channelEnabled: true,
    })).toBe("sync");
  });

  it("origem 'sweep' NUNCA é async", () => {
    expect(decideIngestionMode({
      source: "sweep", flagEnabled: true, flagReadFailed: false, channelEnabled: true,
    })).toBe("sync");
  });
});

describe("decideAckVerdict — 200 é 'está durável ou foi descartado'; 503 é 'não guardei'", () => {
  it("modo sync não opina sobre o ACK: o pipeline de hoje decide", () => {
    expect(decideAckVerdict({ mode: "sync", insert: "skipped" }))
      .toEqual({ kind: "passthrough" });
  });

  it("inserido devolve 200", () => {
    expect(decideAckVerdict({ mode: "async", insert: "inserted" }))
      .toEqual({ kind: "ack", status: 200, outcome: "queued" });
  });

  it("entrega duplicada devolve 200 sem reprocessar", () => {
    expect(decideAckVerdict({ mode: "async", insert: "duplicate" }))
      .toEqual({ kind: "ack", status: 200, outcome: "queue_duplicate_delivery" });
  });

  it("INSERT que falhou devolve 503 — jamais 200, que apagaria o inbound", () => {
    expect(decideAckVerdict({ mode: "async", insert: "failed" }))
      .toEqual({ kind: "retry", status: 503, outcome: "queue_insert_failed" });
  });

  it("gate ilegível devolve 503, não passthrough", () => {
    expect(decideAckVerdict({ mode: "unknown", insert: "skipped" }))
      .toEqual({ kind: "retry", status: 503, outcome: "queue_gate_unreadable" });
  });
});

describe("normalizeDeliveryId — vazio não pode virar chave de dedupe (Review Focus #2)", () => {
  it("string normal passa", () => {
    expect(normalizeDeliveryId("d290f1ee-6c54-4b01-90e6-d701748f0851"))
      .toBe("d290f1ee-6c54-4b01-90e6-d701748f0851");
  });

  it("vazio, espaço e null viram null", () => {
    expect(normalizeDeliveryId("")).toBeNull();
    expect(normalizeDeliveryId("   ")).toBeNull();
    expect(normalizeDeliveryId(null)).toBeNull();
    expect(normalizeDeliveryId(undefined)).toBeNull();
  });

  it("apara espaço nas bordas em vez de gravar a versão suja", () => {
    expect(normalizeDeliveryId("  abc  ")).toBe("abc");
  });

  it("id absurdamente longo é recusado em vez de estourar a coluna", () => {
    expect(normalizeDeliveryId("x".repeat(513))).toBeNull();
  });
});

describe("deliveryDedupeKey — só a Datafy declara id de entrega hoje", () => {
  const get = (map: Record<string, string>) => (name: string) => map[name.toLowerCase()] ?? null;

  it("datafy lê x-datafy-delivery-id", () => {
    expect(deliveryDedupeKey("datafy", get({ "x-datafy-delivery-id": "abc" }))).toBe("abc");
  });

  it("providers legados não têm id de entrega: processed_messages segue a autoridade", () => {
    for (const p of ["zapi", "waha", "uazapi", "official"]) {
      expect(deliveryDedupeKey(p, get({ "x-datafy-delivery-id": "abc" }))).toBeNull();
    }
  });

  it("datafy sem o header devolve null em vez de inventar chave", () => {
    expect(deliveryDedupeKey("datafy", get({}))).toBeNull();
  });
});

describe("nextAttemptDelayMs — curto e raso: resposta atrasada é resposta errada", () => {
  it("segue a escada declarada", () => {
    expect(nextAttemptDelayMs(0)).toBe(INBOUND_RETRY_DELAYS_MS[0]);
    expect(nextAttemptDelayMs(1)).toBe(INBOUND_RETRY_DELAYS_MS[1]);
    expect(nextAttemptDelayMs(2)).toBe(INBOUND_RETRY_DELAYS_MS[2]);
  });

  it("esgotadas as tentativas devolve null, que significa dead", () => {
    expect(nextAttemptDelayMs(INBOUND_MAX_ATTEMPTS)).toBeNull();
    expect(nextAttemptDelayMs(99)).toBeNull();
  });

  // CONTROLE POSITIVO: a janela total é curta DE PROPÓSITO. Se alguém
  // reintroduzir a escada de horas do notification_outbox, este teste falha.
  it("a janela total fica abaixo de 10 minutos", () => {
    const total = INBOUND_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(10 * 60_000);
  });
});

describe("agentDeadlineVerdict — suave: não começa rodada nova, não aborta a em curso", () => {
  it("dentro do orçamento, continua", () => {
    expect(agentDeadlineVerdict({ startedAt: 1_000, now: 1_000 + AGENT_SOFT_DEADLINE_MS - 1 }))
      .toBe("continue");
  });

  it("no limite exato, para de começar rodada nova", () => {
    expect(agentDeadlineVerdict({ startedAt: 1_000, now: 1_000 + AGENT_SOFT_DEADLINE_MS }))
      .toBe("stop_new_rounds");
  });

  it("relógio andando para trás não libera orçamento infinito", () => {
    expect(agentDeadlineVerdict({ startedAt: 5_000, now: 1_000 })).toBe("continue");
  });
});

describe("lockTtlSecondsRequired — o TTL do lock deixa de ser adivinhado", () => {
  // Este é o teste que fecha o achado da medição: AI_LOCK_TTL_SECONDS = 90
  // foi dimensionado contra "~51s de pior caso do runOnce", que era pior caso
  // de UM turno, não do loop. Se alguém subir o orçamento sem subir o TTL,
  // isto falha.
  it("a aritmética cabe no TTL de 90 s que o webhook usa hoje", () => {
    expect(lockTtlSecondsRequired()).toBeLessThanOrEqual(90);
  });

  it("subir o orçamento sem subir o TTL é detectável", () => {
    expect(lockTtlSecondsRequired({ budgetMs: 300_000 })).toBeGreaterThan(90);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

```bash
npm run test -- src/lib/whatsapp-inbound-queue-core.test.ts
```

Esperado: FAIL — `Failed to resolve import ".../whatsapp-inbound-queue-core.ts"`.

- [ ] **Step 3: Implementar o núcleo**

Criar `supabase/functions/_shared/whatsapp-inbound-queue-core.ts`:

```ts
/**
 * Núcleo puro da ingestão assíncrona (Fase C).
 *
 * TODA decisão que a Fase C inventa mora aqui, e não no `index.ts` do
 * `webhook-whatsapp`: o vitest não importa aquela Edge Function (`serve()` no
 * carregamento + imports de `deno.land`), e regra que só se confere por
 * leitura já passou defeito duas vezes neste repo.
 *
 * Sem I/O, sem `Deno`, sem cliente Supabase. Só decisão.
 */

/** De onde veio a invocação. NÃO é o provider — é a porta de entrada. */
export type IngestionSource = "provider" | "queue" | "sweep";

/**
 * `unknown` NÃO é "não sei, então OFF". É "não consigo afirmar", e o caller
 * traduz em 503. Tratar leitura falha de gate como OFF processaria síncrono e
 * estouraria o orçamento do provider sem deixar rastro.
 */
export type IngestionMode = "async" | "sync" | "unknown";

export type InsertOutcome = "inserted" | "duplicate" | "failed" | "skipped";

export type AckVerdict =
  | { kind: "passthrough" }
  | { kind: "ack"; status: 200; outcome: string }
  | { kind: "retry"; status: 503; outcome: string };

/** Escada de retentativa da fila. Curta e rasa de propósito — ver header. */
export const INBOUND_RETRY_DELAYS_MS = [30_000, 120_000, 300_000] as const;
export const INBOUND_MAX_ATTEMPTS = INBOUND_RETRY_DELAYS_MS.length;

/** TTL do lease da linha. Espelha o takeover de `processed_messages`. */
export const INBOUND_LEASE_TTL_MS = 90_000;

/** Orçamento do deadline suave, contado do início do PROCESSAMENTO. */
export const AGENT_SOFT_DEADLINE_MS = 30_000;
/** Pior turno único medido: Gemini primary (12s+backoff) + fallback (12s+backoff). */
export const WORST_SINGLE_TURN_MS = 31_000;
/** Folga para sanitização, envio e append depois do loop. */
export const POST_LOOP_SEND_MS = 5_000;

export const PURGE_DONE_AFTER_DAYS = 7;
export const PURGE_DEAD_AFTER_DAYS = 30;

const MAX_DELIVERY_ID_LEN = 512;

/**
 * As DUAS pernas do gate, mais a guarda anti-laço.
 *
 * `source !== "provider"` é a única coisa que impede a re-entrada a partir da
 * fila de persistir o evento de novo — laço infinito, o defeito mais perigoso
 * disponível neste desenho. Ele vive aqui, e não como um `if` solto no
 * handler, justamente para ter teste com controle positivo.
 */
export function decideIngestionMode(input: {
  source: IngestionSource;
  flagEnabled: boolean;
  flagReadFailed: boolean;
  channelEnabled: boolean | null | undefined;
}): IngestionMode {
  if (input.source !== "provider") return "sync";
  if (input.flagReadFailed) return "unknown";
  if (!input.flagEnabled) return "sync";
  if (input.channelEnabled !== true) return "sync";
  return "async";
}

/**
 * Régua herdada do `asaas-webhook`, adaptada ao contrato da Datafy:
 * 200 = já está durável ou foi descartado de propósito;
 * não-200 = não consegui guardar, reentrega.
 */
export function decideAckVerdict(input: {
  mode: IngestionMode;
  insert: InsertOutcome;
}): AckVerdict {
  if (input.mode === "unknown") {
    return { kind: "retry", status: 503, outcome: "queue_gate_unreadable" };
  }
  if (input.mode === "sync") return { kind: "passthrough" };
  if (input.insert === "inserted") {
    return { kind: "ack", status: 200, outcome: "queued" };
  }
  if (input.insert === "duplicate") {
    return { kind: "ack", status: 200, outcome: "queue_duplicate_delivery" };
  }
  return { kind: "retry", status: 503, outcome: "queue_insert_failed" };
}

/**
 * String vazia NÃO pode virar chave de dedupe: o unique é parcial
 * (`where delivery_id is not null`) e `''` não é null, então duas entregas
 * distintas com header vazio colidiriam e a segunda sumiria como "duplicata".
 */
export function normalizeDeliveryId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_DELIVERY_ID_LEN) return null;
  return trimmed;
}

/**
 * Só a Datafy declara id de entrega hoje. Providers legados não têm, e para
 * eles `processed_messages (provider, message_id)` segue sendo a autoridade
 * de idempotência — exatamente como já é.
 */
export function deliveryDedupeKey(
  provider: string,
  headerGet: (name: string) => string | null,
): string | null {
  if (provider !== "datafy") return null;
  return normalizeDeliveryId(headerGet("x-datafy-delivery-id"));
}

/** `null` significa: esgotou, promove para `dead`. */
export function nextAttemptDelayMs(attempts: number): number | null {
  if (!Number.isFinite(attempts) || attempts < 0) return null;
  if (attempts >= INBOUND_MAX_ATTEMPTS) return null;
  return INBOUND_RETRY_DELAYS_MS[attempts];
}

/**
 * Suave: impede COMEÇAR nova rodada de ferramenta, nunca aborta a em curso.
 * Abortar depois de `create_reservation` deixaria reserva criada e cliente sem
 * resposta — o risco que o `mutatingToolUsed` de hoje já tenta cobrir.
 */
export function agentDeadlineVerdict(input: {
  startedAt: number;
  now: number;
  budgetMs?: number;
}): "continue" | "stop_new_rounds" {
  const budget = input.budgetMs ?? AGENT_SOFT_DEADLINE_MS;
  const elapsed = input.now - input.startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return "continue";
  return elapsed >= budget ? "stop_new_rounds" : "continue";
}

/**
 * O TTL do lock de conversa deixa de ser adivinhado.
 *
 * `AI_LOCK_TTL_SECONDS = 90` foi dimensionado contra "~51s de pior caso do
 * runOnce" — que era pior caso de UM turno, não do loop de até 12. Esta função
 * existe para que um teste reprove quem subir o orçamento sem subir o TTL.
 */
export function lockTtlSecondsRequired(input?: { budgetMs?: number }): number {
  const budget = input?.budgetMs ?? AGENT_SOFT_DEADLINE_MS;
  return Math.ceil((budget + WORST_SINGLE_TURN_MS + POST_LOOP_SEND_MS) / 1000);
}
```

- [ ] **Step 4: Rodar até passar**

```bash
npm run test -- src/lib/whatsapp-inbound-queue-core.test.ts
npm run typecheck
npm run lint
```

Esperado: PASS em tudo, zero erro de tipo, zero erro de lint.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/whatsapp-inbound-queue-core.ts src/lib/whatsapp-inbound-queue-core.test.ts
git commit -F - <<'EOF'
feat(whatsapp): nucleo puro de decisao da ingestao assincrona

Modo de ingestao, veredito do ACK, backoff, deadline suave e derivacao do
TTL do lock. Sem I/O: o vitest nao importa webhook-whatsapp/index.ts, entao
regra que mora la so se confere por leitura.

A guarda anti-laco (origem 'queue' nunca e async) vive dentro do nucleo, com
controle positivo, porque reinserir o evento a partir da fila e o defeito mais
perigoso disponivel neste desenho.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: Migration 111 — tabela, coluna, flag

**Files:**
- Create: `supabase/migrations/20260924120000_111_whatsapp_inbound_events.sql`
- Create: `supabase/tests/local-preflight/16-inbound-events-111.sql`
- Create: `supabase/tests/local-preflight/17-controles-111.sql`

**Interfaces:**
- Consumes: constantes de retenção da Task 1 (documentadas no SQL, não importadas).
- Produces: tabela `whatsapp_inbound_events`, coluna `whatsapp_channels.async_ingestion_enabled`, flag `whatsapp_async_ingestion`.

- [ ] **Step 1: Escrever a migration**

Criar `supabase/migrations/20260924120000_111_whatsapp_inbound_events.sql`:

```sql
-- Fase C — fila durável de eventos inbound de WhatsApp.
--
-- UMA LINHA POR ENTREGA, não por parte de lote. O corpo cru fica armazenado
-- uma vez e INTACTO: guardar a parte já dividida seria re-serializar
-- (`JSON.stringify(part)`), o que destrói a capacidade de revalidar a
-- assinatura. O processador divide o lote em memória, e a idempotência POR
-- PARTE já é de `processed_messages (provider, message_id)`.
--
-- `raw_body` é `bytea`, não `text`: Postgres recusa `\u0000` em `text`
-- (SQLSTATE 22021), e um único inbound com NUL faria o INSERT falhar, virar
-- 503, e o provider reentregar até desistir. `bytea` aceita qualquer octeto e
-- devolve o corpo byte a byte — que é exatamente o que a revalidação exige.

create table if not exists whatsapp_inbound_events (
  id                uuid        primary key default gen_random_uuid(),
  provider          text        not null
                    check (provider in ('zapi','uazapi','waha','official','datafy')),
  channel_id        uuid        not null references whatsapp_channels(id) on delete cascade,
  unit_id           uuid        not null references units(id) on delete cascade,
  raw_body          bytea       not null,
  signature_header  text,
  signature_scheme  text,
  delivery_id       text        check (delivery_id is null
                                       or length(btrim(delivery_id)) between 1 and 512),
  received_at       timestamptz not null default now(),
  status            text        not null default 'received'
                    check (status in ('received','processing','done','dead')),
  attempts          integer     not null default 0 check (attempts >= 0),
  next_attempt_at   timestamptz not null default now(),
  claim_id          uuid,
  claimed_until     timestamptz,
  outcome           text,
  last_error        text,
  updated_at        timestamptz not null default now()
);

comment on column whatsapp_inbound_events.raw_body is
  'Corpo CRU da entrega, byte a byte. bytea e nao text porque text recusa \u0000. Nunca re-serializar: a revalidacao de assinatura depende do byte exato.';
comment on column whatsapp_inbound_events.delivery_id is
  'x-datafy-delivery-id. Só a Datafy declara; legados usam processed_messages como autoridade. Vazio normaliza para NULL no caller (o unique e parcial e '''' nao e null).';

-- Dedupe de ENTREGA, escopado por canal: um id de entrega só tem significado
-- dentro do canal que o emitiu.
create unique index if not exists whatsapp_inbound_events_delivery_idx
  on whatsapp_inbound_events (channel_id, delivery_id)
  where delivery_id is not null;

-- Consulta da varredura: due e não-terminal.
create index if not exists whatsapp_inbound_events_due_idx
  on whatsapp_inbound_events (next_attempt_at)
  where status in ('received','processing');

-- Painel: dead por unidade.
create index if not exists whatsapp_inbound_events_unit_status_idx
  on whatsapp_inbound_events (unit_id, status, received_at desc);

alter table whatsapp_inbound_events enable row level security;
alter table whatsapp_inbound_events force row level security;
-- Sem policies: só service_role, via Edge Function. Mesma disciplina de
-- whatsapp_channels, processed_messages e webhook_executions.

-- Opt-in POR CANAL. A linha do canal já é lida antes do ACK, então ler mais
-- esta coluna custa zero I/O. Rollout e rollback de um UPDATE, um canal por vez.
alter table whatsapp_channels
  add column if not exists async_ingestion_enabled boolean not null default false;

comment on column whatsapp_channels.async_ingestion_enabled is
  'Perna por canal do gate da Fase C. A outra e platform_flags.whatsapp_async_ingestion. AS DUAS precisam ser verdadeiras.';

-- Kill-switch global, fail-closed: ausente = OFF.
insert into platform_flags (key, enabled, description)
values (
  'whatsapp_async_ingestion',
  false,
  'Fase C: ingestao assincrona do webhook de WhatsApp. Precisa de async_ingestion_enabled no canal TAMBEM. NAO ligar para provider com trafego real antes do alerta ativo da Fase J (ASYNC_INGESTION_DEADLETTER_ALERT).'
)
on conflict (key) do nothing;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. RLS forçada e sem policies (esperado: relrowsecurity=t, relforcerowsecurity=t, 0 policies):
--   select relrowsecurity, relforcerowsecurity from pg_class
--    where relname = 'whatsapp_inbound_events';
--   select count(*) from pg_policies where tablename = 'whatsapp_inbound_events';
--
-- 2. Flag semeada DESLIGADA (esperado: false):
--   select enabled from platform_flags where key = 'whatsapp_async_ingestion';
--
-- 3. Nenhum canal optado (esperado: 0):
--   select count(*) from whatsapp_channels where async_ingestion_enabled;
```

- [ ] **Step 2: Escrever o pré-voo com controles positivos**

Criar `supabase/tests/local-preflight/16-inbound-events-111.sql`. Ler [supabase/tests/local-preflight/README.md](../../../supabase/tests/local-preflight/README.md) antes: o harness é Postgres local descartável, **sem `pg_cron`/`pg_net`** (as treze migrations legadas com a URL de produção nos wrappers agendariam cron apontando para lá).

**Seguir a convenção dos arquivos existentes** — ver [14-public-code-lookup-109.sql](../../../supabase/tests/local-preflight/14-public-code-lookup-109.sql) como modelo: cabeçalho dizendo o que cada caso mede e por quê, a **ordem de execução** dos arquivos anteriores, e uma **guarda** que faz o arquivo falhar alto se rodado antes da migration que ele testa (sem ela, os casos negativos passariam por acidente, porque a tabela nem existe). Os ids de canal e unidade vêm do seed (`02-seed.sql`), não de literais inventados.

Este arquivo **prova comportamento**: CHECK, FK, unique parcial e idempotência. Ele **não** prova RLS, grants, ACL nem PostgREST — isso exige Supabase de verdade.

```sql
\set ON_ERROR_STOP on
begin;

-- INBOUND-1: corpo com NUL sobrevive (Review Focus #1).
-- Em `text` isto estouraria 22021. Em `bytea`, entra e volta igual.
insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body)
values ('datafy', :'chan', :'unit', convert_to(E'{"a":"b\u0000c"}', 'UTF8'))
returning id as inbound_1 \gset
do $$
declare v bytea;
begin
  select raw_body into v from whatsapp_inbound_events where id = :'inbound_1';
  if octet_length(v) <> octet_length(convert_to(E'{"a":"b\u0000c"}', 'UTF8')) then
    raise exception 'INBOUND-1 FALHOU: corpo com NUL nao voltou byte a byte';
  end if;
end $$;

-- INBOUND-2: dedupe de entrega por canal.
insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
values ('datafy', :'chan', :'unit', convert_to('{}', 'UTF8'), 'dup-1');
do $$
begin
  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', :'chan', :'unit', convert_to('{}', 'UTF8'), 'dup-1');
    raise exception 'INBOUND-2 FALHOU: segunda entrega com o mesmo delivery_id foi aceita';
  exception when unique_violation then null;
  end;
end $$;

-- INBOUND-3: delivery_id NULL não deduplica (legados inserem várias linhas).
insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
values ('zapi', :'chan', :'unit', convert_to('{}', 'UTF8'), null),
       ('zapi', :'chan', :'unit', convert_to('{}', 'UTF8'), null);

-- INBOUND-4: delivery_id vazio é recusado pelo CHECK (Review Focus #2).
do $$
begin
  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', :'chan', :'unit', convert_to('{}', 'UTF8'), '   ');
    raise exception 'INBOUND-4 FALHOU: delivery_id em branco foi aceito';
  exception when check_violation then null;
  end;
end $$;

-- INBOUND-5: provider fora do allowlist é recusado.
do $$
begin
  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body)
    values ('telegram', :'chan', :'unit', convert_to('{}', 'UTF8'));
    raise exception 'INBOUND-5 FALHOU: provider desconhecido foi aceito';
  exception when check_violation then null;
  end;
end $$;

-- INBOUND-6: apagar o canal apaga os eventos (Review Focus #4) — e NÃO
-- aborta o DELETE, que é o defeito que a 089 teve com FK x CHECK.
delete from whatsapp_channels where id = :'chan';
do $$
declare n integer;
begin
  select count(*) into n from whatsapp_inbound_events where channel_id = :'chan';
  if n <> 0 then
    raise exception 'INBOUND-6 FALHOU: % eventos sobreviveram ao DELETE do canal', n;
  end if;
end $$;

rollback;
```

Criar `supabase/tests/local-preflight/17-controles-111.sql` com os controles positivos: reintroduzir cada defeito e provar que o teste reprova. No mínimo — **C-111-1:** trocar `raw_body` para `text` e ver INBOUND-1 falhar. **C-111-2:** remover o `where delivery_id is not null` do unique e ver INBOUND-3 falhar. **C-111-3:** remover o CHECK de `delivery_id` e ver INBOUND-4 falhar. **C-111-4:** trocar `on delete cascade` por `on delete restrict` e ver INBOUND-6 falhar.

- [ ] **Step 3: Rodar o pré-voo e ver os controles reprovarem**

```bash
# Seguir supabase/tests/local-preflight/README.md para subir o Postgres local.
psql "$PREFLIGHT_URL" -f supabase/tests/local-preflight/16-inbound-events-111.sql
psql "$PREFLIGHT_URL" -f supabase/tests/local-preflight/17-controles-111.sql
```

Esperado: `16-*` PASSA inteiro. `17-*` demonstra cada controle reprovando com a mensagem `INBOUND-N FALHOU`, provando que os testes testam algo.

- [ ] **Step 4: Aplicar e conferir**

```bash
npx supabase db push
npx supabase db query "select enabled from platform_flags where key = 'whatsapp_async_ingestion';"
npx supabase db query "select count(*) from pg_policies where tablename = 'whatsapp_inbound_events';"
```

Esperado: flag `false`, zero policies.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260924120000_111_whatsapp_inbound_events.sql supabase/tests/local-preflight/16-inbound-events-111.sql supabase/tests/local-preflight/17-controles-111.sql
git commit -F - <<'EOF'
feat(whatsapp): fila duravel de eventos inbound (migration 111)

Uma linha por ENTREGA, nao por parte de lote: guardar a parte ja dividida
seria re-serializar, destruindo a revalidacao de assinatura.

raw_body e bytea, nao text: Postgres recusa \u0000 em text (22021), e um
unico inbound com NUL viraria 503 em loop ate o provider desistir.

Gate nasce desligado nas duas pernas. FORCE RLS sem policies.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3: Wrapper da varredura no Vault (migration 112)

**Files:**
- Create: `supabase/migrations/20260924120100_112_inbound_sweep_trigger.sql`

**Interfaces:**
- Consumes: nada da Task 1/2 em tempo de compilação.
- Produces: função SQL `public.trigger_whatsapp_inbound_sweep()`.

**Esta migration NÃO agenda.** O agendamento é a 113, separada de propósito: `db push` aplica tudo que está pendente, e com o `cron.schedule` aqui a varredura nasceria automática antes de qualquer execução manual sob observação. É a mesma disciplina de 092/093.

- [ ] **Step 1: Escrever a migration**

```sql
-- Wrapper da varredura de eventos inbound (Fase C).
--
-- ESTA MIGRATION SÓ CRIA A FUNÇÃO. O agendamento é a 113.
--
-- Lê `project_url` E `internal_api_key` do Vault, fail-closed: faltando
-- qualquer um, avisa e retorna sem POST. NÃO há URL de projeto embutida —
-- um banco reconstruído por este histórico não pode agendar cron apontando
-- para PRODUÇÃO. O header se monta por concatenação, nunca literal.
-- Guardrail: scripts/migration-static-guard.test.ts.

create or replace function public.trigger_whatsapp_inbound_sweep()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  api_key text;
  project_url text;
begin
  select decrypted_secret into api_key
  from vault.decrypted_secrets where name = 'internal_api_key' limit 1;

  select decrypted_secret into project_url
  from vault.decrypted_secrets where name = 'project_url' limit 1;

  if api_key is null or api_key = '' then
    raise notice '[whatsapp-inbound-sweep] internal_api_key ausente no Vault — skip';
    return;
  end if;

  if project_url is null or project_url = '' then
    raise notice '[whatsapp-inbound-sweep] project_url ausente no Vault — skip';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/webhook-whatsapp?sweep=1',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-key', api_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

-- CREATE FUNCTION concede EXECUTE a PUBLIC por padrão e o schema public é
-- exposto ao PostgREST com a anon key.
revoke all on function public.trigger_whatsapp_inbound_sweep() from public, anon, authenticated;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. ACL (esperado: sem anon= e sem authenticated=):
--   select proacl from pg_proc where proname = 'trigger_whatsapp_inbound_sweep';
--
-- 2. Nenhum job agendado ainda (esperado: 0 linhas — o agendamento é a 113):
--   select jobname from cron.job where jobname = 'whatsapp-inbound-sweep';
--
-- 3. Segredos presentes (esperado: 2 linhas):
--   select name from vault.decrypted_secrets
--    where name in ('internal_api_key', 'project_url');
```

- [ ] **Step 2: Rodar o guardrail estático**

```bash
npm run test -- scripts/migration-static-guard.test.ts
```

Esperado: PASS. Ele reprova segredo literal e URL de projeto embutida — se falhar, a migration regrediu num dos dois.

- [ ] **Step 3: Aplicar e conferir a ACL**

```bash
npx supabase db push
npx supabase db query "select proacl from pg_proc where proname = 'trigger_whatsapp_inbound_sweep';"
```

Esperado: sem `anon=` e sem `authenticated=`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260924120100_112_inbound_sweep_trigger.sql
git commit -F - <<'EOF'
feat(whatsapp): wrapper da varredura de inbound lendo o Vault (migration 112)

So cria a funcao. O cron.schedule e a 113, separada para que a varredura
possa ser exercitada manualmente antes de rodar sozinha — mesma disciplina
de 092/093.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4: Insert + ACK no webhook

**Files:**
- Modify: `supabase/functions/webhook-whatsapp/index.ts` (após a guarda de identidade, ~linha 1690)
- Test: `src/lib/whatsapp-inbound-queue-core.test.ts` (acrescentar)

**Interfaces:**
- Consumes: `decideIngestionMode`, `decideAckVerdict`, `deliveryDedupeKey` da Task 1; tabela e coluna da Task 2.
- Produces: `persistInboundEvent(...)` local ao `index.ts`; assinatura nova `handleWebhookRequest(req, opts?: HandlerOptions)`.

- [ ] **Step 1: Trocar a assinatura do handler**

Em `supabase/functions/webhook-whatsapp/index.ts`, substituir a assinatura da linha 1418 e o `serve` da linha 3715:

```ts
/**
 * `signatureAlreadyVerified` e `source` são DUAS perguntas, não uma.
 *
 * O antigo `trustedMetaPayload` significava "sou parte filha de um lote cujo
 * pai já validou a assinatura". Reusá-lo para "vim da fila durável" juntaria
 * duas perguntas num sinal — o anti-padrão que este repo já nomeia em
 * `isMetaShapedProvider`. `source` é o que decide persistir ou não; ele é o
 * guardião contra reinserção infinita, e a decisão mora em
 * `decideIngestionMode`, com controle positivo.
 */
interface HandlerOptions {
  signatureAlreadyVerified?: boolean;
  source?: IngestionSource;
  /** Preenchido quando `source !== "provider"`: a linha já existe na fila. */
  queuedEventId?: string;
}

async function handleWebhookRequest(
  req: Request,
  opts: HandlerOptions = {},
): Promise<Response> {
  const trustedMetaPayload = opts.signatureAlreadyVerified === true;
  const ingestionSource: IngestionSource = opts.source ?? "provider";
```

E na linha 3715:

```ts
serve((req) => handleWebhookRequest(req));
```

E no re-despacho de lote (linha 1736-1740), trocar o `true` posicional:

```ts
          return handleWebhookRequest(new Request(req.url, {
            method: "POST",
            headers,
            body: JSON.stringify(part),
          }), { signatureAlreadyVerified: true, source: ingestionSource });
```

Import novo no topo:

```ts
import {
  decideIngestionMode,
  decideAckVerdict,
  deliveryDedupeKey,
  type IngestionSource,
} from "../_shared/whatsapp-inbound-queue-core.ts";
```

- [ ] **Step 2: Acrescentar a codificação do corpo cru ao núcleo, com teste**

O corpo vai para uma coluna `bytea`; o supabase-js manda o literal `\x`-hex. A conversão é pura, então mora no núcleo, com o teste que prova que o NUL sobrevive (Review Focus #1).

Acrescentar a `supabase/functions/_shared/whatsapp-inbound-queue-core.ts`:

```ts
/**
 * Corpo cru → literal `bytea` do Postgres.
 *
 * `bytea` e não `text` porque Postgres recusa `\u0000` em `text` (22021), e um
 * único inbound com NUL faria o INSERT falhar, virar 503, e o provider
 * reentregar até desistir. A revalidação de assinatura exige o byte exato.
 */
export function encodeRawBodyHex(bodyText: string): string {
  const bytes = new TextEncoder().encode(bodyText);
  let hex = "\\x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Inverso de `encodeRawBodyHex`, para a re-entrada a partir da fila. */
export function decodeRawBodyHex(hex: string): string {
  const clean = hex.startsWith("\\x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return new TextDecoder().decode(bytes);
}
```

Acrescentar a `src/lib/whatsapp-inbound-queue-core.test.ts`:

```ts
describe("encodeRawBodyHex — o corpo cru precisa sobreviver byte a byte", () => {
  it("corpo comum vira hex do UTF-8", () => {
    expect(encodeRawBodyHex('{"a":1}')).toBe("\\x7b2261223a317d");
  });

  it("NUL no meio do corpo não quebra e não é descartado (Review Focus #1)", () => {
    expect(encodeRawBodyHex("a\u0000b")).toBe("\\x610062");
  });

  it("acentuação PT-BR sobrevive", () => {
    expect(encodeRawBodyHex("ã")).toBe("\\xc3a3");
  });

  it("round-trip devolve o texto idêntico, inclusive com NUL", () => {
    for (const s of ['{"a":1}', "a\u0000b", "ã é ç", "🍣"]) {
      expect(decodeRawBodyHex(encodeRawBodyHex(s))).toBe(s);
    }
  });
});
```

Acrescentar `encodeRawBodyHex, decodeRawBodyHex` ao import do teste.

- [ ] **Step 3: Escrever o helper de persistência**

Inserir antes de `handleWebhookRequest`, no `index.ts`:

```ts
/** Header que carrega a assinatura, por esquema. Ao lado de WEBHOOK_SIGNATURE_SCHEME. */
const SIGNATURE_HEADER_BY_SCHEME: Record<string, string> = {
  meta_app_secret: "x-hub-signature-256",
  datafy_whsec: "x-datafy-signature-256",
  channel_secret: "x-webhook-secret",
};

/**
 * Persiste a entrega crua. UMA linha por entrega — o split do lote acontece
 * no processamento, sobre este mesmo corpo intacto.
 */
async function persistInboundEvent(input: {
  provider: WhatsAppProvider;
  channelId: string;
  unitId: string;
  bodyText: string;
  deliveryId: string | null;
  signatureHeader: string | null;
  signatureScheme: string | null;
}): Promise<{ outcome: InsertOutcome; id: string | null }> {
  const { data, error } = await supabase
    .from("whatsapp_inbound_events")
    .insert({
      provider: input.provider,
      channel_id: input.channelId,
      unit_id: input.unitId,
      raw_body: encodeRawBodyHex(input.bodyText),
      delivery_id: input.deliveryId,
      signature_header: input.signatureHeader,
      signature_scheme: input.signatureScheme,
    })
    .select("id")
    .maybeSingle();

  if (!error && data) return { outcome: "inserted", id: data.id };
  if (error?.code === "23505") return { outcome: "duplicate", id: null };
  return { outcome: "failed", id: null };
}
```

- [ ] **Step 4: Inserir a fronteira do ACK**

Colocar imediatamente **antes** do `if (isMetaShapedProvider(provider)) { const parts = splitMetaWebhookPayload(payload); ... }` da linha 1728 — ou seja, depois de **todas** as guardas que produzem não-200 (assinatura, identidade Meta, token UazAPI) e antes de **qualquer** trabalho:

```ts
    // ─── Fronteira do ACK (Fase C) ───────────────────────────────────────────
    // Tudo a jusante daqui é diferido em bloco quando o gate está ON: split de
    // lote, callbacks, canal inativo, eco e inbound. Não se recorta "o que é
    // caro": o split do lote produz partes RE-SERIALIZADAS, e guardar isso
    // destruiria a revalidação de assinatura.
    const flagCheck = await checkFlagEnabled("whatsapp_async_ingestion");
    const ingestionMode = decideIngestionMode({
      source: ingestionSource,
      flagEnabled: flagCheck.enabled,
      flagReadFailed: flagCheck.readFailed,
      channelEnabled: channel.async_ingestion_enabled,
    });

    if (ingestionMode !== "sync") {
      let insert: { outcome: InsertOutcome; id: string | null } = { outcome: "skipped", id: null };

      if (ingestionMode === "async") {
        const scheme = WEBHOOK_SIGNATURE_SCHEME[provider];
        const deliveryId = deliveryDedupeKey(provider, (n) => req.headers.get(n));

        // Instrumentação de FORMA, nunca de valor: publicar o id de entrega ou
        // o header de assinatura no log vazaria correlação e credencial. Isto
        // é o que responde a pendência de validação real nº 6 da spec.
        jsonLog("info", {
          requestId,
          evt: "inbound_delivery_shape",
          provider,
          has_delivery_id: deliveryId !== null,
          delivery_id_type: typeof req.headers.get("x-datafy-delivery-id"),
        });

        insert = await persistInboundEvent({
          provider,
          channelId: channelId!,
          unitId: unitId!,
          bodyText,
          deliveryId,
          signatureHeader: req.headers.get(SIGNATURE_HEADER_BY_SCHEME[scheme] ?? "") ?? null,
          signatureScheme: scheme,
        });
      }

      const verdict = decideAckVerdict({ mode: ingestionMode, insert: insert.outcome });
      if (verdict.kind !== "passthrough") {
        await finish(verdict.outcome);
        if (verdict.kind === "ack" && insert.id) {
          // Caminho rápido OTIMISTA: o worker pode ser retirado a qualquer
          // momento (o wall clock é do WORKER, não da request). A varredura é
          // o backstop, e a degradação é benigna — ~70 s em vez de nunca.
          EdgeRuntime.waitUntil(processQueuedEventById(insert.id));
        }
        return new Response(verdict.kind === "ack" ? "ok" : "queue unavailable", {
          status: verdict.status,
        });
      }
    }
```

- [ ] **Step 5: Rodar**

```bash
npm run test -- src/lib/whatsapp-inbound-queue-core.test.ts
npm run typecheck
```

Esperado: PASS, zero erro de tipo.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/webhook-whatsapp/index.ts supabase/functions/_shared/whatsapp-inbound-queue-core.ts src/lib/whatsapp-inbound-queue-core.test.ts
git commit -F - <<'EOF'
feat(whatsapp): persistir a entrega crua e responder antes de processar

A fronteira do ACK fica logo depois da guarda de identidade e e unica.
INSERT que falha devolve 503, nunca 200: um 200 ai apagaria o inbound para
sempre e nada sobraria para a varredura encontrar.

handleWebhookRequest passa a receber objeto de opcoes: "assinatura ja
verificada" e "de onde vim" sao duas perguntas, nao uma.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 5: Re-entrada a partir da fila

**Files:**
- Modify: `supabase/functions/webhook-whatsapp/index.ts`
- Test: `src/lib/whatsapp-inbound-queue-core.test.ts` (controle positivo do anti-laço já na Task 1)

**Interfaces:**
- Consumes: `handleWebhookRequest(req, opts)` da Task 4; `decodeRawBodyHex` e `nextAttemptDelayMs` da Task 1.
- Produces: `processQueuedEventById(eventId: string): Promise<void>` e `finalizeQueuedEvent(eventId: string, ok: boolean, error: string | null): Promise<void>`. A Task 6 consome os dois.

- [ ] **Step 1: Implementar o processador e a finalização**

```ts
/**
 * Processa uma linha da fila re-entrando no PRÓPRIO pipeline.
 *
 * O mecanismo não é novo: `splitMetaWebhookPayload` já sintetiza `Request` e
 * re-entra em produção em todo lote multiparte. O que é novo é `source`,
 * e é ele que impede a re-entrada de persistir o evento de novo — laço
 * infinito. A decisão mora em `decideIngestionMode`, com controle positivo.
 *
 * Nunca lança: é chamado por `waitUntil` (ninguém está esperando) e pela
 * varredura (que precisa seguir para a próxima linha).
 */
async function processQueuedEventById(eventId: string): Promise<void> {
  try {
    const { data: row, error } = await supabase
      .from("whatsapp_inbound_events")
      .select("id, provider, channel_id, raw_body")
      .eq("id", eventId)
      .maybeSingle();

    // Canal apagado entre o insert e aqui (Review Focus #4): a FK é
    // `on delete cascade`, então a linha some. Não é erro — é trabalho que
    // deixou de existir, e insistir criaria lease preso.
    if (error || !row) {
      jsonLog("warn", { evt: "queued_event_vanished", eventId, err: error?.message });
      return;
    }

    const bodyText = decodeRawBodyHex(row.raw_body as string);
    const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/webhook-whatsapp?channel=${row.channel_id}`;
    const res = await handleWebhookRequest(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyText,
      }),
      { signatureAlreadyVerified: true, source: "queue", queuedEventId: eventId },
    );

    await finalizeQueuedEvent(eventId, res.ok, res.ok ? null : `http_${res.status}`);
  } catch (err) {
    jsonLog("error", { evt: "queued_event_failed", eventId, err: String(err) });
    await finalizeQueuedEvent(eventId, false, String(err).slice(0, 500));
  }
}

/**
 * Backoff CURTO e RASO: resposta atrasada é resposta errada. O repo já
 * formaliza isso em `whatsapp-message-ttl-core.ts` — mensagem automática tem
 * prazo contado do fato que a originou. Esgotado, vira `dead`, e quem assume
 * é uma pessoa, não uma retentativa.
 */
async function finalizeQueuedEvent(
  eventId: string,
  ok: boolean,
  error: string | null,
): Promise<void> {
  const nowIso = new Date().toISOString();

  if (ok) {
    await supabase.from("whatsapp_inbound_events").update({
      status: "done",
      claim_id: null,
      claimed_until: null,
      last_error: null,
      updated_at: nowIso,
    }).eq("id", eventId);
    return;
  }

  const { data: current } = await supabase
    .from("whatsapp_inbound_events")
    .select("attempts").eq("id", eventId).maybeSingle();
  if (!current) return; // linha sumiu junto com o canal

  const attempts = (current.attempts ?? 0) + 1;
  const delay = nextAttemptDelayMs(attempts - 1);

  await supabase.from("whatsapp_inbound_events").update({
    status: delay === null ? "dead" : "received",
    attempts,
    next_attempt_at: delay === null ? nowIso : new Date(Date.now() + delay).toISOString(),
    claim_id: null,
    claimed_until: null,
    last_error: error?.slice(0, 500) ?? null,
    updated_at: nowIso,
  }).eq("id", eventId);

  if (delay === null) await promoteDeadLetterToHandoff(eventId);
}
```

`promoteDeadLetterToHandoff` é da Task 8; até lá, declarar como `async function promoteDeadLetterToHandoff(_eventId: string): Promise<void> {}` para o `tsc -b` passar, e completá-la na Task 8.

- [ ] **Step 2: Escrever o teste de integração do anti-laço**

Criar `src/lib/whatsapp-inbound-reentry.test.ts` — teste de acoplamento que lê o fonte e reprova se a guarda sumir:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("../../supabase/functions/webhook-whatsapp/index.ts", import.meta.url),
  "utf8",
);

describe("re-entrada a partir da fila não pode reinserir (Review Focus #3)", () => {
  it("processQueuedEventById passa source: \"queue\"", () => {
    expect(SRC).toMatch(/source:\s*"queue"/);
  });

  it("a decisão de persistir vem do núcleo, nunca de um if solto no handler", () => {
    expect(SRC).toMatch(/decideIngestionMode\(/);
    // Controle positivo: se alguém reimplementar a decisão aqui, isto reprova.
    expect(SRC).not.toMatch(/ingestionSource\s*===\s*"provider"\s*&&\s*flag/);
  });
});
```

- [ ] **Step 3: Rodar**

```bash
npm run test -- src/lib/whatsapp-inbound-reentry.test.ts
npm run typecheck
```

Esperado: PASS.

- [ ] **Step 4: Exercitar localmente**

Acrescentar a `supabase/config.toml`:

```toml
[edge_runtime]
policy = "per_worker"
```

Sem isso o CLI encerra a instância após a resposta e `waitUntil` nunca completa localmente.

```bash
npx supabase functions serve webhook-whatsapp
```

Noutro terminal, com um canal de teste e o gate ON nas duas pernas, **medir o ACK** (critério de aceite nº 2 da spec):

```bash
curl -s -o /dev/null -w 'status=%{http_code} tempo=%{time_total}s\n' \
  -X POST "http://localhost:54321/functions/v1/webhook-whatsapp?channel=$TEST_CHANNEL_ID" \
  -H 'content-type: application/json' \
  -H "x-datafy-signature-256: $SIG" \
  -H "x-datafy-timestamp: $TS" \
  -H "x-datafy-delivery-id: $(uuidgen)" \
  --data-binary @fixture-inbound.json
```

Esperado: `status=200` e `tempo` **abaixo de 1,0 s**. Em seguida, conferir que a linha completou:

```bash
npx supabase db query "select status, attempts, outcome from whatsapp_inbound_events order by received_at desc limit 1;"
```

Esperado: `done`. Se ficar em `received` ou `processing`, o `waitUntil` não rodou — conferir `policy = "per_worker"`.

**A fixture tem que ser a mensagem como ela chega**, com quebras de linha e decoração reais — não um JSON mínimo montado à mão. Este repo já teve suíte verde por 14 dias exercitando uma forma de envelope que o provider nunca enviou.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/webhook-whatsapp/index.ts src/lib/whatsapp-inbound-reentry.test.ts supabase/config.toml
git commit -F - <<'EOF'
feat(whatsapp): processar a fila re-entrando no proprio pipeline

Reusa o mecanismo que ja roda em producao em todo lote Meta multiparte.
O que e novo e `source`, e e ele que impede a re-entrada de persistir o
evento de novo — laco infinito, com teste de acoplamento que reprova se a
guarda sumir do fonte.

config.toml ganha edge_runtime policy per_worker: sem isso o CLI encerra a
instancia apos a resposta e waitUntil nunca completa localmente.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 6: Varredura, lease e dead letter

**Files:**
- Modify: `supabase/functions/webhook-whatsapp/index.ts`
- Create: `supabase/migrations/20260924120200_113_inbound_claim_rpc.sql`
- Create: `supabase/migrations/20260924120300_114_cron_inbound_sweep.sql` (**só no Step 5**)

**Interfaces:**
- Consumes: `processQueuedEventById` e `finalizeQueuedEvent` da Task 5.
- Produces: RPCs `claim_whatsapp_inbound_events(p_limit integer)` e `purge_whatsapp_inbound_events()`; função `runInboundSweep(requestId: string): Promise<Response>`; branch `?sweep=1`.

- [ ] **Step 1: RPC de claim com relógio único (Review Focus #5)**

A comparação de expiração acontece **no banco**, numa única fonte — nunca `claimed_until` escrito por `now()` e comparado por `Date.now()` no Deno.

```sql
-- Claim atômico de eventos devidos. Relógio ÚNICO: tudo é `now()` do banco.
-- Mistura de fontes é o defeito de borda que este repo já pagou em
-- availability.ts, e aqui produziria takeover cedo demais ou nunca.
create or replace function public.claim_whatsapp_inbound_events(p_limit integer default 20)
returns setof whatsapp_inbound_events
language sql
security definer
set search_path = ''
as $$
  update public.whatsapp_inbound_events e
     set status = 'processing',
         claim_id = gen_random_uuid(),
         claimed_until = now() + make_interval(secs => 90),
         updated_at = now()
   where e.id in (
     select id from public.whatsapp_inbound_events
      where next_attempt_at <= now()
        and (status = 'received'
             or (status = 'processing' and claimed_until < now()))
      order by next_attempt_at
      limit greatest(1, least(coalesce(p_limit, 20), 100))
      for update skip locked
   )
  returning e.*;
$$;

revoke all on function public.claim_whatsapp_inbound_events(integer)
  from public, anon, authenticated;
grant execute on function public.claim_whatsapp_inbound_events(integer) to service_role;
```

- [ ] **Step 2: Branch `?sweep=1`, antes da exigência de `?channel=`**

No topo do `try` de `handleWebhookRequest`, **antes** do `if (!channelId)`:

```ts
    // A varredura não tem canal — ela resolve o canal de cada linha. Por isso
    // este branch precisa vir ANTES da exigência de `?channel=`.
    //
    // SEGURANÇA: este branch NÃO aceita payload nenhum. Ele lê exclusivamente
    // da tabela. Se a chave interna vazar, o poder conferido é "fazer uma
    // varredura rodar mais cedo" sobre eventos já persistidos e já validados
    // por assinatura — não injetar inbound.
    if (url.searchParams.get("sweep") === "1") {
      if (!requireInternalAuth(req)) {
        return new Response("unauthorized", { status: 401 });
      }
      return await runInboundSweep(requestId);
    }
```

- [ ] **Step 3: Varredura, backoff e purga**

```ts
async function runInboundSweep(requestId: string): Promise<Response> {
  const { data: rows, error } = await supabase.rpc("claim_whatsapp_inbound_events", { p_limit: 20 });
  if (error) {
    jsonLog("error", { requestId, evt: "sweep_claim_failed", err: error.message });
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  for (const row of rows ?? []) {
    await processQueuedEventById(row.id);
  }

  // Purga na própria varredura: nenhum job novo. `raw_body` carrega telefone
  // e texto de cliente — é PII, e não fica além do necessário.
  await supabase.rpc("purge_whatsapp_inbound_events");

  jsonLog("info", { requestId, evt: "sweep_processed", count: (rows ?? []).length });
  return new Response(JSON.stringify({ processed: (rows ?? []).length }), { status: 200 });
}
```

`processQueuedEventById` já chama `finalizeQueuedEvent` (Task 5), então a varredura não precisa finalizar nada por fora — e não deve, sob risco de escrever por cima do veredito.

Acrescentar na migration 113 a RPC de purga:

```sql
create or replace function public.purge_whatsapp_inbound_events()
returns integer
language sql
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.whatsapp_inbound_events
     where (status = 'done' and received_at < now() - interval '7 days')
        or (status = 'dead' and received_at < now() - interval '30 days')
    returning 1
  ) select count(*)::integer from gone;
$$;

revoke all on function public.purge_whatsapp_inbound_events() from public, anon, authenticated;
grant execute on function public.purge_whatsapp_inbound_events() to service_role;
```

- [ ] **Step 4: Exercitar a varredura MANUALMENTE antes de agendar**

```bash
npx supabase functions deploy webhook-whatsapp
curl -s -X POST "$PROJECT_URL/functions/v1/webhook-whatsapp?sweep=1" -H "x-internal-key: $INTERNAL_API_KEY"
curl -s -X POST "$PROJECT_URL/functions/v1/webhook-whatsapp?sweep=1"   # sem chave
```

Esperado: com chave, `{"processed":0}` e HTTP 200 (inventário vazio). Sem chave, **401**.

- [ ] **Step 5: Agendar — criar a migration 114 SÓ AGORA**

Criar `supabase/migrations/20260924120300_114_cron_inbound_sweep.sql` apenas neste ponto, depois de o Step 4 ter provado a varredura à mão. Criá-la antes faria o `db push` da Task 6 agendar o cron junto com as RPCs, antes de qualquer execução sob observação — é a mesma razão pela qual a 092 e a 093 são separadas.

```sql
create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule('whatsapp-inbound-sweep');
exception when others then null;
end $$;

select cron.schedule(
  'whatsapp-inbound-sweep',
  '*/1 * * * *',
  'select trigger_whatsapp_inbound_sweep();'
);

-- ATENÇÃO na conferência: `status = succeeded` em cron.job_run_details
-- significa que o pg_net ACEITOU o POST, não que a Edge Function respondeu
-- 200. A resposta real está em net._http_response — pg_net é fire-and-forget.
```

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/webhook-whatsapp/index.ts supabase/migrations/20260924120200_113_inbound_claim_rpc.sql supabase/migrations/20260924120300_114_cron_inbound_sweep.sql
git commit -F - <<'EOF'
feat(whatsapp): varredura de recuperacao, lease e dead letter

Claim atomico com relogio UNICO do banco: claimed_until escrito por now() e
comparado por now(), nunca por Date.now() do Deno.

O branch ?sweep=1 nao aceita payload nenhum — le so da tabela. Chave interna
vazada confere "rodar a varredura mais cedo", nao injetar inbound.

Backoff curto e raso (30s/2min/5min): resposta atrasada e resposta errada.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 7: Deadline suave no loop do agente

**Files:**
- Modify: `supabase/functions/_shared/ai-providers.ts` (linhas 104-123, 517-518, 616-617, 813-814)
- Modify: `supabase/functions/webhook-whatsapp/index.ts` (~3351, ~3553)

**Interfaces:**
- Consumes: `agentDeadlineVerdict`, `AGENT_SOFT_DEADLINE_MS` da Task 1.
- Produces: `AgentLoopOptions.shouldContinue?: () => boolean`.

- [ ] **Step 1: Acrescentar a opção, mantendo o default idêntico a hoje**

Em `AgentLoopOptions`:

```ts
  /**
   * Deadline SUAVE (Fase C). Checado no topo de cada rodada: `false` impede
   * COMEÇAR outra, e a rodada em curso termina normalmente.
   *
   * Abortar no meio deixaria reserva criada e cliente sem resposta — o risco
   * que `mutatingToolUsed` já tenta cobrir. AUSENTE = comportamento de hoje,
   * exato: `manage-ai-providers` não muda de comportamento.
   */
  shouldContinue?: () => boolean;
```

Nos três runners, logo após `while (iterations-- > 0) {`:

```ts
    if (opts.shouldContinue && !opts.shouldContinue()) {
      console.warn(JSON.stringify({
        level: "warn",
        evt: "agent_deadline_reached",
        provider: opts.provider,
        iterations_left: iterations,
      }));
      throw new Error("agent_deadline");
    }
```

- [ ] **Step 2: Ligar no webhook**

No `runOnce` (~3351), acrescentar:

```ts
        shouldContinue: () =>
          agentDeadlineVerdict({ startedAt: processingStartedAt, now: Date.now() }) === "continue",
```

`processingStartedAt` é `Date.now()` no início do processamento — **não** `t0`, que no modo fila já inclui o tempo da requisição original.

No tratamento de erro do agente (~3553), distinguir o motivo:

```ts
      const handoffReason = agentError === "agent_deadline"
        ? `agent_deadline:${provider_ai}:${modelOverride}`
        : `agent_error:${provider_ai}:${modelOverride}`;
```

- [ ] **Step 3: Testar a derivação do TTL**

Já coberto na Task 1 (`lockTtlSecondsRequired`). Acrescentar o teste de acoplamento que amarra a constante do webhook à aritmética:

```ts
it("AI_LOCK_TTL_SECONDS do webhook cobre o orçamento declarado", () => {
  const SRC = readFileSync(
    new URL("../../supabase/functions/webhook-whatsapp/index.ts", import.meta.url), "utf8");
  const m = SRC.match(/AI_LOCK_TTL_SECONDS\s*=\s*(\d+)/);
  expect(m).not.toBeNull();
  expect(Number(m![1])).toBeGreaterThanOrEqual(lockTtlSecondsRequired());
});
```

- [ ] **Step 4: Rodar**

```bash
npm run test
npm run typecheck
npm run lint
```

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/ai-providers.ts supabase/functions/webhook-whatsapp/index.ts src/lib/whatsapp-inbound-queue-core.test.ts
git commit -F - <<'EOF'
feat(whatsapp): deadline suave no loop do agente

Impede COMECAR nova rodada de ferramenta; a em curso termina. Abortar no meio
deixaria reserva criada e cliente sem resposta.

shouldContinue e opcional: ausente = comportamento de hoje, exato. O TTL do
lock deixa de ser adivinhado e passa a ser verificado por teste contra a
aritmetica — orcamento + pior turno + envio.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 8: Dead letter visível

**Files:**
- Modify: `supabase/functions/webhook-whatsapp/index.ts`
- Modify: `supabase/functions/whatsapp-health/index.ts`

**Interfaces:**
- Consumes: `finalizeQueuedEvent` da Task 6.
- Produces: `promoteDeadLetterToHandoff(eventId)`; campo `inboundDeadLetterCount` no diagnóstico.

- [ ] **Step 1: Promover a conversa quando resolvível**

**`conversations` NÃO tem coluna de telefone** — é chaveada por `customer_id` + `unit_id` (ver `get_or_create_whatsapp_conversation`, usado por [index.ts:543-558](../../../supabase/functions/webhook-whatsapp/index.ts)). E `customers` pertencem à **organização**, não à unidade. A cadeia é: unit → `organization_id` → customer por `(organization_id, phone)` → conversa por `(customer_id, unit_id)`.

**Nunca criar conversa aqui.** Se não existe, não existe — `appendOutboundToConversation` é quem auto-cria, e criar uma conversa só para marcá-la em handoff inventaria thread vazia no painel.

```ts
/**
 * Best-effort: quando o evento morreu ANTES de existir conversa, isto não é
 * possível, e sobra o contador do painel. Quando é possível, reusa o
 * `awaiting_human` que `useAwaitingHumanCount` já conta — sem inventar tela.
 *
 * Nunca lança: é chamado do caminho de finalização da fila.
 */
async function promoteDeadLetterToHandoff(eventId: string): Promise<void> {
  try {
    const { data: row } = await supabase.from("whatsapp_inbound_events")
      .select("provider, unit_id, raw_body").eq("id", eventId).maybeSingle();
    if (!row) return;

    const payload = JSON.parse(decodeRawBodyHex(row.raw_body as string));
    const inbound = parseInbound(row.provider as WhatsAppProvider, payload);
    if (!inbound?.fromPhone) return;

    const phone = canonicalBrPhone(inbound.fromPhone);
    if (!isPlausibleCustomerPhone(phone)) return;

    const { data: unit } = await supabase
      .from("units").select("organization_id").eq("id", row.unit_id).maybeSingle();
    if (!unit) return;

    const { data: customer } = await supabase
      .from("customers").select("id")
      .eq("organization_id", unit.organization_id).eq("phone", phone).maybeSingle();
    if (!customer) return;

    const { data: conv } = await supabase
      .from("conversations").select("id")
      .eq("unit_id", row.unit_id).eq("customer_id", customer.id)
      .order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (!conv) return;

    await supabase.from("conversations").update({
      status: "awaiting_human",
      handoff_reason: "inbound_dead_letter",
      handoff_at: new Date().toISOString(),
      last_silenced_reply_at: null,
    }).eq("id", conv.id);

    jsonLog("warn", { evt: "inbound_dead_letter", eventId, convId: conv.id });
  } catch (err) {
    jsonLog("warn", { evt: "dead_letter_handoff_failed", eventId, err: String(err) });
  }
}
```

- [ ] **Step 2: Contagem no diagnóstico**

Em `whatsapp-health`, acrescentar ao payload:

```ts
  const { count: inboundDeadLetterCount } = await supabase
    .from("whatsapp_inbound_events")
    .select("id", { count: "exact", head: true })
    .eq("unit_id", unitId)
    .eq("status", "dead");
```

- [ ] **Step 3: Rodar e commitar**

```bash
npm run test && npm run typecheck && npm run lint
git add supabase/functions/webhook-whatsapp/index.ts supabase/functions/whatsapp-health/index.ts
git commit -F - <<'EOF'
feat(whatsapp): dead letter visivel no painel e no handoff

Evento que esgota as tentativas promove a conversa para awaiting_human quando
resolvivel — reusa o contador que o painel ja tem. Quando morreu antes de
existir conversa, sobra a contagem no diagnostico.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 9: Documentação e fechamento

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md`

- [ ] **Step 1: Escrever as regras permanentes**

No mesmo commit, nos DOIS arquivos (`CLAUDE.md` com detalhe, `AGENTS.md` com o espelho condensado). Formato obrigatório: **regra em 1 frase. Por quê (1 frase). [arquivo.ts](arquivo.ts).**

Regras a acrescentar:

1. **O gate da ingestão assíncrona tem DUAS pernas e as duas nascem OFF.** Flag global fail-closed mais `whatsapp_channels.async_ingestion_enabled`; leitura que falha é **503**, nunca "OFF", porque tratá-la como OFF processaria síncrono e estouraria o orçamento do provider sem rastro.
2. **A fronteira do ACK é única e fica logo depois da guarda de identidade.** Diferir só "o que é caro" obrigaria a guardar corpo de lote re-serializado, destruindo a revalidação de assinatura.
3. **`whatsapp_inbound_events.raw_body` é `bytea`, não `text`.** Postgres recusa `\u0000` em `text` e um único inbound com NUL viraria 503 em loop.
4. **`source: "queue"` é o que impede a re-entrada de reinserir o evento.** A decisão mora em `decideIngestionMode`, com controle positivo — não é um `if` no handler.
5. **O branch `?sweep=1` não aceita payload nenhum.** Chave interna vazada confere "rodar a varredura mais cedo", não injetar inbound.
6. **Linha de redeploy:** `whatsapp-inbound-queue-core.ts` → `webhook-whatsapp`; `ai-providers.ts` → `webhook-whatsapp` **e** `manage-ai-providers`.
7. **`ASYNC_INGESTION_DEADLETTER_ALERT`:** o gate não pode ser ligado para provider com tráfego real antes do alerta ativo da Fase J.

- [ ] **Step 2: Conferir o par sincronizado**

```bash
git diff -- CLAUDE.md AGENTS.md
```

Esperado: os dois mudaram. **Nunca commitar alteração de regra em apenas um deles.**

- [ ] **Step 3: Gates completos**

```bash
npm run test
npm run typecheck
npm run lint
```

Depois, os agentes de segurança, porque esta fase toca banco, webhook, autenticação e multi-tenant: `saas-shield-br:migration-validator` (111-114), `saas-shield-br:rls-auditor`, `saas-shield-br:tenant-isolation-auditor`, `saas-shield-br:integration-reliability-auditor`. Conferir o check `acl-estatico` na aba Checks do PR.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md
git commit -F - <<'EOF'
docs: invariantes da ingestao assincrona de WhatsApp (Fase C)

Gate de duas pernas fail-closed, fronteira unica do ACK, raw_body em bytea,
a guarda anti-laco, o branch de varredura sem payload e as duas linhas de
redeploy.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Ordem de aplicação em produção

1. `supabase db push` — migrations 111, 112, 113. **A 114 ainda não existe como arquivo.**
2. `supabase functions deploy webhook-whatsapp` e `supabase functions deploy manage-ai-providers`.
3. Exercitar `?sweep=1` manualmente, com e sem chave (Task 6, Step 4). Esperado: 200 com chave, 401 sem.
4. Criar a 114 e `supabase db push` (agenda o cron). Conferir em `net._http_response`, não em `cron.job_run_details`: `succeeded` ali significa que o `pg_net` aceitou o POST, não que a função respondeu 200.
5. Gate segue **OFF**. Ligar só para um canal Datafy de teste, nunca para canal com tráfego real antes do alerta da Fase J.

**Inverter 1 e 2 faz o gate ler coluna inexistente → 400 do PostgREST → 503 em todo inbound de todo canal.**
