-- P1..P9, V1..V7 e C1..C9 (ordinais 7801-7831): migration
-- 20261020150000_ai_global_prompt_and_settings_value_guard.sql contra Postgres
-- real.
--
-- BASE: 00 -> 01 -> 09a -> 106 -> 75a -> 20261019180000 -> 78a (ver 78a e
-- README §78). Os casos rodam com a identidade de verdade: `set local role
-- authenticated|service_role|anon` + `request.jwt.claims` (`sub`, `role`).
-- Cada caso confere o SQLSTATE e a MENSAGEM (`prompt_forbidden`,
-- `setting_value_invalid`… são da migration; ACL e RLS devolvem `42501` com
-- outra mensagem) E o efeito (estado do slot, contagem de versões e do ledger,
-- valor gravado).
--
-- RED: sem a migration, a guarda abaixo aborta (é o RED registrado no README).
-- GREEN: este arquivo zera a história (modo replica, só no harness), reaplica a
-- migration por `\i` (o seed recria a v1), recoloca as linhas de `settings` e
-- mede; no fim reaplica a migration de novo e mede a idempotência (P8). Roda da
-- RAIZ DO REPO e pode ser repetido no mesmo banco.

create table if not exists t_res (ord int primary key, caso text, veredito text);
delete from t_res where ord between 7801 and 7831;

do $$
begin
  if to_regclass('public.ai_prompt_versions') is null
     or to_regclass('public.ai_prompt_slots') is null
     or to_regclass('public.ai_prompt_activations') is null
     or to_regprocedure('public.publish_ai_prompt_version(text,text,text,uuid)') is null
     or to_regprocedure('public.activate_ai_prompt_version(text,uuid,uuid,text)') is null
     or not exists (select 1 from pg_trigger
                     where tgrelid = 'public.settings'::regclass
                       and tgname = 'settings_write_value_guard' and not tgisinternal) then
    raise exception '78: migration do prompt global ausente. Aplique a 20261020150000 antes (sem ela, este abort e o RED esperado).';
  end if;
  if not exists (select 1 from platform_admins where user_id = 'a0d78000-0000-4000-8000-0000000000c2') then
    raise exception '78 exige o 78a (atores ai78).';
  end if;
end $$;

-- ─── História zerada (só no harness: replica desliga o append-only e as FKs) ─
set session_replication_role = replica;
delete from public.ai_prompt_activations;
delete from public.ai_prompt_slots;
delete from public.ai_prompt_versions;
set session_replication_role = origin;

-- ─── Migration reaplicada: o seed recria a v1 ────────────────────────────────
\i supabase/migrations/20261020150000_ai_global_prompt_and_settings_value_guard.sql

-- ─── Linhas iniciais de settings de volta (sem triggers, só para o setup) ────
set session_replication_role = replica;
delete from public.settings
 where unit_id in ('a0d78000-0000-4000-8000-0000000000aa', 'a0d78000-0000-4000-8000-0000000000bb');
insert into public.settings (unit_id, key, value)
select 'a0d78000-0000-4000-8000-0000000000aa'::uuid, k, to_jsonb('ai78-inicial-' || k)
  from unnest(array['restaurant_menu', 'delivery_response', 'restaurant_extra_info',
                    'ai_system_prompt', 'ai_context_extra', 'agent_name']) as k;
insert into public.settings (unit_id, key, value)
values ('a0d78000-0000-4000-8000-0000000000aa', 'agent_mode', '"reservations"');
set session_replication_role = origin;

-- ─── Helpers ─────────────────────────────────────────────────────────────────
-- Executa p_sql como (p_role, p_sub) e devolve 'ok' ou 'SQLSTATE:mensagem'.
-- p_role nulo = sem claims e sem trocar de papel (postgres, como `db push`).
create or replace function pg_temp.s78_try(p_role text, p_sub uuid, p_sql text)
returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_role is null then ''
         else jsonb_strip_nulls(jsonb_build_object('sub', p_sub, 'role', p_role))::text end,
    true);
  begin
    if p_role is not null then execute format('set local role %I', p_role); end if;
    execute p_sql;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    return 'ok';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    return sqlstate || ':' || sqlerrm;
  end;
end $$;

-- Mesmo que s78_try, para uma consulta de um valor: 'ok:<valor>' ou erro.
create or replace function pg_temp.s78_sel(p_role text, p_sub uuid, p_sql text)
returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims',
    case when p_role is null then ''
         else jsonb_strip_nulls(jsonb_build_object('sub', p_sub, 'role', p_role))::text end,
    true);
  begin
    if p_role is not null then execute format('set local role %I', p_role); end if;
    execute p_sql into v;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    return 'ok:' || coalesce(v, '<null>');
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    return sqlstate || ':' || sqlerrm;
  end;
end $$;

create or replace function pg_temp.s78_pub(p_body text, p_note text, p_expected uuid, p_slot text default 'global_persona')
returns text language sql as $$
  select format('select public.publish_ai_prompt_version(%L, %L, %L, %L::uuid)',
                p_slot, p_body, p_note, p_expected)
$$;

create or replace function pg_temp.s78_act(p_version uuid, p_expected uuid, p_note text, p_slot text default 'global_persona')
returns text language sql as $$
  select format('select public.activate_ai_prompt_version(%L, %L::uuid, %L::uuid, %L)',
                p_slot, p_version, p_expected, p_note)
$$;

-- Versão ativa e retrato da história (lidos como postgres).
create or replace function pg_temp.s78_active() returns uuid language sql as $$
  select active_version_id from public.ai_prompt_slots where slot = 'global_persona'
$$;

create or replace function pg_temp.s78_vid(p_version int) returns uuid language sql as $$
  select id from public.ai_prompt_versions where slot = 'global_persona' and version = p_version
$$;

create or replace function pg_temp.s78_state() returns text language sql as $$
  select coalesce(pg_temp.s78_active()::text, '<sem slot>')
         || '|v=' || (select count(*) from public.ai_prompt_versions)
         || '|l=' || (select count(*) from public.ai_prompt_activations)
         || '|h=' || coalesce((select md5(string_agg(id::text || version || body || body_sha256 || note,
                                                     ',' order by version))
                                 from public.ai_prompt_versions), '-')
$$;

-- settings: upsert com valor JSON cru (para testar não-string) e leitura.
create or replace function pg_temp.s78_ups(p_unit uuid, p_key text, p_json text)
returns text language sql as $$
  select format('insert into public.settings (unit_id, key, value) values (%L, %L, %L::jsonb) '
                'on conflict (unit_id, key) do update set value = excluded.value',
                p_unit, p_key, p_json)
$$;

create or replace function pg_temp.s78_str(p_text text) returns text language sql as $$
  select to_jsonb(p_text)::text
$$;

create or replace function pg_temp.s78_val(p_unit uuid, p_key text)
returns text language sql as $$
  select coalesce((select value::text from public.settings where unit_id = p_unit and key = p_key),
                  '<ausente>')
$$;

create or replace function pg_temp.s78_good_body(p_tag text) returns text language sql as $$
  select 'Camada global ' || p_tag || ' para {{agent_name}} no {{restaurant_name}}. Seja cordial.'
$$;

-- ─── P1: platform_admin A publica com expected = v1 ──────────────────────────
do $$
declare r text; v1 uuid := pg_temp.s78_vid(1); v2 uuid; v_ok boolean;
  pa constant uuid := 'a0d78000-0000-4000-8000-0000000000c1';
  b constant text := pg_temp.s78_good_body('P1');
begin
  r := pg_temp.s78_sel('authenticated', pa, pg_temp.s78_pub(b, 'P1 primeira publicacao', v1));
  v2 := pg_temp.s78_vid(2);
  select (r = 'ok:' || v2::text)
     and pg_temp.s78_active() = v2
     and v.body = b and v.created_by = pa and v.note = 'P1 primeira publicacao'
     and v.body_sha256 = encode(sha256(convert_to(b, 'UTF8')), 'hex')
     and (select count(*) from public.ai_prompt_versions) = 2
     and (select count(*) from public.ai_prompt_activations) = 2
     and exists (select 1 from public.ai_prompt_activations a
                  where a.kind = 'publish' and a.version_id = v2 and a.previous_version_id = v1
                    and a.actor = pa and a.note = 'P1 primeira publicacao')
     and (select activated_by from public.ai_prompt_slots where slot = 'global_persona') = pa
    into v_ok
    from public.ai_prompt_versions v where v.id = v2;
  insert into t_res values (7801, 'P1 admin A publica com expected=v1: devolve o id da v2, slot na v2, body_sha256 do corpo, autor e ledger publish com ator/nota/anterior',
    case when coalesce(v_ok, false) then 'PASSOU' else 'FALHOU r=' || r || ' estado=' || pg_temp.s78_state() end);
end $$;

-- ─── P2: quem não é platform_admin não publica nem ativa ─────────────────────
-- owner/gerente/operador/sem papel/authenticated sem sub recebem prompt_forbidden
-- do corpo; anon e service_role nem têm EXECUTE. Com grant temporário, o
-- service_role (sem sub) também cai no guard do corpo.
create or replace function pg_temp.s78_p2(p_kind text) returns text language plpgsql as $$
declare ruins text := ''; r text; s0 text := pg_temp.s78_state(); a uuid := pg_temp.s78_active();
  v1 uuid := pg_temp.s78_vid(1);
  f constant text := '42501:prompt_forbidden';
  sql text;
  who record;
begin
  sql := case p_kind when 'pub' then pg_temp.s78_pub(pg_temp.s78_good_body('P2'), 'P2', a)
                     else pg_temp.s78_act(v1, a, 'P2') end;
  for who in select * from (values
      ('authenticated', 'a0d78000-0000-4000-8000-0000000000a1'::uuid, f),
      ('authenticated', 'a0d78000-0000-4000-8000-0000000000a2'::uuid, f),
      ('authenticated', 'a0d78000-0000-4000-8000-0000000000a3'::uuid, f),
      ('authenticated', 'a0d78000-0000-4000-8000-0000000000e1'::uuid, f),
      ('authenticated', null::uuid, f),
      ('anon', null::uuid, '42501:permission denied for function '
                           || case p_kind when 'pub' then 'publish' else 'activate' end || '_ai_prompt_version'),
      ('service_role', null::uuid, '42501:permission denied for function '
                           || case p_kind when 'pub' then 'publish' else 'activate' end || '_ai_prompt_version')
    ) as t(role, sub, expected) loop
    r := pg_temp.s78_try(who.role, who.sub, sql);
    if r <> who.expected then ruins := ruins || ' ' || who.role || '/' || coalesce(who.sub::text, '-') || '=' || r; end if;
  end loop;
  begin
    execute 'grant execute on function public.publish_ai_prompt_version(text,text,text,uuid), '
            'public.activate_ai_prompt_version(text,uuid,uuid,text) to service_role';
    r := pg_temp.s78_try('service_role', null, sql);
    raise exception 'desfazer grant';
  exception when raise_exception then null;
  end;
  if r <> f then ruins := ruins || ' service_role_com_grant=' || r; end if;
  if pg_temp.s78_state() <> s0 then ruins := ruins || ' estado_mudou=' || pg_temp.s78_state(); end if;
  return ruins;
end $$;

do $$
declare r text := pg_temp.s78_p2('pub');
begin
  insert into t_res values (7802, 'P2 publish: owner/gerente/operador/sem papel/sem sub recebem prompt_forbidden; anon e service_role sem EXECUTE; service_role com grant cai no guard; slot, versoes e ledger intactos',
    case when r = '' then 'PASSOU' else 'FALHOU' || r end);
end $$;

do $$
declare r text := pg_temp.s78_p2('act');
begin
  insert into t_res values (7803, 'P2 activate: os mesmos sete papeis recusados (prompt_forbidden ou sem EXECUTE), service_role com grant no guard; nada muda',
    case when r = '' then 'PASSOU' else 'FALHOU' || r end);
end $$;

-- ─── P3: expected desatualizado = 40001, nada muda ───────────────────────────
do $$
declare a text; b text; c text; s0 text := pg_temp.s78_state();
  pb constant uuid := 'a0d78000-0000-4000-8000-0000000000c2';
  f constant text := '40001:prompt_version_conflict';
begin
  a := pg_temp.s78_try('authenticated', pb, pg_temp.s78_pub(pg_temp.s78_good_body('P3'), 'P3 admin B atrasado', pg_temp.s78_vid(1)));
  b := pg_temp.s78_try('authenticated', pb, pg_temp.s78_pub(pg_temp.s78_good_body('P3'), 'P3 sem expected', null));
  c := pg_temp.s78_try('authenticated', pb, pg_temp.s78_act(pg_temp.s78_vid(1), pg_temp.s78_vid(1), 'P3 activate atrasado'));
  insert into t_res values (7804, 'P3 admin B com expected=v1 depois do P1 (publish e activate) e com expected nulo: 40001 prompt_version_conflict, nada muda',
    case when a = f and b = f and c = f and pg_temp.s78_state() = s0 then 'PASSOU'
         else 'FALHOU pub=' || a || ' nulo=' || b || ' act=' || c || ' estado=' || pg_temp.s78_state() end);
end $$;

-- ─── P4: corpo e nota inválidos = 22023 ──────────────────────────────────────
do $$
declare ruins text := ''; r text; s0 text := pg_temp.s78_state(); body text;
  pa constant uuid := 'a0d78000-0000-4000-8000-0000000000c1';
begin
  foreach body in array array[
      '', E'  \n\t  ', repeat('a', 4001), 'ola {{x}}', 'ola {{agent_name}', 'ola }} fim',
      'ola {{ agent_name }}', 'abre <<< aqui', 'fecha >>> aqui', 'sino ' || chr(7) || ' aqui',
      'cr ' || chr(13) || ' aqui', 'del ' || chr(127) || ' aqui'] loop
    r := pg_temp.s78_try('authenticated', pa, pg_temp.s78_pub(body, 'P4', pg_temp.s78_active()));
    if r <> '22023:prompt_body_invalid' then ruins := ruins || ' [' || left(body, 20) || ']=' || r; end if;
  end loop;
  r := pg_temp.s78_try('authenticated', pa, pg_temp.s78_pub(null, 'P4', pg_temp.s78_active()));
  if r <> '22023:prompt_body_invalid' then ruins := ruins || ' [null]=' || r; end if;
  insert into t_res values (7805, 'P4 corpo vazio, so brancos, 4001, {{x}}, {{agent_name} solto, }} solto, placeholder com espaco, <<<, >>>, \x07, \r, DEL e nulo: 22023 prompt_body_invalid, nada muda',
    case when ruins = '' and pg_temp.s78_state() = s0 then 'PASSOU'
         else 'FALHOU' || ruins || ' estado=' || pg_temp.s78_state() end);
end $$;

do $$
declare ruins text := ''; r text; s0 text := pg_temp.s78_state(); note text;
  pa constant uuid := 'a0d78000-0000-4000-8000-0000000000c1';
begin
  foreach note in array array['', '   ', repeat('n', 281)] loop
    r := pg_temp.s78_try('authenticated', pa, pg_temp.s78_pub(pg_temp.s78_good_body('P4n'), note, pg_temp.s78_active()));
    if r <> '22023:prompt_note_invalid' then ruins := ruins || ' pub[' || length(note) || ']=' || r; end if;
    r := pg_temp.s78_try('authenticated', pa, pg_temp.s78_act(pg_temp.s78_vid(1), pg_temp.s78_active(), note));
    if r <> '22023:prompt_note_invalid' then ruins := ruins || ' act[' || length(note) || ']=' || r; end if;
  end loop;
  r := pg_temp.s78_try('authenticated', pa, pg_temp.s78_pub(pg_temp.s78_good_body('P4n'), null, pg_temp.s78_active()));
  if r <> '22023:prompt_note_invalid' then ruins := ruins || ' pub[null]=' || r; end if;
  insert into t_res values (7806, 'P4 nota vazia, so brancos, 281 e nula (publish e activate): 22023 prompt_note_invalid, nada muda',
    case when ruins = '' and pg_temp.s78_state() = s0 then 'PASSOU'
         else 'FALHOU' || ruins || ' estado=' || pg_temp.s78_state() end);
end $$;

-- ─── P4c: NUL é recusado pelo Postgres antes da função ───────────────────────
-- Três formas de mandar um NUL: literal E'\000', chr(0) e JSON "\u0000" (a do
-- PostgREST). Os códigos medidos entram no texto do caso.
do $$
declare a text; b text; c text; s0 text := pg_temp.s78_state();
  pa constant uuid := 'a0d78000-0000-4000-8000-0000000000c1';
begin
  a := pg_temp.s78_try('authenticated', pa,
         format('select public.publish_ai_prompt_version(%L, E''a\000b'', %L, %L::uuid)',
                'global_persona', 'P4c', pg_temp.s78_active()));
  b := pg_temp.s78_try('authenticated', pa,
         format('select public.publish_ai_prompt_version(%L, chr(0), %L, %L::uuid)',
                'global_persona', 'P4c', pg_temp.s78_active()));
  c := pg_temp.s78_try('authenticated', pa,
         format('select public.publish_ai_prompt_version(%L, (%L::jsonb ->> 0), %L, %L::uuid)',
                'global_persona', '["a\u0000b"]', 'P4c', pg_temp.s78_active()));
  insert into t_res values (7807, 'P4c NUL recusado antes da funcao, nada muda; medido: literal=' || split_part(a, ':', 1)
                                  || ' chr(0)=' || split_part(b, ':', 1) || ' json=' || split_part(c, ':', 1),
    case when a not like 'ok%' and b not like 'ok%' and c not like 'ok%'
          and a not like '%prompt_%' and b not like '%prompt_%' and c not like '%prompt_%'
          and pg_temp.s78_state() = s0 then 'PASSOU'
         else 'FALHOU literal=' || a || ' chr=' || b || ' json=' || c end);
end $$;

-- ─── P4b: bordas aceitas (4000 com \n, \t e os dois placeholders; nota 280) ──
do $$
declare r text; v3 uuid; v_ok boolean; b text;
  pa constant uuid := 'a0d78000-0000-4000-8000-0000000000c1';
  tail constant text := E'{{agent_name}}\t{{restaurant_name}}\n';
begin
  b := repeat('x', 4000 - char_length(tail)) || tail;
  r := pg_temp.s78_sel('authenticated', pa, pg_temp.s78_pub(b, repeat('n', 280), pg_temp.s78_active()));
  v3 := pg_temp.s78_vid(3);
  select r = 'ok:' || v3::text and pg_temp.s78_active() = v3 and char_length(v.body) = 4000 and v.body = b
    into v_ok from public.ai_prompt_versions v where v.id = v3;
  insert into t_res values (7808, 'P4b bordas aceitas: corpo de 4000 com \t, \n e os dois placeholders, nota de 280; v3 ativa e corpo identico',
    case when coalesce(v_ok, false) then 'PASSOU' else 'FALHOU r=' || r || ' estado=' || pg_temp.s78_state() end);
end $$;

-- ─── P5: restaurar a v1 (rollback) ───────────────────────────────────────────
do $$
declare r text; v1 uuid := pg_temp.s78_vid(1); v3 uuid := pg_temp.s78_vid(3); v_ok boolean;
  pa constant uuid := 'a0d78000-0000-4000-8000-0000000000c1';
begin
  r := pg_temp.s78_try('authenticated', pa, pg_temp.s78_act(v1, v3, 'P5 voltar ao seed'));
  select r = 'ok' and pg_temp.s78_active() = v1
     and (select count(*) from public.ai_prompt_versions) = 3
     and (select count(*) from public.ai_prompt_activations) = 4
     and exists (select 1 from public.ai_prompt_activations a
                  where a.kind = 'rollback' and a.version_id = v1 and a.previous_version_id = v3
                    and a.actor = pa and a.note = 'P5 voltar ao seed')
     and (select activated_by from public.ai_prompt_slots where slot = 'global_persona') = pa
    into v_ok;
  insert into t_res values (7809, 'P5 admin A ativa a v1 com expected=v3: slot na v1, nenhuma versao nova, ledger rollback com anterior=v3, ator e nota',
    case when v_ok then 'PASSOU' else 'FALHOU r=' || r || ' estado=' || pg_temp.s78_state() end);
end $$;

do $$
declare a text; b text; c text; d text; e text; s0 text := pg_temp.s78_state();
  pa constant uuid := 'a0d78000-0000-4000-8000-0000000000c1';
  ghost constant uuid := 'a0d78000-0000-4000-8000-0000000000ff';
begin
  a := pg_temp.s78_try('authenticated', pa, pg_temp.s78_act(ghost, pg_temp.s78_active(), 'P5 inexistente'));
  b := pg_temp.s78_try('authenticated', pa, pg_temp.s78_act(null, pg_temp.s78_active(), 'P5 nulo'));
  c := pg_temp.s78_try('authenticated', pa, pg_temp.s78_act(pg_temp.s78_active(), pg_temp.s78_active(), 'P5 ja ativa'));
  d := pg_temp.s78_try('authenticated', pa, pg_temp.s78_act(pg_temp.s78_vid(2), pg_temp.s78_active(), 'P5 outro slot', 'outro_slot'));
  e := pg_temp.s78_try('authenticated', pa, pg_temp.s78_pub(pg_temp.s78_good_body('P5'), 'P5 outro slot', pg_temp.s78_active(), 'outro_slot'));
  insert into t_res values (7810, 'P5 recusas: versao inexistente, nula e ja ativa (prompt_version_invalid); slot inexistente no activate e no publish (prompt_slot_invalid); 22023, nada muda',
    case when a = '22023:prompt_version_invalid' and b = a and c = a
          and d = '22023:prompt_slot_invalid' and e = d and pg_temp.s78_state() = s0 then 'PASSOU'
         else 'FALHOU inexistente=' || a || ' nulo=' || b || ' ativa=' || c || ' slot_act=' || d || ' slot_pub=' || e end);
end $$;

-- ─── P6: história append-only, para todo papel ───────────────────────────────
-- Dono (postgres) recebe o trigger. service_role e admin nem têm UPDATE/DELETE;
-- com grant temporário, o service_role (BYPASSRLS) chega ao trigger e o admin
-- (sem policy de escrita) casa zero linhas. Slot só muda pelas RPCs.
do $$
declare ruins text := ''; r text; s0 text := pg_temp.s78_state(); st text;
  pa constant uuid := 'a0d78000-0000-4000-8000-0000000000c1';
  f constant text := '42501:ai_prompt_history_append_only';
begin
  foreach st in array array[
      'update public.ai_prompt_versions set note = ''P6'' where version = 1',
      'delete from public.ai_prompt_versions where version = 2',
      'update public.ai_prompt_activations set note = ''P6''',
      'delete from public.ai_prompt_activations',
      'truncate public.ai_prompt_activations',
      'truncate public.ai_prompt_versions cascade',
      'delete from public.ai_prompt_slots',
      'truncate public.ai_prompt_slots'] loop
    r := pg_temp.s78_try(null, null, st);
    if r <> f then ruins := ruins || ' dono[' || left(st, 34) || ']=' || r; end if;
  end loop;
  foreach st in array array[
      'update public.ai_prompt_versions set note = ''P6''',
      'delete from public.ai_prompt_activations',
      'update public.ai_prompt_slots set activated_by = null',
      'insert into public.ai_prompt_versions (slot, version, body, body_sha256, note) values (''global_persona'', 99, ''x'', repeat(''0'', 64), ''P6'')'] loop
    r := pg_temp.s78_try('service_role', null, st);
    if r not like '42501:permission denied for table ai_prompt_%' then ruins := ruins || ' sr[' || left(st, 34) || ']=' || r; end if;
    r := pg_temp.s78_try('authenticated', pa, st);
    if r not like '42501:permission denied for table ai_prompt_%' then ruins := ruins || ' admin[' || left(st, 34) || ']=' || r; end if;
  end loop;
  begin
    grant update, delete on public.ai_prompt_versions, public.ai_prompt_activations to service_role, authenticated;
    r := pg_temp.s78_try('service_role', null, 'update public.ai_prompt_versions set note = ''P6''');
    if r <> f then ruins := ruins || ' sr_com_grant_upd=' || r; end if;
    r := pg_temp.s78_try('service_role', null, 'delete from public.ai_prompt_activations');
    if r <> f then ruins := ruins || ' sr_com_grant_del=' || r; end if;
    r := pg_temp.s78_try('authenticated', pa, 'update public.ai_prompt_versions set note = ''P6''');
    if r <> 'ok' then ruins := ruins || ' admin_com_grant_upd=' || r; end if;
    if pg_temp.s78_state() <> s0 then ruins := ruins || ' admin_com_grant_mudou'; end if;
    raise exception 'desfazer grant';
  exception when raise_exception then null;
  end;
  if pg_temp.s78_state() <> s0 then ruins := ruins || ' estado_mudou=' || pg_temp.s78_state(); end if;
  insert into t_res values (7811, 'P6 versoes e ledger append-only e slot sem DELETE/TRUNCATE: dono recebe ai_prompt_history_append_only; service_role e admin sem grant de escrita; com grant, service_role cai no trigger e admin casa zero linhas; nada muda',
    case when ruins = '' then 'PASSOU' else 'FALHOU' || ruins end);
end $$;

-- ─── P7: ACL e forma das funções ─────────────────────────────────────────────
do $$
declare ruins text := ''; r text; fn text;
begin
  foreach fn in array array['public.publish_ai_prompt_version(text,text,text,uuid)',
                            'public.activate_ai_prompt_version(text,uuid,uuid,text)'] loop
    if has_function_privilege('anon', fn, 'EXECUTE') then ruins := ruins || ' anon:' || fn; end if;
    if has_function_privilege('service_role', fn, 'EXECUTE') then ruins := ruins || ' service_role:' || fn; end if;
    if not has_function_privilege('authenticated', fn, 'EXECUTE') then ruins := ruins || ' authenticated_sem:' || fn; end if;
    if not exists (select 1 from pg_proc where oid = fn::regprocedure
                    and prosecdef and proconfig = array['search_path=""']) then
      ruins := ruins || ' sem_definer_ou_search_path:' || fn; end if;
  end loop;
  foreach fn in array array['app_private.ai_prompt_append_only()',
                            'app_private.ai_prompt_body_valid(text)',
                            'app_private.ai_prompt_note_valid(text)',
                            'app_private.guard_unit_setting_value()',
                            'app_private.unit_setting_value_limit(text)',
                            'app_private.unit_setting_write_class(text)'] loop
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(r, fn, 'EXECUTE') then ruins := ruins || ' ' || r || ':' || fn; end if;
    end loop;
    if exists (select 1 from pg_proc where oid = fn::regprocedure
                and proacl::text is distinct from '{postgres=X/postgres}') then
      ruins := ruins || ' proacl_aberta:' || fn; end if;
  end loop;
  -- PUBLIC (grantee 0) em nenhuma das oito.
  if exists (select 1 from pg_proc p, aclexplode(p.proacl) x
              where p.oid in ('public.publish_ai_prompt_version(text,text,text,uuid)'::regprocedure,
                              'public.activate_ai_prompt_version(text,uuid,uuid,text)'::regprocedure,
                              'app_private.ai_prompt_append_only()'::regprocedure,
                              'app_private.ai_prompt_body_valid(text)'::regprocedure,
                              'app_private.ai_prompt_note_valid(text)'::regprocedure,
                              'app_private.guard_unit_setting_value()'::regprocedure,
                              'app_private.unit_setting_value_limit(text)'::regprocedure,
                              'app_private.unit_setting_write_class(text)'::regprocedure)
                and x.grantee = 0) then
    ruins := ruins || ' public_tem_execute'; end if;
  if not exists (select 1 from pg_proc where oid = 'app_private.guard_unit_setting_value()'::regprocedure
                  and prosecdef and proconfig = array['search_path=""']) then
    ruins := ruins || ' guard_valor_sem_definer_ou_search_path'; end if;
  if (select count(*) from pg_proc
       where oid in ('app_private.unit_setting_value_limit(text)'::regprocedure,
                     'app_private.ai_prompt_body_valid(text)'::regprocedure,
                     'app_private.ai_prompt_note_valid(text)'::regprocedure,
                     'app_private.unit_setting_write_class(text)'::regprocedure)
         and provolatile = 'i' and proconfig = array['search_path=""']) <> 4 then
    ruins := ruins || ' validadores_nao_immutable_ou_search_path'; end if;
  insert into t_res values (7812, 'P7 RPCs: authenticated executa, anon/service_role/PUBLIC nao, SECURITY DEFINER e search_path vazio; trigger functions, validadores, guard de valor, limite e classe sem EXECUTE para ninguem (proacl so do dono)',
    case when ruins = '' then 'PASSOU' else 'FALHOU' || ruins end);
end $$;

do $$
declare ruins text := ''; t text; p text; v_pol text;
begin
  foreach t in array array['ai_prompt_versions', 'ai_prompt_slots', 'ai_prompt_activations'] loop
    if not exists (select 1 from pg_class where oid = ('public.' || t)::regclass
                    and relrowsecurity and relforcerowsecurity) then
      ruins := ruins || ' sem_force_rls:' || t; end if;
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege('anon', 'public.' || t, p) then ruins := ruins || ' anon:' || t || ':' || p; end if;
      if p <> 'SELECT' and has_table_privilege('authenticated', 'public.' || t, p) then
        ruins := ruins || ' authenticated:' || t || ':' || p; end if;
      if p <> 'SELECT' and has_table_privilege('service_role', 'public.' || t, p) then
        ruins := ruins || ' service_role:' || t || ':' || p; end if;
    end loop;
    if not has_table_privilege('authenticated', 'public.' || t, 'SELECT') then ruins := ruins || ' authenticated_sem_select:' || t; end if;
    if not has_table_privilege('service_role', 'public.' || t, 'SELECT') then ruins := ruins || ' service_role_sem_select:' || t; end if;
    select string_agg(policyname || '=' || cmd || ':' || array_to_string(roles, ',') || ':' || qual || ':' || coalesce(with_check, '-'), ' ; ')
      into v_pol from pg_policies where schemaname = 'public' and tablename = t;
    -- `(select auth.uid())`: avaliado uma vez por consulta (lint auth_rls_initplan).
    if v_pol is distinct from 'platform_admin_read_' || t || '=SELECT:authenticated:app_private.is_platform_admin(( SELECT auth.uid() AS uid)):-' then
      ruins := ruins || ' policies:' || t || '=' || coalesce(v_pol, '<nenhuma>'); end if;
  end loop;
  insert into t_res values (7813, 'P7 tabelas: ENABLE + FORCE RLS; anon sem privilegio; authenticated e service_role so SELECT; uma policy so, SELECT to authenticated com is_platform_admin',
    case when ruins = '' then 'PASSOU' else 'FALHOU' || ruins end);
end $$;

-- ─── P9: quem lê ─────────────────────────────────────────────────────────────
do $$
declare ruins text := ''; t text; r text; n text;
  pa constant uuid := 'a0d78000-0000-4000-8000-0000000000c1';
begin
  foreach t in array array['ai_prompt_versions', 'ai_prompt_slots', 'ai_prompt_activations'] loop
    execute format('select count(*)::text from public.%I', t) into n;
    r := pg_temp.s78_sel('authenticated', pa, format('select count(*)::text from public.%I', t));
    if r <> 'ok:' || n then ruins := ruins || ' admin:' || t || '=' || r; end if;
    r := pg_temp.s78_sel('service_role', null, format('select count(*)::text from public.%I', t));
    if r <> 'ok:' || n then ruins := ruins || ' service_role:' || t || '=' || r; end if;
    r := pg_temp.s78_sel('authenticated', 'a0d78000-0000-4000-8000-0000000000a1', format('select count(*)::text from public.%I', t));
    if r <> 'ok:0' then ruins := ruins || ' owner:' || t || '=' || r; end if;
    r := pg_temp.s78_sel('authenticated', null, format('select count(*)::text from public.%I', t));
    if r <> 'ok:0' then ruins := ruins || ' sem_sub:' || t || '=' || r; end if;
    r := pg_temp.s78_sel('anon', null, format('select count(*)::text from public.%I', t));
    if r not like '42501:permission denied for table%' then ruins := ruins || ' anon:' || t || '=' || r; end if;
  end loop;
  insert into t_res values (7814, 'P9 leitura: admin e service_role leem tudo; owner da loja e authenticated sem sub leem zero linhas; anon sem permissao',
    case when ruins = '' then 'PASSOU' else 'FALHOU' || ruins end);
end $$;

-- ─── V1: gerente e owner gravam as 3 chaves factuais ─────────────────────────
do $$
declare k text; r text; ruins text := ''; who uuid;
  u1 constant uuid := 'a0d78000-0000-4000-8000-0000000000aa';
begin
  foreach who in array array['a0d78000-0000-4000-8000-0000000000a2'::uuid, 'a0d78000-0000-4000-8000-0000000000a1'::uuid] loop
    foreach k in array array['restaurant_menu', 'delivery_response', 'restaurant_extra_info'] loop
      r := pg_temp.s78_try('authenticated', who, pg_temp.s78_ups(u1, k, pg_temp.s78_str('V1 ' || who || ' ' || k)));
      if r <> 'ok' or pg_temp.s78_val(u1, k) <> pg_temp.s78_str('V1 ' || who || ' ' || k) then
        ruins := ruins || ' ' || k || '=' || r || '/' || pg_temp.s78_val(u1, k); end if;
    end loop;
  end loop;
  insert into t_res values (7815, 'V1 gerente e owner U1: upsert de restaurant_menu, delivery_response e restaurant_extra_info gravados',
    case when ruins = '' then 'PASSOU' else 'FALHOU' || ruins end);
end $$;

-- ─── V2: o role guard continua primeiro ──────────────────────────────────────
-- Operador nas 3 chaves (valor válido E valor inválido: a recusa é a do papel,
-- então o guard de valor não vira oráculo); gerente nas 5 chaves platform.
do $$
declare k text; r text; ruins text := ''; v0 text;
  u1 constant uuid := 'a0d78000-0000-4000-8000-0000000000aa';
  op constant uuid := 'a0d78000-0000-4000-8000-0000000000a3';
  ger constant uuid := 'a0d78000-0000-4000-8000-0000000000a2';
  f constant text := '42501:setting_write_forbidden';
begin
  foreach k in array array['restaurant_menu', 'delivery_response', 'restaurant_extra_info'] loop
    v0 := pg_temp.s78_val(u1, k);
    r := pg_temp.s78_try('authenticated', op, pg_temp.s78_ups(u1, k, pg_temp.s78_str('V2 op')));
    if r <> f then ruins := ruins || ' op:' || k || '=' || r; end if;
    r := pg_temp.s78_try('authenticated', op, pg_temp.s78_ups(u1, k, pg_temp.s78_str(repeat('x', 7000))));
    if r <> f then ruins := ruins || ' op_invalido:' || k || '=' || r; end if;
    if pg_temp.s78_val(u1, k) <> v0 then ruins := ruins || ' op_gravou:' || k; end if;
  end loop;
  foreach k in array array['ai_system_prompt', 'ai_context_extra', 'agent_mode', 'agent_name', 'ai_config'] loop
    v0 := pg_temp.s78_val(u1, k);
    r := pg_temp.s78_try('authenticated', ger, pg_temp.s78_ups(u1, k, pg_temp.s78_str('reservations')));
    if r <> f then ruins := ruins || ' ger:' || k || '=' || r; end if;
    if pg_temp.s78_val(u1, k) <> v0 then ruins := ruins || ' ger_gravou:' || k; end if;
  end loop;
  insert into t_res values (7816, 'V2 operador U1 nas 3 chaves (valor valido e invalido) e gerente U1 nas 5 chaves platform: 42501 setting_write_forbidden, nada gravado',
    case when ruins = '' then 'PASSOU' else 'FALHOU' || ruins end);
end $$;

-- ─── V3: valor inválido em restaurant_menu, gerente e service_role ───────────
do $$
declare j text; r text; ruins text := ''; v0 text; who record;
  u1 constant uuid := 'a0d78000-0000-4000-8000-0000000000aa';
  f constant text := '22023:setting_value_invalid';
begin
  v0 := pg_temp.s78_val(u1, 'restaurant_menu');
  for who in select * from (values ('authenticated', 'a0d78000-0000-4000-8000-0000000000a2'::uuid),
                                   ('service_role', null::uuid)) as t(role, sub) loop
    foreach j in array array[pg_temp.s78_str(repeat('x', 6001)), '{"a":1}', '42', 'true', 'null', '["x"]',
                             pg_temp.s78_str('sino ' || chr(7)), pg_temp.s78_str('cr ' || chr(13))] loop
      r := pg_temp.s78_try(who.role, who.sub, pg_temp.s78_ups(u1, 'restaurant_menu', j));
      if r <> f then ruins := ruins || ' ' || who.role || '[' || left(j, 12) || ']=' || r; end if;
    end loop;
  end loop;
  if pg_temp.s78_val(u1, 'restaurant_menu') <> v0 then ruins := ruins || ' gravou=' || left(pg_temp.s78_val(u1, 'restaurant_menu'), 30); end if;
  r := pg_temp.s78_try('authenticated', 'a0d78000-0000-4000-8000-0000000000a2',
         pg_temp.s78_ups(u1, 'restaurant_menu', pg_temp.s78_str(repeat('y', 5998) || E'\n\t')));
  if r <> 'ok' or pg_temp.s78_val(u1, 'restaurant_menu') <> pg_temp.s78_str(repeat('y', 5998) || E'\n\t') then
    ruins := ruins || ' borda_6000=' || r; end if;
  insert into t_res values (7817, 'V3 restaurant_menu com 6001, objeto, numero, booleano, null, array, \x07 e \r, como gerente e service_role: 22023 setting_value_invalid, nada gravado; 6000 com \n\t aceito',
    case when ruins = '' then 'PASSOU' else 'FALHOU' || ruins end);
end $$;

-- ─── V3b: cada limite da tabela, pelo admin (o role guard deixa passar) ──────
-- Lista literal independente da função: se a migration perder ou mudar um
-- limite, este caso falha. Também mede postgres sem claims (migration).
do $$
declare r text; ruins text := ''; kv record;
  u1 constant uuid := 'a0d78000-0000-4000-8000-0000000000aa';
  pa constant uuid := 'a0d78000-0000-4000-8000-0000000000c1';
  f constant text := '22023:setting_value_invalid';
begin
  for kv in select * from (values ('restaurant_menu', 6000), ('restaurant_extra_info', 3000),
                                  ('delivery_response', 1500), ('rules_and_conditions', 3000),
                                  ('additional_info', 2000), ('ai_context_extra', 3000),
                                  ('ai_system_prompt', 4000), ('agent_name', 40)) as t(k, lim) loop
    r := pg_temp.s78_try('authenticated', pa, pg_temp.s78_ups(u1, kv.k, pg_temp.s78_str(repeat('a', kv.lim))));
    if r <> 'ok' then ruins := ruins || ' ' || kv.k || '@lim=' || r; end if;
    r := pg_temp.s78_try('authenticated', pa, pg_temp.s78_ups(u1, kv.k, pg_temp.s78_str(repeat('a', kv.lim + 1))));
    if r <> f then ruins := ruins || ' ' || kv.k || '@lim+1=' || r; end if;
    r := pg_temp.s78_try('authenticated', pa, pg_temp.s78_ups(u1, kv.k, '7'));
    if r <> f then ruins := ruins || ' ' || kv.k || '@numero=' || r; end if;
    r := pg_temp.s78_try(null, null, pg_temp.s78_ups(u1, kv.k, pg_temp.s78_str(repeat('a', kv.lim + 1))));
    if r <> f then ruins := ruins || ' ' || kv.k || '@postgres=' || r; end if;
    if pg_temp.s78_val(u1, kv.k) <> pg_temp.s78_str(repeat('a', kv.lim)) then
      ruins := ruins || ' ' || kv.k || '@valor_mudou'; end if;
  end loop;
  insert into t_res values (7818, 'V3b admin e postgres sem claims: cada uma das 8 chaves de texto aceita o limite e recusa limite+1 e numero com 22023',
    case when ruins = '' then 'PASSOU' else 'FALHOU' || ruins end);
end $$;

-- ─── V4: agent_mode no enum ──────────────────────────────────────────────────
do $$
declare a text; b text; c text; d text; e text; g text; v text;
  u1 constant uuid := 'a0d78000-0000-4000-8000-0000000000aa';
  pa constant uuid := 'a0d78000-0000-4000-8000-0000000000c1';
  f constant text := '22023:setting_value_invalid';
begin
  a := pg_temp.s78_try('authenticated', pa, pg_temp.s78_ups(u1, 'agent_mode', '"x"'));
  b := pg_temp.s78_try('authenticated', pa, pg_temp.s78_ups(u1, 'agent_mode', '1'));
  c := pg_temp.s78_try(null, null, pg_temp.s78_ups(u1, 'agent_mode', '"Reservations"'));
  d := pg_temp.s78_try('service_role', null, pg_temp.s78_ups(u1, 'agent_mode', '""'));
  e := pg_temp.s78_try('authenticated', pa, pg_temp.s78_ups(u1, 'agent_mode', '"reservations_faq"'));
  v := pg_temp.s78_val(u1, 'agent_mode');
  g := pg_temp.s78_try('authenticated', pa, pg_temp.s78_ups(u1, 'agent_mode', '"reservations"'));
  insert into t_res values (7819, 'V4 agent_mode "x", numero, maiuscula (postgres) e vazio (service_role): 22023; "reservations_faq" e "reservations" gravados pelo admin',
    case when a = f and b = f and c = f and d = f and e = 'ok' and v = '"reservations_faq"' and g = 'ok'
          and pg_temp.s78_val(u1, 'agent_mode') = '"reservations"' then 'PASSOU'
         else 'FALHOU x=' || a || ' num=' || b || ' maiusc=' || c || ' vazio=' || d || ' faq=' || e || '/' || v || ' res=' || g end);
end $$;

-- ─── V6: chave fora da tabela não é validada ─────────────────────────────────
do $$
declare a text; b text; c text;
  u1 constant uuid := 'a0d78000-0000-4000-8000-0000000000aa';
  pa constant uuid := 'a0d78000-0000-4000-8000-0000000000c1';
  ger constant uuid := 'a0d78000-0000-4000-8000-0000000000a2';
begin
  a := pg_temp.s78_try('authenticated', ger, pg_temp.s78_ups(u1, 'booking_window_days', '30'));
  b := pg_temp.s78_try('authenticated', pa, pg_temp.s78_ups(u1, 'ai_config', '{"provider":"gemini"}'));
  c := pg_temp.s78_try('authenticated', pa, pg_temp.s78_ups(u1, 'foo_bar', pg_temp.s78_str(repeat('z', 9000))));
  insert into t_res values (7820, 'V6 chave fora da tabela: booking_window_days numero (gerente), ai_config objeto e chave desconhecida com 9000 (admin) gravados',
    case when a = 'ok' and b = 'ok' and c = 'ok' and pg_temp.s78_val(u1, 'booking_window_days') = '30'
          and pg_temp.s78_val(u1, 'ai_config') = '{"provider": "gemini"}' then 'PASSOU'
         else 'FALHOU booking=' || a || ' ai_config=' || b || ' foo=' || c end);
end $$;

-- ─── V7: linha legada acima do limite só é recusada ao regravar inválida ─────
do $$
declare a text; b text;
  u1 constant uuid := 'a0d78000-0000-4000-8000-0000000000aa';
  ger constant uuid := 'a0d78000-0000-4000-8000-0000000000a2';
begin
  set session_replication_role = replica;
  update public.settings set value = to_jsonb(repeat('L', 7000)) where unit_id = u1 and key = 'delivery_response';
  set session_replication_role = origin;
  a := pg_temp.s78_try('authenticated', ger,
         format('update public.settings set value = value where unit_id = %L and key = %L', u1, 'delivery_response'));
  b := pg_temp.s78_try('authenticated', ger, pg_temp.s78_ups(u1, 'delivery_response', pg_temp.s78_str('V7 curto')));
  insert into t_res values (7821, 'V7 delivery_response legado com 7000: regravar o mesmo valor recusa (22023); gerente regrava valor valido e passa',
    case when a = '22023:setting_value_invalid' and b = 'ok'
          and pg_temp.s78_val(u1, 'delivery_response') = '"V7 curto"' then 'PASSOU'
         else 'FALHOU mesmo=' || a || ' curto=' || b end);
end $$;

-- ─── Controles positivos: cada guard enxerga o defeito ───────────────────────
-- Cada um num subbloco desfeito por raise (DDL é transacional). As mutações
-- partem do corpo instalado (pg_get_functiondef) e falham se o trecho sumir.
-- Depois, o guard real volta e recusa.
create or replace function pg_temp.s78_cut(p_fn regprocedure, p_mark text, p_repl text)
returns text language plpgsql as $$
declare v_def text := pg_get_functiondef(p_fn); v_mut text;
begin
  v_mut := regexp_replace(v_def, '-- <' || p_mark || '>.*?-- </' || p_mark || '>', p_repl);
  if v_mut = v_def then raise exception 'controle: marcador % ausente em %', p_mark, p_fn; end if;
  return v_mut;
end $$;

-- C1: sem o trigger append-only, o dono reescreve a história.
do $$
declare p1 text := '<nao rodou>'; p2 text := '<nao rodou>'; d1 text; d2 text; s0 text := pg_temp.s78_state();
  f constant text := '42501:ai_prompt_history_append_only';
begin
  begin
    drop trigger ai_prompt_versions_append_only on public.ai_prompt_versions;
    drop trigger ai_prompt_activations_append_only on public.ai_prompt_activations;
    p1 := pg_temp.s78_try(null, null, 'update public.ai_prompt_versions set note = ''C1'' where version = 1');
    p2 := pg_temp.s78_try(null, null, 'delete from public.ai_prompt_activations where kind = ''publish''');
    raise exception 'desfazer controle';
  exception when raise_exception then null;
  end;
  d1 := pg_temp.s78_try(null, null, 'update public.ai_prompt_versions set note = ''C1'' where version = 1');
  d2 := pg_temp.s78_try(null, null, 'delete from public.ai_prompt_activations where kind = ''publish''');
  insert into t_res values (7822, 'C1 sem o trigger append-only o dono reescreve versoes e apaga ledger; com ele de volta, recusa',
    case when p1 = 'ok' and p2 = 'ok' and d1 = f and d2 = f and pg_temp.s78_state() = s0 then 'PASSOU'
         else 'FALHOU sem=' || p1 || '/' || p2 || ' com=' || d1 || '/' || d2 end);
end $$;

-- C2: sem o trigger de valor, o gerente grava 6001 em restaurant_menu.
do $$
declare p text := '<nao rodou>'; pv text := '<nao rodou>'; d text; v0 text;
  u1 constant uuid := 'a0d78000-0000-4000-8000-0000000000aa';
  ger constant uuid := 'a0d78000-0000-4000-8000-0000000000a2';
begin
  v0 := pg_temp.s78_val(u1, 'restaurant_menu');
  begin
    drop trigger settings_write_value_guard on public.settings;
    p := pg_temp.s78_try('authenticated', ger, pg_temp.s78_ups(u1, 'restaurant_menu', pg_temp.s78_str(repeat('x', 6001))));
    pv := length(pg_temp.s78_val(u1, 'restaurant_menu'))::text;
    raise exception 'desfazer controle';
  exception when raise_exception then null;
  end;
  d := pg_temp.s78_try('authenticated', ger, pg_temp.s78_ups(u1, 'restaurant_menu', pg_temp.s78_str(repeat('x', 6001))));
  insert into t_res values (7823, 'C2 sem settings_write_value_guard o gerente grava 6001 em restaurant_menu; com ele de volta, 22023',
    case when p = 'ok' and pv = '6003' and d = '22023:setting_value_invalid'
          and pg_temp.s78_val(u1, 'restaurant_menu') = v0 then 'PASSOU'
         else 'FALHOU sem=' || p || '/' || pv || ' com=' || d end);
end $$;

-- C3: classe das 3 chaves de volta a platform: V1 passa a 42501.
do $$
declare p text := '<nao rodou>'; d text; v_def text; v_mut text;
  u1 constant uuid := 'a0d78000-0000-4000-8000-0000000000aa';
  ger constant uuid := 'a0d78000-0000-4000-8000-0000000000a2';
begin
  v_def := pg_get_functiondef('app_private.unit_setting_write_class(text)'::regprocedure);
  begin
    v_mut := replace(replace(replace(v_def, '''restaurant_menu'',', ''), '''delivery_response'',', ''), '''restaurant_extra_info'',', '');
    if v_mut = v_def then raise exception 'C3: chaves factuais nao encontradas no classificador'; end if;
    execute v_mut;
    p := pg_temp.s78_try('authenticated', ger, pg_temp.s78_ups(u1, 'restaurant_menu', pg_temp.s78_str('C3')));
    raise exception 'desfazer controle';
  exception when raise_exception then null;
  end;
  d := pg_temp.s78_try('authenticated', ger, pg_temp.s78_ups(u1, 'restaurant_menu', pg_temp.s78_str('C3')));
  insert into t_res values (7824, 'C3 classificador sem as 3 chaves factuais: gerente recebe setting_write_forbidden; com a classe real, grava',
    case when p = '42501:setting_write_forbidden' and d = 'ok' then 'PASSOU'
         else 'FALHOU sem=' || p || ' com=' || d end);
end $$;

-- C4: o dono das RPCs precisa de BYPASSRLS sob FORCE RLS sem policy de escrita.
-- Localmente o postgres é superusuário (não mede nada). Aqui as tabelas e a RPC
-- passam para um dono NÃO superusuário: sem BYPASSRLS o publish não enxerga o
-- slot; com BYPASSRLS publica. Em produção o dono é o postgres, com
-- rolbypassrls=true medido em 2026-09-27 e 2026-10-17 (reconferir no B6).
do $$
declare p_sem text := '<nao rodou>'; p_com text := '<nao rodou>'; s0 text := pg_temp.s78_state();
  pa constant uuid := 'a0d78000-0000-4000-8000-0000000000c1';
begin
  begin
    create role ai78_owner nologin nosuperuser nobypassrls;
    grant usage on schema public, app_private, auth to ai78_owner;
    grant execute on function app_private.is_platform_admin(uuid), app_private.ai_prompt_body_valid(text),
                              app_private.ai_prompt_note_valid(text) to ai78_owner;
    alter table public.ai_prompt_versions owner to ai78_owner;
    alter table public.ai_prompt_slots owner to ai78_owner;
    alter table public.ai_prompt_activations owner to ai78_owner;
    alter function public.publish_ai_prompt_version(text,text,text,uuid) owner to ai78_owner;
    p_sem := pg_temp.s78_try('authenticated', pa, pg_temp.s78_pub(pg_temp.s78_good_body('C4a'), 'C4 sem bypass', pg_temp.s78_active()));
    alter role ai78_owner bypassrls;
    p_com := pg_temp.s78_try('authenticated', pa, pg_temp.s78_pub(pg_temp.s78_good_body('C4b'), 'C4 com bypass', pg_temp.s78_active()));
    raise exception 'desfazer controle';
  exception when raise_exception then null;
  end;
  insert into t_res values (7825, 'C4 dono nao superusuario sob FORCE RLS: sem BYPASSRLS o publish nao enxerga o slot (22023); com BYPASSRLS publica; tudo desfeito',
    case when p_sem = '22023:prompt_slot_invalid' and p_com = 'ok' and pg_temp.s78_state() = s0
          and not exists (select 1 from pg_roles where rolname = 'ai78_owner')
          and (select relowner::regrole::text from pg_class where oid = 'public.ai_prompt_versions'::regclass) = 'postgres'
         then 'PASSOU'
         else 'FALHOU sem=' || p_sem || ' com=' || p_com || ' estado=' || pg_temp.s78_state() end);
end $$;

-- C5: sem o guard de platform_admin, o owner da loja publica e ativa.
do $$
declare p1 text := '<nao rodou>'; p2 text := '<nao rodou>'; d1 text; d2 text; s0 text := pg_temp.s78_state();
  own constant uuid := 'a0d78000-0000-4000-8000-0000000000a1';
begin
  begin
    execute pg_temp.s78_cut('public.publish_ai_prompt_version(text,text,text,uuid)'::regprocedure, 'guard', '');
    execute pg_temp.s78_cut('public.activate_ai_prompt_version(text,uuid,uuid,text)'::regprocedure, 'guard', '');
    p1 := pg_temp.s78_try('authenticated', own, pg_temp.s78_pub(pg_temp.s78_good_body('C5'), 'C5 owner', pg_temp.s78_active()));
    p2 := pg_temp.s78_try('authenticated', own, pg_temp.s78_act(pg_temp.s78_vid(3), pg_temp.s78_active(), 'C5 owner'));
    raise exception 'desfazer controle';
  exception when raise_exception then null;
  end;
  d1 := pg_temp.s78_try('authenticated', own, pg_temp.s78_pub(pg_temp.s78_good_body('C5'), 'C5 owner', pg_temp.s78_active()));
  d2 := pg_temp.s78_try('authenticated', own, pg_temp.s78_act(pg_temp.s78_vid(3), pg_temp.s78_active(), 'C5 owner'));
  insert into t_res values (7826, 'C5 RPCs sem o guard de platform_admin: owner da loja publica e ativa; com o guard real, prompt_forbidden',
    case when p1 = 'ok' and p2 = 'ok' and d1 = '42501:prompt_forbidden' and d2 = d1 and pg_temp.s78_state() = s0 then 'PASSOU'
         else 'FALHOU sem=' || p1 || '/' || p2 || ' com=' || d1 || '/' || d2 end);
end $$;

-- C6: sem a checagem de expected, o admin B atrasado sobrescreve.
do $$
declare p1 text := '<nao rodou>'; p2 text := '<nao rodou>'; d1 text; d2 text; s0 text := pg_temp.s78_state();
  pb constant uuid := 'a0d78000-0000-4000-8000-0000000000c2';
begin
  begin
    execute pg_temp.s78_cut('public.publish_ai_prompt_version(text,text,text,uuid)'::regprocedure, 'conflict', '');
    execute pg_temp.s78_cut('public.activate_ai_prompt_version(text,uuid,uuid,text)'::regprocedure, 'conflict', '');
    p1 := pg_temp.s78_try('authenticated', pb, pg_temp.s78_pub(pg_temp.s78_good_body('C6'), 'C6 atrasado', pg_temp.s78_vid(2)));
    p2 := pg_temp.s78_try('authenticated', pb, pg_temp.s78_act(pg_temp.s78_vid(3), pg_temp.s78_vid(2), 'C6 atrasado'));
    raise exception 'desfazer controle';
  exception when raise_exception then null;
  end;
  d1 := pg_temp.s78_try('authenticated', pb, pg_temp.s78_pub(pg_temp.s78_good_body('C6'), 'C6 atrasado', pg_temp.s78_vid(2)));
  d2 := pg_temp.s78_try('authenticated', pb, pg_temp.s78_act(pg_temp.s78_vid(3), pg_temp.s78_vid(2), 'C6 atrasado'));
  insert into t_res values (7827, 'C6 RPCs sem a checagem de expected: admin B com expected velho publica e ativa; com ela, 40001',
    case when p1 = 'ok' and p2 = 'ok' and d1 = '40001:prompt_version_conflict' and d2 = d1 and pg_temp.s78_state() = s0 then 'PASSOU'
         else 'FALHOU sem=' || p1 || '/' || p2 || ' com=' || d1 || '/' || d2 end);
end $$;

-- C7: validação de corpo e nota. (a) sem a checagem explícita da RPC, o CHECK
-- da tabela ainda barra (23514): é a rede. (b) com o validador neutralizado,
-- corpo e nota inválidos passam: ele é a única régua das duas camadas.
do $$
declare a1 text := '<nao rodou>'; a2 text := '<nao rodou>'; b1 text := '<nao rodou>'; b2 text := '<nao rodou>';
  d1 text; d2 text; s0 text := pg_temp.s78_state();
  pa constant uuid := 'a0d78000-0000-4000-8000-0000000000c1';
begin
  begin
    execute pg_temp.s78_cut('public.publish_ai_prompt_version(text,text,text,uuid)'::regprocedure, 'body-check', '');
    execute pg_temp.s78_cut('public.publish_ai_prompt_version(text,text,text,uuid)'::regprocedure, 'note-check', '');
    a1 := pg_temp.s78_try('authenticated', pa, pg_temp.s78_pub('ola {{x}}', 'C7a', pg_temp.s78_active()));
    a2 := pg_temp.s78_try('authenticated', pa, pg_temp.s78_pub(pg_temp.s78_good_body('C7a'), '', pg_temp.s78_active()));
    raise exception 'desfazer controle';
  exception when raise_exception then null;
  end;
  begin
    execute 'create or replace function app_private.ai_prompt_body_valid(p_body text) returns boolean '
            'language sql immutable set search_path = '''' as $f$ select true $f$';
    execute 'create or replace function app_private.ai_prompt_note_valid(p_note text) returns boolean '
            'language sql immutable set search_path = '''' as $f$ select true $f$';
    b1 := pg_temp.s78_try('authenticated', pa, pg_temp.s78_pub('ola {{x}} <<<', 'C7b', pg_temp.s78_active()));
    b2 := pg_temp.s78_try('authenticated', pa, pg_temp.s78_act(pg_temp.s78_vid(3), pg_temp.s78_active(), ''));
    raise exception 'desfazer controle';
  exception when raise_exception then null;
  end;
  d1 := pg_temp.s78_try('authenticated', pa, pg_temp.s78_pub('ola {{x}} <<<', 'C7b', pg_temp.s78_active()));
  d2 := pg_temp.s78_try('authenticated', pa, pg_temp.s78_act(pg_temp.s78_vid(3), pg_temp.s78_active(), ''));
  insert into t_res values (7828, 'C7 sem a checagem da RPC o CHECK barra (23514); com o validador neutralizado corpo e nota invalidos passam; com os reais, 22023',
    case when a1 like '23514:%ai_prompt_versions_body_check%' and a2 like '23514:%ai_prompt_versions_note_check%'
          and b1 = 'ok' and b2 = 'ok'
          and d1 = '22023:prompt_body_invalid' and d2 = '22023:prompt_note_invalid' and pg_temp.s78_state() = s0 then 'PASSOU'
         else 'FALHOU sem_rpc=' || a1 || '/' || a2 || ' neutro=' || b1 || '/' || b2 || ' real=' || d1 || '/' || d2 end);
end $$;

-- C8: sem a checagem explícita da versão, a FK composta barra (23503) a
-- inexistente, e a já ativa vira rollback vazio no ledger.
do $$
declare p1 text := '<nao rodou>'; p2 text := '<nao rodou>'; d1 text; d2 text; s0 text := pg_temp.s78_state();
  pa constant uuid := 'a0d78000-0000-4000-8000-0000000000c1';
  ghost constant uuid := 'a0d78000-0000-4000-8000-0000000000ff';
begin
  begin
    execute pg_temp.s78_cut('public.activate_ai_prompt_version(text,uuid,uuid,text)'::regprocedure, 'version-check', '');
    p1 := pg_temp.s78_try('authenticated', pa, pg_temp.s78_act(ghost, pg_temp.s78_active(), 'C8 inexistente'));
    p2 := pg_temp.s78_try('authenticated', pa, pg_temp.s78_act(pg_temp.s78_active(), pg_temp.s78_active(), 'C8 ja ativa'));
    raise exception 'desfazer controle';
  exception when raise_exception then null;
  end;
  d1 := pg_temp.s78_try('authenticated', pa, pg_temp.s78_act(ghost, pg_temp.s78_active(), 'C8 inexistente'));
  d2 := pg_temp.s78_try('authenticated', pa, pg_temp.s78_act(pg_temp.s78_active(), pg_temp.s78_active(), 'C8 ja ativa'));
  insert into t_res values (7829, 'C8 activate sem a checagem da versao: inexistente cai na FK composta (23503) e a ja ativa grava rollback vazio; com ela, 22023',
    case when p1 like '23503:%' and p2 = 'ok' and d1 = '22023:prompt_version_invalid' and d2 = d1
          and pg_temp.s78_state() = s0 then 'PASSOU'
         else 'FALHOU sem=' || p1 || '/' || p2 || ' com=' || d1 || '/' || d2 end);
end $$;

-- ─── P8: reaplicar a migration depois das publicações ────────────────────────
-- Antes, o slot sai da v1 (o P5 o deixou lá): só assim o P8 distingue "o seed
-- não mexe no slot" de "o seed devolve o slot à v1".
do $$
declare r text;
begin
  r := pg_temp.s78_try('authenticated', 'a0d78000-0000-4000-8000-0000000000c1',
         pg_temp.s78_act(pg_temp.s78_vid(3), pg_temp.s78_vid(1), 'P8 sair da v1'));
  if r <> 'ok' or pg_temp.s78_active() <> pg_temp.s78_vid(3) then
    raise exception '78: preparo do P8 falhou (%): o slot tinha de ir para a v3', r;
  end if;
end $$;

create temp table if not exists t78_antes (estado text, ativa uuid);
delete from t78_antes;
insert into t78_antes select pg_temp.s78_state(), pg_temp.s78_active();

\i supabase/migrations/20261020150000_ai_global_prompt_and_settings_value_guard.sql

do $$
declare ruins text := ''; v_n int; t text;
begin
  if pg_temp.s78_state() <> (select estado from t78_antes) then
    ruins := ruins || ' estado ' || (select estado from t78_antes) || ' -> ' || pg_temp.s78_state(); end if;
  if (select count(*) from public.ai_prompt_versions where version = 1) <> 1 then ruins := ruins || ' v1_duplicada'; end if;
  if (select count(*) from public.ai_prompt_activations where kind = 'seed') <> 1 then ruins := ruins || ' seed_duplicado'; end if;
  if (select count(*) from public.ai_prompt_slots) <> 1 then ruins := ruins || ' slots'; end if;
  foreach t in array array['ai_prompt_versions_append_only', 'ai_prompt_versions_no_truncate'] loop
    select count(*) into v_n from pg_trigger where tgrelid = 'public.ai_prompt_versions'::regclass and tgname = t;
    if v_n <> 1 then ruins := ruins || ' ' || t || '=' || v_n; end if;
  end loop;
  foreach t in array array['ai_prompt_activations_append_only', 'ai_prompt_activations_no_truncate'] loop
    select count(*) into v_n from pg_trigger where tgrelid = 'public.ai_prompt_activations'::regclass and tgname = t;
    if v_n <> 1 then ruins := ruins || ' ' || t || '=' || v_n; end if;
  end loop;
  -- tgtype 23 = ROW(1) + BEFORE(2) + INSERT(4) + UPDATE(16).
  select count(*) into v_n from pg_trigger
   where tgrelid = 'public.settings'::regclass and tgname = 'settings_write_value_guard'
     and tgfoid = 'app_private.guard_unit_setting_value()'::regprocedure and tgtype = 23 and tgenabled = 'O';
  if v_n <> 1 then ruins := ruins || ' value_guard=' || v_n; end if;
  select count(*) into v_n from pg_trigger
   where tgrelid = 'public.settings'::regclass and tgname in ('settings_write_role_guard', 'whatsapp_legacy_template_write');
  if v_n <> 2 then ruins := ruins || ' outros_triggers=' || v_n; end if;
  if (select count(*) from pg_policies where schemaname = 'public'
        and tablename in ('ai_prompt_versions', 'ai_prompt_slots', 'ai_prompt_activations')) <> 3 then
    ruins := ruins || ' policies'; end if;
  -- O slot estava na v3; o seed reaplicado não pode devolvê-lo à v1.
  if pg_temp.s78_active() is distinct from (select ativa from t78_antes)
     or pg_temp.s78_active() <> pg_temp.s78_vid(3) then ruins := ruins || ' slot_mudou'; end if;
  foreach t in array array['ai_prompt_slots_no_delete', 'ai_prompt_slots_no_truncate'] loop
    select count(*) into v_n from pg_trigger where tgrelid = 'public.ai_prompt_slots'::regclass and tgname = t;
    if v_n <> 1 then ruins := ruins || ' ' || t || '=' || v_n; end if;
  end loop;
  insert into t_res values (7830, 'P8 migration reaplicada com o slot na v3: historia e slot intactos (nao volta a v1), uma v1, um seed, um trigger de cada, tres policies',
    case when ruins = '' then 'PASSOU' else 'FALHOU' || ruins end);
end $$;

-- C9: controle do P8. Um seed de slot com `do update` (a regressão que o P8
-- existe para pegar) devolveria o slot à v1, e a checagem do P8 acusaria.
do $$
declare v_depois uuid; s0 text := pg_temp.s78_state();
begin
  begin
    insert into public.ai_prompt_slots (slot, active_version_id, activated_at, activated_by)
    select v.slot, v.id, now(), null from public.ai_prompt_versions v
     where v.slot = 'global_persona' and v.version = 1
    on conflict (slot) do update set active_version_id = excluded.active_version_id;
    v_depois := pg_temp.s78_active();
    raise exception 'desfazer controle';
  exception when raise_exception then null;
  end;
  insert into t_res values (7831, 'C9 seed de slot com do update devolveria o slot a v1 (o P8 acusaria); desfeito, slot segue na v3',
    case when v_depois = pg_temp.s78_vid(1) and v_depois is distinct from (select ativa from t78_antes)
          and pg_temp.s78_active() = pg_temp.s78_vid(3) and pg_temp.s78_state() = s0 then 'PASSOU'
         else 'FALHOU com_do_update=' || coalesce(v_depois::text, '<null>') || ' estado=' || pg_temp.s78_state() end);
end $$;

select ord, caso, veredito from t_res where ord between 7801 and 7831 order by ord;
select count(*) as total, count(*) filter (where veredito = 'PASSOU') as passou
  from t_res where ord between 7801 and 7831;   -- esperado: 31 e 31
