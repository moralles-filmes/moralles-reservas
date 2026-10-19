# Runbook — templates das automações WhatsApp existentes

Referências: [spec aprovada](superpowers/specs/2026-10-03-whatsapp-templates-programados-design.md), [auditoria de contratos](superpowers/specs/2026-10-03-whatsapp-templates-programados-auditoria.md), [plano](superpowers/plans/2026-10-03-whatsapp-templates-programados.md) e [verificação local](../supabase/tests/whatsapp-scheduled-templates.integration.md). Este documento registra contratos e preparação de rollout; não autoriza nem executa ações externas.

### Escopo da entrega e limites de liberação

As automações existentes podem usar nove templates fixos por conta WhatsApp: confirmação, confirmação com desconto, lembrete do dia, pesquisa da reserva, entrada na fila, pesquisa pós-fila, voucher já emitido de aniversário/frequência, mesa pronta (`fila_mesa_pronta_v1`, kind `waitlist_table_ready`, TTL 30 min) e reserva cancelada (`res_cancelada_v1`, kind `cancellation`, TTL 24 h, descartada depois do horário da reserva). Nas conexões não oficiais, as personalizações existentes continuam disponíveis. Mensagem avulsa, IA, handoff e voucher após avaliação continuam nos caminhos conversacionais existentes.

O ledger, o catálogo e o SQL aceitam os dois kinds novos. A [Fase 3 da migração de loja em produção](superpowers/plans/2026-10-16-datafy-migracao-loja-em-producao.md) acrescenta os produtores autenticados de cancelamento e mesa pronta, o reenvio pelo job existente e a janela de atendimento de 24 horas para mensagem manual no canal Meta. Banco, bundles e frontend foram publicados na Fase 5; a liberação operacional de catálogo, despacho e unidade continua separada. Unidade não adotada conserva os caminhos legados, e o produtor genérico continua recusando novos fatos desses dois kinds.

O catálogo em `_shared/whatsapp-template-catalog-core.ts` é a autoridade de corpo, rodapé, ordem dos parâmetros e hash. Idioma `pt_BR`, `POSITIONAL`, versão 1, links no BODY, sem botões nem interceptação nova de SAIR. Categoria solicitada e categoria efetiva são distintas:

| Nome lógico | Categoria solicitada | Fato produtor |
| --- | --- | --- |
| `res_confirmacao_v1` | UTILITY | `reservation_confirmed` |
| `res_confirmacao_desconto_v1` | UTILITY | `reservation_confirmed` com desconto aplicado |
| `res_lembrete_dia_v1` | UTILITY | `reservation_reminder` |
| `res_pesquisa_reserva_v1` | UTILITY | `reservation_survey` |
| `fila_entrada_v1` | UTILITY | `waitlist_entered` |
| `fila_feedback_v1` | MARKETING | `waitlist_feedback` |
| `mkt_voucher_programado_v1` | MARKETING | `voucher_birthday` ou `voucher_frequency` |
| `fila_mesa_pronta_v1` | UTILITY | `waitlist_table_ready` |
| `res_cancelada_v1` | UTILITY | `cancellation` |

Datafy declara `templateManagement` e `templateMessages` no registry. Isso descreve o adapter implementado, não uma homologação de conta. Meta direta continua sem essas capabilities até comprovar contrato, grants e comportamento da conta; não ligar por analogia nem transformar conexão oficial em TEXT como fallback.

Banco, bundles e frontend desta entrega foram publicados com as flags de catálogo e despacho OFF. Submissão de modelos, WABA/número de homologação, piloto com mensagem real e expansão requerem autorizações específicas e separadas. Qualquer migration/deploy adicional também exige seus gates e autorização próprios. Não usar a base de clientes como teste. Não criar campanha, novo produtor promocional, replay retroativo ou backfill de mensagens.

### Piloto dos nove modelos da Ren Sushi

Após autorização específica, a flag global `whatsapp_template_catalog` foi ligada em Moralles Reservas; `whatsapp_automation_dispatch` permaneceu OFF. A [migration de autoridade do piloto](../supabase/migrations/20261017200000_whatsapp_template_approved_submission_pilot.sql), os três bundles consumidores e o frontend foram publicados após os gates. A Ren Sushi tem conta e binding WABA verificados, um grant manual para o catálogo e nove jobs de provisionamento aceitos uma vez cada pelo provider. O GET remoto das 15h25 BRT reconciliou os nove IDs e hashes: sete `PENDING`, `fila_entrada_v1` e `fila_mesa_pronta_v1` `REJECTED` com `rejection_code=INCORRECT_CATEGORY`; o sync das 15h35 BRT passou os dois para `IN_APPEAL`, mantendo os outros sete `PENDING`. A Meta exibiu para `fila_entrada_v1` apenas a mensagem genérica de não conformidade com uma ou mais políticas; o código remoto aponta a classificação, sem indicar qual categoria aceitaria. Nenhum modelo estava aprovado nessa leitura. Não inferir aprovação ou envio a cliente do aceite do provider.

A migration do piloto prende os nove IDs `pt_BR` a hashes de conteúdo e do JSON completo de `buildTemplateSubmission`, inclusive `examples`. O admin da plataforma libera apenas `scope=catalog` para o canal e geração/revisão correntes. O worker precisa de `prepare`/`confirm`/`check` de quatro argumentos com o hash completo imediatamente antes do POST; bundles antigos de três argumentos falham fechados. Se o resultado remoto for incerto, usar GET/listagem e ledger antes de qualquer nova tentativa. Para modelo recusado, conferir `rejection_code` e pedir análise oficial com exemplo fictício antes de propor alteração; não editar nem reenviar o mesmo conteúdo por inferência. O grafo de imports exige redeploy conjunto de `manage-channels`, `process-whatsapp-templates` e `send-scheduled-whatsapp`, com autorização própria para o segundo. Esta migration ainda não implementa a política automática de futuras lojas; ela requer etapa separada e ativação global explícita.

### Preparação automática de conexões futuras — código local

A [spec](superpowers/specs/2026-10-17-datafy-template-auto-provision-on-connect-design.md) e o [plano](superpowers/plans/2026-10-17-datafy-template-auto-provision-on-connect.md) acrescentam uma política administrativa **OFF por default**. Somente um onboarding Datafy criado depois de a política estar ON recebe inscrição automática; Ren Sushi e outros canais existentes não entram por backfill. A preparação persiste estado e motivo, descobre a conta por GET validado contra o número do canal, cerca grant e confirmação de POST por digest, geração/revisão e uso único, e permite exclusão manual. O heartbeat do canal pronto valida a identidade no `/me` e grava saúde por RPC com revisão e número conferidos sob lock, sem refazer grant ou submissão. O worker alterna prioridade entre jobs existentes e recuperação a cada ciclo de cinco minutos.

Esta política e a migration `20261017203000` estão **somente no checkout local**. Para publicar: autorização própria de `db push` após dry-run/backup/janela e gate ACL; depois autorização dos quatro bundles `manage-channels`, `manage-whatsapp-templates`, `process-whatsapp-templates`, `send-scheduled-whatsapp`; depois frontend `READY` e conferência de alcance antes de ligar a política. O redeploy de `process-whatsapp-templates` exige confirmação separada por poder chegar à Meta. `whatsapp_automation_dispatch` continua OFF: conectar e submeter modelos não autoriza mensagens a clientes. `PENDING` e `IN_APPEAL` não tornam um modelo utilizável.


### Banco antes dos bundles e do frontend

O histórico completo não reconstrói um Supabase vazio com segurança: há predecessores com wrappers antigos e alterações de retorno incompatíveis. Não usar `db reset` ou reaplicar todo o histórico como receita de implantação. Conferir o estado e as migrations pendentes do alvo autorizado; os predecessores de tenancy, canal, Vault, flags, outbox, notificações, conversas, vouchers e helpers privados precisam existir.

Aplicar somente por `supabase db push`, após identificar o alvo e revisar a lista exata de pendências. Não colar SQL no Studio. A tabela abaixo é a ordem dos arquivos desta feature, não uma lista para execução manual isolada:

| Ordem | Migration | Dependência ou efeito relevante |
| --- | --- | --- |
| 1 | `20261003225857_whatsapp_template_catalog.sql` | Contas WABA, bindings, adoção da unidade, catálogo remoto, jobs, eventos, consentimento, tokens, slots, recibos, guards de escopo e escrita legada. WABA única entre organizações. |
| 2 | `20261004002728_whatsapp_automation_claims.sql` | Enqueue/claim/fence, preparação/finalização, sincronização e evidência imutável sobre as tabelas anteriores. |
| 3 | `20261004014032_whatsapp_message_preferences.sql` | Capability pública via serviço, opt-out, anonimização, rate limit, slot promocional e guards refinados. |
| 4 | `20261004025039_whatsapp_template_workers.sql` | Revisão de credencial, binding verificado, provisionamento/sync, health/purga, flags OFF e cron de catálogo. |
| 5 | `20261004165825_whatsapp_template_event_authority.sql` | Autoridade de eventos de gestão cercada pelo binding/capture atual. |
| 6 | `20261004184738_whatsapp_automation_dispatch_prerequisites.sql` | Preconfiguration/bound, pins, bloqueios prévios, preparo e confirmação de POST. |
| 7 | `20261005145913_whatsapp_automation_acceptance_repair.sql` | Reparo local de aceite sem repetir POST. |
| 8 | `20261005170415_whatsapp_automation_resource_post_confirm.sql` | Revalidação final de recursos e conteúdo esperado pelo núcleo de sete argumentos. |
| 9 | `20261006003631_whatsapp_outbox_automation_delegation.sql` | Outbox delega ao ledger, observa resultado e não mantém segunda escada de envio. |
| 10 | `20261009003452_whatsapp_scheduled_voucher_issuer.sql` | Emissão concorrente/idempotente de voucher programado antes do despacho. |
| 11 | `20261009135808_whatsapp_automation_worker_cron.sql` | Recibos correlacionados, reconciliação, seleção/manutenção, projeção Entregas, retenção e cron consumidor. |
| 12 | `20261009153435_whatsapp_template_management.sql` | RPCs autenticadas de consentimento, grants, custo, frequência, sync e revalidação com ator derivado de JWT. |
| 13 | `20261009180617_whatsapp_template_binding_business_refusal.sql` | Recusa `template_binding_changed` em `bind_whatsapp_template_account` usa PT409; o caller deve reconciliar em outra transação, sem retry serializável cego. Aplicação/reaplicação e HTTP409 foram verificados localmente na Task15. |
| 14 | `20261009220823_whatsapp_automation_pending_receipt_retention.sql` | Substitui somente o purger: preserva recibos pending com tupla completa de job existente na seleção e no DELETE final; recibos processados ou unmatched continuam elegíveis após 90 dias. Sem mudança de EF/TypeScript. |
| 15 | `20261017120000_whatsapp_templates_table_ready_cancellation.sql` | Catálogo de 9 ids e 8 kinds. Alarga os CHECKs de `logical_id`, `kind`, kind↔recurso e pin tuple, e reescreve por `create or replace` (ACL preservada) as funções com listas fixas ou `CASE` kind→template. Vai **antes** de qualquer EF com o catálogo novo: semear um id novo contra o CHECK velho falha a conta inteira. O frontend aceita catálogo-subconjunto, então a ordem é SQL → frontend → EFs. O teste gêmeo `src/lib/whatsapp-template-catalog-migration-twin.test.ts` reprova divergência entre TS e SQL. **Efeito externo:** o redeploy de `process-whatsapp-templates` com o catálogo de 9 semeia `fila_mesa_pronta_v1` e `res_cancelada_v1` em **toda** conta com o catálogo liberado (inclusive o piloto Moralles) e os submete à Meta/Datafy sem passo humano, antes de existir produtor. Esse redeploy exige autorização explícita do responsável. Para segurar a submissão numa conta, pause o escopo `catalog` dela antes. |
| 16 | `20261017130000_reservation_cancellation_fact.sql` | Fato `cancelled_at` carimbado pelo servidor na transição para cancelada, sem backfill; retorno ao estado ativo invalida o fato. Pré-voo 67. |
| 17 | `20261017140000_waitlist_table_ready_server_fact.sql` | Fato `notified_at` e marcador `notified_server_at` carimbados na transição da fila; `post_core` exige ambos iguais ao fato do job. Pré-voo 67b. |
| 18 | `20261017150000_whatsapp_automation_failed_notification_adoption.sql` | Reconciliação adota somente notificação legada `failed` de reserva/fila sem evidência de aceite, sob chave natural e job pinado; vouchers sem chave não entram na adoção. Pré-voo 67c. |
| 19 | `20261017160000_conversation_message_write_acl.sql` | Retira escrita direta de conversas para clientes e reabre só as cinco colunas de handoff, preservando a autoridade do histórico para a janela Meta. Pré-voo 67d com drift de grant por coluna. |
| 20 | `20261017170000_public_promotional_opt_in.sql` | RPC pública no nome, mas executável só por `service_role`: valida unidade/organização públicas, cliente vivo e reserva/fila própria; registra opt-in do formulário com referência idempotente. Pré-voo 68. |
| 21 | `20261017173000_public_waitlist_serial_rate_limit.sql` | Fecha entrada anônima direta por RPC/tabela, cria entrada pública com guardas transacionais executável só por `service_role` e limitador serializado por unidade/IP. Pré-voo 69. |

Os objetos finais são o resultado acumulado dessa ordem. Não implantar uma definição antiga de função por cima da mais recente. A migration 13 mantém a assinatura completa `bind_whatsapp_template_account(uuid,uuid,text,bigint,text,text)`, SECURITY DEFINER, search_path vazio e EXECUTE somente service_role. Ela não altera o `40001` herdado de outra função de token da instância; não generalizar a correção para todo conflito SQL. A migration 14 conserva assinatura, SECURITY DEFINER, search_path vazio e EXECUTE somente service_role de `purge_whatsapp_automation_workers(integer,integer)`.

O formulário público de reserva e o de fila só registram opt-in promocional quando o checkbox individual chega como boolean literal `true`. A evidência usa `reservation:<id>;form:v1` ou `waitlist:<id>;form:v1`; a RPC verifica recurso, cliente e unidade e reutiliza a revisão de uma referência já registrada. Isso impede que um retry da mesma inscrição reverta um opt-out posterior. A entrada pública na fila passa pela EF `public-waitlist`: a RPC exclusiva de serviço conserva a guarda pública transacional e a senha atômica; a chave de serviço cria/vincula o cadastro depois da entrada. `anon` deixa de poder chamar `enter_waitlist` ou inserir direto na tabela, pois esses acessos contornariam limite e cadastro; o painel mantém a RPC autenticada. A EF aceita somente o IP de `CF-Connecting-IP`, sem confiar no primeiro `X-Forwarded-For`, e fecha se o cabeçalho faltar. Conferir esse contrato no gateway hospedado antes do corte. `do_not_contact` e o link de descadastro continuam prevalecendo. O deploy exige banco primeiro, depois `create-reservation` e `public-waitlist`, e por fim o frontend; entre a migration e o frontend novo, a fila pública antiga ficará indisponível e requer janela coordenada. Nenhum desses passos autoriza submeter template ou enviar marketing.

**Falha parcial da fila:** a EF devolve a senha já criada com `registration_incomplete` ou `consent_not_recorded` e registra `public_waitlist_post_entry_failed` com `requestId`, estágio, `unitId`, `waitlistId` e booleano de opt-in, sem nome/telefone. Não pedir ao cliente que entre de novo: isso criaria outra senha. Com acesso administrativo autorizado, localizar a entrada por **id e unidade**, derivar a organização da unidade e conferir `customer_id`/telefone canônico. Se o estágio for cadastro/vínculo, resolver ou criar o cliente nessa organização e preencher `waitlist.customer_id` somente se ainda nulo, com predicado de id+unidade e confirmação de uma linha afetada; vínculo existente deve ser investigado, não sobrescrito. Se o log comprovar `marketingOptIn=true`, conferir `do_not_contact` e qualquer opt-out posterior antes de considerar a RPC idempotente com `waitlist:<id>;form:v1`; nunca reativar consentimento após opt-out. Sem log/evidência suficiente, pedir nova autorização ao cliente. Reparos no banco vivo exigem autorização e procedimento revisado; este runbook não autoriza SQL avulso no Studio.

**Falha parcial da reserva:** `create-reservation` conserva a reserva bem-sucedida e registra `public_reservation_promotional_opt_in_failed` com `requestId`, `unitId`, `reservationId` e motivo curto, sem dados pessoais. Localizar a reserva por esses ids, confirmar o cliente e a organização no banco e conferir se houve opt-out posterior antes de qualquer reparo autorizado da evidência `reservation:<id>;form:v1`. Não pedir nova reserva ao cliente nem assumir consentimento por causa da resposta de sucesso.

Migrations 4 e 11 inserem `whatsapp_template_catalog=false` e `whatsapp_automation_dispatch=false` com `ON CONFLICT DO NOTHING`. Isso preserva valor existente, inclusive true; o preflight precisa comprovar OFF no alvo, não inferir OFF pela presença do seed. `dispatch_enabled` nasce false, sem `adopted_at` nem autorização de catálogo.

Há dois novos **consumidores** agendados na feature:

| Job | Schedule UTC | Wrapper/EF |
| --- | --- | --- |
| `whatsapp-template-workers` | `*/5 * * * *` | `trigger_whatsapp_template_workers` → `process-whatsapp-templates` |
| `whatsapp-automation-worker` | `* * * * *` | `trigger_whatsapp_automation_worker` → `process-whatsapp-automations` |

Eles não criam campanha ou substituem os produtores atuais. Os wrappers leem `internal_api_key` e `project_url` do Vault; a chave também precisa corresponder ao Edge secret. Instalar cron é efeito da migration, mesmo com feature OFF. Rotação segue Edge primeiro, Vault depois; não imprimir ou guardar valores em relatório. O ACK assíncrono do `pg_net` não comprova sucesso da EF.

Após banco/ACL compatíveis, atualizar todos os bundles da matriz final; frontend vem depois. Os gateways de `process-whatsapp-templates`, `process-whatsapp-automations` e `send-scheduled-whatsapp` usam `verify_jwt=false`. Os workers e as ações enqueue/dispatch/dispatch_existing do dispatcher exigem autenticação interna; a ação resend do dispatcher exige `getUser` e recurso acessível pelo JWT do caller. `manage-whatsapp-templates` também usa false, mas autentica com `getUser` e encaminha o JWT original às RPCs; não substituir por service role. `whatsapp-message-preferences` é público com capability restrita e não concede acesso direto ao SQL interno.

### Matriz transitiva de bundles

Fonte: matriz AST congelada em `2e1a099f56256c749220d1d5118908605e044079` sobre base `596ea733d8dfe832f84548dbc1e04b3ed9524d2a`, branch `codex/whatsapp-templates-programados`. Leu 150 fontes TypeScript de Edge Functions em `supabase/functions/` e 49 entrypoints; zero imports relativos irresolvidos e zero erros de parse. Os 150 hashes são idênticos ao freeze Task15; esse inventário não cobre os TSX do frontend. Isso é evidência estática; check Deno e deploy são ações distintas.

O conjunto desta entrega exige **36 EFs**. O gate Deno usa as mesmas 36 entradas e os dois sentinelas compartilhados `authz.ts`/`ai-providers.ts`, total **38**; imports apenas de tipo não ampliam o deploy. Qualquer alteração posterior de fonte exige reconciliar hashes e regenerar o alcance.

```text
asaas-webhook
create-billing-checkout
create-manual-reservation
manage-billing
manage-channels
manage-organizations
manage-whatsapp-implementations
manage-whatsapp-templates
process-asaas-invoice-reconcile
process-asaas-reconcile
process-billing-notifications
process-billing-overdue
process-billing-reconcile
process-billing-reminders
process-billing-unblock
process-notification-outbox
process-reservation-reminders
process-satisfaction-surveys
process-trial-expiry
process-voucher-triggers
process-waitlist-entered
process-waitlist-feedback
process-whatsapp-automations
process-whatsapp-channel-health
process-whatsapp-enforcement
process-whatsapp-templates
resend-notification
send-cancellation
send-confirmation
send-manual-message
send-scheduled-whatsapp
send-whatsapp
update-reservation
webhook-whatsapp
whatsapp-health
whatsapp-message-preferences
```

A tabela reúne os 30 compartilhados alterados e os 16 predecessores inalterados que ganharam consumidores. Cada linha lista o alcance real por valor; mudar um predecessor posteriormente pode exigir EFs além das 36 desta entrega, como security.ts. As fontes e hashes completos ficam em `S/task-16-final-import-matrix.json` e `S/task-16-all-shared-consumers.json`, onde S é a pasta de evidências definida adiante.

| Módulos em `_shared/` | EFs consumidoras por valor, diretas ou transitivas |
| --- | --- |
| `security.ts` | `asaas-webhook`, `cleanup-orphan-assets`, `create-billing-checkout`, `create-checkout-session`, `create-manual-reservation`, `create-reservation`, `expire-pending-payments`, `manage-ai-providers`, `manage-billing`, `manage-channels`, `manage-organizations`, `manage-payment-methods`, `manage-platform-secrets`, `manage-stripe-accounts`, `manage-whatsapp-implementations`, `manage-whatsapp-instances`, `process-asaas-invoice-reconcile`, `process-asaas-reconcile`, `process-billing-notifications`, `process-billing-overdue`, `process-billing-reconcile`, `process-billing-reminders`, `process-billing-unblock`, `process-notification-outbox`, `process-reservation-reminders`, `process-satisfaction-surveys`, `process-trial-expiry`, `process-voucher-triggers`, `process-waitlist-entered`, `process-waitlist-feedback`, `process-whatsapp-automations`, `process-whatsapp-channel-health`, `process-whatsapp-enforcement`, `process-whatsapp-instance-cycles`, `process-whatsapp-templates`, `resend-notification`, `send-cancellation`, `send-confirmation`, `send-manual-message`, `send-scheduled-whatsapp`, `send-whatsapp`, `stripe-webhook`, `update-reservation`, `webhook-whatsapp`, `webhook-zapi`, `whatsapp-health` |
| `platform-flags.ts` | `asaas-webhook`, `create-billing-checkout`, `manage-billing`, `manage-channels`, `manage-whatsapp-implementations`, `process-asaas-invoice-reconcile`, `process-asaas-reconcile`, `process-billing-notifications`, `process-billing-overdue`, `process-billing-reconcile`, `process-billing-reminders`, `process-billing-unblock`, `process-notification-outbox`, `process-reservation-reminders`, `process-satisfaction-surveys`, `process-trial-expiry`, `process-voucher-triggers`, `process-waitlist-entered`, `process-waitlist-feedback`, `process-whatsapp-enforcement`, `process-whatsapp-templates`, `send-cancellation`, `send-confirmation`, `send-manual-message`, `send-scheduled-whatsapp`, `send-whatsapp`, `webhook-whatsapp` |
| `billing-delinquency-core.ts` | `asaas-webhook`, `manage-billing`, `manage-channels`, `manage-whatsapp-implementations`, `process-asaas-invoice-reconcile`, `process-asaas-reconcile`, `process-billing-overdue`, `process-billing-reminders`, `process-notification-outbox`, `process-reservation-reminders`, `process-satisfaction-surveys`, `process-trial-expiry`, `process-voucher-triggers`, `process-waitlist-entered`, `process-waitlist-feedback`, `process-whatsapp-enforcement`, `process-whatsapp-instance-cycles`, `process-whatsapp-templates`, `send-cancellation`, `send-confirmation`, `send-manual-message`, `send-scheduled-whatsapp`, `send-whatsapp`, `webhook-whatsapp` |
| `cors.ts` | `create-billing-checkout`, `create-manual-reservation`, `manage-ai-providers`, `manage-billing`, `manage-channels`, `manage-members`, `manage-organizations`, `manage-payment-methods`, `manage-platform-secrets`, `manage-stripe-accounts`, `manage-whatsapp-implementations`, `manage-whatsapp-instances`, `manage-whatsapp-templates`, `resend-notification`, `send-scheduled-whatsapp`, `whatsapp-health` |
| `phone.ts` | `create-manual-reservation`, `create-reservation`, `manage-channels`, `manage-organizations`, `manage-whatsapp-templates`, `process-whatsapp-channel-health`, `process-whatsapp-templates`, `send-cancellation`, `send-confirmation`, `send-manual-message`, `send-scheduled-whatsapp`, `send-whatsapp`, `webhook-whatsapp`, `whatsapp-health` |
| `authz.ts` | `create-manual-reservation`, `send-cancellation`, `send-manual-message`, `update-reservation` |
| `whatsapp-provider-core.ts` | `manage-channels`, `manage-organizations`, `manage-whatsapp-templates`, `process-whatsapp-channel-health`, `process-whatsapp-templates`, `send-cancellation`, `send-confirmation`, `send-manual-message`, `send-scheduled-whatsapp`, `send-whatsapp`, `webhook-whatsapp`, `whatsapp-health` |
| `datafy-client.ts`, `datafy-signature-core.ts`, `provider-error-redaction-core.ts`, `retry.ts`, `uazapi-client.ts`, `whatsapp-providers.ts`, `whatsapp-template-provider-core.ts` | `manage-channels`, `manage-organizations`, `process-whatsapp-channel-health`, `process-whatsapp-templates`, `send-cancellation`, `send-confirmation`, `send-manual-message`, `send-scheduled-whatsapp`, `send-whatsapp`, `webhook-whatsapp`, `whatsapp-health` |
| `whatsapp-subscription-resolver-core.ts` | `manage-channels`, `manage-whatsapp-implementations`, `manage-whatsapp-instances`, `process-billing-reminders`, `process-notification-outbox`, `process-reservation-reminders`, `process-satisfaction-surveys`, `process-voucher-triggers`, `process-waitlist-entered`, `process-waitlist-feedback`, `process-whatsapp-enforcement`, `process-whatsapp-instance-cycles`, `process-whatsapp-templates`, `send-cancellation`, `send-confirmation`, `send-manual-message`, `send-scheduled-whatsapp`, `send-whatsapp`, `webhook-whatsapp` |
| `billing-financial-state-core.ts` | `manage-channels`, `manage-whatsapp-implementations`, `process-asaas-invoice-reconcile`, `process-billing-reminders`, `process-notification-outbox`, `process-reservation-reminders`, `process-satisfaction-surveys`, `process-voucher-triggers`, `process-waitlist-entered`, `process-waitlist-feedback`, `process-whatsapp-enforcement`, `process-whatsapp-templates`, `send-cancellation`, `send-confirmation`, `send-manual-message`, `send-scheduled-whatsapp`, `send-whatsapp`, `webhook-whatsapp` |
| `whatsapp-service-gate.ts`, `whatsapp-service-state-core.ts` | `manage-channels`, `manage-whatsapp-implementations`, `process-billing-reminders`, `process-notification-outbox`, `process-reservation-reminders`, `process-satisfaction-surveys`, `process-voucher-triggers`, `process-waitlist-entered`, `process-waitlist-feedback`, `process-whatsapp-enforcement`, `process-whatsapp-templates`, `send-cancellation`, `send-confirmation`, `send-manual-message`, `send-scheduled-whatsapp`, `send-whatsapp`, `webhook-whatsapp` |
| `whatsapp-template-catalog-core.ts` | `manage-channels`, `manage-whatsapp-templates`, `process-notification-outbox`, `process-reservation-reminders`, `process-satisfaction-surveys`, `process-voucher-triggers`, `process-waitlist-entered`, `process-waitlist-feedback`, `process-whatsapp-templates`, `send-confirmation`, `send-scheduled-whatsapp` |
| `whatsapp-channel-credentials.ts` | `manage-channels`, `process-whatsapp-channel-health`, `send-cancellation`, `send-confirmation`, `send-manual-message`, `send-scheduled-whatsapp`, `send-whatsapp`, `webhook-whatsapp`, `whatsapp-health` |
| `whatsapp-template-account.ts`, `whatsapp-template-runtime.ts`, `whatsapp-template-state-core.ts`, `whatsapp-template-sync.ts`, `whatsapp-template-worker.ts` | `manage-channels`, `process-whatsapp-templates`, `send-scheduled-whatsapp` |
| `whatsapp-template-access-core.ts`, `whatsapp-template-management.ts` | `manage-whatsapp-templates` |
| `whatsapp-message-ttl-core.ts` | `manage-whatsapp-templates`, `process-notification-outbox`, `process-reservation-reminders`, `process-satisfaction-surveys`, `process-voucher-triggers`, `process-waitlist-entered`, `process-waitlist-feedback`, `resend-notification`, `send-confirmation`, `send-scheduled-whatsapp`, `send-whatsapp` |
| `whatsapp-automation-core.ts` | `manage-whatsapp-templates`, `process-notification-outbox`, `process-reservation-reminders`, `process-satisfaction-surveys`, `process-voucher-triggers`, `process-waitlist-entered`, `process-waitlist-feedback`, `send-confirmation`, `send-scheduled-whatsapp` |
| `whatsapp-automation-producer-routing.ts` | `process-notification-outbox`, `process-reservation-reminders`, `process-satisfaction-surveys`, `process-voucher-triggers`, `process-waitlist-entered`, `process-waitlist-feedback`, `send-confirmation` |
| `waitlist-defaults.ts` | `process-waitlist-entered`, `process-waitlist-feedback`, `resend-notification`, `send-scheduled-whatsapp` |
| `whatsapp-automation-worker-core.ts` | `process-whatsapp-automations` |
| `whatsapp-channel-freshness-core.ts`, `whatsapp-channel-service.ts`, `whatsapp-send.ts` | `send-cancellation`, `send-confirmation`, `send-manual-message`, `send-scheduled-whatsapp`, `send-whatsapp` |
| `conversation-log.ts` | `send-cancellation`, `send-confirmation`, `send-scheduled-whatsapp`, `send-whatsapp` |
| `whatsapp-automation-dispatch.ts`, `whatsapp-automation-resources.ts` | `send-scheduled-whatsapp` |
| `whatsapp-message-preferences-core.ts` | `send-scheduled-whatsapp`, `whatsapp-message-preferences` |
| `ai-providers.ts`, `whatsapp-automation-receipts-core.ts`, `whatsapp-automation-receipts.ts`, `whatsapp-meta-batch-core.ts`, `whatsapp-template-events-core.ts`, `whatsapp-template-events.ts` | `webhook-whatsapp` |
| `whatsapp-message-preferences-handler.ts` | `whatsapp-message-preferences` |

Imports exclusivamente de tipo acrescentam sete EFs ao alcance de fonte de `whatsapp-template-catalog-core.ts`: manage-organizations, process-whatsapp-channel-health, send-cancellation, send-manual-message, send-whatsapp, webhook-whatsapp e whatsapp-health. Para `whatsapp-template-provider-core.ts`, acrescentam manage-whatsapp-templates. Essas pernas entram na compilação pertinente, mas não são motivo isolado de redeploy runtime. A ponte npm/frontend de authz.ts não substitui o SDK Deno real.

**Delta local da Fase 3:** a matriz congelada acima descreve a entrega anterior; antes de qualquer deploy, reconciliar o grafo atual e as migrations 16–19. `node scripts/ef-import-graph.mjs` encontrou consumidores por valor dos compartilhados alterados:

| Fonte da Fase 3 | EFs a redeployar por essa fonte |
| --- | --- |
| `whatsapp-automation-producer-routing.ts` | `notify-waitlist-ready`, `process-notification-outbox`, `process-reservation-reminders`, `process-satisfaction-surveys`, `process-voucher-triggers`, `process-waitlist-entered`, `process-waitlist-feedback`, `send-cancellation`, `send-confirmation` |
| `whatsapp-automation-dispatch.ts`, `whatsapp-automation-resources.ts` | `send-scheduled-whatsapp` |
| `whatsapp-channel-service.ts` | `send-cancellation`, `send-confirmation`, `send-manual-message`, `send-scheduled-whatsapp`, `send-whatsapp` |
| `whatsapp-manual-service-window-core.ts` | `send-manual-message` |
| `authz.ts` (alcance atual, módulo não alterado) | `create-manual-reservation`, `notify-waitlist-ready`, `resend-notification`, `send-cancellation`, `send-manual-message`, `send-scheduled-whatsapp`, `update-reservation` |

As entradas alteradas diretamente incluem ainda `resend-notification` e a EF nova `notify-waitlist-ready`. `notify-waitlist-ready` usa `verify_jwt=false` no gateway, autentica JWT de membro na aplicação e usa a chave interna somente nas chamadas servidor-servidor. O acionamento da mesa pronta é manual no painel, mas o canal adotado usa job/template; reenvio reaproveita o job e seu TTL de 30 minutos. Um novo ciclo cancelar→reativar→cancelar conserva o job anterior e não cria segunda mensagem: `cancelled_at` divergente bloqueia POST pendente no preflight e no guard SQL final. No legado, `sent_at` ainda pode avançar após reenvio e renovar o prazo histórico. O envio legado precede a mudança condicional para `notified`: dois cliques concorrentes, ou aceite no provider seguido de falha nessa mudança, podem repetir a mensagem. A resposta `statusUpdated:false` identifica a falha parcial; não acione novo envio antes de conferir o recibo e o estado no provider. Esses são limites aceitos nesta fase para unidades não adotadas. A EF de mensagem manual prende o canal validado, confere a última mensagem recebida do cliente e revalida o prazo antes do outbound Meta sem retry automático. Um rollback de aplicação deve preservar fatos gravados e a ACL restritiva de `conversations`; correção de banco é forward-only.

O registry tem 12 consumidoras, incluindo manage-whatsapp-templates, que não importa a fachada HTTP. Providers/client Datafy têm 11, credenciais têm nove; não unir as três listas por analogia. Datafy também é importado diretamente por manage-channels na descoberta /me. A extração para whatsapp-channel-service.ts conserva os quatro envios antigos e acrescenta send-scheduled-whatsapp; este limpa caches na preparação programada. conversation-log.ts tem quatro consumidores exatos, incluindo o dispatcher. O alcance de flags chega a 27 EFs; isso não altera política comercial.

O procedimento de implantação futuro deve conter alvo autorizado concreto, SHA, lista reconciliada, ordem banco/ACL → bundles → frontend, janela, responsável e observação. Este runbook não executa deploy nem fornece receita com projeto fictício.

### Gestão autorizada e assertions

Todas as ações da API são POST em `manage-whatsapp-templates`, com corpo discriminado e chaves exatas. O frontend obtém revisão de credencial e geração do binding pelo snapshot atual. Uma assertion vencida devolve conflito; reler estado e avaliar a ação, sem remover a assertion para “fazer passar”.

| Ação | Campos além de action | Autoridade |
| --- | --- | --- |
| `snapshot` | `unit_id` | Membro da unidade ou platform_admin; operador só usa esta ação. |
| `sync` | `unit_id`, `channel_id`, `expected_binding_generation` | Owner/gerente da unidade ou admin; catálogo já autorizado. Retorna requested/requestId, não aprovação. |
| `consent_snapshot` | `unit_id`, `customer_id`, `purpose` | Owner/gerente ou admin. Unknown confirmado difere de falha de dependência. |
| `record_consent` | `unit_id`, `customer_id`, `purpose`, `decision`, `source_code`, `observed_at`, `evidence_reference` | Individual, owner/gerente ou admin; ator vem do JWT. |
| `release_channel` | `channel_id`, `scope`, `enabled`, `expected_credential_revision`, `expected_binding_generation` | Somente platform_admin real. scope é catalog ou dispatch. |
| `authorize_marketing_cost` | `channel_id`, `expected_binding_generation`, `category`, `valid_from`, `valid_until` | Somente admin; category é MARKETING, intervalo vigente explícito. |
| `configure_promotion_frequency` | `window_days` | Somente admin; inteiro 1..30, aplicado a capturas futuras. |
| `initialize_job` | `job_id`, `expected_channel_id`, `expected_binding_generation` | Somente admin, transição preconfiguration elegível. |
| `revalidate_job` | `target`, `job_id`, `expected_channel_id`, `expected_binding_generation` | target automation: owner/gerente/admin; target catalog: somente admin. |

`purpose` aceita operational/promotional; `decision` aceita opt_in/opt_out. Origem manual aceita apenas customer_message/signed_form/in_person, com data não futura e referência limitada, sem controles, conversa inteira ou link de capability. Não existe ação em massa para consentir clientes. Telefone, reserva, conversa recente e do_not_contact=false não constituem opt-in.

Recusa HTTP 403 representa falta de autoridade; 409 configuration_changed exige releitura; 409 not_eligible não é autorização para forçar o job; 503 dependency_unavailable é falha operacional. Nenhum desses erros autoriza envio por outra modalidade. Credencial, WABA bruta, evidência pessoal e tokens não integram o DTO client-safe.

### Sequência para um piloto futuro autorizado

1. Registrar autorizações separadas para alvo/migrations/deploy, WABA/número, submissão dos nove modelos, custos/categorias e o único envio controlado. Confirmar conta, organização, canal e identidade descoberta; WABA não pode pertencer a outra organização, inclusive entre Datafy e Meta direta.
2. Conferir banco/ACL, bundles, gateway, frontend e observabilidade com flags OFF. Confirmar que a mudança de flag não é confundida com disponibilidade: conexão, identidade, serviço, recursos, template e consentimento ainda são revalidados.
3. Após autorização de catálogo, preparar/verificar binding pelo fluxo de canal existente e discovery; não aceitar WABA fornecida livremente pelo cliente ou escrever binding via Studio. Habilitar apenas a flag de catálogo e o grant catalog do canal autorizado. A flag sozinha não concede autorização de submissão por canal; o grant sozinho não liga dispatch. Canal conectado ainda inativo pode preparar catálogo.
4. Solicitar sync autorizado; conferir por nome/idioma/hash/categoria efetiva o resultado real da análise na mesma conta. Modelo homônimo divergente vira conflito; não sobrescrever nem gerar sufixos para contornar recusa. Submissão timeout/uncertain é reconciliada por evidência remota, sem segundo POST cego.
5. Comprovar os eventos reais `message_template_status_update`, `message_template_quality_update`, `template_category_update` e `message_template_components_update`, assinatura sobre corpo original, replay, WABA correta e lote misto. Mensagens/recibos/eco continuam exigindo phone_number_id do canal. Lacuna na configuração de eventos Datafy impede afirmar paridade.
6. Confirmar aprovação e integridade atuais: recuperação periódica de 5 minutos e GET antes do POST se snapshot tiver mais de 60 segundos ou sync_required. PAUSED/DISABLED/REJECTED e divergência bloqueiam. Aprovação por evento antigo não libera envio por si só.
7. Conferir destinatário de homologação, propósito e autorização operacional. Para MARKETING, registrar opt-in individual legítimo e autorização administrativa vigente por conta/categoria/geração. Modelo solicitado como UTILITY que vire MARKETING permanece bloqueado nesta versão até revisão específica; autorização de custo/consentimento não contorna essa incompatibilidade. Não presumir gratuidade ou implementar débito/tarifa automaticamente.
8. Depois da autorização de envio, habilitar a flag dispatch e o grant dispatch apenas do canal selecionado e saudável, com assertions atuais. Primeiro enable grava adoção durável; não despachar backlog anterior. Executar somente o fato novo e o destinatário controlado autorizados.
9. Conferir um aceite, provider_message_id, notificação, append author=automation com event_id estável e callback correlacionado por unidade/provider/canal/message_id. Aceite não é entrega. Verificar Entregas e ausência de repetição no worker/outbox, além de controle de atendimento no mesmo canal.
10. Testar opt-out explicitamente no fluxo público: GET não muda escolha, POST confirmado recusa somente ofertas daquela unidade, repetição é idempotente e recusa posterior ao enqueue vence. Não mostrar PII nem guardar capability em logs, storage ou relatório. Verificar no hosting efetivo os headers no-store/no-referrer; o arquivo vercel.json sozinho não comprova entrega desses headers.
11. Observar fila, idade do pendente mais antigo, blocked/needs_review/uncertain, callback e qualidade do template. Expansão exige nova autorização por escopo; não transformar aprovação do primeiro piloto em permissão de envio à base.

A janela promocional padrão é um envio aceito ou uncertain por contato/unidade em sete dias. Unknown/erro de consentimento bloqueia, do_not_contact e cliente anonimizado são mais restritivos. O slot é reservado atomicamente; uncertain o conserva. Bloqueio de mensagem não apaga nem recria voucher programado já emitido. A emissão de aniversário/frequência mantém suas regras próprias de suspensão; after_rating conserva envio antes do commit.

### Observação e tratamento de estados

`get_whatsapp_automation_delivery_state` oferece projeção autenticada por unidade (membro/admin), contagens, oldest_nonterminal_at e paginação. Não abrir SELECT client-side nas tabelas internas. A RPC avalia obrigações de reconciliação e recibos pendentes além do nome do estado; não inferir conclusão só por accepted/reconciled. O snapshot de gestão mostra motivos sanitizados e grants, sem provar saúde atual do canal.

| Situação | Conduta |
| --- | --- |
| blocked / needs_review | Corrigir a causa e solicitar revalidação elegível com assertions atuais; não mudar fato, destinatário, TTL ou identidade para reaproveitar job. |
| queued / retry_wait | Aguardar worker e revalidações; não criar intenção duplicada nem segunda escada no outbox. |
| claimed / posting | Preservar fence/posse. Deadline impede próximo job, não abandona POST em voo. |
| uncertain | Preservar evidência e slot; reconciliar. Timeout após início do POST nunca prova recusa. Não pressionar reenvio. |
| accepted com persistência incompleta | Reparar notification/histórico local; não chamar provider novamente. |
| rejected / failed | Examinar motivo fechado. Só rejeição transitória explícita comprovadamente não aceita participa de retry autorizado. |
| expired | Descartar sem gerar notificação failed para um TTL vencido. Não ampliar validade para enviar fato velho. |
| delivered / read / failed por callback | Aplicar apenas correlação completa; callback adiantado aguarda reconciliação. Sem ID conhecido não inventar entrega. |

Retry permitido tem cinco tentativas totais, intervalos 1, 4, 16 e 64 minutos, sempre dentro de TTL e guardas atuais. Lote máximo 20; alocação de reparos/rechecks também entra no orçamento do worker, sem refill. Política local não é promessa de limite do provider nem garantia “exactly once”.

O worker de catálogo publica `WHATSAPP_TEMPLATE_PIPELINE_ALERT` e tenta `WHATSAPP_TEMPLATE_ALERT_URL`. Ausência do endpoint produz delivered=false/unconfigured; HTTP errado/timeout produz delivery_failed. A configuração e o recebimento de um alerta real precisam ser comprovados no piloto autorizado. O health mede failed, uncertain e idade do job não terminal mais antigo; quantidade zero de falhas não comprova pipeline andando. Não supor que o worker de automações tem o mesmo sender externo: observar sua resposta/logs e a projeção Entregas explicitamente.

Eventos sanitizados têm janela de 90 dias, com received_at finito, mas recibo `pending` fica preservado enquanto existir job com a mesma tupla `(unit_id,provider,channel_id,provider_message_id)`, independentemente do estado/idade desse job. Isso inclui accepted/reconcile_required por conflito com notification legacy e pending posterior de job já reconciled. Recibos processados ou sem job correspondente tornam-se elegíveis após 90 dias; não conservar unmatched indiscriminadamente. A exclusão de pending correlacionado vale antes do LIMIT da seleção e no DELETE final, por leituras sem lock de pai/job depois dos locks de recibos. A purga de jobs mantém seus critérios terminais e exclusões de pendência/reparo. Uma pendência correlacionada pode durar mais de 90 dias: tratar o bloqueio de reconciliação sem apagar evidência nem repetir POST. Não registrar chave, token de preferências, corpo do cliente, senha ou URL credenciada em evidência operacional.

### Pausa e rollback operacional

Usar `release_channel` com **scope=dispatch, enabled=false**, channel_id correto e revisões/geração do snapshot atual, sob JWT de platform_admin. Não confundir com scope=catalog: os grants são independentes. Repetir stop de binding já parado é idempotente; ausência de binding não o cria. Se a assertion envelheceu, obter estado novo e repetir a intenção de parar com a assertion correta.

O stop não depende de flag ON, saúde fresca, secret disponível ou igualdade atual de provider para uma redução exclusiva válida. Continua conferindo pais, tenant e história. Ele pausa a elegibilidade de novos POSTs; não recolhe mensagem já aceita pelo provider nem garante reescrita instantânea de todos os estados do ledger.

Manter `adopted_at`, `whatsapp_automation_adoptions`, jobs e evidências. A adoção durável da unidade sobrevive à troca/remoção do binding. Desligar a flag global não limpa essa história e não faz a unidade voltar ao legado. Intenção já registrada consulta o ledger mesmo com flags OFF. Para cessar novas submissões, parar também o grant catalog autorizado; isso tampouco apaga catálogo remoto.

Deixar claimed/posting concluir/classificar com seu fence; uncertain e aceite com falha local seguem para reconciliação sem outro POST. Não resetar posting_started_at/attempts, não apagar ledger, não trocar canal automaticamente, não usar texto oficial livre como fallback e não dropar tabelas/migrations. A reversão de bundle precisa ser compatível com o banco e a adoção vigente; versão antiga que ignora ledger não é rollback seguro.

### Evidências e gates de entrega local

O resumo abaixo exporta somente resultados sanitizados para este documento durável. S significa `.superpowers/sdd/2026-10-03-whatsapp-templates-programados/`; os nomes são locators para auditoria, não comandos ou autorização para ler a árvore. Não copiar S recursivamente: local-runtime, secrets, chaves, dumps, snapshots privados e valores de capability não são artefatos de entrega. Se a pasta for limpa, preservar antes apenas relatórios finais sanitizados revisados e manifestos de hashes; este resumo conserva os resultados e limites sem a infraestrutura scratch.

O freeze de entrada da Task16 é `2e1a099f56256c749220d1d5118908605e044079`, branch `codex/whatsapp-templates-programados`; destino local main observado `596ea733d8dfe832f84548dbc1e04b3ed9524d2a`. A migration 14 e a correção visual descrita abaixo acrescentam produto a esse estado no worktree final, sem alterar as 150 fontes TypeScript de EFs da matriz. A Task15 foi aprovada independentemente como Spec PASS / Quality Approved, sem achado bloqueante aberto. Essa aprovação não é o gate whole-branch da Task16.

| Evidência final Task15, executada pelo principal | Resultado e limite |
| --- | --- |
| Vitest, lint, typecheck, build e Deno | 106 arquivos / 2838 testes; lint zero erros e 22 warnings herdados; build e tsc -b --noEmit exit0; focused 33/33 após correção de tipo; SDK Deno real 38 entradas, exit0. Não somar testes focused à suíte nem afirmar full suite reexecutada após cada ajuste documental. |
| Gates36/37 nativos | Dez corridas e 89 verificações JWT em cada estado de flag ausente, JSON null e JSONB de alta precisão; restauração comprovada. As variantes não são testes diferentes para inflar contagem. |
| Migration PT409 e catálogo/ACL | Aplicada/reaplicada por CLI local; HTTP409 nativo e zero efeito após recusa; catálogo/ACL preservados. Gate31 após cleanup: 101 asserções, exit0. |
| App → Auth → RPC → SQL → resposta | App/SDK/GoTrue/PostgREST reais, três formulários persistidos, BillingGuard real, papéis/isolamento e opt-out A preservando outro consentimento. Provider fechado sintético. Gerente/operador/oficial incluem observações parciais anteriores explicitamente distinguidas; não são uma segunda história final completa. |
| Aceite/recibo e reenvio | Voucher B aceito uma vez, notification/histórico/recibo reconciliados por quatro campos. Três Requests do botão de confirmação geraram um único aceite; total de dois POSTs sintéticos (voucher + confirmação), zero externo. Confirmação permanece accepted/reconcile_required por conflito com notification legacy preservada, sem alegar entrega ou reparo que não ocorreram. |
| Atendimento/pesquisa | Controles Request exercitam IA/humano, handoff/eco/autor/lock e after_rating. A correção MAIN115 é intencional: pesquisa ganhou predicados unidade/cliente em SELECT/UPDATE, com negativos e concorrência. Ajustes de tipo e SUBSCRIPTION_PUBLIC_COLUMNS com valor idêntico não mudam política; não afirmar atendimento inteiro byte a byte inalterado. |
| Cleanup/cron | Fixtures/usuários/sessões/lease próprios zero, handlers drenados e servidor encerrado; metadata/valores/contagens restaurados; flags catalog/dispatch false. Cron original restaurado como job45, mesmo schedule/comando, fila/inflight/respostas zero; nenhuma invocação externa. |

Locators finais lidos: `S/task-15-final-independent-review.md`, `S/task-15-completion-author-report.md`, `S/task-15-main-cleanup.json`. O encerramento do handoff indexa também `task-15-main-browser-final.md`, `task-15-main-ui-persistence.json`, `task-15-full-story-results.json`, `task-15-main-native-31.log` e `task-15-main-cron-restore-1791582384324.json`. Tentativas falhas permanecem separadas e não são reclassificadas como sucesso.

Limitações: provider sintético não homologa API/conta real; Realtime local ausente; frescor dos dois canais foi precondição sintética, sem prova de health real; gateway/TLS/headers do hosting não foram exercitados. Dois warnings transitórios router_double_slash no breadcrumb do admin sem membership foram medidos e revistos como herdados da main; contador não foi zerado. Fixture SQL reduzido não comprova schema inteiro nem Advisor global.

| Gates Task16 efetivamente executados pelo principal | Resultado |
| --- | --- |
| `npm run test`, após correção visual | 106 arquivos / 2854 testes aprovados. Execução inicial de 2838 e tentativa sandbox EPERM permanecem históricas, sem somar contagens. |
| `npm run typecheck`, após correção visual | tsc -b --noEmit, exit0. |
| `npm run lint`; lint de EFs com max-warnings=0 | Frontend reexecutado após correção visual: exit0/zero erros/22 warnings herdados; lint de EFs anterior exit0/zero warnings, sem mudança de fonte EF. |
| Vite build em configuração fechada, após correção visual | Reexecutado exit0, envDir:false e valores frontend sintéticos; nenhum .env carregado. Avisos de idade Browserslist/tamanho de chunk retidos. O build fechado não é receita de deploy nem execução genérica com env de produção. |
| Correção visual de diagnóstico | RED limpo: 18 testes, 14 falhas/4 passes; GREEN: os mesmos 18 aprovados, via hook/projector reais e fronteira Supabase Functions mockada. Filtro visual em OfficialAutomationTemplate.tsx limita avisos a blocked/needs_review/uncertain/paused/rejected/failed, evitando falso impedimento em jobs normais ou concluídos. API, RBAC e histórico Entregas preservados; isso não altera elegibilidade de envio. |
| Deno real cached-only/no-config/no-lock | 36 EFs + authz.ts/ai-providers.ts, exit0; fontes idênticas ao freeze Task15. |
| PostgreSQL local read-only, antes da correção de retenção | Treze migrations, 78 nomes declarados/79 assinaturas vivas: privilégios efetivos contra allowlist sem grant excessivo/PUBLIC execute/search_path ausente nos controles inspecionados. Metadata de 70 funções/25 relações/13 tipos privados igual ao snapshot Task15; flags OFF e cron45/fila preservados. Search_path presente não equivale a vazio ou a relações qualificadas; os helpers herdados abaixo continuam com essa dívida. |
| Correção nativa de retenção, migration 14 | RED válido contra o predecessor: FAIL60 no recibo pending correlacionado antigo, exit3/rollback. Após aplicação CLI local: gate60 com 34 asserções, gate53 com 92 e gate31 com 101, exit0/rollback. O primeiro fixture falhou tentando alterar received_at imutável e não é prova RED. |
| Reaplicação e catálogo da correção | Dry-run/aplicação/reaplicação CLI local exit0; cópia exata de reaplicação existe só no workdir local, não é 15ª migration de produto. Gate60 repetiu as mesmas 34 asserções, sem duplicar contagem. Catálogo 70 funções/25 relações/13 tipos privados idêntico após reaplicação; contra o baseline, somente corpo/definição do purger mudou. ACL/configurações e demais funções/schema preservados. |
| ACL/migrations/Advisor estáticos após a correção | Três arquivos / 88 testes aprovados, wrapper sintético envDir:false sem VITE herdado. Tentativa direta sem ambiente requerido não executou testes. Não é Advisor global, auditoria global de ACL ou Check remoto. |
| Cleanup após a correção | Contagens e digests de 14 tabelas nomeadas, incluindo Auth/audit/flags, iguais ao baseline; testes em rollback. Cron original restaurado como job46, mesmo schedule/comando; fila/inflight/respostas zero, sem Edge sessions ou nomes Vault dos workers. Nenhum servidor/worker/provider iniciado ou request externo. |

Fontes desses resultados: `S/task-16-main-evidence.md`, `S/task-16-native-readonly-result.json` e `S/task-16-final-import-matrix.json/.md`. Logs iniciais históricos: `task-16-test-1791582862291.log`, `task-16-typecheck-1791582821262.log`, `task-16-lint-1791582837879.log` e `task-16-build-1791582875202.log`; lint EF/Deno: `task-16-edge-lint-1791582848046.log` e `task-16-deno.log`. Logs após correção visual: `S/task-16-ui-red-1791585399327.log`, `S/task-16-ui-green-1791585546660.log`, `S/task-16-test-1791585556708.log`, `S/task-16-typecheck-1791585555047.log`, `S/task-16-lint-1791585556458.log` e `S/task-16-build-1791585556017.log`. A autoria documental não executou runtime, CLI de banco, rede, provider ou testes de produto.

O review whole-branch identificou o P2 visual: a projeção retornava jobs de vários estados e a UI apresentava todos como impedimento. A correção acima atua somente na apresentação dos diagnósticos; Entregas continua mostrando seu histórico. Os seis vereditos registrados adiante conservam o escopo de seus freezes e addenda; não aprovam prospectivamente essa correção TSX ou estes documentos posteriores. O re-review whole-branch e a revisão incremental de secrets devem considerar os novos hashes antes da integração.

A correção está delimitada em `S/task-16-retention-author-report.md` e os resultados do principal em `S/task-16-retention-results.md`: GREEN60 `task-16-retention-green60-1791584385280.log`, regressões `task-16-retention-regression53-1791584441548.log`/`task-16-retention-regression31-1791584445912.log`, comparação `task-16-retention-catalog-comparison.json`, estáticos `task-16-retention-static-1791584511476.log` e restauração `task-16-retention-cron-restore-1791584523960.json`. Não houve novo harness de sessões concorrentes: a mudança acrescenta predicados de lookup sem lock e mantém a perna de jobs/ordem de locks; a cobertura concorrente anterior é evidência histórica, sem alegar nova execução PASS. Os re-reviews de migration e integração consideraram essa justificativa suficiente para o diff limitado, sem medir todas as interleavings, volume ou latência dos novos EXISTS. Repetir o predicado no DELETE do mesmo comando não cria outro snapshot MVCC nem serialização contra associações futuras ainda não visíveis.

Esses comandos são identificadores dos gates executados no ambiente fechado revisado. Reexecução de SQL/JWT/Deno/build exige validar o executor, hashes, alvo local e ambiente isolado descritos no [guia](../supabase/tests/whatsapp-scheduled-templates.integration.md); não reutilizar scripts scratch congelados em outro HEAD, reconstruir todo histórico ou carregar .env de produção por analogia.

Os seis gates reais saas-shield-br 2.3.0 concluíram revisão independente do delta e do freeze documental inicial, sem P0/P1. Foram auditorias estáticas; os resultados de execução acima são do principal. Os relatórios iniciais mantêm seu escopo histórico e não aprovam prospectivamente a migration 14:

| Gate, após addenda dirigidos quando aplicáveis | Veredito final e limite relevante |
| --- | --- |
| rls-auditor | PASS_WITH_WARNINGS; duas tabelas legadas sem FORCE RLS e dois helpers outbox com resolução herdada. |
| tenant-isolation-auditor | PASS_WITH_WARNINGS; helpers de autoridade com search_path público/relações não qualificadas, sem caminho HTTP de exploração demonstrado. |
| identity-access-auditor | PASS_WITH_WARNINGS; mesma dívida dos três helpers de autoridade, sem contar achado repetido como defeito adicional. |
| migration-validator | PASS_WITH_WARNINGS; P2 de retenção fechado na migration 14; permanecem as duas dívidas herdadas de outbox/FORCE RLS. |
| secret-hunter | PASS; nenhum secret acionável em 857 arquivos de fonte autorizados e 155 artefatos do build sintético; scan dirigido dos três caminhos corretivos com zero candidatos. Não auditou histórico Git, ambientes privados ou produção. |
| integration-reliability-auditor | PASS; P2 de perda de recibo pending correlacionado fechado na migration 14. Sem novo harness concorrente e sem homologação externa. |

Locators iniciais: `S/task-16-shield-rls-auditor.md`, `S/task-16-shield-tenant-isolation-auditor.md`, `S/task-16-shield-identity-access-auditor.md`, `S/task-16-shield-migration-validator.md`, `S/task-16-shield-secret-hunter.md` e `S/task-16-shield-integration-reliability-auditor.md`. `S/task-16-root-audit-decisions.md` registra a decisão de exigir correção e re-review da retenção antes da integração local, embora P2 seja atenção não bloqueante no contrato. Os addenda finais `S/task-16-shield-rls-migration-final-addendum.md` e `S/task-16-shield-secret-integration-final-addendum.md` fecham esse achado sobre os hashes dos três caminhos corretivos; não recuperam recibo perdido antes da aplicação nem aprovam os documentos finalizados posteriormente. O freeze consolidado e o review whole-branch devem conferir estes documentos e seus hashes.

As dívidas P2 herdadas permanecem abertas e não bloqueantes neste escopo: `app_private.is_platform_admin/is_unit_member/is_org_member` e `mark_outbox_done/mark_outbox_failed` conservam search_path público e relações não qualificadas; `reservation_message_templates` e `waitlist_message_templates` têm ENABLE sem FORCE RLS. Os primeiros exigem capacidade SQL adicional e relação homônima/TEMP para o cenário descrito; os últimos exigem papel dono sem BYPASSRLS. Não foi encontrado caminho HTTP da feature para essas capacidades, nem medida sua disponibilidade efetiva no ambiente real. O ACL service-only dos helpers outbox foi preservado. Não declarar hardening concluído, bypass público demonstrado ou schema global aprovado; o endurecimento limitado fica separado desta correção.

Review whole-branch independente e revisão integral do staged são condições de integração. O parecer whole-branch deve ser registrado em `S/task-16-final-independent-review.md`; o resultado efetivo e o SHA integrado constarão no relatório final do chat. Testes verdes, intenção de corrigir ou aprovação Task15 não substituem esses gates.

Não há PR nesta execução, portanto Check remoto acl-estatico está ausente. Testes estáticos locais integram a suíte, mas não viram Checks. `scripts/audit-function-acl.ts`/job acl-com-banco é a auditoria autoritativa contra banco autorizado; não foi executada globalmente nesta Task16. A inspeção read-only de 79 assinaturas do fixture não é atestado global do script/Advisor. Uma futura PR com SQL/ACL exige acl-estatico verde em Checks antes do merge.

Antes do commit/integração local, o principal confere 100% do staged, secrets nas linhas adicionadas/artefatos próprios, git status, diff, diff --cached, diff --check, caminhos explícitos, equivalência AGENTS/CLAUDE e main ainda no destino esperado. Commit/merge só após os gates/reviews finais; SHA integrado deve constar no relatório final de entrega. Não houve push, deploy, migration de produção, alteração de flag/canal real, submissão/aprovação remota, mensagem/provider/LLM real nesta autoria. Implementação local não libera homologação/produção nem inicia etapa externa.
