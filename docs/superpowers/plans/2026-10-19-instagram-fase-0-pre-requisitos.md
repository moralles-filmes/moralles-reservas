# Plano — Instagram Fase 0: pré-requisitos no agente

- **Spec:** [2026-10-19-instagram-modulo-design.md](../specs/2026-10-19-instagram-modulo-design.md). A abordagem foi aprovada em 2026-10-19; o aceite cobre implementação **local**. Deploy de `webhook-whatsapp` e push para `main` exigem autorização própria.
- **Branch:** `feat/instagram-module` (worktree `.claude/worktrees/instagram-module`), baseada em `origin/main` `f87d854`.
- **Dependência:** a branch `feat/agente-ia-cortes-fallback` (não mergeada em 2026-10-19) altera `webhook-whatsapp/index.ts`, `_shared/ai-providers.ts` e `useConversations.ts`. **A Task 3 só começa depois que ela entrar em `main`**, com rebase desta branch. As Tasks 1 e 2 tocam outra região do arquivo.
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

- [ ] Rebase sobre `main` e releitura das regras `agente-ia.md`, `whatsapp.md` e `reservas.md`.
- [ ] Extrair com o `ChannelContext` da spec:
  - montagem do prompt (`restaurantInfoLines`, blocos de horário, datas, giftback, regras);
  - `agentTools` e o despacho;
  - turno (debounce, lock, franquia, retry silencioso, handoff).

  O WhatsApp passa o contexto atual (`identityLine` com o telefone, `sanitizeForWhatsApp`, `sendAutomatic`, `reservationSource:"whatsapp"`).
- [ ] Teste de paridade:
  - snapshot do prompt gerado antes e depois para um fixture de unidade;
  - igualdade da lista de ferramentas;
  - controle positivo (alterar uma linha do prompt quebra o snapshot).
- [ ] `node scripts/ef-import-graph.mjs` para cada `_shared` novo ou alterado; registrar a matriz de redeploy.

## Task 4 — Gates e entrega local

- [ ] `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build` e `deno check supabase/functions/webhook-whatsapp/index.ts`.
- [ ] Gates `saas-shield-br`: `tenant-isolation-auditor` e `identity-access-auditor` sobre o diff; `integration-reliability-auditor` se a Task 3 tocar debounce ou lock.
- [ ] Review da branch inteira.
- [ ] `git status`, `git diff --cached` integral, varredura de segredos nas linhas staged e `git add` explícito.
- [ ] Commit, push e PR com autorização. O deploy de `webhook-whatsapp` acontece só com autorização própria, em janela de baixo tráfego, e é conferido em `webhook_executions`.

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
