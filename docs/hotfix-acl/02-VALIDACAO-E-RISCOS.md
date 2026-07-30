# Hotfix ACL — validação, impacto e riscos de quebra

> Acompanha [01-INVENTARIO-E-CLASSIFICACAO.md](01-INVENTARIO-E-CLASSIFICACAO.md) e a migration
> `20260730160000_085_harden_public_function_acl.sql`. **Nada foi aplicado.**

---

## 1. Riscos de quebra — leia antes de aplicar

### R1 (evitado por desenho) — helpers de RLS

Revogar `EXECUTE` de `is_unit_member` / `is_platform_admin` / `is_org_member` **derrubaria a
aplicação**. Policy é avaliada no contexto de privilégio de quem consulta: sem `EXECUTE`, a query
não é negada — ela estoura com `permission denied for function`. `is_platform_admin` aparece em
26 policies de `authenticated`; `is_unit_member` em 18 de `authenticated` **e 24 com
`roles={public}`**, que incluem `anon`.

**A migration 085 não toca nenhuma das três.** Estão na allowlist com justificativa. Se alguém
"limpar" a allowlist no futuro, o portal público de fila e o painel inteiro caem juntos.

### R2 (evitado por desenho) — `normalize_br_phone`

`customers_canonical_phone_trg` é `SECURITY INVOKER`. Num INSERT anônimo em `customers` ele roda
**como `anon`**, e a chamada interna a `normalize_br_phone(text)` é checada em runtime nesse
papel. Revogar quebraria a criação pública de cliente — ou seja, toda reserva pelo portal.

**A 085 mantém o grant**, com o motivo escrito na allowlist para ninguém "otimizar" depois.

### R3 (aceito, com plano) — `unit_role` e `next_waitlist_code`

Revogadas por default-deny: nenhuma tem caller no repositório, e `next_waitlist_code` só tem o
grant histórico da migration 036. **Risco residual:** consumidor não mapeado (SQL manual, job
externo, código que o grep não pegou).

Se quebrar, o sintoma é claro (`permission denied for function`) e o conserto é uma linha:

```sql
grant execute on function public.next_waitlist_code(uuid) to anon, authenticated;
```

E a função **volta ao inventário reclassificada** — não só o grant.

### R4 (aceito) — `get_reservation_by_code(text)`, overload de 1 argumento

Sem caller localizado. Vai para `authenticated` junto com o overload de 2 argumentos, o que é
mais permissivo que o default-deny estrito, de propósito: perder `anon` aqui é reversível, mas
se houver alguma página pública de consulta por código que o grep não achou, ela quebra.

**Verificar durante o smoke test do portal.**

### R5 (operacional, importante) — ordem de migrations vs. Fase 5b

`main` está em **076**. A 5b tem **077–084**, escritas e **não aplicadas**. Este hotfix é **085**,
com timestamp de hoje (`20260730160000`), posterior a todas.

Aplicar o hotfix em produção **antes** da 5b significa que, quando a 5b for empurrada depois, suas
migrations 077–084 terão timestamp **anterior** ao 085 já aplicado. O `supabase db push` detecta
isso como fora de ordem e recusa por padrão.

**Remédio, no momento do push da 5b:**

```bash
supabase db push --include-all
```

Não é contorno improvisado: é o flag existente exatamente para migrations pendentes mais antigas
que a última aplicada. **Deve entrar no roteiro da 5b**, senão o push falha e alguém "conserta"
renumerando uma branch já validada.

### R6 (documental) — a migration 084 da 5b

A 084 revoga as mesmas 14 `trigger_*`. Depois deste hotfix ela vira **no-op idempotente** — sem
problema. Mas o cabeçalho dela atribui a causa só ao default do `CREATE FUNCTION` para `PUBLIC`,
o que agora sabemos ser **incompleto**: o que trava é o grant DIRETO a `anon`/`authenticated`
vindo do `pg_default_acl`, que é justamente o que faz `revoke ... from public` não bastar.

**Ação, ao atualizar a 5b com a `main` (passo 14):** corrigir o cabeçalho da 084 para a causa
real, apontando para este documento. Não editar agora — a 5b está congelada.

### R7 (residual, é o motivo do guardrail existir)

`pg_default_acl` tem entrada para **duas** roles criadoras: `postgres` e `supabase_admin`. A 085
corrige só `postgres` — `supabase_admin` é da plataforma e alterá-la é mudança não auditada que a
Supabase pode reverter em manutenção. Portanto:

- função criada por `supabase_admin` continua nascendo aberta;
- a Supabase pode restaurar os defaults de `postgres` numa atualização.

**Nos dois casos o buraco reabre em silêncio.** É por isso que `scripts/audit-function-acl.ts`
existe e por isso ele deve rodar periodicamente, não uma vez só.

---

## 2. Impacto previsto, por função

**Como ler a coluna "Depois".** Ela lista os papéis com **grant explícito** depois da 085. Três
distinções que a versão anterior desta tabela embaralhava:

- **O dono (`postgres`) nunca aparece.** Ele tem EXECUTE **implícito** por ser dono, em toda
  função, e nenhum `revoke` tira isso. "Sem grant nenhum" não significa "ninguém executa" —
  significa "só o dono".
- **`service_role` aparece quando o grant pré-existente foi mantido.** A 085 revoga de
  `public, anon, authenticated` e **não** revoga de `service_role`. Então nenhuma função aqui é
  literalmente "service_role only": o dono também executa.
- **Exposição via PostgREST ≠ execução interna.** Só `anon` e `authenticated` alcançam a função
  por `POST /rest/v1/rpc/<nome>`. `postgres` (cron, DDL) e `service_role` (Edge Functions)
  executam por conexão direta, fora do PostgREST. Fechar as duas primeiras é o objetivo; as
  outras duas não são superfície pública.

| Função | Antes | Depois | Quem quebra se eu errei |
|---|---|---|---|
| `append_conversation_message(uuid, jsonb)` | anon, authenticated, service_role, postgres | **service_role** | `webhook-whatsapp`, `send-manual-message`, `_shared/conversation-log.ts` — todos usam service role key |
| `mark_outbox_done(uuid)` | PUBLIC, anon, authenticated, service_role | **service_role** | `process-notification-outbox` |
| `mark_outbox_failed(uuid, text)` | PUBLIC, anon, authenticated, service_role | **service_role** | `process-notification-outbox` |
| `list_orphan_unit_assets(integer)` | anon, authenticated, service_role | **service_role** | `cleanup-orphan-assets` |
| 14 × `trigger_*()` | PUBLIC, anon, authenticated, service_role | **dono + service_role** | os 14 `cron.job` — todos `username='postgres'`, que é o dono |
| `cleanup_processed_messages()` | PUBLIC, anon, authenticated, service_role | **dono + service_role** | ninguém (sem caller, sem cron) |
| `cleanup_webhook_executions()` | PUBLIC, anon, authenticated, service_role | **dono + service_role** | ninguém |
| `get_undelivered_notifications(uuid, timestamptz)` | anon, authenticated, service_role | **authenticated** | `/o/:slug/entregas` |
| `search_reservations(uuid, text, date, text)` | PUBLIC, anon, authenticated, service_role | **authenticated** | busca de reservas do painel |
| `get_reservation_by_code(text, uuid)` | anon, authenticated, service_role | **authenticated** | busca por código no painel |
| `get_reservation_by_code(text)` | anon, authenticated, service_role | **authenticated** | consumidor não mapeado (R4) |
| `unit_role(uuid, uuid)` | anon, authenticated, service_role | **só o dono** | ninguém encontrado (R3) |
| `next_waitlist_code(uuid)` | anon, authenticated, service_role | **só o dono** | ninguém encontrado (R3) |
| 10 × allowlist `PUBLIC_ANON` | anon, authenticated (+PUBLIC em algumas) | **anon, authenticated** (PUBLIC removido onde havia) | portal público — é o que o smoke test cobre |
| `is_unit_member` / `is_platform_admin` / `is_org_member` | inalteradas | **inalteradas** | — (R1) |
| funções que retornam `trigger` | inalteradas | **inalteradas** | — (fora do escopo, §1.2 do inventário) |

---

## 3. Comandos exatos — ANTES de aplicar

Rodar e **guardar a saída** (é o "antes" do registro antes/depois).

```sql
-- A1. Superfície exposta hoje (a linha de base a comparar depois)
select p.proname, pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef as secdef, p.proacl::text as acl
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.prokind = 'f'
   and p.prorettype <> 'trigger'::regtype
   and has_function_privilege('anon', p.oid, 'EXECUTE')
 order by p.proname;

-- A2. Default privileges (a causa raiz)
select defaclrole::regrole::text as role_criadora, defaclacl::text
  from pg_default_acl
 where defaclobjtype = 'f' and defaclnamespace = 'public'::regnamespace;

-- A3. Cron: confirma que roda como o dono (é o que torna o revoke seguro)
select jobname, username, active, command from cron.job order by jobname;

-- A4. Dependência de RLS (é o que a migration NÃO pode tocar)
select tablename, policyname, array_to_string(roles, ',') as papeis
  from pg_policies
 where schemaname = 'public'
   and coalesce(qual,'') || coalesce(with_check,'') like '%is_unit_member%'
 order by tablename, policyname;
```

## 4. Comandos exatos — DEPOIS de aplicar

```sql
-- D1. Superfície exposta: esperado SÓ a allowlist + os 3 helpers de RLS
select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.proacl::text
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.prokind = 'f'
   and p.prorettype <> 'trigger'::regtype
   and has_function_privilege('anon', p.oid, 'EXECUTE')
 order by p.proname;

-- D2. Diff antes/depois a partir do snapshot que a própria migration gravou
select s.function_name, s.identity_args, s.acl as antes, p.proacl::text as depois
  from public.function_acl_snapshot s
  join pg_proc p
    on p.proname = s.function_name
   and pg_get_function_identity_arguments(p.oid) = s.identity_args
   and p.pronamespace = 'public'::regnamespace
 where s.label = 'pre-085'
   and coalesce(s.acl,'') is distinct from coalesce(p.proacl::text,'')
 order by s.function_name;

-- D3. Os itens nomeados do achado, um a um: esperado tudo `false`
select 'append_conversation_message' as fn,
       has_function_privilege('anon','public.append_conversation_message(uuid,jsonb)','EXECUTE') as anon,
       has_function_privilege('authenticated','public.append_conversation_message(uuid,jsonb)','EXECUTE') as auth
union all select 'cleanup_processed_messages',
       has_function_privilege('anon','public.cleanup_processed_messages()','EXECUTE'),
       has_function_privilege('authenticated','public.cleanup_processed_messages()','EXECUTE')
union all select 'cleanup_webhook_executions',
       has_function_privilege('anon','public.cleanup_webhook_executions()','EXECUTE'),
       has_function_privilege('authenticated','public.cleanup_webhook_executions()','EXECUTE')
union all select 'trigger_whatsapp_enforcement (se 083 aplicada)',
       has_function_privilege('anon','public.trigger_outbox_processor()','EXECUTE'),
       has_function_privilege('authenticated','public.trigger_outbox_processor()','EXECUTE');

-- D4. Default privilege da role auditada: sem anon, sem authenticated
select defaclrole::regrole::text, defaclacl::text
  from pg_default_acl
 where defaclobjtype = 'f' and defaclnamespace = 'public'::regnamespace;

-- D5. Portal continua acessível (esperado tudo `true`)
select 'get_unit_public'      as fn, has_function_privilege('anon','public.get_unit_public(text)','EXECUTE') as anon
union all select 'get_public_tracking', has_function_privilege('anon','public.get_public_tracking(uuid)','EXECUTE')
union all select 'enter_waitlist',      has_function_privilege('anon','public.enter_waitlist(uuid,text,text,integer,text,text,time without time zone)','EXECUTE')
union all select 'normalize_br_phone',  has_function_privilege('anon','public.normalize_br_phone(text)','EXECUTE')
union all select 'is_unit_member',      has_function_privilege('anon','public.is_unit_member(uuid,uuid)','EXECUTE');
```

## 5. Roteiro de validação — os 12 pontos

| # | O que provar | Como | Esperado |
|---|---|---|---|
| 1 | 14 `trigger_*` não executáveis por anon/authenticated | D1 | nenhuma aparece |
| 2 | Cron segue rodando como `postgres` | A3 depois da aplicação + `select * from cron.job_run_details order by start_time desc limit 20` | `status='succeeded'` nas execuções seguintes |
| 3 | `cleanup_*` não chamáveis por anon | D3 | `anon=false` |
| 4 | `append_conversation_message` não chamável por anon/authenticated | D3 | ambos `false` |
| 5 | Caller legítimo de `append_conversation_message` funciona | Mensagem real no WhatsApp da unidade de teste → conferir que aparece na thread em `/g/:slug/conversas` | mensagem na thread; `webhook_executions.outcome='success'` |
| 6 | RPCs públicas do portal seguem acessíveis | D5 + abrir `/r/:slug` deslogado, em aba anônima | portal carrega; fila aceita entrada |
| 7 | Função tenant-scoped respeita RLS/guarda | Logar como `operador` de uma unidade e abrir `/o/:slug/entregas` | lista da própria unidade; erro ao forjar `unit_id` de outra |
| 8 | `get_undelivered_notifications` bloqueia sem vínculo | Chamar a RPC com a **anon key** | `permission denied for function` (antes era `forbidden` da guarda interna) |
| 9 | Nenhuma função interna executável por `PUBLIC` | `npx deno@2.1.4 run --allow-net --allow-env --allow-read scripts/audit-function-acl.ts` | exit 0, "Sem violações" |
| 10 | O guardrail detecta função insegura de verdade | **Fase D de [03-ENSAIO-ORDEM-REAL.md](03-ENSAIO-ORDEM-REAL.md) — banco local, NUNCA produção** | exit 1, nomeando `fn_teste_inseguro()` |
| 11 | Função nova não nasce aberta | **Fase D do ensaio, local** | `proacl` sem `anon`/`authenticated` |
| 12 | Migration é idempotente | Aplicar, rodar D1, aplicar de novo, rodar D1 | saída idêntica; sem erro |

**Smoke test funcional obrigatório antes de considerar validado** (é o que R1–R4 podem quebrar):
portal público `/r/:slug` (reserva ponta a ponta), entrada pública na fila, login de `operador`,
login de `gerente`, painel de conversas com envio manual, e uma execução de cron observada
(`process-notification-outbox` roda a cada minuto — é o mais rápido de confirmar).

## 6. Em produção, só auditoria não destrutiva

**Decisão do dono:** não se cria função insegura em produção para provar que o guardrail
detecta. Os pontos 10 e 11 são provados **no clone efêmero** — Fase D de
[03-ENSAIO-ORDEM-REAL.md](03-ENSAIO-ORDEM-REAL.md).

Em produção, antes e depois da 085, roda-se **apenas** A1–A4, D1–D5, o guardrail e o smoke test
funcional. Nada que crie, altere ou remova objeto além do que a própria migration faz.

## 7. Ordem operacional

1. **Ensaio completo da ordem real `076 → 085 → 077–084` em clone efêmero do schema de
   produção** — [03-ENSAIO-ORDEM-REAL.md](03-ENSAIO-ORDEM-REAL.md), Fases A–E. **Bloqueante:**
   sem ele, não se aplica nada em produção.
2. Revisar o diff completo desta branch (`git diff main...HEAD`).
3. Rodar A1–A4 em produção e **arquivar a saída**.
4. Aplicar **só** a 085: `supabase db push` (a branch de hotfix não contém 077–084 — confirmar
   com `git status` que o ensaio não deixou arquivo para trás).
5. Rodar D1–D5 e o guardrail contra produção.
6. Smoke test funcional (§5).
7. Registrar antes/depois no fim deste documento.
8. Merge e tag do hotfix na `main`.
9. Atualizar `billing-asaas/fase-5b` com a `main`.
10. Corrigir o cabeçalho da 084 para a causa raiz real (R6) — ela ainda não foi aplicada.
11. `supabase db push --include-all` para as 077–084, conforme a ordem já ensaiada (R5).
12. Rodar o guardrail de novo.
13. Só então deploy das Edge Functions e os 44 blocos do Sandbox da 5b.

## 7.1 Fora do escopo deste hotfix — o histórico de migrations não replaya

O ensaio original tentou reconstruir o banco do zero (`supabase db reset`) e descobriu que **o
histórico versionado não consegue reconstruir o banco**: 54 migrations usam
`create or replace function` para alterar retorno tabular, e só 4 usam `drop function` antes.
Num replay limpo isso estoura com `42P13 — cannot change return type of existing function`.

**Isso é anterior à 085, independente dela e muito maior que ela.** Produção nunca replaya o
histórico do zero — aplica a 085 sobre o schema que já tem. Por isso a validação da 085 passou a
usar **clone efêmero do schema real de produção** (Fases A–E do 03), e não `db reset`.

- Evidência completa e as duas tentativas de replay: branch `investigation/migration-history-replay`.
- Correção definitiva: **projeto separado de baseline**, com spec própria, depois deste hotfix.
- **Nada disso entra nesta branch.** Nenhuma migration histórica é editada aqui.

### Follow-up de CI (obrigatório)

Adicionar verificação periódica que reconstrói o banco do zero e falha se qualquer migration não
aplicar. O defeito viveu meses no repositório porque nada nunca reconstruiu a partir do histórico
— só o ensaio exigido para a 085 o expôs. Entra na spec da baseline.

## 7.1 Exceção autorizada — reparo de reprodutibilidade nas migrations 005 e 013

> Descoberto durante a Fase A do ensaio ([03-ENSAIO-ORDEM-REAL.md](03-ENSAIO-ORDEM-REAL.md)),
> em 2026-07-30. **Não tem relação com a 085** — é anterior a ela e independente.
> Exceção autorizada pelo dono à regra "não editar migration já aplicada".

### O que aconteceu

`supabase db reset` num banco local limpo falhou na migration 005:

```
ERROR: syntax error at or near "time" (SQLSTATE 42601)
Applying migration 20260427200008_005_hardening.sql
```

Hipótese descartada: **não é diferença de versão de Postgres.** A imagem local baixada pelo CLI é
`public.ecr.aws/supabase/postgres:17.6.1.111` — idêntica à de produção (`17.6.1.111`).

### Evidência

**1. As duas migrations constam como aplicadas em produção**

```sql
select version from supabase_migrations.schema_migrations
 where version in ('20260427200008','20260504170218');
-- => 20260427200008, 20260504170218
```

**2. Assinatura completa das funções afetadas** (dois overloads, um por arquivo)

- `public.get_reservation_by_code(p_code text)` — definida na 005
- `public.get_reservation_by_code(p_code text, p_unit_id uuid DEFAULT NULL::uuid)` — definida na 013

**3. `pg_get_functiondef` em produção mostra a coluna QUOTADA**

```
CREATE OR REPLACE FUNCTION public.get_reservation_by_code(p_code text)
 RETURNS TABLE(id uuid, reservation_code text, date date, "time" time without time zone,
               party_size integer, status text, notes text, created_at timestamp with time zone,
               updated_at timestamp with time zone, customer_name text, customer_phone text,
               customer_email text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
```

O overload de 2 argumentos tem exatamente o mesmo `RETURNS TABLE`, também com `"time"`.

Repare: `date` aparece **sem** aspas e `time` **com**. `DATE` e `TIME` são ambos
`col_name_keyword`, mas só `TIME` colide na gramática de `RETURNS TABLE` — o que explica por que
`create table` com as duas colunas (migration 001, linhas 27–28) aplica sem problema, e
`returns table` não.

**4. O trecho inválido versionado no repositório**

```sql
-- supabase/migrations/20260427200008_005_hardening.sql:18-22
returns table (
  id                uuid,
  reservation_code  text,
  date              date,
  time              time,        -- <<< sem aspas: sintaxe inválida
```

```sql
-- supabase/migrations/20260504170218_013_multi_tenant.sql:588-592
returns table (
  id                uuid,
  reservation_code  text,
  date              date,
  time              time,        -- <<< sem aspas: sintaxe inválida
```

Varredura das 15 migrations com `returns table`: **apenas estas duas linhas** têm o defeito.

### Justificativa da exceção

- O SQL versionado é **sintaticamente inválido** e nunca poderia ter produzido o schema existente.
- Produção comprova que as funções foram criadas com `"time"` entre aspas.
- A edição **não muda comportamento** e **não será reaplicada em produção**: as duas versões já
  constam em `schema_migrations`, então `db push` não as re-executa.
- Ela apenas **reconcilia o histórico versionado com o SQL que de fato foi executado**.
- Sem isso, o repositório **não consegue reconstruir um banco novo** por `db reset` — o que torna
  impossível o ensaio da ordem real, agora e no futuro.

**Nenhuma migration nova é criada para isto**: o schema de produção já está correto.

### Follow-up de CI (obrigatório)

Adicionar verificação periódica que reconstrói o banco do zero (`supabase db reset` contra um
Postgres descartável) e falha se qualquer migration não aplicar. Este defeito viveu meses no
repositório sem ser notado porque nada nunca reconstruiu a partir do histórico — só o ensaio
exigido para a 085 o expôs. Sem essa verificação, o histórico volta a ficar irrecuperável e só se
descobre no próximo ambiente novo.

## 8. CI — o guardrail é controle obrigatório, não script opcional

A prevenção no banco é **parcial** (seção 8 da 085): `ALTER DEFAULT PRIVILEGES ... REVOKE
EXECUTE ON FUNCTIONS FROM PUBLIC` foi **no-op** no ambiente ensaiado, então função nova continua
nascendo executável por `anon` via o grant implícito a PUBLIC. Quem impede reabertura é o CI.

Duas camadas, em [.github/workflows/function-acl-audit.yml](../../.github/workflows/function-acl-audit.yml):

| Camada | O que faz | Onde roda |
|---|---|---|
| **`acl-estatico`** — [function-acl-allowlist.test.ts](../../scripts/function-acl-allowlist.test.ts) | Cruza as migrations com a allowlist versionada. Falha nomeando função, aridade e regra. Sem banco, sem segredo. | **Todo PR e push na `main`** |
| **`acl-com-banco`** — [audit-function-acl.ts](../../scripts/audit-function-acl.ts) | Lê o ACL REAL pela RPC `audit_function_acl()`. É o guardrail autoritativo. | `workflow_dispatch` + **local, contra o clone efêmero** |

**Por que a camada com banco ainda não roda em PR:** o histórico de migrations não replaya, então
o CI não consegue construir um banco descartável; e apontar o CI para produção está proibido. A
camada estática cobre o vetor visível sem banco — alguém abrir uma função numa migration nova sem
classificar — que é o caminho mais provável de regressão vinda de código.

**O que a camada estática NÃO cobre**, e por isso a com-banco continua obrigatória antes de cada
aplicação em produção: grant feito fora de migration (dashboard, `psql` manual), default
privilege restaurado pela plataforma, e função criada por `supabase_admin`.

**Marcar `acl-estatico` como required status check** na proteção da branch — sem isso o workflow
reprova mas não bloqueia o merge. A allowlist **nunca** é atualizada automaticamente: abrir
superfície nova exige editar o JSON no mesmo PR, com justificativa, e passar por revisão.

## 9. Follow-up de desenho — event trigger (NÃO improvisar na 085)

Único caminho conhecido para fechar de verdade a superfície B (grant implícito a PUBLIC em função
nova). Exige spec própria, porque intercepta **todo** DDL do banco. A avaliação precisa cobrir:

- quais roles podem criar funções, e se o trigger alcança todas (`supabase_admin` inclusive);
- como identificar com segurança as funções em `public` criadas no comando;
- como revogar `PUBLIC`, `anon` e `authenticated` depois do DDL sem desfazer grant explícito
  legítimo feito na mesma migration (ordem importa: o `grant` da RPC pública vem depois do
  `create`);
- comportamento durante migrations, no dashboard, em `create extension` e em operações internas
  da plataforma;
- risco de recursão (o próprio trigger executa DDL?), de travar migration e de interferir com
  objetos gerenciados pela Supabase;
- privilégios necessários para criar e manter o trigger, e se a Supabase os concede;
- estratégia de rollback e de observabilidade (como saber que o trigger agiu, e quando falhou).

**Mesmo com o event trigger, o CI não sai.** Alteração ou restauração feita pela plataforma pode
reabrir a superfície por fora do trigger — o guardrail é a única verificação que enxerga o estado
real do banco.

## 10. Registro antes/depois

> A preencher por quem aplicar. Colar a saída de A1 e de D1, mais o resultado do guardrail e do
> smoke test. Sem isso o hotfix não é considerado validado.
