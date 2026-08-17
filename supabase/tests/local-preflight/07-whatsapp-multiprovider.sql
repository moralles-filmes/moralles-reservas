-- Preflight comportamental da migration multi-provider/UazAPI.
-- Roda depois da migration e de 02-seed.sql, com ON_ERROR_STOP=1.

do $$
declare
  v_active uuid;
begin
  select id into v_active from whatsapp_channels
  where unit_id = 'bbbbbbbb-0000-0000-0000-000000000001' and is_active is true;
  if v_active <> 'dddddddd-0000-0000-0000-000000000001' then
    raise exception 'MP-1: unidade com canal unico nao foi ativada';
  end if;

  select id into v_active from whatsapp_channels
  where unit_id = 'bbbbbbbb-0000-0000-0000-000000000002' and is_active is true;
  if v_active <> 'dddddddd-0000-0000-0000-000000000002' then
    raise exception 'MP-2: unico connected nao foi ativado';
  end if;

  if exists (
    select 1 from whatsapp_channels
    where unit_id = 'bbbbbbbb-0000-0000-0000-000000000003' and is_active is not null
  ) then
    raise exception 'MP-3: unidade ambigua foi escolhida silenciosamente';
  end if;
end;
$$;

insert into whatsapp_channels (
  id, unit_id, provider, status, credentials, is_active
) values (
  'dddddddd-0000-0000-0000-000000000006',
  'bbbbbbbb-0000-0000-0000-000000000003',
  'uazapi', 'disconnected', '{}'::jsonb, false
);

-- Credencial UazAPI em JSONB é regressão e precisa falhar.
do $$ begin
  begin
    insert into whatsapp_channels (unit_id, provider, credentials)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'uazapi', '{"token":"nao-pode"}'::jsonb);
    raise exception 'MP-4: credentials UazAPI nao vazio foi aceito';
  exception when check_violation then null;
  end;
end $$;

-- Uma única linha UazAPI por unidade.
do $$ begin
  begin
    insert into whatsapp_channels (unit_id, provider)
    values ('bbbbbbbb-0000-0000-0000-000000000003', 'uazapi');
    raise exception 'MP-5: segunda linha UazAPI da unidade foi aceita';
  exception when unique_violation then null;
  end;
end $$;

set role service_role;

select set_organization_default_whatsapp_provider(
  'aaaaaaaa-0000-0000-0000-000000000003', 'uazapi',
  '11111111-1111-1111-1111-111111111111', 'preflight.default'
);

do $$
declare
  v_claim_id uuid;
begin
  select claim_id into v_claim_id
  from claim_whatsapp_channel_provisioning(
    'dddddddd-0000-0000-0000-000000000006',
    '11111111-1111-1111-1111-111111111111',
    120,
    'preflight.vault-claim'
  )
  where claimed;
  if v_claim_id is null then
    raise exception 'MP-5a: claim para Vault nao foi adquirido';
  end if;
  perform store_whatsapp_channel_instance_token(
    'dddddddd-0000-0000-0000-000000000006',
    v_claim_id,
    'fixture-uazapi-value',
    '11111111-1111-1111-1111-111111111111',
    'preflight.vault'
  );
  perform release_whatsapp_channel_provisioning(
    'dddddddd-0000-0000-0000-000000000006',
    v_claim_id,
    'disconnected',
    null,
    null,
    null,
    '11111111-1111-1111-1111-111111111111',
    'preflight.vault-release'
  );
end;
$$;

-- Uma unidade que já tem ativo explícito não pode sofrer cutover só porque um
-- canal preparado ficou connected; begin_switch precisa persistir intenção.
insert into whatsapp_channels (
  id, unit_id, provider, status, credentials, is_active
) values (
  'dddddddd-0000-0000-0000-000000000007',
  'bbbbbbbb-0000-0000-0000-000000000001',
  'uazapi', 'connected', '{}'::jsonb, false
);

do $$ begin
  begin
    perform activate_whatsapp_channel(
      'bbbbbbbb-0000-0000-0000-000000000001',
      'dddddddd-0000-0000-0000-000000000007',
      '11111111-1111-1111-1111-111111111111',
      'preflight.no-intent'
    );
    raise exception 'MP-6: cutover sem intencao foi aceito';
  exception when check_violation then null;
  end;
end $$;

select request_whatsapp_channel_activation(
  'bbbbbbbb-0000-0000-0000-000000000003',
  'dddddddd-0000-0000-0000-000000000006',
  '11111111-1111-1111-1111-111111111111',
  'preflight.switch-intent'
);

do $$
declare v_value text;
begin
  select get_whatsapp_channel_instance_token(
    'dddddddd-0000-0000-0000-000000000006'
  ) into v_value;
  if v_value <> 'fixture-uazapi-value' then
    raise exception 'MP-7: roundtrip Vault falhou';
  end if;
end;
$$;

create temporary table mp_claim as
select * from claim_whatsapp_channel_provisioning(
  'dddddddd-0000-0000-0000-000000000006',
  '11111111-1111-1111-1111-111111111111', 120, 'preflight.claim'
);

do $$
declare
  v_first uuid;
  v_second uuid;
  v_claimed boolean;
begin
  select claim_id into v_first from mp_claim;
  if v_first is null or not (select claimed from mp_claim) then
    raise exception 'MP-8: primeiro claim nao foi adquirido';
  end if;

  -- Polling pode mudar o status, mas não o fence do provisionamento nem a
  -- intenção de cutover. O segundo click ainda enxerga o claim vigente.
  perform record_whatsapp_channel_status(
    'bbbbbbbb-0000-0000-0000-000000000003',
    'dddddddd-0000-0000-0000-000000000006',
    'connecting', null, null,
    '11111111-1111-1111-1111-111111111111', 'preflight.status'
  );

  select c.claimed, c.claim_id into v_claimed, v_second
  from claim_whatsapp_channel_provisioning(
    'dddddddd-0000-0000-0000-000000000006',
    '11111111-1111-1111-1111-111111111111', 120, 'preflight.double'
  ) c;
  if v_claimed or v_second <> v_first then
    raise exception 'MP-9: polling/double click criou outro claim';
  end if;

  begin
    perform release_whatsapp_channel_provisioning(
      'dddddddd-0000-0000-0000-000000000006', gen_random_uuid(),
      'waiting_qr', null, null, null,
      '11111111-1111-1111-1111-111111111111', 'preflight.stale'
    );
    raise exception 'MP-10: release com fence token errado foi aceito';
  exception when serialization_failure then null;
  end;

  perform release_whatsapp_channel_provisioning(
    'dddddddd-0000-0000-0000-000000000006', v_first,
    'waiting_qr', 'uaz-fixture-instance', null, null,
    '11111111-1111-1111-1111-111111111111', 'preflight.release'
  );
end;
$$;

-- Segundo ciclo de claim conclui como connected; QR expirado reutiliza a
-- mesma linha/instância em vez de criar outra.
create temporary table mp_claim_connected as
select * from claim_whatsapp_channel_provisioning(
  'dddddddd-0000-0000-0000-000000000006',
  '11111111-1111-1111-1111-111111111111', 120, 'preflight.reclaim'
);

select release_whatsapp_channel_provisioning(
  'dddddddd-0000-0000-0000-000000000006',
  (select claim_id from mp_claim_connected),
  'connected', 'uaz-fixture-instance', '5511999999999', null,
  '11111111-1111-1111-1111-111111111111', 'preflight.connected'
);

select activate_whatsapp_channel(
  'bbbbbbbb-0000-0000-0000-000000000003',
  'dddddddd-0000-0000-0000-000000000006',
  '11111111-1111-1111-1111-111111111111',
  'preflight.cutover'
);

reset role;

do $$
begin
  if (select count(*) from whatsapp_channels
      where unit_id = 'bbbbbbbb-0000-0000-0000-000000000003'
        and is_active is true) <> 1 then
    raise exception 'MP-11: cutover nao deixou exatamente um canal ativo';
  end if;
  if not (select is_active from whatsapp_channels
          where id = 'dddddddd-0000-0000-0000-000000000006') then
    raise exception 'MP-12: alvo do cutover nao ficou ativo';
  end if;
  if (select default_whatsapp_provider from organizations
      where id = 'aaaaaaaa-0000-0000-0000-000000000003') <> 'uazapi' then
    raise exception 'MP-13: default organizacional nao foi persistido';
  end if;
  if not exists (select 1 from whatsapp_channel_lifecycle_events
                 where event_type = 'activated'
                   and channel_ref = 'dddddddd-0000-0000-0000-000000000006') then
    raise exception 'MP-14: cutover nao foi auditado';
  end if;
  if (select activation_requested_at is not null from whatsapp_channels
      where id = 'dddddddd-0000-0000-0000-000000000006') then
    raise exception 'MP-15: cutover nao consumiu a intencao';
  end if;
end;
$$;

insert into processed_messages (provider, message_id) values
  ('zapi', 'same-provider-message'),
  ('uazapi', 'same-provider-message');

do $$ begin
  begin
    insert into processed_messages (provider, message_id)
    values ('uazapi', 'same-provider-message');
    raise exception 'MP-16: dedupe do mesmo provider foi aceito';
  exception when unique_violation then null;
  end;
end $$;

-- Ledger é append-only até para postgres/service internamente.
do $$ begin
  begin
    update whatsapp_channel_lifecycle_events set event_type = 'error'
    where channel_ref = 'dddddddd-0000-0000-0000-000000000006';
    raise exception 'MP-17: ledger foi reescrito';
  exception when check_violation then null;
  end;
end $$;

-- ACL estática: nenhuma RPC privilegiada pode ter EXECUTE de anon/authenticated.
do $$
declare v_count integer;
begin
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  join pg_roles r on r.oid = a.grantee
  where n.nspname = 'public'
    and p.proname in (
      'set_organization_default_whatsapp_provider',
      'store_whatsapp_channel_instance_token',
      'get_whatsapp_channel_instance_token',
      'claim_whatsapp_channel_provisioning',
      'release_whatsapp_channel_provisioning',
      'record_whatsapp_channel_status',
      'request_whatsapp_channel_activation',
      'activate_whatsapp_channel',
      'claim_processed_whatsapp_message',
      'complete_processed_whatsapp_message'
    )
    and r.rolname in ('anon', 'authenticated')
    and a.privilege_type = 'EXECUTE';
  if v_count <> 0 then
    raise exception 'MP-18: RPC privilegiada exposta a anon/authenticated';
  end if;
end;
$$;
