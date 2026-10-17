# Datafy parceiro — operação e rollout

Este procedimento descreve o fluxo implementado. O contrato externo medido está na [validação Fase 0](superpowers/specs/2026-10-13-datafy-parceiro-validacao-fase0.md); as decisões sobre Coexistence e custo estão no [design §11](superpowers/specs/2026-10-13-datafy-parceiro-conexao-self-service-design.md#11-questões-decididas-aprovadas-em-2026-10-13-conforme-recomendação). Executar chamadas reais, liberar custo e fazer deploy exige o escopo operacional aprovado para o ambiente.

## Preparação

- Conta Datafy com assinatura ativa e marca configurada na aba Parceiros. Conta inadimplente pode responder 403 à API administrativa.
- Platform admin cadastra **Token da conta Datafy** no card **WhatsApp oficial (Datafy)** em Plataforma → Integrações e chaves (`/platform/integracoes`). A chave `datafy_account_token` fica em `platform_secrets`, sem fallback de ambiente; mensagens/status/templates continuam com token de canal. Não colocar token de conta em credenciais de canal, Vercel, código ou logs.
- Configurar endpoint HTTPS de operações por `supabase secrets set WHATSAPP_OPS_ALERT_URL=<endpoint-HTTPS-aprovado>`, pelo canal seguro de secrets, sem colar valor em ticket ou histórico compartilhado. Esse endpoint é Edge secret, diferente do token de conta.
- Conferir serviço/allowance de novo provisionamento e liberação da unidade; platform admin também passa pelos gates de custo. Binding real de outro provider impede primeira configuração Datafy (409 `DATAFY_MIGRATION_NOT_SUPPORTED`), salvo liberação de migração (seção "Migrar loja em produção"); binding Datafy do mesmo provider é permitido. O padrão administrativo da organização não prova qual canal está em uso.

## Banco antes de funções e frontend

Antes do rollout, executar os gates de RLS, isolamento, identidade/acesso, migrations, secrets e integrações; exigir CI e Checks `acl-estatico` verdes e auditar ACL no banco pelo procedimento autorizado (`scripts/audit-function-acl.ts` / `acl-com-banco`). O harness local exercita ACL/RLS SQL com papéis reais e claims JWT; não comprova a configuração de produção, `verify_jwt` ou exposição efetiva pelo PostgREST (ver README do pré-voo). Não aplicar SQL de migration pelo Studio.

Rodar os dois pré-voos somente leitura com acesso administrativo aprovado, antes de `supabase db push`. Ambos devem retornar zero linhas; investigar e reconciliar conflitos com os responsáveis, sem escolher um vencedor ou apagar canais automaticamente.

```sql
-- Mesma normalização do índice, inclusive exclusão de vazio/NULL.
select pg_catalog.btrim(credentials->>'phone_number_id', E' \t\r\n') as phone_number_id, count(*)
from public.whatsapp_channels
where provider in ('official', 'datafy')
  and pg_catalog.btrim(credentials->>'phone_number_id', E' \t\r\n') <> ''
group by 1 having count(*) > 1;

-- WABA compartilhada por canais e contas de templates: uma organização.
with owners as (
  select waba_id, organization_id from public.whatsapp_template_accounts
  union
  select nullif(btrim(c.credentials->>'business_account_id', E' \t\r\n'), ''), u.organization_id
  from public.whatsapp_channels c join public.units u on u.id=c.unit_id
  where c.provider in ('datafy', 'official')
)
select waba_id from owners where waba_id is not null
group by waba_id having count(distinct organization_id) > 1;
```

1. Conferir ambiente alvo, backup e migrations pendentes com `supabase db push --dry-run`.
2. Aplicar por `supabase db push`, em ordem: `20261014120000_datafy_partner_onboarding.sql` (grants, onboarding, claims, índice de telefone, ledger), `20261014170540_datafy_existing_subscription_claim.sql` (cerca administrativa, proveniência de assinatura e reserva WABA), `20261015171115_whatsapp_ops_alert_observation.sql` (observação SQL da fila inteira). Não usar `--include-all` para contornar ordem. Conflito de backfill aborta o rollout.
3. Só após banco/ACL conferidos, deployar a união de 13 EFs deste rollout: `manage-platform-secrets`, `manage-channels`, `manage-organizations`, `manage-whatsapp-templates`, `process-whatsapp-channel-health`, `process-whatsapp-templates`, `send-cancellation`, `send-confirmation`, `send-manual-message`, `send-scheduled-whatsapp`, `send-whatsapp`, `webhook-whatsapp` e `whatsapp-health`. O registry `whatsapp-provider-core.ts` mudou nesta entrega: suas 12 consumidoras precisam do bundle novo, além de `manage-platform-secrets` para o token de conta. Usar `supabase functions deploy <nome>` pelo fluxo aprovado; bibliotecas compartilhadas ficam embutidas em cada bundle.
4. Publicar frontend após funções. Conferir leitura do card, diagnóstico e status sem provocar contratação como teste.

Rollback do app/bundle não remove migrations nem pendências. Bloquear novas liberações, preservar claims/ledger e corrigir banco por migration forward-only; reconciliar operações remotas antes de retomar. Não dropar tabelas/RPCs necessárias à reconciliação.

## Liberar e conectar uma loja

1. Em Plataforma → Unidades → Configurar (`/platform/unidades/:slug`), aba Canais WhatsApp → **WhatsApp oficial (Datafy)**, admin seleciona **Liberar conexão oficial** e confirma a unidade correta. A liberação é persistida; não é simples preferência de provider.
2. Owner/gerente abre o card **WhatsApp oficial**, mantém o número no app WhatsApp Business e acesso administrativo à empresa Meta. Seleciona **Conectar WhatsApp oficial**, conclui na janela Datafy e usa **Já concluí a conexão**. Operador não executa o fluxo.
3. O backend cria/reconcilia canal e webhook sob claim. Enquanto não há número, tudo fica em `whatsapp_datafy_onboardings`; o canal local só nasce com identidade do GET. Link só é emitido sem número: pedir link após conectar permitiria trocar o número. Não copiar URL para logs, cache ou tickets; se a janela for bloqueada, permitir popup e tentar pelo botão.
4. **Já concluí a conexão** pode gerar assinatura/custo assim que o GET confirma o número. Uma liberação paga um canal; reconectar o mesmo não autoriza criar outro. A loja cadastra seu cartão nas configurações de pagamento da conta WhatsApp na Meta; a plataforma paga a assinatura Datafy.
5. Enviar pelo app WhatsApp Business uma mensagem para qualquer contato. O eco persistido comprova Coexistence; assinatura e eco podem chegar em qualquer ordem. Sem eco, nunca ativar manualmente por SQL. GET e postMessage não provam Coexistence. Número só Cloud API fica assinado/inativo até decisão de cancelamento do admin; o card mostra aviso após 24h sem eco.
6. Conferir checklist, intenção de ativação, canal ativo e ingestão efetiva no card. A fila exige coluna do canal + capability `inboundRedelivery=documented` + flag global `whatsapp_async_ingestion`; gate ilegível bloqueia com 503. Templates pendentes não significam automações homologadas: não liberar automações proativas fora da janela de 24h antes do piloto próprio. Lojista deve abrir o app ao menos a cada 14 dias.

## Migrar loja em produção (outro provider → Datafy)

Spec: [migração de loja em produção](superpowers/specs/2026-10-16-datafy-migracao-loja-em-producao-design.md). Vale para unidade cujo canal operacional é de outro provider (ex.: UazAPI).

1. **Pré-requisitos:**
   - o número está no app WhatsApp Business, versão 2.24.17 ou superior;
   - o lojista tem acesso de administrador à empresa Meta;
   - horário de pouco movimento combinado.
   - Liberação comum criada antes deste fluxo não vale como migração: revogar e liberar de novo.
2. **Liberar a migração.** Em Automação → **WhatsApp oficial (Datafy)**, o botão aparece como **Liberar migração para oficial**. O servidor prende a liberação ao canal operacional do momento (`replaces_channel_id`).
   - Se esse canal deixar de ser o operacional antes da conexão, a liberação continua aparecendo como ativa, mas as ações recusam:
     - **Conectar** recusa com `UNIT_ALREADY_ACTIVE`;
     - confirmação, assinatura e **Ativar / trocar** recusam com `DATAFY_MIGRATION_NOT_SUPPORTED`.
   - Nesse caso, revogar e liberar de novo.
3. **Conectar e religar a UazAPI.** Owner ou gerente abre `/g/:slug/whatsapp`, que mostra **Conexão atual** e o cartão oficial, e conclui a conexão na janela Datafy.
   - A Meta desvincula todos os aparelhos vinculados, e a UazAPI cai nesse instante.
   - **Logo em seguida**, gerar novo QR em **Conexão atual** e escanear.
   - Mensagens recebidas entre a queda e o novo QR não entram no sistema; continuam visíveis no celular.
4. **Confirmar.** **Já concluí a conexão** assina o canal. Com liberação de migração, o canal oficial nasce inativo e **sem intenção**.
   - Uma mensagem do app, ou da UazAPI revinculada, prova a coexistência.
   - O checklist vai a `awaiting_cutover` e a UazAPI segue operando.
5. **Preparar os templates com a loja ainda na UazAPI.** Catálogo, sync, aprovação e custo de marketing seguem o [runbook de templates](whatsapp-templates-programados-runbook.md). O catálogo exige o canal conectado, não ativo.
6. **Corte.** **Ativar / trocar** no canal oficial (`begin_switch`). A UazAPI é desligada na mesma transação. Em seguida, liberar o despacho de templates no canal.
   - No corte de migração, eco e conexão são conferidos **antes** de gravar a intenção. Uma recusa (409) não deixa corte armado para o próximo eco.
   - O canal de migração nasce com `async_ingestion_enabled=false`, e o corte não o religa. Com ingestão assíncrona, uma mensagem recebida pelo canal oficial ainda inativo ficaria na fila e seria processada depois do corte, duplicando a resposta já dada pela UazAPI.
   - Religar a ingestão assíncrona é decisão posterior e deliberada do admin.
7. **Reversão.** **Ativar / trocar** no canal UazAPI preservado. A assinatura Datafy continua até o cancelamento administrativo.
   - Se a UazAPI estiver desvinculada, o fluxo gera QR **no painel da plataforma** (Automação), não na tela da loja: com o oficial ainda ativo, a loja vê só o cartão oficial.
   - Combine com a loja para escanear esse QR.
   - Liberação consumida não pode ser revogada (CHECK). Ela continua autorizando novo corte enquanto o canal substituído for o operacional, o que permite cortar de novo depois de uma reversão.
   - Para encerrar a migração de vez, **cancelar a assinatura** do canal Datafy: o CHECK de assinatura operacional recusa a ativação. Também dá para remover o canal Datafy.
8. **Encerramento.** Após 7 dias estáveis, desconectar a instância UazAPI. A linha fica inativa como histórico.

**Deploy da Fase 1:**
1. `supabase db push` da migration `20261016182000_datafy_migration_grant.sql`;
2. deploy de `manage-channels` **logo em seguida**;
3. publicação do frontend.

Não criar liberação entre o `db push` e o deploy. Nesse intervalo o bundle antigo veria uma liberação presa sem entender a migração. O finalizador novo já retém a ativação, mas uma assinatura poderia ser criada fora do fluxo previsto.

`manage-organizations` não precisa de redeploy: a mudança em `whatsapp-org-provider-core.ts` é só de tipo.

## Preparação da Fase 5 — matriz integrada (rollout ainda não executado)

Esta matriz foi derivada de `git diff --name-only origin/main...HEAD` na branch `feat/datafy-migracao-uazapi`, incluindo as Fases 1–4, e complementada pela migration local da Fase 5. Um dry-run anterior com CLI 2.120.0 confirmou **nove migrations pendentes** quando a migration Datafy se chamava `20261016140200_datafy_migration_grant.sql`. Depois, o alvo aplicou `20261016180000_whatsapp_instance_delete_without_cost.sql` e `20261016181000_audit_log_member_read_allowlist.sql` de `main`. O dry-run seguinte recusou `20261016140200` com `DbPushMissingRemoteError`; o arquivo Datafy foi renomeado para `20261016182000_datafy_migration_grant.sql`, com SQL idêntico. O novo `supabase db push --dry-run --skip-vault --project-ref gbabxcrntkwgblgqsiit` terminou com código 0 e confirmou exatamente as **nove migrations pendentes** da tabela abaixo, na ordem indicada. Nenhuma migration Datafy foi aplicada; não houve deploy ou chamada a provider. **NO-GO** pelos demais gates e autorizações de produção. Repetir o dry-run se `main` avançar antes da escrita.

**Banco primeiro.** As migrations novas no diff local, em ordem de filename, são:

| Ordem | Migration | Dependência relevante |
|---|---|---|
| 1 | `20261016182000_datafy_migration_grant.sql` | Grant preso ao canal substituído e retenção da ativação até corte manual; não criar liberação entre SQL e `manage-channels` novo. |
| 2 | `20261017120000_whatsapp_templates_table_ready_cancellation.sql` | CHECKs, catálogo e RPCs aceitam os dois modelos/kinds antes dos bundles com catálogo de nove. |
| 3 | `20261017130000_reservation_cancellation_fact.sql` | Fato `cancelled_at` antes de `send-cancellation` novo. |
| 4 | `20261017140000_waitlist_table_ready_server_fact.sql` | Fato de mesa pronta no servidor antes de `notify-waitlist-ready` novo. |
| 5 | `20261017150000_whatsapp_automation_failed_notification_adoption.sql` | Reparo da linha de notificação `failed` antes dos produtores/dispatch novos. |
| 6 | `20261017160000_conversation_message_write_acl.sql` | Mensagens da conversa escritas só por serviço antes da janela manual oficial nova. |
| 7 | `20261017170000_public_promotional_opt_in.sql` | RPC de opt-in antes de `create-reservation` e `public-waitlist` novos. |
| 8 | `20261017173000_public_waitlist_serial_rate_limit.sql` | Wrapper/rate limit e revogação de entrada direta `anon` antes de liberar a fila via EF. |
| 9 | `20261017180000_force_rls_operational_baseline.sql` | Correção aprovada da Fase 5: `FORCE RLS` nas cinco tabelas herdadas, após as alterações de ACL/fila; pré-voo 70 e gate RLS ainda precisam fechar. |

No alvo autorizado, conferir migrations já aplicadas, backup, `supabase db push --dry-run`, conflitos de identidade e ACL/RLS efetivas; só então aplicar `supabase db push` na ordem real. O SQL de fila revoga o caminho do frontend antigo, portanto a publicação exige janela combinada.

**Bundles.** Entrada reproduzível: `git diff --name-only origin/main...HEAD -- 'supabase/functions/_shared/*.ts'` (13 arquivos) alimenta `node scripts/ef-import-graph.mjs --json <arquivos>`; unir o resultado a `git diff --name-only origin/main...HEAD -- 'supabase/functions/*/index.ts'` (8 entradas diretas). A união local tem **19 EFs**, sem redeploy por prefixo. O grafo segue imports por valor transitivos; não cobre acoplamentos SQL, frontend e strings de evento. Recalcular no SHA final antes da autorização.

| Etapa proposta | Edge Functions da união local | `verify_jwt` no `config.toml` |
|---|---|---|
| Após SQL/ACL, antes do frontend | `create-reservation`, `notify-waitlist-ready`, `process-notification-outbox`, `process-reservation-reminders`, `process-satisfaction-surveys`, `process-voucher-triggers`, `process-waitlist-entered`, `process-waitlist-feedback`, `public-waitlist`, `resend-notification`, `send-cancellation`, `send-confirmation`, `send-manual-message`, `send-scheduled-whatsapp`, `send-whatsapp` | `false` nas 15; cada uma preserva a autenticação própria. |
| Após SQL/ACL, antes do frontend | `manage-channels`, `manage-organizations` | `true` nas 2. |
| Depois de Vercel `READY` do frontend tolerante | `manage-whatsapp-templates` | `false`, mas valida usuário e repassa JWT original às RPCs. O frontend novo aceita snapshot de catálogo antigo como subconjunto; o frontend antigo não aceita catálogo de nove. |
| Só com autorização própria de submissão de modelos | `process-whatsapp-templates` | `false`, com autenticação interna. |

O frontend novo da fila depende de `public-waitlist` e do SQL novos; o frontend antigo chama `enter_waitlist` como `anon`. Publicar `manage-whatsapp-templates` com nove modelos antes do frontend tolerante também quebraria o snapshot de Comunicação no frontend antigo. Coordenar SQL → EFs não submetedoras → frontend `READY` → `manage-whatsapp-templates`; observar os fluxos e somente então tratar `process-whatsapp-templates`. Os outros workers listados são consumidores transitivos dos `_shared` alterados, mesmo sem `index.ts` modificado diretamente. `manage-organizations` entrou na união conservadora pelo import de `whatsapp-org-provider-core.ts`, cuja mudança nesta branch é só de tipo; isoladamente, esse diff não obriga redeploy runtime dessa EF. Manter `whatsapp_template_catalog` e `whatsapp_automation_dispatch` sem nova liberação operacional durante a transição.

**Janela da fila pública.** Agendar horário de pouco movimento com dono técnico e responsável da loja, canal de aviso e rollback operacional definido antes da escrita. Do instante em que a migration 8 revoga `anon` em `enter_waitlist`/`waitlist` até o frontend novo estar `READY` na Vercel, sessões com o formulário antigo falham; clientes com página aberta podem continuar usando código antigo depois de `READY` até recarregar. Não prometer duração fixa. Avisar para atualizar a página, observar erros da fila e confirmações de senha sem duplicar entradas; se `public-waitlist`/gateway falhar, interromper a abertura da fila, preservar IDs já criados e corrigir por migration/bundle forward-only. Reabrir só após smoke sem entrada real não autorizada e monitoramento estável.

**Prova do cabeçalho de IP.** `public-waitlist` só aceita `CF-Connecting-IP` válido; ausência/má formação responde 503, e `X-Forwarded-For` não é fallback. Após o deploy autorizado da EF, `POST` com corpo `{}` ao endpoint hospedado é um smoke sem mutação: 400 `invalid_input` mostra que o cabeçalho passou pelo parser; 503 `dependency_unavailable` não confirma presença/validade (ou indica falha no cálculo da chave). O corpo inválido é recusado antes de qualquer consulta ou escrita no banco. Esse smoke **não prova a origem** do IP, pois um cabeçalho forjado sintaticamente válido também daria 400. Antes de liberar a fila nova, obter evidência de ingress ou usar uma sonda temporária de leitura no gateway hospedado, com acesso restrito e autorização de deploy específica, que apenas devolva `present`, `valid` e se o valor recebido é igual a um marcador forjado; não retornar nem registrar IP, corpo, token ou cabeçalhos. Fazer pedido normal e pedido da mesma origem com `CF-Connecting-IP` forjado (e `X-Forwarded-For` forjado). Exigir no normal 200 e `{present:true, valid:true, equalsForgedMarker:false}`. No forjado, aceitar 200 com os mesmos booleanos **ou** 403 comprovadamente anterior ao handler, com metadados de passagem pela Cloudflare, handler sem caminho 403 e logs agregados da função sem resposta 403 correspondente. O 403 isolado não basta; o bloqueio só prova rejeição na rota e origem testadas, e sua aplicação à fila é inferência pelo ingresso compartilhado. Registrar horário, projeto, método, status e booleanos redigidos quando houver. Valor forjado aceito, cabeçalho normal ausente/inválido ou falta de prova de bloqueio antes do handler são **NO-GO**; não criar senha de fila nem outro dado para testar. Remover a sonda após validação pelo fluxo aprovado. A emenda `docs/superpowers/specs/2026-10-16-cf-connecting-ip-gateway-gate-amendment.md` registra o aceite expresso desse critério alternativo em 2026-10-16.

**Submissão à Meta.** O bundle novo de `process-whatsapp-templates` pode semear e submeter automaticamente `fila_mesa_pronta_v1` e `res_cancelada_v1` em toda conta com escopo `catalog` liberado, inclusive Moralles. Não incluí-lo em autorização genérica de deploy. Obter autorização nominal do responsável para esse redeploy e suas contas afetadas. **Sem essa autorização própria, não redeployar `process-whatsapp-templates`**, mesmo com `catalog` pausado; o rollout permanece incompleto. Pausar o escopo `catalog` das contas relevantes é um passo administrativo que também exige autorização e apenas reduz o risco de submissão quando o redeploy for autorizado; a pausa não substitui a autorização do redeploy. Reabrir o escopo só após decisão explícita. Não usar rollback de bundle como forma de desfazer submissão já aceita.

## Administração e operações incertas

Antes de **Assinar canal**, **Cancelar assinatura**, **Pausar canal**, **Retomar canal** ou vínculo, conferir unidade, id local, telefone e **nome exato do canal remoto** na Datafy. O diálogo de assinatura/pausa/cancelamento pede confirmação genérica; não valida o nome digitado. Esta conferência é procedimento do operador, inclusive quando não há nome remoto exposto no card. Se não conseguir confirmar identidade, interromper a operação. Nunca usar o canal mais recente como substituto de uma seleção explícita inválida.

- **Buscar canal existente** faz preview novo; conferir nome, prefixo de id, assinatura, pausa e hosts do webhook, selecionar candidato, digitar o nome exato e **Confirmar vínculo**. O backend relê listagem/GET e não confia no id remoto isolado. Não vincular com claim/incerteza pendente; troca de identidade/credencial invalida prova de eco.
- Timeout, transporte, 409 ou resposta não reconhecida não provam ausência. Atualizar estado e retomar a mesma ação pelo fluxo existente: **Conectar WhatsApp oficial** para criação/webhook ainda em onboarding, **Já concluí a conexão** para confirmação/assinatura, ou a ação administrativa original no canal selecionado. A implementação reconcilia `uncertain`/`must_reconcile` sob a cerca original antes de POST novo; não há botão chamado “Reconciliar”. Se o backend indicar busy, aguardar e reler; não criar outro canal, limpar claim, mudar grant ou repetir POST por curl.
- Se persistir incerto, investigar GET/listagem e estado persistido com acesso aprovado. Transporte preserva a pendência; ausência comprovada permite somente o reparo autorizado pela etapa. Subscribe com 404 definitivo encerra incerteza sem novo POST; relink não é atalho. Fonte/ator/fence/identidade/revisão e TTL são revalidados no SQL imediatamente antes de mutação remota.
- **Pausar canal** e **Cancelar assinatura** interrompem operação e limpam intenção; conferir confirmação remota no GET. **Retomar canal** não restaura intenção automaticamente: selecionar/ativar novamente pelo fluxo do canal, aguardando guards de assinatura/eco. **Revogar liberação** não cancela assinatura remota existente. Sem automação de inadimplência nesta entrega, decisão de pausar/cancelar é administrativa.
- Se a liberação for revogada durante POST, o fato remoto de custo é registrado sem consumir grant nem ativar. Tratar assinatura existente explicitamente; falha de alerta não desfaz assinatura nem é autorização para POST novo.

## Alertas e limites aceitos

Health observa também unidades da fila sem canal ativo; `observe_whatsapp_ops_alerts` usa relógio SQL e snapshot de contagem/watermark. `ops-alert-runtime` cobre backlog/dead-letter e falha de assinatura; payload fechado não carrega conteúdo, credenciais ou URL de conexão. Conferir logs/resposta de health para endpoint ausente, inválido ou falho: ausência de alerta não prova ausência de incidente.

Ledger só avança após HTTP aceito; throttling padrão é 30 min por unidade/tipo. Envio HTTP e gravação do ledger não são transação distribuída: concorrência e falha após aceite podem duplicar alerta. Não há garantia de exactly-once, fila durável de retry do alerta nem entrega ao destinatário provada por HTTP 2xx. Manter inspeção do painel, claims e logs como apoio operacional.

## Matriz transitiva de redeploy

Consumidoras por valor verificadas no grafo de imports locais em `supabase/functions`; frontend exige build/publicação, não deploy de EF. Alterar dependência alcança todos os bundles que a embutem, mas alterar importador não exige redeploy dos outros consumidores da dependência.

| Arquivo compartilhado | EFs que exigem redeploy |
|---|---|
| `datafy-admin-client.ts`, `datafy-onboarding-actions.ts`, `datafy-onboarding-core.ts` | `manage-channels`; core também é importado diretamente pelo frontend |
| `datafy-account-config.ts`, `datafy-account-config-core.ts` | `manage-channels`, `manage-platform-secrets` |
| `datafy-client.ts` | `manage-channels`, `manage-organizations`, `process-whatsapp-channel-health`, `process-whatsapp-templates`, `send-cancellation`, `send-confirmation`, `send-manual-message`, `send-scheduled-whatsapp`, `send-whatsapp`, `webhook-whatsapp`, `whatsapp-health` |
| `whatsapp-template-provider-core.ts` | As 11 anteriores + `manage-whatsapp-templates` |
| `whatsapp-provider-core.ts` (registry) | As mesmas 12 da linha anterior |
| `phone.ts` | As 12 anteriores + `create-manual-reservation`, `create-reservation` |
| `ops-alert-sender.ts` | `manage-channels`, `process-whatsapp-channel-health`, `process-whatsapp-templates`, `send-scheduled-whatsapp`, `whatsapp-health` |
| `ops-alert-runtime.ts`, `ops-alert-core.ts` | `manage-channels`, `process-whatsapp-channel-health` |
| `whatsapp-inbound-queue-core.ts` | `manage-channels`, `process-whatsapp-channel-health`, `webhook-whatsapp`, `whatsapp-health`; frontend também usa limites do core |

`datafy-admin-client.ts` importa `DATAFY_BASE_URL` de `datafy-client.ts`; este alcança `whatsapp-template-provider-core.ts` e `phone.ts`. A nova perna administrativa chega a `manage-channels`, não a todas as EFs quando apenas o admin client muda. `send-scheduled-whatsapp` chega ao sender via `whatsapp-template-runtime.ts` → `whatsapp-template-worker.ts` (reexport por valor); não omitir essa perna por não chamar o sender diretamente.
