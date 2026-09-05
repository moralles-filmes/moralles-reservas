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

## Contrato obrigatório de paridade de conversa

Provider novo só entra em produção e só aparece como equivalente à Z-API depois de provar, de ponta a ponta:

- inbound de cliente e outbound de IA/painel na mesma conversa;
- eco de mensagem humana enviada no aparelho, separado inequivocamente de mensagem originada pela nossa API;
- ID estável e timestamp original do provider, usados respectivamente no dedupe `(provider,message_id)` e no `timestamp` ISO exibido no chat — horário de processamento local não substitui o timestamp do evento;
- autoria canônica que permita à UI distinguir Cliente, IA e Atendente; mensagem do aparelho é `role: "human"`, e `human_user_id` é preservado quando o autor autenticado existe;
- append pela RPC atômica, sem criar customer a partir de eco não resolvido e sem duplicar outbound já registrado;
- transição imediata para `human_active`, renovando `handoff_at` e impedindo debounce/lock/IA de responder ao mesmo turno;
- testes com mensagem do cliente, resposta da IA, envio pelo painel, envio pelo aparelho, dia/hora, autoria, handoff/silêncio, reentrega, duplicidade e campos obrigatórios ausentes.

Sem qualquer item, a capability deve permanecer indisponível e nenhuma UI, documentação comercial ou cutover pode anunciar paridade.

### Configuração mínima por provider

| Provider | Configuração obrigatória | Eco humano | ID e tempo |
|---|---|---|---|
| Z-API | Callback "Ao receber" e `notifySentByMe: true` | `fromMe: true` e `fromApi: false`; `fromApi: true` é eco da API | `messageId`; `momment` em milissegundos |
| WAHA | Assinar `message.any`; sessão vazia é normalizada como `default` em envio, status e binding do webhook | `fromMe: true` e `source: "app"`; `source: "api"` é eco da API | `payload.id`; `payload.timestamp` em segundos |
| UazAPI | Assinar `messages` e excluir `wasSentByApi`; nunca excluir `fromMeYes` | `fromMe: true` e `wasSentByApi: false` | `messageid`; `messageTimestamp` em milissegundos |
| Meta Cloud API | Somente WhatsApp Business App Coexistence: Embedded Signup com `featureType: "whatsapp_business_app_onboarding"` e assinatura de `smb_message_echoes` | `changes[].field === "smb_message_echoes"`; consumir `value.message_echoes[]` e usar `to` como contato | `id`; `timestamp` Unix em segundos |

Na Meta, Cloud API comum não tem envio manual pelo mesmo número no app e não é paritária. Antes de habilitar a capability, confirme `is_on_biz_app: true` e `platform_type: "CLOUD_API"`. Coexistence exige Parceiro de Soluções/Provedor de Tecnologia, limita o número a 20 mps, não sincroniza grupos e não garante webhooks para clientes complementares incompatíveis (WhatsApp para Windows/WearOS). Referências oficiais: [Z-API](https://developer.z-api.io/en/webhooks/update-notify-sent-by-me), [WAHA](https://waha.devlike.pro/docs/how-to/events/), [UazAPI](https://docs.uazapi.com/openapi-bundled.json) e [Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users).

## Cutover e rollback

O cutover é prepare → connect → validate → activate. Enquanto o alvo não conecta, o canal antigo continua `is_active=true` e é o único usado para envio/inbound. Além do health check, o banco exige `manual_echo_verified_at`: em Z-API/WAHA/Meta, envie uma mensagem de teste pelo celular e aguarde o callback válido; na UazAPI, o lifecycle grava a prova após confirmar a configuração remota. Alterar credenciais ou rotacionar o secret invalida a prova e exige novo teste. Sem prova, o trigger recusa `is_active=true`; `activate_whatsapp_channel` troca os flags na mesma transação somente depois dela.

Rollback reutiliza a linha anterior: teste/conecte o canal preservado, solicite ativação e execute o mesmo cutover. Não sobrescreva credenciais Z-API e não delete a linha antiga como parte da troca.

## Webhook e segurança

- Endpoint único: `webhook-whatsapp?channel=<uuid>&secret=<secret-aleatorio>`.
- O OpenAPI UazAPI não especifica HMAC. Não inventar assinatura: validar secret por canal em tempo constante, token/instance do payload quando presentes e vínculo `channel_id → unit_id`.
- Canal inativo pode receber callback de conexão/entrega e eco humano apenas para comprovar a configuração; não entra em CRM/conversa/IA nem envia resposta.
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
5. Validar uma unidade de teste: criar → QR → conectar → inbound → outbound → delivery status → eco humano do aparelho → autoria/data/hora → handoff e silêncio da IA → reentrega sem duplicidade → desconectar/reconectar.

Não fazer deploy das Edge Functions antes da migration: os guards leem colunas novas e falham fechados. Não fazer `db push`, deploy ou rotação de secrets por copiar este runbook; essas mutações exigem autorização operacional específica.

## Referência do provider

Contratos usados: OpenAPI UazAPI v2.1.1 (`/instance/create`, `/instance/all`, `/webhook`, `/instance/connect`, `/instance/status`, `/instance/disconnect`, `/instance/reset`, `/send/text`): <https://docs.uazapi.com/openapi-bundled.json>.
