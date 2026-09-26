-- CLAIM-1..3, FIN-1..3, ACL-113 (ordinais 49..55), CLAIM-4 (ordinal 63) e
-- CLAIM-5/CLAIM-6 (ordinais 80..81): as duas RPCs da migration 113, contra
-- Postgres real.
--
-- OS ORDINAIS NÃO SÃO CONTÍGUOS POR ARQUIVO, e não precisam ser. O CLAIM-4 está
-- em 63 porque 56..62 já pertenciam aos controles do `19` quando ele nasceu (um
-- achado de revisão); o CLAIM-5 e o CLAIM-6 estão em 80..81 porque 64..79 já
-- pertenciam ao `20`/`21` quando a Task 8 acrescentou o incremento do takeover.
--
-- O que este arquivo prova é a peça que impede DUAS EXECUÇÕES DA MESMA LINHA —
-- que, nesta fase, significa duas IAs respondendo ao mesmo cliente. Duas
-- metades: a exclusividade do claim (só um processo leva a linha, e o lease
-- vencido é retomável) e a cerca da finalização (o perdedor de um takeover não
-- escreve por cima do veredito do vencedor).
--
-- Ele NÃO prova a Edge Function: o `index.ts` do `webhook-whatsapp` importa
-- `deno.land` e chama `serve()` no carregamento, então o vitest não o alcança.
-- A metade de lá é o núcleo puro `queuedEventVerdict`
-- (`src/lib/whatsapp-inbound-queue-core.test.ts`), que decide QUAL veredito;
-- aqui se prova que o banco EXECUTA o veredito recebido do jeito prometido.
--
-- SEQUÊNCIA (banco PRÓPRIO, ver a seção deste arquivo no README):
--   00-bootstrap.sql
--   00a-whatsapp-legacy-seed.sql
--   supabase/migrations/20260716130000_061_platform_flags.sql
--   supabase/migrations/20260924120000_111_whatsapp_inbound_events.sql
--   supabase/migrations/20260924120100_112_inbound_sweep_trigger.sql
--   supabase/migrations/20260924120200_113_inbound_claim_rpc.sql
--   18-inbound-claim-113.sql      <- este
--   19-controles-113.sql
--
-- A 112 entra na sequência por ser a migration entre a 111 e a 113, não porque
-- algum caso dependa dela: ela só cria o wrapper da varredura, que este arquivo
-- não chama (sem `pg_net` neste harness, de propósito).
--
-- CADA CASO SE DESFAZ, pela convenção do `16`: o corpo roda numa subtransação
-- que termina em `raise ... using errcode = 'ZZ113'`, capturado ali mesmo. O
-- arquivo é RE-RUNNABLE e não deixa linha em `whatsapp_inbound_events`.
-- Variável de plpgsql não é transacional, então os valores observados durante o
-- caso sobrevivem ao rollback e o veredito é julgado depois de desfazer.
--
-- CADA CASO TEM A PRÓPRIA LINHA, com `delivery_id` próprio (ruling R15): um
-- controle positivo só vale se o vermelho for LOCALIZADO, e casos que dividem
-- dados avermelham juntos. Foi o defeito que a Task 2 pagou.
--
-- RELÓGIO: `now()` é `transaction_timestamp()`, constante dentro do `do $$`.
-- Por isso o CLAIM-1 compara `claimed_until` com `now() + interval '90 seconds'`
-- por IGUALDADE, e não por "está no futuro": é a asserção que prende os 90 s do
-- SQL ao gêmeo `INBOUND_LEASE_TTL_MS` do núcleo. "Está no futuro" passaria
-- igual com 9 s ou 9000 s.

create table if not exists t_res (ord int primary key, caso text, veredito text);

-- ─── GUARDA: este arquivo só faz sentido DEPOIS da 113 e DEPOIS do `00a` ────
-- Rodado antes, CLAIM-2 e FIN-1 passariam POR ACIDENTE: sem as funções, toda
-- chamada "falha" e todo caso negativo fica verde medindo nada.
do $$
begin
  if to_regprocedure('public.claim_whatsapp_inbound_event(uuid)') is null then
    raise exception '18-inbound-claim-113.sql exige a migration 113 aplicada (public.claim_whatsapp_inbound_event(uuid) ausente). Sequencia: 00 -> 00a -> 061 -> 111 -> 112 -> 113 -> 18 -> 19.';
  end if;
  if to_regprocedure('public.finalize_whatsapp_inbound_event(uuid,uuid,text,text,text,integer)') is null then
    raise exception '18-inbound-claim-113.sql exige a migration 113 aplicada (public.finalize_whatsapp_inbound_event ausente). A 113 pela metade nao e cerca nenhuma.';
  end if;
  if to_regclass('public.whatsapp_inbound_events') is null then
    raise exception '18-inbound-claim-113.sql exige a migration 111 aplicada (tabela public.whatsapp_inbound_events ausente).';
  end if;
  if not exists (select 1 from whatsapp_channels where id = 'dddddddd-0000-0000-0000-000000000001') then
    raise exception '18-inbound-claim-113.sql exige os canais do 00a-whatsapp-legacy-seed.sql (dddddddd-0000-0000-0000-000000000001 ausente). Sem canal, todo insert morre na FK e os casos negativos ficariam verdes medindo nada.';
  end if;
end $$;

-- ─── CLAIM-1 (49): reivindicar uma linha `received` ─────────────────────────
-- Quatro asserções, e a do corpo cru não é decoração: a re-entrada no pipeline
-- só existe porque o claim DEVOLVE `raw_body`. Um `returning` que esquecesse a
-- coluna deixaria o processador sem payload para decodificar, e o veredito
-- diria "reivindicou" sobre uma linha inútil.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{"entry":[{"id":"1"}]}', 'UTF8');
        v_id uuid;
        v_claimou boolean := false;
        v_claim uuid;
        v_att int := -1;
        v_body bytea;
        v_status text;
        v_until timestamptz;
        v_lease_exato boolean := false;
begin
  delete from t_res where ord = 49;

  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', v_chan, v_unit, v_corpo, 'claim-1')
    returning id into v_id;

    select c.claim_id, c.attempts, c.raw_body
      into v_claim, v_att, v_body
      from public.claim_whatsapp_inbound_event(v_id) c;
    v_claimou := found;

    select e.status, e.claimed_until into v_status, v_until
      from whatsapp_inbound_events e where e.id = v_id;
    v_lease_exato := v_until = now() + interval '90 seconds';

    raise exception 'claim-1: desfaz o insert' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;  -- rollback da subtransação: nenhuma linha fica
  end;

  insert into t_res values (49, 'CLAIM-1 linha received e reivindicada: status processing, lease de 90s, corpo cru devolvido',
    case
      when not v_claimou or v_claim is null
        then 'FALHOU (o claim de uma linha received devolveu ZERO linhas — o caminho normal nao reivindica nada)'
      when v_status is distinct from 'processing'
        then 'FALHOU (status ficou ' || coalesce(v_status, 'null') || ' em vez de processing)'
      when not v_lease_exato
        then 'FALHOU (claimed_until nao e now()+90s: ' || coalesce(v_until::text, 'null')
             || ' — o lease divergiu de INBOUND_LEASE_TTL_MS)'
      when v_body is distinct from v_corpo
        then 'FALHOU (o claim nao devolveu o corpo cru intacto — a re-entrada nao teria payload)'
      when v_att <> 0
        then 'FALHOU (attempts veio ' || v_att || ' em vez de 0 — o claim nao pode gastar tentativa)'
      else 'OK (1 linha, status=processing, claimed_until=now()+90s, corpo cru identico, attempts=0)'
    end);
exception when others then
  insert into t_res values (49, 'CLAIM-1 linha received e reivindicada: status processing, lease de 90s, corpo cru devolvido',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── CLAIM-2 (50): o segundo claim imediato devolve ZERO ────────────────────
-- É A CERCA. Sem ela, o caminho rápido (`waitUntil`) e a varredura (`pg_cron`)
-- processam a mesma linha, o que nesta fase significa duas IAs respondendo ao
-- mesmo cliente. O caso mede as DUAS metades: o primeiro claim leva a linha, o
-- segundo não leva nada.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_id uuid;
        v_primeiro uuid;
        v_primeiro_ok boolean := false;
        v_segundo uuid;
        v_segundo_ok boolean := false;
        v_claim_final uuid;
begin
  delete from t_res where ord = 50;

  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', v_chan, v_unit, v_corpo, 'claim-2')
    returning id into v_id;

    select c.claim_id into v_primeiro from public.claim_whatsapp_inbound_event(v_id) c;
    v_primeiro_ok := found;

    select c.claim_id into v_segundo from public.claim_whatsapp_inbound_event(v_id) c;
    v_segundo_ok := found;

    select e.claim_id into v_claim_final from whatsapp_inbound_events e where e.id = v_id;

    raise exception 'claim-2: desfaz o insert' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  insert into t_res values (50, 'CLAIM-2 segundo claim com lease VIVO devolve zero linhas (a cerca)',
    case
      when not v_primeiro_ok
        then 'FALHOU (linha de base: nem o PRIMEIRO claim pegou a linha)'
      when v_segundo_ok
        then 'FALHOU (o segundo claim tambem levou a linha, claim_id=' || coalesce(v_segundo::text, 'null')
             || ' — dois processos rodariam o pipeline sobre a MESMA entrega)'
      when v_claim_final is distinct from v_primeiro
        then 'FALHOU (o claim_id da linha mudou apesar de o segundo claim nao ter devolvido nada: '
             || coalesce(v_claim_final::text, 'null') || ')'
      else 'OK (1o claim levou; 2o devolveu zero linhas; o claim_id na linha continua o do vencedor)'
    end);
exception when others then
  insert into t_res values (50, 'CLAIM-2 segundo claim com lease VIVO devolve zero linhas (a cerca)',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── CLAIM-3 (51): lease VENCIDO é retomável, com claim_id NOVO ─────────────
-- A contraparte do CLAIM-2, e é ela que impede a linha de ficar presa quando o
-- worker morre no meio — o modo de falha que o `notification_outbox` documenta
-- duas vezes não cobrir. O `claim_id` TEM de mudar: se o takeover reusasse o
-- anterior, a cerca da finalização deixaria o worker zumbi (que ainda tem o
-- crachá antigo) escrever sobre o veredito do vivo.
--
-- O lease vencido é montado por UPDATE direto, não esperando 90 s: o que este
-- caso mede é o `where` do claim, não a passagem do tempo.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_id uuid;
        v_velho uuid := '11111111-2222-3333-4444-555555555555';
        v_novo uuid;
        v_retomou boolean := false;
        v_until timestamptz;
begin
  delete from t_res where ord = 51;

  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id, status, claim_id, claimed_until)
    values ('datafy', v_chan, v_unit, v_corpo, 'claim-3', 'processing', v_velho, now() - interval '1 second')
    returning id into v_id;

    select c.claim_id into v_novo from public.claim_whatsapp_inbound_event(v_id) c;
    v_retomou := found;

    select e.claimed_until into v_until from whatsapp_inbound_events e where e.id = v_id;

    raise exception 'claim-3: desfaz o insert' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  insert into t_res values (51, 'CLAIM-3 lease VENCIDO e retomado e o claim_id MUDA (takeover)',
    case
      when not v_retomou
        then 'FALHOU (lease vencido NAO foi retomado — a linha ficaria presa em processing para sempre)'
      when v_novo is null or v_novo = v_velho
        then 'FALHOU (o takeover reusou o claim_id antigo ' || coalesce(v_novo::text, 'null')
             || ' — o worker zumbi ainda poderia finalizar por cima do vivo)'
      -- RENOVAÇÃO, não valor exato. A linha entrou com `claimed_until` no
      -- passado, então `> now()` prova que o takeover reabriu a janela — que é o
      -- que ESTE caso afirma. O valor exato (o gêmeo `INBOUND_LEASE_TTL_MS`) é
      -- asserção do CLAIM-1, e duplicá-la aqui fazia o controle do lease (C-113-4)
      -- avermelhar DOIS casos, com a mensagem "o takeover nao renovou o lease" —
      -- que manda investigar o takeover quando o defeito é o TTL. Controle
      -- positivo vale pelo vermelho ser localizado.
      when v_until is null or v_until <= now()
        then 'FALHOU (o takeover nao renovou o lease: claimed_until=' || coalesce(v_until::text, 'null') || ')'
      else 'OK (retomou, claim_id novo, lease renovado para o futuro)'
    end);
exception when others then
  insert into t_res values (51, 'CLAIM-3 lease VENCIDO e retomado e o claim_id MUDA (takeover)',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── FIN-1 (52): finalizar com claim_id ERRADO não escreve nada ─────────────
-- A cerca da finalização. Sem ela, o PERDEDOR de um takeover marca `done` sobre
-- o veredito de quem de fato respondeu ao cliente — e a linha some da fila com
-- o desfecho errado gravado.
--
-- Duas asserções: o retorno tem de ser ZERO (é ele que o adapter confere, porque
-- `UPDATE` que casa zero linhas devolve `error: null` no supabase-js) E a linha
-- tem de ficar intacta. Só o retorno não bastaria: uma função que devolvesse 0
-- mas escrevesse mesmo assim passaria.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_id uuid;
        v_certo uuid;
        v_afetadas int := -1;
        v_status text;
        v_claim_depois uuid;
        v_outcome text;
begin
  delete from t_res where ord = 52;

  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', v_chan, v_unit, v_corpo, 'fin-1')
    returning id into v_id;

    select c.claim_id into v_certo from public.claim_whatsapp_inbound_event(v_id) c;

    select public.finalize_whatsapp_inbound_event(
             v_id, gen_random_uuid(), 'done', 'queue_processed', null, null)
      into v_afetadas;

    select e.status, e.claim_id, e.outcome into v_status, v_claim_depois, v_outcome
      from whatsapp_inbound_events e where e.id = v_id;

    raise exception 'fin-1: desfaz o insert' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  insert into t_res values (52, 'FIN-1 finalizar com claim_id ERRADO afeta zero linhas e nao muda a linha',
    case
      when v_certo is null
        then 'FALHOU (linha de base: o claim nao pegou a linha, entao nao ha cerca a testar)'
      when v_afetadas <> 0
        then 'FALHOU (a finalize com crachá errado afetou ' || v_afetadas
             || ' linha(s) — o perdedor do takeover escreve por cima do vencedor)'
      when v_status is distinct from 'processing'
        then 'FALHOU (devolveu 0 mas ESCREVEU: status virou ' || coalesce(v_status, 'null') || ')'
      when v_claim_depois is distinct from v_certo
        then 'FALHOU (devolveu 0 mas limpou/trocou o claim_id: ' || coalesce(v_claim_depois::text, 'null') || ')'
      when v_outcome is not null
        then 'FALHOU (devolveu 0 mas gravou outcome=' || v_outcome || ')'
      else 'OK (0 linhas afetadas; status, claim_id e outcome intactos)'
    end);
exception when others then
  insert into t_res values (52, 'FIN-1 finalizar com claim_id ERRADO afeta zero linhas e nao muda a linha',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── FIN-2 (53): retentativa incrementa, agenda pelo BANCO e devolve a linha ─
-- O atraso chega em SEGUNDOS e quem monta o instante é `now()` do banco — o
-- mesmo relógio que o claim depois compara. `now()` é constante na transação,
-- então a asserção é por IGUALDADE com `now() + 30 s`: "está no futuro" passaria
-- com 1 s ou com 1 dia, e a diferença entre esses dois é a resposta chegar ou
-- não chegar ao cliente.
--
-- A truncagem de `last_error` em 500 é medida aqui, na mesma linha, porque é
-- promessa da própria migration e não custa um caso novo.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_id uuid;
        v_claim uuid;
        v_afetadas int := -1;
        v_status text; v_att int := -1; v_prox timestamptz;
        v_claim_depois uuid; v_until_depois timestamptz;
        v_outcome text; v_erro_len int := -1;
begin
  delete from t_res where ord = 53;

  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', v_chan, v_unit, v_corpo, 'fin-2')
    returning id into v_id;

    select c.claim_id into v_claim from public.claim_whatsapp_inbound_event(v_id) c;

    select public.finalize_whatsapp_inbound_event(
             v_id, v_claim, 'received', 'queue_retry_scheduled', repeat('e', 600), 30)
      into v_afetadas;

    select e.status, e.attempts, e.next_attempt_at, e.claim_id, e.claimed_until,
           e.outcome, length(e.last_error)
      into v_status, v_att, v_prox, v_claim_depois, v_until_depois, v_outcome, v_erro_len
      from whatsapp_inbound_events e where e.id = v_id;

    raise exception 'fin-2: desfaz o insert' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  insert into t_res values (53, 'FIN-2 retentativa: attempts+1, next_attempt_at=now()+30s pelo BANCO, lease liberado',
    case
      when v_afetadas <> 1
        then 'FALHOU (a finalize com o crachá certo afetou ' || v_afetadas || ' linha(s) em vez de 1)'
      when v_status is distinct from 'received'
        then 'FALHOU (status ficou ' || coalesce(v_status, 'null') || ' em vez de received)'
      when v_att <> 1
        then 'FALHOU (attempts ficou ' || v_att || ' em vez de 1 — a escada nunca esgotaria)'
      when v_prox is distinct from now() + interval '30 seconds'
        then 'FALHOU (next_attempt_at=' || coalesce(v_prox::text, 'null')
             || ' em vez de now()+30s — o atraso nao foi montado pelo relogio do banco)'
      when v_claim_depois is not null or v_until_depois is not null
        then 'FALHOU (o lease nao foi liberado: claim_id=' || coalesce(v_claim_depois::text, 'null')
             || ' claimed_until=' || coalesce(v_until_depois::text, 'null') || ')'
      when v_outcome is distinct from 'queue_retry_scheduled'
        then 'FALHOU (outcome ficou ' || coalesce(v_outcome, 'null') || ')'
      when v_erro_len <> 500
        then 'FALHOU (last_error ficou com ' || v_erro_len || ' caracteres em vez dos 500 truncados)'
      else 'OK (1 linha, received, attempts=1, next_attempt_at=now()+30s, lease nulo, last_error truncado em 500)'
    end);
exception when others then
  insert into t_res values (53, 'FIN-2 retentativa: attempts+1, next_attempt_at=now()+30s pelo BANCO, lease liberado',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── FIN-3 (54): recusa terminal de 401 morre em `done`, sem gastar tentativa ─
-- Existe uma guarda de 401 que fica DEPOIS da fronteira do ACK e não pode subir
-- (`manual_echo_channel_identity_mismatch`). Com o gate ligado ela vira linha na
-- fila, e retentá-la queimaria três tentativas sobre payload que NUNCA será
-- aceito.
--
-- E ela morre em `done`, não em `dead`, porque `dead` reteria o CORPO CRU — PII
-- de cliente — por 30 dias, quando o rastro de segurança já existe em
-- `webhook_executions` SEM o corpo. Este caso mede o que o BANCO faz com o
-- veredito; quem decide que 401 é terminal é `queuedEventVerdict`, no núcleo
-- puro, com dois controles positivos próprios.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_id uuid;
        v_claim uuid;
        v_afetadas int := -1;
        v_status text; v_att int := -1; v_outcome text; v_claim_depois uuid;
begin
  delete from t_res where ord = 54;

  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', v_chan, v_unit, v_corpo, 'fin-3')
    returning id into v_id;

    select c.claim_id into v_claim from public.claim_whatsapp_inbound_event(v_id) c;

    select public.finalize_whatsapp_inbound_event(
             v_id, v_claim, 'done', 'queue_unauthorized_terminal', 'http_401', null)
      into v_afetadas;

    select e.status, e.attempts, e.outcome, e.claim_id
      into v_status, v_att, v_outcome, v_claim_depois
      from whatsapp_inbound_events e where e.id = v_id;

    raise exception 'fin-3: desfaz o insert' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  insert into t_res values (54, 'FIN-3 recusa terminal de 401 fica done (nao dead) e NAO gasta tentativa',
    case
      when v_afetadas <> 1
        then 'FALHOU (afetou ' || v_afetadas || ' linha(s) em vez de 1)'
      when v_status = 'dead'
        then 'FALHOU (401 terminou em dead — o corpo cru, que e PII, ficaria retido 30 dias em vez de 7)'
      when v_status is distinct from 'done'
        then 'FALHOU (status ficou ' || coalesce(v_status, 'null') || ' em vez de done)'
      when v_att <> 0
        then 'FALHOU (attempts virou ' || v_att || ' — desfecho terminal nao gasta tentativa)'
      when v_outcome is distinct from 'queue_unauthorized_terminal'
        then 'FALHOU (outcome ficou ' || coalesce(v_outcome, 'null') || ')'
      when v_claim_depois is not null
        then 'FALHOU (o lease nao foi liberado no desfecho terminal)'
      else 'OK (done, attempts=0, outcome=queue_unauthorized_terminal, lease liberado)'
    end);
exception when others then
  insert into t_res values (54, 'FIN-3 recusa terminal de 401 fica done (nao dead) e NAO gasta tentativa',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── CLAIM-4 (63): linha TERMINAL não é reivindicável ───────────────────────
-- A terceira perna do `where` do claim, a que não aparece escrita: só `received`
-- e `processing`-com-lease-vencido são reivindicáveis, então `done` e `dead`
-- ficam de fora por AUSÊNCIA. O que se mede aqui é essa ausência.
--
-- Importa porque `done` é onde MORRE a recusa terminal de 401 (FIN-3) e onde
-- termina todo sucesso: se `done` fosse reivindicável, cada linha já respondida
-- seria reprocessada pela varredura a cada minuto até a purga de 7 dias levá-la —
-- e cada reprocessamento é uma re-entrada no pipeline, com o cliente recebendo a
-- mesma resposta de novo. O que hoje impede isso é só o filtro de status, e
-- nenhum outro caso o exercita a partir de um estado terminal.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_id_done uuid; v_id_dead uuid;
        v_pegou_done boolean := true;
        v_pegou_dead boolean := true;
begin
  delete from t_res where ord = 63;

  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id, status)
    values ('datafy', v_chan, v_unit, v_corpo, 'claim-4-done', 'done')
    returning id into v_id_done;

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id, status)
    values ('datafy', v_chan, v_unit, v_corpo, 'claim-4-dead', 'dead')
    returning id into v_id_dead;

    perform 1 from public.claim_whatsapp_inbound_event(v_id_done);
    v_pegou_done := found;

    perform 1 from public.claim_whatsapp_inbound_event(v_id_dead);
    v_pegou_dead := found;

    raise exception 'claim-4: desfaz o insert' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  insert into t_res values (63, 'CLAIM-4 linha done/dead NAO e reivindicavel (o cliente nao recebe a mesma resposta de novo)',
    case
      when v_pegou_done
        then 'FALHOU (uma linha `done` foi reivindicada — a varredura reprocessaria toda entrega ja respondida ate a purga)'
      when v_pegou_dead
        then 'FALHOU (uma linha `dead` foi reivindicada — dead letter voltaria a rodar sozinha, sem pessoa nenhuma)'
      else 'OK (done e dead devolveram zero linhas)'
    end);
exception when others then
  insert into t_res values (63, 'CLAIM-4 linha done/dead NAO e reivindicavel (o cliente nao recebe a mesma resposta de novo)',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── CLAIM-5 (80): o TAKEOVER gasta uma tentativa ──────────────────────────
-- É o fechamento da linha ENVENENADA POR DURAÇÃO. Antes deste incremento,
-- `attempts` só avançava na FINALIZAÇÃO — e o worker que começa e não termina
-- (wall clock do WORKER esgotado, isolate derrubado, `waitUntil` cortado) nunca
-- alcança a finalização. A linha era retomada pelo takeover a cada 90 s, para
-- sempre, sem nunca chegar a `dead`: e como `purge_whatsapp_inbound_events` só
-- alcança `done` e `dead`, o `raw_body` — telefone e texto de cliente, PII —
-- ficava retido INDEFINIDAMENTE. Nada travava e nada alertava.
--
-- DUAS asserções, e a segunda é a que importa para o Deno: a coluna avança E o
-- `returning` devolve o valor JÁ INCREMENTADO. É desse valor que
-- `shouldPromoteToDead` decide não processar; um `returning` que entregasse o
-- valor antigo atrasaria a promoção em um ciclo inteiro de lease.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_id uuid;
        v_retomou boolean := false;
        v_att_devolvido int := -1;
        v_att_linha int := -1;
begin
  delete from t_res where ord = 80;

  begin
    -- A linha nasce com uma tentativa gasta e o lease VENCIDO: é o retrato de
    -- um worker que morreu no meio do segundo serviço.
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id,
                                         status, claim_id, claimed_until, attempts)
    values ('datafy', v_chan, v_unit, v_corpo, 'claim-5',
            'processing', gen_random_uuid(), now() - interval '1 second', 1)
    returning id into v_id;

    select c.attempts into v_att_devolvido from public.claim_whatsapp_inbound_event(v_id) c;
    v_retomou := found;

    select e.attempts into v_att_linha from whatsapp_inbound_events e where e.id = v_id;

    raise exception 'claim-5: desfaz o insert' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  insert into t_res values (80, 'CLAIM-5 takeover de lease vencido GASTA uma tentativa e devolve o valor ja incrementado',
    case
      when not v_retomou
        then 'FALHOU (linha de base: o lease vencido nao foi retomado — ver CLAIM-3, o defeito esta no takeover e nao no incremento)'
      when v_att_linha <> 2
        then 'FALHOU (attempts na linha ficou ' || v_att_linha || ' em vez de 2 — a linha envenenada por DURACAO '
             || 'nunca chega a dead, e o corpo cru (PII) fica retido indefinidamente)'
      when v_att_devolvido <> 2
        then 'FALHOU (o claim devolveu attempts=' || v_att_devolvido || ' em vez de 2 — o Deno decidiria '
             || 'com o valor ANTIGO e a promocao a dead atrasaria um ciclo de lease inteiro)'
      else 'OK (attempts 1 -> 2 na linha, e o returning devolveu 2)'
    end);
exception when others then
  insert into t_res values (80, 'CLAIM-5 takeover de lease vencido GASTA uma tentativa e devolve o valor ja incrementado',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── CLAIM-6 (81): o claim NORMAL não gasta tentativa ──────────────────────
-- A contraparte do CLAIM-5, e é ela que mantém o incremento sendo um FATO e não
-- uma política: em `received` nada foi tentado ainda. Se o claim gastasse
-- tentativa sempre, TODA entrega nova começaria um degrau adiante e a escada de
-- retentativa encurtaria para todo mundo — inclusive para as que dão certo na
-- primeira.
--
-- A linha entra com `attempts = 2` de propósito: o CLAIM-1 já cobre o caso zero,
-- e com zero um incremento indevido seria fácil de confundir com o valor
-- default.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_id uuid;
        v_claimou boolean := false;
        v_att_devolvido int := -1;
        v_att_linha int := -1;
begin
  delete from t_res where ord = 81;

  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id, attempts)
    values ('datafy', v_chan, v_unit, v_corpo, 'claim-6', 2)
    returning id into v_id;

    select c.attempts into v_att_devolvido from public.claim_whatsapp_inbound_event(v_id) c;
    v_claimou := found;

    select e.attempts into v_att_linha from whatsapp_inbound_events e where e.id = v_id;

    raise exception 'claim-6: desfaz o insert' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  insert into t_res values (81, 'CLAIM-6 claim de linha received NAO gasta tentativa (nada foi tentado ainda)',
    case
      when not v_claimou
        then 'FALHOU (linha de base: o claim de uma linha received devolveu zero linhas — ver CLAIM-1)'
      when v_att_linha <> 2
        then 'FALHOU (attempts na linha virou ' || v_att_linha || ' em vez de continuar 2 — o claim normal '
             || 'passou a gastar tentativa e a escada encurtou para TODA entrega nova)'
      when v_att_devolvido <> 2
        then 'FALHOU (o claim devolveu attempts=' || v_att_devolvido || ' em vez de 2)'
      else 'OK (attempts continua 2 na linha e no returning)'
    end);
exception when others then
  insert into t_res values (81, 'CLAIM-6 claim de linha received NAO gasta tentativa (nada foi tentado ainda)',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── ACL-113 (55): as duas RPCs são só do service_role ──────────────────────
-- `CREATE FUNCTION` concede EXECUTE a PUBLIC por padrão e o schema `public` é
-- exposto ao PostgREST com a anon key — uma RPC que move a fila de inbound
-- acessível por anon seria "reivindique/finalize a entrega de qualquer tenant".
-- O guardrail estático do CI (`scripts/function-acl-allowlist.test.ts`) confere
-- GRANT em migration; este caso confere o ACL EFETIVO, incluindo o grant
-- implícito que só some com o `revoke`.
-- O grant a PUBLIC é conferido de duas formas porque `proacl` NULO significa
-- "privilégios default", isto é, o EXECUTE implícito a PUBLIC ainda de pé — e
-- uma consulta que só varresse o array leria NULL como "nada concedido".
do $$
declare v_claim text := 'public.claim_whatsapp_inbound_event(uuid)';
        v_fin text := 'public.finalize_whatsapp_inbound_event(uuid,uuid,text,text,text,integer)';
        v_anon boolean; v_auth boolean; v_svc boolean; v_pub boolean;
        v_anon_f boolean; v_auth_f boolean; v_svc_f boolean; v_pub_f boolean;
begin
  delete from t_res where ord = 55;

  v_anon := has_function_privilege('anon', v_claim, 'execute');
  v_auth := has_function_privilege('authenticated', v_claim, 'execute');
  v_svc := has_function_privilege('service_role', v_claim, 'execute');
  select p.proacl is null
         or exists (select 1 from unnest(p.proacl) a where a::text like '=%')
    into v_pub
    from pg_proc p where p.oid = v_claim::regprocedure;

  v_anon_f := has_function_privilege('anon', v_fin, 'execute');
  v_auth_f := has_function_privilege('authenticated', v_fin, 'execute');
  v_svc_f := has_function_privilege('service_role', v_fin, 'execute');
  select p.proacl is null
         or exists (select 1 from unnest(p.proacl) a where a::text like '=%')
    into v_pub_f
    from pg_proc p where p.oid = v_fin::regprocedure;

  insert into t_res values (55, 'ACL-113 claim/finalize executaveis so por service_role',
    case
      when v_anon or v_auth or v_anon_f or v_auth_f
        then 'FALHOU (execute vazado: claim anon=' || v_anon || '/auth=' || v_auth
             || ', finalize anon=' || v_anon_f || '/auth=' || v_auth_f || ')'
      when v_pub or v_pub_f
        then 'FALHOU (o grant implicito a PUBLIC sobreviveu: claim=' || v_pub || ' finalize=' || v_pub_f || ')'
      when not v_svc or not v_svc_f
        then 'FALHOU (service_role NAO executa: claim=' || v_svc || ' finalize=' || v_svc_f
             || ' — a Edge Function nao conseguiria processar a fila)'
      else 'OK (anon/authenticated/PUBLIC sem execute; service_role com execute nas duas)'
    end);
exception when others then
  insert into t_res values (55, 'ACL-113 claim/finalize executaveis so por service_role',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;
