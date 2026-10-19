-- 75a: base do pré-voo 75 (escrita em `settings` por chave e papel).
--
-- RODA DEPOIS DE: 00-bootstrap -> 01-audit -> 09a-advisor-bootstrap -> migration
-- 20260910120000_106 (a base do 68). Ela já traz `units`, `unit_members`,
-- `platform_admins`, `settings` com o UNIQUE e os helpers `app_private.*` na
-- forma de produção. Este arquivo NÃO instala o trigger novo: só deixa a tabela
-- no estado de produção ANTES da migration 20261019180000, para o 75 medir o
-- RED (guarda aborta) e depois o GREEN.
--
-- O que este arquivo acrescenta, conferido em produção em 2026-10-19 (MCP, só
-- leitura):
--   * `auth.role()` na forma do Supabase (nenhum arquivo da base a define);
--   * RLS ligada (não forçada) e as duas policies de `settings`, com o texto de
--     `pg_policies.qual` de produção;
--   * a ACL de tabela de produção (`arwdDxtm` para anon, authenticated e
--     service_role). Produção não tem ACL de coluna em `settings`; o grant de
--     coluna a anon abaixo é SINTÉTICO, para o S16 conferir que nenhum grant
--     de coluna sobra (o `REVOKE` de tabela já o remove, medido no PG 18; o
--     bloco `DO` da migration é reforço e o S16 não distingue os dois);
--   * o trigger `whatsapp_legacy_template_write` com o corpo de produção, para
--     o S13 provar que os dois guards convivem;
--   * unidades, atores e linhas iniciais (UUIDs fixos `a0d75000-…`).
-- Re-executável.

-- ─── auth.role(): definição do Supabase ──────────────────────────────────────
-- Mesmo corpo de produção em 2026-10-19 (lê `claim.role` e cai para
-- `request.jwt.claims`). O guard depende disso: com a forma antiga, que só lê
-- `claim.role`, toda escrita da Gestão via PostgREST receberia 42501.
create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )::text
$$;

-- ─── settings no estado de produção ──────────────────────────────────────────
alter table public.settings enable row level security;
grant all on table public.settings to anon, authenticated, service_role;
grant insert (value), update (value) on table public.settings to anon;  -- sintético (S16)

drop policy if exists "platform_admin_all_settings" on public.settings;
create policy "platform_admin_all_settings" on public.settings
  for all to authenticated
  using (app_private.is_platform_admin(auth.uid()))
  with check (app_private.is_platform_admin(auth.uid()));

drop policy if exists "unit_member_all_settings" on public.settings;
create policy "unit_member_all_settings" on public.settings
  for all to authenticated
  using (app_private.is_unit_member(auth.uid(), unit_id))
  with check (app_private.is_unit_member(auth.uid(), unit_id));

-- ─── Dependências do guard de template legado ────────────────────────────────
-- `whatsapp_channels.is_active` existe em produção e falta no 00-bootstrap.
alter table public.whatsapp_channels add column if not exists is_active boolean;

-- Forma mínima: só as colunas que o corpo do guard toca.
create table if not exists app_private.whatsapp_template_maintenance_permits (
  id             uuid primary key default gen_random_uuid(),
  transaction_id bigint not null,
  actor_id       uuid not null,
  action         text not null,
  table_name     text not null,
  row_id         uuid not null,
  unit_id        uuid not null,
  event_key      text not null
);

-- Extraído de produção em 2026-10-19 (`select prosrc from pg_proc where proname =
-- 'guard_whatsapp_legacy_template_write'`); corpo idêntico, só CRLF -> LF.
-- Atributos de produção: plpgsql, SECURITY DEFINER, search_path="", proacl
-- {postgres=X/postgres}.
create or replace function public.guard_whatsapp_legacy_template_write()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  v_old jsonb; v_new jsonb; v_scope jsonb; v_unit uuid; v_key text;
  v_actor uuid:=auth.uid(); v_admin boolean; v_official boolean;
  v_need_official boolean:=false; v_changed boolean; v_permit uuid; v_row uuid;
begin
  if tg_op<>'INSERT' then v_old:=to_jsonb(old); end if;
  if tg_op<>'DELETE' then v_new:=to_jsonb(new); end if;
  if tg_op='DELETE' and old.unit_id is not null and not exists(select from public.units where id=old.unit_id) then return old; end if;
  if tg_table_name='settings' and coalesce(v_old->>'key','')<>'giftback_message_template' and coalesce(v_new->>'key','')<>'giftback_message_template' then
    if tg_op='DELETE' then return old; end if; return new;
  end if;
  if tg_op='UPDATE' then
    if tg_table_name='settings' then
      v_changed:=(v_old->'id',v_old->'unit_id',v_old->'key',v_old->'value') is distinct from (v_new->'id',v_new->'unit_id',v_new->'key',v_new->'value');
    else
      v_changed:=(v_old->'id',v_old->'unit_id',v_old->'event',v_old->'body',v_old->'customized') is distinct from (v_new->'id',v_new->'unit_id',v_new->'event',v_new->'body',v_new->'customized');
    end if;
    if not v_changed then return new; end if;
  end if;
  -- BOTH scopes are checked: moving a protected row/key cannot evade the guard.
  if auth.role() is distinct from 'authenticated' or v_actor is null then raise exception 'template_configuration_role_required' using errcode='42501'; end if;
  v_admin:=app_private.is_platform_admin(v_actor);
  foreach v_scope in array array[v_old,v_new] loop
    if v_scope is null then continue; end if;
    v_unit:=(v_scope->>'unit_id')::uuid;
    v_key:=case when tg_table_name='settings' then v_scope->>'key' else v_scope->>'event' end;
    if tg_table_name='settings' and v_key<>'giftback_message_template' then continue; end if;
    if not v_admin and not exists(select from public.unit_members where user_id=v_actor and unit_id=v_unit and role in('owner','gerente')) then raise exception 'template_configuration_role_required' using errcode='42501'; end if;
    if tg_table_name='waitlist_message_templates' and v_key='table_ready' then continue; end if;
    select c.provider in('official','datafy') into v_official from public.whatsapp_channels c where c.unit_id=v_unit and (c.is_active=true or (c.is_active is null and c.status='connected' and not exists(select from public.whatsapp_channels a where a.unit_id=v_unit and a.is_active=true))) order by c.is_active desc nulls last,c.created_at asc,c.id limit 1;
    v_need_official:=v_need_official or coalesce(v_official,false);
  end loop;
  if v_need_official then
    if not v_admin then raise exception 'official_template_immutable' using errcode='42501'; end if;
    v_scope:=coalesce(v_old,v_new); v_row:=(v_scope->>'id')::uuid;
    delete from app_private.whatsapp_template_maintenance_permits
    where transaction_id=txid_current() and actor_id=v_actor and action=tg_op and table_name=tg_table_name and row_id=v_row
      and unit_id=(v_scope->>'unit_id')::uuid and event_key=case when tg_table_name='settings' then v_scope->>'key' else v_scope->>'event' end
    returning id into v_permit;
    if v_permit is null then
      raise exception 'official_template_immutable' using errcode='42501';
    end if;
    if tg_op='UPDATE' and ((v_old->>'id',v_old->>'unit_id',coalesce(v_old->>'event',v_old->>'key')) is distinct from (v_new->>'id',v_new->>'unit_id',coalesce(v_new->>'event',v_new->>'key'))) then raise exception 'official_template_immutable' using errcode='42501'; end if;
  end if;
  if tg_op='DELETE' then return old; end if; return new;
end $function$;
revoke all on function public.guard_whatsapp_legacy_template_write() from public, anon, authenticated, service_role;

drop trigger if exists whatsapp_legacy_template_write on public.settings;
create trigger whatsapp_legacy_template_write
  before insert or update or delete on public.settings
  for each row execute function public.guard_whatsapp_legacy_template_write();

-- ─── Fixtures ────────────────────────────────────────────────────────────────
-- U1: owner (…a1), gerente (…a2), operador (…a3). U2: gerente (…b2).
-- DUAL (…a4): operador em U1 e gerente em U2 (S7: mover linha de U1 para U2
-- passa no NEW e na RLS, só o escopo OLD recusa).
-- PA (…c1): platform_admin sem membership.
insert into auth.users (id, email) values
  ('a0d75000-0000-4000-8000-0000000000a1', 'set75-owner-u1@example.test'),
  ('a0d75000-0000-4000-8000-0000000000a2', 'set75-gerente-u1@example.test'),
  ('a0d75000-0000-4000-8000-0000000000a3', 'set75-operador-u1@example.test'),
  ('a0d75000-0000-4000-8000-0000000000a4', 'set75-dual@example.test'),
  ('a0d75000-0000-4000-8000-0000000000b2', 'set75-gerente-u2@example.test'),
  ('a0d75000-0000-4000-8000-0000000000c1', 'set75-pa@example.test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('a0d75000-0000-4000-8000-00000000000a', 'set75 org')
on conflict (id) do nothing;

insert into units (id, organization_id, name) values
  ('a0d75000-0000-4000-8000-0000000000aa', 'a0d75000-0000-4000-8000-00000000000a', 'set75 U1'),
  ('a0d75000-0000-4000-8000-0000000000bb', 'a0d75000-0000-4000-8000-00000000000a', 'set75 U2')
on conflict (id) do nothing;

insert into unit_members (user_id, unit_id, role) values
  ('a0d75000-0000-4000-8000-0000000000a1', 'a0d75000-0000-4000-8000-0000000000aa', 'owner'),
  ('a0d75000-0000-4000-8000-0000000000a2', 'a0d75000-0000-4000-8000-0000000000aa', 'gerente'),
  ('a0d75000-0000-4000-8000-0000000000a3', 'a0d75000-0000-4000-8000-0000000000aa', 'operador'),
  ('a0d75000-0000-4000-8000-0000000000a4', 'a0d75000-0000-4000-8000-0000000000aa', 'operador'),
  ('a0d75000-0000-4000-8000-0000000000a4', 'a0d75000-0000-4000-8000-0000000000bb', 'gerente'),
  ('a0d75000-0000-4000-8000-0000000000b2', 'a0d75000-0000-4000-8000-0000000000bb', 'gerente')
on conflict (user_id, unit_id) do nothing;

insert into platform_admins (user_id) values ('a0d75000-0000-4000-8000-0000000000c1')
on conflict (user_id) do nothing;

-- Canal NÃO oficial ativo em U1: o guard legado deixa owner/gerente gravar
-- `giftback_message_template` (S13).
insert into whatsapp_channels (id, unit_id, provider, status, is_active, display_phone) values
  ('a0d75000-0000-4000-8000-0000000000d1', 'a0d75000-0000-4000-8000-0000000000aa',
   'zapi', 'connected', true, '5511900000075')
on conflict (id) do nothing;

-- Linhas iniciais de U1. O 75 as recoloca nestes valores no começo de cada
-- execução. As sete de prompt existem para o S4 ter linha a atualizar (UPDATE
-- sem linha não dispara trigger e mediria nada).
insert into public.settings (unit_id, key, value)
select 'a0d75000-0000-4000-8000-0000000000aa'::uuid, k, to_jsonb('set75-inicial-' || k)
  from unnest(array['ai_config', 'ai_system_prompt', 'ai_context_extra', 'agent_mode',
                    'agent_name', 'restaurant_menu', 'delivery_response',
                    'restaurant_extra_info', 'booking_window_days', 'restaurant_name']) as k
on conflict (unit_id, key) do nothing;
