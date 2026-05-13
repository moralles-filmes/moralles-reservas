-- Migration 047: platform_admin override para storage.objects do bucket unit-assets
--
-- Gap descoberto: a mig 019 escopa write em `unit-assets` apenas por unit_members
-- com role owner/gerente. platform_admin (que opera unidades alheias e cuja UI
-- fabrica um pseudo-membership "owner" via useCurrentUnit.ts) era bloqueado com
-- "new row violates row-level security policy" ao subir logo/capa.
--
-- Todas as tabelas de negócio em mig 013+ já têm policy `platform_admin_all_*`
-- via is_platform_admin(auth.uid()). storage.objects era o único gap.
--
-- Convenção a manter: TODA policy RLS escopada por unit_id DEVE ter contraparte
-- platform_admin via is_platform_admin(auth.uid()) — vale para tabelas comuns E
-- para storage.objects quando o bucket é multi-tenant.
--
-- Policies aditivas: não removem nem enfraquecem as existentes
-- `unit_member_*_unit_assets`. Storage RLS avalia OR entre policies do mesmo
-- command, então basta uma passar.

begin;

drop policy if exists "platform_admin_insert_unit_assets" on storage.objects;
create policy "platform_admin_insert_unit_assets" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'unit-assets'
    and is_platform_admin(auth.uid())
  );

drop policy if exists "platform_admin_update_unit_assets" on storage.objects;
create policy "platform_admin_update_unit_assets" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'unit-assets'
    and is_platform_admin(auth.uid())
  )
  with check (
    bucket_id = 'unit-assets'
    and is_platform_admin(auth.uid())
  );

drop policy if exists "platform_admin_delete_unit_assets" on storage.objects;
create policy "platform_admin_delete_unit_assets" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'unit-assets'
    and is_platform_admin(auth.uid())
  );

commit;
