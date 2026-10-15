# Datafy parceiro — operação e rollout

Este procedimento descreve o fluxo implementado. O contrato externo medido está na [validação Fase 0](superpowers/specs/2026-10-13-datafy-parceiro-validacao-fase0.md); as decisões sobre Coexistence e custo estão no [design §11](superpowers/specs/2026-10-13-datafy-parceiro-conexao-self-service-design.md#11-questões-decididas-aprovadas-em-2026-10-13-conforme-recomendação). Executar chamadas reais, liberar custo e fazer deploy exige o escopo operacional aprovado para o ambiente.

## Preparação

- Conta Datafy com assinatura ativa e marca configurada na aba Parceiros. Conta inadimplente pode responder 403 à API administrativa.
- Platform admin cadastra **Token da conta Datafy** no card **WhatsApp oficial (Datafy)** em Plataforma → Automação. A chave `datafy_account_token` fica em `platform_secrets`, sem fallback de ambiente; mensagens/status/templates continuam com token de canal. Não colocar token de conta em credenciais de canal, Vercel, código ou logs.
- Configurar endpoint HTTPS de operações por `supabase secrets set WHATSAPP_OPS_ALERT_URL=<endpoint-HTTPS-aprovado>`, pelo canal seguro de secrets, sem colar valor em ticket ou histórico compartilhado. Esse endpoint é Edge secret, diferente do token de conta.
- Conferir serviço/allowance de novo provisionamento e liberação da unidade; platform admin também passa pelos gates de custo. Binding real de outro provider impede primeira configuração Datafy (409 `DATAFY_MIGRATION_NOT_SUPPORTED`); binding Datafy do mesmo provider é permitido. O padrão administrativo da organização não prova qual canal está em uso.

## Banco antes de funções e frontend

Antes do rollout, executar os gates de RLS, isolamento, identidade/acesso, migrations, secrets e integrações; exigir CI e Checks `acl-estatico` verdes e auditar ACL no banco pelo procedimento autorizado (`scripts/audit-function-acl.ts` / `acl-com-banco`). Harness local não prova ACL/RLS/PostgREST. Não aplicar SQL de migration pelo Studio.

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
3. Só após banco/ACL conferidos, deployar `manage-platform-secrets`, `manage-channels`, `webhook-whatsapp`, `process-whatsapp-channel-health`, `whatsapp-health`, `process-whatsapp-templates` e `send-scheduled-whatsapp` para este conjunto de mudanças. Usar `supabase functions deploy <nome>` pelo fluxo aprovado; bibliotecas compartilhadas ficam embutidas em cada bundle.
4. Publicar frontend após funções. Conferir leitura do card, diagnóstico e status sem provocar contratação como teste.

Rollback do app/bundle não remove migrations nem pendências. Bloquear novas liberações, preservar claims/ledger e corrigir banco por migration forward-only; reconciliar operações remotas antes de retomar. Não dropar tabelas/RPCs necessárias à reconciliação.

## Liberar e conectar uma loja

1. No painel da unidade, Automação → **WhatsApp oficial (Datafy)**, admin seleciona **Liberar conexão oficial** e confirma a unidade correta. A liberação é persistida; não é simples preferência de provider.
2. Owner/gerente abre o card **WhatsApp oficial**, mantém o número no app WhatsApp Business e acesso administrativo à empresa Meta. Seleciona **Conectar WhatsApp oficial**, conclui na janela Datafy e usa **Já concluí a conexão**. Operador não executa o fluxo.
3. O backend cria/reconcilia canal e webhook sob claim. Enquanto não há número, tudo fica em `whatsapp_datafy_onboardings`; o canal local só nasce com identidade do GET. Link só é emitido sem número: pedir link após conectar permitiria trocar o número. Não copiar URL para logs, cache ou tickets; se a janela for bloqueada, permitir popup e tentar pelo botão.
4. **Já concluí a conexão** pode gerar assinatura/custo assim que o GET confirma o número. Uma liberação paga um canal; reconectar o mesmo não autoriza criar outro. A loja cadastra seu cartão nas configurações de pagamento da conta WhatsApp na Meta; a plataforma paga a assinatura Datafy.
5. Enviar pelo app WhatsApp Business uma mensagem para qualquer contato. O eco persistido comprova Coexistence; assinatura e eco podem chegar em qualquer ordem. Sem eco, nunca ativar manualmente por SQL. GET e postMessage não provam Coexistence. Número só Cloud API fica assinado/inativo até decisão de cancelamento do admin; o card mostra aviso após 24h sem eco.
6. Conferir checklist, intenção de ativação, canal ativo e ingestão efetiva no card. A fila exige coluna do canal + capability `inboundRedelivery=documented` + flag global `whatsapp_async_ingestion`; gate ilegível bloqueia com 503. Templates pendentes não significam automações homologadas: não liberar automações proativas fora da janela de 24h antes do piloto próprio. Lojista deve abrir o app ao menos a cada 14 dias.

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
| `phone.ts` | As 12 anteriores + `create-manual-reservation`, `create-reservation` |
| `ops-alert-sender.ts` | `manage-channels`, `process-whatsapp-channel-health`, `process-whatsapp-templates`, `send-scheduled-whatsapp`, `whatsapp-health` |
| `ops-alert-runtime.ts`, `ops-alert-core.ts` | `manage-channels`, `process-whatsapp-channel-health` |
| `whatsapp-inbound-queue-core.ts` | `manage-channels`, `process-whatsapp-channel-health`, `webhook-whatsapp`, `whatsapp-health`; frontend também usa limites do core |

`datafy-admin-client.ts` importa `DATAFY_BASE_URL` de `datafy-client.ts`; este alcança `whatsapp-template-provider-core.ts` e `phone.ts`. A nova perna administrativa chega a `manage-channels`, não a todas as EFs quando apenas o admin client muda. `send-scheduled-whatsapp` chega ao sender via `whatsapp-template-runtime.ts` → `whatsapp-template-worker.ts` (reexport por valor); não omitir essa perna por não chamar o sender diretamente.
