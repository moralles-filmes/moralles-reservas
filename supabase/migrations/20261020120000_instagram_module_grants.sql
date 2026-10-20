-- Instagram, Fase 1 (Task 1.1): liberação do módulo por unidade e as
-- configurações do Direct.
--
-- Spec:  docs/superpowers/specs/2026-10-19-instagram-modulo-design.md
-- Plano: docs/superpowers/plans/2026-10-20-instagram-fase-1-direct-conversas.md
--        (Task 1.1; desvios S2 e S3)
-- Pré-voo: supabase/tests/local-preflight/79a-instagram-bootstrap.sql e
--          79-instagram-module.sql (README, seção "79 — Módulo Instagram").
--
-- O que nasce aqui:
--   * `unit_module_grants`: liberação de módulo pago por unidade, gravada só
--     pelo platform_admin pela RPC `set_unit_module_grant` (desvio S2: RPC
--     SECURITY DEFINER com a guarda no corpo, não Edge Function). Um grant
--     ativo por (unidade, módulo). FORCE RLS sem policy: o painel lê pela RPC
--     `get_unit_modules`, e o webhook/worker pelo `service_role`.
--   * `instagram_settings`: interruptores do módulo por unidade. Nesta fase só
--     `dm_enabled` (desvio S3). Leitura por membro ou platform_admin; escrita
--     de `dm_enabled` por owner/gerente ou platform_admin. A linha nasce na
--     concessão; `authenticated` não insere nem apaga.
--
-- Revogar o grant NÃO apaga `instagram_settings`: o gate do webhook lê o grant
-- ativo E `dm_enabled`, então revogar já desliga a ingestão, e uma nova
-- concessão volta com a escolha que a loja tinha feito.
--
-- Idempotente: `create table/index if not exists`, `create or replace
-- function`, `drop trigger/policy if exists` + `create`, e os `revoke`/`grant`
-- reafirmados. Sem URL do projeto e sem segredo.

begin;

-- ============================================================================
-- 1. unit_module_grants
-- ============================================================================
-- `granted_by`/`revoked_by` sem FK, como na liberação Datafy (20261014120000):
-- são registro histórico, e `on delete set null` num lado do CHECK de par
-- abortaria o DELETE do usuário.
create table if not exists public.unit_module_grants (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  unit_id         uuid        not null references public.units(id) on delete cascade,
  module          text        not null
    constraint unit_module_grants_module_chk check (module in ('instagram')),
  granted_by      uuid        not null,
  granted_at      timestamptz not null default now(),
  revoked_by      uuid,
  revoked_at      timestamptz,
  constraint unit_module_grants_revoked_pair_chk
    check ((revoked_at is null) = (revoked_by is null))
);

comment on table public.unit_module_grants is
  'Liberacao de modulo pago por unidade (hoje so instagram). Gravada so por set_unit_module_grant (platform_admin); lida pelo painel via get_unit_modules e pelo service_role. FORCE RLS sem policies.';

-- Um grant ativo por (unidade, módulo); o histórico de revogados fica.
create unique index if not exists unit_module_grants_one_active_idx
  on public.unit_module_grants (unit_id, module)
  where revoked_at is null;

-- FK sem índice dispara o advisor (lint 0001); o parcial acima não cobre.
create index if not exists unit_module_grants_unit_idx
  on public.unit_module_grants (unit_id);
create index if not exists unit_module_grants_org_idx
  on public.unit_module_grants (organization_id);

-- ============================================================================
-- 2. instagram_settings
-- ============================================================================
create table if not exists public.instagram_settings (
  unit_id         uuid        primary key references public.units(id) on delete cascade,
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  dm_enabled      boolean     not null default false,
  updated_by      uuid,
  updated_at      timestamptz not null default now()
);

comment on table public.instagram_settings is
  'Interruptores do modulo Instagram por unidade. A linha nasce na concessao do modulo (set_unit_module_grant). Membro le; owner/gerente ou platform_admin mudam dm_enabled.';

create index if not exists instagram_settings_org_idx
  on public.instagram_settings (organization_id);

-- ============================================================================
-- 3. RLS e ACL de tabela
-- ============================================================================
-- O `revoke` inclui `service_role` para tirar TRUNCATE/REFERENCES/TRIGGER que
-- os default privileges do Supabase dão; o CRUD é reconcedido explicitamente.
alter table public.unit_module_grants enable row level security;
alter table public.unit_module_grants force row level security;
alter table public.instagram_settings enable row level security;
alter table public.instagram_settings force row level security;

revoke all on table public.unit_module_grants from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.unit_module_grants to service_role;

-- `authenticated`: SELECT e UPDATE só da coluna `dm_enabled`. Sem INSERT
-- (a linha nasce na concessão) e sem DELETE.
revoke all on table public.instagram_settings from public, anon, authenticated, service_role;
grant select on table public.instagram_settings to authenticated;
grant update (dm_enabled) on table public.instagram_settings to authenticated;
grant select, insert, update, delete on table public.instagram_settings to service_role;

drop policy if exists instagram_settings_select on public.instagram_settings;
create policy instagram_settings_select on public.instagram_settings
  for select to authenticated
  using (
    app_private.is_unit_member(auth.uid(), unit_id)
    or app_private.is_platform_admin(auth.uid())
  );

-- Operador é membro, mas não escreve: o UPDATE dele casa zero linhas.
drop policy if exists instagram_settings_update on public.instagram_settings;
create policy instagram_settings_update on public.instagram_settings
  for update to authenticated
  using (
    exists (
      select 1 from public.unit_members um
       where um.unit_id = instagram_settings.unit_id
         and um.user_id = auth.uid()
         and um.role in ('owner', 'gerente')
    )
    or app_private.is_platform_admin(auth.uid())
  )
  with check (
    exists (
      select 1 from public.unit_members um
       where um.unit_id = instagram_settings.unit_id
         and um.user_id = auth.uid()
         and um.role in ('owner', 'gerente')
    )
    or app_private.is_platform_admin(auth.uid())
  );

-- ============================================================================
-- 4. Triggers: coerência de tenant, carimbo e auditoria
-- ============================================================================
-- Coerência organização × unidade (padrão `whatsapp_official_connection_grants_guard`).
-- SECURITY INVOKER: quem grava é a RPC (dona `postgres`) ou o `service_role`.
-- Nas duas tabelas confere a coerência no INSERT; em `unit_module_grants`
-- também torna unidade e organização imutáveis. Em `instagram_settings` a
-- imutabilidade fica no trigger de carimbo abaixo.
create or replace function public.unit_module_tenant_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_unit_org uuid;
begin
  if tg_op = 'UPDATE'
     and (new.organization_id is distinct from old.organization_id
          or new.unit_id is distinct from old.unit_id) then
    raise exception '%: organizacao e unidade sao imutaveis', tg_table_name
      using errcode = 'check_violation';
  end if;

  select u.organization_id into v_unit_org from public.units u where u.id = new.unit_id;

  if v_unit_org is null then
    raise exception '%: unidade % inexistente', tg_table_name, new.unit_id
      using errcode = 'check_violation';
  end if;

  if new.organization_id is distinct from v_unit_org then
    raise exception '%: organizacao % nao e a da unidade %', tg_table_name, new.organization_id, new.unit_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists unit_module_grants_tenant_guard_trg on public.unit_module_grants;
create trigger unit_module_grants_tenant_guard_trg
  before insert or update of organization_id, unit_id on public.unit_module_grants
  for each row execute function public.unit_module_tenant_guard();

drop trigger if exists instagram_settings_tenant_guard_trg on public.instagram_settings;
create trigger instagram_settings_tenant_guard_trg
  before insert on public.instagram_settings
  for each row execute function public.unit_module_tenant_guard();

-- Carimbo de quem mudou e quando, e unidade/organização congeladas. O ator
-- vem da sessão (`auth.uid()`); `service_role` sem `sub` grava NULL.
create or replace function public.instagram_settings_touch()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.unit_id is distinct from old.unit_id
     or new.organization_id is distinct from old.organization_id then
    raise exception 'instagram_settings: unidade e organizacao sao imutaveis (unidade %)', old.unit_id
      using errcode = 'check_violation';
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists instagram_settings_touch_trg on public.instagram_settings;
create trigger instagram_settings_touch_trg
  before update on public.instagram_settings
  for each row execute function public.instagram_settings_touch();

-- Auditoria: mesmo trigger genérico de `organization_entitlement_overrides`.
-- A tabela NÃO entra na allowlist de membro de `audit_log`
-- (20261016181000): só o platform_admin lê essas linhas.
drop trigger if exists unit_module_grants_audit on public.unit_module_grants;
create trigger unit_module_grants_audit
  after insert or update or delete on public.unit_module_grants
  for each row execute function public.audit_trigger_func();

-- ============================================================================
-- 5. RPCs
-- ============================================================================
-- Concessão/revogação. Só platform_admin; o ator é `auth.uid()`, nunca
-- parâmetro; a organização sai de `units`. Idempotente nos dois sentidos:
-- conceder o que já está ativo devolve o grant existente, e revogar o que não
-- está ativo devolve o último estado sem gravar nada. A recusa vem antes de
-- qualquer leitura da unidade, então não é oráculo de existência.
create or replace function public.set_unit_module_grant(p_unit_id uuid, p_module text, p_active boolean)
returns table(module text, active boolean, granted_at timestamptz, revoked_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_org uuid;
begin
  if v_uid is null or not app_private.is_platform_admin(v_uid) then
    raise exception 'module_grant_forbidden' using errcode = '42501';
  end if;

  if p_unit_id is null or p_active is null or p_module is null or p_module not in ('instagram') then
    raise exception 'module_grant_invalid_argument' using errcode = '22023';
  end if;

  select u.organization_id into v_org from public.units u where u.id = p_unit_id;
  if v_org is null then
    raise exception 'module_grant_unit_not_found' using errcode = '22023';
  end if;

  if p_active then
    -- O índice único parcial absorve o clique duplo e a corrida.
    insert into public.unit_module_grants (organization_id, unit_id, module, granted_by)
    values (v_org, p_unit_id, p_module, v_uid)
    on conflict do nothing;

    if p_module = 'instagram' then
      insert into public.instagram_settings (unit_id, organization_id)
      values (p_unit_id, v_org)
      on conflict (unit_id) do nothing;
    end if;
  else
    update public.unit_module_grants g
       set revoked_at = now(), revoked_by = v_uid
     where g.unit_id = p_unit_id
       and g.module = p_module
       and g.revoked_at is null;
  end if;

  -- Estado resultante: o grant ativo, senão o último revogado, senão nada.
  return query
    select p_module,
           g.revoked_at is null,
           g.granted_at,
           g.revoked_at
      from public.unit_module_grants g
     where g.unit_id = p_unit_id and g.module = p_module
     order by (g.revoked_at is null) desc, g.granted_at desc, g.id desc
     limit 1;
  if not found then
    return query select p_module, false, null::timestamptz, null::timestamptz;
  end if;
end;
$$;

-- Leitura para o painel: uma linha por módulo do catálogo (o mesmo do CHECK
-- de `unit_module_grants.module`), ativo ou não. Membro da unidade ou
-- platform_admin; unidade alheia e inexistente caem na mesma recusa.
create or replace function public.get_unit_modules(p_unit_id uuid)
returns table(module text, active boolean, granted_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_unit_id is null
     or not (app_private.is_unit_member(v_uid, p_unit_id) or app_private.is_platform_admin(v_uid)) then
    raise exception 'module_read_forbidden' using errcode = '42501';
  end if;

  return query
    select c.module,
           g.id is not null,
           g.granted_at
      from unnest(array['instagram']::text[]) as c(module)
      left join public.unit_module_grants g
        on g.unit_id = p_unit_id and g.module = c.module and g.revoked_at is null
     order by c.module;
end;
$$;

-- ============================================================================
-- 6. ACL das funções (assinatura completa)
-- ============================================================================
revoke all on function public.set_unit_module_grant(uuid, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_unit_module_grant(uuid, text, boolean) to authenticated;
revoke all on function public.get_unit_modules(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_unit_modules(uuid) to authenticated;
revoke all on function public.unit_module_tenant_guard() from public, anon, authenticated, service_role;
revoke all on function public.instagram_settings_touch() from public, anon, authenticated, service_role;

commit;

-- Validação pós-migration (somente leitura):
--   select proname, proacl from pg_proc
--    where proname in ('set_unit_module_grant', 'get_unit_modules',
--                      'unit_module_tenant_guard', 'instagram_settings_touch');
--   select relname, relrowsecurity, relforcerowsecurity, relacl from pg_class
--    where relname in ('unit_module_grants', 'instagram_settings');
--
-- ROLLBACK (só se nada consumir as tabelas ainda; apaga as liberações):
--   drop function if exists public.get_unit_modules(uuid);
--   drop function if exists public.set_unit_module_grant(uuid, text, boolean);
--   drop table if exists public.instagram_settings;
--   drop table if exists public.unit_module_grants;
--   drop function if exists public.instagram_settings_touch();
--   drop function if exists public.unit_module_tenant_guard();
