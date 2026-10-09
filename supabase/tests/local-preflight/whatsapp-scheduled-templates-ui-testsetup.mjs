// Temporary selected-query bridge, reviewed by MAIN147. Importing this module
// performs no I/O. Only the owned controller supplies SQL and its exclusive lease.
// No production migration, whole-history replay, row dump or fixture-policy bypass.
import { createHash } from 'node:crypto';

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const requireTrue = (value, code) => { if (!value) throw new Error(code); };
async function assertDependencies(sql) {
  for(const fn of DEPENDENCIES) {
    const exists=await sql(`select exists(select from pg_proc p where p.oid=to_regprocedure('${fn.signature}')
      and md5(p.prosrc)='${fn.bodyMd5}' and p.prosecdef and pg_get_userbyid(p.proowner)='postgres'
      and p.proconfig=array['search_path=""']
      and not has_function_privilege('anon',p.oid,'EXECUTE')
      and has_function_privilege('authenticated',p.oid,'EXECUTE')=${fn.authenticated}
      and has_function_privilege('service_role',p.oid,'EXECUTE')=${fn.service})`);
    requireTrue(exists,'ui_parity_dependency_body_or_acl');
  }
  const columns={
    whatsapp_channels:'id,unit_id,provider,is_active,status,created_at,template_credential_revision',
    whatsapp_template_bindings:'id,unit_id,account_id,generation,dispatch_enabled,submission_authorized_at,submission_authorized_by,channel_id',
    whatsapp_automation_adoptions:'unit_id',
    whatsapp_remote_templates:'id,account_id,logical_id,version,effective_category,remote_status,local_status,quality,desired_hash,observed_hash,sync_required,last_synced_at',
    whatsapp_automation_jobs:'id,unit_id,kind,state,pin_phase,channel_id,initial_catalog_key,error_code,attempts,fact_at,expires_at',
    whatsapp_template_jobs:'id,account_id,organization_id,binding_id,target_key,state,error_code,attempts,created_at,due_at',
    whatsapp_automation_receipt_events:'processing_state,unit_id,provider,channel_id,provider_message_id',
  };
  for(const [table,list] of Object.entries(columns)) {
    requireTrue(await sql(`select count(*)=${list.split(',').length} from pg_attribute
      where attrelid=to_regclass('public.${table}') and not attisdropped and attname in(${list.split(',').map(name=>`'${name}'`).join(',')})`),'ui_parity_dependency_columns');
  }
}
const relationNames = ['conversations','customers','notifications_sent','organizations','platform_admins',
  'reservation_message_templates','reservations','settings','unit_members','units','voucher_rules','vouchers','waitlist','waitlist_message_templates'];
const namesSql = relationNames.map(name => `'${name}'`).join(',');

// Same logical projection as ROOT's guarded after14 inventory. Roles use names,
// not installation-specific OIDs; dropped-attribute tombstones are excluded.
const catalogSql = `select jsonb_build_object(
 'helpers',(select coalesce(jsonb_agg(jsonb_build_object('acl',p.proacl::text,'config',p.proconfig,
  'schema',n.nspname,'identity',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid)) order by p.oid::regprocedure::text),'[]')
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and p.proname in('is_platform_admin','is_unit_member')),
 'relations',(select jsonb_agg(jsonb_build_object('name',c.relname,'acl',c.relacl::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
  'columns',(select coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,
    'default',pg_get_expr(d.adbin,d.adrelid),'acl',a.attacl::text) order by a.attnum),'[]') from pg_attribute a left join pg_attrdef d
    on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
  'constraints',(select coalesce(jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid)) order by k.conname),'[]')
    from pg_constraint k where k.conrelid=c.oid),
  'policies',(select coalesce(jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,
    'roles',(select '{'||string_agg(case when r=0 then 'public' else pg_get_userbyid(r) end,',' order by r)||'}' from unnest(p.polroles) r),
    'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polname),'[]') from pg_policy p where p.polrelid=c.oid)
 ) order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in(${namesSql})))`;

const extraSql = `select jsonb_build_object(
 'owners',(select jsonb_agg(jsonb_build_object('name',relname,'owner',pg_get_userbyid(relowner)) order by relname)
  from pg_class where relnamespace='public'::regnamespace and relname in(${namesSql})),
 'schema_acl',(select nspacl::text from pg_namespace where nspname='app_private'),
 'indexes',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',i.relname,'definition',pg_get_indexdef(i.oid),'valid',x.indisvalid,'unique',x.indisunique) order by c.relname,i.relname)
  from pg_index x join pg_class c on c.oid=x.indrelid join pg_class i on i.oid=x.indexrelid where c.relnamespace='public'::regnamespace and c.relname in(${namesSql})),
 'triggers',(select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) order by c.relname,t.tgname),'[]')
  from pg_trigger t join pg_class c on c.oid=t.tgrelid where not t.tgisinternal and c.relnamespace='public'::regnamespace and c.relname in(${namesSql})),
 'new_functions',(select count(*) from pg_proc where oid in(to_regprocedure('public.update_updated_at()'),to_regprocedure('app_private.is_org_member(uuid,uuid)'),to_regprocedure('public.get_undelivered_notifications(uuid,timestamptz)'))))`;

const unitsSql = `select jsonb_agg(jsonb_build_object('id',id,'name',name,'organization_id',organization_id,'slug',slug,'timezone',timezone) order by id) from public.units`;
const preservationSql = `select jsonb_build_object('organizations',(select count(*) from public.organizations),'units',(select count(*) from public.units),
 'customers',(select count(*) from public.customers),'auth_users',(select count(*) from auth.users),'auth_sessions',(select count(*) from auth.sessions),
 'source_null',(select count(*) from public.reservations where source is null))`;
const ownershipSql = `select (select count(*)=2 and count(*) filter(where (id,name) in(
 ('aaaaaaaa-0000-0000-0000-000000000001'::uuid,'Org A'),('aaaaaaaa-0000-0000-0000-000000000002'::uuid,'Org B')))=2 from public.organizations)
 and (select count(*)=3 and count(*) filter(where (id,organization_id,name) in(
 ('bbbbbbbb-0000-0000-0000-000000000001'::uuid,'aaaaaaaa-0000-0000-0000-000000000001'::uuid,'A1'),
 ('bbbbbbbb-0000-0000-0000-000000000002'::uuid,'aaaaaaaa-0000-0000-0000-000000000001'::uuid,'A2'),
 ('bbbbbbbb-0000-0000-0000-000000000003'::uuid,'aaaaaaaa-0000-0000-0000-000000000002'::uuid,'B1')))=3 from public.units)`;

const EXPECTED_AFTER14_HASH = "b0bd653bf29bae07919f3ec1c5ee11c3f9e3184fac9e69a1bb0ce8d888a82d3a";
// MAIN153: channels are outside the unchanged fourteen-relation UI baseline.
const channelCatalogSql=catalogSql.replace(`in(${namesSql})`,"in('whatsapp_channels')");
const channelExtraSql=extraSql.replaceAll(`in(${namesSql})`,"in('whatsapp_channels')");
// Literal fields: 20260905143453_whatsapp_conversation_provider_parity.sql:5;
// 20260817170753_whatsapp_multiprovider_uazapi.sql:52;
// 20260924120000_111_whatsapp_inbound_events.sql:91.
// Table/indexes/RLS: 20260507145736_026_webhook_executions.sql:10-30.
// No historical cleanup function, cron, activation trigger or client policy.
const RECEIPT_INSTALL_SQL=`
alter table public.whatsapp_channels add column manual_echo_verified_at timestamptz,
 add column activation_requested_at timestamptz,
 add column async_ingestion_enabled boolean not null default false;
create table public.webhook_executions (
 id uuid primary key default gen_random_uuid(),request_id text not null,
 unit_id uuid references public.units(id) on delete set null,
 channel_id uuid references public.whatsapp_channels(id) on delete set null,
 phone_hash text,outcome text not null,error text,duration_ms integer,
 meta jsonb default '{}'::jsonb,created_at timestamptz not null default now()
);
create index idx_webhook_executions_unit_created on public.webhook_executions(unit_id,created_at desc);
create index idx_webhook_executions_outcome on public.webhook_executions(outcome,created_at desc);
alter table public.webhook_executions enable row level security;
alter table public.webhook_executions force row level security;
revoke all on public.webhook_executions from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.webhook_executions to service_role;`;
const RECEIPT_RESTORE_SQL=`
do $receipt_restore$ begin
 if exists(select from public.webhook_executions) then raise exception 'ui_parity_telemetry_rows_remain'; end if;
end $receipt_restore$;
drop table public.webhook_executions restrict;
alter table public.whatsapp_channels drop column manual_echo_verified_at restrict,
 drop column activation_requested_at restrict,drop column async_ingestion_enabled restrict;`;
// MAIN154: empty, selected-column read fixtures, not full billing schema proof.
// Definitions: billing_module (20260528000000), entitlement_overrides (062),
// billing_provider_columns (063), service_timestamps (078), grandfathering (079),
// billing_plans_two_plan_model (094). No invoice/subscription/override seed.
const BILLING_INSTALL_SQL=`
alter table public.organizations add column whatsapp_legacy_grandfathered boolean not null default false,
 add column whatsapp_grandfather_revoked_at timestamptz;
create table public.billing_plans(id uuid primary key default gen_random_uuid(),
 category text not null default 'SYSTEM_SUBSCRIPTION',included_features text[] not null default '{}');
create table public.billing_subscriptions(id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 billing_plan_id uuid not null references public.billing_plans(id),
 status text not null default 'trialing',canceled_at timestamptz,suspended_at timestamptz);
create table public.organization_entitlement_overrides(id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 feature text not null,enabled boolean not null default true,
 starts_at timestamptz not null default now(),ends_at timestamptz,revoked_at timestamptz);
alter table public.billing_plans enable row level security;
alter table public.billing_plans force row level security;
alter table public.billing_subscriptions enable row level security;
alter table public.billing_subscriptions force row level security;
alter table public.organization_entitlement_overrides enable row level security;
alter table public.organization_entitlement_overrides force row level security;
revoke all on public.billing_plans,public.billing_subscriptions,public.organization_entitlement_overrides from public,anon,authenticated,service_role;
grant select on public.billing_plans,public.billing_subscriptions,public.organization_entitlement_overrides to service_role;`;
const BILLING_ABSENCE_SQL=`select to_regclass('public.billing_plans') is null
 and to_regclass('public.billing_subscriptions') is null and to_regclass('public.organization_entitlement_overrides') is null`;
const BILLING_RESTORE_SQL=`
do $billing_restore$ begin
 if exists(select from public.billing_plans) or exists(select from public.billing_subscriptions)
  or exists(select from public.organization_entitlement_overrides) then raise exception 'ui_parity_billing_rows_remain'; end if;
end $billing_restore$;
drop table public.billing_subscriptions restrict;
drop table public.billing_plans restrict;
drop table public.organization_entitlement_overrides restrict;
alter table public.organizations drop column whatsapp_legacy_grandfathered restrict,drop column whatsapp_grandfather_revoked_at restrict;`;
const INSTALL_SQL = "ALTER TABLE public.organizations\n  ADD COLUMN slug text,\n  ADD COLUMN is_public boolean NOT NULL DEFAULT true,\n  ADD COLUMN billing_status text NOT NULL DEFAULT 'active',\n  ADD COLUMN trial_ends_at timestamptz,\n  ADD COLUMN blocked_at timestamptz,\n  ADD COLUMN blocked_reason text;\nALTER TABLE public.organizations\n  ADD CONSTRAINT organizations_billing_status_check CHECK (billing_status IN (\n    'active','trialing','pending_payment','past_due','grace_period',\n    'blocked','canceled','manual_override','suspended'\n  ));\n\nALTER TABLE public.units\n  ADD COLUMN address jsonb,\n  ADD COLUMN is_public boolean NOT NULL DEFAULT true,\n  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),\n  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),\n  ADD COLUMN description text,\n  ADD COLUMN price_range_min numeric(10,2),\n  ADD COLUMN price_range_max numeric(10,2),\n  ADD COLUMN hero_image_url text,\n  ADD COLUMN logo_url text,\n  ADD COLUMN cnpj text,\n  ADD COLUMN financial_email text,\n  ADD COLUMN cuisine_types text[] NOT NULL DEFAULT array[]::text[],\n  ADD COLUMN opening_hours_text text,\n  ADD COLUMN payment_methods text,\n  ADD COLUMN facilities jsonb NOT NULL DEFAULT '[]'::jsonb,\n  ADD COLUMN phone text,\n  ADD COLUMN instagram text,\n  ADD COLUMN website text,\n  ADD COLUMN gallery_photos text[] NOT NULL DEFAULT '{}'::text[];\nALTER TABLE public.units\n  ADD CONSTRAINT units_facilities_is_array\n    CHECK (jsonb_typeof(facilities) = 'array'),\n  ADD CONSTRAINT units_gallery_photos_max_5\n    CHECK (array_length(gallery_photos,1) IS NULL OR array_length(gallery_photos,1) <= 5);\n\nWITH changed AS (UPDATE public.organizations o SET slug=x.slug\nFROM (VALUES\n ('aaaaaaaa-0000-0000-0000-000000000001'::uuid,'Org A','task15-bridge-org-a'),\n ('aaaaaaaa-0000-0000-0000-000000000002'::uuid,'Org B','task15-bridge-org-b')\n) AS x(id,name,slug)\nWHERE o.id=x.id AND o.name=x.name RETURNING o.id) SELECT 1/((count(*)=2)::int) FROM changed;\n\nWITH changed AS (UPDATE public.units u SET slug=x.slug, timezone='America/Sao_Paulo'\nFROM (VALUES\n ('bbbbbbbb-0000-0000-0000-000000000001'::uuid,'aaaaaaaa-0000-0000-0000-000000000001'::uuid,'A1','task15-bridge-a1'),\n ('bbbbbbbb-0000-0000-0000-000000000002'::uuid,'aaaaaaaa-0000-0000-0000-000000000001'::uuid,'A2','task15-bridge-a2'),\n ('bbbbbbbb-0000-0000-0000-000000000003'::uuid,'aaaaaaaa-0000-0000-0000-000000000002'::uuid,'B1','task15-bridge-b1')\n) AS x(id,organization_id,name,slug)\nWHERE u.id=x.id AND u.organization_id=x.organization_id AND u.name=x.name RETURNING u.id) SELECT 1/((count(*)=3)::int) FROM changed;\n\nALTER TABLE public.organizations ALTER COLUMN slug SET NOT NULL;\nALTER TABLE public.organizations ADD CONSTRAINT organizations_slug_key UNIQUE(slug);\nALTER TABLE public.units ALTER COLUMN slug SET NOT NULL;\nALTER TABLE public.units ALTER COLUMN timezone SET NOT NULL;\nALTER TABLE public.units ALTER COLUMN timezone SET DEFAULT 'America/Sao_Paulo';\n\nALTER TABLE public.reservations ADD COLUMN satisfaction_at timestamptz;\nALTER TABLE public.reservations ADD COLUMN satisfaction_comment text NULL;\nCOMMENT ON COLUMN public.reservations.satisfaction_comment IS\n 'Comentário livre opcional capturado pelo webhook-whatsapp após nota numérica D+1 (janela 30min).';\n\ncreate or replace function public.update_updated_at()\nreturns trigger\nlanguage plpgsql\nset search_path = public\nas $$\nbegin\n  new.updated_at = now();\n  return new;\nend;\n$$;\nREVOKE ALL ON FUNCTION public.update_updated_at() FROM PUBLIC,anon,authenticated,service_role;\n\nCREATE TRIGGER reservation_message_templates_updated_at\n  BEFORE UPDATE ON public.reservation_message_templates\n  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();\nCREATE TRIGGER waitlist_message_templates_updated_at\n  BEFORE UPDATE ON public.waitlist_message_templates\n  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();\n\ncreate or replace function app_private.is_platform_admin(p_user_id uuid)\nreturns boolean\nlanguage sql security definer stable\nset search_path = public\nas $$\n  select exists (\n    select 1 from platform_admins where user_id = p_user_id\n  );\n$$;\ncreate or replace function app_private.is_unit_member(p_user_id uuid, p_unit_id uuid)\nreturns boolean\nlanguage sql security definer stable\nset search_path = public\nas $$\n  select exists (\n    select 1 from unit_members\n    where user_id = p_user_id and unit_id = p_unit_id\n  );\n$$;\ncreate or replace function app_private.is_org_member(p_user_id uuid, p_org_id uuid)\nreturns boolean\nlanguage sql security definer stable\nset search_path = public\nas $$\n  select exists (\n    select 1\n    from unit_members um\n    join units u on u.id = um.unit_id\n    where um.user_id = p_user_id\n      and u.organization_id = p_org_id\n  );\n$$;\nREVOKE ALL ON SCHEMA app_private FROM PUBLIC,anon,authenticated;\nREVOKE ALL ON FUNCTION app_private.is_platform_admin(uuid) FROM PUBLIC,anon,authenticated;\nREVOKE ALL ON FUNCTION app_private.is_unit_member(uuid,uuid) FROM PUBLIC,anon,authenticated;\nREVOKE ALL ON FUNCTION app_private.is_org_member(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;\nGRANT EXECUTE ON FUNCTION app_private.is_platform_admin(uuid) TO authenticated;\nGRANT EXECUTE ON FUNCTION app_private.is_unit_member(uuid,uuid) TO anon,authenticated;\nGRANT EXECUTE ON FUNCTION app_private.is_org_member(uuid,uuid) TO authenticated;\n\nALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;\nALTER TABLE public.units ENABLE ROW LEVEL SECURITY;\nALTER TABLE public.unit_members ENABLE ROW LEVEL SECURITY;\nALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;\nALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;\nALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;\nALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;\nALTER TABLE public.notifications_sent ENABLE ROW LEVEL SECURITY;\n\nCREATE POLICY platform_admin_all_organizations ON public.organizations FOR ALL TO authenticated\n USING(app_private.is_platform_admin(auth.uid())) WITH CHECK(app_private.is_platform_admin(auth.uid()));\nCREATE POLICY org_member_read_organizations ON public.organizations FOR SELECT TO authenticated\n USING(app_private.is_org_member(auth.uid(),id));\nCREATE POLICY public_read_organizations ON public.organizations FOR SELECT TO anon USING(is_public=true);\nCREATE POLICY platform_admin_all_units ON public.units FOR ALL TO authenticated\n USING(app_private.is_platform_admin(auth.uid())) WITH CHECK(app_private.is_platform_admin(auth.uid()));\nCREATE POLICY unit_member_read_units ON public.units FOR SELECT TO authenticated\n USING(app_private.is_unit_member(auth.uid(),id));\nCREATE POLICY public_read_units ON public.units FOR SELECT TO anon USING(is_public=true);\nCREATE POLICY unit_owner_gerente_update_units ON public.units FOR UPDATE TO authenticated\n USING(EXISTS(SELECT 1 FROM public.unit_members um WHERE um.unit_id=units.id AND um.user_id=auth.uid() AND um.role IN('owner','gerente')))\n WITH CHECK(EXISTS(SELECT 1 FROM public.unit_members um WHERE um.unit_id=units.id AND um.user_id=auth.uid() AND um.role IN('owner','gerente')));\nCREATE POLICY platform_admin_all_unit_members ON public.unit_members FOR ALL TO authenticated\n USING(app_private.is_platform_admin(auth.uid())) WITH CHECK(app_private.is_platform_admin(auth.uid()));\nCREATE POLICY unit_member_read_unit_members ON public.unit_members FOR SELECT TO authenticated\n USING(app_private.is_unit_member(auth.uid(),unit_id));\nCREATE POLICY platform_admin_read_platform_admins ON public.platform_admins FOR SELECT TO authenticated\n USING(app_private.is_platform_admin(auth.uid()));\nCREATE POLICY platform_admin_all_customers ON public.customers FOR ALL TO authenticated\n USING(app_private.is_platform_admin(auth.uid())) WITH CHECK(app_private.is_platform_admin(auth.uid()));\nCREATE POLICY org_member_all_customers ON public.customers FOR ALL TO authenticated\n USING(app_private.is_org_member(auth.uid(),organization_id)) WITH CHECK(app_private.is_org_member(auth.uid(),organization_id));\nCREATE POLICY anon_insert_customers ON public.customers FOR INSERT TO anon\n WITH CHECK(organization_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.organizations o WHERE o.id=organization_id AND o.is_public=true));\nCREATE POLICY platform_admin_all_reservations ON public.reservations FOR ALL TO authenticated\n USING(app_private.is_platform_admin(auth.uid())) WITH CHECK(app_private.is_platform_admin(auth.uid()));\nCREATE POLICY unit_member_all_reservations ON public.reservations FOR ALL TO authenticated\n USING(app_private.is_unit_member(auth.uid(),unit_id)) WITH CHECK(app_private.is_unit_member(auth.uid(),unit_id));\nCREATE POLICY anon_insert_reservations ON public.reservations FOR INSERT TO anon\n WITH CHECK(unit_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.units u JOIN public.organizations o ON o.id=u.organization_id\n   WHERE u.id=unit_id AND u.is_public=true AND o.is_public=true));\nCREATE POLICY waitlist_member_select ON public.waitlist FOR SELECT\n USING(app_private.is_unit_member(auth.uid(),unit_id));\nCREATE POLICY waitlist_member_insert ON public.waitlist FOR INSERT\n WITH CHECK(app_private.is_unit_member(auth.uid(),unit_id));\nCREATE POLICY waitlist_member_update ON public.waitlist FOR UPDATE\n USING(app_private.is_unit_member(auth.uid(),unit_id));\nCREATE POLICY waitlist_member_delete ON public.waitlist FOR DELETE\n USING(app_private.is_unit_member(auth.uid(),unit_id));\nCREATE POLICY platform_admin_all_waitlist ON public.waitlist FOR ALL TO authenticated\n USING(app_private.is_platform_admin(auth.uid())) WITH CHECK(app_private.is_platform_admin(auth.uid()));\nCREATE POLICY anon_insert_waitlist ON public.waitlist FOR INSERT TO anon\n WITH CHECK(unit_id IS NOT NULL AND status='waiting' AND party_size BETWEEN 1 AND 20\n   AND EXISTS(SELECT 1 FROM public.units u JOIN public.organizations o ON o.id=u.organization_id\n     WHERE u.id=unit_id AND u.is_public=true AND o.is_public=true));\nCREATE POLICY platform_admin_all_conversations ON public.conversations FOR ALL TO authenticated\n USING(app_private.is_platform_admin(auth.uid())) WITH CHECK(app_private.is_platform_admin(auth.uid()));\nCREATE POLICY unit_member_all_conversations ON public.conversations FOR ALL TO authenticated\n USING(app_private.is_unit_member(auth.uid(),unit_id)) WITH CHECK(app_private.is_unit_member(auth.uid(),unit_id));\nCREATE POLICY platform_admin_read_notifications_sent ON public.notifications_sent FOR SELECT TO authenticated\n USING(app_private.is_platform_admin(auth.uid()));\nCREATE POLICY unit_member_read_notifications_sent ON public.notifications_sent FOR SELECT TO authenticated\n USING(app_private.is_unit_member(auth.uid(),unit_id));\n\nDROP POLICY fixture_members ON public.settings;\nCREATE POLICY platform_admin_all_settings ON public.settings FOR ALL TO authenticated\n USING(app_private.is_platform_admin(auth.uid())) WITH CHECK(app_private.is_platform_admin(auth.uid()));\nCREATE POLICY unit_member_all_settings ON public.settings FOR ALL TO authenticated\n USING(app_private.is_unit_member(auth.uid(),unit_id)) WITH CHECK(app_private.is_unit_member(auth.uid(),unit_id));\n\nDROP POLICY fixture_members ON public.reservation_message_templates;\nCREATE POLICY rmt_member_select ON public.reservation_message_templates FOR SELECT\n USING(app_private.is_unit_member(auth.uid(),unit_id));\nCREATE POLICY rmt_member_insert ON public.reservation_message_templates FOR INSERT\n WITH CHECK(app_private.is_unit_member(auth.uid(),unit_id));\nCREATE POLICY rmt_member_update ON public.reservation_message_templates FOR UPDATE\n USING(app_private.is_unit_member(auth.uid(),unit_id));\nCREATE POLICY rmt_member_delete ON public.reservation_message_templates FOR DELETE\n USING(app_private.is_unit_member(auth.uid(),unit_id));\nDROP POLICY fixture_members ON public.waitlist_message_templates;\nCREATE POLICY wlmt_member_select ON public.waitlist_message_templates FOR SELECT\n USING(app_private.is_unit_member(auth.uid(),unit_id));\nCREATE POLICY wlmt_member_insert ON public.waitlist_message_templates FOR INSERT\n WITH CHECK(app_private.is_unit_member(auth.uid(),unit_id));\nCREATE POLICY wlmt_member_update ON public.waitlist_message_templates FOR UPDATE\n USING(app_private.is_unit_member(auth.uid(),unit_id));\nCREATE POLICY wlmt_member_delete ON public.waitlist_message_templates FOR DELETE\n USING(app_private.is_unit_member(auth.uid(),unit_id));\n\nGRANT SELECT ON public.conversations TO authenticated;\nREVOKE SELECT ON public.organizations FROM anon;\nGRANT SELECT(id,is_public) ON public.organizations TO anon;\nREVOKE SELECT ON public.units FROM anon;\nGRANT SELECT(\n id,organization_id,name,slug,description,address,timezone,is_public,created_at,updated_at,\n price_range_min,price_range_max,hero_image_url,logo_url,cuisine_types,opening_hours_text,\n payment_methods,facilities,phone,instagram,website,gallery_photos\n) ON public.units TO anon;\nREVOKE INSERT,UPDATE,DELETE ON public.organizations FROM anon;\nREVOKE INSERT,UPDATE,DELETE ON public.units FROM anon;\n\ncreate or replace function public.get_undelivered_notifications(\n  p_unit_id uuid,\n  p_since timestamp with time zone default (now() - '7 days'::interval)\n)\nreturns table(\n  id uuid,\n  kind text,\n  status text,\n  provider_message_id text,\n  sent_at timestamp with time zone,\n  delivered_at timestamp with time zone,\n  read_at timestamp with time zone,\n  failed_at timestamp with time zone,\n  waitlist_id uuid,\n  reservation_id uuid,\n  customer_name text,\n  customer_phone text,\n  ref_code text,\n  ref_date date,\n  ref_time text\n)\nlanguage plpgsql\nstable\nsecurity definer\nset search_path = 'public', 'app_private'\nas $function$\nbegin\n  -- As duas chamadas eram SEM qualificação; ficam qualificadas porque\n  -- `app_private` no search_path é cinto de segurança, não a garantia.\n  if not (app_private.is_unit_member(auth.uid(), p_unit_id)\n          or app_private.is_platform_admin(auth.uid())) then\n    raise exception 'forbidden' using errcode = '42501';\n  end if;\n\n  return query\n    select\n      ns.id,\n      ns.kind,\n      ns.status,\n      ns.provider_message_id,\n      ns.sent_at,\n      ns.delivered_at,\n      ns.read_at,\n      ns.failed_at,\n      ns.waitlist_id,\n      ns.reservation_id,\n      coalesce(w.customer_name, rc.name)        as customer_name,\n      coalesce(w.customer_phone, rc.phone)       as customer_phone,\n      coalesce(w.code::text, r.reservation_code) as ref_code,\n      r.date                                     as ref_date,\n      to_char(r.time, 'HH24:MI')                 as ref_time\n    from notifications_sent ns\n    left join waitlist     w  on w.id = ns.waitlist_id\n    left join reservations r  on r.id = ns.reservation_id\n    left join customers    rc on rc.id = r.customer_id\n    where ns.unit_id = p_unit_id\n      and ns.sent_at >= p_since\n      and ns.kind <> 'confirmation_email'  -- painel é de WhatsApp; e-mail é outro canal\n      and (\n            ns.status = 'failed' or ns.failed_at is not null\n         or (ns.status = 'sent'\n             and ns.provider_message_id is not null\n             and ns.delivered_at is null\n             and ns.sent_at < now() - interval '5 minutes')\n      )\n    order by ns.sent_at desc;\nend;\n$function$;\nREVOKE ALL ON FUNCTION public.get_undelivered_notifications(uuid,timestamptz)\n FROM PUBLIC,anon,authenticated,service_role;\nGRANT EXECUTE ON FUNCTION public.get_undelivered_notifications(uuid,timestamptz) TO authenticated;\n";
const RESTORE_SQL = "DROP POLICY platform_admin_all_organizations ON public.organizations;\nDROP POLICY org_member_read_organizations ON public.organizations;\nDROP POLICY public_read_organizations ON public.organizations;\nDROP POLICY platform_admin_all_units ON public.units;\nDROP POLICY unit_member_read_units ON public.units;\nDROP POLICY public_read_units ON public.units;\nDROP POLICY unit_owner_gerente_update_units ON public.units;\nDROP POLICY platform_admin_all_unit_members ON public.unit_members;\nDROP POLICY unit_member_read_unit_members ON public.unit_members;\nDROP POLICY platform_admin_read_platform_admins ON public.platform_admins;\nDROP POLICY platform_admin_all_customers ON public.customers;\nDROP POLICY org_member_all_customers ON public.customers;\nDROP POLICY anon_insert_customers ON public.customers;\nDROP POLICY platform_admin_all_reservations ON public.reservations;\nDROP POLICY unit_member_all_reservations ON public.reservations;\nDROP POLICY anon_insert_reservations ON public.reservations;\nDROP POLICY waitlist_member_select ON public.waitlist;\nDROP POLICY waitlist_member_insert ON public.waitlist;\nDROP POLICY waitlist_member_update ON public.waitlist;\nDROP POLICY waitlist_member_delete ON public.waitlist;\nDROP POLICY platform_admin_all_waitlist ON public.waitlist;\nDROP POLICY anon_insert_waitlist ON public.waitlist;\nDROP POLICY platform_admin_all_conversations ON public.conversations;\nDROP POLICY unit_member_all_conversations ON public.conversations;\nDROP POLICY platform_admin_read_notifications_sent ON public.notifications_sent;\nDROP POLICY unit_member_read_notifications_sent ON public.notifications_sent;\nDROP POLICY platform_admin_all_settings ON public.settings;\nDROP POLICY unit_member_all_settings ON public.settings;\nDROP POLICY rmt_member_select ON public.reservation_message_templates;\nDROP POLICY rmt_member_insert ON public.reservation_message_templates;\nDROP POLICY rmt_member_update ON public.reservation_message_templates;\nDROP POLICY rmt_member_delete ON public.reservation_message_templates;\nDROP POLICY wlmt_member_select ON public.waitlist_message_templates;\nDROP POLICY wlmt_member_insert ON public.waitlist_message_templates;\nDROP POLICY wlmt_member_update ON public.waitlist_message_templates;\nDROP POLICY wlmt_member_delete ON public.waitlist_message_templates;\nCREATE POLICY fixture_members ON public.settings FOR ALL TO authenticated\n USING(app_private.is_unit_member(auth.uid(),unit_id) OR app_private.is_platform_admin(auth.uid()))\n WITH CHECK(app_private.is_unit_member(auth.uid(),unit_id) OR app_private.is_platform_admin(auth.uid()));\nCREATE POLICY fixture_members ON public.reservation_message_templates FOR ALL TO authenticated\n USING(app_private.is_unit_member(auth.uid(),unit_id)) WITH CHECK(app_private.is_unit_member(auth.uid(),unit_id));\nCREATE POLICY fixture_members ON public.waitlist_message_templates FOR ALL TO authenticated\n USING(app_private.is_unit_member(auth.uid(),unit_id)) WITH CHECK(app_private.is_unit_member(auth.uid(),unit_id));\n\nDROP TRIGGER reservation_message_templates_updated_at ON public.reservation_message_templates;\nDROP TRIGGER waitlist_message_templates_updated_at ON public.waitlist_message_templates;\nDROP FUNCTION public.update_updated_at() RESTRICT;\nDROP FUNCTION app_private.is_org_member(uuid,uuid) RESTRICT;\nDROP FUNCTION public.get_undelivered_notifications(uuid,timestamptz) RESTRICT;\nALTER TABLE public.organizations DROP CONSTRAINT organizations_slug_key RESTRICT,DROP CONSTRAINT organizations_billing_status_check RESTRICT;\nALTER TABLE public.units DROP CONSTRAINT units_facilities_is_array RESTRICT,DROP CONSTRAINT units_gallery_photos_max_5 RESTRICT;\nALTER TABLE public.units ALTER COLUMN slug DROP NOT NULL,ALTER COLUMN timezone DROP NOT NULL;\nREVOKE SELECT ON public.conversations FROM authenticated;\nREVOKE SELECT(id,is_public) ON public.organizations FROM anon;\nREVOKE SELECT ON public.units FROM anon;\nREVOKE SELECT(\n id,organization_id,name,slug,description,address,timezone,is_public,created_at,updated_at,\n price_range_min,price_range_max,hero_image_url,logo_url,cuisine_types,opening_hours_text,\n payment_methods,facilities,phone,instagram,website,gallery_photos\n) ON public.units FROM anon;\nGRANT SELECT,INSERT,UPDATE,DELETE ON public.organizations,public.units TO anon;\nALTER TABLE public.organizations DISABLE ROW LEVEL SECURITY;\nALTER TABLE public.units DISABLE ROW LEVEL SECURITY;\nALTER TABLE public.unit_members DISABLE ROW LEVEL SECURITY;\nALTER TABLE public.platform_admins DISABLE ROW LEVEL SECURITY;\nALTER TABLE public.customers DISABLE ROW LEVEL SECURITY;\nALTER TABLE public.reservations DISABLE ROW LEVEL SECURITY;\nALTER TABLE public.waitlist DISABLE ROW LEVEL SECURITY;\nALTER TABLE public.notifications_sent DISABLE ROW LEVEL SECURITY;\nALTER TABLE public.organizations DROP COLUMN slug RESTRICT,DROP COLUMN is_public RESTRICT,DROP COLUMN billing_status RESTRICT,DROP COLUMN trial_ends_at RESTRICT,DROP COLUMN blocked_at RESTRICT,DROP COLUMN blocked_reason RESTRICT;\nALTER TABLE public.units DROP COLUMN address RESTRICT,DROP COLUMN is_public RESTRICT,DROP COLUMN created_at RESTRICT,DROP COLUMN updated_at RESTRICT,DROP COLUMN description RESTRICT,DROP COLUMN price_range_min RESTRICT,DROP COLUMN price_range_max RESTRICT,DROP COLUMN hero_image_url RESTRICT,DROP COLUMN logo_url RESTRICT,DROP COLUMN cnpj RESTRICT,DROP COLUMN financial_email RESTRICT,DROP COLUMN cuisine_types RESTRICT,DROP COLUMN opening_hours_text RESTRICT,DROP COLUMN payment_methods RESTRICT,DROP COLUMN facilities RESTRICT,DROP COLUMN phone RESTRICT,DROP COLUMN instagram RESTRICT,DROP COLUMN website RESTRICT,DROP COLUMN gallery_photos RESTRICT;\nALTER TABLE public.reservations DROP COLUMN satisfaction_at RESTRICT,DROP COLUMN satisfaction_comment RESTRICT;";

/**
 * sql(statement, parameters?) returns the one JSON SQL value (or null for DDL).
 * Parameters travel via the reviewed private executor, never interpolated here.
 * The lease is held until restoration; cleanup failure deliberately leaves it held.
 */
export async function installUiParity({ query, transaction, assertOwned, assertDrained, lease, onRecoveryReady }) {
  const sql=statement=>query({sql:statement,parameters:[]});
  requireTrue(lease?.held === true,'ui_parity_exclusive_lease_required');
  await assertOwned();
  requireTrue(await sql(ownershipSql),'ui_parity_original_fixture_ownership');
  const before=await sql(catalogSql), extra=await sql(extraSql), originalUnits=await sql(unitsSql), counts=await sql(preservationSql);
  const channelBefore=await sql(channelCatalogSql),channelExtraBefore=await sql(channelExtraSql);
  requireTrue(await sql(BILLING_ABSENCE_SQL),'ui_parity_billing_original_absence');
  requireTrue(await sql(`select not exists(select from pg_attribute where attrelid='public.organizations'::regclass
    and not attisdropped and attname in('whatsapp_legacy_grandfathered','whatsapp_grandfather_revoked_at'))`),'ui_parity_billing_original_columns');
  requireTrue(await sql(`select to_regclass('public.webhook_executions') is null
    and not exists(select from pg_attribute where attrelid='public.whatsapp_channels'::regclass
      and not attisdropped and attname in('manual_echo_verified_at','activation_requested_at','async_ingestion_enabled'))
    and exists(select from pg_attribute where attrelid='public.whatsapp_channels'::regclass
      and not attisdropped and attname='external_instance_id' and format_type(atttypid,atttypmod)='text' and not attnotnull)`),'ui_parity_receipt_original_shape');
  requireTrue(digest(before)===EXPECTED_AFTER14_HASH,'ui_parity_metadata_drift');
  requireTrue(extra.schema_acl==='{postgres=UC/postgres}'&&extra.new_functions===0
    && extra.owners.every(row=>row.owner==='postgres'),'ui_parity_owner_or_function_drift');
  requireTrue(counts.organizations===2&&counts.units===3&&counts.customers===2&&counts.auth_users===29&&counts.source_null===1,'ui_parity_preservation_baseline');
  requireTrue(originalUnits.length===3,'ui_parity_unit_snapshot');
  // Source-qualified dependent objects must already exist; this bridge never
  // recreates approved template/ledger/consent authority to hide an absent setup.
  await assertDependencies(sql);
  const recovery = {
    // Safe source/proof metadata only. The private snapshots never escape.
    proof: Object.freeze({ temporary:true,sourceQualified:true,selectedQueriesOnly:true,baselineHash:EXPECTED_AFTER14_HASH }),
    async restore() {
      requireTrue(lease.held===true,'ui_parity_restore_lifetime');
      await assertOwned();await assertDrained();
      requireTrue(await sql(ownershipSql),'ui_parity_cleanup_owned_rows_remaining');
      requireTrue(digest(await sql(preservationSql))===digest(counts),'ui_parity_preservation_counts_changed');
      // DDL install/restore is transactional. If it rolled back, or restoration
      // committed before a later diagnostic failed, verify without replaying DROP.
      if(digest(await sql(catalogSql))!==digest(before)) {
        const restoreHelpers=before.helpers.map(helper=>helper.definition+';').join('\n');
        await transaction([{sql:`lock table public.organizations,public.units in access exclusive mode;
        ${RECEIPT_RESTORE_SQL}
        ${BILLING_RESTORE_SQL}
        ${RESTORE_SQL}
        ${restoreHelpers}
        revoke all on function app_private.is_platform_admin(uuid) from public,anon,authenticated,service_role;
        revoke all on function app_private.is_unit_member(uuid,uuid) from public,anon,authenticated,service_role;
        grant execute on function app_private.is_platform_admin(uuid) to authenticated,service_role;
        grant execute on function app_private.is_unit_member(uuid,uuid) to authenticated,service_role;`,parameters:[]},
        {id:'restore_baseline_units',sql:`with restored as (update public.units u set slug=x.slug,timezone=x.timezone
          from jsonb_to_recordset($1::jsonb) as x(id uuid,name text,organization_id uuid,slug text,timezone text)
          where u.id=x.id and u.name=x.name and u.organization_id=x.organization_id returning u.id)
          select 1/((count(*)=3)::int) from restored`,parameters:[originalUnits]}]);
      }
      await sql("notify pgrst,'reload schema';");
      requireTrue(digest(await sql(catalogSql))===digest(before),'ui_parity_logical_catalog_restore');
      requireTrue(digest(await sql(extraSql))===digest(extra),'ui_parity_logical_objects_restore');
      requireTrue(digest(await sql(channelCatalogSql))===digest(channelBefore)
        &&digest(await sql(channelExtraSql))===digest(channelExtraBefore),'ui_parity_channel_metadata_restore');
      requireTrue(await sql("select to_regclass('public.webhook_executions') is null"),'ui_parity_telemetry_absence_restore');
      requireTrue(await sql(BILLING_ABSENCE_SQL),'ui_parity_billing_absence_restore');
      requireTrue(digest(await sql(unitsSql))===digest(originalUnits),'ui_parity_original_unit_values_restore');
      requireTrue(digest(await sql(preservationSql))===digest(counts),'ui_parity_preservation_restore');
      return { restored:true,logicalMetadataEqual:true,channelMetadataEqual:true,telemetryOriginalAbsence:true,billingOriginalAbsence:true,originalUnitValuesEqual:true,preservationCountsEqual:true };
    },
  };
  // Register private recovery before the first mutation. A later installation
  // or verification failure must not discard the only original-value snapshot.
  requireTrue(typeof onRecoveryReady==='function','ui_parity_recovery_owner_required');onRecoveryReady(recovery);
  await sql(`begin;set local statement_timeout='20s'; lock table public.organizations,public.units in access exclusive mode;
    do $guard$ begin if not (${ownershipSql.replace(/^select /,'')}) then raise exception 'ui_parity_ownership_changed'; end if; end $guard$;
    ${INSTALL_SQL}
    ${RECEIPT_INSTALL_SQL}
    ${BILLING_INSTALL_SQL}
    commit; notify pgrst,'reload schema';`);
  const applied=await sql(catalogSql);
  requireTrue(applied.relations.find(row=>row.name==='organizations').columns.find(row=>row.name==='slug')?.notnull
    && applied.relations.find(row=>row.name==='units').columns.find(row=>row.name==='slug')?.notnull
    && applied.relations.find(row=>row.name==='units').columns.find(row=>row.name==='timezone')?.notnull,'ui_parity_not_null_missing');
  requireTrue((await sql(extraSql)).schema_acl===extra.schema_acl,'ui_parity_private_schema_acl_changed');
  return recovery;
}

// Exact effective source bodies: final12, final13 and capability migration.
const DEPENDENCIES = [
  {
    "signature": "public.get_whatsapp_automation_delivery_state(uuid,integer,integer)",
    "bodyMd5": "57c48d6ee2381f6d6d39cd86985ada18",
    "authenticated": true,
    "service": false
  },
  {
    "signature": "app_private.require_whatsapp_template_manager(uuid,boolean)",
    "bodyMd5": "7be8e16a30ba8dec3d4a9cade120ac5a",
    "authenticated": false,
    "service": false
  },
  {
    "signature": "public.get_whatsapp_message_consent_state(uuid,uuid,text)",
    "bodyMd5": "0ffb36db060d771a12aa926c540e8c21",
    "authenticated": true,
    "service": false
  },
  {
    "signature": "public.record_whatsapp_message_consent(uuid,uuid,text,text,text,timestamptz,text)",
    "bodyMd5": "53c16868f35462ce1c7459ad23d38fd6",
    "authenticated": true,
    "service": false
  },
  {
    "signature": "public.check_whatsapp_preference_rate(text,integer,integer)",
    "bodyMd5": "7f838a9d74449d26e5d14720ef6e1537",
    "authenticated": false,
    "service": true
  },
  {
    "signature": "public.issue_whatsapp_preference_token(uuid,text)",
    "bodyMd5": "deafa2238f692562325f9d646613cf1f",
    "authenticated": false,
    "service": true
  },
  {
    "signature": "public.lookup_whatsapp_preference_token(text)",
    "bodyMd5": "ee41687389d6c3358d11aade92d4af9b",
    "authenticated": false,
    "service": true
  },
  {
    "signature": "public.revoke_whatsapp_promotion(text)",
    "bodyMd5": "6eca7160eda7d9f82d412749a8c4e347",
    "authenticated": false,
    "service": true
  }
];
