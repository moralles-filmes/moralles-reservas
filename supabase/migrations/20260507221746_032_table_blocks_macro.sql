-- Migration 032: bloqueios macro
--
-- Mudanças:
--   - `unit_id` (NOT NULL): escopo direto da unit. Backfill via tables.unit_id.
--   - `hall_id` (nullable): bloqueio pode ser scoped a um salão específico.
--   - `title` (text): nome exibido na UI. Migra `reason` quando vazio.
--   - `table_id` agora nullable: bloqueio macro = unit/hall toda no intervalo.
--   - RLS: usa `unit_id` direto (não deriva mais via `tables`).
--
-- O modelo "por mesa" continua suportado em runtime (avaliação via
-- availability.ts) mas a UI nova só cria bloqueios macro.

begin;

alter table table_blocks
  add column if not exists unit_id uuid references units(id) on delete cascade,
  add column if not exists hall_id uuid references halls(id) on delete cascade,
  add column if not exists title text;

alter table table_blocks
  alter column table_id drop not null;

-- Backfill unit_id via tables.unit_id pra rows existentes (sempre tinham table_id)
update table_blocks tb
set unit_id = (select t.unit_id from tables t where t.id = tb.table_id)
where tb.unit_id is null and tb.table_id is not null;

alter table table_blocks
  alter column unit_id set not null;

-- Migra reason → title (preserva motivo legado)
update table_blocks set title = reason where title is null and reason is not null;

create index if not exists table_blocks_unit_range_idx
  on table_blocks (unit_id, blocked_from, blocked_to);
create index if not exists table_blocks_hall_idx
  on table_blocks (hall_id) where hall_id is not null;

-- RLS: simplifica usando unit_id direto. Funciona pra rows com e sem table_id.
drop policy if exists "unit_member_all_table_blocks" on table_blocks;
create policy "unit_member_all_table_blocks" on table_blocks
  for all to authenticated
  using (is_unit_member(auth.uid(), unit_id))
  with check (is_unit_member(auth.uid(), unit_id));

-- platform_admin policy permanece (já existe via 013)

commit;
