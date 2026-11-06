-- Canal do WhatsApp não muda de unidade depois de criado.
--
-- Links de escolha de mesa, jobs, bindings de template, eventos e grants Datafy
-- apontam para o canal assumindo a unidade dele; trocar whatsapp_channels.unit_id
-- deixaria tudo isso ligado a outra unidade. Nenhum fluxo legítimo faz isso:
-- trocar de unidade é criar canal novo na unidade certa. Excluir a unidade
-- continua apagando o canal pela FK (DELETE, não UPDATE).
--
-- Rollback (migration nova):
--   drop trigger if exists whatsapp_channels_unit_immutable on public.whatsapp_channels;
--   drop function if exists app_private.guard_whatsapp_channel_unit();
begin;

create or replace function app_private.guard_whatsapp_channel_unit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.unit_id is distinct from old.unit_id then
    raise exception 'whatsapp_channel_unit_immutable' using errcode = '42501';
  end if;
  return new;
end
$$;
comment on function app_private.guard_whatsapp_channel_unit() is
  'Recusa qualquer mudança de whatsapp_channels.unit_id (42501 whatsapp_channel_unit_immutable), para todos os papéis e provedores. Trocar de unidade = criar canal novo.';
revoke all on function app_private.guard_whatsapp_channel_unit() from public, anon, authenticated, service_role;

drop trigger if exists whatsapp_channels_unit_immutable on public.whatsapp_channels;
create trigger whatsapp_channels_unit_immutable
  before update of unit_id on public.whatsapp_channels
  for each row execute function app_private.guard_whatsapp_channel_unit();

commit;
