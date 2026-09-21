# Guard de tenant na RPC `get_customer_stats` — design

Data: 2026-09-21
Projeto Supabase: `gbabxcrntkwgblgqsiit` (Moralles Reservas)
Precedente direto: [frente do advisor](2026-08-17-advisor-warnings-hardening-design.md)
(migrations 106 e 107, aplicadas em 2026-09-21)

## 1. O problema, medido

`public.get_customer_stats(p_customer_id uuid, p_unit_id uuid default null)` é
`SECURITY DEFINER`, está exposta pelo PostgREST e **não tem `auth.uid()` em lugar
nenhum**. Corpo em produção, lido pela API antes de qualquer mudança:

```sql
-- language sql, stable security definer, set search_path to 'public'
with r as (
  select status, date from reservations
  where customer_id = p_customer_id and (p_unit_id is null or unit_id = p_unit_id)
), agg as ( ... )
select total, confirmed, no_shows, cancelled, ..., last_visit from agg;
```

Consequência: **qualquer usuário logado — inclusive um sem nenhuma membership —
lê estatística de cliente de qualquer organização** por
`POST /rest/v1/rpc/get_customer_stats`. Com `p_unit_id => null` o filtro de
unidade é pulado e o agregado cobre toda unidade de toda org.

É a única entrada `authenticated` de
[scripts/function-acl-allowlist.json](../../../scripts/function-acl-allowlist.json)
sem guard interno de tenant. Pré-existente à frente do advisor, que dropou o
irmão pior (o overload de 1 argumento, sem filtro algum) na migration 107 e
registrou este como P1 de frente própria.

Estreitar o grant não resolve: `authenticated` é o único papel Postgres que
significa "logado", e todo chamador legítimo também é só `authenticated`.

### O que já existe e serve de molde

A irmã `public.get_customer_stats_bulk(uuid[], uuid)` guarda assim (corpo em
produção):

```sql
allowed as (
  select c.id, c.organization_id from public.customers c
   where c.id = any(p_customer_ids)
     and (app_private.is_platform_admin(v_caller)
          or app_private.is_org_member(v_caller, c.organization_id))
)
```

E `app_private.is_org_member` é, literalmente:

```sql
select exists (
  select 1 from unit_members um join units u on u.id = um.unit_id
  where um.user_id = p_user_id and u.organization_id = p_org_id
);
```

### Superfície de chamada

Um único chamador: [src/hooks/useCustomers.ts:74](../../../src/hooks/useCustomers.ts),
consumido pela ficha do cliente em
[src/pages/gestao/Clientes.tsx:405](../../../src/pages/gestao/Clientes.tsx). Ele
**sempre** manda `p_unit_id` real (`enabled: !!customerId && !!unitId`).
Nenhuma Edge Function referencia a RPC — logo **esta frente não tem redeploy**.

## 2. A decisão central: de onde vem o tenant

O guard resolve a organização a partir do **próprio recurso** — a
`customers.organization_id` do `p_customer_id` — e nunca do `p_unit_id`, que é
parâmetro do chamador e portanto do atacante. Recurso que pertence à
organização (`customers` pertence à org, não à unidade) guarda por
`is_org_member`, com o paralelo obrigatório `is_platform_admin`.

O `p_unit_id` **continua aceitando `null`**, com o mesmo significado de hoje
(agregado da org inteira). O guard de org já fecha o buraco, e a irmã já expõe
`total_org` a qualquer membro da org — exigir unidade aqui inventaria uma
segunda semântica sem fechar nada a mais.

Chamador sem direito **recebe `42501`**, não zeros. É o padrão de guard de RPC
que o `CLAUDE.md` documenta (`enter_waitlist`, `get_undelivered_notifications`),
aparece no log do Postgres e dá ao pré-voo uma asserção limpa para medir.
Cliente inexistente e cliente alheio caem no **mesmo ramo**: a recusa não é
oráculo de existência.

## 3. O corpo novo

```sql
create or replace function public.get_customer_stats(
  p_customer_id uuid,
  p_unit_id uuid default null
)
returns table (total integer, confirmed integer, no_shows integer,
               cancelled integer, no_show_rate numeric, last_visit date)
language plpgsql
stable security definer
set search_path to 'public', 'app_private', 'pg_temp'
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

  return query
  with r as (
    select res.status, res.date from public.reservations res
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
```

Três pontos que não são estilo:

- **Os aliases `a_*` são obrigatórios.** Em plpgsql, as colunas do
  `returns table` (`total`, `confirmed`, `cancelled`, `last_visit`) são
  variáveis OUT, e referência nua a esses nomes dentro da query estoura
  ambígua em tempo de execução. O `language sql` de hoje não tem esse problema;
  a troca de linguagem o traz junto. O pré-voo executa a função, então pega.
- **A aritmética não muda uma vírgula**, incluindo o `0::numeric` quando o
  denominador é zero. A irmã devolve `null` ali; não vou alinhar — é mudança de
  comportamento sem pedido, e a UI já trata os dois casos
  ([Clientes.tsx:409-411](../../../src/pages/gestao/Clientes.tsx)).
- **O shape de retorno fica byte-idêntico** porque `create or replace` não pode
  alterar tipo de retorno. É também o que garante que nenhum chamador quebre
  por forma.

## 4. Migration 108 — o que mais entra

Arquivo `supabase/migrations/20260921120000_108_customer_stats_tenant_guard.sql`
(timestamp maior que o da 107, `20260910121000`). Além do corpo:

```sql
revoke all on function public.get_customer_stats(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_customer_stats(uuid, uuid) to authenticated;
```

Reafirmado mesmo sendo `create or replace` (que preserva `proacl`), porque assim
a migration segue correta se a função tiver sido dropada e recriada no caminho —
recriar concede `EXECUTE` a `PUBLIC` por default nesta plataforma. Idempotente
por construção: `create or replace` mais `revoke`/`grant` absolutos.

Aplicada **só** por `supabase db push`, nunca pelo SQL Editor.

A função não sai de `public` nem perde o grant a `authenticated`, então o
Advisor **continua `0028=9 | 0029=14 | total=23`**. O `_expected_advisor` da
allowlist não muda; muda só o `why` da entrada, que hoje documenta o buraco como
aceito e passa a documentar o guard.

## 5. O caminho de erro no frontend

Hoje, se a query falhar, [Clientes.tsx:441](../../../src/pages/gestao/Clientes.tsx)
cai no `: null` e a caixa "Histórico" renderiza vazia — sem explicação e sem
retry. O `42501` torna esse caminho alcançável, então entra no escopo um quarto
ramo `isError` com mensagem curta e "Tentar de novo", seguindo a regra de listas
do `CLAUDE.md` (silenciar erro como lista vazia já mascarou incidente em
produção). É a única mudança de frontend.

## 6. Invariante para `CLAUDE.md` + `AGENTS.md`

Par obrigatório, mesmo commit. A lição que ainda não está escrita:

> **Guard de RPC resolve o tenant a partir do PRÓPRIO recurso, nunca do id de
> escopo que o chamador mandou.** O `p_unit_id` é parâmetro do atacante; a org
> sai do `customers` pelo `p_customer_id`. Recurso que pertence à organização
> guarda por `app_private.is_org_member`, não por `is_unit_member` — e sempre
> com o paralelo `is_platform_admin`, que opera com pseudo-membership fabricada
> e não tem linha em `unit_members`.

## 7. Como se prova

### Pré-voo local

Mesmo harness de [supabase/tests/local-preflight/](../../../supabase/tests/local-preflight/README.md),
mesmo banco `advisor106`, depois do `11-overloads-107.sql`. Arquivo novo
`12-customer-stats-108.sql`.

O corpo pré-108 **já está versionado no harness**: o
`09a-advisor-bootstrap.sql` traz `get_customer_stats` (os dois overloads,
extraídos de produção) desde a Task 5 da 107. O `12` portanto não precisa
recriar a função — quando ele roda, `public.get_customer_stats(uuid,uuid)` já
existe na forma sem guard. O que o `12` precisa criar, e nenhum arquivo do
harness tem, são as **reservas**: sem elas todo agregado é zero e o controle
positivo não distinguiria vazamento de "cliente sem reserva nenhuma".

| Caso | O que mede |
|---|---|
| `STATS-1` | Membro da org lê o próprio cliente e os números batem com os do corpo pré-108 |
| `STATS-2` | Membro da org A pedindo cliente da org B → `42501` |
| `STATS-3` | Sem sessão (`auth.uid()` null) → `42501` |
| `STATS-4` | `platform_admin` sem linha em `unit_members` passa |
| `STATS-5` | `p_customer_id` inexistente cai no mesmo ramo do proibido (sem oráculo) |
| `STATS-6` | `p_unit_id => null` segue funcionando para membro da org |
| `STATS-7` | ACL: `authenticated` tem `EXECUTE`, `anon` e `public` não |
| `STATS-8` | Idempotência medida através de **duas execuções** do arquivo |

### Controle positivo

`13-controles-108.sql`, na convenção dos `NN-controles-*` (roda sem
`ON_ERROR_STOP`, e a 108 é reaplicada depois): repõe o corpo sem guard e o caso
de tenant cruzado **tem de falhar**. Sem isso, "passou" não distingue a guarda
funcionando de teste sem força — e tem loja real em produção. O `CONTROLE-10` do
`10-controles-106.sql` já faz exatamente essa manobra para a irmã e serve de
molde.

O `README.md` do harness é atualizado no mesmo commit: tabela de arquivos,
tabela de ordinais e sequência de execução.

### Gates

`saas-shield-br:migration-validator` e `saas-shield-br:tenant-isolation-auditor`
(toca banco, RLS e multi-tenant), `npm run typecheck` (`tsc -b --noEmit`),
`npm test`, o check `acl-estatico` na aba Checks do PR e
`scripts/audit-function-acl.ts` contra o banco real depois do push — com a chave
de service role limpa do ambiente no fim.

### Verificação em produção

1. **Ramo `unauthenticated`, medível sozinho:** chamar a RPC pelo MCP, onde
   `auth.uid()` é null, e ver `42501` em vez de um agregado de zeros.
2. **Ramo legítimo:** o usuário abre `/g/moralles-centro/clientes` e uma ficha;
   os números aparecem. É a mesma confirmação que ficou pendente da frente do
   advisor, aproveitada aqui.
3. **Recusa cross-org com identidade real — PENDENTE DE AUTORIZAÇÃO EXPLÍCITA.**
   Rodar a RPC em transação somente-leitura com `request.jwt.claims` no `sub` do
   usuário, pedindo um cliente do Ren Sushi, e ver `42501` em vez do agregado.
   É leitura, exercita a recusa e não toca dado nenhum, mas usa a identidade do
   usuário — **não executar sem um "pode" explícito dele**. Sem essa
   autorização, a cobertura cross-org fica no pré-voo (`STATS-2`), que a mede
   com controle positivo.

## 8. O que não entra

- `get_customer_stats_bulk` — já guardada, não se mexe.
- Trocar o `0::numeric` por `null` para alinhar com a irmã.
- Remover o `default null` do `p_unit_id`.
- A Edge Function morta `update-reservation` (sem chamador em lugar nenhum) —
  fica na lista de pendências, frente separada.
- Reescrever o cabeçalho da 106, que tem a frase imprecisa sobre "fila pública":
  migration aplicada não se reescreve. Fica para um `comment on function` quando
  uma próxima migration tocar aquela área.

## 9. Riscos e o que os cobre

| Risco | Cobertura |
|---|---|
| Ambiguidade plpgsql entre variável OUT e coluna | Aliases `a_*`; o pré-voo executa a função e o erro é de tempo de execução |
| Guard recusar chamador legítimo | `is_org_member` é "existe `unit_members` em qualquer unidade da org", e a lista de clientes é escopada pela org da unidade atual — membro da unidade passa por construção; `platform_admin` pelo ramo próprio. `STATS-1` e `STATS-4` medem |
| ACL zerada por recriação | `revoke`/`grant` explícitos na migration; `STATS-7` e o `audit-function-acl.ts` medem |
| Regressão no Advisor ou no guardrail | Nada sai de `public`, grant preservado: segue 23. O `_expected_advisor` não muda, então divergência vira erro do guardrail |
| Recusa virar oráculo de existência | Inexistente e proibido no mesmo ramo; `STATS-5` mede |

## 10. Rollback

`create or replace` com o corpo pré-108, que fica versionado em dois lugares do
harness: `09a-advisor-bootstrap.sql` (extraído de produção) e o `CONTROLE-26` do
`13-controles-108.sql`, que o repõe de propósito. Reverter reabre o
buraco, então só se o guard quebrar chamador legítimo em produção — cenário que
`STATS-1`/`STATS-4` existem para tornar improvável. Não há dado migrado, então o
rollback não perde nada.
