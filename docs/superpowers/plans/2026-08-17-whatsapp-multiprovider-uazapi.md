# Plano de implementação — WhatsApp multi-provider com UazAPI

## Objetivo

Implementar o design aprovado em `docs/superpowers/specs/2026-08-17-whatsapp-multiprovider-uazapi-design.md` de forma aditiva, com UazAPI automatizada, Z-API sem regressão, cutover seguro por unidade e credenciais UazAPI protegidas no Supabase Vault.

## Regras de execução

- Preservar as alterações preexistentes do usuário em `CLAUDE.md` e `AGENTS.md`.
- Não executar `db push`, deploy, configurar secrets ou chamar instância UazAPI real neste trabalho local.
- Usar mocks determinísticos para rede e fixtures sanitizadas; nenhum teste usa credencial real.
- Cada etapa recebe revisão funcional e de segurança antes do commit final.
- Mudanças em helpers compartilhados exigem a matriz completa de testes e redeploy documentada.

## Tarefa 1 — Caracterização e contrato central de providers

**Arquivos:**

- Criar `supabase/functions/_shared/whatsapp-provider-core.ts`.
- Refatorar `supabase/functions/_shared/whatsapp-providers.ts`.
- Refatorar `supabase/functions/_shared/whatsapp-status.ts`.
- Criar `src/test/whatsapp-provider-core.test.ts`.

**Passos:**

1. Capturar em testes os payloads Z-API atualmente aceitos, callbacks de status e shape de envio.
2. Definir tipos normalizados, capabilities, erros e registry com `getWhatsAppProvider` fail-closed.
3. Registrar Z-API, WAHA, Official e UazAPI; manter as exports públicas atuais como fachada compatível.
4. Implementar parser/status UazAPI tolerante apenas aos shapes oficiais conhecidos, sem fallback de ID ou timestamp inventado.
5. Implementar envio de texto UazAPI com timeout, erro normalizado e sem retry automático de POST mutante.
6. Rodar o teste focal e revisar diff para comprovar que os endpoints e payloads Z-API não mudaram.

## Tarefa 2 — Migration aditiva, RLS, Vault e RPCs atômicas

**Arquivos:**

- Criar migration com `supabase migration new whatsapp_multiprovider_uazapi`.
- Atualizar/adicionar testes em `supabase/tests/local-preflight/`.

**Passos:**

1. Adicionar `organizations.default_whatsapp_provider` com default/backfill `zapi` e CHECK dos providers.
2. Ampliar CHECKs de provider/status em `whatsapp_channels` e `whatsapp_instances`.
3. Adicionar a `whatsapp_channels` os campos de ativação, Vault, external instance e timestamps, com índices parciais de unicidade.
4. Fazer backfill conservador de `is_active`: selecionar apenas unidades inequívocas; manter ambiguidades legadas em `NULL`.
5. Migrar `processed_messages` para dedupe `(provider, message_id)` e garantir `FORCE ROW LEVEL SECURITY`.
6. Criar ledger sanitizado de lifecycle, com RLS apropriada e sem copiar `credentials`.
7. Criar RPCs service-role-only para claim/release de provisionamento, armazenamento/leitura de token via Vault e cutover atômico.
8. Revogar EXECUTE de `PUBLIC`, `anon` e `authenticated`, conceder somente a `service_role` e testar ACL/idempotência/constraints no preflight.

## Tarefa 3 — Cliente UazAPI e lifecycle idempotente

**Arquivos:**

- Criar `supabase/functions/_shared/uazapi-client.ts`.
- Criar `supabase/functions/_shared/whatsapp-channel-lifecycle.ts`.
- Atualizar `supabase/functions/_shared/whatsapp-instance-core.ts` e testes.
- Atualizar `supabase/functions/manage-channels/index.ts`.
- Atualizar `supabase/functions/whatsapp-health/index.ts`.

**Passos:**

1. Implementar chamadas oficiais `instance/create`, `instance/all`, `webhook`, `instance/connect`, `instance/status`, `instance/disconnect`, `instance/reset` e `send/text`.
2. Exigir `UAZAPI_BASE_URL` e `UAZAPI_ADMIN_TOKEN` apenas nas ações UazAPI e nunca retorná-los/logá-los.
3. Reconciliar create por `adminField01=channel_id` antes de repetir uma criação incerta.
4. Usar claim atômico para que double-click não crie duas instâncias; persistir token no Vault antes de configurar webhook/conectar.
5. Configurar webhook central automaticamente e retornar QR somente na resposta efêmera autorizada.
6. Expor actions separadas de platform admin e owner/gerente, validando JWT, membership, `unit_id` e `channel_id` em todas.
7. Integrar entitlement/allowance sem chamar novo provisionamento quando fail-closed; uma seleção explícita feita por platform admin é a aprovação auditável para provider novo.
8. Fazer health/status usar o registry e activation/cutover transacional, sem `if (provider)`.

## Tarefa 4 — Pipeline central, seleção ativa e correlação

**Arquivos:**

- Atualizar `supabase/functions/_shared/whatsapp-send.ts`.
- Atualizar `supabase/functions/webhook-whatsapp/index.ts`.
- Atualizar consumidores de `sendOutbound` conforme necessário.
- Adicionar testes focais de seleção/dedupe/webhook.

**Passos:**

1. Enviar exclusivamente pelo canal `is_active=true` quando existir; preservar a seleção legada atual quando nenhum canal estiver explicitamente ativo.
2. Rejeitar envio explícito por canal inativo e provider desconhecido.
3. Resolver webhook por `channel_id`, validar segredo e ignorar inbound de canal inativo depois da entrada no modelo explícito.
4. Usar `(provider, message_id)` em todo insert/update de dedupe.
5. Incluir `unit_id` e provider/canal disponíveis na correlação de delivery status para evitar colisão cross-tenant/provider.
6. Garantir que evento desconhecido ou payload inválido responda de forma segura sem disparar IA.
7. Manter a pipeline comum de CRM, conversa, debounce, lock, IA e outbound intacta.

## Tarefa 5 — Default organizacional e experiência de plataforma

**Arquivos:**

- Atualizar `supabase/functions/manage-organizations/index.ts`.
- Atualizar tipos/hooks/validação usados por `src/pages/platform/Empresas.tsx`.
- Atualizar `src/pages/gestao/Automacao.tsx` e componentes relacionados.

**Passos:**

1. Aceitar `default_whatsapp_provider` em create/update com allowlist estrita e default `zapi`.
2. Adicionar seletor Z-API/UazAPI em Nova Empresa e edição; salvar apenas a preferência, sem provisionar externamente.
3. Preservar integralmente o formulário manual Z-API e as ações existentes.
4. Renderizar ações UazAPI a partir das capabilities: preparar/conectar, QR, status, diagnóstico e switch confirmado.
5. Não expor token, secret ID, webhook secret ou payload do provider na UI.

## Tarefa 6 — Portal do cliente

**Arquivos:**

- Criar página/hook/componentes para `/g/:unitSlug/whatsapp`.
- Atualizar `src/App.tsx` e `src/components/layout/GestaoLayout.tsx` (ou caminhos reais equivalentes).
- Adicionar testes de RBAC/renderização/polling quando a infraestrutura existente permitir.

**Passos:**

1. Liberar rota e menu somente para owner/gerente; operador recebe guard/negação.
2. Mostrar apenas estados de negócio: conectar, preparando, QR, conectando, conectado e erro recuperável.
3. Implementar polling de 5 s apenas em estados transitórios e pausar quando `document.hidden`.
4. Permitir conectar, renovar QR, consultar status, desconectar e reiniciar sem revelar provider ou credenciais.

## Tarefa 7 — Documentação, configuração e hardening

**Arquivos:**

- Atualizar `.env.example`.
- Atualizar `CLAUDE.md` e `AGENTS.md` de forma semanticamente equivalente.
- Criar documentação operacional UazAPI em `docs/`.
- Atualizar o checklist de redeploy das Edge Functions importadoras.

**Passos:**

1. Documentar `UAZAPI_BASE_URL` e `UAZAPI_ADMIN_TOKEN` como Edge secrets sem valores reais.
2. Documentar criação, reconciliação, webhook, QR, cutover, rollback e diagnóstico.
3. Registrar invariantes permanentes: registry central, canal ativo, Vault, dedupe por provider e ausência de HMAC inventado.
4. Confirmar com `git diff -- CLAUDE.md AGENTS.md` que as regras continuam sincronizadas e as mudanças preexistentes foram preservadas.

## Tarefa 8 — Verificação, auditorias e entrega

**Gates:**

1. Testes focais de registry, Z-API, UazAPI, lifecycle, dedupe, cutover, RBAC e isolamento de tenant.
2. `npm run test`.
3. `npm run typecheck` (`tsc -b --noEmit`).
4. `npm run lint` e lint específico de Edge Functions.
5. `npm run build`.
6. Preflight SQL disponível no ambiente, ACL estático e `scripts/audit-function-acl.ts` quando houver banco real configurado.
7. Revisões separadas de backend, frontend e QA; auditorias explícitas de RLS, tenant isolation, auth, migration, secrets e confiabilidade de integração.
8. Revisar `git status`, `git diff`, staged e scan de secrets; adicionar somente caminhos explícitos.
9. Commitar na branch atual. Não fazer push nem deploy sem autorização específica.

## Critério de conclusão

A implementação só está concluída quando UazAPI pode ser selecionada, provisionada idempotentemente, conectada por QR e ativada sem duas pipelines; Z-API continua operacional sem alteração de contrato; segredos UazAPI ficam no Vault/Edge secrets; RBAC/tenant isolation e regressões estão cobertos; e todos os gates locais proporcionais ao risco passam ou têm limitação ambiental documentada.
