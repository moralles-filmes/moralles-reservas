-- 101 — Reservas de turno e eventos de uso de IA (Plano D, spec §17.2 e §17.4).
--
-- DUAS TABELAS NO MESMO ARQUIVO porque so fazem sentido juntas: a reserva e a
-- fonte OPERACIONAL do turno (permite revalidar por chamada sem consultar o
-- ledger inteiro), e o evento e a fonte de VERDADE do ciclo.
--
-- FAIL-CLOSED NAS DUAS IGNORANCIAS:
--   - preco desconhecido  -> nao ha evento (price_id e NOT NULL) e nao ha chamada;
--   - usage desconhecido  -> evento em USAGE_REVIEW_REQUIRED com estimativa
--                            conservadora COMPROMETIDA, e a reserva sai do
--                            caminho de expiracao automatica.
-- Sao falhas diferentes com a mesma consequencia: nao e possivel afirmar quanto
-- custou, logo nao e possivel afirmar que cabe no teto.

begin;

-- =====================================================================
-- Reservas — a reserva pertence ao TURNO; cada chamada apropria parte dela
-- =====================================================================
create table if not exists ai_cost_reservations (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null references organizations(id) on delete restrict,
  cycle_id uuid not null references ai_cycle_budgets(id) on delete restrict,

  -- Agrupa as ate 12 chamadas internas de um turno (MAX_ITERATIONS).
  turn_id text not null,

  reserved_cents integer not null check (reserved_cents >= 0),
  -- Acompanha o gasto DENTRO do turno. NUNCA diminui. Quando ultrapassa
  -- reserved_cents e overage OBSERVAVEL (incidente), nunca margem aceita.
  consumed_cents integer not null default 0 check (consumed_cents >= 0),
  released_cents integer not null default 0 check (released_cents >= 0),

  -- SETTLED / RELEASED / EXPIRED sao TERMINAIS: reserva finalizada nao volta a ativa.
  status text not null default 'HELD' check (status in ('HELD', 'SETTLED', 'RELEASED', 'EXPIRED')),

  -- TRUE tira esta reserva da varredura de expiracao (§17.2.2). Sem isso, o TTL
  -- de recuperacao de crash vira PORTA DE SAIDA para consumo nao contabilizado:
  -- bastaria toda resposta vazia esperar cinco minutos para o custo desaparecer.
  -- A resolucao e administrativa ou por reconcile seguro — nunca por decurso de prazo.
  usage_review_required boolean not null default false,

  idempotency_key text not null,

  created_at timestamptz not null default now(),
  -- OBRIGATORIO: reserva nao liquidada nem liberada (crash, timeout, deploy no
  -- meio do turno) consumiria teto para sempre.
  expires_at timestamptz not null,
  -- finalized_at, e nao settled_at: os TRES estados terminais precisam de
  -- carimbo. Uma reserva EXPIRED sem data e indistinguivel de uma nunca varrida.
  finalized_at timestamptz,

  constraint ai_cost_reservations_idem_uniq unique (organization_id, idempotency_key),
  constraint ai_cost_reservations_terminal_chk
    check ((status = 'HELD') = (finalized_at is null))
);

comment on table ai_cost_reservations is
  'Reserva de capacidade por TURNO (Plano D). Reserva e capacidade COMPROMETIDA, nao gasto. usage_review_required tira a linha da varredura de expiracao. FORCE RLS.';

comment on column ai_cost_reservations.consumed_cents is
  'Gasto apropriado DENTRO do turno, chamada a chamada. Nunca diminui. Acima de reserved_cents e overage observavel (incidente), nunca franquia adicional.';

comment on column ai_cost_reservations.usage_review_required is
  'TRUE = existe chamada cujo custo nao pode ser determinado. A linha SAI da expiracao automatica e entra em fila de reconciliacao administrativa.';

create index if not exists ai_cost_reservations_held_idx
  on ai_cost_reservations (organization_id, cycle_id)
  where status = 'HELD';

-- Varredura de expiradas: so as HELD sem revisao pendente entram.
create index if not exists ai_cost_reservations_expiry_idx
  on ai_cost_reservations (expires_at)
  where status = 'HELD' and usage_review_required = false;

create index if not exists ai_cost_reservations_review_idx
  on ai_cost_reservations (organization_id, cycle_id)
  where usage_review_required = true;

create index if not exists ai_cost_reservations_turn_idx
  on ai_cost_reservations (organization_id, turn_id);

-- =====================================================================
-- Eventos de uso — a fonte de verdade do ciclo
-- =====================================================================
create table if not exists ai_usage_events (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null references organizations(id) on delete restrict,
  -- Aponta para o ORCAMENTO, nao para um par de datas soltas: evita que dois
  -- eventos do mesmo ciclo discordem sobre onde o ciclo comeca.
  cycle_id uuid not null references ai_cycle_budgets(id) on delete restrict,
  unit_id uuid references units(id) on delete set null,
  reservation_id uuid references ai_cost_reservations(id) on delete set null,
  conversation_id uuid,

  turn_id text not null,
  request_id text not null,
  -- Identidade PROPRIA de cada chamada dentro do turno. A segunda chamada do
  -- fallback do Gemini tem call_id proprio: sao duas chamadas financeiras.
  call_id text not null,

  provider text not null,
  -- Modelo EXATO resolvido para ESTA chamada. Pro custa multiplas vezes Flash;
  -- gravar o modelo inicial num evento de fallback e subcontabilizacao direta.
  model text not null,

  -- NOT NULL: um evento de uso financeiro so pode existir quando o sistema
  -- conhece provider, modelo, preco, vigencia e custo calculavel. O fail-closed
  -- impede a chamada antes disso. E a "versao de preco usada", auditavel mesmo
  -- depois de a vigencia fechar.
  price_id uuid not null references ai_model_prices(id) on delete restrict,

  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
  reasoning_tokens integer not null default 0 check (reasoning_tokens >= 0),

  cost_usd numeric(12,6) not null check (cost_usd >= 0),
  -- Taxa EFETIVAMENTE usada. NAO recalcular eventos historicos quando o cambio mudar.
  usd_to_brl numeric(12,6) not null check (usd_to_brl > 0),
  cost_brl_cents integer not null check (cost_brl_cents >= 0),

  usage_state text not null default 'SETTLED'
    check (usage_state in ('SETTLED', 'USAGE_REVIEW_REQUIRED', 'FAILED_BEFORE_PROVIDER', 'PROVIDER_FAILED')),

  -- Preenchido pela reconciliacao administrativa de USAGE_REVIEW_REQUIRED.
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id),
  resolution_note text,

  idempotency_key text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- E o UNIQUE que protege a idempotencia: reexecucao com a mesma chave NAO
  -- debita de novo.
  constraint ai_usage_events_idem_uniq unique (organization_id, idempotency_key),

  -- ZERO SO E AFIRMACAO LEGITIMA onde se sabe que nada foi consumido.
  -- FAILED_BEFORE_PROVIDER: negada antes de qualquer I/O externo.
  -- PROVIDER_FAILED: provedor falhou sem consumo apuravel.
  -- USAGE_REVIEW_REQUIRED e o oposto: a chamada OCORREU e o custo e
  -- indeterminado — o valor gravado e estimativa conservadora COMPROMETIDA,
  -- e por isso tem de ser maior que zero.
  constraint ai_usage_events_zero_chk check (
    case usage_state
      when 'FAILED_BEFORE_PROVIDER' then cost_brl_cents = 0 and cost_usd = 0
      when 'PROVIDER_FAILED' then cost_brl_cents = 0 and cost_usd = 0
      when 'USAGE_REVIEW_REQUIRED' then cost_brl_cents > 0
      else true
    end
  ),

  constraint ai_usage_events_resolution_chk check (
    resolved_at is null or usage_state <> 'USAGE_REVIEW_REQUIRED'
  )
);

comment on table ai_usage_events is
  'Ledger de consumo de IA (Plano D). price_id NOT NULL: evento financeiro so existe com preco conhecido. Sem payload do provedor, sem credencial. FORCE RLS.';

comment on column ai_usage_events.call_id is
  'Identidade da CHAMADA dentro do turno. A segunda chamada do fallback do Gemini tem call_id proprio — sao duas chamadas financeiras.';

comment on column ai_usage_events.usage_state is
  'SETTLED = custo real conhecido. USAGE_REVIEW_REQUIRED = chamada ocorreu, custo indeterminado (valor = estimativa conservadora comprometida). FAILED_BEFORE_PROVIDER e PROVIDER_FAILED = zero VERDADEIRO.';

create index if not exists ai_usage_events_cycle_idx
  on ai_usage_events (cycle_id, created_at desc);

create index if not exists ai_usage_events_org_idx
  on ai_usage_events (organization_id, created_at desc);

create index if not exists ai_usage_events_review_idx
  on ai_usage_events (organization_id, cycle_id)
  where usage_state = 'USAGE_REVIEW_REQUIRED' and resolved_at is null;

create index if not exists ai_usage_events_model_idx
  on ai_usage_events (cycle_id, provider, model);

-- Uma call_id nao liquida duas vezes (invariante §17.4). O UNIQUE de
-- idempotency_key ja protege, e este indice torna a garantia explicita para o
-- caso de a chave passar a ser derivada de outra coisa no futuro.
create unique index if not exists ai_usage_events_call_uniq
  on ai_usage_events (organization_id, turn_id, call_id);

-- =====================================================================
-- Guarda de tenant — mesmo padrao de whatsapp_instance_child_tenant_guard (088)
-- =====================================================================
-- As FKs garantem que cycle_id, unit_id e organization_id existem, NAO que sao
-- a mesma organizacao. Esta trigger existe para que um bug futuro num produtor
-- nao consiga atribuir CUSTO a organizacao errada em silencio.
--
-- SAO DOIS CAMINHOS DE ATRIBUICAO, nao um. Validar so `cycle_id` deixava o
-- outro aberto: `ai_usage_events.unit_id` e escrito pelo adapter a partir do
-- canal de WhatsApp, e uma unidade de OUTRA organizacao entraria sem nenhum
-- barulho — o custo apareceria no ciclo certo e no tenant errado em toda
-- consulta por unidade.
create or replace function public.ai_budget_child_tenant_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cycle_org uuid;
  v_new jsonb;
  v_unit_id uuid;
  v_unit_org uuid;
begin
  if new.cycle_id is not null then
    select organization_id into v_cycle_org from ai_cycle_budgets where id = new.cycle_id;

    if v_cycle_org is null or v_cycle_org <> new.organization_id then
      raise exception 'cycle_id pertence a outra organizacao'
        using errcode = 'check_violation';
    end if;
  end if;

  -- `unit_id` E LIDO POR to_jsonb, NAO POR `new.unit_id`. Esta funcao e
  -- COMPARTILHADA por tabelas de formatos diferentes: ai_cost_reservations e
  -- ai_budget_milestones nao tem a coluna, e o acesso cru estouraria "record
  -- new has no field unit_id" (42703) em TEMPO DE EXECUCAO, em todo INSERT
  -- delas — a migration aplicaria limpa e o ledger quebraria na primeira
  -- reserva real. Perguntar pelo campo em vez de assumi-lo tambem cobre de
  -- graca a tabela irma que ganhar a coluna depois.
  v_new := to_jsonb(new);
  if v_new ? 'unit_id' and v_new->>'unit_id' is not null then
    v_unit_id := (v_new->>'unit_id')::uuid;
    select organization_id into v_unit_org from units where id = v_unit_id;

    if v_unit_org is null or v_unit_org <> new.organization_id then
      raise exception 'unit_id pertence a outra organizacao'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.ai_budget_child_tenant_guard()
  from public, anon, authenticated;

drop trigger if exists ai_cost_reservations_tenant_guard on ai_cost_reservations;
create trigger ai_cost_reservations_tenant_guard
  before insert or update of organization_id, cycle_id on ai_cost_reservations
  for each row execute function public.ai_budget_child_tenant_guard();

-- `unit_id` NA LISTA DO `update of`: sem ele a guarda nao dispara quando o
-- UPDATE troca SO a unidade, e a validacao de unidade acima seria letra morta
-- em tudo que nao fosse INSERT. As tabelas irmas nao listam a coluna porque
-- nao a tem — `update of unit_id` numa tabela sem a coluna e erro de DDL.
drop trigger if exists ai_usage_events_tenant_guard on ai_usage_events;
create trigger ai_usage_events_tenant_guard
  before insert or update of organization_id, cycle_id, unit_id on ai_usage_events
  for each row execute function public.ai_budget_child_tenant_guard();

-- =====================================================================
-- RLS
-- =====================================================================
alter table ai_cost_reservations enable row level security;
alter table ai_cost_reservations force row level security;

drop policy if exists platform_admin_all_ai_cost_reservations on ai_cost_reservations;
create policy platform_admin_all_ai_cost_reservations
  on ai_cost_reservations for all
  to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

alter table ai_usage_events enable row level security;
alter table ai_usage_events force row level security;

drop policy if exists platform_admin_all_ai_usage_events on ai_usage_events;
create policy platform_admin_all_ai_usage_events
  on ai_usage_events for all
  to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

drop trigger if exists ai_usage_events_updated_at on ai_usage_events;
create trigger ai_usage_events_updated_at
  before update on ai_usage_events
  for each row execute function update_updated_at();

commit;

-- =====================================================================
-- Validacao pos-migration
-- =====================================================================
-- 1. RLS ligada e forcada nas duas (esperado: t,t em cada):
--   select relname, relrowsecurity, relforcerowsecurity from pg_class
--    where relname in ('ai_cost_reservations','ai_usage_events');
--
-- 2. price_id e NOT NULL (esperado: NO):
--   select is_nullable from information_schema.columns
--    where table_name='ai_usage_events' and column_name='price_id';
--
-- 3. Zero proibido em USAGE_REVIEW_REQUIRED (esperado: erro 23514):
--   insert into ai_usage_events (...) values (..., 'USAGE_REVIEW_REQUIRED', ..., 0, 0);
--
-- 4. Guarda de tenant instalada (esperado: 2 linhas):
--   select tgname from pg_trigger where tgname in
--     ('ai_cost_reservations_tenant_guard','ai_usage_events_tenant_guard');
--
-- 5. A guarda cobre os DOIS caminhos de atribuicao (esperado: erro em cada):
--   -- ciclo de outra organizacao:
--   insert into ai_usage_events (organization_id, cycle_id, ...) values ('<orgA>','<cicloDaOrgB>', ...);
--   -- unidade de outra organizacao:
--   insert into ai_usage_events (organization_id, cycle_id, unit_id, ...)
--   values ('<orgA>','<cicloDaOrgA>','<unitDaOrgB>', ...);
--
-- 6. A guarda compartilhada NAO quebra a tabela sem unit_id (esperado: sucesso):
--   insert into ai_cost_reservations (organization_id, cycle_id, turn_id, reserved_cents,
--                                     idempotency_key, expires_at)
--   values ('<org>','<cicloDaMesmaOrg>','t1',100,'k1', now() + interval '5 min');
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- DEGRAU 2. `drop table` destroi o ledger financeiro. Nao executar isolado.
--
-- O `drop function` abaixo FALHA enquanto a trigger de `ai_budget_milestones`
-- (migration 103) existir — a funcao e compartilhada pelas tres tabelas. O
-- rollback da 103 tem de rodar ANTES deste; a 103 avisa do lado dela, e esta
-- nota existe para quem chegar por aqui primeiro.
--   drop trigger if exists ai_usage_events_tenant_guard on ai_usage_events;
--   drop trigger if exists ai_cost_reservations_tenant_guard on ai_cost_reservations;
--   drop function if exists public.ai_budget_child_tenant_guard();
--   drop table if exists ai_usage_events;
--   drop table if exists ai_cost_reservations;
