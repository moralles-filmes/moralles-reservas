-- Migration 054: Fila de espera — acesso de platform_admin (super-admin).
--
-- Bug: adicionar à fila falhava com "enter_waitlist: not a unit member" quando
-- o super-admin operava uma unit onde ele não tem `unit_members` real. A UI
-- mostra "Proprietário" (useCurrentUnit.ts fabrica pseudo-membership), mas o
-- banco rejeitava porque tanto o RPC quanto as 4 policies RLS da `waitlist`
-- checavam só `is_unit_member(auth.uid(), unit_id)`, sem o paralelo
-- `is_platform_admin`. Mesma invariante já aplicada em `reservations`
-- (platform_admin_all_reservations, mig 013).
--
-- Correção em 2 frentes:
--   1. RPC `enter_waitlist`: branch authenticated aceita membro OU platform_admin.
--      (RPC é SECURITY DEFINER e bypassa a RLS da tabela — o check inline é o
--      gatekeeper do INSERT.)
--   2. Policy `platform_admin_all_waitlist` (FOR ALL): cobre SELECT (ver a fila),
--      UPDATE (notificar/sentar/cancelar) e DELETE pro super-admin. Permissiva →
--      OR com as 4 policies `waitlist_member_*` existentes (mantidas intactas).
--
-- Dependências:
--   * 053 (20260517100100) — enter_waitlist original (corpo replicado aqui)
--   * 014_operacional.sql — tabela waitlist + policies waitlist_member_*
--   * 013_multi_tenant.sql — is_unit_member, is_platform_admin

begin;

-- ─── 1. RPC enter_waitlist (corpo idêntico à mig 053, exceto o guard auth) ───
create or replace function public.enter_waitlist(
  p_unit_id            uuid,
  p_customer_name      text,
  p_customer_phone     text default null,
  p_party_size         int  default 1,
  p_notes              text default null,
  p_priority_category  text default 'normal',
  p_requested_for_time time default null
)
returns table (waitlist_id uuid, code int)
language plpgsql
security definer
set search_path = public
as $$
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
$$;

revoke all on function public.enter_waitlist(uuid, text, text, int, text, text, time) from public;
grant execute on function public.enter_waitlist(uuid, text, text, int, text, text, time) to anon, authenticated;

-- ─── 2. Policy paralela platform_admin (cobre SELECT/INSERT/UPDATE/DELETE) ───
drop policy if exists "platform_admin_all_waitlist" on public.waitlist;
create policy "platform_admin_all_waitlist" on public.waitlist
  for all to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

commit;
