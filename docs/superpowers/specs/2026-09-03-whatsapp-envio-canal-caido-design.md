# Envio com canal caído e descarte de mensagem vencida — design

## Contexto e causa

Incidente medido em produção (organização Ren Sushi, canal Z-API único e ativo):

- `webhook_executions` não registra **nenhum** evento entre `2026-08-28 01:45:46Z` e `2026-09-03 17:12:41Z` — 6,6 dias de canal fora do ar.
- Em `2026-09-03 17:12:41Z` chegam, em ~2,5 minutos, 181 `own_message_echo` e 360 `status_callback`.
- `notifications_sent` mostra **88 mensagens** com `sent_at` entre 28/08 e 02/09 e `delivered_at` dentro desse flush: 29 `waitlist_entered`, 22 `waitlist_feedback`, 8 `waitlist_table_ready`, mais `reminder_d1`, `survey_d1` e `confirmation`.

A cadeia que produziu isso tem três elos, e cada um é uma decisão do nosso código:

1. **A queda só foi observada 4,5 dias depois, e por acaso.** `record_whatsapp_channel_status` só é chamado pelo callback do provider (`webhook-whatsapp`) e por quem abre o portal (`manage-channels`). Não existe worker periódico, e a revalidação de 30s introduzida em [2026-09-01-zapi-connection-status-design.md](2026-09-01-zapi-connection-status-design.md) é gateada por aba visível.

   Medido em `notifications_sent`: a projeção seguiu dizendo `connected` de 28/08 01:45 até **02/09 15:40**, quando alguém abriu o painel e ela virou `disconnected` — a partir daí os 14 envios seguintes foram corretamente recusados com `whatsapp_not_configured`. Ou seja, o filtro `.eq("status","connected")` do caminho por `unit_id` FUNCIONA; o que faltava era alguém dizer a verdade a ele. Todas as 88 mensagens foram postadas na janela em que a projeção ainda mentia.

2. **O envio confiou na projeção congelada.** Em `_shared/whatsapp-send.ts`, o caminho por `unit_id` filtra `.eq("status","connected")` — que era verdadeiro e mentiroso. O caminho por `channel_id` nem chega a perguntar: `requiresConnectedProjection = channel.provider === "uazapi"` isenta explicitamente a Z-API da checagem.

3. **A Z-API aceitou e enfileirou.** Cada POST devolveu 2xx, `recordNotification` gravou `status='sent'`, e a entrega só ocorreu no flush da reconexão. A fila é do provedor, não nossa: entre o 2xx e o flush não existe ponto em que o nosso código pudesse ter desistido.

O elo 3 é a razão pela qual "não reenviar na reconexão" não descreve uma correção implementável — não há reenvio nosso a suprimir. O que existe é **envio para dentro de uma fila que não controlamos**, e o único momento em que temos autoridade é antes do POST.

### O que o prazo de validade cobre, e o que não cobre

Registrado explicitamente para não superestimar a peça: avaliado no instante do POST, o TTL **não teria barrado nenhuma das 88 mensagens do incidente**. Todas estavam válidas quando foram postadas — o lembrete D-0 saiu no dia da reserva, o aviso de fila saiu minutos após a entrada na fila. Elas venceram *dentro* da fila da Z-API.

O TTL cobre um conjunto diferente e real de caminhos, todos em que a mensagem fica represada **do nosso lado**:

- `resend-notification`, alimentado pelo painel Entregas. Depois de uma queda longa esse painel fica cheio de não-entregues antigos, e reenviar em lote é um clique — foi o caminho mais provável para uma segunda rajada.
- `notification_outbox`, único caminho com retry nosso (backoff até ~5,5h). Já tem `stillValid`, restrito a `confirmation`.
- Qualquer represamento futuro criado pela própria peça 2: com o envio barrado, uma execução posterior do worker pode alcançar um fato já vencido.

### Nota sobre o cabeçalho da migration

O comentário de [20260903180000_whatsapp_channel_health_cron.sql](../../../supabase/migrations/20260903180000_whatsapp_channel_health_cron.sql) diz que a projeção ficou `connected` por 6,6 dias. A janela real em que ela mentiu é de 4,5 dias (28/08 01:45 → 02/09 15:40); os 6,6 dias são o tempo de canal fora do ar. A imprecisão foi encontrada **depois** do `db push`, e migration aplicada não se reescreve — mesma razão pela qual a 104 corrigiu por `comment on column` o comentário falso da 090, em vez de editá-la. O registro correto é este documento.

## Decisão

Três peças independentes, cada uma resolvendo um elo.

### Peça 1 — Prazo de validade por tipo de mensagem

Núcleo puro `supabase/functions/_shared/whatsapp-message-ttl-core.ts`, sem I/O, testado por vitest em `src/lib/whatsapp-message-ttl-core.test.ts`.

Contrato: `decideMessageValidity({ kind, factAt, now })` → `{ valid: true } | { valid: false; reason }`. `factAt` é o instante do fato que originou a mensagem, informado por quem a produz — nunca re-derivado dentro do núcleo.

| `kind` | Fato de referência | Prazo |
|---|---|---|
| `waitlist_table_ready` | instante do aviso do operador | 30 min |
| `waitlist_entered` | `waitlist.created_at` | 2 h |
| `waitlist_feedback` | fim do atendimento | 24 h |
| `reminder_d1` | data+hora da reserva | até o horário da reserva |
| `survey_d1` | data da reserva | 48 h |
| `confirmation` | data+hora da reserva | até o horário da reserva |
| `voucher_issued` | emissão | 7 dias |

`kind` desconhecido e `factAt` ausente são **fail-open** (envia) com telemetria própria: a peça não pode silenciar envio legítimo por um produtor que ainda não foi adaptado, mas o produtor omisso precisa ser localizável. Prazos comparados sempre em BRT explícito (`-03:00`), pelo mesmo motivo de `availability.ts`.

Consequência do vencimento, conforme decidido: **descarte silencioso com log**. Não grava `notifications_sent`, não notifica o lojista, não aparece como pendência no painel. Uma linha `failed` ali bloquearia reenvio manual legítimo, e o painel Entregas já é a superfície onde o operador vê o que não saiu.

Pontos de aplicação: `send-whatsapp` (funil de todos os kinds acima exceto `confirmation`), `resend-notification` (antes de rotear) e `process-notification-outbox` (integrado ao `stillValid` existente, sem duplicar a regra).

### Peça 2 — Não postar em canal sem conexão confirmada

Em `_shared/whatsapp-send.ts`, antes de qualquer POST ao provedor:

- Remover a isenção `requiresConnectedProjection = provider === "uazapi"`. Todo provider passa a exigir `status = 'connected'`, nos dois caminhos (`channel_id` e `unit_id`).
- Tratar a projeção como **perecível**: se `last_health_check_at` for mais velho que `CHANNEL_FRESHNESS_MS` (5 min), consultar `getConnectionStatus` do adapter e persistir por `record_whatsapp_channel_status` antes de decidir. Snapshot não-conectado → `{ ok: false, error: "whatsapp_not_connected" }`, sem POST.
- Falha na consulta ao provedor é **fail-closed** para esta decisão: não conseguir confirmar conexão não autoriza alimentar a fila do provedor. É a polaridade oposta à do gate de billing (`whatsapp-service-gate.ts`), e deliberadamente: lá o risco é calar cliente adimplente; aqui o risco é bloqueio da conta do lojista pela Meta.
- Cache por invocação, no mesmo padrão de `clearWhatsAppGateCache()`: uma consulta por canal por invocação, não uma por mensagem. Um worker que envia 22 avisos não faz 22 consultas de status.

A verificação de frescor não se aplica ao agente em `webhook-whatsapp`: uma resposta a inbound é prova de que o canal estava vivo no instante anterior, e uma consulta extra por turno de conversa é custo sem informação.

### Peça 3 — Observação periódica do canal

Worker `process-whatsapp-channel-health`, `*/5 * * * *`, `verify_jwt = false` em `config.toml`, autenticado por `x-internal-key`.

Percorre canais `is_active = true` (e legados `NULL` conectados, mesma regra de binding de `whatsapp-send.ts`), consulta `getConnectionStatus` do adapter e persiste por `record_whatsapp_channel_status`. Não chama a Z-API para canais cujo adapter não declara `getConnectionStatus`.

Isso faz a queda aparecer no portal e no ledger `whatsapp_channel_lifecycle_events` sem depender de aba aberta, e mantém `last_health_check_at` fresco o bastante para que a peça 2 quase nunca precise consultar o provedor no caminho de envio.

## Critérios de aceite

**Peça 1**
- Cada `kind` da tabela devolve `valid:false` com o `reason` correto exatamente após o prazo, e `valid:true` um instante antes.
- `reminder_d1` e `confirmation` vencem no horário da reserva em BRT, não em UTC.
- `kind` desconhecido devolve `valid:true` e emite telemetria de kind não mapeado.
- `factAt` ausente devolve `valid:true` e emite telemetria de produtor omisso.
- Mensagem vencida não grava linha em `notifications_sent`.
- `resend-notification` recusa reenvio de `waitlist_entered` vencido e responde com motivo legível.

**Peça 2**
- Canal Z-API com `status='connected'` e `last_health_check_at` de 6 dias atrás não é usado sem reconsulta.
- Snapshot `disconnected` na reconsulta impede o POST e devolve `whatsapp_not_connected`.
- Falha de rede na consulta de status impede o POST (fail-closed).
- Envio por `channel_id` com provider `zapi` e `status='disconnected'` é recusado — hoje passa.
- Duas mensagens na mesma invocação para o mesmo canal produzem uma única consulta de status.
- Projeção com `last_health_check_at` recente não gera consulta ao provedor.

**Peça 3**
- Uma queda de canal passa a aparecer em `whatsapp_channels.status` em até 5 minutos sem nenhuma aba aberta.
- O worker não consulta provider de canal `is_active = false`.
- Falha de consulta em um canal não interrompe os demais.
- A transição registra linha em `whatsapp_channel_lifecycle_events`.

## Deploy

Ordem obrigatória: nenhuma migration de coluna nova é necessária (`last_health_check_at` já existe), então o rollout é só de Edge Functions e do agendamento.

`_shared/whatsapp-send.ts` muda → redeploy de `send-whatsapp`, `send-confirmation`, `send-cancellation`, `send-manual-message`.

`_shared/whatsapp-message-ttl-core.ts` é novo → consumido por `send-whatsapp`, `resend-notification` e `process-notification-outbox`; os três entram no mesmo rollout e na matriz de redeploy do `CLAUDE.md`.

`process-whatsapp-channel-health` precisa da entrada `verify_jwt = false` em `config.toml` **antes** do deploy, e o agendamento `pg_cron` só depois da função estar publicada — wrapper `SECURITY DEFINER` lendo `internal_api_key` e `project_url` do Vault, sem literal de URL nem de chave na migration.

A peça 2 é a única que pode recusar envio que hoje passa. Ela vai a produção depois da peça 3 estar rodando, para que `last_health_check_at` já esteja fresco e o caminho de reconsulta síncrona seja exceção, não regra.
