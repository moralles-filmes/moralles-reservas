-- SETE CONTROLES POSITIVOS da seleção e da purga da 113 — ordinais 73..79.
--
-- Rodar SEM ON_ERROR_STOP, pela convenção dos outros `NN-controles-*.sql`: os
-- casos sabotam de propósito e um erro no meio não deve sumir com os vereditos
-- dos seguintes.
--
-- Sem eles, "SWEEP-1..6, PURGE-1..2 e ACL-SWEEP passaram" não distingue a
-- seleção funcionando de teste sem força. Cada controle reintroduz UM defeito e
-- mede que o caso alvo fica VERMELHO — e, onde o defeito poderia respingar, mede
-- também que os vizinhos continuam VERDES.
--
--   C-SWEEP-1 (73)  seleção sem `next_attempt_at <= now()`  -> derruba SWEEP-2
--   C-SWEEP-2 (74)  seleção sem a perna do lease vencido    -> derruba SWEEP-3 e SWEEP-6
--   C-SWEEP-3 (75)  seleção que REIVINDICA EM LOTE          -> derruba SWEEP-5
--   C-SWEEP-4 (76)  `order by next_attempt_at`              -> derruba SWEEP-6
--   C-SWEEP-5 (77)  purga com 30 dias também para `done`    -> derruba PURGE-1
--   C-SWEEP-6 (78)  purga sem a perna de `dead`             -> derruba PURGE-2
--   C-SWEEP-7 (79)  drop + create sem o `revoke`            -> derruba ACL-SWEEP
--
-- ═══ O CRITÉRIO NÃO É "UM CASO", É VERMELHO QUE NÃO DESORIENTA ══════════════
--
-- O C-SWEEP-2 derruba DOIS casos, e está certo. A linha "envenenada" do SWEEP-6
-- é, por fidelidade ao cenário, um `processing` com lease vencido — então tirar
-- a perna do takeover a faz sumir da seleção e o SWEEP-6 perde a linha de base.
-- Isso só é aceitável porque o veredito do SWEEP-6 NOMEIA o defeito certo nesse
-- ramo ("o defeito e a PERNA DE TAKEOVER, que o SWEEP-3 nomeia — nao a ordem").
-- É a mesma disciplina do C-113-3 no `19`: o que se exige é vermelho localizado
-- com mensagem que aponte para o lugar certo, não um-para-um.
--
-- ═══ O C-SWEEP-3 É O CONTROLE DA DECISÃO CENTRAL DESTA TASK ═════════════════
--
-- A sabotagem dele não é um erro de digitação plausível: é o DESENHO RECUSADO —
-- `claim_whatsapp_inbound_events(p_limit)`, que reivindica 20 linhas de uma vez.
-- Ele é atraente, estava escrito no plano, e o que o torna errado não aparece em
-- nenhum caso deste diretório: o wall clock é do WORKER, então reivindicar 20 e
-- processar duas deixa ~18 leases órfãos por minuto; e o claim POR LINHA então
-- recusa exatamente essas linhas. O SWEEP-5 é o que torna o retorno a esse
-- desenho detectável, e este controle é o que prova que o SWEEP-5 tem força.
--
-- ═══ O RESTORE MORA DENTRO DE CADA CONTROLE ═════════════════════════════════
--
-- Como no `19`: reaplicar a 113 de fato restauraria (é `create or replace`), mas
-- um arquivo de controles que dependa disso deixa schema sabotado de pé quando o
-- operador esquece. Cada controle: (1) captura a definição REAL do catálogo,
-- (2) confere que a sabotagem MUDOU algo (sabotagem que não sabota é o modo
-- silencioso de um controle positivo mentir), (3) desfaz por ROLLBACK de
-- subtransação (`raise ... using errcode = 'ZZ113'` — CINCO caracteres; seis
-- fazem o plpgsql recusar o bloco em tempo de COMPILAÇÃO, e o arquivo aparenta
-- estar verde com vereditos ausentes) e (4) VERIFICA o restore contra o catálogo.
--
-- O handler `when others` de cada bloco também desfaz: DDL em plpgsql roda na
-- subtransação do bloco, então falha no meio volta atrás. Nenhum caminho deixa
-- função sabotada de pé.

-- ─── GUARDA ─────────────────────────────────────────────────────────────────
-- `t_res` é criada ANTES da guarda, e a ordem não é cosmética: a guarda LÊ
-- `t_res`. Com o `create` depois, rodar este arquivo num banco onde o `20` nunca
-- passou estouraria `42P01` na própria guarda — e como ele roda SEM
-- ON_ERROR_STOP, o `psql` imprimiria ERROR e SEGUIRIA: `t_res` seria criada logo
-- abaixo e os sete controles rodariam e PASSARIAM sobre zero caso SWEEP/PURGE.
--
-- SENTINELA EM `-21`, não em 0 nem em -19: o `17` usa o 0 e o `19` usa o -19.
-- Compartilhar ordinal faria um arquivo saudável apagar a sentinela de outro que
-- falhou, e a falha desapareceria atrás de controles verdes.
create table if not exists t_res (ord int primary key, caso text, veredito text);

do $ctrl$
declare v_falha text := null;
begin
  if to_regprocedure('public.select_due_whatsapp_inbound_events(integer)') is null
     or to_regprocedure('public.purge_whatsapp_inbound_events()') is null then
    v_falha := 'exige a migration 113 aplicada (selecao/purga ausentes).';
  elsif not exists (select 1 from t_res where ord between 64 and 72) then
    v_falha := 'exige o 20-inbound-sweep-113.sql rodado antes (nenhum veredito SWEEP-*/PURGE-* em t_res). Um controle positivo sem o caso que ele derruba nao mede nada.';
  elsif not exists (select 1 from whatsapp_channels where id = 'dddddddd-0000-0000-0000-000000000001') then
    v_falha := 'exige o canal dddddddd-0000-0000-0000-000000000001 do 00a-whatsapp-legacy-seed.sql. Sem canal, todo insert morre na FK e os controles ficariam verdes medindo nada.';
  end if;

  if v_falha is null then
    delete from t_res where ord = -21;   -- sentinela de execução anterior quebrada
  else
    insert into t_res values (-21, 'GUARDA-21 pre-requisitos do 21-controles-113-sweep.sql (nao e caso)',
      'FALHOU: ' || v_falha)
      on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
  end if;
end $ctrl$;

do $ctrl$
declare v_falha text;
begin
  select veredito into v_falha from t_res where ord = -21;
  if v_falha is not null then
    raise exception '21-controles-113-sweep.sql %', v_falha;
  end if;
end $ctrl$;

-- ═══ C-SWEEP-1 (73) — seleção sem o filtro de tempo derruba o SWEEP-2 ═══════
-- Sem `next_attempt_at <= now()`, a escada de retentativa deixa de existir na
-- prática: a linha que acabou de falhar é oferecida de novo no minuto seguinte,
-- antes de o atraso correr. É a sabotagem mais provável de todas, porque quem
-- escreve o filtro no cliente (`.lte("next_attempt_at", new Date()...)`) acha que
-- está fazendo a mesma coisa — e aí o relógio deixa de ser o do banco.
--
-- Mede também que o SWEEP-1 fica verde: a linha devida continua sendo
-- selecionada, então o vermelho é localizado.
do $ctrl$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_def_antes text; v_def_sab text; v_def_depois text;
        v_futura uuid; v_devida uuid;
        v_tem_futura boolean := false; v_tem_devida boolean := false;
begin
  delete from t_res where ord = 73;

  v_def_antes := pg_get_functiondef('public.select_due_whatsapp_inbound_events(integer)'::regprocedure);

  begin
    execute $sab$
      create or replace function public.select_due_whatsapp_inbound_events(p_limit integer default 20)
      returns setof uuid
      language sql
      stable
      security definer
      set search_path = ''
      as $f$
        select e.id
          from public.whatsapp_inbound_events e
         where (e.status = 'received'
                or (e.status = 'processing' and e.claimed_until < now()))
         order by e.updated_at
         limit greatest(1, least(coalesce(p_limit, 20), 100));
      $f$;
    $sab$;

    v_def_sab := pg_get_functiondef('public.select_due_whatsapp_inbound_events(integer)'::regprocedure);

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id, next_attempt_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'cs1-futura', now() + interval '5 minutes')
    returning id into v_futura;

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', v_chan, v_unit, v_corpo, 'cs1-devida')
    returning id into v_devida;

    select bool_or(t = v_futura), bool_or(t = v_devida)
      into v_tem_futura, v_tem_devida
      from public.select_due_whatsapp_inbound_events(100) t;

    raise exception 'c-sweep-1: desfaz a sabotagem' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;  -- rollback: o filtro volta, nenhuma linha fica
  end;

  v_def_depois := pg_get_functiondef('public.select_due_whatsapp_inbound_events(integer)'::regprocedure);

  insert into t_res values (73, 'C-SWEEP-1 selecao sem next_attempt_at <= now() derruba o SWEEP-2 (e so ele)',
    case
      when v_def_antes is null or v_def_antes not like '%next_attempt_at <= now()%'
        then 'FALHOU (linha de base: a selecao ja nao filtrava por next_attempt_at — o SWEEP-2 esta passando por outro motivo)'
      when v_def_sab like '%next_attempt_at <= now()%'
        then 'FALHOU (a sabotagem nao pegou: o filtro de tempo continua no corpo)'
      when not coalesce(v_tem_futura, false)
        then 'FALHOU (sem o filtro, a linha agendada para o futuro AINDA nao foi selecionada — o SWEEP-2 nao tem forca)'
      when not coalesce(v_tem_devida, false)
        then 'FALHOU (respingo: a linha devida deixou de ser selecionada — o SWEEP-1 avermelharia junto e o controle nao isola)'
      when v_def_depois is distinct from v_def_antes
        then 'FALHOU (restore: a definicao divergiu do catalogo original)'
      else 'OK (sem o filtro a futura entra na selecao, logo o SWEEP-2 fica vermelho; a devida segue entrando, '
           || 'logo o SWEEP-1 continua verde; definicao restaurada)'
    end);
exception when others then
  insert into t_res values (73, 'C-SWEEP-1 selecao sem next_attempt_at <= now() derruba o SWEEP-2 (e so ele)',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)')
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ C-SWEEP-2 (74) — seleção sem a perna do lease vencido ══════════════════
-- Derruba o SWEEP-3 e, legitimamente, o SWEEP-6 — ver o cabeçalho deste arquivo.
--
-- Sem essa perna, a linha cujo worker morreu no meio nunca mais é OFERECIDA à
-- varredura. O takeover do claim não salva: ele só é chamado para id que a
-- seleção devolveu. A entrega do cliente fica na tabela até a purga — e `dead`
-- ela nunca vira, porque virar `dead` exige tentativas que ninguém mais faz.
--
-- Mede que o SWEEP-1 fica verde: `received` continua reivindicável.
do $ctrl$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_def_antes text; v_def_sab text; v_def_depois text;
        v_venc uuid; v_devida uuid;
        v_tem_venc boolean := false; v_tem_devida boolean := false;
begin
  delete from t_res where ord = 74;

  v_def_antes := pg_get_functiondef('public.select_due_whatsapp_inbound_events(integer)'::regprocedure);

  begin
    execute $sab$
      create or replace function public.select_due_whatsapp_inbound_events(p_limit integer default 20)
      returns setof uuid
      language sql
      stable
      security definer
      set search_path = ''
      as $f$
        select e.id
          from public.whatsapp_inbound_events e
         where e.next_attempt_at <= now()
           and e.status = 'received'
         order by e.updated_at
         limit greatest(1, least(coalesce(p_limit, 20), 100));
      $f$;
    $sab$;

    v_def_sab := pg_get_functiondef('public.select_due_whatsapp_inbound_events(integer)'::regprocedure);

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id,
                                         status, claim_id, claimed_until, next_attempt_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'cs2-vencido',
            'processing', gen_random_uuid(), now() - interval '1 second', now() - interval '2 minutes')
    returning id into v_venc;

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', v_chan, v_unit, v_corpo, 'cs2-devida')
    returning id into v_devida;

    select bool_or(t = v_venc), bool_or(t = v_devida)
      into v_tem_venc, v_tem_devida
      from public.select_due_whatsapp_inbound_events(100) t;

    raise exception 'c-sweep-2: desfaz a sabotagem' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  v_def_depois := pg_get_functiondef('public.select_due_whatsapp_inbound_events(integer)'::regprocedure);

  insert into t_res values (74, 'C-SWEEP-2 selecao sem a perna do lease vencido derruba o SWEEP-3 (e o SWEEP-6, legitimamente)',
    case
      when v_def_antes is null or v_def_antes not like '%claimed_until <%'
        then 'FALHOU (linha de base: a selecao ja nao tinha a perna de lease vencido)'
      when v_def_sab like '%claimed_until <%'
        then 'FALHOU (a sabotagem nao pegou: a perna de lease vencido continua no corpo)'
      when coalesce(v_tem_venc, false)
        then 'FALHOU (sem a perna, o lease vencido AINDA foi selecionado — o SWEEP-3 nao tem forca)'
      when not coalesce(v_tem_devida, false)
        then 'FALHOU (respingo: a linha received deixou de ser selecionada — o SWEEP-1 avermelharia junto e o controle nao isola)'
      when v_def_depois is distinct from v_def_antes
        then 'FALHOU (restore: a definicao divergiu do catalogo original)'
      else 'OK (sem a perna o lease vencido some da selecao, logo o SWEEP-3 fica vermelho e o SWEEP-6 perde a linha '
           || 'de base — os dois vereditos apontam para o takeover; a received segue entrando, logo o SWEEP-1 '
           || 'continua verde; definicao restaurada)'
    end);
exception when others then
  insert into t_res values (74, 'C-SWEEP-2 selecao sem a perna do lease vencido derruba o SWEEP-3 (e o SWEEP-6, legitimamente)',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)')
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ C-SWEEP-3 (75) — a seleção que REIVINDICA EM LOTE derruba o SWEEP-5 ════
-- O desenho recusado, verbatim: `update ... set status='processing' ... limit 20
-- for update skip locked returning id`. Ele parece a coisa certa a fazer, e é por
-- isso que o SWEEP-5 existe.
--
-- O dano não aparece aqui dentro (leases órfãos quando o worker é derrubado; o
-- claim por linha recusando as linhas que o lote reivindicou) — o que aparece é a
-- ESCRITA, que é a propriedade observável que impede os dois.
--
-- Mede que o SWEEP-1 fica verde: a linha devida continua sendo devolvida, só que
-- com efeito colateral. Um controle que derrubasse SWEEP-1 junto não isolaria
-- nada, porque "a selecao parou de selecionar" é outro defeito.
do $ctrl$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_def_antes text; v_def_sab text; v_def_depois text;
        v_id uuid;
        v_devolveu boolean := false;
        v_status_depois text; v_claim_depois uuid;
begin
  delete from t_res where ord = 75;

  v_def_antes := pg_get_functiondef('public.select_due_whatsapp_inbound_events(integer)'::regprocedure);

  begin
    execute $sab$
      create or replace function public.select_due_whatsapp_inbound_events(p_limit integer default 20)
      returns setof uuid
      language sql
      volatile
      security definer
      set search_path = ''
      as $f$
        update public.whatsapp_inbound_events e
           set status        = 'processing',
               claim_id      = gen_random_uuid(),
               claimed_until = now() + make_interval(secs => 90),
               updated_at    = now()
         where e.id in (
           select id from public.whatsapp_inbound_events
            where next_attempt_at <= now()
              and (status = 'received'
                   or (status = 'processing' and claimed_until < now()))
            order by updated_at
            limit greatest(1, least(coalesce(p_limit, 20), 100))
            for update skip locked
         )
        returning e.id;
      $f$;
    $sab$;

    v_def_sab := pg_get_functiondef('public.select_due_whatsapp_inbound_events(integer)'::regprocedure);

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', v_chan, v_unit, v_corpo, 'cs3-lote')
    returning id into v_id;

    select bool_or(t = v_id) into v_devolveu
      from public.select_due_whatsapp_inbound_events(100) t;

    select e.status, e.claim_id into v_status_depois, v_claim_depois
      from whatsapp_inbound_events e where e.id = v_id;

    raise exception 'c-sweep-3: desfaz a sabotagem' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  v_def_depois := pg_get_functiondef('public.select_due_whatsapp_inbound_events(integer)'::regprocedure);

  insert into t_res values (75, 'C-SWEEP-3 selecao que reivindica EM LOTE derruba o SWEEP-5 (o desenho recusado)',
    case
      when v_def_antes is null or v_def_antes not like '%select e.id%'
        then 'FALHOU (linha de base: a selecao ja nao era um SELECT)'
      when v_def_sab not like '%update public.whatsapp_inbound_events%'
        then 'FALHOU (a sabotagem nao pegou: a selecao continua sem escrever)'
      when v_status_depois is distinct from 'processing'
        then 'FALHOU (a selecao em lote NAO marcou processing: status ficou '
             || coalesce(v_status_depois, 'null') || ' — o SWEEP-5 nao tem forca)'
      when v_claim_depois is null
        then 'FALHOU (a selecao em lote marcou processing mas nao gravou claim_id — nem o desenho recusado se comporta assim)'
      when not coalesce(v_devolveu, false)
        then 'FALHOU (respingo: a selecao em lote deixou de devolver a linha devida — o SWEEP-1 avermelharia junto e o controle nao isola)'
      when v_def_depois is distinct from v_def_antes
        then 'FALHOU (restore: a definicao divergiu do catalogo original)'
      else 'OK (a selecao em lote deixou a linha em processing com claim_id, logo o SWEEP-5 fica vermelho; '
           || 'ela segue devolvendo a linha devida, logo o SWEEP-1 continua verde; definicao restaurada)'
    end);
exception when others then
  insert into t_res values (75, 'C-SWEEP-3 selecao que reivindica EM LOTE derruba o SWEEP-5 (o desenho recusado)',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)')
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ C-SWEEP-4 (76) — `order by next_attempt_at` derruba o SWEEP-6 ══════════
-- A escrita que o plano trazia, e que parece óbvia: "sirva primeiro quem está
-- devido há mais tempo". O que ela produz é a linha ENVENENADA em primeiro lugar
-- para sempre — porque quem escreve `next_attempt_at` é a finalização, e a linha
-- envenenada é exatamente aquela cuja finalização não escreve.
--
-- Mede que o SWEEP-1 fica verde: a ordem não muda quem ENTRA na seleção, só a
-- vez de cada um. Se o SWEEP-1 avermelhasse aqui, o controle estaria medindo
-- outra coisa.
do $ctrl$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_def_antes text; v_def_sab text; v_def_depois text;
        v_antiga uuid; v_envenenada uuid;
        v_primeiro uuid; v_total int := -1;
        v_id_sozinha uuid; v_devolveu_sozinha boolean := false;
begin
  delete from t_res where ord = 76;

  v_def_antes := pg_get_functiondef('public.select_due_whatsapp_inbound_events(integer)'::regprocedure);

  begin
    execute $sab$
      create or replace function public.select_due_whatsapp_inbound_events(p_limit integer default 20)
      returns setof uuid
      language sql
      stable
      security definer
      set search_path = ''
      as $f$
        select e.id
          from public.whatsapp_inbound_events e
         where e.next_attempt_at <= now()
           and (e.status = 'received'
                or (e.status = 'processing' and e.claimed_until < now()))
         order by e.next_attempt_at
         limit greatest(1, least(coalesce(p_limit, 20), 100));
      $f$;
    $sab$;

    v_def_sab := pg_get_functiondef('public.select_due_whatsapp_inbound_events(integer)'::regprocedure);

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id,
                                         next_attempt_at, updated_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'cs4-antiga',
            now() - interval '10 minutes', now() - interval '10 minutes')
    returning id into v_antiga;

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id,
                                         status, claim_id, claimed_until, next_attempt_at, updated_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'cs4-envenenada',
            'processing', gen_random_uuid(), now() - interval '1 second',
            now() - interval '20 minutes', now())
    returning id into v_envenenada;

    -- Mesma forma do SWEEP-6: UMA chamada, ordem por `with ordinality`.
    select count(*), (array_agg(x.id order by x.pos))[1]
      into v_total, v_primeiro
      from public.select_due_whatsapp_inbound_events(100) with ordinality as x(id, pos);

    raise exception 'c-sweep-4: desfaz a sabotagem' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  -- Vizinho, fora da sabotagem: com a ordem real, uma linha devida sozinha
  -- continua sendo devolvida (SWEEP-1).
  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', v_chan, v_unit, v_corpo, 'cs4-vizinha')
    returning id into v_id_sozinha;

    select bool_or(t = v_id_sozinha) into v_devolveu_sozinha
      from public.select_due_whatsapp_inbound_events(100) t;

    raise exception 'c-sweep-4b: desfaz o insert' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  v_def_depois := pg_get_functiondef('public.select_due_whatsapp_inbound_events(integer)'::regprocedure);

  insert into t_res values (76, 'C-SWEEP-4 order by next_attempt_at derruba o SWEEP-6 (a envenenada em primeiro lugar para sempre)',
    case
      when v_def_antes is null or v_def_antes not like '%order by e.updated_at%'
        then 'FALHOU (linha de base: a selecao ja nao ordenava por updated_at — o SWEEP-6 esta passando por outro motivo)'
      when v_def_sab like '%order by e.updated_at%'
        then 'FALHOU (a sabotagem nao pegou: a ordem continua por updated_at)'
      when v_total <> 2
        then 'FALHOU (premissa: as 2 linhas devidas nao foram selecionadas, entao nao ha ordem a comparar)'
      when v_primeiro is distinct from v_envenenada
        then 'FALHOU (com order by next_attempt_at a envenenada NAO veio primeiro — o SWEEP-6 nao tem forca)'
      when not coalesce(v_devolveu_sozinha, false)
        then 'FALHOU (respingo: com a ordem real restaurada, a linha devida sozinha nao foi selecionada — o SWEEP-1 avermelharia junto)'
      when v_def_depois is distinct from v_def_antes
        then 'FALHOU (restore: a definicao divergiu do catalogo original)'
      else 'OK (por next_attempt_at a recem-tocada vem primeiro, logo o SWEEP-6 fica vermelho; quem ENTRA na '
           || 'selecao nao muda, logo o SWEEP-1 continua verde; definicao restaurada)'
    end);
exception when others then
  insert into t_res values (76, 'C-SWEEP-4 order by next_attempt_at derruba o SWEEP-6 (a envenenada em primeiro lugar para sempre)',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)')
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ C-SWEEP-5 (77) — purga com 30 dias para `done` derruba o PURGE-1 ═══════
-- A "simplificação" plausível: uma janela só para as duas situações. O custo é o
-- corpo cru — telefone e texto de cliente — ficando um mês em vez de uma semana,
-- e ela desfaz pela porta de trás a escolha do 401 terminal (`done`, não `dead`,
-- PARA cair na purga de 7 dias).
--
-- Mede que o PURGE-2 fica verde: a janela de `dead` continua sendo 30 dias.
do $ctrl$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_def_antes text; v_def_sab text; v_def_depois text;
        v_done8 uuid; v_dead31 uuid; v_dead29 uuid;
        v_done8_ficou boolean := false;
        v_dead31_ficou boolean := true;
        v_dead29_ficou boolean := false;
begin
  delete from t_res where ord = 77;

  v_def_antes := pg_get_functiondef('public.purge_whatsapp_inbound_events()'::regprocedure);

  begin
    execute $sab$
      create or replace function public.purge_whatsapp_inbound_events()
      returns integer
      language sql
      security definer
      set search_path = ''
      as $f$
        with gone as (
          delete from public.whatsapp_inbound_events
           where (status = 'done' and received_at < now() - interval '30 days')
              or (status = 'dead' and received_at < now() - interval '30 days')
          returning 1
        ) select count(*)::integer from gone;
      $f$;
    $sab$;

    v_def_sab := pg_get_functiondef('public.purge_whatsapp_inbound_events()'::regprocedure);

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id, status, received_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'cs5-done8', 'done', now() - interval '8 days')
    returning id into v_done8;

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id, status, received_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'cs5-dead31', 'dead', now() - interval '31 days')
    returning id into v_dead31;

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id, status, received_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'cs5-dead29', 'dead', now() - interval '29 days')
    returning id into v_dead29;

    perform public.purge_whatsapp_inbound_events();

    select exists (select 1 from whatsapp_inbound_events where id = v_done8),
           exists (select 1 from whatsapp_inbound_events where id = v_dead31),
           exists (select 1 from whatsapp_inbound_events where id = v_dead29)
      into v_done8_ficou, v_dead31_ficou, v_dead29_ficou;

    raise exception 'c-sweep-5: desfaz a sabotagem' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  v_def_depois := pg_get_functiondef('public.purge_whatsapp_inbound_events()'::regprocedure);

  insert into t_res values (77, 'C-SWEEP-5 purga com 30 dias tambem para done derruba o PURGE-1 (e so ele)',
    case
      when v_def_antes is null or v_def_antes not like '%interval ''7 days''%'
        then 'FALHOU (linha de base: a purga ja nao usava 7 dias para done)'
      when v_def_sab like '%interval ''7 days''%'
        then 'FALHOU (a sabotagem nao pegou: a janela de 7 dias continua no corpo)'
      when not v_done8_ficou
        then 'FALHOU (com 30 dias para done, a linha de 8 dias AINDA foi apagada — o PURGE-1 nao tem forca)'
      when v_dead31_ficou
        then 'FALHOU (respingo: a dead de 31 dias deixou de ser apagada — o PURGE-2 avermelharia junto)'
      when not v_dead29_ficou
        then 'FALHOU (respingo: a dead de 29 dias foi apagada — o PURGE-2 avermelharia junto)'
      when v_def_depois is distinct from v_def_antes
        then 'FALHOU (restore: a definicao divergiu do catalogo original)'
      else 'OK (com 30 dias para done o corpo cru de 8 dias sobrevive, logo o PURGE-1 fica vermelho; a janela de '
           || 'dead segue intacta, logo o PURGE-2 continua verde; definicao restaurada)'
    end);
exception when others then
  insert into t_res values (77, 'C-SWEEP-5 purga com 30 dias tambem para done derruba o PURGE-1 (e so ele)',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)')
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ C-SWEEP-6 (78) — purga sem a perna de `dead` derruba o PURGE-2 ═════════
-- A metade que some sem barulho: `done` continua sendo purgado, a tabela continua
-- encolhendo, e o corpo cru das dead letters fica para sempre. Ninguém nota até
-- alguém somar `octet_length(raw_body)`.
--
-- Mede que o PURGE-1 fica verde: a janela de `done` continua sendo 7 dias.
do $ctrl$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_def_antes text; v_def_sab text; v_def_depois text;
        v_dead31 uuid; v_done8 uuid; v_done6 uuid;
        v_dead31_ficou boolean := false;
        v_done8_ficou boolean := true;
        v_done6_ficou boolean := false;
begin
  delete from t_res where ord = 78;

  v_def_antes := pg_get_functiondef('public.purge_whatsapp_inbound_events()'::regprocedure);

  begin
    execute $sab$
      create or replace function public.purge_whatsapp_inbound_events()
      returns integer
      language sql
      security definer
      set search_path = ''
      as $f$
        with gone as (
          delete from public.whatsapp_inbound_events
           where (status = 'done' and received_at < now() - interval '7 days')
          returning 1
        ) select count(*)::integer from gone;
      $f$;
    $sab$;

    v_def_sab := pg_get_functiondef('public.purge_whatsapp_inbound_events()'::regprocedure);

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id, status, received_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'cs6-dead31', 'dead', now() - interval '31 days')
    returning id into v_dead31;

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id, status, received_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'cs6-done8', 'done', now() - interval '8 days')
    returning id into v_done8;

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id, status, received_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'cs6-done6', 'done', now() - interval '6 days')
    returning id into v_done6;

    perform public.purge_whatsapp_inbound_events();

    select exists (select 1 from whatsapp_inbound_events where id = v_dead31),
           exists (select 1 from whatsapp_inbound_events where id = v_done8),
           exists (select 1 from whatsapp_inbound_events where id = v_done6)
      into v_dead31_ficou, v_done8_ficou, v_done6_ficou;

    raise exception 'c-sweep-6: desfaz a sabotagem' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  v_def_depois := pg_get_functiondef('public.purge_whatsapp_inbound_events()'::regprocedure);

  insert into t_res values (78, 'C-SWEEP-6 purga sem a perna de dead derruba o PURGE-2 (e so ele)',
    case
      when v_def_antes is null or v_def_antes not like '%''dead'' and received_at%'
        then 'FALHOU (linha de base: a purga ja nao tinha a perna de dead)'
      when v_def_sab like '%''dead'' and received_at%'
        then 'FALHOU (a sabotagem nao pegou: a perna de dead continua no corpo)'
      when not v_dead31_ficou
        then 'FALHOU (sem a perna de dead, a linha de 31 dias AINDA foi apagada — o PURGE-2 nao tem forca)'
      when v_done8_ficou
        then 'FALHOU (respingo: a done de 8 dias deixou de ser apagada — o PURGE-1 avermelharia junto)'
      when not v_done6_ficou
        then 'FALHOU (respingo: a done de 6 dias foi apagada — o PURGE-1 avermelharia junto)'
      when v_def_depois is distinct from v_def_antes
        then 'FALHOU (restore: a definicao divergiu do catalogo original)'
      else 'OK (sem a perna de dead o corpo cru da dead letter fica para sempre, logo o PURGE-2 fica vermelho; '
           || 'a janela de done segue intacta, logo o PURGE-1 continua verde; definicao restaurada)'
    end);
exception when others then
  insert into t_res values (78, 'C-SWEEP-6 purga sem a perna de dead derruba o PURGE-2 (e so ele)',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)')
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ C-SWEEP-7 (79) — drop + create sem o `revoke` derruba o ACL-SWEEP ══════
-- O caminho provável de acontecer de novo, e o `C-113-7` do `19` já mediu a outra
-- metade: **`create or replace` NÃO reabre o EXECUTE a PUBLIC** — o ACL fica
-- preso ao objeto. Quem reabre é DROP + CREATE, e alguém chega lá precisando
-- mudar o TIPO DE RETORNO (`returns integer` -> `returns table(...)`, por
-- exemplo), descobrindo que `create or replace` recusa, dropando, recriando — e
-- não repetindo o `revoke`.
--
-- A purga com `anon` é "apague a fila de qualquer tenant" via PostgREST com a
-- chave do bundle.
--
-- Mede que a SELEÇÃO continua fechada: o vermelho é do lado que foi dropado, não
-- um desabamento geral de ACL.
do $ctrl$
declare v_pur text := 'public.purge_whatsapp_inbound_events()';
        v_sel text := 'public.select_due_whatsapp_inbound_events(integer)';
        v_def_antes text; v_def_depois text;
        v_anon_apos_drop boolean := false;
        v_pub_apos_drop boolean := false;
        v_sel_anon_durante boolean := true;
        v_anon_restaurado boolean := true;
begin
  delete from t_res where ord = 79;

  v_def_antes := pg_get_functiondef(v_pur::regprocedure);

  begin
    execute 'drop function ' || v_pur;
    execute v_def_antes;

    v_anon_apos_drop := has_function_privilege('anon', v_pur, 'execute');
    select p.proacl is null
           or exists (select 1 from unnest(p.proacl) a where a::text like '=%')
      into v_pub_apos_drop
      from pg_proc p where p.oid = v_pur::regprocedure;

    v_sel_anon_durante := has_function_privilege('anon', v_sel, 'execute');

    raise exception 'c-sweep-7: desfaz a sabotagem' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;  -- rollback: o objeto original volta, com o ACL do `revoke` da 113
  end;

  v_def_depois := pg_get_functiondef(v_pur::regprocedure);
  v_anon_restaurado := has_function_privilege('anon', v_pur, 'execute');

  insert into t_res values (79, 'C-SWEEP-7 drop+create da purga sem o revoke reabre EXECUTE a PUBLIC (derruba o ACL-SWEEP)',
    case
      when v_def_antes is null
        then 'FALHOU (linha de base: pg_get_functiondef nao devolveu a definicao da purga)'
      when not v_anon_apos_drop
        then 'FALHOU (depois de drop+create, anon AINDA nao executa a purga — o ACL-SWEEP nao tem forca contra o modo de falha que ele existe para pegar)'
      when not v_pub_apos_drop
        then 'FALHOU (depois de drop+create, o grant implicito a PUBLIC nao apareceu no proacl — a perna de PUBLIC do ACL-SWEEP nao seria exercitada)'
      when v_sel_anon_durante
        then 'FALHOU (respingo: a SELECAO tambem ficou executavel por anon, e ela nem foi dropada — o controle nao isola)'
      when v_anon_restaurado
        then 'FALHOU (restore: anon CONTINUA com execute depois do rollback — sabotagem de ACL de pe no banco)'
      when v_def_depois is distinct from v_def_antes
        then 'FALHOU (restore: a definicao divergiu do catalogo original)'
      else 'OK (drop+create reabre execute a anon e o grant a PUBLIC na purga, logo o ACL-SWEEP fica vermelho; '
           || 'a selecao segue fechada; ACL e definicao restaurados pelo rollback)'
    end);
exception when others then
  insert into t_res values (79, 'C-SWEEP-7 drop+create da purga sem o revoke reabre EXECUTE a PUBLIC (derruba o ACL-SWEEP)',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)')
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;
