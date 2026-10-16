-- Templates "mesa pronta" e "reserva cancelada": migration
-- 20261017120000_whatsapp_templates_table_ready_cancellation.sql (catálogo de
-- 9 modelos, kinds `cancellation` e `waitlist_table_ready` no ledger de
-- automação). Somente banco descartável.
--
-- SEQUÊNCIA (contêiner próprio; seção "Templates mesa pronta e cancelamento
-- (66)" no README):
--   ... -> 20261009220823 -> 66a -> 66 (esperado: ERROR pela guarda, o RED)
--   -> 20261017120000 -> 66 -> 20261017120000 x2 -> 66
--
-- O QUE ESTE ARQUIVO PROVA (rótulos das checagens começam pelo caso):
--   T1  CHECKs: os 8 kinds entram (inserção direta, guarda real ligada) e o
--       `initial_catalog_key` que a guarda deriva passa no pin tuple com os
--       ids novos; kind desconhecido, kind<->recurso trocado (cancellation +
--       fila, mesa pronta + reserva) e logical_id desconhecido recusam com o
--       nome exato da constraint;
--   T2  `enqueue_whatsapp_automation`: chave lógica dos dois kinds novos em
--       canal TEXT (bound), em preconfiguração sem canal e sem template, e
--       em canal datafy apontando o `whatsapp_remote_templates` certo;
--       logical_id divergente na intenção recusa 22023;
--   T3  autoridade final (`confirm_whatsapp_automation_resource_post` ->
--       `post_core`) para `cancellation`: reserva cancelada futura passa,
--       inclusive com pagamento pendente; reserva `confirmed`, snapshot
--       `confirmed` sobre reserva cancelada e reserva passada recusam;
--   T4  idem para `waitlist_table_ready`: `waiting`/`notified` passam, cliente
--       nulo passa; `seated`, `cancelled` e `seated_at` preenchido recusam;
--   T5  conta datafy com os 9 `whatsapp_remote_templates`: para os dois ids
--       novos `prepare_whatsapp_template_provision`,
--       `confirm_whatsapp_template_post` e `revalidate_whatsapp_template_job`
--       atravessam a lista de ids (prepare -> recusa local -> prova zero-POST
--       -> revalidação -> prepare corrigido);
--   T6  `reconcile_whatsapp_automation_acceptance`: mesa pronta sem cliente
--       reconcilia (`skipped_no_customer`) e grava `notifications_sent`;
--       cancelamento com cliente grava histórico (`recorded`);
--   T7  `block_whatsapp_automation_preflight` aceita `reservation_not_cancelled`,
--       `get_whatsapp_automation_delivery_state` mostra o motivo (não
--       `unknown_reason`) e a revalidação de pinos NÃO o corrige;
--   T8  as 10 funções substituídas têm oid/ACL/prosecdef/proconfig/
--       provolatile/dono iguais ao snapshot do 66a; trigger function sem
--       EXECUTE para PUBLIC/anon/authenticated/service_role; exatamente uma
--       CHECK por localizador e uma função por nome (idempotência);
--   T9  regressão mínima: `confirmation`, `waitlist_entered` e o promocional
--       `waitlist_feedback` continuam com o mesmo comportamento.
--
-- CONTROLES POSITIVOS (subtransação revertida; cada um mede o caso SEM a
-- sabotagem, aplica a sabotagem, observa a virada e confere o restore):
--   (a) CHECK de logical_id sem os ids novos  -> semear fila_mesa_pronta_v1 recusa
--   (b) post_core aceitando `confirmed` para cancellation -> recusa do T3 some
--   (c) mesa pronta aceitando `seated`        -> recusa do T4 some
--
-- O QUE ELE NÃO PROVA: JWT genuíno/PostgREST (os atores são claims
-- `request.jwt.claim.*` numa sessão superusuária; o auth.uid() desta imagem lê
-- `request.jwt.claim.sub`), RLS de produção, corrida com duas sessões (a
-- migration não muda ordem de lock), o caminho TypeScript dos produtores
-- (Fase 3) nem chamada ao provedor.
\set ON_ERROR_STOP on

-- ─── GUARDA: só faz sentido DEPOIS da migration e do 66a ───────────────────
-- Rodado antes, os casos de recusa (T1 trocado, T3/T4 recusas) passariam POR
-- ACIDENTE: sem os kinds no CHECK todo INSERT/enqueue "falha".
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'public.whatsapp_remote_templates'::regclass and contype = 'c'
                    and pg_catalog.pg_get_constraintdef(oid) like '%fila_mesa_pronta_v1%'
                    and pg_catalog.pg_get_constraintdef(oid) like '%res_cancelada_v1%')
     or not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'public.whatsapp_automation_jobs'::regclass and contype = 'c'
                    and pg_catalog.pg_get_constraintdef(oid) like '%waitlist_table_ready%')
     or pg_catalog.pg_get_functiondef('app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)'::regprocedure) not like '%waitlist_table_ready%' then
    raise exception '66 exige a migration 20261017120000 aplicada (CHECKs/post_core sem os kinds/ids novos).';
  end if;
  if to_regclass('public.t_snap066') is null
     or (select count(*) from public.t_snap066 where k like 'fn_antes:%') <> 10 then
    raise exception '66 exige o 66a-templates-table-ready-bootstrap.sql aplicado ANTES da migration (snapshot ausente).';
  end if;
end $$;

begin;
set local lock_timeout = '5s'; set local statement_timeout = '180s';
create temp table checks66(n bigserial, label text) on commit drop;
create temp table ids66(k text primary key, v uuid not null) on commit drop;
create function pg_temp.ok66(v boolean, label text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'FAIL66 %', label; end if; insert into checks66(label) values (label); end $$;
-- SQLSTATE + constraint of a refused statement, or 'ok' (effect then persists).
create function pg_temp.err66(stmt text) returns text language plpgsql as $$
declare s text; c text;
begin
  begin execute stmt; exception when others then get stacked diagnostics s = returned_sqlstate, c = constraint_name; return s || ':' || coalesce(c, ''); end;
  return 'ok';
end $$;
create function pg_temp.id66(key text) returns uuid language sql as $$ select v from ids66 where k = key $$;
create function pg_temp.put66(key text, val uuid) returns uuid language sql as $$ insert into ids66 values (key, val) on conflict (k) do update set v = excluded.v returning v $$;
-- This image's auth.uid()/auth.role() read request.jwt.claim.sub/role.
create function pg_temp.actor66(uid uuid, role_name text default 'authenticated') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', role_name, 'sub', uid)::text, true);
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  perform set_config('request.jwt.claim.role', coalesce(role_name, ''), true);
end $$;
create function pg_temp.service66() returns void language plpgsql as $$
begin perform pg_temp.actor66(null, 'service_role'); end $$;
-- Projection of the real fixture row (same shape as 41's expected41). The
-- setting key mirrors the migration's v_key: null for confirmation and for
-- both new kinds.
create function pg_temp.expected66(jid uuid) returns jsonb language plpgsql as $$
declare j public.whatsapp_automation_jobs%rowtype; r jsonb; c jsonb; u jsonb; rule jsonb := 'null'; setting jsonb; k text;
begin
  select * into j from public.whatsapp_automation_jobs where id = jid;
  if j.reservation_id is not null then
    select jsonb_build_object('id',id,'unit_id',unit_id,'customer_id',customer_id,'date',date,'time',time,'status',status,
      'payment_status',payment_status,'source',source,'party_size',party_size,'reservation_code',reservation_code,
      'applied_discount_percent',applied_discount_percent,'satisfaction_rating',satisfaction_rating) into r from public.reservations where id = j.reservation_id;
  elsif j.waitlist_id is not null then
    select jsonb_build_object('id',id,'unit_id',unit_id,'customer_id',customer_id,'customer_name',customer_name,'customer_phone',customer_phone,
      'party_size',party_size,'code',code,'status',status,'created_at',created_at,'seated_at',seated_at) into r from public.waitlist where id = j.waitlist_id;
  else
    raise exception 'expected66 voucher not used';
  end if;
  select jsonb_build_object('id',id,'organization_id',organization_id,'name',name,'phone',phone,'do_not_contact',do_not_contact,'deleted_at',deleted_at)
    into c from public.customers where id = j.customer_id;
  select jsonb_build_object('id',id,'organization_id',organization_id,'name',name,'slug',slug,'timezone',timezone) into u from public.units where id = j.unit_id;
  k := case j.kind when 'confirmation' then null when 'cancellation' then null when 'waitlist_table_ready' then null
         when 'voucher_issued' then 'giftback_whatsapp_enabled' else j.kind || '_enabled' end;
  select jsonb_build_object('key',k,'present',true,'value',value) into setting from public.settings where unit_id = j.unit_id and key = k;
  if not found then setting := jsonb_build_object('key',k,'present',false,'value',null); end if;
  return jsonb_build_object('version',1,'kind',j.kind,'resource',r,'customer',c,'unit',u,'rule',rule,'setting',setting);
end $$;
-- Real path: enqueue -> claim -> frozen redacted body -> pre-POST prepare.
create function pg_temp.flow66(u uuid, v_kind text, res uuid, fact timestamptz, expiry timestamptz, rev bigint, label text) returns jsonb language plpgsql as $$
declare j uuid; x jsonb; f uuid; g bigint;
begin
  j := public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u,'kind',v_kind,
    case when v_kind in ('confirmation','reminder_d1','survey_d1','cancellation') then 'reservation_id' else 'waitlist_id' end, res,
    'source_event_key','task66-'||v_kind||'-'||res,'fact_at',fact,'expires_at',expiry));
  perform pg_temp.ok66(j is not null, label || ' enqueued');
  x := public.claim_whatsapp_automation(j); f := (x->>'claim_token')::uuid;
  perform pg_temp.ok66(f is not null and x->>'state' = 'claimed', label || ' claimed');
  update public.whatsapp_automation_jobs set safe_log_body = 'Task66 synthetic redacted' where id = j and claim_token = f;
  select binding_generation into g from public.whatsapp_automation_jobs where id = j;
  perform pg_temp.ok66(public.prepare_whatsapp_automation_post(j, f, g, rev, null), label || ' real prepare');
  return jsonb_build_object('job', j, 'fence', f, 'generation', g);
end $$;
create function pg_temp.confirm66(flow jsonb, expected jsonb, rev bigint default null) returns jsonb language sql as $$
  select public.confirm_whatsapp_automation_resource_post((flow->>'job')::uuid, (flow->>'fence')::uuid, (flow->>'generation')::bigint, rev, null, expected)
$$;
create temp table flows66(k text primary key, flow jsonb not null) on commit drop;

-- ─── fixtures ──────────────────────────────────────────────────────────────
do $$
declare
  stamp timestamptz := clock_timestamp(); v_admin uuid := gen_random_uuid(); o uuid := gen_random_uuid();
  u uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid();
  c uuid := gen_random_uuid(); ch uuid := gen_random_uuid(); ch2 uuid := gen_random_uuid(); ch3 uuid := gen_random_uuid();
  a2 uuid := gen_random_uuid(); b2 uuid;
begin
  if (stamp at time zone 'America/Sao_Paulo')::time >= '23:50'::time or (stamp at time zone 'America/Sao_Paulo')::time < '00:10'::time then
    raise exception 'task66_day_boundary_fixture_refused (rode fora de 23:50-00:10 BRT)';
  end if;
  perform pg_temp.ok66(not exists (select from cron.job where jobname in ('whatsapp-automation-worker','whatsapp-template-workers')), 'T0 cron quarantine');
  insert into auth.users(id) values (v_admin); insert into public.platform_admins values (v_admin);
  insert into public.organizations(id, name) values (o, 'Task66');
  insert into public.units(id, organization_id, name, slug, timezone) values
    (u, o, 'Task66 text', 'task66-' || u, 'America/Sao_Paulo'),
    (u2, o, 'Task66 datafy', 'task66-' || u2, 'America/Sao_Paulo'),
    (u3, o, 'Task66 sem canal', 'task66-' || u3, 'America/Sao_Paulo');
  insert into public.customers(id, organization_id, name, phone, do_not_contact, deleted_at) values (c, o, 'Synthetic66', '11999996601', false, null);
  insert into public.whatsapp_channels(id, unit_id, provider, status, is_active, last_health_check_at, webhook_secret) values
    (ch, u, 'zapi', 'connected', true, stamp, 'synthetic-task66-text'),
    (ch3, u3, 'zapi', 'connected', true, stamp, 'synthetic-task66-gone');
  insert into public.whatsapp_channels(id, unit_id, provider, status, is_active, last_health_check_at, credentials, webhook_secret) values
    (ch2, u2, 'datafy', 'connected', true, stamp, '{"phone_number_id":"6601"}', 'synthetic-task66-datafy');
  perform pg_temp.actor66(v_admin);
  -- TEXT bootstrap through the real admin RPC (binding + sticky adoption).
  perform pg_temp.ok66(public.release_whatsapp_template_channel(ch, 'dispatch', true, 0, null), 'T0 TEXT bootstrap u');
  perform pg_temp.ok66(public.release_whatsapp_template_channel(ch3, 'dispatch', true, 0, null), 'T0 TEXT bootstrap u3');
  -- Datafy account/binding; catalog and dispatch grants through the real RPC.
  insert into public.whatsapp_template_accounts(id, organization_id, waba_id, verified_at) values (a2, o, '6600000000001', stamp);
  insert into public.whatsapp_template_bindings(unit_id, channel_id, account_id, provider, verified_at) values (u2, ch2, a2, 'datafy', stamp) returning id into b2;
  perform pg_temp.ok66(public.release_whatsapp_template_channel(ch2, 'catalog', true, 0, 1), 'T0 datafy catalog grant');
  perform pg_temp.ok66(public.release_whatsapp_template_channel(ch2, 'dispatch', true, 0, 1), 'T0 datafy dispatch grant');
  perform pg_temp.service66();
  -- u3 keeps its sticky adoption after losing channel and binding (preconfiguration path).
  delete from public.whatsapp_channels where id = ch3;
  perform pg_temp.ok66(exists (select from public.whatsapp_automation_adoptions where unit_id = u3)
    and not exists (select from public.whatsapp_channels where unit_id = u3), 'T0 u3 adopted without channel');
  insert into public.platform_flags(key, value) values ('whatsapp_automation_dispatch', 'true') on conflict (key) do update set value = excluded.value;
  perform pg_temp.put66('admin', v_admin); perform pg_temp.put66('org', o);
  perform pg_temp.put66('u', u); perform pg_temp.put66('u2', u2); perform pg_temp.put66('u3', u3);
  perform pg_temp.put66('c', c); perform pg_temp.put66('ch', ch); perform pg_temp.put66('ch2', ch2);
  perform pg_temp.put66('a2', a2); perform pg_temp.put66('b2', b2);
end $$;

-- ─── T1: CHECKs (inserção direta, guarda real ligada) ──────────────────────
do $$
declare
  u3 uuid := pg_temp.id66('u3'); o uuid := pg_temp.id66('org'); c uuid := pg_temp.id66('c');
  r uuid := gen_random_uuid(); w uuid := gen_random_uuid(); v uuid := gen_random_uuid(); k text; got text; key text;
  stmt text := 'insert into public.whatsapp_automation_jobs(unit_id,organization_id,kind,reservation_id,waitlist_id,voucher_id,customer_id,source_event_key,fact_at,expires_at,pin_phase,state,error_code) values(%L,%L,%L,%L,%L,%L,%L,%L,clock_timestamp(),clock_timestamp()+interval ''1 hour'',''preconfiguration'',''blocked'',''channel_unconfigured'')';
begin
  insert into public.reservations(id, unit_id, customer_id, status) values (r, u3, c, 'cancelled');
  insert into public.waitlist(id, unit_id, customer_id, customer_name, customer_phone, party_size, code, status) values (w, u3, c, 'Synthetic66', '11999996601', 2, 661, 'waiting');
  insert into public.vouchers(id, unit_id, customer_id, status) values (v, u3, c, 'active');
  foreach k in array array['confirmation','reminder_d1','survey_d1','cancellation','waitlist_entered','waitlist_feedback','waitlist_table_ready','voucher_issued'] loop
    got := pg_temp.err66(format(stmt, u3, o, k,
      case when k in ('confirmation','reminder_d1','survey_d1','cancellation') then r end,
      case when k like 'waitlist_%' then w end, case when k = 'voucher_issued' then v end, c, 't1-' || k));
    perform pg_temp.ok66(got = 'ok', 'T1 kind CHECK accepts ' || k || ' (' || got || ')');
    select initial_catalog_key into key from public.whatsapp_automation_jobs where source_event_key = 't1-' || k;
    perform pg_temp.ok66(key = case k when 'confirmation' then 'res_confirmacao_v1' when 'reminder_d1' then 'res_lembrete_dia_v1'
      when 'survey_d1' then 'res_pesquisa_reserva_v1' when 'cancellation' then 'res_cancelada_v1' when 'waitlist_entered' then 'fila_entrada_v1'
      when 'waitlist_feedback' then 'fila_feedback_v1' when 'waitlist_table_ready' then 'fila_mesa_pronta_v1' when 'voucher_issued' then 'mkt_voucher_programado_v1' end,
      'T1 guard key passes pin tuple CHECK for ' || k || ' = ' || coalesce(key, 'null'));
  end loop;
  got := pg_temp.err66(format(stmt, u3, o, 'table_ready', null, w, null, c, 't1-unknown'));
  perform pg_temp.ok66(got = '23514:whatsapp_automation_jobs_kind_check', 'T1 unknown kind refused by kind CHECK (' || got || ')');
  got := pg_temp.err66(format(stmt, u3, o, 'cancellation', null, w, null, c, 't1-swap-cancel'));
  perform pg_temp.ok66(got = '23514:whatsapp_automation_jobs_kind_resource_check', 'T1 cancellation+waitlist refused (' || got || ')');
  got := pg_temp.err66(format(stmt, u3, o, 'waitlist_table_ready', r, null, null, c, 't1-swap-ready'));
  perform pg_temp.ok66(got = '23514:whatsapp_automation_jobs_kind_resource_check', 'T1 table_ready+reservation refused (' || got || ')');
  got := pg_temp.err66(format('insert into public.whatsapp_remote_templates(account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation) values(%L,%L,1,''pt_BR'',%L,%L,''UTILITY'',1)',
    pg_temp.id66('a2'), 'res_cancelada_v2', 'res_cancelada_v2', repeat('e', 64)));
  perform pg_temp.ok66(got = '23514:whatsapp_remote_templates_logical_id_check', 'T1 unknown logical_id refused (' || got || ')');
  -- Raw T1 rows are removed so T2 enqueues in u3 start from an empty ledger.
  delete from public.whatsapp_automation_jobs where source_event_key like 't1-%';
end $$;

-- ─── CTRL-a: CHECK de logical_id sem o id novo ─────────────────────────────
do $$
declare a2 uuid := pg_temp.id66('a2'); def_before text; base text; sabotaged text;
  stmt text := format('insert into public.whatsapp_remote_templates(account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation) values(%L,''fila_mesa_pronta_v1'',1,''pt_BR'',''fila_mesa_pronta_v1'',%L,''UTILITY'',1)', a2, repeat('d', 64));
begin
  select pg_get_constraintdef(oid) into def_before from pg_constraint where conrelid = 'public.whatsapp_remote_templates'::regclass and conname = 'whatsapp_remote_templates_logical_id_check';
  begin
    base := pg_temp.err66(stmt);
    raise sqlstate 'P0066';
  exception when sqlstate 'P0066' then null; end;
  begin
    alter table public.whatsapp_remote_templates drop constraint whatsapp_remote_templates_logical_id_check;
    alter table public.whatsapp_remote_templates add constraint whatsapp_remote_templates_logical_id_check
      check (logical_id in ('res_confirmacao_v1','res_confirmacao_desconto_v1','res_lembrete_dia_v1','res_pesquisa_reserva_v1','fila_entrada_v1','fila_feedback_v1','mkt_voucher_programado_v1')) not valid;
    sabotaged := pg_temp.err66(stmt);
    raise sqlstate 'P0066';
  exception when sqlstate 'P0066' then null; end;
  perform pg_temp.ok66(base = 'ok', 'CTRL-a baseline: real CHECK accepts fila_mesa_pronta_v1');
  perform pg_temp.ok66(sabotaged = '23514:whatsapp_remote_templates_logical_id_check', 'CTRL-a 7-id CHECK refuses seeding fila_mesa_pronta_v1 (' || coalesce(sabotaged, 'null') || ')');
  perform pg_temp.ok66((select count(*) = 1 and min(pg_get_constraintdef(oid)) = def_before from pg_constraint
    where conrelid = 'public.whatsapp_remote_templates'::regclass and conname = 'whatsapp_remote_templates_logical_id_check'), 'CTRL-a restore: same CHECK back');
  perform pg_temp.ok66(not exists (select from public.whatsapp_remote_templates where account_id = a2), 'CTRL-a restore: no seeded row left');
end $$;

-- ─── T2: enqueue grava a chave lógica certa ────────────────────────────────
do $$
declare
  u uuid := pg_temp.id66('u'); u2 uuid := pg_temp.id66('u2'); u3 uuid := pg_temp.id66('u3'); c uuid := pg_temp.id66('c'); a2 uuid := pg_temp.id66('a2');
  r uuid; w uuid; j uuid; row66 public.whatsapp_automation_jobs%rowtype; tomorrow date := (clock_timestamp() at time zone 'America/Sao_Paulo')::date + 1;
  lid text; n int := 0; got text;
begin
  -- TEXT channel, bound.
  r := gen_random_uuid(); insert into public.reservations(id, unit_id, customer_id, date, time, status, source, party_size, reservation_code) values (r, u, c, tomorrow, '20:00', 'cancelled', 'web', 2, 'T66-T2-' || r);
  j := public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u,'kind','cancellation','reservation_id',r,'source_event_key','t2-c','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '24 hours','logical_id','res_cancelada_v1'));
  select * into row66 from public.whatsapp_automation_jobs where id = j;
  perform pg_temp.ok66(row66.initial_catalog_key = 'res_cancelada_v1' and row66.pin_phase = 'bound' and row66.transport = 'text' and row66.state = 'queued' and row66.customer_id = c,
    'T2 text cancellation -> res_cancelada_v1 bound queued');
  perform pg_temp.ok66(public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u,'kind','cancellation','reservation_id',r,'source_event_key','t2-c','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '24 hours')) = j,
    'T2 same resource dedupes to same job');
  r := gen_random_uuid(); insert into public.reservations(id, unit_id, customer_id, date, time, status) values (r, u, c, tomorrow, '20:00', 'cancelled');
  got := pg_temp.err66(format('select public.enqueue_whatsapp_automation(%L)', jsonb_build_object('unit_id',u,'kind','cancellation','reservation_id',r,'source_event_key','t2-x','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '1 hour','logical_id','res_confirmacao_v1')));
  perform pg_temp.ok66(got like '22023:%', 'T2 cancellation with confirmation logical_id refused (' || got || ')');
  got := pg_temp.err66(format('select public.enqueue_whatsapp_automation(%L)', jsonb_build_object('unit_id',u,'kind','waitlist_table_ready','reservation_id',r,'source_event_key','t2-y','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '1 hour')));
  perform pg_temp.ok66(got like '22023:%', 'T2 table_ready with reservation refused (' || got || ')');
  w := gen_random_uuid(); insert into public.waitlist(id, unit_id, customer_id, customer_name, customer_phone, party_size, code, status) values (w, u, null, 'Sem cadastro', '11988886602', 2, 620, 'waiting');
  j := public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u,'kind','waitlist_table_ready','waitlist_id',w,'source_event_key','t2-w','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '30 minutes','logical_id','fila_mesa_pronta_v1'));
  select * into row66 from public.whatsapp_automation_jobs where id = j;
  perform pg_temp.ok66(row66.initial_catalog_key = 'fila_mesa_pronta_v1' and row66.pin_phase = 'bound' and row66.state = 'queued' and row66.customer_id is null,
    'T2 text table_ready without customer -> fila_mesa_pronta_v1 bound queued');
  -- No channel: preconfiguration keeps the logical key.
  r := gen_random_uuid(); insert into public.reservations(id, unit_id, customer_id, date, time, status) values (r, u3, c, tomorrow, '20:00', 'cancelled');
  j := public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u3,'kind','cancellation','reservation_id',r,'source_event_key','t2-u3c','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '24 hours'));
  select * into row66 from public.whatsapp_automation_jobs where id = j;
  perform pg_temp.ok66(row66.pin_phase = 'preconfiguration' and row66.error_code = 'channel_unconfigured' and row66.initial_catalog_key = 'res_cancelada_v1',
    'T2 no channel cancellation -> preconfiguration res_cancelada_v1');
  w := gen_random_uuid(); insert into public.waitlist(id, unit_id, customer_id, customer_name, customer_phone, party_size, code, status) values (w, u3, c, 'Synthetic66', '11999996601', 2, 621, 'notified');
  j := public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u3,'kind','waitlist_table_ready','waitlist_id',w,'source_event_key','t2-u3w','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '30 minutes'));
  select * into row66 from public.whatsapp_automation_jobs where id = j;
  perform pg_temp.ok66(row66.pin_phase = 'preconfiguration' and row66.error_code = 'channel_unconfigured' and row66.initial_catalog_key = 'fila_mesa_pronta_v1' and row66.customer_id = c,
    'T2 no channel table_ready -> preconfiguration fila_mesa_pronta_v1');
  -- Datafy before the catalog exists: template_unconfigured with the key.
  r := gen_random_uuid(); insert into public.reservations(id, unit_id, customer_id, date, time, status) values (r, u2, c, tomorrow, '20:00', 'cancelled');
  j := public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u2,'kind','cancellation','reservation_id',r,'source_event_key','t2-u2c-pre','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '24 hours'));
  select * into row66 from public.whatsapp_automation_jobs where id = j;
  perform pg_temp.ok66(row66.pin_phase = 'preconfiguration' and row66.error_code = 'template_unconfigured' and row66.initial_catalog_key = 'res_cancelada_v1' and row66.account_id = a2,
    'T2 datafy without template -> preconfiguration template_unconfigured res_cancelada_v1');
  -- Seed the full 9-id catalog (T5 reuses it): every id passes the logical_id CHECK.
  foreach lid in array array['res_confirmacao_v1','res_confirmacao_desconto_v1','res_lembrete_dia_v1','res_pesquisa_reserva_v1','fila_entrada_v1','fila_feedback_v1','mkt_voucher_programado_v1','fila_mesa_pronta_v1','res_cancelada_v1'] loop
    insert into public.whatsapp_remote_templates(account_id, logical_id, version, language, name, desired_hash, requested_category, binding_generation)
      values (a2, lid, 1, 'pt_BR', lid, encode(sha256(convert_to('task66:' || lid, 'UTF8')), 'hex'),
              case when lid in ('fila_feedback_v1','mkt_voucher_programado_v1') then 'MARKETING' else 'UTILITY' end, 1);
    n := n + 1;
  end loop;
  perform pg_temp.ok66(n = 9 and (select count(*) from public.whatsapp_remote_templates where account_id = a2) = 9, 'T1/T5 account seeded with the 9 catalog ids');
  r := gen_random_uuid(); insert into public.reservations(id, unit_id, customer_id, date, time, status) values (r, u2, c, tomorrow, '20:00', 'cancelled');
  j := public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u2,'kind','cancellation','reservation_id',r,'source_event_key','t2-u2c','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '24 hours'));
  select * into row66 from public.whatsapp_automation_jobs where id = j;
  perform pg_temp.ok66(row66.pin_phase = 'bound' and row66.transport = 'template' and row66.initial_catalog_key = 'res_cancelada_v1'
    and row66.remote_template_id = (select id from public.whatsapp_remote_templates where account_id = a2 and logical_id = 'res_cancelada_v1'),
    'T2 datafy cancellation pins the res_cancelada_v1 remote template (' || row66.state || '/' || coalesce(row66.error_code, '-') || ')');
  w := gen_random_uuid(); insert into public.waitlist(id, unit_id, customer_id, customer_name, customer_phone, party_size, code, status) values (w, u2, null, 'Sem cadastro', '11988886603', 3, 622, 'waiting');
  j := public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u2,'kind','waitlist_table_ready','waitlist_id',w,'source_event_key','t2-u2w','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '30 minutes'));
  select * into row66 from public.whatsapp_automation_jobs where id = j;
  perform pg_temp.ok66(row66.pin_phase = 'bound' and row66.transport = 'template' and row66.initial_catalog_key = 'fila_mesa_pronta_v1'
    and row66.remote_template_id = (select id from public.whatsapp_remote_templates where account_id = a2 and logical_id = 'fila_mesa_pronta_v1'),
    'T2 datafy table_ready pins the fila_mesa_pronta_v1 remote template (' || row66.state || '/' || coalesce(row66.error_code, '-') || ')');
end $$;

-- ─── T3: cancelamento na autoridade final ──────────────────────────────────
do $$
declare
  u uuid := pg_temp.id66('u'); c uuid := pg_temp.id66('c'); stamp timestamptz := clock_timestamp();
  tomorrow date := (stamp at time zone 'America/Sao_Paulo')::date + 1; yesterday date := (stamp at time zone 'America/Sao_Paulo')::date - 1;
  r uuid; f jsonb; e jsonb; got jsonb;
begin
  -- Cancelled, future, payment still pending: no payment check for cancellation.
  r := gen_random_uuid();
  insert into public.reservations(id, unit_id, customer_id, date, time, status, payment_status, source, party_size, reservation_code)
    values (r, u, c, tomorrow, '20:00', 'cancelled', 'pending_payment', 'web', 4, 'T66-T3A-' || r);
  f := pg_temp.flow66(u, 'cancellation', r, stamp, stamp + interval '24 hours', null, 'T3 cancelled future');
  insert into flows66 values ('t3_cancel_future', f);
  e := pg_temp.expected66((f->>'job')::uuid);
  got := pg_temp.confirm66(f, e);
  perform pg_temp.ok66(got = '{"allowed":true}', 'T3 cancelled future reservation (pending payment) passes: ' || got::text);
  got := pg_temp.confirm66(f, jsonb_set(e, '{resource,status}', '"confirmed"'));
  perform pg_temp.ok66(got = '{"allowed":false,"reason":"snapshot_invalid"}', 'T3 snapshot status confirmed over cancelled refuses: ' || got::text);
  -- Cancellation job whose reservation is (back to) confirmed: refused.
  r := gen_random_uuid();
  insert into public.reservations(id, unit_id, customer_id, date, time, status, payment_status, source, party_size, reservation_code)
    values (r, u, c, tomorrow, '20:30', 'confirmed', null, 'web', 2, 'T66-T3B-' || r);
  f := pg_temp.flow66(u, 'cancellation', r, stamp, stamp + interval '24 hours', null, 'T3 confirmed');
  insert into flows66 values ('t3_confirmed', f);
  got := pg_temp.confirm66(f, pg_temp.expected66((f->>'job')::uuid));
  perform pg_temp.ok66(got = '{"allowed":false,"reason":"snapshot_invalid"}', 'T3 confirmed reservation refuses cancellation: ' || got::text);
  -- Cancelled but already past: reservation_past -> resource_changed.
  r := gen_random_uuid();
  insert into public.reservations(id, unit_id, customer_id, date, time, status, payment_status, source, party_size, reservation_code)
    values (r, u, c, yesterday, '20:00', 'cancelled', null, 'web', 2, 'T66-T3C-' || r);
  f := pg_temp.flow66(u, 'cancellation', r, stamp, stamp + interval '24 hours', null, 'T3 past');
  got := pg_temp.confirm66(f, pg_temp.expected66((f->>'job')::uuid));
  perform pg_temp.ok66(got = '{"allowed":false,"reason":"resource_changed"}', 'T3 past cancelled reservation refuses: ' || got::text);
end $$;

-- ─── T4: mesa pronta na autoridade final ───────────────────────────────────
do $$
declare
  u uuid := pg_temp.id66('u'); c uuid := pg_temp.id66('c'); stamp timestamptz := clock_timestamp();
  w uuid; f jsonb; got jsonb; item record;
begin
  for item in select * from (values
      ('waiting',   true,  false, 631, '{"allowed":true}'),
      ('notified',  true,  false, 632, '{"allowed":true}'),
      ('waiting',   false, false, 633, '{"allowed":true}'),
      ('seated',    true,  true,  634, '{"allowed":false,"reason":"snapshot_invalid"}'),
      ('cancelled', true,  false, 635, '{"allowed":false,"reason":"snapshot_invalid"}'),
      ('waiting',   true,  true,  636, '{"allowed":false,"reason":"snapshot_invalid"}')) as t(st, with_customer, has_seated, code, want) loop
    w := gen_random_uuid();
    insert into public.waitlist(id, unit_id, customer_id, customer_name, customer_phone, party_size, code, status, created_at, seated_at)
      values (w, u, case when item.with_customer then c end, 'Synthetic66',
              case when item.with_customer then '11999996601' else '11988886604' end, 2, item.code, item.st, stamp - interval '20 minutes',
              case when item.has_seated then stamp - interval '1 minute' end);
    f := pg_temp.flow66(u, 'waitlist_table_ready', w, stamp, stamp + interval '30 minutes', null, 'T4 ' || item.code);
    insert into flows66 values ('t4_' || item.code, f);
    perform pg_temp.ok66((select customer_id is not distinct from case when item.with_customer then c end from public.whatsapp_automation_jobs where id = (f->>'job')::uuid),
      'T4 ' || item.code || ' customer resolution ' || case when item.with_customer then 'known' else 'null' end);
    got := pg_temp.confirm66(f, pg_temp.expected66((f->>'job')::uuid));
    perform pg_temp.ok66(got = item.want::jsonb, format('T4 table_ready status=%s customer=%s seated_at=%s -> %s', item.st, item.with_customer, item.has_seated, got));
  end loop;
end $$;

-- ─── CTRL-b / CTRL-c: sabotagem do post_core ───────────────────────────────
do $$
declare
  sig regprocedure := 'app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)'::regprocedure;
  def0 text := pg_get_functiondef('app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)'::regprocedure);
  acl0 text; bad text; f jsonb; base jsonb; flipped jsonb; after jsonb;
begin
  select coalesce(proacl::text, 'null') into acl0 from pg_proc where oid = sig;
  -- (b) cancellation accepting a confirmed reservation.
  select flow into f from flows66 where k = 't3_confirmed';
  base := pg_temp.confirm66(f, pg_temp.expected66((f->>'job')::uuid));
  bad := replace(def0, $s$case when j.kind='cancellation' then 'cancelled' else 'confirmed' end$s$,
                       $s$case when j.kind='cancellation' and e_res.status='confirmed' then 'confirmed' when j.kind='cancellation' then 'cancelled' else 'confirmed' end$s$);
  perform pg_temp.ok66(bad <> def0, 'CTRL-b sabotage text found');
  begin
    execute bad;
    flipped := pg_temp.confirm66(f, pg_temp.expected66((f->>'job')::uuid));
    raise sqlstate 'P0066';
  exception when sqlstate 'P0066' then null; end;
  after := pg_temp.confirm66(f, pg_temp.expected66((f->>'job')::uuid));
  perform pg_temp.ok66(base = '{"allowed":false,"reason":"snapshot_invalid"}', 'CTRL-b baseline refusal ' || base::text);
  perform pg_temp.ok66(flipped = '{"allowed":true}', 'CTRL-b sabotaged post_core lets cancellation of confirmed pass: ' || coalesce(flipped::text, 'null'));
  perform pg_temp.ok66(after = base and pg_get_functiondef(sig) = def0 and (select coalesce(proacl::text, 'null') from pg_proc where oid = sig) = acl0,
    'CTRL-b restore: body, ACL and refusal back');
  -- (c) table_ready accepting seated.
  select flow into f from flows66 where k = 't4_634';
  base := pg_temp.confirm66(f, pg_temp.expected66((f->>'job')::uuid));
  bad := replace(def0, $s$(e_wait.status is distinct from 'waiting' and e_wait.status is distinct from 'notified' or e_wait.seated_at is not null)$s$,
                       $s$(e_wait.status not in('waiting','notified','seated'))$s$);
  perform pg_temp.ok66(bad <> def0, 'CTRL-c sabotage text found');
  flipped := null;
  begin
    execute bad;
    flipped := pg_temp.confirm66(f, pg_temp.expected66((f->>'job')::uuid));
    raise sqlstate 'P0066';
  exception when sqlstate 'P0066' then null; end;
  after := pg_temp.confirm66(f, pg_temp.expected66((f->>'job')::uuid));
  perform pg_temp.ok66(base = '{"allowed":false,"reason":"snapshot_invalid"}', 'CTRL-c baseline refusal ' || base::text);
  perform pg_temp.ok66(flipped = '{"allowed":true}', 'CTRL-c sabotaged post_core lets seated table_ready pass: ' || coalesce(flipped::text, 'null'));
  perform pg_temp.ok66(after = base and pg_get_functiondef(sig) = def0 and (select coalesce(proacl::text, 'null') from pg_proc where oid = sig) = acl0,
    'CTRL-c restore: body, ACL and refusal back');
end $$;

-- ─── T6: reparação do aceite ───────────────────────────────────────────────
do $$
declare f jsonb; j uuid; res jsonb; u uuid := pg_temp.id66('u'); c uuid := pg_temp.id66('c');
begin
  -- Table ready with no known customer (T4 row 633).
  select flow into f from flows66 where k = 't4_633'; j := (f->>'job')::uuid;
  perform pg_temp.ok66(public.finish_whatsapp_automation(j, (f->>'fence')::uuid, jsonb_build_object('outcome','accepted','reason','provider_accepted','provider_message_id','task66-ready-'||j)),
    'T6 table_ready null customer accepted through real finisher');
  res := public.reconcile_whatsapp_automation_acceptance(j);
  perform pg_temp.ok66(res = '{"state":"reconciled","history":"skipped_no_customer"}', 'T6 table_ready null customer reconciles: ' || res::text);
  perform pg_temp.ok66(exists (select from public.notifications_sent n join public.whatsapp_automation_jobs x on x.notification_id = n.id
    where x.id = j and n.kind = 'waitlist_table_ready' and n.waitlist_id = x.waitlist_id and n.provider_message_id = 'task66-ready-'||j),
    'T6 notifications_sent waitlist_table_ready row correlated');
  perform pg_temp.ok66((select state = 'reconciled' and not reconcile_required from public.whatsapp_automation_jobs where id = j), 'T6 job reconciled');
  -- Cancellation with a customer: history recorded in the conversation.
  select flow into f from flows66 where k = 't3_cancel_future'; j := (f->>'job')::uuid;
  perform pg_temp.ok66(public.finish_whatsapp_automation(j, (f->>'fence')::uuid, jsonb_build_object('outcome','accepted','reason','provider_accepted','provider_message_id','task66-cancel-'||j)),
    'T6 cancellation accepted through real finisher');
  res := public.reconcile_whatsapp_automation_acceptance(j);
  perform pg_temp.ok66(res = '{"state":"reconciled","history":"recorded"}', 'T6 cancellation reconciles with history: ' || res::text);
  perform pg_temp.ok66(exists (select from public.conversations cv cross join lateral jsonb_array_elements(cv.messages) m
    where cv.unit_id = u and cv.customer_id = c and m->>'event_id' = 'automation:'||j||':accepted' and m->>'kind' = 'cancellation'),
    'T6 cancellation history appended once with kind');
end $$;

-- ─── T7: motivo reservation_not_cancelled ──────────────────────────────────
do $$
declare
  u uuid := pg_temp.id66('u'); c uuid := pg_temp.id66('c'); ch uuid := pg_temp.id66('ch'); v_admin uuid := pg_temp.id66('admin');
  stamp timestamptz := clock_timestamp(); tomorrow date := (stamp at time zone 'America/Sao_Paulo')::date + 1;
  r uuid; j uuid; j2 uuid; x jsonb; f uuid; got text; st jsonb; g bigint;
begin
  r := gen_random_uuid(); insert into public.reservations(id, unit_id, customer_id, date, time, status) values (r, u, c, tomorrow, '21:00', 'confirmed');
  j := public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u,'kind','cancellation','reservation_id',r,'source_event_key','t7-a','fact_at',stamp,'expires_at',stamp+interval '24 hours'));
  x := public.claim_whatsapp_automation(j); f := (x->>'claim_token')::uuid;
  got := pg_temp.err66(format('select public.block_whatsapp_automation_preflight(%L,%L,%L)', j, f, 'reservation_not_canceled'));
  perform pg_temp.ok66(got like '22023:%', 'T7 misspelled reason still refused (' || got || ')');
  perform pg_temp.ok66(public.block_whatsapp_automation_preflight(j, f, 'reservation_not_cancelled'), 'T7 preflight accepts reservation_not_cancelled');
  perform pg_temp.ok66((select state = 'blocked' and error_code = 'reservation_not_cancelled' and claim_token is null from public.whatsapp_automation_jobs where id = j),
    'T7 job blocked with reservation_not_cancelled');
  -- Comparator: same lifecycle, correctable reason.
  r := gen_random_uuid(); insert into public.reservations(id, unit_id, customer_id, date, time, status) values (r, u, c, tomorrow, '21:30', 'cancelled');
  j2 := public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u,'kind','cancellation','reservation_id',r,'source_event_key','t7-b','fact_at',stamp,'expires_at',stamp+interval '24 hours'));
  x := public.claim_whatsapp_automation(j2);
  perform pg_temp.ok66(public.block_whatsapp_automation_preflight(j2, (x->>'claim_token')::uuid, 'reservation_past'), 'T7 comparator blocked with reservation_past');
  perform pg_temp.actor66(v_admin);
  st := public.get_whatsapp_automation_delivery_state(u, 100, 0);
  perform pg_temp.ok66(exists (select from jsonb_array_elements(st->'rows') e where e->>'job_id' = j::text and e->>'reason' = 'reservation_not_cancelled' and e->>'kind' = 'cancellation'),
    'T7 delivery state shows reservation_not_cancelled (not unknown_reason)');
  perform pg_temp.ok66(not exists (select from jsonb_array_elements(st->'rows') e where e->>'reason' = 'unknown_reason'), 'T7 delivery state has no unknown_reason');
  select binding_generation into g from public.whatsapp_automation_jobs where id = j;
  perform pg_temp.ok66(not public.revalidate_whatsapp_automation_job(j, ch, g), 'T7 reservation_not_cancelled is not correctable by pin revalidation');
  perform pg_temp.ok66(public.revalidate_whatsapp_automation_job(j2, ch, g), 'T7 comparator reservation_past is correctable (same path)');
  perform pg_temp.service66();
end $$;

-- ─── T5: catálogo de 9 ids nas RPCs de provisionamento ─────────────────────
do $$
declare
  ch2 uuid := pg_temp.id66('ch2'); a2 uuid := pg_temp.id66('a2'); b2 uuid := pg_temp.id66('b2'); v_admin uuid := pg_temp.id66('admin');
  lid text; job uuid; d jsonb; fence uuid; evidence uuid;
begin
  insert into public.platform_flags(key, value) values ('whatsapp_template_catalog', 'true') on conflict (key) do update set value = excluded.value;
  update public.whatsapp_template_accounts set sync_capture_id = gen_random_uuid(), last_sync_published_at = clock_timestamp(),
    sync_binding_id = b2, sync_binding_generation = 1, sync_credential_revision = 0 where id = a2;
  update public.whatsapp_remote_templates set sync_required = false, last_synced_at = clock_timestamp() where account_id = a2;
  foreach lid in array array['fila_mesa_pronta_v1','res_cancelada_v1'] loop
    update public.whatsapp_remote_templates set sync_required = false, last_synced_at = clock_timestamp() where account_id = a2;
    job := public.enqueue_whatsapp_template_job(b2, 'provision', lid, 1);
    d := public.claim_whatsapp_template_job(job); fence := (d->>'claim_token')::uuid;
    perform pg_temp.ok66(fence is not null, 'T5 ' || lid || ' catalog job claimed');
    perform pg_temp.ok66(public.prepare_whatsapp_template_provision(job, fence, 1), 'T5 ' || lid || ' prepare passes the id list');
    perform pg_temp.ok66(public.confirm_whatsapp_template_post(job, fence, 1), 'T5 ' || lid || ' confirm_whatsapp_template_post passes the id list');
    perform pg_temp.ok66(public.finish_whatsapp_template_job(job, fence, '{"outcome":"local_preflight_refused","reason":"final_channel_changed"}'), 'T5 ' || lid || ' real local refusal');
    select id into evidence from app_private.whatsapp_template_zero_post_evidence where job_id = job;
    perform pg_temp.ok66(evidence is not null, 'T5 ' || lid || ' durable zero-POST evidence');
    update public.whatsapp_template_jobs set error_code = null where id = job;
    perform pg_temp.actor66(v_admin);
    perform pg_temp.ok66(public.revalidate_whatsapp_template_job(job, ch2, 1), 'T5 ' || lid || ' revalidate passes the id list');
    perform pg_temp.service66();
    update public.whatsapp_remote_templates set sync_required = false, last_synced_at = clock_timestamp() where account_id = a2;
    d := public.claim_whatsapp_template_job(job); fence := (d->>'claim_token')::uuid;
    perform pg_temp.ok66(public.prepare_whatsapp_template_provision(job, fence, 1), 'T5 ' || lid || ' corrected prepare');
    perform pg_temp.ok66((select state = 'posting' and attempts = 1 from public.whatsapp_template_jobs where id = job), 'T5 ' || lid || ' job posting');
    -- One in-flight catalog job per account: close this one before the next id.
    perform pg_temp.ok66(public.finish_whatsapp_template_job(job, fence, '{"outcome":"uncertain","reason":"post_ambiguous"}'), 'T5 ' || lid || ' closed as uncertain');
  end loop;
end $$;

-- ─── T8: forma e ACL contra o snapshot do 66a ──────────────────────────────
do $$
declare s record; now_v text; f oid := 'public.guard_whatsapp_template_scope()'::regprocedure; nm text;
begin
  for s in select k, v from public.t_snap066 where k like 'fn_antes:%' loop
    select format('oid=%s secdef=%s config=%s volatile=%s owner=%s acl=%s', p.oid, p.prosecdef, coalesce(p.proconfig::text, 'null'), p.provolatile,
                  p.proowner::regrole, coalesce(p.proacl::text, 'null'))
      into now_v from pg_proc p where p.oid = substr(s.k, 10)::regprocedure;
    perform pg_temp.ok66(now_v = s.v, 'T8 unchanged identity/ACL ' || substr(s.k, 10) || ' [' || coalesce(now_v, 'missing') || ' vs ' || s.v || ']');
  end loop;
  perform pg_temp.ok66(not has_function_privilege('anon', f, 'EXECUTE') and not has_function_privilege('authenticated', f, 'EXECUTE')
    and not has_function_privilege('service_role', f, 'EXECUTE')
    and not exists (select from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = f and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
    'T8 trigger function closed to PUBLIC/anon/authenticated/service_role');
  perform pg_temp.ok66((select count(*) = 1 from pg_constraint where conrelid = 'public.whatsapp_remote_templates'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%res_confirmacao_v1%'),
    'T8 exactly one logical_id CHECK');
  perform pg_temp.ok66((select count(*) = 1 from pg_constraint where conrelid = 'public.whatsapp_automation_jobs'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%voucher_issued%' and pg_get_constraintdef(oid) not like '%voucher_id%'),
    'T8 exactly one kind CHECK');
  perform pg_temp.ok66((select count(*) = 1 from pg_constraint where conrelid = 'public.whatsapp_automation_jobs'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%voucher_id IS NOT NULL%'),
    'T8 exactly one kind<->resource CHECK');
  perform pg_temp.ok66((select count(*) = 1 from pg_constraint where conrelid = 'public.whatsapp_automation_jobs'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%initial_catalog_key%'),
    'T8 exactly one pin tuple CHECK');
  perform pg_temp.ok66((select count(*) = 10 from public.t_snap066 where k like 'overloads:%'), 'T8 overload snapshot covers the 10 names');
  for s in select k, v from public.t_snap066 where k like 'overloads:%' loop
    nm := substr(s.k, 11);
    perform pg_temp.ok66((select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname || '.' || p.proname = nm) = s.v,
      'T8 overload count unchanged ' || nm || ' = ' || s.v);
  end loop;
end $$;

-- ─── T9: regressão mínima dos kinds antigos ────────────────────────────────
do $$
declare
  u uuid := pg_temp.id66('u'); c uuid := pg_temp.id66('c'); stamp timestamptz := clock_timestamp();
  tomorrow date := (stamp at time zone 'America/Sao_Paulo')::date + 1; r uuid; w uuid; f jsonb; e jsonb; got jsonb; rev bigint;
begin
  r := gen_random_uuid();
  insert into public.reservations(id, unit_id, customer_id, date, time, status, payment_status, source, party_size, reservation_code)
    values (r, u, c, tomorrow, '19:00', 'confirmed', null, 'web', 3, 'T66-T9-' || r);
  f := pg_temp.flow66(u, 'confirmation', r, stamp, stamp + interval '24 hours', null, 'T9 confirmation');
  e := pg_temp.expected66((f->>'job')::uuid);
  perform pg_temp.ok66((select initial_catalog_key = 'res_confirmacao_v1' from public.whatsapp_automation_jobs where id = (f->>'job')::uuid), 'T9 confirmation key unchanged');
  got := pg_temp.confirm66(f, e);
  perform pg_temp.ok66(got = '{"allowed":true}', 'T9 confirmation confirmed passes: ' || got::text);
  got := pg_temp.confirm66(f, jsonb_set(e, '{resource,status}', '"cancelled"'));
  perform pg_temp.ok66(got = '{"allowed":false,"reason":"snapshot_invalid"}', 'T9 confirmation over cancelled snapshot refuses: ' || got::text);
  got := pg_temp.confirm66(f, jsonb_set(e, '{resource,payment_status}', '"pending_payment"'));
  perform pg_temp.ok66(got = '{"allowed":false,"reason":"snapshot_invalid"}', 'T9 confirmation keeps its payment check: ' || got::text);
  w := gen_random_uuid();
  insert into public.waitlist(id, unit_id, customer_id, customer_name, customer_phone, party_size, code, status, created_at)
    values (w, u, c, 'Synthetic66', '11999996601', 2, 691, 'waiting', stamp - interval '5 minutes');
  f := pg_temp.flow66(u, 'waitlist_entered', w, stamp, stamp + interval '2 hours', null, 'T9 waitlist_entered');
  e := pg_temp.expected66((f->>'job')::uuid);
  perform pg_temp.ok66((select initial_catalog_key = 'fila_entrada_v1' from public.whatsapp_automation_jobs where id = (f->>'job')::uuid), 'T9 waitlist_entered key unchanged');
  got := pg_temp.confirm66(f, e);
  perform pg_temp.ok66(got = '{"allowed":true}', 'T9 waitlist_entered waiting passes: ' || got::text);
  got := pg_temp.confirm66(f, jsonb_set(e, '{resource,status}', '"notified"'));
  perform pg_temp.ok66(got = '{"allowed":false,"reason":"snapshot_invalid"}', 'T9 waitlist_entered still refuses notified: ' || got::text);
  w := gen_random_uuid();
  insert into public.waitlist(id, unit_id, customer_id, customer_name, customer_phone, party_size, code, status, created_at, seated_at)
    values (w, u, c, 'Synthetic66', '11999996601', 2, 692, 'seated', stamp - interval '1 hour', stamp - interval '1 minute');
  insert into public.whatsapp_message_consent_events(unit_id, customer_id, purpose, decision, source_code, evidence_reference, observed_at)
    values (u, c, 'promotional', 'opt_in', 'fixture', 'task66-feedback', stamp) returning revision into rev;
  f := pg_temp.flow66(u, 'waitlist_feedback', w, stamp, stamp + interval '24 hours', rev, 'T9 waitlist_feedback');
  e := pg_temp.expected66((f->>'job')::uuid);
  perform pg_temp.ok66((select initial_catalog_key = 'fila_feedback_v1' from public.whatsapp_automation_jobs where id = (f->>'job')::uuid), 'T9 waitlist_feedback key unchanged');
  perform pg_temp.ok66(exists (select from public.whatsapp_promotion_slots where unit_id = u and customer_id = c and job_id = (f->>'job')::uuid and state = 'reserved'),
    'T9 promotional prepare still reserves the slot');
  got := pg_temp.confirm66(f, e, rev);
  perform pg_temp.ok66(got = '{"allowed":true}', 'T9 promotional waitlist_feedback passes: ' || got::text);
  got := pg_temp.confirm66(f, e, null);
  perform pg_temp.ok66(got = '{"allowed":false,"reason":"authority_changed"}', 'T9 promotional without consent revision refuses: ' || got::text);
end $$;

select split_part(label, ' ', 1) as caso, count(*) as checagens from checks66 group by 1 order by 1;
select count(*) as checks66 from checks66;
select 'GREEN66 T1..T9 + CTRL-a..c; rollback removes every fixture' as evidence;
rollback;
