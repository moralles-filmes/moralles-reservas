# Design — paridade de conversas entre providers WhatsApp

## Objetivo

Todo provider WhatsApp deve entrar no registry com o mesmo contrato de conversa observado na Z-API: mensagens do cliente entram uma vez, mensagens digitadas no aparelho da loja aparecem como atendimento humano e silenciam a IA, autoria é explícita no painel e o horário exibido vem do evento original do provider.

## Contrato normalizado

`WhatsAppProviderAdapter` passa a exigir `parseOwnMessageEchoes(payload)`. O parser devolve uma lista de eventos normalizados com:

- `providerMessageId` estável para dedupe por `(provider, message_id)`;
- `peerPhone`, ou identidade de chat equivalente, para localizar a conversa sem criar customer;
- `text`;
- `timestamp` em epoch milissegundos;
- `source: "manual_device" | "provider_api"`, sem inferir uma mensagem da API como atendente;
- `peerChatId`, `peerLid` e `contactName` opcionais.

O webhook consulta o adapter antes do parser inbound. Eco `provider_api` é ignorado porque a saída já foi registrada no writer original. Eco `manual_device` é deduplicado, anexado como mensagem humana e move a conversa para `human_active`, renovando `handoff_at` e `last_silenced_reply_at`. Evento sem identidade suficiente falha fechado e nunca cria customer.

## Providers atuais

- Z-API: `fromMe=true`; `fromApi=false` identifica aparelho e `fromApi=true` identifica API; `messageId`, `phone`/`chatLid`, `text.message` e `momment` compõem o evento.
- WAHA: exige webhook `message.any`; `fromMe=true`, `source=app` identifica aparelho e `source=api` identifica API; usa `payload.id`, `payload.to`, `payload.body` e `payload.timestamp`.
- UazAPI: evento `messages`; `fromMe=true`, `wasSentByApi=false` identifica aparelho; usa `messageid`, `chatid`, `text` e `messageTimestamp`. A configuração mantém `excludeMessages: ["wasSentByApi"]` e nunca exclui `fromMeYes`.
- Meta Cloud API: somente o modo WhatsApp Business App Coexistence produz `smb_message_echoes`; o parser aceita `value.message_echoes`. Meta convencional não anuncia paridade com aparelho, pois não há aparelho compartilhando o número. A ativação comercial que prometa paridade exige Coexistence validado.

O webhook Meta valida `metadata.phone_number_id` contra o binding do canal mesmo após o HMAC e desmembra lotes com vários `entries`, `changes`, status ou mensagens para que cada inbound atravesse dedupe/debounce/lock sem ser ocultado por um retorno antecipado.

## Autoria e timeline

Cada item novo de `conversations.messages` recebe `author: "customer" | "ai" | "automation" | "human"`, preservando `role` por compatibilidade. Saída do LLM usa `ai`; templates e respostas hardcoded usam `automation`; painel e eco do aparelho usam `human`; inbound usa `customer`.

O timestamp canônico do adapter é epoch em milissegundos e vira ISO antes do append. Z-API usa `momment` quando válido e receipt time apenas como compatibilidade para payload legado. A UI mostra `IA`, `Automação`, `Atendente` ou `Cliente`; históricos sem `author` são rotulados como `IA/Automação (legado)` quando não há `kind`, porque a distinção passada não pode ser reconstruída.

`append_conversation_message` mantém `last_message_at` monotônico com o maior timestamp entre o valor atual e a mensagem anexada. A timeline renderiza uma cópia ordenada de forma estável por epoch, mantendo timestamps iguais na ordem de append.

## Regra para providers futuros

Provider novo só entra como paritário quando adapter, configuração operacional e fixtures provam: inbound, eco humano, distinção API/aparelho, timestamp original, ID estável, dedupe, append humano e silenciamento da IA. Uma limitação real do provider deve ser declarada explicitamente; capability ausente nunca pode ser apresentada como suporte completo.

## Segurança e tenancy

- Canal alvo inativo e autenticado pode consumir um eco manual válido apenas para gravar a prova `manual_echo_verified_at`; CRM/conversa/IA continuam exclusivos do canal ativo.
- A resolução de conversa permanece escopada por `unit_id` e organização.
- Eco nunca cria customer.
- LID, grupos, newsletters e remetentes implausíveis não viram clientes.
- Falha no claim de idempotência retorna erro para permitir reentrega; duplicata retorna 200.
- A escrita humana limpa o lock e toda saída automática pós-claim revalida status+token antes do POST; uma entrega externa já aceita antes do eco não pode ser recolhida.
- Conteúdo, telefone, tokens e payloads brutos não entram em logs.

## Verificação

- Testes unitários dos quatro parsers de eco e timestamps em milissegundos.
- Guard de registry exigindo parser de eco em todo adapter.
- Testes de wiring do webhook para dedupe, append humano, timestamp e handoff.
- Testes de autoria/labels e ordenação da timeline.
- Preflight SQL provando `last_message_at` monotônico e ACL service-role-only.
- Testes, typecheck, lint e build proporcionais ao risco.

## Deploy

Mudança no registry exige redeploy conjunto de todas as Edge Functions da matriz WhatsApp documentada em `CLAUDE.md`; a alteração comportamental de inbound depende especialmente de `webhook-whatsapp`. A migration deve entrar antes do novo bundle. Frontend entra depois do backend compatível.
