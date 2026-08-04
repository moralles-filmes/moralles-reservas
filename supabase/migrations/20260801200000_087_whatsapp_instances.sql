-- Inventário de CUSTO da plataforma com a Z-API (Fase 6b). Uma linha por
-- instância que a plataforma paga (ou pagará).
--
-- ZERO SEGREDO: nenhuma coluna de token, senha, API key ou client token. O
-- `provider_instance_ref` é IDENTIFICADOR, não credencial — ele sozinho não
-- envia mensagem, porque o token (a outra metade da URL) fica só no canal.
--
-- `lifecycle_state` NÃO É FONTE DE AUTORIZAÇÃO. Quem decide direito de envio é
-- o gate de sete estados da 5b (_shared/whatsapp-service-state-core.ts).
-- Cancelar no painel da Z-API interrompe o CUSTO DA PLATAFORMA, não o SERVIÇO
-- DO CLIENTE — duas ações, dois relógios, duas consequências.
--
-- RLS: ENABLE + FORCE, policy só de platform_admin, como whatsapp_implementations
-- (071). O lojista NÃO lê esta tabela: ela contém o que a plataforma paga.

begin;

create table if not exists whatsapp_instances (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null references organizations(id) on delete restrict,
  -- Nulo APENAS em backfill incompleto ou revisão administrativa, com motivo
  -- explícito; o painel destaca a pendência.
  unit_id uuid references units(id) on delete set null,
  channel_id uuid references whatsapp_channels(id) on delete set null,

  provider text not null check (provider in ('zapi', 'waha', 'official')),
  provider_instance_ref text,

  lifecycle_state text not null
    check (lifecycle_state in ('AWAITING_PROVISION', 'ACTIVE', 'CANCELLATION_REQUESTED', 'ENDED')),

  provider_cycle_anchor_day smallint
    check (provider_cycle_anchor_day is null
           or (provider_cycle_anchor_day >= 1 and provider_cycle_anchor_day <= 31)),

  -- PROJEÇÃO do ciclo OPEN. A fonte histórica é whatsapp_instance_cycles.
  current_cycle_started_on date,
  current_cycle_due_on date,
  cycle_source text not null default 'UNKNOWN'
    check (cycle_source in ('ADMIN_CONFIRMED', 'SYSTEM_ROLLED', 'UNKNOWN')),

  -- NULL = desconhecido. NUNCA zero: zero é um fato ("não custa nada"), e
  -- gravá-lo no lugar de "não sei" produz margem falsa.
  current_monthly_cost_cents integer
    check (current_monthly_cost_cents is null or current_monthly_cost_cents >= 0),
  cost_source text,
  cost_updated_at timestamptz,
  cost_updated_by uuid references auth.users(id),
  cost_note text,

  cancellation_requested_at timestamptz,
  cancellation_requested_by uuid references auth.users(id),
  cancellation_reason text,
  -- EXCLUSIVO, igual em natureza a provider_due_on: é o primeiro dia NÃO
  -- coberto. O último dia de acesso real é provider_access_until - 1.
  provider_access_until date,

  end_confirmation_required_at timestamptz,
  ended_at timestamptz,
  ended_by uuid references auth.users(id),
  end_confirmation_note text,

  planned_provision_on date,

  last_synced_at timestamptz,
  last_seen_provider_status text,
  last_divergence_kind text,
  last_divergence_at timestamptz,

  notes text,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Cancelamento é congelado no ato: sem a data-limite o custo não tem fim
  -- registrado e a rolagem não sabe onde parar.
  constraint whatsapp_instances_cancel_needs_until_chk check (
    lifecycle_state <> 'CANCELLATION_REQUESTED'
    or (provider_access_until is not null and cancellation_requested_at is not null)
  ),

  -- ENDED é confirmação humana, não dedução: exige quando foi confirmado.
  constraint whatsapp_instances_ended_needs_confirmation_chk check (
    lifecycle_state <> 'ENDED' or ended_at is not null
  ),

  -- Custo informado exige procedência. Número sem origem vira folclore.
  constraint whatsapp_instances_cost_needs_source_chk check (
    current_monthly_cost_cents is null
    or (cost_source is not null and cost_updated_at is not null)
  ),

  -- Projeção coerente: ou as duas datas existem, ou nenhuma.
  constraint whatsapp_instances_cycle_pair_chk check (
    (current_cycle_started_on is null) = (current_cycle_due_on is null)
  ),
  constraint whatsapp_instances_cycle_order_chk check (
    current_cycle_due_on is null or current_cycle_due_on > current_cycle_started_on
  ),

  -- UNKNOWN não pode carregar projeção: seria data inventada com aparência de
  -- fato confirmado, e é exatamente o que a spec §6.2 proíbe.
  constraint whatsapp_instances_unknown_has_no_cycle_chk check (
    cycle_source <> 'UNKNOWN' or current_cycle_due_on is null
  )
);

comment on table whatsapp_instances is
  'Inventario de CUSTO da plataforma por instancia do fornecedor (Fase 6b). ZERO credencial. lifecycle_state NAO autoriza envio — isso e o gate da 5b. FORCE RLS, so platform_admin.';

comment on column whatsapp_instances.provider_instance_ref is
  'Identificador da instancia no painel do fornecedor. NAO e credencial: sozinho nao autentica. Nunca gravar URL completa (ela contem o token).';

comment on column whatsapp_instances.provider_access_until is
  'EXCLUSIVO: primeiro dia NAO coberto. Ultimo dia de acesso real = provider_access_until - 1.';

comment on column whatsapp_instances.current_monthly_cost_cents is
  'NULL = desconhecido, NUNCA zero. Zero e um fato ("nao custa nada") e mentiria sobre a margem.';

-- A mesma instância física do fornecedor não pertence a duas organizações nem
-- a duas linhas internas.
create unique index if not exists whatsapp_instances_provider_ref_idx
  on whatsapp_instances (provider, provider_instance_ref)
  where provider_instance_ref is not null;

-- Um canal não aponta para duas instâncias de custo ao mesmo tempo. Troca
-- histórica preserva a linha antiga com channel_id = NULL ao encerrar.
create unique index if not exists whatsapp_instances_channel_idx
  on whatsapp_instances (channel_id)
  where channel_id is not null;

-- SEM unicidade por organization_id: N instâncias por organização é permitido
-- (spec §5) e o sistema precisa conseguir REVELAR o caso, não impedi-lo.
create index if not exists whatsapp_instances_org_idx
  on whatsapp_instances (organization_id, lifecycle_state);

create index if not exists whatsapp_instances_due_idx
  on whatsapp_instances (current_cycle_due_on)
  where lifecycle_state in ('ACTIVE', 'CANCELLATION_REQUESTED');

-- =====================================================================
-- Integridade cross-tenant — FK isolada NÃO garante
-- =====================================================================
-- Três FKs para três tabelas não impedem unir a unidade de uma organização com
-- o canal de outra. Sem esta trigger, uma linha coerente com todas as FKs
-- ainda pode misturar tenants. NÃO confiar em validação de frontend.
--
-- whatsapp_channels não tem organization_id: a organização vem por units.
create or replace function public.whatsapp_instance_tenant_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit_org uuid;
  v_chan_org uuid;
  v_chan_unit uuid;
begin
  if new.unit_id is not null then
    select organization_id into v_unit_org from units where id = new.unit_id;
    if v_unit_org is null or v_unit_org <> new.organization_id then
      raise exception 'unit_id pertence a outra organizacao'
        using errcode = 'check_violation';
    end if;
  end if;

  if new.channel_id is not null then
    select u.organization_id, c.unit_id into v_chan_org, v_chan_unit
    from whatsapp_channels c
    join units u on u.id = c.unit_id
    where c.id = new.channel_id;

    if v_chan_org is null or v_chan_org <> new.organization_id then
      raise exception 'channel_id pertence a outra organizacao'
        using errcode = 'check_violation';
    end if;

    if new.unit_id is not null and v_chan_unit is not null and v_chan_unit <> new.unit_id then
      raise exception 'channel_id pertence a outra unidade'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

-- CREATE FUNCTION concede EXECUTE a PUBLIC por padrão e o schema public é
-- exposto ao PostgREST com a anon key. Revogar PUBLIC E os grants diretos
-- (lição do hotfix de ACL, migration 085).
revoke all on function public.whatsapp_instance_tenant_guard() from public, anon, authenticated;

drop trigger if exists whatsapp_instances_tenant_guard on whatsapp_instances;
create trigger whatsapp_instances_tenant_guard
  before insert or update of organization_id, unit_id, channel_id on whatsapp_instances
  for each row execute function public.whatsapp_instance_tenant_guard();

-- =====================================================================
-- RLS
-- =====================================================================
alter table whatsapp_instances enable row level security;
alter table whatsapp_instances force row level security;

drop policy if exists platform_admin_all_whatsapp_instances on whatsapp_instances;
create policy platform_admin_all_whatsapp_instances
  on whatsapp_instances for all
  to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

drop trigger if exists whatsapp_instances_updated_at on whatsapp_instances;
create trigger whatsapp_instances_updated_at
  before update on whatsapp_instances
  for each row execute function update_updated_at();

-- Mesma trilha genérica de customers/reservations/unit_members e da 071.
drop trigger if exists whatsapp_instances_audit on whatsapp_instances;
create trigger whatsapp_instances_audit
  after insert or update or delete on whatsapp_instances
  for each row execute function public.audit_trigger_func();

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. RLS ligada e forçada (esperado: t, t):
--   select relrowsecurity, relforcerowsecurity from pg_class
--    where relname = 'whatsapp_instances';
--
-- 2. Nenhuma coluna com cara de segredo (esperado: 0 linhas):
--   select column_name from information_schema.columns
--    where table_name = 'whatsapp_instances'
--      and column_name ~* 'token|secret|password|senha|api_key|credential';
--
-- 3. ACL da função de guarda (esperado: sem anon= e sem authenticated=):
--   select proacl from pg_proc where proname = 'whatsapp_instance_tenant_guard';
--
-- 4. Guarda cross-tenant funciona (esperado: erro check_violation):
--   insert into whatsapp_instances (organization_id, unit_id, provider, lifecycle_state)
--   values ('<org A>', '<unidade da org B>', 'zapi', 'ACTIVE');
--
-- =====================================================================
-- Rollback — LEIA A ADVERTÊNCIA DA 088 ANTES
-- =====================================================================
-- `drop table whatsapp_instances` DESTRÓI AUDITORIA ADMINISTRATIVA DE FORMA
-- IRREVERSÍVEL, igual às duas tabelas filhas: `current_monthly_cost_cents`,
-- `cost_source`, `cost_note`, `cancellation_reason`, `end_confirmation_note` e
-- `notes` registram DECISÃO HUMANA sobre o que a plataforma paga ao fornecedor,
-- e não têm segunda cópia — o painel da Z-API não reconstrói nenhum deles.
--
-- Esta tabela é o DEGRAU 5 (o último) da sequência. A ordem inversa completa da
-- fase, o rollback operacional não-destrutivo preferencial e o gate de
-- autorização estão publicados na 088 — único lugar onde vivem inteiros. Não
-- executar este bloco isolado: `whatsapp_instance_cycles` e
-- `whatsapp_instance_alerts` referenciam esta tabela e precisam sair antes.
--   drop table if exists whatsapp_instances;   -- ⚠ destrói auditoria
--   drop function if exists public.whatsapp_instance_tenant_guard();
