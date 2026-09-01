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
