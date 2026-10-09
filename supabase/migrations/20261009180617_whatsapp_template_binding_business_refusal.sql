-- Business conflict requires a separate reconciliation transaction (MAIN141).
create or replace function public.bind_whatsapp_template_account(p_channel_id uuid,p_unit_id uuid,p_provider text,p_credential_revision bigint,p_phone_number_id text,p_waba_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.whatsapp_channels%rowtype; b public.whatsapp_template_bindings%rowtype; a public.whatsapp_template_accounts%rowtype; v_org uuid;
begin
  if p_provider<>'datafy' or p_waba_id is null or p_waba_id !~ '^[0-9]{1,64}$' then raise exception 'template_binding_refused' using errcode='42501'; end if;
  select u.organization_id into v_org from public.whatsapp_channels ch join public.units u on u.id=ch.unit_id where ch.id=p_channel_id and ch.unit_id=p_unit_id;
  if not found then raise exception 'template_binding_refused' using errcode='42501'; end if;
  insert into public.whatsapp_template_accounts(organization_id,waba_id,verified_at) values(v_org,p_waba_id,clock_timestamp()) on conflict(waba_id) do nothing;
  select * into a from public.whatsapp_template_accounts where waba_id=p_waba_id for update;
  if a.organization_id is distinct from v_org then raise exception 'template_binding_refused' using errcode='42501'; end if;
  select * into b from public.whatsapp_template_bindings where channel_id=p_channel_id for update;
  if found and b.account_id is distinct from a.id then raise exception 'template_binding_refused' using errcode='42501'; end if;
  select * into c from public.whatsapp_channels where id=p_channel_id for share;
  if c.id is null or (c.unit_id,c.provider,c.template_credential_revision) is distinct from (p_unit_id,p_provider,p_credential_revision)
    or c.credentials->>'phone_number_id' is distinct from p_phone_number_id or p_phone_number_id is null
    or c.status<>'connected' or not exists(select from public.units where id=c.unit_id and organization_id=v_org) then
    raise exception 'template_binding_refused' using errcode='42501';
  end if;
  if b.id is not null and b.channel_credential_revision<>c.template_credential_revision then
    -- Caller must first reconcile in a separate ordered transaction.
    raise exception 'template_binding_changed' using errcode='PT409';
  end if;
  insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider,verified_at,channel_credential_revision)
    values(c.unit_id,c.id,a.id,c.provider,clock_timestamp(),c.template_credential_revision)
    on conflict(channel_id) do update set verified_at=excluded.verified_at
      where whatsapp_template_bindings.account_id=excluded.account_id and whatsapp_template_bindings.channel_credential_revision=excluded.channel_credential_revision
    returning * into b;
  if not found then raise exception 'template_binding_refused' using errcode='42501'; end if;
  update public.whatsapp_template_accounts set verified_at=clock_timestamp() where id=a.id;
  return jsonb_build_object('accountId',a.id,'generation',b.generation);
end $$;
revoke all on function public.bind_whatsapp_template_account(uuid,uuid,text,bigint,text,text) from public,anon,authenticated,service_role;
grant execute on function public.bind_whatsapp_template_account(uuid,uuid,text,bigint,text,text) to service_role;
