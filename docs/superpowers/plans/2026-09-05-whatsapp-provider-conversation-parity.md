# Plano — paridade de conversas entre providers WhatsApp

## Tarefa 1 — contrato e caracterização

1. Adicionar fixtures e testes falhando para eco próprio Z-API, WAHA, UazAPI e Meta Coexistence.
2. Tornar `parseOwnMessageEchoes` obrigatório em `WhatsAppProviderAdapter`, preservando lotes completos da Meta.
3. Normalizar ID, destino, texto, timestamp em milissegundos, origem API/humana e identidade alternativa.
4. Preservar o comportamento inbound/status/send existente.

## Tarefa 2 — webhook genérico

1. Remover a decisão `provider === "zapi"` do eco.
2. Resolver eco pelo registry antes de inbound/mídia.
3. Deduplicar pelo provider e ID estável.
4. Ignorar ecos da API e grupos/newsletters.
5. Resolver conversa por customer conhecido ou identidade de chat aprendida, sem criar customer.
6. Anexar mensagem humana com timestamp original e silenciar a IA.

## Tarefa 3 — autoria e timestamp canônicos

1. Criar builder normalizado de mensagem de conversa.
2. Marcar writers como `customer`, `ai`, `automation` ou `human`.
3. Propagar timestamp original de texto, mídia e eco.
4. Manter fallback compatível para eventos legados sem timestamp confiável.

## Tarefa 4 — banco e UI

1. Criar migration via Supabase CLI para tornar `last_message_at` monotônico.
2. Atualizar preflight de idempotência/ACL da RPC.
3. Mostrar autoria explícita e separar IA de automações.
4. Ordenar a timeline de forma estável por epoch antes dos divisores de dia.

## Tarefa 5 — regra permanente e operação

1. Atualizar `CLAUDE.md` e `AGENTS.md` com regra semanticamente equivalente para providers futuros.
2. Documentar configuração obrigatória: Z-API `notifySentByMe`, WAHA `message.any`, UazAPI sem filtro `fromMeYes` e Meta apenas Coexistence.
3. Atualizar matriz de redeploy se surgir novo helper compartilhado.

## Tarefa 6 — revisão e entrega

1. Rodar testes focais, preflight SQL disponível, suite, typecheck, lint e build.
2. Revisar segurança, isolamento de tenant, idempotência, secrets e confiabilidade do webhook.
3. Revisar integralmente diff e staged, escanear secrets, adicionar apenas paths explícitos.
4. Commitar na branch, revisar whole-branch e integrar na branch de destino sem push/deploy.
