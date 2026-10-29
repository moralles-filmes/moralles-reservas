# Plano — Entrega B: prompt global do agente na Plataforma e catálogo de modelos

- **Spec:** [2026-10-19-agente-ia-prompt-global-e-modelos-design.md](../specs/2026-10-19-agente-ia-prompt-global-e-modelos-design.md), aprovada pelo usuário em 2026-10-20. O aceite cobre a implementação **local**. Push, PR, `db push`, merge, deploy de EF e leitura de conteúdo de `settings` em produção pedem **autorização à parte, cada um**.
- **Plano e spec:** branch `docs/agente-ia-prompt-global-spec`, worktree `.claude/worktrees/agente-ia-prompt-global-spec`. Local, sem push.
- **Execução:** branch nova `feat/agente-ia-prompt-global`, worktree `.claude/worktrees/agente-ia-prompt-global`, criada a partir de `origin/main` **depois** do merge da Fase 0 do Instagram. O Chat 1 traz os commits de spec e plano por `git cherry-pick`.
- **Fluxo por tarefa:** implementador → review de conformidade com a spec (Sonnet) → review de qualidade/segurança (Opus) → commit. No fim da entrega, review da branch inteira e gates (B6).
- **Regras a reler antes de cada tarefa:** `.claude/rules/agente-ia.md`, `banco-de-dados.md`, `edge-functions.md` e `frontend.md`, mais AGENTS §5 e §8.

## 0. Bloqueios e desvios (ler primeiro)

### 0.1 BLOQUEIO — Instagram Fase 0, Tasks 3 e 4, fora de `main`

Conferido em 2026-10-20:
- `feat/instagram-module` está em `889bff3`, só local;
- `git log origin/main..feat/instagram-module` mostra 4 commits (`0c7ff18`, `96df46d`, `6fb7451`, `889bff3`);
- `git ls-tree origin/main supabase/functions/_shared` **não tem** `agent/`;
- a Task 3 (extração para `_shared/agent/system-prompt.ts` com `ChannelContext` e snapshot de paridade) e a Task 4 (gates, PR, merge) **não foram feitas**.

Consequências:
- **B2–B5 não começam** até a Fase 0 entrar em `main`: B3 edita `system-prompt.ts`, B2 extrai o seed do texto que a Task 3 move, e B4/B5 dependem de B2.
- **B1 também espera** (recomendação da spec §11.1): troca os pontos de chamada de `resolveModel` e o runner, que a Task 3 move para `_shared/agent/turn.ts`. Começar B1 antes exige decisão explícita do usuário e paga o rebase.

Comando de desbloqueio (o Chat 1 roda antes de tudo):

```bash
git fetch origin
git ls-tree -r --name-only origin/main supabase/functions/_shared/agent/   # tem de listar system-prompt.ts, channel-context.ts, tools.ts, turn.ts
git log --oneline origin/main --grep "instagram" -5
```

Se a listagem vier vazia, o chat **para** e avisa o usuário.

### 0.2 Desvio — número do pré-voo: 78/78a, não 77/77a

A branch `codex/whatsapp-versioned-dispatch-final`, local e em `origin`, já tem `supabase/tests/local-preflight/77-whatsapp-versioned-dispatch.sql`. Este plano usa **`78a-ai-prompt-bootstrap.sql` + `78-ai-prompt-and-settings-value.sql`**, com ordinais `7801–7899`. O B2 reconfere no início: `git for-each-ref` + `git ls-tree` em todas as branches. Se o 78 também tiver dono, usa o próximo livre e registra aqui.

### 0.3 Desvio — o teste de ACL de settings muda em B2, não em B5

`scripts/settings-write-acl.test.ts` compara o conjunto `manager` do classificador com as constantes de chave que a Gestão grava. Se B2 passar as 3 chaves para `manager` sem uma constante correspondente, a suíte fica vermelha até B5. Por isso **B2 cria a constante `AI_STORE_SETTING_KEYS`** e atualiza o teste, e **B5 liga a tela a ela** e acrescenta ao teste a prova de que a tela a importa.

### 0.4 Desvio — o "contrato com fetch mockado" (§10.2) roda sobre o núcleo puro

O vitest não importa `_shared/ai-providers.ts`, por causa do import `https://esm.sh/@anthropic-ai/sdk`. Por isso:
- o contrato de requisição por família vive num núcleo puro novo, `ai-request-profile-core.ts`, testado pelo vitest;
- um guard estático prova que o runner envia o que o núcleo devolve e não monta limite nem raciocínio por conta própria.

## 1. Chats de execução (um bloco por chat, em sequência)

| Chat | Tarefas | Modelo do chat | Subagentes (parâmetro `model`) | Termina com |
|---|---|---|---|---|
| 0 | Instagram Fase 0, Tasks 3 e 4 (outro plano) | Opus | — | merge em `main` com autorização |
| 1 | **B1** catálogo, perfis, preços, Flash→Pro, aba IA | Opus (decide perfis e evidência) | Haiku: busca nas páginas oficiais; Sonnet: catálogo, `resolveModel`, guard de preços, aba IA, review de spec; Opus: review de qualidade | commit, memória, prompt do Chat 2 |
| 2 | **B2** migration, RPCs, ACL, pré-voo 78/78a, constantes gêmeas | Opus | Sonnet: review de spec; Opus: `migration-validator` + `rls-auditor` como pré-gate | idem |
| 3 | **B3** núcleo do prompt (passo A, passo B) + checkpoint C-B3 | Opus | Sonnet: review de spec | idem; C-B3 pode ficar pendente com o usuário |
| 4 | **B4 + B5** telas da Plataforma e da Gestão | Sonnet | Sonnet: review de spec; Opus: review de qualidade/segurança | idem |
| 5 | **B6** gates, review da branch, PR, `db push`, merge, deploy, verificação | Opus | Opus: gates `saas-shield-br`/`saas-audit-br` | memória fechada |

Motivo dos modelos (memória `model-choice-by-risk`, spec §16):
- **Opus:** SQL/RLS/ACL, prompt e injeção, roteamento ao provider e rollout.
- **Sonnet:** núcleos puros com teste gêmeo, telas e cópia.
- **Haiku:** só busca.

## 2. Convenções comuns a todas as tarefas

**Ambiente do worktree** (memória `instagram-module`):
- `npm install --legacy-peer-deps`.
- Sem `.env.local`, `OfficialConnectionCard` e `App.preference-route` falham só ali. Antes de mexer, registre o baseline de `main` e compare sempre com ele.
- Nunca rode duas suítes ao mesmo tempo (dá timeout).
- Deno: `npx -y deno@2.1.4 check`.
- Não há python. Edição por script usa `node`.

**TDD em todo passo de código:**
1. Escrever o teste.
2. Rodar e ver **vermelho pelo motivo certo** (anotar a mensagem).
3. Implementar.
4. Ver **verde**.
5. **Controle positivo:** reintroduzir o defeito (em memória, ou com edição temporária revertida) e ver o teste falhar.

Registre RED, GREEN e controle em §8 (Evidências).

**Verificação padrão (V)**, ao fim de cada tarefa e antes de cada commit:

```bash
npm run typecheck          # tsc -b --noEmit; nunca tsc --noEmit sem -b
npm run lint
npx vitest run <arquivos de teste da tarefa>
npm run test               # suíte inteira, sozinha
npm run build
npx -y deno@2.1.4 check supabase/functions/webhook-whatsapp/index.ts   # + toda EF que o grafo listar
```

**Antes de cada commit:**
- `git status`, `git diff` e `git diff --cached` inteiros;
- varredura das linhas staged pelos padrões do AGENTS §5;
- `git add <caminho>` explícito.

**Ao fim de cada chat:**
- marcar os checkboxes;
- commitar;
- atualizar a memória `agente-ia-prompt-global` com "próximo chat começa em Bn";
- entregar ao usuário o prompt exato do próximo chat.

**Ações que pedem autorização à parte:**
- `git push`;
- abrir PR;
- `supabase db push`;
- merge em `main`;
- `supabase functions deploy`;
- leitura de **conteúdo** de `settings` em produção (C-B3);
- primeira chamada real a um provider sem chave em produção.

## 3. B1 — Catálogo de modelos (Chat 1)

**Arquivos**
- novo `supabase/functions/_shared/ai-model-catalog.ts`: TS puro, sem import, importado também pelo front;
- novo `supabase/functions/_shared/ai-request-profile-core.ts`: TS puro, perfis de requisição;
- `supabase/functions/_shared/ai-providers.ts`:
  - sai `DEFAULT_MODELS`/`KNOWN_MODELS`/`FALLBACK_MODELS`/`resolveModel`;
  - o runner passa a usar os perfis;
  - o Gemini recebe o fallback por opção;
  - `PRICING_USD_PER_MTOK` ganha os modelos novos;
- `supabase/functions/_shared/agent-output-core.ts`: limite por perfil, se a evidência exigir; `isTruncatedStop` para as famílias novas;
- `supabase/functions/_shared/agent-provider-fallback-core.ts`: nova `decideSameProviderFallback`;
- pontos de chamada de `resolveModel(` onde a Task 3 os deixou (`_shared/agent/turn.ts` ou `webhook-whatsapp/index.ts`; localizar com `git grep -n "resolveModel(\|modelOverride" supabase/functions`);
- `src/lib/aiModels.ts`: re-export fino do catálogo; mantém `AI_PROVIDER_ORDER`;
- `src/pages/gestao/Automacao.tsx`: `AITab` (~linhas 1078–1430 em `main` `2ea296d`), renderizado em `/platform/unidades/:unitSlug`;
- nova `supabase/migrations/<AAAAMMDDHHMMSS>_ai_model_prices_catalog_refresh.sql`, com timestamp maior que a última migration de `main` no dia e menor que o da migration de B2;
- testes:
  - novos: `src/lib/ai-model-catalog.test.ts`, `src/lib/ai-request-profile-core.test.ts`, `src/lib/ai-model-catalog-wiring.test.ts`;
  - atualizados: `src/lib/ai-budget-migrations-guard.test.ts`, `src/lib/agent-output-core.test.ts`, `src/lib/agent-provider-fallback-core.test.ts`, `src/lib/agent-provider-fallback-wiring.test.ts` (ligação da decisão Flash→Pro), `src/lib/ai-budget-wiring-guard.test.ts` (só se quebrar);
- regras: `.claude/rules/agente-ia.md`, `.claude/rules/edge-functions.md`.

### B1.0 Evidência oficial (Haiku busca, Opus decide)

- [x] O subagente Haiku abre **só páginas oficiais** de cada provider: docs de modelos, preços e referência da API de chat. Para cada modelo de §7.2 da spec (ativos e sucessores), devolve:
  - ID exato e status (GA, preview, legado, data de desligamento);
  - preço por Mtok: input, output, cache read, cache write, reasoning se for cobrado à parte;
  - parâmetro de limite de saída;
  - controle de raciocínio (orçamento, nível, adaptativo ou desligado) e se o raciocínio consome o limite de saída;
  - parâmetros proibidos ou ignorados (ex.: `temperature` com raciocínio);
  - formato de tool calling;
  - motivos de parada que indicam corte;
  - endpoint: Chat Completions continua aceito ou o modelo exige outra API;
  - URL e data de acesso.
- [x] Opus decide e preenche a tabela de §8.1. Regras de decisão:
  - ID diferente da spec → vale o oficial, e o desvio é registrado;
  - modelo só em preview → **não entra** como ativo;
  - família que não pôde ser confirmada → não entra, e o provider fica com o que foi confirmado. Se isso deixar um aposentado sem sucessor ativo, **parar e perguntar ao usuário**;
  - **família que exige outra API** (ex.: OpenAI só pela Responses API) → **parar e perguntar**: é mudança de escopo do runner, não de perfil;
  - sucessor sempre do mesmo papel (default→default).
- [x] Registrar em §8.1 o `usd_to_brl` usado. A convenção da 099 é a taxa na linha, e o valor conservador vigente é 5.50; trocar a taxa é decisão do usuário.

### B1.1 Catálogo e `resolveModel` (Sonnet)

- [x] RED em `src/lib/ai-model-catalog.test.ts`:
  - ids únicos por provider;
  - exatamente um `role:"default"` ativo por provider;
  - todo `retired` tem `successor` ativo do mesmo provider e do mesmo papel;
  - `sameProviderFallback` aponta para ativo do mesmo provider (hoje só `gemini-2.5-flash → gemini-2.5-pro`);
  - só os dois Gemini 2.5 com `verifiedInProduction: true`;
  - default do Gemini = `gemini-2.5-flash` (D5);
  - `resolveModel` nos quatro motivos (`saved`, `default` para vazio, `retired_successor`, `unknown_default` com `rejected`), inclusive com espaços (`trim`).
- [x] GREEN: `ai-model-catalog.ts` com o tipo de §7.1 e a lista de §8.1.
- [x] Controle positivo:
  - catálogo sintético com dois defaults → o teste falha;
  - aposentado sem sucessor → falha.
- [x] `src/lib/aiModels.ts` vira re-export: `MODELS_BY_PROVIDER` e `DEFAULT_MODEL_BY_PROVIDER` são **derivados** do catálogo, só com os ativos. Teste em `ai-model-catalog-wiring.test.ts`: `aiModels.ts` não tem literal de ID de modelo (regex `"(claude|gpt|gemini|grok|deepseek)-`), com controle positivo sobre fonte sintética.

### B1.2 Preços (migration) e guard de preços

- [x] RED: reescrever o bloco "todo modelo conhecido tem preço semeado" de `ai-budget-migrations-guard.test.ts`:
  - o conjunto exigido vem de `import { AI_MODEL_CATALOG }`: todo ativo, todo `successor` e todo `sameProviderFallback`. Sai a regex sobre `KNOWN_MODELS`/`FALLBACK_MODELS`, que deixam de existir;
  - `seeded()` passa a varrer **todas** as migrations com `insert into ai_model_prices` e exige uma linha **sem `effective_to`** por par;
  - controle positivo: catálogo sintético com modelo sem preço → falha. O controle atual do extrator é adaptado.
- [x] Ver vermelho: os modelos novos ainda não têm preço.
- [x] GREEN: migration nova, no molde da 099:
  - `begin; … commit;`;
  - `insert … select … from (values …) as v(provider, model, …)`, com `where not exists` por provider+model, ignorando a vigência (mesmo motivo da 099: o replay não pode recriar vigência);
  - `effective_from` = literal `timestamptz '<dia da evidência B1.0> 00:00:00+00'`. É determinístico e não pode passar do dia do `db push`; o B6 confere;
  - linhas de aposentados intocadas;
  - comentário com a fonte e a data de cada preço; sem URL do projeto nem segredo.
- [x] `npx vitest run src/lib/ai-budget-migrations-guard.test.ts scripts/migration-static-guard.test.ts` verde.
- [x] `PRICING_USD_PER_MTOK` (telemetria, `ai-providers.ts`) ganha os ativos novos com os mesmos valores. Teste estático: todo ativo tem entrada.

### B1.3 Perfis de requisição (Opus)

- [x] RED em `src/lib/ai-request-profile-core.test.ts`: `requestParamsFor(entry)` devolve, por `requestProfile`, os campos que o runner manda. Casos:
  - **Gemini 2.5:** `maxOutputTokens: 3072` + `thinkingConfig: { thinkingBudget: 1024 }`, **igual a hoje** (as lojas não mudam);
  - **Claude 4.x legado:** só existe como sucessor resolvido; o perfil não é alcançável;
  - famílias novas conforme §8.1: parâmetro de limite certo (ex.: `max_completion_tokens` em GPT-5+), controle de raciocínio e ausência dos proibidos;
  - para todo perfil com raciocínio que consome a saída, o limite fica acima de 1024 de resposta útil.
- [x] GREEN: núcleo puro. `MAX_OUTPUT_TOKENS_BY_PROVIDER` passa a ser derivado por perfil, ou fica e o perfil o sobrepõe; decidir e registrar. O teste gêmeo `AI_ESTIMATE_OUTPUT_TOKENS >= max(limite de todo perfil)` em `agent-output-core.test.ts` é estendido, com controle positivo.
- [x] `isTruncatedStop` cobre os motivos de corte das famílias novas (§8.1). RED → GREEN no teste existente.
- [x] Ligação no runner (`ai-providers.ts`): `callGeminiOnce`, ramo Claude e ramo OpenAI-compatível usam `requestParamsFor`. Guard estático em `ai-model-catalog-wiring.test.ts`:
  - fora do núcleo, `ai-providers.ts` não contém `max_tokens:`, `max_completion_tokens`, `maxOutputTokens:` nem `thinkingBudget` literal;
  - controle positivo sobre fonte sintética.

### B1.4 Flash→Pro condicional (D5)

- [x] RED em `agent-provider-fallback-core.test.ts`: `decideSameProviderFallback({ entry, reserve })` →
  - sem reserva → `gemini-2.5-pro`;
  - reserva válida (config legível, provider ≠ principal, chave ativa) → `null`;
  - config ilegível → `gemini-2.5-pro`;
  - reserva no mesmo provider → `gemini-2.5-pro`;
  - reserva sem chave ativa → `gemini-2.5-pro`;
  - modelo sem `sameProviderFallback` → `null`.
- [x] GREEN. Depois, ligação:
  - `AgentLoopOptions` ganha `sameProviderFallbackModel: string | null`;
  - `runGemini` usa a opção nos **três** caminhos (5xx, timeout, vazio), no lugar de `FALLBACK_MODELS.gemini`;
  - o chamador calcula a decisão antes do turno.
- [x] Conferir onde a chave do reserva é resolvida hoje. Se for preguiçosa, a **existência** da chave ativa é lida antes do turno, de `ai_provider_credentials` com `active=true` e `unit_id` da própria unidade. O valor da chave não é lido nem logado.
- [x] Guard estático: `FALLBACK_MODELS` não existe mais, e os três caminhos referenciam a opção. Controle positivo.

### B1.5 Modelo resolvido em franquia e telemetria (D6)

- [x] RED (guard estático) em todo ponto que hoje recebe `modelOverride`:
  - `openTurnBudget`, `priceFor`, `agent_usage`, `handoff_reason` e `meta` recebem o modelo **resolvido**;
  - o principal e o reserva (`ai_config.fallback.model`) passam por `resolveModel` do catálogo;
  - `evt:"ai_model_retired"` (`provider`, `saved`, `used`) quando o motivo é `retired_successor`; `evt:"ai_model_fallback"` continua em `unknown_default`.
- [x] GREEN e controle positivo.

### B1.6 Aba IA da unidade (Sonnet)

- [x] RED: helper puro `describeSavedModel(provider, saved)` em `src/lib/aiModels.ts` →
  - `active` (com `verified`);
  - `retired` (com `used`);
  - `unknown` (com `used` = default);
  - `empty`.
  Teste unitário.
- [x] GREEN, e a `AITab` passa a usar:
  - Select só com os ativos;
  - salvo aposentado: "aposentado — em uso: X (confirme)";
  - desconhecido: "descontinuado — usando o padrão X";
  - não verificado: badge "não testado em produção";
  - o mesmo vale para o Select do reserva.
- [x] Teste de componente leve da aba, ou do trecho extraído, cobrindo os três avisos.

### B1.7 Regras (spec §15)

- [x] `.claude/rules/agente-ia.md`:
  - "Default de modelo vive em DOIS arquivos" vira "catálogo único `ai-model-catalog.ts`; aposentado exige sucessor ativo do mesmo papel; todo ativo/sucessor/fallback exige preço vigente (guard)";
  - a linha "Fallback same-provider" passa a dizer "só sem reserva válida (`decideSameProviderFallback`)";
  - a seção Provedores aponta para o catálogo;
  - o `paths:` já cobre `_shared/ai-*`. Conferir que cobre `ai-model-catalog.ts` e `ai-request-profile-core.ts`.
- [x] `.claude/rules/edge-functions.md`: `ai-model-catalog.ts` entra na lista de `_shared` importado pelo front (mudança exige deploy do front).

### B1.8 Grafo e fechamento

- [x] `node scripts/ef-import-graph.mjs` para `ai-model-catalog.ts`, `ai-request-profile-core.ts`, `ai-providers.ts`, `agent-output-core.ts` e `agent-provider-fallback-core.ts`. Registrar em §6.
- [x] Verificação V, reviews, commit `feat(agente-ia): catálogo único de modelos, perfis por família e Flash→Pro condicional`.

## 4. B2 — Banco (Chat 2)

**Arquivos**
- nova `supabase/migrations/<AAAAMMDDHHMMSS>_ai_global_prompt_and_settings_value_guard.sql`, depois da de B1;
- novos `supabase/tests/local-preflight/78a-ai-prompt-bootstrap.sql` e `78-ai-prompt-and-settings-value.sql`, mais a seção "78" no `README.md` do pré-voo;
- `scripts/function-acl-allowlist.json`;
- novo `supabase/functions/_shared/agent/global-prompt-core.ts`, **só constantes** nesta tarefa: `GLOBAL_PERSONA_BASELINE`, `GLOBAL_PROMPT_PLACEHOLDERS`, `GLOBAL_PROMPT_MAX_CHARS`, `STORE_TEXT_LIMITS`, `AGENT_MODES`;
- nova constante `AI_STORE_SETTING_KEYS` em `src/lib/ai-store-settings.ts` (sem import do client Supabase);
- `scripts/settings-write-acl.test.ts`;
- novo `src/lib/global-prompt-sql-twin.test.ts`;
- regra `.claude/rules/banco-de-dados.md`.

### B2.0 Extração do seed

- [x] Em `_shared/agent/system-prompt.ts` (pós-Task 3), localizar o trecho contíguo de `IDENTIDADE:` até `Evite excesso de emojis. `, inclusive o espaço final.
- [x] Conferir que as **únicas** interpolações são `agentName` e `restaurantName`. Se houver condicional, outra variável ou trecho que dependa de `agent_mode`, **parar e perguntar ao usuário**: a premissa de §4.1 da spec quebrou.
- [x] `GLOBAL_PERSONA_BASELINE` = o trecho com `{{agent_name}}`/`{{restaurant_name}}`. O seed SQL usa dollar-quote `$seed$…$seed$`: sem escape de aspas, e o gêmeo compara byte a byte.

### B2.1 Pré-voo primeiro (RED)

- [x] Reconfirmar o número livre (§0.2).
- [x] `78a`: base do 75/75a (`00-bootstrap` → `01-audit` → `09a-advisor-bootstrap` → migration 106 → `75a-settings-write-acl-bootstrap` → `20261019180000_settings_write_role_guard.sql`), mais as fixtures:
  - platform_admin A e B sem membership;
  - U1 com owner, gerente e operador; U2 com gerente;
  - um usuário sem papel.
  O 78a **não** instala nada da migration nova.
- [x] **Atributo do dono das funções:** conferir no harness, e se preciso em produção com leitura de metadado autorizada (`select rolbypassrls from pg_roles where rolname = 'postgres'`), que o dono efetivo das RPCs consegue escrever sob `FORCE RLS` **sem policy de escrita**. Regra de banco-de-dados.md e pré-voo 70. Se não tiver `BYPASSRLS`, a RPC precisa de outro caminho; **parar e decidir com o usuário** antes de escrever a migration.
- [x] `78`: reaplica a migration por `\i` (roda da raiz do repo e pode ser repetido) e mede cada caso pelo **código e pelo efeito**. Ordinais `7801…`, contagem impressa "esperado N e N".

| Ordinal | Caso | Esperado |
|---|---|---|
| P1 | admin A publica com `expected` = v1 | v2 ativa; ledger `publish` com ator e nota; `body_sha256` preenchido |
| P2 | owner, gerente, operador, `anon`, `service_role` e `authenticated` sem `sub` publicam **e** ativam | `42501`; slot, versões e ledger inalterados (contagem antes e depois) |
| P3 | admin B publica com `expected` = v1 depois de P1 | `40001` `prompt_version_conflict`; nada muda |
| P4 | corpo vazio, só brancos, 4001 caracteres, `{{x}}`, `{{agent_name}` solto, `<<<`, `>>>`, controle `\x07`; nota vazia ou com 281 | `22023`; nada muda. NUL: o Postgres recusa antes da função (`22021`/`22P05`); registrar o código medido |
| P5 | ativar a v1 (rollback) com `expected` correto; ativar id de outro slot ou inexistente | ok + ledger `rollback` com `previous_version_id`; recusa `22023`, nada muda |
| P6 | UPDATE e DELETE em `ai_prompt_versions` e `ai_prompt_activations` como dono da tabela, `service_role` e admin | recusado (`42501`, `ai_prompt_history_append_only`) |
| P7 | `has_function_privilege`: `anon`/`service_role`/`public` nas 2 RPCs; todos os papéis nas trigger functions e em `guard_unit_setting_value`/`unit_setting_value_limit` | `false`; `authenticated` nas RPCs `true` |
| P8 | reaplicar a migration depois de P1 | sem erro; slot continua na v2; uma só v1; um só ledger `seed` |
| V1 | gerente U1 faz upsert das 3 chaves factuais | ok, valor gravado |
| V2 | operador U1 nas 3 chaves; gerente U1 em `ai_system_prompt` | `42501` `setting_write_forbidden` (o role guard roda primeiro) |
| V3 | `restaurant_menu` com 6001, não string (`{"a":1}`, número), controle `\x07`, como gerente **e** como `service_role` | `22023` `setting_value_invalid`; nada gravado |
| V4 | `agent_mode='x'` por admin; `agent_mode` válido nos dois valores | `22023`; ok |
| V5 | regressão: rodar o `75-settings-write-acl.sql` no mesmo banco | 20 e 20, como antes |
| C1 | controle: `drop trigger` append-only (subbloco desfeito) | P6 passa a alterar; recriar faz P6 voltar a recusar |
| C2 | controle: `drop trigger settings_write_value_guard` (subbloco desfeito) | V3 passa a gravar; recriar faz V3 voltar a recusar |
| C3 | controle: classe das 3 chaves de volta a `platform` (subbloco desfeito) | V1 passa a `42501` |

- [x] Rodar o 78 antes da migration: **RED** (aborta na guarda de existência).

### B2.2 Migration (GREEN)

Conteúdo, com `begin; … commit;` no arquivo (o harness aplica cru):

- [x] **Tabelas** de §5.1 da spec. Todas `enable` + `force row level security`.
  - CHECKs de `body` iguais aos do TS: placeholder por `regexp_replace(body, '\{\{(agent_name|restaurant_name)\}\}', '', 'g') !~ '\{\{|\}\}'`, mais `char_length 1..4000`, `body ~ '\S'`, `body !~ '<<<|>>>'` e classe de controle sem `\n`/`\t`.
  - `body_sha256` como coluna gerada. Se o PG recusar por volatilidade, vira preenchimento na RPC, com CHECK de formato; registrar.
  - `unique (slot, version)`, `unique (slot, id)`, FK composta `ai_prompt_slots(slot, active_version_id) → ai_prompt_versions(slot, id)`, `check (created_by is not null or version = 1)`.
- [x] **Append-only:** `app_private.ai_prompt_append_only()` (trigger BEFORE UPDATE OR DELETE nas duas tabelas). Levanta `42501` `ai_prompt_history_append_only`. Revoke de `public, anon, authenticated, service_role`.
- [x] **RLS e grants:**
  - policy `platform_admin_read_<tabela>` `for select to authenticated using (app_private.is_platform_admin(auth.uid()))` nas três tabelas;
  - `revoke all … from public, anon, authenticated`;
  - `grant select … to authenticated, service_role`.
- [x] **RPCs** `public.publish_ai_prompt_version(p_slot text, p_body text, p_note text, p_expected_active_version_id uuid) returns uuid` e `public.activate_ai_prompt_version(p_slot text, p_version_id uuid, p_expected_active_version_id uuid, p_note text) returns void`:
  - `security definer`, `set search_path = ''`, identificadores qualificados;
  - guard `auth.uid()` nulo ou `not app_private.is_platform_admin(auth.uid())` → `42501` `prompt_forbidden`;
  - `select … for update` no slot;
  - conflito → `40001` `prompt_version_conflict`;
  - corpo e nota inválidos → `22023` (`prompt_body_invalid`, `prompt_note_invalid`);
  - versão de outro slot ou inexistente → `22023` `prompt_version_invalid`;
  - insert da versão `max+1` + update do slot + ledger, na mesma transação;
  - `revoke all on function <assinatura completa> from public, anon, authenticated, service_role;` e depois `grant execute … to authenticated`.
- [x] **Seed:**
  - v1 com `$seed$…$seed$`, `created_by null` e nota `seed`, com `on conflict (slot, version) do nothing`;
  - slot com `on conflict (slot) do nothing`;
  - ledger `seed` só `where not exists`.
- [x] **Classe:** `create or replace function app_private.unit_setting_write_class` com as 3 chaves em `manager`. O resto não muda, e chave desconhecida continua `platform`. Revoke repetido.
- [x] **Guard de valor:**
  - `app_private.unit_setting_value_limit(text) returns integer immutable`, com a tabela de §4.3 (chave fora dela → `null`);
  - `app_private.guard_unit_setting_value()` (`security definer`, `search_path=''`): string JSON, tamanho, controle e enum de `agent_mode`, senão `22023` `setting_value_invalid`. Vale para todo papel;
  - trigger `settings_write_value_guard` BEFORE INSERT OR UPDATE em `public.settings` (ordena depois de `settings_write_role_guard`);
  - revoke das duas funções de `public, anon, authenticated, service_role`.
- [x] Rodar o pré-voo: 78a → 78 (**RED**) → migration → 78 (**GREEN**) → migration → 78 (**GREEN**, idempotência). Registrar a contagem, os códigos medidos e C1–C3 em §8.2.

### B2.3 ACL, gêmeos e teste de settings

- [x] `scripts/function-acl-allowlist.json`: duas entradas no grupo em que já vivem as RPCs `authenticated` com guarda de platform_admin (`authenticated_tenant`; conferir com `grep -n "guarda platform_admin"`). Cada uma com:
  - `args` exatamente como `pg_get_function_identity_arguments`;
  - `roles: ["authenticated"]`, `security_definer: true`;
  - `advisor_lints` iguais aos das irmãs;
  - `why` citando o guard no corpo, o lock, o `40001` e o pré-voo 78 (P2, P7).
  As trigger functions e as funções do guard **não entram**.
- [x] `npx vitest run scripts/function-acl-allowlist.test.ts`, mais o comando do job `acl-estatico` rodado localmente (ver `.github/workflows/function-acl-audit.yml`).
- [x] RED → GREEN em `src/lib/global-prompt-sql-twin.test.ts`:
  - o seed da migration é igual a `GLOBAL_PERSONA_BASELINE`;
  - os placeholders da regex SQL são iguais a `GLOBAL_PROMPT_PLACEHOLDERS`;
  - o 4000 do CHECK é igual a `GLOBAL_PROMPT_MAX_CHARS`;
  - `unit_setting_value_limit` é igual a `STORE_TEXT_LIMITS`, chave por chave;
  - o enum SQL é igual a `AGENT_MODES`;
  - controle positivo com SQL sintético divergente.
- [x] `scripts/settings-write-acl.test.ts` (§0.3):
  - `AI_STORE_SETTING_KEYS` entra na união `manager`;
  - a exclusão das chaves de `Automacao.tsx` passa a cobrir só as 5 `platform` do `PromptTab` (`ai_system_prompt`, `ai_context_extra`, `agent_mode`, `agent_name`, `ai_config`);
  - `MIN_AUTOMACAO_KEYS` é revisto;
  - controle negativo atualizado: tirar uma das 3 chaves do classificador em memória faz o teste falhar.

### B2.4 Regra, pré-gate e fechamento

- [x] `.claude/rules/banco-de-dados.md`:
  - a regra de `settings` passa a dizer que a classe `manager` inclui as 3 chaves factuais;
  - nova linha: "`settings_write_value_guard` valida forma e tamanho para todo papel, inclusive `service_role`";
  - nova linha: "`ai_prompt_versions`/`ai_prompt_activations` são append-only por trigger; só `publish_`/`activate_ai_prompt_version` escrevem".
- [x] Pré-gate (Opus): `saas-shield-br:migration-validator` e `saas-shield-br:rls-auditor` sobre a migration nova. Achado bloqueante → corrigir com TDD no pré-voo.
- [x] Verificação V e commit `feat(agente-ia): tabelas e RPCs do prompt global, classe e guard de valor em settings`. **Sem `db push`.**

## 5. B3 — Núcleo do prompt (Chat 3)

**Arquivos**
- `supabase/functions/_shared/agent/global-prompt-core.ts`: render, validação gêmea do SQL, decisão de fonte, cache com relógio injetado;
- novo `supabase/functions/_shared/agent/global-prompt.ts`: loader de I/O fino, cliente injetado, sem import Deno, para o vitest alcançar;
- novo `supabase/functions/_shared/agent/store-data-core.ts`: `storeDataBlock`, `neutralizeStoreText`;
- `supabase/functions/_shared/agent/system-prompt.ts`;
- chamador do turno: `meta` e `agent_usage`;
- testes:
  - novos: `src/lib/agent-global-prompt-core.test.ts`, `src/lib/agent-global-prompt-loader.test.ts`, `src/lib/agent-store-data-core.test.ts`, `src/lib/agent-store-data-static-guard.test.ts`;
  - existente: o snapshot de paridade da Task 3 (localizar com `git grep -ln "toMatchSnapshot\|toMatchInlineSnapshot" src/lib | xargs grep -l system-prompt`);
- regras: `.claude/rules/agente-ia.md`, `.claude/rules/edge-functions.md`.

### Passo A — camada global sai do banco, snapshot idêntico

- [x] RED: `renderGlobalLayer(GLOBAL_PERSONA_BASELINE, { agentName, restaurantName })` é igual ao trecho do prompt atual para o fixture da Task 3. Substituição literal dos 2 placeholders, sem template engine.
- [x] RED: validação TS igual ao CHECK SQL, com os mesmos casos de P4.
- [x] RED, loader:
  - fresco → `db` e entra no cache;
  - erro com cache → `stale_cache` (qualquer idade);
  - erro sem cache → `baseline`;
  - corpo inválido → mesmo caminho do erro;
  - os três caminhos de falha emitem `evt:"ai_global_prompt_read_failed"` (sem corpo no log);
  - TTL de 60s com relógio injetado.
- [x] GREEN: núcleo e loader. A leitura é por service role, de `ai_prompt_slots` (`slot='global_persona'`) → versão ativa. Não recebe id de escopo do caller. A polaridade D7 fica declarada em comentário no código.
- [x] Integração em `system-prompt.ts`: o trecho contíguo vira a camada 2 renderizada.
- [x] **Snapshot da Task 3 roda SEM `-u` e fica idêntico.** (A0 `5548e18`; ver §8.3: o passo A virou A0/A1.)
- [x] Controle positivo: trocar 1 caractere do baseline → o snapshot falha; reverter.
- [x] `meta` de `webhook_executions` e `agent_usage` ganham `global_prompt_version` (id ou `baseline`) e `global_prompt_source`. Guard estático com controle positivo.
- [x] Verificação V e **commit separado do passo A** (`feat(agente-ia): camada global do prompt lida do banco (snapshot idêntico)`). O hash vai em §8.3: é a prova de §4.4. Feito em dois commits: A0 `5548e18` (snapshot idêntico) e A1 `1471db6` (loader e telemetria).

### Passo B — delimitação e regra 13 (mudança deliberada)

- [x] RED em `agent-store-data-core.test.ts`:
  - `neutralizeStoreText` remove `<{3,}` e `>{3,}`, inclusive `<<<FIM_DADOS_DA_LOJA>>>` embutido;
  - remove NUL e controles além de `\n`/`\t`;
  - trunca no limite de `STORE_TEXT_LIMITS`;
  - `storeDataBlock(title, text)` produz exatamente `<<<DADOS_DA_LOJA: {title}>>>\n…\n<<<FIM_DADOS_DA_LOJA>>>`;
  - texto vazio não gera bloco (mesmo critério de hoje).
- [x] GREEN e integração. Ordem da camada 8 (§4.1): preços e condições, informações adicionais, [FAQ] cardápio, delivery, outras informações.
  - Os campos curtos de "Sobre o restaurante" (`units.description`, `payment_methods`, `opening_hours_text`) passam por `neutralizeStoreText`: só neutraliza, sem limite novo.
  - **Regra 13** entra depois da 12.
  - **Lembrete final** (camada 11) entra **depois** das instruções da plataforma (camada 10), com o texto de §6.3.4.
  - `ai_context_extra`/`ai_system_prompt` continuam instrução, na mesma posição relativa, truncados no limite.
- [x] RED → GREEN no guard estático: leitura de `settingsMap["restaurant_menu" | "delivery_response" | "restaurant_extra_info" | "rules_and_conditions" | "additional_info"]` fora de `storeDataBlock` reprova. Controle positivo sobre fonte sintética.
- [x] Snapshot B: atualizar com `-u` **só** o snapshot de paridade. O diff do arquivo de snapshot entre o commit do passo A e o do passo B vai para §8.3 e para a descrição do PR. O revisor de qualidade lê o diff linha a linha: só pode mudar delimitador, regra 13, lembrete e neutralização.
- [x] Verificação V e commit `feat(agente-ia): texto da loja como dado delimitado, regra 13 e lembrete de precedência`.

### Checkpoint C-B3 — prompt renderizado das 2 unidades (spec §4.4)

O objetivo é confirmar que nenhuma instrução legítima ficou presa num bloco `DADOS_DA_LOJA`. Exemplo: um `ai_system_prompt` que dependa de texto colado em `restaurant_extra_info`.

- [x] Pedir ao usuário **autorização para ler conteúdo** de `settings` e os 3 campos curtos de `units` das 2 unidades. O classificador já bloqueou essa leitura uma vez. Alternativa: o usuário roda ele mesmo a consulta só de leitura (o plano entrega o SQL no chat) e salva o JSON fora do repo. (Pedido no fim do Chat 3; autorizado pelo usuário em 2026-10-29: leitura só de leitura pelo MCP, JSON no scratchpad da sessão, fora do repo.)
- [x] Harness local `src/lib/agent-prompt-checkpoint.local.test.ts`, pulado sem a env `PROMPT_CHECKPOINT_FILE`. Renderiza as camadas 2 e 8–11 com o código do commit A e do commit B. Os dados de tabela vêm de fixture. Escreve o diff por unidade **no scratchpad**. Dados de produção nunca entram no repo nem no commit.
- [x] O usuário lê os diffs e decide. Se algo estiver preso, a correção é **conteúdo**: o platform_admin move a instrução para `ai_system_prompt` pelo `PromptTab`, antes do deploy da EF. Registrar a decisão em §8.3. C-B3 pendente **bloqueia o deploy (B6.7)**, não o PR. **Fechado em 2026-10-29 (§8.3).**

### Regras e grafo

- [x] `.claude/rules/agente-ia.md`:
  - nova: "camada global = persona/tom; regras 1–13, âncoras e formatação ficam no núcleo; leitura falha aberta para cache de qualquer idade e depois para `GLOBAL_PERSONA_BASELINE`";
  - nova: "texto livre da loja entra só por `storeDataBlock` (guard estático)";
  - `paths:` ganha `supabase/functions/_shared/agent/**`.
- [x] `.claude/rules/edge-functions.md`: `_shared/agent/global-prompt-core.ts` entra na lista de importados pelo front (B4/B5 usam render e limites).
- [x] `node scripts/ef-import-graph.mjs` para cada `_shared/agent/*` tocado ou novo. Registrar em §6.

## 6. B4 + B5 — Telas (Chat 4)

### B4 — `/platform/agente-ia`

**Arquivos**
- `src/pages/platform/AgenteIa.tsx`, `src/hooks/useAiPromptVersions.ts`;
- `src/lib/text-line-diff.ts`: diff de linhas puro. **Sem dependência npm nova**: o `package.json` não tem lib de diff;
- `src/lib/ai-prompt-errors.ts`;
- `src/components/layouts/platform-nav.ts` + `platform-nav.test.ts`;
- `src/App.tsx`: rota com `PlatformGuard`;
- testes ao lado.

- [x] RED → GREEN em `text-line-diff.ts`: igual, inserção, remoção, troca, texto vazio.
- [x] RED → GREEN em `ai-prompt-errors.ts`:
  - `42501` → "Sem permissão.";
  - `40001` → "A versão ativa mudou. Revise as mudanças e confirme de novo." (cópia trocada no review: "recarregue" induzia F5, que perde o rascunho);
  - `22023` → mensagem de corpo ou nota inválida;
  - outro → genérica;
  - nunca `error.message` cru.
- [x] RED → GREEN no hook:
  - lê `ai_prompt_slots` e `ai_prompt_versions` (paginado, 50 por página, "carregar mais"; nunca sem `.range`);
  - publica e restaura **só** por `rpc(...)` com `p_expected_active_version_id`;
  - invalida as queries no sucesso.
- [x] RED → GREEN na página:
  - versão ativa (número, autor, data, motivo);
  - editor com contador de 4000 e validação local pela mesma função de `global-prompt-core.ts`;
  - `\r\n` normalizado para `\n`;
  - pré-visualização com `renderGlobalLayer` e nomes de exemplo;
  - Publicar exige motivo (1–280) e confirmação com diff contra a ativa;
  - histórico com diff e "Restaurar esta versão";
  - cópia "a mudança vale para todas as lojas em até 1 minuto";
  - 4 estados de lista (carregando, erro com `refetch`, vazio, lista).
- [x] Item "Agente de IA" na Plataforma (`platform-nav.ts`) e rota. O teste do nav é atualizado.

### B5 — `/g/:unitSlug/atendimento-ia`

**Arquivos**
- `src/pages/gestao/AtendimentoIa.tsx`, `src/hooks/useAiStoreSettings.ts` (usa `AI_STORE_SETTING_KEYS` de B2);
- `src/components/layouts/GestaoLayout.tsx`;
- `src/App.tsx`: rota com `GestaoGuard`;
- `src/pages/gestao/Automacao.tsx` (`PromptTab`, ~linha 1435);
- `scripts/settings-write-acl.test.ts`;
- testes ao lado.

- [x] RED → GREEN no hook:
  - `upsert(...).select()` e conferência do tamanho do retorno (zero linhas = erro, AGENTS §8);
  - `42501` → "Sem permissão para editar estes textos.";
  - `22023` → "Texto acima do limite ou com caracteres inválidos.";
  - invalida `settings`.
- [x] RED → GREEN na página:
  - campos Cardápio, Delivery/retirada e Outras informações, com contador e limite de `STORE_TEXT_LIMITS`;
  - mostra o modo atual (leitura de `agent_mode`) com a cópia de §6.4;
  - avisos fixos de §6.4;
  - visível a owner, gerente e platform_admin.
- [x] Item "Atendimento por IA" na sidebar da Gestão, e rota.
- [x] `PromptTab`: contador e limite nas 7 chaves, com os valores de `STORE_TEXT_LIMITS`/limites de §4.3 importados, nunca redigitados.
- [x] `settings-write-acl.test.ts`:
  - nova asserção de que `AtendimentoIa.tsx`, ou o hook, importa `AI_STORE_SETTING_KEYS`;
  - controle negativo: fonte sintética sem o import → falha.
- [x] Verificação V, reviews (Opus na qualidade das duas telas) e commits (um por tarefa e por rodada de review; lista em §8.3a).

## 7. B6 — Gates, PR, deploy e rollback (Chat 5)

### B6.1 Matriz de redeploy (preencher com o grafo; não usar lista digitada)

| Arquivo `_shared` alterado/novo | EFs (`node scripts/ef-import-graph.mjs <arquivo>`) | Front (Vercel) |
|---|---|---|
| `ai-providers.ts` | medido em 2026-10-20 (`main` `2185293`): `webhook-whatsapp` | — |
| `agent-output-core.ts` | idem: `webhook-whatsapp` | — |
| `agent-provider-fallback-core.ts` | idem: `webhook-whatsapp` | — |
| `ai-model-catalog.ts` | medido em 2026-10-20 (B1.8, `bab6033` + B1): `webhook-whatsapp` | sim (`src/lib/aiModels.ts` importa) |
| `ai-request-profile-core.ts` | idem: `webhook-whatsapp` | — |
| `agent/turn.ts`, `ai-budget-core.ts` (só comentário) | idem: `webhook-whatsapp` | — |
| `_shared/agent/global-prompt-core.ts`, `global-prompt.ts`, `store-data-core.ts`, `system-prompt.ts` | B3 | `global-prompt-core.ts`: sim |

- [x] Rodar `node scripts/ef-import-graph.mjs --all` no commit final e fixar a lista. Esperado: `webhook-whatsapp`, mais a EF do Instagram se já existir. `manage-ai-providers` não entra. **Medido em 2026-10-29 no HEAD pós-merge da `main` a7624e7, sobre os 12 arquivos de `supabase/functions` do `git diff origin/main HEAD`: só `webhook-whatsapp`. Não há EF do Instagram na `main`.**
- [x] `deno check` em cada EF da lista. _(`webhook-whatsapp` ok com `npx --yes deno` 2.9.6, 2026-10-29.)_

### B6.2 Gates (spec §11.3), antes do PR

- [x] Verificação V completa (§8.4).
- [x] Subagentes Opus, cada um com o diff da branch e a spec (resultado em §8.4):
  - `saas-shield-br:migration-validator` (2 migrations);
  - `saas-shield-br:rls-auditor`;
  - `saas-shield-br:identity-access-auditor` (RPCs, papéis, classe de settings);
  - `saas-shield-br:tenant-isolation-auditor` (tela da Gestão, loader, leitura de chave do reserva);
  - `saas-audit-br:ai-automation-auditor` (prompt injection, custo, perfis).
- [x] Achado P0/P1 → correção com TDD e o gate roda de novo. P2/P3 → corrigir ou registrar como follow-up com justificativa. _(Nenhum P0/P1. P2/P3 viram follow-up no PR, por decisão do usuário em 2026-10-29.)_
- [x] Review da branch inteira (Opus).
- [x] `acl-estatico` local. `git status`, `git diff --cached` integral, varredura do AGENTS §5. `git add` explícito.

### B6.3 PR — **autorização 1**

- [x] Push de `feat/agente-ia-prompt-global` e PR, que leva: _(PR #60.)_
  - o resumo;
  - o diff do snapshot (A → B);
  - a matriz;
  - a evidência de B1.0;
  - o resultado do pré-voo 78;
  - os gates.
- [x] Conferir na aba Checks o `acl-estatico` (não é required) e o preview da Vercel. _(`acl-estatico` pass, Vercel preview pass; `acl-com-banco` é manual e foi pulado.)_

### B6.4 Sequência de deploy (spec §11.2): cada passo com autorização própria

> **Decidido com o usuário em 2026-10-29: opção (a)** — `db push` → deploy de `webhook-whatsapp` do commit exato do PR → merge desse mesmo commit. O C-B3 fechou no mesmo dia (§8.3). As migrations foram renomeadas para `20261029120000` (preços) e `20261029120100` (prompt e guard), porque a `main` trouxe 3 migrations já aplicadas em produção com timestamp posterior às antigas `20261020130000`/`20261020150000`; o pré-voo passou de 78/78a para 80/80a.

1. [x] **Autorização 2 — `supabase db push`** das duas migrations, na ordem do nome: preços (B1, `20261029120000`), depois prompt e guard (B2, `20261029120100`). Receita da memória `settings-escrita-por-chave`, com `--skip-vault` (planos da `main` de 2026-10-20/21: a CLI atual mexe nos segredos do Vault sem ele):
   - `npx --yes supabase@2.121.0 db push --linked --skip-vault --dry-run`, que tem de listar **exatamente** as 2 migrations; depois sem `--dry-run`. Nunca `--include-all`;
   - antes, só de leitura: contagem por chave das linhas de `settings` fora do formato do guard (sem ler o valor), `rolbypassrls` do `postgres`, preços reconferidos no dia, decisão da FK `created_by`;
   - copiar `supabase/.temp/{project-ref,linked-project.json}` do checkout principal e **removê-los depois**;
   - prod ref `gbabxcrntkwgblgqsiit`;
   - conferir que `effective_from` dos preços ≤ agora.

   Verificação só de leitura, sem conteúdo:
   - `count(*)` de preços vigentes por modelo do catálogo;
   - slot `global_persona` na v1;
   - `has_function_privilege` como em P7;
   - `relforcerowsecurity` nas 3 tabelas;
   - trigger `settings_write_value_guard` presente;
   - zero linhas de `settings` acima do limite (só `char_length`, sem ler o valor). Linha acima do limite não quebra nada, mas fica registrada.
> **⚠️ Decidir com o usuário antes do passo 2 (review final do Chat 4, Important 1):** este roteiro (push → merge → EF) contradiz o pré-gate P2 (§8.2: EF do B3 antes do merge). Com as telas do B5, o merge depois do `db push` dá ao gerente um formulário para gravar cardápio/delivery/extra enquanto a EF velha ainda interpola esses textos sem delimitação (raio: a própria loja). Opções: (a) `db push` → deploy de `webhook-whatsapp` (exige C-B3 fechado) → merge; (b) segurar o merge até o C-B3 fechar. **Nunca mergear antes do `db push`** — e o preview da Vercel do PR (B6.3) já expõe as telas: ali `/g/:slug/atendimento-ia` salva com 42501 ("Sem permissão…") e `/platform/agente-ia` mostra o card de erro, sem tela branca nem loop.
2. [x] **Autorização 3 — `supabase functions deploy webhook-whatsapp`** (matriz B6.1) logo depois do passo 1, do commit exato da cabeça do PR, em janela de baixo tráfego. C-B3 fechado em 2026-10-29. Fecha a janela do P2: as 3 chaves já são `manager` desde o passo 1, e só esta EF as delimita. A EF nova funciona com o front antigo. Até o passo 3, a EF de produção vem de um commit fora da `main`; o rollback de código usa a `main` pré-merge.
3. [x] **Autorização 4 — merge do PR em `main`** (Vercel), **do mesmo commit** deployado no passo 2. Conferir o deploy READY. A UI passa a gravar as 3 chaves (o banco já aceita) e a chamar as RPCs.
4. [x] **Verificação (spec §11.2.4):** _(resultado em §8.4, B6.3–B6.4.)_
   - nos primeiros turnos, `webhook_executions.meta.global_prompt_source = 'db'` e `global_prompt_version` = id da v1;
   - nenhum `ai_global_prompt_read_failed` nem `ai_model_retired` inesperado nos logs;
   - modelo resolvido das 2 lojas = `gemini-2.5-flash`;
   - teste manual do usuário: owner real salva o cardápio na Gestão;
   - admin abre `/platform/agente-ia` e vê a v1.

### B6.5 Rollback (spec §12)

- **Conteúdo:** "Restaurar esta versão" na `/platform/agente-ia` (≤60s).
- **Código:** `supabase functions deploy` de `webhook-whatsapp` a partir de `main` anterior ao merge (`git checkout <sha pré-merge> -- supabase/functions` num worktree descartável). A camada volta ao código e os modelos voltam à lista antiga. Unidade com modelo novo salvo cai no default. Front: revert do merge em `main`, com autorização.
- **Banco:** migration de reversão (com autorização e `db push`) que:
  - devolve as 3 chaves a `platform` (`create or replace` da classe + revoke repetido);
  - faz `drop trigger if exists settings_write_value_guard on public.settings`.
  As tabelas de prompt e os preços ficam (inertes). Antes de reverter a classe, a tela da Gestão sai do ar (revert do front), senão o dono recebe `42501`.

### B6.6 Fechamento

- [x] Registrar o rollout em §8.4.
- [x] Atualizar as memórias `agente-ia-prompt-global` (entregue) e `instagram-module` (Fase 1 liberada; a Fase 2 usa `capabilities.vision`). _(A `instagram-module` fica com a sessão do Bloco 3 do Instagram.)_
- [x] Follow-ups da spec §13 ficam listados no PR. _(PR #60.)_

## 8. Evidências

### 8.1 B1.0: modelos, preços e perfis (preenchido no Chat 1, 2026-10-20)

Busca: subagente Haiku, só páginas oficiais, acesso em 2026-10-20 (relatório bruto fora do repo). Preços do Gemini reconferidos pelo Opus na página oficial. Os fatos do Claude também foram cruzados com a referência da API da Anthropic. "Proibidos" lista só o que o runner poderia mandar; ele não manda `temperature`, `top_p` nem penalidades.

| Provider | ID oficial | Papel | Status oficial | Input / Output / Cache R / Cache W / Reasoning (USD/Mtok) | Limite de saída | Raciocínio | Proibidos | Corte (stop) | API | Fonte (URL, data) | Desvio da spec |
|---|---|---|---|---|---|---|---|---|---|---|---|
| gemini | `gemini-2.5-flash` | default (verificado) | estável, sem data de desligamento; acesso ao 2.5 restrito a quem já usava | 0.30 / 2.50 / 0.03 / 0 / como output | `maxOutputTokens` 3072 (máx. 65 536) | `thinkingBudget` 1024 (igual a hoje) | `thinkingLevel` no 2.5 dá erro | `MAX_TOKENS` | generateContent | ai.google.dev/gemini-api/docs/pricing; …/models/gemini-2.5-flash; 2026-10-20 | **preço da 099 (0.15/0.60/0.0375) está defasado**: fora do escopo B1, ver "Achados" abaixo |
| gemini | `gemini-2.5-pro` | strong (verificado); `sameProviderFallback` do Flash | estável, sem data | 1.25 / 10.00 / 0.125 / 0 (≤200k; tier >200k existe) | 3072 | `thinkingBudget` 1024 | idem | `MAX_TOKENS` | generateContent | idem; …/models/gemini-2.5-pro | cache R da 099 (0.3125) acima do oficial: conservador, mantido |
| gemini | `gemini-3.8-flash` | strong | estável (2026-09-02), sem data | 0.75 / 3.75 / 0.075 / 0 até 2026-12-31; **1.50 / 7.50 / 0.15 a partir de 2027-01-01** | 3072 | `thinkingLevel: "low"` (não desliga; níveis low/medium/high) | `thinkingBudget` | `MAX_TOKENS` | generateContent | …/models/gemini-3.8-flash; …/docs/thinking; pricing | papel "strong" (a spec só dizia "ativo"); preço em duas vigências |
| gemini | `gemini-3.5-flash-lite` | light | estável (2026-07-21), sem data | 0.30 / 2.50 / 0.03 / 0 | 3072 | `thinkingLevel: "minimal"` | `thinkingBudget` | `MAX_TOKENS` | generateContent | …/models/gemini-3.5-flash-lite; pricing | — |
| gemini | Pro 3.x | — | só `gemini-3.1-pro-preview` (preview) | — | — | — | — | — | — | …/models/gemini-3.1-pro-preview | não entra (preview) |
| claude | `claude-haiku-5-5` | default | Active (latest), aposentadoria não antes de 2027-10-07 | 0.10 / 0.50 / 0.01 / 0.125 (≤100k) / como output | `max_tokens` 1024 | adaptativo ligado por padrão; o perfil manda `thinking: {type:"disabled"}` (aceito com effort ≤ high; default medium) | `budget_tokens`, sampling não-default, prefill | `max_tokens` (`refusal`, `model_context_window_exceeded` e `pause_turn` não são corte) | Messages | platform.claude.com/docs/en/models/haiku-5-5/overview, …/migration-guide, …/thinking-troubleshooting; 2026-10-20 | — |
| claude | `claude-sonnet-5-5` | strong | Active (latest), não antes de 2027-09-28 | 2.00 / 10.00 / 0.20 / 2.50 / como output | `max_tokens` 1024 | `disabled` dá 400; o perfil manda `thinking: {type:"between_tools"}` (sem raciocínio estendido; notas curtas entre ferramentas voltam em blocos `thinking`, repassados intactos) | `disabled`, `budget_tokens`, `tool_choice` forçado, sampling não-default | `max_tokens` | Messages | …/models/sonnet-5-5/overview; …/thinking-troubleshooting; …/implement-tool-use | cache R: o subagente leu 0.10, a referência da API diz 0.20; vale o maior (conservador) |
| claude | `claude-haiku-4-5` | aposentado → `claude-haiku-5-5` | Active (legacy), "não antes de 2026-10-15" | 1 / 5 / 0.10 / 1.25 (linha da 099, intocada) | — | — | — | — | — | …/models/haiku-4-5/overview; …/model-deprecations | oficialmente ainda ativo; aposentado no catálogo por decisão da spec (§7.2) |
| claude | `claude-sonnet-4-6` | aposentado → `claude-sonnet-5-5` | Active (legacy), não antes de 2027-02-17 | 3 / 15 / 0.30 / 3.75 (099, intocada) | — | — | — | — | — | …/models/sonnet-4-6/overview | idem |
| openai | `gpt-6-luna` | default | sem rótulo de status; substituto oficial do gpt-4o | 0.10 / 0.50 / 0.01 / 0.125 (tier >272k existe) | `max_completion_tokens` 1024 (`max_tokens` está deprecado) | `reasoning_effort: "none"` **obrigatório**: "Chat Completions supports function calling only with `reasoning_effort` set to `none`" | `max_tokens` | `length` | Chat Completions (com a restrição ao lado) | developers.openai.com/api/docs/models/gpt-6-luna; …/reference/…/chat/…/create; 2026-10-20 | — |
| openai | `gpt-5.6-sol` | strong | sem rótulo; **preço promocional "pelo menos até 2026-11-21"** | 4.00 / 20.00 / 0.40 / 5.00 (cache W = 1.25× input) | `max_completion_tokens` 3072 | `reasoning_effort: "low"` (o raciocínio conta no limite) | `max_tokens` | `length` | Chat Completions, tools suportadas | …/models/gpt-5.6-sol | o preço pós-promoção é desconhecido: B6 reconfere antes do `db push` |
| openai | `gpt-4o`, `gpt-4o-mini` | aposentados → `gpt-6-luna` | Deprecated; snapshots desligam em 2027-01-14 com substituto `gpt-6-luna` | linhas da 099 intocadas | — | — | — | — | — | …/docs/deprecations | — |
| grok | `grok-4.20-0309-non-reasoning` | default | ativo | 1.25 / 2.50 / 0.20 / 0 (≤200k) | `max_completion_tokens` 1024 (`max_tokens` deprecado) | nenhum (modelo sem raciocínio) | — | `length` (`end_turn` não é corte) | Chat Completions, **legado/deprecado, sem data de desligamento** | docs.x.ai/developers/models; …/rest-api-reference/inference/chat-completions; …/guides/chat-completions | risco registrado: migrar para Responses é escopo futuro |
| grok | `grok-4.3` | strong | ativo | 1.25 / 2.50 / 0.20 / 0 (≤200k) | `max_completion_tokens` 3072 | default `low`; o perfil não manda parâmetro de esforço (o nome no Chat Completions não foi confirmado) | `presence_penalty`, `frequency_penalty`, `stop` | `length` | Chat Completions (legado) | docs.x.ai/developers/model-capabilities/text/reasoning | — |
| grok | `grok-3` | aposentado → `grok-4.20-0309-non-reasoning` | aposentado em 2026-05-15 (redireciona para grok-4.3) | linha da 099 intocada | — | — | — | — | — | docs.x.ai/developers/migration/may-15-retirement | — |
| deepseek | `deepseek-flash` (V4.1-Flash) | default | atual | 0.30 / 1.20 / 0.006 / 0 (preço de pico; fora do pico é a metade) | `max_tokens` 1024 (máx. 384K) | thinking ligado por padrão; o perfil manda `thinking: {type:"disabled"}` | sampling sem efeito no modo thinking | `length` | Chat Completions (`/chat/completions`) | api-docs.deepseek.com/quick_start/pricing; …/api/create-chat-completion; 2026-10-20 | — |
| deepseek | `deepseek-v4-pro` | — | **declarações oficiais conflitantes** (news260910: roteia para V4.1-Flash desde 2026-09-14; updates: o serviço continua) | — | — | — | — | — | — | …/news/news260910; …/updates | **não entra** (não confirmado); o deepseek fica só com o default |
| deepseek | `deepseek-chat` | aposentado → `deepseek-flash` | descontinuação anunciada para 2026-07-24 | linha da 099 intocada | — | — | — | — | — | …/updates (entrada 2026-04-24) | — |

`usd_to_brl`: 5.50 (convenção da 099; trocar a taxa é decisão do usuário). Data de `effective_from`: `2026-10-20 00:00:00+00`, e `2027-01-01 00:00:00+00` para a segunda vigência do `gemini-3.8-flash`.

Regras de decisão aplicadas:
- Nenhuma família exige outra API. O `gpt-6-luna` aceita ferramentas no Chat Completions só com `reasoning_effort: "none"`, e o perfil manda isso. O Chat Completions da xAI é legado, mas não tem data de desligamento.
- O `deepseek-v4-pro` ficou de fora por não ter sido confirmado. Nenhum aposentado fica sem sucessor ativo.
- Nenhum perfil passa de 3072 tokens de saída. `AI_ESTIMATE_OUTPUT_TOKENS` (3072) não muda, e a reserva de franquia das lojas também não.

Achados fora do escopo do B1 (para decisão do usuário):
- **Preço do `gemini-2.5-flash` defasado na 099.** A 099 tem 0.15 / 0.60 / 0.0375. O oficial em 2026-10-20 é 0.30 / 2.50 / 0.03. O custo de saída está subestimado em cerca de 4×, e a franquia mede menos do que o provider cobra. Corrigir é abrir uma vigência nova (fechar `effective_to` e inserir linha), o que muda a medição das lojas em produção. Não foi feito.
- **O Gemini 2.5 está restrito a projetos que já o usavam**, e uma unidade nova com chave nova pode não ter acesso. A D5 mantém o default `gemini-2.5-flash`. Revisitar a D5 é decisão do usuário.

#### B1: RED, GREEN, controles e decisões (Chat 1, 2026-10-20)

Baseline (`bab6033` + spec/plano): typecheck zero erros; suíte 4118 passam e 45 falham em 8 arquivos (`OfficialConnectionCard`, `TemplateCatalogAdminCard`, `whatsapp-automation-receipts-request`, `whatsapp-reservation-automation-routing`, `whatsapp-template-catalog-migration-twin`, `whatsapp-template-catalog-v2`, `whatsapp-waitlist-voucher-routing`, `whatsapp-template-surfaces`), nenhum do agente de IA.

| Passo | RED (motivo certo) | GREEN | Controle positivo |
|---|---|---|---|
| B1.1 catálogo | `ai-model-catalog.test.ts`: import não resolvido (módulo inexistente) | 23 casos | `catalogViolations` reprova catálogo sintético com 2 defaults, aposentado sem sucessor, sucessor de outro papel/provider/aposentado, id duplicado, fallback inexistente |
| B1.1 `aiModels.ts` | — (re-export) | sem literal de id | regex pega literal em `"`, `'` e crase; não pega fonte sem literal |
| B1.2 preços | guard: 9 ativos sem vigência aberta + telemetria sem 10 chaves | migration `20261020130000` + `PRICING_USD_PER_MTOK` | parser de `values` (linha aberta, só fechada, fechada+aberta, comentada, sem coluna `effective_to`); `missingPrices` acusa ativo, sucessor e fallback sem preço |
| B1.3 perfis | `ai-request-profile-core.test.ts`: módulo inexistente | 18 casos | GPT-6 com `reasoning_effort:"low"` reprova o contrato; limite 4096 reprova o gêmeo com `AI_ESTIMATE_OUTPUT_TOKENS` (e 4 outros) |
| B1.3 runner | guard estático | 0 literal de limite/raciocínio fora do núcleo | detector pega `max_tokens:`, `max_completion_tokens`, `maxOutputTokens:`, `thinkingBudget`, `reasoning_effort` escritos à mão e ignora comentário |
| B1.3 `isTruncatedStop` | **sem RED**: a evidência §8.1 mostra que as famílias novas usam os mesmos motivos de corte, o código não muda | casos novos (`model_context_window_exceeded`, `end_turn` da xAI, `content_filter`, `MISSING_THOUGHT_SIGNATURE`) não são corte | — |
| B1.4 núcleo | 6 casos `decideSameProviderFallback is not defined`; depois do review, o 7º (reserva fora de alcance) falhou por devolver `null` | 26 casos | sem a condição de chave ativa, o caso "reserva sem chave" reprova |
| B1.4/B1.5 ligação | guards estáticos | 22 casos em `ai-model-catalog-wiring.test.ts` | franquia aberta com o salvo cru (`rawModel ?? modelOverride`) reprova; runner sem o `push` do fallback reprova este guard e o de `ai-budget-wiring-guard`; o builder de credencial sem o filtro de unidade ou de `active` reprova |
| B1.6 UI | `describeSavedModel is not a function` (7); depois do review, o vazio com padrão não verificado | 15 casos (helper + aviso) | aba sem o aviso no seletor do reserva reprova o guard |

Decisões e desvios registrados:
- **`MAX_OUTPUT_TOKENS_BY_PROVIDER` saiu.** O limite agora é do perfil (`ai-request-profile-core.ts`), porque o mesmo provider tem famílias com limites diferentes (Sonnet 5.5 1024, GPT-5.6 3072). `GEMINI_THINKING_BUDGET` mudou de arquivo junto. O gêmeo com `AI_ESTIMATE_OUTPUT_TOKENS` foi para `ai-request-profile-core.test.ts`, e não para `agent-output-core.test.ts` como o plano dizia.
- A ligação Flash→Pro foi presa em `ai-model-catalog-wiring.test.ts`, não em `agent-provider-fallback-wiring.test.ts`. Este segue verde e intacto.
- **Review de qualidade (Opus), P2 corrigido.** O D5 tirava o Pro do turno inteiro, mas o reserva só entra na tentativa 0, sem ferramenta mutante e dentro de `AGENT_RETRY_BUDGET_MS`. Agora o runner pergunta na hora do fallback (`sameProviderFallbackModel` é função), e o núcleo ganhou `reserveStillUsable`.
- **P3 corrigido: Pro como principal mantém o empty-retry nele mesmo.** O catálogo declara `gemini-2.5-pro → gemini-2.5-pro`, preservando o comportamento de antes, quando `FALLBACK_MODELS.gemini` também valia para o Pro.
- **P3 corrigido: provider inválido.** A resolução da chave veio para antes da resolução do modelo: `provider` inválido no `ai_config` cai no handoff `api_key_not_configured` de sempre, sem lançar no catálogo. O snapshot de paridade não mudou com isso.
- **Portabilidade sem dívida nova.** A primeira versão de `hasActiveApiKey` repetia o `.from("ai_provider_credentials")` e subia o `check-portabilidade` de 487 para 488. As duas leituras agora usam um único builder (`activeCredentials`) com o filtro de unidade, provider e ativa, e o check voltou a 487 sem regravar a linha de base.
- `edge-request-harness.test.ts` falhou uma vez na suíte completa e passa isolado (17/17). É sensível a tempo sob carga e não tem relação com o B1.
- **Snapshot de paridade regravado uma vez, com mudança decidida.** Os cenários usam Claude com o modelo padrão, e o diff tem só: `claude-haiku-4-5` → `claude-haiku-5-5` (corpo, `agent_usage`, `handoff_reason`, `meta`), `thinking: {type:"disabled"}` nos 10 corpos Claude e `estimated_cost_usd` recalculado. O snapshot passa sem `-u` depois disso e depois das correções do review.
- Review de conformidade (Sonnet): no aviso da aba, o vazio com padrão não verificado ganhou "padrão: X" + selo, e um guard prende os dois seletores ao aviso.
- Fica para o B6:
  - nenhum cenário de paridade exercita o Gemini, o caminho das duas lojas. Ele é coberto pelo corpo fixado no teste de perfil e pelos guards estáticos. Antes do deploy, ler (somente leitura, com autorização) `ai_config->'fallback'` das 2 unidades e se há credencial ativa do provider reserva.
  - o preço da telemetria do `gemini-2.5-flash` (`PRICING_USD_PER_MTOK`) está defasado como o da 099; não foi mexido.

### 8.2 B2: pré-voo 78

Contagem, códigos medidos (inclusive NUL), C1–C3, atributo `BYPASSRLS` do dono.

#### B2: RED, GREEN, controles e decisões (Chat 2, 2026-10-20)

- **Número do pré-voo (§0.2):** `git for-each-ref` + `git ls-tree` em todas as branches locais e remotas, mais as worktrees. 77 é de `codex/whatsapp-versioned-dispatch-final` (e derivadas); 79/79a são de `feat/instagram-fase-1`; **78 livre**, usado.
- **B2.0:** o trecho de `system-prompt.ts` (linhas 214–215) só interpola `agentName` e `restaurantName`, duas vezes cada, sem condicional nem `agent_mode`. Premissa da spec §4.1 confirmada. Seed extraído por script: 939 caracteres, uma linha, sem `$seed$` dentro. sha256 `2b4e3b5b09c903de2827cb9e0f792e573cb5fc34d745d3fc20ae6347864c03d9`, igual no banco e no TS.
- **BYPASSRLS do dono:** não falta. Produção mediu `postgres` com `rolbypassrls=true` em 2026-09-27 (spec Datafy Fase D §1.2) e em 2026-10-17 (plano Datafy, leituras do alvo: 45 corpos `SECURITY DEFINER` com dono com bypass). Localmente o `postgres` é superusuário; o **C4** passa tabelas e RPC a um dono não superusuário e mede: sem `BYPASSRLS` o publish não enxerga o slot (`22023 prompt_slot_invalid`), com `BYPASSRLS` publica. **Reconferir em produção (leitura autorizada) antes do `db push`, no B6.**
- **Pré-voo** (PG 18.6 local, banco `ai78` do zero, porta 55432): 78a ok; 78 antes da migration = **RED** `ERROR: 78: migration do prompt global ausente` (exit 3); migration → 78 **31 e 31**; migration de novo → 78 **31 e 31** (idempotência; o P8 também reaplica dentro do arquivo, com o slot antes movido para a v3). Sequência final repetida num banco recriado do zero depois das correções do pré-gate.
- **NUL medido:** literal `E'\000'` → `22021`; `chr(0)` → `54000`; JSON `"\u0000"` (forma do PostgREST) → `22P05`. Nenhum chega à função.
- **Controles positivos (todos vermelhos com o defeito e verdes com o guard real):** C1 append-only; C2 guard de valor; C3 classe antiga; C4 `BYPASSRLS`; C5 guard de platform_admin nas duas RPCs; C6 checagem de `expected`; C7 validação de corpo e nota (sem a da RPC o CHECK barra com `23514`; com o validador neutralizado passa); C8 checagem de versão (sem ela a FK composta barra a inexistente com `23503` e a já ativa vira rollback vazio); C9 seed de slot com `do update` devolveria o slot à v1 (o P8 acusaria).
- **V5:** o 75 no mesmo banco deu **19/20** — só o S9, `agent_mode = 's75-pa-agent_mode'` recusado com `22023` pelo guard novo (comportamento pedido no V4). O S9 passou a gravar `reservations_faq` em `agent_mode`; o 75 ficou **20/20** no banco do 78 e numa base limpa sem a migration nova. O `\i` do 75 reaplica a classe antiga; o 78 rodado em seguida volta a **31/31**.
- **Gêmeos (`global-prompt-sql-twin.test.ts`, 13 casos):** seed, placeholders, 4000, limites chave a chave, enum, slot e classe de controle do corpo = a do guard de valor; baseline renderizado = trecho atual de `composeAgentSystemPrompt` (com e sem FAQ). Sem RED de "arquivo ausente" (as constantes nasceram com o B2.0); o RED veio por mutação no repo: limite `restaurant_menu` 6500 no TS e baseline com um caractere a menos reprovam, revertidos. Mais 8 controles com SQL sintético.
- **`settings-write-acl.test.ts`:** RED antes da mudança pelos dois motivos certos (3 chaves no classificador sem tela; "vazamento" em `Automacao.tsx`). GREEN 6/6 com `AI_STORE_SETTING_KEYS` na união e a exclusão restrita às 5 `platform` (conjunto exato); controle negativo em memória (classe sem `restaurant_menu`; chave `platform` no classificador).
- **Allowlist:** RED (`publish_/activate_ai_prompt_version/4 → [authenticated] sem entrada`), GREEN com as duas entradas em `authenticated_tenant`; projeção do Advisor 9/37/46. `function-acl-allowlist` + `advisor-divergence-core` + `migration-static-guard` 96/96; `eslint supabase/functions --max-warnings=0` limpo.
- **Verificação V:** typecheck 0; lint 0 erros (17 warnings antigos, nenhum em arquivo do B2); suíte 4220 passam e 45 falham nos **mesmos 8 arquivos do baseline**, sem timeout; build ok; `deno check` de `webhook-whatsapp` e de `global-prompt-core.ts` ok (o grafo: nenhuma EF importa o núcleo ainda); `check-padrao` ok; `check-portabilidade` 487 = baseline.

Desvios e decisões:
- `body_sha256` **não** é coluna gerada: o PG recusa porque `convert_to`/`textsend` são `STABLE`. A RPC e o seed preenchem, com CHECK de formato hex (fallback previsto).
- Validação de corpo e nota em dois helpers `IMMUTABLE` (`app_private.ai_prompt_body_valid`/`ai_prompt_note_valid`), usados pelos CHECKs e pelas RPCs: uma régua só. Revogados de todos, fora da allowlist.
- O `revoke` das três tabelas inclui `service_role` (o plano listava só public/anon/authenticated): os default privileges do Supabase dão ALL a ele, e só as RPCs escrevem. Depois `grant select` a `authenticated` e `service_role`.
- Triggers `BEFORE TRUNCATE` extras nas duas tabelas append-only.
- `activate_ai_prompt_version` recusa a versão já ativa (`22023 prompt_version_invalid`); slot desconhecido é `22023 prompt_slot_invalid` nas duas RPCs.
- Constante extra `GLOBAL_PROMPT_SLOT`, gêmea do CHECK de slot.
- Ordinais 7801–7831, com casos além do plano: P4c (NUL), P4b (bordas aceitas), P9 (quem lê), V3b (cada limite), V6 (chave fora da tabela), V7 (linha legada), C4–C9.
- Triggers `BEFORE DELETE`/`BEFORE TRUNCATE` em `ai_prompt_slots` (o slot é atualizado pelas RPCs, nunca apagado) e policies com `(select auth.uid())`: correções do pré-gate, abaixo.
- A classe de controle recusa `\r` (spec literal: "controle além de `\n`/`\t`").

Pré-gate (Opus) e review de spec (Sonnet):
- **Review de spec (Sonnet): CONFORME**, sem bloqueante. Menores: fechar §8.2 e checkboxes (feito), registrar o pré-gate (feito), extras declarados acima, e o risco do `\r` para B4/B5/B6 (abaixo).
- **`rls-auditor` (Opus): PASS_WITH_WARNINGS, 0 bloqueantes.** Corrigido: a regra dizia "inclusive o dono" no append-only; agora diz "todo papel de API e DML do dono". Para o B6 e para o usuário decidir:
  - **P2 — ordem do deploy.** As 3 chaves viram `manager` no `db push`, mas a defesa contra injeção (delimitação, regra 13) só chega com o deploy da EF do B3. Entre os dois, um gerente pode gravar ordem no cardápio pelo PostgREST e a EF velha a interpola crua (raio: a própria loja). Proposta para o B6: deploy de `webhook-whatsapp` com B3 logo depois do `db push` e antes do merge, ou antes do push (o loader D7 cai em baseline se a tabela não existir; conferir que `42P01` é tratado como erro de leitura).
  - **P3 — dados legados.** O guard recusa ao regravar valor não-string, com `\r`, acima do limite ou `agent_mode` fora do enum. Antes do `db push`, contagem autorizada (sem ler conteúdo) por chave das linhas fora do formato; se > 0, normalizar antes. B4/B5 (e `PromptTab`/`Ajustes`) normalizam `\r\n`→`\n` antes de gravar e tratam `22023`.
  - **P3 — FK `created_by → auth.users`** (pedida pela spec §5.1) impede apagar no Auth um platform_admin que publicou; `set null` é impossível (append-only + CHECK). Alternativa: guardar só o uuid, como `actor`. Mantido como a spec; decisão do usuário.
  - P3 fora do escopo: MFA (`aal2`) nas RPCs de alto alcance; `settings` sem `FORCE RLS` (pré-existente, plano de risco).
- **`migration-validator` (Opus): PASS_WITH_WARNINGS, 0 bloqueantes.** Corrigido com TDD no pré-voo:
  - P3: o P8 não provava "o slot não volta à v1" (o slot já estava na v1). Agora o slot vai à v3 antes do P8, e o C9 mostra que um seed com `do update` seria pego.
  - P3: `ai_prompt_slots` sem proteção contra DELETE/TRUNCATE do dono. RED: o P6 novo apagou o slot como dono e o preparo do P8 abortou (`prompt_slot_invalid`). GREEN: triggers `ai_prompt_slots_no_delete`/`_no_truncate`.
  - P3: policies com `(select auth.uid())` (lint `auth_rls_initplan`); P7 confere o texto novo.
  Registrados para o B6 e o usuário: P2 dados legados fora do formato travam o save em lote de `Ajustes` (`rules_and_conditions`/`additional_info` vão num `upsert` só) — contagem autorizada antes do `db push` e, no B5, contador + normalização + `22023` também em `Ajustes`; P3 FK `created_by` (igual ao rls-auditor; alternativa: runbook de offboarding de admin = remover de `platform_admins` e banir, nunca apagar); P3 `40001` vira HTTP 500 no PostgREST — a UI do B4 decide por `error.code`, nunca pelo status; o `PromptTab` salva 7 upserts em `Promise.all` e pode gravar parcialmente.

### 8.3 B3: passo A, passo B e C-B3

Hash do commit A (snapshot idêntico); diff do snapshot A → B; decisão do C-B3 por unidade.

#### B3: RED, GREEN, controles e decisões (Chat 3, 2026-10-20)

Commits: **A0 `5548e18`** (prova de §4.4), **A1 `1471db6`**, **B `028073c`**, endurecimento do review ``3e373e4``.

- **Passo A dividido em A0/A1 (desvio do plano, decidido no chat).** O snapshot de paridade grava toda leitura do banco (`io`) e o `meta` de `webhook_executions`. A leitura do slot e a telemetria mudam essas seções por definição, sem mudar o prompt. Então:
  - **A0 `5548e18`:** `composeAgentSystemPrompt` monta a camada 2 por `renderGlobalLayer(GLOBAL_PERSONA_BASELINE)`. O snapshot roda **sem `-u` e fica idêntico**: o `.snap` não muda no commit. Controle positivo: um caractere a mais no baseline reprova 6 cenários; o 7º (sem chave BYOK) não chega ao prompt.
  - **A1 `1471db6`:** o loader é ligado e entra a telemetria. O snapshot foi regravado uma vez. Um script comparou seção por seção os 7 cenários: `llm` (prompt, ferramentas e histórico) **idêntica em todos**. Mudam só as 2 leituras novas (`ai_prompt_slots` e `ai_prompt_versions`, filtradas só pelo slot) e `global_prompt_version`/`global_prompt_source` em `executions` e em `agent_usage`; no cenário "resposta vazia", `meta: {}` passa a ter os dois campos. O review de spec conferiu por conta própria.
  - O harness do chat semeia a v1 com `GLOBAL_PERSONA_BASELINE`, como em produção depois do `db push`; o gêmeo SQL prende seed == baseline.
- **Núcleo (`global-prompt-core.ts`):**
  - RED: 28/28 sem as funções. GREEN 28/28.
  - `isValidGlobalPromptBody` gêmea do CHECK, com os casos do P4/P4b e tamanho em code points (`char_length`).
  - `renderGlobalLayer` numa passada, com função de substituição: `$&` e `{{…}}` dentro do valor ficam literais.
  - `resolveGlobalPrompt`/`freshCachedGlobalPrompt` implementam D7: falha usa cache de qualquer idade sem renovar o relógio dele; sem cache, usa o baseline; corpo ou id inválido seguem o caminho do erro. TTL de 60s; relógio que volta não serve cache.
  - `CONTROL_CHAR_CLASS` virou gêmea do SQL em `global-prompt-sql-twin.test.ts`, com controle positivo.
- **Loader (`global-prompt.ts`) e adapter (`adapters/global-prompt-read.ts`).**
  - O `check-portabilidade` barrou `.from(` fora de adapter (489 > 487). Por isso as 2 leituras foram para `adapters/`, e a dívida voltou a 487.
  - O loader não importa `security.ts`: o logger entra por chamada, porque o `tsc -b` alcança o loader e `security.ts` usa `Deno`.
  - RED: o módulo não existia. GREEN 12/12, cobrindo fresco/TTL/stale/baseline nas 7 causas: 42P01, PGRST205, exceção, slot ausente, erro e ausência da versão, corpo inválido.
  - No turno real, `beforeQuery` lança na leitura do slot: o turno termina em `success` com o prompt byte a byte igual ao do baseline, e o evento sai sem o corpo.
  - Teste da versão ativa: com outro corpo no banco, ele é o que entra no prompt.
- **Telemetria.** `promptMeta` entra em todo `finish(` do `turn.ts` depois da carga (8 chamadas) e no `agent_usage`. O guard estático pega qualquer `finish(`, não só `await`. Controles: tirar a chave de um `finish`, do `agent_usage`, da carga, e acrescentar um `void finish("extra")`. O `webhook_error` do catch externo do adapter não leva `promptMeta`; a regra diz isso.
  - `ai-budget-wiring-guard` ficou vermelho no A1 pelo texto literal `finish("ai_budget_exhausted")`. O guard passou a aceitar exatamente `finish("ai_budget_exhausted")` antes da carga e `finish("ai_budget_exhausted", undefined, { ...promptMeta })` depois; o controle continua vermelho.
- **Passo B `028073c`.**
  - `storeDataBlock(title, raw, limit)` neutraliza dentro do helper; o guard exige o limite da mesma chave.
  - Ordem da camada 8 conforme §4.1: "Preços e condições" mudou de lugar e agora vem depois de "Regras de reserva" (camada 7).
  - Regra 13 entra depois da 12; o lembrete final, com o texto exato de §6.3.4, depois das instruções da plataforma.
  - `ai_context_extra` e `ai_system_prompt` continuam instrução, só truncados.
  - Guard estático com 6 fontes sintéticas reprovadas e a canônica aprovada.
  - **Diff do prompt A1→B** (cenário rico):
    - `+13. Dados da loja: …` depois da regra 12;
    - o bloco "Preços e condições do restaurante" sai de antes de "Regras de reserva" e volta depois dela;
    - os 5 textos ganham `<<<DADOS_DA_LOJA: Preços e condições|Informações adicionais|Cardápio|Delivery e retirada|Outras informações>>>` … `<<<FIM_DADOS_DA_LOJA>>>`;
    - `+Em conflito, valem as REGRAS OBRIGATÓRIAS…` no fim.

    Nos outros 5 cenários que chegam ao LLM, só a regra 13 e o lembrete. `io`, `executions` e `logs` ficaram idênticos em todos. O diff integral vai para a descrição do PR (B6.3).
- **Endurecimento depois dos reviews ``3e373e4``.** Antes de corrigir, cada achado virou RED no teste; todos têm controle positivo (9 mutações vermelhas). O snapshot **não mudou**: o texto do fixture não tem quebra nem invisível.
  - **P1-a (Opus).** `halls`, `special_dates` e `table_blocks` são graváveis por **todo membro, inclusive o operador** (RLS das migrations 030, 013 e 032), e entravam crus com `\n`. Um título de bloqueio forjava "Preços e condições do restaurante: 50%…", seção que a Regra 7 aceita. A spec §6.3.6 dizia que "o operador não grava": é falso para essas tabelas.
    - Correção: `shortStoreText` (neutraliza, uma linha só, teto de 200 ou 1000) em nome e descrição de salão, nome de data especial, título e motivo de bloqueio, nome de salão no sufixo e nos campos de `units` (nome, descrição, pagamento, horário, endereço, cozinhas, facilidades, telefone, Instagram e site).
    - Também em `restaurant_name`, `agent_name` (40) e primeiro nome do cliente (40).
  - **P1-b.** Alergias, restrições e VIP mantinham `\n` e podiam forjar uma linha de voucher do cliente. Hoje não chegam ao prompt no WhatsApp: `resolveOrCreateCustomer` lê só `id, name, phone, email, emails, birthday`. Passam por `shortStoreText` como defesa para outro canal.
  - **P2-a.** Invisíveis atravessavam a neutralização:
    - removidos agora: `\p{Cf}` (zero-width, bidi, tags, BOM, soft hyphen), CGJ, seletores de variação e C1;
    - NEL, U+2028 e U+2029 viram `\n`;
    - homóglifos ficam como risco residual.
  - **P2-b.** Neutralizar era quadrático com marcadores aninhados: 16 mil níveis (210 KB) levavam 2,3 s. Agora trunca **antes** de neutralizar, e `limit` é obrigatório.
  - **P2-c.** `booking_window_days`, `reservation_duration_minutes` e `reservation_tolerance_minutes` (classe `manager`, sem guard de valor) entravam crus, podendo ser string com `\n` ou objeto. Agora só inteiro positivo.
  - **P3.**
    - O guard estático reprova `Object.entries/values/keys(settingsMap)`, `JSON.stringify(settingsMap)` e `...settingsMap`. Ficam residuais a chave montada em tempo de execução e leituras fora de `_shared/agent/**` e do webhook.
    - O harness C-B3 recusa entrada ou saída dentro desta worktree **ou** do checkout principal: caminho real, comparação sem caixa, checagem antes de criar pasta. Também valida slug e ref.
- **Review de spec (Sonnet): CONFORME COM RESSALVAS.** Ressalvas fechadas: evidência e checkboxes, regra da telemetria, guard da franquia estrito, limite do guard estático documentado.
- **Review de qualidade e segurança (Opus): APROVADO COM RESSALVAS**, sem P0. Corrigidos P1-a, P1-b, P2-a, P2-b, P2-c e P3 (guards e harness). Conferidos corretos: loader D7, telemetria, render, cache stale, ausência de corpo no log e prompt caching (lembrete constante no fim do bloco único).
- **Para o usuário decidir (não corrigido):**
  - **P2-d.** O lembrete final ("Em conflito, valem as REGRAS OBRIGATÓRIAS") vem depois das "Instruções adicionais" da plataforma. Em conflito, a instrução da plataforma agora perde para as regras 1–13; antes, era a última palavra. É o texto literal da spec §6.3.4. Se alguma loja tiver `ai_system_prompt` que contraria uma regra (por exemplo, oferecer fila de espera contra a Regra 12), o C-B3 mostra. Alternativa: "…; as Instruções adicionais da plataforma podem ajustá-las".
  - **RLS (follow-up de banco, fora do B3):**
    - operador grava `halls`, `special_dates` e `table_blocks`;
    - possível INSERT anon em colunas de equipe de `customers` (`vip_notes`) via `anon_insert_customers` (023b). Não medido; conferir com `has_column_privilege('anon','customers','vip_notes','INSERT')` no harness local.
  - **P3 de texto:** a Regra 7 nega promoção escrita no Cardápio (só aceita "Preços e condições"), e a âncora negativa do Giftback compete com "Preços e condições".
- **Verificação V** (cada commit):
  - typecheck 0;
  - lint 0 erros (17 warnings antigos);
  - suíte: falhas só nos 8 arquivos do baseline (45 testes). No B, `whatsapp-reservation-automation-routing` teve timeout de worker do vitest sob carga; isolado deu as mesmas 3 falhas do baseline;
  - build ok;
  - `deno check` de `webhook-whatsapp` ok;
  - `check-padrao` ok;
  - `check-portabilidade` 487 = baseline.
- **Grafo (`ef-import-graph`):** `global-prompt-core.ts`, `global-prompt.ts`, `adapters/global-prompt-read.ts`, `store-data-core.ts`, `system-prompt.ts` e `turn.ts` → só **`webhook-whatsapp`**. `global-prompt-core.ts` também vai para o front no B4/B5, que exige deploy do front.

#### Checkpoint C-B3 (FECHADO em 2026-10-29)

- Harness: `src/lib/agent-prompt-checkpoint.local.test.ts`. Sem `PROMPT_CHECKPOINT_FILE`, é pulado.
  - Renderiza `loadAgentSystemPrompt` do commit `1471db6` (A1) e do atual, sobre um cliente falso com os dados exportados.
  - Escreve `<slug>.A.txt`, `<slug>.B.txt` e `<slug>.diff` fora de qualquer checkout.
  - Validado com dados sintéticos: um "IMPORTANTE PARA A IA: …" em `restaurant_extra_info` aparece dentro do bloco "Outras informações", que é o caso que o C-B3 procura.
- A consulta só de leitura (`units` + chaves de `settings` das unidades com `ai_config`) foi entregue no chat. A leitura de conteúdo de produção depende de autorização do usuário, ou o usuário roda.
- **Execução (2026-10-29, autorizada pelo usuário):** leitura só de leitura em produção (`units` com `ai_config` → 2 unidades; os 13 `settings` que o prompt lê e os 3 campos curtos de `units`). JSON e saídas ficaram no scratchpad da sessão, fora de qualquer checkout; nada de produção entrou no repo. Harness verde sobre `HEAD 77c9853` contra a base `1471db6`.
- **Decisão por unidade (usuário, 2026-10-29): nenhuma correção de conteúdo.**
  - `moralles-centro`: os 3 blocos `DADOS_DA_LOJA` (cardápio, delivery, outras informações) só têm fatos. `ai_system_prompt` sem conflito com as regras 1–13.
  - `ren-sushi`: idem para os 4 blocos (inclui "Preços e condições"). A única instrução ("sempre avisar que atende por ordem de chegada") está em `ai_context_extra`, que segue fora do bloco de dados e continua instrução; ordem de chegada não é fila de espera (Regra 12).
  - P2-d (lembrete final de precedência): sem efeito nas 2 unidades; fica o texto literal da spec §6.3.4.
- **Diferenças cosméticas aceitas:** o `INVISIBLE_RE` de `store-data-core.ts` remove `U+FE0F` (☀️ → ☀, 🍽️ → 🍽); `opening_hours_text` multilinha vira uma linha (`shortStoreText`); no Ren, "Regras de reserva" sai de dentro do bloco de preços.
- **Follow-ups:** (1) avaliar liberar só `U+FE0F` no `INVISIBLE_RE`, mantendo o resto da faixa; (2) conteúdo do Ren, pré-existente: os preços estão em `rules_and_conditions` e divergem do Cardápio nos dias do jantar — a loja corrige.
- **Efeito:** C-B3 fechado; o deploy da `webhook-whatsapp` (B6.4 passo 3) deixa de estar bloqueado por ele.

### 8.3a B4/B5: RED, GREEN, controles e decisões (Chat 4, 2026-10-21)

Execução: Opus orquestrou; Sonnet implementou e fez o review de spec; Opus fez os reviews de qualidade/segurança, o re-review e o review final. Relatórios completos (RED/GREEN e cada controle positivo) ficaram nos relatórios das tarefas; o essencial está aqui.

**Commits**
- `a1bb411` B4: tela `/platform/agente-ia`.
- `bd0b342` B4, rodada 1 de correções:
  - id esperado preso ao rascunho (`draft = { text, baseId }`), com aviso e o botão "Basear na versão ativa atual";
  - cópia do 40001;
  - diff com prefixo/sufixo cortados e tabela plana + `useMemo`;
  - paginação por keyset (`.lt("version")` + `.range(0,49)`);
  - a11y e testes.
- `b17ff2a` B5: tela `/g/:unitSlug/atendimento-ia`, mais os limites no `PromptTab` e em `Ajustes`.
- `15700c9` B4, rodada 2 de correções:
  - adaptador `src/features/ai-prompt/api.ts` (o `check-portabilidade` acusava 493 > 487);
  - Publicar bloqueado com base desatualizada;
  - `Uint16Array`;
  - `role="status"`.
- `2af4d0b` B5, rodada 1 de correções:
  - coerção de valor legado não-string no `PromptTab`;
  - nome do agente sem `maxLength`;
  - aviso perto do Salvar em `Ajustes`;
  - `isError && !data`.
- Commit de fechamento (este):
  - o texto gravado entra no cache antes da releitura (`useSaveAiStoreSettings`);
  - cópia do aviso de `Ajustes` ("Corrija…", que também cobre caractere inválido);
  - esta evidência.

**Módulos novos**

| Arquivo | O que tem |
|---|---|
| `src/lib/text-normalize.ts` | `normalizeNewlines`: `\r\n?` vira `\n` |
| `src/lib/text-line-diff.ts` | `diffLines`, LCS sem dependência |
| `src/lib/ai-prompt-errors.ts` | `promptErrorMessage` |
| `src/lib/store-text.ts` | `storeTextError`, `isValidStoreText`, `settingsWriteErrorMessage`, `settings_not_written` |
| `src/features/ai-prompt/api.ts` e `src/features/ai-store/api.ts` | adaptadores |
| `src/hooks/useAiPromptVersions.ts` e `src/hooks/useAiStoreSettings.ts` | hooks |
| `src/components/ai/StoreTextCounter.tsx` | contador |

O núcleo ganhou `GLOBAL_PROMPT_NOTE_MAX_CHARS = 280` e `isValidGlobalPromptNote`. É a gêmea de `app_private.ai_prompt_note_valid`, presa no `global-prompt-sql-twin.test.ts`. É só acréscimo, sem efeito nas EFs.

**RED**
- Módulos novos: `Failed to resolve import`.
- Twin: `limite do motivo 280 != undefined`.
- Nav: `expected [] to have a length of 1`.
- PromptTab: `TypeError: text.replace is not a function` (legado não-string).
- AtendimentoIa: a tela de erro aparecia com dado em cache.
- Releitura que falha depois de salvar: o cache voltava ao texto antigo.

Desvios declarados: as páginas `AgenteIa`, `AtendimentoIa` e a tela/hook do passo 7 do B5 tiveram o RED obtido tirando o arquivo do lugar. Isso foi compensado por controles positivos: cerca de 15 no B4 e cerca de 50 no B5, cada defeito reintroduzido reprovado por um teste.

**Rulings do controlador** (cada um com o custo se estiver errado)
1. Autor da versão: "Você", "Sistema (versão inicial)" ou "Admin " + 8 caracteres do uuid. Sem RPC de nomes. Custo: só a cópia.
2. A gêmea da nota fica no núcleo. Custo: nenhum comportamento muda; entra no redeploy do B6.
3. Normalização `/\r\n?/g`. Custo: nenhum, porque o banco recusa `\r` de qualquer forma.
4. `Ajustes` entra no B5. Custo: texto legado acima do limite trava o Salvar do lote até ser corrigido, agora com aviso perto do botão.
5. `PromptTab` mantém os 7 `mutateAsync` em `Promise.all`, por causa da regex do ACL, e valida tudo antes. Custo: ainda pode gravar parcialmente em erro de rede.
6. Tela e item da Gestão ficam atrás de `isGerente`.
7. Nome do agente sem `maxLength` no DOM, porque ele conta UTF-16 e corta a colagem em silêncio. Fica o contador mais a validação em code points do texto aparado. Custo: só UX, porque o banco recusa acima de 40.

**Reviews**
- B4:
  - spec (Sonnet) Aprovado;
  - qualidade (Opus) Aprovado com 10 Minor, dos quais 7 corrigidos na rodada 1;
  - re-review (Opus) Aprovado com 4 Minor, dos quais 3 corrigidos na rodada 2.
- B5:
  - spec (Sonnet) Aprovado;
  - qualidade (Opus) Aprovado com 6 Minor, dos quais 4 corrigidos.
- Review final B4+B5 (Opus): pronto para fechar, 0 Critical.
  - **1 Important, de sequência de deploy** (ver o aviso em B6.4).
  - Minor corrigidos no fechamento: cache depois de salvar e cópia "Corrija".
- Minor que ficam:
  - "slot ausente" antes do `db push` cai no card de erro genérico, porque o PostgREST devolve `PGRST205`/`42P01` e não `data: null`;
  - o teste dos 20 ms em `AtendimentoIa` é estável mas frágil (a correção é `notifyManager.setScheduler`);
  - `isLoading` em vez de `isPending` quando a query está pausada offline;
  - a cópia do 40001 não cita o botão "Basear";
  - o restaurar zera o rascunho;
  - `prompt_slot_invalid` cai na cópia de texto.
- Follow-up fora do escopo: o `saveSetting` da aba IA (`ai_config`, `Automacao.tsx`) continua sem `.select()` e mostra `err.message` cru.

**Verificação V (HEAD de fechamento)**
- `npm run typecheck`: 0 erros.
- `npm run lint`: 0 erros, 17 avisos, todos em arquivos que não foram tocados.
- Suíte: 4555 testes, 51 falham em 12 arquivos.
  - 8 desses arquivos são exatamente os do baseline (45 falhas, mesmas contagens).
  - Os outros 4 são os conhecidos por timeout: edge-request-harness, agent-turn-parity, whatsapp-scheduled-templates-integration e whatsapp-survey-tenant-routing. Rodados um a um com `--testTimeout=120000`, passam: 17/17, 15/15, 23/23 e 16/16.
- `npm run build`: ok.
- `ef-import-graph global-prompt-core.ts` aponta só para `webhook-whatsapp`, e o `deno check` dela passa.
- `check-padrao`: ok.
- `check-portabilidade`: 487, igual ao baseline.

### 8.4 B6: rollout

PR, checks, `db push`, merge, deploy, verificação.

#### B6.1–B6.2 (Chat 5, 2026-10-29)

**Integração com a `main`.** A branch partiu de `bab6033`; a `origin/main` estava em `a7624e7` (15 commits: MARKETING, serviço v2 self-service, `react-router-dom` 7.18, barra de rolagem das abas).
- `d47486e`: merge local da `origin/main` com 3 conflitos resolvidos mantendo os dois lados:
  - `function-acl-allowlist.json`: entradas de MARKETING/serviço v2 e as 2 RPCs do prompt; projeção 9/44/53;
  - `App.tsx`: rotas lazy de Marketing e AtendimentoIa;
  - `Ajustes.tsx`: textos normalizados do B5 e a escrita condicional dos interruptores legados da `main`; `Ajustes.test.tsx` ganhou os mocks de `useAuth`/`useWhatsappServicePreferences` (coorte manual, lote de 7).
- `9688a21` (usuário): C-B3 fechado.
- `0b71574`: testes do B4/B5 sem a prop `future` (removida no `react-router` 7, TS2322) e stub de `ResizeObserver` no PromptTab (o `scroll-area` da `main` usa).
- **Renomeação das migrations e do pré-voo (decisão do usuário).** Produção já tinha `20261020183000`, `20261020184000` e `20261021190000`; as únicas locais ausentes eram as duas desta branch, com timestamp anterior. O push comum recusaria, e o `--include-all` contraria o runbook do Datafy. Por isso: `20261020130000` → **`20261029120000`**, `20261020150000` → **`20261029120100`** (conteúdo idêntico; só 2 linhas de comentário mudaram), e pré-voo 78/78a → **80/80a** (a `main` tem outro 78; 80 livre em todas as branches), com ordinais 7801–7831 → 8001–8031 (o 78 da `main` usa 7801–7803). Os identificadores do fixture (`ai78_*`, UUIDs `a0d78000-…`) ficaram. O `migration-validator` mediu que aplicar estas depois das 3 já aplicadas não muda nenhum resultado: nenhuma toca `settings`, as funções recriadas são disjuntas e não há grant amplo. Guards que leem migrations pelo nome: 675/675 (26 arquivos).

**Verificação V (HEAD `0b71574` e depois da renomeação)**
- typecheck 0; lint 0 erros (17 avisos antigos); build ok; `check-padrao` ok; `check-portabilidade` 487 = baseline.
- Suíte: 4516 passam, 7 falham em 7 arquivos, rodada sob carga junto com os gates. Um a um com `--testTimeout=120000`, passam: `ReservaWizard.marketing` 4/4, `TemplateV2ChannelControls` 7/7, `edge-request-harness` 17/17, `whatsapp-automation-receipts-request` 35/35, `whatsapp-reservation-automation-routing` 111/111, `whatsapp-waitlist-voucher-routing` 75/75. `OfficialConnectionCard` só falha na worktree sem `.env.local` (passa 16/16 no checkout principal; a branch não toca o arquivo). Dos 8 arquivos do baseline antigo, a `main` consertou 7.
- `acl-estatico` local: `function-acl-allowlist` + `advisor-divergence-core` + `migration-static-guard` 96/96; `eslint supabase/functions --max-warnings=0` limpo.
- `secret-scan --range origin/main..HEAD`: 0 achados em 18 commits.
- **Pré-voo 80 (2026-10-29, container descartável `postgres:18` em `127.0.0.1:55480`, banco `ai80` do zero, removido ao fim):** a porta 55432 passou a ser de um container de outro projeto e não foi usada. Sequência do README: 80a ok; 80 antes da migration = **RED** `ERROR: 80: migration do prompt global ausente` (exit 3); migration → 80 **31 e 31**; migration de novo → 80 **31 e 31** (idempotência); 75 **20 e 20**; 80 de novo **31 e 31**.
- **`deno check supabase/functions/webhook-whatsapp/index.ts`:** ok, sem erros (`npx --yes deno` 2.9.6, autorizado pelo usuário).

**Leituras antes do `db push` (2026-10-29, produção, só leitura, autorizadas)**
- `settings` fora do formato do guard, por chave, sem ler valor: as 9 chaves validadas têm 2 linhas cada e **0** não-string, **0** acima do limite, **0** com caractere de controle; `agent_mode` 2 linhas, **0** fora do enum. Nenhuma linha legada travaria uma escrita.
- `pg_roles` do `postgres`: `rolsuper=false`, **`rolbypassrls=true`** — as RPCs escrevem sob `FORCE RLS` sem policy de escrita, como o C4 do pré-voo pressupõe.
- **Preços reconferidos no dia** nas páginas oficiais: todos iguais, exceto o cache de leitura do `claude-sonnet-5-5`, que a página de preços dá como 0,10 (a migration grava 0,20, a escolha conservadora feita quando as duas fontes divergiam). **Mantido 0,20:** superestima o custo, ou seja, falha para o lado seguro, e o Sonnet não é o modelo default. Acertar exige vigência nova, nunca UPDATE (follow-up). Ressalvas confirmadas: o `gpt-5.6-sol` tem preço promocional "pelo menos até 2026-11-21"; o `deepseek-flash` está gravado na tarifa de pico; faixas de contexto longo (Haiku > 100k, Grok ≥ 200k) não estão na tabela.
- **`db push` (B6.4 passo 1, 2026-10-29):** dry-run com `--skip-vault` listou exatamente `20261029120000` e `20261029120100`; o push foi rodado pelo usuário no terminal (o classificador do Claude Code bloqueou o comando). Conferência só de leitura em seguida: as 2 versões em `schema_migrations`; preços **10 linhas, 9 abertas**; `ai_prompt_versions` só a v1 (`seed`, `created_by` nulo); slot `global_persona` na v1; ativação `seed`; triggers append-only/no-truncate/no-delete nas 3 tabelas e `settings_write_value_guard` ao lado do `settings_write_role_guard`; RLS e FORCE RLS nas 3; `publish_`/`activate_ai_prompt_version` sem EXECUTE para `anon` e com EXECUTE para `authenticated`; nenhuma das 3 tabelas legível por `anon` nem gravável por `authenticated`.
- **Deploy da `webhook-whatsapp` (B6.4 passo 2, 2026-10-29):** rodado pelo usuário a partir da worktree em `ee08ecb`; produção em **v113**, `verify_jwt=false`, ACTIVE. Primeiros turnos do agente (`global_prompt_source='db'`, v1, modelo resolvido) ainda a observar quando houver tráfego.
- **FK `created_by` (P3):** o usuário delegou a decisão e **ela fica, como na spec**: dá integridade referencial e evita mexer na migration depois dos gates e do pré-voo. Para remover um admin que já publicou, ele sai de `platform_admins`, não do Auth (follow-up para registrar no runbook).

**Gates (Opus, diff `origin/main..HEAD`)** — todos PASS_WITH_WARNINGS, 0 bloqueantes:

| Gate | P2 | P3 (resumo) |
|---|---|---|
| `migration-validator` | — | push fora de ordem (resolvido pela renomeação); `ai_model_prices` sem schema na migration de preços (convenção da 099) |
| `rls-auditor` | — | o guard de valor não recusa `<<<`/`>>>` nem invisíveis nas chaves da loja (só a EF neutraliza); `restaurant_name` sem limite no banco; o seed também depende de `BYPASSRLS` (o C4 só mede o publish) |
| `identity-access-auditor` | — | platform_admin que também é operador real da loja não vê a tela da Gestão (falha fechada, só UI; Marketing já usa `|| isPlatformAdmin`); gerente influencia o texto do bot (decisão D2, contida) |
| `tenant-isolation-auditor` | — | pré-voo sem caso de gerente da U2 gravando as 3 chaves da U1 (o 75 cobre o caso genérico); injeção intra-loja; cache do prompt global sem dado de unidade (registro) |
| `secret-hunter` | — | literais `sk-ant-123` em testes negativos (falso-positivo) |
| `integration-reliability-auditor` | franquia conta raciocínio/cache em dobro (OpenAI/xAI/Gemini; mapeamento antigo que pesa com os perfis novos); timeout de 12s por chamada compartilhado entre retries, apertado para os modelos `strong` com raciocínio | loader sem backoff de falha, leitura única nem timeout; `webhook_error` sem `promptMeta`; janela do D5 sem Pro e sem reserva quando a troca falha depois; custo da telemetria com o preço do último modelo |
| `ai-automation-auditor` | texto do operador (salão, data especial, bloqueio) e `reservations.notes` chegam fora do bloco delimitado e podem citar "REGRAS OBRIGATÓRIAS"; a premissa "o operador não grava" da spec §6.3.6 é falsa; prompt sem teto de linhas (salões/bloqueios) infla o custo | homóglifo/colchete largo forja o marcador (risco residual já registrado); `AI_ESTIMATE_BASE_INPUT_TOKENS` 6000 abaixo do prompt máximo |

Review da branch inteira (Opus): pronto para PR com ressalvas, 0 Critical. Merge conferido sem regressão (rotas, navegação, Ajustes, PromptTab, allowlist). Important 1 (migrations fora de ordem) e 2 (`--skip-vault` ausente na receita do `db push`) estão resolvidos acima e no B6.4. Minor: pré-voo 78 repetido (resolvido); a cópia de `AtendimentoIa.tsx` diz "Preços e condições", mas o campo em Ajustes se chama "Regras e Condições"; a matriz de redeploy foi remedida no HEAD pós-merge (B6.1).

**Decisões do usuário (2026-10-29):** ordem de deploy (a) push → EF → merge; renomear as migrations; P2/P3 dos gates viram follow-up no PR, porque nenhum afeta as 2 lojas hoje (ambas no `gemini-2.5-flash` padrão, sem modelo `strong`).

#### B6.3–B6.4: PR, merge e verificação (2026-10-29)

- **PR #60:** `acl-estatico` pass, Vercel preview pass, `acl-com-banco` (manual, alvo não-produção) pulado. Follow-ups listados no corpo do PR. Mergeado às 17:17 UTC: `main` **`aecc574`**, cabeça `9d5ea4e`. Deploy da Vercel em `aecc574`: success.
- **Mesmo código na EF e na `main`:** a `webhook-whatsapp` v113 saiu de `ee08ecb`. `ee08ecb..9d5ea4e` só acrescenta 2 linhas neste plano, e `9d5ea4e..aecc574` não mexe em `supabase/functions`. A EF de produção é o código da `main`.
- **Primeiros turnos (produção, só leitura, sem conteúdo nem telefone; janela 17:10–17:26 UTC):**
  - `ai_prompt_versions` tem só a v1, `9bfa9819-55b9-42c1-a15b-b787aa78d48c`;
  - 16 execuções, todas de uma das 2 lojas; a outra ainda sem tráfego;
  - 1 turno do agente com `outcome='success'`, `meta.global_prompt_source='db'` e `meta.global_prompt_version` igual à v1;
  - 2 `webhook_error` com `processed_message_inflight`, que é reentrega concorrente e aparece todo dia na semana anterior (cerca de 1 por `success`); não veio do deploy.
- **Logs da função (17:00–17:35 UTC, leitura autorizada pelo usuário):** 3 `agent_usage`, todos da mesma loja, com `provider=gemini`, `model=gemini-2.5-flash`, `global_prompt_source=db` e a versão v1. **Zero** `ai_global_prompt_read_failed`, `ai_model_retired` e `ai_model_fallback`. Os únicos `level:error` são `processed_message_inflight` (3 até 17:35, o mesmo caso acima) e o `WHATSAPP_TEMPLATE_PIPELINE_ALERT` do pipeline de templates, que já disparava antes do deploy (83 vezes entre 10:00 e 17:00 UTC) e não tem relação com esta entrega. A outra loja segue sem turno do agente; o modelo dela é o mesmo default.
- **Testes manuais do usuário:** o owner salvou o cardápio em Atendimento por IA; o admin vê a v1 em `/platform/agente-ia`. Os dois passaram.
