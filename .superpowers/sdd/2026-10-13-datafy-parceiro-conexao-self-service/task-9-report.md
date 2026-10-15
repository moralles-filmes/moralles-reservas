# Task 9 — alerta operacional externo

Implementação na branch `feat/datafy-parceiro-self-service`, base informada `126130f6c8d0812603fbd5537f1b7ef0dbfb201c`. Sem push, merge, deploy, migration remota ou chamada de provider. Plano não marcado pelo implementador.

## Implementação

- `ops-alert-sender.ts`: extração do transporte de templates, preservando HTTPS sem userinfo/hash, POST JSON, redirect error, timeout 5s e resultados delivered/unconfigured/delivery_failed. Templates reexportam o nome anterior.
- `ops-alert-core.ts`: dead novo, backlog stalled e throttle 30 min por unidade/tipo. Payload fechado em event/unit_id/channel_id/count?/oldest_age_seconds?/generated_at. Datas ilegíveis/futuras não inventam idade/supressão vencida.
- `ops-alert-runtime.ts`: observação, envio sequencial e ledger apenas depois de delivered true; persistência falha preserva delivered true + ledger_failed. Falha operacional não altera fato de assinatura nem dispara retry Datafy.
- `process-whatsapp-channel-health/index.ts`: observa alertas após conexão e inclui resultados na resposta e logs; observa todas as unidades com fila, independentemente do lote de canais ativos.
- `manage-channels/index.ts`: callback emitEvent Datafy ligado ao runtime, sem repassar reason ou qualquer dado remoto ao payload externo.
- `whatsapp-inbound-backlog.ts`: reexport do limite já existente no backend; não houve cópia ou movimento desnecessário da constante.
- Migration `20261015171115_whatsapp_ops_alert_observation.sql`: RPC SECURITY INVOKER service-role-only com relógio SQL, agregados de fila por unidade, lastSent e watermark no mesmo snapshot. Preserva tabela/constraint existente. Assinatura em categoria service-only própria no catálogo ACL.
- `AGENTS.md` e `CLAUDE.md`: invariantes e alcance transitivo sincronizados. Sender → process-whatsapp-templates/process-whatsapp-channel-health/manage-channels; runtime/core → os dois últimos. queue-core agora também alcança health worker e manage-channels.
- Pré-voo 64/64a e README: fixture mínima reexecutável PostgreSQL descartável.

## TDD e gates

1. RED: `vitest run src/lib/ops-alert-core.test.ts --maxWorkers=1 --minWorkers=1` falhou por núcleo/sender ainda inexistentes.
2. GREEN inicial: 8 testes de núcleo/transporte/runtime passaram.
3. RED adicional: transporte do ledger lançando exceção após HTTP aceito devolvia observation_failed e perdia delivered true; teste falhou (`expected undefined to deeply equal ... ledger_failed`).
4. GREEN: 10 testes novos passaram após capturar erro de persistência na fronteira correta.
5. `vitest run scripts/function-acl-allowlist.test.ts src/lib/ops-alert-core.test.ts src/lib/whatsapp-template-worker.test.ts --maxWorkers=1 --minWorkers=1`: 3 arquivos, 93 testes passaram. A primeira classificação colocou a RPC no array histórico da Task7, causando 2 falhas estáticas; corrigido com categoria própria, sem relaxar testes.
6. `tsc -b --noEmit`: passou. `eslint` nos oito arquivos TypeScript alterados: passou. Deno indisponível; não se afirma deno check. Entrypoints têm teste estático de wiring e runtime compartilhado é importado de verdade pelo Vitest.
7. Suíte completa final: `vitest run --maxWorkers=1 --minWorkers=1` passou, exit 0, 112 arquivos / 3238 testes, duração 462.38s. Log local: `task-9-suite-final.log`. Primeira execução foi interrompida depois de detectar as duas falhas ACL anteriores; execução final começou após correção.
8. `git diff --check` e `git diff --cached --check`: passaram. Revisei 100% do staged; scan de todas as linhas adicionadas com sk-/sk-ant-/xai-/re_/AIza/eyJ/Bearer/Basic/service_role e referências a tokens/senhas/URLs encontrou somente tipos/imports, nomes de roles/vars, documentação e endpoints sintéticos `.example`; nenhuma credencial real. Stage exigiu escalation porque .git é read-only no sandbox.

## Pré-voo local

CLI cached v2.120.0 criou a migration com `supabase.exe migration new whatsapp_ops_alert_observation`. npx não alcançou registry; execução cached precisou escalation por telemetria fora do workspace. initdb no sandbox falhou por recursos/rename; cluster próprio inicializado com escalation em `.superpowers/sdd/2026-10-13-datafy-parceiro-conexao-self-service/pg-task9`, escutando somente `127.0.0.1:55464`, sem pg_net/pg_cron. Encerrado com pg_ctl stop após sucesso.

Comando reproduzível, em cluster descartável vazio:

```powershell
& 'C:/Program Files/PostgreSQL/18/bin/psql.exe' -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55464 -U postgres -d postgres -f supabase/tests/local-preflight/64a-whatsapp-ops-bootstrap.sql -f supabase/migrations/20261015171115_whatsapp_ops_alert_observation.sql -f supabase/migrations/20261015171115_whatsapp_ops_alert_observation.sql -f supabase/tests/local-preflight/64-whatsapp-ops-alerts.sql
```

Resultado: exit 0, migration aplicada/reaplicada, NOTICE `OPS64: coverage, tenant filter, aggregate bounds, strict watermark, SQL clock, ACL passed`, ROLLBACK. Prova agregados/ACL efetiva/idempotência com schema mínimo; não prova RLS/PostgREST/Supabase completo ou entrega real HTTP.

## Limites e rollout

- Aplicar migration por `supabase db push` antes de deploy manage-channels/process-whatsapp-channel-health; extração do sender requer redeploy process-whatsapp-templates também. Configurar `WHATSAPP_OPS_ALERT_URL` HTTPS em Edge secrets. Controller deve carregar esses itens para Task14/checkpoint.
- HTTP aceito e ledger não são transação distribuída. Falha local depois do aceite ou invocações concorrentes podem duplicar alerta; falha de endpoint não consome watermark.
- Watermark é max(updated_at) observado, não relógio local pós-envio. Novos dead com timestamp maior durante o HTTP ficam pendentes. Contrato de timestamp estrito não demonstra captura de transação longa que grava timestamp antigo mas só comita depois do snapshot; eliminar essa classe exige protocolo de ACK por evento ou coordenação com writer, além da observação agregada desta tarefa.
- Observação cobre todas unidades, sem cap de canais; custo da consulta/envios cresce com unidades incidentadas. Não há promessa exactly-once nem teste real de provider externo.
- Suíte completa emite somente os avisos baseline de future flags do React Router (`v7_startTransition`/`v7_relativeSplatPath`); eles vêm de testes existentes de UI. Os 10 testes novos de ops alert passaram sem avisos próprios.

## Arquivos

AGENTS.md; CLAUDE.md; scripts/function-acl-allowlist.json; src/lib/ops-alert-core.test.ts; src/lib/whatsapp-inbound-backlog.ts; supabase/functions/_shared/ops-alert-core.ts; ops-alert-runtime.ts; ops-alert-sender.ts; whatsapp-template-worker.ts; supabase/functions/manage-channels/index.ts; supabase/functions/process-whatsapp-channel-health/index.ts; migration de observação; supabase/tests/local-preflight/64-whatsapp-ops-alerts.sql; 64a-whatsapp-ops-bootstrap.sql; README.md; este relatório.
