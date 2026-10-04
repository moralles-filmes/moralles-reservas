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
| `09a-advisor-bootstrap.sql` | O que a sequência do advisor precisa e o `00-bootstrap.sql` não tem: `unit_members`, `customers`, `reservations`, `waitlist`, `settings`, `is_public` nas duas tabelas de tenancy, `auth.uid()` lendo as duas formas de GUC, e as **oito funções extraídas verbatim de produção** (os 3 helpers, as 4 SECURITY DEFINER que os chamam pelo nome — na forma PRÉ-106 — e `next_waitlist_code`, que `enter_waitlist` chama). Reproduz também a ACL de produção de cada uma, revogando de PUBLIC antes de conceder: ACL local mais larga que a real esvaziaria o snapshot de `proacl` do ACL-5. Substitui o `02-seed.sql` nesta sequência — o `02` insere em `whatsapp_instances`, que só existe depois da 087. Traz ainda a **fixture `acl_probe`**, com a policy do ACL-1 escrita na forma das reais (`is_unit_member(auth.uid(), unit_id)` — sem qualificar o schema, sem cláusula `TO`, como a 014 escreveu `waitlist_member_select`) e a **procedência dela gravada em `t_probe_prov`**: o OID que esse nome resolveu, o schema (`public`) e o OID da própria linha de `pg_policy`. A fixture mora aqui, e não no `09`, porque precisa NASCER ANTES da 106 — é esse o fato que o ACL-1 mede. Por isso o arquivo **recusa rodar se a 106 já foi aplicada**: o `create or replace` dele reporia um segundo helper em `public`, a fixture apontaria para o sósia e o ACL-1 ficaria verde medindo nada. |
| `09-advisor-hardening.sql` | ACL-1..ACL-5, ACL-1b, ACL-3b/3c/3d e CONTROLE-16 da migration 106: policy **criada antes do move** continuando a avaliar depois dele (mesmo OID, mesma linha de `pg_policy`, `public.is_unit_member` já inexistente), os quatro corpos reescritos resolvendo o helper, o caminho anon da fila ponta a ponta, idempotência medida **através de duas execuções** do arquivo, e os lados negativos — `ACL-1b` (não-membro vê zero, tenant cruzado não vaza) e `ACL-3b/3c/3d`, o lado de NEGAR das outras três funções: recusa cross-org na anonimização, recusa a não-membro no painel de Entregas, e agregado de outra organização não voltando na listagem de clientes. Nada aqui cria ou recria a policy da fixture; o arquivo **recusa rodar antes da 106 ou sem o `09a`**. `CONTROLE-16` é o controle positivo do ACL-1 e vive neste arquivo, não no `10`, pela razão que o `CONTROLE-8` já usa no `11`: desfaz a sabotagem por rollback de subtransação e não deixa resíduo nenhum. |
| `10-controles-106.sql` | Os **quatro controles positivos** da 106. CONTROLE-6 reintroduz o defeito central da fase; CONTROLE-7 mede qual grant sustenta as policies; CONTROLE-9 sabota `is_unit_member`; CONTROLE-10 sabota `is_org_member` e vê o agregado de outro tenant vazar. |
| `11-overloads-107.sql` | Task 5 (migration 107, Fase 2 do front de advisor): ACL-6 (ord 14) confere que os overloads de 2 argumentos sobrevivem à 107; CONTROLE-8 (ord 15) dropa o de 2 argumentos por engano, vê o call site real estourar, e restaura corpo + ACL de dentro do próprio caso. Roda no mesmo banco `advisor106`, ao final da sequência do advisor — não em banco separado. Os dois vivem no mesmo arquivo, com `ON_ERROR_STOP=1`: diferente de CONTROLE-6, CONTROLE-8 nunca deixa sabotagem residual para um reapply externo resolver, então não precisa da rede de segurança que os arquivos `NN-controles-*.sql` têm. |
| `12-customer-stats-108.sql` | STATS-1..8 (ordinais 17–24, migration 108): o guard de tenant da `get_customer_stats`. Permitir (membro lê o próprio cliente com os números certos, `platform_admin` **sem** linha em `unit_members` passa, `p_unit_id => null` segue agregando a org) e negar (cliente de outra org, sem sessão, e id inexistente caindo no MESMO ramo do proibido — senão a recusa vira oráculo de existência), mais ACL e idempotência através de duas execuções. **Traz as reservas**, que nenhum arquivo do harness tinha: sem elas todo agregado é zero e o controle positivo não distinguiria vazamento de "cliente sem reserva nenhuma". A segunda unidade da org A nasce **não pública** de propósito — os casos do `09` resolvem a unidade por `where is_public limit 1`, e uma segunda pública tornaria aquela escolha não-determinística. O corpo pré-108 **não** é recriado aqui: o `09a` já traz `get_customer_stats` desde a Task 5 da 107. |
| `13-controles-108.sql` | Os **dois controles positivos** da 108. CONTROLE-25 neutraliza só o `raise` de `forbidden` (delta mínimo sobre `pg_get_functiondef`) e vê o agregado da org B chegar ao membro da org A; CONTROLE-26 repõe o corpo `language sql` pré-108 inteiro e vê as DUAS regressões de uma vez — o vazamento cross-org e a chamada sem sessão devolvendo linha de zeros em vez de `42501`. **A sabotagem é o `raise`, não o `if`, e isso foi medido:** trocar `if v_org is null` por `if false and v_org is null` não neutraliza nada, porque `and` liga mais forte que `or` e o segundo disjunto (`not (is_platform_admin or is_org_member)`) continua verdadeiro — o raise dispararia igual e o controle ficaria verde tendo sabotado coisa nenhuma. Reaplicar a 108 restaura, como no CONTROLE-6. |
| `14-public-code-lookup-109.sql` | CODE-1..CODE-8 (ordinais 27–34, migration 109): a RPC pública `resolve_tracking_token_by_code`. O caminho de ACHAR (código certo, unidade certa e pública) devolve o token; os três casos de NÃO achar — unidade errada, unidade não pública, código inexistente — têm de devolver `null` indistinguivelmente entre si, senão a recusa vira oráculo cross-tenant. Mede também a AUSÊNCIA de `get_reservation_by_code` (dropada por esta migration), a ACL (`anon`/`authenticated` executam, `PUBLIC` não) e idempotência através de duas execuções. |
| `15-controles-109.sql` | Os **dois controles positivos** (ordinais 35–36) da 109. Sabotam o corpo real a partir de `pg_get_functiondef` — CONTROLE-9 remove o gate `is_public` e vê CODE-3 resolver uma unidade privada; CONTROLE-10 remove o casamento `unit_id` e vê CODE-2 resolver o código de outra unidade. As duas asserções são sobre o UUID que voltou, nunca sobre "não estourou": guarda quebrada aqui devolve dado, não erro. |
| `16-inbound-events-111.sql` | INBOUND-1..7 (ordinais 37–43, migration 111, Fase C): a fila durável `whatsapp_inbound_events`. Corpo com octeto NUL voltando byte a byte (o motivo de `raw_body` ser `bytea`), dedupe de entrega escopado por canal, entregas legadas com `delivery_id` NULL coexistindo, CHECK de `delivery_id` e de `provider` com contra-caso em cada um, cascade do canal sem abortar o DELETE, e a postura do gate (RLS forçada, zero policies, flag `false`, zero canais optados). **Roda em banco PRÓPRIO** e com seed `00a` — ver a seção "Rodar" dele. Cada caso se desfaz por rollback de subtransação, então o arquivo é re-runnable e não deixa linha na tabela. |
| `17-controles-111.sql` | Os **cinco controles positivos** (ordinais 44–48) da 111. C-111-1 troca `raw_body` para `text`; C-111-2 troca o unique parcial por `nulls not distinct`; C-111-3 dropa o CHECK de `delivery_id`; C-111-4 troca `on delete cascade` por `restrict`; C-111-5 dropa o CHECK de `provider`. **Aqui o restore mora dentro de cada controle e isso não é escolha** — ver a nota "Por que reaplicar a 111 não restaura" abaixo. |
| `18-inbound-claim-113.sql` | CLAIM-1..6, FIN-1..4 e ACL-113 (ordinais 49–55, 63, 80–81 e 83, migration 113, Fase C): a cerca de UUID que impede DUAS execuções da mesma linha — que nesta fase significa duas IAs respondendo ao mesmo cliente. Claim exclusivo, takeover de lease vencido com crachá novo, finalização recusada com crachá errado, incremento de `attempts` e `next_attempt_at` montados pelo relógio do BANCO, recusa terminal de 401 morrendo em `done` (e não em `dead`, que reteria o corpo cru por 30 dias), o takeover GASTANDO uma tentativa (CLAIM-5) enquanto o claim normal não gasta (CLAIM-6), a finalização com erro NULO preservando o `last_error` anterior em vez de apagá-lo (FIN-4), e o ACL efetivo das duas RPCs. **Continua o banco da 111** — ver a seção "Sequência da migration 113". |
| `19-controles-113.sql` | Os **nove controles positivos** (ordinais 56–62, 82 e 84) da 113. C-113-1 tira a cerca `claim_id` da finalização; C-113-2 tira a perna do takeover; C-113-3 tira o filtro de status do claim; C-113-4 encurta o lease para 9 s; C-113-5 incrementa `attempts` em todo ramo; C-113-6 lê o atraso como milissegundos; C-113-7 dropa e recria a função sem repetir o `revoke`; C-113-8 devolve o claim à forma anterior à Task 8, sem o incremento do takeover; C-113-9 devolve o `last_error` à sobrescrita cega, provando que finalizar com erro NULO apagaria a evidência. Cada um mede também que os casos VIZINHOS continuam verdes. O critério **não é "um caso"**: o C-113-3 derruba dois (CLAIM-2 e CLAIM-4) e está certo, porque a sabotagem quebra genuinamente as duas propriedades e cada veredito nomeia o defeito real — o que se exige é vermelho localizado, com mensagem apontando para o lugar certo. |
| `20-inbound-sweep-113.sql` | SWEEP-1..6, PURGE-1..2 e ACL-SWEEP (ordinais 64–72, migration 113, Fase C): a SELEÇÃO das linhas devidas e a PURGA. Linha devida selecionada, agendada para o futuro fora, lease vencido dentro, lease vivo fora, a seleção **não escrevendo nada** (as cinco colunas intactas), a linha antiga passando na frente da recém-tocada, as duas janelas de retenção (7 d para `done`, 30 d para `dead`) com contra-caso em cada uma, e o ACL efetivo das duas RPCs. **Continua o banco da 111/113** — ver a seção "Sequência da migration 113". |
| `21-controles-113-sweep.sql` | Os **sete controles positivos** (ordinais 73–79) da seleção e da purga. C-SWEEP-1 tira o filtro `next_attempt_at <= now()`; C-SWEEP-2 tira a perna do lease vencido; **C-SWEEP-3 reintroduz o desenho recusado** (a seleção que reivindica EM LOTE, marcando 20 linhas `processing` de uma vez); C-SWEEP-4 volta a ordem para `next_attempt_at`; C-SWEEP-5 iguala a janela de `done` à de `dead`; C-SWEEP-6 tira a perna de `dead`; C-SWEEP-7 dropa e recria a purga sem repetir o `revoke`. Cada um mede também que os vizinhos continuam verdes. O C-SWEEP-2 derruba DOIS casos (SWEEP-3 e SWEEP-6) e está certo: a linha "envenenada" do SWEEP-6 é, por fidelidade ao cenário, um `processing` com lease vencido — e o veredito dele nomeia o takeover, não a ordem. |
| `22a-ad-touchpoints-bootstrap.sql` | O que a 115 (Fase D) referencia e o `00` não tem: **default privileges** que emulam o Supabase (ALL nas tabelas novas de `public` para `anon`/`authenticated`/`service_role` — é o que dá ao `service_role` o INSERT do TP-1b e o que o `revoke` de tabela da 115 tem de tirar; sem eles o TP-10 fica cego), `customers` fiel MÍNIMO com RLS e uma policy PERMISSIVA de fixture para `authenticated` (não é a de produção), três clientes (dois da org A, um da org B) e o grant de tabela em tudo que já existia em `public`, sem o qual o `service_role` do TP-1b não leria `units`/`whatsapp_channels`. **Recusa rodar depois da 115**: a tabela nasceria sem os default privileges e o TP-1b/TP-10 mediriam outra coisa. |
| `22-ad-touchpoints-115.sql` | TP-1..TP-11, TP-1b, TP-4b e TP-6b (ordinais 85–96, 102 e 103, migration 115): a tabela `whatsapp_ad_touchpoints`. Imutabilidade (nenhum UPDATE, nem o que não muda nada) com a única exceção da coerção do `set null` de `channel_id`, coerência de tenant entre as três FKs, cliente anonimizado recusado com o SQLSTATE dedicado `P0A15` (TP-6b), CHECKs de `provider` e da rede de 64 KiB, dedupe `(provider, provider_message_id)`, a purga LGPD disparada por soft delete feito com o papel REAL `authenticated` (TP-9), a gravação com o papel REAL `service_role` (TP-1b), RLS, a tabela sem privilégio para `anon`/`authenticated`, ACL/forma das funções (TP-10) e idempotência através de duas execuções (TP-11). **Banco PRÓPRIO** `fased115` — ver a seção "Sequência da migration 115". |
| `23-controles-115.sql` | Os **seis controles positivos** (ordinais 97–101 e 104) da 115. C-115-1/2/3/6 sabotam o guard por **delta mínimo** sobre `pg_get_functiondef`, recortando o trecho entre os marcadores `-- <x>`/`-- </x>` do corpo (`excecao-set-null`, `coerencia-tenant`, `guarda-update`, `cliente-vivo`); C-115-4 torna a purga `security invoker`; C-115-5 dropa e recria o guard sem o `revoke`. Restore dentro de cada controle, conferido contra o catálogo. |
| `24-concorrencia-115.sh` | A serialização do `for share` do guard da 115 contra uma anonimização **concorrente**, com DUAS sessões reais de `psql` (Git Bash; `PGBIN`, `PGPORT`, `PGDB`). CONC-1: a anonimização segura o lock e o INSERT espera e é recusado com `P0A15`; CONC-2: o INSERT segura o lock e a anonimização espera e apaga a linha; CONC-3: controle de tempo (sem concorrência, < 1 s); CONC-4: **controle positivo** — guard sem `for share`, a linha sobrevive; restaura reaplicando a 115 e confere o `md5` do guard. Roda no banco da 115, depois do `23`. |

## Rodar

**Versão mínima: PostgreSQL 15.** Não é preferência — `17-controles-111.sql`
usa `create unique index ... nulls not distinct` (C-111-2), sintaxe que só existe
a partir do 15. Num servidor mais velho aquele controle cai no `when others` com
erro de sintaxe e reporta `FALHOU` **sem que haja nada errado com a migration**:
falso-vermelho que se lê como defeito da 111. O restante dos arquivos não usa
sintaxe posterior ao 13. Medido no **PostgreSQL 18.4** (`scoop`), que é onde a
suíte inteira roda verde.

**`PGCLIENTENCODING=UTF8` não é opcional.** O `psql` do Windows, sem essa
variável, converte errado a entrada de arquivo `-f` e grava todo texto acentuado
**duplamente codificado** — mesmo reportando `client_encoding = UTF8` no `show`.
Medido: o `comment on schema app_private` da 106 tem 1317 caracteres / 1356 bytes
no arquivo, e sem a variável o banco guarda 1356 *caracteres* (cada acento virou
dois). Nenhum veredito depende disso (os casos comparam números e literais ASCII),
e produção não é afetada porque o `supabase db push` fala UTF-8; mas comentário e
mensagem de erro guardados errados são falso-vermelho esperando acontecer.

**Se o `pg_ctl start` disser "outro servidor pode estar executando", confira a
porta antes de tentar destravar.** `apps/postgresql/current/data` é junção para
`persist/postgresql/data`, que é o data dir da instância *default* do scoop — se
ela já estiver no ar (na 5432, normalmente), não existe segundo postmaster
possível sobre o mesmo diretório, e o `postmaster.pid` que parece resíduo é de um
servidor vivo. `cat "$USERPROFILE/scoop/apps/postgresql/current/data/postmaster.pid"`
mostra PID, data dir e porta nas primeiras linhas. Nesse caso o certo é **usar a
porta que já está no ar** trocando `-p 55432` pela dela, não parar a instância do
usuário: o banco desta suíte é descartável e conviver com os outros no mesmo
servidor não muda nenhum veredito.

```bash
export PGCLIENTENCODING=UTF8
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
export PGCLIENTENCODING=UTF8          # obrigatório; ver a nota na seção "Rodar"
"$PG/dropdb.exe"   -h 127.0.0.1 -p 55432 -U postgres --if-exists advisor106
"$PG/createdb.exe" -h 127.0.0.1 -p 55432 -U postgres advisor106
P() { "$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d advisor106 -v ON_ERROR_STOP=1 "$@"; }

P -f supabase/tests/local-preflight/00-bootstrap.sql
P -f supabase/tests/local-preflight/01-audit.sql
P -f supabase/tests/local-preflight/09a-advisor-bootstrap.sql

# ANTES da migration, o 09 tem de FALHAR — hoje pelo guard do topo do arquivo:
# `exige a migration 106 aplicada (app_private.is_unit_member nao existe)`.
# É o RED que dá sentido ao GREEN, e ele é EXPLÍCITO de propósito: enquanto a
# fixture `acl_probe` era criada dentro do `09`, o RED vinha de um acidente feliz
# (`schema "app_private" does not exist` na criação da policy). Com a fixture no
# `09a`, onde ela precisa estar, esse acidente sumiu — e sem o guard este arquivo
# rodaria inteiro contra o mundo PRÉ-migration: ACL-2/3/4 passariam (produção
# funciona hoje) e o ACL-5 gravaria em `t_acl_snap` um snapshot de ZERO funções,
# contra o qual a 1a passada de verdade reprovaria.
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

P -c "select ord, caso, veredito from t_res order by ord;"   # 14 linhas, todas OK

# ── Task 5 (migration 107): dropar os dois overloads de RPC sem caller ──────
# 11-overloads-107.sql roda no MESMO banco advisor106, apendado ao fim desta
# sequência — não é "outro banco" como uma nota antiga deste README chegou a
# dizer. ACL-6/CONTROLE-8 não dependem da 107 ter rodado (nenhum dos dois toca
# os overloads de 1 argumento que ela dropa), então já dão OK aqui, ANTES da
# migration existir:
P -f supabase/tests/local-preflight/11-overloads-107.sql

P -f supabase/migrations/20260910121000_107_drop_dead_rpc_overloads.sql

# E continuam OK depois — é isso que prova que a 107 não encostou nos
# overloads de 2 argumentos:
P -f supabase/tests/local-preflight/11-overloads-107.sql

P -c "select ord, caso, veredito from t_res order by ord;"   # 16 linhas, todas OK

# ── Migration 108: guard de tenant na get_customer_stats ───────────────────
# ANTES da migration, o 12 tem de FALHAR pelo guard do topo do arquivo
# (`o corpo de public.get_customer_stats nao chama is_org_member`). É o RED que
# dá sentido ao GREEN, e é explícito pelo mesmo motivo do guard do `09`: sem ele
# STATS-1/6/7 passariam medindo o mundo pré-migration e o STATS-8 gravaria um
# snapshot do corpo SEM guard, contra o qual a 1a passada de verdade reprovaria.
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

**Ordinais casam com o número do NOME do caso, não com a ordem de execução** —
por isso o `order by ord` intercala casos do `09`/`11` com controles do `10`:

| ord | caso | arquivo |
|---|---|---|
| 1–5 | `ACL-1` .. `ACL-5` | `09` |
| 6, 7 | `CONTROLE-6`, `CONTROLE-7` | `10` |
| 8 | `ACL-1b` | `09` |
| 9 | `CONTROLE-9` | `10` |
| 10 | `CONTROLE-10` | `10` |
| 11, 12, 13 | `ACL-3b`, `ACL-3c`, `ACL-3d` | `09` |
| 14, 15 | `ACL-6`, `CONTROLE-8` | `11` |
| 16 | `CONTROLE-16` | `09` |
| 17–24 | `STATS-1` .. `STATS-8` | `12` |
| 25, 26 | `CONTROLE-25`, `CONTROLE-26` | `13` |
| 27–34 | `CODE-1` .. `CODE-8` | `14` |
| 35, 36 | `CONTROLE-9`, `CONTROLE-10` (da 109) | `15` |

**Os ordinais 8 e 9 já estavam ocupados** por `ACL-1b` e `CONTROLE-9` quando a
Task 5 chegou — uma nota anterior deste README reservava o 8 para o controle de
overload errado, escrita antes de `09a-advisor-bootstrap.sql`/`09`/`10`
existirem com essa numeração. `11-overloads-107.sql` usa 14 e 15, os primeiros
ordinais livres depois de `ACL-3d` (13). Ele também é o motivo de
`09a-advisor-bootstrap.sql` ter, além das oito funções da 106, mais quatro:
`get_reservation_by_code`/`get_customer_stats` (os dois overloads de cada) —
extraídas de produção via `supabase db dump --linked` (o MCP `execute_sql`
estava com o token expirado quando a Task 5 rodou; ver
`.superpowers/sdd/2026-08-17-advisor-warnings-hardening/task-5-report.md`).

**`ACL-6` (ord 14, em `11-overloads-107.sql`) chama `get_reservation_by_code`,
que a migration 109 dropa — reexecutar o `11` depois da 109 deixa esse caso
vermelho, e isso não é regressão da 107.** Na sequência linear deste README o
`11` roda antes da 108/109 e o veredito já está gravado em `t_res` quando a 109
chega, então nada quebra; mas qualquer reaplicação isolada do `11` depois da
109 encontra a função ausente. `CODE-6` mede a AUSÊNCIA da mesma função que o
`ACL-6` mede a PRESENÇA — os dois estão certos, cada um no seu momento da
sequência.

### Sequência da migration 111 (Fase C — fila de inbound)

**Banco PRÓPRIO**, pela mesma razão do `advisor106`: o `16` declara `t_res` com
`ord int primary key`, como o `09` e posteriores, e o `03`/`05` declaram sem
chave primária — os dois conjuntos não convivem num banco só.

É a sequência mais curta que produz veredito, e cada peça está aqui porque falta
dela quebra algo concreto:

- **`00-bootstrap.sql`** traz `organizations`, `units`, `whatsapp_channels` e
  `update_updated_at()`, que a 111 referencia (duas FKs e a coluna nova).
- **`00a-whatsapp-legacy-seed.sql`**, e não o `02-seed.sql`: os casos precisam de
  linha em `whatsapp_channels`, e é o `00a` que cria canais. O `02` insere em
  `whatsapp_instances`, que só existe depois da 087 — trazer a 087 seria
  sequência mais longa sem veredito novo.
- **A migration 061** (`platform_flags`): o bootstrap **não** cria essa tabela, e
  sem ela o seed da flag no fim da 111 estoura e a migration inteira falha.
- **Nada de 110.** O `provider` que os casos exercitam é o da própria tabela nova.
  A linha de canal referenciada nasce `provider = 'zapi'`, que o CHECK do
  bootstrap já aceita — evento `datafy` apontando para canal `zapi` é combinação
  sem sentido em produção e perfeitamente válida no banco, e é só disso que os
  casos dependem.

```bash
export PGCLIENTENCODING=UTF8          # obrigatório; ver a nota na seção "Rodar"
PG="$USERPROFILE/scoop/apps/postgresql/current/bin"
"$PG/dropdb.exe"   -h 127.0.0.1 -p 55432 -U postgres --if-exists fasec111
"$PG/createdb.exe" -h 127.0.0.1 -p 55432 -U postgres fasec111
P() { "$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d fasec111 -v ON_ERROR_STOP=1 "$@"; }

P -f supabase/tests/local-preflight/00-bootstrap.sql
P -f supabase/tests/local-preflight/00a-whatsapp-legacy-seed.sql
P -f supabase/migrations/20260716130000_061_platform_flags.sql

# ANTES da migration, o 16 e o 17 têm de FALHAR pelas guardas do topo
# (`tabela public.whatsapp_inbound_events ausente`). É o RED que dá sentido ao
# GREEN: rodado antes, INBOUND-2/4/5/6 passariam POR ACIDENTE, porque sem a
# tabela todo insert "falha" e todo caso negativo fica verde medindo nada.
P -f supabase/tests/local-preflight/16-inbound-events-111.sql   # esperado: ERROR
P -f supabase/tests/local-preflight/17-controles-111.sql        # esperado: ERROR

P -f supabase/migrations/20260924120000_111_whatsapp_inbound_events.sql
P -f supabase/tests/local-preflight/16-inbound-events-111.sql

"$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d fasec111 \
  -f supabase/tests/local-preflight/17-controles-111.sql   # SEM ON_ERROR_STOP
# NÃO reaplicar a 111 aqui: ela não restaura nada (ver a nota abaixo). Cada
# controle já se desfez sozinho.

P -c "select ord, caso, veredito from t_res order by ord;"   # 12 linhas, todas OK

# Idempotência da 111: aplicar 3x e conferir que a flag continua com UMA linha.
P -f supabase/migrations/20260924120000_111_whatsapp_inbound_events.sql   # x3
P -c "select count(*) from platform_flags where key = 'whatsapp_async_ingestion';"  # 1
P -f supabase/tests/local-preflight/16-inbound-events-111.sql   # segue 7/7 OK
```

Ao terminar: `dropdb fasec111`. Este banco é descartável e não tem relação
nenhuma com produção nem com o Supabase do projeto.

| ord | caso | arquivo |
|---|---|---|
| 0 | `GUARDA-17` (sentinela; **só aparece quando os pré-requisitos do `17` falham**) | `17` |
| 37–43 | `INBOUND-1` .. `INBOUND-7` | `16` |
| 44–48 | `C-111-1` .. `C-111-5` | `17` |

**Por que a guarda do `17` grava uma linha em vez de só levantar erro.** Este
arquivo roda SEM ON_ERROR_STOP de propósito (um erro no meio não deve sumir com
os vereditos seguintes) — então um `raise` na guarda imprime ERROR e o `psql`
SEGUE, e os cinco controles rodam e passam sobre zero caso INBOUND. A linha
`ord = 0` é o que faz essa falha aparecer em `select ord, caso, veredito from
t_res order by ord`, no topo, em vez de depender de o operador contar cinco
linhas onde esta tabela promete doze. Numa execução sadia ela não existe (a
guarda apaga sentinela de execução anterior), e sob ON_ERROR_STOP o `raise` que
vem depois aborta o arquivo como antes.

**Só o `INBOUND-3` depende de NULL coexistir, e isso é invariante do `16`.**
Todo caso que insere mais de uma linha no MESMO canal passa `delivery_id`
explícito e distinto, mesmo quando o id não tem relação com o que o caso mede.
Sem isso a sabotagem do C-111-2 (`nulls not distinct`) produz TRÊS vermelhos em
vez de um — medido: o INBOUND-5 (cinco linhas) e o INBOUND-6 (duas) colidiam
também, e os dois reportavam só `duplicate key value violates unique
constraint`, que no INBOUND-6 se lê como defeito de FK/cascade e manda
investigar o lugar errado. Controle positivo vale pelo vermelho ser
**localizado**. Caso novo ali segue a regra.

**Por que reaplicar a 111 não restaura — e por que os controles do `17` se
desfazem sozinhos.** Nos conjuntos anteriores o README manda reaplicar a
migration depois do arquivo de controles, porque lá a sabotagem é no corpo de
uma função e a migration a define com `create or replace`. A 111 é
`create table if not exists` + `create index if not exists` + `add column if not
exists`: com a tabela já existindo, reaplicá-la é **no-op** e não devolve o tipo
da coluna, o predicado do índice, o CHECK nem o `on delete cascade`. Uma
sabotagem esquecida ficaria de pé e faria todo caso posterior passar ou falhar em
silêncio sobre um schema que não é o da migration. Por isso cada controle captura
a definição real do catálogo antes de mexer, confere que a sabotagem mudou algo,
desfaz por rollback de subtransação (`raise ... using errcode = 'ZZ111'`, a
convenção do `CONTROLE-16`) e **verifica o restore contra o catálogo** — o
veredito só é `OK` se as três metades casarem.

**Dois resultados MEDIDOS que o rascunho desta fase supunha ao contrário.** Os
dois estão escritos nos arquivos, no ponto em que importam:

1. **Derrubar o predicado `where delivery_id is not null` do unique NÃO derruba o
   INBOUND-3.** NULL é distinto de NULL em índice unique por default, então com
   um unique cheio as entregas legadas continuam entrando. Quem derruba é
   `nulls not distinct` — e é essa a sabotagem do `C-111-2`. A versão briefada
   daquele controle teria ficado verde tendo sabotado coisa nenhuma.
2. **`on delete restrict` estoura `23001` (`restrict_violation`), não `23503`
   (`foreign_key_violation`).** Um handler escrito para `foreign_key_violation`
   — a escolha óbvia — não o captura. O `INBOUND-6` e o `C-111-4` capturam as
   duas condições; sem o controle, aquele handler morto seguiria no arquivo sem
   nunca ser exercitado, porque com `cascade` o ramo nem é alcançado.

### Sequência da migration 113 (Fase C — claim, finalização, seleção e purga)

**O mesmo banco da 111, continuado** — não um banco novo. O `19` exige que o `18`
tenha rodado e o `21` exige o `20` (os dois conferem vereditos em `t_res`), e o
`18`/`20` exigem a 111 aplicada. Quem já rodou a seção da 111 acrescenta a 113 e
segue; quem está começando roda a sequência inteira de uma vez, como abaixo.

A 113 tem QUATRO funções, e os arquivos se dividem pelo que cada par faz: o
`18`/`19` medem a CERCA (claim e finalização), o `20`/`21` medem a SELEÇÃO das
linhas devidas e a PURGA.

A **112 entra na sequência** por ser a migration entre a 111 e a 113, não porque
algum caso dependa dela: ela só cria o wrapper da varredura, que nenhum caso
chama (este harness não tem `pg_net`, de propósito).

```bash
export PGCLIENTENCODING=UTF8          # obrigatório; ver a nota na seção "Rodar"
PG="$USERPROFILE/scoop/apps/postgresql/current/bin"
"$PG/dropdb.exe"   -h 127.0.0.1 -p 55432 -U postgres --if-exists fasec113
"$PG/createdb.exe" -h 127.0.0.1 -p 55432 -U postgres fasec113
P() { "$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d fasec113 -v ON_ERROR_STOP=1 "$@"; }

P -f supabase/tests/local-preflight/00-bootstrap.sql
P -f supabase/tests/local-preflight/00a-whatsapp-legacy-seed.sql
P -f supabase/migrations/20260716130000_061_platform_flags.sql

# ANTES da 113, o 18/19/20/21 têm de FALHAR pelas guardas do topo. É o RED que dá
# sentido ao GREEN: rodado antes, CLAIM-2, FIN-1, SWEEP-2 e SWEEP-4 passariam POR
# ACIDENTE, porque sem as funções toda chamada "falha" e todo caso negativo fica
# verde medindo nada.
P -f supabase/tests/local-preflight/18-inbound-claim-113.sql   # esperado: ERROR
P -f supabase/tests/local-preflight/19-controles-113.sql       # esperado: ERROR
P -f supabase/tests/local-preflight/20-inbound-sweep-113.sql   # esperado: ERROR
P -f supabase/tests/local-preflight/21-controles-113-sweep.sql # esperado: ERROR

P -f supabase/migrations/20260924120000_111_whatsapp_inbound_events.sql
P -f supabase/migrations/20260924120100_112_inbound_sweep_trigger.sql
P -f supabase/migrations/20260924120200_113_inbound_claim_rpc.sql

P -f supabase/tests/local-preflight/16-inbound-events-111.sql
P -f supabase/tests/local-preflight/18-inbound-claim-113.sql
P -f supabase/tests/local-preflight/20-inbound-sweep-113.sql

"$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d fasec113 \
  -f supabase/tests/local-preflight/17-controles-111.sql   # SEM ON_ERROR_STOP
"$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d fasec113 \
  -f supabase/tests/local-preflight/19-controles-113.sql   # SEM ON_ERROR_STOP
"$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d fasec113 \
  -f supabase/tests/local-preflight/21-controles-113-sweep.sql   # SEM ON_ERROR_STOP
# NÃO reaplicar as migrations aqui: cada controle já se desfez sozinho.

P -c "select ord, caso, veredito from t_res order by ord;"   # 48 linhas, todas OK
```

Ao terminar: `dropdb fasec113`.

**Conte as 48 linhas, não confie em "nenhum FALHOU".** O `19` e o `21` rodam SEM
ON_ERROR_STOP de propósito, e plpgsql compila o bloco INTEIRO na primeira
execução: um erro de compilação (um SQLSTATE com 6 caracteres em vez de 5, por
exemplo) derruba o bloco antes de qualquer statement, então nem o `when others`
grava veredito. O `psql` imprime ERROR, segue, e a tabela fica com **39 linhas
todas OK** — nove a menos, a aparência exata de uma execução sadia sem aquele
arquivo de controles. Medido ao escrever este conjunto. É a mesma razão pela qual
cada guarda grava sentinela (`ord = 0` no `17`, `ord = -19` no `19`, `ord = -21`
no `21`) em vez de só levantar erro. **Ao acrescentar caso, atualize os dois
números deste parágrafo e o da linha `select` acima** — um contador velho aqui
esconde exatamente o defeito que ele existe para pegar.

| ord | caso | arquivo |
|---|---|---|
| −21 | `GUARDA-21` (sentinela; **só aparece quando os pré-requisitos falham**) | `21` |
| −19 | `GUARDA-19` (sentinela; idem) | `19` |
| 0 | `GUARDA-17` (sentinela; idem) | `17` |
| 37–43 | `INBOUND-1` .. `INBOUND-7` | `16` |
| 44–48 | `C-111-1` .. `C-111-5` | `17` |
| 49–55 | `CLAIM-1` .. `CLAIM-3`, `FIN-1` .. `FIN-3`, `ACL-113` | `18` |
| 56–62 | `C-113-1` .. `C-113-7` | `19` |
| 63 | `CLAIM-4` (linha terminal não é reivindicável) | `18` |
| 64–72 | `SWEEP-1` .. `SWEEP-6`, `PURGE-1`, `PURGE-2`, `ACL-SWEEP` | `20` |
| 73–79 | `C-SWEEP-1` .. `C-SWEEP-7` | `21` |
| 80, 81 | `CLAIM-5`, `CLAIM-6` (o takeover gasta tentativa; o claim normal não) | `18` |
| 82 | `C-113-8` | `19` |
| 83 | `FIN-4` (erro NULO preserva o `last_error` anterior) | `18` |
| 84 | `C-113-9` | `19` |

**As três sentinelas têm ordinais DIFERENTES de propósito.** Compartilhando o 0,
um arquivo de controles saudável apagaria a sentinela de outro que falhou — e a
falha desapareceria atrás de controles verdes, que é o mesmo modo de mascaramento
descrito no parágrafo acima. O `CLAIM-4` está em 63, fora da faixa do `18`, porque
foi acrescentado depois dos controles por um achado de revisão; os ordinais não
são contíguos por arquivo e não precisam ser.

**Por que o `18` compara instantes por IGUALDADE, e por que dois controles
existem só para provar isso.** `now()` é `transaction_timestamp()`, constante
dentro de um `do $$`, então `claimed_until = now() + interval '90 seconds'` é uma
asserção exata — e é ela que prende os 90 segundos do SQL ao gêmeo
`INBOUND_LEASE_TTL_MS` do núcleo em TypeScript, que o SQL não pode importar. A
escrita óbvia (`> now()`, "está no futuro") passaria com 9 segundos e com 9000. O
`C-113-4` (lease de 9 s) e o `C-113-6` (atraso de 30 lido como milissegundos)
medem as DUAS coisas: que a asserção real reprova a sabotagem, e que a frouxa
teria passado. Sem eles, trocar a igualdade por `> now()` numa limpeza futura não
derrubaria nada.

**Por que o `CLAIM-5` existe, e por que ele mede o TAKEOVER e não a
finalização.** `attempts` avançava só na finalização — e existe uma classe de
linha que nunca a alcança: o worker que começa e não termina (wall clock do
WORKER esgotado, isolate derrubado, `EdgeRuntime.waitUntil` cortado). O lease
vencia, o takeover servia a linha de novo, e `attempts` ficava parado para
sempre: ela nunca chegava a `dead`, logo nunca virava dead letter — e como
`purge_whatsapp_inbound_events` só alcança `done` e `dead`, o `raw_body`
(telefone e texto de cliente, PII) ficava retido indefinidamente. Nada travava e
nada alertava, porque a ordenação por `updated_at` devolve essa linha ao fim da
fila a cada serviço. O `CLAIM-5` mede o incremento na perna do takeover e o
valor DEVOLVIDO pelo `returning` (é dele que o Deno decide nem processar); o
`CLAIM-6` mede a contraparte — claim normal não gasta tentativa, senão toda
entrega nova começaria um degrau adiante. O `C-113-8` reintroduz a forma
anterior e vê o `CLAIM-5` ficar vermelho com o `CLAIM-6` verde. Consequência a
saber ao ler a coluna: **`attempts` conta TENTATIVAS GASTAS, não vereditos
gravados** — uma linha legitimamente lenta (lease vence, worker original ainda
vivo, finaliza depois) é contada duas vezes e morre um passo antes. É o lado
seguro do erro e é aceito de propósito.

**Um resultado MEDIDO no `C-113-7`: `create or replace function` NÃO reabre o
`EXECUTE` a PUBLIC.** O ACL fica preso ao objeto e sobrevive à substituição do
corpo, então migration que só troque implementação não precisa repetir o
`revoke`. Quem reabre é **DROP + CREATE** — e esse é o caminho provável de
acontecer de novo: alguém precisa mudar o tipo de retorno, descobre que
`create or replace` recusa, dropa, recria, e não repete o `revoke`. O controle
mede as duas metades; sem a primeira ele diria que o `ACL-113` tem força sem
dizer contra o quê.

**Por que a seleção do `20` ordena por `updated_at` e não por `next_attempt_at`, e
por que o `C-SWEEP-4` existe.** Quem escreve `next_attempt_at` é a FINALIZAÇÃO — e
a linha que precisa ceder a vez é justamente aquela cuja finalização falha por
motivo independente do payload (banco fora, `PGRST202` por Edge Function
deployada antes do `db push`). Nesse caso `attempts` e `next_attempt_at` nunca
avançam, a linha fica permanentemente devida com o `next_attempt_at` mais antigo
da tabela, e ordenar por ele a põe em primeiro lugar a cada minuto, para sempre,
comendo o orçamento de laço da varredura. `updated_at` é escrito pelo CLAIM, isto
é, pelo próprio ato de SERVIR a linha, então ser servida sempre lhe custa o lugar
na fila. O `SWEEP-6` monta as duas ordens em conflito (a envenenada com o
`next_attempt_at` mais ANTIGO e o `updated_at` mais NOVO) e o `C-SWEEP-4` prova que
a escrita do plano avermelharia exatamente esse caso.

**Dois resultados MEDIDOS ao escrever o `20`/`21`, os dois com a sabotagem
aplicada de forma PERSISTENTE (não só pelo controle):**

1. **O `SWEEP-6` precisa chamar a seleção UMA vez, com `with ordinality`.** Na
   versão de duas chamadas (uma para contar, outra para pegar a primeira), a
   sabotagem do `C-SWEEP-3` — a seleção que reivindica EM LOTE — o avermelhava com
   *"nao devolveu primeira linha nenhuma"*: a primeira chamada reivindicava tudo e
   a segunda voltava vazia. O vermelho era real, mas a mensagem mandava
   investigar a ORDEM quando o defeito era a ESCRITA. Com uma chamada só, a
   sabotagem do claim em lote avermelha **apenas** o `SWEEP-5`.
2. **`with ordinality` em vez de `array_agg` cru sobre o function scan.** É a
   forma documentada de capturar a ordem em que a função devolveu as linhas;
   depender da ordem em que um agregado consome o scan é apostar no plano.

**Quadro de sabotagem do `21`, medido linha a linha** (sabotagem persistida, `20`
reexecutado, 113 reaplicada para restaurar):

| controle | avermelha | continua verde |
|---|---|---|
| `C-SWEEP-1` (sem o filtro de tempo) | 65 (`SWEEP-2`) | 64, 66–72 |
| `C-SWEEP-2` (sem a perna do lease vencido) | 66 (`SWEEP-3`) **e** 69 (`SWEEP-6`, linha de base — o veredito nomeia o takeover) | 64, 65, 67, 68, 70–72 |
| `C-SWEEP-3` (seleção que reivindica em lote) | 68 (`SWEEP-5`) | 64–67, 69–72 |
| `C-SWEEP-4` (`order by next_attempt_at`) | 69 (`SWEEP-6`) | 64–68, 70–72 |
| `C-SWEEP-5` (30 dias também para `done`) | 70 (`PURGE-1`) | 64–69, 71, 72 |
| `C-SWEEP-6` (sem a perna de `dead`) | 71 (`PURGE-2`) | 64–70, 72 |
| `C-SWEEP-7` (drop + create sem o `revoke`) | 72 (`ACL-SWEEP`) | 64–71 |

### Sequência da migration 115 (Fase D — touchpoints CTWA)

**Banco PRÓPRIO `fased115`**, por duas razões. A primeira é a de sempre: o `22`
declara `t_res` com `ord int primary key`, como o `09` e posteriores, e não
convive com o `03`/`05`. A segunda é desta sequência: o `22a` tem de rodar
**ANTES** da 115 — são os default privileges dele que fazem a tabela nascer com
os grants do Supabase —, e ele recusa rodar num banco onde a tabela já existe.
Não dá para acrescentá-la a um banco que já tem a 115.

Nada de 061/110/111/113: a 115 referencia só `units`, `whatsapp_channels` (do
`00`) e `customers` (do `22a`), e os canais do `00a` servem de fixture. O canal
`dddd…02` é da unidade B1 e o cliente `cccc…03` da org B — são eles que os casos
de tenant cruzado usam.

**O servidor pode já estar no ar** na 55432 (outra sessão pode tê-lo subido): nesse
caso não rode `pg_ctl start`, e **não o pare** ao terminar — só crie e apague o
banco `fased115`. Se ele não estiver no ar, a seção "Rodar" diz como conferir a
porta antes de subir qualquer coisa — e vale também o caso inverso do que ela
descreve: em 2026-09-28 o `postmaster.pid` do data dir default dizia porta 55432
com um PID que **não existia mais** (resíduo), e o único Postgres no ar era de
OUTRO data dir, na 55433 e com senha. Conferir PID e porta antes de concluir
qualquer coisa vale nos dois sentidos.

```bash
export PGCLIENTENCODING=UTF8          # obrigatório; ver a nota na seção "Rodar"
PG="$USERPROFILE/scoop/apps/postgresql/current/bin"
"$PG/dropdb.exe"   -h 127.0.0.1 -p 55432 -U postgres --if-exists fased115
"$PG/createdb.exe" -h 127.0.0.1 -p 55432 -U postgres fased115
P() { "$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d fased115 -v ON_ERROR_STOP=1 "$@"; }

P -f supabase/tests/local-preflight/00-bootstrap.sql
P -f supabase/tests/local-preflight/00a-whatsapp-legacy-seed.sql
P -f supabase/tests/local-preflight/22a-ad-touchpoints-bootstrap.sql

# ANTES da 115, o 22 e o 23 têm de FALHAR pelas guardas do topo. É o RED que dá
# sentido ao GREEN: rodado antes, TP-5/6/6b/7 passariam POR ACIDENTE, porque sem
# a tabela todo insert "falha" e todo caso negativo fica verde medindo nada. O 23
# deixa a sentinela -23 gravada; a execução sadia dele a apaga.
P -f supabase/tests/local-preflight/22-ad-touchpoints-115.sql   # esperado: ERROR (guarda: tabela ausente)
P -f supabase/tests/local-preflight/23-controles-115.sql        # esperado: ERROR (guarda)

P -f supabase/migrations/20260927120000_115_whatsapp_ad_touchpoints.sql
P -f supabase/tests/local-preflight/22-ad-touchpoints-115.sql   # TP-11 = PENDENTE
# TP-11 mede idempotência ATRAVÉS DE EXECUÇÕES: a 1a passada grava a assinatura
# do catálogo, a 2a compara. Reaplicar a 115 no meio é o que está sendo medido.
P -f supabase/migrations/20260927120000_115_whatsapp_ad_touchpoints.sql
P -f supabase/migrations/20260927120000_115_whatsapp_ad_touchpoints.sql
P -f supabase/tests/local-preflight/22-ad-touchpoints-115.sql   # TP-11 = OK

"$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d fased115 \
  -f supabase/tests/local-preflight/23-controles-115.sql        # SEM ON_ERROR_STOP
# NÃO reaplicar a 115 aqui: cada controle já se desfez sozinho e conferiu o
# restore contra o catálogo.

P -c "select ord, caso, veredito from t_res order by ord;"      # 20 linhas, todas OK

# Concorrência do `for share`, com DUAS sessões — mesmo banco, depois do 23.
# Leva ~11 s (três casos esperam um pg_sleep(3)). Sai != 0 se algum falhar.
PGPORT=55432 PGDB=fased115 bash supabase/tests/local-preflight/24-concorrencia-115.sh
# esperado (tempos variam):
#   CONC-1  OK      INSERT esperou 2.05 s (>= 1.5); recusa: ERROR:  P0A15: whatsapp_ad_touchpoints: cliente cccccccc-0000-0000-0000-000000000001 anonimizado; sobraram 0; sessao A rc=0
#   CONC-2  OK      anonimizacao esperou 2.07 s (>= 1.5); sobraram 0 (esperado 0); rc A=0 B=0
#   CONC-3  OK      INSERT sem concorrencia levou 0.08 s (< 1); rc=0
#   CONC-4  OK      sem for share: anonimizacao levou 0.07 s, sobrou 1 (esperado 1); sabotou=t restaurou=t
#   4/4 OK
```

Ao terminar: `"$PG/dropdb.exe" -h 127.0.0.1 -p 55432 -U postgres fased115`. **Não
pare o servidor.**

**Conte as 20 linhas, não confie em "nenhum FALHOU".** O `23` roda SEM
ON_ERROR_STOP, e um erro de compilação de plpgsql derruba o bloco inteiro antes
de qualquer statement — nem o `when others` grava veredito. A tabela ficaria com
menos linhas, todas OK, que é a aparência exata de uma execução sadia. É a mesma
razão da sentinela `-23`: ordinal próprio, para que um `23` saudável nunca apague
a de outro arquivo de controles que falhou. **Ao acrescentar caso, atualize este
número e o do comentário do `select` acima.**

| ord | caso | arquivo |
|---|---|---|
| −23 | `GUARDA-23` (sentinela; **só aparece quando os pré-requisitos do `23` falham**) | `23` |
| 85–90 | `TP-1` .. `TP-6` | `22` |
| 91 | `TP-6b` (cliente anonimizado recusado) | `22` |
| 92–96 | `TP-7` .. `TP-11` | `22` |
| 97–101 | `C-115-1` .. `C-115-5` | `23` |
| 102 | `TP-1b` (o `service_role` grava) | `22` |
| 103 | `TP-4b` (DELETE da unidade com dupla cascata) | `22` |
| 104 | `C-115-6` | `23` |

**Quadro de sabotagem, medido com a sabotagem PERSISTIDA** (fora de
subtransação, `22` reexecutado, 115 reaplicada para restaurar — e o `22` volta a
14/14 OK depois de cada uma). O `TP-11` fica vermelho em TODAS as linhas, e isso
é o certo: ele compara a assinatura do catálogo, que é exatamente o que a
sabotagem mudou. Fora ele, o vermelho é localizado e a mensagem nomeia o defeito:

| sabotagem (controle) | avermelha | continua verde |
|---|---|---|
| guard sem `<excecao-set-null>` (`C-115-1`) | 88 (`TP-4`: "DELETE do canal abortou … e imutavel") | todos os outros, **inclusive 103** |
| guard sem `<coerencia-tenant>` (`C-115-2`) | 89 (`TP-5`), 90 (`TP-6`) | todos os outros |
| guard sem `<guarda-update>` (`C-115-3`) | 87 (`TP-3`: os sete UPDATEs aceitos) | todos os outros |
| purga `security invoker` (`C-115-4`) | 94 (`TP-9`: `42501 permission denied for table whatsapp_ad_touchpoints` — com o `revoke` de tabela o soft delete estoura; sem ele, era `depois=2`), 95 (`TP-10`: "purga deveria ser DEFINER") | todos os outros |
| guard dropado e recriado sem `revoke`, trigger recriado (`C-115-5`) | 95 (`TP-10`: anon, authenticated, PUBLIC) | todos os outros |
| guard sem `<cliente-vivo>` (`C-115-6`) | 91 (`TP-6b`) | todos os outros |

**Três resultados MEDIDOS ao escrever este conjunto**, cada um registrado no
arquivo, no ponto em que importa:

1. **O `TP-4b` NÃO passa pela exceção do `set null`** — o rascunho supunha que
   sim. No DELETE da unidade, as ações de FK disparadas pelo DELETE do canal
   entram na fila DEPOIS das ações irmãs do DELETE da unidade: o cascade direto
   apaga o touchpoint primeiro, e o `set null` chega a zero linhas (um trigger
   espião `before update or delete` registrou só o DELETE). Por isso ele segue
   verde sem `<excecao-set-null>`. O caso continua valendo — prova que o DELETE
   da unidade conclui —, mas quem prova a exceção é o `TP-4`, com o `C-115-1`.
2. **`text[] || 'literal'` sem cast estoura `22P02`.** O `TP-10` apendava
   literais crus a `v_falhas`; o Postgres resolve o literal como array
   (`malformed array literal`), e sob a sabotagem do `C-115-4` o caso ficava
   vermelho pelo `when others`, com uma mensagem que não nomeava o defeito. Os
   literais levam `::text`.
3. **`set search_path = ''` grava `{"search_path=\"\""}` em `proconfig`** no
   18.4 — o elemento `search_path=""`, que é o que o `TP-10` exige.

O recorte do `pg_temp.sem_trecho` (`-- <x>.*?-- </x>`, sem flag) também foi
medido: no ARE do Postgres `.` casa quebra de linha por default e a gula do RE
é a do primeiro quantificador, então cada recorte remove só o próprio trecho —
os outros três marcadores de abertura continuam no corpo (dois, no caso de
`guarda-update`, que contém `excecao-set-null`), e o `select … for share`, que
fica fora de todos os marcadores, sobrevive a todo recorte.

**Por que o restore mora dentro de cada controle.** Reaplicar a 115 restauraria
as FUNÇÕES (`create or replace function`, `drop trigger if exists` + `create
trigger`, os `revoke`) — o quadro acima foi restaurado assim. Mas ela NÃO
restaura a tabela, pela razão da nota "Por que reaplicar a 111 não restaura":
`create table if not exists`/`create index if not exists` são no-op sobre uma
tabela que já existe. Um arquivo de controles que dependa do reapply deixaria
de pé qualquer sabotagem futura de CHECK, FK ou índice; por isso cada controle
captura, sabota, confere que o catálogo mudou, mede o defeito, desfaz por
rollback de subtransação (`ZZ115`) e confere o restore. O veredito só é `OK` se
as três metades casarem.

**O que o pré-voo NÃO prova aqui:**

- **Exposição PostgREST** da tabela (nenhuma rota REST útil, dada a RLS forçada
  sem policies) — depende de Supabase de verdade.
- **O `rolbypassrls` do `postgres` de produção.** A purga é SECURITY DEFINER
  justamente para rodar como o dono e alcançar as linhas de uma tabela FORCE
  RLS; em produção o `postgres` tem `rolbypassrls = true` (medido lá em
  2026-09-27, spec §1.2 de
  [../../../docs/superpowers/specs/2026-09-27-datafy-fase-d-ctwa-referral-design.md](../../../docs/superpowers/specs/2026-09-27-datafy-fase-d-ctwa-referral-design.md)).
  Localmente o `postgres` é superusuário e ignora RLS de qualquer jeito, então o
  `TP-9` verde aqui não distingue as duas coisas.

A serialização do `for share` contra uma anonimização CONCORRENTE **não** está
nesta lista: o `22`/`23` são de sessão única e medem só a perna sequencial (`TP-6b`) e
o privilégio que o `for share` exige (`TP-1b`), mas o `24-concorrencia-115.sh`
mede a corrida com duas sessões reais, nas duas ordens (CONC-1 e CONC-2), com
controle de tempo (CONC-3) e controle positivo (CONC-4: sem o `for share`, a
linha sobrevive à anonimização).

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

## O que os quatro controles do `10` fazem

**CONTROLE-6** reconstrói `enter_waitlist` a partir de `pg_get_functiondef` com
uma única troca — `app_private.is_` volta a `public.is_` — e chama a função como
membro autenticado: ela **estoura** com `function public.is_unit_member(uuid,
uuid) does not exist`. É o defeito central desta fase reproduzido em vez de
argumentado; sem ele, "ACL-2 passou" não significaria nada. Duas coisas o fazem
medir: a definição vem do banco (redigitada à mão, erraria o tipo de retorno e
falharia por outro motivo) e o claim JWT é setado (sem ele a função tomaria o
ramo anon e não chamaria helper nenhum).

**CONTROLE-7** responde **qual privilégio é load-bearing**, porque o rascunho
desta fase supôs errado. `USAGE` de schema não é: expressão de policy fica
guardada no catálogo já resolvida, e `USAGE` só governa procura de NOME. `EXECUTE`
de função é: ele é conferido na inicialização da expressão mesmo quando a função
é referenciada por identificador já resolvido — revogá-lo **estoura 42501**. É
por isso que a 106 move em vez de revogar.

**O `7a` mudou de forma na rodada 4, e a mudança é um fortalecimento.** Antes ele
revogava `usage` de `anon` para mostrar que a policy seguia avaliando. A 106
passou a **negar** esse `usage` a `anon` e `authenticated` (só `service_role`
recebe), então revogá-lo deixou de ser sabotagem — **a suíte inteira agora roda
nesse estado**, o que prova mais que o controle antigo provava. O `7a` virou a
afirmação explícita da postura entregue:
`has_schema_privilege('anon'|'authenticated', 'app_private', 'usage')` é `false`
nas duas. Quem prova que a postura é *suficiente* são os casos do `09` rodando ao
lado: `ACL-1` (policy `TO PUBLIC`), `ACL-1b` (tenant cruzado) e `ACL-4` (`anon`
entrando na fila ponta a ponta), todos verdes sem `usage`. O `7b` ficou intacto —
é ele o controle positivo de verdade.

O `7a` tem força: reconceder `usage` a `anon` e rodar o `10` devolve
`FALHOU: 7a postura=divergiu (usage concedido: anon=true, authenticated=false)`,
nomeando o papel. E reaplicar a 106 sobre um banco com a postura antiga
**converge** — os `revoke` dela derrubam o `usage` herdado.

**CONTROLE-9** sabota o **predicado de tenant**: troca o corpo de
`app_private.is_unit_member` por `select true` e confere que o não-membro passa a
VER linha em `acl_probe` — o defeito que o `ACL-1b` existe para pegar. Sem ele,
"ACL-1b passou" não distingue a guarda funcionando de teste sem força, e o
`ACL-1b` é justamente a asserção de isolamento multi-tenant desta migration.

**O restore do CONTROLE-9 mora dentro do próprio controle, não no reapply da
106** — diferente dos controles 6 e 7. A 106 só MOVE o helper
(`alter function ... set schema`, guardada por `to_regprocedure(...) is not
null`, que é NULL depois do move) e **nunca redefine o corpo**. Medido: sabotar,
reaplicar a 106 e reler `prosrc` devolve `select true` intacto. Por isso o caso
captura a definição real de `pg_get_functiondef` **antes** de sabotar, restaura a
partir dela, e **verifica** o restore (o não-membro tem de voltar a ver zero) —
o veredito só é `OK` se as duas metades casarem. O bloco também tem handler
`when others`: DDL em plpgsql roda na subtransação do bloco, então falha no meio
desfaz a sabotagem por rollback. Nenhum caminho deixa helper permissivo de pé —
o que importa aqui mais que nos outros dois, porque um helper permissivo
esquecido faria **todo caso posterior naquele banco passar em silêncio**.

Este é o 9, e não o 8, porque o 8 já pertencia a `ACL-1b` quando este arquivo
foi escrito. O controle de overload errado que a Task 5 acrescenta em
`11-overloads-107.sql` (`CONTROLE-8`, no nome — não no ordinal) usa 14 e 15; ver
a tabela de ordinais acima.

**CONTROLE-10** sabota o outro guard de tenant: `app_private.is_org_member`, que
é o de `anonymize_customer` e `get_customer_stats_bulk`. Ele mede pelo `ACL-3d`
porque ali um guard quebrado **não estoura — ele vaza formato de dado**: com o
helper devolvendo TRUE, `get_customer_stats_bulk` devolve a agregação do cliente
da outra organização junto com a do chamador (2 linhas em vez de 1). Recusa que
deixa de recusar é visível; agregado que aparece a mais é o que passa
despercebido. O `ACL-3b` ficaria vermelho pelo mesmo helper, então um controle
sobre `is_org_member` cobre os dois — não há um por função. Mesma disciplina de
restore do CONTROLE-9, e vale o mesmo aviso: **reaplicar a 106 não restauraria**,
porque ela só move o helper e nunca define o corpo.

Os dois controles de sabotagem cobrem `is_unit_member` (9) e `is_org_member`
(10). `is_platform_admin` fica sem controle de mutação de propósito: nas quatro
funções ele aparece sempre como o segundo termo de um `or`, sempre com
`platform_admins` vazia neste harness — sabotá-lo para TRUE tornaria todo
chamador super-admin e o que ficaria vermelho seriam os mesmos casos que 9 e 10
já cobrem, sem isolar nada de novo.

## O que o CONTROLE-16 do `09` faz

É o controle positivo do `ACL-1` — e o `ACL-1` é o único caso desta suíte que
sustenta a frase da 106 sobre as policies não precisarem de reescrita, que é o
que autoriza deixar **42 policies de produção intocadas** (24 delas `TO PUBLIC`).

A sabotagem disponível é uma só, e é justamente ela que demonstra a propriedade:
**depois do move não existe como escrever uma policy que resolva
`public.is_unit_member`**. O caso dropa a policy da fixture, observa a asserção do
`ACL-1` virar zero (o vermelho), e tenta reconstruí-la pelo nome antigo — o
`create policy` estoura `undefined_function`. Num mundo em que policy dependesse
de nome, a fixture não poderia nem existir neste banco.

**O restore é rollback de subtransação, não um `create policy` de volta**, e a
escolha é o ponto: recriar a policy a resolveria pelo endereço NOVO, e a 2a
passada do `09` (a que o `ACL-5` exige) leria uma policy nascida DEPOIS do move —
o controle reintroduziria, pela porta de trás, exatamente o defeito de evidência
que ele existe para fechar. Um `raise` com SQLSTATE próprio desfaz o `drop` e
devolve a MESMA linha de `pg_policy`; quem confere isso é o `ACL-1`, comparando
com o OID gravado pelo `09a`. Variável de plpgsql não é transacional, então os
valores observados durante a sabotagem sobrevivem ao rollback e dá para julgar
depois de desfazer.

Por não deixar resíduo, ele roda sob `ON_ERROR_STOP=1` junto dos casos, em vez de
morar num `NN-controles-*.sql` — mesma situação do `CONTROLE-8` no `11`.

**Achado colateral, e vale para ler qualquer veredito:** os handlers
`when others` do `09` gravam com `on conflict (ord) do update`. O `delete from
t_res where ord = N` do início de cada caso é DESFEITO pelo próprio `exception`
que o handler está tratando (em plpgsql o handler roda depois do rollback da
subtransação do bloco), então, na 2a passada, caso que estoura tentava inserir um
ordinal já gravado e morria com `duplicate key`. Sob `ON_ERROR_STOP=1` isso
**abortava o arquivo** — sumiam o veredito do caso que falhou e os de todos os
seguintes, exatamente quando alguém precisa deles. Não foi deduzido: apareceu ao
sabotar a fixture de propósito para ver o `CONTROLE-16` ficar vermelho.

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

## Catálogo e ledger de templates WhatsApp — 25/26

Use um **projeto Supabase local descartável e próprio**, com Auth/GoTrue e
PostgREST, sem link remoto. Não copie o histórico do produto: migrations antigas
contêm cron/URLs de produção e não são replayáveis. O arquivo de produto desta
fase é `20261003225857_whatsapp_template_catalog.sql`, gerado pelo Supabase CLI.

`25-template-bootstrap.sql` fornece somente organizations, três units em duas
orgs, membros/admins, canais, customers, reserva/fila/voucher, textos legados,
settings e audit. As policies iniciais de reservation/waitlist templates são
somente de membro, como no histórico; a migration de produto acrescenta a
contraparte platform admin. Settings já inclui ambos. Não é um replay do RLS
completo de produção. Auth instalado é preservado:
`auth.users`, `auth.uid()` e `auth.role()` só são criados se ausentes. Em um
Postgres standalone isso permite testar SQL, **sem comprovar JWT/PostgREST**.

Ordem para a stack local já inicializada (nomes scratch gerados pelo CLI):

1. Gere `template_test_bootstrap` **no workdir scratch**, copie o `25` para o
   arquivo recém-gerado e aplique com `supabase db push --local --workdir <scratch>`.
2. Execute `26-template-catalog.sql` com `ON_ERROR_STOP=1` antes do schema de
   produto. O RED esperado é `42P01`, relation `whatsapp_template_accounts` absent.
3. Gere `template_catalog_fixture` no mesmo workdir scratch, copie **somente** a
   migration de produto para esse arquivo e aplique por `db push --local`.
   O timestamp scratch posterior ao bootstrap mantém a ordem das dependências;
   o arquivo de produto conserva seu timestamp original no Git.
4. Execute o `26` de novo. Todos os asserts precisam passar e o `ROLLBACK` final
   deve deixar as fixtures intactas. Os claims nesse SQL são contexto de teste,
   nunca evidência de assinatura de JWT.
5. Gere outra migration scratch com o **mesmo DDL de produto** e reaplique por
   `db push --local`. Compare colunas, constraints, índices, funções, triggers,
   RLS e ACL antes/depois. Teste rollback de DDL em subtransação com uma exceção
   deliberada e confira a assinatura do catálogo restaurada.

Exemplo de execução do SQL no contêiner próprio, em PowerShell:

```powershell
$env:PGCLIENTENCODING = 'UTF8'
Get-Content -Raw supabase/tests/local-preflight/26-template-catalog.sql |
  & $taskDocker exec -i supabase_db_moralles-templates-20261003 `
    psql -U postgres -d postgres -X -v ON_ERROR_STOP=1
```

Os casos verificam FORCE RLS/ausência de policies/grants privados, WABA única
independente de provider, coerência org/unit/canal/recurso, exactly-one/kind,
transport e UUID de notificação fixos, hash-only de token, revisão SQL de
consentimento, evidência append-only, custo por binding/generation/admin,
adoção sticky por unidade, exclusão de canal sem perder fence/ledger/recibo,
aceite tardio, correlação única de recibo, anonimização verificada e a exceção
estreita de cascade quando a unidade já foi removida. Também cobrem TTL zero,
refresh pre-POST de epoch/render seguro, freeze pós-POST e gerações distintas de
conta versus vínculo. Fila preserva customer_id compatível ou resolve telefone
canônico dentro da organização quando NULL, sem criar cliente; DDD 55 é mantido.
O fallback de canal segue created_at ASC, como o envio atual. Textos antigos permanecem.
O revoke também limpa defaults de service_role: somente CRUD nas tabelas de
serviço, SELECT nas adoções, nenhum acesso aos permits; TRUNCATE/TRIGGER/REFERENCES são negados.

A fixture contém somente colunas consumidas por estes guards. Slug de org/unit,
data/hora/pessoas/código de reserva e código/desconto/validade de voucher precisam
ser acrescentados pelas próximas tasks antes de testar elegibilidade e payloads
completos; esta suíte não comprova esses fluxos futuros.

Além do `26`, a validação de integração precisa criar usuários fake **no GoTrue
local**, obter JWT reais e chamar PostgREST com anon, service role e cada papel
(owner/gerente/operador/platform_admin/outro tenant). Assert HTTP/code **e efeito
no banco**: UPDATE/DELETE anon nas tabelas legadas pode retornar `200 []` pelo RLS;
isso não é autorização nem prova de mudança. Tabelas internas devem negar grants
a todos esses usuários, incluindo platform admin; manutenção só passa pela RPC
`maintain_whatsapp_legacy_template` com JWT authenticated de admin real, audit
derivado de `auth.uid()` e permit consumido. Service role não executa essa RPC.
Teste owner/gerente editando texto não oficial e configuração `table_ready`,
operador negado para configuração e chaves settings não relacionadas preservadas.
O envio manual de mesa/atendimento e `after_rating` não passam por esse catálogo.

Teste também duas sessões reais inserindo decisões para o mesmo
unit/customer/purpose: a segunda deve esperar o lock do cliente e receber revisão
SQL seguinte, mesmo com `observed_at` anterior. A liberação de adoção via RPC
administrativa e a purga automática de anonimização pertencem às próximas tasks;
este schema já fornece os guards necessários.
O marcador posting_started_at não pode mudar após ser preenchido: ele sustenta o
freeze de epoch/render em todas as atualizações posteriores. Retry com rejeição
comprovada exigirá autorização SQL estreita nas próximas tasks, sem reset genérico.
Jobs de catálogo derivam organization_id da conta, preservam a conta por FK
NO ACTION DEFERRABLE e têm cascade independente pela organização para privacidade.
Autor de submission_authorized_at fica protegido por FK RESTRICT: a remoção do
usuário exige revogar explicitamente timestamp e ator juntos, sem reassinar a decisão.

Chaves/JWT locais são lidos privadamente de arquivo scratch e nunca impressos,
gravados no router ou commitados. Os resultados locais não comprovam o ACL/RLS
do banco de produção, Security Advisor, homologação Datafy/Meta ou rollout.

### Claims/transições de automação e catálogo — Task 4

`27-template-claims.sql` roda depois de `25-template-bootstrap.sql`, migration
`20261003225857_whatsapp_template_catalog.sql` e migration
`20261004002728_whatsapp_automation_claims.sql`, em banco descartável. Seus dados,
funções temporárias e controles mutantes terminam em rollback. Fixture 25 contém
somente as colunas legadas usadas pelo contrato, incluindo platform_flags,
notifications_sent com as FKs reais e last_health_check_at; não é replay do schema
de produção. Nenhuma coluna voucher_id é inventada em notifications_sent.

O teste verifica chave unit/kind/recurso, ledger com flag OFF, FK de notificação
legada aceita, recusa uniforme de recurso ausente/alheio, claim sem tentativa,
fence errado, retry Datafy apenas por não-aceite preproxy documentado, máximo
cinco POSTs, lease vencida sem takeover de POST e aceite tardio no fence original.
Verifica DNC, consent revision operacional, identidade alterada, promoção text
bloqueada sem autorização individual atual, expiry original, requeue restrito a
blocked/paused sem POST, seleção máxima de 20 sem claim coletivo, batch de gestão
atômico, snapshot completo por geração da conta + epochs e preservação de RED
quando o GET omite quality. RED impede MARKETING; UTILITY aprovado fica utilizável
após GET válido, e sync_required bloqueia ambos. Controles positivos removem UNIQUE/fence e trocam o
relógio por now(); a assertion correspondente precisa detectar cada mutação, que
é revertida dentro de uma subtransação antes de continuar.

`whatsapp_template_accounts.reconciliation_revision` só identifica/coalesce
tarefas de catálogo e nunca é fence do snapshot. O batch incrementa sob lock da
conta somente por eventos novos. O teste remove eventos antigos depois de uma
tarefa sync done e prova revisão inédita na tarefa seguinte; dedupe e tentativa
de reduzir a coluna não reutilizam identidade. A retenção futura de 90 dias não
pode converter esse contador em count(eventos ainda retidos).

`28-template-concurrency.sh` executa duas sessões reais e exige exatamente um
owner. Depois segura o lock do customer além de uma lease curta de teste e
confere que prepare retorna false sem marker/attempt. Outra corrida troca a conta
do binding enquanto enqueue aguarda o lock da conta original, exigindo recusa
sem criar tarefa com pins misturados. A lease de produção
continua 90 segundos e usa clock_timestamp() após adquirir os locks. Para o
runtime Docker isolado deste desenvolvimento:

```bash
TASK_DOCKER='/caminho/docker' \
TASK_DB_CONTAINER='supabase_db_moralles-templates-20261003' \
bash supabase/tests/local-preflight/28-template-concurrency.sh
```

Alternativamente use psql com PGHOST=127.0.0.1/PGPORT=55452 apontando ao mesmo
banco descartável. O script cria um tenant fake próprio, preserva/restaura a flag
local e limpa somente seus dados; nunca usa provider, cron ou banco remoto.
Teste JWT/PostgREST separado deve obter JWT reais GoTrue de cada papel e conferir
que as 13 RPCs service-only negam anon/owner/gerente/operador/platform_admin/
outsider. Adoção no setup SQL claims-context prova o trigger; não substitui a
futura RPC de release autenticada. Permit de reset em app_private não recebe
grant de caller algum, inclusive service_role; nunca existe bypass por GUC,
actor_id do body ou estado novo isoladamente.

### Preferências promocionais e slots — Task 5

`29-template-preferences.sql` roda após a fixture25, migrations de Tasks3/4 e
`20261004014032_whatsapp_message_preferences.sql`. Termina em rollback e cobre
o prepare/finish reais, opt-in desconhecido, DNC, revisão SQL, token somente hash
com TTL90 dias, GET sem alteração do domínio, POST idempotente unit-scoped,
revogação/expiração, slot concorrente, janela capturada e anonimização.
`27-template-claims.sql` agora testa a proteção real de consentimento desconhecido.

`30-template-preferences-concurrency.sh` usa duas sessões PostgreSQL para prepare
versus prepare, lease expirada com marcador, finish versus prepare, opt-out
versus prepare, opt-outs simultâneos, anonimização versus prepare e rate gate
atômico. O mesmo modo Docker/loopback da Task4 é obrigatório; o script limpa
seu tenant fictício e restaura a flag que encontrou, sem provider ou banco remoto.

```bash
TASK_DOCKER='/caminho/docker' \
TASK_DB_CONTAINER='supabase_db_moralles-templates-20261003' \
bash supabase/tests/local-preflight/30-template-preferences-concurrency.sh
```

A EF pública `whatsapp-message-preferences` usa a mesma factory pura testada com
Requests reais; `verify_jwt=false` autoriza exclusivamente a capability de saída.
GET recebe `x-preference-token`, sem query e sem mudança de token/consentimento/
cliente/slot. POST exige origem exata configurada em `WHATSAPP_PREFERENCE_ORIGINS`,
JSON limitado a2048 bytes lidos do stream e apenas `{token,action:'opt_out'}`.
OPTIONS não exige token; respostas usam no-store e no-referrer. O token tem
32 bytes aleatórios/base64url canônico43 caracteres, SHA256 e90 dias via SQL.
Revogação administrativa é interna; opt-out não consome nem revoga o link.

Todas as seis novas RPCs são service-only, sem leitura SQL direta pelo frontend.
Rate gate guarda apenas bucket hash técnico privado, usa UPSERT atômico e
limpa buckets vencidos há5 minutos. Default30/60s; limites internos SQL1..100
requisições e10..300s, nunca derivados do body público. Erro de banco fecha503.
Contador técnico pode avançar no GET, separado do domínio read-only. Contexto
forwarded é pacing suplementar; não prova identidade. Nenhum check_rate_limit
legado foi alterado.

Política global privada default7 dias/bounds1..30 não recebe grants diretos,
inclusive service_role. A duração é capturada no slot e não muda retroativamente;
writer autenticado platform_admin e auditoria pertencem à Task13. Prepare segue
customer→account→binding→channel→template→preferência/slot→job; finish promocional
segue customer→slot→job e permite aceite tardio com pins históricos. Claim/requeue
não escrevem slots. Marcador de POST/uncertain protege reserva mesmo com lease
expirada. Rejeição documentada ou local_preflight_refused libera atomicamente;
timeout/500 mantém uncertain. Recusa local só aceita os cinco motivos fechados,
fence/lease originais vivos e nenhum provider ID, e consome permit privado único
para desfazer apenas a tentativa preparatória. Task9 fornece o switch confiável
postAttempted imediatamente antes de chamar adapter/rede.

Exclusão de voucher/fila/job preserva o slot e seu job_id técnico obrigatório e
único, sem FK para o job: INSERT continua validando job real e escopo. Slot órfão
accepted/uncertain mantém a janela capturada; reserved órfão protege até window_until
mesmo com lease vencida. Só prepare ordenado pode recuperar a reserva órfã vencida
via permit estreito. DELETE direto continua negado; privacidade customer/unit limpa
também órfãos. SQL29 cobre ambas as cascatas nos três estados, bloqueio da promoção
seguinte, recuperação após janela e cleanup hard/soft de cliente e de unidade.

Após erasure, zero POST comprovado pode finalizar sob as mesmas guardas/permit:
blocked/customer_not_alive, reduz só a tentativa preparada e limpa marcador/fence,
preservando timestamp de erasure, NULL customer/render, identidade e TTL. Requeue e
prepare permanecem negados; fence alheio, lease vencida, uncertain e provider ID
não permitem reset. SQL29 executa esses caminhos reais sem restaurar dados pessoais.

Trigger de deleted_at remove tokens/evidências/slots e apaga safe_log_body mesmo
em accepted/uncertain, preservando fence/marcador/provider ID e timestamps
técnicos. Exceção de freeze é SQL-verificada e não permite restaurar texto.
notifications_sent não tem body/customer_id/voucher_id; nenhum campo foi inventado
nem cleanup legado ampliado. Teste JWT/PostgREST separado deve obter JWT reais
own/foreign owner, gerente, operador e platform_admin: todos negados nas RPCs e
stores internos; service-only positivos, handler/SQL real e domínio GET estável.
Isto não prova configuração de origem, homologação ou ACL de produção.
