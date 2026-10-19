# Plano — agente de IA: cortes, "Assumir", calendário e provedor reserva

Spec: [2026-10-19-agente-ia-respostas-cortadas-assumir-fallback-design.md](../specs/2026-10-19-agente-ia-respostas-cortadas-assumir-fallback-design.md) (aprovada 2026-10-19).
Branch/worktree: `feat/agente-ia-cortes-fallback` em `.claude/worktrees/agente-ia-fallback`, a partir de `origin/main`.

## Regras para todo implementador

- Ler `AGENTS.md`, `.claude/rules/agente-ia.md` e `.claude/rules/whatsapp.md` antes de editar.
- **Decisão mora em núcleo puro em `supabase/functions/_shared/*-core.ts`**, sem import remoto (`https://`, `npm:`), testado por Vitest em `src/lib/*.test.ts`. O vitest não importa `ai-providers.ts` (SDK esm.sh) nem `index.ts` de EF. O `index.ts` e `ai-providers.ts` só aplicam a decisão.
- `strict: false`: use `x.kind === "..."`/early-return para estreitar uniões.
- Gates por tarefa: `npx vitest run <arquivos tocados>`, `npm run typecheck` (= `tsc -b --noEmit`), `npm run lint` sem erro novo e `deno check supabase/functions/webhook-whatsapp/index.ts` quando a EF mudar (se `deno` não existir na máquina, registrar no relatório e não fingir o gate).
- Commit por tarefa com `git add <caminhos>` explícito; nunca `git add .`/`-A`. Mensagem convencional em inglês, sem segredo.
- Atualizar `.claude/rules/agente-ia.md` na mesma tarefa quando a regra documentada mudar (formato `**regra.** Por quê. Ponteiro.`).

## Bloco 1 — correções (Tasks 1–3)

### [x] Task 1 — "Assumir" inicia o relógio do handoff

1. Núcleo `supabase/functions/_shared/handoff-clock-core.ts`: `resolveHandoffClock({ handoffAt: string|null, lastHumanTs: number, nowMs: number }) → { silenceStartMs: number; persistHandoffAt: string|null }`. Se `handoffAt` válido ou `lastHumanTs > 0`: `silenceStartMs = max(...)`, `persistHandoffAt = null`. Se ambos ausentes: `silenceStartMs = nowMs`, `persistHandoffAt = new Date(nowMs).toISOString()`. `handoffAt` inválido (NaN) conta como ausente. Testes em `src/lib/handoff-clock-core.test.ts`: os três casos, NaN e o máximo entre os dois.
2. `webhook-whatsapp/index.ts` (bloco `if (conv.status === "human_active" || conv.status === "awaiting_human")`, ~linha 3518): trocar o cálculo inline de `handoffStart`/`silenceStart` pelo núcleo. Quando `persistHandoffAt` vier preenchido, `await supabase.from("conversations").update({ handoff_at }).eq("id", conv.id).eq("unit_id", unitId).is("handoff_at", null)` e logar erro como `jsonLog("warn", { evt: "handoff_clock_persist_failed" ... })` sem interromper. Manter `silenceStart > 0` no `shouldAutoResolve` (agora sempre > 0). Preservar o resto do bloco byte a byte.
3. `src/hooks/useConversations.ts` `assumeConversation`: incluir `handoff_at: new Date().toISOString()`, filtrar também por `.eq("unit_id", unitId)`, encadear `.select("id")` e lançar `Error("Conversa não encontrada ou sem permissão.")` se vier zero linhas. Conferir na migration `supabase/migrations/20261017160000_conversation_message_write_acl.sql` que `authenticated` pode atualizar `handoff_at`; se não puder, PARAR e reportar (não criar migration nesta tarefa).
4. Teste do hook (`src/hooks/useConversations.assume.test.tsx` ou equivalente com mock do supabase, seguindo o padrão de `Conversas.service-window.test.tsx`): grava `handoff_at`, filtra `unit_id` e rejeita zero linhas.
5. Regra em `.claude/rules/whatsapp.md` (seção Conversas, item Handoff): "Assumir grava `handoff_at`; o webhook inicia o relógio no primeiro inbound se a conversa silenciada não tiver nenhum."

Modelo: Sonnet (implementação e review de spec); Opus no review de qualidade (escrita em `conversations`).

### [x] Task 2 — Calendário dos próximos dias no prompt

1. Núcleo `supabase/functions/_shared/agent-calendar-core.ts`: `WEEKDAY_NAMES_PT` (mover do webhook) e `buildUpcomingDaysLines(nowBrt: Date, days = 8): string[]`, lendo só `getUTC*` do `nowBrt` (já deslocado para BRT pelo chamador). Saída: `- hoje: quarta-feira, 14/10`, `- amanhã: quinta-feira, 15/10`, depois `- sexta-feira, 16/10` … (8 linhas no total). Testes `src/lib/agent-calendar-core.test.ts`: virada de mês (31/10→01/11), de ano (31/12→01/01), fevereiro bissexto e o caso 22h BRT (o `nowBrt` construído de um `Date.now()` em UTC do dia seguinte continua no dia BRT certo).
2. `webhook-whatsapp/index.ts`: importar o núcleo; usar `WEEKDAY_NAMES_PT` dele; logo após `Hoje é ${todayBR}. ` acrescentar `\n\nPróximos dias (use esta lista para saber o dia da semana de "amanhã", "sábado", "dia 18" etc. — nunca calcule de cabeça):\n${upcomingDaysLines.join("\n")}\n\n` de forma que o texto seguinte continue legível. Na Regra 11, depois de "Se o cliente perguntar o preço de OUTRO dia, use a faixa daquele dia.", acrescentar: `Para descobrir o dia da semana de uma data relativa ou futura, consulte a lista "Próximos dias"; para data fora da lista, use o dia da semana da data completa informada pelo cliente ou pergunte a data.`
3. Regra em `.claude/rules/agente-ia.md` (item de Data/dia-da-semana): acrescentar que o prompt traz a lista de 8 dias derivada do mesmo `nowBrt`, em `agent-calendar-core.ts`.

Modelo: Sonnet (todos os papéis; núcleo puro com teste).

### [x] Task 3 — Nunca enviar resposta cortada

1. Núcleo `supabase/functions/_shared/agent-output-core.ts`:
   - `MAX_OUTPUT_TOKENS_BY_PROVIDER: Record<AIProvider, number>` = gemini 3072; claude/openai/grok/deepseek 1024 (tipo `AIProvider` redeclarado localmente como união literal ou importado com `import type` de `ai-providers.ts`, que é apagado no bundle e não puxa esm.sh para o vitest).
   - `GEMINI_THINKING_BUDGET = 1024` e `geminiThinkingConfig(model)` → `{ thinkingBudget: 1024 }` (válido em Flash e Pro: Pro exige ≥128).
   - `isTruncatedStop(provider, reason)`: `true` para gemini `"MAX_TOKENS"`, openai-compat `"length"`, claude `"max_tokens"`; `false` para o resto, inclusive `undefined`.
   - `class AgentTruncatedError extends Error` (`name = "AgentTruncatedError"`, campos `provider`, `model`, `reason`) e `isAgentTruncatedError(err)`.
   - Testes `src/lib/agent-output-core.test.ts`.
2. `ai-providers.ts`: `DEFAULT_MAX_OUTPUT_TOKENS` deixa de existir; cada runner usa `MAX_OUTPUT_TOKENS_BY_PROVIDER[...]`; Gemini envia `generationConfig: { maxOutputTokens, thinkingConfig: geminiThinkingConfig(model) }` — atenção: o `body` é montado UMA vez por iteração e reaproveitado no fallback Pro, então o `thinkingConfig` tem de servir aos dois (por isso orçamento único de 1024). Nos três pontos que hoje só logam `agent_unexpected_stop` para corte (Gemini com texto e `finishReason != STOP`; OpenAI-compat `finish_reason` fora de stop/tool_calls; Claude `stop_reason` fora de end_turn/tool_use): manter o log (acrescentar `output_tokens` quando disponível) e, se `isTruncatedStop`, `throw new AgentTruncatedError(...)`; outros motivos mantêm o comportamento atual. Re-exportar `AgentTruncatedError`/`isAgentTruncatedError` como já é feito com o deadline.
3. `ai-budget-core.ts`: `AI_ESTIMATE_OUTPUT_TOKENS = 3072`, comentário apontando para o gêmeo. Teste gêmeo em `src/lib/agent-output-core.test.ts`: `AI_ESTIMATE_OUTPUT_TOKENS >= Math.max(...Object.values(MAX_OUTPUT_TOKENS_BY_PROVIDER))`. Rodar `src/lib/ai-budget-*.test.ts` inteiros — se algum espera 1024 literal, ajustar com justificativa no relatório.
4. `webhook-whatsapp/index.ts`: `totalUsage` ganha `reasoning_tokens` (somado de `u.reasoning_tokens ?? 0`) e aparece em `agent_usage`; `estimateCostUsd` continua recebendo o objeto (campo extra é ignorado). Nenhuma outra mudança no retry: `AgentTruncatedError` já cai no `catch` do laço de tentativa (retry silencioso uma vez se `!mutatingToolUsed`), depois em `agent_error` → handoff.
5. Grafo: `node scripts/ef-import-graph.mjs supabase/functions/_shared/ai-budget-core.ts` e o mesmo para `agent-output-core.ts`; colar a lista de EFs no relatório (é a matriz de redeploy).
6. Regra em `.claude/rules/agente-ia.md` (Resiliência): substituir "`max_tokens: 1024` por turno" por "saída máxima por provider em `agent-output-core.ts` (Gemini 3072 com `thinkingBudget` 1024 — o raciocínio do 2.5 consome o mesmo limite); corte (`MAX_TOKENS`/`length`/`max_tokens`) lança `AgentTruncatedError` e nunca é enviado; `AI_ESTIMATE_OUTPUT_TOKENS` acompanha o maior limite".

Modelo: Sonnet implementação; Opus review de qualidade (orçamento + resiliência).

## Bloco 2 — provedor reserva (Tasks 4–6)

### [x] Task 4 — Núcleo de decisão do fallback entre provedores

1. Núcleo `supabase/functions/_shared/agent-provider-fallback-core.ts`:
   - `parseFallbackConfig(aiConfig: unknown, primary: AIProvider): { provider: AIProvider; model: string } | null` — aceita só `aiConfig.fallback.provider` string pertencente aos 5 providers, ≠ `primary`, e `model` string (pode ser vazio → o chamador resolve com `resolveModel`). Qualquer outro formato → `null` (polaridade: config ilegível = sem fallback = comportamento atual).
   - `shouldUseFallbackProvider(err: unknown): boolean` — `false` para `AgentTruncatedError`, `AgentDeadlineError`, e mensagens `api_key_not_configured:*`; `status` numérico → `status >= 500 || status === 429`; sem `status` → `true` (rede/timeout/abort).
   - Testes `src/lib/agent-provider-fallback-core.test.ts`, incluindo erro do SDK Anthropic simulado (`{ status: 529 }`), 400/401/404 → false.
2. `ai-providers.ts` `runOpenAICompatible`: anexar `e.status = resp.status` ao erro lançado em `!resp.ok` (mesmo padrão do Gemini), para a classificação funcionar.

Modelo: Sonnet; review de qualidade Opus.

### [x] Task 5 — Fallback no turno do webhook

1. `webhook-whatsapp/index.ts`: `runOnce` passa a receber `{ provider, apiKey, model }` (default = principal). Ler `fallback = parseFallbackConfig(aiConfig, provider_ai)`; se houver, resolver `fallbackModel = resolveModel(fallback.provider, fallback.model).model`.
2. No laço `for (attempt ...)`: quando `attempt === 0` falhar e as travas atuais permitirem retry (`!agentDeadlineReached && !mutatingToolUsed && elapsed < AGENT_RETRY_BUDGET_MS`), se `fallback && shouldUseFallbackProvider(err)`: tentar `resolveApiKey(fallback.provider, unitId)` (falha → `jsonLog("warn", { evt: "fallback_unavailable", provider, unitId })` e segue o retry atual no principal); com chave → `jsonLog("warn", { evt: "agent_provider_fallback", from_provider, from_model, to_provider, to_model, reason: agentError })` e a tentativa 1 roda no reserva. Resposta vazia na tentativa 0 com fallback configurado também dispara (só se `!mutatingToolUsed` e dentro do tempo): tratar `agentOutcome.kind === "TEXT" && !agentOutcome.text.trim()` como gatilho, com motivo `empty_response`.
3. `usedProvider`/`usedModel` refletem quem respondeu; `agent_usage`, `finish(..., meta)` do sucesso e do `agent_error` incluem `fallback_provider`/`fallback_model` quando usados; o `handoff_reason` de erro usa o provider/modelo da última tentativa.
4. `budgetHooks` é o mesmo objeto (o adapter precifica por `ctx.provider/ctx.model`); nada muda em `openTurnBudget`.
5. Guard estático em `src/lib/agent-provider-fallback-wiring.test.ts` (lendo o `index.ts` como texto, padrão dos `*-wiring-guard.test.ts`): o laço consulta `shouldUseFallbackProvider`, a chave do reserva vem de `resolveApiKey(fallback.provider, unitId)` e nunca de `Deno.env`, e o gate `!mutatingToolUsed` continua na condição.
6. Regra em `.claude/rules/agente-ia.md`: invariante nova "Provedor reserva é por unidade (`ai_config.fallback`), BYOK da própria unidade, só no retry de turno, só para indisponibilidade, só naquela solicitação; config ilegível = sem reserva."

Modelo: Opus (implementação, por tocar o turno do agente e retry com efeito externo) — ou Sonnet com review Opus obrigatório.

### [x] Task 6 — UI do provedor reserva

1. `src/lib/ai-fallback-options.ts` (+ teste): `fallbackProviderOptions(savedKeyProviders: string[], primary: AIProvider)` → providers ≠ primary com chave salva, na ordem de `PROVIDERS`.
2. `src/pages/gestao/Automacao.tsx` `AITab`: tipo `AIConfig` ganha `fallback?: { provider: AIProvider; model?: string } | null`. Abaixo do bloco da chave, card "Provedor reserva (opcional)": Select "Nenhum" + opções; ao escolher, Select de modelo com `MODELS_BY_PROVIDER` (opção "Padrão (…)" = `model` vazio). Texto curto: "Usado só quando o provedor principal estiver sobrecarregado ou fora do ar, apenas naquela mensagem. Precisa de chave salva do provedor reserva nesta unidade." Trocar o provedor principal para o mesmo do reserva limpa `fallback` no mesmo `updateAiConfig`. Sem opções disponíveis: texto explicando que é preciso cadastrar a chave de outro provedor (trocar o provedor ativo temporariamente para cadastrá-la é o fluxo atual — não criar fluxo novo de chave).
3. Teste de componente mínimo ou do helper; `npm run build`.

Modelo: Sonnet (todos os papéis).

## Fechamento (depois do Bloco 2)

Notas da execução do Bloco 2:
- Task 5: em vez de parâmetro, `runOnce` lê o alvo mutável `agentTarget` (trocado só por `switchToFallback`), porque guardas existentes ancoram `const runOnce = () => runAgentLoop(` e `await runOnce()`. `whatsapp-inbound-reentry.test.ts` passou a exigir `${usedProvider}` no `handoff_reason`.
- Matriz de redeploy (grafo de `agent-provider-fallback-core.ts` e `ai-providers.ts`): só `webhook-whatsapp` + frontend. Sem migration.
- A worktree não tem `.env.local`: testes que importam o client real (ex.: `OfficialConnectionCard.test.tsx`) e o build precisam de `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` placeholders inline. `whatsapp-scheduled-templates-integration.test.ts` oscila por tempo sob a suíte inteira e passa isolado.

- Review da branch inteira (Opus), gates `saas-shield-br:identity-access-auditor` (Task 1) e `saas-shield-br:integration-reliability-auditor` (Tasks 3–5), `npm run typecheck && npm run lint && npm test && npm run build`, `deno check` da EF, secret scan do staged.
- Merge em `main` só com autorização; deploy de `webhook-whatsapp` (e das EFs que o grafo apontar) com autorização separada. Sem migration.
- Verificação pós-deploy: `agent_unexpected_stop` com `MAX_TOKENS` zera; `agent_usage` mostra `reasoning_tokens`; "Assumir" grava `handoff_at`.
