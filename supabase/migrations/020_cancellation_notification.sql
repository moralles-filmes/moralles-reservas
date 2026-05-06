-- Permite registrar notificações de cancelamento em notifications_sent.
-- A função Edge `send-cancellation` registra (reservation_id, kind='cancellation')
-- para auditoria e idempotência (evitar reenvios duplicados).

alter table notifications_sent drop constraint if exists notifications_sent_kind_check;

alter table notifications_sent add constraint notifications_sent_kind_check
  check (kind in ('confirmation', 'reminder_d1', 'survey_d1', 'cancellation'));
