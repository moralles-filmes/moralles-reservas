-- Casos C1..C20 (com C2b, C5b, C5c, C6b, C8b) e os SEIS controles positivos
-- (ordinais 105..135, C14 por último): a migration
-- 20261014120000_datafy_partner_onboarding.sql (Datafy parceiro — liberação
-- por unidade, onboarding fora de `whatsapp_channels`, claim cercado dos
-- passos que geram custo, índice único do `phone_number_id` e ledger de
-- alertas), contra Postgres real.
--
-- O QUE ESTE ARQUIVO PROVA:
--   * liberação: no máximo UMA ativa por unidade (C1), coerência organização ×
--     unidade pela trigger (C2), CHECKs de par/exclusão (C12), canal consumido
--     existente e da MESMA unidade (C19);
--   * onboarding: coerência organização × unidade × liberação (C2b), no máximo
--     UM aberto por unidade (C3), CHECKs de estado/claim/erro (C12),
--     credenciais que não sobrevivem ao fechamento (C15), canal Datafy exigido
--     depois de `open` (C16), vínculos de tenant imutáveis (C17), uma
--     liberação para um onboarding vivo (C18);
--   * o CLAIM: passo livre é reivindicado e o segundo imediato não leva nada
--     nem recebe a cerca de quem leva (C4 — o clique duplo); claim vencido é
--     retomado com `must_reconcile = true` e o dono antigo bate na cerca (C5);
--     a retomada REGISTRA o passo do dono morto em `uncertain_steps` (C5b); o
--     lease vale pelo TTL do DONO, não do desafiante (C5c); passo incerto
--     exige reconciliação até um release que a resolva (C6) e `failed` não a
--     resolve (C6b); cerca velha → 40001 (C7); bordas e TTL limitado a
--     30..900 por igualdade (C10); onboarding de outra unidade → 42501 (C20);
--   * o índice único de `phone_number_id` para official/datafy, inclusive
--     entre os dois providers (C8), lendo o número como o núcleo lê — aparado,
--     vazio não é âncora (C8b);
--   * ACL: as duas RPCs só para service_role, SECURITY DEFINER, `search_path`
--     vazio; as trigger functions fechadas para PUBLIC/anon/authenticated; as
--     três tabelas com RLS forçada, zero policies, sem privilégio para
--     anon/authenticated e sem TRUNCATE/REFERENCES/TRIGGER para o
--     service_role (C9); e o service_role, papel real de produção, gravando e
--     chamando as RPCs (C11);
--   * DELETE da unidade cascateando sem abortar (C13), e idempotência ATRAVÉS
--     de execuções da migration (C14).
--
-- CONTROLES POSITIVOS: cada um reintroduz UM defeito e vê o caso alvo ficar
-- vermelho pela razão certa (o veredito do caso tem de conter um trecho que
-- nomeia o defeito, não basta "FALHOU"):
--   C5-CTRL   claim sem `<ttl>` (nunca vence)               -> C5
--   C5b-CTRL  claim sem `<takeover-incerto>`                -> C5b
--   C5c-CTRL  vivacidade pelo TTL do DESAFIANTE             -> C5c
--   C6b-CTRL  release sem `<failed-mantem>`                 -> C6b
--   C8-CTRL   sem o índice de `phone_number_id`             -> C8
--   C8b-CTRL  índice na forma crua, sem `btrim`             -> C8b
-- Os de função rodam o MESMO corpo do caso (`pg_temp.c5()` etc.), não uma
-- cópia: controle que mede um cenário redigitado mede outra coisa. Cada um
-- captura a definição real do catálogo, confere que a sabotagem mudou algo,
-- mede o defeito, desfaz por ROLLBACK de subtransação (`ZZ061`) e confere o
-- restore contra o catálogo (corpo E ACL; para índice, `pg_get_indexdef`) — o
-- veredito só é `OK` se as três metades casarem. Por não deixarem resíduo,
-- rodam aqui sob ON_ERROR_STOP, como o CONTROLE-16 do `09`. O restore mora no
-- controle, e não no reapply da migration, pela razão da nota "Por que
-- reaplicar a 111 não restaura" do README: `create index if not exists` é
-- no-op sobre um índice com o mesmo nome e outro predicado.
--
-- O QUE ELE NÃO PROVA: exposição PostgREST (depende de Supabase de verdade);
-- o `rolbypassrls` do `postgres` de produção, de que as RPCs SECURITY DEFINER
-- dependem para alcançar uma tabela FORCE RLS (aqui o `postgres` é
-- superusuário e ignora RLS de qualquer jeito — mesma ressalva da 115); e a
-- corrida com DUAS sessões, que é do `61b-concorrencia-datafy-onboarding.sh`.
--
-- SEQUÊNCIA (banco PRÓPRIO `datafy61`, ver a seção no README):
--   00-bootstrap.sql
--   00a-whatsapp-legacy-seed.sql
--   61a-datafy-partner-bootstrap.sql
--   61-datafy-partner-onboarding.sql   <- ANTES da migration: ERROR (guarda)
--   supabase/migrations/20261014120000_datafy_partner_onboarding.sql
--   61-datafy-partner-onboarding.sql   <- 1a passada: C14 = PENDENTE
--   migration duas vezes
--   61-datafy-partner-onboarding.sql   <- 2a passada: C14 = OK
--   61b-concorrencia-datafy-onboarding.sh
--
-- CADA CASO SE DESFAZ: o corpo roda numa subtransação que termina em
-- `raise ... using errcode = 'ZZ061'`, capturado ali mesmo — a convenção do
-- `ZZ115` do `22`. O arquivo é RE-RUNNABLE e não deixa linha nas tabelas novas
-- nem canal datafy (o C14 confere). Nos casos NEGATIVOS o `ZZ061` também é
-- obrigatório: com a guarda defeituosa o insert PASSA, e sem o rollback a linha
-- ficaria. Variável de plpgsql não é transacional, então o que foi observado
-- sobrevive ao rollback e o veredito é julgado depois de desfazer.
--
-- CADA CASO TEM AS PRÓPRIAS LINHAS (ruling R15 do `18`): controle positivo só
-- vale se o vermelho for LOCALIZADO, e casos que dividem dados avermelham
-- juntos. Pela mesma razão, cada tentativa negativa roda na PRÓPRIA
-- subtransação: medido no C2b, uma tentativa que entra indevidamente e fica de
-- pé faz a seguinte morrer num índice e o veredito apontar o lugar errado.
--
-- RELÓGIO: `now()` é `transaction_timestamp()`, constante dentro do `do $$` e
-- das funções chamadas nele. O claim grava `claim_expires_at = now() + TTL` e
-- compara contra `now()`, então "vencido" é forjado recuando
-- `claim_started_at`/`claim_expires_at` (`pg_temp.dp_vence`) — nunca
-- esperando — e o TTL é conferido por IGUALDADE (`= now() + 900 s`), como no
-- `18`: "está no futuro" passaria com qualquer TTL.

-- ─── GUARDA: só faz sentido DEPOIS da migration e do 61a ────────────────────
-- Rodado antes, C1/C2/C3/C7/C8 passariam POR ACIDENTE: sem as tabelas e as
-- RPCs, todo insert e toda chamada "falham", e todo caso negativo fica verde
-- medindo nada.
do $$
begin
  if to_regclass('public.whatsapp_official_connection_grants') is null
     or to_regclass('public.whatsapp_datafy_onboardings') is null
     or to_regclass('public.whatsapp_ops_alerts') is null then
    raise exception '61-datafy-partner-onboarding.sql exige a migration 20261014120000 aplicada (tabelas ausentes). Sequencia: 00 -> 00a -> 61a -> migration -> 61.';
  end if;
  if to_regprocedure('public.claim_datafy_onboarding_step(uuid,uuid,text,uuid,integer)') is null
     or to_regprocedure('public.release_datafy_onboarding_step(uuid,uuid,uuid,text,text,text)') is null then
    raise exception '61-datafy-partner-onboarding.sql exige as duas RPCs da migration 20261014120000 (com p_unit_id). Migration pela metade nao e cerca nenhuma.';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.whatsapp_channels'::regclass
       and conname = 'whatsapp_channels_provider_check'
       and pg_get_constraintdef(oid) like '%datafy%'
  ) then
    raise exception '61-datafy-partner-onboarding.sql exige o 61a-datafy-partner-bootstrap.sql (CHECK de provider sem datafy).';
  end if;
end $$;

create table if not exists t_res (ord int primary key, caso text, veredito text);
create table if not exists t_snap061 (k text primary key, v text not null);

create or replace function pg_temp.dp_res(p_ord int, p_caso text, p_veredito text)
returns void language sql as $$
  insert into t_res values (p_ord, p_caso, p_veredito)
  on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
$$;

-- Liberação válida por default: unidade A1, organização A.
create or replace function pg_temp.dp_grant(
  p_unit uuid default 'bbbbbbbb-0000-0000-0000-000000000001',
  p_org  uuid default 'aaaaaaaa-0000-0000-0000-000000000001'
) returns uuid language sql as $$
  insert into public.whatsapp_official_connection_grants (organization_id, unit_id, granted_by)
  values (p_org, p_unit, gen_random_uuid())
  returning id;
$$;

-- Onboarding válido por default: unidade A1, organização A, sem liberação,
-- aberto. Fora de `open`/`abandoned` o CHECK exige `datafy_channel_id`, que o
-- helper inventa.
create or replace function pg_temp.dp_onb(
  p_unit  uuid default 'bbbbbbbb-0000-0000-0000-000000000001',
  p_org   uuid default 'aaaaaaaa-0000-0000-0000-000000000001',
  p_grant uuid default null,
  p_state text default 'open'
) returns uuid language sql as $$
  insert into public.whatsapp_datafy_onboardings (organization_id, unit_id, grant_id, state, datafy_channel_id)
  values (p_org, p_unit, p_grant, p_state,
          case when p_state in ('open', 'abandoned') then null else 'dfy-' || gen_random_uuid()::text end)
  returning id;
$$;

-- As RPCs com a unidade CERTA, lida da própria linha. Casos que medem a
-- unidade errada (C20) e o papel real (C11) chamam a RPC direto.
create or replace function pg_temp.dp_claim(p_onb uuid, p_step text, p_ttl integer default 120)
returns table (claimed boolean, claim_id uuid, must_reconcile boolean, state text) language sql as $$
  select * from public.claim_datafy_onboarding_step(
    p_onb, (select o.unit_id from public.whatsapp_datafy_onboardings o where o.id = p_onb), p_step, null, p_ttl);
$$;

create or replace function pg_temp.dp_release(p_onb uuid, p_claim uuid, p_step text, p_outcome text, p_err text default null)
returns boolean language sql as $$
  select public.release_datafy_onboarding_step(
    p_onb, (select o.unit_id from public.whatsapp_datafy_onboardings o where o.id = p_onb), p_claim, p_step, p_outcome, p_err);
$$;

-- Forja um claim VENCIDO: tomado há 200 s com o TTL default (120 s).
create or replace function pg_temp.dp_vence(p_onb uuid)
returns void language sql as $$
  update public.whatsapp_datafy_onboardings
     set claim_started_at = now() - interval '200 seconds',
         claim_expires_at = now() - interval '80 seconds'
   where id = p_onb;
$$;

-- Recorta o trecho entre `-- <marcador>` e `-- </marcador>` do corpo real.
-- Mesmo recorte do `23-controles-115.sql` (`.*?` sem flag: no ARE do Postgres
-- `.` casa quebra de linha por default, e o não-guloso para no PRIMEIRO
-- fechamento — medido lá no 18.4; aqui, também com corpo em CRLF).
create or replace function pg_temp.sem_trecho(p_def text, p_marcador text)
returns text language sql as $$
  select regexp_replace(p_def, '-- <' || p_marcador || '>.*?-- </' || p_marcador || '>', '')
$$;

-- Uma tentativa NEGATIVA na própria subtransação: devolve NULL se foi recusada
-- com `check_violation` e mensagem casando `p_msg`; senão, o que deu errado.
-- Se a guarda estiver quebrada e a escrita passar, ela é desfeita (`ZZ061`) e
-- não contamina a tentativa seguinte (medido no C17).
create or replace function pg_temp.tenta(p_sql text, p_rotulo text, p_msg text)
returns text language plpgsql as $f$
declare v_res text;
begin
  begin
    execute p_sql;
    v_res := p_rotulo || ' passou';
    raise exception using errcode = 'ZZ061';
  exception
    when check_violation then
      v_res := case when sqlerrm ilike p_msg then null else p_rotulo || ' recusado pela perna errada: ' || sqlerrm end;
    when sqlstate 'ZZ061' then null;
  end;
  return v_res;
end $f$;

-- ─── C1 (105): duas liberações ATIVAS na mesma unidade → 23505 ───────────────
-- E a contraparte, sem a qual o caso não distingue o índice PARCIAL de um
-- unique cheio em `unit_id`: liberação revogada e liberação consumida não
-- impedem uma nova ativa ("uma liberação paga um canal").
do $$
declare v_state text; v_contra boolean := false; v_g uuid;
begin
  begin
    perform pg_temp.dp_grant();
    begin
      perform pg_temp.dp_grant();
      v_state := 'aceitou';
    exception when unique_violation then v_state := '23505';
    end;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  begin
    v_g := pg_temp.dp_grant();
    update public.whatsapp_official_connection_grants
       set revoked_at = now(), revoked_by = gen_random_uuid() where id = v_g;
    v_g := pg_temp.dp_grant();
    update public.whatsapp_official_connection_grants
       set consumed_at = now(), consumed_channel_id = 'dddddddd-0000-0000-0000-000000000001' where id = v_g;
    perform pg_temp.dp_grant();
    v_contra := true;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  perform pg_temp.dp_res(105, 'C1', case when v_state = '23505' and v_contra then 'OK'
    else format('FALHOU: segunda ativa=%s (esperado 23505); revogada+consumida+nova ativa aceitas=%s', coalesce(v_state, 'null'), v_contra) end);
exception when others then
  perform pg_temp.dp_res(105, 'C1', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C2 (106): liberação com organização de OUTRA organização → trigger ──────
do $$
declare v_state text; v_msg text;
begin
  begin
    -- unidade A1 é da org A; a linha diz org B.
    perform pg_temp.dp_grant(p_org => 'aaaaaaaa-0000-0000-0000-000000000002');
    v_state := 'aceitou';
    raise exception using errcode = 'ZZ061';
  exception
    when check_violation then v_state := '23514'; v_msg := sqlerrm;
    when sqlstate 'ZZ061' then null;
  end;
  perform pg_temp.dp_res(106, 'C2', case when v_state = '23514' and v_msg ilike '%organizacao%' then 'OK'
    else 'FALHOU: liberacao com organizacao alheia aceita ou recusada pela perna errada: '
         || coalesce(v_state, 'null') || ' ' || coalesce(v_msg, '') end);
exception when others then
  perform pg_temp.dp_res(106, 'C2', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C2b (107): onboarding — organização alheia, liberação de outra unidade,
--     e UPDATE que move a linha para unidade de outra organização ──────────────
-- A perna do UPDATE hoje é recusada pela IMUTABILIDADE (C17 mede a guarda em
-- si, inclusive para unidade da MESMA organização); aqui basta que nenhum
-- caminho leve a linha a outra organização.
do $$
declare v_org text; v_grant text; v_upd text; v_g uuid; v_o uuid;
begin
  begin
    perform pg_temp.dp_onb(p_org => 'aaaaaaaa-0000-0000-0000-000000000002');
    v_org := 'aceitou';
    raise exception using errcode = 'ZZ061';
  exception
    when check_violation then
      v_org := case when sqlerrm ilike '%organizacao%' then '23514' else '23514 perna errada: ' || sqlerrm end;
    when sqlstate 'ZZ061' then null;
  end;
  begin
    -- liberação da unidade C1 (org C) num onboarding da unidade A1.
    v_g := pg_temp.dp_grant(p_unit => 'bbbbbbbb-0000-0000-0000-000000000003',
                            p_org  => 'aaaaaaaa-0000-0000-0000-000000000003');
    begin
      perform pg_temp.dp_onb(p_grant => v_g);
      v_grant := 'aceitou';
    exception when check_violation then
      v_grant := case when sqlerrm ilike '%liberacao%' then '23514' else '23514 perna errada: ' || sqlerrm end;
    end;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  begin
    v_o := pg_temp.dp_onb();
    begin
      update public.whatsapp_datafy_onboardings
         set unit_id = 'bbbbbbbb-0000-0000-0000-000000000002' where id = v_o;
      v_upd := 'aceitou';
    exception when check_violation then v_upd := '23514';
    end;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  perform pg_temp.dp_res(107, 'C2b', case when v_org = '23514' and v_grant = '23514' and v_upd = '23514' then 'OK'
    else format('FALHOU: org alheia=%s liberacao de outra unidade=%s update para unidade alheia=%s (esperado 23514 nos tres)',
                coalesce(v_org, 'null'), coalesce(v_grant, 'null'), coalesce(v_upd, 'null')) end);
exception when others then
  perform pg_temp.dp_res(107, 'C2b', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C3 (108): dois onboardings ABERTOS na mesma unidade → 23505 ─────────────
-- Contraparte: `completed` e `abandoned` não contam como abertos.
do $$
declare v_state text; v_contra boolean := false;
begin
  begin
    perform pg_temp.dp_onb();
    begin
      perform pg_temp.dp_onb(p_state => 'channel_created');
      v_state := 'aceitou';
    exception when unique_violation then v_state := '23505';
    end;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  begin
    perform pg_temp.dp_onb(p_state => 'completed');
    perform pg_temp.dp_onb(p_state => 'abandoned');
    perform pg_temp.dp_onb(p_state => 'open');
    v_contra := true;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  perform pg_temp.dp_res(108, 'C3', case when v_state = '23505' and v_contra then 'OK'
    else format('FALHOU: segundo aberto=%s (esperado 23505); completed+abandoned+aberto aceitos=%s', coalesce(v_state, 'null'), v_contra) end);
exception when others then
  perform pg_temp.dp_res(108, 'C3', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C4 (109): claim de passo livre; o segundo imediato não leva nada ────────
-- É o CLIQUE DUPLO da Review Focus 1, na perna sequencial (a corrida com duas
-- sessões é do `61b`). O perdedor recebe `claim_id` NULO: devolver a cerca de
-- quem segura deixaria o perdedor liberá-lo (C7 passaria a aceitar). O segundo
-- claim tenta OUTRO passo também — há um claim por onboarding, não um por
-- passo. A linha fica com a cerca, o passo, `now()`, o lease de 120 s exatos
-- (TTL default) e o ator do primeiro.
do $$
declare
  v_id uuid; v_actor uuid := gen_random_uuid();
  r1 record; r2 record; r3 record;
  v_step text; v_started timestamptz; v_expires timestamptz; v_claim uuid; v_by uuid;
begin
  begin
    v_id := pg_temp.dp_onb();
    select * into r1 from public.claim_datafy_onboarding_step(v_id, 'bbbbbbbb-0000-0000-0000-000000000001', 'create_channel', v_actor);
    select * into r2 from pg_temp.dp_claim(v_id, 'create_channel');
    select * into r3 from pg_temp.dp_claim(v_id, 'subscribe');
    select o.claim_id, o.claim_step, o.claim_started_at, o.claim_expires_at, o.claim_actor_id
      into v_claim, v_step, v_started, v_expires, v_by
      from public.whatsapp_datafy_onboardings o where o.id = v_id;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  perform pg_temp.dp_res(109, 'C4', case
    when not (r1.claimed and r1.claim_id is not null and r1.must_reconcile = false and r1.state = 'open')
      then format('FALHOU: primeiro claim devolveu claimed=%s claim_id=%s must_reconcile=%s state=%s (esperado t, uuid, f, open)',
                  r1.claimed, r1.claim_id, r1.must_reconcile, r1.state)
    when r2.claimed or r2.claim_id is not null
      then format('FALHOU: segundo claim imediato do MESMO passo levou: claimed=%s claim_id=%s (esperado f e NULO)', r2.claimed, r2.claim_id)
    when r3.claimed or r3.claim_id is not null
      then format('FALHOU: claim de OUTRO passo com claim vivo levou: claimed=%s claim_id=%s', r3.claimed, r3.claim_id)
    when v_claim is distinct from r1.claim_id or v_step <> 'create_channel' or v_started <> now()
         or v_expires <> now() + interval '120 seconds' or v_by is distinct from v_actor
      then format('FALHOU: linha nao ficou com a cerca do primeiro: claim=%s step=%s started=%s expires=%s (now=%s) actor=%s',
                  v_claim, v_step, v_started, v_expires, now(), v_by)
    else 'OK' end);
exception when others then
  perform pg_temp.dp_res(109, 'C4', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C5 (110): claim VENCIDO é retomado com must_reconcile = true ────────────
-- Review Focus 2: o dono do claim pode ter morrido DEPOIS do POST à Datafy e
-- ANTES do release. Quem retoma não pode postar antes de reconciliar. E o dono
-- antigo, se voltar do POST e tentar liberar, bate na cerca (40001): o
-- veredito dele não apaga o do novo dono. Essa perna mora aqui, e não no C7,
-- para que o C7 não dependa do TTL.
create or replace function pg_temp.c5() returns text language plpgsql as $$
declare v_id uuid; r1 record; r2 record; v_velho text; v_dono uuid;
begin
  begin
    v_id := pg_temp.dp_onb();
    select * into r1 from pg_temp.dp_claim(v_id, 'create_channel');
    perform pg_temp.dp_vence(v_id);
    select * into r2 from pg_temp.dp_claim(v_id, 'create_channel');
    begin
      perform pg_temp.dp_release(v_id, r1.claim_id, 'create_channel', 'succeeded');
      v_velho := 'aceitou';
    exception when sqlstate '40001' then v_velho := '40001';
    end;
    select o.claim_id into v_dono from public.whatsapp_datafy_onboardings o where o.id = v_id;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  return case
    when not r1.claimed then 'FALHOU: o primeiro claim nem levou (ver C4)'
    when not (r2.claimed and r2.must_reconcile and r2.claim_id is not null and r2.claim_id <> r1.claim_id)
      then format('FALHOU: retomada do claim vencido devolveu claimed=%s must_reconcile=%s claim_id_novo=%s (esperado t, t, uuid diferente)',
                  r2.claimed, r2.must_reconcile, r2.claim_id is distinct from r1.claim_id)
    when v_velho is distinct from '40001' or v_dono is distinct from r2.claim_id
      then format('FALHOU: release do dono antigo=%s (esperado 40001); cerca na linha e do novo dono=%s', coalesce(v_velho, 'null'), v_dono = r2.claim_id)
    else 'OK' end;
exception when others then
  return 'FALHOU: ' || sqlstate || ' ' || sqlerrm;
end $$;
do $$ begin perform pg_temp.dp_res(110, 'C5', pg_temp.c5()); end $$;

-- ─── C5b (111): a retomada REGISTRA o passo do dono morto ───────────────────
-- O `must_reconcile = true` da retomada some no primeiro release de quem
-- retoma; o que sobrevive é `uncertain_steps`. Sem o registro, quem retoma e
-- solta com `failed` (reconciliação ambígua) devolveria o passo a "livre" e o
-- claim seguinte postaria às cegas. Três pernas: o passo do dono entra; o
-- `failed` de quem retoma não o tira (depende também do `<failed-mantem>` do
-- C6b); o dono morto em `subscribe` com quem retoma pedindo `create_webhook`
-- registra `subscribe`, não o pedido; e nada duplica.
-- Se a retomada nem acontece (TTL quebrado), o caso sai cedo apontando o C5:
-- seguir adiante estouraria 40001 no release com cerca nula, e o veredito
-- genérico mandaria investigar a cerca (medido com a sabotagem persistida).
-- Sai pelo `ZZ061`, nunca por `return` dentro do bloco: `return` ali COMMITA
-- a subtransação e deixaria o onboarding do caso de pé.
create or replace function pg_temp.c5b() returns text language plpgsql as $$
declare v_id uuid; r2 record; r3 record; r4 record; r5 record; v_u text[]; v_dif text[]; v_dup text[];
  v_sem_retomada boolean := false;
begin
  begin
    v_id := pg_temp.dp_onb();
    perform pg_temp.dp_claim(v_id, 'create_channel');
    perform pg_temp.dp_vence(v_id);
    select * into r2 from pg_temp.dp_claim(v_id, 'create_channel');
    if not r2.claimed then
      v_sem_retomada := true;
      raise exception using errcode = 'ZZ061';
    end if;
    select o.uncertain_steps into v_u from public.whatsapp_datafy_onboardings o where o.id = v_id;
    perform pg_temp.dp_release(v_id, r2.claim_id, 'create_channel', 'failed', 'DATAFY_RECONCILE_AMBIGUOUS');
    select * into r3 from pg_temp.dp_claim(v_id, 'create_channel');
    perform pg_temp.dp_release(v_id, r3.claim_id, 'create_channel', 'reconciled_absent');

    perform pg_temp.dp_claim(v_id, 'subscribe');
    perform pg_temp.dp_vence(v_id);
    select * into r4 from pg_temp.dp_claim(v_id, 'create_webhook');
    select o.uncertain_steps into v_dif from public.whatsapp_datafy_onboardings o where o.id = v_id;
    perform pg_temp.dp_release(v_id, r4.claim_id, 'create_webhook', 'succeeded');

    perform pg_temp.dp_claim(v_id, 'subscribe');
    perform pg_temp.dp_vence(v_id);
    select * into r5 from pg_temp.dp_claim(v_id, 'subscribe');
    select o.uncertain_steps into v_dup from public.whatsapp_datafy_onboardings o where o.id = v_id;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  -- Fora do `case`: plpgsql avalia de antemão todo campo de record citado na
  -- expressão, e `r3` nem foi atribuído quando a retomada falha (medido: 55000).
  if v_sem_retomada then
    return 'FALHOU: a retomada do claim vencido nem levou (ver C5)';
  end if;
  return case
    when r2.claimed and r2.must_reconcile and v_u = array['create_channel']
         and r3.claimed and r3.must_reconcile
         and r4.claimed and r4.must_reconcile and v_dif = array['subscribe']
         and r5.claimed and r5.must_reconcile and v_dup = array['subscribe'] then 'OK'
    else format('FALHOU: takeover_registrou=%s claim_apos_failed_must_reconcile=%s dono_em_subscribe_pedido_create_webhook=%s sem_duplicar=%s (esperado {create_channel}, t, {subscribe}, {subscribe})',
                v_u, r3.must_reconcile, v_dif, v_dup) end;
exception when others then
  return 'FALHOU: ' || sqlstate || ' ' || sqlerrm;
end $$;
do $$ begin perform pg_temp.dp_res(111, 'C5b', pg_temp.c5b()); end $$;

-- ─── C5c (112): o lease vale pelo TTL do DONO ───────────────────────────────
-- O dono toma com 900 s; 200 s depois um desafiante chama com o TTL default
-- (120 s). Pelo TTL do desafiante o claim estaria vencido; pelo do dono, vivo.
-- Vivo é o certo: o dono pediu 900 s porque o POST dele demora, e o
-- desafiante encurtaria o lease no meio do POST.
create or replace function pg_temp.c5c() returns text language plpgsql as $$
declare v_id uuid; r1 record; r2 record; v_exp timestamptz;
begin
  begin
    v_id := pg_temp.dp_onb();
    select * into r1 from pg_temp.dp_claim(v_id, 'create_channel', 900);
    select o.claim_expires_at into v_exp from public.whatsapp_datafy_onboardings o where o.id = v_id;
    update public.whatsapp_datafy_onboardings
       set claim_started_at = now() - interval '200 seconds',
           claim_expires_at = now() - interval '200 seconds' + interval '900 seconds'
     where id = v_id;
    select * into r2 from pg_temp.dp_claim(v_id, 'create_channel', 120);
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  return case
    when not r1.claimed or v_exp is distinct from now() + interval '900 seconds'
      then format('FALHOU: o dono nao gravou o lease de 900 s: claimed=%s expires=%s (now=%s)', r1.claimed, v_exp, now())
    when r2.claimed
      then 'FALHOU: desafiante levou pelo PROPRIO TTL o claim vivo do dono'
    when r2.claim_id is not null
      then 'FALHOU: o desafiante perdeu mas recebeu a cerca do dono (ver C4)'
    else 'OK' end;
exception when others then
  return 'FALHOU: ' || sqlstate || ' ' || sqlerrm;
end $$;
do $$ begin perform pg_temp.dp_res(112, 'C5c', pg_temp.c5c()); end $$;

-- ─── C6 (113): passo incerto exige reconciliação até um release reconciled_* ─
-- Sequência: uncertain -> claim (must_reconcile) -> uncertain de novo (sem
-- duplicar a entrada) -> claim (must_reconcile) -> reconciled_absent -> claim
-- (sem reconciliação). E a incerteza é POR PASSO: outro passo não herda.
do $$
declare
  v_id uuid; c record; a record; b record; d record; e record;
  v_unc1 text[]; v_err1 text; v_claim1 uuid; v_unc2 text[]; v_unc3 text[]; v_err3 text;
begin
  begin
    v_id := pg_temp.dp_onb();
    select * into c from pg_temp.dp_claim(v_id, 'create_channel');
    perform pg_temp.dp_release(v_id, c.claim_id, 'create_channel', 'uncertain', 'DATAFY_TIMEOUT');
    select o.uncertain_steps, o.last_error, o.claim_id into v_unc1, v_err1, v_claim1
      from public.whatsapp_datafy_onboardings o where o.id = v_id;

    select * into a from pg_temp.dp_claim(v_id, 'create_channel');
    perform pg_temp.dp_release(v_id, a.claim_id, 'create_channel', 'uncertain', 'DATAFY_TIMEOUT');
    select o.uncertain_steps into v_unc2 from public.whatsapp_datafy_onboardings o where o.id = v_id;

    select * into e from pg_temp.dp_claim(v_id, 'subscribe');
    perform pg_temp.dp_release(v_id, e.claim_id, 'subscribe', 'failed', 'DATAFY_PAYMENT_DECLINED');

    select * into b from pg_temp.dp_claim(v_id, 'create_channel');
    perform pg_temp.dp_release(v_id, b.claim_id, 'create_channel', 'reconciled_absent');
    select o.uncertain_steps, o.last_error into v_unc3, v_err3 from public.whatsapp_datafy_onboardings o where o.id = v_id;

    select * into d from pg_temp.dp_claim(v_id, 'create_channel');
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  perform pg_temp.dp_res(113, 'C6', case
    when v_unc1 is distinct from array['create_channel'] or v_err1 is distinct from 'DATAFY_TIMEOUT' or v_claim1 is not null
      then format('FALHOU: release uncertain gravou uncertain_steps=%s last_error=%s claim_restante=%s (esperado {create_channel}, DATAFY_TIMEOUT, null)',
                  v_unc1, v_err1, v_claim1)
    when not (a.claimed and a.must_reconcile)
      then format('FALHOU: claim depois de uncertain: claimed=%s must_reconcile=%s (esperado t, t)', a.claimed, a.must_reconcile)
    when v_unc2 is distinct from array['create_channel']
      then format('FALHOU: segundo uncertain duplicou ou perdeu a entrada: %s', v_unc2)
    when not e.claimed or e.must_reconcile
      then format('FALHOU: outro passo herdou a incerteza: claimed=%s must_reconcile=%s (esperado t, f)', e.claimed, e.must_reconcile)
    when not (b.claimed and b.must_reconcile)
      then format('FALHOU: incerteza sumiu antes do reconciled_*: claimed=%s must_reconcile=%s', b.claimed, b.must_reconcile)
    when v_unc3 is distinct from '{}'::text[] or v_err3 is not null
      then format('FALHOU: reconciled_absent deixou uncertain_steps=%s last_error=%s (esperado {} e null)', v_unc3, v_err3)
    when not d.claimed or d.must_reconcile
      then format('FALHOU: claim depois do reconciled_absent: claimed=%s must_reconcile=%s (esperado t, f)', d.claimed, d.must_reconcile)
    else 'OK' end);
exception when others then
  perform pg_temp.dp_res(113, 'C6', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C6b (114): `failed` NÃO resolve a incerteza ────────────────────────────
-- A reconciliação que falha (ambígua, recusada) não prova que o POST anterior
-- não aconteceu. Se `failed` tirasse o passo de `uncertain_steps`, o claim
-- seguinte voltaria com `must_reconcile = false` e postaria às cegas — o
-- defeito P1 da revisão. `last_error` é atualizado mesmo assim. Contraparte:
-- `succeeded` e `reconciled_present` resolvem.
create or replace function pg_temp.c6b() returns text language plpgsql as $$
declare v_id uuid; c record; a record; n record; v_u1 text[]; v_err text; v_s text[]; v_p text[];
begin
  begin
    v_id := pg_temp.dp_onb();
    select * into c from pg_temp.dp_claim(v_id, 'subscribe');
    perform pg_temp.dp_release(v_id, c.claim_id, 'subscribe', 'uncertain', 'DATAFY_TIMEOUT');
    select * into a from pg_temp.dp_claim(v_id, 'subscribe');
    perform pg_temp.dp_release(v_id, a.claim_id, 'subscribe', 'failed', 'DATAFY_RECONCILE_AMBIGUOUS');
    select o.uncertain_steps, o.last_error into v_u1, v_err from public.whatsapp_datafy_onboardings o where o.id = v_id;
    select * into n from pg_temp.dp_claim(v_id, 'subscribe');
    perform pg_temp.dp_release(v_id, n.claim_id, 'subscribe', 'succeeded');
    select o.uncertain_steps into v_s from public.whatsapp_datafy_onboardings o where o.id = v_id;
    select * into c from pg_temp.dp_claim(v_id, 'create_channel');
    perform pg_temp.dp_release(v_id, c.claim_id, 'create_channel', 'uncertain');
    select * into c from pg_temp.dp_claim(v_id, 'create_channel');
    perform pg_temp.dp_release(v_id, c.claim_id, 'create_channel', 'reconciled_present');
    select o.uncertain_steps into v_p from public.whatsapp_datafy_onboardings o where o.id = v_id;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  return case
    when a.must_reconcile and v_u1 = array['subscribe'] and v_err = 'DATAFY_RECONCILE_AMBIGUOUS'
         and n.claimed and n.must_reconcile and v_s = '{}'::text[] and v_p = '{}'::text[] then 'OK'
    else format('FALHOU: failed_mantem=%s last_error=%s claim_seguinte_must_reconcile=%s succeeded_tira=%s reconciled_present_tira=%s (esperado {subscribe}, DATAFY_RECONCILE_AMBIGUOUS, t, {}, {})',
                v_u1, v_err, n.must_reconcile, v_s, v_p) end;
exception when others then
  return 'FALHOU: ' || sqlstate || ' ' || sqlerrm;
end $$;
do $$ begin perform pg_temp.dp_res(114, 'C6b', pg_temp.c6b()); end $$;

-- ─── C7 (115): release com cerca velha → 40001 ───────────────────────────────
-- Cerca de um claim já liberado, usada depois que outro claim foi tomado: o
-- release recusa, e o claim vivo continua de quem o tomou. Sem depender do TTL
-- (a perna do claim RETOMADO é do C5). Mais três bordas: cerca certa com passo
-- errado, release repetido (claim já limpo) e cerca NULA numa linha sem claim
-- — `null is distinct from null` é falso, e é por isso que a RPC recusa
-- `p_claim_id` nulo explicitamente.
do $$
declare
  v_id uuid; r1 record; r2 record;
  v_velho text; v_passo text; v_certo boolean; v_repetido text; v_nulo text;
begin
  begin
    v_id := pg_temp.dp_onb();
    select * into r1 from pg_temp.dp_claim(v_id, 'create_channel');
    perform pg_temp.dp_release(v_id, r1.claim_id, 'create_channel', 'failed', 'DATAFY_CONFLICT');
    select * into r2 from pg_temp.dp_claim(v_id, 'create_channel');
    begin
      perform pg_temp.dp_release(v_id, r1.claim_id, 'create_channel', 'succeeded');
      v_velho := 'aceitou';
    exception when sqlstate '40001' then
      v_velho := case when sqlerrm = 'stale_onboarding_claim' then '40001' else '40001 msg=' || sqlerrm end;
    end;
    begin
      perform pg_temp.dp_release(v_id, r2.claim_id, 'subscribe', 'succeeded');
      v_passo := 'aceitou';
    exception when sqlstate '40001' then v_passo := '40001';
    end;
    -- Em bloco próprio: se o passo errado tiver passado (e limpado o claim),
    -- este release estoura 40001, e sem o bloco o veredito seria o `when
    -- others` genérico, sem nomear a perna que faltou.
    begin
      v_certo := pg_temp.dp_release(v_id, r2.claim_id, 'create_channel', 'succeeded');
    exception when sqlstate '40001' then v_certo := false;
    end;
    begin
      perform pg_temp.dp_release(v_id, r2.claim_id, 'create_channel', 'succeeded');
      v_repetido := 'aceitou';
    exception when sqlstate '40001' then v_repetido := '40001';
    end;
    begin
      perform pg_temp.dp_release(v_id, null, null, 'succeeded');
      v_nulo := 'aceitou';
    exception when sqlstate '40001' then v_nulo := '40001';
    end;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  perform pg_temp.dp_res(115, 'C7', case
    when v_velho = '40001' and v_passo = '40001' and v_certo and v_repetido = '40001' and v_nulo = '40001' then 'OK'
    else format('FALHOU: cerca velha=%s passo errado=%s cerca certa=%s repetido=%s cerca nula=%s (esperado 40001/40001/t/40001/40001)',
                coalesce(v_velho, 'null'), coalesce(v_passo, 'null'), v_certo, coalesce(v_repetido, 'null'), coalesce(v_nulo, 'null')) end);
exception when others then
  perform pg_temp.dp_res(115, 'C7', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C8 (116): `phone_number_id` repetido em official/datafy → 23505 ─────────
-- O índice é a âncora de `metaPayloadMatchesChannel`: dois canais com o mesmo
-- número fariam o webhook validar payload de um no canal do outro. Vale ENTRE
-- os dois providers (o canal `official` legado da Moralles e um `datafy` novo
-- com o mesmo número colidem). Fora dele: `zapi` com o mesmo valor entra, e
-- canal sem a chave entra quantas vezes for.
create or replace function pg_temp.c8() returns text language plpgsql as $$
declare v_dd text; v_od text; v_zapi boolean := false; v_sem boolean := false;
begin
  begin
    insert into whatsapp_channels (unit_id, provider, status, credentials, display_phone)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'datafy', 'connected', '{"phone_number_id":"PN-C8"}', '5511000c8001');
    begin
      insert into whatsapp_channels (unit_id, provider, status, credentials, display_phone)
      values ('bbbbbbbb-0000-0000-0000-000000000002', 'datafy', 'connected', '{"phone_number_id":"PN-C8"}', '5511000c8002');
      v_dd := 'aceitou';
    exception when unique_violation then v_dd := '23505';
    end;
    begin
      insert into whatsapp_channels (unit_id, provider, status, credentials, display_phone)
      values ('bbbbbbbb-0000-0000-0000-000000000003', 'official', 'connected', '{"phone_number_id":"PN-C8"}', '5511000c8003');
      v_od := 'aceitou';
    exception when unique_violation then v_od := '23505';
    end;
    insert into whatsapp_channels (unit_id, provider, status, credentials, display_phone)
    values ('bbbbbbbb-0000-0000-0000-000000000003', 'zapi', 'connected', '{"phone_number_id":"PN-C8"}', '5511000c8004');
    v_zapi := true;
    insert into whatsapp_channels (unit_id, provider, status, credentials, display_phone)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'datafy', 'disconnected', '{}', '5511000c8005'),
           ('bbbbbbbb-0000-0000-0000-000000000002', 'datafy', 'disconnected', '{}', '5511000c8006');
    v_sem := true;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  return case when v_dd = '23505' and v_od = '23505' and v_zapi and v_sem then 'OK'
    else format('FALHOU: datafy x datafy=%s official x datafy=%s zapi aceito=%s sem a chave aceitos=%s (esperado 23505/23505/t/t)',
                coalesce(v_dd, 'null'), coalesce(v_od, 'null'), v_zapi, v_sem) end;
exception when others then
  return 'FALHOU: ' || sqlstate || ' ' || sqlerrm;
end $$;
do $$ begin perform pg_temp.dp_res(116, 'C8', pg_temp.c8()); end $$;

-- ─── C8b (117): o índice lê o número como o núcleo lê ───────────────────────
-- `metaPayloadMatchesChannel` apara (`.trim()`) e trata vazio como "sem
-- âncora". O índice tem de fazer o mesmo, senão `"777"` e `" 777\n"` são dois
-- números para o banco e o MESMO para o webhook. E o vazio não pode colidir:
-- `""` e `"  "` não são âncora, nem JSON null. Número no JSON (`888`) vira
-- `'888'` pelo `->>` e colide com a string.
create or replace function pg_temp.c8b() returns text language plpgsql as $$
declare v_ws text; v_num text; v_vazio boolean := false; v_null boolean := false;
begin
  begin
    insert into whatsapp_channels (unit_id, provider, status, credentials, display_phone)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'datafy', 'connected', '{"phone_number_id":"777"}', '5511000c8b01');
    begin
      insert into whatsapp_channels (unit_id, provider, status, credentials, display_phone)
      values ('bbbbbbbb-0000-0000-0000-000000000002', 'official', 'connected', '{"phone_number_id":" 777\n"}', '5511000c8b02');
      v_ws := 'aceitou';
    exception when unique_violation then v_ws := '23505';
    end;
    insert into whatsapp_channels (unit_id, provider, status, credentials, display_phone)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'datafy', 'connected', '{"phone_number_id":"888"}', '5511000c8b03');
    begin
      insert into whatsapp_channels (unit_id, provider, status, credentials, display_phone)
      values ('bbbbbbbb-0000-0000-0000-000000000002', 'official', 'connected', '{"phone_number_id":888}', '5511000c8b04');
      v_num := 'aceitou';
    exception when unique_violation then v_num := '23505';
    end;
    begin
      insert into whatsapp_channels (unit_id, provider, status, credentials, display_phone)
      values ('bbbbbbbb-0000-0000-0000-000000000001', 'official', 'disconnected', '{"phone_number_id":""}', '5511000c8b05'),
             ('bbbbbbbb-0000-0000-0000-000000000002', 'official', 'disconnected', '{"phone_number_id":"  "}', '5511000c8b06'),
             ('bbbbbbbb-0000-0000-0000-000000000003', 'datafy', 'disconnected', '{"phone_number_id":""}', '5511000c8b07');
      v_vazio := true;
    exception when unique_violation then null;
    end;
    begin
      insert into whatsapp_channels (unit_id, provider, status, credentials, display_phone)
      values ('bbbbbbbb-0000-0000-0000-000000000001', 'datafy', 'disconnected', '{"phone_number_id":null}', '5511000c8b08'),
             ('bbbbbbbb-0000-0000-0000-000000000002', 'datafy', 'disconnected', '{"phone_number_id":null}', '5511000c8b09');
      v_null := true;
    exception when unique_violation then null;
    end;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  return case when v_ws = '23505' and v_num = '23505' and v_vazio and v_null then 'OK'
    else format('FALHOU: espaco/quebra=%s numero_vs_texto=%s vazios_aceitos=%s json_null_aceitos=%s (esperado 23505/23505/t/t)',
                coalesce(v_ws, 'null'), coalesce(v_num, 'null'), v_vazio, v_null) end;
exception when others then
  return 'FALHOU: ' || sqlstate || ' ' || sqlerrm;
end $$;
do $$ begin perform pg_temp.dp_res(117, 'C8b', pg_temp.c8b()); end $$;

-- ─── C9 (118): ACL e forma das funções; postura das três tabelas ────────────
-- A ACL é medida contra os default privileges do `61a`, que emulam o Supabase:
-- função e tabela nascem com grant EXPLÍCITO a anon/authenticated/service_role,
-- e só os `revoke` da migration tiram. Sem o `61a` este caso ficaria verde
-- medindo apenas o grant implícito a PUBLIC. As trigger functions mantêm o
-- EXECUTE do service_role herdado dos default privileges (inofensivo: não são
-- chamáveis fora de trigger) — por isso não se afirma nada sobre ele aqui.
--
-- Literais apendados a `v_falhas` levam `::text` (medido no `22`: sem o cast,
-- `text[] || 'literal'` resolve o literal como ARRAY e estoura 22P02).
do $$
declare
  v_fn regprocedure; v_tab regclass; v_papel text; v_priv text;
  v_rls boolean; v_force boolean; v_pol int;
  v_falhas text[] := '{}';
begin
  foreach v_fn in array array[
    'public.claim_datafy_onboarding_step(uuid,uuid,text,uuid,integer)'::regprocedure,
    'public.release_datafy_onboarding_step(uuid,uuid,uuid,text,text,text)'::regprocedure
  ] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE') then v_falhas := v_falhas || (v_fn::text || ' anon'); end if;
    if has_function_privilege('authenticated', v_fn, 'EXECUTE') then v_falhas := v_falhas || (v_fn::text || ' authenticated'); end if;
    if not has_function_privilege('service_role', v_fn, 'EXECUTE') then v_falhas := v_falhas || (v_fn::text || ' sem service_role'); end if;
    if exists (
      select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.oid = v_fn and a.grantee = 0 and a.privilege_type = 'EXECUTE'
    ) then v_falhas := v_falhas || (v_fn::text || ' PUBLIC'); end if;
    if not exists (select 1 from pg_proc where oid = v_fn and prosecdef) then
      v_falhas := v_falhas || (v_fn::text || ' deveria ser SECURITY DEFINER');
    end if;
    if not exists (select 1 from pg_proc where oid = v_fn and 'search_path=""' = any(proconfig)) then
      v_falhas := v_falhas || (v_fn::text || ' sem search_path vazio');
    end if;
  end loop;

  foreach v_fn in array array[
    'public.whatsapp_official_connection_grants_guard()'::regprocedure,
    'public.whatsapp_datafy_onboardings_guard()'::regprocedure
  ] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE') then v_falhas := v_falhas || (v_fn::text || ' anon'); end if;
    if has_function_privilege('authenticated', v_fn, 'EXECUTE') then v_falhas := v_falhas || (v_fn::text || ' authenticated'); end if;
    if exists (
      select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.oid = v_fn and a.grantee = 0 and a.privilege_type = 'EXECUTE'
    ) then v_falhas := v_falhas || (v_fn::text || ' PUBLIC'); end if;
    if exists (select 1 from pg_proc where oid = v_fn and prosecdef) then
      v_falhas := v_falhas || (v_fn::text || ' deveria ser INVOKER');
    end if;
    if not exists (select 1 from pg_proc where oid = v_fn and 'search_path=""' = any(proconfig)) then
      v_falhas := v_falhas || (v_fn::text || ' sem search_path vazio');
    end if;
  end loop;

  foreach v_tab in array array[
    'public.whatsapp_official_connection_grants'::regclass,
    'public.whatsapp_datafy_onboardings'::regclass,
    'public.whatsapp_ops_alerts'::regclass
  ] loop
    select relrowsecurity, relforcerowsecurity into v_rls, v_force from pg_class where oid = v_tab;
    select count(*) into v_pol from pg_policy where polrelid = v_tab;
    if not (v_rls and v_force) then v_falhas := v_falhas || (v_tab::text || ' rls nao forcada'); end if;
    if v_pol <> 0 then v_falhas := v_falhas || (v_tab::text || ' policies=' || v_pol); end if;
    foreach v_papel in array array['anon', 'authenticated'] loop
      foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(v_papel, v_tab, v_priv) then
          v_falhas := v_falhas || (v_tab::text || ': ' || v_papel || ' tem ' || v_priv);
        end if;
      end loop;
    end loop;
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', v_tab, v_priv) then
        v_falhas := v_falhas || (v_tab::text || ': service_role sem ' || v_priv);
      end if;
    end loop;
    foreach v_priv in array array['TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege('service_role', v_tab, v_priv) then
        v_falhas := v_falhas || (v_tab::text || ': service_role tem ' || v_priv);
      end if;
    end loop;
  end loop;

  perform pg_temp.dp_res(118, 'C9', case when cardinality(v_falhas) = 0 then 'OK'
    else 'FALHOU: ' || array_to_string(v_falhas, '; ') end);
exception when others then
  perform pg_temp.dp_res(118, 'C9', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C10 (119): bordas das RPCs ──────────────────────────────────────────────
-- Linha fechada recusa com `check_violation` e a mensagem `onboarding_closed`;
-- passo e desfecho fora da lista, 22023; onboarding inexistente, P0002; código
-- de erro fora do formato, 22023 (antes do CHECK, para não virar 23514
-- genérico). E o TTL LIMITADO a 30..900, conferido por IGUALDADE no lease
-- gravado: p_ttl = 1 vira 30 s (sem o piso, um clique duplo lento passaria),
-- 5000 vira 900 s (sem o teto, um chamador prenderia a linha por mais de uma
-- hora), e nulo vira o default de 120 s.
do $$
declare
  v_u uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
  v_c text; v_a text; v_passo text; v_inex text; v_inex_rel text; v_desf text; v_err text;
  v_id uuid; r record; v_piso interval; v_teto interval; v_nulo interval;
begin
  begin
    v_id := pg_temp.dp_onb(p_state => 'completed');
    begin
      perform pg_temp.dp_claim(v_id, 'subscribe');
      v_c := 'aceitou';
    exception when check_violation then v_c := case when sqlerrm = 'onboarding_closed' then 'closed' else sqlerrm end;
    end;
    update public.whatsapp_datafy_onboardings set state = 'abandoned' where id = v_id;
    begin
      perform pg_temp.dp_claim(v_id, 'subscribe');
      v_a := 'aceitou';
    exception when check_violation then v_a := case when sqlerrm = 'onboarding_closed' then 'closed' else sqlerrm end;
    end;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;

  begin
    v_id := pg_temp.dp_onb();
    begin
      perform pg_temp.dp_claim(v_id, 'delete_channel');
      v_passo := 'aceitou';
    exception when sqlstate '22023' then v_passo := '22023';
    end;
    begin
      perform public.claim_datafy_onboarding_step(gen_random_uuid(), v_u, 'subscribe', null);
      v_inex := 'aceitou';
    exception when sqlstate 'P0002' then v_inex := 'P0002';
    end;
    begin
      perform public.release_datafy_onboarding_step(gen_random_uuid(), v_u, gen_random_uuid(), 'subscribe', 'failed');
      v_inex_rel := 'aceitou';
    exception when sqlstate 'P0002' then v_inex_rel := 'P0002';
    end;
    select * into r from pg_temp.dp_claim(v_id, 'subscribe');
    begin
      perform pg_temp.dp_release(v_id, r.claim_id, 'subscribe', 'done');
      v_desf := 'aceitou';
    exception when sqlstate '22023' then v_desf := '22023';
    end;
    begin
      perform pg_temp.dp_release(v_id, r.claim_id, 'subscribe', 'failed', 'erro em minusculas');
      v_err := 'aceitou';
    exception when sqlstate '22023' then v_err := '22023';
    end;
    perform pg_temp.dp_release(v_id, r.claim_id, 'subscribe', 'succeeded');

    select * into r from pg_temp.dp_claim(v_id, 'subscribe', 1);
    select o.claim_expires_at - now() into v_piso from public.whatsapp_datafy_onboardings o where o.id = v_id;
    perform pg_temp.dp_release(v_id, r.claim_id, 'subscribe', 'succeeded');
    select * into r from pg_temp.dp_claim(v_id, 'subscribe', 5000);
    select o.claim_expires_at - now() into v_teto from public.whatsapp_datafy_onboardings o where o.id = v_id;
    perform pg_temp.dp_release(v_id, r.claim_id, 'subscribe', 'succeeded');
    select * into r from public.claim_datafy_onboarding_step(v_id, v_u, 'subscribe', null, null);
    select o.claim_expires_at - now() into v_nulo from public.whatsapp_datafy_onboardings o where o.id = v_id;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;

  perform pg_temp.dp_res(119, 'C10', case
    when v_c = 'closed' and v_a = 'closed' and v_passo = '22023' and v_inex = 'P0002' and v_inex_rel = 'P0002'
         and v_desf = '22023' and v_err = '22023'
         and v_piso = interval '30 seconds' and v_teto = interval '900 seconds' and v_nulo = interval '120 seconds' then 'OK'
    else format('FALHOU: completed=%s abandoned=%s passo_invalido=%s inexistente claim/release=%s/%s desfecho_invalido=%s erro_invalido=%s lease ttl=1:%s ttl=5000:%s ttl=null:%s (esperado 30s/900s/120s)',
                coalesce(v_c, 'null'), coalesce(v_a, 'null'), coalesce(v_passo, 'null'), coalesce(v_inex, 'null'), coalesce(v_inex_rel, 'null'),
                coalesce(v_desf, 'null'), coalesce(v_err, 'null'), v_piso, v_teto, v_nulo) end);
exception when others then
  perform pg_temp.dp_res(119, 'C10', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C11 (120): o service_role, papel real de produção, grava e chama ───────
-- Todos os outros casos rodam como `postgres`, superusuário, e não medem
-- privilégio nenhum. As tabelas passam pelo guard SECURITY INVOKER, que lê
-- `units`, a liberação e o canal consumido com o privilégio de quem grava.
-- Sem pg_temp aqui: função temporária da sessão não é o que se quer medir.
do $$
declare v_g uuid; v_o uuid; r record; v_rel boolean; v_ok boolean := false;
begin
  begin
    set local role service_role;
    insert into public.whatsapp_official_connection_grants (organization_id, unit_id, granted_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', gen_random_uuid())
    returning id into v_g;
    insert into public.whatsapp_datafy_onboardings (organization_id, unit_id, grant_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', v_g)
    returning id into v_o;
    select * into r from public.claim_datafy_onboarding_step(v_o, 'bbbbbbbb-0000-0000-0000-000000000001', 'create_channel', gen_random_uuid());
    v_rel := public.release_datafy_onboarding_step(v_o, 'bbbbbbbb-0000-0000-0000-000000000001', r.claim_id, 'create_channel', 'succeeded');
    update public.whatsapp_official_connection_grants
       set consumed_at = now(), consumed_channel_id = 'dddddddd-0000-0000-0000-000000000001'
     where id = v_g;
    insert into public.whatsapp_ops_alerts (unit_id, alert_type, last_watermark)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'inbound_dead_letter', now());
    v_ok := r.claimed and v_rel;
    reset role;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  perform pg_temp.dp_res(120, 'C11', case when v_ok then 'OK'
    else 'FALHOU: service_role nao completou insert + claim + release + consumo + alerta' end);
exception when others then
  perform pg_temp.dp_res(120, 'C11', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C12 (121): os CHECKs das três tabelas ──────────────────────────────────
-- Cada tentativa num bloco próprio; a lista do que PASSOU indevidamente é o
-- veredito.
do $$
declare
  v_stmt text;
  v_passaram text[] := '{}';
  v_dup text; v_outra boolean := false;
  v_stmts text[] := array[
    -- liberação: par revogação, par consumo, revogada E consumida
    $q$insert into public.whatsapp_official_connection_grants (organization_id, unit_id, granted_by, revoked_at) values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', gen_random_uuid(), now())$q$,
    $q$insert into public.whatsapp_official_connection_grants (organization_id, unit_id, granted_by, consumed_at) values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', gen_random_uuid(), now())$q$,
    $q$insert into public.whatsapp_official_connection_grants (organization_id, unit_id, granted_by, revoked_at, revoked_by, consumed_at, consumed_channel_id) values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', gen_random_uuid(), now(), gen_random_uuid(), now(), 'dddddddd-0000-0000-0000-000000000001')$q$,
    -- onboarding: estado, passo, claim incoerente (cada perna), ator sem claim, último erro, passo incerto fora da lista
    $q$insert into public.whatsapp_datafy_onboardings (organization_id, unit_id, state) values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'connecting')$q$,
    $q$insert into public.whatsapp_datafy_onboardings (organization_id, unit_id, claim_id, claim_step, claim_started_at, claim_expires_at) values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', gen_random_uuid(), 'delete_channel', now(), now())$q$,
    $q$insert into public.whatsapp_datafy_onboardings (organization_id, unit_id, claim_id, claim_started_at, claim_expires_at) values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', gen_random_uuid(), now(), now())$q$,
    $q$insert into public.whatsapp_datafy_onboardings (organization_id, unit_id, claim_id, claim_step, claim_started_at) values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', gen_random_uuid(), 'subscribe', now())$q$,
    $q$insert into public.whatsapp_datafy_onboardings (organization_id, unit_id, claim_step) values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'subscribe')$q$,
    $q$insert into public.whatsapp_datafy_onboardings (organization_id, unit_id, claim_expires_at) values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', now())$q$,
    $q$insert into public.whatsapp_datafy_onboardings (organization_id, unit_id, claim_actor_id) values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', gen_random_uuid())$q$,
    $q$insert into public.whatsapp_datafy_onboardings (organization_id, unit_id, last_error) values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'erro: com texto livre')$q$,
    $q$insert into public.whatsapp_datafy_onboardings (organization_id, unit_id, uncertain_steps) values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', array['delete_channel'])$q$,
    -- alerta: tipo fora da lista
    $q$insert into public.whatsapp_ops_alerts (unit_id, alert_type) values ('bbbbbbbb-0000-0000-0000-000000000001', 'inbound_slow')$q$
  ];
begin
  foreach v_stmt in array v_stmts loop
    begin
      execute v_stmt;
      v_passaram := v_passaram || v_stmt;
      raise exception using errcode = 'ZZ061';
    exception
      when check_violation then null;
      when sqlstate 'ZZ061' then null;
    end;
  end loop;

  begin
    insert into public.whatsapp_ops_alerts (unit_id, alert_type) values ('bbbbbbbb-0000-0000-0000-000000000001', 'inbound_dead_letter');
    begin
      insert into public.whatsapp_ops_alerts (unit_id, alert_type) values ('bbbbbbbb-0000-0000-0000-000000000001', 'inbound_dead_letter');
      v_dup := 'aceitou';
    exception when unique_violation then v_dup := '23505';
    end;
    insert into public.whatsapp_ops_alerts (unit_id, alert_type) values ('bbbbbbbb-0000-0000-0000-000000000002', 'inbound_dead_letter');
    v_outra := true;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;

  perform pg_temp.dp_res(121, 'C12', case when cardinality(v_passaram) = 0 and v_dup = '23505' and v_outra then 'OK'
    else format('FALHOU: aceitos indevidamente=[%s]; alerta duplicado=%s; mesmo tipo em outra unidade=%s',
                array_to_string(v_passaram, ' | '), coalesce(v_dup, 'null'), v_outra) end);
exception when others then
  perform pg_temp.dp_res(121, 'C12', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C13 (122): DELETE da unidade cascateia sem abortar ──────────────────────
-- Liberação, onboarding que a referencia (FK NO ACTION, checada no fim do
-- statement) e alerta saem juntos. Pegaria, por exemplo, a FK da liberação no
-- onboarding como RESTRICT, ou um CHECK que a coerção de FK violasse (o
-- conflito FK × CHECK da 089) — `consumed_channel_id` não tem FK por isso.
do $$
declare
  v_unit uuid := 'bbbbbbbb-0000-0000-0000-0000000000c3';
  v_g uuid; v_restam int; v_erro text;
begin
  begin
    insert into units (id, organization_id, name) values (v_unit, 'aaaaaaaa-0000-0000-0000-000000000001', 'Unidade C13');
    v_g := pg_temp.dp_grant(p_unit => v_unit);
    perform pg_temp.dp_onb(p_unit => v_unit, p_grant => v_g);
    insert into public.whatsapp_ops_alerts (unit_id, alert_type) values (v_unit, 'datafy_subscription_failed');
    delete from units where id = v_unit;
    select (select count(*) from public.whatsapp_official_connection_grants where unit_id = v_unit)
         + (select count(*) from public.whatsapp_datafy_onboardings where unit_id = v_unit)
         + (select count(*) from public.whatsapp_ops_alerts where unit_id = v_unit)
      into v_restam;
    raise exception using errcode = 'ZZ061';
  exception
    when sqlstate 'ZZ061' then null;
    when others then v_erro := sqlstate || ' ' || sqlerrm;
  end;
  perform pg_temp.dp_res(122, 'C13', case
    when v_erro is not null then 'FALHOU: DELETE da unidade abortou: ' || v_erro
    when v_restam = 0 then 'OK'
    else 'FALHOU: sobraram ' || v_restam || ' linha(s) da unidade apagada' end);
exception when others then
  perform pg_temp.dp_res(122, 'C13', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C15 (123): credenciais não sobrevivem ao onboarding fechado ────────────
-- `channel_token` e `webhook_secret` são cópia de trabalho; a autoritativa é a
-- de `whatsapp_channels`. `completed`/`abandoned` com qualquer uma das duas é
-- recusado, no INSERT e na transição por UPDATE; aberto (e intermediários)
-- guarda; fechar limpando as duas passa.
do $$
declare v_o uuid; v_falhas text[] := '{}'; v_stmt text;
  v_neg text[] := array[
    $q$insert into public.whatsapp_datafy_onboardings (organization_id, unit_id, state, datafy_channel_id, channel_token) values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'completed', 'dfy-c15a', 'tok-c15')$q$,
    $q$insert into public.whatsapp_datafy_onboardings (organization_id, unit_id, state, datafy_channel_id, webhook_secret) values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'completed', 'dfy-c15b', 'sec-c15')$q$,
    $q$insert into public.whatsapp_datafy_onboardings (organization_id, unit_id, state, channel_token) values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'abandoned', 'tok-c15')$q$
  ];
begin
  foreach v_stmt in array v_neg loop
    begin
      execute v_stmt;
      v_falhas := v_falhas || ('aceitou: ' || v_stmt);
      raise exception using errcode = 'ZZ061';
    exception
      when check_violation then null;
      when sqlstate 'ZZ061' then null;
    end;
  end loop;
  begin
    insert into public.whatsapp_datafy_onboardings (organization_id, unit_id, state, datafy_channel_id, channel_token, webhook_secret)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'webhook_ready', 'dfy-c15c', 'tok-c15', 'sec-c15')
    returning id into v_o;
    v_falhas := v_falhas
      || pg_temp.tenta(format('update public.whatsapp_datafy_onboardings set state = %L where id = %L', 'abandoned', v_o),
                       'abandonar sem limpar', '%closed_no_credentials%')
      || pg_temp.tenta(format('update public.whatsapp_datafy_onboardings set state = %L where id = %L', 'completed', v_o),
                       'completar sem limpar', '%closed_no_credentials%');
    v_falhas := array_remove(v_falhas, null);
    update public.whatsapp_datafy_onboardings
       set state = 'completed', channel_token = null, webhook_secret = null where id = v_o;
    raise exception using errcode = 'ZZ061';
  exception
    when sqlstate 'ZZ061' then null;
    when others then v_falhas := v_falhas || ('caminho legitimo recusado: ' || sqlstate || ' ' || sqlerrm);
  end;
  perform pg_temp.dp_res(123, 'C15', case when cardinality(v_falhas) = 0 then 'OK'
    else 'FALHOU: ' || array_to_string(v_falhas, '; ') end);
exception when others then
  perform pg_temp.dp_res(123, 'C15', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C16 (124): depois de `open`, só `abandoned` existe sem canal Datafy ─────
-- Contraparte: `open`/`abandoned` sem canal entram, e o caminho de recriação
-- (`channel_created` → `open` limpando `datafy_channel_id`) passa.
do $$
declare v_o uuid; v_falhas text[] := '{}'; v_st text;
begin
  foreach v_st in array array['channel_created', 'webhook_ready', 'connected', 'completed'] loop
    begin
      insert into public.whatsapp_datafy_onboardings (organization_id, unit_id, state)
      values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', v_st);
      v_falhas := v_falhas || (v_st || ' sem datafy_channel_id aceito');
      raise exception using errcode = 'ZZ061';
    exception
      when check_violation then null;
      when sqlstate 'ZZ061' then null;
    end;
  end loop;
  begin
    perform pg_temp.dp_onb(p_state => 'abandoned');
    v_o := pg_temp.dp_onb(p_state => 'channel_created');
    update public.whatsapp_datafy_onboardings set state = 'open', datafy_channel_id = null where id = v_o;
    raise exception using errcode = 'ZZ061';
  exception
    when sqlstate 'ZZ061' then null;
    when others then v_falhas := v_falhas || ('caminho legitimo recusado: ' || sqlstate || ' ' || sqlerrm);
  end;
  perform pg_temp.dp_res(124, 'C16', case when cardinality(v_falhas) = 0 then 'OK'
    else 'FALHOU: ' || array_to_string(v_falhas, '; ') end);
exception when others then
  perform pg_temp.dp_res(124, 'C16', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C17 (125): vínculos de tenant imutáveis depois do INSERT ───────────────
-- Mover para unidade da MESMA organização (A1 → A2) passaria na coerência —
-- por isso a unidade A2 é criada aqui: é a única forma de medir a
-- imutabilidade em si, e não a coerência que o C2/C2b já medem. Liberação
-- anexada depois (nulo → valor) passa; trocar ou tirar a gravada, não.
--
-- Cada tentativa negativa se desfaz sozinha (`ZZ061`, em `pg_temp.tenta`):
-- medido com a guarda da liberação sabotada, a liberação movida para A2 ficava
-- de pé e o passo legítimo seguinte (anexá-la ao onboarding de A1) morria na
-- coerência — o veredito apontava a liberação de outra unidade, não a
-- imutabilidade.
do $$
declare
  v_a2 uuid := 'bbbbbbbb-0000-0000-0000-0000000000a2';
  v_g uuid; v_g2 uuid; v_o uuid; v_falhas text[] := '{}'; v_anexou text;
begin
  begin
    insert into units (id, organization_id, name) values (v_a2, 'aaaaaaaa-0000-0000-0000-000000000001', 'Unidade A2 C17');
    v_g := pg_temp.dp_grant();
    v_o := pg_temp.dp_onb();
    v_falhas := v_falhas
      || pg_temp.tenta(format('update public.whatsapp_official_connection_grants set unit_id = %L where id = %L', v_a2, v_g),
                       'liberacao mudou de unidade', '%imutave%')
      || pg_temp.tenta(format('update public.whatsapp_official_connection_grants set organization_id = %L where id = %L',
                              'aaaaaaaa-0000-0000-0000-000000000002', v_g),
                       'liberacao mudou de organizacao', '%imutave%')
      || pg_temp.tenta(format('update public.whatsapp_datafy_onboardings set unit_id = %L where id = %L', v_a2, v_o),
                       'onboarding mudou de unidade', '%imutave%');
    begin
      update public.whatsapp_datafy_onboardings set grant_id = v_g where id = v_o;
      v_anexou := 'ok';
    exception when others then v_anexou := sqlstate || ' ' || sqlerrm;
    end;
    update public.whatsapp_official_connection_grants set revoked_at = now(), revoked_by = gen_random_uuid() where id = v_g;
    v_g2 := pg_temp.dp_grant();
    v_falhas := v_falhas
      || pg_temp.tenta(format('update public.whatsapp_datafy_onboardings set grant_id = %L where id = %L', v_g2, v_o),
                       'onboarding trocou de liberacao', '%imutave%')
      || pg_temp.tenta(format('update public.whatsapp_datafy_onboardings set grant_id = null where id = %L', v_o),
                       'onboarding perdeu a liberacao', '%imutave%');
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  v_falhas := array_remove(v_falhas, null);
  perform pg_temp.dp_res(125, 'C17', case when cardinality(v_falhas) = 0 and v_anexou = 'ok' then 'OK'
    else format('FALHOU: %s; anexar liberacao depois=%s', array_to_string(v_falhas, '; '), coalesce(v_anexou, 'null')) end);
exception when others then
  perform pg_temp.dp_res(125, 'C17', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C18 (126): uma liberação para um onboarding vivo ───────────────────────
-- O primeiro onboarding da liberação está `completed`, então o índice de "um
-- aberto por unidade" NÃO dispara: o 23505 só pode vir do índice da
-- liberação, e o caso confere o nome da constraint. Contraparte: depois de um
-- `abandoned`, a mesma liberação abre outro.
do $$
declare v_g uuid; v_state text; v_con text; v_contra boolean := false;
begin
  begin
    v_g := pg_temp.dp_grant();
    perform pg_temp.dp_onb(p_grant => v_g, p_state => 'completed');
    begin
      perform pg_temp.dp_onb(p_grant => v_g);
      v_state := 'aceitou';
    exception when unique_violation then
      v_state := '23505';
      get stacked diagnostics v_con = constraint_name;
    end;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  begin
    v_g := pg_temp.dp_grant();
    perform pg_temp.dp_onb(p_grant => v_g, p_state => 'abandoned');
    perform pg_temp.dp_onb(p_grant => v_g);
    v_contra := true;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  perform pg_temp.dp_res(126, 'C18', case
    when v_state = '23505' and v_con = 'whatsapp_datafy_onboardings_one_per_grant_idx' and v_contra then 'OK'
    else format('FALHOU: segundo onboarding da mesma liberacao=%s constraint=%s (esperado 23505 one_per_grant); abandonado libera=%s',
                coalesce(v_state, 'null'), coalesce(v_con, 'null'), v_contra) end);
exception when others then
  perform pg_temp.dp_res(126, 'C18', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C19 (127): o canal que consome a liberação é da MESMA unidade ──────────
-- Sem FK em `consumed_channel_id` (C13), a guarda é a trigger: canal de outra
-- unidade ou inexistente é recusado no UPDATE e no INSERT; canal da unidade
-- passa.
do $$
declare v_g uuid; v_falhas text[] := '{}';
begin
  begin
    v_g := pg_temp.dp_grant();
    v_falhas := v_falhas
      || pg_temp.tenta(format('update public.whatsapp_official_connection_grants set consumed_at = now(), consumed_channel_id = %L where id = %L',
                              'dddddddd-0000-0000-0000-000000000002', v_g),
                       'canal de outra unidade no UPDATE', '%canal%unidade%')
      || pg_temp.tenta(format('update public.whatsapp_official_connection_grants set consumed_at = now(), consumed_channel_id = %L where id = %L',
                              gen_random_uuid(), v_g),
                       'canal inexistente no UPDATE', '%canal%unidade%')
      || pg_temp.tenta($q$insert into public.whatsapp_official_connection_grants (organization_id, unit_id, granted_by, consumed_at, consumed_channel_id)
                          values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', gen_random_uuid(), now(),
                                  'dddddddd-0000-0000-0000-000000000002')$q$,
                       'canal de outra unidade no INSERT', '%canal%unidade%');
    v_falhas := array_remove(v_falhas, null);
    begin
      update public.whatsapp_official_connection_grants
         set consumed_at = now(), consumed_channel_id = 'dddddddd-0000-0000-0000-000000000001' where id = v_g;
    exception when others then
      v_falhas := v_falhas || ('canal da unidade recusado: ' || sqlstate || ' ' || sqlerrm);
    end;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  perform pg_temp.dp_res(127, 'C19', case when cardinality(v_falhas) = 0 then 'OK'
    else 'FALHOU: ' || array_to_string(v_falhas, '; ') end);
exception when others then
  perform pg_temp.dp_res(127, 'C19', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C20 (128): onboarding de OUTRA unidade → 42501, nas duas RPCs ──────────
-- Segunda tranca atrás do `.eq("unit_id", …)` do EF. Unidade nula também é
-- recusada. O release recusado não toca a linha (o claim continua de pé).
-- Onboarding inexistente segue P0002 — service-role-only, sem oráculo a
-- esconder.
do $$
declare
  v_a1 uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
  v_b1 uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  v_id uuid; r record; v_c_alheia text; v_c_nula text; v_r_alheia text; v_dono uuid;
begin
  begin
    v_id := pg_temp.dp_onb();
    begin
      perform public.claim_datafy_onboarding_step(v_id, v_b1, 'create_channel', null);
      v_c_alheia := 'aceitou';
    exception when sqlstate '42501' then
      v_c_alheia := case when sqlerrm = 'onboarding_unit_mismatch' then '42501' else '42501 msg=' || sqlerrm end;
    end;
    begin
      perform public.claim_datafy_onboarding_step(v_id, null, 'create_channel', null);
      v_c_nula := 'aceitou';
    exception when sqlstate '42501' then v_c_nula := '42501';
    end;
    select * into r from public.claim_datafy_onboarding_step(v_id, v_a1, 'create_channel', null);
    begin
      perform public.release_datafy_onboarding_step(v_id, v_b1, r.claim_id, 'create_channel', 'succeeded');
      v_r_alheia := 'aceitou';
    exception when sqlstate '42501' then v_r_alheia := '42501';
    end;
    select o.claim_id into v_dono from public.whatsapp_datafy_onboardings o where o.id = v_id;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  perform pg_temp.dp_res(128, 'C20', case
    when v_c_alheia = '42501' and v_c_nula = '42501' and v_r_alheia = '42501' and r.claimed and v_dono = r.claim_id then 'OK'
    else format('FALHOU: claim unidade alheia=%s claim unidade nula=%s release unidade alheia=%s claim intacto=%s (esperado 42501 nos tres)',
                coalesce(v_c_alheia, 'null'), coalesce(v_c_nula, 'null'), coalesce(v_r_alheia, 'null'), v_dono = r.claim_id) end);
exception when others then
  perform pg_temp.dp_res(128, 'C20', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── Controles positivos de corpo de função (129..132) ──────────────────────
-- Sabotam o corpo REAL (recorte entre marcadores ou troca de um trecho exato),
-- rodam a função do CASO alvo e exigem: a sabotagem mudou o catálogo, o caso
-- devolveu FALHOU com o trecho que nomeia o defeito, e corpo + ACL voltaram.
create or replace function pg_temp.ctrl_corpo(
  p_fn regprocedure, p_marcador text, p_de text, p_para text, p_caso text, p_espera text
) returns text language plpgsql as $$
declare
  v_real text := pg_get_functiondef(p_fn);
  v_acl text;
  v_sab text; v_mudou boolean := false; v_res text; v_restaurou boolean;
begin
  select coalesce(proacl::text, 'null') into v_acl from pg_proc where oid = p_fn;
  begin
    v_sab := case when p_marcador is not null then pg_temp.sem_trecho(v_real, p_marcador)
                  else replace(v_real, p_de, p_para) end;
    if v_sab = v_real then
      v_res := 'sabotagem nao encontrou o trecho';
    else
      execute v_sab;
      v_mudou := pg_get_functiondef(p_fn) <> v_real;
      execute 'select pg_temp.' || p_caso || '()' into v_res;
    end if;
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  select pg_get_functiondef(p_fn) = v_real and coalesce(proacl::text, 'null') = v_acl
    into v_restaurou from pg_proc where oid = p_fn;
  return case
    when v_mudou and v_res like 'FALHOU%' and position(p_espera in v_res) > 0 and v_restaurou then 'OK'
    else format('FALHOU: mudou=%s caso_vermelho_pela_razao_certa=%s restaurou=%s; veredito do caso sob sabotagem: %s',
                v_mudou, coalesce(v_res like 'FALHOU%' and position(p_espera in v_res) > 0, false), v_restaurou, coalesce(v_res, 'null')) end;
exception when others then
  return 'FALHOU: ' || sqlstate || ' ' || sqlerrm;
end $$;

-- C5-CTRL: sem `<ttl>` o claim nunca vence, e a retomada devolve claimed=f.
do $$ begin perform pg_temp.dp_res(129, 'C5-CTRL', pg_temp.ctrl_corpo(
  'public.claim_datafy_onboarding_step(uuid,uuid,text,uuid,integer)'::regprocedure,
  'ttl', null, null, 'c5', 'retomada do claim vencido')); end $$;

-- C5b-CTRL: sem `<takeover-incerto>` o passo do dono morto não é registrado.
do $$ begin perform pg_temp.dp_res(130, 'C5b-CTRL', pg_temp.ctrl_corpo(
  'public.claim_datafy_onboarding_step(uuid,uuid,text,uuid,integer)'::regprocedure,
  'takeover-incerto', null, null, 'c5b', 'takeover_registrou={}')); end $$;

-- C5c-CTRL: vivacidade pelo TTL do DESAFIANTE (a forma anterior) — o lease de
-- 900 s do dono é encurtado para 120 s e o desafiante leva.
do $$ begin perform pg_temp.dp_res(131, 'C5c-CTRL', pg_temp.ctrl_corpo(
  'public.claim_datafy_onboarding_step(uuid,uuid,text,uuid,integer)'::regprocedure,
  null, 'v_row.claim_expires_at > pg_catalog.now()',
  'v_row.claim_started_at > pg_catalog.now() - pg_catalog.make_interval(secs => v_ttl)',
  'c5c', 'desafiante levou')); end $$;

-- C6b-CTRL: sem `<failed-mantem>`, `failed` cai no `array_remove`.
do $$ begin perform pg_temp.dp_res(132, 'C6b-CTRL', pg_temp.ctrl_corpo(
  'public.release_datafy_onboarding_step(uuid,uuid,uuid,text,text,text)'::regprocedure,
  'failed-mantem', null, null, 'c6b', 'failed_mantem={}')); end $$;

-- ─── C8-CTRL (133): sem o índice, o número repetido entra ───────────────────
-- O `pg_get_indexdef` fica no CORPO, não no `declare`: erro na inicialização
-- de variável não é capturado pelo `exception` do próprio bloco, e com o índice
-- ausente o arquivo inteiro abortaria sob ON_ERROR_STOP, levando o C14 junto.
do $$
declare
  v_def text;
  v_mudou boolean := false; v_res text; v_restaurou boolean;
begin
  if to_regclass('public.whatsapp_channels_meta_phone_number_idx') is null then
    raise exception 'indice whatsapp_channels_meta_phone_number_idx ausente: nada a sabotar (o C8 ja deve estar vermelho)';
  end if;
  v_def := pg_get_indexdef('public.whatsapp_channels_meta_phone_number_idx'::regclass);
  begin
    drop index public.whatsapp_channels_meta_phone_number_idx;
    v_mudou := to_regclass('public.whatsapp_channels_meta_phone_number_idx') is null;
    v_res := pg_temp.c8();
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  v_restaurou := to_regclass('public.whatsapp_channels_meta_phone_number_idx') is not null
                 and pg_get_indexdef('public.whatsapp_channels_meta_phone_number_idx'::regclass) = v_def;
  perform pg_temp.dp_res(133, 'C8-CTRL', case
    when v_mudou and v_res like 'FALHOU: datafy x datafy=aceitou%' and v_restaurou then 'OK'
    else format('FALHOU: mudou=%s restaurou=%s; veredito do C8 sem o indice: %s', v_mudou, v_restaurou, coalesce(v_res, 'null')) end);
exception when others then
  perform pg_temp.dp_res(133, 'C8-CTRL', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C8b-CTRL (134): índice na forma CRUA, sem `btrim` ──────────────────────
-- A forma anterior à revisão (`credentials->>'phone_number_id'`, predicado `?`).
-- O C8 continua verde com ela (o número repetido sem espaço colide igual); o
-- C8b avermelha: `" 777\n"` entra ao lado de `"777"`, e os vazios colidem.
do $$
declare
  v_def text;
  v_mudou boolean := false; v_res text; v_restaurou boolean;
begin
  if to_regclass('public.whatsapp_channels_meta_phone_number_idx') is null then
    raise exception 'indice whatsapp_channels_meta_phone_number_idx ausente: nada a sabotar (o C8b ja deve estar vermelho)';
  end if;
  v_def := pg_get_indexdef('public.whatsapp_channels_meta_phone_number_idx'::regclass);
  begin
    drop index public.whatsapp_channels_meta_phone_number_idx;
    create unique index whatsapp_channels_meta_phone_number_idx
      on public.whatsapp_channels ((credentials->>'phone_number_id'))
      where provider in ('official', 'datafy') and credentials ? 'phone_number_id';
    v_mudou := pg_get_indexdef('public.whatsapp_channels_meta_phone_number_idx'::regclass) <> v_def;
    v_res := pg_temp.c8b();
    raise exception using errcode = 'ZZ061';
  exception when sqlstate 'ZZ061' then null;
  end;
  v_restaurou := to_regclass('public.whatsapp_channels_meta_phone_number_idx') is not null
                 and pg_get_indexdef('public.whatsapp_channels_meta_phone_number_idx'::regclass) = v_def;
  perform pg_temp.dp_res(134, 'C8b-CTRL', case
    when v_mudou and v_res like 'FALHOU: espaco/quebra=aceitou%' and v_restaurou then 'OK'
    else format('FALHOU: mudou=%s restaurou=%s; veredito do C8b com o indice cru: %s', v_mudou, v_restaurou, coalesce(v_res, 'null')) end);
exception when others then
  perform pg_temp.dp_res(134, 'C8b-CTRL', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C14 (135): idempotência ATRAVÉS DE EXECUÇÕES ───────────────────────────
-- A 1a execução grava a assinatura do catálogo; o README manda reaplicar a
-- migration duas vezes e rodar este arquivo de novo, e a 2a compara. As duas
-- leituras num único `do $$` veriam o mesmo estado e não mediriam nada. Fica
-- por ÚLTIMO (no arquivo e no ordinal) de propósito: os controles acima também
-- têm de ter devolvido o catálogo, e o C14 os pega se não devolveram.
do $$
declare v_assinatura text; v_gravada text; v_linhas bigint;
begin
  select string_agg(x, E'\n' order by x) into v_assinatura from (
    select 'col:' || attrelid::regclass::text || ':' || attname || ':' || format_type(atttypid, atttypmod) || ':' || attnotnull
           || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
      from pg_attribute a
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid in ('public.whatsapp_official_connection_grants'::regclass,
                          'public.whatsapp_datafy_onboardings'::regclass,
                          'public.whatsapp_ops_alerts'::regclass)
       and a.attnum > 0 and not a.attisdropped
    union all
    select 'col:whatsapp_channels:' || attname || ':' || format_type(atttypid, atttypmod) || ':' || attnotnull
      from pg_attribute
     where attrelid = 'public.whatsapp_channels'::regclass and attname like 'provider\_%\_at' and not attisdropped
    union all
    select 'con:' || conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid)
      from pg_constraint
     where conrelid in ('public.whatsapp_official_connection_grants'::regclass,
                        'public.whatsapp_datafy_onboardings'::regclass,
                        'public.whatsapp_ops_alerts'::regclass)
    union all
    select 'idx:' || indexrelid::regclass::text || ':' || pg_get_indexdef(indexrelid)
      from pg_index
     where indrelid in ('public.whatsapp_official_connection_grants'::regclass,
                        'public.whatsapp_datafy_onboardings'::regclass,
                        'public.whatsapp_ops_alerts'::regclass)
        or indexrelid = 'public.whatsapp_channels_meta_phone_number_idx'::regclass
    union all
    select 'trg:' || tgname || ':' || pg_get_triggerdef(oid)
      from pg_trigger where not tgisinternal
       and tgrelid in ('public.whatsapp_official_connection_grants'::regclass,
                       'public.whatsapp_datafy_onboardings'::regclass,
                       'public.whatsapp_ops_alerts'::regclass)
    union all
    select 'fn:' || p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(p.proacl::text, 'null')
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('claim_datafy_onboarding_step', 'release_datafy_onboarding_step',
                         'whatsapp_official_connection_grants_guard', 'whatsapp_datafy_onboardings_guard')
    union all
    select 'rel:' || oid::regclass::text || ':' || relrowsecurity || ':' || relforcerowsecurity || ':' || coalesce(relacl::text, 'null')
      from pg_class
     where oid in ('public.whatsapp_official_connection_grants'::regclass,
                   'public.whatsapp_datafy_onboardings'::regclass,
                   'public.whatsapp_ops_alerts'::regclass)
  ) s(x);
  select (select count(*) from public.whatsapp_official_connection_grants)
       + (select count(*) from public.whatsapp_datafy_onboardings)
       + (select count(*) from public.whatsapp_ops_alerts)
       + (select count(*) from public.whatsapp_channels where provider = 'datafy')
       + (select count(*) from units where id in ('bbbbbbbb-0000-0000-0000-0000000000c3', 'bbbbbbbb-0000-0000-0000-0000000000a2'))
    into v_linhas;
  select v into v_gravada from t_snap061 where k = 'assinatura';

  if v_gravada is null then
    insert into t_snap061 values ('assinatura', v_assinatura);
    perform pg_temp.dp_res(135, 'C14', 'PENDENTE: assinatura gravada — reaplique a migration duas vezes e rode este arquivo de novo');
  elsif v_gravada = v_assinatura and v_linhas = 0 then
    perform pg_temp.dp_res(135, 'C14', 'OK');
  else
    perform pg_temp.dp_res(135, 'C14', format('FALHOU: catalogo mudou entre execucoes da migration (%s) ou sobrou linha (%s)',
      case when v_gravada = v_assinatura then 'igual' else 'diferente' end, v_linhas));
  end if;
exception when others then
  perform pg_temp.dp_res(135, 'C14', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

select ord, caso, veredito from t_res where ord between 105 and 135 order by ord;
