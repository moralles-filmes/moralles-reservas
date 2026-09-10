# Pré-voo local — replay de migration contra Postgres real, sem Docker

Este diretório existe porque a Fase 6b fez exatamente este trabalho (a 089 real
aplicada verbatim, casos FK-A..FK-G, 11/11) e **não deixou nada commitado**. A
Fase 6c teve de reconstruir o ambiente do zero para rodar NOTE-A..NOTE-D. Da
terceira vez em diante, é só rodar.

**O que este ambiente prova:** comportamento de trigger, CHECK, FK, ordem de
execução, idempotência de migration.
**O que ele NÃO prova:** `verify_jwt` e PostgREST — isso depende de Supabase de
verdade. É por isso que o caso `NOTE-E` de
[../whatsapp-instances.integration.md](../whatsapp-instances.integration.md)
continua pendente mesmo com NOTE-A..NOTE-D verdes.

**Sobre RLS, grants e ACL:** a frase anterior deste README dizia que o ambiente
não os provava. Aquilo descrevia o conjunto de ARQUIVOS que existia, não um
limite do ambiente — o `00-bootstrap.sql` já cria os papéis
`anon`/`authenticated`/`service_role`, então `set local role` mais
`set local request.jwt.claims` exercitam policy, grant de tabela e ACL de função
de verdade. É o que `09-advisor-hardening.sql` faz. O que segue fora do alcance
local é a **exposição PostgREST**: essa metade é do
[../../../scripts/audit-function-acl.ts](../../../scripts/audit-function-acl.ts)
contra o projeto real.

**Sem `pg_cron` e sem `pg_net`, de propósito:** treze migrations legadas embutem
a URL de produção nos wrappers de cron, e um replay com as duas extensões
presentes agendaria jobs apontando para lá.

## Os arquivos

| Arquivo | O que é |
|---|---|
| `00-bootstrap.sql` | O mínimo que as migrations REFERENCIAM: papéis, auth, tenancy, canais, `processed_messages`, `notifications_sent` e um stub local explícito do Vault. Escrito à mão — não simula cifra/RLS/PostgREST. |
| `00a-whatsapp-legacy-seed.sql` | Três topologias legadas para provar o backfill conservador de `is_active`: único canal, único connected e ambiguidade. |
| `01-audit.sql` | `audit_log` e `audit_trigger_func()` **extraídos verbatim** das migrations 009 e 013. Não é transcrição livre: a 087 pendura o trigger de auditoria em `whatsapp_instances`, e o `DELETE` do caso NOTE-B passa por ele. |
| `02-seed.sql` | Duas organizações, cinco instâncias com ids fixos. A segunda organização existe só para o caso NOTE-D3 (tenant cruzado). |
| `03-notes-b-c-d.sql` | NOTE-B, NOTE-C (7 casos) e NOTE-D (4 + 1 controle negativo). Cada caso numa subtransação; grava veredito em `t_res`. |
| `04-controles.sql` | Os dois **controles positivos**. Sem eles, "passou" não distingue *a guarda funciona* de *o teste não testa nada*. |
| `05-ciclo-custo-e-fim.sql` | COST-1..4, END-1..4, CORR-1..2 e CYCLE-1..3 — comportamento das RPCs `set_whatsapp_instance_cost` (104) e `confirm_whatsapp_instance_end` (104 + 105), e a colisão dos dois índices que produzem `23505`. `CYCLE-3` é o que mostra por que "existe linha com esta `cycle_start`?" é uma aproximação insuficiente e o discriminador tem de ser o ciclo OPEN. Mesmo padrão: cada caso numa subtransação, veredito em `t_res`. |
| `06-controles-104.sql` | Os **três controles positivos** (104 e 105). Sem eles, "COST-2 passou", "END-1 passou" e "END-4 passou" não distinguem a guarda funcionando de teste sem força. |
| `07-whatsapp-multiprovider.sql` | MP-1..18 + MP-5b/5c: backfill, CHECK/uniqueness, Vault RPC, claim fence/double-click, intenção/cutover, status Z-API/UazAPI, provider correto no ledger, dedupe por provider e ACL estática. |
| `08-whatsapp-conversation-parity.sql` | CP: append idempotente com `last_message_at` monotônico, mensagem humana + handoff/lock atômicos, resolver de conversa serializado, validação de shape/tenant, liberação cercada do claim, cutover fail-closed sem prova de eco e ACL. |
| `09a-advisor-bootstrap.sql` | O que a sequência do advisor precisa e o `00-bootstrap.sql` não tem: `unit_members`, `customers`, `reservations`, `waitlist`, `settings`, `is_public` nas duas tabelas de tenancy, `auth.uid()` lendo as duas formas de GUC, e as **oito funções extraídas verbatim de produção** (os 3 helpers, as 4 SECURITY DEFINER que os chamam pelo nome — na forma PRÉ-106 — e `next_waitlist_code`, que `enter_waitlist` chama). Reproduz também a ACL de produção de cada uma, revogando de PUBLIC antes de conceder: ACL local mais larga que a real esvaziaria o snapshot de `proacl` do ACL-5. Substitui o `02-seed.sql` nesta sequência — o `02` insere em `whatsapp_instances`, que só existe depois da 087. |
| `09-advisor-hardening.sql` | ACL-1..ACL-5 + ACL-1b da migration 106: policy TO PUBLIC sobrevivendo ao `SET SCHEMA`, os quatro corpos reescritos resolvendo o helper, o caminho anon da fila ponta a ponta, idempotência medida **através de duas execuções** do arquivo, e o lado negativo (`ACL-1b`): não-membro vê zero e tenant cruzado não vaza — sem ele, ACL-1 passaria contra um helper que devolvesse TRUE sempre. |
| `10-controles-106.sql` | Os dois **controles positivos** da 106. CONTROLE-6 reintroduz o defeito central da fase; CONTROLE-7 mede qual grant sustenta as policies. |

## Rodar

```bash
PG="$USERPROFILE/scoop/apps/postgresql/current/bin"
"$PG/pg_ctl.exe" -D "$USERPROFILE/scoop/apps/postgresql/current/data" \
  -l /tmp/pg.log -o "-p 55432" start

"$PG/dropdb.exe"   -h 127.0.0.1 -p 55432 -U postgres --if-exists fase6c
"$PG/createdb.exe" -h 127.0.0.1 -p 55432 -U postgres fase6c
P() { "$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d fase6c -v ON_ERROR_STOP=1 "$@"; }

P -f supabase/tests/local-preflight/00-bootstrap.sql
P -f supabase/tests/local-preflight/00a-whatsapp-legacy-seed.sql
P -f supabase/tests/local-preflight/01-audit.sql
P -f supabase/migrations/20260801200000_087_whatsapp_instances.sql
P -f supabase/migrations/20260801200100_088_whatsapp_instance_cycles.sql
P -f supabase/migrations/20260801200300_090_whatsapp_instance_cycle_rpc.sql
P -f supabase/migrations/20260817170753_whatsapp_multiprovider_uazapi.sql
P -f supabase/migrations/20260901225539_generalize_whatsapp_channel_status.sql
P -f supabase/tests/local-preflight/02-seed.sql
P -f supabase/tests/local-preflight/07-whatsapp-multiprovider.sql
P -f supabase/migrations/20260905143453_whatsapp_conversation_provider_parity.sql
P -f supabase/tests/local-preflight/08-whatsapp-conversation-parity.sql

# NOTE-A: aplicar a 096 três vezes e conferir que a contagem não muda
P -f supabase/migrations/20260803120000_096_whatsapp_instance_notes.sql   # x3
P -c "select count(*) from whatsapp_instance_notes;"                      # 1

P -f supabase/tests/local-preflight/03-notes-b-c-d.sql
P -f supabase/tests/local-preflight/04-controles.sql   # SEM ON_ERROR_STOP
# 04 mexe na guarda de propósito — reaplicar a 096 restaura a versão real:
P -f supabase/migrations/20260803120000_096_whatsapp_instance_notes.sql

P -f supabase/migrations/20260807100000_104_whatsapp_cycle_cost_and_end.sql
P -f supabase/migrations/20260807110000_105_whatsapp_end_confirmation_first_wins.sql
P -f supabase/tests/local-preflight/05-ciclo-custo-e-fim.sql
P -f supabase/tests/local-preflight/06-controles-104.sql   # SEM ON_ERROR_STOP
# 06 mexe nas RPCs de propósito — reaplicar a 104 e DEPOIS a 105 restaura as
# reais. A ORDEM IMPORTA: a 105 supera a 104 em confirm_whatsapp_instance_end.
P -f supabase/migrations/20260807100000_104_whatsapp_cycle_cost_and_end.sql
P -f supabase/migrations/20260807110000_105_whatsapp_end_confirmation_first_wins.sql

P -c "select ord, caso, veredito from t_res order by ord;"
```

Ao terminar: `dropdb fase6c` e `pg_ctl stop`. Este banco é descartável e não
tem relação nenhuma com produção nem com o Supabase do projeto.

### Sequência da migration 106 (advisor)

Banco próprio e independente do `fase6c` — **não usa o `02-seed.sql`**, que
insere em `whatsapp_instances` e portanto exigiria a 087. O `09` declara `t_res`
com `ord int primary key`, enquanto o `03` e o `05` declaram sem chave primária:
os dois conjuntos de arquivos **não são intercambiáveis num mesmo banco**, e é
por isso que esta sequência tem banco próprio.

> **Ordem de deploy em produção.** As quatro Edge Functions da Task 2
> (`create-manual-reservation`, `update-reservation`, `send-cancellation`,
> `send-manual-message`) precisam estar deployadas e verificadas **antes** de a
> 106 ser aplicada. Elas chamavam `rpc("is_unit_member")`, que deixa de existir
> em `public`; com a versão antiga em memória, o lojista leva 403 na reserva
> manual, na edição de reserva, no aviso de cancelamento e na mensagem manual.
> Essa metade-aplicada é invisível no SQL — daí a nota estar aqui e no cabeçalho
> da migration.

```bash
"$PG/dropdb.exe"   -h 127.0.0.1 -p 55432 -U postgres --if-exists advisor106
"$PG/createdb.exe" -h 127.0.0.1 -p 55432 -U postgres advisor106
P() { "$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d advisor106 -v ON_ERROR_STOP=1 "$@"; }

P -f supabase/tests/local-preflight/00-bootstrap.sql
P -f supabase/tests/local-preflight/01-audit.sql
P -f supabase/tests/local-preflight/09a-advisor-bootstrap.sql

# ANTES da migration, o 09 tem de FALHAR: `schema "app_private" does not exist`,
# na criação da policy de acl_probe. É o RED que dá sentido ao GREEN.
P -f supabase/tests/local-preflight/09-advisor-hardening.sql   # esperado: ERROR

P -f supabase/migrations/20260910120000_106_advisor_private_rls_helpers.sql
P -f supabase/tests/local-preflight/09-advisor-hardening.sql   # 1a passada
# ACL-5 mede idempotência ATRAVÉS DE DUAS EXECUÇÕES: a 1a grava o snapshot de
# `proacl` em t_acl_snap, a 2a compara. Reaplicar a 106 no meio é o que está
# sendo medido — as duas leituras num único `do $$` veriam o mesmo estado.
P -f supabase/migrations/20260910120000_106_advisor_private_rls_helpers.sql
P -f supabase/tests/local-preflight/09-advisor-hardening.sql   # 2a passada

"$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d advisor106 \
  -f supabase/tests/local-preflight/10-controles-106.sql   # SEM ON_ERROR_STOP
# O 10 desfaz a reescrita de enter_waitlist de propósito — reaplicar a 106
# restaura a versão real:
P -f supabase/migrations/20260910120000_106_advisor_private_rls_helpers.sql

P -c "select ord, caso, veredito from t_res order by ord;"   # 8 linhas, todas OK
```

O ordinal 8 é o `ACL-1b`, e ele fica depois dos controles porque 6 e 7 são os
ordinais dos controles no roteiro da fase — ordinal de caso não se renumera.

## O que os dois controles do `04` fazem

**CONTROLE-1** reintroduz o CHECK `instance_id is not null` (a forma da 089) e
apaga a instância: o `DELETE` **aborta**. Removido o CHECK, o mesmo `DELETE`
conclui. Isso REPRODUZ o defeito F-01 em vez de argumentá-lo — sem ele,
"NOTE-B passou" não significaria nada.

**CONTROLE-2** troca a condição de `instance_id` da guarda pela da 089 (`<>`
puro) e repete o caso NOTE-C7: `NULL → uuid` **passa**. É a demonstração, contra
banco, de que a divergência deliberada da 096 é real e de que a 089 carrega o
defeito latente descrito no bloco "DIVERGÊNCIA DELIBERADA" da 096. Reaplicar a
096 restaura a guarda estrita e o mesmo `UPDATE` volta a ser recusado.

## O que os três controles do `06` fazem

**CONTROLE-3** remove da RPC de custo a condição `provider_cost_cents is null`
e mostra o custo já congelado sendo sobrescrito. **CONTROLE-4** remove do
encerramento o fecho do ciclo e mostra o ciclo ficando `OPEN` — é literalmente
o defeito §2.3 reintroduzido. Os dois se desfazem reaplicando a 104.

**CONTROLE-5** devolve à `confirm_whatsapp_instance_end` a sobrescrita de
`ended_by` e `end_confirmation_note` que a 105 corrige, **mantendo** o
`coalesce` de `ended_at` — e mostra a linha afirmando "encerrada em T1, por B,
com a nota de B", que é o registro falso. Manter `ended_at` intacto é o que
isola o que este controle mede. Restaurar exige reaplicar a **104 e depois a
105**, nesta ordem.

## O que os dois controles do `10` fazem

**CONTROLE-6** reconstrói `enter_waitlist` a partir de `pg_get_functiondef` com
uma única troca — `app_private.is_` volta a `public.is_` — e chama a função como
membro autenticado: ela **estoura** com `function public.is_unit_member(uuid,
uuid) does not exist`. É o defeito central desta fase reproduzido em vez de
argumentado; sem ele, "ACL-2 passou" não significaria nada. Duas coisas o fazem
medir: a definição vem do banco (redigitada à mão, erraria o tipo de retorno e
falharia por outro motivo) e o claim JWT é setado (sem ele a função tomaria o
ramo anon e não chamaria helper nenhum).

**CONTROLE-7** responde **qual grant é load-bearing**, porque o rascunho desta
fase supôs errado. Ele mede as duas metades: revogar `usage` no schema
`app_private` de `anon` **não afeta** as policies — expressão de policy fica
guardada resolvida por OID, e `USAGE` só governa procura de NOME; revogar
`execute` da função **estoura 42501**, porque o privilégio de função é conferido
na inicialização da expressão mesmo por OID. É por isso que a 106 move em vez de
revogar, e é por isso que o `grant usage on schema` dela é defesa em
profundidade, não a trava.

## O que CORR-1 e CORR-2 NÃO provam

Os dois casos **reescrevem o `UPDATE` à mão em SQL**. Eles provam a metade do
banco: que o CHECK `whatsapp_cycles_closed_needs_cost_chk` aceita custo e status
mudando juntos, e que o predicado `status = 'PENDING_REVIEW'` casa (CORR-1) e
deixa de casar (CORR-2).

Eles **não exercitam a Edge Function**. Se o `UPDATE` real de
`correct_cycle_cost` perdesse o `.eq("status", "PENDING_REVIEW")` ou a
conferência de zero linhas — lembrando que `UPDATE` do Supabase JS que casa zero
linhas devolve `error: null` —, nenhum caso deste diretório ficaria vermelho.

Essa metade é fechada por
[../../../src/lib/whatsapp-instance-ef-write-guard.test.ts](../../../src/lib/whatsapp-instance-ef-write-guard.test.ts),
guardrail **estático textual** sobre a fonte da EF: os `index.ts` importam
`deno.land`/`esm.sh` e chamam `serve()` no carregamento, então o vitest não
consegue importá-los. É uma afirmação mais estreita que "a EF foi testada" — *o
predicado não pode sumir sem teste vermelho* — e é o que existe.

O mesmo par (caso de banco aqui + guardrail estático lá) cobre `CYCLE-1`/`CYCLE-2`
e a guarda de unidade duplicada do `update_instance`.
