# Reconciliação dos três surveys legados da Ren Sushi

**Estado: executada uma vez em produção, após autorização específica.** O arquivo operacional está em `.superpowers/sdd/2026-10-19-whatsapp-template-v2/ren-sushi-legacy-receipts-reconcile.sql` (ignorado pelo Git), SHA-256 `78CFE7B4EDD29F5B195BAA3C72948F9CBBD613A4E5C1C24FE05177283296EF47`. Este registro não autoriza repetição, SQL adicional, deploy ou envio.

## Evidência de origem

O pré-voo de produção, feito apenas por leitura pelo responsável da operação, encontrou três `notifications_sent` `survey_d1` com `status=failed`, ID de mensagem do provider, canal Datafy da Ren Sushi e horário de falha entre 17:00:18 e 17:00:26 UTC de 19/10/2026. Os IDs técnicos das notificações são `a15d01af-3ab5-41c0-8eb9-7265b721845c`, `71bc3ab5-391e-4c2f-bb31-70eaf3dfdd3c` e `6f98551b-6544-4052-8164-d0495dfbe048`.

Para cada notificação foi encontrado exatamente um `webhook_executions` `status_callback` do mesmo `unit_id` e `channel_id`, `error IS NULL`, criado a até dois minutos da falha. O mesmo índice de `meta.ids[]` e `meta.statuses[]` contém o ID de mensagem e `failed`. A Edge Function de webhook registra essa execução após validar a origem Datafy. As tabelas de origem estão com `FORCE RLS`; não há policy de escrita para sessão autenticada em `webhook_executions` nem `notifications_sent`. A prova não depende de `failed_at` isoladamente.

O guard SQL atual só considera um `failed` com ID como entrega terminal quando há `whatsapp_automation_receipt_events` com tupla completa de unidade, provider, canal, ID e `status=failed`. Esses três callbacks antigos precedem o armazenamento de receipts e mantêm a adoção gerenciada bloqueada até a reconciliação. O significado do receipt é **POST aceito, entrega posteriormente falhou**; ele nunca declara que nenhum POST ocorreu e não libera reenvio do mesmo fato.

## Escrita proposta e limites

Uma transação, executável somente pelo papel SQL Editor `postgres` sem JWT forjado, verifica os três alvos e toda a evidência novamente. Ela trava o mutex da unidade e dos fatos, depois lê e trava conta, binding, canal e flag de despacho. Exige conta/canal/revisão/generation esperados, `whatsapp_automation_dispatch=false`, nenhuma adoção, nenhum job/marcador do mesmo fato e exatamente três callbacks distintos com o par ID/status no mesmo índice. Divergência, leitura incompleta, receipt prévio ou execução parcial gera erro e rollback.

Em sucesso, insere exatamente três receipts `failed`, com `provider_timestamp=NULL`, `received_at` igual ao `created_at` da execução e digest da mesma tupla canônica da RPC `record_whatsapp_automation_receipts`. Insere três linhas de `audit_log` com apenas IDs técnicos de notificação e execução, sem corpo, telefone, nome ou ID de mensagem do provider. Confere que `whatsapp_cutover_has_active_legacy_uncertainty` retorna falso. Não altera `notifications_sent`, jobs, canal, binding, flags ou adoção; não chama Datafy ou Meta e não envia WhatsApp. Uma segunda execução aborta conservadoramente, sem duplicar.

## Teste local isolado

Em `margin-cutover-dedup-sql-pg-r1` (PostgreSQL 17, `--network none`, sem portas publicadas), fixture sintética:

| Caso | Resultado |
|---|---|
| Segundo callback com `statuses[1]=delivered` apesar do ID correspondente | Erro `reconciliation_callback_evidence_not_exact`; zero receipts, zero auditorias |
| Três callbacks `failed` no mesmo índice do respectivo ID | `COMMIT`; três receipts, três auditorias; incerteza ativa = falso |
| Repetição após sucesso | Erro `reconciliation_already_present_or_partial`; sem novos registros |

A fixture local cria `webhook_executions` sintética porque o bootstrap compacto do harness 76 não inclui essa tabela histórica. Não replica identidade nem dados pessoais de produção; IDs de mensagem são fictícios. Este teste prova sintaxe, checks, cardinalidade, rollback e pós-condição no esquema local, sem substituir a reconfirmação de produção imediatamente antes de uma eventual execução autorizada.

## Gate antes de operar

Revisão independente de spec e qualidade deste SQL; autorização explícita da escrita de produção para os três IDs e projeto Moralles Reservas; novo pré-voo de leitura de canal, binding, flag, origem e contagens; execução única do arquivo exato; conferência pós-escrita sem conteúdo pessoal. Se qualquer precondição mudar, abortar e reprojetar.

## Execução comprovada

Implementer `template_v2_task3_map`; spec ROOT PASS após fixar os locks/CAS de conta→binding→canal; qualidade independente `template_v2_integration_quality` PASS, sem P0/P1/P2. O hash final acima corresponde ao produto testado e revisado.

O responsável respondeu **“Autorizo os 3 recibos e 3 auditorias”** após conhecer o alvo Moralles Reservas/Ren Sushi Datafy `d35128bb…`, assinatura existente R$49,90/mês e ausência de nova chamada/cobrança Datafy/Meta. Pré-leitura de 19h23m09s UTC: papel postgres, sem impersonation, três notifications failed, zero receipts, zero adoção/bindings enabled, dispatch false e incerteza true.

Uma execução do arquivo completo retornou sem erro. Pós-leitura de **19h23m47.955429s UTC** confirmou três receipts failed, três auditorias, três notifications ainda failed, incerteza ativa false, zero adoções/bindings enabled e dispatch false. Nenhuma repetição foi feita em produção. A liberação operacional posterior está na [evidência de publicação](2026-10-19-whatsapp-cutover-dedup-production-evidence.md).
