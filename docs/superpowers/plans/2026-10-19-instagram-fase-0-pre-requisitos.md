# Plano — Instagram Fase 0: pré-requisitos no agente

- **Spec:** [2026-10-19-instagram-modulo-design.md](../specs/2026-10-19-instagram-modulo-design.md). A abordagem foi aprovada em 2026-10-19; o aceite cobre implementação **local**. Deploy de `webhook-whatsapp` e push para `main` exigem autorização própria.
- **Branch:** `feat/instagram-module` (worktree `.claude/worktrees/instagram-module`), rebaseada sobre `origin/main` `d18f975`.
- **Dependência resolvida:** `feat/agente-ia-cortes-fallback` entrou em `main` (PR #39, `d18f975`) em 2026-10-19 e esta branch foi rebaseada sobre ela sem conflito. A Task 3 está liberada.
- **Fluxo:** para cada task, um implementador, review de spec e review de qualidade. Ao fim, review da branch inteira e gates `saas-shield-br`.
- **Modelo por papel:** Sonnet implementa as Tasks 1 e 2 (plano mapeado, núcleo puro com testes). Opus revisa segurança e faz a Task 3 (refactor amplo com risco de regressão).

## Task 1 — Escopo de tenant nas ferramentas de reserva do agente

Arquivos:
- novo `supabase/functions/_shared/agent-reservation-tools.ts`;
- `supabase/functions/webhook-whatsapp/index.ts` (só as funções `getReservation`, `updateReservation`, `cancelReservation` e o despacho em `onToolCall`);
- novo teste `src/lib/agent-reservation-tools.test.ts`.

- [x] Mover `getReservation`, `updateReservation` e `cancelReservation` para o núcleo novo, recebendo o client como parâmetro e um escopo obrigatório `{ unitId, customerId }`.
  - Toda query leva `.eq("unit_id", unitId)` e `.eq("customer_id", customerId)`.
  - Leitura e escrita só sobre `status in ('confirmed','pending')`.
- [x] `get_reservation` sem código busca a mais recente do `customerId` resolvido (cliente já canônico do turno). Assim some o lookup de `customers` por telefone sem organização.
- [x] `update_reservation` e `cancel_reservation` usam `.select("reservation_code")` e conferem a linha. Zero linhas vira `{ success:false }` com mensagem PT-BR neutra, que não distingue "não existe" de "é de outra pessoa".
- [x] Nenhum `error.message` do Postgres volta ao LLM: mensagem curta PT-BR e detalhe só no log.
- [x] O despacho em `onToolCall` passa `{ unitId, customerId: customer.id }`. Assinaturas das ferramentas (nomes, parâmetros, descriptions) e a flag `mutatingToolUsed` continuam iguais.
- [x] Testes com client falso que registra os filtros:
  - os três caminhos aplicam unidade, cliente e status;
  - código de outro cliente ou de outra unidade → não encontrado, sem escrita;
  - zero linhas → `success:false`;
  - erro de banco → mensagem genérica sem o texto do erro;
  - código vazio → mensagem existente.

## Task 2 — Alterar reserva revalida disponibilidade (IA e painel)

Decisão do responsável em 2026-10-19: ajustar `availability.ts` com parâmetros opcionais, corrigindo a IA e a Edge Function do painel.

Arquivos: `_shared/availability.ts`, `_shared/agent-reservation-tools.ts`, `webhook-whatsapp/index.ts`, `update-reservation/index.ts`, testes e fixture de integração.

- [x] `AvailabilityParams` ganha `excludeReservationId` e `preferTableId`, opcionais. Sem eles o resultado é idêntico ao de antes (reserva nova).
- [x] A reserva alterada não conta contra si mesma (fixa ou flutuante). A mesa atual é mantida se continuar livre e compatível; senão vale o first-fit.
- [x] `update_reservation` da IA lê a reserva no escopo, revalida no salão da mesa atual quando data, hora ou pessoas mudam, e grava `table_id = suggestedTableId ?? null`. Sem vaga, não grava; 23505 vira "horário acabou de ser ocupado". Só observação não revalida.
- [x] `update-reservation` (painel) usa os mesmos parâmetros, mantém o salão da mesa atual quando o gerente não escolhe outro, move a mesa quando ele não escolhe uma e deixa de devolver `error.message` do Postgres.

## Task 3 — Extrair o núcleo do agente (depois do merge de `feat/agente-ia-cortes-fallback`)

Arquivos:
- novo `supabase/functions/_shared/agent/` (`channel-context.ts`, `system-prompt.ts`, `tools.ts`, `turn.ts`);
- `webhook-whatsapp/index.ts`;
- testes de paridade em `src/lib/`.

- [x] Rebase sobre `main` e releitura das regras `agente-ia.md`, `whatsapp.md` e `reservas.md`.
- [x] Extrair com o `ChannelContext` da spec:
  - montagem do prompt (`restaurantInfoLines`, blocos de horário, datas, giftback, regras);
  - `agentTools` e o despacho;
  - turno (debounce, lock, franquia, retry silencioso, handoff).

  O WhatsApp passa o contexto atual (`identityLine` com o telefone, `sanitizeForWhatsApp`, `sendAutomatic`, `reservationSource:"whatsapp"`).
- [x] Teste de paridade:
  - snapshot do prompt gerado antes e depois para um fixture de unidade;
  - igualdade da lista de ferramentas;
  - controle positivo (alterar uma linha do prompt quebra o snapshot).
- [x] `node scripts/ef-import-graph.mjs` para cada `_shared` novo ou alterado; registrar a matriz de redeploy.

## Task 4 — Gates e entrega local

- [x] `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build` e `deno check supabase/functions/webhook-whatsapp/index.ts`.
- [x] Gates `saas-shield-br`: `tenant-isolation-auditor` e `identity-access-auditor` sobre o diff; `integration-reliability-auditor` se a Task 3 tocar debounce ou lock.
- [x] Review da branch inteira.
- [x] `git status`, `git diff --cached` integral, varredura de segredos nas linhas staged e `git add` explícito.
- [x] Commit, push e PR com autorização. O deploy de `webhook-whatsapp` acontece só com autorização própria, em janela de baixo tráfego, e é conferido em `webhook_executions`.

## Evidências

### Task 1 (2026-10-19)
- Núcleo `supabase/functions/_shared/agent-reservation-tools.ts`; `webhook-whatsapp` passa `{ unitId, customerId: customer.id }` aos três casos de `onToolCall`. Contrato das ferramentas e flags de retry inalterados.
- `npx vitest run src/lib/agent-reservation-tools.test.ts`: 13/13. Controle positivo: remover `.eq("customer_id")` do cancel reprova 1 teste; restaurado, 13/13.
- `npm run typecheck` e ESLint dos dois arquivos: limpos. `npx deno@2.1.4 check supabase/functions/webhook-whatsapp/index.ts`: ok (deno não está no PATH nem no CI).
- `node scripts/ef-import-graph.mjs supabase/functions/_shared/agent-reservation-tools.ts`: 1 EF (`webhook-whatsapp`).
- Suíte completa: as falhas vistas são de ambiente. As 5 suítes que carregam o webhook real passam isoladas (237/237); `OfficialConnectionCard` e `App.preference-route` exigem `.env.local`, ausente no worktree, e passam no checkout principal (30/30); as demais foram timeout de 5s com duas execuções concorrentes.
- Mudança de comportamento aceita: reserva feita sob outro cadastro (acompanhante) não é mais encontrada pela IA, que recebe "Reserva não encontrada ou já cancelada." (a equipe resolve pelo painel).

### Task 2 (2026-10-19)
- `src/lib/availability-reservation-edit.test.ts` (banco em memória, 7 casos): 7/7. Controle positivo: sem o filtro de exclusão e sem a mesa preferida, 3 falham; restaurado, 7/7.
- `src/lib/agent-reservation-tools.test.ts`: 20/20 (12 casos de update).
- A fixture de integração ganhou a coluna real `reservations.table_id` (o harness recusa coluna fora do schema declarado). As 6 suítes que carregam o webhook real e o guard de authz: 242/242.
- `npm run typecheck`: zero erros. O teste passou a incluir `availability.ts` no programa do tsc, o que expôs o estreitamento `!override.closed` (regra do AGENTS §6); corrigido para `override.closed === false`, sem mudança de comportamento.
- ESLint dos arquivos tocados: limpo. `deno check` em `webhook-whatsapp`, `update-reservation`, `create-reservation` e `create-manual-reservation`: ok.
- `node scripts/ef-import-graph.mjs supabase/functions/_shared/availability.ts`: 4 EFs (as quatro acima). Matriz de redeploy da Fase 0 até aqui: essas 4.
- Observação: `useUpdateReserva` (único caller de `update-reservation` no front) não é usado por nenhum componente hoje; a correção do painel é preventiva.
- Fora do escopo, registrado: a alteração não recalcula `applied_discount_percent` quando o novo horário tem outro desconto (decisão comercial pendente).
- Após o rebase sobre `d18f975`: `npm run typecheck` zero erros; 10 suítes relacionadas (inclui `agent-output-core` e `agent-calendar-core` da PR #39) 287/287; `deno check` das 4 EFs ok.

### Task 3 (2026-10-20)
- Rebase sobre `origin/main` `2ea296d` sem conflito; releitura de `agente-ia.md`, `whatsapp.md`, `reservas.md` e `edge-functions.md`.
- **Paridade comportamental gravada ANTES da extração** (`c6f6cd4`): `src/lib/agent-turn-parity.test.ts` roda o `webhook-whatsapp` real no harness de Request com SDK Anthropic falso e prende, em 7 cenários (prompt rico, horários por salão, ida e volta de ferramentas, handoff por ferramenta, erro do provedor com retry, resposta vazia, sem chave BYOK), a entrada do LLM (prompt, ferramentas, histórico), a sequência de leituras/escritas/RPCs/envios, os logs e `webhook_executions`. O fixture ganhou as colunas reais de `hall_schedules` e a tabela `tables`. Duas execuções seguidas: determinístico.
- Núcleo em `supabase/functions/_shared/agent/`: `channel-context.ts` (tipos), `system-prompt.ts` (carga na mesma ordem de leituras e relógio, montagem pura `composeAgentSystemPrompt`), `tools.ts` (definições e implementações com o client por parâmetro), `turn.ts` (`createAgentTurn(io)`: resolved→handoff UX→debounce→lock→franquia→prompt→laço com retry e reserva→desfechos). O `webhook-whatsapp` caiu de 5000 para ~2950 linhas e entra com o contexto do WhatsApp (`sendOutbound`, `sanitizeForWhatsApp`, identidade com o telefone, `WHATSAPP_FORMATTING_RULES`, `reservationSource:"whatsapp"`).
- Depois da extração o snapshot passou **byte a byte** sem regravar. Controles positivos: tirar "Nunca atalhe." da regra 1 reprova 6 cenários; inverter `finish`/`releaseAiLock` no desfecho vazio reprova 1. Os dois restaurados por cópia idêntica (`cmp`). Teste novo prova que o harness carrega `_shared/agent/{turn,system-prompt,tools}.ts`.
- Guardas textuais reapontados para o arquivo onde o código mora, sem afrouxar: `ai-budget-wiring-guard` (turno em `turnCode`, catch externo no webhook, portas de handoff sobre webhook+turno; a varredura de saídas agora prende TODO `return` do corpo de `run`, não só uma forma), `whatsapp-inbound-reentry` (+ amarra nova: o webhook entrega ao turno `ingestionSource` e `t0` por identidade), `agent-provider-fallback-wiring`, `whatsapp-conversation-parity-guard` (a cerca vale para `ctx.send`; o núcleo não chama `sendOutbound`), `whatsapp-multiprovider-wiring-guard`. Sabotagens no `turn.ts` (trava de mutação do retry, liquidação do sucesso, status de uma porta de handoff) reprovam cada uma.
- `src/lib/agent-core-channel.test.ts`: identidade e formatação entram pelo contexto (o núcleo não contém o texto do WhatsApp), conjunto de ferramentas, e a cadeia `reservationSource` → `reserveSlot` que nenhum cenário do harness exercita.
- Desvios do `ChannelContext` da spec, deliberados: `customer` segue **obrigatório** (o `null` do contato IG sem telefone entra na Fase 1 com `link_customer_phone` e `need_phone`, que o consomem); `reservationSource` só aceita `"whatsapp"` até a migration que libera `instagram`; o contexto ganhou `unit`, `phone`, `appBaseUrl` (lido preguiçoso, `Deno.env` só no entrypoint) e `channelId`; leva a `conversation` carregada (o núcleo a atualiza em memória ao longo do turno) em vez de só `conversationId`, e ainda não tem `contact` (entra com o canal Instagram); `ingestionSource`, `finish`, append e marca de efeito externo ficam no `AgentTurnIO` da invocação. A regra 12 do prompt ainda diz "pelo WhatsApp": fica para a Fase 1 parametrizar.
- Gates: `npm run typecheck` zero erros (o teste novo pôs `tools.ts` no programa do tsc, o que pediu `result.success === false` e um tipo local de ferramenta para não puxar o SDK do `esm.sh`); ESLint dos arquivos tocados limpo; `npx deno@2.1.4 check supabase/functions/webhook-whatsapp/index.ts` ok; 14 suítes relacionadas 487/487.
- Suíte completa: 4028 passaram e 18 falharam, todas preexistentes: `OfficialConnectionCard` não carrega (sem `.env.local` no worktree), e as 18 são de `whatsapp-automation-receipts-request`, `whatsapp-template-catalog-v2` e `Automacao.datafy`, que falham igual (18/55) num worktree limpo de `origin/main` `7ed0976`, removido depois. `receipts-request` já falhava no baseline desta branch antes de qualquer mudança da Task 3.
- `node scripts/ef-import-graph.mjs`: `agent/turn.ts`, `agent/system-prompt.ts`, `agent/tools.ts` → 1 EF (`webhook-whatsapp`); `agent/channel-context.ts` → 0. Matriz de redeploy da Fase 0 inalterada: `webhook-whatsapp`, `update-reservation`, `create-reservation`, `create-manual-reservation`.
- Regras atualizadas: `agente-ia.md` (invariante do núcleo por canal, `paths:` com `_shared/agent/**`, ponteiros) e o fluxo em `whatsapp.md`.
- Pendente para a Task 4: `origin/main` avançou para `7ed0976` (PRs #47–#49; o #48 mexe em `reserveSlot`, sem tocar o webhook) — rebase antes do PR. Feito na Task 4.

### Task 4 (2026-10-20)
- **Rebase:** primeiro sobre `origin/main` `3ed43b5` (PRs #47–#51), depois sobre `44d8690` (#52–#53), os dois sem conflito.
  - No primeiro, só `availability.ts`, a fixture de automação e `reservas.md` se cruzavam, e o git os combinou sozinho.
  - O segundo só trouxe `Automacao.*`.
  - Os hashes citados nas Tasks 1–3 são de antes dos rebases; os commits se identificam pelo assunto.
- **Gates estáticos:** todos ok.
  - `npm run typecheck`: zero erros. `npm run lint`: 0 erros (17 warnings preexistentes). `npm run build`: ok.
  - `npx deno@2.1.4 check` nas 4 EFs da matriz: ok.
  - `check-padrao`: ok.
  - `check-portabilidade`: acusou 38 chamadas `.from`/`.rpc` em `_shared/agent/*` e `agent-reservation-tools.ts`. São as mesmas consultas que moravam no `index.ts` do webhook, que o check libera como adapter. Por decisão do responsável, a linha de base foi regravada (commit "grava na linha de base a dívida que saiu do webhook para _shared"), e a porta de dados do núcleo fica para a Fase 1. O CI não roda esse check hoje.
- **Gates `saas-shield-br`:**
  - `tenant-isolation-auditor`: FAIL, com 1 bloqueante anterior à branch.
  - `identity-access-auditor` (Sonnet, superfície estreita): PASS_WITH_WARNINGS.
  - `integration-reliability-auditor`: PASS_WITH_WARNINGS.
- **Corrigidos nesta task:**
  - `update-reservation`: `table_id`/`hall_id` do body presos à unidade da reserva. Era o bloqueante, apontado pelos dois primeiros auditores. O UPDATE ganhou escopo por unidade e status editável (cancelamento concorrente → 409). Reserva alheia e inexistente agora têm a mesma resposta 404.
  - `reserveSlot`, `create_reservation` e o catch do `onToolCall` não devolvem mais texto do Postgres ao portal, ao painel nem ao LLM.
  - `list_customer_reservations`: dia em BRT, e erro de leitura deixa de virar "sem reservas".
  - Catch externo do webhook: liquida e solta o lock antes de devolver o claim da mensagem.
  - `releaseAiLock` lê o `{ error }` da RPC.
- **Review da branch inteira:** "pronto com ajustes", sem blocker. A extração foi conferida com `diff -w` contra o webhook original: só aparecem as substituições previstas. Ajustes aplicados:
  - a ordem do catch externo passou a ser presa por comportamento (cenário novo em `agent-turn-parity`) e pela guarda das portas do `agentTurn`;
  - o contrato do catch do adapter foi escrito em `agente-ia.md`;
  - `paths:` de `reservas.md` e `whatsapp.md` corrigidos, e três regras ficaram mais precisas;
  - dois casos positivos novos no teste do `update-reservation`;
  - cabeçalho do `turn.ts` atualizado.
- **Controles positivos:** cada teste novo reprova contra o código anterior. Os arquivos foram restaurados por cópia e conferidos com `cmp`. O snapshot de paridade nunca foi regravado.
- **Instabilidade corrigida:** a paridade falhou com `request_did_not_finish` em 2 de 3 suítes completas, cada vez num cenário diferente.
  - Causa: o `run()` da fixture de chat gastava o orçamento de 300 em voltas de `setImmediate` enquanto esperava o webcrypto real do harness, e o thread pool fica saturado na suíte completa.
  - Correção: o orçamento agora conta só os avanços do relógio falso. Sem timer devido, a volta espera 1ms real, com teto de 20s.
- **Suíte completa:** 4118 passaram e 45 falharam, todas preexistentes: as mesmas suítes que falham num checkout limpo de `origin/main` (`whatsapp-template-surfaces`, `whatsapp-template-catalog-v2`, `whatsapp-waitlist-voucher-routing`, `whatsapp-automation-receipts-request`, `whatsapp-reservation-automation-routing`, `whatsapp-template-catalog-migration-twin`, `TemplateCatalogAdminCard`), mais `OfficialConnectionCard`, que só falha no worktree sem `.env.local`. Nenhum `request_did_not_finish` depois da correção da fixture.
- **Mudanças deliberadas de comportamento,** para as notas de deploy:
  1. `update-reservation`: 403 → 404 sem oráculo; mesa/salão de outra unidade → 400; cancelamento concorrente → 409; erro de leitura → 500 com texto fixo.
  2. `insert_failed` do `reserveSlot` com texto fixo.
  3. Erro de ferramenta da IA com texto fixo.
  4. `list_customer_reservations` em BRT e com erro explícito.
  5. Nova ordem do catch externo.
- **Matriz de redeploy:** inalterada, 4 EFs (`webhook-whatsapp`, `update-reservation`, `create-reservation`, `create-manual-reservation`). Sem migration. O deploy só acontece depois do merge, com autorização própria e em janela de baixo tráfego, e é conferido em `webhook_executions`.
- **Follow-ups fora desta fase:**
  - auto-resolve e lembrete de handoff enviam por `ctx.send` cru, sem compare-and-set (risco de duplicata em rajada);
  - o índice único pega só o horário exato, não a janela de duração (decisão de produto);
  - o `override` do `update-reservation` aceita operador (decisão de produto);
  - faltam validação de faixa de data e hora no painel e validação de formato no `update_reservation` da IA;
  - `system-prompt.ts` calcula o aniversário pelo dia UTC (bug anterior à branch);
  - logs novos de `tools.ts`/`availability.ts` sem `requestId`.
- **Itens da Fase 1:**
  - `create_reservation` resolve o cliente por telefone, separado do `customer.id`, e precisa de identidade única com o Instagram;
  - `organizationId` pode chegar `""`;
  - a regra 12 do prompt ainda diz "pelo WhatsApp";
  - a porta de dados do núcleo;
  - ferramentas de reserva desligadas enquanto `customer` for nulo.
