-- Escolha de mesa: chave por unidade `seat_choice_enabled` (cliente escolhe a
-- mesa na página online, no WhatsApp e no Instagram). Ausente = desligada.
-- Spec: docs/superpowers/specs/2026-11-05-escolha-de-mesa-chave-design.md
--
-- 1. A chave entra na classe `manager` (dono e gerente gravam; operador recebe
--    42501 do settings_write_role_guard).
-- 2. O guard de valor aceita só JSON booleano nela (22023 setting_value_invalid).
-- Sem backfill: nenhuma linha nova; toda unidade continua com a escolha desligada.
-- Keep in sync with scripts/settings-write-acl.test.ts (SETTING_KEYS de Ajustes.tsx).

begin;

create or replace function app_private.unit_setting_write_class(p_key text)
returns text language sql immutable set search_path = '' as $$
  select case when p_key = any (array[
    'reservation_duration_minutes','booking_window_days','reservation_tolerance_minutes',
    'rules_and_conditions','additional_info','reminder_d1_enabled','survey_d1_enabled',
    'seat_choice_enabled',
    'waitlist_qr_enabled','waitlist_menu_link_enabled','waitlist_priority_enabled',
    'waitlist_code_min','waitlist_code_max','waitlist_tolerance_minutes',
    'waitlist_remote_entry_enabled','waitlist_remote_entry_limit',
    'waitlist_entered_enabled','waitlist_feedback_enabled',
    'giftback_whatsapp_enabled','giftback_email_enabled','giftback_message_template',
    'restaurant_menu','delivery_response','restaurant_extra_info',
    'allow_overbooking','restaurant_name'
  ]::text[]) then 'manager' else 'platform' end
$$;

revoke all on function app_private.unit_setting_write_class(text) from public, anon, authenticated, service_role;

-- Mesmo corpo da 20261029120100, mais o ramo de seat_choice_enabled.
create or replace function app_private.guard_unit_setting_value()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_limit integer;
  v_text text;
begin
  if new.key = 'agent_mode' then
    if pg_catalog.jsonb_typeof(new.value) is distinct from 'string'
       or (new.value #>> '{}') <> all (array['reservations', 'reservations_faq']) then
      raise exception 'setting_value_invalid' using errcode = '22023';
    end if;
    return new;
  end if;

  if new.key = 'seat_choice_enabled' then
    if pg_catalog.jsonb_typeof(new.value) is distinct from 'boolean' then
      raise exception 'setting_value_invalid' using errcode = '22023';
    end if;
    return new;
  end if;

  v_limit := app_private.unit_setting_value_limit(new.key);
  if v_limit is null then
    return new;
  end if;
  if pg_catalog.jsonb_typeof(new.value) is distinct from 'string' then
    raise exception 'setting_value_invalid' using errcode = '22023';
  end if;
  v_text := new.value #>> '{}';
  if pg_catalog.char_length(v_text) > v_limit or v_text ~ '[\x01-\x08\x0b-\x1f\x7f]' then
    raise exception 'setting_value_invalid' using errcode = '22023';
  end if;
  return new;
end
$$;

revoke all on function app_private.guard_unit_setting_value() from public, anon, authenticated, service_role;

commit;

-- Rollback (migration nova): recriar as duas funções como na 20261029120100.
-- Linhas seat_choice_enabled já gravadas podem ficar: sem a chave na classe,
-- só deixam de ser editáveis pela Gestão.
