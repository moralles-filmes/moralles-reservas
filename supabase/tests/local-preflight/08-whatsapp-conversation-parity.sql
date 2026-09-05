-- CP-1..9 — timeline idempotente, handoff/claim, cutover fail-closed e ACL.

create table if not exists public.conversations (
  id uuid primary key,
  unit_id uuid,
  customer_id uuid,
  messages jsonb not null default '[]'::jsonb,
  status text not null default 'ai_active',
  handoff_at timestamptz,
  handoff_reason text,
  last_silenced_reply_at timestamptz,
  ai_lock_token text,
  ai_lock_until timestamptz,
  last_message_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.conversations
  alter column id set default gen_random_uuid(),
  add column if not exists contact_name text,
  add column if not exists wa_chat_lid text;

create table if not exists public.customers (
  id uuid primary key,
  organization_id uuid not null,
  name text not null,
  phone text not null
);

insert into public.customers (id, organization_id, name, phone)
values (
  'ffffffff-0000-0000-0000-000000000001',
  'aaaaaaaa-0000-0000-0000-000000000003',
  'Cliente CP',
  '11999999999'
)
on conflict (id) do nothing;

insert into public.conversations (id, unit_id, messages, status, last_message_at)
values (
  'eeeeeeee-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001',
  '[]'::jsonb,
  'ai_active',
  '2026-09-05T15:00:00Z'
)
on conflict (id) do update set
  unit_id = excluded.unit_id,
  messages = '[]'::jsonb,
  status = 'ai_active',
  handoff_at = null,
  handoff_reason = null,
  last_silenced_reply_at = null,
  ai_lock_token = 'turno-antigo',
  ai_lock_until = now() + interval '90 seconds',
  last_message_at = '2026-09-05T15:00:00Z';

select public.append_conversation_message(
  'eeeeeeee-0000-0000-0000-000000000001',
  '{"event_id":"cp-user-1","role":"user","author":"customer","content":"anterior","timestamp":"2026-09-05T14:00:00Z"}'::jsonb
);
select public.append_conversation_message(
  'eeeeeeee-0000-0000-0000-000000000001',
  '{"event_id":"cp-user-1","role":"user","author":"customer","content":"anterior","timestamp":"2026-09-05T14:00:00Z"}'::jsonb
);

do $$
declare
  v_last timestamptz;
  v_count integer;
begin
  select last_message_at, jsonb_array_length(messages)
  into v_last, v_count
  from public.conversations
  where id = 'eeeeeeee-0000-0000-0000-000000000001';

  if v_last <> '2026-09-05T15:00:00Z'::timestamptz or v_count <> 1 then
    raise exception 'CP-1: append atrasado regrediu last_message_at ou não foi persistido';
  end if;
end $$;

select public.record_whatsapp_human_message(
  'eeeeeeee-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001',
  '{"event_id":"cp-human-1","role":"human","author":"human","content":"resposta da loja","timestamp":"2026-09-05T16:00:00Z"}'::jsonb,
  'atendente respondeu pelo WhatsApp da loja'
);
select public.record_whatsapp_human_message(
  'eeeeeeee-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001',
  '{"event_id":"cp-human-1","role":"human","author":"human","content":"resposta da loja","timestamp":"2026-09-05T16:00:00Z"}'::jsonb,
  'atendente respondeu pelo WhatsApp da loja'
);

do $$
declare
  v_row public.conversations%rowtype;
begin
  select * into v_row
  from public.conversations
  where id = 'eeeeeeee-0000-0000-0000-000000000001';

  if v_row.status <> 'human_active'
     or v_row.handoff_at is null
     or v_row.last_silenced_reply_at is null
     or v_row.ai_lock_token is not null
     or v_row.ai_lock_until is not null
     or v_row.last_message_at <> '2026-09-05T16:00:00Z'::timestamptz
     or jsonb_array_length(v_row.messages) <> 2 then
    raise exception 'CP-2: mensagem humana e handoff não foram gravados atomicamente';
  end if;
end $$;

do $$
begin
  if (select jsonb_array_length(messages) from public.conversations
      where id = 'eeeeeeee-0000-0000-0000-000000000001') <> 2 then
    raise exception 'CP-9: retry idempotente duplicou mensagem na timeline';
  end if;
end $$;

do $$
begin
  begin
    perform public.record_whatsapp_human_message(
      'eeeeeeee-0000-0000-0000-000000000001',
      'bbbbbbbb-0000-0000-0000-000000000001',
      '{"role":"assistant","author":"ai","content":"inválida","timestamp":"2026-09-05T17:00:00Z"}'::jsonb,
      'inválida'
    );
    raise exception 'CP-3: RPC aceitou mensagem que não é humana';
  exception when raise_exception then
    if sqlerrm = 'CP-3: RPC aceitou mensagem que não é humana' then raise; end if;
  end;
end $$;

do $$
begin
  begin
    perform public.record_whatsapp_human_message(
      'eeeeeeee-0000-0000-0000-000000000001',
      'bbbbbbbb-0000-0000-0000-000000000099',
      '{"role":"human","author":"human","content":"tenant errado","timestamp":"2026-09-05T17:00:00Z"}'::jsonb,
      'tenant errado'
    );
    raise exception 'CP-4: RPC aceitou conversa de outra unidade';
  exception when raise_exception then
    if sqlerrm = 'CP-4: RPC aceitou conversa de outra unidade' then raise; end if;
  end;
end $$;

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  left join pg_roles r on r.oid = a.grantee
  where n.nspname = 'public'
    and p.proname in (
      'append_conversation_message',
      'record_whatsapp_human_message',
      'release_processed_whatsapp_message_claim',
      'enforce_whatsapp_conversation_parity_on_activation',
      'get_or_create_whatsapp_conversation'
    )
    and (a.grantee = 0 or r.rolname in ('anon', 'authenticated'))
    and a.privilege_type = 'EXECUTE';

  if v_count <> 0 then
    raise exception 'CP-5: RPC de conversa exposta a anon/authenticated';
  end if;
end $$;

-- Chamadas concorrentes/duplicadas resolvem a mesma conversa por unit+customer.
do $$
declare
  v_first uuid;
  v_second uuid;
  v_count integer;
begin
  v_first := public.get_or_create_whatsapp_conversation(
    'ffffffff-0000-0000-0000-000000000001',
    'bbbbbbbb-0000-0000-0000-000000000003',
    'Cliente CP',
    'cp-lid'
  );
  v_second := public.get_or_create_whatsapp_conversation(
    'ffffffff-0000-0000-0000-000000000001',
    'bbbbbbbb-0000-0000-0000-000000000003',
    'Cliente CP',
    'cp-lid'
  );
  select count(*) into v_count
  from public.conversations
  where unit_id = 'bbbbbbbb-0000-0000-0000-000000000003'
    and customer_id = 'ffffffff-0000-0000-0000-000000000001';
  if v_first is distinct from v_second or v_count <> 1 then
    raise exception 'CP: resolver de conversa criou duplicata';
  end if;
end $$;

-- Claim incompleto pode ser liberado somente pela cerca correta.
do $$
declare
  v_claim uuid;
begin
  select claim_id into v_claim
  from public.claim_processed_whatsapp_message(
    'zapi', 'cp-release-1', 'bbbbbbbb-0000-0000-0000-000000000001', 90
  );
  if v_claim is null then raise exception 'CP-6: claim não foi criado'; end if;
  if public.release_processed_whatsapp_message_claim('zapi', 'cp-release-1', gen_random_uuid()) then
    raise exception 'CP-6: cerca errada liberou claim';
  end if;
  if not public.release_processed_whatsapp_message_claim('zapi', 'cp-release-1', v_claim) then
    raise exception 'CP-6: cerca correta não liberou claim';
  end if;
end $$;

-- Canal novo conectado não pode cortar sem prova de paridade.
do $$
declare
  v_id uuid := gen_random_uuid();
  v_active boolean;
begin
  insert into public.whatsapp_channels (id, unit_id, provider, status, credentials)
  values (
    v_id,
    'bbbbbbbb-0000-0000-0000-000000000003',
    'zapi',
    'disconnected',
    '{}'::jsonb
  )
  returning is_active into v_active;

  if v_active is distinct from false then
    raise exception 'CP-7: writer que omite is_active não nasceu fail-closed';
  end if;
  delete from public.whatsapp_channels where id = v_id;
end $$;

update public.whatsapp_channels
set status = 'connected', is_active = false, manual_echo_verified_at = null,
    manual_echo_verification_source = null
where id = 'dddddddd-0000-0000-0000-000000000006';

do $$
begin
  begin
    update public.whatsapp_channels set is_active = true
    where id = 'dddddddd-0000-0000-0000-000000000006';
    raise exception 'CP-8: canal sem prova de eco foi ativado';
  exception when check_violation then null;
  end;
end $$;

update public.whatsapp_channels
set manual_echo_verified_at = now(),
    manual_echo_verification_source = 'provider_callback',
    is_active = true
where id = 'dddddddd-0000-0000-0000-000000000006';

do $$
begin
  if not exists (
    select 1 from public.whatsapp_channels
    where id = 'dddddddd-0000-0000-0000-000000000006'
      and is_active is true and manual_echo_verified_at is not null
  ) then
    raise exception 'CP-9: canal comprovado não foi ativado';
  end if;
end $$;
