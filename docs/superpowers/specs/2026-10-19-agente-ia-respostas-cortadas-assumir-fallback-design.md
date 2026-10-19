# Agente de IA: respostas cortadas, "Assumir" sem relógio, calendário de dias e provedor reserva — design

**Estado:** aprovada pelo responsável em 2026-10-19 para plano, implementação e testes locais. Não há migration. O deploy de `webhook-whatsapp` e o push do frontend exigem autorização própria depois dos gates.

## Evidência (produção `gbabxcrntkwgblgqsiit`, leitura)

- **Corte real ao cliente.** Polli, Ren Sushi, 13/10 21:50 UTC: a resposta foi gravada **e enviada** com 136 caracteres, terminando em "(6". O log `agent_unexpected_stop` traz `finish_reason: MAX_TOKENS`, com `output_tokens: 41`. No Gemini 2.5, o raciocínio interno (`thoughtsTokenCount`) consome o mesmo `maxOutputTokens: 1024`. O código loga o corte e devolve o texto parcial ([ai-providers.ts](../../../supabase/functions/_shared/ai-providers.ts) `runGemini`). Nas últimas 24h foram 2 cortes em 64 chamadas.
- **IA "não respondeu amanhã".** Thiago, 14/10 23:17 UTC: a conversa estava `human_active` com `assigned_to` preenchido, sem mensagem humana e com `handoff_at` NULL. Alguém clicou "Assumir", e só o lembrete de atendimento humano saiu. `assumeConversation` ([useConversations.ts](../../../src/hooks/useConversations.ts)) não grava `handoff_at`, e o auto-resolve de 12h usa `max(handoff_at, última mensagem humana)`. Com os dois zerados, a IA fica calada para sempre. A conversa foi devolvida manualmente à IA em 19/10, com autorização.
- **Raciocínio de data.** O prompt informa só "Hoje é quarta-feira, 14/10/2026". "Amanhã", "sábado" ou "dia 18" exigem que o modelo calcule o dia da semana sozinho, antes de aplicar a Regra 11 (preço por dia).
- **Sobrecarga.** Polli, 13/10 21:52: Flash 503 → fallback Pro 503 → 503 de novo no retry silencioso do turno inteiro. Resultado: `agent_error` e handoff. O fallback Flash→Pro já existe e vale só para a solicitação, mas a sobrecarga do Google atingiu os dois modelos. Foi o único `agent_error` em 14 dias (1196 `success`). As únicas chaves cadastradas são Gemini (`ren-sushi`, `moralles-centro`).

## 1. "Assumir" inicia o relógio do atendimento

- `assumeConversation` grava `handoff_at = now()` junto com `status`/`assigned_to`, com predicado de tenant e `.select()`, e confere linha afetada (invariante do UPDATE zero-row). A ACL atual já permite a `authenticated` escrever `handoff_at` (o `releaseToAI` grava NULL). Conferir na migration `20261017160000_conversation_message_write_acl.sql` antes de implementar.
- **Rede de proteção no webhook** para linhas legadas e writers futuros: com status `human_active`/`awaiting_human` e `silenceStart === 0`, o webhook grava `handoff_at = now()` por UPDATE condicional `.is("handoff_at", null)` e passa a usar esse valor como relógio. Falha dessa escrita só loga, e o turno segue como hoje (silenciado). Resultado: no pior caso, a conversa volta para a IA 12h depois do primeiro inbound recebido durante o handoff.
- Decisão em núcleo puro (`resolveHandoffClock`) com teste. O `index.ts` só aplica.

## 2. Nunca enviar resposta cortada

- **Gemini:** `generationConfig.thinkingConfig.thinkingBudget = 1024` (Flash aceita 0–24576; Pro exige ≥128 e não desliga o raciocínio) e `maxOutputTokens = 3072`. A resposta fica com pelo menos ~2000 tokens livres, o triplo da maior resposta normal. Constantes nomeadas em `ai-providers.ts`.
- **Corte detectado = erro, não texto.** Gemini `finishReason: MAX_TOKENS`, OpenAI-compat `finish_reason: "length"` e Claude `stop_reason: "max_tokens"` lançam `AgentTruncatedError`. Hoje o Claude devolve "Desculpe, não consegui processar…" como se fosse resposta. O uso da chamada já foi reportado ao orçamento antes do lançamento. Com isso, o retry silencioso existente (uma vez, `!mutatingToolUsed`, `<30s`) cobre o caso. Se repetir, o caminho `agent_error` faz handoff. Se a tool mutante já rodou, o handoff é imediato. Cliente nunca recebe meia frase.
- **Orçamento:** `AI_ESTIMATE_OUTPUT_TOKENS` (ai-budget-core.ts) passa a derivar da mesma constante de saída máxima. Estimar 1024 para uma chamada que pode gastar 3072 subestimaria a reserva. A estimativa erra para cima de propósito. Teste gêmeo amarra os dois valores. Organizações sem franquia (Ren Sushi `LIFETIME`) não são afetadas.
- **Telemetria:** `agent_usage` passa a incluir `reasoning_tokens`, e `agent_unexpected_stop` inclui `output_tokens`. O campo `reasoning_tokens` já existe em `AgentUsage`, mas hoje não aparece no log.

## 3. Calendário dos próximos dias no prompt

- Núcleo puro `buildUpcomingDaysLines(nowBrt)`, com teste, devolve 8 linhas derivadas do mesmo `nowBrt` (invariante BRT): `- hoje: quarta-feira, 14/10`, `- amanhã: quinta-feira, 15/10` e os 6 dias seguintes, com nome e data.
- O bloco entra logo após "Hoje é …". A Regra 11 ganha uma frase: para "amanhã", "sábado", "dia 18" etc., consultar a lista para saber o dia da semana e então aplicar a faixa de preço daquele dia. Nunca calcular de cabeça.
- Para datas fora da lista, a regra manda informar o preço da faixa correspondente ao dia da semana da data pedida, se o cliente informar a data completa, ou perguntar a data. Sem chamada extra de ferramenta.

## 4. Provedor reserva (fallback entre provedores) — proposta do responsável, refinada

Pedido: em sobrecarga, usar outro modelo só naquela solicitação e depois voltar ao padrão da loja. Isso já acontece **dentro do Gemini** (Flash→Pro, sticky só na invocação). O caso de 13/10 mostra o limite: a sobrecarga é da infraestrutura do provedor, e o Pro caiu junto. O Pro também é várias vezes mais caro e mais lento. Por isso a reserva vale mais se for **outro provedor** do que se for "mais potente".

- **Configuração por unidade, opcional, desligada por padrão:** `settings.ai_config.fallback = { provider, model }`, editada pelo platform admin na aba Provedor de IA (`/platform/unidades/:slug`). A aba lista só provedores ≠ principal **com chave ativa cadastrada na própria unidade**. Sem fallback global de chave (invariante BYOK). Modelo validado por `resolveModel`.
- **Gatilho:** erro de indisponibilidade depois de esgotada a cadeia do provedor principal: HTTP 5xx, 429, rede/timeout ou resposta vazia. 4xx de chave/modelo, `AgentTruncatedError`, deadline e negação de orçamento **não** disparam. Classificação em núcleo puro (`shouldUseFallbackProvider`) com teste.
- **Granularidade de turno, não de chamada:** com fallback configurado, o retry silencioso existente roda o turno inteiro no provedor reserva em vez de repetir o principal sobrecarregado. Valem as mesmas travas: uma vez, `!mutatingToolUsed`, `<30s`, sem deadline. Trocar de provedor no meio do loop de tools exigiria converter turnos de ferramenta entre formatos. O histórico em texto já é neutro, então o turno recomeça limpo. Sem fallback configurado, o comportamento atual se mantém byte a byte.
- **Só aquela solicitação:** a próxima mensagem volta ao provedor e modelo padrão da loja. Nada é persistido como troca.
- **Chave e orçamento:** a chave sai de `resolveApiKey(fallback.provider, unitId)`. Ausente ou inativa: loga `fallback_unavailable` e segue o caminho atual. A chamada passa por `callWithBudget` com provedor e modelo reais. Em organização com franquia, modelo sem preço em `ai_model_prices` falha fechado (`PRICE_UNKNOWN`) e não vira chamada grátis.
- **Observabilidade:** log `agent_provider_fallback` (de/para, motivo sanitizado). `webhook_executions.meta` e `agent_usage` registram `fallback_provider`/`fallback_model` quando usados.
- **Custo operacional:** ativar no Ren Sushi exige cadastrar uma segunda chave (ex.: Anthropic ou OpenAI) paga pelo responsável. O cadastro e a ativação ficam fora desta entrega e precisam de autorização própria.

## Fora do escopo

Prompt global editável na Plataforma e atualização da lista de modelos (entrega B, spec própria); aniversário calculado em UTC no prompt; vocabulário de `outcome`; alterar Flash→Pro.

## Testes e gates

Vitest dos núcleos (`resolveHandoffClock`, `buildUpcomingDaysLines` com virada de mês/ano e 21h–24h BRT, classificação de truncamento/fallback, gêmeo de tokens) e teste do hook `assumeConversation` com zero linhas. `deno check` de `webhook-whatsapp`, `npm run typecheck`, `lint`, `test`, `build`. Grafo: `ai-providers.ts` → só `webhook-whatsapp`; rodar o grafo dos arquivos realmente alterados. Gates `saas-shield-br` proporcionais (identity-access para o UPDATE de conversa; integration-reliability para retry/fallback). Review por tarefa e da branch.

## Rollout e reversão

Branch nova a partir de `main`. Frontend (push em `main` → Vercel) e `supabase functions deploy webhook-whatsapp` sem migration; a ordem entre eles é indiferente. Verificação: `agent_unexpected_stop`/`MAX_TOKENS` cai a zero, `reasoning_tokens` aparece no log, "Assumir" grava `handoff_at`. Reversão: redeploy da versão anterior. O fallback é desligado removendo `ai_config.fallback`.
