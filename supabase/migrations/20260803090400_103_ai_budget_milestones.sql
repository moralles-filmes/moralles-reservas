-- 103 — Ledger dos marcos da franquia de IA (Plano D, spec §18.2).
--
-- POR QUE UM LEDGER E NAO SO A FILA: o UNIQUE de billing_notifications e
-- PARCIAL e NAO deduplica com invoice_id nulo — e nenhum aviso desta fase tem
-- fatura. Enfileirar a cada passada criaria uma linha por dia para o mesmo
-- fato. A CADENCIA VIVE NO LEDGER, NAO NA FILA. Precedente direto:
-- whatsapp_instance_alerts (089).
--
-- DISCIPLINA DE TRES TEMPOS (6b): tocar -> enfileirar -> carimbar. Aqui o
-- INSERT com `on conflict do nothing` E a barreira de persistencia: se ele nao
-- grava, NADA e enfileirado. `notified_at` so e carimbado depois de o
-- enfileiramento confirmar.
--
-- Cada marco dispara NO MAXIMO UMA VEZ POR CICLO.

begin;

create table if not exists ai_budget_milestones (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null references organizations(id) on delete restrict,
  cycle_id uuid not null references ai_cycle_budgets(id) on delete restrict,

  -- PERCENTUAL do limite do ciclo, nao valor absoluto: com limit_cents = 10000
  -- os quatro caem exatamente em R$ 70/80/90/100 da spec, e um limite diferente
  -- (plano CUSTOM futuro) mantem a mesma escada em vez de transformar "R$ 70"
  -- em "94% do teto" sem ninguem decidir isso.
  -- Fonte canonica dos event_type: _shared/ai-budget-milestones-core.ts.
  milestone_percent integer not null check (milestone_percent in (70, 80, 90, 100)),

  -- Custo LIQUIDADO no instante do cruzamento. Auditavel depois, e nao
  -- derivavel: settled_cents do ciclo continua subindo.
  settled_cents_at_cross integer not null check (settled_cents_at_cross >= 0),
  limit_cents_at_cross integer not null check (limit_cents_at_cross >= 0),

  crossed_at timestamptz not null default now(),

  -- Distingue "registrei o marco" de "o aviso foi para a fila". Sem esta
  -- separacao, uma falha de enfileiramento seria indistinguivel de sucesso.
  notified_at timestamptz,
  enqueue_attempts integer not null default 0 check (enqueue_attempts >= 0),

  -- "Nao recebi e-mail" nao e "nao houve alerta": billing_notifications_dispatch
  -- nasce OFF nesta fase e a fila acumula de proposito.
  dispatch_enabled_at_enqueue boolean,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A unicidade que faz "no maximo uma vez por ciclo" ser garantia de banco.
  constraint ai_budget_milestones_cycle_uniq unique (cycle_id, milestone_percent)
);

comment on table ai_budget_milestones is
  'Ledger dos marcos 70/80/90/100% da franquia de IA (Plano D). A cadencia vive AQUI, nao na fila: o UNIQUE de billing_notifications e parcial e nao deduplica com invoice_id nulo. FORCE RLS.';

comment on column ai_budget_milestones.milestone_percent is
  'Percentual do limite do ciclo. Fonte canonica dos event_type correspondentes: _shared/ai-budget-milestones-core.ts (EVENT_TYPE_BY_MILESTONE_PERCENT).';

comment on column ai_budget_milestones.notified_at is
  'Carimbado SO depois de o enfileiramento confirmar. NULL com enqueue_attempts > 0 = marco registrado, aviso nao enfileirado — retry sem duplicar registro.';

create index if not exists ai_budget_milestones_org_idx
  on ai_budget_milestones (organization_id, crossed_at desc);

create index if not exists ai_budget_milestones_pending_idx
  on ai_budget_milestones (cycle_id)
  where notified_at is null;

-- Mesma guarda de tenant das tabelas irmas (101): as FKs garantem existencia,
-- nao que cycle_id e organization_id sao a mesma organizacao.
drop trigger if exists ai_budget_milestones_tenant_guard on ai_budget_milestones;
create trigger ai_budget_milestones_tenant_guard
  before insert or update of organization_id, cycle_id on ai_budget_milestones
  for each row execute function public.ai_budget_child_tenant_guard();

-- =====================================================================
-- RLS
-- =====================================================================
alter table ai_budget_milestones enable row level security;
alter table ai_budget_milestones force row level security;

drop policy if exists platform_admin_all_ai_budget_milestones on ai_budget_milestones;
create policy platform_admin_all_ai_budget_milestones
  on ai_budget_milestones for all
  to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

drop trigger if exists ai_budget_milestones_updated_at on ai_budget_milestones;
create trigger ai_budget_milestones_updated_at
  before update on ai_budget_milestones
  for each row execute function update_updated_at();

commit;

-- =====================================================================
-- Validacao pos-migration
-- =====================================================================
-- 1. RLS ligada e forcada (esperado: t, t):
--   select relrowsecurity, relforcerowsecurity from pg_class where relname = 'ai_budget_milestones';
--
-- 2. Segundo INSERT do mesmo marco no mesmo ciclo e rejeitado (esperado: 23505):
--   insert into ai_budget_milestones (organization_id, cycle_id, milestone_percent,
--                                     settled_cents_at_cross, limit_cents_at_cross)
--   values ('<org>','<cyc>',70,7000,10000);   -- duas vezes
--
-- 3. Percentual fora do vocabulario e rejeitado (esperado: 23514):
--   ... milestone_percent = 75
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- Executar ANTES da 101 (a trigger usa ai_budget_child_tenant_guard).
--   drop table if exists ai_budget_milestones;
