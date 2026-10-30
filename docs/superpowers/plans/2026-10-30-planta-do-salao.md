# Planta do salão (Parte B do redesign) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dono e gerente desenham a planta de cada salão na Gestão, e a equipe vê no Operacional as mesas em 3D, acesas pela situação, com as ações essenciais por mesa.

**Architecture:**
- **Banco.** Ganha colunas de layout em `tables`/`halls` e carimbos de presença (`arrived_at`/`released_at` na reserva; `released_at` e `table_id` na fila; `released_at` no passante).
  - Triggers impõem papel, unidade, consistência e relógio do servidor.
  - RPCs `SECURITY INVOKER` sobre a RLS existente fazem as escritas.
  - Nenhuma ação muda `status` nem cria linha extra, para as métricas ficarem intactas.
- **Tela.**
  - A situação de cada mesa sai de uma função pura sobre reservas, passantes, fila e bloqueios do dia, em BRT.
  - O editor é 2D, com eventos de ponteiro nativos.
  - A planta ao vivo usa CSS 3D sobre `<button>` reais, com queda para 2D.

**Tech Stack:** Supabase (Postgres 17, RLS, plpgsql), Vite, React 18, TypeScript, Tailwind 3.4, shadcn/Radix, TanStack Query 5, Vitest + Testing Library (jsdom), harness `supabase/tests/local-preflight/`.

**Spec:** [docs/superpowers/specs/2026-10-29-redesign-salao-em-vidro-design.md](../specs/2026-10-29-redesign-salao-em-vidro-design.md) §5, decisões 4 e 5 da §3. Mockup: [Salao.dc.html](../specs/2026-10-29-redesign-salao-em-vidro/Salao.dc.html). Onde a spec silencia, vale o mockup; onde divergem, vale a spec. Corte aprovado e regras do dono: `.tasks/planta-do-salao/PLAN.md` (fora do Git; resumo abaixo).

**Regras do dono (2026-10-30):**
- O cliente da fila sentado numa mesa grava a mesa na própria entrada da fila e **não pode duplicar no fluxo de clientes nem inflar métrica de jeito nenhum**.
- "Desfazer chegada" entra.
- A reserva sem mesa aceita "Chegou", mas não é posta numa mesa na v1.
- A unidade de teste é a **MORALLES** (`moralles-centro`).
- Fora da v1: trocar mesa, bloquear mesa, mensagem avulsa e liberação automática.

## Global Constraints

- **Nenhuma ação da planta muda `status` nem cria linha em outra tabela de fluxo.**
  - Chegada e liberação são carimbos à parte.
  - Liberar um passante **nunca** usa `status = 'left'`: o `useFluxoClientes` conta como sentado só `status = 'seated'` (`src/hooks/useFluxoClientes.ts:412`).
- Nenhuma dependência nova (nem de arrastar, 3D ou animação). Pacote novo exige decisão do dono.
- Função nova revoga `EXECUTE` de `public, anon, authenticated` (e `service_role` em função de trigger), concede só o necessário e entra em `scripts/function-acl-allowlist.json` com `why`.
- Recusa de acesso é `42501` com a mesma mensagem para recurso alheio e inexistente (sem oráculo). Guard resolve a unidade pelo próprio recurso.
- Todo guard por unidade tem o paralelo `app_private.is_platform_admin`.
- Migration idempotente (`if not exists`, `drop ... if exists` antes de `create`), timestamp maior que `20261029200900` e aplicada só por `supabase db push`.
- Toda query de tela filtra `unit_id`, e a chave começa por `[entidade, unitId, …]`. Dados ao vivo usam `refetchInterval: () => (document.hidden ? false : 30_000)`.
- Tempo: "hoje" e "agora" em `America/Sao_Paulo`; `time` do banco passa por `.slice(0, 5)`.
- Cor só por token. As situações usam `--status-free|reserved|arriving|seated|late|pending` e sempre levam texto além da cor.
- `backdrop-filter` só na superfície única da página (`glass-usage-guard.test.ts`). Mesa, cartão repetido e linha de lista não desfocam.
- Movimento:
  - entrada de 0,9 a 1,6 s com `cubic-bezier(0.16, 1, 0.3, 1)`;
  - resposta ao toque de 200 a 350 ms, só `transform` e `opacity`;
  - tudo sob `motion-safe:`;
  - halo pulsante só em Chegando e Atrasada.
- 3D só na planta ao vivo; o editor é 2D.
- Alvo de toque de pelo menos 44 px em ponteiro grosso (`coarse:`). Texto em PT-BR, caixa normal.
- Escrita manual de teste só na MORALLES. "Chamar da fila" só com uma entrada de fila no telefone do dono.
- Fim de cada fase:
  - `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`, `node scripts/check-padrao.mjs` e `node scripts/check-portabilidade.mjs` verdes;
  - em fase com SQL, também `npx vitest run scripts/function-acl-allowlist.test.ts scripts/migration-static-guard.test.ts`.
- Git: `git add <caminho>` explícito. PR, merge, push e `supabase db push` só com autorização do dono.

## Review Focus

1. **Mesa ocupada depois da meia-noite.** Uma reserva das 23:30 de ontem, com chegada e sem liberação, continua Ocupada às 00:20. A consulta inclui ontem; o teste fica na Task 7 (`ocupada atravessa a meia-noite`).
2. **Dois tablets tocam "Chegou" ou "Liberar" juntos.** A segunda chamada não dá erro e não muda o horário gravado. Teste P-2/P-4 no harness (Task 2).
3. **Operador ou outra unidade chamando a API direto.** `save_hall_plan`, UPDATE de `plan_*` e mesa de outro salão ou unidade no payload recebem `42501`, sem gravar nada. Testes L-3, L-10 a L-12 (Task 1).
4. **Salão sem dimensões ou mesa sem posição.** A planta abre com o tamanho padrão e as mesas numa grade automática, sem sobrepor nem sair do salão, tanto no editor quanto ao vivo. Teste `grade automática` (Task 4).
5. **Métrica inflada ou distorcida.** Depois de chegar, liberar, sentar da fila e liberar passante, as contagens por status de `reservations`, `waitlist` e `walk_ins` são idênticas, e `walk_ins` não ganha linha. Teste P-12 (Task 2).

---

## Como executar (um chat por fase)

Cinco fases. A B1 vai para a `main` sozinha (passo "expand"): as migrations precisam estar no repositório da `main` antes do `db push`. Senão, qualquer `db push` de outra frente falha com "versão remota sem arquivo local".

| Fase | Branch | Base e destino | Tasks |
|---|---|---|---|
| B1 Banco | `feat/planta-b1-banco` | `main` → PR para `main` | 1–3 |
| B2 Editor | `feat/planta-b2-editor` | `feat/planta-do-salao` | 4–6 |
| B3 Salão ao vivo: visão | `feat/planta-b3-ao-vivo` | `feat/planta-do-salao` | 7–10 |
| B4 Ações | `feat/planta-b4-acoes` | `feat/planta-do-salao` | 11–14 |
| B5 Listas, QA e lançamento | `feat/planta-b5-lancamento` | `feat/planta-do-salao` → PR para `main` | 15–17 |

**Abertura do chat da fase**
1. `/padrao-saas:mudanca planta-do-salao`. A Etapa 0 lê `.tasks/planta-do-salao/STATE.md` e confere `git status` e `git diff`.
2. Criar a branch da fase a partir da base da tabela. A integração `feat/planta-do-salao` nasce da `main` logo depois do merge da B1.
3. Executar as tasks com `superpowers:subagent-driven-development`:
   - review por task (AGENTS §4);
   - executor escolhido por `ai-router-br:route`. **A B1 é crítica e fica com o agente principal.** Nas demais fases, se o router não decidir: `saas-builder-br:frontend-react` para tela, `design-ux` para visual e a11y, `qa-testes` para testes;
   - modelo `sonnet` para implementador e revisor de task; o mais capaz só na revisão da branch.

**Fechamento da fase**
1. Gates da seção Global Constraints verdes.
2. Revisão visual com `npm run dev` (B2–B5): rotas da fase em 1440×900, 1194×834 e 390×844, nos dois temas, na MORALLES. Anotar no STATE.
3. Revisão da branch com `superpowers:requesting-code-review`.
4. Merge `--no-ff` na base da tabela. A B1 e a B5 vão por PR, com autorização.
5. Marcar os checkboxes deste plano e commitar o plano.
6. Atualizar o STATE e a memória do projeto.
7. Push da integração com autorização: preview da Vercel, que usa o Supabase de produção. Testar escrita só na MORALLES.
8. Sugerir chat novo.

## Mapa de arquivos

| Arquivo | Responsabilidade | Task |
|---|---|---|
| `supabase/migrations/<ts1>_planta_do_salao_layout.sql` | Colunas `plan_*`, CHECKs, helper `app_private.is_unit_manager`, trigger de papel, RPC `save_hall_plan` | 1 |
| `supabase/migrations/<ts2>_planta_do_salao_presenca.sql` | Carimbos de presença, triggers de presença e de mesa da mesma unidade, policy de super-admin em `walk_ins`, RPCs de presença | 2 |
| `supabase/tests/local-preflight/81a-planta-do-salao-bootstrap.sql`, `81-planta-do-salao.sql`, README §81 | Projeção das tabelas e casos L-*, P-* | 1–3 |
| `scripts/function-acl-allowlist.json` | 5 entradas novas | 1–2 |
| `src/types/reserva.ts` | Campos novos em `Mesa`, `Hall`, `Reserva`, `WaitlistEntry`, `WalkIn` | 3 |
| `src/lib/hall-plan-core.ts` (+ teste) | Geometria pura: padrão do salão, tamanho por capacidade, grade automática, encaixe, limites, payload de salvar | 4 |
| `src/hooks/useHallPlan.ts` (+ teste) | Leitura da planta e mutation `save_hall_plan` | 5 |
| `src/pages/gestao/reservas/SalaoPlanta.tsx`, `src/components/planta/editor/*` | Editor 2D | 6 |
| `src/lib/table-situation-core.ts` (+ teste) | `brtNow`, `deriveTableStates`, `reservationLiveSituation` | 7, 15 |
| `src/hooks/useNow.ts`, `src/hooks/useSalaoAoVivo.ts` (+ teste) | Relógio de tela e dados ao vivo da unidade | 8 |
| `src/pages/operacional/SalaoAoVivo.tsx`, `src/components/planta/ao-vivo/*`, `src/components/planta/situation-labels.ts` | Cena 3D/2D, legenda, painel, próximas chegadas, fila | 9, 12 |
| `src/hooks/useMesaAcoes.ts` (+ teste), `src/lib/waitlist-message.ts` | Mutations das RPCs; mensagem da fila extraída de `Fila.tsx` | 11 |
| `src/components/reserva/ReservaCard.tsx`, `src/pages/operacional/Passantes.tsx`, `src/hooks/useWalkIns.ts` | Botões de presença; passante liberado sai de "Na mesa" | 13 |
| `src/lib/conversation-link.ts`, `src/pages/gestao/Conversas.tsx` | Link direto `?cliente=` (helper na 11, leitura na 14) | 11, 14 |
| `src/components/ui/status-pill.tsx` | Pílula de situação única | 15 |
| `.claude/rules/reservas.md`, `frontend.md`, `banco-de-dados.md` | Invariantes novos | 16 |

---

# B1 — Banco

### Task 1: Layout da planta (colunas, trigger de papel, `save_hall_plan`)

**Files:**
- Create: `supabase/migrations/<ts1>_planta_do_salao_layout.sql`
- Create: `supabase/tests/local-preflight/81a-planta-do-salao-bootstrap.sql`, `supabase/tests/local-preflight/81-planta-do-salao.sql`
- Modify: `scripts/function-acl-allowlist.json`

**Interfaces:**
- Produces:
  - **Colunas de `public.tables`** (todas `integer`, salvo indicado; nulas):
    - `plan_x`, `plan_y`: centro da mesa em cm;
    - `plan_w`, `plan_h`;
    - `plan_rotation smallint`;
    - `plan_shape text`.
  - **CHECKs de `tables`:**
    - `tables_plan_all_or_none`: as seis colunas nulas ou as seis preenchidas;
    - `tables_plan_values`: `plan_x`/`plan_y` entre 0 e 5000, `plan_w`/`plan_h` entre 30 e 600, `plan_rotation` entre 0 e 359, `plan_shape in ('round','square','rect')` e `plan_shape = 'rect' or plan_w = plan_h`.
  - **Colunas de `public.halls`:** `plan_width_cm int`, `plan_depth_cm int`, `plan_entrance_wall text`, `plan_entrance_offset_cm int` (nulas) e `plan_window_walls text[] not null default '{}'`.
  - **CHECKs de `halls`:**
    - `halls_plan_dims`: as duas medidas nulas ou ambas entre 200 e 5000;
    - `halls_plan_entrance`: parede e deslocamento nulos juntos; parede em `top|right|bottom|left`; deslocamento ≥ 0;
    - `halls_plan_windows`: `plan_window_walls <@ array['top','right','bottom','left']`.
  - **`app_private.is_unit_manager(p_user_id uuid, p_unit_id uuid) returns boolean`:** `stable`, `security definer`, `search_path = ''`. Verdadeiro se a pessoa é membro com `role in ('owner','gerente')`. **Não** inclui super-admin; quem chama faz o `or app_private.is_platform_admin(...)`. `EXECUTE` só para `authenticated`.
  - **Trigger `app_private.guard_plan_write()`:** `tables_plan_write_guard` e `halls_plan_write_guard`, `BEFORE INSERT OR UPDATE`, por linha.
    - Recusa `raise 'plan_write_forbidden' using errcode = '42501'` quando alguma coluna `plan_*` da tabela muda (INSERT com alguma não nula; UPDATE com a tupla `plan_*` distinta) e quem grava não é `is_unit_manager` de `new.unit_id` (e de `old.unit_id` no UPDATE) nem `is_platform_admin`.
    - Ramo `auth.role()` nulo, `service_role` e role GUC igual ao molde `app_private.guard_unit_setting_write()` em `supabase/migrations/20261019180000_settings_write_role_guard.sql:27-76`.
    - Escrita sem coluna `plan_*` passa sempre: o fluxo atual do operador fica preservado.
  - **`public.save_hall_plan(p_hall_id uuid, p_expected_updated_at timestamptz, p_hall jsonb, p_tables jsonb) returns timestamptz`:** `security invoker`, `search_path = ''`. Devolve o `updated_at` novo do salão.
    1. `select unit_id, updated_at ... from public.halls where id = p_hall_id for update`. Sem linha visível: `raise 'hall_plan_forbidden' using errcode = '42501'`.
    2. Se a pessoa não é `is_unit_manager` nem `is_platform_admin`: a mesma recusa.
    3. Se `p_expected_updated_at is distinct from updated_at`: `raise 'hall_plan_stale' using errcode = '40001'`.
    4. `p_hall` precisa ser objeto com as chaves `width_cm, depth_cm, entrance_wall, entrance_offset_cm, window_walls` (`jsonb_typeof`). `p_tables` precisa ser array com até 500 itens `{id, x, y, w, h, rotation, shape}`; todos os campos nulos tiram a mesa da planta. Fora disso: `raise 'hall_plan_invalid' using errcode = '22023'`.
    5. Os ids são distintos, e todos pertencem a `tables.hall_id = p_hall_id`. Senão: `hall_plan_forbidden` `42501`, antes de qualquer UPDATE.
    6. UPDATE do salão (sempre, para mudar a revisão) e das mesas via `jsonb_to_recordset`. Contar as linhas afetadas; divergência dá `42501`.
  - **ACL:** `revoke all ... from public, anon, authenticated` e `grant execute ... to authenticated`. Entrada na allowlist com `"security_definer": false`.

- [ ] **Step 1: Escrever `81a` e os casos L-* do `81`, falhando sem a migration**

  `81a` projeta `units`, `unit_members`, `platform_admins`, `halls`, `tables` (FKs, `UNIQUE(unit_id, number)` e trigger `halls_updated_at`), os helpers `app_private.is_unit_member`/`is_platform_admin` e as policies atuais `unit_member_all_tables|halls` e `platform_admin_all_tables|halls`, como estão em `013`/`030`. Molde: `70a-force-rls-bootstrap.sql` e `75a-settings-write-acl-bootstrap.sql`.

  Cenário:
  - duas unidades, A e B;
  - em A: owner, gerente e operador;
  - um outsider;
  - um platform_admin sem membership;
  - em A: dois salões (S1, S2), com mesas em ambos;
  - em B: um salão.

  Cada caso grava em `t_res(ord, caso, veredito)`, no estilo de `75-settings-write-acl.sql`, alternando `set local role` e `set local request.jwt.claims`:
  - L-1/L-2: owner e gerente atualizam `plan_*` de mesa de A → `ok`.
  - L-3: operador atualiza `plan_x` direto → `42501 plan_write_forbidden`.
  - L-4: operador atualiza `max_capacity` sem tocar `plan_*` → `ok`.
  - L-5: operador INSERT de mesa sem `plan_*` → `ok`; com `plan_*` → `42501`.
  - L-6: platform_admin sem membership → `ok`.
  - L-7: `service_role` → `ok`.
  - L-8: owner de A faz UPDATE de mesa de B → 0 linhas.
  - L-9: owner chama `save_hall_plan` em S1 → devolve `updated_at` maior; as mesas ficam com os valores enviados; uma mesa com tudo nulo sai da planta.
  - L-10: operador chama `save_hall_plan` → `42501`.
  - L-11: salão de B e salão inexistente → `42501` com a mesma `sqlerrm`.
  - L-12: payload com mesa de S2, mesa de B, id inexistente e id repetido → `42501`, e nenhuma mesa de S1 muda (conferir antes e depois).
  - L-13: `p_expected_updated_at` velho → `40001`, nada muda.
  - L-14: mesa parcial (só `x`) → `23514`; `round` com `w ≠ h` → `23514`.
  - L-15: `plan_window_walls = '{norte}'` → `23514`.
  - L-16: `anon` executa `save_hall_plan` → `42501` (permission denied).
  - L-CP: controle positivo. Dentro da transação, `alter table public.tables disable trigger tables_plan_write_guard`; L-3 passa a gravar e o caso registra `controle_ok`; depois `rollback to savepoint`.

- [ ] **Step 2: Rodar contra o contêiner sem a migration e ver os L-* de layout falharem**

  Contêiner exclusivo `public.ecr.aws/supabase/postgres:17.11.0.004` com `--network none`, como no README §70. Aplicar `81a`, depois `81`.
  Expected: `select caso, veredito from t_res order by ord` mostra L-1…L-16 diferentes do esperado (colunas e função ausentes).

- [ ] **Step 3: Escrever a migration `<ts1>_planta_do_salao_layout.sql` conforme Interfaces**

  Arquivo com `begin;` … `commit;` próprios. Na mesma migration:
  - `revoke all on function app_private.guard_plan_write() from public, anon, authenticated, service_role`;
  - os revoke/grant de `is_unit_manager` e `save_hall_plan` com a assinatura completa;
  - `comment on function` em PT-BR dizendo a regra.

- [ ] **Step 4: Aplicar `81a`, a migration crua 3 vezes e o `81` depois de cada aplicação**

  Expected: os vereditos de L-1…L-16 batem com o esperado, `L-CP = controle_ok` e as três passagens são idênticas (idempotência).

- [ ] **Step 5: Entrada da allowlist e testes estáticos**

  Acrescentar `save_hall_plan` com `"args": "p_hall_id uuid, p_expected_updated_at timestamptz, p_hall jsonb, p_tables jsonb"`, `"roles": ["authenticated"]` e o `why`: "Owner/gerente/admin salva a planta do salão da própria unidade; INVOKER sobre RLS; ids validados contra o salão."
  Run: `npx vitest run scripts/function-acl-allowlist.test.ts scripts/migration-static-guard.test.ts`
  Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/<ts1>_planta_do_salao_layout.sql supabase/tests/local-preflight/81a-planta-do-salao-bootstrap.sql supabase/tests/local-preflight/81-planta-do-salao.sql scripts/function-acl-allowlist.json
git commit -m "feat(planta): layout de mesas e salões com guarda de papel e save_hall_plan"
```

### Task 2: Presença (chegada, liberação, fila e passante na mesa)

**Files:**
- Create: `supabase/migrations/<ts2>_planta_do_salao_presenca.sql` (`ts2 > ts1`)
- Modify: `supabase/tests/local-preflight/81a-planta-do-salao-bootstrap.sql`, `81-planta-do-salao.sql`, `scripts/function-acl-allowlist.json`

**Interfaces:**
- Consumes: `81a` da Task 1.
- Produces:
  - **Colunas novas:**
    - `reservations.arrived_at timestamptz`, `reservations.released_at timestamptz`, com CHECK `reservations_presence_order`: `released_at is null or (arrived_at is not null and released_at >= arrived_at)`;
    - `waitlist.table_id uuid references public.tables(id) on delete set null` e `waitlist.released_at timestamptz`, com CHECK `waitlist_release_requires_seat`: `released_at is null or seated_at is not null`;
    - `walk_ins.released_at timestamptz`, com CHECK `walk_ins_release_requires_seat`: `released_at is null or seated_at is not null`. É `seated_at`, não `status`: "Foi embora" (`left`) depois de liberar continua permitido.
    - Índices parciais: `waitlist (table_id) where table_id is not null and released_at is null` e `walk_ins (table_id) where status = 'seated' and released_at is null`.
  - **Trigger `app_private.guard_presence_stamps()`:** `security definer`, `search_path = ''`, `BEFORE INSERT OR UPDATE` em `reservations`, `waitlist` e `walk_ins`; nomes `<tabela>_presence_guard`. Erro `raise 'presence_invalid' using errcode = '23514', detail = '<motivo>'`.
    - **INSERT:** `arrived_at`/`released_at` não nulos → motivo `born_with_presence`.
    - **`reservations.arrived_at` de nulo para preenchido:**
      - exige `new.status in ('pending','confirmed')` e `new.date` entre `hoje_brt - 1` e `hoje_brt`, com `hoje_brt = (now() at time zone 'America/Sao_Paulo')::date`. Senão, motivo `arrival_not_allowed`;
      - grava `new.arrived_at := now()`, que é o relógio do servidor.
    - **De preenchido para nulo (desfazer):** exige `old.released_at is null` e `new.released_at is null`, senão motivo `presence_final`.
    - **De preenchido para outro valor:** motivo `presence_final`.
    - **`released_at` (nas três tabelas) de nulo para preenchido:**
      - na reserva exige `new.arrived_at is not null`, senão motivo `release_requires_arrival`;
      - na fila e no passante exige `new.status = 'seated'`, senão motivo `not_seated`;
      - grava `new.released_at := now()`.
    - **Qualquer mudança de `released_at` já preenchido:** motivo `presence_final`.
  - **Trigger `app_private.guard_same_unit_table()`:** `security definer`; `waitlist_table_unit_guard` e `walk_ins_table_unit_guard`, `BEFORE INSERT OR UPDATE OF table_id`. Se `new.table_id` não é nulo e não existe `tables` com esse id e `unit_id = new.unit_id`: `raise 'table_unit_mismatch' using errcode = '42501'`.
  - **Policy `platform_admin_all_walk_ins`:** `on public.walk_ins for all to authenticated using/with check (app_private.is_platform_admin(auth.uid()))`, com `drop policy if exists` antes. É o paralelo que falta hoje (AGENTS §8).
  - **RPCs** (todas `security invoker`, `search_path = ''`, `returns void`; revoke de `public, anon, authenticated` e grant a `authenticated`):
    - `public.set_reservation_presence(p_reservation_id uuid, p_action text)`:
      - `arrive` → `arrived_at = coalesce(arrived_at, now())`;
      - `undo_arrive` → `arrived_at = null`;
      - `release` → `released_at = coalesce(released_at, now())`;
      - outra ação: `22023 presence_action_invalid`;
      - zero linhas: `42501 presence_forbidden` (RLS esconde alheio e inexistente).
    - `public.seat_waitlist_entry(p_waitlist_id uuid, p_table_id uuid)`:
      - `status = 'seated', table_id = p_table_id where id = p_waitlist_id and status in ('waiting','notified')`;
      - zero linhas: se a entrada é visível, `23514 presence_invalid` com detail `not_seatable`; senão, `42501 presence_forbidden`.
    - `public.release_waitlist_entry(p_waitlist_id uuid)` e `public.release_walk_in(p_walk_in_id uuid)`:
      - `released_at = coalesce(released_at, now()) where id = … and status = 'seated'`;
      - zero linhas: visível dá `23514 not_seated`; invisível dá `42501 presence_forbidden`.

- [ ] **Step 1: Estender `81a`**
  - Projetar `reservations` (com `FORCE RLS` e dono sem `BYPASSRLS`, como no `70a`), `waitlist` (com o trigger real de transição de status e `seated_at`), `walk_ins` e `customers`.
  - Incluir policies iguais às atuais (`013`, `014`, `054`, `023b`) e o trigger `enforce_operador_no_cancel` da `057`.

- [ ] **Step 2: Escrever os casos P-* no `81`**
  - P-1: operador `arrive` numa reserva `confirmed` de hoje → `arrived_at` igual ao `now()` da transação. UPDATE direto enviando `arrived_at = '2000-01-01'` também grava `now()`.
  - P-2: `arrive` repetido → sem erro, `arrived_at` inalterado.
  - P-3: `arrive` em `cancelled`, `no_show` e reserva de amanhã → `23514 arrival_not_allowed`; reserva de ontem → `ok`.
  - P-4: `release` sem chegada → `23514 release_requires_arrival`; depois de chegar → `ok`; `release` repetido → sem erro; `undo_arrive` depois de liberar → `23514 presence_final`.
  - P-5: `undo_arrive` antes de liberar → `arrived_at` nulo.
  - P-6: `status` igual ao inicial em P-1…P-5. O operador continua sem conseguir cancelar (`operador_cannot_cancel`).
  - P-7: reserva de B e reserva inexistente → `42501` com a mesma `sqlerrm`.
  - P-8: `seat_waitlist_entry`:
    - `waiting` e `notified` com mesa de A → `table_id` gravado, `seated_at` preenchido;
    - entrada `cancelled` → `23514 not_seatable`;
    - mesa de B → `42501 table_unit_mismatch`;
    - entrada de B → `42501 presence_forbidden`.
  - P-9: `release_waitlist_entry` e `release_walk_in`:
    - `seated` → `released_at` preenchido;
    - `waiting` → `23514 not_seated`;
    - alheio → `42501`;
    - passante liberado ainda aceita `status = 'left'`.
  - P-10: UPDATE direto de `walk_ins.table_id` com mesa de B → `42501`.
  - P-11: platform_admin sem membership libera passante de A → `ok`; outsider → `42501`.
  - P-12: invariante de métricas.
    - Snapshot de `select tabela, status, count(*)` nas três tabelas antes e depois de P-1, P-4, P-5, P-8 e P-9: só muda o que a própria ação de status já mudava (P-8: `waiting → seated` na mesma linha).
    - `select count(*) from walk_ins` idêntico antes e depois de P-8.
  - P-13: INSERT de reserva com `arrived_at` preenchido (como `anon` e `authenticated`) → `23514 born_with_presence`.
  - P-14: `anon` executa as 4 RPCs → permission denied.
  - P-CP: controle positivo. Desabilitar `reservations_presence_guard` dentro de um savepoint: o UPDATE direto de P-1 grava `2000-01-01` e o caso registra `controle_ok`.

- [ ] **Step 3: Rodar e ver os P-* falharem sem a migration** (mesmo contêiner e ordem da Task 1, mais `<ts1>`).

- [ ] **Step 4: Escrever `<ts2>_planta_do_salao_presenca.sql` conforme Interfaces**, com `begin;`/`commit;`, revokes com a assinatura completa e `comment on function`.

- [ ] **Step 5: Aplicar `81a`, `<ts1>` e `<ts2>` cruas 3 vezes, com o `81` inteiro depois de cada aplicação**
  Expected: L-* e P-* conforme o esperado; `L-CP` e `P-CP` = `controle_ok`.

- [ ] **Step 6: Allowlist e testes estáticos**
  - Quatro entradas novas, `"security_definer": false`, cada uma com `why` dizendo "não muda status nem cria linha; carimbo de presença".
  - Run: `npx vitest run scripts/function-acl-allowlist.test.ts scripts/migration-static-guard.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/<ts2>_planta_do_salao_presenca.sql supabase/tests/local-preflight/81a-planta-do-salao-bootstrap.sql supabase/tests/local-preflight/81-planta-do-salao.sql scripts/function-acl-allowlist.json
git commit -m "feat(planta): chegada e liberação como carimbos, fila e passante na mesa, sem mexer em status"
```

### Task 3: Tipos, README do harness e entrega da B1 na `main`

**Files:**
- Modify: `src/types/reserva.ts`, `src/hooks/useHallTables.ts`, `supabase/tests/local-preflight/README.md`

**Interfaces:**
- Produces:
  - `Mesa` ganha `plan_x`, `plan_y`, `plan_w`, `plan_h`, `plan_rotation: number | null` e `plan_shape: "round" | "square" | "rect" | null`.
  - `Hall` ganha:
    - `plan_width_cm`, `plan_depth_cm: number | null`;
    - `plan_entrance_wall: PlanWall | null`;
    - `plan_entrance_offset_cm: number | null`;
    - `plan_window_walls: PlanWall[]`;
    - com `export type PlanWall = "top" | "right" | "bottom" | "left"`.
  - `Reserva` ganha `arrived_at?: string | null` e `released_at?: string | null`.
  - `WaitlistEntry` ganha `table_id: string | null`, `seated_at: string | null` e `released_at: string | null`.
  - `WalkIn` ganha `released_at: string | null`.
  - Os `select` fixos de `useHallTables.ts` (`:12`, `:30`, `:79`) passam a incluir as colunas `plan_*`.

- [ ] **Step 1: Atualizar os tipos e os `select` fixos.** Run `npm run typecheck` → 0 erros.
- [ ] **Step 2: README §81** — seção "### 81 — Planta do salão" com a ordem exata de aplicação, o contêiner usado, a lista L-*/P-* e o que cada controle positivo prova.
- [ ] **Step 3: Gates**
  - typecheck, lint, test, build, check-padrao, check-portabilidade e os dois vitest de scripts verdes;
  - `saas-shield-br:migration-validator` nas duas migrations;
  - `saas-shield-br:identity-access-auditor` na fronteira de papel (trigger, `is_unit_manager`, RPCs);
  - sem bloqueante.
- [ ] **Step 4: Commit**

```bash
git add src/types/reserva.ts src/hooks/useHallTables.ts supabase/tests/local-preflight/README.md
git commit -m "feat(planta): tipos de layout e presença; README do harness 81"
```

- [ ] **Step 5: PR para `main` (autorização do dono)**
  - `gh pr create --base main --head feat/planta-b1-banco`.
  - Corpo:
    - o que é aditivo e inerte (nenhuma tela usa ainda);
    - os casos do harness;
    - o achado fora do escopo (operador edita `tables`/`halls` pela API; "Foi embora" subconta passantes sentados);
    - o aviso de ordem para o Instagram (`db push --include-all`);
    - o rodapé de atribuição.
  - Conferir o `acl-estatico` verde na aba Checks antes do merge.
- [ ] **Step 6: Merge e `supabase db push` (autorização do dono)**
  - Depois do merge: `git switch main && git pull`.
  - `supabase db push --dry-run` lista só `<ts1>` e `<ts2>`; depois, `supabase db push`.
  - Conferir com `supabase migration list` que as duas versões estão em local e remoto.
  - Deploy da Vercel em READY (só tipos mudaram).
- [ ] **Step 7: Criar a integração:** `git switch -c feat/planta-do-salao` a partir da `main` nova. Atualizar o STATE.

---

# B2 — Editor da planta

### Task 4: Geometria pura da planta

**Files:**
- Create: `src/lib/hall-plan-core.ts`, `src/lib/hall-plan-core.test.ts`

**Interfaces:**
- Consumes: `Mesa`, `Hall`, `PlanWall` (Task 3).
- Produces:

```ts
export type PlanShape = "round" | "square" | "rect";
export interface HallPlan { widthCm: number; depthCm: number; entrance: { wall: PlanWall; offsetCm: number } | null; windowWalls: PlanWall[] }
export interface TableBox { tableId: string; number: number; capacity: number; x: number; y: number; w: number; h: number; rotation: number; shape: PlanShape; positioned: boolean }
export const DEFAULT_HALL_PLAN: HallPlan; // { widthCm: 1200, depthCm: 900, entrance: null, windowWalls: [] }
export const GRID_CM = 25;
export function hallPlanFrom(hall: Hall): HallPlan;
export function defaultSizeFor(maxCapacity: number): { w: number; h: number; shape: PlanShape };
export function resolveTableBoxes(plan: HallPlan, tables: Mesa[]): TableBox[];
export function snap(valueCm: number, grid?: number): number;
export function clampBox(box: TableBox, plan: HallPlan): TableBox;
export function toSavePayload(plan: HallPlan, boxes: TableBox[]): { p_hall: { width_cm: number; depth_cm: number; entrance_wall: PlanWall | null; entrance_offset_cm: number | null; window_walls: PlanWall[] }; p_tables: Array<{ id: string; x: number | null; y: number | null; w: number | null; h: number | null; rotation: number | null; shape: PlanShape | null }> };
```

- [ ] **Step 1: Testes que falham** (`hall-plan-core.test.ts`):
  - `hallPlanFrom` devolve `DEFAULT_HALL_PLAN` quando `plan_width_cm` é nulo e copia as colunas quando preenchidas.
  - `defaultSizeFor(2)` dá `{70,70,"round"}`; `defaultSizeFor(4)` dá `{80,80,"square"}`; `defaultSizeFor(6)` dá `{140,80,"rect"}`; `defaultSizeFor(10)` dá `{260,80,"rect"}` (regra: 5 ou mais → `w = 80 + 60 * ceil((cap - 4) / 2)`, limitado a 600).
  - **`grade automática`:** 12 mesas sem posição num salão padrão.
    - `positioned=false`;
    - nenhum par de caixas se sobrepõe;
    - todas dentro do salão;
    - ordem por `number`, em linhas da esquerda para a direita e de cima para baixo, com espaçamento de `2 * GRID_CM` entre caixas;
    - as mesas posicionadas ficam onde estão.
  - `snap(137)` dá `125` e `snap(138)` dá `150`.
  - `clampBox` traz para dentro uma caixa com `x = -40` e outra com `x > widthCm`, considerando o retângulo envolvente da rotação.
  - `toSavePayload`:
    - mesa `positioned=false` sai com todos os campos `null`;
    - `rotation` é normalizada para 0–359;
    - `x`/`y`/`w`/`h` são inteiros.
- [ ] **Step 2:** `npx vitest run src/lib/hall-plan-core.test.ts` → FAIL (módulo ausente).
- [ ] **Step 3: Implementar.** Na grade automática, a posição sem colisão pode ser encontrada por varredura em passos de `GRID_CM`.
- [ ] **Step 4:** mesmo comando → PASS.
- [ ] **Step 5: Commit** `feat(planta): geometria pura da planta com grade automática`.

### Task 5: Dados e salvamento da planta

**Files:**
- Create: `src/hooks/useHallPlan.ts`, `src/hooks/useHallPlan.test.tsx`

**Interfaces:**
- Consumes: `toSavePayload` (Task 4); RPC `save_hall_plan` (Task 1).
- Produces:
  - `useHallPlanData(unitId: string, hallId: string)`:
    - key `["hall-plan", unitId, hallId]`;
    - devolve `{ hall: Hall; tables: Mesa[] }`;
    - mesas do salão com `active = true`, filtradas por `unit_id` e `hall_id`, com as colunas `plan_*`.
  - `useSaveHallPlan(unitId: string, hallId: string)`:
    - mutation `{ expectedUpdatedAt: string; payload: ReturnType<typeof toSavePayload> }` → `string` (o `updated_at` novo);
    - invalida `["hall-plan", unitId, hallId]`, `["hall", hallId]`, `["hall-tables", hallId]` e `["salao-ao-vivo", unitId]`.
  - `hallPlanErrorMessage(err: unknown): string`:
    - `40001` → "A planta foi alterada por outra pessoa. Recarregue para ver a versão atual.";
    - `42501` → "Você não tem permissão para editar esta planta.";
    - outro → "Não foi possível salvar a planta. Tente de novo.".

- [ ] **Step 1: Testes que falham**, no molde de `useAiStoreSettings.test.tsx` com `vi.mock("@/lib/supabase")`:
  - a leitura filtra `unit_id` e `hall_id`;
  - salvar chama `rpc("save_hall_plan", { p_hall_id, p_expected_updated_at, p_hall, p_tables })` com o payload intacto;
  - erro `{ code: "40001" }` vira a mensagem de conflito;
  - sucesso invalida as quatro chaves.
- [ ] **Step 2:** `npx vitest run src/hooks/useHallPlan.test.tsx` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(planta): leitura e salvamento da planta por RPC`.

### Task 6: Tela do editor

**Files:**
- Create:
  - `src/pages/gestao/reservas/SalaoPlanta.tsx`;
  - `src/components/planta/editor/PlantaEditorCanvas.tsx`, `MesaPropriedades.tsx`, `SalaoPropriedades.tsx`, `BandejaSemPosicao.tsx`;
  - `src/pages/gestao/reservas/SalaoPlanta.test.tsx`.
- Modify:
  - `src/App.tsx`: rota `/g/:unitSlug/reservas/saloes/:hallId/planta` dentro de `GestaoGuard`, com `lazy`;
  - `src/pages/gestao/reservas/SalaoDetalhe.tsx:262-273`: o cartão "Mapa de mesas" perde "(Em breve)", e o botão "Criar mapa" vira link "Editar planta" para a rota nova.

**Interfaces:**
- Consumes: Tasks 4 e 5; `useCurrentUnit().isGerente`.
- Produces: nenhuma para outras fases.

O que a tela faz:
- **Lona 2D** em escala ajustada à largura (ResizeObserver), com grade de `GRID_CM` desenhada por `background-image` com token.
- **Arrastar a mesa** por `pointerdown/move/up` com `setPointerCapture`, funcionando com mouse e toque. Ao soltar: `snap` e `clampBox`.
- **Mesa selecionada no teclado:**
  - setas movem `GRID_CM`;
  - `Shift`+seta move `5 * GRID_CM`;
  - `R` gira 15°;
  - `Delete` manda a mesa para a bandeja.
- **Painel de propriedades da mesa:** forma (segmentado), largura, profundidade e rotação.
- **Painel do salão:** largura, profundidade, parede e deslocamento da entrada, paredes com janela (checkboxes).
- **Bandeja** com as mesas sem posição; tocar numa delas a põe no primeiro espaço livre.
- **Salvar:**
  - botão principal, desabilitado sem mudanças;
  - aviso de alterações não salvas no `beforeunload` e no `useBlocker` do React Router ao sair da rota.
- **Estados:** carregando (skeleton); erro com "Tentar de novo"; salão sem mesas ("Cadastre mesas neste salão para montar a planta", com link de volta ao salão); conteúdo.
- **Permissão:** quem não é `isGerente` vê a planta só para leitura, sem salvar. Hoje só o platform_admin com pseudo-owner e o owner/gerente chegam à Gestão.
- **Visual:** `surface` nos painéis, sem `glass`; mesas com o token `--status-free`; 2D, sem 3D.

- [ ] **Step 1: Testes que falham** (`SalaoPlanta.test.tsx`, hooks mockados):
  - renderiza as mesas como `button` com `aria-label` `"Mesa 3, 4 lugares"`;
  - `ArrowRight` com a mesa 3 selecionada desloca 25 cm no estado e habilita "Salvar";
  - "Salvar" chama `useSaveHallPlan().mutate` com `expectedUpdatedAt` igual a `hall.updated_at`;
  - com `isGerente=false` não existe botão "Salvar";
  - erro de leitura mostra "Tentar de novo".
- [ ] **Step 2:** `npx vitest run src/pages/gestao/reservas/SalaoPlanta.test.tsx` → FAIL.
- [ ] **Step 3: Implementar** a página, os componentes, a rota e o link.
- [ ] **Step 4:** PASS; `npm run typecheck` 0.
- [ ] **Step 5: Revisão visual na MORALLES:**
  - posicionar as mesas de um salão, salvar e recarregar: a planta é a mesma;
  - arrastar por toque no DevTools com emulação de toque;
  - 1440×900, 1194×834 e 390×844, nos dois temas.
- [ ] **Step 6: Commit** `feat(planta): editor 2D da planta na Gestão`.

---

# B3 — Salão ao vivo: visão

### Task 7: Situação de cada mesa (função pura)

**Files:**
- Create: `src/lib/table-situation-core.ts`, `src/lib/table-situation-core.test.ts`

**Interfaces:**
- Consumes: tipos da Task 3.
- Produces:

```ts
export type TableSituation = "blocked" | "occupied" | "late" | "arriving" | "reserved" | "free";
export interface BrtNow { date: string; minutes: number; yesterday: string } // date "YYYY-MM-DD"; minutes desde 00:00 BRT
export function brtNow(now: Date): BrtNow; // Intl.DateTimeFormat timeZone "America/Sao_Paulo", hourCycle "h23"
export interface Occupant { kind: "reservation" | "walk_in" | "waitlist"; id: string; since: string; partySize: number }
export interface TableState {
  situation: TableSituation;
  occupant?: Occupant;
  overtime?: boolean;              // ocupada e since + durationMinutes < now
  minutesLate?: number;            // late
  minutesUntil?: number;           // arriving
  focusReservationId?: string;     // late | arriving | reserved
  nextReservationId?: string;      // próxima reserva de hoje ainda não chegada, para o painel
}
export interface BlockWindow { table_id: string | null; hall_id: string | null; blocked_from: string; blocked_to: string }
export interface SituationInput {
  tables: Array<Pick<Mesa, "id" | "hall_id">>;
  reservations: Array<Pick<Reserva, "id" | "table_id" | "date" | "time" | "status" | "party_size" | "arrived_at" | "released_at">>;
  walkIns: Array<Pick<WalkIn, "id" | "table_id" | "status" | "seated_at" | "party_size" | "released_at">>;
  waitlistSeated: Array<Pick<WaitlistEntry, "id" | "table_id" | "status" | "seated_at" | "party_size" | "released_at">>;
  blocks: BlockWindow[];
  now: Date;
  durationMinutes: number;
}
export function deriveTableStates(input: SituationInput): Map<string, TableState>;
```

Regras (spec §5.4; a ordem é a prioridade; a primeira que casa vence):
- **blocked:** há bloqueio com `blocked_from <= now < blocked_to` e uma destas condições: `table_id = mesa`; `table_id` nulo e `hall_id = mesa.hall_id`; ou os dois nulos (unidade inteira).
- **occupied:** a mesa tem um destes ocupantes:
  - passante `seated` sem `released_at`;
  - entrada de fila `seated` sem `released_at`;
  - reserva `pending|confirmed` com `arrived_at` e sem `released_at`, de hoje ou de ontem.

  `since` é `seated_at` ou `arrived_at`. `overtime` vale para os três tipos. Com mais de um ocupante, vence o de `since` mais antigo.
- **late:** reserva de hoje, `pending|confirmed`, sem `arrived_at`, com `time` menor que agora. Fica a mais antiga, com `minutesLate`.
- **arriving:** reserva de hoje, `confirmed`, sem chegada, com `0 <= time − agora <= 15`.
- **reserved:** reserva de hoje, `pending|confirmed`, sem chegada, mais tarde (inclui `pending` nos próximos 15 min). Fica a mais próxima.
- **free:** nenhuma das anteriores.
- Reserva com `released_at` ou `status` `cancelled|no_show` é ignorada. Reserva sem `table_id` não acende mesa nenhuma.

- [ ] **Step 1: Testes que falham** (um `it` por linha):
  - `brtNow` às `2026-10-31T02:30:00Z` → `{ date: "2026-10-30", minutes: 1410, yesterday: "2026-10-29" }`.
  - Cada situação isolada com uma mesa.
  - **Prioridade:** bloqueio vence ocupada; ocupada vence atrasada na mesma mesa.
  - **Várias reservas:** 19:00 sem chegada e 21:00, agora 19:20 → `late` 20 min com foco na das 19:00; com a das 19:00 liberada → `reserved` com foco na das 21:00.
  - **`passou do tempo`:** chegada às 19:00, duração 90, agora 20:31 → `occupied` + `overtime`.
  - **`ocupada atravessa a meia-noite`:** reserva de ontem às 23:30 com chegada e sem liberação, agora 00:20 → `occupied`.
  - **Bloqueio macro:** do salão e da unidade.
  - **Passante e fila sentados** sem `released_at` → `occupied`; com `released_at` → `free`.
  - **Reserva `pending` daqui a 10 min** → `reserved`, não `arriving`.
  - **`time` com segundos** (`"19:00:00"`) → mesmo resultado que `"19:00"`.
- [ ] **Step 2:** `npx vitest run src/lib/table-situation-core.test.ts` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(planta): situação derivada de cada mesa em BRT`.

### Task 8: Relógio de tela e dados ao vivo

**Files:**
- Create: `src/hooks/useNow.ts`, `src/hooks/useSalaoAoVivo.ts`, `src/hooks/useSalaoAoVivo.test.tsx`

**Interfaces:**
- Consumes: `brtNow` (Task 7); `useWalkIns(unitId, true)` (`src/hooks/useWalkIns.ts`); `useWaitlist(unitId, true)` (`src/hooks/useWaitlist.ts`).
- Produces:
  - `useNow(intervalMs = 60_000): Date`: estado que se atualiza no intervalo e para quando `document.hidden`.
  - `useSalaoAoVivo(unitId: string)` devolve `{ halls: Hall[]; tables: Mesa[]; reservations: Reserva[]; walkIns: WalkIn[]; waitlistActive: WaitlistEntry[]; waitlistSeated: WaitlistEntry[]; blocks: BlockWindow[]; durationMinutes: number; isLoading: boolean; isError: boolean; refetch: () => void }`, a partir destas consultas:
    - `["salao-ao-vivo", unitId, "plan"]`: salões ativos (`sort_order`) e mesas ativas da unidade, com `plan_*`;
    - `["reservas", unitId, "salao", hojeBrt]`: `status in (pending, confirmed)` e `or(date.eq.<hoje>, and(date.eq.<ontem>, arrived_at.not.is.null, released_at.is.null))`, com `customer:customers(id, name, phone)`. A key começa com `["reservas", unitId]` para as mutations atuais invalidarem;
    - `useWalkIns(unitId, true)`;
    - `useWaitlist(unitId, true)`;
    - `["waitlist", unitId, "seated-at-table"]`: `status = 'seated'`, `table_id` não nulo e `released_at` nulo;
    - `["table-blocks", unitId, "now"]`: `blocked_from <= agora` e `blocked_to > agora`;
    - `["settings", unitId, "reservation_duration_minutes"]`, `.maybeSingle()`: aceita número, string ou `{minutes}`; padrão 90 (mesma regra de `availability.ts:98-112`).
  - As consultas ao vivo usam `refetchInterval` ciente da aba, 30 s. `isError` é verdadeiro se qualquer consulta falhar.

- [ ] **Step 1: Testes que falham:**
  - toda consulta leva `.eq("unit_id", unitId)`;
  - o filtro de reservas contém hoje e ontem em BRT;
  - duração `"120"` → 120, `{ minutes: 75 }` → 75, ausente → 90;
  - erro numa consulta → `isError`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(planta): dados ao vivo do salão com polling ciente da aba`.

### Task 9: Página Salão ao vivo (cena 3D/2D, legenda, painel de leitura, chegadas e fila)

**Files:**
- Create:
  - `src/pages/operacional/SalaoAoVivo.tsx`, `src/pages/operacional/SalaoAoVivo.test.tsx`;
  - `src/components/planta/ao-vivo/PlantaCena3D.tsx`, `PlantaCena2D.tsx`, `MesaBotao.tsx`, `LegendaSituacoes.tsx`, `PainelMesa.tsx`, `ProximasChegadas.tsx`, `ResumoFila.tsx`;
  - `src/components/planta/situation-labels.ts`.
- Modify:
  - `src/App.tsx`: rota `/o/:unitSlug/salao` dentro de `OperacionalGuard`, com `lazy`;
  - `src/components/layouts/OperacionalLayout.tsx:44-55`: item `{ to: \`${base}/salao\`, label: "Salão ao vivo", icon: LayoutGrid }` logo depois de "Reservas do dia";
  - `src/lib/glass-usage-guard.test.ts`: `SalaoAoVivo.tsx` em `ALLOWED_BLUR_FILES`, só para a seção principal.

**Interfaces:**
- Consumes: Tasks 4, 7 e 8.
- Produces:
  - `SITUATION_LABEL: Record<TableSituation, string>`: Bloqueada, Ocupada, Atrasada, Chegando, Reservada, Livre.
  - `SITUATION_TONE: Record<TableSituation, "late" | "seated" | "arriving" | "reserved" | "free" | "pending">`: blocked → pending, occupied → seated, late → late, arriving → arriving, reserved → reserved, free → free.
  - `situationText(state: TableState): string`: "Atrasada 12 min", "Chega em 3 min", "Ocupada · passou do tempo", ou o rótulo puro.
  - `PainelMesa` aceita `actions?: ReactNode`, preenchido na Task 12.

O que a tela faz (mockup `Salao.dc.html`):
- **Layout:** grid `minmax(0,1fr) 372px` a partir de `lg`; empilhado abaixo disso.
- **Seção principal** (`glass`, superfície única):
  - h1 "Salão ao vivo" e chip com a contagem de mesas;
  - seletor de ambiente segmentado (`role="group"`, `aria-pressed`), um salão por vez, lembrado em `localStorage` com `try/catch`;
  - legenda `<ul aria-label="Situação das mesas">` com contagem por situação.
- **Cena 3D:**
  - `perspective: 1500px`, plano com `rotateX(56deg) rotateZ(-36deg)` e `transform-style: preserve-3d`;
  - escala pelo tamanho do salão (Task 4) e pela largura disponível;
  - parede superior e direita, com janela marcada por listras de token, e porta na entrada;
  - mesas como `MesaBotao`: camadas em `translateZ`, a tampa colorida pelo tom da situação e a etiqueta (número e horário) contrarrotacionada;
  - halo `motion-safe` só em `arriving` e `late`; entrada `settle` com `motion-safe`.
- **Queda para 2D** (`PlantaCena2D`, vista de cima, mesmas caixas): abaixo de 640 px, com `prefers-reduced-motion: reduce` ou quando o 3D falha (error boundary em volta do 3D).
- **`MesaBotao`:**
  - `<button>` com `aria-label`, por exemplo "Mesa 12, 4 lugares, Ocupada há 40 min, passou do tempo";
  - `aria-pressed` quando selecionada;
  - toque 200 a 350 ms em `transform`;
  - sem `backdrop-filter`.
- **Aside** (cartões `surface`):
  - **`PainelMesa`** (`aria-live="polite"`):
    - h2 "Mesa N", "N lugares" e pílula com `situationText`;
    - ocupante ou reserva em foco: nome, "N pessoas às HH:MM" e nota "Ocupada desde HH:MM. Próxima reserva às HH:MM" ou "Livre até a reserva das HH:MM" / "pelo resto do dia";
    - sem mesa selecionada: "Toque numa mesa para ver os detalhes";
    - notas de visitas e de saldo de giftback ficam fora da v1 (spec §5.1: só com dado que já existe na consulta).
  - **`ProximasChegadas`:**
    - reservas de hoje sem chegada, `pending|confirmed`, ordenadas por horário, no máximo 8;
    - linha "N pessoas na mesa X" ou "sem mesa";
    - tocar seleciona a mesa e troca o ambiente.
  - **`ResumoFila`:** número de grupos aguardando, o próximo ("família X, N pessoas, há N min") e a espera média em minutos (`created_at` até agora, entradas ativas).
- **Estados:** skeleton; erro com "Tentar de novo" (`refetch`); unidade sem salões ou mesas ("Cadastre salões e mesas na Gestão"); salão sem planta usa a grade automática e mostra o aviso "Planta ainda não desenhada" com link para o editor quando `isGerente`.

- [ ] **Step 1: Testes que falham** (`SalaoAoVivo.test.tsx`, `useSalaoAoVivo` mockado, `matchMedia` controlado):
  - legenda com as contagens certas para um conjunto de 5 mesas, uma de cada situação;
  - `matchMedia("(prefers-reduced-motion: reduce)")` verdadeiro renderiza `PlantaCena2D` (`data-testid="planta-2d"`);
  - largura 390 renderiza 2D;
  - tocar na "Mesa 3" mostra no painel o nome do ocupante;
  - tocar numa linha de próximas chegadas seleciona a mesa;
  - `isError` mostra "Tentar de novo".
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implementar** a página, os componentes, a rota, o menu e a entrada no guard de blur.
- [ ] **Step 4:** PASS; `npx vitest run src/lib/glass-usage-guard.test.ts` PASS.
- [ ] **Step 5: Commit** `feat(planta): Salão ao vivo em 3D com legenda, chegadas e fila`.

### Task 10: Desempenho e revisão visual da B3

- [ ] **Step 1: Preparar 40 mesas num salão da MORALLES** pelo cadastro em lote atual (`HallScheduleSheet`) e posicioná-las no editor (B2).
- [ ] **Step 2: Medir** no Chrome com DevTools Performance, 1194×834, CPU 4×, abrindo `/o/moralles-centro/salao`.
  - Expected:
    - nenhuma long task acima de 200 ms depois da primeira pintura;
    - toque numa mesa até a atualização do painel abaixo de 100 ms;
    - com o halo ativo em 5 mesas, rolagem do aside sem queda de quadros visível no FPS meter.
  - Anotar os números no STATE.
- [ ] **Step 3: Se falhar,** reduzir as camadas `translateZ` das mesas (de 4 para 2) e o halo para só `opacity`, e medir de novo. Não trocar a técnica sem o dono.
- [ ] **Step 4: Revisão visual:** 1440×900, 1194×834 e 390×844, nos dois temas, com movimento reduzido ligado; teclado (Tab percorre as mesas por número; Enter seleciona).
- [ ] **Step 5: Commit** dos ajustes, se houver: `perf(planta): ...`.

---

# B4 — Ações

### Task 11: Mutations de presença e mensagem da fila compartilhada

**Files:**
- Create: `src/hooks/useMesaAcoes.ts`, `src/hooks/useMesaAcoes.test.tsx`, `src/lib/waitlist-message.ts`, `src/lib/waitlist-message.test.ts`, `src/lib/conversation-link.ts`, `src/lib/conversation-link.test.ts`
- Modify: `src/pages/operacional/Fila.tsx:169-186` (passa a usar `buildWaitlistMessage` da lib); `src/hooks/useWalkIns.ts` (`useCreateWalkIn` aceita `table_id?: string | null` e `seated?: boolean`)

**Interfaces:**
- Consumes: as quatro RPCs da Task 2.
- Produces:

```ts
export type PresenceAction = "arrive" | "undo_arrive" | "release";
export function useReservationPresence(unitId: string): UseMutationResult<void, Error, { reservationId: string; action: PresenceAction }>;
export function useSeatWaitlistEntry(unitId: string): UseMutationResult<void, Error, { waitlistId: string; tableId: string }>;
export function useReleaseWaitlistEntry(unitId: string): UseMutationResult<void, Error, { waitlistId: string }>;
export function useReleaseWalkIn(unitId: string): UseMutationResult<void, Error, { walkInId: string }>;
export function presenceErrorMessage(err: unknown): string;
// waitlist-message.ts
// WaitlistMessageTemplate: o tipo que useWaitlistTemplates (src/hooks/useWaitlistTemplates.ts:74) já devolve
export function buildWaitlistMessage(entry: WaitlistEntry, event: "entered" | "table_ready", opts: { templates: WaitlistMessageTemplate[] | undefined; unitName: string | undefined; origin: string }): string;
// conversation-link.ts — basePath é `/o/:slug` ou `/g/:slug`
export function conversationHref(basePath: string, customerId: string): string; // `${basePath}/conversas?cliente=${encodeURIComponent(customerId)}`
```

- **Invalidações:**
  - presença de reserva → `["reservas", unitId]`;
  - fila → `["waitlist", unitId]`;
  - passante → `["walk-ins", unitId]`.
- **Toasts:**
  - "Chegada marcada." com ação "Desfazer", que chama `undo_arrive`;
  - "Chegada desfeita.";
  - "Mesa liberada.";
  - "Cliente sentado na mesa N.".
- **`presenceErrorMessage`:**
  - `42501` → "Sem permissão para esta mesa.";
  - `23514` com o detail:
    - `arrival_not_allowed` → "Só dá para marcar chegada de reserva pendente ou confirmada de hoje.";
    - `release_requires_arrival` → "Marque a chegada antes de liberar a mesa.";
    - `presence_final` → "Esta mesa já foi liberada.";
    - `not_seatable` → "Este cliente não está mais aguardando na fila.";
    - `not_seated` → "Este cliente não está sentado.";
  - outro → "Não foi possível atualizar a mesa. Recarregue a tela.".
- **`useCreateWalkIn` com `seated: true`:** grava `status: "seated"`, `seated_at` agora e o `table_id`, numa linha só.

- [ ] **Step 1: Testes que falham:**
  - cada mutation chama `supabase.rpc` com o nome e os parâmetros exatos;
  - as invalidações certas;
  - o mapa de mensagens com `{ code: "23514", details: "release_requires_arrival" }`;
  - `buildWaitlistMessage` produz o mesmo texto que o `Fila.tsx` atual para template customizado e padrão (fixture);
  - `useCreateWalkIn` com `seated` faz um único `insert` com `status: "seated"`;
  - `conversationHref("/o/moralles-centro", "a b")` → `"/o/moralles-centro/conversas?cliente=a%20b"`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implementar** e trocar o `Fila.tsx` pela lib.
- [ ] **Step 4:** PASS; os testes existentes de Fila/Passantes continuam verdes.
- [ ] **Step 5: Commit** `feat(planta): mutations de presença e mensagem da fila compartilhada`.

### Task 12: Ações no painel da mesa

**Files:**
- Create: `src/components/planta/ao-vivo/AcoesMesa.tsx`, `src/components/planta/ao-vivo/AcoesMesa.test.tsx`
- Modify: `src/pages/operacional/SalaoAoVivo.tsx` (passa `actions` ao `PainelMesa`; `ResumoFila` ganha "Chamar no WhatsApp")

**Interfaces:**
- Consumes: Task 11 (inclusive `conversationHref`); `useNotifyWaitlist` e `useUpdateWalkInStatus` existentes. O link só abre a conversa certa depois da Task 14.

Ações por situação (todas as pessoas da unidade):

| Situação | Ações |
|---|---|
| `arriving`, `late`, `reserved` (reserva em foco) | "Marcar chegada"; "Abrir conversa" se houver `customer_id` |
| `occupied` por reserva | "Liberar mesa"; "Desfazer chegada"; "Abrir conversa" |
| `occupied` por fila | "Liberar mesa"; "Abrir conversa" se houver `customer_id` |
| `occupied` por passante | "Liberar mesa" |
| `free` | "Sentar passante": lista dos passantes `waiting` ou formulário curto de passante novo (nome, pessoas). "Sentar da fila": lista das entradas `waiting/notified`, a mais prioritária primeiro, com aviso quando `party_size` passa de `max_capacity` |
| `blocked` | nenhuma; texto "Mesa bloqueada até HH:MM" |

- `ResumoFila`: "Chamar no WhatsApp" chama `useNotifyWaitlist` com `buildWaitlistMessage(entry, "table_ready", …)` para o próximo da fila, no padrão `{ externalOk, dbOk }`. Sem telefone, o botão fica desabilitado com o texto "Sem WhatsApp cadastrado".
- Botões desabilitados por `mutation.isPending && mutation.variables?.… === id`.

- [ ] **Step 1: Testes que falham:**
  - para cada linha da tabela, as ações visíveis são exatamente as listadas;
  - "Marcar chegada" chama `mutate({ reservationId, action: "arrive" })`;
  - "Sentar da fila" chama `useSeatWaitlistEntry` com a mesa selecionada;
  - o passante novo chama `useCreateWalkIn` com `seated: true` e `table_id`;
  - a mesa bloqueada não tem nenhum botão de ação.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(planta): ações essenciais por mesa no Salão ao vivo`.

### Task 13: Presença em Reservas do dia e passante liberado

**Files:**
- Modify: `src/components/reserva/ReservaCard.tsx`, `src/pages/operacional/Passantes.tsx`, `src/hooks/useWalkIns.ts`
- Test: `src/components/reserva/ReservaCard.presence.test.tsx`, `src/pages/operacional/Passantes.release.test.tsx`

**Interfaces:**
- Consumes: Task 11.

**`ReservaCard`**, com `showActions`, para todos os papéis:
- "Chegou": `pending|confirmed`, sem `arrived_at` e `date` de hoje em BRT;
- "Liberar mesa" e "Desfazer chegada": com `arrived_at` e sem `released_at`.

**Passantes:**
- A lista "Na mesa" esconde quem tem `released_at`.
- **Decisão do dono (aprovada em 2026-10-30):** "Foi embora" de quem está na mesa passa a chamar `useReleaseWalkIn`. O status fica `seated`, e as métricas de sentados e receita deixam de subcontar daqui em diante; os dias passados não mudam. "Não apareceu" continua igual.

- [ ] **Step 1: Testes que falham:**
  - `ReservaCard`: confirmada de hoje sem chegada mostra "Chegou" e não mostra "Liberar mesa"; com `arrived_at` mostra "Liberar mesa" e "Desfazer chegada"; reserva de amanhã não mostra "Chegou"; o operador também vê os três.
  - Passantes: passante `seated` com `released_at` não aparece em "Na mesa"; "Foi embora" chama `useReleaseWalkIn` e não faz UPDATE de `status`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(planta): chegada e liberação em Reservas do dia; passante liberado sai da mesa`.

### Task 14: Link direto para a conversa do cliente

**Files:**
- Modify: `src/pages/gestao/Conversas.tsx` (`:424-440`)
- Test: `src/pages/gestao/Conversas.deeplink.test.tsx`

**Interfaces:**
- Consumes: o formato de `conversationHref` (Task 11): parâmetro `cliente` com o `customer_id`.

**Conversas:**
- lê `cliente` por `useSearchParams`;
- quando `allConversations` carrega, seleciona a conversa com `customer_id` igual;
- sem conversa, mostra `toast.info("Ainda não há conversa com este cliente.")`;
- depois remove o parâmetro (`setSearchParams(..., { replace: true })`), para não reabrir ao trocar de filtro.

- [ ] **Step 1: Testes que falham:**
  - com `?cliente=c1` e uma lista que contém a conversa de `c1`, o painel de detalhe abre nela;
  - sem conversa, o toast é chamado e o parâmetro some.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Teste manual da B4 na MORALLES:**
  - marcar chegada, desfazer e liberar;
  - sentar um passante novo;
  - sentar alguém da fila;
  - chamar da fila, só com uma entrada no telefone do dono;
  - abrir conversa.

  Depois, conferir na Gestão › Fluxo de clientes do dia que as contagens não mudaram além do que a tela Passantes/Fila já registraria.
- [ ] **Step 6: Commit** `feat(planta): abrir conversa do cliente a partir da mesa`.

---

# B5 — Situações nas listas, QA e lançamento

### Task 15: Pílula única e situação derivada nas listas

**Files:**
- Create: `src/components/ui/status-pill.tsx`, `src/components/ui/status-pill.test.tsx`
- Modify:
  - `src/lib/table-situation-core.ts` (+ teste);
  - `src/components/reserva/ReservaCard.tsx:54-56`;
  - `src/pages/operacional/Fila.tsx:61`;
  - `src/pages/operacional/Passantes.tsx:49`;
  - a lista "Reservas de hoje" do Dashboard, que é o consumidor de `useReservasHoje`/`DashboardHero`.

**Interfaces:**
- Produces:

```ts
export type StatusTone = "free" | "reserved" | "arriving" | "seated" | "late" | "pending" | "destructive" | "muted" | "success";
export function StatusPill(props: { tone: StatusTone; children: ReactNode; className?: string }): JSX.Element;
// table-situation-core.ts
export function reservationLiveSituation(r: Pick<Reserva, "date" | "time" | "status" | "arrived_at" | "released_at">, now: Date, durationMinutes: number): { tone: StatusTone; label: string } | null;
```

`reservationLiveSituation` só vale para `pending|confirmed`:
- chegada sem liberação → `{ seated, "Sentada" }`, ou `"Sentada · passou do tempo"`;
- de hoje, sem chegada e horário passado → `{ late, "Atrasada N min" }`;
- `confirmed` com 0 a 15 min → `{ arriving, "Chega em N min" }`;
- senão, `null`.

As listas mostram a pílula gravada e, quando não é `null`, a derivada ao lado, no máximo duas. O relógio é `useNow(60_000)`.

- [ ] **Step 1: Testes que falham:**
  - `StatusPill` aplica `bg-status-late/15 text-status-late`, sem cor fixa;
  - `reservationLiveSituation` nos quatro ramos e em `cancelled` → `null`;
  - `ReservaCard` de reserva confirmada às 19:00, agora 19:12 → pílulas "Confirmada" e "Atrasada 12 min".
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implementar e substituir** as três tabelas locais de classes pelas `StatusPill`.
- [ ] **Step 4:** PASS; os testes existentes das listas verdes.
- [ ] **Step 5: Commit** `feat(planta): situações Chegando, Atrasada e Sentada nas listas`.

### Task 16: Regras e documentação

**Files:**
- Modify: `.claude/rules/reservas.md`, `.claude/rules/frontend.md`, `.claude/rules/banco-de-dados.md`

- [ ] **Step 1: Acrescentar,** no formato do AGENTS §3, uma frase de regra, uma de porquê e um ponteiro:
  - **reservas.md:** chegada e liberação são carimbos e o `status` não muda; liberar passante nunca usa `left` (métrica de sentados); sentar da fila grava `waitlist.table_id` na mesma linha; o relógio é o do servidor, via trigger.
  - **frontend.md:** a situação da mesa só sai de `table-situation-core.ts`; o link de conversa usa `conversationHref`; a planta ao vivo tem um único `glass`.
  - **banco-de-dados.md:** `plan_*` de `tables`/`halls` são guardadas por `guard_plan_write` (owner/gerente/admin), enquanto o resto da linha continua na policy `unit_member_all_*`; as RPCs de presença são INVOKER por causa do `FORCE RLS`.
- [ ] **Step 2:** `node scripts/check-padrao.mjs` verde (o AGENTS.md fica abaixo de 200 linhas; nada novo nele).
- [ ] **Step 3: Commit** `docs(planta): invariantes da planta e da presença`.

### Task 17: Lançamento

- [ ] **Step 1: Gates completos** na integração (seção Global Constraints).
- [ ] **Step 2: Auditores** `saas-shield-br`:
  - `migration-validator`, `rls-auditor`, `tenant-isolation-auditor` e `identity-access-auditor` sobre a branch inteira contra `main`;
  - corrigir bloqueante em nova task.
- [ ] **Step 3: Revisão da branch inteira** com `superpowers:requesting-code-review` (modelo mais capaz).
- [ ] **Step 4: Segredos:** `git diff main...feat/planta-do-salao | grep -nE "sk-|sk-ant-|xai-|AIza|eyJ|Bearer |service_role|whsec_"` sem resultado.
- [ ] **Step 5: Preview para o dono, com autorização:**
  - push de `feat/planta-do-salao`;
  - o dono confere na MORALLES o editor, o Salão ao vivo no tablet e as listas.
- [ ] **Step 6: PR e merge, com autorização:**
  - `gh pr create --base main --head feat/planta-do-salao`, com o resumo das fases, as medições da Task 10, os achados fora do escopo e o rodapé de atribuição;
  - merge depois dos checks;
  - conferir a produção na Vercel em READY.
- [ ] **Step 7: Fechar a mudança:**
  - STATE em "concluído";
  - memória do projeto atualizada;
  - checkboxes deste plano marcados.
