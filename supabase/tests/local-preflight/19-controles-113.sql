-- SETE CONTROLES POSITIVOS da migration 113 — ordinais 56..62.
--
-- Rodar SEM ON_ERROR_STOP, pela convenção dos outros `NN-controles-*.sql`: os
-- casos sabotam de propósito e um erro no meio não deve sumir com os vereditos
-- dos seguintes.
--
-- Sem eles, "CLAIM-1..4 e FIN-1..3 passaram" não distingue a cerca funcionando
-- de teste sem força. Cada controle reintroduz UM defeito e mede que o caso alvo
-- fica VERMELHO — e, onde o defeito poderia respingar, mede também que os
-- vizinhos continuam VERDES.
--
--   C-113-1 (56)  `finalize` sem `and claim_id = p_claim_id`   -> derruba FIN-1
--   C-113-2 (57)  `claim` sem a perna do takeover              -> derruba CLAIM-3
--   C-113-3 (58)  `claim` sem filtro de status                 -> derruba CLAIM-2 e CLAIM-4
--   C-113-4 (59)  lease de 9 s em vez de 90                    -> derruba CLAIM-1
--   C-113-5 (60)  `attempts + 1` em TODO ramo                  -> derruba FIN-3
--   C-113-6 (61)  atraso lido como MILISSEGUNDOS               -> derruba FIN-2
--   C-113-7 (62)  drop + create sem o `revoke`                  -> derruba ACL-113
--   C-113-8 (82)  `claim` sem o incremento do takeover          -> derruba CLAIM-5
--
-- O C-113-8 está em 82, fora da faixa 56..62, porque nasceu depois do `20`/`21`
-- (ordinais 64..79) e dos casos CLAIM-5/CLAIM-6 do `18` (80..81).
--
-- ═══ O CRITÉRIO NÃO É "UM CASO", É VERMELHO QUE NÃO DESORIENTA ══════════════
--
-- O C-113-2 e o C-113-3 derrubam DOIS casos cada, e os dois estão certos. Sem a
-- perna do takeover não existe takeover a gastar tentativa, então o CLAIM-3 e o
-- CLAIM-5 caem juntos, cada um nomeando a mesma causa. Tirar o filtro de status
-- quebra genuinamente duas propriedades (lease vivo reivindicado duas vezes, e
-- linha terminal voltando a ser trabalhável), e cada veredito nomeia o defeito
-- real.
-- Isso é diferente de um controle cujo segundo vermelho MENTE sobre a causa —
-- defeito que este conjunto teve e que uma revisão pegou: o C-113-4 (lease de 9 s)
-- também avermelhava o CLAIM-3, com a mensagem "o takeover nao renovou o lease",
-- mandando investigar o takeover quando o defeito era o TTL. A correção não foi
-- enfraquecer o controle: foi tirar do CLAIM-3 a asserção de VALOR exato do lease,
-- que era duplicata da do CLAIM-1. Controle positivo vale pelo vermelho ser
-- LOCALIZADO e pela mensagem apontar para o lugar certo — não por um-para-um.
--
-- ═══ DOIS CONTROLES MEDEM A ESCOLHA DA ASSERÇÃO, NÃO SÓ O CÓDIGO ════════════
--
-- O C-113-4 e o C-113-6 existem porque o `18` compara instantes por IGUALDADE
-- (`claimed_until = now() + interval '90 seconds'`), e a escrita óbvia teria sido
-- "está no futuro". Os dois medem as DUAS coisas: que a asserção real reprova a
-- sabotagem, e que a asserção frouxa teria PASSADO. Um lease de 9 s e um atraso
-- de 30 ms estão os dois no futuro, e a diferença entre 30 s e 30 ms é a resposta
-- chegar ou não chegar ao cliente. Sem estes controles, trocar a igualdade por
-- `> now()` numa limpeza futura não derrubaria nada.
--
-- ═══ O RESTORE MORA DENTRO DE CADA CONTROLE ═════════════════════════════════
--
-- Diferente da 111, a 113 é `create or replace function` e reaplicá-la DE FATO
-- restauraria. O restore continua morando dentro de cada controle de propósito:
-- um arquivo de controles que dependa de o operador reaplicar a migration depois
-- deixa schema sabotado de pé quando ele esquece — e aqui a sabotagem esquecida
-- não é uma coluna estranha, é a cerca que impede duas IAs de responderem ao
-- mesmo cliente. Cada controle: (1) captura a definição REAL do catálogo, (2)
-- confere que a sabotagem mudou algo (sabotagem que não sabota é o modo
-- silencioso de um controle positivo mentir, a lição do `15-controles-109.sql`),
-- (3) desfaz por ROLLBACK de subtransação (`raise ... using errcode = 'ZZ113'`)
-- e (4) VERIFICA o restore contra o catálogo.
--
-- O handler `when others` de cada bloco também desfaz: DDL em plpgsql roda na
-- subtransação do bloco, então falha no meio volta atrás. Nenhum caminho deixa
-- função sabotada de pé.
--
-- A sabotagem é aplicada por `execute` de uma string dollar-quoted (`$sab$`), e
-- o corpo dentro dela usa outra tag (`$f$`): plpgsql não substitui variável
-- dentro de literal, então o corpo chega ao banco exatamente como escrito.

-- ─── GUARDA ─────────────────────────────────────────────────────────────────
-- `t_res` é criada ANTES da guarda, e a ordem não é cosmética: a guarda LÊ
-- `t_res` (é assim que ela sabe se o `18` rodou). Com o `create` depois, rodar
-- este arquivo num banco onde o `18` nunca passou estouraria `42P01` na própria
-- guarda — e como este arquivo roda SEM ON_ERROR_STOP de propósito, o `psql`
-- imprimiria ERROR e SEGUIRIA: `t_res` seria criada logo abaixo e os sete
-- controles rodariam e PASSARIAM sobre zero caso CLAIM/FIN.
--
-- A guarda é DOIS statements pela mesma razão do `17`: um `raise` desfaz a
-- subtransação do próprio `do`, então um bloco que registrasse e levantasse
-- perderia o registro no rollback.
create table if not exists t_res (ord int primary key, caso text, veredito text);

do $ctrl$
declare v_falha text := null;
begin
  if to_regprocedure('public.claim_whatsapp_inbound_event(uuid)') is null
     or to_regprocedure('public.finalize_whatsapp_inbound_event(uuid,uuid,text,text,text,integer)') is null then
    v_falha := 'exige a migration 113 aplicada (claim/finalize ausentes).';
  elsif not exists (select 1 from t_res where ord between 49 and 55) then
    v_falha := 'exige o 18-inbound-claim-113.sql rodado antes (nenhum veredito CLAIM-*/FIN-* em t_res). Um controle positivo sem o caso que ele derruba nao mede nada.';
  elsif not exists (select 1 from whatsapp_channels where id = 'dddddddd-0000-0000-0000-000000000001') then
    v_falha := 'exige o canal dddddddd-0000-0000-0000-000000000001 do 00a-whatsapp-legacy-seed.sql. Sem canal, todo insert morre na FK e os controles ficariam verdes medindo nada.';
  end if;

  -- SENTINELA EM `-19`, NÃO EM 0, e a escolha é necessária: o `17` usa o 0, e um
  -- `19` saudável apagaria a sentinela de um `17` que falhou — a falha do `17`
  -- desapareceria atrás de sete controles verdes. Ordinal próprio, negativo para
  -- que `order by ord` continue pondo qualquer sentinela no topo.
  if v_falha is null then
    delete from t_res where ord = -19;   -- sentinela de execução anterior quebrada
  else
    insert into t_res values (-19, 'GUARDA-19 pre-requisitos do 19-controles-113.sql (nao e caso)',
      'FALHOU: ' || v_falha)
      on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
  end if;
end $ctrl$;

do $ctrl$
declare v_falha text;
begin
  select veredito into v_falha from t_res where ord = -19;
  if v_falha is not null then
    raise exception '19-controles-113.sql %', v_falha;
  end if;
end $ctrl$;

-- ═══ C-113-1 (56) — `finalize` sem a cerca derruba o FIN-1 ══════════════════
-- A cerca é a peça que impede o PERDEDOR de um takeover de escrever por cima do
-- veredito de quem de fato respondeu ao cliente. Sem ela, qualquer crachá serve.
--
-- Duas metades, e a segunda é o que prova que o vermelho não respinga: com a cerca
-- fora, o crachá ERRADO passa a afetar 1 linha (FIN-1 fica vermelho) e o crachá
-- CERTO continua afetando 1 linha (FIN-2 e FIN-3 seguem verdes, porque os dois
-- apresentam o crachá certo).
do $ctrl$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_def_antes text; v_def_sab text; v_def_depois text;
        v_id uuid; v_certo uuid;
        v_afetadas_errado int := -1; v_status_errado text;
        v_id2 uuid; v_certo2 uuid; v_afetadas_certo int := -1;
begin
  delete from t_res where ord = 56;

  v_def_antes := pg_get_functiondef('public.finalize_whatsapp_inbound_event(uuid,uuid,text,text,text,integer)'::regprocedure);

  begin
    execute $sab$
      create or replace function public.finalize_whatsapp_inbound_event(
        p_event_id            uuid,
        p_claim_id            uuid,
        p_status              text,
        p_outcome             text,
        p_error               text,
        p_retry_delay_seconds integer
      )
      returns integer
      language sql
      security definer
      set search_path = ''
      as $f$
        with fenced as (
          update public.whatsapp_inbound_events e
             set status          = p_status,
                 outcome         = p_outcome,
                 last_error      = left(p_error, 500),
                 attempts        = case
                                     when p_status in ('received', 'dead') then e.attempts + 1
                                     else e.attempts
                                   end,
                 next_attempt_at = case
                                     when p_retry_delay_seconds is null then now()
                                     else now() + make_interval(secs => p_retry_delay_seconds)
                                   end,
                 claim_id        = null,
                 claimed_until   = null,
                 updated_at      = now()
           where e.id = p_event_id
          returning 1
        )
        select count(*)::integer from fenced;
      $f$;
    $sab$;

    v_def_sab := pg_get_functiondef('public.finalize_whatsapp_inbound_event(uuid,uuid,text,text,text,integer)'::regprocedure);

    -- metade 1: crachá ERRADO. É o que o FIN-1 mede.
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', v_chan, v_unit, v_corpo, 'c1-errado')
    returning id into v_id;
    select c.claim_id into v_certo from public.claim_whatsapp_inbound_event(v_id) c;

    select public.finalize_whatsapp_inbound_event(
             v_id, gen_random_uuid(), 'done', 'queue_processed', null, null)
      into v_afetadas_errado;
    select e.status into v_status_errado from whatsapp_inbound_events e where e.id = v_id;

    -- metade 2: crachá CERTO, noutra linha. É o que o FIN-2/FIN-3 medem.
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', v_chan, v_unit, v_corpo, 'c1-certo')
    returning id into v_id2;
    select c.claim_id into v_certo2 from public.claim_whatsapp_inbound_event(v_id2) c;

    select public.finalize_whatsapp_inbound_event(
             v_id2, v_certo2, 'received', 'queue_retry_scheduled', null, 30)
      into v_afetadas_certo;

    raise exception 'c-113-1: desfaz a sabotagem' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;  -- rollback: a cerca volta, nenhuma linha fica
  end;

  v_def_depois := pg_get_functiondef('public.finalize_whatsapp_inbound_event(uuid,uuid,text,text,text,integer)'::regprocedure);

  insert into t_res values (56, 'C-113-1 finalize sem a cerca de claim_id derruba o FIN-1 (e so ele)',
    case
      when v_def_antes is null or v_def_antes not like '%claim_id = p_claim_id%'
        then 'FALHOU (linha de base: a finalize ja nao tinha a cerca `claim_id = p_claim_id` — entao o FIN-1 esta passando por outro motivo)'
      when v_def_sab like '%claim_id = p_claim_id%'
        then 'FALHOU (a sabotagem nao pegou: a cerca continua no corpo)'
      when v_certo is null
        then 'FALHOU (linha de base: o claim nao pegou a linha, nao ha cerca a derrubar)'
      when v_afetadas_errado <> 1
        then 'FALHOU (sem a cerca, o crachá errado AINDA afetou ' || v_afetadas_errado
             || ' linha(s) — o FIN-1 nao tem forca)'
      when v_status_errado is distinct from 'done'
        then 'FALHOU (sem a cerca, o crachá errado nao escreveu: status ficou '
             || coalesce(v_status_errado, 'null') || ')'
      when v_afetadas_certo <> 1
        then 'FALHOU (respingo: com a cerca fora, o crachá CERTO afetou ' || v_afetadas_certo
             || ' linha(s) — o FIN-2/FIN-3 avermelhariam junto e o controle nao isola)'
      when v_def_depois is distinct from v_def_antes
        then 'FALHOU (restore: a definicao divergiu do catalogo original)'
      else 'OK (sem a cerca o crachá errado gravou done e afetou 1 linha, logo o FIN-1 fica vermelho; '
           || 'o crachá certo segue afetando 1, logo FIN-2/FIN-3 continuam verdes; definicao restaurada)'
    end);
exception when others then
  insert into t_res values (56, 'C-113-1 finalize sem a cerca de claim_id derruba o FIN-1 (e so ele)',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)')
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ C-113-2 (57) — `claim` sem a perna do takeover derruba o CLAIM-3 ═══════
-- É a perna que impede uma linha de ficar presa quando o worker morre no meio —
-- o modo de falha que o `notification_outbox` documenta duas vezes não cobrir.
-- Sem ela, `processing` com lease vencido nunca mais é reivindicado: a entrega
-- do cliente fica na tabela para sempre e ninguém responde.
--
-- Mede também que o CLAIM-1 fica verde: uma linha `received` continua
-- reivindicável, então o vermelho é localizado.
--
-- SEGUNDO VERMELHO LEGÍTIMO, pela mesma régua do C-113-3: o CLAIM-5 (o takeover
-- gasta uma tentativa) também cai, porque sem a perna não há takeover nenhum a
-- gastar tentativa. A mensagem dele diz exatamente isso — "linha de base: o
-- lease vencido nao foi retomado — ver CLAIM-3" — e manda investigar o lugar
-- certo, que é o requisito. Já o CLAIM-6 fica verde: o claim normal não depende
-- desta perna.
do $ctrl$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_def_antes text; v_def_sab text; v_def_depois text;
        v_id_venc uuid; v_retomou boolean := false;
        v_id_novo uuid; v_pegou_received boolean := false;
begin
  delete from t_res where ord = 57;

  v_def_antes := pg_get_functiondef('public.claim_whatsapp_inbound_event(uuid)'::regprocedure);

  begin
    execute $sab$
      create or replace function public.claim_whatsapp_inbound_event(p_event_id uuid)
      returns table (
        id          uuid,
        provider    text,
        channel_id  uuid,
        raw_body    bytea,
        attempts    integer,
        claim_id    uuid
      )
      language sql
      security definer
      set search_path = ''
      as $f$
        update public.whatsapp_inbound_events e
           set status        = 'processing',
               claim_id      = gen_random_uuid(),
               claimed_until = now() + make_interval(secs => 90),
               updated_at    = now()
         where e.id = p_event_id
           and e.status = 'received'
        returning e.id, e.provider, e.channel_id, e.raw_body, e.attempts, e.claim_id;
      $f$;
    $sab$;

    v_def_sab := pg_get_functiondef('public.claim_whatsapp_inbound_event(uuid)'::regprocedure);

    -- metade 1: lease VENCIDO. É o que o CLAIM-3 mede.
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id,
                                         status, claim_id, claimed_until)
    values ('datafy', v_chan, v_unit, v_corpo, 'c2-vencido',
            'processing', gen_random_uuid(), now() - interval '1 second')
    returning id into v_id_venc;

    perform 1 from public.claim_whatsapp_inbound_event(v_id_venc);
    v_retomou := found;

    -- metade 2: linha `received`. É o que o CLAIM-1 mede.
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', v_chan, v_unit, v_corpo, 'c2-received')
    returning id into v_id_novo;

    perform 1 from public.claim_whatsapp_inbound_event(v_id_novo);
    v_pegou_received := found;

    raise exception 'c-113-2: desfaz a sabotagem' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  v_def_depois := pg_get_functiondef('public.claim_whatsapp_inbound_event(uuid)'::regprocedure);

  insert into t_res values (57, 'C-113-2 claim sem a perna do takeover derruba o CLAIM-3 (e so ele)',
    case
      when v_def_antes is null or v_def_antes not like '%claimed_until <%'
        then 'FALHOU (linha de base: o claim ja nao tinha a perna de lease vencido)'
      when v_def_sab like '%claimed_until <%'
        then 'FALHOU (a sabotagem nao pegou: a perna do takeover continua no corpo)'
      when v_retomou
        then 'FALHOU (sem a perna, o lease vencido AINDA foi retomado — o CLAIM-3 nao tem forca)'
      when not v_pegou_received
        then 'FALHOU (respingo: a linha received deixou de ser reivindicavel — o CLAIM-1 avermelharia junto e o controle nao isola)'
      when v_def_depois is distinct from v_def_antes
        then 'FALHOU (restore: a definicao divergiu do catalogo original)'
      else 'OK (sem a perna o lease vencido nao e retomado, logo o CLAIM-3 fica vermelho; '
           || 'a linha received segue reivindicavel, logo o CLAIM-1 continua verde; definicao restaurada)'
    end);
exception when others then
  insert into t_res values (57, 'C-113-2 claim sem a perna do takeover derruba o CLAIM-3 (e so ele)',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)')
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ C-113-3 (58) — `claim` sem filtro de status derruba o CLAIM-2 ══════════
-- A sabotagem mais plausível de todas: um `where` que só casa o id parece
-- suficiente para quem lê "reivindica ESTA linha". Sem o filtro de status, o
-- caminho rápido (`waitUntil`) e a varredura (`pg_cron`) levam a MESMA linha com
-- lease vivo — duas IAs respondendo ao mesmo cliente, que é o dano que esta fase
-- inteira existe para impedir.
do $ctrl$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_def_antes text; v_def_sab text; v_def_depois text;
        v_id uuid;
        v_primeiro uuid; v_primeiro_ok boolean := false;
        v_segundo uuid; v_segundo_ok boolean := false;
        v_id_done uuid; v_pegou_done boolean := false;
begin
  delete from t_res where ord = 58;

  v_def_antes := pg_get_functiondef('public.claim_whatsapp_inbound_event(uuid)'::regprocedure);

  begin
    execute $sab$
      create or replace function public.claim_whatsapp_inbound_event(p_event_id uuid)
      returns table (
        id          uuid,
        provider    text,
        channel_id  uuid,
        raw_body    bytea,
        attempts    integer,
        claim_id    uuid
      )
      language sql
      security definer
      set search_path = ''
      as $f$
        update public.whatsapp_inbound_events e
           set status        = 'processing',
               claim_id      = gen_random_uuid(),
               claimed_until = now() + make_interval(secs => 90),
               updated_at    = now()
         where e.id = p_event_id
        returning e.id, e.provider, e.channel_id, e.raw_body, e.attempts, e.claim_id;
      $f$;
    $sab$;

    v_def_sab := pg_get_functiondef('public.claim_whatsapp_inbound_event(uuid)'::regprocedure);

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', v_chan, v_unit, v_corpo, 'c3-dobro')
    returning id into v_id;

    select c.claim_id into v_primeiro from public.claim_whatsapp_inbound_event(v_id) c;
    v_primeiro_ok := found;

    select c.claim_id into v_segundo from public.claim_whatsapp_inbound_event(v_id) c;
    v_segundo_ok := found;

    -- segundo vermelho LEGÍTIMO: sem o filtro de status, `done` também volta a
    -- ser trabalhável. É o CLAIM-4, e a mensagem dele nomeia o defeito certo.
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id, status)
    values ('datafy', v_chan, v_unit, v_corpo, 'c3-done', 'done')
    returning id into v_id_done;
    perform 1 from public.claim_whatsapp_inbound_event(v_id_done);
    v_pegou_done := found;

    raise exception 'c-113-3: desfaz a sabotagem' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  v_def_depois := pg_get_functiondef('public.claim_whatsapp_inbound_event(uuid)'::regprocedure);

  insert into t_res values (58, 'C-113-3 claim sem filtro de status derruba o CLAIM-2 (lease vivo reivindicado duas vezes)',
    case
      when v_def_antes is null or v_def_antes not like '%status = ''received''%'
        then 'FALHOU (linha de base: o claim ja nao filtrava por status)'
      when v_def_sab like '%status = ''received''%'
        then 'FALHOU (a sabotagem nao pegou: o filtro de status continua no corpo)'
      when not v_primeiro_ok
        then 'FALHOU (linha de base: nem o PRIMEIRO claim pegou a linha)'
      when not v_segundo_ok
        then 'FALHOU (sem o filtro de status, o segundo claim AINDA devolveu zero — o CLAIM-2 nao tem forca)'
      when v_segundo is not distinct from v_primeiro
        then 'FALHOU (o segundo claim devolveu o MESMO claim_id — nao e o cenario de dois processos)'
      when not v_pegou_done
        then 'FALHOU (sem o filtro de status, a linha `done` AINDA nao foi reivindicada — o CLAIM-4 nao tem forca)'
      when v_def_depois is distinct from v_def_antes
        then 'FALHOU (restore: a definicao divergiu do catalogo original)'
      else 'OK (sem o filtro de status os dois claims levaram a linha, com crachas diferentes, logo o CLAIM-2 '
           || 'fica vermelho; e a linha `done` voltou a ser reivindicavel, logo o CLAIM-4 tambem — os dois '
           || 'vermelhos nomeiam o mesmo defeito real; definicao restaurada)'
    end);
exception when others then
  insert into t_res values (58, 'C-113-3 claim sem filtro de status derruba o CLAIM-2 (lease vivo reivindicado duas vezes)',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)')
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ C-113-4 (59) — lease de 9 s derruba o CLAIM-1, e a asserção frouxa não ══
-- Este controle mede a ESCOLHA DA ASSERÇÃO. O `18` compara `claimed_until` com
-- `now() + interval '90 seconds'` por IGUALDADE, e não por "está no futuro",
-- porque é essa igualdade que prende os 90 s do SQL ao gêmeo
-- `INBOUND_LEASE_TTL_MS` do núcleo. Um lease de 9 s também está no futuro.
--
-- O veredito exige as DUAS medidas: a igualdade reprova (o CLAIM-1 fica
-- vermelho) E a asserção frouxa teria passado (é por isso que ela não foi usada).
-- Sem isso, trocar a igualdade por `> now()` numa limpeza futura não derrubaria
-- nada, e a divergência entre o SQL e o núcleo voltaria a ser indetectável.
do $ctrl$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_def_antes text; v_def_sab text; v_def_depois text;
        v_id uuid; v_until timestamptz;
        v_igualdade_reprova boolean := false;
        v_frouxa_passaria boolean := false;
        v_id_venc uuid; v_retomou boolean := false; v_until_venc timestamptz;
begin
  delete from t_res where ord = 59;

  v_def_antes := pg_get_functiondef('public.claim_whatsapp_inbound_event(uuid)'::regprocedure);

  begin
    execute $sab$
      create or replace function public.claim_whatsapp_inbound_event(p_event_id uuid)
      returns table (
        id          uuid,
        provider    text,
        channel_id  uuid,
        raw_body    bytea,
        attempts    integer,
        claim_id    uuid
      )
      language sql
      security definer
      set search_path = ''
      as $f$
        update public.whatsapp_inbound_events e
           set status        = 'processing',
               claim_id      = gen_random_uuid(),
               claimed_until = now() + make_interval(secs => 9),
               updated_at    = now()
         where e.id = p_event_id
           and (e.status = 'received'
                or (e.status = 'processing' and e.claimed_until < now()))
        returning e.id, e.provider, e.channel_id, e.raw_body, e.attempts, e.claim_id;
      $f$;
    $sab$;

    v_def_sab := pg_get_functiondef('public.claim_whatsapp_inbound_event(uuid)'::regprocedure);

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', v_chan, v_unit, v_corpo, 'c4-lease')
    returning id into v_id;

    perform 1 from public.claim_whatsapp_inbound_event(v_id);
    select e.claimed_until into v_until from whatsapp_inbound_events e where e.id = v_id;

    v_igualdade_reprova := v_until is distinct from now() + interval '90 seconds';
    v_frouxa_passaria   := v_until > now();

    -- O CLAIM-3 tem de ficar VERDE: ele afirma que o takeover retoma e RENOVA o
    -- lease, não que o lease vale 90 s. Foi por afirmar as duas coisas que ele
    -- avermelhava aqui, com mensagem que apontava para o takeover.
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id,
                                         status, claim_id, claimed_until)
    values ('datafy', v_chan, v_unit, v_corpo, 'c4-vencido',
            'processing', gen_random_uuid(), now() - interval '1 second')
    returning id into v_id_venc;

    perform 1 from public.claim_whatsapp_inbound_event(v_id_venc);
    v_retomou := found;
    select e.claimed_until into v_until_venc from whatsapp_inbound_events e where e.id = v_id_venc;

    raise exception 'c-113-4: desfaz a sabotagem' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  v_def_depois := pg_get_functiondef('public.claim_whatsapp_inbound_event(uuid)'::regprocedure);

  insert into t_res values (59, 'C-113-4 lease de 9s derruba o CLAIM-1 pela IGUALDADE; "esta no futuro" passaria',
    case
      when v_def_antes is null or v_def_antes not like '%secs => 90%'
        then 'FALHOU (linha de base: o lease do claim ja nao era de 90s)'
      when v_def_sab like '%secs => 90%'
        then 'FALHOU (a sabotagem nao pegou: o lease continua 90s)'
      when v_until is null
        then 'FALHOU (linha de base: o claim sabotado nao reivindicou a linha, nao ha lease a medir)'
      when not v_igualdade_reprova
        then 'FALHOU (com lease de 9s a assercao por igualdade do CLAIM-1 AINDA passaria — o caso nao tem forca)'
      when not v_frouxa_passaria
        then 'FALHOU (premissa: o lease de 9s nao ficou no futuro, entao este controle nao demonstra por que a igualdade e necessaria)'
      when not v_retomou or v_until_venc is null or v_until_venc <= now()
        then 'FALHOU (respingo: o takeover de lease vencido parou de funcionar ou nao renovou — o CLAIM-3 '
             || 'avermelharia junto e este controle voltaria a desorientar)'
      when v_def_depois is distinct from v_def_antes
        then 'FALHOU (restore: a definicao divergiu do catalogo original)'
      else 'OK (lease de 9s: a igualdade reprova, logo o CLAIM-1 fica vermelho; "> now()" teria passado, '
           || 'logo a igualdade e load-bearing e nao estilo; e o takeover segue retomando e renovando, '
           || 'logo o CLAIM-3 continua verde; definicao restaurada)'
    end);
exception when others then
  insert into t_res values (59, 'C-113-4 lease de 9s derruba o CLAIM-1 pela IGUALDADE; "esta no futuro" passaria',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)')
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ C-113-5 (60) — `attempts + 1` em todo ramo derruba o FIN-3 ═════════════
-- A "simplificação" plausível: tirar o `case` e incrementar sempre, porque
-- "finalizar é uma tentativa". O custo é no desfecho TERMINAL — 401 e sucesso
-- não têm nada a retentar, e gastar tentativa neles encurta a escada dos casos
-- que de fato precisam dela.
--
-- Mede também que o FIN-2 fica verde: o ramo de retentativa continua chegando a
-- `attempts = 1`, que é exatamente o que ele afirma.
do $ctrl$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_def_antes text; v_def_sab text; v_def_depois text;
        v_id uuid; v_claim uuid; v_att_terminal int := -1;
        v_id2 uuid; v_claim2 uuid; v_att_retry int := -1;
begin
  delete from t_res where ord = 60;

  v_def_antes := pg_get_functiondef('public.finalize_whatsapp_inbound_event(uuid,uuid,text,text,text,integer)'::regprocedure);

  begin
    execute $sab$
      create or replace function public.finalize_whatsapp_inbound_event(
        p_event_id            uuid,
        p_claim_id            uuid,
        p_status              text,
        p_outcome             text,
        p_error               text,
        p_retry_delay_seconds integer
      )
      returns integer
      language sql
      security definer
      set search_path = ''
      as $f$
        with fenced as (
          update public.whatsapp_inbound_events e
             set status          = p_status,
                 outcome         = p_outcome,
                 last_error      = left(p_error, 500),
                 attempts        = e.attempts + 1,
                 next_attempt_at = case
                                     when p_retry_delay_seconds is null then now()
                                     else now() + make_interval(secs => p_retry_delay_seconds)
                                   end,
                 claim_id        = null,
                 claimed_until   = null,
                 updated_at      = now()
           where e.id = p_event_id
             and e.claim_id = p_claim_id
          returning 1
        )
        select count(*)::integer from fenced;
      $f$;
    $sab$;

    v_def_sab := pg_get_functiondef('public.finalize_whatsapp_inbound_event(uuid,uuid,text,text,text,integer)'::regprocedure);

    -- metade 1: desfecho TERMINAL de 401. É o que o FIN-3 mede.
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', v_chan, v_unit, v_corpo, 'c5-terminal')
    returning id into v_id;
    select c.claim_id into v_claim from public.claim_whatsapp_inbound_event(v_id) c;
    perform public.finalize_whatsapp_inbound_event(
              v_id, v_claim, 'done', 'queue_unauthorized_terminal', 'http_401', null);
    select e.attempts into v_att_terminal from whatsapp_inbound_events e where e.id = v_id;

    -- metade 2: ramo de RETENTATIVA. É o que o FIN-2 mede.
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', v_chan, v_unit, v_corpo, 'c5-retry')
    returning id into v_id2;
    select c.claim_id into v_claim2 from public.claim_whatsapp_inbound_event(v_id2) c;
    perform public.finalize_whatsapp_inbound_event(
              v_id2, v_claim2, 'received', 'queue_retry_scheduled', null, 30);
    select e.attempts into v_att_retry from whatsapp_inbound_events e where e.id = v_id2;

    raise exception 'c-113-5: desfaz a sabotagem' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  v_def_depois := pg_get_functiondef('public.finalize_whatsapp_inbound_event(uuid,uuid,text,text,text,integer)'::regprocedure);

  insert into t_res values (60, 'C-113-5 attempts+1 em TODO ramo derruba o FIN-3 (terminal gastando tentativa)',
    case
      when v_def_antes is null or v_def_antes not like '%p_status in (''received'', ''dead'')%'
        then 'FALHOU (linha de base: a finalize ja nao condicionava o incremento de attempts)'
      when v_def_sab like '%p_status in (''received'', ''dead'')%'
        then 'FALHOU (a sabotagem nao pegou: o case do incremento continua no corpo)'
      when v_att_terminal <> 1
        then 'FALHOU (com incremento incondicional o desfecho terminal ficou com attempts=' || v_att_terminal
             || ' — esperado 1, logo o FIN-3 nao tem forca)'
      when v_att_retry <> 1
        then 'FALHOU (respingo: o ramo de retentativa ficou com attempts=' || v_att_retry
             || ' em vez de 1 — o FIN-2 avermelharia junto e o controle nao isola)'
      when v_def_depois is distinct from v_def_antes
        then 'FALHOU (restore: a definicao divergiu do catalogo original)'
      else 'OK (terminal passou a gastar tentativa (attempts=1), logo o FIN-3 fica vermelho; '
           || 'a retentativa segue em 1, logo o FIN-2 continua verde; definicao restaurada)'
    end);
exception when others then
  insert into t_res values (60, 'C-113-5 attempts+1 em TODO ramo derruba o FIN-3 (terminal gastando tentativa)',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)')
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ C-113-6 (61) — atraso lido como MILISSEGUNDOS derruba o FIN-2 ══════════
-- A confusão de unidade é o risco real da fronteira: o núcleo guarda a escada em
-- MILISSEGUNDOS (`INBOUND_RETRY_DELAYS_MS`) e converte para segundos ao atravessar
-- para o SQL. Um lado que leia o número na unidade do outro transforma 30 s em
-- 30 ms — e a linha volta imediatamente, em laço quente, sobre um erro que não
-- teve tempo de deixar de existir.
--
-- Segundo controle que mede a ESCOLHA DA ASSERÇÃO: 30 ms também está no futuro,
-- então "está no futuro" passaria. O veredito exige as duas medidas.
do $ctrl$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_def_antes text; v_def_sab text; v_def_depois text;
        v_id uuid; v_claim uuid; v_prox timestamptz;
        v_igualdade_reprova boolean := false;
        v_frouxa_passaria boolean := false;
begin
  delete from t_res where ord = 61;

  v_def_antes := pg_get_functiondef('public.finalize_whatsapp_inbound_event(uuid,uuid,text,text,text,integer)'::regprocedure);

  begin
    execute $sab$
      create or replace function public.finalize_whatsapp_inbound_event(
        p_event_id            uuid,
        p_claim_id            uuid,
        p_status              text,
        p_outcome             text,
        p_error               text,
        p_retry_delay_seconds integer
      )
      returns integer
      language sql
      security definer
      set search_path = ''
      as $f$
        with fenced as (
          update public.whatsapp_inbound_events e
             set status          = p_status,
                 outcome         = p_outcome,
                 last_error      = left(p_error, 500),
                 attempts        = case
                                     when p_status in ('received', 'dead') then e.attempts + 1
                                     else e.attempts
                                   end,
                 next_attempt_at = case
                                     when p_retry_delay_seconds is null then now()
                                     else now() + make_interval(secs => p_retry_delay_seconds / 1000.0)
                                   end,
                 claim_id        = null,
                 claimed_until   = null,
                 updated_at      = now()
           where e.id = p_event_id
             and e.claim_id = p_claim_id
          returning 1
        )
        select count(*)::integer from fenced;
      $f$;
    $sab$;

    v_def_sab := pg_get_functiondef('public.finalize_whatsapp_inbound_event(uuid,uuid,text,text,text,integer)'::regprocedure);

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', v_chan, v_unit, v_corpo, 'c6-unidade')
    returning id into v_id;
    select c.claim_id into v_claim from public.claim_whatsapp_inbound_event(v_id) c;

    perform public.finalize_whatsapp_inbound_event(
              v_id, v_claim, 'received', 'queue_retry_scheduled', null, 30);
    select e.next_attempt_at into v_prox from whatsapp_inbound_events e where e.id = v_id;

    v_igualdade_reprova := v_prox is distinct from now() + interval '30 seconds';
    v_frouxa_passaria   := v_prox > now();

    raise exception 'c-113-6: desfaz a sabotagem' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  v_def_depois := pg_get_functiondef('public.finalize_whatsapp_inbound_event(uuid,uuid,text,text,text,integer)'::regprocedure);

  insert into t_res values (61, 'C-113-6 atraso lido como MILISSEGUNDOS derruba o FIN-2; "esta no futuro" passaria',
    case
      when v_def_antes is null or v_def_antes not like '%secs => p_retry_delay_seconds)%'
        then 'FALHOU (linha de base: a finalize ja nao montava o atraso com secs => p_retry_delay_seconds)'
      when v_def_sab like '%secs => p_retry_delay_seconds)%'
        then 'FALHOU (a sabotagem nao pegou: a conversao de unidade continua a original)'
      when v_prox is null
        then 'FALHOU (linha de base: a finalize sabotada nao escreveu next_attempt_at)'
      when not v_igualdade_reprova
        then 'FALHOU (com o atraso em ms a assercao por igualdade do FIN-2 AINDA passaria — o caso nao tem forca)'
      when not v_frouxa_passaria
        then 'FALHOU (premissa: 30ms nao ficou no futuro, entao este controle nao demonstra por que a igualdade e necessaria)'
      when v_def_depois is distinct from v_def_antes
        then 'FALHOU (restore: a definicao divergiu do catalogo original)'
      else 'OK (30 lido como ms: a igualdade reprova, logo o FIN-2 fica vermelho; e "> now()" teria passado, '
           || 'logo a igualdade e load-bearing; definicao restaurada)'
    end);
exception when others then
  insert into t_res values (61, 'C-113-6 atraso lido como MILISSEGUNDOS derruba o FIN-2; "esta no futuro" passaria',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)')
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ C-113-7 (62) — drop + create sem o `revoke` derruba o ACL-113 ══════════
-- Este controle carrega um RESULTADO NEGATIVO MEDIDO, e ele é metade da
-- evidência: **`create or replace` NÃO reabre o EXECUTE a PUBLIC.** O ACL fica
-- preso ao objeto e sobrevive à substituição do corpo — então uma migration
-- futura que só troque a implementação não precisa repetir o `revoke`.
--
-- Quem reabre é DROP + CREATE: o objeto novo nasce com o grant implícito a
-- PUBLIC, e o schema `public` é exposto ao PostgREST com a anon key. Aí uma RPC
-- que move a fila de inbound vira "reivindique ou finalize a entrega de qualquer
-- tenant". É o modo de falha que o `docs/hotfix-acl/` documenta e o caminho mais
-- provável de acontecer de novo: alguém precisa mudar o TIPO de retorno, descobre
-- que `create or replace` recusa, dropa, recria — e não repete o `revoke`.
--
-- O veredito exige as duas medidas. Sem a primeira, este controle diria que o
-- ACL-113 tem força sem dizer contra o quê; sem a segunda, ele não mede nada.
do $ctrl$
declare v_claim_sig text := 'public.claim_whatsapp_inbound_event(uuid)';
        v_def_antes text; v_def_depois text;
        v_anon_apos_replace boolean := true;
        v_anon_apos_drop boolean := false;
        v_pub_apos_drop boolean := false;
        v_anon_restaurado boolean := true;
begin
  delete from t_res where ord = 62;

  v_def_antes := pg_get_functiondef(v_claim_sig::regprocedure);

  begin
    -- metade 1 (resultado negativo medido): substituir o corpo NÃO reabre o ACL.
    execute v_def_antes;
    v_anon_apos_replace := has_function_privilege('anon', v_claim_sig, 'execute');

    -- metade 2: dropar e recriar reabre. É o que o ACL-113 mede.
    execute 'drop function ' || v_claim_sig;
    execute v_def_antes;
    v_anon_apos_drop := has_function_privilege('anon', v_claim_sig, 'execute');
    select p.proacl is null
           or exists (select 1 from unnest(p.proacl) a where a::text like '=%')
      into v_pub_apos_drop
      from pg_proc p where p.oid = v_claim_sig::regprocedure;

    raise exception 'c-113-7: desfaz a sabotagem' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;  -- rollback: o objeto original volta, com o ACL do `revoke` da 113
  end;

  v_def_depois := pg_get_functiondef(v_claim_sig::regprocedure);
  v_anon_restaurado := has_function_privilege('anon', v_claim_sig, 'execute');

  insert into t_res values (62, 'C-113-7 drop+create sem o revoke reabre EXECUTE a PUBLIC (derruba o ACL-113); create or replace NAO reabre',
    case
      when v_def_antes is null
        then 'FALHOU (linha de base: pg_get_functiondef nao devolveu a definicao do claim)'
      when v_anon_apos_replace
        then 'FALHOU (premissa: create or replace REABRIU o execute a anon — entao toda migration que troque corpo precisa repetir o revoke, e o comentario da 113 esta errado)'
      when not v_anon_apos_drop
        then 'FALHOU (depois de drop+create, anon AINDA nao executa — o ACL-113 nao tem forca contra o modo de falha que ele existe para pegar)'
      when not v_pub_apos_drop
        then 'FALHOU (depois de drop+create, o grant implicito a PUBLIC nao apareceu no proacl — a perna de PUBLIC do ACL-113 nao seria exercitada)'
      when v_anon_restaurado
        then 'FALHOU (restore: anon CONTINUA com execute depois do rollback — sabotagem de ACL de pe no banco)'
      when v_def_depois is distinct from v_def_antes
        then 'FALHOU (restore: a definicao divergiu do catalogo original)'
      else 'OK (create or replace preserva o ACL; drop+create reabre execute a anon e o grant a PUBLIC, '
           || 'logo o ACL-113 fica vermelho; ACL e definicao restaurados pelo rollback)'
    end);
exception when others then
  insert into t_res values (62, 'C-113-7 drop+create sem o revoke reabre EXECUTE a PUBLIC (derruba o ACL-113); create or replace NAO reabre',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)')
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ C-113-8 (82) — `claim` sem o incremento do takeover derruba o CLAIM-5 ══
-- A sabotagem é EXATAMENTE a forma anterior desta migration, e é por isso que
-- ela é plausível: "incrementar é trabalho da finalização" foi o desenho até a
-- Task 8, e está escrito em prosa em mais de um lugar do repositório.
--
-- O custo é a LINHA ENVENENADA POR DURAÇÃO: o worker que começa e não termina
-- nunca alcança a finalização, logo `attempts` nunca avança, logo a linha nunca
-- chega a `dead` — e como `purge_whatsapp_inbound_events` só alcança `done` e
-- `dead`, o `raw_body` (telefone e texto de cliente, PII) fica retido
-- indefinidamente. Nada trava e nada alerta: a ordenação da varredura por
-- `updated_at` devolve essa linha ao fim da fila a cada serviço.
--
-- Mede também que o CLAIM-6 fica VERDE: sem o `case`, o claim normal continua
-- não gastando tentativa, então o vermelho é localizado e a mensagem do CLAIM-5
-- aponta para o takeover, que é onde o defeito está.
do $ctrl$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_def_antes text; v_def_sab text; v_def_depois text;
        v_id_venc uuid; v_retomou boolean := false;
        v_att_venc int := -1; v_att_devolvido int := -1;
        v_id_novo uuid; v_att_novo int := -1;
begin
  delete from t_res where ord = 82;

  v_def_antes := pg_get_functiondef('public.claim_whatsapp_inbound_event(uuid)'::regprocedure);

  begin
    execute $sab$
      create or replace function public.claim_whatsapp_inbound_event(p_event_id uuid)
      returns table (
        id          uuid,
        provider    text,
        channel_id  uuid,
        raw_body    bytea,
        attempts    integer,
        claim_id    uuid
      )
      language sql
      security definer
      set search_path = ''
      as $f$
        update public.whatsapp_inbound_events e
           set status        = 'processing',
               claim_id      = gen_random_uuid(),
               claimed_until = now() + make_interval(secs => 90),
               updated_at    = now()
         where e.id = p_event_id
           and (e.status = 'received'
                or (e.status = 'processing' and e.claimed_until < now()))
        returning e.id, e.provider, e.channel_id, e.raw_body, e.attempts, e.claim_id;
      $f$;
    $sab$;

    v_def_sab := pg_get_functiondef('public.claim_whatsapp_inbound_event(uuid)'::regprocedure);

    -- metade 1: TAKEOVER de lease vencido. É o que o CLAIM-5 mede.
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id,
                                         status, claim_id, claimed_until, attempts)
    values ('datafy', v_chan, v_unit, v_corpo, 'c8-vencido',
            'processing', gen_random_uuid(), now() - interval '1 second', 1)
    returning id into v_id_venc;

    select c.attempts into v_att_devolvido from public.claim_whatsapp_inbound_event(v_id_venc) c;
    v_retomou := found;
    select e.attempts into v_att_venc from whatsapp_inbound_events e where e.id = v_id_venc;

    -- metade 2: claim NORMAL. É o que o CLAIM-6 mede.
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id, attempts)
    values ('datafy', v_chan, v_unit, v_corpo, 'c8-received', 2)
    returning id into v_id_novo;

    perform 1 from public.claim_whatsapp_inbound_event(v_id_novo);
    select e.attempts into v_att_novo from whatsapp_inbound_events e where e.id = v_id_novo;

    raise exception 'c-113-8: desfaz a sabotagem' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  v_def_depois := pg_get_functiondef('public.claim_whatsapp_inbound_event(uuid)'::regprocedure);

  insert into t_res values (82, 'C-113-8 claim sem o incremento do takeover derruba o CLAIM-5 (linha envenenada por duracao)',
    case
      when v_def_antes is null or v_def_antes not like '%case when e.status = ''processing''%'
        then 'FALHOU (linha de base: o claim ja nao incrementava attempts no takeover — entao o CLAIM-5 esta passando por outro motivo)'
      when v_def_sab like '%case when e.status = ''processing''%'
        then 'FALHOU (a sabotagem nao pegou: o incremento continua no corpo)'
      when not v_retomou
        then 'FALHOU (linha de base: o lease vencido nao foi retomado nem com a sabotagem — nao ha incremento a derrubar)'
      when v_att_venc <> 1
        then 'FALHOU (sem o case, o takeover AINDA levou attempts para ' || v_att_venc
             || ' — esperado continuar 1, logo o CLAIM-5 nao tem forca)'
      when v_att_devolvido <> 1
        then 'FALHOU (sem o case, o returning devolveu ' || v_att_devolvido || ' em vez do valor antigo 1)'
      when v_att_novo <> 2
        then 'FALHOU (respingo: o claim normal passou a gastar tentativa (attempts=' || v_att_novo
             || ') — o CLAIM-6 avermelharia junto e o controle nao isola)'
      when v_def_depois is distinct from v_def_antes
        then 'FALHOU (restore: a definicao divergiu do catalogo original)'
      else 'OK (sem o incremento o takeover deixa attempts em 1, logo o CLAIM-5 fica vermelho; '
           || 'o claim normal segue em 2, logo o CLAIM-6 continua verde; definicao restaurada)'
    end);
exception when others then
  insert into t_res values (82, 'C-113-8 claim sem o incremento do takeover derruba o CLAIM-5 (linha envenenada por duracao)',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)')
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;
