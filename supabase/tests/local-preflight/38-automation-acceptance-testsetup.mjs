// Closed, local-only fixture delta. Never replay the historical migration.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const docker = 'C:/Users/Yuri/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe';
const project = 'moralles-templates-20261003';
const container = `supabase_db_${project}`;
const source = readFileSync(fileURLToPath(new URL('../../migrations/20260905143453_whatsapp_conversation_provider_parity.sql', import.meta.url)), 'utf8');
function run(args, input) {
  const result = spawnSync(docker, args, { input, encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (result.status !== 0) throw new Error('acceptance_setup_local_process_failed');
  return result.stdout.trim();
}
function exact(pattern) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error('acceptance_setup_source_mismatch');
  return matches[0][0];
}
const definitions = [
  { name: 'append_conversation_message', signature: 'uuid, jsonb', compact: 'uuid,jsonb' },
  { name: 'get_or_create_whatsapp_conversation', signature: 'uuid, uuid, text, text', compact: 'uuid,uuid,text,text' },
].map(({ name, signature, compact }) => {
  const signaturePattern = signature.replaceAll(', ', ',\\s*');
  const create = exact(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\) returns (?:void|uuid)\\s+language plpgsql\\s+security definer\\s+set search_path = public\\s+as \\$\\$[\\s\\S]*?\\$\\$;`, 'g'));
  const body = create.split('$$')[1];
  if (create.split('$$').length !== 3 || !body) throw new Error('acceptance_setup_delimiter_mismatch');
  const statements = [create,
    exact(new RegExp(`revoke all on function public\\.${name}\\(${signaturePattern}\\)\\s+from public, anon, authenticated;`, 'g')),
    exact(new RegExp(`grant execute on function public\\.${name}\\(${signaturePattern}\\)\\s+to service_role;`, 'g')),
    exact(new RegExp(`comment on function public\\.${name}\\(${signaturePattern}\\) is\\s+'[^']*';`, 'g'))];
  return { name, compact, body, statements, digest: createHash('sha256').update(statements.join('\n')).digest('hex') };
});
// One real catalog predicate, shared by the fixture guard and SQL controls.
// indnkeyatts excludes INCLUDE columns; order and partial predicates cannot
// disguise a unique constraint on the same unit/customer pair.
const conversationIndexGuard = `
create function pg_temp.assert_acceptance_conversation_indexes(p_relation regclass)
returns void language plpgsql as $guard$
begin
 if exists(
  select from pg_catalog.pg_index i
  where i.indrelid=p_relation and i.indisunique and i.indnkeyatts=2
   and (select array_agg(a.attname::text order by a.attname::text)
    from unnest(i.indkey) with ordinality k(attnum,position)
    join pg_catalog.pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
    where k.position<=i.indnkeyatts)=array['customer_id','unit_id']::text[]
 ) then raise exception 'acceptance_setup_unexpected_conversations_authority' using errcode='P0038'; end if;
end $guard$;
`;
const conversationIndexControls = `
create temp table acceptance_index_control(unit_id uuid,customer_id uuid,wa_chat_lid text) on commit drop;
-- This allowed partial index and an ordinary pair index must survive unchanged.
create unique index acceptance_control_lid on acceptance_index_control(unit_id,wa_chat_lid) where wa_chat_lid is not null;
create index acceptance_control_nonunique on acceptance_index_control(unit_id,customer_id);
create unique index acceptance_control_include_only on acceptance_index_control(wa_chat_lid) include(unit_id,customer_id);
select pg_temp.assert_acceptance_conversation_indexes('pg_temp.acceptance_index_control'::regclass);
do $controls$
declare keys text;
begin
 foreach keys in array array[
  '(unit_id,customer_id)', '(customer_id,unit_id)',
  '(customer_id,unit_id) where customer_id is not null',
  '(unit_id,customer_id) include(wa_chat_lid)',
  '(customer_id,unit_id) include(wa_chat_lid) where wa_chat_lid is not null'
 ] loop
  execute 'create unique index acceptance_control_forbidden on pg_temp.acceptance_index_control '||keys;
  begin
   perform pg_temp.assert_acceptance_conversation_indexes('pg_temp.acceptance_index_control'::regclass);
   raise exception 'FAIL acceptance pair unique was not refused: %',keys;
  exception when sqlstate 'P0038' then null;
  end;
  -- Only this control's own just-created index is removed. Unknown real indexes
  -- are refused by the guard, never dropped to make the fixture pass.
  drop index pg_temp.acceptance_control_forbidden;
 end loop;
 perform pg_temp.assert_acceptance_conversation_indexes('pg_temp.acceptance_index_control'::regclass);
end $controls$;
`;
if (process.argv.length === 3 && process.argv[2] === '--source-check') {
  for (const d of definitions) console.log(`SOURCE ${d.name} statements=${d.statements.length} sha256=${d.digest}`);
  console.log(`SOURCE conversation index guard/controls sha256=${createHash('sha256').update(conversationIndexGuard + conversationIndexControls).digest('hex')}`);
  console.log('Source extraction only; no database, SQL execution or ACL proof.');
  process.exit(0);
}
if (process.argv.length !== 2) throw new Error('acceptance_setup_arguments_refused');
// Deny a remote daemon even when the container happens to have matching labels.
if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT || process.env.DOCKER_TLS_VERIFY || process.env.DOCKER_CERT_PATH) {
  throw new Error('acceptance_setup_docker_override_refused');
}
const endpoint = run(['context', 'inspect', '--format', '{{ .Endpoints.docker.Host }}']);
if (!/^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+$/.test(endpoint)) throw new Error('acceptance_setup_namedpipe_required');
if (run(['inspect', '--format', '{{ .State.Running }}', container]) !== 'true'
  || run(['inspect', '--format', '{{ .Name }}', container]) !== `/${container}`
  || run(['inspect', '--format', '{{ index .Config.Labels "com.supabase.cli.project" }}', container]) !== project
  || run(['inspect', '--format', '{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}', container]) !== '55452') {
  throw new Error('acceptance_setup_own_running_stack_required');
}
const literal = value => `'${value.replaceAll("'", "''")}'`;
const schema = `
${conversationIndexGuard}
${conversationIndexControls}
create table if not exists public.conversations (
 id uuid primary key default gen_random_uuid(),
 customer_id uuid not null references public.customers(id) on delete cascade,
 unit_id uuid not null references public.units(id) on delete restrict,
 messages jsonb not null default '[]'::jsonb,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 last_message_at timestamptz default now(), contact_name text, wa_chat_lid text,
 status text not null default 'ai_active' check(status in('ai_active','awaiting_human','human_active','resolved')),
 reservation_id uuid references public.reservations(id) on delete set null
);
create unique index if not exists conversations_unit_wa_chat_lid_idx on public.conversations(unit_id,wa_chat_lid) where wa_chat_lid is not null;
alter table public.conversations enable row level security;
revoke all on public.conversations from public,anon,authenticated;
grant select,insert,update,delete on public.conversations to service_role;
do $setup$
declare k record;
begin
 if (select count(*) from pg_attribute where attrelid='public.conversations'::regclass and attnum>0 and not attisdropped)<>11
 or exists(
  select * from (values ('id','uuid',true),('customer_id','uuid',true),('unit_id','uuid',true),('messages','jsonb',true),
   ('created_at','timestamp with time zone',true),('updated_at','timestamp with time zone',true),
   ('last_message_at','timestamp with time zone',false),('contact_name','text',false),('wa_chat_lid','text',false),
   ('status','text',true),('reservation_id','uuid',false)) e(n,t,nn)
  left join pg_attribute a on a.attrelid='public.conversations'::regclass and a.attname=e.n
  where a.attname is null or format_type(a.atttypid,a.atttypmod)<>e.t or a.attnotnull<>e.nn
 ) then raise exception 'acceptance_setup_conversations_shape'; end if;
 if not exists(select from pg_constraint where conrelid='public.conversations'::regclass and contype='p'
  and pg_get_constraintdef(oid)='PRIMARY KEY (id)')
 or exists(select from (values ('id','gen_random_uuid()'),('messages','''[]''::jsonb'),
  ('created_at','now()'),('updated_at','now()'),('last_message_at','now()'),('status','''ai_active''::text')) e(n,expression)
  left join pg_attribute a on a.attrelid='public.conversations'::regclass and a.attname=e.n
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where pg_get_expr(d.adbin,d.adrelid) is distinct from e.expression) then
  raise exception 'acceptance_setup_conversations_defaults'; end if;
 if (select pg_get_constraintdef(oid) from pg_constraint where conrelid='public.conversations'::regclass
  and conname='conversations_status_check') is distinct from
  'CHECK ((status = ANY (ARRAY[''ai_active''::text, ''awaiting_human''::text, ''human_active''::text, ''resolved''::text])))' then
  raise exception 'acceptance_setup_conversations_status'; end if;
 if has_table_privilege('anon','public.conversations','SELECT') or has_table_privilege('authenticated','public.conversations','SELECT')
  or not has_table_privilege('service_role','public.conversations','SELECT,INSERT,UPDATE,DELETE') then
  raise exception 'acceptance_setup_conversations_acl'; end if;
 if exists(select from pg_policy where polrelid='public.conversations'::regclass) then
  raise exception 'acceptance_setup_unexpected_conversations_authority'; end if;
 perform pg_temp.assert_acceptance_conversation_indexes('public.conversations'::regclass);
 for k in select * from (values ('customer_id','public.customers'::regclass,'c'),
  ('unit_id','public.units'::regclass,'r'),('reservation_id','public.reservations'::regclass,'n')) e(n,parent,action) loop
  if not exists(select from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and c.conkey=array[a.attnum]
   where c.conrelid='public.conversations'::regclass and c.contype='f' and a.attname=k.n
    and c.confrelid=k.parent and c.confdeltype::text=k.action and c.convalidated) then
   raise exception 'acceptance_setup_conversations_fk'; end if;
 end loop;
 -- Only the two documented fixture deltas are repaired. No data is removed.
 select c.* into k from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and c.conkey=array[a.attnum]
  where c.conrelid='public.notifications_sent'::regclass and c.contype='f' and a.attname='unit_id';
 if k.confrelid is distinct from 'public.units'::regclass or k.confdeltype not in('c','r') then
  raise exception 'acceptance_setup_notification_unit_fk'; end if;
 if k.confdeltype='c' then
  execute format('alter table public.notifications_sent drop constraint %I',k.conname);
  alter table public.notifications_sent add constraint notifications_sent_unit_id_fk foreign key(unit_id) references public.units(id) on delete restrict;
 end if;
 if not exists(select from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and c.conkey=array[a.attnum]
  where c.conrelid='public.notifications_sent'::regclass and c.contype='f' and a.attname='whatsapp_channel_id') then
  alter table public.notifications_sent add constraint notifications_sent_whatsapp_channel_id_fkey foreign key(whatsapp_channel_id) references public.whatsapp_channels(id) on delete set null;
 end if;
 if not exists(select from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and c.conkey=array[a.attnum]
  where c.conrelid='public.notifications_sent'::regclass and c.contype='f' and a.attname='whatsapp_channel_id'
   and c.confrelid='public.whatsapp_channels'::regclass and c.confdeltype='n' and c.convalidated) then
  raise exception 'acceptance_setup_notification_channel_fk'; end if;
 if exists(select from pg_constraint where conrelid='public.notifications_sent'::regclass and conname='notifications_sent_waitlist_id_kind_key') then
  if (select pg_get_constraintdef(oid) from pg_constraint where conrelid='public.notifications_sent'::regclass and conname='notifications_sent_waitlist_id_kind_key')<>'UNIQUE (waitlist_id, kind)' then
   raise exception 'acceptance_setup_waitlist_unique'; end if;
  alter table public.notifications_sent drop constraint notifications_sent_waitlist_id_kind_key;
 end if;
 if not exists(select from pg_constraint where conrelid='public.notifications_sent'::regclass and conname='notifications_sent_whatsapp_provider_check') then
  alter table public.notifications_sent add constraint notifications_sent_whatsapp_provider_check check(whatsapp_provider is null or whatsapp_provider in('zapi','uazapi','waha','official','datafy'));
 end if;
end $setup$;
create unique index if not exists notifications_sent_waitlist_kind_unique on public.notifications_sent(waitlist_id,kind) where waitlist_id is not null;
do $indexes$
begin
 if not exists(select from pg_index where indexrelid='public.conversations_unit_wa_chat_lid_idx'::regclass
  and indrelid='public.conversations'::regclass and indisunique and indisvalid
  and pg_get_indexdef(indexrelid,1,true)='unit_id' and pg_get_indexdef(indexrelid,2,true)='wa_chat_lid'
  and indnatts=2 and pg_get_expr(indpred,indrelid)='(wa_chat_lid IS NOT NULL)') then
  raise exception 'acceptance_setup_conversations_index'; end if;
 if not exists(select from pg_index where indexrelid='public.notifications_sent_waitlist_kind_unique'::regclass
  and indrelid='public.notifications_sent'::regclass and indisunique and indisvalid
  and pg_get_indexdef(indexrelid,1,true)='waitlist_id' and pg_get_indexdef(indexrelid,2,true)='kind'
  and indnatts=2 and pg_get_expr(indpred,indrelid)='(waitlist_id IS NOT NULL)') then
  raise exception 'acceptance_setup_notification_index'; end if;
 if not exists(select from pg_constraint where conrelid='public.notifications_sent'::regclass and contype='u'
  and pg_get_constraintdef(oid)='UNIQUE (reservation_id, kind)') then
  raise exception 'acceptance_setup_reservation_unique'; end if;
 if (select pg_get_constraintdef(oid) from pg_constraint where conrelid='public.notifications_sent'::regclass
  and conname='notifications_sent_whatsapp_provider_check') is distinct from
  'CHECK (((whatsapp_provider IS NULL) OR (whatsapp_provider = ANY (ARRAY[''zapi''::text, ''uazapi''::text, ''waha''::text, ''official''::text, ''datafy''::text]))))' then
  raise exception 'acceptance_setup_provider_check'; end if;
end $indexes$;
`;
const assertions = definitions.map(d => `
do $verify$
declare f pg_proc%rowtype;
begin
 select * into f from pg_proc where oid='public.${d.name}(${d.compact})'::regprocedure;
 if f.prosrc is distinct from ${literal(d.body)} or not f.prosecdef or f.proconfig is distinct from array['search_path=public'] then
  raise exception 'acceptance_setup_function_catalog'; end if;
 if has_function_privilege('anon',f.oid,'EXECUTE') or has_function_privilege('authenticated',f.oid,'EXECUTE')
 or exists(select from aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) where grantee=0 and privilege_type='EXECUTE')
 or not has_function_privilege('service_role',f.oid,'EXECUTE') then raise exception 'acceptance_setup_function_acl'; end if;
end $verify$;`).join('\n');
const transaction = `begin; set local lock_timeout='5s'; set local statement_timeout='10s';\n${schema}\n${definitions.flatMap(d => d.statements).join('\n')}\n${assertions}\ncommit;`;
// Identical second application proves this setup's own idempotence. No product
// migration or gate is run by this script, and no key/HTTP access is needed.
for (let pass = 1; pass <= 2; pass++) {
  run(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], transaction);
  console.log(`GREEN acceptance fixture application ${pass}; actual function body/ACL/catalog verified`);
}
for (const d of definitions) console.log(`SOURCE ${d.name} sha256=${d.digest}`);
