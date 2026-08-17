-- COST-1..4, END-1..4, CORR-1..2, CYCLE-1..3 — comportamento das RPCs das
-- migrations 104 e 105, e a colisao dos dois indices que produzem 23505.
--
-- Cada caso numa subtransacao, veredito em `t_res`. Os ids sao FIXOS: o
-- harness e descartavel e reproduzivel, e id gerado tornaria a leitura do
-- resultado dependente da execucao.
--
-- `t_res` ja existe (criada pelo 03, colunas ord/caso/esperado/obtido/veredito)
-- quando este arquivo roda como parte da sequencia do README. O `create table
-- if not exists` abaixo so cria a versao de 3 colunas quando este arquivo roda
-- ISOLADO (sem 03 antes). Os inserts usam lista de colunas explicita
-- (ord, caso, veredito) para funcionar nos dois casos sem depender de quais
-- colunas a tabela tem.

create table if not exists t_res (ord int, caso text, veredito text);

-- Instancia dedicada a estes casos, para nao interferir com 03/04.
insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, cycle_source)
values ('cc000000-0000-4000-8000-000000000001', (select id from organizations order by id limit 1),
        'zapi', 'ACTIVE', 'ADMIN_CONFIRMED')
on conflict (id) do nothing;

-- ── COST-1: preenche ciclo OPEN sem custo ────────────────────────────
do $$
declare v_filled boolean; v_cycle uuid;
begin
  delete from whatsapp_instance_cycles where instance_id = 'cc000000-0000-4000-8000-000000000001';
  insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on, status)
  values ('cc000000-0000-4000-8000-000000000001',
          (select organization_id from whatsapp_instances where id = 'cc000000-0000-4000-8000-000000000001'),
          date '2026-07-04', date '2026-08-04', 'OPEN');

  select cycle_filled into v_filled
  from set_whatsapp_instance_cost('cc000000-0000-4000-8000-000000000001', 9990, 'PROVIDER_PANEL', 'nota', null);

  select id into v_cycle from whatsapp_instance_cycles
   where instance_id = 'cc000000-0000-4000-8000-000000000001' and status = 'OPEN';

  insert into t_res (ord, caso, veredito) values (51, 'COST-1 preenche ciclo OPEN sem custo',
    case when v_filled
      and (select provider_cost_cents from whatsapp_instance_cycles where id = v_cycle) = 9990
      and (select cost_source from whatsapp_instance_cycles where id = v_cycle) = 'PROVIDER_PANEL'
      and (select cost_snapshot_at from whatsapp_instance_cycles where id = v_cycle) is not null
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── COST-2: NAO sobrescreve custo ja congelado ───────────────────────
do $$
declare v_filled boolean;
begin
  select cycle_filled into v_filled
  from set_whatsapp_instance_cost('cc000000-0000-4000-8000-000000000001', 12000, 'PROVIDER_INVOICE', 'nota', null);

  insert into t_res (ord, caso, veredito) values (52, 'COST-2 nao sobrescreve custo congelado do ciclo',
    case when v_filled = false
      and (select provider_cost_cents from whatsapp_instance_cycles
            where instance_id = 'cc000000-0000-4000-8000-000000000001' and status = 'OPEN') = 9990
      and (select current_monthly_cost_cents from whatsapp_instances
            where id = 'cc000000-0000-4000-8000-000000000001') = 12000
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── COST-3: custo desconhecido nao apaga o custo do ciclo ────────────
do $$
declare v_filled boolean;
begin
  select cycle_filled into v_filled
  from set_whatsapp_instance_cost('cc000000-0000-4000-8000-000000000001', null, null, 'nao sei mais', null);

  insert into t_res (ord, caso, veredito) values (53, 'COST-3 custo desconhecido nao apaga o do ciclo',
    case when v_filled = false
      and (select provider_cost_cents from whatsapp_instance_cycles
            where instance_id = 'cc000000-0000-4000-8000-000000000001' and status = 'OPEN') = 9990
      and (select current_monthly_cost_cents from whatsapp_instances
            where id = 'cc000000-0000-4000-8000-000000000001') is null
      and (select cost_updated_at from whatsapp_instances
            where id = 'cc000000-0000-4000-8000-000000000001') is null
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── COST-4: sem ciclo OPEN, grava so na instancia ────────────────────
do $$
declare v_found boolean; v_cycle uuid; v_filled boolean;
begin
  delete from whatsapp_instance_cycles where instance_id = 'cc000000-0000-4000-8000-000000000001';

  select instance_found, open_cycle_id, cycle_filled into v_found, v_cycle, v_filled
  from set_whatsapp_instance_cost('cc000000-0000-4000-8000-000000000001', 7000, 'ESTIMATED', 'nota', null);

  insert into t_res (ord, caso, veredito) values (54, 'COST-4 sem ciclo OPEN grava so na instancia',
    case when v_found and v_cycle is null and v_filled = false
      and (select current_monthly_cost_cents from whatsapp_instances
            where id = 'cc000000-0000-4000-8000-000000000001') = 7000
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── END-1: com custo, ciclo fecha CLOSED e a projecao e limpa ────────
do $$
declare v_status text;
begin
  insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on, status,
                                        provider_cost_cents, cost_source, cost_snapshot_at)
  values ('cc000000-0000-4000-8000-000000000001',
          (select organization_id from whatsapp_instances where id = 'cc000000-0000-4000-8000-000000000001'),
          date '2026-09-04', date '2026-10-04', 'OPEN', 9990, 'PROVIDER_PANEL', now());
  update whatsapp_instances
     set current_cycle_started_on = date '2026-09-04', current_cycle_due_on = date '2026-10-04'
   where id = 'cc000000-0000-4000-8000-000000000001';

  select closed_cycle_status into v_status
  from confirm_whatsapp_instance_end('cc000000-0000-4000-8000-000000000001', 'verificado no painel', null);

  insert into t_res (ord, caso, veredito) values (55, 'END-1 com custo fecha CLOSED e limpa projecao',
    case when v_status = 'CLOSED'
      and (select lifecycle_state from whatsapp_instances
            where id = 'cc000000-0000-4000-8000-000000000001') = 'ENDED'
      and (select current_cycle_started_on from whatsapp_instances
            where id = 'cc000000-0000-4000-8000-000000000001') is null
      and (select current_cycle_due_on from whatsapp_instances
            where id = 'cc000000-0000-4000-8000-000000000001') is null
      and (select count(*) from whatsapp_instance_cycles
            where instance_id = 'cc000000-0000-4000-8000-000000000001' and status = 'OPEN') = 0
      and (select provider_due_on from whatsapp_instance_cycles
            where instance_id = 'cc000000-0000-4000-8000-000000000001'
              and cycle_start = date '2026-09-04') = date '2026-10-04'
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── END-2: sem custo, ciclo fecha PENDING_REVIEW ─────────────────────
do $$
declare v_status text;
begin
  insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, cycle_source)
  values ('cc000000-0000-4000-8000-000000000002',
          (select id from organizations order by id limit 1), 'zapi', 'ACTIVE', 'ADMIN_CONFIRMED')
  on conflict (id) do nothing;
  insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on, status)
  values ('cc000000-0000-4000-8000-000000000002',
          (select organization_id from whatsapp_instances where id = 'cc000000-0000-4000-8000-000000000002'),
          date '2026-07-10', date '2026-08-10', 'OPEN');

  select closed_cycle_status into v_status
  from confirm_whatsapp_instance_end('cc000000-0000-4000-8000-000000000002', 'verificado', null);

  insert into t_res (ord, caso, veredito) values (56, 'END-2 sem custo fecha PENDING_REVIEW',
    case when v_status = 'PENDING_REVIEW'
      and (select status from whatsapp_instance_cycles
            where instance_id = 'cc000000-0000-4000-8000-000000000002') = 'PENDING_REVIEW'
      and (select closed_at from whatsapp_instance_cycles
            where instance_id = 'cc000000-0000-4000-8000-000000000002') is not null
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── END-3: repeticao e idempotente e nao reescreve ended_at ──────────
do $$
declare v_first timestamptz; v_second timestamptz; v_cycle uuid;
begin
  -- `ended_at = coalesce(ended_at, now())` preserva a data da PRIMEIRA
  -- confirmacao; e isso que este caso mede.
  select ended_at into v_first from whatsapp_instances
   where id = 'cc000000-0000-4000-8000-000000000002';
  select closed_cycle_id into v_cycle
  from confirm_whatsapp_instance_end('cc000000-0000-4000-8000-000000000002', 'de novo', null);
  select ended_at into v_second from whatsapp_instances
   where id = 'cc000000-0000-4000-8000-000000000002';

  insert into t_res (ord, caso, veredito) values (57, 'END-3 repeticao idempotente, ended_at preservado',
    case when v_first = v_second and v_cycle is null
      and (select count(*) from whatsapp_instance_cycles
            where instance_id = 'cc000000-0000-4000-8000-000000000002') = 1
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── END-4: repeticao NAO reescreve autoria nem nota do encerramento ──
-- A porta NAO e corrida. `canTransition` tem curto-circuito de mesmo estado
-- (ENDED -> ENDED passa) e o botao do painel e renderizado a partir do
-- lifecycle_state EM CACHE do React Query, com refetchOnWindowFocus desligado:
-- uma aba parada de outro administrador continua oferecendo o botao.
--
-- Os dois atores sao os usuarios do 02-seed.sql — `ended_by` tem FK para
-- auth.users, entao uuid inventado abortaria o caso com foreign_key_violation.
--
-- Instancia PROPRIA (…0003): …0001 e …0002 ja foram encerradas por END-1/END-2.
do $$
declare v_at1 timestamptz; v_at2 timestamptz; v_by uuid; v_note text;
begin
  insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, cycle_source)
  values ('cc000000-0000-4000-8000-000000000003',
          (select id from organizations order by id limit 1), 'zapi', 'ACTIVE', 'ADMIN_CONFIRMED')
  on conflict (id) do nothing;

  perform confirm_whatsapp_instance_end('cc000000-0000-4000-8000-000000000003',
    'primeira', '11111111-1111-1111-1111-111111111111');
  select ended_at into v_at1 from whatsapp_instances
   where id = 'cc000000-0000-4000-8000-000000000003';

  perform confirm_whatsapp_instance_end('cc000000-0000-4000-8000-000000000003',
    'segunda', '22222222-2222-2222-2222-222222222222');
  select ended_at, ended_by, end_confirmation_note into v_at2, v_by, v_note
    from whatsapp_instances where id = 'cc000000-0000-4000-8000-000000000003';

  insert into t_res (ord, caso, veredito) values (60,
    'END-4 repeticao nao reescreve ended_by nem end_confirmation_note',
    case when v_at1 = v_at2
      and v_by = '11111111-1111-1111-1111-111111111111'
      and v_note = 'primeira'
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── CORR-1: correcao promove PENDING_REVIEW -> CLOSED ────────────────
-- O compare-and-set e o mesmo predicado que a Edge Function usa
-- (`status = 'PENDING_REVIEW'` no WHERE). O que este caso prova e a metade do
-- banco: que o CHECK `whatsapp_cycles_closed_needs_cost_chk` aceita custo e
-- status mudando juntos, e que o predicado casa.
do $$
declare v_rows int; v_id uuid;
begin
  select id into v_id from whatsapp_instance_cycles
   where instance_id = 'cc000000-0000-4000-8000-000000000002';

  update whatsapp_instance_cycles
     set provider_cost_cents = 9990, cost_source = 'PROVIDER_INVOICE',
         cost_snapshot_at = now(), status = 'CLOSED',
         notes = coalesce(notes || E'\n', '') || '[correcao de custo] fatura de julho'
   where id = v_id and status = 'PENDING_REVIEW';
  get diagnostics v_rows = row_count;

  insert into t_res (ord, caso, veredito) values (58, 'CORR-1 promove PENDING_REVIEW para CLOSED e anexa motivo',
    case when v_rows = 1
      and (select status from whatsapp_instance_cycles where id = v_id) = 'CLOSED'
      and (select notes from whatsapp_instance_cycles where id = v_id) like '%[correcao de custo]%'
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── CORR-2: correcao sobre ciclo CLOSED casa ZERO linhas ─────────────
do $$
declare v_rows int; v_id uuid;
begin
  select id into v_id from whatsapp_instance_cycles
   where instance_id = 'cc000000-0000-4000-8000-000000000002';

  update whatsapp_instance_cycles
     set provider_cost_cents = 1
   where id = v_id and status = 'PENDING_REVIEW';
  get diagnostics v_rows = row_count;

  insert into t_res (ord, caso, veredito) values (59, 'CORR-2 correcao sobre CLOSED casa zero linhas',
    case when v_rows = 0
      and (select provider_cost_cents from whatsapp_instance_cycles where id = v_id) = 9990
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── CYCLE-1 / CYCLE-2: os DOIS indices que produzem 23505 ────────────
-- `whatsapp_cycles_instance_start_idx (instance_id, cycle_start)` significa
-- reexecucao com a MESMA data (idempotencia genuina).
-- `whatsapp_cycles_one_open_idx (instance_id) WHERE status='OPEN'` significa
-- que existe OUTRO ciclo aberto, com data DIFERENTE.
--
-- Os dois erros sao 23505. O par de casos abaixo torna a colisao visivel e
-- prova o DISCRIMINADOR que a Edge Function usa: existe linha com ESTA
-- cycle_start? Sem eles, alguem "simplificando" os indices da 088 quebraria o
-- discriminador em silencio.

-- ── CYCLE-1: mesma data — 23505 E a linha daquela data existe ────────
do $$
declare v_code text; v_exists boolean;
begin
  insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, cycle_source)
  values ('cc000000-0000-4000-8000-000000000004',
          (select id from organizations order by id limit 1), 'zapi', 'ACTIVE', 'UNKNOWN')
  on conflict (id) do nothing;
  delete from whatsapp_instance_cycles where instance_id = 'cc000000-0000-4000-8000-000000000004';
  insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on, status)
  values ('cc000000-0000-4000-8000-000000000004',
          (select organization_id from whatsapp_instances where id = 'cc000000-0000-4000-8000-000000000004'),
          date '2026-05-01', date '2026-06-01', 'OPEN');

  begin
    insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on, status)
    values ('cc000000-0000-4000-8000-000000000004',
            (select organization_id from whatsapp_instances where id = 'cc000000-0000-4000-8000-000000000004'),
            date '2026-05-01', date '2026-06-01', 'OPEN');
  exception when unique_violation then
    v_code := sqlstate;
  end;

  select exists (select 1 from whatsapp_instance_cycles
                  where instance_id = 'cc000000-0000-4000-8000-000000000004'
                    and cycle_start = date '2026-05-01') into v_exists;

  insert into t_res (ord, caso, veredito) values (63,
    'CYCLE-1 mesma data: 23505 e a linha daquela cycle_start EXISTE (reexecucao)',
    case when v_code = '23505' and v_exists then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── CYCLE-2: data diferente — 23505 E nenhuma linha daquela data ─────
do $$
declare v_code text; v_exists boolean;
begin
  begin
    insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on, status)
    values ('cc000000-0000-4000-8000-000000000004',
            (select organization_id from whatsapp_instances where id = 'cc000000-0000-4000-8000-000000000004'),
            date '2026-06-15', date '2026-07-15', 'OPEN');
  exception when unique_violation then
    v_code := sqlstate;
  end;

  select exists (select 1 from whatsapp_instance_cycles
                  where instance_id = 'cc000000-0000-4000-8000-000000000004'
                    and cycle_start = date '2026-06-15') into v_exists;

  insert into t_res (ord, caso, veredito) values (64,
    'CYCLE-2 data diferente: 23505 e NENHUMA linha daquela cycle_start (divergencia)',
    case when v_code = '23505' and v_exists = false then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── CYCLE-3: por que "existe linha com esta cycle_start" NAO basta ───
-- Com um ciclo CLOSED comecando em X e um OPEN comecando em Y, confirmar X
-- produz 23505 (pelo instance_start_idx) E a linha de X EXISTE. A aproximacao
-- "existe linha com esta cycle_start?" concluiria REEXECUCAO e gravaria a
-- projecao com X, enquanto o ciclo corrente comeca em Y — exatamente a
-- divergencia que o ramo do 23505 existe para impedir.
--
-- O discriminador EXATO e o ciclo OPEN. Este caso mede os dois lados no mesmo
-- estado: a aproximacao diz "reexecucao", o exato diz "divergencia".
do $$
declare v_code text; v_row_exists boolean; v_open_start date;
begin
  insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, cycle_source)
  values ('cc000000-0000-4000-8000-000000000006',
          (select id from organizations order by id limit 1), 'zapi', 'ACTIVE', 'UNKNOWN')
  on conflict (id) do nothing;
  delete from whatsapp_instance_cycles where instance_id = 'cc000000-0000-4000-8000-000000000006';

  -- CLOSED em X (custo obrigatorio pelo whatsapp_cycles_closed_needs_cost_chk).
  insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on,
                                        status, provider_cost_cents, cost_source, cost_snapshot_at, closed_at)
  values ('cc000000-0000-4000-8000-000000000006',
          (select organization_id from whatsapp_instances where id = 'cc000000-0000-4000-8000-000000000006'),
          date '2026-03-01', date '2026-04-01', 'CLOSED', 9990, 'PROVIDER_PANEL', now(), now());
  -- OPEN em Y.
  insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on, status)
  values ('cc000000-0000-4000-8000-000000000006',
          (select organization_id from whatsapp_instances where id = 'cc000000-0000-4000-8000-000000000006'),
          date '2026-04-01', date '2026-05-01', 'OPEN');

  begin
    insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on, status)
    values ('cc000000-0000-4000-8000-000000000006',
            (select organization_id from whatsapp_instances where id = 'cc000000-0000-4000-8000-000000000006'),
            date '2026-03-01', date '2026-04-01', 'OPEN');
  exception when unique_violation then
    v_code := sqlstate;
  end;

  -- A APROXIMACAO: existe linha com cycle_start = X? Sim -> diria reexecucao.
  select exists (select 1 from whatsapp_instance_cycles
                  where instance_id = 'cc000000-0000-4000-8000-000000000006'
                    and cycle_start = date '2026-03-01') into v_row_exists;
  -- O EXATO: qual e a cycle_start do ciclo OPEN? Y -> diz divergencia.
  select cycle_start into v_open_start from whatsapp_instance_cycles
   where instance_id = 'cc000000-0000-4000-8000-000000000006' and status = 'OPEN';

  insert into t_res (ord, caso, veredito) values (66,
    'CYCLE-3 CLOSED em X + OPEN em Y: a linha de X existe, mas o ciclo OPEN comeca em Y',
    case when v_code = '23505' and v_row_exists and v_open_start = date '2026-04-01'
    then 'PASSOU' else 'FALHOU' end);
end $$;
