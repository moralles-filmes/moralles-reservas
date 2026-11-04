# Planta do salão: endurecimento (pendências da B4 e achados de segurança)

Origem: PR #67 (main cc2c11c), seções "Pendências conhecidas" e "Achados fora do escopo"; `.tasks/planta-do-salao/STATE.md`.
Regras confirmadas pelo dono em 2026-11-04.

## 1. Chegada marcada por outro tablet

- `set_reservation_presence` passa a devolver `boolean`: `true` quando a ação gravou, `false` quando já estava feita (chegada já marcada, chegada já desfeita, mesa já liberada). O tipo de retorno muda, então a migration faz `drop` + `create` e refaz revoke/grant na mesma transação.
- Na tela (`useReservationPresence`), `false` mostra aviso neutro sem "Desfazer": "Chegada já registrada", "Chegada já desfeita" ou "Mesa já liberada". `true` mantém os toasts de hoje, e o "Desfazer" do toast só aparece quando a chegada foi gravada por esta ação.
- Os botões fixos "Desfazer chegada" (`AcoesMesa`, `ReservaCard`) continuam para todos os papéis (decisão do dono).
- Compatibilidade: o frontend vai para produção no merge, antes do `db push`. A RPC antiga devolve `null`, e `null` é tratado como `true` (comportamento atual).

## 2. Passante sentado por dois tablets

- `useUpdateWalkInStatus` (todas as chamadas partem de `waiting`: Sentar e Não apareceu) grava com `.eq("unit_id", unitId).eq("status", "waiting").select("id")` e confere o tamanho. Zero linhas mostra "Esse passante já foi atualizado em outro aparelho" e invalida `["walk-ins", unitId]`, também no erro.
- `useDeleteWalkIn` grava com `.eq("unit_id", unitId).select("id")`. Zero linhas usa a mesma mensagem e invalida.
- Vale em Passantes e no Salão ao vivo, que usam os mesmos hooks.

## 3. Escrita em mesas, salões e horários só para gestor

- `tables`, `halls` e `hall_schedules`: INSERT, UPDATE e DELETE só para owner, gerente ou platform_admin da unidade. A leitura continua para qualquer membro. O operador não tem tela de edição (`GestaoGuard`), nenhuma Edge Function grava nessas tabelas e o bloqueio de mesa fica em `table_blocks`, então nenhuma tela quebra.
- Mecanismo no molde de `guard_plan_write`: um trigger `BEFORE INSERT OR UPDATE OR DELETE`, `SECURITY DEFINER`, que decide o papel com `app_private.is_unit_manager` e o paralelo `app_private.is_platform_admin`. A recusa é `42501 layout_write_forbidden`, sem oráculo. O papel é conferido nas duas unidades, a antiga e a nova (UPDATE). `hall_schedules` não tem `unit_id` e resolve a unidade pelo salão, antes e depois.
- `service_role` passa, e a sessão sem claims de API (migration, cron) passa como no `guard_plan_write`.
- DELETE em cascata (salão → horários; salão → `tables.hall_id = null`) feito por gestor passa. O harness mede esse caso.
- As policies `unit_member_all_*` ficam como estão: o trigger aperta sem trocar a policy, igual ao `settings_write_role_guard`.
- Função nova: revoke de `public, anon, authenticated, service_role` e entrada na allowlist de ACL (`scripts/function-acl-allowlist.json`) na mesma mudança.
- Tela: 42501 vira "Só owner ou gerente podem alterar mesas e salões." nos hooks de mesa, salão e horário.

## 4. Salão de outra unidade na tela da unidade ativa

- Chaves: `["hall", unitId, hallId]`, `["hall-tables", unitId, hallId, …]`, `["hall-schedules", unitId, hallId]`. A invalidação segue as chaves novas.
- Toda consulta e toda escrita por id filtram `unit_id`: as de `hall_schedules` filtram pelo salão da unidade com `halls!inner(unit_id)`. UPDATE e DELETE de mesa, salão e horário levam o predicado de unidade e `.select()` com conferência do tamanho (AGENTS §8).
- `SalaoDetalhe` (e a rota `/planta`, se buscar por `hallId`) mostra "Salão não encontrado nesta unidade" quando o salão não é da unidade ativa. Não renderiza nenhuma ação.
- Banco: o trigger `guard_table_hall_unit` recusa `tables.hall_id` de salão de outra unidade (`42501 hall_unit_mismatch`, em `insert or update of hall_id, unit_id`). Também recusa mudar `halls.unit_id` quando o salão tem mesa ou horário. `waitlist.table_id` e `walk_ins.table_id` já têm `guard_same_unit_table`, sem mudança.
- Antes do `db push`: contar, por leitura, as mesas com `hall_id` de outra unidade em produção. Se houver alguma, o dono decide antes do push.

## 5. Cache no logout e na troca de usuário

- Hoje nada descarta o cache do TanStack. O `AuthContext` passa a chamar `queryClient.clear()` quando a sessão termina (`SIGNED_OUT`) ou quando o `user.id` muda. A troca de unidade não precisa limpar: as chaves já começam por `[entidade, unitId]` e o item 4 fecha as que não começavam. Fica registrado como decisão.

## Fora do escopo

Edição de mesa pelo operador; `arrived_by`; mudanças nas policies `unit_member_all_*`; outras tabelas com escrita sem papel.
