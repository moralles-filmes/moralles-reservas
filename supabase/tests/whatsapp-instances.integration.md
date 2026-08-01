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

São **dois bloqueios independentes**. Consertar as URLs não destrava o replay.

## Desbloqueio

A frente `BASELINE_REPRODUCIBLE_DATABASE_ENVIRONMENT`, cujo **primeiro item é
destravar o replay** — pré-requisito dos demais, porque sem ele não existe banco
descartável onde testar nada. Nada deste arquivo é reescrito quando isso
acontecer: os casos já estão especificados.

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
