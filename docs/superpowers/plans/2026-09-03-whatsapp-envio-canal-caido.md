# Envio com canal caído e descarte de mensagem vencida — plano

Spec: [2026-09-03-whatsapp-envio-canal-caido-design.md](../specs/2026-09-03-whatsapp-envio-canal-caido-design.md).

## Tarefa 1 — Núcleo puro do prazo de validade

- Testes vermelhos em `src/lib/whatsapp-message-ttl-core.test.ts`: um par (válido / vencido) por `kind` da tabela da spec, fronteira exata do prazo, `reminder_d1` e `confirmation` vencendo pelo horário da reserva em BRT, `kind` desconhecido fail-open, `factAt` ausente fail-open.
- Implementar `supabase/functions/_shared/whatsapp-message-ttl-core.ts` até passarem: `decideMessageValidity({ kind, factAt, now })`, sem I/O, sem `Date.now()` interno.
- Tabela de prazos exportada como constante única — nunca redigitada nos consumidores.

## Tarefa 2 — Aplicar o prazo nos três produtores

- `send-whatsapp`: aceitar `fact_at` no payload, consultar o núcleo antes de `sendWhatsApp`, descartar em silêncio com `jsonLog` (`evt: "message_expired_discarded"`) e **não** gravar `notifications_sent`. Resposta 200 com `{ discarded: true, reason }` — descarte não é erro do caller.
- Produtores passam `fact_at`: `process-waitlist-entered` (`waitlist.created_at`), `process-waitlist-feedback`, `process-reservation-reminders`, `process-satisfaction-surveys`, `process-voucher-triggers`, e o frontend em `useWaitlist.ts` para `waitlist_table_ready`.
- `resend-notification`: consultar o núcleo antes de rotear e devolver motivo legível em PT-BR ao painel.
- `process-notification-outbox`: integrar ao `stillValid` existente sem duplicar a regra de vencimento.

## Tarefa 3 — Não postar em canal sem conexão confirmada

- Remover `requiresConnectedProjection = provider === "uazapi"` de `_shared/whatsapp-send.ts`; exigir `status='connected'` nos dois caminhos, todo provider.
- Tratar a projeção como perecível: `last_health_check_at` além de `CHANNEL_FRESHNESS_MS` (5 min) dispara `getConnectionStatus` do adapter e persiste por `record_whatsapp_channel_status` antes de decidir.
- Fail-closed: erro de transporte, credencial ou persistência recusa o POST com `whatsapp_not_connected`. Polaridade oposta à do gate de billing — comentar o porquê no arquivo.
- Cache por invocação (`clearChannelFreshnessCache()`), zerado pelos mesmos callers que já zeram o cache do gate. Uma consulta por canal por invocação.
- Não aplicar ao agente em `webhook-whatsapp`.

## Tarefa 4 — Observação periódica do canal

- Criar `process-whatsapp-channel-health` (auth `x-internal-key`, `verify_jwt = false` em `config.toml`).
- Varrer canais `is_active = true` mais legados `NULL` conectados, mesma regra de binding de `whatsapp-send.ts`; pular adapter sem `getConnectionStatus`.
- Persistir por `record_whatsapp_channel_status`; falha em um canal não interrompe os demais.
- Migration idempotente do `pg_cron` `*/5 * * * *`, wrapper `SECURITY DEFINER` lendo `internal_api_key` e `project_url` do Vault — sem literal de URL nem de chave, conforme o guardrail estático.

## Tarefa 5 — Documentar e verificar

- Registrar as invariantes em `CLAUDE.md` **e** `AGENTS.md`, semanticamente sincronizados, no mesmo commit: prazo de validade, fail-closed do envio, worker de health, e as novas linhas da matriz de redeploy.
- Atualizar a tabela de workers do `CLAUDE.md` com `process-whatsapp-channel-health`.
- `npm run typecheck` (`tsc -b --noEmit`), `npm run lint`, `npm test`.
- Gates `saas-shield-br`: `rls-auditor` e `migration-validator` (migration do cron), `secret-hunter` (migration + EF nova), `tenant-isolation-auditor` (varredura cross-unit do worker), `integration-reliability-auditor` (fail-closed e retry).
- Revisar `git diff` e `git diff --cached` linha a linha antes do commit; conferir o check `acl-estatico` no PR.
