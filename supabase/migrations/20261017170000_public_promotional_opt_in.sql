-- Public form consent is written only by the trusted reservation/waitlist EFs.
begin;

create or replace function public.record_public_promotional_opt_in(
  p_unit_id uuid,
  p_customer_id uuid,
  p_reference text
)
returns bigint language plpgsql security definer set search_path='' as $$
declare
  v_org uuid;
  v_resource_id uuid;
  v_revision bigint;
begin
  -- The customer lock serializes revisions with manual consent and opt-out.
  select c.organization_id into v_org
    from public.customers c
   where c.id=p_customer_id and c.deleted_at is null
   for update;
  if not found then
    raise exception 'public_promotional_opt_in_forbidden' using errcode='42501';
  end if;

  perform 1 from public.units u
    join public.organizations o on o.id=u.organization_id
   where u.id=p_unit_id and u.organization_id=v_org
     and u.is_public=true and o.is_public=true
   for share of u,o;
  if not found then
    raise exception 'public_promotional_opt_in_forbidden' using errcode='42501';
  end if;

  if p_reference is null or char_length(p_reference) not between 1 and 512
    or p_reference ~ '[[:cntrl:]]'
    or p_reference like '%/preferencias/mensagens/%'
    or p_reference !~ '^(reservation|waitlist):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12};form:v1$' then
    raise exception 'public_promotional_opt_in_invalid' using errcode='22023';
  end if;

  v_resource_id := split_part(split_part(p_reference,':',2),';',1)::uuid;
  if p_reference like 'reservation:%' then
    perform 1 from public.reservations r
     where r.id=v_resource_id and r.unit_id=p_unit_id and r.customer_id=p_customer_id
     for share;
  else
    perform 1 from public.waitlist w
     where w.id=v_resource_id and w.unit_id=p_unit_id and w.customer_id=p_customer_id
     for share;
  end if;
  if not found then
    raise exception 'public_promotional_opt_in_forbidden' using errcode='42501';
  end if;

  -- A retry of the same form submission must not override a later opt-out.
  -- The customer lock also serializes concurrent requests for this evidence.
  select e.revision into v_revision
    from public.whatsapp_message_consent_events e
   where e.unit_id=p_unit_id and e.customer_id=p_customer_id
     and e.purpose='promotional' and e.decision='opt_in'
     and e.source_code='public_form' and e.evidence_reference=p_reference
   order by e.revision
   limit 1;
  if found then
    if v_revision>9007199254740991 then
      raise exception 'public_promotional_opt_in_dependency' using errcode='PT503';
    end if;
    return v_revision;
  end if;

  -- The existing trigger assigns the next revision under the customer lock.
  insert into public.whatsapp_message_consent_events(
    unit_id,customer_id,purpose,decision,source_code,evidence_reference,actor_id,observed_at
  ) values (
    p_unit_id,p_customer_id,'promotional','opt_in','public_form',p_reference,null,clock_timestamp()
  ) returning revision into v_revision;
  if v_revision>9007199254740991 then
    raise exception 'public_promotional_opt_in_dependency' using errcode='PT503';
  end if;

  insert into public.audit_log(table_name,record_id,action,new_values,actor_id,unit_id,organization_id)
  values(
    'whatsapp_message_consent_events',p_customer_id::text,'INSERT',
    jsonb_build_object('purpose','promotional','decision','opt_in','revision',v_revision),
    null,p_unit_id,v_org
  );
  return v_revision;
end $$;
revoke all on function public.record_public_promotional_opt_in(uuid,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.record_public_promotional_opt_in(uuid,uuid,text)
  to service_role;

commit;
