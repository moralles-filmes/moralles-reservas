# Consulta pública por código — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O cliente digita o código de 8 caracteres no portal público e chega na página de acompanhamento; `get_reservation_by_code` deixa de existir.

**Architecture:** Uma RPC nova (`resolve_tracking_token_by_code`) resolve `reservation_code` → `reservations.id` e devolve **só o token**, nunca dado — quem entrega payload público continua sendo `get_public_tracking`. `get_reservation_by_code` é dropada na mesma migration, fechando por remoção a leitura cross-tenant de PII. O diálogo do portal vira mutation com ramo de erro explícito e navega para `/acompanhar/:token`.

**Tech Stack:** Postgres/Supabase (migration via `supabase db push`), React 18 + TanStack Query v5 + React Router v6, Vitest + Testing Library, harness de pré-voo em Postgres local (`supabase/tests/local-preflight/`).

**Spec:** [docs/superpowers/specs/2026-09-22-consulta-publica-por-codigo-design.md](../specs/2026-09-22-consulta-publica-por-codigo-design.md)

## Global Constraints

Valem para **todas** as tarefas. Vêm do `CLAUDE.md` do projeto e da spec.

- **`git add <caminho>` sempre explícito.** Nunca `git add .`, `git add -A`, `git reset --hard`. Nunca `git stash`/`git stash pop` (a pilha é compartilhada com worktrees).
- **Migration aplicada só por `supabase db push`** — nunca colar SQL no Studio/SQL Editor.
- **Migration nunca embute segredo nem a URL do projeto Supabase.**
- **Função nova em `public` nasce executável por `PUBLIC`** pelo grant implícito do `CREATE FUNCTION`. Revogar explicitamente antes de conceder: `revoke all on function <assinatura completa> from public, anon, authenticated;`.
- **`npm run typecheck` é `tsc -b --noEmit`.** Nunca `tsc --noEmit` sem `-b` (vira no-op silencioso, exit 0 sem checar).
- **`CLAUDE.md` e `AGENTS.md` são par obrigatório** — regra permanente entra nos dois no mesmo commit.
- **Controle positivo é critério de aceite**, não gentileza: reintroduzir o defeito, ver o teste falhar, restaurar. Há loja real em produção.
- **Nunca imprimir a service_role key.** Depois de qualquer script que a use: `$env:SUPABASE_SERVICE_ROLE_KEY = $null`.
- **Copy do ramo de erro, verbatim:** `"Não foi possível consultar agora. Tente novamente em instantes."` — tem de dizer *falha*, nunca *não encontrado*.
- **Copy do ramo não-encontrado, verbatim:** `"Reserva não encontrada. Verifique o código."`
- **Assinatura da RPC nova, verbatim:** `public.resolve_tracking_token_by_code(p_code text, p_unit_id uuid)` — `p_unit_id` **sem `DEFAULT`**.
- **Nome do arquivo da migration, verbatim:** `supabase/migrations/20260922150000_109_public_code_lookup.sql`.
- Branch de trabalho: `public-code-lookup` (já existe, já tem a spec commitada).

---

## Estrutura de arquivos

| arquivo | responsabilidade | tarefa |
|---|---|---|
| `supabase/migrations/20260922150000_109_public_code_lookup.sql` | cria a RPC, dropa a antiga, ACL | 1 |
| `supabase/tests/local-preflight/14-public-code-lookup-109.sql` | CODE-1..CODE-8 contra Postgres real | 1 |
| `supabase/tests/local-preflight/15-controles-109.sql` | CONTROLE-9/10 (sabotagem) | 2 |
| `supabase/tests/local-preflight/README.md` | sequência de execução | 2 |
| `src/components/reserva/ReservaCodeLookup.tsx` | **novo** — diálogo + resultado, saindo de `PublicPortal.tsx` | 3 |
| `src/components/reserva/ReservaCodeLookup.test.tsx` | os quatro ramos + controle positivo | 3 |
| `src/pages/PublicPortal.tsx` | passa a importar o componente; perde `ReservaCard` e `useReservaByCode` | 3 |
| `src/hooks/useReservas.ts` | perde `useReservaByCode`, `mapRpcRowToReserva`, `ReservationByCodeRow` | 3 |
| `src/hooks/useReservas.test.ts` | perde o bloco que testa código removido | 3 |
| `scripts/function-acl-allowlist.json` | allowlist + `_expected_advisor` 23→24 | 4 |
| `CLAUDE.md` + `AGENTS.md` | invariante permanente | 5 |

**Por que `ReservaCodeLookup` sai de `PublicPortal.tsx`:** o arquivo tem ~890 linhas; o componente precisa ser montável isoladamente para o teste de navegação; e manter a superfície pública num arquivo público (em vez de num hook dentro de `useReservas.ts`) é o que evita repetir o `-- Caller: (hook do painel)` que causou esta frente.

---

## Task 1: Migration 109 + casos de pré-voo

**Files:**
- Create: `supabase/migrations/20260922150000_109_public_code_lookup.sql`
- Create: `supabase/tests/local-preflight/14-public-code-lookup-109.sql`

**Interfaces:**
- Consumes: fixtures do `09a-advisor-bootstrap.sql` e as reservas criadas por `12-customer-stats-108.sql` (códigos `STATSA1`..`STATSB3`).
- Produces: `public.resolve_tracking_token_by_code(text, uuid) returns uuid`, concedida a `anon` e `authenticated`. A tabela `t_res` ganha os ordinais **27..34**.

**Fixtures que já existem e este arquivo reusa** (não criar nenhuma nova):

| id | o que é |
|---|---|
| `bbbbbbbb-0000-0000-0000-000000000001` | Unidade Advisor A — `is_public = true` |
| `bbbbbbbb-0000-0000-0000-000000000002` | Unidade Advisor B — `is_public = false` |
| `bbbbbbbb-0000-0000-0000-000000000003` | Unidade Advisor A2 — `is_public = false` (criada pelo `12`) |
| `dddddddd-0000-0000-0000-000000000001` | reserva código `STATSA1`, na unidade A (pública) |
| `dddddddd-0000-0000-0000-000000000005` | reserva código `STATSA5`, na unidade A2 (**não** pública) |

- [ ] **Step 1: Escrever os casos de pré-voo**

Criar `supabase/tests/local-preflight/14-public-code-lookup-109.sql`:

```sql
-- CODE-1..CODE-8 (ordinais 27..34): a RPC pública `resolve_tracking_token_by_code`
-- da migration 109, contra Postgres real.
--
-- CODE-1/5 são o caminho de ACHAR; CODE-2/3/4 o de NÃO achar — e os três têm de
-- devolver `null` indistinguivelmente, senão a recusa vira oráculo. CODE-6 mede
-- que a get_reservation_by_code SUMIU, CODE-7 a ACL e CODE-8 a idempotência
-- através de duas execuções.
--
-- Diferente da 108, aqui NÃO há `raise`: o retorno é uma linha ou nenhuma, então
-- `null` já é a resposta certa para código errado, unidade errada e unidade não
-- pública. Não há o que um `raise` acrescente, e por isso `language sql` basta.
--
-- Rodar depois de 00, 01, 09a, 106, 09 (2x), 10, 11, 107, 11, 108, 12, 13, 108,
-- 12 e da própria 109, com ON_ERROR_STOP=1. Este arquivo é RODADO DUAS VEZES,
-- com a 109 reaplicada no meio — é assim que CODE-8 mede idempotência.
--
-- Handlers `when others` gravam com `on conflict (ord) do update` pela mesma
-- razão documentada no `12`: o `delete from t_res` do início é desfeito pelo
-- rollback da subtransação, e na 2a passada o insert bateria em chave duplicada.

-- ─── GUARDA: este arquivo só faz sentido DEPOIS da 109 ──────────────────────
-- Rodado antes, CODE-2/3/4 passariam por acidente (a função não existe, tudo
-- "falha"), e CODE-8 gravaria snapshot de um mundo sem a função. Recusar é o
-- RED explícito, mesmo desenho do guard do `12`.
do $$
begin
  if to_regprocedure('public.resolve_tracking_token_by_code(text,uuid)') is null then
    raise exception '14-public-code-lookup-109.sql exige a migration 109 aplicada (public.resolve_tracking_token_by_code(text,uuid) ausente). Sequencia do README: ... -> 108 -> 12 -> 13 -> 108 -> 12 -> 109 -> 14.';
  end if;
  if not exists (select 1 from reservations where reservation_code = 'STATSA1') then
    raise exception '14-public-code-lookup-109.sql exige as reservas criadas por 12-customer-stats-108.sql (reservation_code STATSA1 ausente). Sem elas CODE-1 nao teria o que achar e os casos negativos ficariam verdes medindo nada.';
  end if;
end $$;

create table if not exists t_res (ord int primary key, caso text, veredito text);

-- Snapshot que atravessa as duas execuções (mesmo motivo do `t_stats_snap`).
create table if not exists t_code_snap (ord int primary key, def_md5 text, acl text);

-- ─── CODE-1: código certo, unidade certa e pública → devolve o token ────────
do $$
declare v_unit_a uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_esperado uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_tok uuid;
begin
  delete from t_res where ord = 27;
  set local role anon;
  select resolve_tracking_token_by_code('STATSA1', v_unit_a) into v_tok;
  reset role;

  insert into t_res values (27, 'CODE-1 codigo certo em unidade publica devolve o token',
    case
      when v_tok = v_esperado then 'OK (devolveu ' || v_tok::text || ')'
      else 'FALHOU (esperado ' || v_esperado::text || ', veio ' || coalesce(v_tok::text,'null') || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (27, 'CODE-1 codigo certo em unidade publica devolve o token', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── CODE-2: mesmo código, UNIDADE ERRADA → null ────────────────────────────
-- `reservation_code` tem UNIQUE GLOBAL, então sem o `and r.unit_id = p_unit_id`
-- o portal de qualquer loja resolveria código de qualquer outra. É o caso que o
-- CONTROLE-10 sabota.
do $$
declare v_unit_b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        v_tok uuid;
begin
  delete from t_res where ord = 28;
  set local role anon;
  select resolve_tracking_token_by_code('STATSA1', v_unit_b) into v_tok;
  reset role;

  insert into t_res values (28, 'CODE-2 codigo de outra unidade nao resolve (sem oraculo cross-tenant)',
    case
      when v_tok is null then 'OK (null)'
      else 'FALHOU (vazou o token ' || v_tok::text || ' para a unidade errada)'
    end);
exception when others then
  reset role;
  insert into t_res values (28, 'CODE-2 codigo de outra unidade nao resolve (sem oraculo cross-tenant)', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── CODE-3: unidade NÃO pública → null ─────────────────────────────────────
-- STATSA5 mora na unidade A2, que é `is_public = false`. Este é o gate que tem
-- de casar com o de `get_public_tracking`: se o resolvedor for mais frouxo, o
-- cliente resolve o código e a pagina de acompanhamento recusa depois — beco
-- sem saída pior que a mensagem de hoje. É o caso que o CONTROLE-9 sabota.
do $$
declare v_unit_a2 uuid := 'bbbbbbbb-0000-0000-0000-000000000003';
        v_tok uuid;
begin
  delete from t_res where ord = 29;
  set local role anon;
  select resolve_tracking_token_by_code('STATSA5', v_unit_a2) into v_tok;
  reset role;

  insert into t_res values (29, 'CODE-3 unidade nao publica nao resolve',
    case
      when v_tok is null then 'OK (null)'
      else 'FALHOU (resolveu ' || v_tok::text || ' numa unidade is_public=false)'
    end);
exception when others then
  reset role;
  insert into t_res values (29, 'CODE-3 unidade nao publica nao resolve', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── CODE-4: código inexistente → null, igual aos outros dois ───────────────
do $$
declare v_unit_a uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_tok uuid;
begin
  delete from t_res where ord = 30;
  set local role anon;
  select resolve_tracking_token_by_code('ZZZZZZZZ', v_unit_a) into v_tok;
  reset role;

  insert into t_res values (30, 'CODE-4 codigo inexistente devolve null igual aos negados',
    case
      when v_tok is null then 'OK (null, indistinguivel de CODE-2 e CODE-3)'
      else 'FALHOU (devolveu ' || v_tok::text || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (30, 'CODE-4 codigo inexistente devolve null igual aos negados', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── CODE-5: minúsculas e espaços resolvem igual ────────────────────────────
-- Cliente cola o código do WhatsApp com espaço em volta. `upper(btrim())`.
do $$
declare v_unit_a uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_esperado uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_tok uuid;
begin
  delete from t_res where ord = 31;
  set local role anon;
  select resolve_tracking_token_by_code('  statsa1  ', v_unit_a) into v_tok;
  reset role;

  insert into t_res values (31, 'CODE-5 minusculas e espacos resolvem igual a CODE-1',
    case
      when v_tok = v_esperado then 'OK (devolveu ' || v_tok::text || ')'
      else 'FALHOU (esperado ' || v_esperado::text || ', veio ' || coalesce(v_tok::text,'null') || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (31, 'CODE-5 minusculas e espacos resolvem igual a CODE-1', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── CODE-6: get_reservation_by_code NÃO EXISTE MAIS ────────────────────────
-- O P1 desta frente fecha por remoção. Medir a ausência é a asserção inteira.
do $$
declare v_2arg oid; v_1arg oid;
begin
  delete from t_res where ord = 32;
  v_2arg := to_regprocedure('public.get_reservation_by_code(text,uuid)');
  v_1arg := to_regprocedure('public.get_reservation_by_code(text)');

  insert into t_res values (32, 'CODE-6 get_reservation_by_code foi dropada (P1 fecha por remocao)',
    case
      when v_2arg is null and v_1arg is null then 'OK (nenhum overload existe)'
      when v_2arg is not null then 'FALHOU (o overload de 2 argumentos ainda existe)'
      else 'FALHOU (o overload de 1 argumento reapareceu — a 107 o dropou)'
    end);
exception when others then
  insert into t_res values (32, 'CODE-6 get_reservation_by_code foi dropada (P1 fecha por remocao)', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── CODE-7: ACL — anon e authenticated executam, PUBLIC não ────────────────
-- `proacl` nulo NÃO é "ninguém tem": é a ACL DEFAULT, que em função concede
-- EXECUTE a PUBLIC. Tratar nulo como falso deixaria passar exatamente o estado
-- que o `revoke` da migration existe para evitar. Mesmo desenho do STATS-7.
do $$
declare v_anon boolean; v_auth boolean; v_pub boolean;
begin
  delete from t_res where ord = 33;
  select has_function_privilege('anon',          'public.resolve_tracking_token_by_code(text,uuid)', 'EXECUTE') into v_anon;
  select has_function_privilege('authenticated', 'public.resolve_tracking_token_by_code(text,uuid)', 'EXECUTE') into v_auth;
  select case
           when p.proacl is null then true
           else coalesce((select true from aclexplode(p.proacl) a
                           where a.grantee = 0 and a.privilege_type = 'EXECUTE' limit 1), false)
         end
    into v_pub
    from pg_proc p where p.oid = 'public.resolve_tracking_token_by_code(text,uuid)'::regprocedure;

  insert into t_res values (33, 'CODE-7 ACL: anon e authenticated executam, PUBLIC nao',
    case
      when v_anon and v_auth and not v_pub then 'OK (anon=t, authenticated=t, PUBLIC=f)'
      else 'FALHOU (anon=' || v_anon || ', authenticated=' || v_auth || ', PUBLIC=' || v_pub || ')'
    end);
exception when others then
  insert into t_res values (33, 'CODE-7 ACL: anon e authenticated executam, PUBLIC nao', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── CODE-8: idempotência medida ATRAVÉS DE DUAS EXECUÇÕES ──────────────────
do $$
declare v_def_md5 text; v_acl text; s record;
begin
  delete from t_res where ord = 34;
  select md5(pg_get_functiondef(p.oid)), coalesce(p.proacl::text, '<null>')
    into v_def_md5, v_acl
    from pg_proc p where p.oid = 'public.resolve_tracking_token_by_code(text,uuid)'::regprocedure;

  select * into s from t_code_snap where ord = 34;
  if s is null then
    insert into t_code_snap values (34, v_def_md5, v_acl);
    insert into t_res values (34, 'CODE-8 reaplicar a 109 nao muda corpo nem ACL',
      'OK (1a passada: snapshot gravado, corpo md5 ' || left(v_def_md5, 8) || ', acl ' || v_acl || ')');
  elsif s.def_md5 = v_def_md5 and s.acl = v_acl then
    insert into t_res values (34, 'CODE-8 reaplicar a 109 nao muda corpo nem ACL',
      'OK (2a passada: corpo e ACL identicos ao snapshot)');
  else
    insert into t_res values (34, 'CODE-8 reaplicar a 109 nao muda corpo nem ACL',
      'FALHOU (mudou: corpo ' || left(s.def_md5,8) || ' -> ' || left(v_def_md5,8)
        || ', acl ' || s.acl || ' -> ' || v_acl || ')');
  end if;
exception when others then
  insert into t_res values (34, 'CODE-8 reaplicar a 109 nao muda corpo nem ACL', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;
```

- [ ] **Step 2: Rodar os casos ANTES da migration e ver o RED**

Subir o Postgres local e chegar ao estado da 108 seguindo `supabase/tests/local-preflight/README.md` (bloco "Sequência da migration 106 (advisor)", até a linha que imprime 26 linhas). Então:

```bash
P -f supabase/tests/local-preflight/14-public-code-lookup-109.sql
```

Esperado: **ERROR** com `exige a migration 109 aplicada (public.resolve_tracking_token_by_code(text,uuid) ausente)`.

Se passar em vez de falhar, pare: a função já existe no banco local de alguma execução anterior e o GREEN seguinte não vale nada.

- [ ] **Step 3: Escrever a migration**

Criar `supabase/migrations/20260922150000_109_public_code_lookup.sql`:

```sql
-- Migration 109: consulta pública por código resolve o TOKEN, nunca o dado.
--
-- Fecha dois defeitos trançados de `public.get_reservation_by_code(text,uuid)`.
--
-- (A) FUNCIONAL. O único call site dessa RPC em todo o repositório é
--     `src/pages/PublicPortal.tsx` -> ReservaCodeLookup -> useReservas.ts:97: o
--     PORTAL PÚBLICO, não o painel. A migration 085 anotou
--     `-- Caller: src/hooks/useReservas.ts (hook do painel)` e, com base nessa
--     leitura, revogou `anon`. Desde 2026-07-30 o diálogo "Já tem reserva?
--     Consulte pelo código" responde HTTP 401 / 42501 para todo visitante —
--     medido com a anon key real. O componente só lia `data`/`isLoading`, então
--     o erro chegava ao cliente como "Reserva não encontrada. Verifique o
--     código.". As migrations 005 e 013 tinham concedido `anon` de propósito e
--     diziam "consulta pública" e "portal público" no comentário.
--
-- (B) SEGURANÇA (P1). A função é SECURITY DEFINER, `language sql`, sem
--     `auth.uid()` em lugar nenhum e sem helper de membresia, concedida a
--     `authenticated`. Qualquer usuário logado de qualquer organização que
--     possua um `reservation_code` lia `customer_name`, `customer_phone`,
--     `customer_email` e `notes` da reserva de QUALQUER organização.
--     `p_unit_id` não protegia: `reservation_code` tem índice UNIQUE GLOBAL
--     (`reservations_reservation_code_key`), então o parâmetro só estreitava 1
--     linha para 0 — filtrava, nunca autorizava.
--
-- (C) De quebra, o diálogo renderizava `<ReservaCard>`, componente de painel que
--     exibe nome completo, telefone e `notes` do operador. Antes da 085 isso
--     estava no ar no portal público.
--
-- A CORREÇÃO NÃO É UM GUARD. Guard de membresia numa RPC cujo único chamador é
-- anônimo consolidaria (A); e devolver o payload atual a `anon` publicaria
-- telefone, e-mail e `notes`, contra a régua de superfície pública. Em vez
-- disso, o portal passa a resolver o código para o TOKEN de /acompanhar/:token e
-- `get_reservation_by_code` é DROPADA — (B) fecha por remoção, sem guard novo
-- para auditar, e (C) some junto quando o portal deixa de renderizar ReservaCard.
--
-- NENHUM PAYLOAD PÚBLICO NOVO NASCE AQUI: quem entrega dado continua sendo
-- `get_public_tracking` (migration 055), fonte única da régua de privacidade —
-- 1º nome, sem telefone/e-mail/`notes`.
--
-- POR QUE `language sql` E NÃO `plpgsql` COM `raise`, ao contrário da 108: lá a
-- recusa tinha de ser `raise ... 42501` porque `count(*)` sobre conjunto vazio
-- sempre produz linha, e "negar" ficaria indistinguível de "não achar nada".
-- Aqui o retorno é uma linha ou nenhuma: `null` já responde código errado,
-- unidade errada e unidade não pública — os três indistinguíveis, sem oráculo.
--
-- O GATE `units.is_public` TEM DE CASAR COM O DE `get_public_tracking`. Se este
-- for mais frouxo, o código resolve um token que a página de acompanhamento
-- depois recusa, e o cliente cai em "Acompanhamento indisponível" DEPOIS de
-- digitar o código certo. Afrouxar um lado sem o outro é regressão.
--
-- `p_unit_id` É OBRIGATÓRIO E NÃO AUTORIZA — quem autoriza é `u.is_public`. Ele
-- vem do slug da URL e só ESTREITA, impedindo que o portal de uma loja vire
-- oráculo universal onde código de qualquer tenant resolve. Isso não repete o
-- erro que a 108 corrigiu: lá o parâmetro do chamador era a única fonte do
-- tenant e podia ser escolhido para afrouxar o guard; aqui ele só pode tornar a
-- checagem mais estrita.
--
-- SÓ RESERVA, NUNCA FILA: `waitlist.code` é inteiro pequeno por unidade
-- ("senha #7"), trivialmente enumerável. Resolvê-lo para um token seria buraco.
--
-- Idempotente: `create or replace` + `drop ... if exists`.

begin;

create or replace function public.resolve_tracking_token_by_code(
  p_code text,
  p_unit_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = 'public'
as $$
  select r.id
    from reservations r
    join units u on u.id = r.unit_id
   where r.reservation_code = upper(btrim(p_code))
     and r.unit_id = p_unit_id
     and u.is_public = true;
$$;

-- CREATE FUNCTION concede EXECUTE a PUBLIC por padrão e o schema `public` é
-- exposto ao PostgREST com a anon key. Revogar antes de conceder ao papel mínimo.
revoke all on function public.resolve_tracking_token_by_code(text, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_tracking_token_by_code(text, uuid)
  to anon, authenticated;

comment on function public.resolve_tracking_token_by_code(text, uuid) is
  'Resolve reservation_code -> reservations.id (token de /acompanhar/:token). Devolve SO o token, nunca dado: o payload publico e de get_public_tracking, fonte unica da regua de privacidade. Gateada por units.is_public, que TEM de casar com o gate da get_public_tracking. p_unit_id e obrigatorio e so estreita — quem autoriza e o is_public. Nao resolve codigo de waitlist (inteiro pequeno, enumeravel).';

-- Fecha o P1 por remoção. Ver o cabeçalho.
drop function if exists public.get_reservation_by_code(text, uuid);

commit;
```

- [ ] **Step 4: Aplicar no banco local e ver o GREEN**

```bash
P -f supabase/migrations/20260922150000_109_public_code_lookup.sql
P -f supabase/tests/local-preflight/14-public-code-lookup-109.sql   # 1a passada
P -f supabase/migrations/20260922150000_109_public_code_lookup.sql
P -f supabase/tests/local-preflight/14-public-code-lookup-109.sql   # 2a passada
P -c "select ord, caso, veredito from t_res where ord between 27 and 34 order by ord;"
```

Esperado: 8 linhas, **todas começando com `OK`**. Qualquer `FALHOU` para aqui.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260922150000_109_public_code_lookup.sql supabase/tests/local-preflight/14-public-code-lookup-109.sql
git commit -m "feat(109): consulta publica por codigo resolve token, e dropa get_reservation_by_code"
```

---

## Task 2: Controles positivos + README do pré-voo

**Files:**
- Create: `supabase/tests/local-preflight/15-controles-109.sql`
- Modify: `supabase/tests/local-preflight/README.md` (bloco de sequência, depois da linha que imprime "26 linhas, todas OK")

**Interfaces:**
- Consumes: a função da Task 1 e os casos CODE-2/CODE-3.
- Produces: ordinais **35** e **36** em `t_res`.

**Por que esta tarefa é separada da 1:** um revisor pode aceitar a migration e recusar os controles (sabotagem fraca, asserção sobre "não estourou" em vez de sobre o valor). São gates diferentes.

- [ ] **Step 1: Escrever os controles**

Criar `supabase/tests/local-preflight/15-controles-109.sql`:

```sql
-- DOIS CONTROLES POSITIVOS da migration 109 — ordinais 35 e 36.
--
-- Rodar SEM ON_ERROR_STOP: os casos sabotam de propósito.
--
-- Sem eles, "CODE-2 e CODE-3 passaram" não distingue a guarda funcionando de
-- teste sem força — os dois casos afirmam `null`, e `null` é exatamente o que
-- uma função quebrada de qualquer outra maneira também devolveria.
--
--   CONTROLE-9   remove `and u.is_public = true` e vê CODE-3 resolver uma
--                unidade privada. É o gate que casa com o da get_public_tracking.
--   CONTROLE-10  remove `and r.unit_id = p_unit_id` e vê CODE-2 resolver código
--                de outra unidade — o portal de uma loja virando oráculo
--                universal, que é o que o UNIQUE GLOBAL de reservation_code
--                permite quando nada amarra o tenant.
--
-- AS DUAS ASSERÇÕES SÃO SOBRE O UUID QUE VOLTOU, não sobre "não estourou":
-- guarda quebrada aqui devolve dado, não erro. Foi essa a lição do CONTROLE-25.
--
-- A definição sabotada é construída a partir de `pg_get_functiondef`, não
-- redigitada: assinatura, volatilidade, modo de segurança e search_path vêm do
-- banco, e o ÚNICO delta é a linha removida. Cada caso confere que o `replace`
-- de fato mudou o texto — sabotagem que não sabota é o modo silencioso de um
-- controle positivo mentir.
--
-- RESTORE: a 109 DEFINE o corpo com `create or replace`, então reaplicar a
-- migration restaura as duas sabotagens. É o que o README manda fazer depois.
do $ctrl$
begin
  if to_regprocedure('public.resolve_tracking_token_by_code(text,uuid)') is null then
    raise exception '15-controles-109.sql exige a migration 109 aplicada.';
  end if;
  if not exists (select 1 from reservations where reservation_code = 'STATSA5') then
    raise exception '15-controles-109.sql exige as reservas do 12-customer-stats-108.sql (STATSA5, na unidade nao publica). Sem ela o CONTROLE-9 nao teria o que vazar e ficaria verde medindo nada.';
  end if;
end $ctrl$;

-- ═══ CONTROLE-9 — sem o gate is_public, unidade privada resolve ═════════════
do $ctrl$
declare v_def text; v_sab text;
        v_unit_a2 uuid := 'bbbbbbbb-0000-0000-0000-000000000003';
        v_esperado uuid := 'dddddddd-0000-0000-0000-000000000005';
        v_tok uuid;
begin
  delete from t_res where ord = 35;

  v_def := pg_get_functiondef('public.resolve_tracking_token_by_code(text,uuid)'::regprocedure);
  v_sab := replace(v_def, 'and u.is_public = true', 'and true');

  if v_sab = v_def then
    insert into t_res values (35, 'CONTROLE-9 sem o gate is_public, unidade privada resolve',
      'FALHOU (o replace nao mudou nada: `and u.is_public = true` nao esta no corpo com o texto esperado — a 109 nao esta aplicada ou o corpo mudou)');
    return;
  end if;

  execute v_sab;

  set local role anon;
  select resolve_tracking_token_by_code('STATSA5', v_unit_a2) into v_tok;
  reset role;

  insert into t_res values (35, 'CONTROLE-9 sem o gate is_public, unidade privada resolve',
    case
      when v_tok = v_esperado then 'OK (resolveu ' || v_tok::text || ' numa unidade is_public=false — o CODE-3 tem forca)'
      else 'FALHOU (sabotado e ainda assim nao resolveu: veio ' || coalesce(v_tok::text,'null')
             || '; o CODE-3 pode estar passando por outro motivo)'
    end);
exception when others then
  reset role;
  insert into t_res values (35, 'CONTROLE-9 sem o gate is_public, unidade privada resolve', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ CONTROLE-10 — sem o casamento de unidade, código alheio resolve ════════
-- Este controle depende do CONTROLE-9 ter rodado antes? NÃO: ele reconstrói a
-- sabotagem a partir do corpo que estiver no banco. Mas se o 9 rodou e não
-- restaurou, o corpo já está sem `is_public` — por isso o caso confere que o
-- replace do `unit_id` mudou o texto, e o README reaplica a 109 no fim.
do $ctrl$
declare v_def text; v_sab text;
        v_unit_b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        v_esperado uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_tok uuid;
begin
  delete from t_res where ord = 36;

  v_def := pg_get_functiondef('public.resolve_tracking_token_by_code(text,uuid)'::regprocedure);
  v_sab := replace(v_def, 'and r.unit_id = p_unit_id', 'and true');

  if v_sab = v_def then
    insert into t_res values (36, 'CONTROLE-10 sem o casamento de unidade, codigo alheio resolve',
      'FALHOU (o replace nao mudou nada: `and r.unit_id = p_unit_id` nao esta no corpo com o texto esperado)');
    return;
  end if;

  execute v_sab;

  set local role anon;
  select resolve_tracking_token_by_code('STATSA1', v_unit_b) into v_tok;
  reset role;

  insert into t_res values (36, 'CONTROLE-10 sem o casamento de unidade, codigo alheio resolve',
    case
      when v_tok = v_esperado then 'OK (o portal da unidade B resolveu codigo da unidade A — o CODE-2 tem forca)'
      else 'FALHOU (sabotado e ainda assim nao resolveu: veio ' || coalesce(v_tok::text,'null')
             || '; o CODE-2 pode estar passando por outro motivo)'
    end);
exception when others then
  reset role;
  insert into t_res values (36, 'CONTROLE-10 sem o casamento de unidade, codigo alheio resolve', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;
```

- [ ] **Step 2: Rodar os controles e conferir que sabotam de verdade**

```bash
"$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d advisor106 \
  -f supabase/tests/local-preflight/15-controles-109.sql   # SEM ON_ERROR_STOP
P -c "select ord, caso, veredito from t_res where ord in (35,36) order by ord;"
```

Esperado: 2 linhas, ambas `OK`. Um `FALHOU (sabotado e ainda assim nao resolveu)` significa que o caso correspondente passa por outro motivo — investigar antes de seguir, **não** ajustar o controle para ficar verde.

- [ ] **Step 3: Restaurar e conferir que voltou**

```bash
P -f supabase/migrations/20260922150000_109_public_code_lookup.sql
P -f supabase/tests/local-preflight/14-public-code-lookup-109.sql
P -c "select ord, caso, veredito from t_res order by ord;"
```

Esperado: 36 linhas, todas `OK`.

- [ ] **Step 4: Atualizar o README do pré-voo**

Em `supabase/tests/local-preflight/README.md`, logo depois da linha `P -c "select ord, caso, veredito from t_res order by ord;"   # 26 linhas, todas OK`, acrescentar:

```bash
# ── Migration 109: consulta publica por codigo ─────────────────────────────
# ANTES da migration, o 14 tem de FALHAR pelo guard do topo do arquivo
# (`public.resolve_tracking_token_by_code(text,uuid) ausente`). E o RED: rodado
# antes, CODE-2/3/4 passariam por acidente, porque a funcao inexistente faz tudo
# "falhar", e o CODE-8 gravaria snapshot de um mundo sem a funcao.
P -f supabase/tests/local-preflight/14-public-code-lookup-109.sql   # esperado: ERROR

P -f supabase/migrations/20260922150000_109_public_code_lookup.sql
P -f supabase/tests/local-preflight/14-public-code-lookup-109.sql   # 1a passada
# CODE-8 mede idempotencia ATRAVES DE DUAS EXECUCOES, igual ao STATS-8:
P -f supabase/migrations/20260922150000_109_public_code_lookup.sql
P -f supabase/tests/local-preflight/14-public-code-lookup-109.sql   # 2a passada

"$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d advisor106 \
  -f supabase/tests/local-preflight/15-controles-109.sql   # SEM ON_ERROR_STOP
# O 15 sabota o CORPO da resolve_tracking_token_by_code de proposito, e a 109
# DEFINE o corpo — entao reaplicar restaura:
P -f supabase/migrations/20260922150000_109_public_code_lookup.sql

P -c "select ord, caso, veredito from t_res order by ord;"   # 36 linhas, todas OK
```

Também atualizar a tabela de ordinais que começa em `| ord | caso | arquivo |` (linha ~215), acrescentando as linhas 27–36 apontando para `14-public-code-lookup-109.sql` (27–34) e `15-controles-109.sql` (35–36).

- [ ] **Step 5: Commit**

```bash
git add supabase/tests/local-preflight/15-controles-109.sql supabase/tests/local-preflight/README.md
git commit -m "test(109): controles positivos do gate is_public e do casamento de unidade"
```

---

## Task 3: Frontend — `ReservaCodeLookup`

**Files:**
- Create: `src/components/reserva/ReservaCodeLookup.tsx`
- Create: `src/components/reserva/ReservaCodeLookup.test.tsx`
- Modify: `src/pages/PublicPortal.tsx` (imports 1–23; remover `ReservaCodeLookup` das linhas 809–882; ajustar o uso na linha 514)
- Modify: `src/hooks/useReservas.ts:7-46,97-111`
- Modify: `src/hooks/useReservas.test.ts`

**Interfaces:**
- Consumes: `public.resolve_tracking_token_by_code(p_code text, p_unit_id uuid) returns uuid` (Task 1).
- Produces: `export function ReservaCodeLookup({ unitId }: { unitId: string })` e `export function ReservaCodeLookupResult({ state, onRetry }: { state: LookupState; onRetry: () => void })`, com `export type LookupState = "idle" | "pending" | "notFound" | "error"`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/components/reserva/ReservaCodeLookup.test.tsx`:

```tsx
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ReservaCodeLookup, ReservaCodeLookupResult } from "./ReservaCodeLookup";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const real = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...real, useNavigate: () => navigate };
});

const rpc = vi.fn();
vi.mock("@/lib/supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

const UNIT = "bbbbbbbb-0000-0000-0000-000000000001";
const TOKEN = "dddddddd-0000-0000-0000-000000000001";

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  navigate.mockReset();
  rpc.mockReset();
});

async function buscar(codigo: string) {
  await userEvent.click(screen.getByRole("button", { name: /consulte pelo código/i }));
  await userEvent.type(screen.getByPlaceholderText(/AB1C2DEF/i), codigo);
  await userEvent.click(screen.getByRole("button", { name: /^buscar$/i }));
}

describe("ReservaCodeLookupResult", () => {
  it("não afirma nada enquanto está parado ou buscando", () => {
    const { rerender } = render(<ReservaCodeLookupResult state="idle" onRetry={() => {}} />);
    expect(screen.queryByText(/não encontrada/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/não foi possível consultar/i)).not.toBeInTheDocument();
    rerender(<ReservaCodeLookupResult state="pending" onRetry={() => {}} />);
    expect(screen.queryByText(/não encontrada/i)).not.toBeInTheDocument();
  });

  it("diz 'não encontrada' quando a RPC devolveu null", () => {
    render(<ReservaCodeLookupResult state="notFound" onRetry={() => {}} />);
    expect(screen.getByText("Reserva não encontrada. Verifique o código.")).toBeInTheDocument();
  });

  // O ramo que esta frente existe para criar. Ele não existia, e por isso 54
  // dias de HTTP 401 chegaram ao cliente como "código errado".
  it("diz que FALHOU, nunca 'não encontrada', quando a consulta deu erro", async () => {
    const onRetry = vi.fn();
    render(<ReservaCodeLookupResult state="error" onRetry={onRetry} />);

    expect(
      screen.getByText("Não foi possível consultar agora. Tente novamente em instantes.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/não encontrada/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /tentar de novo/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("ReservaCodeLookup", () => {
  it("leva para /acompanhar quando o código resolve", async () => {
    rpc.mockResolvedValue({ data: TOKEN, error: null });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await buscar("AB1C2DEF");

    expect(rpc).toHaveBeenCalledWith("resolve_tracking_token_by_code", {
      p_code: "AB1C2DEF",
      p_unit_id: UNIT,
    });
    expect(navigate).toHaveBeenCalledWith(`/acompanhar/${TOKEN}`);
  });

  it("não navega quando a RPC devolve null — diz que não encontrou", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await buscar("AB1C2DEF");

    expect(navigate).not.toHaveBeenCalled();
    expect(await screen.findByText("Reserva não encontrada. Verifique o código.")).toBeInTheDocument();
  });

  it("não navega e não diz 'não encontrada' quando a RPC dá erro", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await buscar("AB1C2DEF");

    expect(navigate).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Não foi possível consultar agora. Tente novamente em instantes.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/não encontrada/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Rodar e verificar que falha**

```bash
npx vitest run src/components/reserva/ReservaCodeLookup.test.tsx
```

Esperado: FAIL — `Failed to resolve import "./ReservaCodeLookup"`.

- [ ] **Step 3: Escrever o componente**

Criar `src/components/reserva/ReservaCodeLookup.tsx`:

```tsx
// Consulta pública por código, no rodapé do portal /r/:slug.
//
// Mora AQUI, e não num hook em src/hooks/useReservas.ts, de propósito: foi um
// hook público morando no arquivo de hooks de painel que produziu o comentário
// `-- Caller: (hook do painel)` da migration 085 e, com ele, 54 dias com esta
// consulta respondendo HTTP 401 para todo visitante. Superfície pública fica
// visível na pasta pública.
//
// A RPC devolve SÓ o token de /acompanhar/:token, nunca dado do cliente — quem
// entrega payload público é get_public_tracking (migration 055).

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ChevronRight, Clock, Search } from "lucide-react";

export type LookupState = "idle" | "pending" | "notFound" | "error";

// Props-only, para os quatro ramos serem testáveis sem rede nem router.
export function ReservaCodeLookupResult({
  state,
  onRetry,
}: {
  state: LookupState;
  onRetry: () => void;
}) {
  if (state === "pending") {
    return <p className="text-sm text-muted-foreground">Buscando...</p>;
  }

  if (state === "notFound") {
    return (
      <p className="text-sm text-destructive">Reserva não encontrada. Verifique o código.</p>
    );
  }

  // Erro NÃO é "não encontrada". Silenciar um como o outro já mascarou
  // incidente neste repo — é o motivo desta frente existir.
  if (state === "error") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-destructive">
          Não foi possível consultar agora. Tente novamente em instantes.
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Tentar de novo
        </Button>
      </div>
    );
  }

  return null;
}

export function ReservaCodeLookup({ unitId }: { unitId: string }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const navigate = useNavigate();

  const lookup = useMutation({
    mutationFn: async (rawCode: string) => {
      const { data, error } = await supabase.rpc("resolve_tracking_token_by_code", {
        p_code: rawCode,
        p_unit_id: unitId,
      });
      if (error) throw error;
      return (data as string | null) ?? null;
    },
    onSuccess: (token) => {
      // A troca de rota desmonta o diálogo — não é preciso fechá-lo à mão.
      if (token) navigate(`/acompanhar/${token}`);
    },
  });

  const state: LookupState = lookup.isPending
    ? "pending"
    : lookup.isError
      ? "error"
      : lookup.isSuccess && lookup.data === null
        ? "notFound"
        : "idle";

  const buscar = () => {
    const limpo = code.trim().toUpperCase();
    if (limpo.length < 4) return;
    lookup.mutate(limpo);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setCode("");
          lookup.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 transition-colors"
        >
          <Clock className="h-3.5 w-3.5" />
          Já tem reserva? Consulte pelo código
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">Consultar reserva</DialogTitle>
          <p className="text-sm text-muted-foreground">
            Informe o código de 8 caracteres recebido no WhatsApp.
          </p>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="Ex: AB1C2DEF"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter") buscar();
              }}
              className="font-mono"
              maxLength={8}
            />
            <Button
              variant="secondary"
              onClick={buscar}
              disabled={code.trim().length < 4 || lookup.isPending}
              aria-label="Buscar"
            >
              <Search className="h-4 w-4" />
            </Button>
          </div>

          <ReservaCodeLookupResult state={state} onRetry={buscar} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Rodar e verificar que passa**

```bash
npx vitest run src/components/reserva/ReservaCodeLookup.test.tsx
```

Esperado: PASS, 6 testes.

- [ ] **Step 5: Controle positivo — reintroduzir o defeito e ver o teste reprovar**

Em `ReservaCodeLookupResult`, trocar o ramo de erro pelo comportamento antigo (erro cai no mesmo texto do não-encontrado):

```tsx
  if (state === "error") {
    return (
      <p className="text-sm text-destructive">Reserva não encontrada. Verifique o código.</p>
    );
  }
```

Rodar `npx vitest run src/components/reserva/ReservaCodeLookup.test.tsx`.

Esperado: **FAIL** em pelo menos `diz que FALHOU, nunca 'não encontrada'` e `não navega e não diz 'não encontrada' quando a RPC dá erro`.

Se passar, o teste não tem força — pare e conserte o teste antes de continuar.

Restaurar o ramo de erro correto e rodar de novo: PASS.

- [ ] **Step 6: Ligar no portal e remover o código morto**

Em `src/pages/PublicPortal.tsx`:

1. Remover a linha 6: `import { ReservaCard } from "@/components/reserva/ReservaCard";`
2. Remover a linha 23: `import { useReservaByCode } from "@/hooks/useReservas";`
3. Acrescentar, junto dos outros imports de `@/components/reserva/`: `import { ReservaCodeLookup } from "@/components/reserva/ReservaCodeLookup";`
4. Apagar a função `ReservaCodeLookup` inteira (linhas 809–882 do arquivo atual). O uso em `<ReservaCodeLookup unitId={unit.id} />` na linha 514 fica igual — a prop não mudou.
5. Se `Clock`, `Search` ou `ChevronRight` ficarem sem uso no arquivo, removê-los do bloco de imports de `lucide-react` (o lint acusa).

Em `src/hooks/useReservas.ts`: apagar `ReservationByCodeRow` (linhas 7–20), `mapRpcRowToReserva` (22–46) e `useReservaByCode` (97–111). Se `ReservaStatus` ficar sem uso no `import type` da linha 5, removê-lo.

Em `src/hooks/useReservas.test.ts`: apagar o `describe("mapRpcRowToReserva", ...)` inteiro. **Se o arquivo ficar sem nenhum teste, apagar o arquivo** — arquivo de teste vazio faz o vitest falhar com "No test suite found".

- [ ] **Step 7: Rodar a suíte inteira e os gates de tipo/lint**

```bash
npm run typecheck
npm run lint
npx vitest run
```

Esperado: typecheck limpo, lint 0 erros, suíte verde. Nenhum import órfão de `mapRpcRowToReserva` ou `useReservaByCode` pode restar.

- [ ] **Step 8: Commit**

```bash
git add src/components/reserva/ReservaCodeLookup.tsx src/components/reserva/ReservaCodeLookup.test.tsx src/pages/PublicPortal.tsx src/hooks/useReservas.ts src/hooks/useReservas.test.ts
git commit -m "fix(portal): consulta por codigo leva ao acompanhamento e trata erro separado de nao-encontrado"
```

---

## Task 4: Allowlist e o número do Advisor

**Files:**
- Modify: `scripts/function-acl-allowlist.json` (linhas 94–96; entrada em ~133–139; entrada em ~212–219)

**Interfaces:**
- Consumes: a assinatura criada na Task 1.
- Produces: allowlist consistente com o banco pós-109. É o que o job `acl-estatico` do CI lê.

- [ ] **Step 1: Remover a entrada dropada**

Apagar do bucket `authenticated_tenant` o objeto inteiro cujo `"name": "get_reservation_by_code"` e `"args": "p_code text, p_unit_id uuid"` (o bloco começa na linha ~212), inclusive a vírgula que o separa do próximo objeto.

Isso é previsto pelo `_doc` da allowlist: *"Assinatura DROPADA por uma migration posterior à 085 sai daqui — nada pode executar uma função que não existe mais."*

- [ ] **Step 2: Acrescentar a entrada nova**

No bucket `public_anon`, logo **depois** do objeto de `get_public_tracking` (que termina por volta da linha 139), inserir:

```json
    {
      "name": "resolve_tracking_token_by_code",
      "args": "p_code text, p_unit_id uuid",
      "roles": ["anon", "authenticated"],
      "why": "Consulta por código no rodapé do portal público /r/:slug (src/components/reserva/ReservaCodeLookup.tsx). Devolve SÓ reservations.id — o token de /acompanhar/:token — e nunca dado do cliente: quem entrega payload público é get_public_tracking, e mantê-lo como produtor único é o que impede duas réguas de privacidade divergirem. Gateada por units.is_public, o MESMO gate da get_public_tracking (afrouxar um lado sem o outro faz o código resolver um token que a página depois recusa). p_unit_id é obrigatório e só estreita, impedindo que o portal de uma loja resolva código de outra — quem autoriza é o is_public, não o parâmetro. Não resolve código de waitlist (inteiro pequeno por unidade, enumerável). Substitui get_reservation_by_code, dropada pela 109.",
      "security_definer": true,
      "advisor_lints": ["0028", "0029"]
    },
```

- [ ] **Step 3: Atualizar `_expected_advisor`**

Nas linhas 94–96, trocar:

```json
    "0028": 9,
    "0029": 14,
    "total": 23
```

por:

```json
    "0028": 10,
    "0029": 14,
    "total": 24
```

E acrescentar, ao fim do array `_doc` do `_expected_advisor` (antes do `],` da linha 93), o item:

```json
      "",
      "DELTA DA 109: `get_reservation_by_code`(text,uuid) sai (era DEFINER só com",
      "`authenticated`, logo declarava só 0029) e `resolve_tracking_token_by_code`",
      "entra em `public_anon` (DEFINER com `anon`, logo declara os dois, como a",
      "`get_public_tracking`). Então 0028 sobe de 9 para 10, 0029 fica em 14 (−1",
      "da saída, +1 da entrada) e o total vai a 24."
```

- [ ] **Step 4: Rodar os dois testes que o CI roda sobre este arquivo**

```bash
npx vitest run scripts/function-acl-allowlist.test.ts scripts/advisor-divergence-core.test.ts
```

Esperado: PASS nos dois. Se `function-acl-allowlist.test.ts` reclamar que a 109 concede a uma assinatura sem entrada, o `args` não bate exatamente com `pg_get_function_identity_arguments` — conferir contra a migration.

- [ ] **Step 5: Commit**

```bash
git add scripts/function-acl-allowlist.json
git commit -m "chore(acl): allowlist da 109 — sai get_reservation_by_code, entra o resolvedor de token"
```

---

## Task 5: `CLAUDE.md` + `AGENTS.md`

**Files:**
- Modify: `CLAUDE.md` (seção "### RLS", perto do bullet de `get_public_tracking`)
- Modify: `AGENTS.md` (espelho condensado, no ponto equivalente)

**Interfaces:** nenhuma. Documento.

**Regra dura:** os dois no MESMO commit. Nunca commitar, mergear ou dar push em alteração de só um.

- [ ] **Step 1: Acrescentar o invariante no `CLAUDE.md`**

Na seção `### RLS`, logo depois do bullet que termina em *"campo novo no payload DEVE permanecer privacy-safe."*, inserir:

```markdown
- **Consulta pública por código resolve só o TOKEN, nunca o dado.** `resolve_tracking_token_by_code(text, uuid)` devolve `reservations.id` e quem entrega payload público continua sendo `get_public_tracking` — produtor único, porque duas réguas de privacidade divergem e uma não. As duas gateiam por `units.is_public` e afrouxar uma sem a outra deixa o cliente num beco: o código resolve, o acompanhamento recusa. `p_unit_id` é obrigatório e só estreita; quem autoriza é o `is_public`. Componente de painel não entra em página pública — o `ReservaCard` no portal exibia nome completo, telefone e `notes`. [migration 109](supabase/migrations/20260922150000_109_public_code_lookup.sql).
```

- [ ] **Step 2: Espelhar no `AGENTS.md`**

O espelho vai logo **depois da linha 53** (`- \`/r/:slug\` aceita \`mode=embed\` ... \`/acompanhar/:token\` é público via \`get_public_tracking\` ...`), como bullet novo no mesmo bloco, no estilo condensado do arquivo:

```markdown
- Consulta pública por código resolve só o TOKEN (`resolve_tracking_token_by_code`), nunca o dado; payload público é só de `get_public_tracking`. Mesmo gate `units.is_public` nas duas. Componente de painel não entra em página pública.
```

- [ ] **Step 3: Conferir que os dois foram tocados**

```bash
git diff -- CLAUDE.md AGENTS.md --stat
```

Esperado: **duas** linhas. Se só uma aparecer, pare — é a regra que o `CLAUDE.md` chama de par obrigatório.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md
git commit -m "docs: invariante da consulta publica por codigo (token, nunca dado)"
```

---

## Task 6: Gates, PR, produção

**Files:** nenhum novo. Esta tarefa fecha a entrega.

**Interfaces:** consome tudo das tarefas 1–5.

- [ ] **Step 1: Gates de segurança**

Rodar os três agentes, nesta ordem, sobre a branch:

- `saas-shield-br:migration-validator` — alvo `supabase/migrations/20260922150000_109_public_code_lookup.sql`
- `saas-shield-br:tenant-isolation-auditor` — escopo: a branch
- `saas-shield-br:identity-access-auditor` — foco: grant novo a `anon` e superfície pública

Zero bloqueantes é a condição para seguir. Achado bloqueante volta para a tarefa que o originou.

- [ ] **Step 2: Suíte completa e revisão do diff**

```bash
npm run typecheck
npm run lint
npx vitest run
git status
git diff main...HEAD
```

Revisar 100% das linhas adicionadas procurando os padrões de secret do `CLAUDE.md` (`sk-`, `eyJ`, `Bearer `, `service_role`, URLs com credencial). Esta frente não deveria ter nenhum — se tiver, pare.

- [ ] **Step 3: Push e PR**

```bash
git push -u origin public-code-lookup
gh pr create --base main --head public-code-lookup --title "fix(109): consulta publica por codigo — resolve token e dropa get_reservation_by_code" --body-file <corpo>
```

O corpo do PR deve carregar: os três defeitos, a medição do 401 com a anon key real, a tabela de casos do pré-voo com os dois controles positivos, a derivação do Advisor 23→24, e o risco aceito (payload público alcançável por segredo de ~1,1e12 e não só por 2^122).

- [ ] **Step 4: Conferir `acl-estatico` na aba Checks**

```bash
gh pr checks <n>
```

`acl-estatico` **não é required status check** (branch protection exige GitHub Pro e o repo é privado por decisão). A regra operacional do `CLAUDE.md` é conferir à mão antes de mergear PR que toque migration, função SQL, grant/revoke ou ACL. Verde é condição para o merge.

- [ ] **Step 5: Merge e aplicar em produção**

```bash
gh pr merge <n> --merge --delete-branch
git checkout main && git pull --ff-only
supabase db push
supabase migration list        # 20260922150000 local == remote, sem drift
```

**Nunca colar o SQL no Studio.**

- [ ] **Step 6: Sondas de produção**

Sem MCP do Supabase nesta máquina: usar `supabase db query --linked -f <arquivo>`, e toda sonda de identidade dentro de `begin; set transaction read only; ... rollback;`. Receita completa em `memory/verificar-guard-em-producao-sem-mcp.md`.

| sonda | como | esperado |
|---|---|---|
| a RPC nova responde ao visitante | `POST /rest/v1/rpc/resolve_tracking_token_by_code` com a anon key real, `p_code` de uma reserva viva do Ren Sushi e `p_unit_id` da unidade dele | 200 com o uuid |
| a antiga sumiu | mesmo endpoint, `get_reservation_by_code` | `PGRST202` / função não existe |
| não resolve cross-unit | mesmo código, `p_unit_id` de outra unidade | `null` |
| não resolve unidade privada | código de reserva em unidade com `is_public=false` | `null` |
| Advisor de verdade | `supabase db advisors --linked --type security --output-format json` | `0028=10`, `0029=14`, total `24` |
| ACL × allowlist | RPC `audit_function_acl()` cruzada com o JSON | 16 ↔ 16, sem órfão dos dois lados |

O Advisor tem de ser lido da API, **não** inferido da linha `Equivalente-advisor` de script nenhum — é o que o `_doc` da allowlist exige no checkpoint final.

- [ ] **Step 7: Confirmação manual, que só o usuário pode dar**

Pedir ao usuário: abrir `/r/<slug>` do Ren Sushi, clicar em **"Já tem reserva? Consulte pelo código"**, digitar um código real e confirmar que chega na página de acompanhamento com os dados certos.

É o único caminho que nenhuma sonda cobre — e é exatamente o que ficou 54 dias quebrado sem ninguém notar.

---

## Notas de execução

**Duas divergências conscientes com a spec**, ambas para mais e nenhuma muda a decisão:

1. A spec listou CODE-1..CODE-7 e CONTROLE-8/9. O plano acrescentou **CODE-7 (ACL)**, espelhando o STATS-7 da 108 — é de graça e mede o `revoke`/`grant` que a migration faz. Por isso a idempotência virou CODE-8 e os controles positivos são **9 e 10**.
2. A spec descreve `ReservaCodeLookup` onde ele está hoje, dentro de `PublicPortal.tsx`. O plano **move o componente para `src/components/reserva/ReservaCodeLookup.tsx`**. Três razões: `PublicPortal.tsx` tem ~890 linhas; o teste de navegação precisa montar o componente isoladamente, o que exigiria exportar um interno da página; e a spec já pedia que a superfície pública não more no arquivo de hooks do painel — pasta pública é o lugar coerente com esse argumento. A prop (`unitId`) e o uso na linha 514 não mudam.

**Ordem das tarefas:** 1 → 2 → 3 podem ser revisadas independentemente, mas 2 depende do banco local no estado da 1. As tarefas 4 e 5 não dependem de banco e podem rodar em paralelo com a 3. A 6 fecha tudo.

**Se o Postgres local não subir:** o harness não usa Docker, mas precisa do binário do Postgres no caminho descrito no `README.md` do pré-voo. Sem ele as tarefas 1 e 2 não podem ser concluídas — **não** marque como feitas com base em leitura de código. Pare e diga ao usuário: controle positivo não executado é a diferença entre "a guarda funciona" e "o teste não testa nada".
