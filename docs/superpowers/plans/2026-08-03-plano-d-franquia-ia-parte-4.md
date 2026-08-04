# Plano D — Parte 4 (Tasks 10 e 11: `ai-providers.ts` e o adapter de I/O)

> Continuação de `2026-08-03-plano-d-franquia-ia.md`. **As Global Constraints daquele arquivo valem integralmente aqui.**

---

## Task 10: Autorização por chamada nos cinco provedores (`ai-providers.ts`)

**Files:**
- Modify: `supabase/functions/_shared/ai-providers.ts`
- Test: `src/lib/ai-budget-wiring-guard.test.ts` (novo)

**Interfaces:**
- Consumes: `authorizeAndInvoke`, `AgentCallMeta`, `AgentCallOutcome`, `PriceLookup` de `ai-call-authorizer-core.ts`; `BeforeCallContext`, `BeforeCallDecision` de `ai-budget-core.ts`.
- Produces: `AgentBudgetHooks`, `AgentLoopResult`; `AgentLoopOptions.budget?`; `runAgentLoop(opts): Promise<AgentLoopResult>`.

**Contexto obrigatório para o implementador:**

- **`webhook-whatsapp` é o ÚNICO consumidor de runtime deste arquivo.** `manage-ai-providers` importa apenas `security.ts` e `cors.ts`. A mudança do contrato de `runAgentLoop` exige redeploy **só** de `webhook-whatsapp`; `manage-ai-providers` só entra quando o **catálogo de modelos** mudar (`DEFAULT_MODELS`, `KNOWN_MODELS`, `MODELS_BY_PROVIDER`, `DEFAULT_MODEL_BY_PROVIDER`) — o que **não** acontece nesta tarefa.
- **`opts.budget` ausente = comportamento de hoje, byte a byte.** É o que mantém Ren Sushi, carteira legada e BYOK puro fora de todo caminho novo.
- **`estimateCostUsd` e `PRICING_USD_PER_MTOK` NÃO são removidos.** Continuam servindo o log `agent_usage` (telemetria pura pode tolerar desconhecido). O que muda é que o **caminho de orçamento** nunca os consulta — ele usa `ai-price-core.ts` contra a tabela versionada. Acrescentar o comentário que fixa essa separação.
- **`MAX_ITERATIONS = 12` não muda.** Não há limite de conversas nem de mensagens; o único teto é financeiro.
- **Retries de `fetchWithRetry` dentro de UMA chamada lógica NÃO produzem autorização nova** — é a mesma chamada, mesmo modelo, e uma tentativa que falha não gera usage. O fallback **de modelo**, sim, é chamada nova.

- [ ] **Step 1: Escrever o guardrail que falha**

Criar `src/lib/ai-budget-wiring-guard.test.ts`:

```ts
/**
 * Guardrail de LEITURA sobre os arquivos que o vitest não consegue importar
 * (`ai-providers.ts` importa esm.sh; `ai-budget-gate.ts` e o `index.ts` do
 * webhook importam supabase-js e chamam `serve()` no carregamento).
 *
 * Toda DECISÃO desta frente vive em núcleo puro e é testada de verdade. O que
 * este arquivo prova é o WIRING: que os adaptadores chamam os núcleos, que
 * nenhum runner conversa com o provedor por fora do autorizador, e que nada
 * sensível vaza. Leitura humana já deixou passar um `ReferenceError` de
 * autorização e um conflito FK × CHECK por duas auditorias na 6b — este teste é
 * a leitura que não cansa.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SHARED = join(__dirname, "..", "..", "supabase", "functions", "_shared");
const providers = readFileSync(join(SHARED, "ai-providers.ts"), "utf8");

describe("ai-providers.ts — contrato de orçamento", () => {
  it("importa o autorizador puro em vez de reimplementar a ordem", () => {
    expect(providers).toContain('from "./ai-call-authorizer-core.ts"');
    expect(providers).toContain("authorizeAndInvoke");
  });

  it("expõe os hooks de orçamento como OPCIONAIS — ausente = comportamento de hoje", () => {
    expect(providers).toMatch(/budget\?:\s*AgentBudgetHooks/);
  });

  it("runAgentLoop devolve resultado discriminado, não string crua", () => {
    expect(providers).toMatch(/export type AgentLoopResult/);
    expect(providers).toMatch(/runAgentLoop\([^)]*\):\s*Promise<AgentLoopResult>/);
  });

  it("os CINCO provedores passam pelo mesmo caminho autorizado", () => {
    // Nenhum runner pode chamar o provedor por fora: implementar o gancho só no
    // Gemini o tornaria "o único testado".
    const helper = "callWithBudget";
    expect(providers).toContain(helper);
    for (const runner of ["runClaude", "runOpenAICompatible", "runGemini"]) {
      const i = providers.indexOf(`async function ${runner}(`);
      expect(i, `${runner} não encontrado`).toBeGreaterThan(-1);
      const body = providers.slice(i, providers.indexOf("\n}\n", i));
      expect(body, `${runner} não usa ${helper}`).toContain(helper);
    }
  });

  it("nenhuma chamada HTTP ao provedor acontece fora do helper autorizado", () => {
    // `anthropic.messages.create` e `fetchWithRetry` só podem aparecer dentro do
    // `invoke` passado ao helper.
    const rawCalls = [...providers.matchAll(/anthropic\.messages\.create|fetchWithRetry\(/g)];
    expect(rawCalls.length).toBeGreaterThan(0);
    for (const m of rawCalls) {
      const before = providers.slice(Math.max(0, m.index! - 900), m.index!);
      expect(
        /invoke:\s*async|invoke\(\)/.test(before),
        `chamada HTTP fora do invoke autorizado perto do índice ${m.index}`,
      ).toBe(true);
    }
  });

  it("o fallback do Gemini é chamada NOVA, não herda autorização", () => {
    const i = providers.indexOf("async function runGemini(");
    const body = providers.slice(i);
    // O fallback passa pelo helper com o modelo REAL do fallback.
    expect(body).toMatch(/callWithBudget[\s\S]{0,600}fallbackModel/);
  });

  it("o catálogo de modelos NÃO muda nesta frente — manage-ai-providers fora do redeploy", () => {
    // Os quatro nomes do invariante de sincronização continuam presentes e
    // intactos; mexer neles mudaria a lista de redeploy.
    expect(providers).toContain("DEFAULT_MODELS");
    expect(providers).toContain("KNOWN_MODELS");
    expect(providers).toMatch(/gemini:\s*"gemini-2\.5-flash"/);
    expect(providers).toMatch(/gemini:\s*"gemini-2\.5-pro"/);
  });

  it("estimateCostUsd continua existindo, e o comentário fixa que ele NÃO serve o orçamento", () => {
    expect(providers).toContain("export function estimateCostUsd");
    const i = providers.indexOf("export function estimateCostUsd");
    const doc = providers.slice(Math.max(0, i - 900), i);
    expect(doc).toMatch(/orçamento|orcamento/i);
    expect(doc).toMatch(/ai-price-core/);
  });

  it("nenhuma chave de API aparece em log", () => {
    for (const m of providers.matchAll(/console\.(warn|error|info|log)\(/g)) {
      const block = providers.slice(m.index!, m.index! + 700);
      expect(block).not.toMatch(/apiKey|opts\.apiKey|api_key/);
    }
  });

  it("nenhuma contagem de conversa, mensagem ou interação autoriza chamada", () => {
    expect(providers).not.toMatch(/conversationCount|messageCount|interactionCount/);
  });

  it("controle positivo: o detector de chamada crua funciona", () => {
    expect(/invoke:\s*async/.test("invoke: async () => {")).toBe(true);
    expect(/invoke:\s*async/.test("const x = 1;")).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/ai-budget-wiring-guard.test.ts`
Expected: FAIL — `ai-providers.ts` ainda não importa o autorizador.

- [ ] **Step 3: Acrescentar o contrato de orçamento aos tipos**

Em `supabase/functions/_shared/ai-providers.ts`, logo depois do import de `retry.ts` (linha 2):

```ts
import {
  authorizeAndInvoke,
  type AgentCallMeta,
  type AgentCallOutcome,
  type AuthorizedCall,
  type PriceLookup,
} from "./ai-call-authorizer-core.ts";
import type { BeforeCallContext, BeforeCallDecision } from "./ai-budget-core.ts";

export type { AgentCallMeta, AgentCallOutcome, BeforeCallDecision };
```

Em `AgentUsage` (linha ~23), acrescentar o campo **opcional**:

```ts
export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  /**
   * OpenAI `completion_tokens_details.reasoning_tokens` e Gemini
   * `thoughtsTokenCount`. OPCIONAL para não quebrar caller existente; ausente é
   * tratado como zero em telemetria — mas o caminho de ORÇAMENTO usa
   * `ai-price-core.ts`, onde token de raciocínio sem faixa própria é cobrado
   * como output, nunca como grátis.
   */
  reasoning_tokens?: number;
}
```

Depois de `AgentUsage`, acrescentar o contrato dos hooks:

```ts
/**
 * Autorização financeira POR CHAMADA (Plano D, spec §17.7).
 *
 * AUSENTE = comportamento de hoje, byte a byte: nenhuma autorização, nenhuma
 * apropriação, nenhum custo persistido. É o que mantém fora deste caminho as
 * organizações com override vitalício (Ren Sushi), a carteira legada e o BYOK
 * puro — nenhuma delas tem franquia, e nenhuma pode ser afetada por ela.
 *
 * `snapshot()` é lido ANTES de cada chamada: o adapter mantém consumido e
 * reservado atualizados a cada `reportCall`, e é isso que permite revalidar por
 * chamada sem consultar o ledger financeiro inteiro a cada iteração.
 */
export interface AgentBudgetHooks {
  organizationId: string;
  cycleId: string;
  turnId: string;
  requestId: string;
  reservationId: string;
  priceFor(provider: string, model: string): Promise<PriceLookup>;
  beforeCall(ctx: BeforeCallContext): Promise<BeforeCallDecision>;
  reportCall(meta: AgentCallMeta, outcome: AgentCallOutcome, priceId: string): Promise<void>;
  newCallId(): string;
  /** Estado corrente da reserva + estimativa já precificada da próxima chamada. */
  snapshot(iteration: number): {
    consumedCents: number;
    reservedCents: number;
    nextCallEstimateCents: number;
  };
}

/**
 * O loop deixou de devolver só texto porque "parei porque o orçamento acabou"
 * e "terminei de responder" exigem consequências opostas: handoff com razão
 * própria, copy determinística e alerta administrativo num caso; envio normal
 * no outro. Devolver `""` para o primeiro apagaria a diferença.
 */
export type AgentLoopResult =
  | { kind: "TEXT"; text: string }
  | { kind: "DENIED"; decision: BeforeCallDecision; meta: AgentCallMeta };
```

Em `AgentLoopOptions` (linha ~30-47), acrescentar ao fim:

```ts
  /** Telemetry callback fired once per HTTP turn (the loop may have multiple). */
  onUsage?: (usage: AgentUsage) => void;
  /** Plano D. Ausente = nenhuma autorização financeira (comportamento legado). */
  budget?: AgentBudgetHooks;
```

- [ ] **Step 4: Documentar a separação de `estimateCostUsd`**

Substituir o comentário acima de `PRICING_USD_PER_MTOK` (linhas ~106-110) por:

```ts
/**
 * Preços em USD por milhão de tokens — TELEMETRIA APENAS.
 *
 * ESTE CAMINHO NÃO É O DO ORÇAMENTO. `estimateCostUsd` devolve `0` para modelo
 * desconhecido, e no caminho protegido por franquia esse zero significaria
 * consumo ilimitado sem nunca tocar o teto. O caminho de orçamento usa
 * `ai-price-core.ts` contra a tabela versionada `ai_model_prices`, onde a
 * ausência de preço tem tipo próprio (`PRICE_UNKNOWN`) e falha FECHADO.
 *
 * Telemetria pura pode tolerar desconhecido; orçamento, não. As duas coexistem
 * de propósito — não unificar sem mover o log `agent_usage` para a tabela.
 */
```

- [ ] **Step 5: Escrever o helper de chamada autorizada**

Acrescentar logo antes de `runAgentLoop` (linha ~209):

```ts
/**
 * Executa UMA chamada ao provedor, autorizada quando há orçamento.
 *
 * Sem `opts.budget`: chama direto e reporta `onUsage` — exatamente o que o
 * código fazia antes desta frente.
 *
 * Com `opts.budget`: delega ao núcleo puro `authorizeAndInvoke`, que fixa a
 * ordem preço → autorização → chamada → apropriação (§17.7.3). O helper NÃO
 * decide nada; ele só liga os fios.
 *
 * `invoke` recebe o modelo REAL e devolve `{ value, rawUsage }`. Um erro
 * lançado lá dentro vira `PROVIDER_FAILED` (consumo zero VERDADEIRO) e é
 * relançado ao chamador depois de reportado — o loop continua tratando exceção
 * do provedor como sempre tratou.
 */
async function callWithBudget<T>(
  opts: AgentLoopOptions,
  spec: {
    provider: AIProvider;
    model: string;
    iteration: number;
    invoke: () => Promise<{ value: T; rawUsage: unknown }>;
  },
): Promise<{ kind: "OK"; value: T } | { kind: "DENIED"; decision: BeforeCallDecision; meta: AgentCallMeta }> {
  const b = opts.budget;

  if (!b) {
    const r = await spec.invoke();
    if (opts.onUsage && r.rawUsage) opts.onUsage(r.rawUsage as AgentUsage);
    return { kind: "OK", value: r.value };
  }

  const snap = b.snapshot(spec.iteration);
  let thrown: unknown = null;

  const authorized: AuthorizedCall = await authorizeAndInvoke(
    {
      organizationId: b.organizationId,
      cycleId: b.cycleId,
      turnId: b.turnId,
      requestId: b.requestId,
      reservationId: b.reservationId,
      provider: spec.provider,
      model: spec.model,
      iteration: spec.iteration,
      maxIterations: MAX_ITERATIONS,
      consumedCents: snap.consumedCents,
      reservedCents: snap.reservedCents,
      nextCallEstimateCents: snap.nextCallEstimateCents,
    },
    {
      priceFor: (provider, model) => b.priceFor(provider, model),
      beforeCall: (ctx) => b.beforeCall(ctx),
      reportCall: (meta, outcome, priceId) => b.reportCall(meta, outcome, priceId),
      newCallId: () => b.newCallId(),
      invoke: async () => {
        try {
          const r = await spec.invoke();
          return { kind: "OK", value: r.value, rawUsage: r.rawUsage };
        } catch (err) {
          // Guardado para relançar DEPOIS da apropriação: o desfecho precisa
          // ser registrado como PROVIDER_FAILED antes de a exceção subir.
          thrown = err;
          return { kind: "FAILED", error: err };
        }
      },
    },
  );

  if (authorized.kind === "DENIED") {
    return { kind: "DENIED", decision: authorized.decision, meta: authorized.meta };
  }

  if (thrown) throw thrown;

  const res = authorized.result;
  if (res.kind === "FAILED") throw res.error;

  // Telemetria legada (log `agent_usage`) continua alimentada.
  if (opts.onUsage && authorized.outcome.kind === "USAGE") {
    opts.onUsage(authorized.outcome.usage as AgentUsage);
  }
  return { kind: "OK", value: res.value as T };
}
```

- [ ] **Step 6: Trocar o tipo de retorno de `runAgentLoop`**

```ts
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
```

O `switch` continua igual — os três runners passam a devolver `AgentLoopResult`.

- [ ] **Step 7: Adaptar `runClaude`**

Trocar a assinatura para `Promise<AgentLoopResult>` e substituir o bloco da chamada (linhas ~315-333) por:

```ts
    const call = await callWithBudget<Anthropic.Message>(opts, {
      provider: "claude",
      model,
      iteration: MAX_ITERATIONS - iterations,
      invoke: async () => {
        const r = await anthropic.messages.create(
          {
            model,
            max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
            system: systemBlocks,
            tools: claudeTools,
            messages,
          },
          { signal: timeoutSignal(timeoutMs) },
        );
        return {
          value: r,
          rawUsage: r.usage
            ? {
                input_tokens: r.usage.input_tokens ?? 0,
                output_tokens: r.usage.output_tokens ?? 0,
                cache_creation_tokens: (r.usage as any).cache_creation_input_tokens ?? 0,
                cache_read_tokens: (r.usage as any).cache_read_input_tokens ?? 0,
                reasoning_tokens: 0,
              }
            : null,
        };
      },
    });

    // Negado: NÃO iniciar nova chamada, NÃO truncar resposta já recebida,
    // encerrar o loop de forma controlada e preservar mensagens e ferramentas
    // já executadas. Quem decide a copy e o handoff é o webhook.
    if (call.kind === "DENIED") return { kind: "DENIED", decision: call.decision, meta: call.meta };
    const response = call.value;
```

Trocar os três `return`/`break` finais:
- `return text?.text ?? "";` → `return { kind: "TEXT", text: text?.text ?? "" };`
- `return "Desculpe, não consegui processar sua solicitação. Tente novamente.";` → `return { kind: "TEXT", text: "Desculpe, não consegui processar sua solicitação. Tente novamente." };`

- [ ] **Step 8: Adaptar `runOpenAICompatible`**

Assinatura para `Promise<AgentLoopResult>`; substituir o bloco `fetchWithRetry` + `!resp.ok` + `data.usage` (linhas ~392-437) por:

```ts
    const call = await callWithBudget<any>(opts, {
      provider: opts.provider,
      model,
      iteration: MAX_ITERATIONS - iterations,
      invoke: async () => {
        const resp = await fetchWithRetry(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages,
            tools: openaiTools,
            tool_choice: "auto",
            max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
          }),
          signal: timeoutSignal(timeoutMs),
        }, {
          retries: DEFAULT_HTTP_RETRIES,
          baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
          onRetry: ({ attempt, status, error, delayMs }) => {
            console.warn(JSON.stringify({
              level: "warn",
              evt: "agent_http_retry",
              provider: opts.provider,
              model,
              attempt,
              status: status ?? null,
              error: error ? String(error) : null,
              delay_ms: Math.round(delayMs),
            }));
          },
        });

        if (!resp.ok) {
          const err = await resp.text();
          throw new Error(`${opts.provider} API error ${resp.status}: ${err}`);
        }

        const d = await resp.json();
        return {
          value: d,
          rawUsage: d.usage
            ? {
                input_tokens: d.usage.prompt_tokens ?? 0,
                output_tokens: d.usage.completion_tokens ?? 0,
                cache_creation_tokens: 0,
                cache_read_tokens: d.usage.prompt_tokens_details?.cached_tokens ?? 0,
                reasoning_tokens: d.usage.completion_tokens_details?.reasoning_tokens ?? 0,
              }
            : null,
        };
      },
    });

    if (call.kind === "DENIED") return { kind: "DENIED", decision: call.decision, meta: call.meta };
    const data = call.value;
```

E os `return` de texto viram `{ kind: "TEXT", text: ... }`.

- [ ] **Step 9: Reestruturar `runGemini` — o fallback vira chamada financeira própria**

**Substituir integralmente** `callGeminiWithFallback` (linhas ~492-571) por um `callGeminiOnce` sem fallback embutido, e mover a decisão de fallback para dentro do loop de `runGemini`, onde ela ganha autorização própria:

```ts
/**
 * UMA chamada Gemini, com retry HTTP dentro do MESMO modelo.
 *
 * Os retries de `fetchWithRetry` NÃO são chamadas financeiras novas: mesma
 * chamada lógica, mesmo modelo, e uma tentativa que falha não produz usage.
 *
 * O FALLBACK DE MODELO SAIU DAQUI de propósito. Ele realiza uma segunda chamada
 * HTTP com outro modelo, e Pro custa múltiplas vezes Flash: cobrar Pro a preço
 * de Flash é subcontabilização direta. A escolha do fallback subiu para
 * `runGemini`, onde cada modelo passa por `callWithBudget` e recebe autorização
 * própria, preço do modelo real e `call_id` próprio (§17.7.6).
 */
async function callGeminiOnce(
  body: string,
  apiKey: string,
  model: string,
  timeoutMs: number,
  retries: number,
): Promise<Response> {
  return fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: timeoutSignal(timeoutMs),
    },
    {
      retries,
      baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
      onRetry: ({ attempt, status, error, delayMs }) => {
        console.warn(JSON.stringify({
          level: "warn",
          evt: "agent_http_retry",
          provider: "gemini",
          model,
          attempt,
          status: status ?? null,
          error: error ? String(error) : null,
          delay_ms: Math.round(delayMs),
        }));
      },
    },
  );
}
```

E dentro do `while` de `runGemini`, substituir o bloco `callGeminiWithFallback` + `!resp.ok` + `data.usageMetadata` por:

```ts
    // Uma tentativa por modelo, cada uma com autorização financeira PRÓPRIA.
    // `attemptModels` é [ativo] ou [ativo, fallback] — a segunda entrada só é
    // tentada quando a primeira falha com 5xx ou erro de rede.
    const attemptModels = fallbackModel && fallbackModel !== activeModel
      ? [activeModel, fallbackModel]
      : [activeModel];

    let data: any = null;
    let denied: { decision: BeforeCallDecision; meta: AgentCallMeta } | null = null;
    let lastError: unknown = null;

    for (let a = 0; a < attemptModels.length; a++) {
      const attemptModel = attemptModels[a];
      const isFallbackAttempt = a > 0;

      if (isFallbackAttempt) {
        console.warn(JSON.stringify({
          level: "warn",
          evt: "agent_model_fallback",
          provider: "gemini",
          from_model: attemptModels[0],
          to_model: attemptModel,
          primary_error: String(lastError),
        }));
      }

      try {
        const call = await callWithBudget<any>(opts, {
          provider: "gemini",
          model: attemptModel,
          iteration: MAX_ITERATIONS - iterations,
          invoke: async () => {
            const resp = await callGeminiOnce(
              body,
              opts.apiKey,
              attemptModel,
              timeoutMs,
              // Primary: 1 retry — se Flash falha 2x seguidas a sobrecarga
              // regional persiste e mais espera só atrasa o cliente. Fallback:
              // retries default, porque Pro tem cota TPM separada.
              isFallbackAttempt ? DEFAULT_HTTP_RETRIES : 1,
            );
            if (!resp.ok) {
              const err = await resp.text();
              throw new Error(`Gemini API error ${resp.status}: ${err}`);
            }
            const d = await resp.json();
            return {
              value: d,
              rawUsage: d.usageMetadata
                ? {
                    input_tokens: d.usageMetadata.promptTokenCount ?? 0,
                    output_tokens: d.usageMetadata.candidatesTokenCount ?? 0,
                    cache_creation_tokens: 0,
                    cache_read_tokens: d.usageMetadata.cachedContentTokenCount ?? 0,
                    reasoning_tokens: d.usageMetadata.thoughtsTokenCount ?? 0,
                  }
                : null,
            };
          },
        });

        // Negação vale para a tentativa ATUAL e encerra o turno — inclusive a
        // do fallback. Quando a 1ª chamada não devolveu usage, a autorização do
        // fallback volta DENY_USAGE_UNRESOLVED e a 2ª chamada não acontece: é
        // exatamente o buraco de "resposta vazia + fallback = duas chamadas,
        // uma contabilizada" (§17.7.6).
        if (call.kind === "DENIED") {
          denied = { decision: call.decision, meta: call.meta };
          break;
        }

        data = call.value;
        // Sticky: se caímos no Pro, seguimos no Pro (a cota do Flash continua
        // saturada — não adianta voltar).
        activeModel = attemptModel;
        break;
      } catch (err) {
        lastError = err;
        // Última tentativa: propaga como sempre propagou (→ agent_error → handoff).
        if (a === attemptModels.length - 1) throw err;
      }
    }

    if (denied) return { kind: "DENIED", decision: denied.decision, meta: denied.meta };
    if (!data) throw lastError ?? new Error("Gemini: sem resposta utilizável");
```

O trecho de resposta vazia (`emptyRetried`) continua igual — ele já faz `continue` no topo do laço, e o topo do laço agora **autoriza de novo**, com `activeModel` apontando para o fallback. Trocar os `return text` / `return ""` / `return "Desculpe..."` por `{ kind: "TEXT", text: ... }`.

- [ ] **Step 10: Rodar o guardrail, os gates e commitar**

```bash
npx vitest run src/lib/ai-budget-wiring-guard.test.ts
npm run test
npm run typecheck
npx eslint supabase/functions/_shared/ai-providers.ts --max-warnings=0
git add supabase/functions/_shared/ai-providers.ts src/lib/ai-budget-wiring-guard.test.ts
git commit -m "feat(plano-d): autorizacao financeira por chamada nos cinco provedores; fallback do Gemini com autorizacao propria"
```

---

## Task 11: Adapter de I/O do orçamento (`ai-budget-gate.ts`)

**Files:**
- Create: `supabase/functions/_shared/ai-budget-gate.ts`
- Modify: `src/lib/ai-budget-wiring-guard.test.ts` (bloco novo)

**Interfaces:**
- Consumes: RPCs da Task 5; núcleos das Tasks 1-3; `AgentBudgetHooks` da Task 10.
- Produces: `loadAiFranchise(supabase, orgId)`, `openTurnBudget(supabase, args)`, `makeBudgetHooks(supabase, args)`, `finalizeTurn(supabase, args)`, `recordMilestones(supabase, args)`, tipo `TurnBudget`.

**Contexto obrigatório para o implementador:**

- **Este arquivo é adapter. Zero decisão própria.** Toda pergunta ("cabe?", "qual preço?", "qual marco?", "que texto?") é respondida por núcleo puro. Regra escrita aqui não é auditável por vitest — é a lição que a 6b pagou duas vezes.
- **Modo observação (flag `ai_wallet_enforced` OFF):** medição e ledger funcionam, **nenhuma negação comercial acontece**. `DENY_BUDGET` vira `ALLOW` com log; `DENY_PRICE_UNKNOWN` também vira `ALLOW` (e a chamada simplesmente **não gera evento**, porque `price_id` é NOT NULL). É o modo que permite ver o custo real por organização **antes** de qualquer bloqueio ligar.
- **`UPDATE` do Supabase JS que casa ZERO linhas devolve `error: null`.** Toda escrita escopada por `organization_id` usa `.select()` e confere o tamanho do retorno.
- **Nunca expor SQL, `error.message` do Postgres ou payload bruto em `sanitizedCode`.** Detalhe vai para `jsonLog`.
- **Nunca logar a chave de IA.**

- [ ] **Step 1: Escrever o bloco de guardrail que falha**

Acrescentar a `src/lib/ai-budget-wiring-guard.test.ts`:

```ts
const gate = readFileSync(join(SHARED, "ai-budget-gate.ts"), "utf8");

describe("ai-budget-gate.ts — adapter sem decisão própria", () => {
  it("delega a decisão aos núcleos puros", () => {
    for (const core of ["ai-budget-core.ts", "ai-price-core.ts", "ai-budget-milestones-core.ts"]) {
      expect(gate, `não importa ${core}`).toContain(`from "./${core}"`);
    }
    for (const fn of ["planNextCall", "mapReserveDecision", "computeAvailableCents", "priceUsage", "selectEffectivePrice", "crossedMilestonePercents", "resolveCycleWindow"]) {
      expect(gate, `não usa ${fn}`).toContain(fn);
    }
  });

  it("não reimplementa a fórmula do teto nem a escada de marcos", () => {
    expect(gate).not.toMatch(/limit_?[Cc]ents\s*-\s*settled/);
    expect(gate).not.toMatch(/\b(7000|8000|9000|10000)\b/);
  });

  it("não redigita event_type de marco — a fonte canônica é o núcleo", () => {
    expect(gate).not.toMatch(/"admin_ai_budget_(70|80|90|stop)"/);
    expect(gate).toContain("EVENT_TYPE_BY_MILESTONE_PERCENT");
  });

  it("chama as cinco RPCs pelo nome, sem SQL cru", () => {
    for (const rpc of ["open_ai_cycle_budget", "reserve_ai_budget", "extend_ai_reservation", "record_ai_call_usage", "finalize_ai_reservation"]) {
      expect(gate, `não chama ${rpc}`).toContain(`"${rpc}"`);
    }
    expect(gate).not.toMatch(/\bselect\s+\*\s+from\b/i);
  });

  it("todo UPDATE escopado por tenant confere as linhas casadas", () => {
    // PostgREST devolve error:null num UPDATE que não casa linha nenhuma.
    for (const m of gate.matchAll(/\.update\(/g)) {
      const block = gate.slice(m.index!, m.index! + 500);
      expect(block, `update sem .select() perto de ${m.index}`).toContain(".select(");
    }
  });

  it("nenhum sanitizedCode carrega mensagem do Postgres ou SQL", () => {
    for (const m of gate.matchAll(/sanitizedCode:\s*([^,\n]+)/g)) {
      expect(m[1]).not.toContain("error.message");
      expect(m[1]).not.toContain("err.message");
      expect(m[1]).toMatch(/^"[a-z0-9_]{1,40}"$/);
    }
  });

  it("o modo observação nunca nega — e está dito no código", () => {
    expect(gate).toContain("ai_wallet_enforced");
    expect(gate).toMatch(/enforced[\s\S]{0,300}ALLOW/);
  });

  it("nenhuma chave de IA é lida ou logada aqui", () => {
    expect(gate).not.toMatch(/ai_provider_credentials|apiKey|api_key/);
  });

  it("budgetRemainingCents nunca é devolvido ao frontend do lojista", () => {
    // O adapter é chamado só por webhook-whatsapp (service_role). Não pode
    // existir nenhum caminho que devolva o restante numa resposta HTTP.
    expect(gate).not.toMatch(/new Response\(/);
  });

  it("nenhuma contagem de conversa autoriza chamada", () => {
    expect(gate).not.toMatch(/from\("conversations"\)[\s\S]{0,200}count/);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/ai-budget-wiring-guard.test.ts`
Expected: FAIL — `ENOENT ... ai-budget-gate.ts`.

- [ ] **Step 3: Implementar o adapter**

Criar `supabase/functions/_shared/ai-budget-gate.ts`:

```ts
/**
 * ADAPTER de I/O do orçamento de franquia de IA (Plano D).
 *
 * ZERO DECISÃO PRÓPRIA. Toda pergunta — "cabe?", "qual preço vigente?", "qual
 * marco cruzou?", "que janela é o ciclo?" — é respondida por núcleo puro
 * (`ai-budget-core.ts`, `ai-price-core.ts`, `ai-budget-milestones-core.ts`).
 * Este arquivo importa supabase-js e o vitest não o alcança: regra escrita aqui
 * só seria verificável por leitura, e leitura já deixou passar um
 * `ReferenceError` de autorização e um conflito FK × CHECK na 6b.
 *
 * MODO OBSERVAÇÃO (flag `ai_wallet_enforced` OFF): medição e ledger funcionam,
 * hard stop NÃO aplica. Nenhuma negação comercial acontece — é assim que se vê
 * o custo real por organização ANTES de qualquer bloqueio ligar (§21).
 *
 * NUNCA lê credencial de IA, nunca loga chave, nunca devolve SQL ou
 * `error.message` do Postgres para o chamador.
 *
 * REDEPLOY: consumidor único hoje é `webhook-whatsapp`. Linha correspondente em
 * docs/billing-asaas/PLANO-D-PENDENCIAS.md.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog } from "./security.ts";
import { isFlagEnabled } from "./platform-flags.ts";
import {
  AI_BUDGET_DEFAULT_LIMIT_CENTS,
  AI_RESERVATION_TTL_SECONDS,
  estimateCallTokens,
  estimateTurnCents,
  mapReserveDecision,
  planNextCall,
  resolveCycleWindow,
  type BeforeCallContext,
  type BeforeCallDecision,
} from "./ai-budget-core.ts";
import {
  priceUsage,
  selectEffectivePrice,
  type AiModelPrice,
  type AiUsageTokens,
} from "./ai-price-core.ts";
import {
  crossedMilestonePercents,
  EVENT_TYPE_BY_MILESTONE_PERCENT,
} from "./ai-budget-milestones-core.ts";
import type { AgentBudgetHooks, AgentCallMeta, AgentCallOutcome } from "./ai-providers.ts";
import type { PriceLookup } from "./ai-call-authorizer-core.ts";
import { enqueueBillingNotification, resolvePlatformAdminRecipients } from "./billing-notify.ts";

const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Data de HOJE em BRT. Deno roda em UTC; sem isto a virada do ciclo erra 3h. */
function todayBrt(): string {
  return new Date(Date.now() - BRT_OFFSET_MS).toISOString().slice(0, 10);
}

export interface TurnBudget {
  cycleId: string;
  limitCents: number;
  settledCents: number;
  state: string;
  reservationId: string;
  reservedCents: number;
  enforced: boolean;
}

export type OpenTurnResult =
  | { kind: "READY"; budget: TurnBudget }
  | { kind: "EXHAUSTED"; cycleId: string }
  | { kind: "ERROR"; sanitizedCode: string };

// ─── Preços ────────────────────────────────────────────────────────────────

/**
 * Cache por invocação, não por processo: a Edge Function pode ficar quente e um
 * preço recém-cadastrado precisa valer na próxima requisição — o mesmo motivo
 * de `unitCache` ser zerado no início de cada invocação dos workers.
 */
function makePriceResolver(supabase: SupabaseClient) {
  const cache = new Map<string, AiModelPrice[]>();

  return async function priceFor(provider: string, model: string): Promise<PriceLookup> {
    const key = `${provider}:${model}`;
    let rows = cache.get(key);
    if (!rows) {
      const { data, error } = await supabase
        .from("ai_model_prices")
        .select(
          "id, provider, model, input_usd_per_mtok, output_usd_per_mtok, cache_read_usd_per_mtok, cache_write_usd_per_mtok, reasoning_usd_per_mtok, usd_to_brl, effective_from, effective_to",
        )
        .eq("provider", provider)
        .eq("model", model);
      if (error) {
        // Falha de LEITURA não é "preço inexistente" — mas a consequência é a
        // mesma e é a segura: sem preço confirmado, nenhuma chamada.
        jsonLog("error", { evt: "ai_price_read_failed", provider, model, err: error.message });
        return { kind: "PRICE_UNKNOWN", provider, model };
      }
      rows = (data ?? []).map((r: Record<string, unknown>) => ({
        id: r.id as string,
        provider: r.provider as string,
        model: r.model as string,
        inputUsdPerMtok: Number(r.input_usd_per_mtok),
        outputUsdPerMtok: Number(r.output_usd_per_mtok),
        cacheReadUsdPerMtok: Number(r.cache_read_usd_per_mtok),
        cacheWriteUsdPerMtok: Number(r.cache_write_usd_per_mtok),
        reasoningUsdPerMtok: r.reasoning_usd_per_mtok === null ? null : Number(r.reasoning_usd_per_mtok),
        usdToBrl: Number(r.usd_to_brl),
        effectiveFrom: r.effective_from as string,
        effectiveTo: (r.effective_to as string | null) ?? null,
      }));
      cache.set(key, rows);
    }

    const price = selectEffectivePrice(rows, provider, model, new Date().toISOString());
    if (!price) {
      // Registro sanitizado: provider, modelo e organização. NUNCA a chave,
      // NUNCA o objeto de credenciais (§17.1).
      jsonLog("warn", { evt: "ai_price_unknown", provider, model });
      return { kind: "PRICE_UNKNOWN", provider, model };
    }
    return { kind: "PRICED", priceId: price.id };
  };
}

/** Devolve o preço completo (não só o id) para precificar usage e estimativa. */
async function loadPrice(
  supabase: SupabaseClient,
  provider: string,
  model: string,
): Promise<AiModelPrice | null> {
  const { data, error } = await supabase
    .from("ai_model_prices")
    .select(
      "id, provider, model, input_usd_per_mtok, output_usd_per_mtok, cache_read_usd_per_mtok, cache_write_usd_per_mtok, reasoning_usd_per_mtok, usd_to_brl, effective_from, effective_to",
    )
    .eq("provider", provider)
    .eq("model", model);
  if (error || !data) return null;
  const rows: AiModelPrice[] = data.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    provider: r.provider as string,
    model: r.model as string,
    inputUsdPerMtok: Number(r.input_usd_per_mtok),
    outputUsdPerMtok: Number(r.output_usd_per_mtok),
    cacheReadUsdPerMtok: Number(r.cache_read_usd_per_mtok),
    cacheWriteUsdPerMtok: Number(r.cache_write_usd_per_mtok),
    reasoningUsdPerMtok: r.reasoning_usd_per_mtok === null ? null : Number(r.reasoning_usd_per_mtok),
    usdToBrl: Number(r.usd_to_brl),
    effectiveFrom: r.effective_from as string,
    effectiveTo: (r.effective_to as string | null) ?? null,
  }));
  return selectEffectivePrice(rows, provider, model, new Date().toISOString());
}

// ─── Franquia (leitura para o entitlement) ─────────────────────────────────

/**
 * Estado do orçamento do ciclo corrente, para injetar em `resolveOrgEntitlements`.
 *
 * `null` = não há ciclo aberto ainda (organização que nunca usou IA). O núcleo
 * de entitlement trata ausência como "não consultado", nunca como "esgotado".
 */
export async function loadAiFranchise(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ state: "OPEN" | "EXHAUSTED" | "CLOSED"; remainingCents: number } | null> {
  const today = todayBrt();
  const { data, error } = await supabase
    .from("ai_cycle_budgets")
    .select("id, limit_cents, settled_cents, state")
    .eq("organization_id", organizationId)
    .lte("cycle_start", today)
    .gt("cycle_end", today)
    .maybeSingle();
  if (error || !data) return null;

  const { data: held } = await supabase
    .from("ai_cost_reservations")
    .select("reserved_cents, consumed_cents")
    .eq("cycle_id", data.id)
    .eq("status", "HELD");

  const committed = (held ?? []).reduce(
    (s: number, r: { reserved_cents: number; consumed_cents: number }) =>
      s + Math.max(r.reserved_cents - r.consumed_cents, 0),
    0,
  );

  return {
    state: data.state as "OPEN" | "EXHAUSTED" | "CLOSED",
    // Fórmula do núcleo — não reimplementada aqui.
    remainingCents: computeRemaining(data.limit_cents, data.settled_cents, committed),
  };
}

// Wrapper de uma linha só para manter a fórmula no núcleo puro e ainda assim
// não importar o nome duas vezes com significados diferentes.
import { computeAvailableCents } from "./ai-budget-core.ts";
function computeRemaining(limitCents: number, settledCents: number, committed: number): number {
  return computeAvailableCents({
    limitCents,
    settledCents,
    activeReservedRemainingCents: committed,
  });
}

// ─── Abertura do ciclo + reserva do turno ──────────────────────────────────

export async function openTurnBudget(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    turnId: string;
    requestId: string;
    provider: string;
    model: string;
  },
): Promise<OpenTurnResult> {
  const enforced = await isFlagEnabled("ai_wallet_enforced");

  // 1. Âncora: orçamento anterior > fim do período da assinatura de sistema >
  //    criação da organização. PERSISTIDA, nunca re-derivada.
  const [{ data: lastBudget }, { data: sub }, { data: org }] = await Promise.all([
    supabase
      .from("ai_cycle_budgets")
      .select("cycle_anchor_day")
      .eq("organization_id", args.organizationId)
      .order("cycle_start", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("billing_subscriptions")
      .select("current_period_start, current_period_end, billing_plans!inner(category)")
      .eq("organization_id", args.organizationId)
      .eq("billing_plans.category", "SYSTEM_SUBSCRIPTION")
      .neq("status", "canceled")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from("organizations").select("created_at").eq("id", args.organizationId).maybeSingle(),
  ]);

  const window = resolveCycleWindow({
    todayIso: todayBrt(),
    anchorDay: lastBudget?.cycle_anchor_day ?? null,
    subscriptionPeriodStartIso: sub?.current_period_start ?? null,
    subscriptionPeriodEndIso: sub?.current_period_end ?? null,
    orgCreatedAtIso: org?.created_at ?? new Date().toISOString(),
  });

  const { data: opened, error: openErr } = await supabase.rpc("open_ai_cycle_budget", {
    p_organization_id: args.organizationId,
    p_cycle_start: window.cycleStart,
    p_cycle_end: window.cycleEnd,
    p_anchor_day: window.anchorDay,
    p_limit_cents: AI_BUDGET_DEFAULT_LIMIT_CENTS,
  });
  const cycle = Array.isArray(opened) ? opened[0] : opened;
  if (openErr || !cycle) {
    jsonLog("error", {
      evt: "ai_budget_open_failed",
      org: args.organizationId,
      err: openErr?.message ?? "no_row",
    });
    return { kind: "ERROR", sanitizedCode: "budget_open_failed" };
  }

  if (cycle.state === "EXHAUSTED" && enforced) {
    return { kind: "EXHAUSTED", cycleId: cycle.id };
  }

  // 2. Estimativa da reserva inicial, precificada pelo modelo REAL do turno.
  const price = await loadPrice(supabase, args.provider, args.model);
  if (!price) {
    // Sem preço não há como estimar — e sem estimar não há reserva honesta.
    // Em modo observação isto NÃO impede o turno: o webhook segue sem hooks.
    jsonLog("warn", {
      evt: "ai_price_unknown",
      org: args.organizationId,
      provider: args.provider,
      model: args.model,
    });
    return { kind: "ERROR", sanitizedCode: "price_unknown" };
  }

  const estimate = estimateTurnCents((usage) => costOf(price, usage, args.provider, args.model));

  const { data: reserved, error: resErr } = await supabase.rpc("reserve_ai_budget", {
    p_organization_id: args.organizationId,
    p_cycle_id: cycle.id,
    p_turn_id: args.turnId,
    p_idempotency_key: `turn:${args.turnId}`,
    p_estimate_cents: estimate,
    p_ttl_seconds: AI_RESERVATION_TTL_SECONDS,
  });
  const row = Array.isArray(reserved) ? reserved[0] : reserved;
  if (resErr) {
    jsonLog("error", { evt: "ai_budget_reserve_failed", org: args.organizationId, err: resErr.message });
    return { kind: "ERROR", sanitizedCode: "reserve_failed" };
  }

  const decision = mapReserveDecision(row);
  if (decision.kind === "DENY_BUDGET") {
    if (!enforced) {
      jsonLog("warn", {
        evt: "ai_budget_deny_budget_observed",
        org: args.organizationId,
        note: "flag OFF: nenhuma negação aplicada",
      });
      // Modo observação: segue sem hooks. Medição do turno se perde, e é o
      // preço de não bloquear — nunca o contrário.
      return { kind: "ERROR", sanitizedCode: "observed_only" };
    }
    return { kind: "EXHAUSTED", cycleId: cycle.id };
  }
  if (decision.kind !== "ALLOW") {
    jsonLog("warn", { evt: "ai_budget_reserve_not_allowed", org: args.organizationId, kind: decision.kind });
    return { kind: "ERROR", sanitizedCode: "reserve_not_allowed" };
  }

  return {
    kind: "READY",
    budget: {
      cycleId: cycle.id,
      limitCents: cycle.limit_cents,
      settledCents: cycle.settled_cents,
      state: cycle.state,
      reservationId: decision.reservationId,
      reservedCents: row.reserved_cents ?? estimate,
      enforced,
    },
  };
}

function costOf(price: AiModelPrice, usage: AiUsageTokens, provider: string, model: string): number {
  const r = priceUsage(price, usage, provider, model);
  // Estimativa: `PRICE_UNKNOWN` aqui é impossível (o preço veio carregado), mas
  // devolver 0 em silêncio seria a falha que esta frente existe para matar.
  return r.kind === "PRICED" ? r.brlCents : Number.MAX_SAFE_INTEGER;
}

// ─── Hooks entregues ao runAgentLoop ───────────────────────────────────────

export function makeBudgetHooks(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    unitId: string | null;
    conversationId: string | null;
    requestId: string;
    turnId: string;
    budget: TurnBudget;
    provider: string;
  },
): AgentBudgetHooks {
  const priceFor = makePriceResolver(supabase);
  let consumedCents = 0;
  let reservedCents = args.budget.reservedCents;
  let usageUnresolved = false;
  let callSeq = 0;
  let lastEstimateCents = 0;

  return {
    organizationId: args.organizationId,
    cycleId: args.budget.cycleId,
    turnId: args.turnId,
    requestId: args.requestId,
    reservationId: args.budget.reservationId,
    newCallId: () => `${args.turnId}:${++callSeq}`,
    priceFor,

    snapshot(iteration: number) {
      // A estimativa da próxima chamada é precificada sob demanda pelo
      // `beforeCall`; aqui devolvemos a última calculada para o contexto.
      return { consumedCents, reservedCents, nextCallEstimateCents: lastEstimateCents };
    },

    async beforeCall(ctx: BeforeCallContext): Promise<BeforeCallDecision> {
      // Estimativa da PRÓXIMA chamada, no modelo REAL dela.
      const price = await loadPrice(supabase, ctx.provider, ctx.model);
      if (!price) {
        return { kind: "DENY_PRICE_UNKNOWN", provider: ctx.provider, model: ctx.model };
      }
      lastEstimateCents = costOf(price, estimateCallTokens(ctx.iteration), ctx.provider, ctx.model);

      const plan = planNextCall(
        { ...ctx, consumedCents, reservedCents, nextCallEstimateCents: lastEstimateCents },
        { usageUnresolved },
      );

      if (plan.kind === "DENY_USAGE_UNRESOLVED") {
        if (!args.budget.enforced) {
          jsonLog("warn", { evt: "ai_budget_usage_unresolved_observed", org: args.organizationId });
          return { kind: "ALLOW", reservationId: args.budget.reservationId, remainingReservedCents: 0 };
        }
        return { kind: "DENY_USAGE_UNRESOLVED", reasonCode: plan.reasonCode };
      }

      if (plan.kind === "ALLOW") {
        return {
          kind: "ALLOW",
          reservationId: args.budget.reservationId,
          remainingReservedCents: Math.max(reservedCents - consumedCents, 0),
        };
      }

      const { data, error } = await supabase.rpc("extend_ai_reservation", {
        p_organization_id: args.organizationId,
        p_reservation_id: args.budget.reservationId,
        p_additional_cents: plan.additionalCents,
      });
      if (error) {
        jsonLog("error", { evt: "ai_budget_extend_failed", org: args.organizationId, err: error.message });
        // Falha de infraestrutura NÃO é franquia esgotada.
        return { kind: "ERROR", retryable: true, sanitizedCode: "extend_failed" };
      }
      const row = Array.isArray(data) ? data[0] : data;
      const decision = mapReserveDecision(row);
      if (decision.kind === "ALLOW") {
        reservedCents = row.reserved_cents ?? reservedCents;
        consumedCents = row.consumed_cents ?? consumedCents;
        return decision;
      }
      if (decision.kind === "DENY_BUDGET" && !args.budget.enforced) {
        jsonLog("warn", { evt: "ai_budget_deny_budget_observed", org: args.organizationId });
        return { kind: "ALLOW", reservationId: args.budget.reservationId, remainingReservedCents: 0 };
      }
      return decision;
    },

    async reportCall(meta: AgentCallMeta, outcome: AgentCallOutcome, priceId: string) {
      const price = await loadPrice(supabase, meta.provider, meta.model);
      if (!price) {
        jsonLog("error", {
          evt: "ai_usage_price_vanished",
          org: args.organizationId,
          provider: meta.provider,
          model: meta.model,
        });
        return;
      }

      let usageState: string;
      let usage: AiUsageTokens;
      if (outcome.kind === "USAGE") {
        usageState = "SETTLED";
        usage = outcome.usage;
      } else if (outcome.kind === "PROVIDER_FAILED") {
        // Zero VERDADEIRO: o provedor falhou sem consumo apurável.
        usageState = "PROVIDER_FAILED";
        usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0 };
      } else {
        // A chamada OCORREU e o custo é indeterminado. NÃO gravar zero, NÃO
        // criar evento aparentemente liquidado: mantém-se ESTIMATIVA
        // CONSERVADORA COMPROMETIDA e a reserva sai da expiração automática.
        usageState = "USAGE_REVIEW_REQUIRED";
        usage = estimateCallTokens(meta.iteration);
        usageUnresolved = true;
      }

      const cost = priceUsage(price, usage, meta.provider, meta.model);
      if (cost.kind !== "PRICED") {
        jsonLog("error", { evt: "ai_usage_price_unknown_on_report", org: args.organizationId });
        return;
      }

      const { data, error } = await supabase.rpc("record_ai_call_usage", {
        p_organization_id: args.organizationId,
        p_cycle_id: args.budget.cycleId,
        p_reservation_id: args.budget.reservationId,
        p_unit_id: args.unitId,
        p_conversation_id: args.conversationId,
        p_turn_id: meta.turnId,
        p_request_id: meta.requestId,
        p_call_id: meta.callId,
        p_provider: meta.provider,
        p_model: meta.model,
        p_price_id: priceId,
        p_input_tokens: usage.input_tokens,
        p_output_tokens: usage.output_tokens,
        p_cache_read_tokens: usage.cache_read_tokens,
        p_cache_write_tokens: usage.cache_creation_tokens,
        p_reasoning_tokens: usage.reasoning_tokens,
        p_cost_usd: cost.usd,
        p_usd_to_brl: cost.usdToBrl,
        p_cost_brl_cents: usageState === "PROVIDER_FAILED" ? 0 : cost.brlCents,
        p_usage_state: usageState,
        // Idempotência: a MESMA call_id não liquida duas vezes.
        p_idempotency_key: `call:${meta.turnId}:${meta.callId}`,
      });
      if (error) {
        jsonLog("error", { evt: "ai_usage_record_failed", org: args.organizationId, err: error.message });
        // Propaga: apropriação silenciosamente perdida é o pior caso possível.
        throw new Error("ai_usage_record_failed");
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (row) {
        reservedCents = row.reserved_cents ?? reservedCents;
        consumedCents = row.consumed_cents ?? consumedCents;
        usageUnresolved = usageUnresolved || !!row.usage_review_required;
      }
    },
  };
}

// ─── Liquidação e marcos ───────────────────────────────────────────────────

export async function finalizeTurn(
  supabase: SupabaseClient,
  args: { organizationId: string; reservationId: string; status: "SETTLED" | "RELEASED" },
): Promise<{ settledCents: number; limitCents: number; state: string } | null> {
  const { data, error } = await supabase.rpc("finalize_ai_reservation", {
    p_organization_id: args.organizationId,
    p_reservation_id: args.reservationId,
    p_final_status: args.status,
  });
  if (error) {
    jsonLog("error", { evt: "ai_budget_finalize_failed", org: args.organizationId, err: error.message });
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return { settledCents: row.settled_cents, limitCents: row.limit_cents, state: row.state };
}

/**
 * Registra os marcos cruzados e enfileira o aviso interno.
 *
 * DISCIPLINA DE TRÊS TEMPOS (6b): o INSERT com `on conflict do nothing` é a
 * BARREIRA DE PERSISTÊNCIA — se ele não grava, nada é enfileirado. Só depois de
 * o enfileiramento confirmar é que `notified_at` é carimbado.
 *
 * A CADÊNCIA VIVE NO LEDGER: o UNIQUE de `billing_notifications` é parcial e não
 * deduplica com `invoice_id` nulo, e nenhum destes avisos tem fatura.
 *
 * Best-effort: nunca derruba o turno. O custo já está liquidado.
 */
export async function recordMilestones(
  supabase: SupabaseClient,
  args: { organizationId: string; cycleId: string; settledCents: number; limitCents: number },
): Promise<void> {
  const crossed = crossedMilestonePercents(args.settledCents, args.limitCents);
  if (crossed.length === 0) return;

  const recipients = await resolvePlatformAdminRecipients(supabase);
  const recipient = recipients[0] ?? null;
  const dispatchOn = await isFlagEnabled("billing_notifications_dispatch");

  for (const percent of crossed) {
    const { data: inserted, error } = await supabase
      .from("ai_budget_milestones")
      .insert({
        organization_id: args.organizationId,
        cycle_id: args.cycleId,
        milestone_percent: percent,
        settled_cents_at_cross: args.settledCents,
        limit_cents_at_cross: args.limitCents,
        dispatch_enabled_at_enqueue: dispatchOn,
      })
      .select("id")
      .maybeSingle();

    // 23505 = o marco já foi registrado neste ciclo. Cada marco dispara NO
    // MÁXIMO UMA VEZ por ciclo — a garantia é do UNIQUE, não deste laço.
    if (error) {
      if (error.code !== "23505") {
        jsonLog("error", { evt: "ai_budget_milestone_insert_failed", org: args.organizationId, err: error.message });
      }
      continue;
    }
    if (!inserted) continue;
    if (!recipient) {
      jsonLog("warn", { evt: "ai_budget_milestone_no_recipient", org: args.organizationId, percent });
      continue;
    }

    const queued = await enqueueBillingNotification(supabase, {
      organizationId: args.organizationId,
      eventType: EVENT_TYPE_BY_MILESTONE_PERCENT[percent],
      invoiceId: null,
      recipient,
    });

    const { data: stamped } = await supabase
      .from("ai_budget_milestones")
      .update({
        notified_at: queued ? new Date().toISOString() : null,
        enqueue_attempts: 1,
      })
      .eq("id", inserted.id)
      .eq("organization_id", args.organizationId)
      .select("id");

    // UPDATE que casa ZERO linhas devolve error:null — sem conferir o retorno,
    // "o predicado negou" é indistinguível de "gravei".
    if (!stamped || stamped.length === 0) {
      jsonLog("error", { evt: "ai_budget_milestone_stamp_missed", org: args.organizationId, percent });
    }
  }
}
```

- [ ] **Step 4: Rodar o guardrail, os gates e commitar**

```bash
npx vitest run src/lib/ai-budget-wiring-guard.test.ts
npm run test
npm run typecheck
npx eslint supabase/functions/_shared/ai-budget-gate.ts --max-warnings=0
git add supabase/functions/_shared/ai-budget-gate.ts src/lib/ai-budget-wiring-guard.test.ts
git commit -m "feat(plano-d): adapter de I/O do orcamento, com decisao delegada aos nucleos"
```

---

*(As tarefas 12 e 13 seguem em `2026-08-03-plano-d-franquia-ia-parte-5.md`.)*
