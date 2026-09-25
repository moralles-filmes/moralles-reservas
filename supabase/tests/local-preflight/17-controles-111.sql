-- CINCO CONTROLES POSITIVOS da migration 111 — ordinais 44..48.
--
-- Rodar SEM ON_ERROR_STOP, pela convenção dos outros `NN-controles-*.sql`: os
-- casos sabotam de propósito e um erro no meio não deve sumir com os vereditos
-- dos seguintes.
--
-- Sem eles, "INBOUND-1..6 passaram" não distingue a tabela estando certa de
-- teste sem força. Cada controle reintroduz UM defeito e mede que o caso alvo
-- fica VERMELHO:
--
--   C-111-1 (44)  `raw_body` vira `text`            -> derruba INBOUND-1
--   C-111-2 (45)  unique com `nulls not distinct`   -> derruba INBOUND-3
--   C-111-3 (46)  sem o CHECK de `delivery_id`      -> derruba INBOUND-4
--   C-111-4 (47)  FK com `on delete restrict`       -> derruba INBOUND-6
--   C-111-5 (48)  sem o CHECK de `provider`         -> derruba INBOUND-5
--
-- O INBOUND-2 (dedupe de entrega) não tem controle próprio porque o C-111-2 já
-- mexe no MESMO índice: derrubá-lo para provar o INBOUND-2 seria dropar o índice,
-- e "sem índice unique, o unique não recusa" é tautologia, não evidência. O que
-- o INBOUND-2 arrisca é o escopo (`channel_id` no índice), e ISSO já está medido
-- dentro do próprio caso, pela metade que exige o mesmo `delivery_id` ser aceito
-- noutro canal. O INBOUND-7 também não tem controle, pela razão escrita no
-- cabeçalho dele (ele é fail-closed por construção).
--
-- ═══ O RESTORE MORA DENTRO DE CADA CONTROLE, E AQUI ISSO NÃO É ESCOLHA ═══════
--
-- Nos conjuntos anteriores deste diretório o README manda REAPLICAR a migration
-- depois do arquivo de controles, porque lá a sabotagem é no corpo de uma função
-- e a migration a define com `create or replace`. **A 111 não restaura nada.**
-- Ela é `create table if not exists` + `create index if not exists` + `add
-- column if not exists`: com a tabela já existindo, reaplicá-la é NO-OP e não
-- devolve o tipo da coluna, o predicado do índice, o CHECK nem o `on delete
-- cascade`. Uma sabotagem esquecida aqui ficaria de pé no banco e faria TODO
-- caso posterior passar ou falhar em silêncio sobre um schema que não é o da
-- migration.
--
-- Por isso cada controle: (1) captura a definição REAL do catálogo antes de
-- mexer, (2) confere que a sabotagem de fato mudou algo — sabotagem que não
-- sabota é o modo silencioso de um controle positivo mentir, a lição do
-- `15-controles-109.sql`, (3) desfaz por ROLLBACK de subtransação
-- (`raise ... using errcode = 'ZZ111'`, como o CONTROLE-16 do `09`), e
-- (4) VERIFICA o restore contra o catálogo. O veredito só é OK se as três
-- metades casarem: linha de base, vermelho, e restore.
--
-- O handler `when others` de cada bloco também desfaz a sabotagem: DDL em
-- plpgsql roda na subtransação do bloco, então falha no meio volta atrás. Nenhum
-- caminho deixa schema sabotado de pé.

-- ─── GUARDA ─────────────────────────────────────────────────────────────────
-- `t_res` é criada ANTES da guarda, e a ordem não é cosmética: a guarda LÊ
-- `t_res` (é assim que ela sabe se o `16` rodou). Com o `create` depois, rodar
-- este arquivo num banco onde o `16` nunca passou estourava `42P01` na própria
-- guarda — e como este arquivo roda SEM ON_ERROR_STOP de propósito, o `psql`
-- imprimia ERROR e SEGUIA: `t_res` era criada logo abaixo e os cinco controles
-- rodavam e PASSAVAM sobre zero caso INBOUND. Detectar isso dependia de o
-- operador notar cinco linhas onde o README promete doze.
--
-- A guarda é DOIS statements, e isso também é necessário: um `raise` desfaz a
-- subtransação do próprio `do`, então um bloco que registrasse e levantasse
-- perderia o registro no rollback. O primeiro bloco DIAGNOSTICA e grava o
-- veredito (ord 0 — não é caso, e `order by ord` o põe no topo da tabela); o
-- segundo só relê essa linha e aborta. Sob ON_ERROR_STOP o arquivo morre ali;
-- sem ele o ERROR é impresso e a linha 0 garante que a falha não se perde entre
-- cinco controles verdes.
create table if not exists t_res (ord int primary key, caso text, veredito text);

do $ctrl$
declare v_falha text := null;
begin
  if to_regclass('public.whatsapp_inbound_events') is null then
    v_falha := 'exige a migration 111 aplicada (tabela public.whatsapp_inbound_events ausente).';
  elsif not exists (select 1 from t_res where ord between 37 and 43) then
    v_falha := 'exige o 16-inbound-events-111.sql rodado antes (nenhum veredito INBOUND-* em t_res). Um controle positivo sem o caso que ele derruba nao mede nada.';
  elsif not exists (select 1 from whatsapp_channels where id = 'dddddddd-0000-0000-0000-000000000005') then
    v_falha := 'exige o canal dddddddd-0000-0000-0000-000000000005 do 00a-whatsapp-legacy-seed.sql (alvo do C-111-4).';
  end if;

  if v_falha is null then
    delete from t_res where ord = 0;   -- sentinela de execução anterior quebrada
  else
    insert into t_res values (0, 'GUARDA-17 pre-requisitos do 17-controles-111.sql (nao e caso)',
      'FALHOU: ' || v_falha)
      on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
  end if;
end $ctrl$;

do $ctrl$
declare v_falha text;
begin
  select veredito into v_falha from t_res where ord = 0;
  if v_falha is not null then
    raise exception '17-controles-111.sql %', v_falha;
  end if;
end $ctrl$;

-- ═══ C-111-1 (44) — `raw_body` em `text` derruba o INBOUND-1 ════════════════
-- Duas metades, e as duas são o defeito:
--   (a) o caminho HONESTO do escritor — entregar o corpo como o `text` que ele
--       seria — estoura 22021 (`invalid byte sequence for encoding "UTF8":
--       0x00`). É o 503 em loop descrito no cabeçalho da migration.
--   (b) o caminho LENIENTE não estoura: o coerce de atribuição bytea->text grava
--       a REPRESENTAÇÃO HEX. `octet_length(raw_body)` sai de 11 para 24, e a
--       asserção do INBOUND-1 fica vermelha. Esta metade é a que justifica o
--       INBOUND-1 comparar `octet_length` lido do banco em vez de ler a coluna
--       para uma variável `bytea` — a leitura tipada converteria o hex de volta
--       aos 11 octetos e o caso ficaria VERDE sobre um corpo corrompido.
do $ctrl$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{"a":"b', 'UTF8') || '\x00'::bytea || convert_to('c"}', 'UTF8');
        v_tipo_antes text; v_tipo_sab text; v_tipo_depois text;
        v_state_honesto text := null;
        v_octetos int := -1;
        v_id uuid;
begin
  delete from t_res where ord = 44;

  select data_type into v_tipo_antes from information_schema.columns
   where table_schema = 'public' and table_name = 'whatsapp_inbound_events'
     and column_name = 'raw_body';

  begin
    alter table whatsapp_inbound_events alter column raw_body type text;

    select data_type into v_tipo_sab from information_schema.columns
     where table_schema = 'public' and table_name = 'whatsapp_inbound_events'
       and column_name = 'raw_body';

    -- (a) caminho honesto: o corpo COMO TEXTO
    begin
      execute 'insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body)
               values (''datafy'', $1, $2, convert_from($3, ''UTF8''))'
        using v_chan, v_unit, v_corpo;
    exception when others then
      v_state_honesto := sqlstate;
    end;

    -- (b) caminho leniente: os octetos, coagidos para text
    execute 'insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body)
             values (''datafy'', $1, $2, $3) returning id'
      into v_id using v_chan, v_unit, v_corpo;
    execute 'select octet_length(raw_body) from whatsapp_inbound_events where id = $1'
      into v_octetos using v_id;

    raise exception 'c-111-1: desfaz a sabotagem' using errcode = 'ZZ111';
  exception when sqlstate 'ZZ111' then
    null;  -- rollback: a coluna volta a bytea, nenhuma linha fica
  end;

  select data_type into v_tipo_depois from information_schema.columns
   where table_schema = 'public' and table_name = 'whatsapp_inbound_events'
     and column_name = 'raw_body';

  insert into t_res values (44, 'C-111-1 raw_body em text derruba o INBOUND-1 (NUL recusado e corpo corrompido)',
    case
      when v_tipo_antes <> 'bytea'
        then 'FALHOU (linha de base: raw_body ja nao era bytea, era ' || coalesce(v_tipo_antes,'null') || ')'
      when v_tipo_sab <> 'text'
        then 'FALHOU (a sabotagem nao pegou: raw_body ficou ' || coalesce(v_tipo_sab,'null') || ')'
      when v_state_honesto is distinct from '22021'
        then 'FALHOU (o corpo como texto NAO estourou 22021: sqlstate '
             || coalesce(v_state_honesto,'<nenhum erro>') || ' — a premissa da migration nao se sustenta)'
      when v_octetos = octet_length(v_corpo)
        then 'FALHOU (em text o corpo ainda mediu ' || v_octetos
             || ' octetos — o INBOUND-1 passaria igual e nao tem forca)'
      when v_tipo_depois <> 'bytea'
        then 'FALHOU (restore: raw_body ficou ' || coalesce(v_tipo_depois,'null') || ' em vez de bytea)'
      else 'OK (corpo como texto estourou 22021; coagido gravou ' || v_octetos || ' em vez de '
           || octet_length(v_corpo) || ' octetos, logo o INBOUND-1 fica vermelho; restaurado para bytea)'
    end);
exception when others then
  insert into t_res values (44, 'C-111-1 raw_body em text derruba o INBOUND-1 (NUL recusado e corpo corrompido)',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)')
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ C-111-2 (45) — `nulls not distinct` derruba o INBOUND-3 ════════════════
-- Este controle carrega um RESULTADO NEGATIVO MEDIDO, e ele é metade da
-- evidência: **derrubar o predicado parcial `where delivery_id is not null` NÃO
-- derruba o INBOUND-3.** NULL é distinto de NULL em índice unique por default,
-- então com um unique CHEIO as entregas legadas continuam entrando. O brief
-- desta task supunha o contrário; medir foi o que mostrou que aquela sabotagem
-- seria um controle verde tendo sabotado coisa nenhuma.
--
-- Quem derruba é `nulls not distinct` — a "melhoria" plausível de quem lê o
-- índice e acha que está apertando o dedupe. Aí duas entregas legadas do mesmo
-- canal colidem e o segundo inbound de uma rajada some como duplicata.
--
-- O veredito exige as DUAS: passo 1 aceito (o predicado não é behavioral) e
-- passo 2 recusado (o caso tem força).
do $ctrl$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_def_antes text; v_def_depois text;
        v_sem_predicado_aceitou boolean := false;
        v_nnd_recusou boolean := false;
begin
  delete from t_res where ord = 45;

  select pg_get_indexdef(i.indexrelid) into v_def_antes
    from pg_index i join pg_class c on c.oid = i.indexrelid
   where c.relname = 'whatsapp_inbound_events_delivery_idx';

  begin
    -- passo 1: unique CHEIO, sem o predicado parcial. NULLs seguem distintos.
    drop index whatsapp_inbound_events_delivery_idx;
    create unique index whatsapp_inbound_events_delivery_idx
      on whatsapp_inbound_events (channel_id, delivery_id);

    begin
      insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
      values ('zapi', v_chan, v_unit, v_corpo, null),
             ('zapi', v_chan, v_unit, v_corpo, null),
             ('zapi', v_chan, v_unit, v_corpo, null);
      v_sem_predicado_aceitou := true;
    exception when unique_violation then
      v_sem_predicado_aceitou := false;
    end;
    delete from whatsapp_inbound_events where channel_id = v_chan and delivery_id is null;

    -- passo 2: `nulls not distinct`. AGORA as entregas legadas colidem.
    drop index whatsapp_inbound_events_delivery_idx;
    create unique index whatsapp_inbound_events_delivery_idx
      on whatsapp_inbound_events (channel_id, delivery_id) nulls not distinct;

    begin
      insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
      values ('zapi', v_chan, v_unit, v_corpo, null),
             ('zapi', v_chan, v_unit, v_corpo, null),
             ('zapi', v_chan, v_unit, v_corpo, null);
      v_nnd_recusou := false;
    exception when unique_violation then
      v_nnd_recusou := true;
    end;

    raise exception 'c-111-2: desfaz a sabotagem' using errcode = 'ZZ111';
  exception when sqlstate 'ZZ111' then
    null;  -- rollback: o índice parcial original volta
  end;

  select pg_get_indexdef(i.indexrelid) into v_def_depois
    from pg_index i join pg_class c on c.oid = i.indexrelid
   where c.relname = 'whatsapp_inbound_events_delivery_idx';

  insert into t_res values (45, 'C-111-2 unique com nulls not distinct derruba o INBOUND-3',
    case
      when v_def_antes is null or v_def_antes not like '%delivery_id IS NOT NULL%'
        then 'FALHOU (linha de base: o indice nao era o parcial esperado: ' || coalesce(v_def_antes,'<ausente>') || ')'
      when not v_sem_predicado_aceitou
        then 'FALHOU (sem o predicado parcial as tres entregas NULL foram recusadas — contraria a medicao e o INBOUND-3 mediria outra coisa)'
      when not v_nnd_recusou
        then 'FALHOU (com nulls not distinct as entregas NULL AINDA coexistiram — o INBOUND-3 nao tem forca)'
      when v_def_depois is distinct from v_def_antes
        then 'FALHOU (restore: indexdef divergiu. antes=' || coalesce(v_def_antes,'null')
             || ' depois=' || coalesce(v_def_depois,'null') || ')'
      else 'OK (sem o predicado parcial os 3 NULL ainda entram — predicado nao e behavioral; com nulls not distinct colidem, logo o INBOUND-3 fica vermelho; indexdef restaurado)'
    end);
exception when others then
  insert into t_res values (45, 'C-111-2 unique com nulls not distinct derruba o INBOUND-3',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)')
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ C-111-3 (46) — sem o CHECK de `delivery_id` derruba o INBOUND-4 ════════
-- `''` entra, e é exatamente a chave de dedupe que o núcleo (Task 1) proíbe: o
-- unique é parcial e `''` não é NULL, então duas entregas com header vazio
-- colidem e a segunda some como duplicata.
do $ctrl$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_def_antes text; v_def_depois text;
        v_branco_entrou boolean := false;
        v_longo_entrou boolean := false;
begin
  delete from t_res where ord = 46;

  select pg_get_constraintdef(oid) into v_def_antes from pg_constraint
   where conrelid = 'whatsapp_inbound_events'::regclass
     and conname = 'whatsapp_inbound_events_delivery_id_check';

  begin
    alter table whatsapp_inbound_events
      drop constraint whatsapp_inbound_events_delivery_id_check;

    begin
      insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
      values ('datafy', v_chan, v_unit, v_corpo, '   ');
      v_branco_entrou := true;
    exception when check_violation then v_branco_entrou := false;
    end;

    begin
      insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
      values ('datafy', v_chan, v_unit, v_corpo, repeat('x', 513));
      v_longo_entrou := true;
    exception when check_violation then v_longo_entrou := false;
    end;

    raise exception 'c-111-3: desfaz a sabotagem' using errcode = 'ZZ111';
  exception when sqlstate 'ZZ111' then
    null;  -- rollback: o CHECK volta
  end;

  select pg_get_constraintdef(oid) into v_def_depois from pg_constraint
   where conrelid = 'whatsapp_inbound_events'::regclass
     and conname = 'whatsapp_inbound_events_delivery_id_check';

  insert into t_res values (46, 'C-111-3 sem o CHECK de delivery_id, branco e >512 entram (derruba o INBOUND-4)',
    case
      when v_def_antes is null
        then 'FALHOU (linha de base: o CHECK whatsapp_inbound_events_delivery_id_check nao existia — nome mudou? entao o INBOUND-4 esta passando por outro motivo)'
      when not v_branco_entrou
        then 'FALHOU (sem o CHECK, delivery_id em branco AINDA foi recusado — o INBOUND-4 nao tem forca)'
      when not v_longo_entrou
        then 'FALHOU (sem o CHECK, delivery_id de 513 AINDA foi recusado — o limite vem de outro lugar)'
      when v_def_depois is distinct from v_def_antes
        then 'FALHOU (restore: constraintdef divergiu. antes=' || coalesce(v_def_antes,'null')
             || ' depois=' || coalesce(v_def_depois,'null') || ')'
      else 'OK (branco e 513 entraram sem o CHECK, logo o INBOUND-4 fica vermelho; CHECK restaurado identico)'
    end);
exception when others then
  insert into t_res values (46, 'C-111-3 sem o CHECK de delivery_id, branco e >512 entram (derruba o INBOUND-4)',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)')
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ C-111-4 (47) — FK com `on delete restrict` derruba o INBOUND-6 ═════════
-- É o defeito FK × CHECK da 089 na sua forma mais simples: com `restrict`, o
-- DELETE do canal ABORTA. Quem apaga um canal pelo painel leva erro de banco em
-- vez de remoção, e o evento inbound fica preso referenciando canal que o
-- operador acredita ter apagado.
--
-- MEDIDO AO ESCREVER ESTE CONTROLE, e é por isso que ele existe: `on delete
-- restrict` estoura **23001 (`restrict_violation`)**, NÃO 23503
-- (`foreign_key_violation`). A primeira versão deste caso capturava só
-- `foreign_key_violation` — a escolha óbvia — e o erro atravessou os dois
-- handlers até o `when others`. O INBOUND-6 tinha a mesma escrita e foi
-- corrigido junto; sem este controle, aquele handler morto seguiria no arquivo
-- sem nunca ser exercitado, porque com `cascade` o ramo nem é alcançado.
--
-- Os dois eventos levam `delivery_id` explícito (`c4-1`/`c4-2`) pela regra do
-- cabeçalho do `16`: duas linhas no MESMO canal sem id colidem se alguém
-- apertar o índice para `nulls not distinct`, e este caso ficaria vermelho
-- dizendo `duplicate key value` — sobre um controle de FK. MEDIDO com a
-- sabotagem aplicada de forma persistente: era o único caso do `17`, além do
-- próprio C-111-2, que reagia; e o do C-111-2 é reação CERTA (a linha de base
-- dele confere o indexdef e acusa o índice trocado).
do $ctrl$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000005';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000003';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_def_antes text; v_def_depois text;
        v_abortou boolean := false;
        v_state text := null;
begin
  delete from t_res where ord = 47;

  select pg_get_constraintdef(oid) into v_def_antes from pg_constraint
   where conrelid = 'whatsapp_inbound_events'::regclass
     and conname = 'whatsapp_inbound_events_channel_id_fkey';

  begin
    alter table whatsapp_inbound_events
      drop constraint whatsapp_inbound_events_channel_id_fkey;
    alter table whatsapp_inbound_events
      add constraint whatsapp_inbound_events_channel_id_fkey
      foreign key (channel_id) references whatsapp_channels(id) on delete restrict;

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('zapi', v_chan, v_unit, v_corpo, 'c4-1'),
           ('zapi', v_chan, v_unit, v_corpo, 'c4-2');

    begin
      delete from whatsapp_channels where id = v_chan;
      v_abortou := false;
    exception when foreign_key_violation or restrict_violation then
      v_abortou := true;
      v_state := sqlstate;
    end;

    raise exception 'c-111-4: desfaz a sabotagem' using errcode = 'ZZ111';
  exception when sqlstate 'ZZ111' then
    null;  -- rollback: a FK volta com on delete cascade, o canal volta
  end;

  select pg_get_constraintdef(oid) into v_def_depois from pg_constraint
   where conrelid = 'whatsapp_inbound_events'::regclass
     and conname = 'whatsapp_inbound_events_channel_id_fkey';

  insert into t_res values (47, 'C-111-4 FK com on delete restrict aborta o DELETE do canal (derruba o INBOUND-6)',
    case
      when v_def_antes is null or v_def_antes not like '%ON DELETE CASCADE%'
        then 'FALHOU (linha de base: a FK de channel_id nao era ON DELETE CASCADE: ' || coalesce(v_def_antes,'<ausente>') || ')'
      when not v_abortou
        then 'FALHOU (com restrict o DELETE do canal AINDA concluiu — o INBOUND-6 nao tem forca)'
      when v_def_depois is distinct from v_def_antes
        then 'FALHOU (restore: constraintdef divergiu. antes=' || coalesce(v_def_antes,'null')
             || ' depois=' || coalesce(v_def_depois,'null') || ')'
      when not exists (select 1 from whatsapp_channels where id = v_chan)
        then 'FALHOU (restore: o canal do seed nao voltou)'
      else 'OK (com restrict o DELETE abortou em ' || coalesce(v_state,'?')
           || ', logo o INBOUND-6 fica vermelho; FK e canal restaurados)'
    end);
exception when others then
  insert into t_res values (47, 'C-111-4 FK com on delete restrict aborta o DELETE do canal (derruba o INBOUND-6)',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)')
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ C-111-5 (48) — sem o CHECK de `provider` derruba o INBOUND-5 ═══════════
-- Acréscimo ao mínimo do brief. A 110 mostrou que o nome do provider é
-- restringido em oito lugares e que liberar parte deles estoura no meio do
-- caminho do inbound; esta tabela é a nona restrição. Sem controle, "INBOUND-5
-- passou" não distingue o CHECK funcionando de o insert estar falhando por outro
-- motivo qualquer.
do $ctrl$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_def_antes text; v_def_depois text;
        v_entrou boolean := false;
begin
  delete from t_res where ord = 48;

  select pg_get_constraintdef(oid) into v_def_antes from pg_constraint
   where conrelid = 'whatsapp_inbound_events'::regclass
     and conname = 'whatsapp_inbound_events_provider_check';

  begin
    alter table whatsapp_inbound_events
      drop constraint whatsapp_inbound_events_provider_check;

    begin
      insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body)
      values ('telegram', v_chan, v_unit, v_corpo);
      v_entrou := true;
    exception when check_violation then v_entrou := false;
    end;

    raise exception 'c-111-5: desfaz a sabotagem' using errcode = 'ZZ111';
  exception when sqlstate 'ZZ111' then
    null;  -- rollback: o CHECK volta
  end;

  select pg_get_constraintdef(oid) into v_def_depois from pg_constraint
   where conrelid = 'whatsapp_inbound_events'::regclass
     and conname = 'whatsapp_inbound_events_provider_check';

  insert into t_res values (48, 'C-111-5 sem o CHECK de provider, "telegram" entra (derruba o INBOUND-5)',
    case
      when v_def_antes is null
        then 'FALHOU (linha de base: o CHECK whatsapp_inbound_events_provider_check nao existia)'
      when not v_entrou
        then 'FALHOU (sem o CHECK, provider "telegram" AINDA foi recusado — o INBOUND-5 nao tem forca)'
      when v_def_depois is distinct from v_def_antes
        then 'FALHOU (restore: constraintdef divergiu. antes=' || coalesce(v_def_antes,'null')
             || ' depois=' || coalesce(v_def_depois,'null') || ')'
      else 'OK ("telegram" entrou sem o CHECK, logo o INBOUND-5 fica vermelho; CHECK restaurado identico)'
    end);
exception when others then
  insert into t_res values (48, 'C-111-5 sem o CHECK de provider, "telegram" entra (derruba o INBOUND-5)',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)')
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;
