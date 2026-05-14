-- Migration 048: Automação de mensagens WhatsApp da fila de espera.
--
-- Cobre 2 disparos antes ausentes (a Fila → Comunicação só tinha o
-- `table_ready` manual via painel operacional):
--
--   1. `waitlist_entered` — disparado pela trigger `dispatch_waitlist_entered`
--      (AFTER INSERT em waitlist) via pg_net + INTERNAL_API_KEY do Vault,
--      chamando a Edge Function `process-waitlist-entered`. Funciona tanto pro
--      portal público (anon) quanto pro painel — o caminho é único.
--   2. `waitlist_feedback` — disparado pelo cron diário 17:00 UTC (14:00 BRT)
--      chamando a Edge Function `process-waitlist-feedback`, que percorre
--      seated_at = ontem (BRT) e dispara em lote. Espelha o pattern de
--      process-satisfaction-surveys (mig 045).
--
-- Dependências:
--   * `internal_api_key` cadastrado no Vault (já é pré-req dos demais crons).
--   * Edge Functions deployadas: process-waitlist-entered, process-waitlist-feedback.
--   * Migration 040 (notifications_sent.reservation_id NULLABLE + kinds waitlist_*).
--
-- Idempotência:
--   * UNIQUE parcial (waitlist_id, kind) WHERE waitlist_id IS NOT NULL impede
--     duplicar notifications_sent pra uma mesma entry de fila.

begin;

-- ─── 1. waitlist.seated_at ────────────────────────────────────────────────────
-- Captura quando a entry entrou no estado 'seated'. Sem essa coluna o worker
-- D+1 não consegue filtrar "ontem" sem ambiguidade (updated_at muda em qualquer
-- update). NULL pra status != seated.

alter table waitlist
  add column if not exists seated_at timestamptz;

create or replace function set_waitlist_seated_at()
returns trigger
language plpgsql
as $$
begin
  -- Set on transition TO 'seated' if not already set.
  if new.status = 'seated' and (old.status is null or old.status <> 'seated')
     and new.seated_at is null then
    new.seated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists waitlist_set_seated_at on waitlist;
create trigger waitlist_set_seated_at
  before update of status on waitlist
  for each row execute function set_waitlist_seated_at();

create index if not exists waitlist_unit_seated_at_idx
  on waitlist (unit_id, seated_at)
  where status = 'seated' and seated_at is not null;

-- ─── 2. notifications_sent.waitlist_id + idempotência ────────────────────────

alter table notifications_sent
  add column if not exists waitlist_id uuid references waitlist(id) on delete cascade;

create unique index if not exists notifications_sent_waitlist_kind_unique
  on notifications_sent (waitlist_id, kind)
  where waitlist_id is not null;

create index if not exists notifications_sent_waitlist_idx
  on notifications_sent (waitlist_id)
  where waitlist_id is not null;

-- ─── 3. RPC get_waitlist_for_feedback ────────────────────────────────────────
-- Retorna entries seated em `p_target_date` (BRT) que ainda não receberam
-- waitlist_feedback. Padrão idêntico a get_reservations_for_survey (mig 044).

create or replace function public.get_waitlist_for_feedback(
  p_target_date date,
  p_unit_id     uuid default null
)
returns table (
  waitlist_id     uuid,
  unit_id         uuid,
  customer_phone  text,
  customer_name   text,
  party_size      int,
  code            int
)
language sql
security definer
set search_path = public
stable
as $$
  select
    w.id,
    w.unit_id,
    w.customer_phone,
    w.customer_name,
    w.party_size,
    w.code
  from waitlist w
  where w.status = 'seated'
    and w.seated_at is not null
    -- "ontem em BRT" — BRT = UTC-3. Convertemos seated_at pra BRT antes do cast.
    and (w.seated_at at time zone 'America/Sao_Paulo')::date = p_target_date
    and w.customer_phone is not null
    and w.customer_phone <> ''
    and (p_unit_id is null or w.unit_id = p_unit_id)
    and not exists (
      select 1
        from notifications_sent n
       where n.waitlist_id = w.id
         and n.kind = 'waitlist_feedback'
         and n.status = 'sent'
    );
$$;

revoke all on function public.get_waitlist_for_feedback(date, uuid) from public;
revoke execute on function public.get_waitlist_for_feedback(date, uuid) from anon, authenticated;
grant execute on function public.get_waitlist_for_feedback(date, uuid) to service_role;

-- ─── 4. Trigger dispatch_waitlist_entered ────────────────────────────────────
-- AFTER INSERT em waitlist, dispara pg_net → process-waitlist-entered passando
-- o waitlist_id. Edge Function decide skip (sem phone, settings off, etc.) e
-- chama send-whatsapp. Trigger é fire-and-forget — falha de pg_net não bloqueia
-- o INSERT (try/catch).

create or replace function dispatch_waitlist_entered()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  api_key text;
  project_url text := 'https://gbabxcrntkwgblgqsiit.supabase.co';
begin
  -- Só dispara pra entries novas em 'waiting' com phone preenchido. Inserts
  -- importados / reativados não disparam.
  if new.status <> 'waiting' or new.customer_phone is null or new.customer_phone = '' then
    return new;
  end if;

  begin
    select decrypted_secret into api_key
    from vault.decrypted_secrets
    where name = 'internal_api_key'
    limit 1;

    if api_key is null or api_key = '' then
      raise notice '[waitlist-entered] internal_api_key ausente no Vault — skip';
      return new;
    end if;

    perform net.http_post(
      url := project_url || '/functions/v1/process-waitlist-entered',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-internal-key', api_key
      ),
      body := jsonb_build_object('waitlist_id', new.id),
      timeout_milliseconds := 30000
    );
  exception when others then
    -- Não bloqueia o INSERT por causa de falha de rede / Vault.
    raise notice '[waitlist-entered] dispatch falhou: %', sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists waitlist_dispatch_entered on waitlist;
create trigger waitlist_dispatch_entered
  after insert on waitlist
  for each row execute function dispatch_waitlist_entered();

-- ─── 5. Wrapper + cron pro feedback D+1 ─────────────────────────────────────

create or replace function trigger_waitlist_feedback_processor()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  api_key text;
  project_url text := 'https://gbabxcrntkwgblgqsiit.supabase.co';
begin
  select decrypted_secret into api_key
  from vault.decrypted_secrets
  where name = 'internal_api_key'
  limit 1;

  if api_key is null or api_key = '' then
    raise notice '[waitlist-feedback] internal_api_key ausente no Vault — cadastre via vault.create_secret()';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/process-waitlist-feedback',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-key', api_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

-- Feedback fila: 17:00 UTC = 14:00 BRT. Mesmo horário do survey de reservas
-- (mig 045) — workers são independentes, sem disputa de recursos.
do $$
begin
  perform cron.unschedule('process-waitlist-feedback');
exception when others then
  null;
end $$;

select cron.schedule(
  'process-waitlist-feedback',
  '0 17 * * *',
  'select trigger_waitlist_feedback_processor();'
);

commit;
