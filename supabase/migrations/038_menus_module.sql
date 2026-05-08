-- Migration 038: módulo "Cardápios"
--
-- Tabelas:
--   * menus            — recurso público com slug, paleta (theme JSONB), cover.
--   * menu_pages       — galeria ordenada de imagens (cardápio fotografado).
--   * menu_banners     — banners da unit, dois tipos: 'home' (story 1080x1919)
--                        e 'content' (1080x1080), reaproveitados em /m/<slug>.
--
-- RLS: membros da unit fazem CRUD; SELECT anon não toca tabelas direto — só
-- via RPC `get_menu_public(slug)` SECURITY DEFINER (mesmo padrão Widget).

begin;

-- ─── menus ─────────────────────────────────────────────────────────────────────
create table if not exists menus (
  id              uuid primary key default gen_random_uuid(),
  unit_id         uuid not null references units(id) on delete cascade,
  slug            text not null unique,
  name            text not null,
  cover_image_url text,
  theme           jsonb not null default jsonb_build_object(
    'font_primary',   '#141414',
    'font_secondary', '#AAAAAA',
    'bg_primary',     '#FFFFFF',
    'bg_secondary',   '#EFF2F5',
    'accent',         '#DD4F50'
  ),
  active          boolean not null default true,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists menus_unit_idx on menus(unit_id);

drop trigger if exists menus_updated_at on menus;
create trigger menus_updated_at
  before update on menus
  for each row execute function update_updated_at();

-- ─── menu_pages ────────────────────────────────────────────────────────────────
create table if not exists menu_pages (
  id          uuid primary key default gen_random_uuid(),
  menu_id     uuid not null references menus(id) on delete cascade,
  image_url   text not null,
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists menu_pages_menu_idx on menu_pages(menu_id, sort_order);

-- ─── menu_banners ──────────────────────────────────────────────────────────────
create table if not exists menu_banners (
  id          uuid primary key default gen_random_uuid(),
  unit_id     uuid not null references units(id) on delete cascade,
  type        text not null check (type in ('home', 'content')),
  image_url   text not null,
  link_url    text,
  active      boolean not null default false,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists menu_banners_unit_type_idx
  on menu_banners(unit_id, type, sort_order);

drop trigger if exists menu_banners_updated_at on menu_banners;
create trigger menu_banners_updated_at
  before update on menu_banners
  for each row execute function update_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS — anon NÃO lê direto; leitura pública via RPC abaixo.
-- ═══════════════════════════════════════════════════════════════════════════

alter table menus         enable row level security;
alter table menu_pages    enable row level security;
alter table menu_banners  enable row level security;

-- menus
drop policy if exists "platform_admin_all_menus" on menus;
create policy "platform_admin_all_menus" on menus
  for all to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

drop policy if exists "unit_member_all_menus" on menus;
create policy "unit_member_all_menus" on menus
  for all to authenticated
  using (is_unit_member(auth.uid(), unit_id))
  with check (is_unit_member(auth.uid(), unit_id));

-- menu_pages — escopo pelo menu pai
drop policy if exists "platform_admin_all_menu_pages" on menu_pages;
create policy "platform_admin_all_menu_pages" on menu_pages
  for all to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

drop policy if exists "unit_member_all_menu_pages" on menu_pages;
create policy "unit_member_all_menu_pages" on menu_pages
  for all to authenticated
  using (
    exists (
      select 1 from menus m
      where m.id = menu_pages.menu_id
        and is_unit_member(auth.uid(), m.unit_id)
    )
  )
  with check (
    exists (
      select 1 from menus m
      where m.id = menu_pages.menu_id
        and is_unit_member(auth.uid(), m.unit_id)
    )
  );

-- menu_banners
drop policy if exists "platform_admin_all_menu_banners" on menu_banners;
create policy "platform_admin_all_menu_banners" on menu_banners
  for all to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

drop policy if exists "unit_member_all_menu_banners" on menu_banners;
create policy "unit_member_all_menu_banners" on menu_banners
  for all to authenticated
  using (is_unit_member(auth.uid(), unit_id))
  with check (is_unit_member(auth.uid(), unit_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- RPC pública: retorna menu + pages + banners (home/content), só pra units
-- e organizations públicas e cardápios ativos.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.get_menu_public(p_slug text)
returns jsonb
language sql security definer stable
set search_path = public
as $$
  with m as (
    select mn.*
    from menus mn
    join units u        on u.id = mn.unit_id
    join organizations o on o.id = u.organization_id
    where mn.slug = p_slug
      and mn.active = true
      and u.is_public = true
      and o.is_public = true
    limit 1
  )
  select case
    when not exists (select 1 from m) then null
    else jsonb_build_object(
      'menu', (
        select jsonb_build_object(
          'id', m.id,
          'slug', m.slug,
          'name', m.name,
          'cover_image_url', m.cover_image_url,
          'theme', m.theme
        ) from m
      ),
      'unit', (
        select jsonb_build_object(
          'id', u.id,
          'name', u.name,
          'slug', u.slug,
          'logo_url', u.logo_url
        )
        from units u
        where u.id = (select unit_id from m)
      ),
      'pages', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'id', mp.id,
            'image_url', mp.image_url,
            'sort_order', mp.sort_order
          ) order by mp.sort_order, mp.created_at
        ), '[]'::jsonb)
        from menu_pages mp
        where mp.menu_id = (select id from m)
      ),
      'banners', jsonb_build_object(
        'home', (
          select coalesce(jsonb_agg(
            jsonb_build_object(
              'id', mb.id,
              'image_url', mb.image_url,
              'link_url', mb.link_url,
              'sort_order', mb.sort_order
            ) order by mb.sort_order, mb.created_at
          ), '[]'::jsonb)
          from menu_banners mb
          where mb.unit_id = (select unit_id from m)
            and mb.type = 'home'
            and mb.active = true
        ),
        'content', (
          select coalesce(jsonb_agg(
            jsonb_build_object(
              'id', mb.id,
              'image_url', mb.image_url,
              'link_url', mb.link_url,
              'sort_order', mb.sort_order
            ) order by mb.sort_order, mb.created_at
          ), '[]'::jsonb)
          from menu_banners mb
          where mb.unit_id = (select unit_id from m)
            and mb.type = 'content'
            and mb.active = true
        )
      )
    )
  end;
$$;

revoke all on function public.get_menu_public(text) from public;
grant execute on function public.get_menu_public(text) to anon, authenticated;

commit;
