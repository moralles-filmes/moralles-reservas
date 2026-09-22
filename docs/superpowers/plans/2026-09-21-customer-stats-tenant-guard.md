# Guard de tenant na `get_customer_stats` — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar a última entrada `authenticated` da allowlist sem guard de tenant — `public.get_customer_stats(uuid,uuid)` — resolvendo a organização a partir do próprio `customers` e recusando com `42501` quem não é membro dela.

**Architecture:** Uma migration `create or replace` troca a função de `language sql` para `plpgsql`, abre com `auth.uid()` e o par `app_private.is_org_member` / `app_private.is_platform_admin`, e mantém shape de retorno e aritmética idênticos. O pré-voo local prova o comportamento contra Postgres real, com controle positivo. O frontend ganha o ramo de erro que o `42501` torna alcançável.

**Tech Stack:** Postgres 18 local (scoop, sem Docker), `psql`, Supabase CLI (`db push`), Vite + React + TanStack Query, vitest + @testing-library/react (jsdom).

**Spec:** [docs/superpowers/specs/2026-09-21-customer-stats-tenant-guard-design.md](../specs/2026-09-21-customer-stats-tenant-guard-design.md)

## Global Constraints

- Branch: `customer-stats-tenant-guard`. Commit por task, `git add <caminho>` com escopo explícito — **nunca** `git add .` / `-A` / `git reset --hard`.
- Migration aplicada **somente** por `supabase db push`; nunca colar SQL no Studio. MCP Supabase é **leitura só** — nunca `apply_migration`, nunca DDL.
- Migration nova em `public` reafirma `revoke all on function <assinatura completa> from public, anon, authenticated;` antes de `grant execute ... to authenticated;`.
- Migration não embute segredo nem a URL do projeto Supabase.
- `CLAUDE.md` e `AGENTS.md` são par obrigatório: toda regra permanente atualiza os DOIS no MESMO commit.
- `npm run typecheck` é `tsc -b --noEmit` — **nunca** `tsc --noEmit` sem `-b`.
- `PGCLIENTENCODING=UTF8` é obrigatório para todo `psql` neste ambiente (Windows).
- Controle positivo (reintroduzir o defeito, ver o teste falhar, restaurar) é **critério de aceite**, não gentileza — há loja real em produção.
- Números do Advisor que não podem mudar: `0028=9 | 0029=14 | total=23`. O `_expected_advisor` de `scripts/function-acl-allowlist.json` **não muda** nesta frente.
- Nomes exatos das fixtures do harness (de `09a-advisor-bootstrap.sql`), para não reinventar:
  - membro gerente da org A: `11111111-1111-1111-1111-111111111111`
  - membro gerente da org B: `22222222-2222-2222-2222-222222222222`
  - usuário sem nenhuma membership: `33333333-3333-3333-3333-333333333333`
  - org A `aaaaaaaa-0000-0000-0000-000000000001` / org B `aaaaaaaa-0000-0000-0000-000000000002`
  - unidade A (pública) `bbbbbbbb-0000-0000-0000-000000000001` / unidade B (não pública) `bbbbbbbb-0000-0000-0000-000000000002`
  - cliente da org A `eeeeeeee-0000-0000-0000-000000000004` / cliente da org B `eeeeeeee-0000-0000-0000-000000000005`
- `auth.uid()` local (definido no `09a`) lê `request.jwt.claim.sub` **ou** `request.jwt.claims->>'sub'`, e `nullif(...,'')` faz string vazia virar NULL.
- `platform_admins` é `(user_id uuid primary key references auth.users(id) on delete cascade)`.
- Ordinais de `t_res` já ocupados: **1–16**. Esta frente usa **17–24** (casos) e **25–26** (controles). Ordinal casa com o número do NOME do caso, nunca com a ordem de execução.

---

### Task 1: Pré-voo `12` (o RED) e migration 108 (o GREEN)

**Files:**
- Create: `supabase/tests/local-preflight/12-customer-stats-108.sql`
- Create: `supabase/migrations/20260921120000_108_customer_stats_tenant_guard.sql`
- Modify: `supabase/tests/local-preflight/README.md` (tabela de arquivos, sequência do advisor, tabela de ordinais)

**Interfaces:**
- Consumes: as fixtures do `09a-advisor-bootstrap.sql` listadas em Global Constraints; a tabela `t_res (ord int primary key, caso text, veredito text)` criada pelo `09`; os helpers `app_private.is_org_member(uuid,uuid)` e `app_private.is_platform_admin(uuid)`, que existem em `app_private` porque a 106 já foi aplicada neste banco.
- Produces: `public.get_customer_stats(p_customer_id uuid, p_unit_id uuid default null)` em plpgsql, retornando `table(total integer, confirmed integer, no_shows integer, cancelled integer, no_show_rate numeric, last_visit date)` e levantando `42501` (`unauthenticated` sem sessão, `forbidden` sem direito). A Task 2 sabota e restaura esta mesma função; a Task 3 consome o `42501` pelo frontend.

- [ ] **Step 1: Subir o Postgres local e reconstruir o banco `advisor106` do zero até o estado pós-107**

Rodar a sequência do advisor do README, **inteira**, até a última linha (`11-overloads-107.sql` rodado depois da 107). O `12` mede o estado pós-106/107; rodá-lo contra um banco parcial mede outro mundo.

```bash
export PGCLIENTENCODING=UTF8
PG="$USERPROFILE/scoop/apps/postgresql/current/bin"
"$PG/pg_ctl.exe" -D "$USERPROFILE/scoop/apps/postgresql/current/data" \
  -l /tmp/pg.log -o "-p 55432" start
```

Depois a sequência de `### Sequência da migration 106 (advisor)` do
[README](../../../supabase/tests/local-preflight/README.md), sem pular o RED do `09`.

Esperado no fim: `select ord, caso, veredito from t_res order by ord;` → **16 linhas, todas OK**.

- [ ] **Step 2: Escrever `12-customer-stats-108.sql` — o teste que falha**

Cabeçalho, guard e fixtures próprias (as reservas **não existem** em nenhum arquivo do harness; sem elas todo agregado é zero e o controle positivo da Task 2 não distinguiria vazamento de "cliente sem reserva"):

```sql
-- STATS-1..STATS-8 (ordinais 17..24): guard de tenant da migration 108 em
-- `public.get_customer_stats(uuid,uuid)` contra Postgres real.
--
-- STATS-1/4/6 são o caminho de PERMITIR; STATS-2/3/5 o de NEGAR; STATS-7 a ACL e
-- STATS-8 a idempotência através de duas execuções. Guard só testado no allow
-- não notaria um `if not (...)` invertido nem `is_org_member` trocado por
-- `is_unit_member` — é o mesmo motivo pelo qual o `09` ganhou ACL-1b/3b/3c/3d.
--
-- Rodar depois de 00, 01, 09a, 106, 09 (2x), 10, 11, 107, 11 e da própria 108,
-- com ON_ERROR_STOP=1. Este arquivo é RODADO DUAS VEZES, com a 108 reaplicada no
-- meio — é assim que STATS-8 mede idempotência (ver o caso).
--
-- POR QUE OS HANDLERS `when others` GRAVAM COM `on conflict (ord) do update`:
-- o `delete from t_res where ord = N` do início de cada caso é DESFEITO pelo
-- próprio `exception` que o handler trata (em plpgsql o handler roda depois do
-- rollback da subtransação). Na 2a passada, caso que estoura tentaria INSERIR
-- ordinal que a 1a já gravou e morreria com chave duplicada — o que sob
-- ON_ERROR_STOP=1 aborta o arquivo e apaga justamente os vereditos de quem
-- precisa deles. Mesma razão documentada no `09`.

-- ─── GUARDA: este arquivo só faz sentido DEPOIS da 108 ──────────────────────
-- Rodado antes, STATS-2/3/5 reprovariam (é o RED que dá sentido ao GREEN) mas
-- STATS-1/6/7 passariam medindo o mundo pré-migration, e STATS-8 gravaria um
-- snapshot do corpo SEM guard contra o qual a 1a passada de verdade reprovaria.
-- Melhor recusar explicitamente, como o `09` faz.
do $$
begin
  if to_regprocedure('public.get_customer_stats(uuid,uuid)') is null then
    raise exception '12-customer-stats-108.sql exige 09a-advisor-bootstrap.sql aplicado antes (public.get_customer_stats(uuid,uuid) ausente). Sequencia do README: 00 -> 01 -> 09a -> 106 -> 09 -> 10 -> 11 -> 107 -> 11 -> 108 -> 12.';
  end if;
  if pg_get_functiondef('public.get_customer_stats(uuid,uuid)'::regprocedure) not like '%is_org_member%' then
    raise exception '12-customer-stats-108.sql exige a migration 108 aplicada (o corpo de public.get_customer_stats nao chama is_org_member, ou seja, nao tem guard de tenant). Este arquivo mede o estado DEPOIS do guard; rodado antes, metade dos casos reportaria OK sobre o mundo pre-migration. Aplique supabase/migrations/20260921120000_108_customer_stats_tenant_guard.sql e rode de novo.';
  end if;
end $$;

create table if not exists t_res (ord int primary key, caso text, veredito text);

-- Snapshot que atravessa as duas execuções (mesmo motivo do t_acl_snap do `09`:
-- duas leituras dentro de um único `do $$` compararia o estado consigo mesmo).
create table if not exists t_stats_snap (ord int primary key, def_md5 text, acl text);

-- ─── Fixtures próprias deste arquivo ────────────────────────────────────────
-- Moram AQUI e não no `09a` por duas razões: (1) o `09a` é compartilhado com os
-- casos 1–16, que já rodaram quando este arquivo entra, e mexer nele arriscaria
-- mudar o que eles mediram; (2) a segunda unidade da org A é **não pública** de
-- propósito — os casos do `09` resolvem a unidade por `where is_public limit 1`
-- e uma segunda unidade pública tornaria aquela escolha não-determinística.
insert into auth.users (id, email) values
  ('44444444-4444-4444-4444-444444444444', 'platform-admin@teste.local')
on conflict do nothing;

insert into platform_admins (user_id) values
  ('44444444-4444-4444-4444-444444444444')
on conflict do nothing;

insert into units (id, organization_id, name, slug, is_public) values
  ('bbbbbbbb-0000-0000-0000-000000000003',
   'aaaaaaaa-0000-0000-0000-000000000001', 'Unidade Advisor A2', 'unidade-advisor-a2', false)
on conflict (id) do nothing;

-- Reservas: o harness não tinha NENHUMA. Os números da org A e da org B são
-- diferentes de propósito — é o que faz o vazamento do CONTROLE-25 ser
-- inconfundível em vez de parecer "cliente sem reserva".
insert into reservations (id, unit_id, customer_id, status, party_size, date, time, reservation_code) values
  -- Cliente da org A, na unidade A: 2 confirmed, 1 no_show, 1 cancelled
  ('dddddddd-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000004','confirmed',2,'2026-09-01','19:00','STATSA1'),
  ('dddddddd-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000004','confirmed',2,'2026-09-05','19:00','STATSA2'),
  ('dddddddd-0000-0000-0000-000000000003','bbbbbbbb-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000004','no_show',  2,'2026-09-03','19:00','STATSA3'),
  ('dddddddd-0000-0000-0000-000000000004','bbbbbbbb-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000004','cancelled',2,'2026-09-07','19:00','STATSA4'),
  -- Mesmo cliente, na SEGUNDA unidade da org A: só entra no agregado de ORG.
  -- Sem esta linha, STATS-6 (`p_unit_id => null`) seria tautologia.
  ('dddddddd-0000-0000-0000-000000000005','bbbbbbbb-0000-0000-0000-000000000003','eeeeeeee-0000-0000-0000-000000000004','confirmed',2,'2026-09-09','19:00','STATSA5'),
  -- Cliente da org B: 3 confirmed, nenhum no_show, nenhum cancelled.
  ('dddddddd-0000-0000-0000-000000000006','bbbbbbbb-0000-0000-0000-000000000002','eeeeeeee-0000-0000-0000-000000000005','confirmed',4,'2026-09-02','20:00','STATSB1'),
  ('dddddddd-0000-0000-0000-000000000007','bbbbbbbb-0000-0000-0000-000000000002','eeeeeeee-0000-0000-0000-000000000005','confirmed',4,'2026-09-04','20:00','STATSB2'),
  ('dddddddd-0000-0000-0000-000000000008','bbbbbbbb-0000-0000-0000-000000000002','eeeeeeee-0000-0000-0000-000000000005','confirmed',4,'2026-09-06','20:00','STATSB3')
on conflict (id) do nothing;
```

Números esperados do cliente da org A, derivados das fixtures acima:

| escopo | total | confirmed | no_shows | cancelled | no_show_rate | last_visit |
|---|---|---|---|---|---|---|
| `p_unit_id` = unidade A | 4 | 2 | 1 | 1 | `round(1/3,3)` = 0.333 | 2026-09-05 |
| `p_unit_id` = null (org) | 5 | 3 | 1 | 1 | `round(1/4,3)` = 0.250 | 2026-09-09 |

- [ ] **Step 3: Escrever os oito casos no mesmo arquivo**

```sql
-- ─── STATS-1: membro da org lê o próprio cliente e os números batem ─────────
do $$
declare v_membro_a uuid := '11111111-1111-1111-1111-111111111111';
        v_unit_a   uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_cust_a   uuid := 'eeeeeeee-0000-0000-0000-000000000004';
        r record;
begin
  delete from t_res where ord = 17;
  perform set_config('request.jwt.claims', json_build_object('sub', v_membro_a)::text, true);
  set local role authenticated;
  select * into r from get_customer_stats(v_cust_a, v_unit_a);
  reset role;

  insert into t_res values (17, 'STATS-1 membro le o proprio cliente com os numeros certos',
    case
      when r.total = 4 and r.confirmed = 2 and r.no_shows = 1 and r.cancelled = 1
       and r.no_show_rate = 0.333 and r.last_visit = date '2026-09-05'
        then 'OK (4/2/1/1, taxa 0.333, ultima 2026-09-05)'
      else 'FALHOU (veio total=' || coalesce(r.total::text,'null')
             || ' conf=' || coalesce(r.confirmed::text,'null')
             || ' ns='   || coalesce(r.no_shows::text,'null')
             || ' canc=' || coalesce(r.cancelled::text,'null')
             || ' taxa=' || coalesce(r.no_show_rate::text,'null')
             || ' ult='  || coalesce(r.last_visit::text,'null') || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (17, 'STATS-1 membro le o proprio cliente com os numeros certos', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── STATS-2: membro da org A pedindo cliente da org B é RECUSADO ───────────
-- O caso mais valioso: guard quebrado aqui não estoura, VAZA DADO de outro
-- tenant. Captura `insufficient_privilege` ESPECIFICAMENTE (não `when others`):
-- recusa e zeros são resultados diferentes, e um `when others` confundiria os
-- dois com qualquer outro erro. O contra-caso é o STATS-1, que chama a mesma
-- função como membro e recebe linha — "recusou" aqui não é "está quebrada".
do $$
declare v_membro_a uuid := '11111111-1111-1111-1111-111111111111';
        v_unit_a   uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_cust_b   uuid := 'eeeeeeee-0000-0000-0000-000000000005';
        v_total int; v_recusou boolean := false; v_err text;
begin
  delete from t_res where ord = 18;
  perform set_config('request.jwt.claims', json_build_object('sub', v_membro_a)::text, true);
  set local role authenticated;
  begin
    select total into v_total from get_customer_stats(v_cust_b, v_unit_a);
  exception when insufficient_privilege then
    v_recusou := true;
    get stacked diagnostics v_err = message_text;
  end;
  reset role;

  insert into t_res values (18, 'STATS-2 membro da org A nao le cliente da org B',
    case
      when v_recusou then 'OK (raise 42501 "' || v_err || '")'
      else 'FALHOU (nao recusou: devolveu total=' || coalesce(v_total::text,'null') || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (18, 'STATS-2 membro da org A nao le cliente da org B', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── STATS-3: sem sessão é RECUSADO ────────────────────────────────────────
-- `request.jwt.claims` em string vazia: o `auth.uid()` do `09a` faz
-- `nullif(...,'')`, então isso é exatamente "sem sessão".
do $$
declare v_unit_a uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_cust_a uuid := 'eeeeeeee-0000-0000-0000-000000000004';
        v_total int; v_recusou boolean := false; v_err text;
begin
  delete from t_res where ord = 19;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  set local role authenticated;
  begin
    select total into v_total from get_customer_stats(v_cust_a, v_unit_a);
  exception when insufficient_privilege then
    v_recusou := true;
    get stacked diagnostics v_err = message_text;
  end;
  reset role;

  insert into t_res values (19, 'STATS-3 sem sessao e recusado, nao devolve zeros',
    case
      when v_recusou then 'OK (raise 42501 "' || v_err || '")'
      else 'FALHOU (nao recusou: devolveu total=' || coalesce(v_total::text,'null') || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (19, 'STATS-3 sem sessao e recusado, nao devolve zeros', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── STATS-4: platform_admin SEM linha em unit_members passa ───────────────
-- Este é o caso que o paralelo `is_platform_admin` existe para cobrir:
-- `useCurrentUnit` fabrica pseudo-membership "owner" para super-admin operar
-- unidade alheia, e no banco não há linha em `unit_members` nenhuma.
do $$
declare v_admin  uuid := '44444444-4444-4444-4444-444444444444';
        v_unit_a uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_cust_a uuid := 'eeeeeeee-0000-0000-0000-000000000004';
        v_total int; v_membro boolean;
begin
  delete from t_res where ord = 20;
  select exists (select 1 from unit_members where user_id = v_admin) into v_membro;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  set local role authenticated;
  select total into v_total from get_customer_stats(v_cust_a, v_unit_a);
  reset role;

  insert into t_res values (20, 'STATS-4 platform_admin sem unit_members passa',
    case
      when v_membro then 'FALHOU (fixture invalida: o admin tem linha em unit_members, o caso nao mede o ramo is_platform_admin)'
      when v_total = 4 then 'OK (total=4 sem nenhuma linha em unit_members)'
      else 'FALHOU (esperado total=4, veio ' || coalesce(v_total::text,'null') || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (20, 'STATS-4 platform_admin sem unit_members passa', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── STATS-5: id inexistente cai no MESMO ramo do proibido ─────────────────
-- Sem isto, a recusa seria oráculo de existência: "42501" para cliente alheio e
-- "linha de zeros" para id inexistente diria ao atacante quais UUIDs existem.
do $$
declare v_membro_a uuid := '11111111-1111-1111-1111-111111111111';
        v_unit_a   uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_fantasma uuid := '99999999-9999-9999-9999-999999999999';
        v_total int; v_recusou boolean := false; v_err text;
begin
  delete from t_res where ord = 21;
  perform set_config('request.jwt.claims', json_build_object('sub', v_membro_a)::text, true);
  set local role authenticated;
  begin
    select total into v_total from get_customer_stats(v_fantasma, v_unit_a);
  exception when insufficient_privilege then
    v_recusou := true;
    get stacked diagnostics v_err = message_text;
  end;
  reset role;

  insert into t_res values (21, 'STATS-5 id inexistente recusa igual a cliente alheio (sem oraculo)',
    case
      when v_recusou and v_err = 'forbidden' then 'OK (mesma mensagem "forbidden" do STATS-2)'
      when v_recusou then 'FALHOU (recusou com mensagem DIFERENTE do STATS-2: "' || v_err || '" — vira oraculo de existencia)'
      else 'FALHOU (nao recusou: devolveu total=' || coalesce(v_total::text,'null') || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (21, 'STATS-5 id inexistente recusa igual a cliente alheio (sem oraculo)', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── STATS-6: `p_unit_id => null` continua sendo o agregado da ORG ─────────
-- O guard não estreitou a semântica: null segue significando "toda unidade da
-- org do cliente". A asserção é sobre a DIFERENÇA (5 na org, 4 na unidade) —
-- sem a reserva da segunda unidade nas fixtures isto seria tautologia.
do $$
declare v_membro_a uuid := '11111111-1111-1111-1111-111111111111';
        v_unit_a   uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_cust_a   uuid := 'eeeeeeee-0000-0000-0000-000000000004';
        v_org int; v_unidade int; v_ult date;
begin
  delete from t_res where ord = 22;
  perform set_config('request.jwt.claims', json_build_object('sub', v_membro_a)::text, true);
  set local role authenticated;
  select total            into v_org     from get_customer_stats(v_cust_a, null);
  select last_visit       into v_ult     from get_customer_stats(v_cust_a, null);
  select total            into v_unidade from get_customer_stats(v_cust_a, v_unit_a);
  reset role;

  insert into t_res values (22, 'STATS-6 p_unit_id null segue agregando a org inteira',
    case
      when v_org = 5 and v_unidade = 4 and v_ult = date '2026-09-09'
        then 'OK (org=5, unidade=4, ultima da org 2026-09-09)'
      else 'FALHOU (esperado org=5/unidade=4/ult=2026-09-09, veio org='
             || coalesce(v_org::text,'null') || '/unidade=' || coalesce(v_unidade::text,'null')
             || '/ult=' || coalesce(v_ult::text,'null') || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (22, 'STATS-6 p_unit_id null segue agregando a org inteira', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── STATS-7: ACL — `authenticated` executa, `anon` e `public` não ─────────
do $$
declare v_auth boolean; v_anon boolean; v_pub boolean;
begin
  delete from t_res where ord = 23;
  select has_function_privilege('authenticated', 'public.get_customer_stats(uuid,uuid)', 'EXECUTE') into v_auth;
  select has_function_privilege('anon',          'public.get_customer_stats(uuid,uuid)', 'EXECUTE') into v_anon;
  select coalesce(
           (select true from aclexplode(p.proacl) a
              where a.grantee = 0 and a.privilege_type = 'EXECUTE' limit 1), false)
    into v_pub
    from pg_proc p where p.oid = 'public.get_customer_stats(uuid,uuid)'::regprocedure;

  insert into t_res values (23, 'STATS-7 ACL: authenticated executa, anon e PUBLIC nao',
    case
      when v_auth and not v_anon and not v_pub then 'OK (authenticated=t, anon=f, PUBLIC=f)'
      else 'FALHOU (authenticated=' || v_auth || ', anon=' || v_anon || ', PUBLIC=' || v_pub || ')'
    end);
exception when others then
  insert into t_res values (23, 'STATS-7 ACL: authenticated executa, anon e PUBLIC nao', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── STATS-8: idempotência medida ATRAVÉS DE DUAS EXECUÇÕES ────────────────
-- A 1a passada grava corpo e ACL em t_stats_snap; a 2a compara. Reaplicar a 108
-- no meio é o que está sendo medido — duas leituras num único `do $$` veriam o
-- mesmo estado e não mediriam nada. Mesmo desenho do ACL-5 no `09`.
do $$
declare v_def_md5 text; v_acl text; s record;
begin
  delete from t_res where ord = 24;
  select md5(pg_get_functiondef(p.oid)), coalesce(p.proacl::text, '<null>')
    into v_def_md5, v_acl
    from pg_proc p where p.oid = 'public.get_customer_stats(uuid,uuid)'::regprocedure;

  select * into s from t_stats_snap where ord = 24;
  if s is null then
    insert into t_stats_snap values (24, v_def_md5, v_acl);
    insert into t_res values (24, 'STATS-8 reaplicar a 108 nao muda corpo nem ACL',
      'OK (1a passada: snapshot gravado, corpo md5 ' || left(v_def_md5, 8) || ', acl ' || v_acl || ')');
  elsif s.def_md5 = v_def_md5 and s.acl = v_acl then
    insert into t_res values (24, 'STATS-8 reaplicar a 108 nao muda corpo nem ACL',
      'OK (2a passada: corpo e ACL identicos ao snapshot)');
  else
    insert into t_res values (24, 'STATS-8 reaplicar a 108 nao muda corpo nem ACL',
      'FALHOU (mudou: corpo ' || left(s.def_md5,8) || '->' || left(v_def_md5,8)
        || ', acl ' || s.acl || ' -> ' || v_acl || ')');
  end if;
exception when others then
  insert into t_res values (24, 'STATS-8 reaplicar a 108 nao muda corpo nem ACL', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;
```

- [ ] **Step 4: Rodar o `12` ANTES da migration e ver o RED**

```bash
P -f supabase/tests/local-preflight/12-customer-stats-108.sql
```

Esperado: **ERROR**, com a mensagem `... exige a migration 108 aplicada (o corpo de public.get_customer_stats nao chama is_org_member ...)`. Se o arquivo rodar inteiro e gravar OKs, o guard do topo está errado — conserte antes de seguir.

- [ ] **Step 5: Escrever a migration 108**

`supabase/migrations/20260921120000_108_customer_stats_tenant_guard.sql`:

```sql
-- 108 — guard de tenant em public.get_customer_stats(uuid, uuid)
--
-- Era a única entrada `authenticated` de scripts/function-acl-allowlist.json sem
-- guard interno: SECURITY DEFINER, exposta pelo PostgREST e sem `auth.uid()` em
-- lugar nenhum. Qualquer usuário logado — inclusive sem nenhuma membership —
-- lia estatística de cliente de qualquer organização, e com `p_unit_id => null`
-- o filtro de unidade era pulado e o agregado cobria toda unidade de toda org.
-- A 107 dropou o irmão de 1 argumento, que era pior; este ficou para esta
-- migration.
--
-- O TENANT VEM DO PRÓPRIO RECURSO: a organização sai de `customers` pelo
-- `p_customer_id`, nunca do `p_unit_id`, que é parâmetro do chamador. `customers`
-- pertence à ORGANIZATION (o cliente reserva em qualquer unidade da rede), então
-- o guard é `is_org_member` — não `is_unit_member` — com o paralelo obrigatório
-- `is_platform_admin`, que opera com pseudo-membership fabricada pelo
-- `useCurrentUnit` e não tem linha em `unit_members`. Mesmo padrão da irmã
-- `get_customer_stats_bulk`.
--
-- Estreitar o grant não resolveria: `authenticated` é o único papel Postgres que
-- significa "logado", e todo chamador legítimo também é só `authenticated`.
--
-- `p_unit_id` SEGUE aceitando null, com o mesmo significado de antes (agregado
-- da org). O guard de org já fecha o buraco, e a irmã já expõe `total_org` a
-- qualquer membro da org.
--
-- Recusa com 42501 em vez de devolver zeros: é o padrão de guard de RPC deste
-- repo (`enter_waitlist`, `get_undelivered_notifications`) e deixa rastro no log.
-- Cliente inexistente e cliente alheio caem no MESMO ramo — a recusa não é
-- oráculo de existência.
--
-- Nada sai de `public` e o grant a `authenticated` fica: o Advisor segue
-- 0028=9 | 0029=14 | total=23.
--
-- Verificado no pré-voo: supabase/tests/local-preflight/12-customer-stats-108.sql
-- (STATS-1..8) e 13-controles-108.sql (CONTROLE-25/26).

create or replace function public.get_customer_stats(
  p_customer_id uuid,
  p_unit_id uuid default null
)
returns table (total integer, confirmed integer, no_shows integer,
               cancelled integer, no_show_rate numeric, last_visit date)
language plpgsql
stable
security definer
set search_path = 'public', 'app_private', 'pg_temp'
as $$
declare
  v_caller uuid := auth.uid();
  v_org    uuid;
begin
  if v_caller is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  -- O tenant vem do PRÓPRIO recurso, nunca do p_unit_id que o chamador mandou.
  select c.organization_id into v_org
    from public.customers c
   where c.id = p_customer_id;

  -- Cliente inexistente e cliente alheio caem no MESMO ramo: sem oráculo.
  if v_org is null
     or not (app_private.is_platform_admin(v_caller)
             or app_private.is_org_member(v_caller, v_org)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Os aliases `a_*` não são estilo: `total`, `confirmed`, `cancelled` e
  -- `last_visit` são variáveis OUT do `returns table`, e referência nua a esses
  -- nomes dentro da query estoura ambígua em tempo de execução. A aritmética é
  -- a de antes, incluindo o `0::numeric` com denominador zero (a irmã devolve
  -- null ali; alinhar seria mudança de comportamento sem pedido).
  return query
  with r as (
    select res.status, res.date
      from public.reservations res
     where res.customer_id = p_customer_id
       and (p_unit_id is null or res.unit_id = p_unit_id)
  ),
  agg as (
    select count(*)::int                                                 as a_total,
           count(*) filter (where r.status = 'confirmed')::int           as a_confirmed,
           count(*) filter (where r.status = 'no_show')::int             as a_no_shows,
           count(*) filter (where r.status = 'cancelled')::int           as a_cancelled,
           max(r.date) filter (where r.status in ('confirmed','no_show')) as a_last_visit
      from r
  )
  select agg.a_total, agg.a_confirmed, agg.a_no_shows, agg.a_cancelled,
         case when (agg.a_confirmed + agg.a_no_shows) > 0
              then round(agg.a_no_shows::numeric
                         / (agg.a_confirmed + agg.a_no_shows), 3)
              else 0::numeric end,
         agg.a_last_visit
    from agg;
end;
$$;

-- `create or replace` preserva `proacl`, mas reafirmar mantém a migration
-- correta se a função tiver sido dropada e recriada no caminho — recriar concede
-- EXECUTE a PUBLIC por default nesta plataforma (medido; ver docs/hotfix-acl/).
revoke all on function public.get_customer_stats(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_customer_stats(uuid, uuid) to authenticated;

comment on function public.get_customer_stats(uuid, uuid) is
  'Ficha do cliente no painel. Guard de tenant: a organização é resolvida a partir de customers pelo p_customer_id (nunca do p_unit_id, que é parâmetro do chamador) e exige app_private.is_org_member ou app_private.is_platform_admin; recusa com 42501. Migration 108.';
```

- [ ] **Step 6: Aplicar a 108 no banco local e rodar o `12` — a 1a passada**

```bash
P -f supabase/migrations/20260921120000_108_customer_stats_tenant_guard.sql
P -f supabase/tests/local-preflight/12-customer-stats-108.sql
```

Esperado: sem erro, e `select ord, caso, veredito from t_res where ord between 17 and 24 order by ord;` → **8 linhas, todas começando com `OK`**. O ordinal 24 deve dizer `1a passada: snapshot gravado`.

Se STATS-1 vier `FALHOU: column reference "total" is ambiguous`, os aliases `a_*` foram perdidos na transcrição — é exatamente o erro que eles previnem.

- [ ] **Step 7: Reaplicar a 108 e rodar o `12` — a 2a passada (idempotência)**

```bash
P -f supabase/migrations/20260921120000_108_customer_stats_tenant_guard.sql
P -f supabase/tests/local-preflight/12-customer-stats-108.sql
```

Esperado: 8 linhas OK de novo, e o ordinal 24 agora dizendo `2a passada: corpo e ACL identicos ao snapshot`.

- [ ] **Step 8: Atualizar o README do harness**

Três lugares, todos em `supabase/tests/local-preflight/README.md`:

1. Na tabela "Os arquivos", duas linhas novas depois da do `11-overloads-107.sql`:

```markdown
| `12-customer-stats-108.sql` | STATS-1..8 (migration 108): o guard de tenant da `get_customer_stats`. Permitir (membro, `platform_admin` sem linha em `unit_members`, `p_unit_id => null` seguindo agregado de org) e negar (cliente de outra org, sem sessão, id inexistente caindo no MESMO ramo do proibido — senão a recusa vira oráculo de existência), mais ACL e idempotência através de duas execuções. Traz as **reservas**, que nenhum arquivo do harness tinha: sem elas todo agregado é zero e o controle positivo não distinguiria vazamento de "cliente sem reserva". A segunda unidade da org A nasce **não pública** de propósito — os casos do `09` resolvem a unidade por `where is_public limit 1`. |
| `13-controles-108.sql` | Os **dois controles positivos** da 108. CONTROLE-25 neutraliza só o `raise` de `forbidden` (delta mínimo sobre `pg_get_functiondef`) e vê o agregado da org B chegar ao membro da org A; CONTROLE-26 repõe o corpo `language sql` pré-108 inteiro e vê as DUAS regressões de uma vez — o vazamento cross-org e a chamada sem sessão devolvendo zeros em vez de `42501`. Reaplicar a 108 restaura, como no CONTROLE-6. |
```

2. Ao fim do bloco `bash` da "Sequência da migration 106 (advisor)", depois do segundo `11-overloads-107.sql`:

```bash
# ── Migration 108: guard de tenant na get_customer_stats ───────────────────
# ANTES da migration, o 12 tem de FALHAR pelo guard do topo do arquivo
# (`o corpo de public.get_customer_stats nao chama is_org_member`). É o RED que
# dá sentido ao GREEN, e é explícito pelo mesmo motivo do guard do `09`: sem ele
# STATS-1/6/7 passariam medindo o mundo pré-migration e STATS-8 gravaria um
# snapshot do corpo SEM guard.
P -f supabase/tests/local-preflight/12-customer-stats-108.sql   # esperado: ERROR

P -f supabase/migrations/20260921120000_108_customer_stats_tenant_guard.sql
P -f supabase/tests/local-preflight/12-customer-stats-108.sql   # 1a passada
# STATS-8 mede idempotência ATRAVÉS DE DUAS EXECUÇÕES, igual ao ACL-5:
P -f supabase/migrations/20260921120000_108_customer_stats_tenant_guard.sql
P -f supabase/tests/local-preflight/12-customer-stats-108.sql   # 2a passada

"$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d advisor106 \
  -f supabase/tests/local-preflight/13-controles-108.sql   # SEM ON_ERROR_STOP
# O 13 sabota o CORPO da get_customer_stats de propósito, e a 108 DEFINE o corpo
# (diferente da 106, que só move helpers) — então reaplicar restaura:
P -f supabase/migrations/20260921120000_108_customer_stats_tenant_guard.sql

P -c "select ord, caso, veredito from t_res order by ord;"   # 26 linhas, todas OK
```

3. Na tabela de ordinais, duas linhas novas:

```markdown
| 17–24 | `STATS-1` .. `STATS-8` | `12` |
| 25, 26 | `CONTROLE-25`, `CONTROLE-26` | `13` |
```

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/20260921120000_108_customer_stats_tenant_guard.sql \
        supabase/tests/local-preflight/12-customer-stats-108.sql \
        supabase/tests/local-preflight/README.md
git commit -F <mensagem>
```

Mensagem: assunto `feat(108): guard de tenant na get_customer_stats, resolvido pelo próprio recurso`; corpo dizendo que o tenant sai de `customers` pelo `p_customer_id` e nunca do `p_unit_id`; que recusa com `42501` e que inexistente e alheio compartilham o ramo; que o Advisor segue 23; e os 8 casos verdes com as duas passadas. Terminar com `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

### Task 2: Controles positivos da 108

**Files:**
- Create: `supabase/tests/local-preflight/13-controles-108.sql`

**Interfaces:**
- Consumes: `public.get_customer_stats(uuid,uuid)` já guardada pela 108 (Task 1); as fixtures e as reservas criadas pelo `12`; `t_res`.
- Produces: nada que outra task consuma. Este arquivo sabota e a reaplicação da 108 restaura.

- [ ] **Step 1: Escrever `13-controles-108.sql`**

```sql
-- DOIS CONTROLES POSITIVOS da migration 108 — ordinais 25 e 26.
--
-- Rodar SEM ON_ERROR_STOP: os casos sabotam de propósito.
--
-- Sem eles, "STATS-2 passou" não distingue a guarda funcionando de teste sem
-- força:
--   CONTROLE-25  neutraliza SÓ o `raise` de `forbidden`, com delta mínimo sobre
--                `pg_get_functiondef`, e vê o agregado da org B chegar ao membro
--                da org A. É o defeito central desta migration.
--   CONTROLE-26  repõe o corpo `language sql` pré-108 INTEIRO e vê as DUAS
--                regressões de uma vez: o vazamento cross-org e a chamada sem
--                sessão devolvendo linha de zeros em vez de 42501. Mede que é a
--                estrutura toda que fecha, não só a linha do `if`.
--
-- Este arquivo depende das RESERVAS que o `12` cria. Sem elas o agregado da org
-- B seria zero e "vazou" ficaria indistinguível de "cliente sem reserva" — o
-- controle pareceria verde medindo nada.
--
-- RESTORE: a 108 DEFINE o corpo (diferente da 106, que só move helpers), então
-- reaplicar a migration restaura as duas sabotagens. É o que o README manda
-- fazer depois deste arquivo.
do $$
begin
  if not exists (select 1 from reservations
                  where customer_id = 'eeeeeeee-0000-0000-0000-000000000005') then
    raise exception '13-controles-108.sql exige as reservas criadas por 12-customer-stats-108.sql (o cliente da org B nao tem nenhuma). Sem elas o vazamento seria indistinguivel de cliente sem reserva e o controle ficaria verde medindo nada.';
  end if;
end $$;

-- ═══ CONTROLE-25 — sem o raise do guard, o agregado de outra org vaza ═══════
--
-- CORREÇÃO NA EXECUÇÃO: este plano descrevia a sabotagem como trocar
-- `if v_org is null` por `if false and v_org is null`. Isso NÃO neutraliza nada,
-- e foi medido: `and` liga mais forte que `or`, então a condição vira
-- `(false and v_org is null) or not (is_platform_admin or is_org_member)`, e o
-- segundo disjunto continua verdadeiro para membro da org A pedindo cliente da
-- org B — o raise dispararia igual e o controle ficaria VERDE tendo sabotado
-- coisa nenhuma. A sabotagem certa é trocar o `raise` de `forbidden` por
-- `null;`: neutraliza o ramo inteiro sem tocar em precedência e deixa o ramo
-- `unauthenticated` intacto.
--
-- Duas coisas fazem este controle medir de fato:
--   1. A definição sabotada é construída a partir de `pg_get_functiondef`, não
--      redigitada: assinatura, DEFAULTs, volatilidade, modo de segurança e
--      search_path vêm do banco, e o ÚNICO delta é o `raise`. Mesmo método do
--      CONTROLE-6. O caso confere que o `replace` mudou o texto — sabotagem que
--      não sabota é o modo silencioso de um controle positivo mentir.
--   2. A asserção é sobre o NÚMERO que voltou (3, da org B), não sobre "não
--      estourou": um guard quebrado aqui vaza dado, não erro.
do $ctrl$
declare v_def text; v_sab text;
        v_membro_a uuid := '11111111-1111-1111-1111-111111111111';
        v_cust_b uuid := 'eeeeeeee-0000-0000-0000-000000000005';
        v_total int;
begin
  delete from t_res where ord = 25;

  v_def := pg_get_functiondef('public.get_customer_stats(uuid,uuid)'::regprocedure);
  v_sab := replace(v_def,
                   'raise exception ''forbidden'' using errcode = ''42501'';',
                   'null;');

  if v_sab = v_def then
    insert into t_res values (25, 'CONTROLE-25 sem o raise do guard, o agregado de outra org vaza',
      'FALHOU (o replace nao mudou nada: a 108 nao esta aplicada ou o corpo mudou)');
    return;
  end if;

  execute v_sab;

  perform set_config('request.jwt.claims', json_build_object('sub', v_membro_a)::text, true);
  set local role authenticated;
  select total into v_total from get_customer_stats(v_cust_b, null);
  reset role;

  insert into t_res values (25, 'CONTROLE-25 sem o raise do guard, o agregado de outra org vaza',
    case
      when v_total = 3 then 'OK (vazou total=3 da org B para membro da org A — o guard do STATS-2 tem forca)'
      else 'FALHOU (sabotado e ainda assim nao vazou: total=' || coalesce(v_total::text,'null')
             || '; o STATS-2 pode estar passando por outro motivo)'
    end);
exception when others then
  reset role;
  insert into t_res values (25, 'CONTROLE-25 sem o raise do guard, o agregado de outra org vaza', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ CONTROLE-26 — repõe o corpo pré-108 e vê as DUAS regressões ═══════════
--
-- Este é o corpo que estava em produção até a 108, transcrito da forma como o
-- `09a-advisor-bootstrap.sql` o extraiu. Repô-lo mede o que a migration inteira
-- fecha — não só a linha do `if`: sem sessão, o corpo antigo devolve uma LINHA
-- DE ZEROS em vez de recusar, porque `count(*)` sobre conjunto vazio sempre
-- produz linha.
do $$
declare v_membro_a uuid := '11111111-1111-1111-1111-111111111111';
        v_cust_b   uuid := 'eeeeeeee-0000-0000-0000-000000000005';
        v_unit_a   uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_cust_a   uuid := 'eeeeeeee-0000-0000-0000-000000000004';
        v_vazou int; v_sem_sessao int; v_recusou boolean := false;
begin
  delete from t_res where ord = 26;

  create or replace function public.get_customer_stats(p_customer_id uuid, p_unit_id uuid default null)
  returns table(total integer, confirmed integer, no_shows integer,
                cancelled integer, no_show_rate numeric, last_visit date)
  language sql stable security definer set search_path to 'public'
  as $body$
    with r as (
      select status, date from reservations
      where customer_id = p_customer_id and (p_unit_id is null or unit_id = p_unit_id)
    ),
    agg as (
      select count(*)::int as total,
        count(*) filter (where status = 'confirmed')::int as confirmed,
        count(*) filter (where status = 'no_show')::int as no_shows,
        count(*) filter (where status = 'cancelled')::int as cancelled,
        max(date) filter (where status in ('confirmed', 'no_show')) as last_visit
      from r
    )
    select total, confirmed, no_shows, cancelled,
      case when (confirmed + no_shows) > 0 then round(no_shows::numeric / (confirmed + no_shows), 3) else 0::numeric end,
      last_visit
    from agg;
  $body$;

  -- Regressão 1: tenant cruzado vaza.
  perform set_config('request.jwt.claims', json_build_object('sub', v_membro_a)::text, true);
  set local role authenticated;
  select total into v_vazou from get_customer_stats(v_cust_b, null);
  reset role;

  -- Regressão 2: sem sessão devolve zeros em vez de recusar.
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  set local role authenticated;
  begin
    select total into v_sem_sessao from get_customer_stats(v_cust_a, v_unit_a);
  exception when insufficient_privilege then
    v_recusou := true;
  end;
  reset role;

  insert into t_res values (26, 'CONTROLE-26 corpo pre-108 volta a vazar e a nao recusar sem sessao',
    case
      when v_vazou = 3 and not v_recusou and v_sem_sessao = 4
        then 'OK (vazou total=3 da org B, e sem sessao devolveu 4 em vez de 42501)'
      else 'FALHOU (esperado vazou=3 e sem_sessao=4 sem recusa; veio vazou='
             || coalesce(v_vazou::text,'null') || ', recusou=' || v_recusou
             || ', sem_sessao=' || coalesce(v_sem_sessao::text,'null') || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (26, 'CONTROLE-26 corpo pre-108 volta a vazar e a nao recusar sem sessao', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;
```

- [ ] **Step 2: Rodar os controles (SEM `ON_ERROR_STOP`) e conferir os dois OK**

```bash
"$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d advisor106 \
  -f supabase/tests/local-preflight/13-controles-108.sql
```

Esperado: `select ord, caso, veredito from t_res where ord in (25,26) order by ord;` → duas linhas `OK`. `CONTROLE-25` diz `vazou total=3`; `CONTROLE-26` diz `sem sessao devolveu 4 em vez de 42501`.

- [ ] **Step 3: Restaurar reaplicando a 108 e conferir que o `12` volta todo verde**

```bash
P -f supabase/migrations/20260921120000_108_customer_stats_tenant_guard.sql
P -f supabase/tests/local-preflight/12-customer-stats-108.sql
P -c "select ord, caso, veredito from t_res order by ord;"
```

Esperado: **26 linhas, todas OK**. Se algum dos 17–24 ficou vermelho depois do `13`, a sabotagem não foi desfeita — reaplicar a 108 é o restore e tem de bastar.

- [ ] **Step 4: Commit**

```bash
git add supabase/tests/local-preflight/13-controles-108.sql
git commit -F <mensagem>
```

Mensagem: assunto `test(108): controles positivos do guard de tenant`; corpo explicando que CONTROLE-25 é o delta mínimo sobre `pg_get_functiondef` e CONTROLE-26 o corpo pré-108 inteiro, que o arquivo depende das reservas criadas pelo `12` (senão "vazou" é indistinguível de "cliente sem reserva"), e que reaplicar a 108 é o restore. Terminar com a linha `Co-Authored-By:`.

---

### Task 3: `CustomerStatsBlock` extraído, com o ramo de erro que o `42501` torna alcançável

**Files:**
- Create: `src/components/gestao/CustomerStatsBlock.tsx`
- Create: `src/components/gestao/CustomerStatsBlock.test.tsx`
- Modify: `src/pages/gestao/Clientes.tsx` (bloco "Histórico" nas linhas 424-447; `Stat` nas 529-544; derivações `noShowRate`/`hasShowDecision` nas 409-411)

**Interfaces:**
- Consumes: o tipo `CustomerStats` de `@/types/reserva`; `formatDateBR` de `@/lib/utils`; `Skeleton` de `@/components/ui/skeleton`; `Button` de `@/components/ui/button`.
- Produces: `CustomerStatsBlock({ stats, isLoading, isError, onRetry })` — componente sem busca de dados própria, com `stats: CustomerStats | undefined`, `isLoading: boolean`, `isError: boolean`, `onRetry: () => void`.

**Por que extrair em vez de editar no lugar:** o bloco passa de três ramos para quatro, `Clientes.tsx` já tem 500+ linhas, e um componente que recebe tudo por prop é testável sem `QueryClientProvider` nem mock do cliente Supabase — que não existem em nenhum teste deste repo hoje. `Stat` é usado só aqui (linhas 432-435), então vai junto.

- [ ] **Step 1: Escrever o teste que falha**

`src/components/gestao/CustomerStatsBlock.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomerStatsBlock } from "./CustomerStatsBlock";

const cheio = {
  total: 4,
  confirmed: 2,
  no_shows: 1,
  cancelled: 1,
  no_show_rate: 0.333,
  last_visit: "2026-09-05",
};

describe("CustomerStatsBlock", () => {
  it("mostra os números quando tem stats", () => {
    render(<CustomerStatsBlock stats={cheio} isLoading={false} isError={false} onRetry={() => {}} />);
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("33%")).toBeInTheDocument();
    expect(screen.getByText(/Última presença/)).toBeInTheDocument();
  });

  // O ramo que a migration 108 torna alcançável: a RPC passa a recusar com
  // 42501 quem não é membro da org do cliente. Antes desta mudança o erro caía
  // num `: null` e a caixa renderizava VAZIA — sem explicação e sem retry.
  it("mostra erro e botão de retry quando a consulta falha, em vez de caixa vazia", async () => {
    const onRetry = vi.fn();
    render(<CustomerStatsBlock stats={undefined} isLoading={false} isError onRetry={onRetry} />);

    expect(screen.getByText(/não foi possível carregar/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /tentar de novo/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("erro vence stats vazias — não renderiza zeros como se fossem dado", () => {
    render(<CustomerStatsBlock stats={undefined} isLoading={false} isError onRetry={() => {}} />);
    expect(screen.queryByText("Reservas")).not.toBeInTheDocument();
  });

  it("carregando mostra skeleton e nenhum número", () => {
    render(<CustomerStatsBlock stats={undefined} isLoading isError={false} onRetry={() => {}} />);
    expect(screen.queryByText("Reservas")).not.toBeInTheDocument();
    expect(screen.queryByText(/não foi possível carregar/i)).not.toBeInTheDocument();
  });

  it("taxa de no-show só destaca com amostra de 3 ou mais", () => {
    const { container } = render(
      <CustomerStatsBlock
        stats={{ ...cheio, confirmed: 1, no_shows: 1, total: 2, no_show_rate: 0.5 }}
        isLoading={false}
        isError={false}
        onRetry={() => {}}
      />
    );
    expect(container.querySelector(".text-destructive")).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

```bash
npx vitest run src/components/gestao/CustomerStatsBlock.test.tsx
```

Esperado: FAIL — `Failed to resolve import "./CustomerStatsBlock"`.

- [ ] **Step 3: Escrever o componente**

`src/components/gestao/CustomerStatsBlock.tsx`:

```tsx
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateBR } from "@/lib/utils";
import type { CustomerStats } from "@/types/reserva";

function Stat({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: number | string;
  highlight?: boolean;
}) {
  return (
    <div>
      <p className={`text-xl font-bold ${highlight ? "text-destructive" : ""}`}>{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

export function CustomerStatsBlock({
  stats,
  isLoading,
  isError,
  onRetry,
}: {
  stats: CustomerStats | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  const noShowRate = stats?.no_show_rate ?? null;
  // Amostra pequena não decide nada: 1 de 2 é 50% e não diz mais que ruído.
  const hasShowDecision =
    stats != null && stats.confirmed + stats.no_shows >= 3 && noShowRate != null;

  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground mb-3">Histórico</p>
      {isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : isError ? (
        // Erro é ramo próprio, nunca "lista vazia": a RPC recusa com 42501 quem
        // não é membro da org do cliente (migration 108), e silenciar isso como
        // zeros já mascarou incidente neste repo.
        <div className="text-center space-y-2">
          <p className="text-sm text-muted-foreground">
            Não foi possível carregar as estatísticas.
          </p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Tentar de novo
          </Button>
        </div>
      ) : stats ? (
        <div className="grid grid-cols-4 gap-3 text-center">
          <Stat label="Reservas" value={stats.total} />
          <Stat label="Confirmadas" value={stats.confirmed} />
          <Stat label="Não vieram" value={stats.no_shows} />
          <Stat
            label="Taxa no-show"
            value={noShowRate != null ? `${Math.round(noShowRate * 100)}%` : "—"}
            highlight={hasShowDecision && noShowRate! >= 0.3}
          />
        </div>
      ) : null}
      {!isError && stats?.last_visit && (
        <p className="text-xs text-muted-foreground mt-3 text-center">
          Última presença: {formatDateBR(stats.last_visit)}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Rodar o teste e ver passar**

```bash
npx vitest run src/components/gestao/CustomerStatsBlock.test.tsx
```

Esperado: 5 testes PASS.

- [ ] **Step 5: Ligar em `Clientes.tsx`**

1. Adicionar o import junto dos outros de componente:

```tsx
import { CustomerStatsBlock } from "@/components/gestao/CustomerStatsBlock";
```

2. Trocar a linha 405 por (o hook precisa entregar `isError` e `refetch`):

```tsx
  const {
    data: stats,
    isLoading: loadingStats,
    isError: statsError,
    refetch: refetchStats,
  } = useCustomerStats(customer?.id, unitId);
```

3. Apagar as derivações das linhas 409-411 (`noShowRate` e `hasShowDecision` passam a viver no componente) e substituir o bloco inteiro das linhas 424-447 por:

```tsx
          <CustomerStatsBlock
            stats={stats}
            isLoading={loadingStats}
            isError={statsError}
            onRetry={() => void refetchStats()}
          />
```

4. Apagar a função `Stat` das linhas 529-544 — ela foi para o componente novo e não tem outro uso (`grep -n "<Stat\b" src/pages/gestao/Clientes.tsx` deve voltar vazio).

5. Conferir que `Skeleton` ainda é usado em `Clientes.tsx` antes de mexer no import: `grep -n "Skeleton" src/pages/gestao/Clientes.tsx`. Se sobrar sem uso, remover o import; se ainda for usado na listagem, deixar.

- [ ] **Step 6: Rodar typecheck, lint e a suíte inteira**

```bash
npm run typecheck
npm run lint
npm test
```

Esperado: zero erros de tipo (baseline do repo é zero; qualquer novo é regressão), lint limpo e suíte verde.

- [ ] **Step 7: Commit**

```bash
git add src/components/gestao/CustomerStatsBlock.tsx \
        src/components/gestao/CustomerStatsBlock.test.tsx \
        src/pages/gestao/Clientes.tsx
git commit -F <mensagem>
```

Mensagem: assunto `fix(clientes): erro nas estatísticas deixa de renderizar caixa vazia`; corpo dizendo que a 108 torna o `42501` alcançável, que o `: null` da linha 441 renderizava caixa vazia sem explicação nem retry, e que o bloco saiu para componente próprio porque assim o teste dispensa `QueryClientProvider` e mock do cliente Supabase. Terminar com a linha `Co-Authored-By:`.

---

### Task 4: Allowlist e o par `CLAUDE.md` / `AGENTS.md`

**Files:**
- Modify: `scripts/function-acl-allowlist.json` (entrada `get_customer_stats`, linha 232)
- Modify: `CLAUDE.md` (linha 145)
- Modify: `AGENTS.md` (linha 64, logo depois da regra de runtime do plpgsql)

**Interfaces:**
- Consumes: nada de código. O `_expected_advisor` fica intacto — a 108 não muda nenhum dos três números.
- Produces: nada. É o registro que o guardrail e as próximas sessões leem.

- [ ] **Step 1: Rodar o teste do guardrail ANTES de editar, para ter a baseline**

```bash
npx vitest run scripts/function-acl-allowlist.test.ts
```

Esperado: PASS. Guardar a contagem de testes — a edição não pode reduzi-la.

- [ ] **Step 2: Reescrever o `why` da entrada `get_customer_stats`**

Trocar o valor da chave `"why"` na linha 232 por:

```
"Ficha do cliente no painel. Guard interno desde a migration 108: a organização é resolvida a partir de `customers` pelo `p_customer_id` — nunca do `p_unit_id`, que é parâmetro do chamador — e exige `app_private.is_org_member` ou `app_private.is_platform_admin`, recusando com `42501`. Cliente inexistente e cliente alheio caem no MESMO ramo, então a recusa não é oráculo de existência. `p_unit_id => null` segue significando agregado da org, igual à irmã `get_customer_stats_bulk`. Até a 108 esta era a única entrada `authenticated` daqui SEM guard: o corpo não tinha `auth.uid()` em lugar nenhum e qualquer usuário logado, inclusive sem membership, lia estatística de cliente de qualquer organização por REST (a 107 dropou o irmão de 1 argumento, que era pior). Estreitar o grant não resolveria: `authenticated` é o único papel Postgres que significa 'logado', e todo caller legítimo também é só `authenticated`. Medido em supabase/tests/local-preflight/12-customer-stats-108.sql (STATS-1..8) com controle positivo em 13-controles-108.sql."
```

- [ ] **Step 3: Rodar o teste do guardrail e conferir que segue verde**

```bash
npx vitest run scripts/function-acl-allowlist.test.ts
```

Esperado: PASS, com a mesma contagem do Step 1. O JSON tem de continuar válido — um `"` não escapado no `why` quebra o `JSON.parse` da linha 57 do teste.

- [ ] **Step 4: Estender a linha 145 do `CLAUDE.md`**

A linha hoje termina em: `Aplicado em \`create-manual-reservation\`, \`update-reservation\`, \`send-cancellation\`, \`send-manual-message\` (EF) e \`enter_waitlist\` + \`get_undelivered_notifications\` (RPC).`

Trocar esse fim por:

```
Aplicado em `create-manual-reservation`, `update-reservation`, `send-cancellation`, `send-manual-message` (EF) e `enter_waitlist` + `get_undelivered_notifications` + `get_customer_stats` + `get_customer_stats_bulk` (RPC). **O guard resolve o tenant a partir do PRÓPRIO recurso, nunca do id de escopo que o chamador mandou** — em `get_customer_stats` a org sai de `customers` pelo `p_customer_id`, porque o `p_unit_id` é parâmetro do atacante e confiar nele deixa o guard decorativo. Recurso que pertence à organização (`customers`) guarda por `app_private.is_org_member`; só o que pertence à unidade guarda por `is_unit_member`. [migration 108](supabase/migrations/20260921120000_108_customer_stats_tenant_guard.sql).
```

- [ ] **Step 5: Espelhar no `AGENTS.md`, como item novo depois da linha 64**

```
- Guard de RPC/EF resolve o tenant a partir do PRÓPRIO recurso, nunca do id de escopo que o chamador mandou — a org sai de `customers` pelo `p_customer_id`, não do `p_unit_id`. Recurso da organização guarda por `is_org_member`; da unidade, por `is_unit_member`; sempre com o paralelo `is_platform_admin`, que não tem linha em `unit_members`.
```

- [ ] **Step 6: Conferir o par e rodar a suíte**

```bash
git diff -- CLAUDE.md AGENTS.md
npm test
```

Esperado: as duas mudanças aparecem no mesmo diff (nunca commitar só uma) e a suíte segue verde.

- [ ] **Step 7: Commit**

```bash
git add scripts/function-acl-allowlist.json CLAUDE.md AGENTS.md
git commit -F <mensagem>
```

Mensagem: assunto `docs(108): registrar o guard e a regra de onde vem o tenant`; corpo dizendo que o `why` deixa de documentar o buraco e passa a documentar o guard, que o `_expected_advisor` não muda porque a 108 não move nem desconcede nada, e que a invariante nova é "o tenant vem do recurso, não do parâmetro de escopo". Terminar com a linha `Co-Authored-By:`.

---

### Task 5: Gates de branch inteira e a decisão de aplicar em produção

**Files:** nenhum arquivo novo. Esta task é medição.

**Interfaces:**
- Consumes: tudo das Tasks 1–4.
- Produces: o veredito que autoriza (ou não) o `supabase db push`.

- [ ] **Step 1: Gates de segurança obrigatórios (toca banco, RLS e multi-tenant)**

Despachar os dois agentes com o diff da branch:

- `saas-shield-br:migration-validator` sobre `supabase/migrations/20260921120000_108_customer_stats_tenant_guard.sql`
- `saas-shield-br:tenant-isolation-auditor` sobre a branch

Esperado: nenhum bloqueante. Bloqueante aberto **impede** o push — não mergear com gate vermelho.

- [ ] **Step 2: Suíte e tipos da branch inteira**

```bash
npm run typecheck
npm test
```

Esperado: zero erros; suíte verde, incluindo os 5 testes novos do `CustomerStatsBlock` e o guardrail da allowlist.

- [ ] **Step 3: Conferir que a árvore só tem o que pertence à frente**

```bash
git status
git diff main...HEAD --stat
```

Esperado exatamente 7 arquivos: a migration, `12`, `13`, o README do harness, o componente, o teste do componente, `Clientes.tsx`, `scripts/function-acl-allowlist.json`, `CLAUDE.md`, `AGENTS.md` e a spec/plano. Nada de `.env*`, `*.pem`, `*.key`, dump de DB. Revisar 100% das linhas adicionadas procurando `sk-`, `eyJ`, `service_role`, `SERVICE_ROLE_KEY`, URL com credencial embutida.

- [ ] **Step 4: PARAR e pedir o "pode" do usuário para o `db push`**

**Não aplicar em produção sem autorização explícita nesta conversa.** Aplicar altera o banco da loja real, e a autorização do push escalonado da 106/107 era daquela frente, não desta. Apresentar: os 26 casos verdes com os dois controles positivos, o resultado dos gates, e que o push é uma migration só (não precisa de escalonamento — a 108 não move nada de schema, só troca corpo e reafirma ACL).

- [ ] **Step 5: Depois do "pode" — `db push` com dry-run antes**

```bash
supabase db push --dry-run
supabase db push
```

Esperado no dry-run: **somente** `20260921120000_108_customer_stats_tenant_guard.sql` pendente. Mais de uma migration na lista significa que a árvore tem migration que esta frente não escreveu — parar e investigar.

- [ ] **Step 6: Verificar em produção**

1. Pelo MCP (leitura), conferir que o corpo em produção tem o guard e que o Advisor segue 23:

```sql
select pg_get_functiondef('public.get_customer_stats(uuid,uuid)'::regprocedure) like '%is_org_member%' as tem_guard,
       has_function_privilege('authenticated','public.get_customer_stats(uuid,uuid)','EXECUTE') as auth_executa,
       has_function_privilege('anon','public.get_customer_stats(uuid,uuid)','EXECUTE') as anon_executa;
```

2. Chamar a RPC pelo MCP, onde `auth.uid()` é null: esperado `42501`, **não** uma linha de zeros. É o ramo `unauthenticated` medido em produção.

3. `get_advisors` e conferir `0028=9 | 0029=14 | total=23`.

4. `scripts/audit-function-acl.ts` com as variáveis de ambiente, e **limpar a chave depois**:

```powershell
$env:SUPABASE_URL = "<url>"
$env:SUPABASE_SERVICE_ROLE_KEY = "<chave>"
npx deno@2.1.4 run --allow-net --allow-env --allow-read scripts/audit-function-acl.ts
$env:SUPABASE_SERVICE_ROLE_KEY = $null
```

Esperado: exit 0, sem violações.

5. Pedir ao usuário que abra `/g/moralles-centro/clientes` e uma ficha — é o ramo legítimo com sessão real, e fecha também a confirmação que ficou pendente da frente do advisor.

6. Só com um "pode" explícito do usuário: a sondagem cross-org com a identidade dele, descrita na seção 7 da spec.

- [ ] **Step 7: Merge e push**

Abrir PR, conferir o check `acl-estatico` na aba Checks (obrigatório para mudança que toca migration/função SQL/grant/ACL), e só então mergear em `main`. `main` dispara deploy automático da Vercel — o deploy do frontend traz o ramo de erro da Task 3, que é compatível com a 108 já aplicada em qualquer ordem (o ramo novo só melhora o que hoje é caixa vazia).

---

## Auto-revisão do plano

**Cobertura da spec:** §1 e §2 (o buraco e de onde vem o tenant) → Task 1 Step 5; §3 (corpo) → Task 1 Step 5; §4 (ACL, número, idempotência) → Task 1 Steps 5/7; §5 (frontend) → Task 3; §6 (invariante nos dois arquivos) → Task 4 Steps 4/5; §7 (pré-voo, controles, gates, produção) → Tasks 1/2/5; §8 (o que não entra) → nenhuma task o contradiz; §9 (riscos) → STATS-1/4 (guard recusar legítimo), STATS-7 (ACL), STATS-5 (oráculo), Task 1 Step 6 (ambiguidade plpgsql); §10 (rollback) → **corrigido**: a spec dizia que o corpo pré-108 ficaria versionado no `12`, mas o `09a-advisor-bootstrap.sql` já o traz verbatim desde a Task 5 da 107, e o `13` o usa no CONTROLE-26. A spec precisa desse conserto.

**Placeholders:** nenhum "TBD"/"TODO"; toda mensagem de commit tem assunto e o conteúdo do corpo especificado; todo passo de código tem o código.

**Consistência de tipos:** `CustomerStatsBlock({ stats, isLoading, isError, onRetry })` é usado com exatamente essas quatro props no Step 5 da Task 3 e nos 5 testes do Step 1. `CustomerStats` vem de `@/types/reserva` nos dois arquivos. Os ordinais 17–24 e 25–26 não colidem com os 1–16 existentes e são os mesmos no `12`, no `13` e nas duas tabelas do README.
