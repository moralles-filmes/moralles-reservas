-- Instagram, Fase 1 (Task 1.2): conta com token no Vault, contato do Direct,
-- ledger contato × reserva e anonimização LGPD do contato.
--
-- Spec:  docs/superpowers/specs/2026-10-19-instagram-modulo-design.md
-- Plano: docs/superpowers/plans/2026-10-20-instagram-fase-1-direct-conversas.md
--        (Task 1.2)
-- Pré-voo: supabase/tests/local-preflight/79a-instagram-bootstrap.sql e
--          79-instagram-module.sql (README, seção "79 — Módulo Instagram"),
--          casos IG-2.1..IG-2.6 e controles C-IG-2.1..C-IG-2.6.
--
-- O que nasce aqui:
--   * `instagram_accounts`: a conta profissional ligada a UMA unidade. O token
--     longo fica no Vault (`token_secret_id`); a linha guarda só o ponteiro.
--     FORCE RLS sem policy: o painel lê pela RPC `get_instagram_account_status`
--     (projeção sem token), e as EFs pelo `service_role`. Uma conta ativa por
--     `ig_user_id` e uma por unidade (índices únicos parciais).
--   * RPCs só `service_role` de conexão, leitura do token, assinatura do
--     webhook, renovação, troca de status e desconexão.
--   * `instagram_contacts`: o interlocutor do Direct (IGSID por conta). Membro
--     da unidade ou platform_admin lê; ninguém além do `service_role` escreve.
--   * `instagram_contact_reservations`: que reserva nasceu de qual contato.
--     FORCE RLS sem policy; gravado só por `record_instagram_contact_reservation`.
--   * Trigger em `customers`: o soft delete LGPD (`deleted_at`) apaga IGSID,
--     username e nome dos contatos do cliente (padrão da 115).
--
-- Tenant: a unidade e a organização do contato saem da CONTA, e a do ledger
-- sai da reserva conferida contra o contato. Nenhuma RPC aceita `unit_id`
-- para escopar um recurso que já tem dono.
--
-- Idempotente: `create table/index if not exists`, `create or replace
-- function`, `drop trigger/policy if exists` + `create`, e os `revoke`/`grant`
-- reafirmados. Sem URL do projeto e sem segredo.

begin;

-- ============================================================================
-- 1. instagram_accounts
-- ============================================================================
-- `connected_by`/`disconnected_by` sem FK: registro histórico, como
-- `granted_by` na 20261020120000. As RPCs rodam como `service_role` (sem
-- `sub`), então o `actor_id` do audit_log sai nulo: quem conectou e quem
-- desconectou ficam nessas duas colunas, que o audit_log copia em new_values.
-- `ig_user_id` é o id numérico da conta no Instagram, gravado sem espaços.
create table if not exists public.instagram_accounts (
  id                 uuid        primary key default gen_random_uuid(),
  organization_id    uuid        not null references public.organizations(id) on delete cascade,
  unit_id            uuid        not null references public.units(id) on delete cascade,
  ig_user_id         text        not null
    constraint instagram_accounts_ig_user_id_chk check (ig_user_id ~ '^[0-9]+$'),
  username           text,
  account_type       text,
  status             text        not null default 'connected'
    constraint instagram_accounts_status_chk
      check (status in ('connected', 'reauth_required', 'disconnected')),
  token_secret_id    uuid        references vault.secrets(id) on delete set null,
  token_expires_at   timestamptz,
  token_refreshed_at timestamptz,
  subscribed_fields  text[]      not null default '{}',
  last_error_code    text,
  connected_by       uuid        not null,
  connected_at       timestamptz not null default now(),
  disconnected_at    timestamptz,
  disconnected_by    uuid,
  updated_at         timestamptz not null default now()
);

comment on table public.instagram_accounts is
  'Conta profissional do Instagram ligada a uma unidade. Token no Vault (token_secret_id), nunca na linha. Gravada so pelas RPCs service_role; o painel le get_instagram_account_status. FORCE RLS sem policies.';

-- Uma conta ativa por ig_user_id (a mesma conta não serve duas unidades) e
-- uma conta ativa por unidade. As desconectadas ficam como histórico.
create unique index if not exists instagram_accounts_ig_user_active_idx
  on public.instagram_accounts (ig_user_id)
  where status <> 'disconnected';
create unique index if not exists instagram_accounts_unit_active_idx
  on public.instagram_accounts (unit_id)
  where status <> 'disconnected';

-- FKs sem índice disparam o advisor (lint 0001); os parciais não cobrem.
create index if not exists instagram_accounts_unit_idx
  on public.instagram_accounts (unit_id);
create index if not exists instagram_accounts_org_idx
  on public.instagram_accounts (organization_id);
create index if not exists instagram_accounts_token_secret_idx
  on public.instagram_accounts (token_secret_id);

-- Coerência organização × unidade e vínculo imutável: o mesmo guard da
-- 20261020120000 (genérico por `tg_table_name`).
drop trigger if exists instagram_accounts_tenant_guard_trg on public.instagram_accounts;
create trigger instagram_accounts_tenant_guard_trg
  before insert or update of organization_id, unit_id on public.instagram_accounts
  for each row execute function public.unit_module_tenant_guard();

-- Trilha de conexão/reconexão/desconexão: o mesmo trigger genérico de
-- `unit_module_grants`. A tabela NÃO entra na allowlist de membro do
-- audit_log (20261016181000): só o platform_admin lê essas linhas. O que vai
-- para old/new_values é o ponteiro do Vault (uuid), nunca o token.
drop trigger if exists instagram_accounts_audit on public.instagram_accounts;
create trigger instagram_accounts_audit
  after insert or update or delete on public.instagram_accounts
  for each row execute function public.audit_trigger_func();

-- ============================================================================
-- 2. instagram_contacts
-- ============================================================================
-- `igsid` nulo só depois da anonimização, e só então: o CHECK amarra os dois.
-- `unique (instagram_account_id, igsid)`: o IGSID é escopado pela conta, e os
-- nulos dos anonimizados não colidem entre si.
create table if not exists public.instagram_contacts (
  id                   uuid        primary key default gen_random_uuid(),
  organization_id      uuid        not null references public.organizations(id) on delete cascade,
  unit_id              uuid        not null references public.units(id) on delete cascade,
  instagram_account_id uuid        not null references public.instagram_accounts(id) on delete restrict,
  igsid                text,
  username             text,
  name                 text,
  customer_id          uuid        references public.customers(id) on delete set null,
  customer_linked_at   timestamptz,
  anonymized_at        timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint instagram_contacts_anonymized_igsid_chk
    check ((anonymized_at is null) = (igsid is not null)),
  constraint instagram_contacts_account_igsid_key
    unique (instagram_account_id, igsid)
);

comment on table public.instagram_contacts is
  'Interlocutor do Direct (IGSID por conta). Unidade e organizacao vem da conta; cliente, se houver, e da mesma organizacao. Membro da unidade ou platform_admin le; so service_role escreve. Anonimizado junto com o cliente (trigger em customers).';

create index if not exists instagram_contacts_unit_idx
  on public.instagram_contacts (unit_id);
create index if not exists instagram_contacts_org_idx
  on public.instagram_contacts (organization_id);
create index if not exists instagram_contacts_customer_idx
  on public.instagram_contacts (customer_id);

-- Guarda de coerência do contato. SECURITY INVOKER: quem grava é RPC dona
-- `postgres`, o `service_role` ou o trigger de anonimização (DEFINER).
create or replace function public.instagram_contact_tenant_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_acc_unit uuid;
  v_acc_org  uuid;
  v_cust_org uuid;
begin
  if tg_op = 'UPDATE'
     and (new.instagram_account_id is distinct from old.instagram_account_id
          or new.unit_id is distinct from old.unit_id
          or new.organization_id is distinct from old.organization_id) then
    raise exception 'instagram_contacts: conta, unidade e organizacao sao imutaveis'
      using errcode = 'check_violation';
  end if;

  select a.unit_id, a.organization_id into v_acc_unit, v_acc_org
    from public.instagram_accounts a where a.id = new.instagram_account_id;

  if v_acc_unit is null then
    raise exception 'instagram_contacts: conta % inexistente', new.instagram_account_id
      using errcode = 'check_violation';
  end if;

  if new.unit_id is distinct from v_acc_unit or new.organization_id is distinct from v_acc_org then
    raise exception 'instagram_contacts: unidade/organizacao do contato nao sao as da conta %', new.instagram_account_id
      using errcode = 'check_violation';
  end if;

  if new.customer_id is not null then
    select c.organization_id into v_cust_org from public.customers c where c.id = new.customer_id;
    if v_cust_org is distinct from new.organization_id then
      raise exception 'instagram_contacts: cliente % nao e da organizacao do contato', new.customer_id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists instagram_contacts_tenant_guard_trg on public.instagram_contacts;
create trigger instagram_contacts_tenant_guard_trg
  before insert or update of instagram_account_id, unit_id, organization_id, customer_id
  on public.instagram_contacts
  for each row execute function public.instagram_contact_tenant_guard();

-- ============================================================================
-- 3. instagram_contact_reservations
-- ============================================================================
create table if not exists public.instagram_contact_reservations (
  reservation_id       uuid        primary key references public.reservations(id) on delete cascade,
  instagram_contact_id uuid        not null references public.instagram_contacts(id) on delete cascade,
  unit_id              uuid        not null references public.units(id) on delete cascade,
  created_at           timestamptz not null default now()
);

comment on table public.instagram_contact_reservations is
  'Reserva nascida de um contato do Instagram. Gravada so por record_instagram_contact_reservation (service_role), com unidade e cliente conferidos. FORCE RLS sem policies.';

create index if not exists instagram_contact_reservations_contact_idx
  on public.instagram_contact_reservations (instagram_contact_id);
create index if not exists instagram_contact_reservations_unit_idx
  on public.instagram_contact_reservations (unit_id);

-- ============================================================================
-- 4. RLS e ACL de tabela
-- ============================================================================
-- O `revoke` inclui `service_role` para tirar o que os default privileges do
-- Supabase dão. Contas e ledger: `service_role` só LÊ (o webhook e o worker de
-- renovação listam contas; a escrita é só pelas RPCs DEFINER, que conferem
-- tenant, Vault e transições). Contatos: CRUD para `service_role`.
alter table public.instagram_accounts enable row level security;
alter table public.instagram_accounts force row level security;
alter table public.instagram_contacts enable row level security;
alter table public.instagram_contacts force row level security;
alter table public.instagram_contact_reservations enable row level security;
alter table public.instagram_contact_reservations force row level security;

revoke all on table public.instagram_accounts from public, anon, authenticated, service_role;
grant select on table public.instagram_accounts to service_role;

revoke all on table public.instagram_contacts from public, anon, authenticated, service_role;
grant select on table public.instagram_contacts to authenticated;
grant select, insert, update, delete on table public.instagram_contacts to service_role;

revoke all on table public.instagram_contact_reservations from public, anon, authenticated, service_role;
grant select on table public.instagram_contact_reservations to service_role;

drop policy if exists instagram_contacts_select on public.instagram_contacts;
create policy instagram_contacts_select on public.instagram_contacts
  for select to authenticated
  using (
    app_private.is_unit_member(auth.uid(), unit_id)
    or app_private.is_platform_admin(auth.uid())
  );

-- ============================================================================
-- 5. RPCs da conta (service_role)
-- ============================================================================
-- Ponteiro do Vault preso ao nome. Toda RPC que lê ou grava o segredo exige
-- que `token_secret_id` aponte para o segredo `instagram-account-<id>-token`
-- desta conta; ponteiro para outro segredo (p.ex. `internal_api_key`) é
-- recusado com 42501 `instagram_account_secret_mismatch`, sem decifrar nem
-- gravar nada. Sem ponteiro, o segredo é procurado pelo nome.

-- Desconexão: o segredo no Vault é SOBRESCRITO com valor aleatório (não
-- apagado: a FK `on delete set null` e o nome estável deixam a reconexão
-- reaproveitar a mesma entrada), o ponteiro é zerado, a linha vira
-- `disconnected` e `disconnected_by` guarda o ator. Repetir é no-op que
-- reafirma a sobrescrita e preserva quem e quando desconectou primeiro.
create or replace function public.disconnect_instagram_account(p_account_id uuid, p_actor uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_acc       record;
  v_secret_id uuid;
  v_name      text;
begin
  if p_account_id is null or p_actor is null then
    raise exception 'invalid_instagram_account_argument' using errcode = '22023';
  end if;

  select a.id, a.token_secret_id into v_acc
    from public.instagram_accounts a where a.id = p_account_id
    for update;
  if not found then
    raise exception 'instagram_account_not_found' using errcode = 'P0002';
  end if;

  v_name := 'instagram-account-' || p_account_id::text || '-token';
  if v_acc.token_secret_id is not null then
    select s.id into v_secret_id from vault.secrets s
     where s.id = v_acc.token_secret_id and s.name = v_name;
    if v_secret_id is null then
      raise exception 'instagram_account_secret_mismatch' using errcode = '42501';
    end if;
  else
    select s.id into v_secret_id from vault.secrets s where s.name = v_name limit 1;
  end if;
  if v_secret_id is not null then
    perform vault.update_secret(v_secret_id, 'revoked-' || gen_random_uuid()::text || gen_random_uuid()::text);
  end if;

  update public.instagram_accounts a
     set token_secret_id = null,
         status = 'disconnected',
         disconnected_at = coalesce(a.disconnected_at, now()),
         disconnected_by = case when a.disconnected_at is null then p_actor else a.disconnected_by end,
         updated_at = now()
   where a.id = p_account_id;
end;
$$;

-- Conexão. `ig_user_id` e token entram sem espaços nas pontas, e o
-- `ig_user_id` é só dígitos. Serializa por `ig_user_id` e depois por unidade
-- (ordem fixa, sem ciclo). A conta ativa noutra unidade é recusada; outra
-- conta ativa na mesma unidade é desconectada antes; a mesma conta na mesma
-- unidade (ativa ou desconectada) reaproveita a linha, o que mantém os
-- contatos e o segredo. A organização sai de `units`.
create or replace function public.store_instagram_account_connection(
  p_unit_id      uuid,
  p_ig_user_id   text,
  p_username     text,
  p_account_type text,
  p_token        text,
  p_expires_at   timestamptz,
  p_actor        uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org       uuid;
  v_other     record;
  v_row       record;
  v_id        uuid;
  v_secret_id uuid;
  v_name      text;
begin
  p_ig_user_id := btrim(p_ig_user_id);
  p_token := btrim(p_token);

  if p_unit_id is null or p_actor is null
     or p_ig_user_id is null or p_ig_user_id !~ '^[0-9]{1,64}$' then
    raise exception 'invalid_instagram_account_argument' using errcode = '22023';
  end if;
  if p_token is null or length(p_token) < 8 or length(p_token) > 4096 then
    raise exception 'invalid_instagram_token' using errcode = '22023';
  end if;

  select u.organization_id into v_org from public.units u where u.id = p_unit_id;
  if v_org is null then
    raise exception 'instagram_unit_not_found' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('instagram_account_ig:' || p_ig_user_id, 0));
  perform pg_advisory_xact_lock(hashtextextended('instagram_account_unit:' || p_unit_id::text, 0));

  if exists (
    select 1 from public.instagram_accounts a
     where a.ig_user_id = p_ig_user_id
       and a.status <> 'disconnected'
       and a.unit_id <> p_unit_id
  ) then
    raise exception 'instagram_account_in_use' using errcode = 'P0001';
  end if;

  for v_other in
    select a.id from public.instagram_accounts a
     where a.unit_id = p_unit_id
       and a.status <> 'disconnected'
       and a.ig_user_id <> p_ig_user_id
     for update
  loop
    perform public.disconnect_instagram_account(v_other.id, p_actor);
  end loop;

  select a.id, a.status, a.token_secret_id into v_row
    from public.instagram_accounts a
   where a.unit_id = p_unit_id and a.ig_user_id = p_ig_user_id
   order by (a.status <> 'disconnected') desc, a.updated_at desc, a.id desc
   limit 1
   for update;

  if found then
    v_id := v_row.id;
    update public.instagram_accounts a
       set username = p_username,
           account_type = p_account_type,
           status = 'connected',
           token_expires_at = p_expires_at,
           token_refreshed_at = null,
           subscribed_fields = case when v_row.status = 'disconnected' then '{}'::text[] else a.subscribed_fields end,
           last_error_code = null,
           connected_by = p_actor,
           connected_at = now(),
           disconnected_at = null,
           disconnected_by = null,
           updated_at = now()
     where a.id = v_id;
  else
    insert into public.instagram_accounts (
      organization_id, unit_id, ig_user_id, username, account_type, status,
      token_expires_at, connected_by
    ) values (
      v_org, p_unit_id, p_ig_user_id, p_username, p_account_type, 'connected',
      p_expires_at, p_actor
    )
    returning id into v_id;
  end if;

  v_name := 'instagram-account-' || v_id::text || '-token';
  if v_row.token_secret_id is not null then
    select s.id into v_secret_id from vault.secrets s
     where s.id = v_row.token_secret_id and s.name = v_name;
    if v_secret_id is null then
      raise exception 'instagram_account_secret_mismatch' using errcode = '42501';
    end if;
  else
    select s.id into v_secret_id from vault.secrets s where s.name = v_name limit 1;
  end if;

  if v_secret_id is not null then
    perform vault.update_secret(
      v_secret_id,
      p_token,
      v_name,
      'Instagram account token for internal account UUID'
    );
  else
    select vault.create_secret(
      p_token,
      v_name,
      'Instagram account token for internal account UUID'
    ) into v_secret_id;
  end if;

  update public.instagram_accounts a
     set token_secret_id = v_secret_id
   where a.id = v_id;

  return v_id;
end;
$$;

-- Token para a EF. Sem ponteiro (desconectada) ou sem segredo: P0002.
-- Ponteiro para segredo de outro nome: 42501, sem decifrar.
create or replace function public.get_instagram_account_token(p_account_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ptr       uuid;
  v_name      text;
  v_secret_id uuid;
  v_token     text;
begin
  select a.token_secret_id into v_ptr from public.instagram_accounts a where a.id = p_account_id;
  if v_ptr is null then
    raise exception 'instagram_account_token_not_found' using errcode = 'P0002';
  end if;

  v_name := 'instagram-account-' || p_account_id::text || '-token';
  if v_ptr is not null then
    select s.id into v_secret_id from vault.secrets s
     where s.id = v_ptr and s.name = v_name;
    if v_secret_id is null then
      raise exception 'instagram_account_secret_mismatch' using errcode = '42501';
    end if;
  end if;

  select ds.decrypted_secret into v_token from vault.decrypted_secrets ds where ds.id = v_secret_id;
  if v_token is null then
    raise exception 'instagram_account_token_not_found' using errcode = 'P0002';
  end if;

  return v_token;
end;
$$;

-- Campos assinados no webhook da conta (`subscribed_apps`).
create or replace function public.record_instagram_account_subscription(p_account_id uuid, p_fields text[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select a.status into v_status from public.instagram_accounts a where a.id = p_account_id for update;
  if v_status is null then
    raise exception 'instagram_account_not_found' using errcode = 'P0002';
  end if;
  if v_status = 'disconnected' then
    raise exception 'instagram_account_not_active' using errcode = '55000';
  end if;

  update public.instagram_accounts a
     set subscribed_fields = coalesce(
           (select array_agg(distinct f order by f) from unnest(p_fields) as f where f is not null),
           '{}'::text[]),
         updated_at = now()
   where a.id = p_account_id;
end;
$$;

-- Renovação do token longo: troca o valor no MESMO segredo (preso ao nome) e
-- carimba `token_refreshed_at`. Não muda o status.
create or replace function public.record_instagram_token_refresh(p_account_id uuid, p_token text, p_expires_at timestamptz)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_acc       record;
  v_name      text;
  v_secret_id uuid;
begin
  p_token := btrim(p_token);
  if p_token is null or length(p_token) < 8 or length(p_token) > 4096 then
    raise exception 'invalid_instagram_token' using errcode = '22023';
  end if;

  select a.id, a.status, a.token_secret_id into v_acc
    from public.instagram_accounts a where a.id = p_account_id
    for update;
  if not found then
    raise exception 'instagram_account_not_found' using errcode = 'P0002';
  end if;
  if v_acc.status = 'disconnected' or v_acc.token_secret_id is null then
    raise exception 'instagram_account_not_active' using errcode = '55000';
  end if;

  v_name := 'instagram-account-' || p_account_id::text || '-token';
  if v_acc.token_secret_id is not null then
    select s.id into v_secret_id from vault.secrets s
     where s.id = v_acc.token_secret_id and s.name = v_name;
    if v_secret_id is null then
      raise exception 'instagram_account_secret_mismatch' using errcode = '42501';
    end if;
  end if;

  perform vault.update_secret(
    v_secret_id,
    p_token,
    v_name,
    'Instagram account token for internal account UUID'
  );

  update public.instagram_accounts a
     set token_expires_at = p_expires_at,
         token_refreshed_at = now(),
         updated_at = now()
   where a.id = p_account_id;
end;
$$;

-- Só `connected` <-> `reauth_required`. Desconectar é `disconnect_…`, e
-- reconectar é `store_…` (que traz token novo). Voltar a `connected` limpa
-- `last_error_code`.
create or replace function public.set_instagram_account_status(p_account_id uuid, p_status text, p_error_code text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_status is null or p_status not in ('connected', 'reauth_required') then
    raise exception 'invalid_instagram_account_status' using errcode = '22023';
  end if;

  select a.status into v_status from public.instagram_accounts a where a.id = p_account_id for update;
  if v_status is null then
    raise exception 'instagram_account_not_found' using errcode = 'P0002';
  end if;
  if v_status = 'disconnected' then
    raise exception 'instagram_account_not_active' using errcode = '55000';
  end if;

  update public.instagram_accounts a
     set status = p_status,
         last_error_code = case when p_status = 'connected' then null else p_error_code end,
         updated_at = now()
   where a.id = p_account_id;
end;
$$;

-- ============================================================================
-- 6. Projeção para o painel (authenticated)
-- ============================================================================
-- Membro da unidade ou platform_admin; unidade alheia, inexistente e sessão
-- sem `sub` caem na mesma recusa. Zero linhas sem conta ativa. Nunca devolve
-- token, ponteiro do Vault nem `ig_user_id`.
create or replace function public.get_instagram_account_status(p_unit_id uuid)
returns table(
  username         text,
  status           text,
  token_expires_at timestamptz,
  connected_at     timestamptz,
  subscribed       boolean,
  last_error_code  text
)
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
    raise exception 'instagram_status_forbidden' using errcode = '42501';
  end if;

  return query
    select a.username,
           a.status,
           a.token_expires_at,
           a.connected_at,
           'messages' = any(a.subscribed_fields),
           a.last_error_code
      from public.instagram_accounts a
     where a.unit_id = p_unit_id
       and a.status <> 'disconnected';
end;
$$;

-- ============================================================================
-- 7. Contato e ledger (service_role)
-- ============================================================================
-- Unidade e organização vêm da conta. `username`/`name` só são sobrescritos
-- por valor não nulo (o perfil é best-effort). Contato anonimizado tem
-- `igsid` nulo, então o mesmo IGSID voltando abre um contato novo.
-- Conta desconectada recusa (55000); `reauth_required` aceita, porque
-- mensagens ainda chegam enquanto a loja reautentica.
create or replace function public.upsert_instagram_contact(
  p_account_id uuid,
  p_igsid      text,
  p_username   text,
  p_name       text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_unit   uuid;
  v_org    uuid;
  v_status text;
  v_id     uuid;
begin
  if p_account_id is null or p_igsid is null or length(btrim(p_igsid)) = 0 or length(p_igsid) > 128 then
    raise exception 'invalid_instagram_contact_argument' using errcode = '22023';
  end if;

  select a.unit_id, a.organization_id, a.status into v_unit, v_org, v_status
    from public.instagram_accounts a where a.id = p_account_id
    for share;
  if v_unit is null then
    raise exception 'instagram_account_not_found' using errcode = 'P0002';
  end if;
  if v_status = 'disconnected' then
    raise exception 'instagram_account_not_active' using errcode = '55000';
  end if;

  insert into public.instagram_contacts as c (organization_id, unit_id, instagram_account_id, igsid, username, name)
  values (v_org, v_unit, p_account_id, p_igsid, p_username, p_name)
  on conflict (instagram_account_id, igsid) do update
     set username = coalesce(excluded.username, c.username),
         name = coalesce(excluded.name, c.name),
         updated_at = now()
  returning c.id into v_id;

  return v_id;
end;
$$;

-- Ledger contato × reserva. A reserva tem de ser da unidade do contato E do
-- cliente ligado ao contato; contato sem cliente, contato ou reserva
-- inexistentes caem na mesma recusa. Repetir é no-op.
create or replace function public.record_instagram_contact_reservation(p_contact_id uuid, p_reservation_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c_unit uuid;
  v_c_cust uuid;
  v_r_unit uuid;
  v_r_cust uuid;
begin
  select c.unit_id, c.customer_id into v_c_unit, v_c_cust
    from public.instagram_contacts c where c.id = p_contact_id;
  select r.unit_id, r.customer_id into v_r_unit, v_r_cust
    from public.reservations r where r.id = p_reservation_id;

  if v_c_unit is null or v_r_unit is null
     or v_r_unit is distinct from v_c_unit
     or v_c_cust is null or v_r_cust is distinct from v_c_cust then
    raise exception 'instagram_contact_reservation_forbidden' using errcode = '42501';
  end if;

  insert into public.instagram_contact_reservations (reservation_id, instagram_contact_id, unit_id)
  values (p_reservation_id, p_contact_id, v_r_unit)
  on conflict do nothing;
end;
$$;

-- ============================================================================
-- 8. Anonimização LGPD
-- ============================================================================
-- Mesmo desenho da 115: `anonymize_customer` faz SOFT delete, então o cascade
-- não dispara, e o trigger cobre QUALQUER caminho que marque `deleted_at`.
-- SECURITY DEFINER porque `instagram_contacts` é FORCE RLS e `authenticated`
-- não tem UPDATE: como invoker, o soft delete de um membro pelo PostgREST
-- anonimizaria zero contatos ou derrubaria o próprio soft delete. O dono
-- efetivo precisa de BYPASSRLS (README §79, "O que NÃO prova").
create or replace function public.instagram_contacts_anonymize_on_customer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.instagram_contacts c
     set igsid = null,
         username = null,
         name = null,
         anonymized_at = now(),
         updated_at = now()
   where c.customer_id = new.id
     and c.anonymized_at is null;
  return null;
end;
$$;

drop trigger if exists instagram_contacts_anonymize_on_customer_trg on public.customers;
create trigger instagram_contacts_anonymize_on_customer_trg
  after update of deleted_at on public.customers
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function public.instagram_contacts_anonymize_on_customer();

-- ============================================================================
-- 9. ACL das funções (assinatura completa)
-- ============================================================================
revoke all on function public.disconnect_instagram_account(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.disconnect_instagram_account(uuid, uuid) to service_role;
revoke all on function public.store_instagram_account_connection(uuid, text, text, text, text, timestamptz, uuid) from public, anon, authenticated, service_role;
grant execute on function public.store_instagram_account_connection(uuid, text, text, text, text, timestamptz, uuid) to service_role;
revoke all on function public.get_instagram_account_token(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_instagram_account_token(uuid) to service_role;
revoke all on function public.record_instagram_account_subscription(uuid, text[]) from public, anon, authenticated, service_role;
grant execute on function public.record_instagram_account_subscription(uuid, text[]) to service_role;
revoke all on function public.record_instagram_token_refresh(uuid, text, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.record_instagram_token_refresh(uuid, text, timestamptz) to service_role;
revoke all on function public.set_instagram_account_status(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.set_instagram_account_status(uuid, text, text) to service_role;
revoke all on function public.upsert_instagram_contact(uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.upsert_instagram_contact(uuid, text, text, text) to service_role;
revoke all on function public.record_instagram_contact_reservation(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.record_instagram_contact_reservation(uuid, uuid) to service_role;

revoke all on function public.get_instagram_account_status(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_instagram_account_status(uuid) to authenticated;

revoke all on function public.instagram_contact_tenant_guard() from public, anon, authenticated, service_role;
revoke all on function public.instagram_contacts_anonymize_on_customer() from public, anon, authenticated, service_role;

commit;

-- Validação pós-migration (somente leitura):
--   select proname, proacl from pg_proc where proname like '%instagram%';
--   select relname, relrowsecurity, relforcerowsecurity, relacl from pg_class
--    where relname in ('instagram_accounts', 'instagram_contacts', 'instagram_contact_reservations');
--   select count(*) from pg_policies where tablename in ('instagram_accounts', 'instagram_contact_reservations');  -- 0
--
-- ROLLBACK (só se nada consumir as tabelas ainda; apaga contas e contatos e
-- deixa os segredos `instagram-account-*-token` no Vault para apagar à mão):
--   drop trigger if exists instagram_contacts_anonymize_on_customer_trg on public.customers;
--   drop function if exists public.instagram_contacts_anonymize_on_customer();
--   drop function if exists public.record_instagram_contact_reservation(uuid, uuid);
--   drop function if exists public.upsert_instagram_contact(uuid, text, text, text);
--   drop function if exists public.get_instagram_account_status(uuid);
--   drop function if exists public.set_instagram_account_status(uuid, text, text);
--   drop function if exists public.record_instagram_token_refresh(uuid, text, timestamptz);
--   drop function if exists public.record_instagram_account_subscription(uuid, text[]);
--   drop function if exists public.get_instagram_account_token(uuid);
--   drop function if exists public.store_instagram_account_connection(uuid, text, text, text, text, timestamptz, uuid);
--   drop function if exists public.disconnect_instagram_account(uuid, uuid);
--   drop table if exists public.instagram_contact_reservations;
--   drop table if exists public.instagram_contacts;
--   drop function if exists public.instagram_contact_tenant_guard();
--   drop table if exists public.instagram_accounts;
