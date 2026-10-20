-- 79a: base do pré-voo 79 (módulo Instagram, Fase 1).
--
-- RODA DEPOIS DE: 00-bootstrap -> 01-audit -> 09a-advisor-bootstrap -> migration
-- 20260910120000_106 (a base do 68/75). Ela já traz `organizations`, `units`
-- (com `organization_id`), `unit_members` (com `role`), `platform_admins`,
-- `auth.uid()` lendo `request.jwt.claims` e os helpers `app_private.*` na forma
-- de produção. RODA ANTES das migrations do Instagram, e recusa rodar depois.
--
-- O que este arquivo acrescenta:
--   1. DEFAULT PRIVILEGES de tabela E de função emulando o Supabase (como o
--      61a): ALL nas tabelas novas de `public` e EXECUTE nas funções novas para
--      anon/authenticated/service_role. Sem eles o IG-1.5 fica CEGO: mediria só
--      o grant implícito a PUBLIC do `CREATE FUNCTION`, e uma migration sem os
--      `revoke` de tabela passaria verde.
--   2. Grant de tabela em tudo que já existe em `public`, como o Supabase dá em
--      produção (a policy de UPDATE de `instagram_settings` lê `unit_members`
--      como `authenticated`), e USAGE do schema `auth` para os papéis de API.
--   3. RLS de `unit_members` com as duas policies de produção (013, com os
--      helpers já em `app_private` depois da 106): o `exists` da policy de
--      UPDATE enxerga só o que o papel real enxerga.
--   4. Fixtures (UUIDs fixos `a0d79000-…`): org A com a unidade UA (owner,
--      gerente, operador), org B com a unidade UB (gerente), e um
--      platform_admin sem membership.
-- Re-executável (antes das migrations).

do $$
begin
  if to_regclass('public.unit_module_grants') is not null
     or to_regclass('public.instagram_settings') is not null then
    raise exception '79a exige rodar ANTES da migration 20261020120000_instagram_module_grants: as tabelas ja existem e nasceram sem os default privileges, o que cega o IG-1.5. Recrie o banco (dropdb ig79 / createdb ig79) e siga o README, secao 79.';
  end if;
  if to_regprocedure('app_private.is_unit_member(uuid,uuid)') is null
     or to_regprocedure('app_private.is_platform_admin(uuid)') is null
     or to_regclass('public.unit_members') is null then
    raise exception '79a exige 00 -> 01 -> 09a -> migration 106 aplicados antes.';
  end if;
end $$;

-- ─── 1. Default privileges do Supabase ───────────────────────────────────────
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;

-- ─── 2. Grants de tabela no que já existe ────────────────────────────────────
grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;

-- USAGE do schema `auth` para os papéis de API, como no Supabase: o trigger de
-- carimbo de `instagram_settings` é SECURITY INVOKER e resolve `auth.uid()`
-- pelo nome com o papel de quem grava. Sem isto o UPDATE do gerente falharia
-- por ACL do harness (`permission denied for schema auth`), não pela migration.
grant usage on schema auth to anon, authenticated, service_role;

-- ─── 3. RLS de unit_members (forma da 013, helpers em app_private) ──────────
alter table public.unit_members enable row level security;

drop policy if exists "platform_admin_all_unit_members" on public.unit_members;
create policy "platform_admin_all_unit_members" on public.unit_members
  for all to authenticated
  using (app_private.is_platform_admin(auth.uid()))
  with check (app_private.is_platform_admin(auth.uid()));

drop policy if exists "unit_member_read_unit_members" on public.unit_members;
create policy "unit_member_read_unit_members" on public.unit_members
  for select to authenticated
  using (app_private.is_unit_member(auth.uid(), unit_id));

-- ─── 3b. Conversas na forma de produção (Task 1.4) ─────────────────────────
-- `conversations` como as migrations 001 + 013 + 015 + 027 + 049 + 056 + 070 a
-- deixam (colunas, FKs, CHECK de status, índices, trigger de updated_at), RLS
-- habilitada e FORCE (20261017180000), com as duas policies da 013 já com os
-- helpers em `app_private` (106). Nasce DEPOIS dos default privileges (passo
-- 1), então ganha ALL para anon/authenticated/service_role como no Supabase; a
-- ACL de escrita de produção vem da migration 20261017160000, aplicada
-- VERBATIM na sequência do README §79 (assim como a 20260905143453, que traz
-- `append_conversation_message` e o `get_or_create_whatsapp_conversation`
-- pré-Instagram). Fora daqui: publication do Realtime (não existe no harness).
--
-- O que a 20260905143453 e o reconcile de aceitação precisam e o 00 não tem,
-- na forma da 20260817170753: `whatsapp_channels.is_active` e o par
-- `notifications_sent.whatsapp_provider/whatsapp_channel_id`.
alter table public.whatsapp_channels add column if not exists is_active boolean;
alter table public.notifications_sent
  add column if not exists whatsapp_provider text,
  add column if not exists whatsapp_channel_id uuid references public.whatsapp_channels(id) on delete set null;

create table if not exists public.conversations (
  id                     uuid        primary key default gen_random_uuid(),
  customer_id            uuid        not null references public.customers(id) on delete cascade,
  reservation_id         uuid        references public.reservations(id) on delete set null,
  messages               jsonb       not null default '[]',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unit_id                uuid        not null constraint conversations_unit_id_fk references public.units(id) on delete restrict,
  status                 text        not null default 'ai_active'
    check (status in ('ai_active', 'awaiting_human', 'human_active', 'resolved')),
  handoff_reason         text,
  handoff_at             timestamptz,
  assigned_to            uuid        references auth.users(id) on delete set null,
  last_message_at        timestamptz default now(),
  last_silenced_reply_at timestamptz,
  contact_name           text,
  ai_lock_token          text,
  ai_lock_until          timestamptz,
  wa_chat_lid            text
);
create index if not exists conversations_customer_idx on public.conversations (customer_id);
create index if not exists conversations_updated_idx on public.conversations (updated_at desc);
create index if not exists conversations_unit_idx on public.conversations (unit_id);
create index if not exists conversations_unit_status_idx on public.conversations (unit_id, status) where status <> 'resolved';
create unique index if not exists conversations_unit_wa_chat_lid_idx
  on public.conversations (unit_id, wa_chat_lid) where wa_chat_lid is not null;

drop trigger if exists conversations_updated_at on public.conversations;
create trigger conversations_updated_at
  before update on public.conversations
  for each row execute function public.update_updated_at();

alter table public.conversations enable row level security;
alter table public.conversations force row level security;

drop policy if exists "platform_admin_all_conversations" on public.conversations;
create policy "platform_admin_all_conversations" on public.conversations
  for all to authenticated
  using (app_private.is_platform_admin(auth.uid()))
  with check (app_private.is_platform_admin(auth.uid()));

drop policy if exists "unit_member_all_conversations" on public.conversations;
create policy "unit_member_all_conversations" on public.conversations
  for all to authenticated
  using (app_private.is_unit_member(auth.uid(), unit_id))
  with check (app_private.is_unit_member(auth.uid(), unit_id));

-- Stub MÍNIMO de `whatsapp_automation_jobs` para o IG-4.3: só as colunas que
-- o corpo real de `app_private.reconcile_whatsapp_automation_acceptance_inner`
-- (20261019183559:777) lê no caminho `recorded`, com nome, tipo, nulidade e
-- default das migrations 20261003225857 + 20261004184738 (`pin_phase`) +
-- 20261017120000 (CHECK de `kind`). Sem binding/template/voucher/RLS: o
-- reconcile roda como dono (postgres) e não lê nada disso no caminho medido.
-- O `%rowtype` do corpo exige a tabela no `create or replace` da migration.
create table if not exists public.whatsapp_automation_jobs (
  id                  uuid        primary key default gen_random_uuid(),
  unit_id             uuid        not null references public.units(id) on delete cascade,
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  kind                text        not null
    constraint whatsapp_automation_jobs_kind_check
    check (kind in ('confirmation','reminder_d1','survey_d1','waitlist_entered','waitlist_feedback','voucher_issued','cancellation','waitlist_table_ready')),
  reservation_id      uuid        references public.reservations(id) on delete cascade,
  waitlist_id         uuid        references public.waitlist(id) on delete cascade,
  customer_id         uuid        references public.customers(id) on delete set null,
  customer_erased_at  timestamptz,
  channel_id          uuid,
  provider            text        check (provider in ('official','datafy','zapi','waha','uazapi')),
  notification_id     uuid        not null default gen_random_uuid() unique,
  safe_log_body       text        check (char_length(safe_log_body) <= 4096),
  state               text        not null default 'queued'
    check (state in ('queued','claimed','posting','accepted','blocked','expired','uncertain','retry_wait','needs_review','failed','reconciled','paused','rejected')),
  claim_token         uuid,
  posting_started_at  timestamptz,
  provider_message_id text        check (char_length(provider_message_id) between 1 and 512 and provider_message_id !~ '[[:cntrl:]]'),
  reconcile_required  boolean     not null default false,
  error_code          text        check (error_code ~ '^[a-z0-9_]{1,64}$'),
  finished_at         timestamptz,
  pin_phase           text        not null default 'bound'
);

-- ─── 4. Fixtures ─────────────────────────────────────────────────────────────
-- UA (org A): owner …a1, gerente …a2, operador …a3. UB (org B): gerente …b2.
-- PA …c1: platform_admin sem nenhuma linha em unit_members.
insert into auth.users (id, email) values
  ('a0d79000-0000-4000-8000-0000000000a1', 'ig79-owner-a@example.test'),
  ('a0d79000-0000-4000-8000-0000000000a2', 'ig79-gerente-a@example.test'),
  ('a0d79000-0000-4000-8000-0000000000a3', 'ig79-operador-a@example.test'),
  ('a0d79000-0000-4000-8000-0000000000b2', 'ig79-gerente-b@example.test'),
  ('a0d79000-0000-4000-8000-0000000000c1', 'ig79-pa@example.test')
on conflict (id) do nothing;

insert into public.organizations (id, name) values
  ('a0d79000-0000-4000-8000-00000000000a', 'ig79 org A'),
  ('a0d79000-0000-4000-8000-00000000000b', 'ig79 org B')
on conflict (id) do nothing;

insert into public.units (id, organization_id, name) values
  ('a0d79000-0000-4000-8000-0000000000aa', 'a0d79000-0000-4000-8000-00000000000a', 'ig79 UA'),
  ('a0d79000-0000-4000-8000-0000000000bb', 'a0d79000-0000-4000-8000-00000000000b', 'ig79 UB')
on conflict (id) do nothing;

insert into public.unit_members (user_id, unit_id, role) values
  ('a0d79000-0000-4000-8000-0000000000a1', 'a0d79000-0000-4000-8000-0000000000aa', 'owner'),
  ('a0d79000-0000-4000-8000-0000000000a2', 'a0d79000-0000-4000-8000-0000000000aa', 'gerente'),
  ('a0d79000-0000-4000-8000-0000000000a3', 'a0d79000-0000-4000-8000-0000000000aa', 'operador'),
  ('a0d79000-0000-4000-8000-0000000000b2', 'a0d79000-0000-4000-8000-0000000000bb', 'gerente')
on conflict (user_id, unit_id) do nothing;

insert into public.platform_admins (user_id) values ('a0d79000-0000-4000-8000-0000000000c1')
on conflict (user_id) do nothing;
