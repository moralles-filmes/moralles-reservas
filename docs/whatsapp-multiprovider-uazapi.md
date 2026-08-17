# WhatsApp multi-provider — operação UazAPI

## Escopo

UazAPI e Z-API compartilham a mesma pipeline de reservas, CRM, conversas, IA e outbound. `whatsapp_channels` é o vínculo operacional por unidade; cada provider ocupa uma linha própria. Z-API continua manual e usa os mesmos campos/endpoints anteriores. UazAPI é provisionada e conectada automaticamente, sem gravar token no JSONB.

## Configuração

Configure somente como Edge Function secrets:

```text
UAZAPI_BASE_URL=https://seu-servidor-uazapi
UAZAPI_ADMIN_TOKEN=<admintoken do servidor>
```

Comando operacional, após aprovação para alterar o ambiente:

```bash
supabase secrets set UAZAPI_BASE_URL=... UAZAPI_ADMIN_TOKEN=...
```

O `admintoken` cria/lista instâncias e nunca entra no frontend ou no banco. O token individual retornado por `/instance/create` é gravado por RPC service-role-only no Supabase Vault; `whatsapp_channels` guarda apenas o UUID do segredo.

## Provisionamento e conexão

1. Platform admin seleciona UazAPI na empresa. Isso salva apenas `organizations.default_whatsapp_provider` e registra a decisão no ledger.
2. Owner/gerente abre `/g/:unitSlug/whatsapp` e solicita conexão, ou o admin prepara pelo painel de Automação.
3. `manage-channels` cria/reutiliza uma linha UazAPI inativa e reivindica um claim com fence UUID.
4. Sem token local, a função lista instâncias e reconcilia por `adminField01 = channel_id`. Só cria quando não encontra.
5. O token vai ao Vault, a instância entra no inventário financeiro e o webhook central é configurado com eventos `messages`, `messages_update` e `connection`, excluindo `wasSentByApi`.
6. `/instance/connect` gera QR. O QR é devolvido apenas na resposta efêmera; não é persistido nem logado.
7. Status `connected` ativa o primeiro canal. Em troca de provider, ativa apenas se existir intenção explícita criada por `begin_switch`.

Double-click não cria duas instâncias: o índice parcial limita uma linha UazAPI por unidade, o claim serializa o I/O e a reconciliação cobre timeout incerto do create. Uma tentativa atrasada não consegue liberar claim novo porque `release` exige o fence UUID.

## Cutover e rollback

O cutover é prepare → connect → validate → activate. Enquanto o alvo não conecta, o canal antigo continua `is_active=true` e é o único usado para envio/inbound. `activate_whatsapp_channel` bloqueia target desconectado e troca os flags na mesma transação.

Rollback reutiliza a linha anterior: teste/conecte o canal preservado, solicite ativação e execute o mesmo cutover. Não sobrescreva credenciais Z-API e não delete a linha antiga como parte da troca.

## Webhook e segurança

- Endpoint único: `webhook-whatsapp?channel=<uuid>&secret=<secret-aleatorio>`.
- O OpenAPI UazAPI não especifica HMAC. Não inventar assinatura: validar secret por canal em tempo constante, token/instance do payload quando presentes e vínculo `channel_id → unit_id`.
- Canal inativo pode receber callback de conexão/entrega, mas eventos de mensagem retornam 200 sem CRM/IA/resposta.
- Payload acima de 1 MB é recusado.
- Dedupe usa `(provider, message_id)`.
- Logs nunca carregam admintoken, instance token, QR, secret do webhook ou conteúdo de mensagem.

## RBAC

- Platform admin: default organizacional, credenciais manuais, diagnóstico, preparação e troca de provider.
- Owner/gerente da própria unidade: listar estado client-safe, conectar/renovar QR/status/desconectar/reiniciar UazAPI.
- Operador: sem acesso à rota ou às actions de lifecycle.
- As Edge Functions usam service role, portanto toda action valida JWT, role, `unit_id` e `channel_id` antes de I/O externo.

## Diagnóstico

| Sintoma | Verificação | Ação segura |
|---|---|---|
| `AUTH_ERROR` | Edge secrets e admintoken no servidor correto | Corrigir secret; não criar nova instância |
| `CAPACITY_EXCEEDED` | Limite do servidor/plano UazAPI | Ampliar capacidade ou encerrar instância confirmada |
| QR expirou | Status do mesmo `channel_id` | Pedir novo QR; não recriar instância |
| Timeout após create | `/instance/all`, `adminField01=channel_id` | Reconciliar e guardar o token; nunca repetir create cegamente |
| Conectou, mas não ativou | `activation_requested_at`, canal ativo atual e ledger | Reexecutar status/activate; preservar canal antigo |
| Warning de inventário | `whatsapp_instances` por provider/ref/channel | Reconciliar a linha financeira; não repetir criação externa |
| UazAPI sem env | Z-API deve continuar normal | Configurar apenas os dois secrets UazAPI |

## Ordem de rollout

1. Aplicar a migration `20260817170753_whatsapp_multiprovider_uazapi.sql`.
2. Configurar os dois Edge secrets.
3. Deploy conjunto de `manage-organizations`, `manage-channels`, `whatsapp-health`, `webhook-whatsapp`, `send-whatsapp`, `send-confirmation`, `send-cancellation` e `send-manual-message`.
4. Deploy do frontend.
5. Validar uma unidade de teste: criar → QR → conectar → inbound → outbound → delivery status → desconectar/reconectar.

Não fazer deploy das Edge Functions antes da migration: os guards leem colunas novas e falham fechados. Não fazer `db push`, deploy ou rotação de secrets por copiar este runbook; essas mutações exigem autorização operacional específica.

## Referência do provider

Contratos usados: OpenAPI UazAPI v2.1.1 (`/instance/create`, `/instance/all`, `/webhook`, `/instance/connect`, `/instance/status`, `/instance/disconnect`, `/instance/reset`, `/send/text`): <https://docs.uazapi.com/openapi-bundled.json>.
