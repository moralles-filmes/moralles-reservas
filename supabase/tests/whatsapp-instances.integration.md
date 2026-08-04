# Testes de integração da Fase 6b — status `ENVIRONMENT_BLOCKED`

**Status:** `ENVIRONMENT_BLOCKED`

Este arquivo **não é** um `.test.ts` de propósito. Um arquivo de teste que não roda
vira `skip` silencioso, e `skip` verde é exatamente a mentira que a Seção D proíbe:
"os arquivos dos testes de integração podem ser preparados, mas não devem fingir
execução".

## Motivo exato (literal — "infra indisponível" não serve)

> Rebuild não executado porque o ambiente local não possui Supabase CLI/Docker/psql
> e migrations com wrappers de `pg_cron` contêm URL de produção, tornando a
> execução local insegura sem isolamento prévio.

**Emenda (correção de veredito, 2026-08-01):** o rebuild também **não completaria
se o ambiente existisse**. O replay foi tentado em 2026-07-30 e reprovou com
`42P13 — cannot change return type of existing function`, porque **54 migrations
usam `create or replace function` para alterar retorno tabular contra apenas 4 que
usam `drop function`** ([docs/hotfix-acl/03-ENSAIO-ORDEM-REAL.md §1](../../docs/hotfix-acl/03-ENSAIO-ORDEM-REAL.md)).
Supabase Branch não resolve — ele replaya do zero e estoura no mesmo ponto.

São **dois bloqueios independentes**, e nenhum deles é consequência do outro:

| | Bloqueio | Natureza | O que acontece se o outro for resolvido |
|---|---|---|---|
| **A** | O replay **não completa**: `42P13` | O histórico não é reproduzível | Continua estourando no mesmo ponto |
| **B** | O banco reconstruído **seria inseguro** | O histórico é reproduzível, mas hostil | Continua apontando para produção |

**O bloqueio B não é só a URL.** Três dependências implícitas de ambiente, todas
verificadas por `grep` sobre o histórico:

- **`create extension pg_net` não existe em migration nenhuma**, embora treze
  migrations chamem `net.http_post`. Num banco novo, o replay quebra ou os
  *wrappers* nascem inertes — nos dois casos, o comportamento não é o de produção.
- **O Vault é assumido presente e semeado.** `internal_api_key` (e, a partir da
  092, `project_url`) nunca são criados por migration; são semeadura operacional.
  Num banco reconstruído eles não existem.
- **A URL de produção está embutida nos treze *wrappers* de `pg_cron`.** Com
  `pg_cron` ativo, o banco local agenda `POST` **nas Edge Functions de produção**.

Ordem obrigatória do desbloqueio, e ela não é negociável:
**1º** tornar o histórico reproduzível sem `42P13`; **2º** tornar o ambiente
reconstruído seguro. Inverter não adianta — não há o que endurecer enquanto o
replay não chega ao fim.

## Desbloqueio

A frente `BASELINE_REPRODUCIBLE_DATABASE_ENVIRONMENT`, cujo **primeiro item é
destravar o replay** — pré-requisito dos demais, porque sem ele não existe banco
descartável onde testar nada. Nada deste arquivo é reescrito quando isso
acontecer: os casos já estão especificados.

**Fora do escopo da Fase 6b, por decisão explícita.** Consertar as treze
migrations legadas ou parametrizar o histórico **não** entra nesta fase. A 6b
garante apenas que **nenhuma migration nova repete o padrão**, e isso é testado
por [scripts/migration-static-guard.test.ts](../../scripts/migration-static-guard.test.ts).

## Proibições que não mudam

- **Nunca contra produção.** Teste de integração com fixtures em produção **não
  vira rotina da suíte** — o teste do Risco 7 foi intervenção pontual, autorizada,
  acompanhada e limpa; ter funcionado não transforma produção em ambiente
  permanente de teste.
- **Nunca acionado pelo CI**, nunca automático em merge ou deploy. O CI não deve
  possuir credencial de produção capaz de criar e remover dados.
- **Ren Sushi e Moralles nunca como fixture.**
- Limpeza em `teardown`/`finally`, **mesmo com falha de assertion**.
- Sucesso na limpeza **não prova ausência de efeito colateral** em log, alerta,
  auditoria ou job concorrente.

## Ambiente, por ordem de preferência

1. Supabase local descartável reconstruído pelas migrations — **bloqueado** (os
   dois motivos acima);
2. projeto Supabase separado de teste/staging — **não existe hoje**;
3. banco temporário criado para o job;
4. roteiro manual em produção — só para evidência inalcançável nos anteriores,
   com autorização específica **para aquela execução**.

## Estado da máquina de desenvolvimento (2026-08-02)

**Categoria B — apto apenas para validações estáticas.**

| | |
|---|---|
| Supabase CLI | ✅ **2.111.0** (scoop) — mas **fora do `PATH`** da sessão antiga |
| **Docker** | ❌ **ausente** — logo **não existe stack local** |
| **`psql` / `pg_dump`** | ❌ **ausentes** |
| Repositório | 🔴 **vinculado ao projeto de produção** (arquivos de vínculo ignorados pelo Git) |
| Autenticação da CLI | ativa, via **Windows Credential Manager** |
| `supabase/config.toml` | **43 blocos, todos `[functions.*]`** — sem `project_id`, sem `[db]`: **não é config de stack local** |

**Instalar a CLI não destravou nada deste arquivo.** Os quinze casos continuam
`ENVIRONMENT_BLOCKED` — sem Docker não há banco descartável onde executá-los.

**O ensaio por *dump*** (`db dump --linked` → `supabase start` → importação por
`psql`), usado em 2026-07-30, evita o replay **mas não está autorizado**: é leitura
remota do projeto vinculado e exige protocolo próprio — autorização específica,
análise do conteúdo, sanitização, armazenamento seguro, política de exclusão, além
de Docker e `psql`. **Não é o próximo comando.**

**Quando Docker e `psql` existirem, o ensaio não roda neste diretório.** Ele exige
*workspace* isolado, sem `supabase/.temp` copiado, sem herdar `project-ref`, token
ou `.env.local` de produção — e **sem copiar segredo de produção para o ambiente
subir**. Dependência de segredo se resolve com valor local não sensível ou se
declara como bloqueio.

## Casos, com controle positivo obrigatório

Todo teste negativo carrega controle positivo. Sem ele, "nada aconteceu" passa por
sucesso e uma EF quebrada é aprovada como se fosse defesa funcionando.

| # | Negativo (deve falhar) | Controle positivo (deve funcionar) |
|---|---|---|
| 1 | `authenticated` não lê `whatsapp_instances` | `service_role` lê |
| 2 | `anon` não lê nenhuma das três tabelas | `service_role` lê |
| 3 | `anon`/`authenticated` sem `EXECUTE` em `roll_whatsapp_instance_cycle` | `service_role` executa |
| 4 | segunda rolagem simultânea não cria ciclo duplicado | rolagem legítima cria |
| 5 | dois ciclos `OPEN` na mesma instância são rejeitados | `PENDING_REVIEW` + `OPEN` coexistem |
| 6 | `dedupe_key` repetido no ledger é rejeitado | combinação diferente é aceita |
| 7 | `unit_id` de outra organização é rejeitado pela trigger | `unit_id` coerente é aceito |
| 8 | `channel_id` de outra organização é rejeitado | `channel_id` coerente é aceito |
| 9 | `ENDED` sem `ended_at` viola CHECK | `ENDED` com `ended_at` é aceito |
| 10 | `CLOSED` sem `provider_cost_cents` viola CHECK | `PENDING_REVIEW` sem custo é aceito |
| 11 | `cycle_source='UNKNOWN'` com `current_cycle_due_on` viola CHECK | `UNKNOWN` sem projeção é aceito |
| 12 | `CANCELLATION_REQUESTED` sem `provider_access_until` viola CHECK | com a data é aceito |
| 13 | transição `ENDED → ACTIVE` é recusada pela EF | `ACTIVE → CANCELLATION_REQUESTED` conclui |
| 14 | `provider_instance_ref` duplicado no mesmo provider é rejeitado | ref diferente é aceito |
| 15 | dois `whatsapp_instances` apontando o mesmo `channel_id` é rejeitado | canal livre é aceito |
| 16 | ciclo com `organization_id` ≠ org da instância é rejeitado pela guarda filha | par coerente é aceito |
| 17 | alerta `INSTANCE` com `organization_id` ≠ org da instância é rejeitado | par coerente é aceito |
| 18 | alerta `ORGANIZATION` (`instance_id` nulo) **passa** pela guarda filha | — é o controle positivo do caminho nulo |
| 19 | `UPDATE` que troque `instance_id` para instância de outra org é rejeitado | troca dentro da mesma org é aceita |
| 20 | apagar `organizations` com alerta no ledger é **recusado** (`restrict`) | apagar `whatsapp_channels` só anula `channel_id`, o alerta sobrevive |

**Casos 16–20 nascem da reauditoria de segurança** (`tenant-isolation-auditor` e
`migration-validator`, 2026-08-02). Eles cobrem
`whatsapp_instance_child_tenant_guard()` e a FK `on delete restrict` do ledger —
**regras que vivem no banco**, e por isso inalcançáveis por teste unitário. Como
todos os anteriores, seguem `ENVIRONMENT_BLOCKED`.

### FK × CHECK do ledger — casos FK-A a FK-E

Nascem do `FINDING-004` do `rls-auditor` (rodada 3). O defeito é **latente desde
a versão original da migration 089**, não regressão de correção: a FK
`instance_id … on delete set null` convivia com um CHECK que exigia
`instance_id is not null` no ramo INSTANCE, e apagar uma instância com alerta
abortava a transação inteira com `check_violation` — o oposto do contrato
"o ledger sobrevive nulando".

Estes cinco são o único jeito de provar o desenho novo: **três operações
distintas do banco** (INSERT recusado por trigger, coerção da FK num DELETE,
CHECK avaliando linha coagida) que nenhum teste de núcleo alcança.

| # | Situação | Esperado |
|---|---|---|
| FK-A | `INSERT` INSTANCE com `instance_id` preenchido e `subject_id = instance_id` | **aceito** |
| FK-B | `INSERT` INSTANCE com `instance_id` preenchido e `subject_id` diferente | **rejeitado** pela trigger `whatsapp_alert_subject_guard` |
| FK-B2 | `INSERT` INSTANCE com `instance_id` **nulo** | **rejeitado** — alerta de instância nasce apontando instância viva |
| FK-C | `DELETE` da `whatsapp_instances` que tem alerta INSTANCE aberto | `instance_id` vira `NULL`; `subject_id` e `organization_id` **inalterados**; o alerta **não é apagado**; a transação conclui **sem** `check_violation` |
| FK-D | `INSERT` ORGANIZATION com `instance_id` nulo e `subject_id = organization_id` | **aceito** |
| FK-E | `INSERT` ORGANIZATION com `instance_id` preenchido, **ou** `subject_id` ≠ `organization_id` | **rejeitado** pelo CHECK |
| FK-F | `UPDATE` que altere `subject_id` de qualquer linha | **rejeitado** — identidade histórica é imutável |
| FK-G | `UPDATE` que reaponte `instance_id` de uma instância viva para **outra** | **rejeitado** — transferiria custo entre instâncias sem rastro |

Controle positivo do FK-C: depois do `DELETE`, `select subject_id,
organization_id, alert_type from whatsapp_instance_alerts where id = <id>`
devolve **a mesma linha**, com `instance_id is null`. Se a linha sumiu, a FK está
em `cascade` — regressão grave, porque apaga auditoria financeira.

`WRITTEN / NOT EXECUTED AGAINST DATABASE.` Sem Docker, o comportamento da FK e
do CHECK **não** é declarável verde. A coerência do SQL foi verificada
estaticamente; a execução, não.

## Comportamento do worker — W1–W4 saíram daqui

Estes quatro eram `NOT_EXECUTED` porque
`process-whatsapp-instance-cycles/index.ts` chamava `serve()` no carregamento e
importava `deno.land`/`esm.sh`: **o vitest não conseguia importá-lo**, e as
correções ficavam sustentadas por leitura.

O lote de estabilização extraiu decisão e fluxo para
[`_shared/whatsapp-instance-worker-core.ts`](../functions/_shared/whatsapp-instance-worker-core.ts),
com `clock`, `repo`, `notifier`, `recipients` e `telemetry` injetados. Os quatro
viraram teste real:

| # | Comportamento | Onde |
|---|---|---|
| W1 | Resolução do destinatário é da invocação, não do módulo — sem admin não enfileira e o slot fica livre; com admin, enfileira | núcleo, bloco **A** |
| W2 | Falha na leitura de instâncias em divergências aborta o passo: zero `CHANNEL_WITHOUT_INSTANCE` falso | núcleo, bloco **G** |
| W2b | Controle positivo: as duas leituras OK → canal elegível sem inventário gera o alerta | núcleo, bloco **G** |
| W3 | Falha em cada leitura de economia: `failed>0` e nenhum alerta com dado parcial | núcleo, bloco **H** |
| W4 | D-1 com motivo A, lembrete com motivo B: mesma linha, `payload` atualizado, sem duplicata | núcleo, bloco **E** |

**`WORKER_CORE_TESTS: EXECUTED`.** Isso NÃO promove nenhum caso de banco: CHECK,
FK, índice parcial, RLS, grant, `SECURITY DEFINER`, trigger e concorrência real
da RPC continuam `ENVIRONMENT_BLOCKED`. Teste de núcleo prova a decisão do
worker, não a regra do banco — e confundir os dois é exatamente o erro que este
arquivo existe para impedir.

## Por que integração e não unitário

O hotfix do Risco 7 provou o ponto: a classificação estava **certa** e a retenção
não persistia porque o `UPDATE` violava um `CHECK`. **Nenhum mock teria pego.**
Onze dos quinze casos acima são dessa família — a regra vive no banco, e só o
banco pode reprová-la.

**O caso 4 está aqui e não no núcleo puro de propósito:** concorrência é fato de
banco, não aritmética de calendário. Simulá-la com mock provaria apenas que o mock
foi escrito de acordo com o mock.

---

## Fase 6c — ledger `whatsapp_instance_notes` (migration 096)

Nenhum caso abaixo é verificável por vitest. Roteiro para banco local
(PostgreSQL 18.4 em `127.0.0.1:55432`, sem `pg_cron`/`pg_net`), aplicando a
migration real sobre bootstrap mínimo — o mesmo procedimento usado para validar
a 089.

> **EXECUTADO em 2026-08-03: `NOTE-A` a `NOTE-D`, 19 casos, 19 PASS, 0 FAIL**,
> com a 096 aplicada verbatim (três vezes, para o NOTE-A) sobre 087 e 088
> também verbatim. Inclui os dois controles positivos: o CHECK da 089
> reintroduzido faz o `DELETE` abortar (defeito F-01 reproduzido), e a condição
> da 089 em `<>` puro deixa passar `NULL → uuid` (defeito latente demonstrado).
> Harness commitado em [local-preflight/](local-preflight/README.md); resultado
> por caso em
> [docs/billing-asaas/FASE-6C-PENDENCIAS.md §2](../../docs/billing-asaas/FASE-6C-PENDENCIAS.md).
>
> **`NOTE-E` continua pendente** — RLS pelo client SDK exige Supabase de
> verdade, não um Postgres nu.

### NOTE-A — Backfill idempotente

1. Com pelo menos uma linha em `whatsapp_instances` com `notes` não-vazio,
   aplicar a 096.
2. `select count(*) from whatsapp_instance_notes where action = 'REGISTER';`
   → uma linha por instância com `notes`.
3. **Aplicar a migration de novo, inteira.**
4. Repetir a contagem. **Esperado: o mesmo número.**

**Reprova se:** a segunda aplicação duplicar qualquer linha.

### NOTE-B — Controle positivo: apagar a instância NÃO apaga a observação

1. Inserir uma observação para uma instância de teste.
2. `delete from whatsapp_instances where id = '<id de teste>';`
3. **Esperado:** o DELETE conclui; a linha em `whatsapp_instance_notes`
   continua existindo, com `instance_id` nulo e `instance_ref` intacto.

**Reprova se:** o DELETE abortar com `check_violation` — foi exatamente esse o
defeito que a 089 pagou, e este caso é o controle que prova que ele não voltou.

### NOTE-C — Append-only

1. `update whatsapp_instance_notes set note = 'outro texto' where id = '<id>';`
   **Esperado:** exceção `check_violation`, "observacao e registro append-only".
2. `update whatsapp_instance_notes set action = 'UPDATE' where id = '<id>';`
   **Esperado:** a mesma exceção.
3. `update whatsapp_instance_notes set instance_ref = gen_random_uuid() where id = '<id>';`
   **Esperado:** a mesma exceção.

**As quatro transições de `instance_id`** — a coluna é o único campo que a
guarda append-only deixa mudar, e só numa direção. A 096 foi deliberadamente
escrita mais estrita que a trigger irmã da 089
(`whatsapp_alert_subject_guard`), que usa `<>` puro e por isso deixa passar
`NULL → uuid`; ver o comentário na própria migration
(`supabase/migrations/20260803120000_096_whatsapp_instance_notes.sql`, bloco
"DIVERGÊNCIA DELIBERADA"). Os quatro casos abaixo são o que prova essa
diferença contra banco real — hoje só verificada estaticamente por
`src/lib/whatsapp-instance-notes-core.test.ts` (que lê o texto SQL e simula a
fórmula em JS, não executa a trigger).

4. `update whatsapp_instance_notes set instance_id = instance_id where id = '<id>';`
   (ou qualquer `UPDATE` que mantenha o mesmo valor, nulo ou não)
   **Esperado:** conclui sem exceção — `old.instance_id is distinct from
   new.instance_id` é `false` quando os dois lados são iguais, então a
   cláusula de guarda nem entra no `if`.
5. `update whatsapp_instance_notes set instance_id = null where id = '<id com
   instance_id preenchido>';`
   **Esperado:** conclui sem exceção. É a transição que a FK `on delete set
   null` produz sozinha quando a instância é apagada (caso NOTE-B); este caso
   simula o mesmo `UPDATE` direto, porque a trigger não distingue quem gerou a
   mudança.
6. `update whatsapp_instance_notes set instance_id = '<uuid de OUTRA instância
   viva, mesma organização>' where id = '<id>';`
   **Esperado:** exceção `check_violation`, "instance_id so pode ser nulado
   pela FK, nunca reapontado" — transferiria a observação de uma instância
   para outra sem rastro.
7. `update whatsapp_instance_notes set instance_id = '<uuid de instância viva>'
   where id = '<id com instance_id já nulo>';`
   **Esperado:** a mesma exceção do caso 6 — reatar uma observação já órfã a
   uma instância viva (`NULL → uuid`) inventaria um vínculo que nunca existiu.
   É exatamente a transição que a 089 permite e a 096 recusa de propósito.

**Reprova se:** qualquer um dos sete casos produzir o resultado oposto do
esperado — em particular, se os casos 6 ou 7 (`uuid → outro uuid`, `NULL →
uuid`) forem aceitos (regressão para a permissividade da 089), ou se os casos
4 ou 5 (inalterado, `uuid → NULL`) forem recusados (regressão que reintroduz o
defeito original que a 089 pagou e que este ledger existe para não repetir).

### NOTE-D — Rigor de INSERT

1. `insert ... (instance_ref, instance_id, ...) values (gen_random_uuid(), null, ...)`
   **Esperado:** exceção, "observacao nasce apontando instancia viva".
2. `insert` com `instance_ref` diferente de `instance_id`
   **Esperado:** a mesma exceção.
3. `insert` com `organization_id` de OUTRA organização que não a da instância
   **Esperado:** exceção da trigger de tenant, "instance_id pertence a outra organizacao".
4. `insert` com `note = '   '`
   **Esperado:** violação do CHECK `btrim(note) <> ''`.

### NOTE-E — RLS

Pelo **client SDK**, nunca pelo SQL Editor (que bypassa RLS):

1. Como usuário `authenticated` **sem** linha em `platform_admins`:
   `select` em `whatsapp_instance_notes` → **zero linhas**.
2. Como usuário membro (`unit_members`) da organização dona da instância:
   **zero linhas**. É a diferença que justifica não ter usado `audit_log`.
3. Como `platform_admin`: as linhas aparecem.
4. Como `anon`: **erro ou zero linhas**, nunca dados.
