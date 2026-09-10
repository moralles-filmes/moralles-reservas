-- Ambiente mínimo para os casos ACL-1..ACL-5 da migration 106.
--
-- POR QUE ESTE ARQUIVO EXISTE. O `00-bootstrap.sql` foi escrito para a sequência
-- de WhatsApp/instâncias e não tem `unit_members`, `customers`, `waitlist`,
-- `reservations`, `settings`, nem `units.is_public`/`organizations.is_public`. E
-- o `02-seed.sql` insere em `whatsapp_instances`, que só existe depois da 087 —
-- por isso a sequência do advisor NÃO usa o `02`. O que falta está aqui, e nada
-- aqui altera arquivo compartilhado com a outra sequência.
--
-- ORIGEM DE CADA OBJETO. As sete funções abaixo foram **extraídas verbatim de
-- produção** via `pg_get_functiondef(oid)` (projeto gbabxcrntkwgblgqsiit,
-- 2026-09-10), na mesma disciplina que o `01-audit.sql` declara no cabeçalho.
-- Isso é o que dá força ao CONTROLE-6: ele reintroduz `public.is_*` num corpo
-- REAL. Corpo parafraseado provaria apenas que a paráfrase quebra.
-- As tabelas foram conferidas coluna a coluna contra
-- `information_schema.columns` e `pg_indexes` do mesmo projeto — não inventadas.
--
-- Rodar depois de `00-bootstrap.sql` e `01-audit.sql`, com ON_ERROR_STOP=1.

-- ─── auth.uid() ──────────────────────────────────────────────────────────────
-- O stub do 00-bootstrap só lê o GUC `request.jwt.claim.sub`; os casos ACL
-- setam `request.jwt.claims` como objeto JSON, que é a forma que o GoTrue usa
-- hoje. Sem as duas, `auth.uid()` devolveria NULL e ACL-1 falharia pelo motivo
-- errado. Esta é a definição real do Supabase, reproduzida aqui — e é
-- `create or replace` NESTE arquivo de propósito: o 00-bootstrap é compartilhado
-- com a sequência de WhatsApp e não pode mudar.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

-- ─── Tenancy que o 00-bootstrap não tem ──────────────────────────────────────
-- `is_public` nas duas: `enter_waitlist` exige as DUAS verdadeiras no caminho
-- anon (ACL-4), e o 00-bootstrap não declara nenhuma delas.
alter table organizations add column if not exists is_public boolean not null default false;
alter table units         add column if not exists is_public boolean not null default false;
alter table units         add column if not exists slug text;

create table if not exists unit_members (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  unit_id    uuid not null references units(id) on delete cascade,
  role       text not null default 'operador' check (role in ('owner','gerente','operador')),
  created_at timestamptz not null default now(),
  email      text,
  name       text,
  unique (user_id, unit_id)
);

create table if not exists customers (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references organizations(id) on delete cascade,
  name                     text not null,
  phone                    text not null,
  email                    text,
  emails                   jsonb not null default '[]'::jsonb,
  allergies                text,
  dietary_restrictions     text,
  vip_notes                text,
  preferred_table_location text,
  do_not_contact           boolean not null default false,
  deleted_at               timestamptz,
  created_at               timestamptz not null default now()
);
create unique index if not exists customers_org_phone_unique on customers (organization_id, phone);

create table if not exists reservations (
  id               uuid primary key default gen_random_uuid(),
  unit_id          uuid not null references units(id) on delete cascade,
  customer_id      uuid not null references customers(id) on delete cascade,
  status           text not null default 'pending',
  date             date not null,
  time             time without time zone not null,
  reservation_code text not null,
  created_at       timestamptz not null default now()
);

create table if not exists waitlist (
  id                 uuid primary key default gen_random_uuid(),
  unit_id            uuid not null references units(id) on delete cascade,
  customer_id        uuid references customers(id) on delete set null,
  customer_name      text not null,
  customer_phone     text,
  party_size         integer not null,
  requested_for_time time without time zone,
  priority           integer not null default 0,
  status             text not null default 'waiting',
  notes              text,
  notified_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  code               integer,
  priority_category  text not null default 'normal',
  seated_at          timestamptz
);
-- Reproduzido de produção: é o índice que torna o laço de `next_waitlist_code`
-- necessário em vez de decorativo.
create unique index if not exists waitlist_unit_active_code_unique
  on waitlist (unit_id, code)
  where status in ('waiting','notified') and code is not null;

create table if not exists settings (
  id      uuid primary key default gen_random_uuid(),
  key     text not null,
  value   jsonb not null,
  unit_id uuid not null references units(id) on delete cascade,
  unique (unit_id, key)
);

-- A 013 pendura o trigger genérico de auditoria em `customers`; `anonymize_customer`
-- passa por ele em produção, então passa aqui também.
drop trigger if exists audit_customers on customers;
create trigger audit_customers
  after insert or update or delete on customers
  for each row execute function public.audit_trigger_func();

-- ─── Os três helpers, verbatim de produção ───────────────────────────────────
-- `drop` antes de `create` no is_platform_admin: o stub do 00-bootstrap chama o
-- parâmetro `p_user` e produção chama `p_user_id`; `create or replace` não
-- renomeia parâmetro de entrada.
drop function if exists public.is_platform_admin(uuid);

CREATE OR REPLACE FUNCTION public.is_unit_member(p_user_id uuid, p_unit_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from unit_members where user_id = p_user_id and unit_id = p_unit_id);
$function$;

CREATE OR REPLACE FUNCTION public.is_platform_admin(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from platform_admins where user_id = p_user_id);
$function$;

CREATE OR REPLACE FUNCTION public.is_org_member(p_user_id uuid, p_org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from unit_members um join units u on u.id = um.unit_id
    where um.user_id = p_user_id and u.organization_id = p_org_id
  );
$function$;

-- Os grants que produção tem hoje. Reproduzi-los é o que dá sentido ao snapshot
-- de `proacl` do ACL-5: o move tem de PRESERVAR esta ACL, incluindo o fato de
-- que só `is_unit_member` tem `anon` (revogado das outras duas pela 085 §5.2).
revoke all on function public.is_unit_member(uuid, uuid)     from public;
revoke all on function public.is_platform_admin(uuid)        from public;
revoke all on function public.is_org_member(uuid, uuid)      from public;
grant execute on function public.is_unit_member(uuid, uuid)  to anon, authenticated, service_role;
grant execute on function public.is_platform_admin(uuid)     to authenticated, service_role;
grant execute on function public.is_org_member(uuid, uuid)    to authenticated, service_role;

-- ─── As quatro SECURITY DEFINER, verbatim de produção (forma PRÉ-106) ────────
-- Elas chegam aqui como estão em produção HOJE, chamando `public.is_*` (e, no
-- caso do get_undelivered_notifications, sem qualificar). É a migration 106 que
-- reescreve as quatro; é isso que o RED→GREEN mede.

CREATE OR REPLACE FUNCTION public.next_waitlist_code(p_unit_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_min int;
  v_max int;
  v_next int;
begin
  select coalesce((value)::text::int, 1) into v_min
    from settings where unit_id = p_unit_id and key = 'waitlist_code_min';
  if v_min is null then v_min := 1; end if;

  select coalesce((value)::text::int, 1000) into v_max
    from settings where unit_id = p_unit_id and key = 'waitlist_code_max';
  if v_max is null then v_max := 1000; end if;

  if v_min < 1 then v_min := 1; end if;
  if v_max < v_min then v_max := v_min; end if;

  select coalesce(max(code) + 1, v_min) into v_next
    from waitlist
    where unit_id = p_unit_id
      and code is not null
      and status in ('waiting', 'notified');

  if v_next < v_min or v_next > v_max then
    v_next := v_min;
  end if;

  for i in 0..(v_max - v_min) loop
    if not exists (
      select 1 from waitlist
      where unit_id = p_unit_id
        and code = v_next
        and status in ('waiting', 'notified')
    ) then
      return v_next;
    end if;
    v_next := v_next + 1;
    if v_next > v_max then v_next := v_min; end if;
  end loop;

  return v_min;
end;
$function$;

CREATE OR REPLACE FUNCTION public.enter_waitlist(p_unit_id uuid, p_customer_name text, p_customer_phone text DEFAULT NULL::text, p_party_size integer DEFAULT 1, p_notes text DEFAULT NULL::text, p_priority_category text DEFAULT 'normal'::text, p_requested_for_time time without time zone DEFAULT NULL::time without time zone)
 RETURNS TABLE(waitlist_id uuid, code integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text := current_setting('request.jwt.claim.role', true);
  v_uid  uuid := auth.uid();
  v_code int;
  v_id   uuid;
begin
  -- ── Validação de inputs ──────────────────────────────────────────────────
  if p_unit_id is null then
    raise exception 'enter_waitlist: p_unit_id is required' using errcode = '22023';
  end if;

  if p_customer_name is null or btrim(p_customer_name) = '' then
    raise exception 'enter_waitlist: p_customer_name is required' using errcode = '22023';
  end if;

  if p_party_size is null or p_party_size < 1 then
    raise exception 'enter_waitlist: p_party_size must be >= 1' using errcode = '22023';
  end if;

  if p_priority_category not in ('normal','senior','pregnant','disabled','other') then
    raise exception 'enter_waitlist: invalid priority_category' using errcode = '22023';
  end if;

  -- ── Auth por role ────────────────────────────────────────────────────────
  -- service_role bypassa checks (chamadas internas confiáveis).
  if v_role is distinct from 'service_role' then
    if v_uid is null then
      -- anon: unit precisa ser pública (org + unit) e party_size <= 20
      if p_party_size > 20 then
        raise exception 'enter_waitlist: anon party_size must be <= 20' using errcode = '22023';
      end if;

      if not exists (
        select 1
          from units u
          join organizations o on o.id = u.organization_id
         where u.id = p_unit_id
           and u.is_public = true
           and o.is_public = true
      ) then
        raise exception 'enter_waitlist: unit not public' using errcode = '42501';
      end if;
    else
      -- authenticated: membro da unit OU platform_admin (super-admin opera units
      -- alheias via pseudo-membership fabricada em useCurrentUnit.ts).
      if not (public.is_unit_member(v_uid, p_unit_id)
              or public.is_platform_admin(v_uid)) then
        raise exception 'enter_waitlist: not a unit member' using errcode = '42501';
      end if;
    end if;
  end if;

  -- ── Lock por tenant ─ serializa next_code+insert na mesma unit ──────────
  -- Advisory xact lock libera no commit/rollback automaticamente. hashtext
  -- mantém a chave dentro do range int4 e evita colisão entre namespaces.
  perform pg_advisory_xact_lock(hashtext('waitlist_code:' || p_unit_id::text));

  -- ── Gera próximo código (cíclico) usando lógica existente ────────────────
  v_code := public.next_waitlist_code(p_unit_id);

  -- ── INSERT ───────────────────────────────────────────────────────────────
  insert into public.waitlist (
    unit_id,
    customer_name,
    customer_phone,
    party_size,
    notes,
    priority_category,
    requested_for_time,
    status,
    code
  ) values (
    p_unit_id,
    btrim(p_customer_name),
    nullif(btrim(coalesce(p_customer_phone, '')), ''),
    p_party_size,
    nullif(btrim(coalesce(p_notes, '')), ''),
    p_priority_category,
    p_requested_for_time,
    'waiting',
    v_code
  )
  returning id into v_id;

  return query select v_id, v_code;
end;
$function$;

CREATE OR REPLACE FUNCTION public.anonymize_customer(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_org_id   uuid;
  v_caller   uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  select organization_id
    into v_org_id
    from public.customers
   where id = p_id
     and deleted_at is null;

  -- Customer inexistente ou já anonimizado: trata como no-op silencioso
  -- (não vaza existência do UUID para tenants alheios).
  if v_org_id is null then
    return;
  end if;

  if not public.is_org_member(v_caller, v_org_id)
     and not public.is_platform_admin(v_caller) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.customers
     set name = 'Cliente removido',
         phone = 'anon-' || substring(id::text, 1, 8),
         email = null,
         emails = '[]'::jsonb,
         allergies = null,
         dietary_restrictions = null,
         vip_notes = null,
         preferred_table_location = null,
         do_not_contact = true,
         deleted_at = now()
   where id = p_id and deleted_at is null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_customer_stats_bulk(p_customer_ids uuid[], p_unit_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(customer_id uuid, total_unit integer, total_org integer, confirmed integer, no_shows integer, cancelled integer, no_show_rate numeric, last_visit date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  if p_customer_ids is null or array_length(p_customer_ids, 1) is null then
    return;
  end if;

  return query
  with
    -- Customers pedidos que existem e pertencem a uma org da qual o caller é membro
    -- (ou caller é platform_admin)
    allowed as (
      select c.id, c.organization_id
        from public.customers c
       where c.id = any(p_customer_ids)
         and (
           public.is_platform_admin(v_caller)
           or public.is_org_member(v_caller, c.organization_id)
         )
    ),
    -- Agregação por customer escopada na unidade
    by_unit as (
      select r.customer_id,
             count(*)::int                                              as total_unit,
             count(*) filter (where r.status = 'confirmed')::int        as confirmed,
             count(*) filter (where r.status = 'no_show')::int          as no_shows,
             count(*) filter (where r.status = 'cancelled')::int        as cancelled,
             max(r.date) filter (where r.status in ('confirmed','no_show')) as last_visit
        from public.reservations r
        join allowed a on a.id = r.customer_id
       where (p_unit_id is null or r.unit_id = p_unit_id)
       group by r.customer_id
    ),
    -- Agregação por customer em toda a org (sem filtro de unit)
    by_org as (
      select r.customer_id,
             count(*)::int as total_org
        from public.reservations r
        join allowed a on a.id = r.customer_id
       group by r.customer_id
    )
  select
    a.id                                            as customer_id,
    coalesce(bu.total_unit, 0)                      as total_unit,
    coalesce(bo.total_org, 0)                       as total_org,
    coalesce(bu.confirmed, 0)                       as confirmed,
    coalesce(bu.no_shows, 0)                        as no_shows,
    coalesce(bu.cancelled, 0)                       as cancelled,
    case
      when coalesce(bu.confirmed, 0) + coalesce(bu.no_shows, 0) > 0
        then round(
               coalesce(bu.no_shows, 0)::numeric
               / (coalesce(bu.confirmed, 0) + coalesce(bu.no_shows, 0)),
               3
             )
      else null
    end                                             as no_show_rate,
    bu.last_visit                                   as last_visit
  from allowed a
  left join by_unit bu on bu.customer_id = a.id
  left join by_org  bo on bo.customer_id = a.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_undelivered_notifications(p_unit_id uuid, p_since timestamp with time zone DEFAULT (now() - '7 days'::interval))
 RETURNS TABLE(id uuid, kind text, status text, provider_message_id text, sent_at timestamp with time zone, delivered_at timestamp with time zone, read_at timestamp with time zone, failed_at timestamp with time zone, waitlist_id uuid, reservation_id uuid, customer_name text, customer_phone text, ref_code text, ref_date date, ref_time text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not (is_unit_member(auth.uid(), p_unit_id) or is_platform_admin(auth.uid())) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
    select
      ns.id,
      ns.kind,
      ns.status,
      ns.provider_message_id,
      ns.sent_at,
      ns.delivered_at,
      ns.read_at,
      ns.failed_at,
      ns.waitlist_id,
      ns.reservation_id,
      coalesce(w.customer_name, rc.name)        as customer_name,
      coalesce(w.customer_phone, rc.phone)       as customer_phone,
      coalesce(w.code::text, r.reservation_code) as ref_code,
      r.date                                     as ref_date,
      to_char(r.time, 'HH24:MI')                 as ref_time
    from notifications_sent ns
    left join waitlist     w  on w.id = ns.waitlist_id
    left join reservations r  on r.id = ns.reservation_id
    left join customers    rc on rc.id = r.customer_id
    where ns.unit_id = p_unit_id
      and ns.sent_at >= p_since
      and ns.kind <> 'confirmation_email'  -- painel é de WhatsApp; e-mail é outro canal
      and (
            ns.status = 'failed' or ns.failed_at is not null
         or (ns.status = 'sent'
             and ns.provider_message_id is not null
             and ns.delivered_at is null
             and ns.sent_at < now() - interval '5 minutes')
      )
    order by ns.sent_at desc;
end;
$function$;

-- Grants que produção tem nas quatro (o que as põe nos lints 0028/0029).
grant execute on function public.enter_waitlist(uuid, text, text, integer, text, text, time without time zone)
  to anon, authenticated, service_role;
grant execute on function public.anonymize_customer(uuid)                    to authenticated, service_role;
grant execute on function public.get_customer_stats_bulk(uuid[], uuid)       to authenticated, service_role;
grant execute on function public.get_undelivered_notifications(uuid, timestamptz) to authenticated, service_role;
grant select on waitlist to anon, authenticated;

-- ─── Seed ────────────────────────────────────────────────────────────────────
-- Ids fixos, no mesmo estilo do 02-seed.sql, para os casos poderem se referir a
-- eles. NADA aqui depende de whatsapp_instances — é por isso que a sequência do
-- advisor dispensa o 02.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'membro@teste.local')
on conflict do nothing;

insert into organizations (id, name, is_public) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Org Advisor', true)
on conflict (id) do update set is_public = true;

insert into units (id, organization_id, name, slug, is_public) values
  ('bbbbbbbb-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000001', 'Unidade Advisor', 'unidade-advisor', true)
on conflict (id) do update set is_public = true;

insert into unit_members (user_id, unit_id, role) values
  ('11111111-1111-1111-1111-111111111111',
   'bbbbbbbb-0000-0000-0000-000000000001', 'gerente')
on conflict (user_id, unit_id) do nothing;

insert into customers (id, organization_id, name, phone) values
  ('eeeeeeee-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000001', 'Cliente Advisor', '11999990001')
on conflict (id) do nothing;

-- Uma notificação não entregue, para o painel de Entregas ter o que devolver
-- em ACL-3 em vez de percorrer zero linhas.
insert into notifications_sent (id, unit_id, kind, status, provider_message_id, sent_at)
values ('ffffffff-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000001', 'waitlist_ready', 'sent',
        'MSG-ADVISOR-1', now() - interval '1 hour')
on conflict (id) do nothing;
