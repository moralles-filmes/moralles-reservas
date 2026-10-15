import { resolveLocalDocker } from './local-runtime-paths.mjs';
// Additive local fixture bridge only. No historical replay, RPC standins or retrofits.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const docker = resolveLocalDocker();
const project = 'moralles-templates-20261003', container = `supabase_db_${project}`;
const historical = readFileSync(fileURLToPath(new URL('../../migrations/20260508151746_042_giftback_module.sql', import.meta.url)), 'utf8');
const hardening = readFileSync(fileURLToPath(new URL('../../migrations/20260517110000_giftback_hardening.sql', import.meta.url)), 'utf8');
function exact(source, pattern) { const found = [...source.matchAll(pattern)]; if (found.length !== 1) throw new Error('resource_setup_source_mismatch'); return found[0][0]; }
const rules = exact(historical, /create table voucher_rules \([\s\S]*?\n\);/g)
  .replace('create table voucher_rules', 'create table if not exists public.voucher_rules').replace('references units(id)', 'references public.units(id)');
const rating = exact(hardening, /alter table voucher_rules\s+add constraint voucher_rules_min_rating_when_after_rating\s+check \(trigger_type <> 'after_rating' or min_rating is not null\);/g);
// ADD nullable without default FIRST, then future insert defaults. Every legacy NULL survives.
const columns = [
  ['units','slug','text',null], ['units','timezone','text',"'America/Sao_Paulo'::text"],
  ['reservations','date','date',null], ['reservations','time','time without time zone',null],
  ['reservations','payment_status','text',null], ['reservations','source','text',"'web'::text"],
  ['reservations','party_size','integer',null], ['reservations','reservation_code','text',null],
  ['reservations','satisfaction_rating','integer',null],
  ['waitlist','party_size','integer',null], ['waitlist','code','integer',null],
  ['waitlist','created_at','timestamp with time zone','now()'], ['waitlist','seated_at','timestamp with time zone',null],
  ['vouchers','rule_id','uuid',null], ['vouchers','code','text',null], ['vouchers','discount_percent','integer',null],
  ['vouchers','issued_at','timestamp with time zone','now()'], ['vouchers','created_at','timestamp with time zone','now()'],
  ['vouchers','expires_at','timestamp with time zone',null],
];
const inherited = [
  ['units','id','uuid',true], ['units','organization_id','uuid',true], ['units','name','text',true],
  ['customers','id','uuid',true], ['customers','organization_id','uuid',true], ['customers','name','text',true],
  ['customers','phone','text',true], ['customers','do_not_contact','boolean',true], ['customers','deleted_at','timestamp with time zone',false],
  ['reservations','id','uuid',true], ['reservations','unit_id','uuid',true], ['reservations','customer_id','uuid',true], ['reservations','status','text',true],
  ['reservations','applied_discount_percent','integer',false],
  ['waitlist','id','uuid',true], ['waitlist','unit_id','uuid',true], ['waitlist','customer_id','uuid',false],
  ['waitlist','customer_phone','text',false], ['waitlist','customer_name','text',null], ['waitlist','status','text',true],
  ['vouchers','id','uuid',true], ['vouchers','unit_id','uuid',true], ['vouchers','customer_id','uuid',true], ['vouchers','status','text',true],
  ['settings','id','uuid',true], ['settings','unit_id','uuid',true], ['settings','key','text',true], ['settings','value','jsonb',true],
];
const checks = [
  ['reservations','resource41_party','party_size >= 1','CHECK ((party_size >= 1))'],
  ['reservations','resource41_source',"source in('web','whatsapp')","CHECK ((source = ANY (ARRAY['web'::text, 'whatsapp'::text])))"],
  ['reservations','resource41_payment',"payment_status is null or payment_status in('not_required','pending_payment','paid','failed','refunded','expired')","CHECK (((payment_status IS NULL) OR (payment_status = ANY (ARRAY['not_required'::text, 'pending_payment'::text, 'paid'::text, 'failed'::text, 'refunded'::text, 'expired'::text]))))"],
  ['reservations','resource41_rating','satisfaction_rating between 1 and 5','CHECK (((satisfaction_rating >= 1) AND (satisfaction_rating <= 5)))'],
  ['waitlist','resource41_party','party_size >= 1','CHECK ((party_size >= 1))'],
  ['vouchers','resource41_discount','discount_percent > 0 and discount_percent <= 100','CHECK (((discount_percent > 0) AND (discount_percent <= 100)))'],
];
const indexes = [
  ['units','resource41_unit_slug',['slug'],null],
  ['reservations','resource41_reservation_code',['reservation_code'],null],
  ['waitlist','resource41_waitlist_code',['unit_id','code'],"((status = ANY (ARRAY['waiting'::text, 'notified'::text])) AND (code IS NOT NULL))"],
  ['vouchers','resource41_voucher_code',['code'],"(status = 'active'::text)"],
  ['vouchers','resource41_voucher_rule_customer',['unit_id','rule_id','customer_id'],"((status = 'active'::text) AND (rule_id IS NOT NULL))"],
];
const literal = value => `'${value.replaceAll("'", "''")}'`;
const shape = inherited.map(([table, column, type, nn]) => `
 if not exists(select from pg_attribute where attrelid='public.${table}'::regclass and attname=${literal(column)} and not attisdropped
  and format_type(atttypid,atttypmod)=${literal(type)}${nn === null ? '' : ` and attnotnull=${nn}`}) then raise exception 'resource_setup_inherited_shape'; end if;`).join('\n');
const adds = columns.map(([table, column, type, future]) => `
do $column$
declare a pg_attribute%rowtype; d text;
begin
 select * into a from pg_attribute where attrelid='public.${table}'::regclass and attname=${literal(column)} and not attisdropped;
 if not found then alter table public.${table} add column ${column} ${type};
 elsif format_type(a.atttypid,a.atttypmod)<>${literal(type)} then raise exception 'resource_setup_column_type'; end if;
 select pg_get_expr(adbin,adrelid) into d from pg_attrdef where adrelid='public.${table}'::regclass and adnum=(select attnum from pg_attribute where attrelid='public.${table}'::regclass and attname=${literal(column)});
 if d is not null and d is distinct from ${future ? literal(future) : 'null::text'} then raise exception 'resource_setup_unexpected_default'; end if;
 ${future ? `alter table public.${table} alter column ${column} set default ${future};` : ''}
end $column$;`).join('\n');
const constraintSql = checks.map(([table,name,expr,expected]) => `
do $check$
begin
 if not exists(select from pg_constraint where conrelid='public.${table}'::regclass and conname=${literal(name)}) then
  alter table public.${table} add constraint ${name} check(${expr});
 end if;
 if not exists(select from pg_constraint where conrelid='public.${table}'::regclass and conname=${literal(name)} and contype='c' and convalidated
  and pg_get_constraintdef(oid)=${literal(expected)}) then raise exception 'resource_setup_constraint_mismatch'; end if;
end $check$;`).join('\n');
const indexSql = indexes.map(([table,name,keys,predicate]) => `
create unique index if not exists ${name} on public.${table}(${keys.join(',')})${predicate ? ` where ${predicate}` : ''};
do $index$
begin
 if not exists(select from pg_index where indexrelid='public.${name}'::regclass and indrelid='public.${table}'::regclass
  and indisunique and indisvalid and indnatts=${keys.length} and indnkeyatts=${keys.length}
  ${keys.map((key,i) => `and pg_get_indexdef(indexrelid,${i+1},true)=${literal(key)}`).join(' ')}
  and pg_get_expr(indpred,indrelid) is not distinct from ${predicate ? literal(predicate) : 'null::text'}) then raise exception 'resource_setup_index_mismatch'; end if;
end $index$;`).join('\n');
const schema = `
do $inherited$ begin ${shape} end $inherited$;
${adds}
${rules}
do $rules$
begin
 if not exists(select from pg_constraint where conrelid='public.voucher_rules'::regclass and conname='voucher_rules_min_rating_when_after_rating') then
  ${rating.replace('alter table voucher_rules','alter table public.voucher_rules')}
 end if;
 if (select count(*) from pg_attribute where attrelid='public.voucher_rules'::regclass and attnum>0 and not attisdropped)<>12
  or exists(select from (values
    ('id','uuid',true,'gen_random_uuid()'),('unit_id','uuid',true,null),('name','text',true,null),('trigger_type','text',true,null),
    ('discount_percent','integer',true,null),('validity_days','integer',true,'30'),('min_rating','integer',false,null),('visits_required','integer',false,null),
    ('days_window','integer',false,null),('active','boolean',true,'true'),('created_at','timestamp with time zone',true,'now()'),('updated_at','timestamp with time zone',true,'now()')) e(n,t,nn,d)
    left join pg_attribute a on a.attrelid='public.voucher_rules'::regclass and a.attname=e.n and not a.attisdropped
    left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attname is null or format_type(a.atttypid,a.atttypmod)<>e.t or a.attnotnull<>e.nn or pg_get_expr(d.adbin,d.adrelid) is distinct from e.d)
  then raise exception 'resource_setup_rules_shape'; end if;
 if not exists(select from pg_constraint where conrelid='public.voucher_rules'::regclass and contype='p' and pg_get_constraintdef(oid)='PRIMARY KEY (id)')
  or not exists(select from pg_constraint where conrelid='public.voucher_rules'::regclass and conname='voucher_rules_min_rating_when_after_rating' and convalidated
    and pg_get_constraintdef(oid)='CHECK (((trigger_type <> ''after_rating''::text) OR (min_rating IS NOT NULL)))')
  or (select count(*) from pg_constraint where conrelid='public.voucher_rules'::regclass and contype='c')<>7
  or exists(select from (values
   ('CHECK ((trigger_type = ANY (ARRAY[''after_rating''::text, ''manual''::text, ''birthday''::text, ''frequency''::text])))'),
   ('CHECK (((discount_percent > 0) AND (discount_percent <= 100)))'), ('CHECK ((validity_days > 0))'),
   ('CHECK (((min_rating >= 1) AND (min_rating <= 5)))'), ('CHECK ((visits_required > 0))'), ('CHECK ((days_window > 0))')) e(def)
   where not exists(select from pg_constraint where conrelid='public.voucher_rules'::regclass and contype='c' and convalidated and pg_get_constraintdef(oid)=e.def)) then raise exception 'resource_setup_rules_constraints'; end if;
end $rules$;
create index if not exists voucher_rules_unit_active_idx on public.voucher_rules(unit_id,active);
do $rules_index$ begin
 if not exists(select from pg_index where indexrelid='public.voucher_rules_unit_active_idx'::regclass and indrelid='public.voucher_rules'::regclass
  and not indisunique and indisvalid and indnatts=2 and indnkeyatts=2 and indpred is null
  and pg_get_indexdef(indexrelid,1,true)='unit_id' and pg_get_indexdef(indexrelid,2,true)='active') then raise exception 'resource_setup_rules_index'; end if;
end $rules_index$;
alter table public.voucher_rules enable row level security;
alter table public.voucher_rules force row level security;
revoke all on public.voucher_rules from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.voucher_rules to service_role;
do $fk$
begin
 if not exists(select from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and c.conkey=array[a.attnum]
  where c.conrelid='public.vouchers'::regclass and c.contype='f' and a.attname='rule_id') then
  alter table public.vouchers add constraint resource41_voucher_rule foreign key(rule_id) references public.voucher_rules(id) on delete set null;
 end if;
 if not exists(select from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and c.conkey=array[a.attnum]
  join pg_attribute parent on parent.attrelid=c.confrelid and c.confkey=array[parent.attnum]
  where c.conrelid='public.vouchers'::regclass and c.contype='f' and a.attname='rule_id' and c.confrelid='public.voucher_rules'::regclass
   and parent.attname='id' and c.confdeltype='n' and c.convalidated) then raise exception 'resource_setup_rule_fk'; end if;
 if not exists(select from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and c.conkey=array[a.attnum]
  join pg_attribute parent on parent.attrelid=c.confrelid and c.confkey=array[parent.attnum]
  where c.conrelid='public.voucher_rules'::regclass and c.contype='f' and a.attname='unit_id' and c.confrelid='public.units'::regclass
   and parent.attname='id' and c.confdeltype='c' and c.convalidated) then raise exception 'resource_setup_rule_unit_fk'; end if;
end $fk$;
${constraintSql}
${indexSql}
-- Inherited customer/settings types are validated; their production RLS/NN/history
-- and old customers.org/reservations.unit CASCADE deviations are NOT repaired here.
`;
if (process.argv.length === 3 && process.argv[2] === '--source-check') {
  console.log(`SOURCE rules sha256=${createHash('sha256').update(rules+rating).digest('hex')}`);
  console.log(`SOURCE bridge sha256=${createHash('sha256').update(schema).digest('hex')} columns=${columns.length}`);
  console.log('Source only; no SQL execution, schema fidelity or ACL proof.'); process.exit(0);
}
function run(args,input) {
  const result = spawnSync(docker,args,{ input,encoding:'utf8',timeout:30000,windowsHide:true });
  if (result.status !== 0) throw new Error('resource_setup_local_process_failed'); return result.stdout.trim();
}
if (process.argv.length !== 2 || process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT || process.env.DOCKER_TLS_VERIFY || process.env.DOCKER_CERT_PATH) throw new Error('resource_setup_override_refused');
if (!/^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+$/.test(run(['context','inspect','--format','{{ .Endpoints.docker.Host }}']))
  || run(['inspect','--format','{{ .State.Running }}',container]) !== 'true'
  || run(['inspect','--format','{{ .Name }}',container]) !== `/${container}`
  || run(['inspect','--format','{{ index .Config.Labels "com.supabase.cli.project" }}',container]) !== project
  || run(['inspect','--format','{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}',container]) !== '55452') throw new Error('resource_setup_own_running_stack_required');
for (let pass=1;pass<=2;pass++) {
  run(['exec','-i',container,'psql','-U','postgres','-d','postgres','-X','-q','-v','ON_ERROR_STOP=1'],`begin; set local lock_timeout='5s'; set local statement_timeout='20s';\n${schema}\ncommit;`);
  console.log(`GREEN resource fixture application ${pass}; nullable bridge, NOT production NN/RLS/trigger parity`);
}
