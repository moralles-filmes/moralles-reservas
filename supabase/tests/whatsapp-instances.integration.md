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

## Por que integração e não unitário

O hotfix do Risco 7 provou o ponto: a classificação estava **certa** e a retenção
não persistia porque o `UPDATE` violava um `CHECK`. **Nenhum mock teria pego.**
Onze dos quinze casos acima são dessa família — a regra vive no banco, e só o
banco pode reprová-la.

**O caso 4 está aqui e não no núcleo puro de propósito:** concorrência é fato de
banco, não aritmética de calendário. Simulá-la com mock provaria apenas que o mock
foi escrito de acordo com o mock.
