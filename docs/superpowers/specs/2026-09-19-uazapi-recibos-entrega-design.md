# UazAPI: recibos de entrega chegam em `event`, não em `message`

## Contexto

Desde a migração para UazAPI (05/09/2026), o painel **Operacional → Entregas** marca 100% das mensagens do Ren Sushi como "não entregue": 140 envios com `provider_message_id`, zero com `delivered_at`. Nenhum cliente é afetado — as mensagens chegam, são lidas e respondidas; quebrou só a visão do operador.

`parseUazApiStatus` guarda por `EventType === "messages_update"` (que **passa**) e então chama `uazApiMessageFromEnvelope`, que procura o payload em `message`/`data` e cai no próprio envelope. O recibo da UazAPI vem em **`event`**, então `messageid` é `undefined`, o parser devolve `null`, o payload escorre para o parser inbound e termina em `ignored_non_text`. Foram 2681 recibos descartados em 20 dias.

## Medição

Instrumentação privacy-safe (PR #16) mediu 52 recibos em 14h. Todos com o mesmo envelope:

```
EventType: "messages_update"
type:      "ReadReceipt"
event: { MessageIDs: array[N], Type, Chat, Sender, IsFromMe, IsGroup,
         Timestamp, chatid, chatlid, sender_pn, sender_lid }
```

| `event.Type` | `IsFromMe` | qtd | `MessageIDs` |
|---|---|---|---|
| `Delivered` | false | 38 | `array[1]` |
| `Read` | false | 6 | `array[1]` |
| `Read` | true | 7 | `array[6]` |

**A UazAPI não usa o enum do whatsmeow** (`""`/`"delivery"`/`"read"`/`"played"`) — usa vocabulário próprio em PascalCase. Escrever o mapa a partir da documentação produziria um parser que não casa com nada. Não foi observado `Played` nem tipo de falha.

## Contrato

- **O recibo da UazAPI é lido de `payload.event`.** As famílias `message`/`data` continuam aceitas: são documentadas, e removê-las seria regressão não forçada.
- **Um `StatusUpdate` por entrada de `MessageIDs`.** O recibo é plural por natureza (um `Read` observado carrega 6 ids).
- **Mapa medido:** `Delivered` → `delivered`, `Read` → `read`, `Played` → `read`. Valor fora do conjunto é descartado, nunca adivinhado.
- **`IsFromMe === true` é descartado.** É o atendente abrindo a conversa no aparelho e zerando as não-lidas **do cliente** — os ids ali são das mensagens que o cliente enviou à loja, não das nossas. A leitura oposta (`IsFromMe` = "a mensagem confirmada é minha") não sobrevive aos dados: implicaria nunca recebermos recibo de entrega das nossas próprias mensagens, que é o único recibo que o WhatsApp existe para emitir.

## O que garante que o painel não vai mentir

**Não é o filtro de `IsFromMe` — é a correlação de quatro campos** em `applyDeliveryStatus` (`unit_id` + `whatsapp_provider` + `whatsapp_channel_id` + `provider_message_id`). Recibo que carregue id que não é nosso casa zero linhas. Se a leitura de `IsFromMe` estivesse invertida, o modo de falha é *o painel continuar cego*, nunca *o painel afirmar entrega falsa*. O filtro é correção semântica e defesa em profundidade.

O risco residual que a correlação **não** cobre é o mapa `Type` → status: se `"Delivered"` significasse outra coisa, sub-reportaríamos. É o único ponto que sobra, e é quase tautológico.

## Por que a suíte atual não pegou

`src/test/whatsapp-provider-core.test.ts` exercita `parseUazApiStatus` com `{ EventType, messageid, status }` na raiz — **um envelope que a UazAPI nunca enviou**. Verde por 14 dias sobre uma forma inventada, enquanto produção estava 100% cega.

O caso novo usa o envelope medido, e o **controle positivo** é restaurar o corpo antigo de `uazApiMessageFromEnvelope` (só `message`/`data`) e ver o caso reprovar. Sem isso, o teste volta a não testar nada.

## Fora de escopo

- `DeletedMessage` — mesma família de envelope, também descartado, mas não é status de entrega.
- O `Timestamp` do recibo não é usado: `applyDeliveryStatus` carimba `now()`. Desvio de segundos, e incluí-lo mudaria `StatusUpdate` para todos os providers.
- ~5 `webhook_unauthorized`/dia (suspeita: canal Z-API antigo ainda apontado ao webhook no painel do provedor).
- **Backfill não é necessário.** A RPC do painel tem janela de 7 dias (`get_undelivered_notifications`, default `now() - interval '7 days'`), então as linhas antigas saem da tela sozinhas.

## Verificação

- Caso novo com o envelope medido: `Delivered`/`Read` viram `delivered`/`read`; `MessageIDs` com N entradas produz N `StatusUpdate`; `IsFromMe: true` devolve `null`; `Type` desconhecido devolve `null`.
- Controle positivo sobre `uazApiMessageFromEnvelope`.
- Os casos existentes das famílias `message`/`data` continuam verdes (não-regressão).
- `typecheck`, `test`, `lint`, `build`.
- **Em produção, após deploy:** os recibos deixam de cair em `ignored_non_text` e passam a `status_callback`, e `notifications_sent.delivered_at` começa a encher. Mensurável em minutos — chegaram 38 recibos de entrega em um único dia.

## Deploy

Sem migration. `whatsapp-provider-core.ts` é importado por **nove** Edge Functions, todas a redeployar no mesmo ato — deploy parcial deixa parser divergente em memória:

`webhook-whatsapp`, `send-whatsapp`, `send-confirmation`, `send-cancellation`, `send-manual-message`, `manage-channels`, `whatsapp-health`, `manage-organizations`, `process-whatsapp-channel-health`.
