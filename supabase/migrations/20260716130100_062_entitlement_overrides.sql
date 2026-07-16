-- Overrides de entitlement POR FUNCIONALIDADE (system | whatsapp | ai).
-- Fase 1 da migração billing Stripe→Asaas (docs/billing-asaas/01-PLANO-IMPLEMENTACAO.md).
--
-- Substitui gradualmente billing_access_overrides (que é org-inteira, 3 tipos).
-- A tabela antiga NÃO é removida — continua alimentando o fluxo legado até a
-- migração semântica na Fase 9.
--
-- Semântica:
--   enabled=true  → concede acesso à feature (cortesia/vitalício/promo)
--   enabled=false → bloqueio administrativo EXPLÍCITO da feature (prioridade
--                   máxima no resolver — vence assinatura paga e trial)
--   revoked_at    → override desativado (nunca deletar; trilha de auditoria)
--   ends_at null  → sem expiração (LIFETIME)
--
-- Prioridade de acesso (documentada e testada em entitlements-core.ts):
--   1. bloqueio admin explícito  2. override ativo  3. assinatura paga
--   4. trial  5. sem acesso.
-- Webhooks financeiros NUNCA escrevem nesta tabela (invariante — só admin).
--
-- RLS: ENABLE + FORCE. Escrita/leitura direta exclusiva de platform_admin
-- (policy); Edge Functions service_role bypassam (BYPASSRLS). Membros da org
-- enxergam o RESULTADO via resolver em EF, nunca a tabela crua. Não há trigger
-- force-tenant: tenant jamais escreve a própria linha aqui.

begin;

create table if not exists organization_entitlement_overrides (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  feature text not null check (feature in ('system', 'whatsapp', 'ai')),
  enabled boolean not null default true,
  grant_type text not null check (grant_type in ('LIFETIME', 'TEMPORARY', 'PROMOTIONAL', 'MANUAL_OVERRIDE')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  reason text not null,
  granted_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id)
);

comment on table organization_entitlement_overrides is
  'Cortesias/bloqueios administrativos por feature (system/whatsapp/ai). enabled=false = bloqueio explícito (prioridade 1). Nunca escrito por webhook financeiro. Resolver: _shared/entitlements.ts.';

create index if not exists org_entitlement_overrides_org_idx
  on organization_entitlement_overrides (organization_id);

create index if not exists org_entitlement_overrides_active_idx
  on organization_entitlement_overrides (organization_id, feature)
  where revoked_at is null;

alter table organization_entitlement_overrides enable row level security;
alter table organization_entitlement_overrides force row level security;

drop policy if exists platform_admin_all_org_entitlement_overrides on organization_entitlement_overrides;
create policy platform_admin_all_org_entitlement_overrides
  on organization_entitlement_overrides
  for all
  to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

-- Trilha de auditoria — mesmo trigger genérico de customers/reservations/unit_members.
-- audit_trigger_func extrai organization_id do row automaticamente.
drop trigger if exists organization_entitlement_overrides_audit on organization_entitlement_overrides;
create trigger organization_entitlement_overrides_audit
  after insert or update or delete on organization_entitlement_overrides
  for each row execute function public.audit_trigger_func();

-- ---------------------------------------------------------------------
-- Seed: cortesia vitalícia para as 2 orgs fundadoras (decisão do admin,
-- 2026-07-16): Moralles e Ren Sushi operam gratuitamente (system+whatsapp+ai;
-- a IA delas permanece BYOK — sem carteira/débito). Sem estas linhas, o
-- enforcement da Fase 4 bloquearia as duas orgs reais (risco R2 da auditoria).
-- Idempotente; no-op em ambientes sem essas orgs ou sem platform_admin.
-- ---------------------------------------------------------------------

insert into organization_entitlement_overrides
  (organization_id, feature, enabled, grant_type, reason, granted_by)
select
  o.id,
  f.feature,
  true,
  'LIFETIME',
  'Cortesia vitalícia — cliente fundador (decisão admin 2026-07-16, Fase 1 billing-asaas)',
  (select user_id from platform_admins limit 1)
from organizations o
cross join (values ('system'), ('whatsapp'), ('ai')) as f(feature)
where o.name in ('Moralles', 'Ren Sushi')
  and exists (select 1 from platform_admins)
  and not exists (
    select 1
    from organization_entitlement_overrides x
    where x.organization_id = o.id
      and x.feature = f.feature
      and x.revoked_at is null
  );

commit;
