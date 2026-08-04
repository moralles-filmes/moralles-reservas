-- DOIS CONTROLES POSITIVOS. Sem eles, "NOTE-B passou" e "NOTE-C7 passou" não
-- distinguem "a guarda funciona" de "o teste não testa nada".
--
-- CONTROLE 1 reproduz o defeito F-01 que a 089 pagou: com o CHECK exigindo
-- `instance_id is not null`, o DELETE da instância ABORTA.
-- CONTROLE 2 reproduz o defeito LATENTE da 089: com a condição em `<>` puro,
-- a transição NULL → uuid PASSA.
--
-- Os dois alteram o schema de propósito e DESFAZEM a alteração no fim.

do $$
declare v_note uuid; v_err text; begin

-- ═══ CONTROLE 1 — o CHECK da 089 torna o DELETE inexecutável ═══
insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, created_by)
values ('cccccccc-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-000000000001',
        'zapi', 'ACTIVE', '11111111-1111-1111-1111-111111111111');

insert into whatsapp_instance_notes
  (instance_ref, instance_id, organization_id, action, note)
values ('cccccccc-0000-0000-0000-000000000008', 'cccccccc-0000-0000-0000-000000000008',
        'aaaaaaaa-0000-0000-0000-000000000001', 'REGISTER', 'linha do controle positivo')
returning id into v_note;

alter table whatsapp_instance_notes
  add constraint ctrl_089_chk check (instance_id is not null) not valid;

begin
  delete from whatsapp_instances where id = 'cccccccc-0000-0000-0000-000000000008';
  insert into t_res (caso, esperado, obtido, veredito)
  values ('CONTROLE-1 com o CHECK da 089, DELETE aborta', 'check_violation', 'SEM excecao (defeito NAO reproduzido)', 'FAIL');
exception when check_violation then
  get stacked diagnostics v_err = message_text;
  insert into t_res (caso, esperado, obtido, veredito)
  values ('CONTROLE-1 com o CHECK da 089, DELETE aborta', 'check_violation', v_err, 'PASS');
end;

alter table whatsapp_instance_notes drop constraint ctrl_089_chk;

begin
  delete from whatsapp_instances where id = 'cccccccc-0000-0000-0000-000000000008';
  insert into t_res (caso, esperado, obtido, veredito)
  values ('CONTROLE-1b sem o CHECK, o MESMO DELETE conclui', 'sem excecao', 'sem excecao', 'PASS');
exception when others then
  get stacked diagnostics v_err = message_text;
  insert into t_res (caso, esperado, obtido, veredito)
  values ('CONTROLE-1b sem o CHECK, o MESMO DELETE conclui', 'sem excecao', 'EXCECAO: ' || v_err, 'FAIL');
end;

end $$;

-- ═══ CONTROLE 2 — a condição da 089 (`<>` puro) deixa passar NULL → uuid ═══
-- Instala na guarda da 096 a condição EQUIVALENTE à de whatsapp_alert_subject_guard
-- (089) e repete o caso NOTE-C7. Se ele passar, a divergência da 096 é real e o
-- defeito latente da 089 está demonstrado, não argumentado.
create or replace function public.whatsapp_instance_note_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.instance_id is null or new.instance_ref <> new.instance_id then
      raise exception 'observacao nasce apontando instancia viva, com instance_ref igual a ela'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.instance_ref is distinct from old.instance_ref
     or new.organization_id is distinct from old.organization_id
     or new.action is distinct from old.action
     or new.note is distinct from old.note
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'observacao e registro append-only e nao pode ser reescrita'
      using errcode = 'check_violation';
  end if;
  -- ESTA é a condição da 089, textualmente equivalente:
  if old.instance_id is not null and new.instance_id is not null
     and new.instance_id <> old.instance_id then
    raise exception 'instance_id so pode ser nulado pela FK, nunca reapontado'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

do $$
declare v_orfa uuid; v_err text; begin
  select id into v_orfa from whatsapp_instance_notes
   where instance_ref = 'cccccccc-0000-0000-0000-000000000002' and instance_id is null;

  begin
    update whatsapp_instance_notes
       set instance_id = 'cccccccc-0000-0000-0000-000000000004' where id = v_orfa;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('CONTROLE-2 com a condicao da 089, NULL -> uuid PASSA',
            'sem excecao (defeito latente reproduzido)', 'sem excecao', 'PASS');
  exception when others then
    get stacked diagnostics v_err = message_text;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('CONTROLE-2 com a condicao da 089, NULL -> uuid PASSA',
            'sem excecao (defeito latente reproduzido)', 'EXCECAO: ' || v_err, 'FAIL');
  end;

  -- desfaz o vínculo inventado pelo controle
  update whatsapp_instance_notes set instance_id = null where id = v_orfa;
end $$;
