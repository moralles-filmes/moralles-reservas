# Plano — escrita em `settings` por chave e papel

Spec: [2026-10-19-settings-escrita-por-chave-design.md](../specs/2026-10-19-settings-escrita-por-chave-design.md) (aprovada 2026-10-19).
PR 1 (banco): branch `fix/settings-write-acl` em `.claude/worktrees/settings-write-acl`, a partir de `origin/main` `d18f975`.
PR 2 (hook de conversas): branch própria `fix/conversations-release-unit-scope`, worktree `.claude/worktrees/conversations-release-scope`, a partir de `origin/main`. Independente do PR 1.

## Regras para todo implementador

- Ler `AGENTS.md` e `.claude/rules/banco-de-dados.md` antes de editar. O PR 2 lê também `.claude/rules/whatsapp.md` e `.claude/rules/frontend.md`.
- Migration só por `supabase db push`, **nunca** aplicada no remoto nesta execução. Ninguém roda SQL de escrita em produção. Leitura de produção só pelo MCP, só `select`.
- Função nova: `revoke all … from public, anon, authenticated, service_role` com a assinatura completa. Helper chamado por qualificação `app_private.`. Recusa sempre `raise exception 'setting_write_forbidden' using errcode = '42501'`, a mesma mensagem em todos os ramos.
- Harness `local-preflight`: Postgres local descartável, migration aplicada **crua** (sem `psql -1`) com `ON_ERROR_STOP=1`, e todo caso novo com controle positivo. Se o Postgres local não estiver disponível na máquina, **parar e reportar**. Não fingir o gate nem trocar por "revisão de leitura".
- Gates por tarefa: os testes tocados, `npm run typecheck` (= `tsc -b --noEmit`), `npm run lint` sem erro novo. Falhas locais já conhecidas e pré-existentes (`whatsapp-template-catalog-v2.test.ts` por CRLF, flake de `whatsapp-survey-tenant-routing.test.ts` só na suíte cheia) entram no relatório como tal.
- Commit por tarefa com `git add <caminhos>` explícito, nunca `git add .`/`-A`. Mensagem convencional em inglês, terminada com a linha `Co-Authored-By` da sessão. Antes do commit: `git diff --cached` inteiro e a varredura de segredos do AGENTS §5.
- Push, PR, merge, `db push` e deploy: cada um **só com autorização explícita do usuário, pedida à parte**.

## Bloco 1 — PR 1, banco (Tasks 1–3)

### [x] Task 1 — Migration do guard + pré-voo 75/75a (RED antes, GREEN depois)

**Modelo:** Opus (implementação e review). SQL, trigger e ACL.

1. **Pré-voo primeiro (RED).** Criar `supabase/tests/local-preflight/75a-settings-write-acl-bootstrap.sql` sobre a base do 68 (`00-bootstrap` → `01-audit` → `09a-advisor-bootstrap` → migration `20260910120000_106_advisor_private_rls_helpers.sql`):
   - `auth.role()` stub, igual ao do Supabase: `coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')`. Conferir antes que nenhum arquivo da base já define `auth.role()`.
   - Atores fixos (UUIDs literais) para as unidades U1 e U2: owner U1, gerente U1, operador U1, gerente U2 e platform_admin sem membership. Linhas iniciais em `settings` U1 para `ai_config`, `ai_system_prompt`, `booking_window_days` e `restaurant_name`.
   - A tabela `settings` **não** pode receber o trigger novo aqui. O 75a só prepara.
   - Trigger existente `whatsapp_legacy_template_write`: copiar o corpo de `public.guard_whatsapp_legacy_template_write()` **verbatim de produção** (ler com `select prosrc` pelo MCP), com a mesma ACL (`revoke all … from public, anon, authenticated, service_role`). Criar só as dependências que o corpo toca: `app_private.whatsapp_template_maintenance_permits` (forma mínima) e `whatsapp_channels` (o 00 já tem; conferir as colunas `provider`, `is_active`, `status`, `created_at`, `unit_id`). Se faltar coluna, acrescentar com `add column if not exists`. A procedência ("extraído de produção em AAAA-MM-DD") vai num comentário.
2. Criar `supabase/tests/local-preflight/75-settings-write-acl.sql` no estilo do 68: tabela `t_res(ord, caso, veredito)` e cada caso em `do $$ … $$`, com a identidade por `set local role authenticated|service_role|anon` + `set local request.jwt.claims = '{"sub":"…","role":"…"}'`. Cada caso confere **o SQLSTATE `42501` e o efeito na tabela** (valor intacto ou gravado). Ordinais **751–770**, com a lista de casos de §6.1 da spec (S1–S16). S8 cobre **cada uma** das 22 chaves `manager` (loop sobre um array literal) para owner e para gerente. S15 reaplica a migration por `\i` e confere um único trigger `settings_write_role_guard`. O controle positivo (ordinal 770): `drop trigger settings_write_role_guard`, repete S1 e exige que o operador **consiga** gravar `ai_config`; depois recria o trigger e confirma que S1 volta a falhar. Termina com `select ord, caso, veredito from t_res where ord between 751 and 770 order by ord` e a contagem esperada.
   - O arquivo começa com uma guarda que aborta se o trigger não existir. Rodado antes da migration, **tem de falhar** pela guarda: esse é o RED. Registrar a saída no relatório.
3. **Migration** `supabase/migrations/20261019180000_settings_write_role_guard.sql`. Antes, conferir que o timestamp é posterior ao último arquivo de `supabase/migrations/` em `origin/main`. Conteúdo, com `begin;` … `commit;` no próprio arquivo e idempotente:
   ```sql
   create or replace function app_private.unit_setting_write_class(p_key text)
   returns text language sql immutable set search_path = '' as $$
     select case when p_key = any (array[
       'reservation_duration_minutes','booking_window_days','reservation_tolerance_minutes',
       'rules_and_conditions','additional_info','reminder_d1_enabled','survey_d1_enabled',
       'waitlist_qr_enabled','waitlist_menu_link_enabled','waitlist_priority_enabled',
       'waitlist_code_min','waitlist_code_max','waitlist_tolerance_minutes',
       'waitlist_remote_entry_enabled','waitlist_remote_entry_limit',
       'waitlist_entered_enabled','waitlist_feedback_enabled',
       'giftback_whatsapp_enabled','giftback_email_enabled','giftback_message_template',
       'allow_overbooking','restaurant_name'
     ]::text[]) then 'manager' else 'platform' end
   $$;
   ```
   `app_private.guard_unit_setting_write() returns trigger`, `plpgsql`, `security definer`, `set search_path = ''`:
   - `v_role := auth.role()`. Se for `null` ou `'service_role'`, devolve `old` no DELETE e `new` nos demais.
   - Se `v_role is distinct from 'authenticated'`, recusa. Se `auth.uid()` for nulo, recusa.
   - Se `app_private.is_platform_admin(v_uid)`, passa.
   - Em `UPDATE`/`DELETE`, sobre `old`; em `INSERT`/`UPDATE`, sobre `new`: recusa se `app_private.unit_setting_write_class(x.key) <> 'manager'` ou se não existir `public.unit_members m where m.user_id = v_uid and m.unit_id = x.unit_id and m.role in ('owner','gerente')`.
   - Devolve `old` no DELETE e `new` nos demais.

   Depois, `revoke all on function app_private.unit_setting_write_class(text) from public, anon, authenticated, service_role;` e o mesmo para `app_private.guard_unit_setting_write()`. Em seguida `drop trigger if exists settings_write_role_guard on public.settings;` e `create trigger settings_write_role_guard before insert or update or delete on public.settings for each row execute function app_private.guard_unit_setting_write();`. Grants:
   - `revoke insert, update, delete, truncate on table public.settings from anon;`
   - um bloco `do $$` que revoga `insert (…)`/`update (…)` de todas as colunas de `public.settings` para `anon` (copiar a forma do bloco da migration `20261017160000_conversation_message_write_acl.sql`);
   - `revoke truncate on table public.settings from public, authenticated;`

   O comentário do topo explica o porquê em 3–5 linhas e aponta a spec. Não mexer nas policies.
4. **GREEN.** Rodar a sequência da base + `75a` + migration (crua) + `75`, e a migration de novo + `75` (idempotência). Todos os ordinais 751–770 devem dar `PASSOU` e a contagem tem de bater. Rodar também os pré-voos que tocam `settings` para regressão: `26-template-catalog.sql`, na sequência documentada no README, se a base dele aceitar a migration nova; senão, registrar por quê.
5. Seção nova no README do pré-voo, "### 75 — Escrita em settings por chave e papel", no formato da seção 68: comandos exatos, contagem esperada, ordinais livres e "O que NÃO prova" (PostgREST/JWT real; o isolamento entre unidades continua nas policies, que não mudaram).
6. Commit: `feat(db): guard settings writes by key and role` com a migration, `75a`, `75` e o README.

### [x] Task 2 — Paridade UI ↔ classificador + regra

**Modelo:** Sonnet (implementação e review). Teste estático puro.

1. `scripts/settings-write-acl.test.ts` (Vitest, mesmo estilo de `scripts/audit-log-member-policy.test.ts`):
   - acha a **última** migration (ordem lexical) que contém `function app_private.unit_setting_write_class` e extrai o array literal;
   - monta o conjunto da Gestão importando `GIFTBACK_SETTING_KEYS` e `WAITLIST_SETTING_KEYS`, lendo `SETTING_KEYS` de `src/pages/gestao/reservas/Ajustes.tsx` por regex no fonte (o arquivo é página React, não importar), mais `allow_overbooking` (`src/hooks/useTableBlocks.ts`, conferir por regex que a string existe lá) e `restaurant_name` (`src/pages/gestao/Conta.tsx`, idem);
   - afirma **igualdade** de conjuntos, com mensagem de diff legível;
   - afirma que nenhuma chave de `saveSetting.mutate…({ key: "…" })` em `src/pages/gestao/Automacao.tsx` está no array (extrair por regex e exigir pelo menos 8 achadas, para o regex não passar vazio);
   - controle negativo: uma função pura `diffSettingKeys(a, b)` testada com um conjunto que tem uma chave a mais tem de reportar a diferença.
2. `.claude/rules/banco-de-dados.md`, seção "Tabelas e auditoria", uma linha no formato do arquivo: **"Chave nova de `settings` nasce gravável só por platform_admin; a Gestão grava só as chaves `manager` de `app_private.unit_setting_write_class`, e o trigger `settings_write_role_guard` recusa o resto com `42501`."** O motivo: `unit_member_all_settings` não confere papel, e o trigger é o que impede o operador de trocar IA, prompt e envios. Ponteiro para a migration e para `scripts/settings-write-acl.test.ts`.
3. Gates: `npx vitest run scripts/settings-write-acl.test.ts`, `npm run typecheck`, `npm run lint`, `npm run test` (suíte cheia; registrar as falhas pré-existentes). Commit: `test(settings): pin Gestão setting keys to the write classifier`.

### [x] Task 3 — Gates de segurança e review da branch

**Modelo:** Opus.

1. Em paralelo, sobre a migration e os testes:
   - `saas-shield-br:migration-validator` com o path do `.sql`;
   - `saas-shield-br:rls-auditor` com a migration e a 013 (policies de `settings`);
   - `saas-shield-br:identity-access-auditor` com foco em papéis owner/gerente/operador/platform_admin e escrita em `settings`.

   Cada achado bloqueante é corrigido numa tarefa de correção (com review) ou contestado com evidência no relatório. Nada é ignorado em silêncio.
2. Review da branch inteira contra a spec: `git diff origin/main...HEAD`, conferindo §4.2 item a item e os 16 casos de §6.1.
3. `node scripts/ef-import-graph.mjs` **não se aplica** (nenhum `_shared/` mudou). Confirmar com `git diff --stat origin/main...HEAD` que nada em `supabase/functions/` nem em `src/` mudou.
4. Pedir ao usuário **autorização para push da branch e abertura do PR**. Com ela, abrir o PR e conferir na aba Checks que o `acl-estatico` e o CI estão verdes. Não mergear.
5. Ao fim do bloco: marcar os checkboxes, commitar o plano e atualizar a memória `settings-escrita-por-chave` ("próximo chat: Task 4 após autorização").

## Bloco 2 — PR 1, rollout (Task 4; só com autorizações)

### [x] Task 4 — Merge, `db push` e verificação

**Modelo:** Opus.

1. Com autorização de **merge**: mergear o PR 1 em `main` (dispara a Vercel sem mudança de bundle). Conferir o deploy READY.
2. Com autorização de **`db push`**: `supabase db push` a partir do `main` atualizado, depois de `supabase migration list` mostrar só a migration nova pendente. Se aparecer drift, parar. A migration tem `lock_timeout = '5s'`: se falhar com `55P03`, nada foi aplicado (BEGIN/COMMIT); repetir fora de pico.
3. Verificação somente leitura em produção (MCP `select`):
   - **antes do push**, `auth.role()` ainda lê `request.jwt.claims` (conferido em 2026-10-19); com a forma antiga, a Gestão inteira receberia `42501`;
   - o trigger `settings_write_role_guard` existe;
   - `has_function_privilege` é `false` para `anon`/`authenticated`/`service_role` nas duas funções;
   - `has_table_privilege('anon','public.settings','INSERT'|'UPDATE'|'DELETE'|'TRUNCATE')` e `('authenticated', …, 'TRUNCATE')` são `false`;
   - as policies de `settings` são idênticas às de antes.
4. Pedir ao usuário um teste manual: owner/gerente salva Ajustes de reserva e de fila na Gestão, e o platform_admin salva o Provedor de IA da unidade. Sem `42501`.
5. Rollback documentado no relatório: uma migration que faz `drop trigger if exists settings_write_role_guard on public.settings`.
6. Atualizar a memória `settings-escrita-por-chave` (entregue) e `agente-ia-cortes-fallback` (follow-up de `ai_config` fechado). Depois disso, a spec do Item 2 (Entrega B) pode começar.

## Bloco 3 — PR 2, hook de conversas (Task 5; independente)

### [x] Task 5 — `releaseToAI`/`markResolved` com escopo e confirmação

**Modelo:** Sonnet (implementação e review de spec); Opus no review de qualidade (escrita em `conversations`).

1. `git worktree add -b fix/conversations-release-unit-scope .claude/worktrees/conversations-release-scope origin/main`.
2. `src/hooks/useConversations.ts`: nos dois mutations, acrescentar `.eq("unit_id", unitId)` e `.select("id")`, e lançar `Error("Conversa não encontrada ou sem permissão.")` com zero linhas, igual ao `assumeConversation`. Como os dois corpos são idênticos (o comentário explica que "Resolver" é alias), extrair uma função local `releaseConversation(conversationId)` usada pelos dois. Os nomes públicos dos mutations ficam.
3. Teste no padrão do teste de hook já existente (procurar `useConversations*.test.tsx` ou `Conversas.*.test.tsx` e seguir o mock de supabase de lá): filtra `unit_id`, pede `select`, rejeita zero linhas, nos dois mutations.
4. Gates: o teste, `npm run typecheck`, `npm run lint`, `npm run test`.
5. Commit `fix(conversations): scope release/resolve to the unit and confirm the write`. Pedir autorização para push e PR. O merge em `main` publica na Vercel e também precisa de autorização.
6. Registrar em `.claude/rules/whatsapp.md` (Conversas), na mesma tarefa: "`conversations.assigned_to` aceita qualquer `auth.users.id` pelo grant de coluna; nenhum código o lê. Antes de usá-lo para decidir algo, fechar com trigger (`NULL` ou `auth.uid()`)." É o achado registrado para depois.

## Execução do Bloco 1 (2026-10-19)

- **Task 1** (`c8534c7`): pré-voo RED (exit 3 na guarda), depois 20/20 com a migration crua aplicada duas vezes, em PG 18.6 descartável. Reviews de spec (Sonnet) e de qualidade (Opus) sem bloqueante. Acréscimos do review: ramo do `role` GUC para papel de API sem claims, `lock_timeout = '5s'`, casos do escopo OLD (S2/S6/S7) e controle positivo em três partes por mutação do corpo instalado. Medido: `REVOKE` de tabela já limpa grant de coluna (o bloco `DO` é reforço). O `26` não foi reexecutado (exige a stack CLI e a cadeia 27–60; a linha de base já falha num contêiner avulso); no lugar, checagem focada em `supabase/postgres:17.11` com o guard legado e a RPC de manutenção reais (README §75).
- **Task 2** (`79c7a04`): paridade 22 = 22, 5/5; typecheck limpo; lint sem erro novo; suíte cheia com só a falha conhecida de CRLF e `OfficialConnectionCard.test.tsx`, que exige `VITE_*` ausentes no worktree (passa 16/16 com valores fictícios).
- **Task 3**: `migration-validator`, `rls-auditor` e `identity-access-auditor` em `PASS_WITH_WARNINGS`, zero bloqueantes. Do RLS entrou a correção da premissa de §4.1 (no INSERT o trigger roda antes do `WITH CHECK`) e a prova de recusa idêntica para unidade alheia e inexistente (EXTRA-2). Review da branch contra a spec: §4.2 e S1–S16 conferidos. Nada em `src/` nem em `supabase/functions/`. Guards estáticos (`function-acl-allowlist`, `advisor-divergence-core`, `migration-static-guard`) verdes. Push e PR autorizados: PR #42, com `acl-estatico` e Vercel verdes (`acl-com-banco` é manual e foi pulado). Não mergeado.
- **Follow-ups registrados, fora deste PR:** `FORCE RLS` em `settings` (medir `BYPASSRLS` do dono das RPCs públicas antes, como na 180000); revogar `SELECT` de anon e `REFERENCES`/`TRIGGER` de anon/authenticated; policies de `settings` com `(select …)`; `Conta.tsx:202` sem `isPlatformAdmin` em `canEdit` e DELETE de `restaurant_name` sem checar `error`; `.claude/rules/frontend.md` diz que a UI não escreve `restaurant_name`, mas ela o apaga; `manage-members` devolve `error.message` cru; o comentário da `20261017160000` diz que `REVOKE` de tabela não remove grant de coluna (medido: remove).

## Execução do Bloco 2 (2026-10-19)

- **Pré-voo (somente leitura, MCP):** `auth.role()` lê `request.jwt.claims`. O `schema_migrations` de produção é idêntico ao `origin/main` (180 versões). Retrato de antes: só o trigger `whatsapp_legacy_template_write`; policies `platform_admin_all_settings` e `unit_member_all_settings`; `anon` com `arwdDxtm`; RLS ligado, FORCE desligado.
- **Merge** autorizado: PR #42 → `main` `bc91673`. Vercel `success` no commit.
- **`db push`** autorizado, a partir de `bc91673`: o `migration list` mostrou só a `20261019180000` pendente; aplicada sem `55P03`.
- **Verificação (MCP `select`):**
  - a migration está registrada;
  - os triggers `settings_write_role_guard` e `whatsapp_legacy_template_write` estão habilitados;
  - `EXECUTE` é `false` para `anon`/`authenticated`/`service_role` nas duas funções, e o guard é `SECURITY DEFINER` com `search_path=""`;
  - `anon` não tem INSERT/UPDATE/DELETE/TRUNCATE nem grant de coluna; `authenticated` não tem TRUNCATE e mantém SELECT/INSERT/UPDATE/DELETE; `service_role` mantém INSERT;
  - as policies são idênticas às de antes, e RLS/FORCE seguem `true/false`;
  - o classificador devolve `ai_config`/`ai_system_prompt` → `platform` e `booking_window_days`/`restaurant_name` → `manager`.
- **Teste manual (item 4):** confirmado pelo usuário. Nos `edge_logs` aparecem três `POST /rest/v1/settings?on_conflict=unit_id,key` com 200 às 18:28 UTC, e não há `setting_write_forbidden` nos `postgres_logs` depois do push.
- **Rollback:** migration nova com `drop trigger if exists settings_write_role_guard on public.settings;`.

## Sequência de chats

- **Chat 1:** Bloco 1 (Tasks 1–3).
- **Chat 2:** Bloco 2 (Task 4), quando as autorizações vierem.
- **Bloco 3** pode rodar em qualquer chat, antes ou depois, porque não toca nos mesmos arquivos.

## Execução do Bloco 3 (2026-10-19)

- **Task 5** (branch `fix/conversations-release-unit-scope`, a partir de `origin/main` `bc91673`): `releaseConversation` local com `.eq("unit_id", unitId)` + `.select("id")` e recusa com zero linhas, usada por `releaseToAI` e `markResolved`. A UI já trata a recusa (`onError` com toast em `Conversas.tsx`).
- Teste `src/hooks/useConversations.release.test.tsx`, no mock do `assume`: RED 6/6 contra o hook antigo (sem filtro de unidade; zero linhas e erro resolviam), GREEN 6/6. Typecheck limpo; lint sem erro (só warnings antigos em outros arquivos); suíte cheia com as falhas conhecidas (CRLF do catálogo v2, `OfficialConnectionCard` sem `VITE_*`) e dois timeouts sob carga (`whatsapp-scheduled-templates-integration`, `whatsapp-waitlist-voucher-routing`) que passam isolados.
- Review de spec e de qualidade feitos pelo agente principal (Opus): diff pequeno, `assumeConversation` intocado, nomes públicos mantidos.
- Achado do `assigned_to` registrado em `.claude/rules/whatsapp.md` (Conversas); conferido que nenhum código de `src/` ou `supabase/functions/` o usa para decidir.
