---
paths:
  - "supabase/functions/**"
  - "docs/integrations/**"
---

# Integrações — ao tocar provedor, webhook, worker ou chamada externa

Antes de alterar, leia `docs/standards/INTEGRATIONS.md`, a ficha do provedor em `docs/integrations/providers/` (quando existir) e a regra do assunto: WhatsApp → `whatsapp.md`, `whatsapp-templates.md`, `datafy.md`; IA → `agente-ia.md`; Stripe/Asaas → `billing.md`. A regra do assunto prevalece; esta lista o que vale para todo provedor. Confirme versão e contrato da API na documentação oficial; não codifique de memória.

- O provedor fica atrás de um adapter em `supabase/functions/_shared/` (ex.: `whatsapp-providers.ts`, `datafy-client.ts`, `ai-providers.ts`). URL, token e formato do provedor não vazam para o caso de uso nem para o frontend.
- **Webhook:**
  - autentique antes de qualquer `JSON.parse`: assinatura sobre o corpo **bruto** ou segredo comparado em tempo constante;
  - a unidade/organização vem da conexão vinculada à conta externa (canal, instância, conta), nunca de id no payload;
  - persista o evento com dedup durável antes de responder 2xx e processe pela fila/worker;
  - eventos chegam duplicados e fora de ordem: nenhum status regride.
- **Efeito externo** (mensagem, cobrança, e-mail): chave de idempotência com o tenant e a intenção; resultado ambíguo vira `UNKNOWN` e é reconciliado antes de qualquer repetição.
- **Retry automático** só em erro transitório **e** com repetição comprovadamente segura. Nunca em 4xx definitivo, validação ou autorização.
- **Fallback entre provedores** nunca é automático quando pode duplicar o efeito. Em IA, só em geração sem efeito externo, e sempre com a chave BYOK da unidade (sem fallback global).
- **Credenciais** só no servidor (`platform_secrets`, `ai_provider_credentials`, Edge secrets) e nunca em log, DTO ou erro. Z-API põe o token no path da URL: redija a URL inteira.
- **Testes, CI e previews** usam fake ou sandbox. Nunca disparam mensagem, cobrança, e-mail ou webhook real.
