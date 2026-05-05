-- Adiciona kinds para notificações por e-mail em notifications_sent.
-- O CHECK original (migration 011) só permitia: 'confirmation', 'reminder_d1', 'survey_d1'.
-- Agora aceita também '_email' para cada um, antecipando uso futuro pelo N8N.

alter table notifications_sent
  drop constraint if exists notifications_sent_kind_check;

alter table notifications_sent
  add constraint notifications_sent_kind_check
    check (kind in (
      'confirmation',
      'confirmation_email',
      'reminder_d1',
      'reminder_d1_email',
      'survey_d1',
      'survey_d1_email'
    ));
