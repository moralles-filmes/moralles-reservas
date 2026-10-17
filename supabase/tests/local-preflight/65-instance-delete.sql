-- DEL-1..14 — RPC delete_whatsapp_instance_without_cost (migration 20261015223000).
-- Roda no banco da sequencia base do README (fase6c), DEPOIS da migration nova
-- aplicada duas vezes. Ids fixos; cada caso grava veredito em t_res.

create table if not exists t_res (ord int, caso text, veredito text);

-- Fixtures: org A do 02-seed. ENDED exige ended_at (087); custo atual exige
-- cost_source + cost_updated_at (087); ciclo PENDING_REVIEW/CLOSED exige
-- closed_at, e CLOSED exige custo (088).
-- A DEL-1 leva unit_id (Unidade A1 do seed, mesma org): o retrato dos ciclos no
-- audit_log herda o tenant da instancia e o caso confere organization_id e unit_id.
insert into whatsapp_instances (id, organization_id, unit_id, provider, lifecycle_state, cycle_source, ended_at)
values
  ('de000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'zapi', 'ENDED', 'ADMIN_CONFIRMED', now()),
  ('de000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', null, 'zapi', 'ENDED', 'ADMIN_CONFIRMED', now()),
  ('de000000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', null, 'zapi', 'ENDED', 'ADMIN_CONFIRMED', now())
on conflict (id) do nothing;

insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, cycle_source, ended_at,
                                current_monthly_cost_cents, cost_source, cost_updated_at)
values ('de000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'zapi', 'ENDED',
        'ADMIN_CONFIRMED', now(), 9990, 'PROVIDER_PANEL', now())
on conflict (id) do nothing;

-- DEL-9 (ator nulo) e DEL-10 (alerta aberto): ENDED sem custo.
insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, cycle_source, ended_at)
values
  ('de000000-0000-4000-8000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001', 'zapi', 'ENDED', 'ADMIN_CONFIRMED', now()),
  ('de000000-0000-4000-8000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000001', 'zapi', 'ENDED', 'ADMIN_CONFIRMED', now())
on conflict (id) do nothing;

-- DEL-12 (ENDED com custo atual + alerta OPEN: has_cost vence open_alerts) e
-- DEL-13 (ACTIVE sem custo + alerta OPEN: not_ended vence open_alerts).
insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, cycle_source, ended_at,
                                current_monthly_cost_cents, cost_source, cost_updated_at)
values ('de000000-0000-4000-8000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000001', 'zapi', 'ENDED',
        'ADMIN_CONFIRMED', now(), 5990, 'PROVIDER_PANEL', now())
on conflict (id) do nothing;
insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, cycle_source)
values ('de000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001', 'zapi', 'ACTIVE', 'ADMIN_CONFIRMED')
on conflict (id) do nothing;

-- DEL-11: nasce COM custo e o custo e anulado depois (set_cost aceita "desconhecido"
-- em qualquer estado). O trigger de auditoria da 087 guarda as duas versoes da linha.
insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, cycle_source, ended_at,
                                current_monthly_cost_cents, cost_source, cost_updated_at)
values ('de000000-0000-4000-8000-000000000008', 'aaaaaaaa-0000-0000-0000-000000000001', 'zapi', 'ENDED',
        'ADMIN_CONFIRMED', now(), 4990, 'PROVIDER_PANEL', now())
on conflict (id) do nothing;
update whatsapp_instances
   set current_monthly_cost_cents = null, cost_source = null, cost_updated_at = null
 where id = 'de000000-0000-4000-8000-000000000008' and current_monthly_cost_cents is not null;

insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, cycle_source)
values ('de000000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'zapi', 'ACTIVE', 'ADMIN_CONFIRMED')
on conflict (id) do nothing;

insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on, status, closed_at)
select 'de000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
       date '2026-08-01', date '2026-09-01', 'PENDING_REVIEW', now()
where not exists (select 1 from whatsapp_instance_cycles where instance_id = 'de000000-0000-4000-8000-000000000001');

insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on, status,
                                      provider_cost_cents, cost_source, cost_snapshot_at, closed_at)
select 'de000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
       date '2026-08-01', date '2026-09-01', 'CLOSED', 9990, 'PROVIDER_PANEL', now(), now()
where not exists (select 1 from whatsapp_instance_cycles where instance_id = 'de000000-0000-4000-8000-000000000003');

insert into whatsapp_instance_notes (instance_ref, instance_id, organization_id, action, note, created_by)
select 'de000000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001',
       'aaaaaaaa-0000-0000-0000-000000000001', 'REGISTER', 'instancia de teste', '11111111-1111-1111-1111-111111111111'
where not exists (select 1 from whatsapp_instance_notes where instance_ref = 'de000000-0000-4000-8000-000000000001' and action = 'REGISTER');

-- Alerta de INSTANCIA apontando a DEL-1: o ledger precisa sobreviver a exclusao
-- (instance_id vira NULL pela FK, subject_id segue sendo a identidade). A guarda
-- whatsapp_alert_subject_guard exige instance_id vivo e subject_id igual no INSERT.
-- RESOLVED (com resolved_at, por whatsapp_alerts_resolved_chk): alerta aberto bloquearia
-- a exclusao (open_alerts) e o DEL-1 existe para provar o caminho feliz.
insert into whatsapp_instance_alerts (subject_type, subject_id, organization_id, instance_id, alert_type, dedupe_key,
                                      status, resolved_at, resolved_by, resolution_note)
select 'INSTANCE', 'de000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
       'de000000-0000-4000-8000-000000000001', 'DIVERGENCE', 'del-1-fixture',
       'RESOLVED', now(), '11111111-1111-1111-1111-111111111111', 'fixture resolvido'
where exists (select 1 from whatsapp_instances where id = 'de000000-0000-4000-8000-000000000001')
  and not exists (select 1 from whatsapp_instance_alerts
                   where subject_id = 'de000000-0000-4000-8000-000000000001' and dedupe_key = 'del-1-fixture');

-- Alerta ABERTO da DEL-10: a instancia ENDED sem custo so e apagavel depois de resolver.
insert into whatsapp_instance_alerts (subject_type, subject_id, organization_id, instance_id, alert_type, dedupe_key)
select 'INSTANCE', 'de000000-0000-4000-8000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000001',
       'de000000-0000-4000-8000-000000000007', 'DIVERGENCE', 'del-10-fixture'
where exists (select 1 from whatsapp_instances where id = 'de000000-0000-4000-8000-000000000007')
  and not exists (select 1 from whatsapp_instance_alerts
                   where subject_id = 'de000000-0000-4000-8000-000000000007' and dedupe_key = 'del-10-fixture');

-- DEL-14: ENDED sem custo com alerta ACKNOWLEDGED (reconhecido, nao resolvido): tambem bloqueia.
-- A 089 exige acknowledged_at junto de ACKNOWLEDGED (whatsapp_alerts_ack_chk).
insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, cycle_source, ended_at)
values ('de000000-0000-4000-8000-00000000000b', 'aaaaaaaa-0000-0000-0000-000000000001', 'zapi', 'ENDED', 'ADMIN_CONFIRMED', now())
on conflict (id) do nothing;
insert into whatsapp_instance_alerts (subject_type, subject_id, organization_id, instance_id, alert_type, dedupe_key,
                                      status, acknowledged_at, acknowledged_by)
select 'INSTANCE', 'de000000-0000-4000-8000-00000000000b', 'aaaaaaaa-0000-0000-0000-000000000001',
       'de000000-0000-4000-8000-00000000000b', 'DIVERGENCE', 'del-14-fixture',
       'ACKNOWLEDGED', now(), '11111111-1111-1111-1111-111111111111'
where exists (select 1 from whatsapp_instances where id = 'de000000-0000-4000-8000-00000000000b')
  and not exists (select 1 from whatsapp_instance_alerts
                   where subject_id = 'de000000-0000-4000-8000-00000000000b' and dedupe_key = 'del-14-fixture');

-- Alertas ABERTOS das DEL-12 e DEL-13: a precedencia das recusas e not_ended > has_cost > open_alerts.
insert into whatsapp_instance_alerts (subject_type, subject_id, organization_id, instance_id, alert_type, dedupe_key)
select 'INSTANCE', i, 'aaaaaaaa-0000-0000-0000-000000000001', i, 'DIVERGENCE', 'del-prec-' || right(i::text, 2)
  from unnest(array['de000000-0000-4000-8000-000000000009'::uuid, 'de000000-0000-4000-8000-00000000000a'::uuid]) as i
 where exists (select 1 from whatsapp_instances where id = i)
   and not exists (select 1 from whatsapp_instance_alerts
                    where subject_id = i and dedupe_key = 'del-prec-' || right(i::text, 2));

-- ── DEL-1: encerrada sem custo e apagada; ciclo sai, notas e alerta ficam orfaos ──
-- Retrato do ciclo em audit_log (os ciclos nao tem trigger de auditoria).
do $$
declare v_out text; v_cycle_id uuid;
begin
  select id into v_cycle_id from whatsapp_instance_cycles
   where instance_id = 'de000000-0000-4000-8000-000000000001';
  select outcome into v_out from delete_whatsapp_instance_without_cost(
    'de000000-0000-4000-8000-000000000001', 'era instancia de teste', '11111111-1111-1111-1111-111111111111');
  insert into t_res (ord, caso, veredito) values (301, 'DEL-1 apaga encerrada sem custo; ciclo sai (com retrato no audit_log), notas e alerta ficam',
    case when v_out = 'deleted'
      and not exists (select 1 from whatsapp_instances where id = 'de000000-0000-4000-8000-000000000001')
      and not exists (select 1 from whatsapp_instance_cycles where instance_id = 'de000000-0000-4000-8000-000000000001')
      and exists (select 1 from whatsapp_instance_notes
                   where instance_ref = 'de000000-0000-4000-8000-000000000001' and action = 'DELETE'
                     and instance_id is null and note = 'era instancia de teste'
                     and created_by = '11111111-1111-1111-1111-111111111111')
      and exists (select 1 from whatsapp_instance_notes
                   where instance_ref = 'de000000-0000-4000-8000-000000000001' and action = 'REGISTER'
                     and instance_id is null)
      and exists (select 1 from whatsapp_instance_alerts
                   where subject_type = 'INSTANCE'
                     and subject_id = 'de000000-0000-4000-8000-000000000001'
                     and instance_id is null)
      and exists (select 1 from audit_log
                   where table_name = 'whatsapp_instances' and action = 'DELETE'
                     and record_id = 'de000000-0000-4000-8000-000000000001')
      and exists (select 1 from audit_log
                   where table_name = 'whatsapp_instance_cycles' and action = 'DELETE'
                     and record_id = v_cycle_id::text
                     and old_values->>'status' = 'PENDING_REVIEW'
                     and actor_id = '11111111-1111-1111-1111-111111111111'
                     and organization_id = 'aaaaaaaa-0000-0000-0000-000000000001'
                     and unit_id = 'bbbbbbbb-0000-0000-0000-000000000001')
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── DEL-2: custo atual informado bloqueia ─────────────────────────────
do $$
declare v_out text;
begin
  select outcome into v_out from delete_whatsapp_instance_without_cost(
    'de000000-0000-4000-8000-000000000002', 'tentativa', '11111111-1111-1111-1111-111111111111');
  insert into t_res (ord, caso, veredito) values (302, 'DEL-2 custo atual bloqueia a exclusao',
    case when v_out = 'has_cost'
      and exists (select 1 from whatsapp_instances where id = 'de000000-0000-4000-8000-000000000002')
      and not exists (select 1 from whatsapp_instance_notes
                       where instance_ref = 'de000000-0000-4000-8000-000000000002' and action = 'DELETE')
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── DEL-3: custo so em ciclo tambem bloqueia ──────────────────────────
do $$
declare v_out text;
begin
  select outcome into v_out from delete_whatsapp_instance_without_cost(
    'de000000-0000-4000-8000-000000000003', 'tentativa', '11111111-1111-1111-1111-111111111111');
  insert into t_res (ord, caso, veredito) values (303, 'DEL-3 custo so no ciclo bloqueia a exclusao',
    case when v_out = 'has_cost'
      and exists (select 1 from whatsapp_instances where id = 'de000000-0000-4000-8000-000000000003')
      and exists (select 1 from whatsapp_instance_cycles where instance_id = 'de000000-0000-4000-8000-000000000003')
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── DEL-4: instancia nao encerrada nao e apagada ──────────────────────
do $$
declare v_out text;
begin
  select outcome into v_out from delete_whatsapp_instance_without_cost(
    'de000000-0000-4000-8000-000000000004', 'tentativa', '11111111-1111-1111-1111-111111111111');
  insert into t_res (ord, caso, veredito) values (304, 'DEL-4 ACTIVE nao e apagada',
    case when v_out = 'not_ended'
      and exists (select 1 from whatsapp_instances where id = 'de000000-0000-4000-8000-000000000004')
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── DEL-5: id inexistente ─────────────────────────────────────────────
do $$
declare v_out text;
begin
  select outcome into v_out from delete_whatsapp_instance_without_cost(
    'de000000-0000-4000-8000-0000000000ff', 'tentativa', '11111111-1111-1111-1111-111111111111');
  insert into t_res (ord, caso, veredito) values (305, 'DEL-5 id inexistente devolve not_found',
    case when v_out = 'not_found' then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── DEL-6: ACL ────────────────────────────────────────────────────────
insert into t_res (ord, caso, veredito)
select 306, 'DEL-6 so service_role executa; PUBLIC, anon e authenticated nao',
  case when not has_function_privilege('anon', 'public.delete_whatsapp_instance_without_cost(uuid,text,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.delete_whatsapp_instance_without_cost(uuid,text,uuid)', 'execute')
    and has_function_privilege('service_role', 'public.delete_whatsapp_instance_without_cost(uuid,text,uuid)', 'execute')
    and not exists (
      select 1 from pg_proc p, aclexplode(p.proacl) a
       where p.proname = 'delete_whatsapp_instance_without_cost' and a.grantee = 0)
  then 'PASSOU' else 'FALHOU' end;

-- ── DEL-7: migration aplicada duas vezes nao duplica nada ─────────────
insert into t_res (ord, caso, veredito)
select 307, 'DEL-7 idempotencia: um CHECK com DELETE, uma funcao',
  case when (select count(*) from pg_constraint where conname = 'whatsapp_instance_notes_action_check') = 1
    and (select pg_get_constraintdef(oid) from pg_constraint
          where conname = 'whatsapp_instance_notes_action_check') like '%''DELETE''%'
    and (select count(*) from pg_proc where proname = 'delete_whatsapp_instance_without_cost') = 1
  then 'PASSOU' else 'FALHOU' end;

-- ── DEL-8: motivo vazio e recusado e nada e apagado ───────────────────
do $$
declare v_state text;
begin
  begin
    perform delete_whatsapp_instance_without_cost('de000000-0000-4000-8000-000000000005', '   ', '11111111-1111-1111-1111-111111111111');
    v_state := 'apagou';
  exception when check_violation then
    v_state := 'recusou';
  end;
  insert into t_res (ord, caso, veredito) values (308, 'DEL-8 motivo vazio e recusado',
    case when v_state = 'recusou'
      and exists (select 1 from whatsapp_instances where id = 'de000000-0000-4000-8000-000000000005')
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── DEL-9: ator nulo e recusado e nada e apagado ──────────────────────
do $$
declare v_state text;
begin
  begin
    perform delete_whatsapp_instance_without_cost('de000000-0000-4000-8000-000000000006', 'sem ator', null);
    v_state := 'apagou';
  exception when check_violation then
    v_state := 'recusou';
  end;
  insert into t_res (ord, caso, veredito) values (309, 'DEL-9 ator nulo e recusado',
    case when v_state = 'recusou'
      and exists (select 1 from whatsapp_instances where id = 'de000000-0000-4000-8000-000000000006')
      and not exists (select 1 from whatsapp_instance_notes
                       where instance_ref = 'de000000-0000-4000-8000-000000000006' and action = 'DELETE')
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── DEL-10: alerta aberto bloqueia, mesmo sem custo ───────────────────
do $$
declare v_out text;
begin
  select outcome into v_out from delete_whatsapp_instance_without_cost(
    'de000000-0000-4000-8000-000000000007', 'tentativa', '11111111-1111-1111-1111-111111111111');
  insert into t_res (ord, caso, veredito) values (310, 'DEL-10 alerta OPEN bloqueia a exclusao',
    case when v_out = 'open_alerts'
      and exists (select 1 from whatsapp_instances where id = 'de000000-0000-4000-8000-000000000007')
      and exists (select 1 from whatsapp_instance_alerts
                   where instance_id = 'de000000-0000-4000-8000-000000000007' and status = 'OPEN')
      and not exists (select 1 from whatsapp_instance_notes
                       where instance_ref = 'de000000-0000-4000-8000-000000000007' and action = 'DELETE')
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── DEL-11: custo anulado depois ainda e custo (historico no audit_log) ──
do $$
declare v_out text;
begin
  select outcome into v_out from delete_whatsapp_instance_without_cost(
    'de000000-0000-4000-8000-000000000008', 'tentativa', '11111111-1111-1111-1111-111111111111');
  insert into t_res (ord, caso, veredito) values (313, 'DEL-11 custo anulado depois bloqueia a exclusao',
    case when v_out = 'has_cost'
      and exists (select 1 from whatsapp_instances
                   where id = 'de000000-0000-4000-8000-000000000008'
                     and current_monthly_cost_cents is null)
      and not exists (select 1 from whatsapp_instance_notes
                       where instance_ref = 'de000000-0000-4000-8000-000000000008' and action = 'DELETE')
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── DEL-12: com custo E alerta aberto, o desfecho e has_cost (nao open_alerts) ──
do $$
declare v_out text;
begin
  select outcome into v_out from delete_whatsapp_instance_without_cost(
    'de000000-0000-4000-8000-000000000009', 'tentativa', '11111111-1111-1111-1111-111111111111');
  insert into t_res (ord, caso, veredito) values (316, 'DEL-12 custo atual e alerta OPEN: has_cost vence open_alerts',
    case when v_out = 'has_cost'
      and exists (select 1 from whatsapp_instances where id = 'de000000-0000-4000-8000-000000000009')
      and not exists (select 1 from whatsapp_instance_notes
                       where instance_ref = 'de000000-0000-4000-8000-000000000009' and action = 'DELETE')
    then 'PASSOU' else 'FALHOU ' || coalesce(v_out, '<null>') end);
end $$;

-- ── DEL-13: ACTIVE com alerta aberto, o desfecho e not_ended (nao open_alerts) ──
do $$
declare v_out text;
begin
  select outcome into v_out from delete_whatsapp_instance_without_cost(
    'de000000-0000-4000-8000-00000000000a', 'tentativa', '11111111-1111-1111-1111-111111111111');
  insert into t_res (ord, caso, veredito) values (317, 'DEL-13 ACTIVE e alerta OPEN: not_ended vence open_alerts',
    case when v_out = 'not_ended'
      and exists (select 1 from whatsapp_instances where id = 'de000000-0000-4000-8000-00000000000a')
      and not exists (select 1 from whatsapp_instance_notes
                       where instance_ref = 'de000000-0000-4000-8000-00000000000a' and action = 'DELETE')
    then 'PASSOU' else 'FALHOU ' || coalesce(v_out, '<null>') end);
end $$;

-- ── DEL-14: alerta ACKNOWLEDGED tambem bloqueia (open_alerts) ─────────
do $$
declare v_out text;
begin
  select outcome into v_out from delete_whatsapp_instance_without_cost(
    'de000000-0000-4000-8000-00000000000b', 'tentativa', '11111111-1111-1111-1111-111111111111');
  insert into t_res (ord, caso, veredito) values (318, 'DEL-14 alerta ACKNOWLEDGED bloqueia a exclusao',
    case when v_out = 'open_alerts'
      and exists (select 1 from whatsapp_instances where id = 'de000000-0000-4000-8000-00000000000b')
      and exists (select 1 from whatsapp_instance_alerts
                   where instance_id = 'de000000-0000-4000-8000-00000000000b' and status = 'ACKNOWLEDGED')
      and not exists (select 1 from whatsapp_instance_notes
                       where instance_ref = 'de000000-0000-4000-8000-00000000000b' and action = 'DELETE')
    then 'PASSOU' else 'FALHOU ' || coalesce(v_out, '<null>') end);
end $$;
