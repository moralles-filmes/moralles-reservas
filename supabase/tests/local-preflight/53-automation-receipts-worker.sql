\set ON_ERROR_STOP on
-- ROOT runs after migration via db push and exact cron quarantine. All fixtures rollback.
begin;
set local lock_timeout='5s'; set local statement_timeout='60s';
create temp table checks53(label text) on commit drop;
create temp table owned53(unit_id uuid) on commit drop;
create function pg_temp.ok53(v boolean,label text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'FAIL53 %',label; end if; insert into checks53 values(label); end $$;
create function pg_temp.error53(statement text,code text,label text) returns void language plpgsql as $$
declare actual text; before_jobs bigint; before_receipts bigint;
begin
 select count(*) into before_jobs from public.whatsapp_automation_jobs; select count(*) into before_receipts from public.whatsapp_automation_receipt_events;
 begin execute statement; exception when others then get stacked diagnostics actual=returned_sqlstate; end;
 perform pg_temp.ok53(actual=code,label||' exact SQLSTATE');
 perform pg_temp.ok53((select count(*)=before_jobs from public.whatsapp_automation_jobs) and (select count(*)=before_receipts from public.whatsapp_automation_receipt_events),label||' no partial insert/delete');
end $$;
create function pg_temp.job53(u uuid,c uuid,ch uuid,b uuid,s text default 'queued',old boolean default false) returns uuid language plpgsql as $$
declare r uuid:=gen_random_uuid(); j uuid:=gen_random_uuid(); stamp timestamptz:=clock_timestamp(); o uuid;
begin
 select organization_id into o from public.units where id=u;
 insert into public.reservations(id,unit_id,customer_id) values(r,u,c);
 insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,expires_at,
   channel_id,provider,binding_id,binding_generation,transport,state,due_at,created_at,claim_token,claimed_until)
 values(j,u,o,'confirmation',r,c,'task53:'||r,case when old then stamp-interval '100 days' else stamp end,
   case when old then stamp-interval '99 days' else stamp+interval '1 hour' end,ch,'zapi',b,1,'text',s,stamp-interval '1 minute',case when old then stamp-interval '100 days' else stamp end,
   case when s in('claimed','posting','uncertain') then gen_random_uuid() else null end,case when s in('claimed','posting','uncertain') then stamp+interval '90 seconds' else null end);
 return j;
end $$;
do $$ declare sig text; f oid; begin
 perform pg_temp.ok53(not exists(select from cron.job where jobname in('whatsapp-automation-worker','whatsapp-template-workers')),'persisted cron quarantine');
 foreach sig in array array['record_whatsapp_automation_receipts(uuid,uuid,text,bigint,text,jsonb)','reconcile_whatsapp_automation_receipts(uuid,integer)',
   'maintain_and_select_whatsapp_automation_work(integer)','purge_whatsapp_automation_workers(integer,integer)'] loop
   f:=('public.'||sig)::regprocedure;
   perform pg_temp.ok53(not has_function_privilege('anon',f,'EXECUTE') and not has_function_privilege('authenticated',f,'EXECUTE') and has_function_privilege('service_role',f,'EXECUTE'),sig||' roles');
   perform pg_temp.ok53((select prosecdef and provolatile='v' and pronargdefaults=0 and proconfig=array['search_path=""'] from pg_proc where oid=f),sig||' function contract');
   perform pg_temp.ok53(not exists(select from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=f and a.grantee=0 and a.privilege_type='EXECUTE'),sig||' PUBLIC denied');
 end loop;
 perform pg_temp.ok53(not has_table_privilege('service_role','public.whatsapp_automation_receipt_events','INSERT') and not has_table_privilege('service_role','public.whatsapp_automation_receipt_events','DELETE')
   and not has_table_privilege('service_role','public.whatsapp_automation_jobs','DELETE'),'direct receipt insert and technical deletes revoked');
 perform pg_temp.ok53(has_table_privilege('service_role','public.whatsapp_automation_jobs','SELECT') and has_table_privilege('service_role','public.whatsapp_automation_jobs','UPDATE')
   and has_table_privilege('service_role','public.whatsapp_automation_receipt_events','SELECT') and has_table_privilege('service_role','public.whatsapp_automation_receipt_events','UPDATE'),'required service reads/updates retained');
 perform pg_temp.ok53(not has_function_privilege('service_role','public.trigger_whatsapp_automation_worker()','EXECUTE'),'cron has no caller execute');
 perform pg_temp.error53('select public.maintain_and_select_whatsapp_automation_work(null)','22023','NULL allocator refused');
 perform pg_temp.error53('select public.maintain_and_select_whatsapp_automation_work(19)','22023','partial allocator refused');
end $$;
do $$ declare
 o uuid:=gen_random_uuid(); u uuid:=gen_random_uuid(); u2 uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); ch uuid:=gen_random_uuid(); ch2 uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); actor uuid:=gen_random_uuid();
 j uuid; j2 uuid; jid uuid; token uuid; n uuid; rev bigint; result jsonb; batch jsonb; before_row jsonb; stamp timestamptz; finished timestamptz; i integer; nr integer; np integer; nn integer;
begin
 insert into auth.users(id) values(actor); insert into public.platform_admins values(actor);
 insert into public.organizations(id,name) values(o,'Task53');
 insert into public.units(id,organization_id,name) values(u,o,'Task53'),(u2,o,'Task53 other');
 insert into owned53 values(u),(u2);
 insert into public.customers(id,organization_id,name,phone) values(c,o,'Synthetic','11999995353');
 insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values(ch,u,'zapi','connected',true,clock_timestamp()),(ch2,u2,'zapi','disconnected',false,clock_timestamp());
 insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider,generation) values(b,u,ch,'zapi',1);
 select template_credential_revision into rev from public.whatsapp_channels where id=ch;
 batch:='[{"provider_message_id":"early","status":"read","provider_timestamp":null}]';
 perform pg_temp.ok53(public.record_whatsapp_automation_receipts(ch,u,'zapi',rev,null,batch)->>'state'='not_adopted','never adopted no receipt');
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
 insert into public.whatsapp_automation_adoptions(unit_id) values(u),(u2);
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 result:=public.record_whatsapp_automation_receipts(ch,u,'zapi',rev,null,batch);
 perform pg_temp.ok53(result='{"state":"recorded","inserted":1}'::jsonb,'early receipt admitted');
 perform pg_temp.ok53(public.record_whatsapp_automation_receipts(ch,u,'zapi',rev,null,batch)='{"state":"recorded","inserted":0}'::jsonb,'stable duplicate admission');
 perform pg_temp.ok53((select provider_timestamp is null and processing_state='pending' from public.whatsapp_automation_receipt_events where unit_id=u and provider_message_id='early'),'native absent stays null and early stays pending');
 perform public.record_whatsapp_automation_receipts(ch2,u2,'zapi',0,null,batch);
 perform pg_temp.ok53(public.record_whatsapp_automation_receipts(ch,u2,'zapi',rev,null,batch)->>'state'='authority_changed','foreign unit assertion refused');
 perform pg_temp.ok53(public.record_whatsapp_automation_receipts(ch,u,'waha',rev,null,batch)->>'state'='authority_changed','foreign provider refused');
 perform pg_temp.ok53(public.record_whatsapp_automation_receipts(ch,u,'zapi',rev+1,null,batch)->>'state'='authority_changed','revision assertion refused');
 perform pg_temp.ok53(public.record_whatsapp_automation_receipts(ch,u,'zapi',rev,'foreign',batch)->>'state'='authority_changed','external anchor assertion refused');
 select jsonb_agg(batch->0) into result from generate_series(1,501);
 perform pg_temp.error53(format('select public.record_whatsapp_automation_receipts(%L,%L,%L,%s,null,%L)',ch,u,'zapi',rev,result),'22023','501 validated before dedupe');
 perform pg_temp.error53(format('select public.record_whatsapp_automation_receipts(%L,%L,%L,%s,null,%L)',ch,u,'zapi',rev,'[{"provider_message_id":"ok","status":"read","provider_timestamp":null},{"provider_message_id":"","status":"read","provider_timestamp":null}]'),'22023','whole invalid batch no partial receipt');
 select jsonb_agg(batch->0) into result from generate_series(1,500);
 perform pg_temp.ok53(public.record_whatsapp_automation_receipts(ch,u,'zapi',rev,null,result)->>'inserted'='0','500 duplicate events permitted');
 -- Actual acceptance writer and original local receipt observation.
 j:=pg_temp.job53(u,c,ch,b); token:=gen_random_uuid();
 update public.whatsapp_automation_jobs set state='posting',claim_token=token,claimed_until=clock_timestamp()+interval '90 seconds',posting_started_at=clock_timestamp(),attempts=1,safe_log_body='Synthetic accepted' where id=j;
 perform pg_temp.ok53(public.finish_whatsapp_automation(j,token,'{"outcome":"accepted","reason":"provider_accepted","provider_message_id":"early"}'),'finish records true accepted evidence');
 select notification_id,finished_at into n,finished from public.whatsapp_automation_jobs where id=j;
 select received_at into stamp from public.whatsapp_automation_receipt_events where unit_id=u and provider_message_id='early';
 perform pg_temp.ok53(public.reconcile_whatsapp_automation_receipts(j,20)='{"state":"reconciled","processed":1}'::jsonb,'early receipt consumed only after acceptance');
 perform pg_temp.ok53((select processing_state='pending' from public.whatsapp_automation_receipt_events where unit_id=u2 and provider_message_id='early'),'same native ID in other unit stays pending');
 perform pg_temp.ok53((select read_at=stamp and delivered_at=stamp from public.notifications_sent where id=n),'read implies delivery with original local observation');
 perform pg_temp.ok53((select state='reconciled' and attempts=1 and finished_at=finished from public.whatsapp_automation_jobs where id=j),'receipt does not reopen acceptance');
 perform public.record_whatsapp_automation_receipts(ch,u,'zapi',rev,null,'[{"provider_message_id":"early","status":"failed","provider_timestamp":null}]');
 perform pg_temp.ok53(public.reconcile_whatsapp_automation_receipts(j,20)->>'processed'='1','later receipt for locally reconciled');
 perform pg_temp.ok53((select status='failed' and read_at=stamp and delivered_at=stamp and failed_at is not null from public.notifications_sent where id=n),'failure preserves earlier delivery evidence');
 perform pg_temp.ok53((select state='reconciled' and provider_message_id='early' from public.whatsapp_automation_jobs where id=j),'delivery failure is still accepted ledger');
 select to_jsonb(x) into before_row from public.whatsapp_automation_jobs x where id=j;
 perform public.reconcile_whatsapp_automation_receipts(j,20);
 perform pg_temp.ok53((select (to_jsonb(x)-'next_receipt_repair_at')=(before_row-'next_receipt_repair_at') from public.whatsapp_automation_jobs x where id=j),'repeat only advances technical pacing');
 -- Expiry is independent, original TTL, preserves posted and live lease.
 j2:=pg_temp.job53(u,c,ch,b,'blocked',true);
 result:=public.maintain_and_select_whatsapp_automation_work(0);
 perform pg_temp.ok53(result->>'expired_count'='1' and result->'normal'='[]'::jsonb and result->'repairs'='[]'::jsonb and result->'rechecks'='[]'::jsonb,'maintenance zero bounded expiry only');
 perform pg_temp.ok53((select state='expired' and finished_at is not null from public.whatsapp_automation_jobs where id=j2),'new expiry records true finish');
 update public.whatsapp_automation_jobs set finished_at=clock_timestamp()-interval '91 days' where id=j2;
 result:=public.purge_whatsapp_automation_workers(0,20);
 perform pg_temp.ok53(result->>'jobs_deleted'='1' and not exists(select from public.whatsapp_automation_jobs where id=j2),'old expired job really purged');
 j2:=pg_temp.job53(u,c,ch,b,'expired',true);
 perform public.purge_whatsapp_automation_workers(0,20);
 perform pg_temp.ok53(exists(select from public.whatsapp_automation_jobs where id=j2 and finished_at is null),'historical null finish retained');
 -- Shared auxiliary seats and at least15 normal candidates, actual SQL-minute parity.
 for i in 1..20 loop perform pg_temp.job53(u,c,ch,b); end loop;
 for i in 1..6 loop perform pg_temp.job53(u,c,ch,b,'blocked'); end loop;
 for i in 1..6 loop
   jid:=pg_temp.job53(u,c,ch,b); token:=gen_random_uuid();
   update public.whatsapp_automation_jobs set state='posting',claim_token=token,claimed_until=clock_timestamp()+interval '90 seconds',posting_started_at=clock_timestamp(),attempts=1,safe_log_body='Synthetic repair' where id=jid;
   perform public.finish_whatsapp_automation(jid,token,jsonb_build_object('outcome','accepted','reason','provider_accepted','provider_message_id','repair:'||jid));
 end loop;
 result:=public.maintain_and_select_whatsapp_automation_work(20); nr:=jsonb_array_length(result->'rechecks'); np:=jsonb_array_length(result->'repairs'); nn:=jsonb_array_length(result->'normal');
 perform pg_temp.ok53(nr+np=5 and nn=15 and nr in(2,3) and np in(2,3),'allocator20 auxiliary5 normal15');
 perform pg_temp.ok53(case when (result->>'sql_minute')::bigint%2=0 then nr=3 and np=2 else nr=2 and np=3 end,'actual minute2/3 fairness');
 perform pg_temp.ok53((select count(distinct x->>'job_id')=20 from jsonb_array_elements((result->'normal')||(result->'rechecks')||(result->'repairs')) x),'all20 unique');
 perform pg_temp.ok53((select bool_and(next_eligibility_check_at>clock_timestamp()+interval '4 minutes') from public.whatsapp_automation_jobs where id in(select (x->>'job_id')::uuid from jsonb_array_elements(result->'rechecks') x)),'returned rechecks paced5min');
 perform pg_temp.ok53((select bool_and(next_receipt_repair_at>clock_timestamp()) from public.whatsapp_automation_jobs where id in(select (x->>'job_id')::uuid from jsonb_array_elements(result->'repairs') x)),'returned repairs paced1min');
 -- Authorized projection includes all retained outstanding, without configuration/time window.
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
 result:=public.get_whatsapp_automation_delivery_state(u,1,0);
 perform pg_temp.ok53(jsonb_array_length(result->'rows')=1 and (result->>'has_more')::boolean and (result->'counts'->>'total')::integer>20,'page independent global counts');
 perform pg_temp.ok53(result->>'oldest_nonterminal_at' is not null and not (result->'rows'->0 ? 'provider_message_id'),'oldest outstanding and privacy projection');
 perform pg_temp.error53(format('select public.get_whatsapp_automation_delivery_state(%L,1,0)',gen_random_uuid()),'42501','missing unit uniformly refused');
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 perform pg_temp.error53(format('select public.get_whatsapp_automation_delivery_state(%L,1,0)',u),'42501','service identity no read substitute');
 -- Original posting expiry resolves through one real claim, never reopens.
 jid:=pg_temp.job53(u,c,ch,b); token:=gen_random_uuid();
 update public.whatsapp_automation_jobs set state='posting',claim_token=token,claimed_until=clock_timestamp()-interval '1 second',posting_started_at=clock_timestamp()-interval '2 minutes',attempts=1 where id=jid;
 perform pg_temp.ok53(public.claim_whatsapp_automation(jid) is null,'expired posting claim returns no work');
 perform pg_temp.ok53((select state='uncertain' and attempts=1 and posting_started_at is not null from public.whatsapp_automation_jobs where id=jid),'expired posting kept uncertain evidence');
end $$;
-- Isolate subsequent selector vectors from our earlier due fixtures, preserving
-- facts/pins. No table-wide mutation or state reset of unrelated rows.
update public.whatsapp_automation_jobs set due_at='infinity',next_eligibility_check_at='infinity',next_receipt_repair_at='infinity'
 where unit_id in(select unit_id from owned53);
do $$ declare
 o uuid:=gen_random_uuid();u uuid:=gen_random_uuid();u_unconfigured uuid:=gen_random_uuid();c uuid:=gen_random_uuid();ch uuid:=gen_random_uuid();b uuid:=gen_random_uuid();a uuid:=gen_random_uuid();
 ch_alt uuid:=gen_random_uuid();ch_provider uuid:=gen_random_uuid();r uuid;j uuid;f uuid;n uuid;result jsonb;before_row jsonb;rev bigint;i integer;s text;ids uuid[];native text;
begin
 insert into auth.users(id) values(a);insert into public.platform_admins values(a);
 insert into public.organizations(id,name) values(o,'Task53 vectors');insert into public.units(id,organization_id,name) values(u,o,'Task53 vectors'),(u_unconfigured,o,'Task53 unconfigured');insert into owned53 values(u),(u_unconfigured);
 insert into public.customers(id,organization_id,name,phone) values(c,o,'Synthetic','11999995354');
 insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values(ch,u,'zapi','connected',true,clock_timestamp()),(ch_alt,u,'zapi','disconnected',false,clock_timestamp()),(ch_provider,u,'waha','disconnected',false,clock_timestamp());
 insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider,generation) values(b,u,ch,'zapi',1);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',a)::text,true);insert into public.whatsapp_automation_adoptions(unit_id) values(u),(u_unconfigured);
 select template_credential_revision into rev from public.whatsapp_channels where id=ch;
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 result:=public.maintain_and_select_whatsapp_automation_work(20);
 perform pg_temp.ok53(result->'rechecks'='[]'::jsonb and result->'repairs'='[]'::jsonb and result->'normal'='[]'::jsonb,'zero demand allocates zero');
 -- Single-group capacity1..5; extra group rows cannot exceed auxiliary5.
 for i in 1..6 loop perform pg_temp.job53(u,c,ch,b,'blocked');end loop;
 result:=public.maintain_and_select_whatsapp_automation_work(20);
 perform pg_temp.ok53(jsonb_array_length(result->'rechecks')=5 and result->'repairs'='[]'::jsonb and result->'allocation'->>'normal_limit'='15','only R saturated gets exactly5');
 result:=public.maintain_and_select_whatsapp_automation_work(20);
 perform pg_temp.ok53(jsonb_array_length(result->'rechecks')=1 and result->'allocation'->>'normal_limit'='19','only R remaining1; paced five not rediscovered');
 result:=public.maintain_and_select_whatsapp_automation_work(20);
 perform pg_temp.ok53(result->'rechecks'='[]'::jsonb,'all six R paced');
 -- Same native ID on other channel/provider is not consumed by this job.
 j:=pg_temp.job53(u,c,ch,b);f:=gen_random_uuid();
 update public.whatsapp_automation_jobs set state='posting',claim_token=f,claimed_until=clock_timestamp()+interval '90 seconds',posting_started_at=clock_timestamp(),attempts=1,safe_log_body='Synthetic exact correlation' where id=j;
 perform public.finish_whatsapp_automation(j,f,'{"outcome":"accepted","reason":"provider_accepted","provider_message_id":"collision53"}');
 perform public.record_whatsapp_automation_receipts(ch_alt,u,'zapi',0,null,'[{"provider_message_id":"collision53","status":"read","provider_timestamp":null}]');
 perform public.record_whatsapp_automation_receipts(ch_provider,u,'waha',0,null,'[{"provider_message_id":"collision53","status":"read","provider_timestamp":null}]');
 perform public.record_whatsapp_automation_receipts(ch,u,'zapi',rev,null,'[{"provider_message_id":"collision53","status":"delivered","provider_timestamp":"2026-01-01T00:00:00Z"}]');
 result:=public.record_whatsapp_automation_receipts(ch,u,'zapi',rev,null,'[{"provider_message_id":"collision53","status":"delivered","provider_timestamp":"2025-12-31T21:00:00-03:00"}]');
 perform pg_temp.ok53(result->>'inserted'='0','native UTC equivalent digest dedupes');
 perform pg_temp.ok53(public.reconcile_whatsapp_automation_receipts(j,20)->>'processed'='1','only exact four-field event consumed');
 perform pg_temp.ok53((select count(*)=2 from public.whatsapp_automation_receipt_events where unit_id=u and processing_state='pending' and provider_message_id='collision53'),'other channel and provider remain pending');
 perform pg_temp.ok53((select delivered_at='2026-01-01T00:00:00Z'::timestamptz and read_at is null from public.notifications_sent where id=(select notification_id from public.whatsapp_automation_jobs where id=j)),'native time preserved without foreign read');
 -- Original legacy conflict yields deferred acceptance and retained receipt.
 j:=pg_temp.job53(u,c,ch,b);f:=gen_random_uuid();select reservation_id into r from public.whatsapp_automation_jobs where id=j;n:=gen_random_uuid();
 insert into public.notifications_sent(id,unit_id,reservation_id,kind,status,sent_at) values(n,u,r,'confirmation','sent',clock_timestamp());
 update public.whatsapp_automation_jobs set state='posting',claim_token=f,claimed_until=clock_timestamp()+interval '90 seconds',posting_started_at=clock_timestamp(),attempts=1,safe_log_body='Synthetic conflict' where id=j;
 perform public.finish_whatsapp_automation(j,f,'{"outcome":"accepted","reason":"provider_accepted","provider_message_id":"conflict53"}');
 perform public.record_whatsapp_automation_receipts(ch,u,'zapi',rev,null,'[{"provider_message_id":"conflict53","status":"read","provider_timestamp":null}]');
 select to_jsonb(x) into before_row from public.notifications_sent x where id=n;
 perform pg_temp.ok53(public.reconcile_whatsapp_automation_receipts(j,20)='{"state":"deferred","processed":0}'::jsonb,'legacy conflict deferred');
 perform pg_temp.ok53((select to_jsonb(x)=before_row from public.notifications_sent x where id=n) and (select processing_state='pending' from public.whatsapp_automation_receipt_events where unit_id=u and provider_message_id='conflict53'),'conflict does not steal notification or receipt');
 perform pg_temp.ok53((select next_receipt_repair_at>clock_timestamp()+interval '4 minutes' and state='accepted' and reconcile_required from public.whatsapp_automation_jobs where id=j),'deferred paced5min with durable acceptance');
 for i in 1..6 loop
  j:=pg_temp.job53(u,c,ch,b);f:=gen_random_uuid();
  update public.whatsapp_automation_jobs set state='posting',claim_token=f,claimed_until=clock_timestamp()+interval '90 seconds',posting_started_at=clock_timestamp(),attempts=1,safe_log_body='Synthetic only repair' where id=j;
  perform public.finish_whatsapp_automation(j,f,jsonb_build_object('outcome','accepted','reason','provider_accepted','provider_message_id','onlyp53:'||j));
 end loop;
 result:=public.maintain_and_select_whatsapp_automation_work(20);
 perform pg_temp.ok53(jsonb_array_length(result->'repairs')=5 and result->'rechecks'='[]'::jsonb and result->'allocation'->>'normal_limit'='15','only P saturated gets exactly5');
 result:=public.maintain_and_select_whatsapp_automation_work(20);
 perform pg_temp.ok53(jsonb_array_length(result->'repairs')=1 and result->'allocation'->>'normal_limit'='19','only P remaining1; paced five not rediscovered');
 -- Per-repair receipt budget20, including repeated native-ID evidence.
 select provider_message_id into native from public.whatsapp_automation_jobs where id=j;
 select jsonb_agg(jsonb_build_object('provider_message_id',native,'status','read','provider_timestamp',timestamptz '2026-01-01T00:00:00Z'+make_interval(secs=>k))) into result from generate_series(1,21) k;
 perform public.record_whatsapp_automation_receipts(ch,u,'zapi',rev,null,result);
 perform pg_temp.ok53(public.reconcile_whatsapp_automation_receipts(j,2147483647)->>'processed'='20','repair maximum clamps to20');
 perform pg_temp.ok53(public.reconcile_whatsapp_automation_receipts(j,0)->>'processed'='0','repair zero consumes no receipt');
 perform pg_temp.ok53(public.reconcile_whatsapp_automation_receipts(j,null)->>'processed'='1','repair NULL default20 consumes remaining1');
 -- Unknown/uncertain is never fabricated accepted even when receipt exists.
 j:=pg_temp.job53(u,c,ch,b,'uncertain');select to_jsonb(x) into before_row from public.whatsapp_automation_jobs x where id=j;
 perform pg_temp.ok53(public.reconcile_whatsapp_automation_receipts(j,20)->>'state'='not_accepted','uncertain no acceptance inference');
 perform pg_temp.ok53((select to_jsonb(x)=before_row from public.whatsapp_automation_jobs x where id=j),'uncertain entirely unchanged');
 -- New initial-block expiry preserves an existing finish, while ordinary
 -- blocker leaves NULL unchanged. Neither consumes attempts or a posting mark.
 j:=pg_temp.job53(u,c,ch,b,'claimed',true);select claim_token into f from public.whatsapp_automation_jobs where id=j;
 update public.whatsapp_automation_jobs set finished_at='2026-01-01T00:00:00Z' where id=j;
 perform pg_temp.ok53(public.block_whatsapp_automation_preflight(j,f,'reservation_pending'),'original TTL overrides ordinary initial blocker');
 perform pg_temp.ok53((select state='expired' and finished_at='2026-01-01T00:00:00Z'::timestamptz and attempts=0 and posting_started_at is null from public.whatsapp_automation_jobs where id=j),'existing expiry finish preserved exactly');
 j:=pg_temp.job53(u,c,ch,b,'claimed');select claim_token into f from public.whatsapp_automation_jobs where id=j;
 perform pg_temp.ok53(public.block_whatsapp_automation_preflight(j,f,'reservation_pending'),'ordinary initial blocker positive');
 perform pg_temp.ok53((select state='blocked' and finished_at is null from public.whatsapp_automation_jobs where id=j),'ordinary blocker does not fabricate terminal time');
 -- Incomplete pin excluded from selection, included in original-TTL expiry.
 -- The real preconfiguration guard requires no selected channel for NULL pins.
 perform pg_temp.ok53(not exists(select from public.whatsapp_channels where unit_id=u_unconfigured)
   and not exists(select from public.whatsapp_template_bindings where unit_id=u_unconfigured)
   and exists(select from public.whatsapp_automation_adoptions where unit_id=u_unconfigured),'incomplete fixture adopted without channel or binding');
 r:=gen_random_uuid();j:=gen_random_uuid();insert into public.reservations(id,unit_id,customer_id) values(r,u_unconfigured,c);
 insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,expires_at,pin_phase,state,error_code,due_at,initial_catalog_key)
 values(j,u_unconfigured,o,'confirmation',r,c,'incomplete53:'||r,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour','preconfiguration','needs_review','channel_unconfigured',clock_timestamp()+interval '1 day','res_confirmacao_v1');
 select to_jsonb(x) into before_row from public.whatsapp_automation_jobs x where id=j;
 perform public.maintain_and_select_whatsapp_automation_work(0);
 perform pg_temp.ok53((select state='expired' and finished_at is not null and pin_phase='preconfiguration' and (to_jsonb(x)-array['state','error_code','finished_at'])=(before_row-array['state','error_code','finished_at']) from public.whatsapp_automation_jobs x where id=j),'incomplete expires without initializing pins/fact/attempts');
 -- All nonterminal states retain old finished timestamps; null/infinite finish
 -- remain retained even for otherwise terminal expired fixtures.
 ids:='{}';
 foreach s in array array['queued','claimed','posting','accepted','blocked','uncertain','retry_wait','needs_review','failed','paused'] loop
  j:=pg_temp.job53(u,c,ch,b,s,true);update public.whatsapp_automation_jobs set finished_at=clock_timestamp()-interval '91 days' where id=j;ids:=array_append(ids,j);
 end loop;
 foreach native in array array['infinity','-infinity'] loop
  j:=pg_temp.job53(u,c,ch,b,'expired',true);update public.whatsapp_automation_jobs set finished_at=native::timestamptz where id=j;ids:=array_append(ids,j);
 end loop;
 result:=public.purge_whatsapp_automation_workers(-1,2147483647);
 perform pg_temp.ok53(result->>'receipt_limit'='0' and result->>'job_limit'='20' and (select count(*)=cardinality(ids) from public.whatsapp_automation_jobs where id=any(ids)),'clamps and nonterminal/nonfinite retention');
 -- Original received clock, not native event date or repair time, controls90d.
 insert into public.whatsapp_automation_receipt_events(unit_id,provider,channel_id,provider_message_id,status,provider_timestamp,digest,received_at)
 values(u,'zapi',ch,'old-observed53','sent',clock_timestamp()+interval '1 year',repeat('c',64),clock_timestamp()-interval '91 days'),
 (u,'zapi',ch,'recent-observed53','sent',clock_timestamp()-interval '1 year',repeat('d',64),clock_timestamp()-interval '89 days'),
 (u,'zapi',ch,'future-observed53','sent',null,repeat('e',64),clock_timestamp()+interval '1 day'),
 (u,'zapi',ch,'nonfinite-observed53','sent',null,repeat('f',64),'-infinity');
 result:=public.purge_whatsapp_automation_workers(null,0);
 perform pg_temp.ok53(result->>'receipt_limit'='500' and result->>'receipts_deleted'='1' and not exists(select from public.whatsapp_automation_receipt_events where unit_id=u and provider_message_id='old-observed53'),'unmatched pending ages by received_at');
 perform pg_temp.ok53((select count(*)=3 from public.whatsapp_automation_receipt_events where unit_id=u and provider_message_id in('recent-observed53','future-observed53','nonfinite-observed53')),'recent/future/nonfinite observation retained');
 perform pg_temp.error53(format('select public.record_whatsapp_automation_receipts(%L,%L,%L,%s,null,%L)',ch,u,'zapi',rev,'[{"provider_message_id":"nonfinite-native","status":"read","provider_timestamp":"infinity"}]'),'22023','nonfinite native refused');
 -- Unknown stored diagnostic is closed before read projection; full counts
 -- include previous-day work and paging clamps cannot overflow int4.
 update public.whatsapp_automation_jobs set error_code='private_arbitrary_diagnostic' where id=ids[1];
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',a)::text,true);
 result:=public.get_whatsapp_automation_delivery_state(u,null,null);
 perform pg_temp.ok53(exists(select from jsonb_array_elements(result->'rows') x where x->>'reason'='unknown_reason') and result::text not like '%private_arbitrary%','reason allowlist redacts arbitrary text');
 perform pg_temp.ok53(jsonb_array_length(public.get_whatsapp_automation_delivery_state(u,0,-1)->'rows')=1,'authorized pagination negative clamps');
 perform pg_temp.ok53(public.get_whatsapp_automation_delivery_state(u,2147483647,2147483647)->'rows'='[]'::jsonb,'int4 maximum offset no overflow');
end $$;
-- Isolation guard must be first executable statement (zero effectful initializers).
do $$ declare body text; begin
 select prosrc into body from pg_proc where oid='public.purge_whatsapp_automation_workers(integer,integer)'::regprocedure;
 perform pg_temp.ok53(body ~ 'begin\s+if pg_catalog.current_setting\(''transaction_isolation''\)','purge first executable isolation guard');
end $$;
select count(*) as passed53 from checks53;
rollback;
