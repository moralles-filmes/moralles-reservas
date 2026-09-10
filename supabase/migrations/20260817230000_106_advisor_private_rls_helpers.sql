-- Tira os três helpers de RLS do schema exposto ao PostgREST.
--
-- POR QUÊ. Os lints 0028/0029 do Security Advisor apontam função SECURITY
-- DEFINER de `public` alcançável por anon/authenticated. Dos 29 warnings, estes
-- três são a única exposição concreta: com a anon key do bundle, qualquer um
-- chamava /rest/v1/rpc/is_unit_member com p_user_id/p_unit_id arbitrários e
-- recebia um booleano — oráculo de enumeração de membership. `is_platform_admin`
-- e `is_org_member` não têm EXECUTE para anon (a 085 §5.2 revogou), mas seguem
-- alcançáveis por qualquer usuário logado, que é o mesmo oráculo um degrau acima.
--
-- POR QUE NÃO REVOGAR EM VEZ DE MOVER. `is_unit_member` é referenciado por 42
-- policies, 24 delas TO PUBLIC. Policy é avaliada com o privilégio de quem
-- consulta, e o EXECUTE da função é conferido em TEMPO DE EXECUÇÃO: revogar
-- EXECUTE de anon faz a query ESTOURAR com `permission denied for function`, não
-- negar linha. Mover não mexe na ACL — ela vive na linha de `pg_proc` e viaja
-- com a função — e o PostgREST só expõe `public`, então o oráculo fecha sem que
-- nenhuma policy perceba.
--
-- SOBRE O `grant usage on schema` ABAIXO. Ele NÃO é o que sustenta as policies.
-- Expressão de policy fica guardada no catálogo já resolvida por OID, então
-- nenhum nome é procurado na hora da consulta e revogar USAGE do schema não
-- afeta policy nenhuma — medido no CONTROLE-7 de 10-controles-106.sql, que
-- mostra as duas metades lado a lado: USAGE revogado não muda nada, EXECUTE
-- revogado estoura. O USAGE existe para as chamadas POR NOME que continuam
-- existindo (service_role em worker/RPC, SQL futuro, o `create or replace` das
-- quatro funções abaixo) — é defesa em profundidade, não a trava.
--
-- O QUE TORNA ESTA MIGRATION PERIGOSA SE COPIADA PELA METADE. Quatro funções
-- SECURITY DEFINER chamam os helpers PELO NOME dentro do corpo. Em plpgsql o
-- nome é resolvido em tempo de execução, então um SET SCHEMA sem a reescrita
-- abaixo quebra a entrada pública na fila de espera, a anonimização LGPD, a
-- listagem de clientes e o painel de Entregas. As duas metades vivem na mesma
-- transação de propósito. CONTROLE-6 reintroduz exatamente esse defeito e vê a
-- fila pública quebrar.
--
-- As policies referenciam a função por OID, não por nome, então elas NÃO
-- precisam ser reescritas — provado em ACL-1 do pré-voo local.

begin;

create schema if not exists app_private;
comment on schema app_private is
  'Helpers de RLS e utilitários internos. NUNCA exposto ao PostgREST: expor '
  'reabre os lints 0028/0029 do Security Advisor e o oráculo de membership.';

-- PUBLIC não tem privilégio em schema novo por default; o revoke é explícito
-- para que um `alter default privileges` futuro não abra o schema em silêncio.
revoke all on schema app_private from public;
grant usage on schema app_private to anon, authenticated, service_role;

-- Idempotente: só move o que ainda estiver em `public`. `to_regprocedure`
-- devolve NULL em vez de estourar quando a função não existe, e casa a
-- ASSINATURA — checar só `proname` casaria um overload alheio.
do $$
begin
  if to_regprocedure('public.is_unit_member(uuid,uuid)') is not null then
    alter function public.is_unit_member(uuid, uuid) set schema app_private;
  end if;
  if to_regprocedure('public.is_platform_admin(uuid)') is not null then
    alter function public.is_platform_admin(uuid) set schema app_private;
  end if;
  if to_regprocedure('public.is_org_member(uuid,uuid)') is not null then
    alter function public.is_org_member(uuid, uuid) set schema app_private;
  end if;
end $$;

-- Os três são `language sql`, SECURITY DEFINER, STABLE, com `search_path=public`
-- FIXO e corpo que lê `unit_members`/`units`/`platform_admins` sem qualificar. O
-- search_path fixo viaja com a função e é o que mantém a resolução correta
-- depois do move — as tabelas continuam em `public`. Nenhum `grant execute`
-- extra é necessário: o SET SCHEMA não toca a ACL.

-- ─────────────────────────────────────────────────────────────────────────────
-- A OUTRA METADE: os quatro corpos que chamam o helper pelo nome.
--
-- Cada `create or replace` abaixo é a definição de produção com UMA substituição
-- por call site (duas por função), mais `app_private` ACRESCENTADO ao
-- search_path que cada uma já tinha — nunca substituindo. Preservado de
-- propósito, porque perder qualquer um destes quebra caller existente:
--   • os DEFAULTs de enter_waitlist (cinco), de get_customer_stats_bulk
--     (p_unit_id) e de get_undelivered_notifications (p_since) — perder um
--     quebra chamada com menos argumentos, que é como o frontend chama;
--   • STABLE em get_customer_stats_bulk e get_undelivered_notifications, que
--     muda plano de execução;
--   • SECURITY DEFINER nas quatro;
--   • o `pg_temp` que anonymize_customer e get_customer_stats_bulk já tinham, e
--     a AUSÊNCIA dele nas outras duas.
-- `create or replace function` não muda dono nem permissão, então a ACL das
-- quatro segue intacta.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.enter_waitlist(
  p_unit_id uuid,
  p_customer_name text,
  p_customer_phone text default null::text,
  p_party_size integer default 1,
  p_notes text default null::text,
  p_priority_category text default 'normal'::text,
  p_requested_for_time time without time zone default null::time without time zone
)
returns table(waitlist_id uuid, code integer)
language plpgsql
security definer
set search_path = 'public', 'app_private'
as $function$
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
      if not (app_private.is_unit_member(v_uid, p_unit_id)
              or app_private.is_platform_admin(v_uid)) then
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

create or replace function public.anonymize_customer(p_id uuid)
returns void
language plpgsql
security definer
set search_path = 'public', 'app_private', 'pg_temp'
as $function$
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

  if not app_private.is_org_member(v_caller, v_org_id)
     and not app_private.is_platform_admin(v_caller) then
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

create or replace function public.get_customer_stats_bulk(
  p_customer_ids uuid[],
  p_unit_id uuid default null::uuid
)
returns table(
  customer_id uuid,
  total_unit integer,
  total_org integer,
  confirmed integer,
  no_shows integer,
  cancelled integer,
  no_show_rate numeric,
  last_visit date
)
language plpgsql
stable
security definer
set search_path = 'public', 'app_private', 'pg_temp'
as $function$
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
           app_private.is_platform_admin(v_caller)
           or app_private.is_org_member(v_caller, c.organization_id)
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

create or replace function public.get_undelivered_notifications(
  p_unit_id uuid,
  p_since timestamp with time zone default (now() - '7 days'::interval)
)
returns table(
  id uuid,
  kind text,
  status text,
  provider_message_id text,
  sent_at timestamp with time zone,
  delivered_at timestamp with time zone,
  read_at timestamp with time zone,
  failed_at timestamp with time zone,
  waitlist_id uuid,
  reservation_id uuid,
  customer_name text,
  customer_phone text,
  ref_code text,
  ref_date date,
  ref_time text
)
language plpgsql
stable
security definer
set search_path = 'public', 'app_private'
as $function$
begin
  -- As duas chamadas eram SEM qualificação; ficam qualificadas porque
  -- `app_private` no search_path é cinto de segurança, não a garantia.
  if not (app_private.is_unit_member(auth.uid(), p_unit_id)
          or app_private.is_platform_admin(auth.uid())) then
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

commit;
