-- Migration 036: Módulo "Fila de espera" no painel de gestão.
--
--   * Templates de mensagem WhatsApp por evento (entered / table_ready / feedback)
--     em `waitlist_message_templates` (1 linha por unit×event quando customizado).
--   * `waitlist.code` int — senha sequencial cíclica dentro do range configurado
--     em `settings` (waitlist_code_min/waitlist_code_max).
--   * `waitlist.priority_category` text — categoria (normal/senior/pregnant/
--     disabled/other) substitui o uso semântico de `priority` int. O campo `priority`
--     legacy continua existindo e é alimentado por trigger derivada da categoria
--     (mantém compat com os ORDER BY já em uso).
--   * RPC `next_waitlist_code(unit_id)` — retorna próximo código disponível
--     dentro do range; cíclica quando esgota; usada via `select` da Edge
--     Function ou diretamente pelo formulário público.
--
-- Dependências: 014_operacional.sql (waitlist), 023b_lock_anon_policies.sql
-- (anon_insert_waitlist).

begin;

-- ─── 1. waitlist: code + priority_category ──────────────────────────────────────

alter table waitlist
  add column if not exists code int,
  add column if not exists priority_category text not null default 'normal'
    check (priority_category in ('normal','senior','pregnant','disabled','other'));

-- `priority` int (legacy) é mantida e mapeada por trigger:
--    normal → 0, qualquer outra categoria → -10 (vai pro topo no ORDER BY priority asc).
create or replace function set_waitlist_priority_from_category()
returns trigger
language plpgsql
as $$
begin
  if new.priority_category = 'normal' then
    new.priority := 0;
  else
    new.priority := -10;
  end if;
  return new;
end;
$$;

drop trigger if exists waitlist_priority_from_category on waitlist;
create trigger waitlist_priority_from_category
  before insert or update of priority_category on waitlist
  for each row execute function set_waitlist_priority_from_category();

-- Unique parcial: dois clientes ativos não podem ter o mesmo code na mesma unit.
-- Cancelados/sentados liberam o código para reuso (cíclico).
create unique index if not exists waitlist_unit_active_code_unique
  on waitlist (unit_id, code)
  where status in ('waiting', 'notified') and code is not null;

create index if not exists waitlist_unit_code_idx on waitlist (unit_id, code);

-- ─── 2. RPC next_waitlist_code ──────────────────────────────────────────────────

create or replace function public.next_waitlist_code(p_unit_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_min int;
  v_max int;
  v_next int;
begin
  -- range vem de settings (defaults sensatos quando ausente)
  select coalesce((value)::text::int, 1) into v_min
    from settings where unit_id = p_unit_id and key = 'waitlist_code_min';
  if v_min is null then v_min := 1; end if;

  select coalesce((value)::text::int, 1000) into v_max
    from settings where unit_id = p_unit_id and key = 'waitlist_code_max';
  if v_max is null then v_max := 1000; end if;

  if v_min < 1 then v_min := 1; end if;
  if v_max < v_min then v_max := v_min; end if;

  -- max(code) entre os ativos da unit, +1; cicla pra v_min se ultrapassar v_max
  select coalesce(max(code) + 1, v_min) into v_next
    from waitlist
    where unit_id = p_unit_id
      and code is not null
      and status in ('waiting', 'notified');

  if v_next < v_min or v_next > v_max then
    v_next := v_min;
  end if;

  -- procura o primeiro slot livre a partir de v_next (cíclico)
  -- (pra cobrir gaps quando alguém cancelou no meio do range)
  for i in 0..(v_max - v_min) loop
    if not exists (
      select 1 from waitlist
      where unit_id = p_unit_id
        and code = v_next
        and status in ('waiting', 'notified')
    ) then
      return v_next;
    end if;
    v_next := v_next + 1;
    if v_next > v_max then v_next := v_min; end if;
  end loop;

  -- range completamente ocupado — retorna v_min (último recurso)
  return v_min;
end;
$$;

revoke all on function public.next_waitlist_code(uuid) from public;
grant execute on function public.next_waitlist_code(uuid) to anon, authenticated;

-- ─── 3. waitlist_message_templates ──────────────────────────────────────────────

create table if not exists waitlist_message_templates (
  id          uuid primary key default gen_random_uuid(),
  unit_id     uuid not null references units(id) on delete cascade,
  event       text not null check (event in ('entered','table_ready','feedback')),
  customized  boolean not null default false,
  body        text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (unit_id, event)
);

create trigger waitlist_message_templates_updated_at
  before update on waitlist_message_templates
  for each row execute function update_updated_at();

alter table waitlist_message_templates enable row level security;

-- Membros da unit gerenciam (CRUD)
drop policy if exists "wlmt_member_select" on waitlist_message_templates;
create policy "wlmt_member_select" on waitlist_message_templates
  for select using (is_unit_member(auth.uid(), unit_id));

drop policy if exists "wlmt_member_insert" on waitlist_message_templates;
create policy "wlmt_member_insert" on waitlist_message_templates
  for insert with check (is_unit_member(auth.uid(), unit_id));

drop policy if exists "wlmt_member_update" on waitlist_message_templates;
create policy "wlmt_member_update" on waitlist_message_templates
  for update using (is_unit_member(auth.uid(), unit_id));

drop policy if exists "wlmt_member_delete" on waitlist_message_templates;
create policy "wlmt_member_delete" on waitlist_message_templates
  for delete using (is_unit_member(auth.uid(), unit_id));

commit;
