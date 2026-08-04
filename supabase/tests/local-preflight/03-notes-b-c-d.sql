-- NOTE-B, NOTE-C, NOTE-D de supabase/tests/whatsapp-instances.integration.md
-- mais o CONTROLE POSITIVO do NOTE-B (o defeito que a 089 pagou).
--
-- Cada caso roda numa subtransação própria; exceção esperada é capturada e
-- comparada. Um caso "passa" só se o resultado for o previsto no roteiro —
-- exceção onde se espera exceção, sucesso onde se espera sucesso.

create table if not exists t_res (
  ord serial, caso text, esperado text, obtido text, veredito text
);
truncate t_res restart identity;

do $$
declare
  v_backfill uuid;   -- id da linha backfilada (instância ...0001)
  v_orfa     uuid;   -- linha que vai ficar com instance_id nulo (C5)
  v_del      uuid;   -- linha da instância descartável (B)
  v_err      text;
begin
  select id into v_backfill from whatsapp_instance_notes
   where instance_ref = 'cccccccc-0000-0000-0000-000000000001';

  -- ---------------------------------------------------------------
  -- NOTE-B — apagar a instância NÃO apaga a observação
  -- ---------------------------------------------------------------
  insert into whatsapp_instance_notes
    (instance_ref, instance_id, organization_id, action, note, created_by)
  values ('cccccccc-0000-0000-0000-000000000009', 'cccccccc-0000-0000-0000-000000000009',
          'aaaaaaaa-0000-0000-0000-000000000001', 'SET_COST', 'custo informado pelo painel',
          '22222222-2222-2222-2222-222222222222')
  returning id into v_del;

  begin
    delete from whatsapp_instances where id = 'cccccccc-0000-0000-0000-000000000009';
    insert into t_res (caso, esperado, obtido, veredito)
    select 'NOTE-B  DELETE da instancia conclui', 'sem excecao', 'sem excecao', 'PASS';
  exception when others then
    get stacked diagnostics v_err = message_text;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-B  DELETE da instancia conclui', 'sem excecao', 'EXCECAO: ' || v_err, 'FAIL');
  end;

  insert into t_res (caso, esperado, obtido, veredito)
  select 'NOTE-B  observacao sobrevive, instance_id nulo, instance_ref intacto',
         'linha viva / null / ref intacto',
         case when n.id is null then 'linha APAGADA'
              else (case when n.instance_id is null then 'null' else 'nao-null' end)
                   || ' / ' || coalesce(n.instance_ref::text, '(sem ref)') end,
         case when n.id is not null and n.instance_id is null
                   and n.instance_ref = 'cccccccc-0000-0000-0000-000000000009'
              then 'PASS' else 'FAIL' end
  from (select 1) x left join whatsapp_instance_notes n on n.id = v_del;

  -- ---------------------------------------------------------------
  -- NOTE-C 1..3 — append-only
  -- ---------------------------------------------------------------
  begin
    update whatsapp_instance_notes set note = 'outro texto' where id = v_backfill;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-C1 update de note', 'check_violation', 'SEM excecao', 'FAIL');
  exception when check_violation then
    get stacked diagnostics v_err = message_text;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-C1 update de note', 'check_violation', v_err, 'PASS');
  end;

  begin
    update whatsapp_instance_notes set action = 'UPDATE' where id = v_backfill;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-C2 update de action', 'check_violation', 'SEM excecao', 'FAIL');
  exception when check_violation then
    get stacked diagnostics v_err = message_text;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-C2 update de action', 'check_violation', v_err, 'PASS');
  end;

  begin
    update whatsapp_instance_notes set instance_ref = gen_random_uuid() where id = v_backfill;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-C3 update de instance_ref', 'check_violation', 'SEM excecao', 'FAIL');
  exception when check_violation then
    get stacked diagnostics v_err = message_text;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-C3 update de instance_ref', 'check_violation', v_err, 'PASS');
  end;

  -- ---------------------------------------------------------------
  -- NOTE-C 4..7 — as quatro transições de instance_id
  -- ---------------------------------------------------------------
  -- 4: inalterado → passa
  begin
    update whatsapp_instance_notes set instance_id = instance_id where id = v_backfill;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-C4 instance_id inalterado', 'sem excecao', 'sem excecao', 'PASS');
  exception when others then
    get stacked diagnostics v_err = message_text;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-C4 instance_id inalterado', 'sem excecao', 'EXCECAO: ' || v_err, 'FAIL');
  end;

  -- 5: uuid → NULL → passa (é o que a FK faz sozinha)
  insert into whatsapp_instance_notes
    (instance_ref, instance_id, organization_id, action, note, created_by)
  values ('cccccccc-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000002',
          'aaaaaaaa-0000-0000-0000-000000000001', 'UPDATE', 'linha para o caso C5/C7',
          '11111111-1111-1111-1111-111111111111')
  returning id into v_orfa;

  begin
    update whatsapp_instance_notes set instance_id = null where id = v_orfa;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-C5 instance_id uuid -> NULL', 'sem excecao', 'sem excecao', 'PASS');
  exception when others then
    get stacked diagnostics v_err = message_text;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-C5 instance_id uuid -> NULL', 'sem excecao', 'EXCECAO: ' || v_err, 'FAIL');
  end;

  -- 6: uuid → OUTRO uuid (mesma organização) → recusa
  begin
    update whatsapp_instance_notes
       set instance_id = 'cccccccc-0000-0000-0000-000000000004' where id = v_backfill;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-C6 instance_id uuid -> outro uuid', 'check_violation', 'SEM excecao', 'FAIL');
  exception when check_violation then
    get stacked diagnostics v_err = message_text;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-C6 instance_id uuid -> outro uuid', 'check_violation', v_err, 'PASS');
  end;

  -- 7: NULL → uuid → recusa (a divergência deliberada contra a 089)
  begin
    update whatsapp_instance_notes
       set instance_id = 'cccccccc-0000-0000-0000-000000000004' where id = v_orfa;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-C7 instance_id NULL -> uuid', 'check_violation', 'SEM excecao', 'FAIL');
  exception when check_violation then
    get stacked diagnostics v_err = message_text;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-C7 instance_id NULL -> uuid', 'check_violation', v_err, 'PASS');
  end;

  -- ---------------------------------------------------------------
  -- NOTE-D — rigor de INSERT
  -- ---------------------------------------------------------------
  begin
    insert into whatsapp_instance_notes
      (instance_ref, instance_id, organization_id, action, note)
    values (gen_random_uuid(), null, 'aaaaaaaa-0000-0000-0000-000000000001', 'UPDATE', 'x');
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-D1 insert com instance_id nulo', 'check_violation', 'SEM excecao', 'FAIL');
  exception when check_violation then
    get stacked diagnostics v_err = message_text;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-D1 insert com instance_id nulo', 'check_violation', v_err, 'PASS');
  end;

  begin
    insert into whatsapp_instance_notes
      (instance_ref, instance_id, organization_id, action, note)
    values (gen_random_uuid(), 'cccccccc-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-000000000001', 'UPDATE', 'x');
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-D2 insert com ref <> instance_id', 'check_violation', 'SEM excecao', 'FAIL');
  exception when check_violation then
    get stacked diagnostics v_err = message_text;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-D2 insert com ref <> instance_id', 'check_violation', v_err, 'PASS');
  end;

  begin
    insert into whatsapp_instance_notes
      (instance_ref, instance_id, organization_id, action, note)
    values ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-000000000002', 'UPDATE', 'x');
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-D3 insert com organization_id de outra org', 'excecao de tenant', 'SEM excecao', 'FAIL');
  exception when others then
    get stacked diagnostics v_err = message_text;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-D3 insert com organization_id de outra org', 'excecao de tenant', v_err,
            case when v_err like '%outra organizacao%' then 'PASS' else 'FAIL' end);
  end;

  begin
    insert into whatsapp_instance_notes
      (instance_ref, instance_id, organization_id, action, note)
    values ('cccccccc-0000-0000-0000-000000000004', 'cccccccc-0000-0000-0000-000000000004',
            'aaaaaaaa-0000-0000-0000-000000000001', 'UPDATE', '   ');
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-D4 insert com note em branco', 'violacao do CHECK btrim', 'SEM excecao', 'FAIL');
  exception when check_violation then
    get stacked diagnostics v_err = message_text;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-D4 insert com note em branco', 'violacao do CHECK btrim', v_err, 'PASS');
  end;

  -- Controle negativo do NOTE-D: o INSERT LEGÍTIMO passa. Sem ele, "todos os
  -- inserts foram recusados" não distinguiria rigor de tabela quebrada.
  begin
    insert into whatsapp_instance_notes
      (instance_ref, instance_id, organization_id, action, note)
    values ('cccccccc-0000-0000-0000-000000000004', 'cccccccc-0000-0000-0000-000000000004',
            'aaaaaaaa-0000-0000-0000-000000000001', 'REQUEST_CANCELLATION', 'cancelamento pedido no painel');
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-D5 CONTROLE: insert legitimo passa', 'sem excecao', 'sem excecao', 'PASS');
  exception when others then
    get stacked diagnostics v_err = message_text;
    insert into t_res (caso, esperado, obtido, veredito)
    values ('NOTE-D5 CONTROLE: insert legitimo passa', 'sem excecao', 'EXCECAO: ' || v_err, 'FAIL');
  end;
end $$;
