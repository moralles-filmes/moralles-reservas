# WhatsApp multi-provider com UazAPI — design

## Contexto e objetivo

O sistema já opera WhatsApp por unidade através de `whatsapp_channels` e de uma pipeline única em `webhook-whatsapp`, mas a camada de provider é um dispatcher condicional para Z-API, WAHA e Meta. Esta mudança adiciona UazAPI com provisionamento automático, preserva integralmente o fluxo manual Z-API e transforma a integração existente em um registry extensível.

O pedido do usuário anexado a esta tarefa é a especificação de produto aprovada. Este documento fixa as decisões encontradas durante a auditoria do repositório e resolve ambiguidades de implementação sem reduzir os critérios de aceite originais.

## Auditoria do estado atual

- `organizations` é o cliente SaaS, `units` é a fronteira operacional e `whatsapp_channels` guarda provider, credenciais, status e segredo de webhook por unidade.
- `whatsapp_channels` usa `FORCE RLS`; somente Edge Functions com service role leem credenciais. Hoje elas ficam em JSONB sem criptografia de aplicação.
- Providers atuais são `zapi`, `waha` e `official`. Todos continuam suportados; a feature apenas adiciona `uazapi`.
- A pipeline inbound já é única: resolver canal → validar webhook → callback de entrega/parse inbound → dedupe → conversa/debounce/lock → IA → `sendOutbound`.
- Z-API é configurada manualmente em `/platform/automacao/:unitSlug`; o portal do cliente não tem tela nem permissão para gerenciar canal.
- O envio por unidade escolhe o primeiro canal `connected`, portanto não existe cutover seguro quando duas configurações coexistem.
- `processed_messages` deduplica apenas por `message_id`; a identidade precisa incluir provider para evitar colisões cross-provider.
- `whatsapp_instances` é inventário financeiro/auditável, separado do canal operacional. A feature o mantém como inventário e passa a aceitar `uazapi`, sem armazenar tokens.
- O provisionamento real está deliberadamente bloqueado até existir criptografia em repouso. UazAPI usará Supabase Vault para o token de instância; o `admintoken` permanece exclusivamente em Edge Function secret.
- Baseline auditado: 1201 testes passam e typecheck passa, mas não há testes de `whatsapp-providers.ts`, webhook ou outbound.

## Princípios

1. Z-API mantém payloads, credenciais, endpoint de webhook e UX manual atuais.
2. Regra de negócio, IA, agenda, CRM, conversa, billing e filas permanecem únicas.
3. Detalhes de provider ficam em adapters registrados centralmente.
4. Provider operacional pertence ao canal; `organizations.default_whatsapp_provider` é apenas herança para novos canais/unidades.
5. Troca é prepare → connect → validate → atomic cutover. Nunca se ativa provider não conectado.
6. Configuração anterior é preservada e pode ser reativada; exclusão é ação separada.
7. UazAPI ausente ou mal configurada degrada somente UazAPI. Z-API continua funcionando.
8. Nenhum segredo, QR ou payload sensível é logado ou retornado ao portal além do QR efêmero solicitado pelo usuário autorizado.

## Contrato e registry

O core expõe `getWhatsAppProvider(name)` e metadados serializáveis para a UI:

```ts
interface WhatsAppProviderAdapter {
  name: WhatsAppProviderName;
  label: string;
  capabilities: WhatsAppProviderCapabilities;
  parseInbound(payload: unknown): InboundMessage | null;
  peekInboundMedia(payload: unknown): InboundMediaPeek | null;
  parseStatusCallback(payload: unknown): StatusUpdate[] | null;
  sendText(credentials: ResolvedChannelCredentials, message: OutboundMessage): Promise<SendResult>;
  getConnectionStatus?(credentials: ResolvedChannelCredentials): Promise<ProviderConnectionSnapshot>;
}
```

Capabilities iniciais: `manualCredentials`, `automaticProvisioning`, `qrConnection`, `pairCode`, `automaticWebhook`, `disconnect`, `restart` e `deliveryReceipts`. Métodos administrativos UazAPI vivem no adapter UazAPI e são chamados apenas pelo serviço de lifecycle de canal.

`whatsapp-providers.ts` permanece como fachada compatível para os consumidores atuais, mas resolve tudo pelo registry. Não haverá branching de provider em telas ou workers; a UI reage a capabilities.

## Estados e erros normalizados

Estados operacionais persistidos:

- `not_configured`
- `provisioning`
- `waiting_qr`
- `connecting`
- `connected`
- `disconnected`
- `reconnecting`
- `suspended`
- `provider_error`
- `switching_provider`
- `error` (alias legado preservado)

Estados nativos UazAPI mapeiam assim: `disconnected → disconnected`, `connecting → connecting` ou `waiting_qr` quando há QR, `connected → connected`, `hibernated → suspended`.

Erros normalizados: `AUTH_ERROR`, `INSTANCE_NOT_FOUND`, `NOT_CONNECTED`, `QR_REQUIRED`, `CAPACITY_EXCEEDED`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `TIMEOUT`, `INVALID_REQUEST` e `UNKNOWN_PROVIDER_ERROR`. HTTP 429 no provisionamento/conexão UazAPI vira `CAPACITY_EXCEEDED`; mensagens técnicas ficam apenas nos logs estruturados sanitizados.

## Modelo de dados

### `organizations`

Adicionar `default_whatsapp_provider text not null default 'zapi'` com CHECK incluindo os quatro providers existentes. Backfill explícito mantém toda organização atual em `zapi`.

### `whatsapp_channels`

`whatsapp_channels` já é o binding por provider; criar uma segunda tabela com a mesma identidade seria duplicação. Cada configuração preservada continua sendo uma linha própria. Adições:

- estados normalizados no CHECK;
- `is_active boolean` para distinguir o canal operacional do preparado/inativo;
- `instance_token_secret_id` apontando o token UazAPI no Vault;
- `external_instance_id`, `connected_at`, `last_health_check_at` e `provisioning_started_at`;
- provider CHECK incluindo `uazapi`;
- UNIQUE parcial para uma linha UazAPI por unidade, impedindo double-click de criar placeholders concorrentes;
- UNIQUE parcial para no máximo um canal explicitamente ativo por unidade.

Não remover, renomear, transformar nem limpar `provider`, `credentials`, `webhook_secret` ou qualquer dado Z-API. Trocar provider cria/reutiliza outra linha de `whatsapp_channels`; a anterior apenas recebe `is_active=false` no cutover.

`is_active` nasce nullable por compatibilidade de rollout. A migration marca automaticamente apenas unidades inequívocas (um único canal conectado, ou um único canal total). Unidades com múltiplos canais legados ficam com `NULL` e preservam o comportamento atual até revisão administrativa; o código usa o primeiro conectado como antes enquanto não existir nenhum `is_active=true`. Nenhum backfill escolhe silenciosamente entre canais ambíguos.

### Vault

Funções `SECURITY DEFINER` internas, com `search_path` fixo e EXECUTE revogado de `PUBLIC`, `anon` e `authenticated`, criam/atualizam/leem o token UazAPI no Supabase Vault. Apenas `service_role` recebe EXECUTE. O nome do segredo contém UUID interno, nunca nome de empresa. O token não aparece em `whatsapp_channels`, na tabela filha, em logs ou respostas ao frontend.

### Dedupe

`processed_messages` recebe `provider` e a chave passa a ser `(provider, message_id)`. Linhas existentes são backfilled como `zapi`, preservando o comportamento legado. Toda operação do webhook usa ambos os campos.

## UazAPI oficial v2.1.1

Contratos verificados no OpenAPI oficial atual:

- `POST /instance/create`, header `admintoken`, body `name`, `adminField01`, `adminField02`;
- `GET /instance/all`, header `admintoken`, para reconciliação por `adminField01 = channel_id`;
- `POST /webhook`, header `token`, modo simples com eventos `messages`, `messages_update`, `connection` e `excludeMessages: ["wasSentByApi"]`;
- `POST /instance/connect`, header `token`, sem `phone` para QR;
- `GET /instance/status`, header `token`, fonte de status/QR/número;
- `POST /instance/disconnect` e `POST /instance/reset`, header `token`;
- `POST /send/text`, header `token`, body `number` e `text`.

Todas as chamadas têm timeout. GET/status pode ter retry limitado; criação não é repetida cegamente. Após timeout de criação, a próxima tentativa lista instâncias e reconcilia pelo `adminField01` estável antes de criar.

O OpenAPI não define assinatura HMAC de webhook. A autenticação usa o segredo aleatório no URL por configuração, comparação constant-time, validação do `token`/instance correspondente recebido no payload quando presente e rejeição de config inativa para eventos de mensagem. Não será inventado HMAC.

## Provisionamento idempotente

1. Usuário autenticado chama `connect` para um canal UazAPI.
2. Backend valida JWT, role owner/gerente ou platform admin, unit/channel e gates de serviço/entitlement.
3. Claim atômico muda o canal elegível para `provisioning`. Requests concorrentes recebem o snapshot em andamento e não chamam o provider.
4. Se o token ainda não existe, reconciliar `GET /instance/all` por `adminField01=channel_id`; criar apenas se ausente.
5. Gravar token no Vault e identificador externo na config antes do passo seguinte.
6. Configurar webhook automaticamente.
7. Chamar connect sem telefone e obter QR/status.
8. Retornar QR efêmero e persistir apenas estado/timestamps.
9. Polling controlado chama status. Ao observar `connected`, realiza cutover atômico quando o canal era uma troca.

Claim expirado permite reconciliação; nunca cria nova instância só porque QR expirou.

## Troca de provider

- `begin_switch` é ação exclusiva de platform admin e cria/reutiliza o canal alvo inativo, mantendo o atual ativo.
- Durante `switching_provider`, mensagens e envios continuam exclusivamente pela projeção ativa antiga.
- UazAPI alvo pode provisionar/configurar/gerar QR, mas eventos `messages` de canal inativo são reconhecidos e ignorados.
- Após status `connected`, uma RPC transacional marca o canal antigo inativo e o alvo ativo, atualiza timestamps e escreve auditoria sanitizada.
- O webhook exige canal ativo depois que a unidade entra no modelo explícito, impedindo duas IAs mesmo que o segredo antigo continue preservado para rollback.
- Retorno para Z-API reutiliza a linha anterior. Z-API permanece manual: o admin atualiza/testa credenciais se necessário; cutover só ocorre após health conectado.

## RBAC e tenancy

- Provider default, criação manual, edição de credenciais, switch e diagnóstico técnico: platform admin.
- `list_client`, `connect`, `refresh_qr`, `status`, `disconnect` e `restart` UazAPI: owner/gerente da própria unidade ou platform admin.
- Operador não acessa lifecycle do canal.
- Toda action resolve `channel_id` junto com `unit_id`; service role nunca aceita apenas um UUID sem conferir tenancy.
- QR, token e external ID não cruzam tenants; external ID aparece somente no diagnóstico platform admin.

## UI

### Plataforma

- “Nova empresa” recebe seletor Z-API/UazAPI, default Z-API.
- Edição mostra/altera o default sem provisionar.
- Automação mantém os formulários Z-API/WAHA/Meta atuais.
- UazAPI cria configuração local sem campos de token e apresenta preparar/conectar/status/diagnóstico.
- Troca por canal usa diálogo de confirmação e estados prepare/connect/activate; nunca sobrescreve config antiga.

### Cliente

Nova rota `/g/:unitSlug/whatsapp`, item “WhatsApp” para owner/gerente. A tela não revela nome do provider ou credenciais:

- não configurado/desconectado: conectar;
- provisioning: progresso;
- waiting QR/connecting: QR e instruções;
- conectado: online, número e última conexão;
- erro: mensagem neutra e retry/reconnect.

Polling de 5 s somente nos estados transitórios, suspenso quando `document.hidden`; estados estáveis não fazem polling agressivo.

## Observabilidade e auditoria

Logs estruturados incluem `event`, `provider`, `organization_id`, `unit_id`, `channel_id`, `external_instance_id`, `request_id`, `status`, duração e código normalizado. Nunca incluem token, admintoken, QR ou conteúdo de mensagem.

Ações provider selected/changed, provisioning, connect/disconnect, activation, QR requested e errors são escritas em um ledger sanitizado próprio. O trigger genérico de `audit_log` não pode ser aplicado a `whatsapp_channels`, pois copiaria o JSONB de credenciais.

## Compatibilidade de rollout

1. Aplicar migration aditiva.
2. Deploy de `manage-organizations` e `manage-channels` compatíveis com snapshots ausentes.
3. Deploy conjunto de toda EF consumidora dos helpers WhatsApp alterados: `webhook-whatsapp`, `send-whatsapp`, `send-confirmation`, `send-cancellation`, `send-manual-message`, `manage-channels` e `whatsapp-health`.
4. Deploy frontend.
5. Configurar `UAZAPI_BASE_URL` e `UAZAPI_ADMIN_TOKEN` via `supabase secrets set`.

Sem as envs, adapters Z-API/WAHA/Meta seguem funcionando e ações UazAPI respondem erro de configuração localizado.

## Testes obrigatórios

- registry/capabilities e provider inválido;
- regressão parse/send/status Z-API;
- UazAPI parse de texto/mídia/status, send text e erros 401/429/timeout;
- provisionamento create once, reuse, double click, timeout+reconcile;
- QR expirado reutiliza instância;
- webhook UazAPI converge para a pipeline e desconhecido retorna 200 sem IA;
- dedupe `(provider,message_id)`;
- canal inativo não processa mensagem;
- cutover Z-API→UazAPI e rollback UazAPI→Z-API preservam linhas e uma ativa;
- membership/tenant isolation e operador negado;
- ambiente sem env UazAPI não afeta Z-API;
- migration legada backfill Z-API;
- typecheck, lint, testes, build, preflight SQL, ACL estático e auditorias de RLS/tenant/auth/migration/secrets/integration.

## Fora de escopo

- Implementar Meta, WAHA ou novos providers além de preservar os atuais.
- Pair code na UI; capability fica preparada, QR é obrigatório.
- Download/processamento novo de mídia. O comportamento atual de responder texto a mídia é preservado.
- Deletar instância UazAPI automaticamente.
- Deploy, `db push`, rotação de secrets ou qualquer mutação em produção sem autorização separada.
