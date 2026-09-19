# Plano: destravar os recibos de entrega da UazAPI

1. Criar branch a partir da `main` mergeada.
2. Escrever o caso de teste com o envelope **medido** (`payload.event`) em `src/test/whatsapp-provider-core.test.ts`, vendo-o reprovar antes da correção.
3. Estender `uazApiMessageFromEnvelope` para ler `event`, preservando `message`/`data`.
4. Reescrever `parseUazApiStatus`: mapa `Delivered`/`Read`/`Played`, um `StatusUpdate` por entrada de `MessageIDs`, descarte de `IsFromMe: true`, preservação da família de mensagem.
5. **Controle positivo:** restaurar o corpo antigo de `uazApiMessageFromEnvelope` e confirmar que o caso novo reprova; reverter.
6. Atualizar `CLAUDE.md` e `AGENTS.md` com a invariante permanente (par obrigatório, mesmo commit).
7. Rodar gates: `typecheck`, `test`, `lint`, `build`.
8. Gates `saas-shield-br`: `integration-reliability-auditor` (webhook/contrato de provedor) e `secret-hunter` (pré-commit).
9. Revisar `git status` / `git diff` / `git diff --cached` com escopo explícito, commitar, abrir PR, aguardar checks, mergear.
10. Redeployar as **nove** Edge Functions que importam `whatsapp-provider-core.ts`.
11. Verificar em produção: recibos passam de `ignored_non_text` a `status_callback` e `notifications_sent.delivered_at` começa a encher.
