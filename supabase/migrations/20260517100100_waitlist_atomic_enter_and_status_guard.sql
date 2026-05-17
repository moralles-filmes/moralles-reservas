-- Migration 053: Fila de espera — entrada atômica + guard de transições de status.
--
-- Cobre 2 bugs do módulo:
--
--   1. Race condition no `code`: hoje o cliente chama `next_waitlist_code(unit_id)`
--      e depois faz INSERT em waitlist em round-trips separados. Dois clientes
--      simultâneos podem receber o mesmo código antes do INSERT do primeiro
--      commitar. A UNIQUE parcial `waitlist_unit_active_code_unique` (mig 036)
--      pega o problema mas devolve erro confuso (23505) pro 2º cliente.
--      Solução: RPC `enter_waitlist` faz advisory lock + next_code + INSERT
--      numa única transação. Lock é por (unit_id), tenants concorrentes não se
--      afetam.
--
--   2. Status transitions sem validação: a UI esconde botões inválidos mas
--      via API/console é possível UPDATE direto seated→waiting,
--      cancelled→seated, etc. Trigger `validate_waitlist_status_transition`
--      bloqueia transições proibidas. Estados terminais (`seated`, `cancelled`)
--      não voltam pra waiting/notified.
--
-- Dependências:
--   * 014_operacional.sql (waitlist)
--   * 023b_lock_anon_policies.sql (anon_insert_waitlist) — política mantida
--   * 036_waitlist_module.sql (next_waitlist_code, priority_category)
--   * 013_multi_tenant.sql (is_unit_member)
--   * extension pgcrypto/uuid (já carregadas)

begin;

-- ─── 1. RPC enter_waitlist ──────────────────────────────────────────────────
-- Atômica: lock por unit_id → next_code → INSERT → retorna (id, code).
-- Substitui o fluxo client `rpc(next_waitlist_code) + insert(waitlist)`.
--
-- Validação inline (defense-in-depth contra bypass das RLS policies):
--   * anon: exige unit pública + party_size 1-20 + status 'waiting'
--   * authenticated: exige is_unit_member(auth.uid(), p_unit_id) + party_size >= 1
--   * service_role: passa direto (sem checks adicionais — usado por edge fns)
--
-- Os campos `priority` int e `seated_at` são populados pelos triggers
-- existentes (set_waitlist_priority_from_category mig 036, set_waitlist_seated_at
-- mig 048). A trigger `waitlist_dispatch_entered` (mig 048) dispara
-- normalmente no AFTER INSERT — fluxo de mensagem "entrou na fila" preservado.

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
      -- authenticated: precisa ser membro da unit
      if not public.is_unit_member(v_uid, p_unit_id) then
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

-- ─── 2. Trigger validate_waitlist_status_transition ─────────────────────────
-- Estados terminais (seated, cancelled) não voltam. Estados intermediários
-- (waiting, notified) seguem as transições documentadas em CLAUDE.md.
--
-- UPDATEs que repetem o mesmo status (no-op) são aceitos pra não atrapalhar
-- updates parciais (.update({ status, notified_at }) com mesmo status).

create or replace function public.validate_waitlist_status_transition()
returns trigger
language plpgsql
as $$
begin
  -- No-op (mesmo status) é sempre permitido.
  if new.status = old.status then
    return new;
  end if;

  -- Matriz de transições válidas
  if old.status = 'waiting' and new.status in ('notified','seated','cancelled') then
    return new;
  end if;

  if old.status = 'notified' and new.status in ('seated','cancelled','waiting') then
    -- waiting permitido pra desfazer notificação enviada por engano
    return new;
  end if;

  -- Qualquer outra transição é proibida (seated → *, cancelled → *)
  raise exception 'invalid_waitlist_status_transition: % -> %', old.status, new.status
    using errcode = '23514';
end;
$$;

drop trigger if exists waitlist_validate_status_transition on public.waitlist;
create trigger waitlist_validate_status_transition
  before update of status on public.waitlist
  for each row execute function public.validate_waitlist_status_transition();

commit;
