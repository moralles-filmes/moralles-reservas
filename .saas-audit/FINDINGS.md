# Findings consolidados

| ID | Sev | Estado | Resumo |
|---|---|---|---|
| MOD-datafy-whatsapp-001 | P2 | **rejeitado** | `.ai-router/` supostamente commitado. Desmentido: `git ls-files` vazio e regra em `.git/info/exclude:7`. O auditor não tinha shell e leu só o `.gitignore`. |
| MOD-datafy-whatsapp-002 | P2 | **corrigido (doc)** | A superfície de 500 no lote Meta é mais larga que o caso do `metadata`: qualquer `result.ok === false` de um filho propaga como 500. Spec corrigida; código não muda (alcançaria `official`). |
| MOD-datafy-whatsapp-003 | P3 | **aberto** | Dois canais ativos no mesmo `phone_number_id` (`official` + `datafy`) processariam a mesma mensagem duas vezes — a chave `(provider, message_id)` não colide entre providers por design. Provavelmente inatingível; decidir antes de migrar unidade existente. |
| MOD-datafy-whatsapp-004 | P3 | **informativo** | Lacunas declaradas pelos auditores: destino de `providerMessageId: undefined`; ordem de escrita no caminho Datafy; `.update().eq()` sem `.select()` em `applyDeliveryStatus` e `manual_echo_verified_at`. Todas pré-existentes e compartilhadas com os quatro providers — nenhuma introduzida por esta branch. |

**Zero P0. Zero P1.** Relatório completo: `.saas-audit/modules/datafy-whatsapp/REPORT.md`.
