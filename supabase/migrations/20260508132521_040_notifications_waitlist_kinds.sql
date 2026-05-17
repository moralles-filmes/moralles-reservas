-- Migration 040: estende notifications_sent pra suportar notificações de fila.
--
-- Mudanças:
--   1. CHECK em `kind` ganha `waitlist_entered`, `waitlist_table_ready`,
--      `waitlist_feedback`. Set anterior (mig 021):
--      ('confirmation','confirmation_email','reminder_d1','survey_d1','cancellation')
--   2. `reservation_id` vira NULLABLE — notificação de fila não tem reserva
--      associada. UNIQUE (reservation_id, kind) continua: PostgreSQL aceita
--      múltiplos NULLs (cada notificação de fila é uma linha separada).
--   3. FK reservation_id já é ON DELETE CASCADE — mantém.
--
-- Sem dataloss; constraint apenas afrouxa.

begin;

alter table notifications_sent
  alter column reservation_id drop not null;

alter table notifications_sent
  drop constraint if exists notifications_sent_kind_check;

alter table notifications_sent
  add constraint notifications_sent_kind_check
  check (kind in (
    'confirmation',
    'confirmation_email',
    'reminder_d1',
    'survey_d1',
    'cancellation',
    'waitlist_entered',
    'waitlist_table_ready',
    'waitlist_feedback'
  ));

commit;
