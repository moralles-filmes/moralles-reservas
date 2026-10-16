---
paths:
  - "supabase/functions/_shared/availability.ts"
  - "supabase/functions/_shared/giftback.ts"
  - "supabase/functions/_shared/resolve-customer.ts"
  - "supabase/functions/_shared/phone.ts"
  - "supabase/functions/create-reservation/**"
  - "supabase/functions/create-manual-reservation/**"
  - "supabase/functions/update-reservation/**"
  - "supabase/functions/process-voucher-triggers/**"
  - "supabase/functions/process-reservation-reminders/**"
  - "supabase/functions/process-notification-outbox/**"
  - "supabase/functions/webhook-whatsapp/**"
  - "src/hooks/useReservationTemplates*"
  - "src/components/reserva/**"
  - "src/lib/phone.ts"
  - "src/pages/gestao/giftback/**"
---

# Reservas, clientes e giftback

## Disponibilidade (`availability.ts`)


[supabase/functions/_shared/availability.ts](supabase/functions/_shared/availability.ts) é fonte única de verdade compartilhada por `webhook-whatsapp` e `create-reservation`. Ordem de resolução:

1. **Janela de reserva** (`settings.booking_window_days`)
2. **`special_dates`** — override fechado bloqueia; aberto substitui hall_schedule
3. **Halls ativos** — special_date do hall > global, depois `hall_schedules` do dia
4. **Antecedência mínima** da janela que cobre o horário
5. **Mesas compatíveis** — `min_capacity ≤ partySize ≤ max_capacity`; `allow_empty_seat` aceita `partySize ≥ min - 1`
6. **`table_blocks`** — `table_id IS NULL` = macro (fecha hall/unit)
7. **First-fit** — aloca menor mesa disponível
8. **Overbooking** — se ativo, cria reserva floating (`table_id: null`) em vez de rejeitar

- **Timestamps em `availability.ts` SEMPRE com offset BRT explícito (`-03:00`).** Deno runtime é UTC; sem offset, comparação contra `table_blocks.blocked_from/to` (BRT no banco) fica 3h fora e bloqueios parciais (ex.: 19h-22h) deixam reservas escaparem na borda. Replicar em qualquer query nova nesse arquivo.

## Reservas, clientes e telefone

- **`defaultBody` em `useReservationTemplates.ts` fica sincronizado com os `DEFAULT_*_BODY` dos workers** (o worker é autoritativo); workers leem `reservation_message_templates` com `customized=true` ou o default.
- **E-mail é opcional no banco, em `create-reservation` e no agente** (cliente de WhatsApp raramente informa); só o wizard público o exige. Não promover a obrigatoriedade ao backend sem coordenar.
- **`reservations.source` (`web`/`whatsapp`)** é load-bearing: trigger `enqueue_confirmation_notification` filtra `source != 'whatsapp'` pra não duplicar template. Qualquer Edge Function nova que crie reserva via agente DEVE passar `source: "whatsapp"` em `reserveSlot` — frontend/wizard usa default `'web'`.
- **Reserva manual ([create-manual-reservation](supabase/functions/create-manual-reservation/index.ts)) DESACOPLA notificação de `source`.** Operador escolhe origem (relatório) E "avisar cliente" separadamente; como o trigger acopla os dois, a EF reconcilia `notification_outbox` no pós-insert (insere se notify=ON, deleta pendente se OFF). NÃO inferir intenção de notificar a partir de `source` em código novo. EF é autenticada (membro da unit ou `platform_admin`, via `hasUnitAccess` em [_shared/authz.ts](supabase/functions/_shared/authz.ts)), isenta de rate-limit e caução.
- **`reserveSlot({ override: true })` força reserva flutuante** (`table_id: null`) quando a validação recusa — exclusivo da reserva manual do operador. Não usar em path público.
- **Operador não cancela reserva — forçado por trigger `enforce_operador_no_cancel()` (BEFORE UPDATE em `reservations`).** Bloqueia transição pra `status='cancelled'` quando `auth.uid()` é membro `operador` da unit; service_role (workers/agente/Stripe, `auth.uid()` null) e gerente/owner/platform_admin passam. Path novo que cancele via Edge Function `service_role` bypassa o trigger silenciosamente — gatear o papel no próprio EF. Frontend espelha em [ReservaCard.tsx](src/components/reserva/ReservaCard.tsx) (`canCancel = useCurrentUnit().isGerente`).
- **`customers.email` é array (`emails[]`)** — append-only via `resolveOrCreateCustomer`.
- **`customers.phone` é SEMPRE canônico (9º dígito): celular 11 díg., fixo 10, sem `55`.** Sem isso o mesmo cliente em dois formatos (com/sem 9) vira duplicata, pois a dedupe é `(organization_id, phone)`. Regra única em 3 lugares sincronizados: `canonicalBrPhone` em [_shared/phone.ts](supabase/functions/_shared/phone.ts) (backend) ⇄ [src/lib/phone.ts](src/lib/phone.ts) (front) ⇄ função SQL `normalize_br_phone`. Backstop: trigger `customers_canonical_phone_trg` (BEFORE INSERT/UPDATE) força o canônico em qualquer write (cobre o handler de mídia, que não passa pelo resolver). Writer novo de telefone canoniza na origem; não usar `replace(/^55/)` cru (DDD 55/RS existe).
- **Todo destinatário montado pelos ADAPTERS de provider passa por `toE164BrPhone`, inverso do armazenamento canônico: só considera `55` código de país se houver 12 ou 13 dígitos, sem alterar o assinante.** `startsWith("55")` isolado confunde DDD 55 com país e causa falha silenciosa nos cinco providers; nenhum adapter deve manter regra própria de prefixo. [_shared/phone.ts](supabase/functions/_shared/phone.ts), [testes dos cinco envios](src/lib/phone.test.ts).
- **`business_hours`** é DEPRECATED — fonte de horário é `halls + hall_schedules`. Não construa nada novo em cima.
- **Coluna Postgres `time` (`reservations.time`, `hall_schedules.open_time/close_time`, etc.) sempre volta como `HH:MM:SS`.** Interpolar direto num literal de timestamp (`` `${time}:00-03:00` ``) gera dois blocos de segundos → `Invalid Date` → `NaN` silencia qualquer comparação sem erro visível. Sempre `.slice(0, 5)` antes de montar o literal; não há helper compartilhado — `availability.ts`, `process-notification-outbox` e `process-reservation-reminders` resolvem cada um por conta própria. [process-notification-outbox/index.ts:96](supabase/functions/process-notification-outbox/index.ts).
- **`vouchers_unit_rule_customer_active_idx`** (UNIQUE PARTIAL em `vouchers` WHERE status='active' AND rule_id NOT NULL) garante no máximo 1 voucher ativo por (unit, rule, customer). Sempre tentar INSERT e tratar `23505` como dedupe silencioso.
- **`voucher_rules` CHECK exige `min_rating NOT NULL` quando `trigger_type='after_rating'`** — queries do webhook usam `.lte('min_rating', rating)` puro.

## Giftback


- **Validade sempre fim-do-dia BRT.** Use `expiresAtEndOfDayBrt(validity_days)` de [supabase/functions/_shared/giftback.ts](supabase/functions/_shared/giftback.ts) — Deno é UTC, `setHours` daria 21:00 BRT do dia anterior. Frontend usa `endOfDayLocalISO` em [src/lib/utils.ts](src/lib/utils.ts).
- **No webhook, voucher só persiste se WhatsApp send OK; o worker de aniversário/frequência persiste antes do envio.** Ciclo no webhook: `prepareGiftbackVoucher` (monta sem escrever) → `sendOutbound` → `commitGiftbackVoucher` (escreve voucher + `notifications_sent` com status real); inverter cria voucher fantasma nesse caminho. No worker, `issueAndSend` insere antes de enviar e mantém o benefício em falha/supressão: não aplicar a ordem do webhook ao worker. [process-voucher-triggers/index.ts](supabase/functions/process-voucher-triggers/index.ts).
- **`notifications_sent.status` reflete envio real** — `sent` se 2xx, `failed` com `error` caso contrário.
- **Dedupe `(rule, customer)` é DB-enforced** via `vouchers_unit_rule_customer_active_idx`. Sempre tente INSERT; erro `23505` é dedupe silencioso (log `voucher_dedup_race`). `SELECT existing` antes não basta (reprocessing_stuck_message permite 2 execuções paralelas).
- **`processFrequency` conta reservas até ontem BRT** (`.lte('date', yesterdayIso)`) — sem isso, reservas confirmadas no futuro disparam voucher antes da visita.
- **Cooldown da frequência = `rule.validity_days`** (estável). NÃO use `windowStart` deslizante.
- **Sob suspensão de WhatsApp, aniversário cria o voucher e só suprime o envio; frequência pula a regra inteira.** Assimetria deliberada: a data de aniversário não volta (perda permanente se pular), a janela de frequência é recalculada a cada execução (adiado, sem perda). `suppressSend` em `IssueArgs`. [process-voucher-triggers/index.ts](supabase/functions/process-voucher-triggers/index.ts).
- **Phone vazio = skip.** Workers filtram `phoneDigits.length >= 10` antes do `issueAndSend`.
- **29/02 em ano não-bissexto → dispara em 28/02** (regra civil BR). Lógica em `getTodayBrtParts` + flag `acceptLeapBirthday`.
- **Advisory lock no worker:** `try_giftback_lock()` no início, `release_giftback_lock()` no `finally`. Falha aberta é OK — UNIQUE PARTIAL pega o resto.
- **Mensagem do voucher é appendada em `conversations.messages`** (rating intercept + comment intercept chamam `appendToConversation` pro incoming "5" E pro outgoing). Sem isso, operador vê buraco na thread.
