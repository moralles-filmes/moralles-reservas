-- Histórico IMUTÁVEL de ciclos do fornecedor (Fase 6b).
--
-- O ciclo cobre [cycle_start, provider_due_on) — início INCLUSIVO, fim
-- EXCLUSIVO. NÃO existe coluna `cycle_end`: o nome admitia duas leituras
-- ("último dia pago" vs "dia da próxima cobrança") e a diferença de um dia é
-- justamente a que erra o D-7.
--
-- PENDING_REVIEW é POSTERIOR a OPEN, nunca concorrente: designa ciclo que
-- terminou mas não fechou financeiramente (custo ausente). Por isso não
-- conflita com a unicidade de OPEN e o ciclo seguinte abre normalmente.

begin;

create table if not exists whatsapp_instance_cycles (
  id uuid primary key default gen_random_uuid(),

  instance_id uuid not null references whatsapp_instances(id) on delete cascade,
  -- Denormalizado para escopo de consulta e auditoria sem join.
  organization_id uuid not null references organizations(id) on delete restrict,

  cycle_start date not null,
  provider_due_on date not null,

  status text not null check (status in ('OPEN', 'CLOSED', 'PENDING_REVIEW')),

  -- Congelado na ABERTURA do ciclo: representa o custo vigente quando a
  -- competência começou. Mudança no custo da instância afeta só ciclos FUTUROS.
  provider_cost_cents integer check (provider_cost_cents is null or provider_cost_cents >= 0),
  cost_source text,
  cost_snapshot_at timestamptz,

  -- NULL = desconhecido/ambíguo; 0 = zero VERDADEIRO (override vitalício).
  customer_revenue_cents integer check (customer_revenue_cents is null or customer_revenue_cents >= 0),
  revenue_source text check (revenue_source is null or revenue_source in (
    'SUBSCRIPTION_SOLE_INSTANCE', 'AMBIGUOUS_MULTI_INSTANCE', 'LIFETIME_OVERRIDE', 'NO_ENTITLEMENT'
  )),
  customer_revenue_snapshot_at timestamptz,
  -- Referência ao que produziu a receita, para auditoria posterior.
  billing_subscription_id uuid references billing_subscriptions(id) on delete set null,

  -- Armazenado porque é a diferença de dois inteiros já congelados no ciclo.
  -- O PERCENTUAL, esse, nunca é gravado: é derivável e só poderia divergir.
  gross_margin_cents integer,

  closed_at timestamptz,
  closed_by uuid references auth.users(id),
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint whatsapp_cycles_order_chk check (provider_due_on > cycle_start),

  -- Ciclo fechado tem data de fechamento; ciclo OPEN não tem.
  constraint whatsapp_cycles_closed_chk check (
    (status = 'OPEN' and closed_at is null)
    or (status in ('CLOSED', 'PENDING_REVIEW') and closed_at is not null)
  ),

  -- CLOSED significa financeiramente concluído. Sem custo, o ciclo é
  -- PENDING_REVIEW — o worker não inventa default.
  constraint whatsapp_cycles_closed_needs_cost_chk check (
    status <> 'CLOSED' or provider_cost_cents is not null
  ),

  -- Margem só existe com os dois lados conhecidos.
  constraint whatsapp_cycles_margin_chk check (
    (gross_margin_cents is null)
    or (provider_cost_cents is not null and customer_revenue_cents is not null)
  )
);

comment on table whatsapp_instance_cycles is
  'Historico imutavel de ciclos do fornecedor (Fase 6b). [cycle_start, provider_due_on) — fim EXCLUSIVO, sem coluna cycle_end. Custo congelado na ABERTURA. Sem credenciais.';

comment on column whatsapp_instance_cycles.provider_due_on is
  'EXCLUSIVO: dia da proxima cobranca = cycle_start do ciclo seguinte.';

-- Reexecução do fechamento não duplica.
create unique index if not exists whatsapp_cycles_instance_start_idx
  on whatsapp_instance_cycles (instance_id, cycle_start);

-- NUNCA dois ciclos economicamente correntes na mesma instância.
create unique index if not exists whatsapp_cycles_one_open_idx
  on whatsapp_instance_cycles (instance_id)
  where status = 'OPEN';

create index if not exists whatsapp_cycles_org_idx
  on whatsapp_instance_cycles (organization_id, cycle_start desc);

create index if not exists whatsapp_cycles_pending_idx
  on whatsapp_instance_cycles (status)
  where status = 'PENDING_REVIEW';

-- =====================================================================
-- Guarda de tenant — mesmo padrão de whatsapp_instance_tenant_guard (087)
-- =====================================================================
-- As FKs garantem que instance_id e organization_id existem, NÃO que são a
-- mesma organização. Hoje todo produtor deriva organization_id da própria
-- linha de whatsapp_instances lida no servidor, então não há caminho
-- explorável — esta trigger existe para que um bug futuro num produtor não
-- consiga atribuir CUSTO à organização errada em silêncio, que é exatamente
-- o erro que esta fase existe para impedir.
create or replace function public.whatsapp_instance_child_tenant_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inst_org uuid;
begin
  if new.instance_id is null then
    return new;
  end if;

  select organization_id into v_inst_org
  from whatsapp_instances where id = new.instance_id;

  if v_inst_org is null or v_inst_org <> new.organization_id then
    raise exception 'instance_id pertence a outra organizacao'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke all on function public.whatsapp_instance_child_tenant_guard()
  from public, anon, authenticated;

drop trigger if exists whatsapp_instance_cycles_tenant_guard on whatsapp_instance_cycles;
create trigger whatsapp_instance_cycles_tenant_guard
  before insert or update of organization_id, instance_id on whatsapp_instance_cycles
  for each row execute function public.whatsapp_instance_child_tenant_guard();

-- =====================================================================
-- RLS
-- =====================================================================
alter table whatsapp_instance_cycles enable row level security;
alter table whatsapp_instance_cycles force row level security;

drop policy if exists platform_admin_all_whatsapp_instance_cycles on whatsapp_instance_cycles;
create policy platform_admin_all_whatsapp_instance_cycles
  on whatsapp_instance_cycles for all
  to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

drop trigger if exists whatsapp_instance_cycles_updated_at on whatsapp_instance_cycles;
create trigger whatsapp_instance_cycles_updated_at
  before update on whatsapp_instance_cycles
  for each row execute function update_updated_at();

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. RLS ligada e forçada (esperado: t, t):
--   select relrowsecurity, relforcerowsecurity from pg_class
--    where relname = 'whatsapp_instance_cycles';
--
-- 2. Não existe coluna cycle_end (esperado: 0 linhas):
--   select column_name from information_schema.columns
--    where table_name = 'whatsapp_instance_cycles' and column_name = 'cycle_end';
--
-- 3. Índices de unicidade presentes (esperado: 2 linhas):
--   select indexname from pg_indexes where tablename = 'whatsapp_instance_cycles'
--    and indexname in ('whatsapp_cycles_instance_start_idx', 'whatsapp_cycles_one_open_idx');
--
-- 4. Guarda de tenant instalada (esperado: 1 linha):
--   select tgname from pg_trigger
--    where tgname = 'whatsapp_instance_cycles_tenant_guard';
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- Sequência COMPLETA, nesta ordem. A 089 vem primeiro porque a trigger dela usa
-- a função criada aqui; o Postgres recusa o `drop function` enquanto ela
-- existir (falha segura, mas o operador perde tempo com erro genérico).
--   drop table if exists whatsapp_instance_alerts;
--   drop table if exists whatsapp_instance_cycles;
--   drop function if exists public.whatsapp_instance_child_tenant_guard();
