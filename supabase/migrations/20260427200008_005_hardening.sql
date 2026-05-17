-- Hardening P0: fechar leitura anon, expor RPC controlada,
-- adicionar idempotência e rate limit para o webhook do agente IA.

-- ─── A. Fechar RLS de leitura anon ───────────────────────────────────────────
-- Antes: anon podia "select *" em reservations e customers — vazamento de PII.
-- Depois: anon perde SELECT direto; consulta pública passa pela RPC abaixo.

drop policy if exists "anon_select_reservation" on reservations;
drop policy if exists "anon_select_own_customer" on customers;

-- INSERT permanece liberado (form público continua criando reserva/cliente).
-- auth_all_* (admin) permanece intacto.

-- ─── B. RPC controlada para consulta pública por código ──────────────────────
-- Achata customer em colunas explícitas para evitar expor o objeto inteiro.

create or replace function public.get_reservation_by_code(p_code text)
returns table (
  id                uuid,
  reservation_code  text,
  date              date,
  time              time,
  party_size        integer,
  status            text,
  notes             text,
  created_at        timestamptz,
  updated_at        timestamptz,
  customer_name     text,
  customer_phone    text,
  customer_email    text
)
language sql
security definer
set search_path = public
stable
as $$
  select
    r.id,
    r.reservation_code,
    r.date,
    r.time,
    r.party_size,
    r.status,
    r.notes,
    r.created_at,
    r.updated_at,
    c.name,
    c.phone,
    c.email
  from reservations r
  join customers c on c.id = r.customer_id
  where r.reservation_code = upper(p_code)
  limit 1;
$$;

revoke all on function public.get_reservation_by_code(text) from public;
grant execute on function public.get_reservation_by_code(text) to anon, authenticated;

-- ─── C. Idempotência do webhook Z-API ────────────────────────────────────────

create table if not exists processed_messages (
  message_id    text primary key,
  processed_at  timestamptz not null default now()
);

alter table processed_messages enable row level security;
-- Sem policies = acesso apenas via service_role (Edge Functions).

-- ─── D. Rate limit por telefone (sliding window) ─────────────────────────────

create table if not exists rate_limit_events (
  id          bigserial primary key,
  phone       text not null,
  created_at  timestamptz not null default now()
);

create index if not exists rate_limit_events_phone_created_idx
  on rate_limit_events(phone, created_at desc);

alter table rate_limit_events enable row level security;
-- Sem policies = acesso apenas via service_role (a função check_rate_limit
-- roda como SECURITY DEFINER e bypassa RLS dentro do search_path public).

create or replace function public.check_rate_limit(
  p_phone           text,
  p_window_seconds  integer,
  p_max             integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  -- GC oportunista (não impacta accuracy da janela atual).
  delete from rate_limit_events
   where created_at < now() - interval '1 hour';

  select count(*)
    into v_count
    from rate_limit_events
   where phone = p_phone
     and created_at > now() - make_interval(secs => p_window_seconds);

  if v_count >= p_max then
    return false;
  end if;

  insert into rate_limit_events(phone) values (p_phone);
  return true;
end;
$$;

revoke all on function public.check_rate_limit(text, integer, integer) from public;
grant execute on function public.check_rate_limit(text, integer, integer) to service_role;
