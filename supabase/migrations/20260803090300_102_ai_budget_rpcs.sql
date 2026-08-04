-- 102 — RPCs transacionais do orcamento de franquia de IA (Plano D, §17.5-17.6).
--
-- O PASSO 1 DO CICLO E ATOMICO E E ONDE O TETO E APLICADO. Verificar depois da
-- chamada nao e protecao: e deteccao.
--
-- O LOCK NAO E A GARANTIA. `select ... for update` na linha do orcamento
-- serializa as concorrentes e economiza trabalho; a correcao vem dos UNIQUE e
-- do EXCLUDE das migrations 100/101. Advisory lock NAO e usado de proposito:
-- e session-scoped e nao sobrevive ao pooling transaction-mode do PgBouncer
-- (licao da migration 056, lock de conversa por TTL em coluna).
--
-- ORDEM DE LOCK UNICA — ai_cycle_budgets ANTES de ai_cost_reservations em
-- TODAS as funcoes; inverter em uma delas reintroduz deadlock (40P01) entre a
-- varredura de expiradas de reserve_ai_budget e as demais RPCs.
--
-- TODA COLUNA DE `RETURNS TABLE` E UMA VARIAVEL PLPGSQL EM ESCOPO NO CORPO.
-- Referenciar uma coluna de tabela HOMONIMA sem qualificar estoura 42702
-- (column reference is ambiguous) em TEMPO DE EXECUCAO — a migration aplica
-- limpa e a RPC quebra na PRIMEIRA chamada real. Por isso todo acesso a
-- `reserved_cents`, `consumed_cents`, `settled_cents`, `limit_cents`, `state`,
-- `id` e afins usa alias de tabela (`r.`, `b.`). As unicas posicoes isentas sao
-- as que o proprio Postgres nao substitui: o alvo do SET num UPDATE e a lista
-- de colunas de um INSERT. `#variable_conflict use_column` NAO e usado: ele
-- muda a resolucao no corpo inteiro e trocaria um erro barulhento por um bug
-- quieto onde a intencao era a variavel.
--
-- NENHUMA FUNCAO AQUI CONTA CONVERSA, MENSAGEM OU INTERACAO. O unico teto e
-- financeiro (§18.1).
--
-- Sem segredo, sem host de projeto, sem header de autenticacao.

begin;

-- =====================================================================
-- 1. Abertura idempotente do ciclo
-- =====================================================================
-- Chamada no inicio do turno. Reexecucao devolve a linha existente — a
-- reativacao apos inadimplencia e a troca de plano sao exatamente os momentos
-- em que um segundo budget nasceria sobrepondo o primeiro, e o EXCLUDE da 100
-- e quem impede isso. Aqui a excecao 23P01 e traduzida em "devolva o ciclo que
-- ja cobre hoje" em vez de estourar no caller.
create or replace function public.open_ai_cycle_budget(
  p_organization_id uuid,
  p_cycle_start date,
  p_cycle_end date,
  p_anchor_day integer,
  p_limit_cents integer
)
returns table (
  id uuid,
  limit_cents integer,
  settled_cents integer,
  state text,
  cycle_start date,
  cycle_end date,
  cycle_anchor_day integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row ai_cycle_budgets%rowtype;
begin
  select * into v_row
  from ai_cycle_budgets b
  where b.organization_id = p_organization_id
    and b.cycle_start <= p_cycle_start
    and b.cycle_end > p_cycle_start;

  if found then
    return query select v_row.id, v_row.limit_cents, v_row.settled_cents, v_row.state,
                        v_row.cycle_start, v_row.cycle_end, v_row.cycle_anchor_day;
    return;
  end if;

  begin
    insert into ai_cycle_budgets (
      organization_id, cycle_start, cycle_end, cycle_anchor_day, limit_cents
    ) values (
      p_organization_id, p_cycle_start, p_cycle_end, p_anchor_day, p_limit_cents
    )
    returning * into v_row;
  exception
    -- 23505 = duplicado exato; 23P01 = sobreposicao. Nos dois casos outra
    -- invocacao ganhou a corrida: releia e devolva o ciclo dela. Criar um
    -- segundo budget seria TETO DOBRADO sem ninguem decidir isso.
    when unique_violation or exclusion_violation then
      select * into v_row
      from ai_cycle_budgets b
      where b.organization_id = p_organization_id
        and b.cycle_start <= p_cycle_start
        and b.cycle_end > p_cycle_start;
      if not found then
        raise;
      end if;
  end;

  return query select v_row.id, v_row.limit_cents, v_row.settled_cents, v_row.state,
                      v_row.cycle_start, v_row.cycle_end, v_row.cycle_anchor_day;
end;
$$;

comment on function public.open_ai_cycle_budget(uuid, date, date, integer, integer) is
  'Abre (ou devolve) o orcamento do ciclo que cobre p_cycle_start. Idempotente. limit_cents e CONGELADO na abertura. A aritmetica de ancora vem do nucleo puro ai-budget-core.ts — nao e reimplementada aqui.';

-- =====================================================================
-- 2. Reserva do turno — leitura e criacao ATOMICAS
-- =====================================================================
-- p_observation E O MODO OBSERVACAO (flag ai_wallet_enforced OFF): a franquia
-- MEDE mas nao NEGA. Com true, a reserva nasce mesmo excedendo o disponivel e
-- mesmo com usage pendente, e a coluna `overrun` diz que ela excedeu. Sem esse
-- escape, a organizacao que estourou o teto rodaria TODO turno seguinte sem
-- reserva — e portanto sem medicao — permanentemente cega, no unico modo que
-- existe justamente para medi-la. Nao e consertavel no chamador: os ganchos
-- precisam de um reservation_id que nao teria sido criado.
--
-- O TETO CONTINUA INTEIRO. A reserva de overrun percorre o ciclo normal:
-- record_ai_call_usage avanca consumed_cents, finalize_ai_reservation migra o
-- consumido para settled_cents (que nao tem limite superior) e carimba
-- state='EXHAUSTED' assim que settled >= limit. Com a flag LIGADA
-- (p_observation = false), o disponivel ja estara em zero e a negacao volta a
-- acontecer sem nenhuma mudanca de codigo.
--
-- PRECO DESCONHECIDO NAO TEM ESCAPE EQUIVALENTE, e por impedimento estrutural,
-- nao por escolha: price_id e NOT NULL em ai_usage_events, entao o evento nao
-- poderia existir. Saldo estourado e usage pendente nao tem esse impedimento —
-- da para registrar, e por isso se registra.
--
-- A assinatura mudou (parametro e coluna novos). O drop abaixo mantem o arquivo
-- reexecutavel: `create or replace` nao muda tipo de retorno (42P13), e a versao
-- de 6 argumentos ficaria ambigua com a de 7 com default.
drop function if exists public.reserve_ai_budget(uuid, uuid, text, text, integer, integer);

create or replace function public.reserve_ai_budget(
  p_organization_id uuid,
  p_cycle_id uuid,
  p_turn_id text,
  p_idempotency_key text,
  p_estimate_cents integer,
  p_ttl_seconds integer,
  p_observation boolean default false
)
returns table (
  decision text,
  reason_code text,
  reservation_id uuid,
  reserved_cents integer,
  consumed_cents integer,
  available_cents integer,
  -- TRUE = esta reserva nasceu EXCEDENDO o disponivel, o que so acontece em
  -- observacao. Descreve a decisao DESTA chamada: no caminho idempotente
  -- (reserva ja existente) nada foi decidido e a coluna volta false.
  overrun boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_budget ai_cycle_budgets%rowtype;
  v_res ai_cost_reservations%rowtype;
  v_committed integer;
  v_available integer;
  v_review boolean;
  -- Qual guard foi contornado por observacao. NULL quando nenhum — e com
  -- p_observation = false e SEMPRE null, porque nenhum ramo novo e alcancado.
  v_bypass text := null;
  v_overrun boolean := false;
begin
  -- Serializa as concorrentes da MESMA organizacao. Sem isto, duas invocacoes
  -- leem o mesmo available e ambas reservam contra ele.
  select * into v_budget
  from ai_cycle_budgets
  where id = p_cycle_id and organization_id = p_organization_id
  for update;

  if not found then
    return query select 'ERROR'::text, 'cycle_not_found'::text, null::uuid, 0, 0, 0, false;
    return;
  end if;

  -- Reexecucao com a mesma chave NAO cria segunda reserva nem debita de novo.
  select * into v_res
  from ai_cost_reservations
  where organization_id = p_organization_id and idempotency_key = p_idempotency_key;

  if found then
    if v_res.status <> 'HELD' then
      -- Reserva finalizada nao volta a ativa: SETTLED/RELEASED/EXPIRED sao terminais.
      return query select 'ERROR'::text, 'reservation_finalized'::text,
                          v_res.id, v_res.reserved_cents, v_res.consumed_cents, 0, false;
      return;
    end if;
    return query select 'ALLOW'::text, null::text,
                        v_res.id, v_res.reserved_cents, v_res.consumed_cents, 0, false;
    return;
  end if;

  -- Varredura de expiradas, sob o mesmo lock. NUNCA toca reserva com usage
  -- pendente: o TTL de recuperacao de crash nao pode virar porta de saida para
  -- consumo nao contabilizado (§17.2.2).
  -- ALIAS OBRIGATORIO: `reserved_cents` e `consumed_cents` sao nomes de coluna
  -- de saida (RETURNS TABLE), e portanto variaveis plpgsql em escopo. Sem o
  -- `r.`, o statement estoura 42702 (column reference is ambiguous) em TEMPO DE
  -- EXECUCAO — a migration aplicaria limpa e a RPC quebraria na primeira
  -- chamada real. `#variable_conflict use_column` resolveria, e e proibido aqui:
  -- muda a resolucao no corpo INTEIRO e trocaria um erro barulhento por um bug
  -- quieto onde a intencao era a variavel.
  update ai_cost_reservations r
     set status = 'EXPIRED',
         released_cents = greatest(r.reserved_cents - r.consumed_cents, 0),
         finalized_at = now()
   where r.organization_id = p_organization_id
     and r.cycle_id = p_cycle_id
     and r.status = 'HELD'
     and r.usage_review_required = false
     and r.expires_at <= now();

  -- Consumo anterior cujo custo nao pode ser determinado bloqueia chamada nova.
  -- Escopado ao CICLO: o valor comprometido ja foi apropriado neste ciclo, e um
  -- bloqueio perpetuo entre ciclos seria alerta eterno — o outro extremo que a
  -- §17.2.2 tambem proibe. A resolucao continua administrativa.
  select exists (
    select 1 from ai_usage_events e
    where e.organization_id = p_organization_id
      and e.cycle_id = p_cycle_id
      and e.usage_state = 'USAGE_REVIEW_REQUIRED'
      and e.resolved_at is null
  ) into v_review;

  if v_review then
    if not p_observation then
      return query select 'DENY_USAGE_UNRESOLVED'::text, 'prior_usage_unresolved'::text,
                          null::uuid, 0, 0, 0, false;
      return;
    end if;
    -- Observacao: o estado pendente e PEGAJOSO ate resolucao administrativa.
    -- Negar aqui com a flag desligada deixaria a organizacao no escuro por tempo
    -- indeterminado. Registra-se o contorno e segue.
    v_bypass := 'observation_usage_unresolved';
  end if;

  -- Capacidade COMPROMETIDA = restante das HELD, nunca o valor original: a parte
  -- ja consumida migra para settled na liquidacao, e conta-la duas vezes
  -- bloquearia organizacoes que ainda tem saldo.
  -- Alias pelo mesmo motivo do statement acima (42702 em tempo de execucao).
  select coalesce(sum(greatest(r.reserved_cents - r.consumed_cents, 0)), 0)
    into v_committed
    from ai_cost_reservations r
   where r.organization_id = p_organization_id
     and r.cycle_id = p_cycle_id
     and r.status = 'HELD';

  v_available := greatest(v_budget.limit_cents - v_budget.settled_cents - v_committed, 0);

  if p_estimate_cents > v_available then
    if not p_observation then
      return query select 'DENY_BUDGET'::text, 'insufficient_available'::text,
                          null::uuid, 0, 0, v_available, false;
      return;
    end if;
    -- Observacao: a reserva nasce EXCEDENDO o disponivel, de proposito, para que
    -- o turno seja medido. O consumo real vai para settled_cents na liquidacao e
    -- o teto continua integro para quando a flag ligar (ver cabecalho da secao).
    v_overrun := true;
    v_bypass := coalesce(v_bypass || '+', '') || 'observation_overrun';
  end if;

  insert into ai_cost_reservations (
    organization_id, cycle_id, turn_id, reserved_cents, idempotency_key, expires_at
  ) values (
    p_organization_id, p_cycle_id, p_turn_id, p_estimate_cents, p_idempotency_key,
    now() + make_interval(secs => greatest(p_ttl_seconds, 30))
  )
  returning * into v_res;

  return query select 'ALLOW'::text, v_bypass,
                      v_res.id, v_res.reserved_cents, v_res.consumed_cents, v_available, v_overrun;
end;
$$;

comment on function public.reserve_ai_budget(uuid, uuid, text, text, integer, integer, boolean) is
  'Reserva ATOMICA de capacidade para um TURNO. Le e cria sob lock de linha do orcamento. Expira HELD vencidas (nunca as com usage pendente). Idempotente por (organization_id, idempotency_key). p_observation = modo observacao: cria a reserva mesmo excedendo o disponivel ou com usage pendente, devolve overrun=true, e NUNCA nega comercialmente — o teto continua integro porque o consumo real migra para settled_cents normalmente.';

-- =====================================================================
-- 3. Extensao da reserva — o turno longo nao e punido se o ciclo tem saldo
-- =====================================================================
-- Reservar as 12 iteracoes de uma vez bloquearia organizacoes com saldo real
-- por um pior caso que quase nunca ocorre. A reserva nasce cobrindo duas
-- chamadas e cresce sob o MESMO lock quando o turno se estende.
create or replace function public.extend_ai_reservation(
  p_organization_id uuid,
  p_reservation_id uuid,
  p_additional_cents integer
)
returns table (
  decision text,
  reason_code text,
  reservation_id uuid,
  reserved_cents integer,
  consumed_cents integer,
  available_cents integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cycle_id uuid;
  v_budget ai_cycle_budgets%rowtype;
  v_res ai_cost_reservations%rowtype;
  v_committed integer;
  v_available integer;
begin
  -- Passo 1: le a reserva SEM lock, so pra descobrir a que ciclo ela pertence.
  -- ORDEM DE LOCK UNICA (ver cabecalho do arquivo): ai_cycle_budgets sempre
  -- antes de ai_cost_reservations — travar a reserva primeiro aqui inverteria
  -- a ordem de reserve_ai_budget e reabriria o deadlock 40P01 entre a
  -- varredura de expiradas e esta extensao.
  select cycle_id into v_cycle_id
  from ai_cost_reservations
  where id = p_reservation_id and organization_id = p_organization_id;

  if not found then
    return query select 'ERROR'::text, 'reservation_not_found'::text, null::uuid, 0, 0, 0;
    return;
  end if;

  -- Passo 2: trava o ORCAMENTO primeiro.
  select * into v_budget
  from ai_cycle_budgets
  where id = v_cycle_id and organization_id = p_organization_id
  for update;

  if not found then
    return query select 'ERROR'::text, 'cycle_not_found'::text, p_reservation_id, 0, 0, 0;
    return;
  end if;

  -- Passo 3: so agora trava a RESERVA. Dali em diante TODAS as decisoes
  -- (terminal, expiracao, HELD/nao-HELD) usam este snapshot travado — nunca o
  -- do passo 1.
  select * into v_res
  from ai_cost_reservations
  where id = p_reservation_id and organization_id = p_organization_id
  for update;

  if not found then
    return query select 'ERROR'::text, 'reservation_not_found'::text, null::uuid, 0, 0, 0;
    return;
  end if;

  if v_res.status <> 'HELD' then
    return query select 'ERROR'::text, 'reservation_finalized'::text,
                        v_res.id, v_res.reserved_cents, v_res.consumed_cents, 0;
    return;
  end if;

  -- Reserva expirada NAO autoriza chamada, mesmo antes da varredura passar.
  if v_res.expires_at <= now() and v_res.usage_review_required = false then
    -- Alias: `reserved_cents`/`consumed_cents` sao colunas de saida desta
    -- funcao, logo variaveis em escopo — sem `r.` isto e 42702 em execucao.
    update ai_cost_reservations r
       set status = 'EXPIRED',
           released_cents = greatest(r.reserved_cents - r.consumed_cents, 0),
           finalized_at = now()
     where r.id = v_res.id;
    return query select 'ERROR'::text, 'reservation_expired'::text,
                        v_res.id, v_res.reserved_cents, v_res.consumed_cents, 0;
    return;
  end if;

  select coalesce(sum(greatest(r.reserved_cents - r.consumed_cents, 0)), 0)
    into v_committed
    from ai_cost_reservations r
   where r.organization_id = p_organization_id
     and r.cycle_id = v_res.cycle_id
     and r.status = 'HELD';

  v_available := greatest(v_budget.limit_cents - v_budget.settled_cents - v_committed, 0);

  if p_additional_cents > v_available then
    return query select 'DENY_BUDGET'::text, 'insufficient_available'::text,
                        v_res.id, v_res.reserved_cents, v_res.consumed_cents, v_available;
    return;
  end if;

  -- `and status = 'HELD'` no WHERE: um UPDATE que nao casa nenhuma linha nao
  -- pode passar por sucesso silencioso. Sob o lock adquirido no passo 3 isto e
  -- inalcancavel na pratica (ninguem mais pode mudar o status entre o passo 3
  -- e aqui), mas a garantia fica explicita mesmo assim.
  -- O alvo do SET fica SEM alias (Postgres proibe qualifica-lo); o lado DIREITO
  -- precisa do `r.`, senao `reserved_cents` ali resolve para a coluna de saida.
  update ai_cost_reservations r
     set reserved_cents = r.reserved_cents + greatest(p_additional_cents, 0)
   where r.id = v_res.id
     and r.status = 'HELD'
  returning * into v_res;

  if not found then
    return query select 'ERROR'::text, 'reservation_finalized'::text, p_reservation_id, 0, 0, 0;
    return;
  end if;

  return query select 'ALLOW'::text, null::text,
                      v_res.id, v_res.reserved_cents, v_res.consumed_cents,
                      greatest(v_available - p_additional_cents, 0);
end;
$$;

comment on function public.extend_ai_reservation(uuid, uuid, integer) is
  'Amplia a reserva do turno sob o MESMO lock do orcamento. DENY_BUDGET quando o ciclo nao comporta. Reserva expirada ou terminal nunca e ampliada.';

-- =====================================================================
-- 4. Apropriacao do custo real de UMA chamada
-- =====================================================================
-- O consumo de cada chamada e apropriado ANTES da proxima autorizacao — sem
-- isso, a 2a chamada decide com o saldo de antes da 1a.
create or replace function public.record_ai_call_usage(
  p_organization_id uuid,
  p_cycle_id uuid,
  p_reservation_id uuid,
  p_unit_id uuid,
  p_conversation_id uuid,
  p_turn_id text,
  p_request_id text,
  p_call_id text,
  p_provider text,
  p_model text,
  p_price_id uuid,
  p_input_tokens integer,
  p_output_tokens integer,
  p_cache_read_tokens integer,
  p_cache_write_tokens integer,
  p_reasoning_tokens integer,
  p_cost_usd numeric,
  p_usd_to_brl numeric,
  p_cost_brl_cents integer,
  p_usage_state text,
  p_idempotency_key text
)
returns table (
  applied boolean,
  reserved_cents integer,
  consumed_cents integer,
  usage_review_required boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_cycle_id uuid;
  v_budget ai_cycle_budgets%rowtype;
  v_res ai_cost_reservations%rowtype;
  v_new_settled integer;
  v_state text;
begin
  insert into ai_usage_events (
    organization_id, cycle_id, reservation_id, unit_id, conversation_id,
    turn_id, request_id, call_id, provider, model, price_id,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
    cost_usd, usd_to_brl, cost_brl_cents, usage_state, idempotency_key
  ) values (
    p_organization_id, p_cycle_id, p_reservation_id, p_unit_id, p_conversation_id,
    p_turn_id, p_request_id, p_call_id, p_provider, p_model, p_price_id,
    greatest(p_input_tokens, 0), greatest(p_output_tokens, 0), greatest(p_cache_read_tokens, 0),
    greatest(p_cache_write_tokens, 0), greatest(p_reasoning_tokens, 0),
    greatest(p_cost_usd, 0), p_usd_to_brl, greatest(p_cost_brl_cents, 0),
    p_usage_state, p_idempotency_key
  )
  -- UMA call_id nao liquida duas vezes. Reexecucao com a mesma chave devolve
  -- applied=false e NAO avanca consumed_cents.
  on conflict (organization_id, idempotency_key) do nothing
  returning id into v_event_id;

  -- Passo 1: le a reserva SEM lock, so pra descobrir a que ciclo ela pertence.
  -- ORDEM DE LOCK UNICA (ver cabecalho do arquivo): ai_cycle_budgets sempre
  -- antes de ai_cost_reservations, nas cinco funcoes.
  select cycle_id into v_cycle_id
  from ai_cost_reservations
  where id = p_reservation_id and organization_id = p_organization_id;

  if not found then
    return query select (v_event_id is not null), 0, 0, false;
    return;
  end if;

  -- Passo 2: trava o ORCAMENTO primeiro — SEMPRE, mesmo quando o evento e uma
  -- reexecucao idempotente que nao vai escrever nada e mesmo no ramo HELD que
  -- nao toca settled_cents. Mais trabalho por chamada em troca de uma unica
  -- ordem de lock nas cinco RPCs (ver cabecalho do arquivo).
  select * into v_budget
  from ai_cycle_budgets
  where id = v_cycle_id and organization_id = p_organization_id
  for update;

  -- Passo 3: so agora trava a RESERVA. Dali em diante TODAS as decisoes
  -- (status terminal, HELD/nao-HELD) usam este snapshot travado — nunca o do
  -- passo 1.
  select * into v_res
  from ai_cost_reservations
  where id = p_reservation_id and organization_id = p_organization_id
  for update;

  if not found then
    return query select (v_event_id is not null), 0, 0, false;
    return;
  end if;

  if v_event_id is not null then
    if v_res.status <> 'HELD' then
      -- CUSTO TARDIO: a reserva ja morreu (SETTLED/RELEASED/EXPIRED) mas o
      -- dinheiro foi de fato gasto — a resposta do provedor chegou depois de
      -- finalize_ai_reservation ou da varredura de expiradas de
      -- reserve_ai_budget ter fechado esta linha. NAO reabrir a reserva
      -- (estado terminal e terminal) e NAO tocar em consumed_cents dela —
      -- o custo vai direto pro ciclo, porque descarta-lo seria franquia
      -- adicional silenciosa e reabrir violaria a garantia de terminalidade.
      -- v_budget ja esta travado desde o passo 2.
      v_new_settled := v_budget.settled_cents + greatest(p_cost_brl_cents, 0);
      v_state := case when v_new_settled >= v_budget.limit_cents then 'EXHAUSTED' else v_budget.state end;

      update ai_cycle_budgets
         set settled_cents = settled_cents + greatest(p_cost_brl_cents, 0),
             state = v_state,
             -- O momento do esgotamento nao e derivavel depois. Carimbado uma vez.
             exhausted_at = case
               when v_state = 'EXHAUSTED' and exhausted_at is null then now()
               else exhausted_at
             end,
             updated_at = now()
       where id = v_budget.id;
    else
      -- USAGE_REVIEW_REQUIRED marca a reserva de forma STICKY: uma vez true, so
      -- volta a false por reconciliacao administrativa (fora destas RPCs) —
      -- nunca por decurso de prazo, e nunca liberado automaticamente por esta
      -- funcao. A chamada OCORREU e o custo e indeterminado: a linha sai da
      -- varredura de expiracao e entra em fila de reconciliacao.
      -- Alias nos DOIS: `consumed_cents` e coluna de saida desta funcao, entao
      -- o lado direito do SET sem `r.` e 42702 em tempo de execucao. O alvo do
      -- SET (esquerda) fica sem alias, como Postgres exige.
      if p_usage_state = 'USAGE_REVIEW_REQUIRED' then
        update ai_cost_reservations r
           set consumed_cents = r.consumed_cents + greatest(p_cost_brl_cents, 0),
               usage_review_required = true
         where r.id = v_res.id
        returning * into v_res;
      else
        update ai_cost_reservations r
           set consumed_cents = r.consumed_cents + greatest(p_cost_brl_cents, 0)
         where r.id = v_res.id
        returning * into v_res;
      end if;
    end if;
  end if;

  return query select (v_event_id is not null), v_res.reserved_cents,
                      v_res.consumed_cents, v_res.usage_review_required;
end;
$$;

comment on function public.record_ai_call_usage(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, uuid, integer, integer, integer, integer, integer, numeric, numeric, integer, text, text) is
  'Grava UM evento de uso e avanca consumed_cents da reserva, de forma atomica e idempotente por (organization_id, idempotency_key). usage_state USAGE_REVIEW_REQUIRED marca a reserva (sticky, so true) e a tira da expiracao automatica. Reserva ja terminal (SETTLED/RELEASED/EXPIRED) nao e reaberta: o custo tardio conta direto em settled_cents do ciclo — descarta-lo seria franquia adicional silenciosa.';

-- =====================================================================
-- 5. Finalizacao da reserva
-- =====================================================================
-- SETTLED e RELEASED compartilham a contabilidade: o consumido migra para
-- settled_cents do ciclo e a diferenca volta ao disponivel. O que muda e o
-- NOME do desfecho — liquidacao normal do turno versus liberacao por falha.
create or replace function public.finalize_ai_reservation(
  p_organization_id uuid,
  p_reservation_id uuid,
  p_final_status text
)
returns table (
  finalized boolean,
  settled_cents integer,
  limit_cents integer,
  state text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cycle_id uuid;
  v_budget ai_cycle_budgets%rowtype;
  v_res ai_cost_reservations%rowtype;
  v_new_settled integer;
  v_state text;
begin
  if p_final_status not in ('SETTLED', 'RELEASED') then
    return query select false, 0, 0, 'INVALID_STATUS'::text;
    return;
  end if;

  -- Passo 1: le a reserva SEM lock, so pra descobrir a que ciclo ela pertence.
  -- ORDEM DE LOCK UNICA (ver cabecalho do arquivo): ai_cycle_budgets sempre
  -- antes de ai_cost_reservations, nas cinco funcoes.
  select cycle_id into v_cycle_id
  from ai_cost_reservations
  where id = p_reservation_id and organization_id = p_organization_id;

  if not found then
    return query select false, 0, 0, 'RESERVATION_NOT_FOUND'::text;
    return;
  end if;

  -- Passo 2: trava o ORCAMENTO primeiro.
  select * into v_budget
  from ai_cycle_budgets
  where id = v_cycle_id and organization_id = p_organization_id
  for update;

  if not found then
    return query select false, 0, 0, 'CYCLE_NOT_FOUND'::text;
    return;
  end if;

  -- Passo 3: so agora trava a RESERVA. Dali em diante toda decisao usa este
  -- snapshot travado — nunca o do passo 1.
  select * into v_res
  from ai_cost_reservations
  where id = p_reservation_id and organization_id = p_organization_id
  for update;

  if not found then
    return query select false, 0, 0, 'RESERVATION_NOT_FOUND'::text;
    return;
  end if;

  -- Ja finalizada: idempotente, devolve o estado atual sem debitar de novo.
  if v_res.status <> 'HELD' then
    return query select false, v_budget.settled_cents, v_budget.limit_cents, v_budget.state;
    return;
  end if;

  v_new_settled := v_budget.settled_cents + greatest(v_res.consumed_cents, 0);
  v_state := case when v_new_settled >= v_budget.limit_cents then 'EXHAUSTED' else v_budget.state end;

  update ai_cycle_budgets
     set settled_cents = v_new_settled,
         state = v_state,
         -- O momento do esgotamento nao e derivavel depois. Carimbado uma vez.
         exhausted_at = case
           when v_state = 'EXHAUSTED' and exhausted_at is null then now()
           else exhausted_at
         end,
         updated_at = now()
   where id = v_budget.id;

  update ai_cost_reservations
     set status = p_final_status,
         released_cents = greatest(reserved_cents - consumed_cents, 0),
         finalized_at = now()
   where id = v_res.id;

  return query select true, v_new_settled, v_budget.limit_cents, v_state;
end;
$$;

comment on function public.finalize_ai_reservation(uuid, uuid, text) is
  'Liquida (SETTLED) ou libera (RELEASED) a reserva: move o consumido para settled_cents e devolve a diferenca ao disponivel. Idempotente — reserva terminal nao e reprocessada.';

-- =====================================================================
-- ACL — CREATE FUNCTION concede EXECUTE a PUBLIC por padrao e o schema public
-- e exposto ao PostgREST com a anon key. Revogar PUBLIC **e** os grants diretos.
-- =====================================================================
revoke all on function public.open_ai_cycle_budget(uuid, date, date, integer, integer)
  from public, anon, authenticated;
revoke all on function public.reserve_ai_budget(uuid, uuid, text, text, integer, integer, boolean)
  from public, anon, authenticated;
revoke all on function public.extend_ai_reservation(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.record_ai_call_usage(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, uuid, integer, integer, integer, integer, integer, numeric, numeric, integer, text, text)
  from public, anon, authenticated;
revoke all on function public.finalize_ai_reservation(uuid, uuid, text)
  from public, anon, authenticated;

grant execute on function public.open_ai_cycle_budget(uuid, date, date, integer, integer)
  to service_role;
grant execute on function public.reserve_ai_budget(uuid, uuid, text, text, integer, integer, boolean)
  to service_role;
grant execute on function public.extend_ai_reservation(uuid, uuid, integer)
  to service_role;
grant execute on function public.record_ai_call_usage(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, uuid, integer, integer, integer, integer, integer, numeric, numeric, integer, text, text)
  to service_role;
grant execute on function public.finalize_ai_reservation(uuid, uuid, text)
  to service_role;

commit;

-- =====================================================================
-- Validacao pos-migration
-- =====================================================================
-- 1. ACL das cinco (esperado: nenhuma com anon= ou authenticated=):
--   select proname, proacl from pg_proc
--    where proname in ('open_ai_cycle_budget','reserve_ai_budget','extend_ai_reservation',
--                      'record_ai_call_usage','finalize_ai_reservation');
--
-- 2. search_path fixado nas cinco:
--   select proname, proconfig from pg_proc where proname like '%ai_%budget%' or proname like '%ai_call%';
--
-- 3. TESTE 42 DA SPEC — duas reservas concorrentes NAO usam o mesmo saldo.
--    Em DUAS sessoes psql simultaneas, com o ciclo em limit=10000 e settled=0:
--      A: begin; select * from reserve_ai_budget('<org>','<cyc>','tA','kA',6000,300);
--      B: begin; select * from reserve_ai_budget('<org>','<cyc>','tB','kB',6000,300);
--      A: commit;  B: commit;
--    Esperado: uma ALLOW e uma DENY_BUDGET. B fica bloqueada ate o commit de A.
--
-- 4. Idempotencia: chamar reserve_ai_budget duas vezes com a mesma
--    idempotency_key devolve o MESMO reservation_id e nao cria segunda linha.
--
-- 5. Reserva expirada nao autoriza:
--    reserve com ttl=30, esperar 31s, chamar extend -> reservation_expired.
--
-- 6. MODO OBSERVACAO — mede quem estourou, e o teto volta inteiro quando ligar.
--    Com o ciclo em limit=10000 e settled=10000 (disponivel = 0):
--      a) select * from reserve_ai_budget('<org>','<cyc>','tX','kX',500,300, false);
--         Esperado: DENY_BUDGET / insufficient_available, overrun = false.
--      b) select * from reserve_ai_budget('<org>','<cyc>','tX','kX2',500,300, true);
--         Esperado: ALLOW, reason_code = 'observation_overrun', overrun = TRUE,
--         e uma linha HELD nova em ai_cost_reservations.
--      c) apos record_ai_call_usage + finalize_ai_reservation dessa reserva:
--         settled_cents > limit_cents, state = 'EXHAUSTED', exhausted_at nao nulo.
--      d) repetir (a): continua DENY_BUDGET. O teto nao foi afrouxado — so a
--         negacao foi suspensa enquanto a flag estava desligada.
--
-- 7. Usage pendente em observacao: com um ai_usage_events em
--    USAGE_REVIEW_REQUIRED e resolved_at null no ciclo,
--      reserve_ai_budget(..., false) -> DENY_USAGE_UNRESOLVED
--      reserve_ai_budget(..., true)  -> ALLOW, reason_code = 'observation_usage_unresolved'.
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- DEGRAU 1 (o primeiro a desfazer). Nao destroi dado.
--   drop function if exists public.finalize_ai_reservation(uuid, uuid, text);
--   drop function if exists public.record_ai_call_usage(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, uuid, integer, integer, integer, integer, integer, numeric, numeric, integer, text, text);
--   drop function if exists public.extend_ai_reservation(uuid, uuid, integer);
--   drop function if exists public.reserve_ai_budget(uuid, uuid, text, text, integer, integer, boolean);
--   drop function if exists public.open_ai_cycle_budget(uuid, date, date, integer, integer);
