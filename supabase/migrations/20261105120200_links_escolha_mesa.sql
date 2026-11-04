-- Escolha de mesa, passo 3: links de escolha do WhatsApp e limite de acesso do
-- mapa público. Spec: docs/superpowers/specs/2026-11-04-escolha-de-mesa-design.md;
-- plano: docs/superpowers/plans/2026-11-04-escolha-de-mesa.md, Task 3.
--
-- Aditiva (expand), nada a ler pelo front publicado.
--   * `seat_choice_links`: o agente grava um link por pedido de escolha (só o
--     SHA-256 hex do token, nunca o token); a EF pública `public-seat-map` lê
--     pelo hash e pela validade. FORCE RLS sem policy e sem privilégio para
--     anon/authenticated: só service_role, que filtra `unit_id`. O trigger
--     `guard_seat_choice_link` garante salão e canal da mesma unidade do link,
--     porque o service role ignora RLS e o link vai para a mão do cliente.
--   * `check_public_seat_map_rate_limit`: mesmo desenho da
--     `check_public_waitlist_rate_limit` (20261017173000), com tabela de
--     contagem própria (`seat_map_rate_events`) e limite 30 por 60 s.
--     `p_unit_id` nulo é o balde do modo token (a unidade só se sabe depois de
--     ler o link); a chave é `public-seat-map-ip:<sha256 hex>`. A tabela não
--     tem FK em unit_id: é contador, e id de unidade inexistente só conta
--     (sem 23503 que diferencie unidade existente de inexistente).
--
-- Rollback (migration nova, nunca edição desta): drop da função
-- check_public_seat_map_rate_limit, do trigger seat_choice_links_guard, da
-- função app_private.guard_seat_choice_link e das tabelas seat_choice_links e
-- seat_map_rate_events.
-- Pré-voo: supabase/tests/local-preflight/83-escolha-de-mesa.sql (README §83).
begin;
set local lock_timeout = '5s';

-- ─── Links de escolha ────────────────────────────────────────────────────────
create table if not exists public.seat_choice_links (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  hall_id uuid not null references public.halls(id) on delete cascade,
  channel_id uuid references public.whatsapp_channels(id) on delete set null,
  date date not null,
  time time not null,
  party_size integer not null,
  token_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint seat_choice_links_party_size_check check (party_size between 1 and 50),
  constraint seat_choice_links_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint seat_choice_links_expiry_check
    check (expires_at > created_at and expires_at <= created_at + interval '24 hours'),
  constraint seat_choice_links_token_hash_key unique (token_hash)
);
create index if not exists seat_choice_links_unit_idx on public.seat_choice_links (unit_id);
create index if not exists seat_choice_links_expires_idx on public.seat_choice_links (expires_at);
comment on table public.seat_choice_links is
  'Link de escolha de mesa enviado pelo agente no WhatsApp: salão, data, hora e pessoas do pedido, válido até expires_at (6 h no código, 24 h no máximo). Só o SHA-256 hex do token. Sem policy e sem privilégio para anon/authenticated: só service_role (EF public-seat-map e agente), filtrando unit_id. Sem PII.';

alter table public.seat_choice_links enable row level security;
alter table public.seat_choice_links force row level security;
revoke all on table public.seat_choice_links from public, anon, authenticated, service_role;
grant select, insert, delete on table public.seat_choice_links to service_role;

create or replace function app_private.guard_seat_choice_link()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.halls h where h.id = new.hall_id and h.unit_id = new.unit_id;
  if not found then
    raise exception 'seat_link_invalid' using errcode = '42501';
  end if;
  if new.channel_id is not null then
    perform 1 from public.whatsapp_channels c where c.id = new.channel_id and c.unit_id = new.unit_id;
    if not found then
      raise exception 'seat_link_invalid' using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;
comment on function app_private.guard_seat_choice_link() is
  'seat_choice_links: salão e canal da mesma unidade do link (42501 seat_link_invalid, mesma mensagem para alheio e inexistente).';
revoke all on function app_private.guard_seat_choice_link() from public, anon, authenticated, service_role;

drop trigger if exists seat_choice_links_guard on public.seat_choice_links;
create trigger seat_choice_links_guard
  before insert or update on public.seat_choice_links
  for each row execute function app_private.guard_seat_choice_link();

-- ─── Limite de acesso do mapa público ────────────────────────────────────────
create table if not exists public.seat_map_rate_events (
  id bigserial primary key,
  unit_id uuid,
  ip_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists seat_map_rate_events_key_idx
  on public.seat_map_rate_events (ip_hash, unit_id, created_at);
create index if not exists seat_map_rate_events_created_idx
  on public.seat_map_rate_events (created_at);
comment on table public.seat_map_rate_events is
  'Contagem da check_public_seat_map_rate_limit (EF public-seat-map). unit_id nulo = modo token. Sem FK: contador apagado depois de 1 h. Sem policy e sem privilégio: só a função DEFINER escreve.';

alter table public.seat_map_rate_events enable row level security;
alter table public.seat_map_rate_events force row level security;
revoke all on table public.seat_map_rate_events from public, anon, authenticated, service_role;
revoke all on sequence public.seat_map_rate_events_id_seq from public, anon, authenticated, service_role;

create or replace function public.check_public_seat_map_rate_limit(
  p_unit_id uuid,
  p_ip_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_count integer;
begin
  if p_ip_hash is null or p_ip_hash !~ '^public-seat-map-ip:[0-9a-f]{64}$' then
    raise exception 'public_seat_map_rate_limit_invalid' using errcode = '22023';
  end if;

  -- Serializa contagem+insert por unidade (ou modo token) e IP, inclusive
  -- entre invocações independentes da EF. Colisão de 64 bits só limita a mais.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public_seat_map_rate:' || coalesce(p_unit_id::text, 'token') || ':' || p_ip_hash, 0)
  );
  v_now := pg_catalog.clock_timestamp();

  delete from public.seat_map_rate_events
   where created_at < v_now - interval '1 hour';

  select count(*) into v_count
    from public.seat_map_rate_events e
   where e.unit_id is not distinct from p_unit_id
     and e.ip_hash = p_ip_hash
     and e.created_at >= v_now - interval '60 seconds';
  if v_count >= 30 then return false; end if;

  insert into public.seat_map_rate_events (unit_id, ip_hash, created_at)
  values (p_unit_id, p_ip_hash, v_now);
  return true;
end;
$$;
comment on function public.check_public_seat_map_rate_limit(uuid, text) is
  'Só service_role (EF public-seat-map): true e conta a chamada se o IP fez menos de 30 nos últimos 60 s para a unidade (p_unit_id nulo = modo token); false sem contar. Chave fora de public-seat-map-ip:<sha256 hex>: 22023.';
revoke all on function public.check_public_seat_map_rate_limit(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.check_public_seat_map_rate_limit(uuid, text) to service_role;

commit;
