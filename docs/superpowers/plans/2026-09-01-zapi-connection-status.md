# Corrigir status real da conexão Z-API — plano

## Tarefa 1 — Caracterizar o contrato no core

- Adicionar testes vermelhos para respostas `/status` conectada, desconectada, HTTP inválido e payload inválido.
- Adicionar testes vermelhos para `ConnectedCallback`, `DisconnectedCallback` e payload alheio.
- Implementar funções puras em `whatsapp-provider-core.ts` até os testes passarem.

## Tarefa 2 — Integrar no registry

- Fazer `getZApiConnectionStatus` usar corpo e status HTTP no parser puro.
- Registrar `parseConnectionCallback` no adapter Z-API sem branching em consumidores.
- Confirmar que o webhook compartilhado persiste o snapshot existente sem alteração de contrato.

## Tarefa 3 — Generalizar a persistência privilegiada

- Criar migration idempotente para `record_whatsapp_channel_status` aceitar o provider real da linha bloqueada por `(unit_id, channel_id)`.
- Preservar `SECURITY DEFINER`, `search_path` vazio e EXECUTE somente de `service_role`.
- Cobrir no preflight Z-API, UazAPI, provider correto no ledger e ACL.
- Fazer o teste manual persistir `snapshot.status`, inclusive `disconnected`, em vez de reduzir todo `connected:false` a `error`.

## Tarefa 4 — Documentar e verificar

- Registrar a invariante em `CLAUDE.md` e `AGENTS.md` de forma semanticamente equivalente.
- Rodar testes direcionados, `npm run typecheck`, `npm run lint`, suíte e build conforme o risco.
- Revisar diff, secrets staged e matriz de redeploy.
- Fazer reviews de implementação, segurança/tenancy e branch completa antes de integrar.

## Tarefa 5 — Fechar a lacuna encontrada em produção

- Fazer `list_client` observar canais manuais pelo adapter do registry e persistir o snapshot com `record_whatsapp_channel_status` antes de devolver o shape client-safe.
- Fazer WAHA interpretar o `status` do payload (`WORKING` como único conectado) antes de habilitar a reconciliação genérica.
- Em falha de transporte, credencial ou persistência, falhar fechado como `provider_error`; nunca conservar `connected` sem uma observação válida.
- Manter credenciais e detalhes do provider apenas na Edge Function.
- Adicionar polling visibility-aware de 30 segundos para estados configurados estáveis, preservando 5 segundos para transitórios e desabilitando-o para aba oculta, `not_configured` e `suspended`.
- Escolher `status` versus `list_client` pela capability `lifecycle_available`, não pelo valor transitório/estável do status.
- Aplicar freshness/lease atômico de 30 segundos no backend para coalescer chamadas concorrentes e impedir bypass do intervalo do frontend.
- Cobrir a reconciliação no guardrail de wiring e os intervalos no teste do hook.
- Publicar o frontend e as oito EFs da matriz do registry (`webhook-whatsapp`, quatro envios, `manage-channels`, `whatsapp-health`, `manage-organizations`), depois validar o fluxo real na unidade afetada.
