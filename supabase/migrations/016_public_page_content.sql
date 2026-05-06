-- Migration 016: conteúdo da página pública do restaurante
-- Adiciona colunas de marketing em `units`, libera UPDATE para owner/gerente,
-- abre `waitlist` para inserts anônimos e cria bucket de Storage `unit-assets`.
-- Dependência: 014_operacional.sql (waitlist), 013_multi_tenant.sql (units, unit_members).

begin;

-- ─── 1. Colunas de conteúdo público em units ──────────────────────────────────

alter table units
  add column if not exists description       text,
  add column if not exists price_range_min   numeric(10,2),
  add column if not exists price_range_max   numeric(10,2),
  add column if not exists hero_image_url    text,
  add column if not exists logo_url          text;

-- address (jsonb) já existe; convenção esperada:
-- { "street", "number", "neighborhood", "city", "state", "cep", "full" }
-- onde `full` é a string usada no embed do Google Maps.

-- ─── 2. RLS: owner/gerente passa a poder UPDATE units ────────────────────────
-- Hoje só platform_admin podia escrever em units (013).

drop policy if exists "unit_owner_gerente_update_units" on units;

create policy "unit_owner_gerente_update_units" on units
  for update to authenticated
  using (
    exists (
      select 1 from unit_members um
      where um.unit_id = units.id
        and um.user_id = auth.uid()
        and um.role in ('owner','gerente')
    )
  )
  with check (
    exists (
      select 1 from unit_members um
      where um.unit_id = units.id
        and um.user_id = auth.uid()
        and um.role in ('owner','gerente')
    )
  );

-- ─── 3. RPC pública: get_unit_public retorna os novos campos ─────────────────

create or replace function public.get_unit_public(p_slug text)
returns table (
  id                uuid,
  name              text,
  slug              text,
  address           jsonb,
  timezone          text,
  organization_id   uuid,
  organization_name text,
  description       text,
  price_range_min   numeric,
  price_range_max   numeric,
  hero_image_url    text,
  logo_url          text
)
language sql
security definer
set search_path = public
stable
as $$
  select
    u.id,
    u.name,
    u.slug,
    u.address,
    u.timezone,
    u.organization_id,
    o.name as organization_name,
    u.description,
    u.price_range_min,
    u.price_range_max,
    u.hero_image_url,
    u.logo_url
  from units u
  join organizations o on o.id = u.organization_id
  where u.slug = lower(p_slug)
    and u.is_public = true
  limit 1;
$$;

grant execute on function public.get_unit_public(text) to anon, authenticated;

-- ─── 4. Waitlist: permitir INSERT anônimo (Entrar na Fila público) ───────────

drop policy if exists "anon_insert_waitlist" on waitlist;

create policy "anon_insert_waitlist" on waitlist
  for insert to anon
  with check (
    unit_id is not null
    and status = 'waiting'
    and party_size between 1 and 20
  );

-- ─── 5. Storage bucket público para logos e hero images ──────────────────────

insert into storage.buckets (id, name, public)
values ('unit-assets', 'unit-assets', true)
on conflict (id) do update set public = excluded.public;

-- Read público (qualquer um pode ver as imagens — bucket publica via CDN)
drop policy if exists "public_read_unit_assets" on storage.objects;
create policy "public_read_unit_assets" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'unit-assets');

-- Write apenas por owner/gerente da unidade dona do path.
-- Convenção do path: <unit_id>/<kind>-<timestamp>.<ext>  (ex: ab12.../hero-1735000000.jpg)

drop policy if exists "unit_member_insert_unit_assets" on storage.objects;
create policy "unit_member_insert_unit_assets" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'unit-assets'
    and exists (
      select 1 from unit_members um
      where um.user_id = auth.uid()
        and um.unit_id::text = split_part(name, '/', 1)
        and um.role in ('owner','gerente')
    )
  );

drop policy if exists "unit_member_update_unit_assets" on storage.objects;
create policy "unit_member_update_unit_assets" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'unit-assets'
    and exists (
      select 1 from unit_members um
      where um.user_id = auth.uid()
        and um.unit_id::text = split_part(name, '/', 1)
        and um.role in ('owner','gerente')
    )
  );

drop policy if exists "unit_member_delete_unit_assets" on storage.objects;
create policy "unit_member_delete_unit_assets" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'unit-assets'
    and exists (
      select 1 from unit_members um
      where um.user_id = auth.uid()
        and um.unit_id::text = split_part(name, '/', 1)
        and um.role in ('owner','gerente')
    )
  );

commit;
