-- SWEEP-1..6, PURGE-1..2 e ACL-SWEEP (ordinais 64..72): a SELEÇÃO e a PURGA da
-- migration 113, contra Postgres real.
--
-- As outras duas funções da 113 (claim/finalize) são a CERCA, e o `18` as mede.
-- Estas duas são a ESCOLHA de quem tentar a seguir e a RETENÇÃO — e o que este
-- arquivo prova, antes de tudo, é que a seleção **não escreve nada**. Uma versão
-- anterior desta fase previa reivindicar 20 linhas de uma vez aqui; com o claim
-- por linha já sendo o primeiro ato do processamento, isso deixaria ~18 leases
-- órfãos por minuto e o claim recusaria exatamente as linhas que o lote
-- reivindicou. O SWEEP-5 é o caso que torna esse retorno detectável.
--
-- Ele NÃO prova a Edge Function: o `index.ts` do `webhook-whatsapp` importa
-- `deno.land` e chama `serve()` no carregamento, então o vitest não o alcança. A
-- metade de lá é o núcleo puro (`sweepShouldStartAnother`,
-- `parseSelectedEventIds`, em `src/lib/whatsapp-inbound-queue-core.test.ts`);
-- aqui se prova o que o BANCO devolve e o que ele apaga.
--
-- SEQUÊNCIA (o MESMO banco do `16`/`18`, continuado — ver o README):
--   00-bootstrap.sql
--   00a-whatsapp-legacy-seed.sql
--   supabase/migrations/20260716130000_061_platform_flags.sql
--   supabase/migrations/20260924120000_111_whatsapp_inbound_events.sql
--   supabase/migrations/20260924120100_112_inbound_sweep_trigger.sql
--   supabase/migrations/20260924120200_113_inbound_claim_rpc.sql
--   16-inbound-events-111.sql
--   18-inbound-claim-113.sql
--   20-inbound-sweep-113.sql      <- este
--   17 / 19 / 21 (controles, SEM ON_ERROR_STOP)
--
-- CADA CASO SE DESFAZ, pela convenção do `16`/`18`: o corpo roda numa
-- subtransação que termina em `raise ... using errcode = 'ZZ113'`, capturado ali
-- mesmo. O arquivo é RE-RUNNABLE e não deixa linha em `whatsapp_inbound_events`.
-- Variável de plpgsql não é transacional, então os valores observados durante o
-- caso sobrevivem ao rollback e o veredito é julgado depois de desfazer.
--
-- `ZZ113` tem CINCO caracteres. Um SQLSTATE de seis é recusado pelo plpgsql em
-- tempo de COMPILAÇÃO — antes de qualquer statement, logo nem o `when others`
-- grava veredito, e o arquivo de controles (que roda sem ON_ERROR_STOP) aparenta
-- estar verde com vereditos AUSENTES. Medido nesta fase.
--
-- CADA CASO TEM AS PRÓPRIAS LINHAS, com `delivery_id` próprio: um controle
-- positivo só vale se o vermelho for LOCALIZADO, e casos que dividem dados
-- avermelham juntos.
--
-- RELÓGIO: `now()` é `transaction_timestamp()`, constante dentro do `do $$`.
-- Então "devida", "futura", "lease vencido" e "lease vivo" são construídas por
-- deslocamento em torno do MESMO instante, e não por espera.

create table if not exists t_res (ord int primary key, caso text, veredito text);

-- ─── GUARDA: este arquivo só faz sentido DEPOIS da 113 e DEPOIS do `00a` ────
-- Rodado antes, SWEEP-2 e SWEEP-4 passariam POR ACIDENTE: sem a função, toda
-- seleção "não devolve nada" e todo caso negativo fica verde medindo nada.
do $$
begin
  if to_regprocedure('public.select_due_whatsapp_inbound_events(integer)') is null then
    raise exception '20-inbound-sweep-113.sql exige a migration 113 aplicada (public.select_due_whatsapp_inbound_events(integer) ausente). Sequencia: 00 -> 00a -> 061 -> 111 -> 112 -> 113 -> 16 -> 18 -> 20.';
  end if;
  if to_regprocedure('public.purge_whatsapp_inbound_events()') is null then
    raise exception '20-inbound-sweep-113.sql exige a migration 113 aplicada (public.purge_whatsapp_inbound_events() ausente). A 113 pela metade nao tem retencao nenhuma.';
  end if;
  if to_regclass('public.whatsapp_inbound_events') is null then
    raise exception '20-inbound-sweep-113.sql exige a migration 111 aplicada (tabela public.whatsapp_inbound_events ausente).';
  end if;
  if not exists (select 1 from whatsapp_channels where id = 'dddddddd-0000-0000-0000-000000000001') then
    raise exception '20-inbound-sweep-113.sql exige os canais do 00a-whatsapp-legacy-seed.sql (dddddddd-0000-0000-0000-000000000001 ausente). Sem canal, todo insert morre na FK e os casos negativos ficariam verdes medindo nada.';
  end if;
end $$;

-- ─── SWEEP-1 (64): a linha DEVIDA é selecionada ─────────────────────────────
-- O caminho normal. Sem ele, todo caso negativo deste arquivo ficaria verde
-- sobre uma função que não devolve nada.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{"entry":[{"id":"1"}]}', 'UTF8');
        v_id uuid;
        v_achou boolean := false;
        v_total int := -1;
begin
  delete from t_res where ord = 64;

  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', v_chan, v_unit, v_corpo, 'sweep-1')
    returning id into v_id;

    select count(*), bool_or(t = v_id)
      into v_total, v_achou
      from public.select_due_whatsapp_inbound_events(100) t;

    raise exception 'sweep-1: desfaz o insert' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;  -- rollback da subtransação: nenhuma linha fica
  end;

  insert into t_res values (64, 'SWEEP-1 linha received e devida aparece na selecao',
    case
      when v_total <> 1
        then 'FALHOU (a selecao devolveu ' || v_total || ' linha(s) em vez de 1 — a varredura nao teria o que processar)'
      when not coalesce(v_achou, false)
        then 'FALHOU (a selecao devolveu alguma linha, mas nao a devida)'
      else 'OK (1 linha, e e a devida)'
    end);
exception when others then
  insert into t_res values (64, 'SWEEP-1 linha received e devida aparece na selecao',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── SWEEP-2 (65): `next_attempt_at` no FUTURO não é selecionada ────────────
-- A escada de retentativa inteira depende deste filtro: sem ele, a linha que
-- acabou de falhar volta no minuto seguinte, antes de o atraso de 30 s (ou 2, ou
-- 5 min) ter corrido — laço quente sobre um erro que não teve tempo de deixar de
-- existir. Duas linhas no caso, porque "nao devolveu a futura" sem uma devida ao
-- lado ficaria verde numa selecao que nao devolve nada.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_futura uuid; v_devida uuid;
        v_tem_futura boolean := true;
        v_tem_devida boolean := false;
begin
  delete from t_res where ord = 65;

  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id, next_attempt_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'sweep-2-futura', now() + interval '5 minutes')
    returning id into v_futura;

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id, next_attempt_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'sweep-2-devida', now() - interval '1 second')
    returning id into v_devida;

    select bool_or(t = v_futura), bool_or(t = v_devida)
      into v_tem_futura, v_tem_devida
      from public.select_due_whatsapp_inbound_events(100) t;

    raise exception 'sweep-2: desfaz o insert' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  insert into t_res values (65, 'SWEEP-2 linha agendada para o FUTURO nao e selecionada (a escada de retentativa vale)',
    case
      when not coalesce(v_tem_devida, false)
        then 'FALHOU (linha de base: nem a linha devida foi selecionada)'
      when coalesce(v_tem_futura, false)
        then 'FALHOU (a linha agendada para daqui a 5 min foi selecionada — o atraso da escada nao vale nada e a linha volta em laco quente)'
      else 'OK (a devida entra, a futura fica de fora)'
    end);
exception when others then
  insert into t_res values (65, 'SWEEP-2 linha agendada para o FUTURO nao e selecionada (a escada de retentativa vale)',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── SWEEP-3 (66): `processing` com lease VENCIDO é selecionada ─────────────
-- A contraparte do takeover do claim, no lado da seleção: sem esta perna, a
-- linha cujo worker morreu no meio nunca mais é oferecida à varredura, e a
-- entrega do cliente fica na tabela para sempre. O claim sozinho não resolve —
-- ele só é chamado para id que a seleção devolveu.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_id uuid;
        v_achou boolean := false;
begin
  delete from t_res where ord = 66;

  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id,
                                         status, claim_id, claimed_until, next_attempt_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'sweep-3-vencido',
            'processing', gen_random_uuid(), now() - interval '1 second', now() - interval '2 minutes')
    returning id into v_id;

    select bool_or(t = v_id) into v_achou
      from public.select_due_whatsapp_inbound_events(100) t;

    raise exception 'sweep-3: desfaz o insert' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  insert into t_res values (66, 'SWEEP-3 processing com lease VENCIDO volta a ser selecionavel (worker morto no meio)',
    case
      when not coalesce(v_achou, false)
        then 'FALHOU (o lease vencido NAO foi selecionado — a entrega do cliente fica presa em processing para sempre, porque o claim so e chamado para id que a selecao devolveu)'
      else 'OK (lease vencido selecionado)'
    end);
exception when others then
  insert into t_res values (66, 'SWEEP-3 processing com lease VENCIDO volta a ser selecionavel (worker morto no meio)',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── SWEEP-4 (67): `processing` com lease VIVO não é selecionada ────────────
-- Selecionar um lease vivo não produz resposta dupla (o claim recusaria a
-- linha), mas produz trabalho que se sabe inútil: uma ida ao banco por linha, por
-- minuto, enquanto outro processo trabalha nela — e ocupa vaga no `limit` da
-- seleção, que é o recurso escasso quando a fila acumula.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_vivo uuid; v_devida uuid;
        v_tem_vivo boolean := true;
        v_tem_devida boolean := false;
begin
  delete from t_res where ord = 67;

  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id,
                                         status, claim_id, claimed_until, next_attempt_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'sweep-4-vivo',
            'processing', gen_random_uuid(), now() + interval '90 seconds', now() - interval '2 minutes')
    returning id into v_vivo;

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id)
    values ('datafy', v_chan, v_unit, v_corpo, 'sweep-4-devida')
    returning id into v_devida;

    select bool_or(t = v_vivo), bool_or(t = v_devida)
      into v_tem_vivo, v_tem_devida
      from public.select_due_whatsapp_inbound_events(100) t;

    raise exception 'sweep-4: desfaz o insert' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  insert into t_res values (67, 'SWEEP-4 processing com lease VIVO nao e selecionada (trabalho que o claim recusaria)',
    case
      when not coalesce(v_tem_devida, false)
        then 'FALHOU (linha de base: nem a linha devida foi selecionada)'
      when coalesce(v_tem_vivo, false)
        then 'FALHOU (a linha com lease VIVO foi selecionada — a varredura gastaria claim recusado e vaga do limit enquanto outro processo trabalha nela)'
      else 'OK (a devida entra, o lease vivo fica de fora)'
    end);
exception when others then
  insert into t_res values (67, 'SWEEP-4 processing com lease VIVO nao e selecionada (trabalho que o claim recusaria)',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── SWEEP-5 (68): a seleção NÃO ESCREVE NADA ───────────────────────────────
-- O caso central deste arquivo. A alternativa recusada era um claim EM LOTE
-- (marcar 20 linhas `processing` de uma vez), e ela é atraente justamente porque
-- parece "reivindicar o trabalho da varredura". Duas consequências, as duas
-- medidas em outro lugar e nenhuma visível aqui: leases órfãos quando o worker
-- morre, e o claim por linha recusando as linhas que o lote reivindicou.
--
-- O que ESTE caso guarda é a propriedade que torna as duas impossíveis: depois
-- de selecionar, `status`, `claim_id`, `claimed_until`, `attempts` e `updated_at`
-- estão exatamente como estavam.
--
-- `updated_at` não é decoração na lista: ele é o critério de ORDEM da seleção
-- (ver SWEEP-6). Uma seleção que o tocasse mandaria toda linha selecionada para
-- o fim da fila, inclusive as que ela não chegou a processar.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_id uuid;
        v_achou boolean := false;
        v_st_antes text; v_cl_antes uuid; v_until_antes timestamptz;
        v_att_antes int; v_upd_antes timestamptz;
        v_st_dep text; v_cl_dep uuid; v_until_dep timestamptz;
        v_att_dep int; v_upd_dep timestamptz;
begin
  delete from t_res where ord = 68;

  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id, updated_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'sweep-5', now() - interval '3 minutes')
    returning id into v_id;

    select e.status, e.claim_id, e.claimed_until, e.attempts, e.updated_at
      into v_st_antes, v_cl_antes, v_until_antes, v_att_antes, v_upd_antes
      from whatsapp_inbound_events e where e.id = v_id;

    select bool_or(t = v_id) into v_achou
      from public.select_due_whatsapp_inbound_events(100) t;

    select e.status, e.claim_id, e.claimed_until, e.attempts, e.updated_at
      into v_st_dep, v_cl_dep, v_until_dep, v_att_dep, v_upd_dep
      from whatsapp_inbound_events e where e.id = v_id;

    raise exception 'sweep-5: desfaz o insert' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  insert into t_res values (68, 'SWEEP-5 a selecao NAO ESCREVE: status, claim_id, claimed_until, attempts e updated_at intactos',
    case
      when not coalesce(v_achou, false)
        then 'FALHOU (linha de base: a linha nem foi selecionada, entao nao ha escrita a observar)'
      when v_st_dep is distinct from v_st_antes
        then 'FALHOU (a selecao escreveu status: ' || coalesce(v_st_antes, 'null') || ' -> '
             || coalesce(v_st_dep, 'null') || ' — e um claim em lote disfarcado, e um processing sem lease nunca e retomavel)'
      when v_cl_dep is distinct from v_cl_antes
        then 'FALHOU (a selecao escreveu claim_id: ' || coalesce(v_cl_dep::text, 'null') || ')'
      when v_until_dep is distinct from v_until_antes
        then 'FALHOU (a selecao escreveu claimed_until: ' || coalesce(v_until_dep::text, 'null') || ')'
      when v_att_dep is distinct from v_att_antes
        then 'FALHOU (a selecao gastou tentativa: attempts ' || v_att_antes || ' -> ' || v_att_dep || ')'
      when v_upd_dep is distinct from v_upd_antes
        then 'FALHOU (a selecao tocou updated_at, que e o criterio de ORDEM: toda linha selecionada iria para o fim da fila, inclusive as que ela nem processou)'
      else 'OK (a linha foi selecionada e as cinco colunas seguem identicas)'
    end);
exception when others then
  insert into t_res values (68, 'SWEEP-5 a selecao NAO ESCREVE: status, claim_id, claimed_until, attempts e updated_at intactos',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── SWEEP-6 (69): a linha ANTIGA passa na frente da recém-tocada ───────────
-- A ordem é `updated_at`, e não `next_attempt_at`, por causa de UMA linha: a
-- envenenada. É a FINALIZAÇÃO quem escreve `next_attempt_at`; se ela falhar por
-- motivo independente do payload (banco fora, `PGRST202` por Edge Function
-- deployada antes do `db push`), `attempts` e `next_attempt_at` nunca avançam e a
-- linha fica permanentemente devida com o `next_attempt_at` MAIS ANTIGO da
-- tabela. Ordenada por ele, ela seria a primeira a cada minuto, para sempre,
-- consumindo o orcamento de laco e adiando o inbound de outros tenants.
--
-- `updated_at` é escrito pelo CLAIM, isto é, pelo proprio ato de SERVIR a linha
-- — entao ser servida sempre custa a ela o seu lugar na fila.
--
-- A fixture é exatamente esse cenário: a envenenada tem o `next_attempt_at` mais
-- ANTIGO e o `updated_at` mais NOVO. As duas ordens discordam, e é isso que faz o
-- caso medir alguma coisa.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_antiga uuid; v_envenenada uuid;
        v_primeiro uuid;
        v_total int := -1;
begin
  delete from t_res where ord = 69;

  begin
    -- Nunca tocada desde que chegou: `updated_at` = instante do insert.
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id,
                                         next_attempt_at, updated_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'sweep-6-antiga',
            now() - interval '10 minutes', now() - interval '10 minutes')
    returning id into v_antiga;

    -- Envenenada: reivindicada agora (lease ja vencido), finalizacao falhou, logo
    -- `next_attempt_at` continua o original — o mais antigo da tabela.
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id,
                                         status, claim_id, claimed_until, next_attempt_at, updated_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'sweep-6-envenenada',
            'processing', gen_random_uuid(), now() - interval '1 second',
            now() - interval '20 minutes', now())
    returning id into v_envenenada;

    -- UMA chamada, e a ordem vem de `with ordinality` — que é a forma
    -- DOCUMENTADA de capturar a ordem em que a função devolveu as linhas, em vez
    -- de depender da ordem em que um agregado consome um function scan.
    --
    -- Uma chamada, e não duas (contagem + primeira), porque duas tornam este
    -- caso sensível a um defeito que não é o dele: uma seleção que ESCREVA
    -- (o claim em lote recusado) reivindica tudo na primeira chamada e a segunda
    -- volta vazia — o SWEEP-6 avermelharia com "nao devolveu primeira linha
    -- nenhuma", que manda investigar a ordem quando o defeito é a escrita. Medido
    -- ao rodar a sabotagem do C-SWEEP-3 contra a versão de duas chamadas.
    select count(*), (array_agg(x.id order by x.pos))[1]
      into v_total, v_primeiro
      from public.select_due_whatsapp_inbound_events(100) with ordinality as x(id, pos);

    raise exception 'sweep-6: desfaz o insert' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  insert into t_res values (69, 'SWEEP-6 a linha antiga vem ANTES da recem-tocada (a envenenada nao monopoliza o orcamento)',
    case
      when v_total <> 2
        then 'FALHOU (linha de base: a selecao devolveu ' || v_total || ' linha(s) em vez das 2 devidas. '
             || 'Se a que sumiu foi a envenenada (processing com lease vencido), o defeito e a PERNA DE TAKEOVER '
             || 'da selecao, que o SWEEP-3 nomeia — nao a ordem)'
      when v_primeiro is null
        then 'FALHOU (linha de base: a selecao nao devolveu primeira linha nenhuma)'
      when v_primeiro = v_envenenada
        then 'FALHOU (a recem-tocada veio primeiro — e o comportamento de `order by next_attempt_at`: a linha cuja finalizacao falha fica em primeiro lugar para sempre e come a vez de outros tenants)'
      when v_primeiro is distinct from v_antiga
        then 'FALHOU (a primeira linha nao e nenhuma das duas do caso: ' || v_primeiro::text || ')'
      else 'OK (as 2 devidas aparecem, e a antiga vem primeiro apesar de a envenenada ter o next_attempt_at mais antigo)'
    end);
exception when others then
  insert into t_res values (69, 'SWEEP-6 a linha antiga vem ANTES da recem-tocada (a envenenada nao monopoliza o orcamento)',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── PURGE-1 (70): `done` sai em 7 dias ─────────────────────────────────────
-- `raw_body` carrega telefone e texto de cliente. A janela de `done` é de 7 dias,
-- e ela é LOAD-BEARING para uma decisão de outro arquivo: a recusa terminal de
-- 401 morre em `done` (e não em `dead`) exatamente para cair aqui em vez da purga
-- de 30 — ver `queuedEventVerdict`, no núcleo, e o FIN-3 do `18`.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_velha uuid; v_nova uuid;
        v_apagadas int := -1;
        v_velha_ficou boolean := true;
        v_nova_ficou boolean := false;
begin
  delete from t_res where ord = 70;

  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id,
                                         status, received_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'purge-1-velha', 'done', now() - interval '8 days')
    returning id into v_velha;

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id,
                                         status, received_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'purge-1-nova', 'done', now() - interval '6 days')
    returning id into v_nova;

    select public.purge_whatsapp_inbound_events() into v_apagadas;

    select exists (select 1 from whatsapp_inbound_events where id = v_velha),
           exists (select 1 from whatsapp_inbound_events where id = v_nova)
      into v_velha_ficou, v_nova_ficou;

    raise exception 'purge-1: desfaz o insert' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  insert into t_res values (70, 'PURGE-1 done de 8 dias e apagada, done de 6 dias fica',
    case
      when v_velha_ficou
        then 'FALHOU (a linha done de 8 dias sobreviveu — o corpo cru, que e PII, fica alem da retencao declarada)'
      when not v_nova_ficou
        then 'FALHOU (a linha done de 6 dias foi apagada — a janela encolheu e o rastro some antes da hora)'
      when v_apagadas <> 1
        then 'FALHOU (a purga devolveu ' || v_apagadas || ' em vez de 1 — a contagem nao corresponde ao que foi apagado)'
      else 'OK (1 apagada: a de 8 dias; a de 6 dias continua)'
    end);
exception when others then
  insert into t_res values (70, 'PURGE-1 done de 8 dias e apagada, done de 6 dias fica',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── PURGE-2 (71): `dead` sai em 30 dias ────────────────────────────────────
-- Janela maior porque dead letter é o que uma pessoa ainda vai investigar. As
-- duas janelas serem DIFERENTES é a decisão; igualá-las por qualquer lado desfaz
-- a escolha do 401 terminal descrita no PURGE-1.
do $$
declare v_chan uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_corpo bytea := convert_to('{}', 'UTF8');
        v_velha uuid; v_nova uuid;
        v_apagadas int := -1;
        v_velha_ficou boolean := true;
        v_nova_ficou boolean := false;
begin
  delete from t_res where ord = 71;

  begin
    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id,
                                         status, received_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'purge-2-velha', 'dead', now() - interval '31 days')
    returning id into v_velha;

    insert into whatsapp_inbound_events (provider, channel_id, unit_id, raw_body, delivery_id,
                                         status, received_at)
    values ('datafy', v_chan, v_unit, v_corpo, 'purge-2-nova', 'dead', now() - interval '29 days')
    returning id into v_nova;

    select public.purge_whatsapp_inbound_events() into v_apagadas;

    select exists (select 1 from whatsapp_inbound_events where id = v_velha),
           exists (select 1 from whatsapp_inbound_events where id = v_nova)
      into v_velha_ficou, v_nova_ficou;

    raise exception 'purge-2: desfaz o insert' using errcode = 'ZZ113';
  exception when sqlstate 'ZZ113' then
    null;
  end;

  insert into t_res values (71, 'PURGE-2 dead de 31 dias e apagada, dead de 29 dias fica',
    case
      when v_velha_ficou
        then 'FALHOU (a linha dead de 31 dias sobreviveu — o corpo cru fica alem da retencao declarada)'
      when not v_nova_ficou
        then 'FALHOU (a linha dead de 29 dias foi apagada — a dead letter some antes de alguem investigar)'
      when v_apagadas <> 1
        then 'FALHOU (a purga devolveu ' || v_apagadas || ' em vez de 1)'
      else 'OK (1 apagada: a de 31 dias; a de 29 dias continua)'
    end);
exception when others then
  insert into t_res values (71, 'PURGE-2 dead de 31 dias e apagada, dead de 29 dias fica',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── ACL-SWEEP (72): seleção e purga são só do service_role ─────────────────
-- `CREATE FUNCTION` concede EXECUTE a PUBLIC por padrão e o schema `public` é
-- exposto ao PostgREST com a anon key. A purga com `anon` seria "apague a fila de
-- qualquer tenant"; a SELEÇÃO, que não escreve nada, seria um inventário de quem
-- recebeu mensagem agora — id de entrega de todo tenant, de graça.
-- O grant a PUBLIC é conferido de duas formas porque `proacl` NULO significa
-- "privilégios default", isto é, o EXECUTE implícito a PUBLIC ainda de pé.
do $$
declare v_sel text := 'public.select_due_whatsapp_inbound_events(integer)';
        v_pur text := 'public.purge_whatsapp_inbound_events()';
        v_anon boolean; v_auth boolean; v_svc boolean; v_pub boolean;
        v_anon_p boolean; v_auth_p boolean; v_svc_p boolean; v_pub_p boolean;
begin
  delete from t_res where ord = 72;

  v_anon := has_function_privilege('anon', v_sel, 'execute');
  v_auth := has_function_privilege('authenticated', v_sel, 'execute');
  v_svc := has_function_privilege('service_role', v_sel, 'execute');
  select p.proacl is null
         or exists (select 1 from unnest(p.proacl) a where a::text like '=%')
    into v_pub
    from pg_proc p where p.oid = v_sel::regprocedure;

  v_anon_p := has_function_privilege('anon', v_pur, 'execute');
  v_auth_p := has_function_privilege('authenticated', v_pur, 'execute');
  v_svc_p := has_function_privilege('service_role', v_pur, 'execute');
  select p.proacl is null
         or exists (select 1 from unnest(p.proacl) a where a::text like '=%')
    into v_pub_p
    from pg_proc p where p.oid = v_pur::regprocedure;

  insert into t_res values (72, 'ACL-SWEEP selecao/purga executaveis so por service_role',
    case
      when v_anon or v_auth or v_anon_p or v_auth_p
        then 'FALHOU (execute vazado: selecao anon=' || v_anon || '/auth=' || v_auth
             || ', purga anon=' || v_anon_p || '/auth=' || v_auth_p || ')'
      when v_pub or v_pub_p
        then 'FALHOU (o grant implicito a PUBLIC sobreviveu: selecao=' || v_pub || ' purga=' || v_pub_p || ')'
      when not v_svc or not v_svc_p
        then 'FALHOU (service_role NAO executa: selecao=' || v_svc || ' purga=' || v_svc_p
             || ' — a varredura nao conseguiria escolher nem purgar nada)'
      else 'OK (anon/authenticated/PUBLIC sem execute; service_role com execute nas duas)'
    end);
exception when others then
  insert into t_res values (72, 'ACL-SWEEP selecao/purga executaveis so por service_role',
    'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;
