-- Migration 055: RPC pública única de acompanhamento (tracking) por token UUID.
--
-- Cria a página pública /acompanhar/:token (sem login). O token é o próprio
-- `id` UUID v4 (gen_random_uuid) de `reservations` OU `waitlist` — não-sequencial
-- e inadivinhável, então serve como identificador público sem coluna nova.
--
-- A função discrimina o tipo tentando `reservations` primeiro, depois `waitlist`
-- (espaços de UUID não colidem). SEMPRE gateada por `units.is_public = true` —
-- entry de unit privada/fechada retorna null (sem vazamento cross-tenant: o
-- token é um lookup global, mas só retorna se a unit DA PRÓPRIA linha for
-- pública; não há parâmetro de tenant pra falsificar).
--
-- Privacidade: devolve só dados públicos — PRIMEIRO NOME apenas, mais os campos
-- da unit que JÁ são públicos (name/slug/logo/phone, expostos em
-- get_unit_public_full). SEM telefone do cliente, SEM e-mail, SEM nome completo,
-- SEM `notes` (notes pode conter anotação interna do operador).
--
-- Posição na fila: rank entre entries ATIVAS (status in ('waiting','notified'))
-- da mesma unit, ordem `priority asc, created_at asc` — idêntico a useWaitlist.ts
-- e ao painel do operador. Só calculada quando a entry está ativa; senão null.
--
-- Aditiva e pura: função nova, sem DROP, sem mudança de schema/RLS/policy.

begin;

create or replace function public.get_public_tracking(p_token uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_result     jsonb;
  v_unit_id    uuid;
  v_priority   int;
  v_created_at timestamptz;
  v_status     text;
  v_position   int;
begin
  -- ── Branch 1: reserva ─────────────────────────────────────────────────────
  select jsonb_build_object(
           'type', 'reservation',
           'first_name', split_part(btrim(c.name), ' ', 1),
           'unit_name', u.name,
           'unit_slug', u.slug,
           'unit_logo_url', u.logo_url,
           'unit_whatsapp', regexp_replace(coalesce(u.phone, ''), '\D', '', 'g'),
           'date', r.date,
           'time', to_char(r.time, 'HH24:MI'),
           'party_size', r.party_size,
           'status', r.status,
           'reservation_code', r.reservation_code,
           'payment_status', r.payment_status,
           'status_updated_at', r.updated_at
         )
    into v_result
    from reservations r
    join customers c on c.id = r.customer_id
    join units     u on u.id = r.unit_id
   where r.id = p_token
     and u.is_public = true
   limit 1;

  if v_result is not null then
    return v_result;
  end if;

  -- ── Branch 2: fila de espera ──────────────────────────────────────────────
  -- Carrega os campos brutos primeiro (priority/created_at/status são
  -- necessários pra calcular a posição antes de montar o jsonb).
  select w.unit_id, w.priority, w.created_at, w.status
    into v_unit_id, v_priority, v_created_at, v_status
    from waitlist w
    join units u on u.id = w.unit_id
   where w.id = p_token
     and u.is_public = true
   limit 1;

  if not found then
    return null;
  end if;

  -- Posição: 1 + nº de entries ativas da mesma unit que ordenam ANTES desta.
  -- "Antes" sob `priority asc, created_at asc`. Só faz sentido se ESTA entry
  -- estiver ativa; caso contrário, null.
  if v_status in ('waiting', 'notified') then
    select 1 + count(*)
      into v_position
      from waitlist w2
     where w2.unit_id = v_unit_id
       and w2.status in ('waiting', 'notified')
       and (
            w2.priority < v_priority
         or (w2.priority = v_priority and w2.created_at < v_created_at)
       );
  else
    v_position := null;
  end if;

  select jsonb_build_object(
           'type', 'waitlist',
           'first_name', split_part(btrim(w.customer_name), ' ', 1),
           'unit_name', u.name,
           'unit_slug', u.slug,
           'unit_logo_url', u.logo_url,
           'unit_whatsapp', regexp_replace(coalesce(u.phone, ''), '\D', '', 'g'),
           'party_size', w.party_size,
           'code', w.code,
           'status', w.status,
           'position', v_position,
           'created_at', w.created_at,
           'status_updated_at', w.updated_at
         )
    into v_result
    from waitlist w
    join units u on u.id = w.unit_id
   where w.id = p_token
   limit 1;

  return v_result;
end;
$$;

revoke all on function public.get_public_tracking(uuid) from public;
grant execute on function public.get_public_tracking(uuid) to anon, authenticated;

commit;
