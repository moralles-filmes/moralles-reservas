# Provedor: {{Nome}}

> Complementa `docs/standards/INTEGRATIONS.md` e não pode enfraquecê-lo.
> Registre só o que foi verificado na documentação oficial, com link. Nunca registre tokens, secrets ou ids sensíveis.

- Status: {{ativo | em avaliação | descontinuado}}
- Tipo: {{oficial | não oficial}} — riscos conhecidos: {{...}}
- Capacidade(s): {{messaging | payments | email | ...}}
- Porta implementada: {{MessagingProvider}} — adapter `{{caminho}}`
- Documentação oficial: {{link}}
- Versão da API em uso: {{...}} — centralizada em `{{arquivo de config do adapter}}`
- Última verificação: {{AAAA-MM-DD}}

## Capacidades verificadas

Responda com "sim", "não" ou "não documentado". Não presuma.

| Pergunta | Resposta | Fonte |
|---|---|---|
| Aceita chave de idempotência remota? | | |
| Tem consulta de status por id? | | |
| Assina webhooks? Algoritmo e header? | | |
| Garante ordem dos eventos? | | |
| Política de reentrega de webhooks | | |
| Limites de taxa | | |
| Sandbox disponível? | | |
| Permite revogar tokens? | | |

## Autenticação e endpoints

- Como autentica: {{header Bearer | token no path | OAuth}}
- O que precisa de redaction: {{headers, URLs inteiras se o token vai no path}}
- Hosts permitidos (allowlist): {{...}}

## Webhooks

- Como verificar a autenticidade: {{assinatura X | segredo no path, se o provedor não assina}}
- Campo que identifica a conta externa (→ `integration_connection.external_account_id`): {{...}}
- Id de deduplicação do evento: {{...}}
- Máquina de estados e transições válidas: {{ex.: queued → sent → delivered → read; failed é terminal}}

## Mapeamento de erros

| Erro do provedor | Erro normalizado | Retry? |
|---|---|---|
| | | |

## Particularidades operacionais

- {{limites, janelas de envio, requisitos de consentimento, comportamentos inesperados confirmados}}
