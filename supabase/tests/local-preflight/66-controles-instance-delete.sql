-- CONTROLE-DEL-1/2 — controles positivos dos casos DEL-3 e DEL-4.
-- Rodar SEM ON_ERROR_STOP. Cada sabotagem vive num subbloco desfeito por raise,
-- entao nada precisa de reapply; o fim de cada caso confere o corpo real.

create table if not exists t_res (ord int, caso text, veredito text);

-- ── CONTROLE-DEL-1: sem a checagem de custo em ciclo, DEL-3 apagaria ──
do $$
declare v_def text; v_sab text; v_out text; v_after text;
begin
  v_def := pg_get_functiondef('public.delete_whatsapp_instance_without_cost(uuid,text,uuid)'::regprocedure);
  v_sab := regexp_replace(v_def, 'or exists \(\s*select 1 from whatsapp_instance_cycles.*?is not null\s*\)', '');
  if v_sab = v_def then
    insert into t_res (ord, caso, veredito) values (311, 'CONTROLE-DEL-1 sem checar custo do ciclo, apagaria', 'FALHOU (sabotagem nao casou)');
    return;
  end if;
  begin
    execute v_sab;
    select outcome into v_out from delete_whatsapp_instance_without_cost(
      'de000000-0000-4000-8000-000000000003', 'controle', null);
    raise exception 'desfazer controle';
  exception when raise_exception then null;
  end;
  select outcome into v_after from delete_whatsapp_instance_without_cost(
    'de000000-0000-4000-8000-000000000003', 'controle', null);
  insert into t_res (ord, caso, veredito) values (311, 'CONTROLE-DEL-1 sem checar custo do ciclo, apagaria',
    case when v_out = 'deleted' and v_after = 'has_cost' then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── CONTROLE-DEL-2: sem a checagem de estado, DEL-4 apagaria ──────────
do $$
declare v_def text; v_sab text; v_out text; v_after text;
begin
  v_def := pg_get_functiondef('public.delete_whatsapp_instance_without_cost(uuid,text,uuid)'::regprocedure);
  v_sab := replace(v_def, 'if v_inst.lifecycle_state <> ''ENDED'' then', 'if false then');
  if v_sab = v_def then
    insert into t_res (ord, caso, veredito) values (312, 'CONTROLE-DEL-2 sem checar estado, apagaria ACTIVE', 'FALHOU (sabotagem nao casou)');
    return;
  end if;
  begin
    execute v_sab;
    select outcome into v_out from delete_whatsapp_instance_without_cost(
      'de000000-0000-4000-8000-000000000004', 'controle', null);
    raise exception 'desfazer controle';
  exception when raise_exception then null;
  end;
  select outcome into v_after from delete_whatsapp_instance_without_cost(
    'de000000-0000-4000-8000-000000000004', 'controle', null);
  insert into t_res (ord, caso, veredito) values (312, 'CONTROLE-DEL-2 sem checar estado, apagaria ACTIVE',
    case when v_out = 'deleted' and v_after = 'not_ended' then 'PASSOU' else 'FALHOU' end);
end $$;
