# Status real da conexão Z-API — design

## Contexto e causa

A tela de canais renderiza `whatsapp_channels.status`. Esse estado é atualizado pelo teste manual do canal e pelos callbacks de conexão reconhecidos pelo registry.

O adapter Z-API tem duas lacunas:

- `GET /status` considera qualquer HTTP 2xx como conexão ativa, embora o contrato da Z-API devolva `connected: boolean` no corpo e responda 200 também quando `connected` é `false`;
- callbacks `ConnectedCallback` e `DisconnectedCallback` chegam ao webhook compartilhado, mas a Z-API não registra `parseConnectionCallback`, então eles são ignorados e a projeção permanece antiga.

## Decisão

Criar no core puro um parser de snapshot de conexão Z-API e usá-lo nos dois caminhos:

1. consulta síncrona `GET /status`, usando HTTP apenas para distinguir erro de provider e o booleano `connected` como autoridade quando a resposta é 2xx;
2. callback de conexão, aceitando exclusivamente `ConnectedCallback` e `DisconnectedCallback` com os indicadores booleanos documentados.

O parser será fail-closed: resposta 2xx sem `connected: boolean` vira `provider_error`, nunca `connected`. O callback de desconexão produz `disconnected`; o callback de conexão só produz `connected` quando `connected === true`. O número exibido vem de `phone` e passa pela normalização canônica existente.

Não haverá branching fora do registry nem leitura de credenciais no frontend. O webhook continuará persistindo o snapshot via `record_whatsapp_channel_status`; uma migration generalizará essa RPC, antes exclusiva da UazAPI, para derivar o provider da linha de canal bloqueada por `(unit_id, channel_id)`, mantendo EXECUTE exclusivo de `service_role`.

### Complemento após validação em produção

Callbacks continuam sendo o caminho primário, mas não são garantia suficiente: uma instância Z-API sem callback de desconexão configurado manteve a projeção `connected` por seis dias. A consulta client-safe do portal deve reconciliar canais manuais pelo `getConnectionStatus` do registry antes de responder e persistir o snapshot pela mesma RPC privilegiada. Credenciais permanecem exclusivamente na Edge Function.

Como a reconciliação percorre o registry, cada adapter precisa produzir um snapshot semântico. WAHA usa o `status` do corpo: somente `WORKING` é conectado; `STOPPED`, estados de autenticação/transição e `FAILED` não podem ser promovidos por HTTP 2xx. O hook escolhe `status` para lifecycle gerenciado e `list_client` para provider manual, independentemente do estado atual.

Enquanto a página estiver visível, estados configurados serão revalidados a cada 30 segundos; estados transitórios preservam o intervalo de 5 segundos e página oculta não faz polling. `not_configured` e `suspended` não geram consulta periódica. O backend aplica a mesma janela com claim atômico em `last_health_check_at`, impedindo que chamadas diretas ou abas concorrentes multipliquem consultas externas; claim em andamento responde fail-closed.

O teste manual persiste o `snapshot.status` sem reduzir todo `connected:false` a erro. Uma consulta concluída com `disconnected` invalida a lista e mostra aviso de instância desconectada; somente falha de provider trafega como erro.

## Critérios de aceite

- HTTP 200 com `{ connected: false }` retorna snapshot `disconnected`.
- HTTP 200 com `{ connected: true }` retorna snapshot `connected`.
- HTTP não-2xx e payload 2xx inválido retornam `provider_error`.
- `DisconnectedCallback` atualiza o canal para `disconnected`.
- `ConnectedCallback` atualiza o canal para `connected` e normaliza `phone`.
- Payloads de outros tipos não são tratados como callback de conexão.
- A RPC aceita Z-API e UazAPI, preserva o provider real no ledger e rejeita chamadas de `anon`/`authenticated`.
- Abrir o portal com um canal Z-API manual reconcilia o status real antes de renderizar o cartão.
- Uma queda ocorrida com a página aberta aparece em até 30 segundos, somente enquanto a aba estiver visível.
- WAHA HTTP 200 com `STOPPED` não é persistido como conectado; somente `WORKING` é.
- UazAPI estável usa a action `status` nos polls; provider manual transitório continua usando `list_client`.
- Testes do core cobrem todos esses casos.

## Deploy

A migration da RPC deve ser aplicada antes de qualquer Edge Function. A mudança em `_shared/whatsapp-provider-core.ts` e `_shared/whatsapp-providers.ts` exige redeploy conjunto de `webhook-whatsapp`, `send-whatsapp`, `send-confirmation`, `send-cancellation`, `send-manual-message`, `manage-channels`, `whatsapp-health` e `manage-organizations`, conforme a matriz do repositório. O frontend é publicado no mesmo rollout depois de verificar que a migration anterior já está aplicada.
