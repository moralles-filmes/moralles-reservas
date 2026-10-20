# Provedor: Z-API (WhatsApp não oficial)

> Complementa `docs/standards/INTEGRATIONS.md` e não pode enfraquecê-lo.
> Itens marcados com **[verificar]** dependem da documentação vigente da Z-API. Confirme antes de implementar e registre o link e a data.

- Tipo: **não oficial**. Riscos a registrar e comunicar: dependência de uma sessão do WhatsApp em um aparelho, possibilidade de bloqueio do número e termos de uso do WhatsApp.
- Capacidade: messaging
- Última verificação: {{AAAA-MM-DD}}

## Credenciais e redaction

- O id e o token da instância fazem parte do **path** da URL (`/instances/<id>/token/<token>/...`) **[verificar formato vigente]**. A URL inteira é segredo. Redija URLs em logs, traces, breadcrumbs do Sentry, mensagens de erro de `fetch` e qualquer exceção serializada.
- Token de segurança da conta em header (`Client-Token`), quando habilitado **[verificar]**. Fica no servidor e no secret store.
- Host fixo em allowlist (`api.z-api.io` **[verificar]**), redirects bloqueados.
- Por tenant: id da instância em `integration_connection.external_account_id`; tokens no Vault.

## Envio

- Idempotência local por mensagem (`company_id` + intenção + id de negócio). Não presuma idempotência remota **[verificar]**.
- Timeout explícito. Resultado ambíguo vira `UNKNOWN` e é reconciliado pelo webhook de status ou por consulta **[verificar endpoint de consulta]**. Sem confirmação, não reenvie automaticamente.
- Rate limit **por instância**, com espaçamento entre mensagens compatível com a política anti-bloqueio do projeto. Estado no Postgres.
- Health da instância (conectada/desconectada) monitorado. Circuit breaker por instância (N2).
- Kill switch por instância e global, sem deploy.
- Nunca fazer fallback automático para Meta (ou vice-versa) quando houver chance de duplicar a mensagem.

## Webhooks

- **Autenticidade:** verifique se a Z-API assina os webhooks **[verificar]**. Se não assinar, use o fallback de INTEGRATIONS §12: segredo aleatório por conexão no path, comparação em tempo constante e rotação. Antes de agir sobre evento crítico, confirme via API.
- **Tenant:** id da instância → conexão → `company_id`.
- **Deduplicação e ordem:** id da mensagem + tipo de evento; máquina de estados sem regressão.

## Capacidades verificadas

| Pergunta | Resposta | Fonte |
|---|---|---|
| Idempotência remota | **[verificar]** | |
| Consulta de status por id | **[verificar]** | |
| Assinatura de webhook | **[verificar]** | |
| Ordem garantida | Não presumir | |
| Limites de taxa documentados | **[verificar]** | |

## Mapeamento de erros

| Erro do provedor | Erro normalizado | Retry? |
|---|---|---|
| {{código}} | | |
