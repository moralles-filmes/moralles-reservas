-- 057 — Operador não pode cancelar reservas (apenas gerente/owner/platform_admin)
--
-- O cancelamento pelo painel é um UPDATE direto (reservations SET status='cancelled')
-- feito pelo browser sob RLS aberta (auth_all_reservations). Não há Edge Function
-- de status pra gatear o papel, então a regra é forçada por trigger BEFORE UPDATE.
--
-- Só bloqueia quando:
--   * a transição vira 'cancelled' (OLD.status <> 'cancelled'); e
--   * existe um usuário logado no painel (auth.uid() IS NOT NULL); e
--   * o papel desse usuário na unit da reserva é 'operador'.
--
-- Service contexts (workers, agente WhatsApp, Stripe) usam service_role com
-- auth.uid() = NULL e passam direto. platform_admin não tem linha em
-- unit_members → não é 'operador' → passa. Confirmar/Não compareceu não tocam
-- nesta regra (só cancelamento).

create or replace function public.enforce_operador_no_cancel()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
begin
  -- Só interessa a transição PARA 'cancelled' iniciada por usuário do painel.
  if new.status = 'cancelled'
     and old.status is distinct from 'cancelled'
     and v_uid is not null then

    select role into v_role
    from unit_members
    where user_id = v_uid and unit_id = new.unit_id;

    if v_role = 'operador' then
      raise exception 'operador_cannot_cancel'
        using hint = 'Apenas gerente ou proprietário podem cancelar reservas.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_operador_no_cancel on reservations;

create trigger trg_enforce_operador_no_cancel
  before update on reservations
  for each row
  execute function public.enforce_operador_no_cancel();
