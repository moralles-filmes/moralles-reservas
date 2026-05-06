-- Adiciona 'confirmation_email' ao CHECK de notifications_sent.kind.
-- A função `send-confirmation` registra notificações por canal (WhatsApp e email)
-- usando kinds distintos para idempotência separada.

alter table notifications_sent drop constraint if exists notifications_sent_kind_check;

alter table notifications_sent add constraint notifications_sent_kind_check
  check (kind in (
    'confirmation',
    'confirmation_email',
    'reminder_d1',
    'survey_d1',
    'cancellation'
  ));
