# Planta do salão: endurecimento — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** fechar as pendências da B4 e os achados fora do escopo do PR #67: presença que informa se mudou algo, passante sem corrida entre tablets, escrita de layout só para gestor, salão preso à unidade e cache limpo no logout.

**Architecture:** uma migration aditiva com dois triggers DEFINER (papel e unidade do salão) e a RPC de presença devolvendo `boolean`; nos hooks de tela, predicados de tenant e status com `.select()` conferido, chaves `[entidade, unitId, …]` e mensagens novas. O front vai para produção antes do `db push` e funciona com o banco antigo.

**Tech Stack:** Postgres/Supabase (plpgsql, RLS), React + TanStack Query, Vitest, harness local Docker (`supabase/tests/local-preflight`).

**Spec:** docs/superpowers/specs/2026-11-04-planta-endurecimento-design.md

## Global Constraints

- Migration `supabase/migrations/20261104120000_planta_endurecimento.sql`, aplicada só por `supabase db push`, depois do merge e com autorização do dono.
- Sem dependência nova. Escrita de teste em produção só na MORALLES (`moralles-centro`).
- Função nova revoga `EXECUTE` de `public, anon, authenticated, service_role` (triggers) e fica sem grant.
- Recusa de papel: `42501 layout_write_forbidden`. Recusa de unidade do salão: `42501 hall_unit_mismatch`. Sem oráculo de existência.
- Mensagens (copiar literal): "Chegada já registrada.", "Chegada já desfeita.", "Mesa já liberada.", "Esse passante já foi atualizado em outro aparelho.", "Só owner ou gerente podem alterar mesas e salões.", "Salão não encontrado nesta unidade."
- `authenticated` não tem USAGE em `app_private` em produção: RPC INVOKER não chama helper de lá; só trigger DEFINER.
- Typecheck é `npm run typecheck`; baseline zero erros.

## Review Focus

1. Gestor apaga salão com horários e mesas: a cascata (DELETE em `hall_schedules`, `tables.hall_id = null`) dispara os triggers novos com o salão já apagado e não pode ser recusada → caso H-9 da Task 1.
2. Front novo com banco antigo: `set_reservation_presence` devolve `null` → tratar como mudou (toasts de hoje) → teste `null → comportamento atual` na Task 2.
3. Membro de A e B move mesa de A para salão de B, ou horário de S1 para SB: o papel é conferido nas duas unidades e o salão tem que ser da mesma unidade → casos H-5/H-11 da Task 1.
4. `save_hall_plan` por gerente continua funcionando com o trigger de papel novo, inclusive o UPDATE nulo do modo estrito → caso H-10 da Task 1 (e o harness 81 inteiro reaplicado verde).
5. Abrir `/g/A/reservas/saloes/<salão de B>` como membro das duas: nenhuma query devolve B e nenhuma ação é renderizada → teste da Task 3.

---

### Task 0: Branch de trabalho

- [ ] `git switch -c feat/planta-endurecimento chore/planta-fechamento` e `git cherry-pick c98a9c6`. Conferir em `vercel.json` só a regra `main: true` / `**: false`.
- [ ] Commitar spec e plano: `git add docs/superpowers/specs/2026-11-04-planta-endurecimento-design.md docs/superpowers/plans/2026-11-04-planta-endurecimento.md`.

### Task 1: Migration + harness 82 (crítica, agente principal)

**Files:**
- Create: `supabase/migrations/20261104120000_planta_endurecimento.sql`
- Create: `supabase/tests/local-preflight/82a-planta-endurecimento-bootstrap.sql` (adiciona `hall_schedules` na forma de produção, com policies e grants reais — conferir por leitura no banco vivo — e os horários H1 em S1, HB em SB)
- Create: `supabase/tests/local-preflight/82-planta-endurecimento.sql` (mesmo motor de casos do 81: subbloco desfeito, sentinela `P8282`, tabela de resultados, `DO` que aborta)
- Modify: `supabase/tests/local-preflight/README.md` (§82), `scripts/function-acl-allowlist.json` (texto do `why` de `set_reservation_presence`: devolve boolean; casos do 82)

**Interfaces:**
- Produces: `public.set_reservation_presence(p_reservation_id uuid, p_action text) returns boolean` (true = gravou; false = já estava feito). Erros iguais aos de hoje.
- Produces: `app_private.guard_layout_write()` em `tables`, `halls` e `hall_schedules` (`before insert or update or delete`, `for each row`), triggers `tables_write_role_guard`, `halls_write_role_guard`, `hall_schedules_write_role_guard` (o nome faz o trigger disparar depois do `*_plan_write_guard`, então escrita de planta pelo operador segue `plan_write_forbidden`). Triggers de unidade: `tables_write_unit_hall_guard` e `halls_write_unit_change_guard`.
- Produces: `app_private.guard_table_hall_unit()`: em `tables` `before insert or update of hall_id, unit_id`, recusa `hall_id` cujo salão tem outro `unit_id`; em `halls` `before update of unit_id`, recusa quando há mesa ou horário no salão.

Regra do `guard_layout_write` (mesma decisão de sessão do `guard_plan_write`): `auth.role()` nulo com `role` GUC fora de anon/authenticated passa; `service_role` passa; não-authenticated ou `auth.uid()` nulo → 42501; `is_platform_admin` passa; senão exige `is_unit_manager` na unidade de `old` (UPDATE/DELETE) e de `new` (INSERT/UPDATE). Em `hall_schedules`, a unidade vem do salão (`old.hall_id`, `new.hall_id`). Salão de `old` não encontrado em DELETE de `hall_schedules` = cascata do salão já apagado → passa (a direta é barrada pela RLS, que exige o salão). DELETE devolve `old`.

- [ ] **Step 1: Escrever 82a e 82** com os casos:
  - H-1..H-3: operador → `42501 layout_write_forbidden` em INSERT, UPDATE (`capacity`, `active`, `hall_id`) e DELETE de `tables`; INSERT/UPDATE/DELETE de `halls`; INSERT/UPDATE/DELETE de `hall_schedules`. Efeito conferido: nada mudou.
  - H-4: owner, gerente e platform_admin fazem as mesmas escritas → `ok`; `service_role` → `ok`.
  - H-5: GERB (gerente só em B) muda mesa de A → zero linhas pela RLS; gerente de A movendo mesa para `unit_id` B → recusado (RLS ou 42501, esperado `42501%`).
  - H-6: operador lê `tables`, `halls`, `hall_schedules` da própria unidade → contagem igual à do postgres (leitura intacta).
  - H-7: mesa de A com `hall_id` = SB (por platform_admin, que passa na RLS) → `42501 hall_unit_mismatch`; mesmo salão da unidade → `ok`.
  - H-8: mudar `halls.unit_id` de S1 (com mesas) → `42501 hall_unit_mismatch`.
  - H-9: gerente apaga S1 (com horário H1 e mesas) → `ok`; H1 sumiu e mesas com `hall_id` nulo.
  - H-10: gerente chama `save_hall_plan` em S1 → `ok`; operador → `42501 hall_plan_forbidden` (como antes).
  - H-11: gerente de A move o horário H1 de S1 para SB → `42501 layout_write_forbidden` (não é gestor de B). Se a RLS barrar antes, vale o mesmo `42501%`.
  - H-12: `set_reservation_presence` → `true` na primeira `arrive`, `false` na repetição; `undo_arrive` já desfeita → `false`; `release` repetido → `false`; `anon` sem EXECUTE.
  - H-CP (controle positivo): `alter table … disable trigger tables_layout_write_guard` dentro do caso faz H-1 passar a `ok` — prova que é o trigger quem recusa.
- [ ] **Step 2: RED.** Contêiner `planta82-pg` (`--network none`, imagem `public.ecr.aws/supabase/postgres:17.11.0.004`); rodar 81a, as duas migrations de 20261030, 82a e o 82. Esperado: H-1..H-3, H-7, H-8, H-11 e H-12 divergem.
- [ ] **Step 3: Escrever a migration** (`begin`/`set local lock_timeout = '5s'`/`commit`; `drop function` + `create` da RPC com revoke/grant; comentários em PT-BR como nas de 20261030).
- [ ] **Step 4: GREEN.** Aplicar a migration e rodar o 82 → todos `ok`. Rodar também o 81 → 83/83 (exceto onde o 81 espera o operador mudando `max_capacity`/criando mesa: atualizar esses casos do 81 para `42501 layout_write_forbidden`, e registrar no README).
- [ ] **Step 5: Reaplicar** a migration e rodar 81 e 82 de novo → verdes. `docker rm -f planta82-pg`.
- [ ] **Step 6: Vitest de ACL** `npx vitest run scripts/function-acl-allowlist.test.ts scripts/migration-static-guard.test.ts` → verde.
- [ ] **Step 7: Gates** `saas-shield-br:migration-validator` e `saas-shield-br:rls-auditor` na migration, sem bloqueante.
- [ ] **Step 8: Commit** dos arquivos da task (caminhos explícitos).

### Task 2: Presença, passantes e cache (comum; ai-router-br)

**Files:**
- Modify: `src/features/planta/api.ts` (`setReservationPresence(...): Promise<boolean>`; `data === false` → `false`, qualquer outro valor → `true`)
- Modify: `src/hooks/useMesaAcoes.ts` (`useMutation<boolean, …>`; `onSuccess(changed)`: `false` → `toast.info` com "Chegada já registrada." / "Chegada já desfeita." / "Mesa já liberada." conforme a ação, sem `action`; `true` → toasts atuais)
- Modify: `src/hooks/useWalkIns.ts` (`useUpdateWalkInStatus`: `.eq("id", id).eq("unit_id", unitId).eq("status", "waiting").select("id")`; `useDeleteWalkIn`: `.eq("id", id).eq("unit_id", unitId).select("id")`; zero linhas → `throw new StaleWalkInError()` com a mensagem fixa; invalidar `["walk-ins", unitId]` em `onSettled`; `onError` mostra a mensagem do `StaleWalkInError` ou a atual)
- Modify: `src/contexts/AuthContext.tsx` (`useQueryClient()`; `queryClient.clear()` no evento `SIGNED_OUT` e quando o `user?.id` muda de um id para outro)
- Test: testes vizinhos existentes desses hooks (procurar `*.test.ts(x)` com o nome do hook) ou novos ao lado

- [ ] **Step 1: Testes que falham:** `setReservationPresence` devolve `false` para `data: false`, `true` para `true` e para `null`; `useReservationPresence` com `false` em `arrive` chama `toast.info("Chegada já registrada.")` sem `action`; com `true` mantém o toast com "Desfazer"; `useUpdateWalkInStatus` manda os filtros `unit_id`/`status` e, com `data: []`, mostra "Esse passante já foi atualizado em outro aparelho." e invalida `["walk-ins", unitId]`; o mesmo para `useDeleteWalkIn`; `AuthContext` chama `clear()` no `SIGNED_OUT`.
- [ ] **Step 2: Rodar** `npx vitest run <arquivos>` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar** os testes → PASS; `npm run typecheck` → 0.
- [ ] **Step 5: Review** da task (revisor independente) e commit com caminhos explícitos.

### Task 3: Salões, mesas e horários presos à unidade (crítica, agente principal)

**Files:**
- Modify: `src/hooks/useHalls.ts` (`useHall(unitId, hallId)`, chave `["hall", unitId, hallId]`, `.eq("unit_id", unitId)`, `.maybeSingle()`; update/delete com `.eq("unit_id", unitId).select("id")` e conferência)
- Modify: `src/hooks/useHallTables.ts` (`useHallTables(unitId, hallId, opts)`, chave `["hall-tables", unitId, hallId, …]`, filtro `unit_id`; `useUpdateTable`/`useDeleteTable` com `.eq("unit_id", …).select("id")`; invalidações nas chaves novas)
- Modify: `src/hooks/useHallSchedules.ts` (`useHallSchedules(unitId, hallId)`, chave `["hall-schedules", unitId, hallId]`, select com `halls!inner(unit_id)` e `.eq("halls.unit_id", unitId)`; update/delete conferidos)
- Modify: `src/pages/gestao/reservas/SalaoDetalhe.tsx`, `Saloes.tsx`, a página da rota `/planta` e qualquer outro consumidor (achar com `grep -rn "useHall(\|useHallTables(\|useHallSchedules(" src`)
- Create: `src/lib/layout-errors.ts` com `layoutErrorMessage(err: unknown, fallback: string): string` (42501 → "Só owner ou gerente podem alterar mesas e salões."), usado nos `onError` dos três hooks
- Test: testes dos hooks e de `SalaoDetalhe`

- [ ] **Step 1: Testes que falham:** chaves começam por `[entidade, unitId]`; queries recebem `.eq("unit_id", unitId)`; UPDATE/DELETE com zero linhas lançam erro; `SalaoDetalhe` com `useHall` devolvendo `null` mostra "Salão não encontrado nesta unidade." e nenhum botão de ação; `layoutErrorMessage({code:"42501"})` devolve a mensagem de papel.
- [ ] **Step 2: Rodar** → FAIL.
- [ ] **Step 3: Implementar** e atualizar todos os consumidores.
- [ ] **Step 4: Rodar** os testes afetados → PASS; `npm run typecheck` → 0; `npm run lint` → 0 erros.
- [ ] **Step 5: Gate** `saas-shield-br:tenant-isolation-auditor` sobre a diff da task, sem bloqueante. Commit.

### Task 4: Fechamento e PR único (crítica, agente principal)

- [ ] Regras duráveis: `.claude/rules/banco-de-dados.md` (escrita de layout só gestor por trigger; `tables.hall_id` preso à unidade) e `.claude/rules/reservas.md` (`set_reservation_presence` devolve se mudou; passante muda só a partir de `waiting` com `.select()` conferido).
- [ ] Gates: `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`, `node scripts/check-padrao.mjs`, `node scripts/check-portabilidade.mjs`; varredura de segredos no staged (AGENTS §5).
- [ ] Auditores: `migration-validator`, `rls-auditor`, `tenant-isolation-auditor`, `identity-access-auditor` sobre a branch inteira, sem bloqueante; review da branch inteira.
- [ ] Push da branch e um PR para a `main` (com autorização), descrevendo a ordem: merge → Vercel → leitura da contagem de mesas com salão de outra unidade → `supabase db push --dry-run` (só a 20261104120000) → `db push` com autorização → conferência por leitura (triggers, ACL, retorno boolean) → teste manual na MORALLES.
