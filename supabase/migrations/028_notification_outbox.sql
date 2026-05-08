-- Outbox pattern para confirmações/cancelamentos de reserva.
--
-- Antes: trigger `send-confirmation-on-reservation` (criado em 022) chamava
-- `supabase_functions.http_request` direto. Sem retry, sem visibilidade —
-- se a Edge Function timeoutava (5s) ou retornava erro, a confirmação era
-- perdida silenciosamente.
--
-- Agora: trigger insere uma linha em `notification_outbox` (status=pending).
-- Edge Function `process-notification-outbox` (chamada por cron a cada
-- 1-2 minutos) processa pendentes com retry exponencial e move pra `dead`
-- após 5 tentativas, deixando registro pra investigação.

create table if not exists notification_outbox (
  id              uuid primary key default gen_random_uuid(),
  reservation_id  uuid not null references reservations(id) on delete cascade,
  unit_id         uuid not null references units(id) on delete cascade,
  kind            text not null check (kind in ('confirmation', 'cancellation')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  status          text not null default 'pending'
                  check (status in ('pending', 'processing', 'done', 'dead')),
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (reservation_id, kind)
);

create index if not exists idx_outbox_pending_due
  on notification_outbox (next_attempt_at)
  where status = 'pending';

create index if not exists idx_outbox_unit_status
  on notification_outbox (unit_id, status, created_at desc);

alter table notification_outbox enable row level security;
alter table notification_outbox force row level security;
-- Sem policies: só service_role acessa via Edge Function.

-- Substitui o trigger antigo que chamava send-confirmation direto.
drop trigger if exists "send-confirmation-on-reservation" on reservations;

create or replace function enqueue_confirmation_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Reservas via WhatsApp não geram confirmação automática (o agente já
  -- confirma na conversa). Só web/painel/API.
  if new.source is distinct from 'whatsapp' then
    insert into notification_outbox (reservation_id, unit_id, kind)
    values (new.id, new.unit_id, 'confirmation')
    on conflict (reservation_id, kind) do nothing;
  end if;
  return new;
end;
$$;

create trigger enqueue_confirmation_after_insert
  after insert on reservations
  for each row
  execute function enqueue_confirmation_notification();

-- Helper: marca outbox como done (chamado pela Edge Function quando o envio sucede).
create or replace function mark_outbox_done(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update notification_outbox
  set status = 'done', updated_at = now(), last_error = null
  where id = p_id;
$$;

-- Helper: marca outbox como falhada — calcula next_attempt_at com backoff
-- (1m, 5m, 15m, 1h, 4h) e move pra 'dead' após 5 tentativas.
create or replace function mark_outbox_failed(p_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  new_attempts integer;
  delays interval[] := array['1 minute', '5 minutes', '15 minutes', '1 hour', '4 hours']::interval[];
  next_delay interval;
begin
  update notification_outbox
  set attempts = attempts + 1,
      last_error = p_error,
      updated_at = now(),
      status = case when attempts + 1 >= 5 then 'dead' else 'pending' end,
      next_attempt_at = case
        when attempts + 1 >= 5 then next_attempt_at
        else now() + delays[least(attempts + 1, array_length(delays, 1))]
      end
  where id = p_id
  returning attempts into new_attempts;
end;
$$;

-- Backfill opcional: NÃO insere reservas antigas no outbox por padrão. Se
-- precisar reprocessar confirmações perdidas, rodar manualmente:
--   insert into notification_outbox (reservation_id, unit_id, kind)
--   select id, unit_id, 'confirmation' from reservations
--   where source <> 'whatsapp' and created_at > now() - interval '7 days'
--     and id not in (select reservation_id from notifications_sent
--                    where kind in ('confirmation', 'confirmation_email')
--                    and status = 'sent')
--   on conflict do nothing;
