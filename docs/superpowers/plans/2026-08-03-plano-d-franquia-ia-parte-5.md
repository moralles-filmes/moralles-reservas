# Plano D — Parte 5 (Tasks 12 e 13: webhook e fechamento)

> Continuação de `2026-08-03-plano-d-franquia-ia.md`. **As Global Constraints daquele arquivo valem integralmente aqui.**

---

## Task 12: Ligação no `webhook-whatsapp`

**Files:**
- Modify: `supabase/functions/webhook-whatsapp/index.ts`
- Modify: `src/lib/ai-budget-wiring-guard.test.ts` (bloco novo)

**Interfaces:**
- Consumes: `loadAiFranchise`, `openTurnBudget`, `makeBudgetHooks`, `finalizeTurn`, `recordMilestones` de `ai-budget-gate.ts`; `AI_BUDGET_HANDOFF_REASON`, `shouldAutoResolveHandoff`, `isCommercialHardStop`, `telemetryEventFor` de `ai-budget-core.ts`; `AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT`, `AI_BUDGET_HARDCODED_TEXTS`, `resolveMutationStopText` de `ai-budget-copy.ts`; `resolveOrgEntitlements` de `entitlements.ts`; `AgentLoopResult` de `ai-providers.ts`.
- Produces: nada consumido por tarefas seguintes.

**Contexto obrigatório para o implementador:**

- **`runAgentLoop` agora devolve `AgentLoopResult`**, não `string`. O único caller é este arquivo.
- **Todo o caminho novo é gated por `ai.source === "franchise"`.** Override vitalício (Ren Sushi), carteira legada e BYOK puro **não entram**: `budgetHooks` fica `undefined` e o loop roda exatamente como hoje.
- **Nenhuma contagem de conversa/mensagem autoriza ou nega.**
- **O hard stop não desliga o canal** — o WhatsApp continua recebendo, a conversa continua visível, o atendimento humano continua possível.
- **`sanitizeForWhatsApp` só se aplica a saída de LLM.** Os textos determinísticos **não** passam por ele (são hardcoded, como `MEDIA_REPLY_TEXT`).
- Ao negar depois de ferramenta mutante: **preservar o efeito, não repetir a ferramenta, não dar retry integral**, e responder com o texto determinístico da situação correta.

- [ ] **Step 1: Escrever o bloco de guardrail que falha**

Acrescentar a `src/lib/ai-budget-wiring-guard.test.ts`:

```ts
const webhook = readFileSync(
  join(__dirname, "..", "..", "supabase", "functions", "webhook-whatsapp", "index.ts"),
  "utf8",
);

describe("webhook-whatsapp — ligação da franquia", () => {
  it("importa o adapter e os núcleos, sem reimplementar decisão", () => {
    expect(webhook).toContain('from "../_shared/ai-budget-gate.ts"');
    expect(webhook).toContain('from "../_shared/ai-budget-copy.ts"');
    for (const fn of ["openTurnBudget", "makeBudgetHooks", "finalizeTurn", "recordMilestones", "loadAiFranchise"]) {
      expect(webhook, `não usa ${fn}`).toContain(fn);
    }
  });

  it("os textos determinísticos entram no HARDCODED_AGENT_NOISE pela LISTA, não redigitados", () => {
    // Sem isto a mensagem de bloqueio polui o histórico das invocações
    // seguintes — mesmo motivo de MEDIA_REPLY_TEXT.
    const i = webhook.indexOf("HARDCODED_AGENT_NOISE");
    const block = webhook.slice(i, i + 900);
    expect(block).toContain("AI_BUDGET_HARDCODED_TEXTS");
    expect(block).toMatch(/\.\.\.AI_BUDGET_HARDCODED_TEXTS/);
  });

  it("o hard stop usa razão de handoff PRÓPRIA, distinta de agent_error", () => {
    expect(webhook).toContain("AI_BUDGET_HANDOFF_REASON");
    expect(webhook).not.toMatch(/handoff_reason:\s*"ai_budget_exhausted"/);
  });

  it("o auto-resolve consulta o núcleo em vez de comparar idade cru", () => {
    expect(webhook).toContain("shouldAutoResolveHandoff");
  });

  it("a franquia só entra quando o entitlement resolve por franchise", () => {
    expect(webhook).toMatch(/ai\.source\s*===\s*"franchise"/);
  });

  it("o texto determinístico NÃO passa por sanitizeForWhatsApp", () => {
    // sanitizeForWhatsApp aplica-se só a saída de LLM.
    for (const m of webhook.matchAll(/sanitizeForWhatsApp\(([^)]*)\)/g)) {
      expect(m[1]).not.toMatch(/AI_BUDGET_|budgetStopText/);
    }
  });

  it("negação por orçamento não repete ferramenta mutante nem dá retry integral", () => {
    const i = webhook.indexOf("agentOutcome.kind === \"DENIED\"");
    expect(i, "bloco de negação não encontrado").toBeGreaterThan(-1);
    const block = webhook.slice(i, i + 3000);
    expect(block).toContain("mutatingToolUsed");
    expect(block).toContain("resolveMutationStopText");
    expect(block).not.toContain("runOnce()");
  });

  it("a variante ERROR não é tratada como franquia esgotada", () => {
    expect(webhook).toContain("isCommercialHardStop");
  });

  it("cada variante emite telemetria própria", () => {
    expect(webhook).toContain("telemetryEventFor");
  });

  it("a reserva é finalizada em TODOS os desfechos do turno", () => {
    // Sem liquidação/liberação, a reserva fica presa até o TTL e come teto.
    const settles = [...webhook.matchAll(/finalizeTurn\(/g)];
    expect(settles.length).toBeGreaterThanOrEqual(3);
    expect(webhook).toContain('"SETTLED"');
    expect(webhook).toContain('"RELEASED"');
  });

  it("nenhum valor de custo, token ou limite é enviado ao cliente final", () => {
    for (const m of webhook.matchAll(/sendOutbound\([^;]{0,600};/g)) {
      expect(m[0]).not.toMatch(/settledCents|limitCents|budgetRemaining|cost_brl|estimated_cost/);
    }
  });

  it("budgetRemainingCents nunca sai numa resposta HTTP do webhook", () => {
    expect(webhook).not.toMatch(/budgetRemainingCents[\s\S]{0,200}new Response/);
  });

  it("nenhuma contagem de conversa autoriza a IA", () => {
    expect(webhook).not.toMatch(/conversationCount|messageQuota|interactionLimit/);
  });

  it("controle positivo: o detector acha um símbolo que sabidamente existe", () => {
    expect(webhook.includes("MEDIA_REPLY_TEXT")).toBe(true);
    expect(webhook.includes("SIMBOLO_QUE_NAO_EXISTE")).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/ai-budget-wiring-guard.test.ts`
Expected: FAIL — o webhook ainda não importa o adapter.

- [ ] **Step 3: Acrescentar os imports**

No topo de `supabase/functions/webhook-whatsapp/index.ts`, junto dos demais imports de `_shared`:

```ts
import {
  loadAiFranchise,
  openTurnBudget,
  makeBudgetHooks,
  finalizeTurn,
  recordMilestones,
  type TurnBudget,
} from "../_shared/ai-budget-gate.ts";
import {
  AI_BUDGET_HANDOFF_REASON,
  isCommercialHardStop,
  shouldAutoResolveHandoff,
  telemetryEventFor,
} from "../_shared/ai-budget-core.ts";
import {
  AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT,
  AI_BUDGET_HARDCODED_TEXTS,
  resolveMutationStopText,
  type MutationOutcome,
} from "../_shared/ai-budget-copy.ts";
import { resolveOrgEntitlements } from "../_shared/entitlements.ts";
import type { AgentBudgetHooks, AgentLoopResult } from "../_shared/ai-providers.ts";
```

- [ ] **Step 4: Estender o `HARDCODED_AGENT_NOISE`**

Substituir o `Set` da linha ~1997 por:

```ts
    const HARDCODED_AGENT_NOISE = new Set<string>([
      "Tive um instante de instabilidade aqui. Já chamei alguém da equipe pra te responder. Em breve um humano assume.",
      "Desculpa, não consegui montar uma resposta agora. Pode reformular ou aguardar um instante?",
      "Desculpe, não consegui processar sua solicitação. Tente novamente.",
      // Plano D: os textos determinísticos do bloqueio por franquia entram pela
      // LISTA, nunca redigitados — é o que impede que um texto novo apareça sem
      // entrar no filtro. Mesmo motivo de MEDIA_REPLY_TEXT: sem isso a mensagem
      // polui o histórico das invocações seguintes e ensina o modelo que
      // "atendimento interrompido" é o padrão.
      ...AI_BUDGET_HARDCODED_TEXTS,
    ]);
```

- [ ] **Step 5: Corrigir o auto-resolve do handoff**

Substituir as linhas ~1827-1829 (cálculo de `shouldAutoResolve`) por:

```ts
      const silenceStart = Math.max(handoffStart, lastHumanTs);
      const handoffAge = silenceStart ? Date.now() - silenceStart : 0;

      // Handoff por franquia esgotada NÃO volta para a IA pelo decurso do
      // prazo: devolveria a conversa a uma IA que não pode responder. Só a
      // virada do ciclo (orçamento não mais esgotado) devolve. A leitura do
      // orçamento só acontece quando a razão é essa — nenhum custo nos demais.
      let budgetStillExhausted = false;
      if (conv.handoff_reason === AI_BUDGET_HANDOFF_REASON) {
        const franchise = await loadAiFranchise(supabase, organizationId);
        budgetStillExhausted = franchise?.state === "EXHAUSTED";
      }

      const shouldAutoResolve =
        silenceStart > 0 &&
        shouldAutoResolveHandoff({
          handoffReason: conv.handoff_reason ?? null,
          ageMs: handoffAge,
          thresholdMs: HANDOFF_AUTO_RESOLVE_MS,
          budgetExhausted: budgetStillExhausted,
        });
```

- [ ] **Step 6: Resolver a franquia e aplicar o hard stop (bloco A)**

Inserir **imediatamente antes** do comentário `// Load AI config from settings (unit-scoped)` (linha ~2051):

```ts
    // ─── Franquia de IA (Plano D) ────────────────────────────────────────────
    // Resolve o entitlement de IA COM o estado do orçamento. Só o ramo
    // `franchise` entra no caminho novo: override vitalício (Ren Sushi),
    // carteira legada e BYOK puro seguem exatamente como antes.
    const aiFranchiseState = await loadAiFranchise(supabase, organizationId);
    const entitlements = await resolveOrgEntitlements(
      supabase,
      organizationId,
      undefined,
      aiFranchiseState ?? undefined,
    );
    const isFranchise = entitlements.ai.source === "franchise";

    if (isFranchise && !entitlements.ai.allowed) {
      // HARD STOP. O canal NÃO é desligado, o sistema NÃO é bloqueado, a
      // conversa continua visível e o atendimento humano continua possível
      // (§18.3). Nada de "falha técnica": não houve falha nenhuma.
      await appendToConversation(conv.id, conv.messages || [], "user", incomingText);
      await supabase
        .from("conversations")
        .update({
          status: "awaiting_human",
          handoff_reason: AI_BUDGET_HANDOFF_REASON,
          handoff_at: new Date().toISOString(),
          last_silenced_reply_at: null,
        })
        .eq("id", conv.id);

      // Texto determinístico, hardcoded. NÃO passa por sanitizeForWhatsApp
      // (só saída de LLM passa) e NÃO expõe custo, tokens, modelo ou limite.
      await sendOutbound(provider, credentials, {
        toPhone: phone,
        text: AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT,
      });
      await appendToConversation(
        conv.id,
        conv.messages || [],
        "assistant",
        AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT,
      );

      jsonLog("warn", {
        requestId,
        evt: "ai_budget_exhausted_handoff",
        unitId,
        organizationId,
        convId: conv.id,
      });
      await finish("ai_budget_exhausted");
      await releaseAiLock();
      return new Response("ok");
    }
```

- [ ] **Step 7: Abrir o orçamento e montar os hooks (bloco B)**

Inserir **imediatamente antes** de `const totalUsage = { ... }` (linha ~2451):

```ts
    // Reserva ATÔMICA antes de iniciar o turno. O passo é onde o teto é
    // aplicado — verificar depois da chamada não é proteção, é detecção.
    const turnId = `${conv.id}:${requestId}`;
    let budgetHooks: AgentBudgetHooks | undefined;
    let turnBudget: TurnBudget | null = null;

    if (isFranchise) {
      const opened = await openTurnBudget(supabase, {
        organizationId,
        turnId,
        requestId,
        provider: provider_ai,
        model: modelOverride,
      });

      if (opened.kind === "EXHAUSTED") {
        // A franquia esgotou entre a resolução do entitlement e a reserva
        // (turno concorrente liquidou). Mesmo desfecho do bloco A.
        await supabase
          .from("conversations")
          .update({
            status: "awaiting_human",
            handoff_reason: AI_BUDGET_HANDOFF_REASON,
            handoff_at: new Date().toISOString(),
            last_silenced_reply_at: null,
          })
          .eq("id", conv.id);
        await sendOutbound(provider, credentials, {
          toPhone: phone,
          text: AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT,
        });
        await appendToConversation(
          conv.id,
          [...(conv.messages || []), { role: "user", content: incomingText }],
          "assistant",
          AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT,
        );
        jsonLog("warn", { requestId, evt: "ai_budget_exhausted_on_reserve", unitId, organizationId });
        await finish("ai_budget_exhausted");
        await releaseAiLock();
        return new Response("ok");
      }

      if (opened.kind === "READY") {
        turnBudget = opened.budget;
        budgetHooks = makeBudgetHooks(supabase, {
          organizationId,
          unitId,
          conversationId: conv.id,
          requestId,
          turnId,
          budget: opened.budget,
          provider: provider_ai,
        });
      } else if (opened.sanitizedCode === "observed_only") {
        // Flag OFF: nenhuma negação comercial acontece. O turno segue SEM
        // medição — o preço de não bloquear, nunca o contrário.
        jsonLog("warn", { requestId, evt: "ai_budget_observed_only", unitId, organizationId });
      } else {
        // ERROR de infraestrutura. NÃO é franquia esgotada, e a copy tem de
        // dizer outra coisa. Com a flag LIGADA não podemos chamar o LLM sem
        // medir (consumo não contabilizado); com ela desligada, seguimos.
        jsonLog("error", {
          requestId,
          evt: "ai_budget_open_error",
          unitId,
          organizationId,
          code: opened.sanitizedCode,
        });
        const enforcedNow = await isFlagEnabled("ai_wallet_enforced");
        if (enforcedNow) {
          await supabase
            .from("conversations")
            .update({
              status: "awaiting_human",
              handoff_reason: `ai_budget_error:${opened.sanitizedCode}`,
              handoff_at: new Date().toISOString(),
              last_silenced_reply_at: null,
            })
            .eq("id", conv.id);
          // Texto de instabilidade JÁ EXISTENTE no noise set — não é franquia
          // esgotada e não pode dizer que é.
          const errText = "Tive um instante de instabilidade aqui. Já chamei alguém da equipe pra te responder. Em breve um humano assume.";
          await sendOutbound(provider, credentials, { toPhone: phone, text: errText });
          await appendToConversation(
            conv.id,
            [...(conv.messages || []), { role: "user", content: incomingText }],
            "assistant",
            errText,
          );
          await finish("ai_budget_error", opened.sanitizedCode);
          await releaseAiLock();
          return new Response("ok");
        }
      }
    }
```

> `isFlagEnabled` já precisa estar importado de `../_shared/platform-flags.ts` — confirmar; o webhook já o importa desde a Fase 5b Task 15.

- [ ] **Step 8: Rastrear o desfecho da última ferramenta mutante**

Junto de `let mutatingToolUsed = false;` (linha ~2455):

```ts
    let mutatingToolUsed = false;
    // Desfecho da ÚLTIMA ferramenta mutante. Na dúvida, UNKNOWN: afirmar
    // conclusão de uma ação que ainda exige validação é o erro que produz
    // cliente aparecendo no restaurante sem mesa (§17.7.4).
    let lastMutationOutcome: MutationOutcome = "UNKNOWN";
```

Em cada `case` mutante, depois de `result = await ...`, classificar:

```ts
              case "create_reservation":
                mutatingToolUsed = true; // desliga o retry silencioso (evita reserva duplicada)
                result = await createReservation({ ...input, phone, unit_id: unitId!, organization_id: organizationId });
                lastMutationOutcome = result?.requires_payment
                  ? "PENDING"
                  : result?.ok === true
                    ? "COMPLETED"
                    : "UNKNOWN";
                break;
```

E o análogo em `update_reservation` / `cancel_reservation` (`result?.ok === true ? "COMPLETED" : "UNKNOWN"`).

- [ ] **Step 9: Passar os hooks e tratar o resultado discriminado**

Em `runOnce`, acrescentar `budget: budgetHooks,` ao objeto passado a `runAgentLoop`.

Substituir o laço de retry (linhas ~2520-2540) e o que vem depois por:

```ts
    let agentOutcome: AgentLoopResult | null = null;
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        agentOutcome = await runOnce();
        agentError = null;
        break;
      } catch (err) {
        agentError = String(err);
        jsonLog("error", { requestId, evt: "agent_loop_error", attempt, err: agentError });
        const elapsed = Date.now() - t0;
        if (attempt === 0 && !mutatingToolUsed && elapsed < AGENT_RETRY_BUDGET_MS) {
          jsonLog("warn", { requestId, evt: "agent_retry", elapsed_ms: elapsed });
          continue;
        }
        break;
      }
    }
    finalText = agentOutcome && agentOutcome.kind === "TEXT" ? agentOutcome.text : "";
```

Logo depois do `jsonLog` de `agent_usage` (linha ~2552), acrescentar o tratamento da negação — **antes** do bloco `if (agentError)`:

```ts
    // ─── Negação de orçamento durante o turno ────────────────────────────────
    // O efeito de ferramenta mutante já persistido NÃO é descartado, a
    // ferramenta NÃO é repetida, o turno NÃO recebe retry integral, e a
    // resposta é texto DETERMINÍSTICO — gerar com IA a explicação de que a IA
    // foi bloqueada exigiria justamente a chamada que foi negada.
    if (agentOutcome && agentOutcome.kind === "DENIED") {
      const decision = agentOutcome.decision;
      const hardStop = isCommercialHardStop(decision);

      // Liquida o que JÁ foi consumido antes da negação. A reserva não pode
      // ficar presa até o TTL comendo teto.
      if (turnBudget) {
        const fin = await finalizeTurn(supabase, {
          organizationId,
          reservationId: turnBudget.reservationId,
          status: "SETTLED",
        });
        if (fin) {
          await recordMilestones(supabase, {
            organizationId,
            cycleId: turnBudget.cycleId,
            settledCents: fin.settledCents,
            limitCents: fin.limitCents,
          });
        }
      }

      // Razão PRÓPRIA por variante: `ai_budget_exhausted` é a única que
      // significa que a franquia acabou. As demais são fail-closed técnico e
      // não podem afirmar isso ao cliente nem ao admin.
      const handoffReason = hardStop
        ? AI_BUDGET_HANDOFF_REASON
        : decision.kind === "DENY_PRICE_UNKNOWN"
          ? `ai_price_unknown:${decision.provider}:${decision.model}`
          : decision.kind === "DENY_USAGE_UNRESOLVED"
            ? "ai_usage_unresolved"
            : "ai_budget_error";

      await supabase
        .from("conversations")
        .update({
          status: "awaiting_human",
          handoff_reason: handoffReason,
          handoff_at: new Date().toISOString(),
          last_silenced_reply_at: null,
        })
        .eq("id", conv.id);

      // Copy: só o hard stop usa o texto de franquia. As três situações de
      // ferramenta mutante têm textos distintos — usar a mesma frase para as
      // três é o erro que produz cliente aparecendo no restaurante sem mesa.
      const stopText = hardStop
        ? mutatingToolUsed
          ? resolveMutationStopText(lastMutationOutcome)
          : AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT
        : "Tive um instante de instabilidade aqui. Já chamei alguém da equipe pra te responder. Em breve um humano assume.";

      await sendOutbound(provider, credentials, { toPhone: phone, text: stopText });
      await appendToConversation(
        conv.id,
        [...(conv.messages || []), { role: "user", content: incomingText }],
        "assistant",
        stopText,
      );

      jsonLog("warn", {
        requestId,
        evt: telemetryEventFor(decision),
        unitId,
        organizationId,
        convId: conv.id,
        provider: provider_ai,
        model: agentOutcome.meta.model,
        iteration: agentOutcome.meta.iteration,
        mutating_tool_used: mutatingToolUsed,
      });

      await finish(hardStop ? "ai_budget_exhausted" : "ai_budget_denied", undefined, {
        decision: decision.kind,
        provider: provider_ai,
        model: agentOutcome.meta.model,
      });
      await releaseAiLock();
      return new Response("ok");
    }
```

- [ ] **Step 10: Liberar a reserva em falha e liquidar no sucesso**

No bloco `if (agentError) { ... }`, **antes** do `update` da conversa:

```ts
      // Falha do provedor: libera a reserva. O que JÁ foi consumido migra para
      // o liquidado; a diferença volta ao disponível.
      if (turnBudget) {
        await finalizeTurn(supabase, {
          organizationId,
          reservationId: turnBudget.reservationId,
          status: "RELEASED",
        });
      }
```

No caminho de resposta vazia (`if (!finalText || !finalText.trim())`), antes do `finish("empty_response")`, o mesmo bloco com `status: "RELEASED"`.

E no caminho de sucesso, **antes** de `await finish("success", ...)`:

```ts
    // Fim do turno: liquida o custo real e devolve a diferença ao disponível.
    if (turnBudget) {
      const fin = await finalizeTurn(supabase, {
        organizationId,
        reservationId: turnBudget.reservationId,
        status: "SETTLED",
      });
      if (fin) {
        await recordMilestones(supabase, {
          organizationId,
          cycleId: turnBudget.cycleId,
          settledCents: fin.settledCents,
          limitCents: fin.limitCents,
        });
      }
    }
```

E, no `catch` externo do handler (linha ~2620), antes de `releaseAiLock()`, **não** finalizar: a reserva expira pelo TTL. Acrescentar comentário explicando que é deliberado (o estado do turno é desconhecido nesse ponto, e liquidar às cegas gravaria custo que talvez não tenha ocorrido).

- [ ] **Step 11: Rodar tudo e commitar**

```bash
npx vitest run src/lib/ai-budget-wiring-guard.test.ts
npm run test
npm run typecheck
npx eslint supabase/functions --max-warnings=0
git add supabase/functions/webhook-whatsapp/index.ts src/lib/ai-budget-wiring-guard.test.ts
git commit -m "feat(plano-d): ligacao da franquia no webhook — reserva, liquidacao, hard stop e copy deterministica"
```

---

## Task 13: Pendências, guardrail de redeploy e gates finais

**Files:**
- Create: `docs/billing-asaas/PLANO-D-PENDENCIAS.md`
- Create: `src/lib/ai-budget-redeploy-guard.test.ts`

**Interfaces:**
- Consumes: tudo.
- Produces: o documento que substitui a edição do `CLAUDE.md` (proibida nesta frente).

- [ ] **Step 1: Escrever o guardrail de redeploy (testes 46 e 47 da spec)**

Criar `src/lib/ai-budget-redeploy-guard.test.ts`:

```ts
/**
 * Testes 46 e 47 da spec: o checklist de redeploy é EXATO ou não serve.
 *
 * Redeploy desnecessário não é inofensivo — ele treina a leitura de que o
 * checklist é aproximado, e o checklist só funciona enquanto for exato: é ele
 * que impede metade do sistema de rodar com `_shared/` velho em memória.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FUNCTIONS = join(__dirname, "..", "..", "supabase", "functions");
const PENDENCIAS = join(__dirname, "..", "..", "docs", "billing-asaas", "PLANO-D-PENDENCIAS.md");

function importersOf(shared: string): string[] {
  const out: string[] = [];
  for (const dir of readdirSync(FUNCTIONS)) {
    if (dir.startsWith("_")) continue;
    const idx = join(FUNCTIONS, dir, "index.ts");
    try {
      if (!statSync(idx).isFile()) continue;
    } catch {
      continue;
    }
    if (readFileSync(idx, "utf8").includes(`../_shared/${shared}`)) out.push(dir);
  }
  return out.sort();
}

describe("teste 46 — só webhook-whatsapp consome ai-providers.ts", () => {
  it("nenhuma outra Edge Function importa ai-providers.ts em runtime", () => {
    expect(importersOf("ai-providers.ts")).toEqual(["webhook-whatsapp"]);
  });
});

describe("teste 47 — manage-ai-providers só entra quando o catálogo mudar", () => {
  it("manage-ai-providers não importa ai-providers.ts", () => {
    const src = readFileSync(join(FUNCTIONS, "manage-ai-providers", "index.ts"), "utf8");
    expect(src).not.toContain("../_shared/ai-providers.ts");
  });

  it("o documento de pendências registra a distinção, e não põe manage-ai-providers no redeploy do beforeCall", () => {
    const doc = readFileSync(PENDENCIAS, "utf8");
    const i = doc.indexOf("ai-providers.ts");
    expect(i, "linha de ai-providers.ts ausente no checklist").toBeGreaterThan(-1);
    const line = doc.slice(i, doc.indexOf("\n", i));
    expect(line).toContain("webhook-whatsapp");
    expect(line).not.toContain("manage-ai-providers");
  });
});

describe("checklist de redeploy dos arquivos novos", () => {
  const doc = readFileSync(PENDENCIAS, "utf8");
  const NEW_SHARED = [
    "ai-price-core.ts",
    "ai-budget-core.ts",
    "ai-budget-milestones-core.ts",
    "ai-budget-copy.ts",
    "ai-call-authorizer-core.ts",
    "ai-budget-gate.ts",
  ];

  for (const f of NEW_SHARED) {
    it(`${f} tem linha própria no checklist`, () => {
      expect(doc).toContain(f);
    });
  }

  it("entitlements-core.ts aparece com as três consumidoras já conhecidas", () => {
    const i = doc.indexOf("entitlements-core.ts");
    expect(i).toBeGreaterThan(-1);
    const block = doc.slice(i, i + 400);
    for (const ef of ["manage-billing", "create-billing-checkout", "manage-whatsapp-implementations"]) {
      expect(block).toContain(ef);
    }
    // webhook-whatsapp passou a consumir entitlements.ts nesta frente.
    expect(block).toContain("webhook-whatsapp");
  });

  it("o acoplamento por string com process-billing-notifications está registrado", () => {
    expect(doc).toContain("process-billing-notifications");
    expect(doc).toMatch(/admin_ai_budget/);
  });

  it("a ordem obrigatória migration-antes-de-deploy está escrita", () => {
    expect(doc).toMatch(/migration[\s\S]{0,200}antes[\s\S]{0,200}deploy/i);
  });
});

describe("pendências não declaráveis por teste unitário", () => {
  const doc = readFileSync(PENDENCIAS, "utf8");

  it("os testes 42 e 44 aparecem como PENDENTES, não como concluídos", () => {
    expect(doc).toMatch(/42/);
    expect(doc).toMatch(/44/);
    expect(doc).toMatch(/PENDENTE|pendente/);
  });

  it("o gate comercial continua NO-GO", () => {
    expect(doc).toContain("PLAN_AUTOMACAO_CHECKOUT");
    expect(doc).toMatch(/NO-GO/);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/ai-budget-redeploy-guard.test.ts`
Expected: FAIL — `ENOENT ... PLANO-D-PENDENCIAS.md`.

- [ ] **Step 3: Escrever `docs/billing-asaas/PLANO-D-PENDENCIAS.md`**

```markdown
# Pendências do Plano D — franquia de IA inclusa

Fase 7 redefinida (spec §17-18). Ambiente sem Docker. **Nenhuma migration
aplicada, nenhuma Edge Function deployada, nenhuma flag alterada, nenhum cron
criado.** Tudo abaixo é o que a suíte verde NÃO prova.

## Gates desta entrega

| Gate | Resultado |
|---|---|
| `npm run test` | (preencher na execução) |
| `npm run typecheck` | (preencher) |
| `npm run lint` | (preencher) |
| `npx eslint supabase/functions --max-warnings=0` | (preencher) |

---

## 1. Depende de banco real — testes 42 e 44 seguem **PENDENTES**

Núcleo puro prova que a **fórmula** está certa. Ele não prova que o
`SELECT ... FOR UPDATE` serializa, que o `EXCLUDE` existe, nem que a RPC é
`SECURITY DEFINER` com os grants certos.

- **Teste 42 — duas reservas concorrentes não usam o mesmo saldo.** Roteiro em
  `20260803090300_102_ai_budget_rpcs.sql`, bloco "Validação pós-migration", item 3.
- **Teste 44 — dois ciclos sobrepostos são rejeitados.** Roteiro em
  `20260803090100_100_ai_cycle_budgets.sql`, item 2.
- **`btree_gist` nunca foi criada neste projeto.** As duas migrations que
  dependem dela (099 e 100) falham por inteiro se a extensão não estiver
  disponível — e **falhar é o comportamento certo**: sem o `EXCLUDE`, a
  não sobreposição deixa de ser garantia de banco e vira promessa.
- **RLS, grants e a guarda de tenant nunca exercitados** contra INSERT real.
- **O CHECK `ai_usage_events_zero_chk` nunca foi exercitado.**

**Enquanto não houver prova contra banco real, não declarar o teto
financeiramente seguro e manter `PLAN_AUTOMACAO_CHECKOUT = NO-GO`.**

## 2. Depende de deploy

**Ordem obrigatória:** `db push` de 099→103 **antes** do deploy de qualquer
Edge Function que leia as tabelas novas. Coluna/tabela inexistente vira 400 do
PostgREST → leitura falha → o gate fail-closed nega para todo mundo (foi assim
que `manage-channels` respondeu 403 `PROVISIONING_UNVERIFIABLE` a toda unidade
sem canal, inclusive platform_admin).

Depois: **`process-billing-notifications` primeiro**, antes de qualquer produtor
dos quatro `admin_ai_budget_*`. Só então `webhook-whatsapp`.

## 3. CLAUDE.md a consolidar

> Esta frente **não edita** `CLAUDE.md` (três frentes em paralelo editam o mesmo
> arquivo; a consolidação é um commit único no fim, fora deste chat). O que
> entraria no checklist de redeploy está aqui, pronto para colar.

**Checklist de redeploy — linhas novas:**

- **`ai-price-core.ts`** (núcleo puro, testado em `src/lib/ai-price-core.test.ts`) → `webhook-whatsapp` (via `ai-budget-gate.ts` e `ai-call-authorizer-core.ts`). Decide vigência de preço e o `CostResult` discriminado; redeploy parcial deixa uma ponta precificando com vigência velha em memória.
- **`ai-budget-core.ts`** (núcleo puro, testado em `src/lib/ai-budget-core.test.ts`) → `webhook-whatsapp` (via `ai-budget-gate.ts` e `ai-providers.ts`). Carrega a fórmula do teto, a janela do ciclo, a estimativa conservadora e a união `BeforeCallDecision`.
- **`ai-budget-milestones-core.ts`** (núcleo puro) → `webhook-whatsapp` (via `ai-budget-gate.ts`). **Fonte canônica dos quatro `admin_ai_budget_*`.**
- **`ai-budget-copy.ts`** (núcleo puro) → `webhook-whatsapp`. Os textos determinísticos do bloqueio; mudá-los sem redeployar deixa o `HARDCODED_AGENT_NOISE` filtrando frases que já não são emitidas.
- **`ai-call-authorizer-core.ts`** (núcleo puro, testado em `src/lib/ai-call-authorizer-core.test.ts`) → `webhook-whatsapp` (via `ai-providers.ts`). O protocolo ordenado de §17.7.3.
- **`ai-budget-gate.ts`** (adapter de I/O) → `webhook-whatsapp`. Consumidor único hoje.
- **`ai-providers.ts`** → **`webhook-whatsapp` apenas** — é o único importador de runtime, verificado por teste (`src/lib/ai-budget-redeploy-guard.test.ts`). A linha do checklist que cita `manage-ai-providers` existe por OUTRA razão: o invariante de **sincronização do catálogo de modelos** (`DEFAULT_MODELS`, `KNOWN_MODELS`, `MODELS_BY_PROVIDER`, `DEFAULT_MODEL_BY_PROVIDER`). O Plano D não toca o catálogo, logo **não** exige redeploy de `manage-ai-providers`.
- **`entitlements.ts` / `entitlements-core.ts`** → acrescentar **`webhook-whatsapp`** às consumidoras já listadas (`manage-billing`, `create-billing-checkout`, `manage-whatsapp-implementations`): o webhook passou a resolver entitlements para descobrir se a organização está no ramo de franquia.
- **`whatsapp-instance-cycle-core.ts`** → acrescentar **`webhook-whatsapp`** (via `ai-budget-core.ts`, que reusa `clampDayToMonth` em vez de reimplementar a aritmética de âncora).
- **`billing-notify.ts`** → acrescentar **`webhook-whatsapp`** (via `ai-budget-gate.ts`: `resolvePlatformAdminRecipients` + `enqueueBillingNotification`).
- **`platform-flags.ts`** → `webhook-whatsapp` já consta; a flag lida agora inclui `ai_wallet_enforced`.

**Acoplamento por string — SEXTA ocorrência:** `webhook-whatsapp` (via
`ai-budget-gate.ts`) enfileira `admin_ai_budget_70|80|90|stop`, e é
`process-billing-notifications` (`TEMPLATE_BY_EVENT`) quem sabe renderizá-los.
As duas EFs **não compartilham nenhum `_shared/`** para esse acoplamento — é só
o `event_type`. Deployar o produtor sozinho é inofensivo (a linha fica
`pending`); deployar com um `process-billing-notifications` anterior a este
commit mata o aviso em `failed/unknown_event_type` exatamente quando importa.
Teste bidirecional: `src/lib/ai-budget-dispatcher.test.ts`.

**Invariantes novos (candidatos a linha no CLAUDE.md):**

- **A franquia de IA tem teto FINANCEIRO e nenhum teto de volume.** Qualquer código que conte conversas, mensagens ou interações para autorizar ou negar está errado. `_shared/ai-budget-core.ts`.
- **`beforeCall` devolve união discriminada, nunca boolean.** `ERROR` de infraestrutura e `DENY_BUDGET` levam ao mesmo destino operacional mas dizem coisas opostas ao cliente e ao admin — só uma significa que a franquia acabou. `_shared/ai-budget-core.ts`.
- **`estimateCostUsd` serve telemetria; o orçamento usa `ai-price-core.ts`.** O primeiro devolve zero para modelo desconhecido, e zero no caminho de orçamento é consumo ilimitado sem tocar o teto. Não unificar. `_shared/ai-providers.ts`.
- **A chamada de fallback do Gemini é chamada financeira própria** — autorização, preço do modelo real e `call_id` próprios; sem usage da primeira, a segunda recebe `DENY_USAGE_UNRESOLVED`. `_shared/ai-providers.ts`.
- **`settled_cents` e reservas nunca colapsam num campo só.** Reserva é capacidade comprometida, não gasto. `ai_cycle_budgets` / `ai_cost_reservations`.
- **Reserva com `usage_review_required` sai da varredura de expiração.** Sem isso o TTL de recuperação de crash vira porta de saída para consumo não contabilizado. `20260803090200_101`.
- **`ai_usage_events.price_id` é NOT NULL** — evento financeiro só existe com preço conhecido; é o que torna o fail-closed de preço uma garantia de banco.

## 4. Desvios deliberados da spec (registrados, não acidentais)

1. **Copy do hard stop ao cliente final.** §18.3 traz um texto "conceitual" com
   a palavra *franquia*; o destinatário real é o cliente do restaurante, e a
   própria §18.3 proíbe informar-lhe o limite. Os textos de
   `_shared/ai-budget-copy.ts` comunicam o mesmo fato (a equipe assume, nada
   quebrou) sem vocabulário de contrato. Testado em
   `src/lib/ai-budget-milestones-core.test.ts`.
2. **`DENY_PRICE_UNKNOWN` não tem `event_type` de e-mail próprio.** §18.2 congela
   quatro tipos; criar um quinto ampliaria a spec congelada. O alerta ao
   platform_admin existe como telemetria (`evt: ai_price_unknown` + meta em
   `webhook_executions`) e aparece no painel de diagnóstico — mesma postura que
   a 6b adotou com o dispatch OFF. **Reavaliar antes de ligar
   `ai_wallet_enforced`:** com a flag ligada, preço ausente interrompe a IA de
   uma organização, e só o log avisaria.
3. **Marcos são percentuais do `limit_cents`, não valores absolutos.** Com o
   limite de R$ 100 caem exatamente em R$ 70/80/90/100 da spec; com um limite
   diferente (plano CUSTOM futuro) a escada acompanha em vez de um marco de
   R$ 70 virar "94% do teto" sem ninguém decidir isso.
4. **A varredura de reservas expiradas roda dentro de `reserve_ai_budget`**, sob
   o mesmo lock, em vez de um worker novo. Não há cron novo nesta frente.
   Consequência: uma organização que **pare** de usar IA deixa reservas órfãs
   `HELD` até o próximo turno. Elas não custam nada (o ciclo só é consultado
   quando há uso), mas inflam `activeReservedRemainingCents` se alguém ler o
   disponível por fora. **Se um painel de franquia for construído, ele precisa
   expirar antes de exibir — ou ganhar o worker.**
5. **`DENY_USAGE_UNRESOLVED` é escopado ao CICLO.** Bloqueio perpétuo entre
   ciclos seria o "alerta eterno" que §17.2.2 também proíbe; o valor
   comprometido já foi apropriado no ciclo em que ocorreu.

## 5. Reconciliação administrativa de `USAGE_REVIEW_REQUIRED` — **sem superfície**

§17.2.2 exige resolução "administrativa ou por reconcile seguro, nunca por
decurso de prazo". O **estado** existe (`ai_usage_events.usage_state`,
`resolved_at`, `resolved_by`, `resolution_note`; `ai_cost_reservations.usage_review_required`),
e a expiração automática o respeita. **A superfície de resolução não existe** —
não há painel nem action de `manage-billing` para marcar um evento como
resolvido. Hoje isso se faz por SQL de platform_admin.

**Quem decide:** engenharia, antes de ligar `ai_wallet_enforced`. Com a flag OFF
o estado nunca bloqueia ninguém; com ela ligada, um usage indeterminado
interrompe a IA da organização **até o fim do ciclo**.

## 6. Escopo desta frente

Não foram tocados (são de outras frentes): `manage-whatsapp-instances`,
`manage-channels`, `WhatsappInstances.tsx`, `manage-whatsapp-implementations`,
componentes de pricing. Seeds e catálogo dos dois planos: **Plano B**. Fluxos
comerciais: **Plano C**.

O que o lojista vê da franquia (§18.4 — `Franquia disponível` · `Uso elevado` ·
`Franquia utilizada`) **não foi construído**: exigiria superfície de frontend, e
`budgetRemainingCents` não pode ir ao painel do lojista por caminho compartilhado
— precisa de caminho de resposta separado, como o payload de `manage-billing`.

## 7. Gate comercial

**`PLAN_AUTOMACAO_CHECKOUT = NO-GO`** até o teto estar provado contra banco real
(seção 1) e até a pendência do Plano A (concorrência do limite de conexões)
fechar. O teto é parte do modelo econômico de R$ 799,90.

Flags permanecem OFF (`ai_wallet_enforced`, `billing_notifications_dispatch`).
Nenhum plano publicado. **Ren Sushi segue vitalício e grátis — override LIFETIME
em `system`, `whatsapp` e `ai` intacto, e o ramo de franquia nunca o alcança
(prioridade 2 do resolvedor, testado por cenário nomeado).**
```

- [ ] **Step 4: Rodar o guardrail e confirmar que passa**

Run: `npx vitest run src/lib/ai-budget-redeploy-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Rodar os gates finais e preencher a tabela**

```bash
npm run test
npm run typecheck
npm run lint
npx eslint supabase/functions --max-warnings=0
```

Preencher a tabela da seção "Gates desta entrega" com os números reais. **Se
algum gate falhar, corrigir antes de commitar — não registrar número aspiracional.**

- [ ] **Step 6: Commitar**

```bash
git add docs/billing-asaas/PLANO-D-PENDENCIAS.md src/lib/ai-budget-redeploy-guard.test.ts
git commit -m "docs(plano-d): pendencias, desvios deliberados e checklist de redeploy a consolidar"
```

---

## Self-review do plano (executado na redação)

**1. Cobertura da spec.** §17.1 → Tasks 1, 4. §17.2/17.2.1 → Tasks 1, 4.
§17.2.2 → Tasks 4, 5 (`usage_review_required` + varredura). §17.3 → Tasks 2, 4.
§17.4 → Tasks 4, 5. §17.5 → Tasks 2, 5. §17.6 → Tasks 5, 11, 12. §17.7 →
Tasks 9, 10, 11. §17.7.1 → Task 2. §17.7.2 → Task 2 (`BeforeCallContext`).
§17.7.3 → Task 9. §17.7.4 → Tasks 3, 12. §17.7.5 → Task 10. §17.7.6 → Tasks 9,
10. §17.7.7 → Task 13. §18.1 → guardrails em Tasks 2, 5, 10, 11, 12. §18.2 →
Tasks 3, 6, 8, 11. §18.3 → Tasks 2, 3, 12. §18.4 → Task 7 (campo próprio) +
Task 13 (pendência: painel não construído). §18.5 → Task 2. §2.3 → Task 7.
§1.3 → Task 4. §19 → Task 7 (cenários legados + Ren Sushi). §20 → todos.
§21/§22 → Task 13.

**Testes da §20 cobertos e onde:** 12, 13 (T1, T9) · 14 (T9, T11) · 15, 42 (T5,
**banco real**) · 16, 17, 18 (T2, T9) · 19, 20, 37 (T5, T9) · 21 (T9, T10) ·
22 (T5) · 33, 34, 35, 36 (T9, T10) · 38, 39, 40 (T3, T12) · 41, 43 (T2) ·
44 (T4, **banco real**) · 45 (T5, T11) · 46, 47 (T13) · 5, 7, 8 (T7).
**Não cobertos por serem de outra frente:** 1, 2, 6, 9, 10, 11 (Plano A/B),
23-32 (Plano B/C, gate e fluxos comerciais).

**2. Placeholders.** Nenhum "TBD", "similar ao anterior" ou "adicionar
tratamento de erro apropriado": todo passo de código traz o código.

**3. Consistência de tipos.** `AiUsageTokens` (T1) é o mesmo tipo usado por
`estimateCallTokens` (T2), `classifyUsage` (T1) e `reportCall` (T11).
`BeforeCallDecision`/`BeforeCallContext` nascem em T2, são consumidos em T9,
reexportados em T10 e usados em T11/T12. `AgentCallMeta`/`AgentCallOutcome`
nascem em T9 e são consumidos em T10/T11. `PriceLookup` nasce em T9 e é
produzido por `makePriceResolver` em T11. `TurnBudget` nasce em T11 e é
consumido em T12. As assinaturas das cinco RPCs em T5 batem campo a campo com
as chamadas `supabase.rpc(...)` de T11.
