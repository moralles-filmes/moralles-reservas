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

- [ ] Mover `getReservation`, `updateReservation` e `cancelReservation` para o núcleo novo, recebendo o client como parâmetro e um escopo obrigatório `{ unitId, customerId }`.
  - Toda query leva `.eq("unit_id", unitId)` e `.eq("customer_id", customerId)`.
  - Leitura e escrita só sobre `status in ('confirmed','pending')`.
- [ ] `get_reservation` sem código busca a mais recente do `customerId` resolvido (cliente já canônico do turno). Assim some o lookup de `customers` por telefone sem organização.
- [ ] `update_reservation` e `cancel_reservation` usam `.select("reservation_code")` e conferem a linha. Zero linhas vira `{ success:false }` com mensagem PT-BR neutra, que não distingue "não existe" de "é de outra pessoa".
- [ ] Nenhum `error.message` do Postgres volta ao LLM: mensagem curta PT-BR e detalhe só no log.
- [ ] O despacho em `onToolCall` passa `{ unitId, customerId: customer.id }`. Assinaturas das ferramentas (nomes, parâmetros, descriptions) e a flag `mutatingToolUsed` continuam iguais.
- [ ] Testes com client falso que registra os filtros:
  - os três caminhos aplicam unidade, cliente e status;
  - código de outro cliente ou de outra unidade → não encontrado, sem escrita;
  - zero linhas → `success:false`;
  - erro de banco → mensagem genérica sem o texto do erro;
  - código vazio → mensagem existente.

## Task 2 — `update_reservation` revalida disponibilidade

Arquivos: `_shared/agent-reservation-tools.ts`, `webhook-whatsapp/index.ts` e testes.

- [ ] Antes de alterar data, hora ou pessoas, rodar `checkAvailability` do `_shared/availability.ts` para o novo par (desconsiderando a própria reserva) e só gravar com mesa compatível, atualizando `table_id`.
  - Sem vaga → `{ success:false, available:false }` com sugestão de usar `check_availability`.
- [ ] Decidir na própria task, com teste, como desconsiderar a reserva atual na checagem. Se `availability.ts` não suportar exclusão por id, a task para e volta ao responsável antes de alterar o núcleo de disponibilidade, porque ele é compartilhado com `create-reservation`.

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

(preencher por task)
