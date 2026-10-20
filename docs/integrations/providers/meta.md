# Provedor: Meta (WhatsApp Business Platform / Graph API)

> Complementa `docs/standards/INTEGRATIONS.md` e não pode enfraquecê-lo.
> Itens marcados com **[verificar]** dependem da documentação vigente da Meta. Confirme antes de implementar e registre o link e a data.

- Tipo: oficial
- Capacidade: messaging (e, se usado, páginas/Instagram)
- Versão da Graph API: {{vX.Y}} **[verificar]** — fixada em configuração do adapter. Acompanhe o calendário de deprecação da Meta.
- Última verificação: {{AAAA-MM-DD}}

## Credenciais

- Access token só no servidor. Para integração de longo prazo, use token de system user **[verificar]**.
- App Secret no secret store; ele assina os webhooks.
- O verify token (usado só no desafio GET de configuração) é um valor separado do App Secret e **não** substitui a verificação de assinatura dos POSTs.
- Por tenant: WABA ID e phone number ID ficam em `integration_connection`. Os tokens ficam no Vault, referenciados.

## Webhooks

- **Autenticidade:** HMAC-SHA256 do corpo **bruto** com o App Secret, comparado em tempo constante ao header `X-Hub-Signature-256` (formato `sha256=<hex>`). Exemplo em INTEGRATIONS §12.
- **Tenant:** WABA/phone number ID do evento → conexão → `company_id`. Nunca outro campo do payload.
- **Deduplicação:** um POST pode trazer várias mudanças. Deduplique por item: id da mensagem para mensagens recebidas; id da mensagem + status para atualizações de status.
- **Ordem:** não presuma ordem entre atualizações de status. A máquina de estados impede regressão (ex.: `read` não volta para `delivered`); `failed` tem tratamento próprio.

## Templates

- Ciclo de vida local espelhando o remoto: rascunho → enviado para aprovação → aprovado | rejeitado | pausado | desativado **[verificar estados vigentes]**. Sincronize periodicamente.
- O conteúdo aprovado é imutável no sistema. Alterar exige nova submissão e nova versão local.
- Categorias, regras de uso e preços **[verificar]**: não codifique de memória.

## Políticas de envio

- Janela de atendimento ao cliente e uso obrigatório de template fora dela **[verificar regras vigentes]**.
- Opt-in registrado e opt-out funcional, verificados **no momento do envio** (INTEGRATIONS §16.4).
- Limites de mensagens por número e quality rating **[verificar valores vigentes]**: ajuste o rate limit e o monitoramento a eles.
- Envio em massa com rate limit, auditoria e idempotência por mensagem.

## Capacidades verificadas

| Pergunta | Resposta | Fonte |
|---|---|---|
| Idempotência remota no envio | **[verificar]** | |
| Consulta de status por id | **[verificar]** | |
| Assinatura de webhook | Sim — `X-Hub-Signature-256` | {{link}} |
| Ordem garantida | Não presumir | |
| Reentrega de webhooks | **[verificar]** | |

## Mapeamento de erros

| Erro do provedor | Erro normalizado | Retry? |
|---|---|---|
| {{código}} | | |
