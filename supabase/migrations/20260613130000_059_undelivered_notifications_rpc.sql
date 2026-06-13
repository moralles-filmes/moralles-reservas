-- Migration 059: RPC do painel "Entregas" — lista mensagens NÃO ENTREGUES.
--
-- Fonte única do painel central (Operacional → Entregas). Junta notifications_sent
-- com waitlist / reservations→customers pra dar contexto (nome, telefone, código)
-- sem N+1 no cliente, e devolve só as que não foram confirmadas como entregues.
--
-- "Não entregue" =
--   * status='failed' OU failed_at preenchido (falha real reportada), OU
--   * status='sent' E provider_message_id preenchido E delivered_at NULL há > 5min.
-- Linhas SEM provider_message_id (envios pré-Fase-1 ou provider que não devolve id)
-- NÃO entram — não dá pra afirmar que falharam (evita falso positivo).
--
-- Gateada por is_unit_member OR is_platform_admin (padrão do projeto). Operator-facing:
-- pode devolver nome/telefone (operador já vê dados do cliente normalmente).
--
-- Aditiva e pura.

begin;

create or replace function public.get_undelivered_notifications(
  p_unit_id uuid,
  p_since   timestamptz default now() - interval '7 days'
)
returns table (
  id                  uuid,
  kind                text,
  status              text,
  provider_message_id text,
  sent_at             timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  failed_at           timestamptz,
  waitlist_id         uuid,
  reservation_id      uuid,
  customer_name       text,
  customer_phone      text,
  ref_code            text,
  ref_date            date,
  ref_time            text
)
language plpgsql
security definer
stable
set search_path = public
as $$
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
$$;

revoke all on function public.get_undelivered_notifications(uuid, timestamptz) from public;
grant execute on function public.get_undelivered_notifications(uuid, timestamptz) to authenticated;

commit;
