-- INBOUND-1..INBOUND-7 (ordinais 37..43): a tabela `whatsapp_inbound_events` da
-- migration 111, contra Postgres real.
--
-- Este arquivo prova COMPORTAMENTO: CHECK, FK, unique parcial, distinção de NULL
-- e a postura do gate. Ele NÃO prova RLS efetiva, grants, ACL nem PostgREST —
-- `force row level security` sem policies só tem consequência observável com um
-- papel que não seja o dono da tabela nem `bypassrls`, e a metade PostgREST
-- (nenhuma rota REST para esta tabela) depende de Supabase de verdade. O que dá
-- para afirmar localmente está em INBOUND-7: RLS ligada, forçada e com ZERO
-- policies, que é a postura que a Edge Function `service_role` pressupõe.
--
-- SEQUÊNCIA (banco PRÓPRIO, ver a seção deste arquivo no README):
--   00-bootstrap.sql
--   00a-whatsapp-legacy-seed.sql
--   supabase/migrations/20260716130000_061_platform_flags.sql
--   supabase/migrations/20260924120000_111_whatsapp_inbound_events.sql
--   16-inbound-events-111.sql      <- este
--   17-controles-111.sql
--
-- Banco próprio, e não o `fase6c` nem o `advisor106`: este arquivo declara
-- `t_res` com `ord int primary key`, igual ao `09` e posteriores, enquanto o
-- `03` e o `05` declaram sem chave primária — os dois conjuntos não convivem.
--
-- POR QUE O SEED É O `00a`, E NÃO O `02`: os casos precisam de linha em
-- `whatsapp_channels`, e é o `00a` que cria canais (o `02` insere em
-- `whatsapp_instances`, que só existe depois da migration 087 — trazer a 087 só
-- para ter ids seria sequência mais longa sem veredito novo).
--
-- POR QUE NÃO PRECISA DA 110: o `provider` que os casos exercitam é o da
-- PRÓPRIA tabela nova (allowlist de cinco valores, criada pela 111). A linha de
-- canal referenciada nasce com `provider = 'zapi'`, que o CHECK do
-- `00-bootstrap.sql` já aceita — evento `datafy` apontando para canal `zapi` é
-- combinação sem sentido em produção e perfeitamente válida no banco, e é só
-- disso que estes casos dependem.
--
-- CADA CASO SE DESFAZ: o corpo de cada um roda dentro de uma subtransação que
-- termina com `raise ... using errcode = 'ZZ111'`, capturado ali mesmo —
-- a convenção do CONTROLE-16 do `09`. Consequência: o arquivo é RE-RUNNABLE e
-- não deixa uma linha em `whatsapp_inbound_events`. Sem isso, a 2a passada de
-- INBOUND-2 bateria no unique do próprio `delivery_id` que a 1a gravou, e a
-- falha pareceria defeito da tabela. Variável de plpgsql não é transacional,
-- então os valores observados durante o caso sobrevivem ao rollback e o veredito
-- é julgado depois de desfazer.
--
-- Handlers `when others` gravam com `on conflict (ord) do update` pela razão
-- documentada no `09`: o `delete from t_res` do início é desfeito pelo rollback
-- da subtransação quando é o OUTER block que estoura, e na 2a passada o insert
-- bateria em chave duplicada — abortando o arquivo sob ON_ERROR_STOP e sumindo
-- com o veredito de todos os casos seguintes.
--
-- ═══ SÓ O INBOUND-3 DEPENDE DE NULL COEXISTIR — E ISSO É INVARIANTE ══════════
-- Todo caso que insere MAIS DE UMA linha no MESMO canal passa `delivery_id`
-- explícito e distinto, mesmo quando o id não tem nada a ver com o que o caso
-- mede. A razão é o valor do controle positivo: a sabotagem do C-111-2
-- (`nulls not distinct`) tem de produzir UM vermelho, no caso que fala de NULL.
--
-- MEDIDO na versão anterior deste arquivo: com o INBOUND-5 inserindo cinco
-- linhas e o INBOUND-6 duas, todas sem `delivery_id`, aquela sabotagem produzia
-- TRÊS vermelhos — e os dois extras diziam apenas `duplicate key value violates
-- unique constraint`, sem nomear nada. No INBOUND-6 isso se lê como problema de
-- FK/cascade e manda o mantenedor investigar o lugar errado. Nem o CHECK de
-- `provider` (INBOUND-5) nem o cascade da FK (INBOUND-6) têm relação com NULLs
-- coexistirem, e não devem depender dessa propriedade.
--
-- Caso novo aqui segue a regra: uma linha por canal pode omitir `delivery_id`
-- (uma linha nunca colide); duas ou mais, nunca.

-- ─── GUARDA: este arquivo só faz sentido DEPOIS da 111 e DEPOIS do `00a` ─────
-- Rodado antes, INBOUND-2/4/5/6 passariam POR ACIDENTE: a tabela não existe,
-- então todo insert "falha" e todo caso negativo fica verde medindo nada.
-- Recusar é o RED explícito, mesmo desenho do guard do `12` e do `14`.
do $$
begin
  if to_regclass('public.whatsapp_inbound_events') is null then
    raise exception '16-inbound-events-111.sql exige a migration 111 aplicada (tabela public.whatsapp_inbound_events ausente). Sequencia: 00 -> 00a -> 061 -> 111 -> 16 -> 17.';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'whatsapp_channels'
       and column_name = 'async_ingestion_enabled'
  ) then
    raise exception '16-inbound-events-111.sql exige a migration 111 aplicada (coluna whatsapp_channels.async_ingestion_enabled ausente). A tabela existe mas a perna por canal do gate nao — migration 111 pela metade.';
  end if;
  if not exists (select 1 from whatsapp_channels where id = 'dddddddd-0000-0000-0000-000000000001') then
    raise exception '16-inbound-events-111.sql exige os canais do 00a-whatsapp-legacy-seed.sql (dddddddd-0000-0000-0000-000000000001 ausente). Sem canal, todo insert morre na FK e os casos negativos ficariam verdes medindo nada.';
  end if;
  if not exists (select 1 from whatsapp_channels where id = 'dddddddd-0000-0000-0000-000000000005') then
    raise exception '16-inbound-events-111.sql exige o canal dddddddd-0000-0000-0000-000000000005 do 00a-whatsapp-legacy-seed.sql, que é o apagado pelo INBOUND-6.';
  end if;
end $$;

create table if not exists t_res (ord int primary key, caso text, veredito text);

-- ─── INBOUND-1: corpo com NUL sobrevive byte a byte ─────────────────────────
-- O corpo é montado por CONCATENAÇÃO de bytea, e não por literal de texto: um
-- `E'...\u0000...'` é ERRO DE PARSE em Postgres (`invalid Unicode escape
-- value`), medido — o octeto NUL não tem como existir dentro de um literal
-- `text`, que é precisamente o motivo de a coluna ser `bytea`.
--
-- Duas asserções, e a ORDEM das duas é deliberada. `octet_length(raw_body)` é
-- lido por SQL DINÂMICO e julgado primeiro: ele mede o dano mesmo quando o TIPO
-- da coluna mudou, e é o que faz o diagnóstico dizer "24 em vez de 11 octetos"
-- — o que se perdeu — em vez de um "operator does not exist: text = bytea", que
-- é o que a igualdade sozinha produz e não nomeia perda nenhuma. Medido ao
-- rodar o C-111-1 com a sabotagem aplicada de forma persistente.
--
-- Ler a coluna para uma variável `bytea` esconderia o dano, e é por isso que
-- nenhuma das duas faz isso: com a coluna em `text`, inserir os octetos NÃO
-- estoura — o coerce de atribuição grava a representação hex (`\x7b22...`,
-- 24 caracteres) e uma leitura tipada converteria o hex de volta aos 11
-- octetos, deixando o caso VERDE sobre um corpo corrompido.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{"a":"b', 'UTF8') || '\x00'::bytea || convert_to('c"}', 'UTF8');
        v_id uuid;
        v_lido int;
        v_igual boolean := false;
        v_erro_igual text := null;
begin
  delete from t_res where ord = 37;

  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body)
    values ('datafy', v_chan, v_unit, v_corpo)
    returning id into v_id;

    execute 'select octet_length(raw_body) from whatsapp_inbound_events where id = $1'
      into v_lido using v_id;

    -- Igualdade byte a byte, guardada: sob coluna `text` a comparação
    -- `text = bytea` nem chega a planejar, e não planejar CONTA como "não é
    -- igual" — não como caso inconclusivo.
    begin
      execute 'select raw_body = $2 from whatsapp_inbound_events where id = $1'
        into v_igual using v_id, v_corpo;
    exception when others then
      v_igual := false;
      v_erro_igual := sqlstate || ': ' || sqlerrm;
    end;

    raise exception 'inbound-1: desfaz o insert' using errcode = 'ZZ111';
  exception when sqlstate 'ZZ111' then
    null;  -- rollback da subtransação: nenhuma linha fica
  end;

  insert into t_res values (37, 'INBOUND-1 corpo com octeto NUL volta byte a byte (bytea, nao text)',
    case
      when v_lido = octet_length(v_corpo) and v_igual
        then 'OK (' || v_lido || ' octetos, identico ao original)'
      when v_lido is distinct from octet_length(v_corpo)
        then 'FALHOU (esperado ' || octet_length(v_corpo) || ' octetos, veio '
             || coalesce(v_lido::text, 'null') || ' — a coluna nao esta guardando o corpo cru'
             || coalesce('; comparacao byte a byte: ' || v_erro_igual, '') || ')'
      else 'FALHOU (mesmo tamanho mas conteudo diferente do original'
           || coalesce('; ' || v_erro_igual, '') || ')'
    end);
exception when others then
  insert into t_res values (37, 'INBOUND-1 corpo com octeto NUL volta byte a byte (bytea, nao text)',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── INBOUND-2: dedupe de ENTREGA, escopado por canal ───────────────────────
-- Duas asserções, e as duas importam: o mesmo `delivery_id` no MESMO canal é
-- recusado, e no OUTRO canal é aceito. Sem a segunda metade, um unique global
-- (sem `channel_id`) passaria — e aí o id de entrega de um tenant bloquearia o
-- de outro.
do $$
declare v_chan_a uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit_a uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_chan_c uuid := 'dddddddd-0000-0000-0000-000000000005';
        v_unit_c uuid := 'bbbbbbbb-0000-0000-0000-000000000003';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_recusou boolean := false;
        v_outro_canal_ok boolean := false;
begin
  delete from t_res where ord = 38;

  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', v_chan_a, v_unit_a, v_corpo, 'dup-1');

    begin
      insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
      values ('datafy', v_chan_a, v_unit_a, v_corpo, 'dup-1');
      v_recusou := false;
    exception when unique_violation then
      v_recusou := true;
    end;

    begin
      insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
      values ('datafy', v_chan_c, v_unit_c, v_corpo, 'dup-1');
      v_outro_canal_ok := true;
    exception when unique_violation then
      v_outro_canal_ok := false;
    end;

    raise exception 'inbound-2: desfaz os inserts' using errcode = 'ZZ111';
  exception when sqlstate 'ZZ111' then
    null;
  end;

  insert into t_res values (38, 'INBOUND-2 mesmo delivery_id repete no canal (recusa) e vale noutro canal (aceita)',
    case
      when v_recusou and v_outro_canal_ok then 'OK (repetido no canal = unique_violation; mesmo id noutro canal = aceito)'
      when not v_recusou then 'FALHOU (segunda entrega com o mesmo delivery_id no MESMO canal foi aceita)'
      else 'FALHOU (o mesmo delivery_id noutro canal foi recusado — o unique nao esta escopado por channel_id)'
    end);
exception when others then
  insert into t_res values (38, 'INBOUND-2 mesmo delivery_id repete no canal (recusa) e vale noutro canal (aceita)',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── INBOUND-3: delivery_id NULL não deduplica ──────────────────────────────
-- Providers legados não declaram id de entrega; para eles a autoridade de
-- idempotência segue sendo `processed_messages (provider, message_id)`. Duas
-- entregas com `delivery_id` NULL no mesmo canal TÊM de coexistir — senão o
-- segundo inbound de uma rajada Z-API sumiria como "duplicata".
--
-- MEDIDO: o que sustenta isso é NULL ser distinto de NULL em índice unique por
-- default, NÃO o predicado parcial `where delivery_id is not null`. Derrubar o
-- predicado mantém este caso verde. Quem derruba é `nulls not distinct`, e é
-- essa a sabotagem do C-111-2.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_n int := -1;
begin
  delete from t_res where ord = 39;

  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('zapi', v_chan, v_unit, v_corpo, null),
           ('zapi', v_chan, v_unit, v_corpo, null),
           ('zapi', v_chan, v_unit, v_corpo, null);

    select count(*) into v_n
      from whatsapp_inbound_events
     where channel_id = v_chan and delivery_id is null;

    raise exception 'inbound-3: desfaz os inserts' using errcode = 'ZZ111';
  exception when sqlstate 'ZZ111' then
    null;
  end;

  insert into t_res values (39, 'INBOUND-3 tres entregas legadas com delivery_id NULL coexistem',
    case
      when v_n = 3 then 'OK (3 linhas com delivery_id NULL no mesmo canal)'
      else 'FALHOU (esperado 3 linhas, contou ' || v_n || ' — NULL esta deduplicando)'
    end);
exception when unique_violation then
  insert into t_res values (39, 'INBOUND-3 tres entregas legadas com delivery_id NULL coexistem',
    'FALHOU: NULL deduplicou (unique_violation) — inbound legado seria descartado como duplicata. ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
when others then
  insert into t_res values (39, 'INBOUND-3 tres entregas legadas com delivery_id NULL coexistem',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── INBOUND-4: delivery_id em branco é recusado pelo CHECK ─────────────────
-- Gêmeo do `normalizeDeliveryId` do núcleo (Task 1): string vazia não pode
-- virar chave de dedupe, porque o unique é parcial e `''` não é NULL — duas
-- entregas distintas com header vazio colidiriam e a segunda sumiria. O caller
-- normaliza para NULL; o CHECK é o backstop para quem não passar pelo caller.
-- Três formas do mesmo defeito: vazia, só espaços, e além de 512.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_vazia boolean := false;
        v_espacos boolean := false;
        v_longa boolean := false;
        v_limite boolean := false;
begin
  delete from t_res where ord = 40;

  begin
    begin
      insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
      values ('datafy', v_chan, v_unit, v_corpo, '');
    exception when check_violation then v_vazia := true;
    end;

    begin
      insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
      values ('datafy', v_chan, v_unit, v_corpo, '   ');
    exception when check_violation then v_espacos := true;
    end;

    begin
      insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
      values ('datafy', v_chan, v_unit, v_corpo, repeat('x', 513));
    exception when check_violation then v_longa := true;
    end;

    -- Contra-caso: 512 exatos é o LIMITE e tem de PASSAR. Sem ele, um CHECK
    -- `length(...) between 1 and 1` também deixaria as três asserções verdes.
    begin
      insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
      values ('datafy', v_chan, v_unit, v_corpo, repeat('x', 512));
      v_limite := true;
    exception when check_violation then v_limite := false;
    end;

    raise exception 'inbound-4: desfaz o que entrou' using errcode = 'ZZ111';
  exception when sqlstate 'ZZ111' then
    null;
  end;

  insert into t_res values (40, 'INBOUND-4 delivery_id vazio/espacos/>512 recusado, 512 exatos aceito',
    case
      when v_vazia and v_espacos and v_longa and v_limite
        then 'OK (vazia, espacos e 513 recusados por check_violation; 512 exatos aceito)'
      else 'FALHOU (vazia=' || v_vazia || ', espacos=' || v_espacos
           || ', 513=' || v_longa || ', limite_512_aceito=' || v_limite || ')'
    end);
exception when others then
  insert into t_res values (40, 'INBOUND-4 delivery_id vazio/espacos/>512 recusado, 512 exatos aceito',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── INBOUND-5: provider fora do allowlist é recusado ───────────────────────
-- A 110 mostrou que o nome do provider é restringido em oito lugares e que
-- liberar só parte deles estoura no meio do caminho do inbound. Esta é a nona
-- restrição; um provider novo tem de entrar aqui também. Contra-caso: os cinco
-- nomes válidos TÊM de passar, senão um CHECK que recusasse tudo ficaria verde.
--
-- O `delivery_id` (`p-<provider>`) não tem nada a ver com o que este caso mede:
-- ele existe porque cinco linhas no MESMO canal sem id colidiriam sob a
-- sabotagem do C-111-2, e esse vermelho não é deste caso. Ver a nota do
-- cabeçalho. O insert de `telegram` fica sem id de propósito — o CHECK o recusa
-- e ele nunca chega a ser linha.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_recusou boolean := false;
        v_aceitos int := 0;
        v_p text;
begin
  delete from t_res where ord = 41;

  begin
    begin
      insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body)
      values ('telegram', v_chan, v_unit, v_corpo);
    exception when check_violation then v_recusou := true;
    end;

    foreach v_p in array array['zapi','uazapi','waha','official','datafy'] loop
      insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
      values (v_p, v_chan, v_unit, v_corpo, 'p-' || v_p);
      v_aceitos := v_aceitos + 1;
    end loop;

    raise exception 'inbound-5: desfaz o que entrou' using errcode = 'ZZ111';
  exception when sqlstate 'ZZ111' then
    null;
  end;

  insert into t_res values (41, 'INBOUND-5 provider desconhecido recusado, os cinco suportados aceitos',
    case
      when v_recusou and v_aceitos = 5
        then 'OK (telegram recusado por check_violation; zapi/uazapi/waha/official/datafy aceitos)'
      when not v_recusou then 'FALHOU (provider "telegram" foi aceito)'
      else 'FALHOU (dos cinco suportados, so ' || v_aceitos || ' foram aceitos)'
    end);
exception when others then
  insert into t_res values (41, 'INBOUND-5 provider desconhecido recusado, os cinco suportados aceitos',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── INBOUND-6: apagar o canal apaga os eventos e NÃO aborta o DELETE ───────
-- É o defeito que a 089 teve com FK × CHECK: lá, exigir `instance_id is not
-- null` tornava o `on delete set null` inexecutável e o DELETE inteiro abortava.
-- Aqui as duas metades são medidas separadamente — que o DELETE CONCLUIU e que
-- os eventos sumiram. "0 eventos sobraram" sozinho seria verde num mundo em que
-- o DELETE nunca rodou.
--
-- O handler captura `foreign_key_violation` **e** `restrict_violation`, e a
-- segunda não é redundância: MEDIDO, `on delete restrict` estoura **23001
-- (restrict_violation)**, não 23503 — um handler escrito só para
-- `foreign_key_violation`, que é a escolha óbvia, NÃO o captura, e a regressão
-- chegaria aqui como `when others` com mensagem genérica em vez do diagnóstico.
-- É o que o C-111-4 dispara.
--
-- Os dois eventos levam `delivery_id` explícito (`ev-1`/`ev-2`) por uma razão
-- alheia ao cascade: duas linhas no MESMO canal sem id colidem sob a sabotagem
-- do C-111-2, e este caso ficaria vermelho dizendo `duplicate key value` — que
-- se lê como defeito de FK e manda investigar o lugar errado. Ver a nota do
-- cabeçalho.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000005';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000003';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_antes int := -1;
        v_depois int := -1;
        v_canal_sumiu boolean := false;
        v_abortou text := null;
begin
  delete from t_res where ord = 42;

  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('zapi', v_chan, v_unit, v_corpo, 'ev-1'),
           ('zapi', v_chan, v_unit, v_corpo, 'ev-2');

    select count(*) into v_antes from whatsapp_inbound_events where channel_id = v_chan;

    begin
      delete from whatsapp_channels where id = v_chan;
      v_canal_sumiu := not exists (select 1 from whatsapp_channels where id = v_chan);
      select count(*) into v_depois from whatsapp_inbound_events where channel_id = v_chan;
    exception when foreign_key_violation or restrict_violation then
      v_abortou := sqlstate || ': ' || sqlerrm;
    end;

    raise exception 'inbound-6: desfaz o delete do canal' using errcode = 'ZZ111';
  exception when sqlstate 'ZZ111' then
    null;  -- rollback: o canal do seed volta, com os eventos
  end;

  insert into t_res values (42, 'INBOUND-6 apagar o canal cascateia nos eventos sem abortar o DELETE',
    case
      when v_abortou is not null
        then 'FALHOU (o DELETE do canal ABORTOU: ' || v_abortou || ' — FK sem cascade, defeito FK x CHECK da 089)'
      when v_antes <> 2
        then 'FALHOU (linha de base: esperava 2 eventos no canal antes do DELETE, havia ' || v_antes || ')'
      when not v_canal_sumiu
        then 'FALHOU (o DELETE nao estourou mas o canal continua la)'
      when v_depois <> 0
        then 'FALHOU (' || v_depois || ' eventos sobreviveram ao DELETE do canal)'
      else 'OK (2 eventos antes, DELETE concluiu, canal sumiu, 0 eventos sobraram)'
    end);
exception when others then
  insert into t_res values (42, 'INBOUND-6 apagar o canal cascateia nos eventos sem abortar o DELETE',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── INBOUND-7: o gate NASCE DESLIGADO nas duas pernas, e RLS forçada ───────
-- É a "Validação pós-migration" do brief promovida a asserção permanente, em
-- lugar de três queries rodadas uma vez à mão. As quatro coisas que a 111 tem
-- de deixar verdadeiras no instante seguinte a ser aplicada:
--   a) `relrowsecurity` e `relforcerowsecurity` ligadas;
--   b) ZERO policies — a tabela é de `service_role` via Edge Function;
--   c) a flag global semeada e com valor `false`;
--   d) NENHUM canal com `async_ingestion_enabled`.
--
-- Fail-closed por construção: flag AUSENTE deixa `v_flag` em NULL e a asserção
-- `= 'false'::jsonb` não é verdadeira, então "não semeou" reprova junto com
-- "semeou ligada". É por isso que a guarda do topo deste arquivo NÃO confere a
-- flag — conferir lá tornaria este ramo inalcançável.
--
-- Sem controle positivo próprio, e o motivo é que não há sabotagem que ensine
-- algo: virar a flag para `true` ou ligar a coluna de um canal reprova por
-- leitura direta do mesmo valor que a asserção lê. O que um controle fecharia
-- — a asserção estar lendo o lugar errado — já está fechado pelo fail-closed
-- acima: lugar errado devolve NULL e reprova.
do $$
declare v_rls boolean; v_force boolean; v_policies int;
        v_flag jsonb; v_canais int;
begin
  delete from t_res where ord = 43;

  select c.relrowsecurity, c.relforcerowsecurity
    into v_rls, v_force
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'whatsapp_inbound_events';

  select count(*) into v_policies
    from pg_policies where schemaname = 'public' and tablename = 'whatsapp_inbound_events';

  select value into v_flag from platform_flags where key = 'whatsapp_async_ingestion';

  select count(*) into v_canais from whatsapp_channels where async_ingestion_enabled;

  insert into t_res values (43, 'INBOUND-7 gate nasce OFF nas duas pernas; RLS forcada e sem policies',
    case
      when v_rls and v_force and v_policies = 0 and v_flag = 'false'::jsonb and v_canais = 0
        then 'OK (rls=t force=t policies=0 flag=false canais_optados=0)'
      else 'FALHOU (rls=' || coalesce(v_rls::text,'null')
           || ' force=' || coalesce(v_force::text,'null')
           || ' policies=' || coalesce(v_policies::text,'null')
           || ' flag=' || coalesce(v_flag::text,'<ausente>')
           || ' canais_optados=' || coalesce(v_canais::text,'null') || ')'
    end);
exception when others then
  insert into t_res values (43, 'INBOUND-7 gate nasce OFF nas duas pernas; RLS forcada e sem policies',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;
