-- Instagram, Fase 1 (Task 1.4): `conversations` ganha canal e contato do
-- Instagram, `customer_id` passa a ser opcional (só para o Instagram), e as
-- duas leituras do WhatsApp que buscavam "a conversa do cliente na unidade"
-- ficam presas a `channel = 'whatsapp'`.
--
-- Spec:  docs/superpowers/specs/2026-10-19-instagram-modulo-design.md
-- Plano: docs/superpowers/plans/2026-10-20-instagram-fase-1-direct-conversas.md
--        (Task 1.4 e a tabela "Leitores de conversations.customer_id")
-- Pré-voo: supabase/tests/local-preflight/79a-instagram-bootstrap.sql e
--          79-instagram-module.sql (README, seção "79 — Módulo Instagram"),
--          casos IG-4.1..IG-4.7 e controles C-IG-4.x.
--
-- CAMINHO DE PRODUÇÃO DO WHATSAPP. O que muda para ele:
--   * linhas existentes recebem `channel = 'whatsapp'` pelo default (sem
--     reescrita: default constante) e `instagram_contact_id` nulo;
--   * o CHECK de identidade mantém `customer_id NOT NULL` para o WhatsApp;
--   * `get_or_create_whatsapp_conversation` e
--     `app_private.reconcile_whatsapp_automation_acceptance_inner` são cópias
--     VERBATIM dos corpos mais recentes (20260905143453:204 e
--     20261019183559:777), com UMA linha a mais cada: o filtro de canal.
--     Sem ele, um cliente com conversa do Instagram ligada teria o log de
--     automação e o `contact_name`/`wa_chat_lid` do WhatsApp gravados na
--     conversa do Instagram.
-- Nenhuma linha `channel = 'instagram'` existe antes do grant do piloto (último
-- passo do Bloco 6); os demais leitores do plano entram no mesmo release.
--
-- Tenant: a conversa do Instagram tira unidade, organização e cliente do
-- CONTATO (`instagram_contacts`, Task 1.2); as RPCs novas recebem só o id do
-- contato (e o do cliente, conferido contra a organização do contato).
--
-- Idempotente: `add column if not exists`, constraints recriadas por nome
-- (NOT VALID + VALIDATE), `create index if not exists`, `create or replace
-- function`, `drop trigger if exists` + `create`, revokes/grants reafirmados.
-- Sem URL do projeto e sem segredo.

begin;
set local lock_timeout = '5s';

-- ============================================================================
-- 1. Colunas
-- ============================================================================
alter table public.conversations
  add column if not exists channel text not null default 'whatsapp';
alter table public.conversations
  add column if not exists instagram_contact_id uuid;
alter table public.conversations
  alter column customer_id drop not null;

comment on column public.conversations.channel is
  'Canal da conversa: whatsapp (cliente obrigatorio) ou instagram (contato obrigatorio, cliente opcional). Imutavel (conversations_channel_guard).';
comment on column public.conversations.instagram_contact_id is
  'Contato do Direct (instagram_contacts) da conversa do Instagram; nulo no WhatsApp. Uma conversa por contato.';

-- ============================================================================
-- 2. Constraints (NOT VALID + VALIDATE, recriadas por nome)
-- ============================================================================
-- Tudo roda numa transação que já segura ACCESS EXCLUSIVE em `conversations`
-- desde o ADD COLUMN; o NOT VALID + VALIDATE segue o padrão do plano e deixa
-- explícito que as linhas existentes (todas `whatsapp` com cliente) foram
-- conferidas. O `lock_timeout` de 5s (logo após o `begin`) limita a espera
-- pelo lock: se o webhook ou o painel estiverem segurando a tabela, o ALTER
-- desiste em 5s, a migration aborta inteira (ROLLBACK, nada aplicado) e a
-- fila de escritas atrás dela é liberada. Repetir numa janela calma. Depois de
-- obtido o lock, as escritas concorrentes esperam o COMMIT (tabela pequena).
alter table public.conversations drop constraint if exists conversations_channel_check;
alter table public.conversations
  add constraint conversations_channel_check
  check (channel in ('whatsapp', 'instagram')) not valid;
alter table public.conversations validate constraint conversations_channel_check;

alter table public.conversations drop constraint if exists conversations_instagram_contact_id_fkey;
alter table public.conversations
  add constraint conversations_instagram_contact_id_fkey
  foreign key (instagram_contact_id) references public.instagram_contacts(id) on delete restrict not valid;
alter table public.conversations validate constraint conversations_instagram_contact_id_fkey;

alter table public.conversations drop constraint if exists conversations_channel_identity_check;
alter table public.conversations
  add constraint conversations_channel_identity_check
  check (
    (channel = 'whatsapp' and customer_id is not null and instagram_contact_id is null)
    or (channel = 'instagram' and instagram_contact_id is not null)
  ) not valid;
alter table public.conversations validate constraint conversations_channel_identity_check;

-- ============================================================================
-- 3. Índices
-- ============================================================================
create unique index if not exists conversations_instagram_contact_uidx
  on public.conversations (instagram_contact_id)
  where instagram_contact_id is not null;
create index if not exists conversations_unit_channel_status_idx
  on public.conversations (unit_id, channel, status);

-- ============================================================================
-- 4. Guarda de canal e tenant
-- ============================================================================
-- SECURITY INVOKER (como o guard do contato na Task 1.2): quem grava é o
-- `service_role` (BYPASSRLS) ou RPC DEFINER dona `postgres`; `authenticated`
-- não tem INSERT nem UPDATE nessas colunas (20261017160000), então nunca chega
-- aqui. Dispara só nas colunas de identidade: o append de mensagem e o handoff
-- não pagam a checagem.
--
-- Regras: canal e unidade imutáveis (qualquer canal); conversa IG na unidade
-- do contato e com o MESMO cliente do contato (nulo só se o contato não tem
-- cliente); cliente da organização da unidade. O link
-- (`link_instagram_contact_customer`) grava o contato antes da conversa, então
-- a conversa já encontra o cliente novo no contato. Apagar o cliente de fato
-- põe nulo no contato (`on delete set null`) e APAGA a conversa (FK
-- `customer_id … on delete cascade`): a conversa nunca é atualizada nesse
-- caminho.
create or replace function public.conversations_channel_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_contact_unit uuid;
  v_contact_cust uuid;
  v_unit_org     uuid;
  v_cust_org     uuid;
begin
  if tg_op = 'UPDATE' and new.channel is distinct from old.channel then
    raise exception 'conversations: canal e imutavel'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'UPDATE' and new.unit_id is distinct from old.unit_id then
    raise exception 'conversations: unidade e imutavel'
      using errcode = 'check_violation';
  end if;

  -- A forma (canal x cliente x contato) é do CHECK de identidade; aqui só o
  -- tenant do contato presente.
  if new.channel = 'instagram' and new.instagram_contact_id is not null then
    select c.unit_id, c.customer_id into v_contact_unit, v_contact_cust
      from public.instagram_contacts c where c.id = new.instagram_contact_id;
    if v_contact_unit is null or v_contact_unit is distinct from new.unit_id then
      raise exception 'conversations: contato do Instagram nao e da unidade da conversa'
        using errcode = 'check_violation';
    end if;
    if new.customer_id is distinct from v_contact_cust then
      raise exception 'conversations: cliente da conversa do Instagram nao e o do contato'
        using errcode = 'check_violation';
    end if;
  end if;

  if new.customer_id is not null then
    select u.organization_id into v_unit_org from public.units u where u.id = new.unit_id;
    select cu.organization_id into v_cust_org from public.customers cu where cu.id = new.customer_id;
    if v_cust_org is null or v_cust_org is distinct from v_unit_org then
      raise exception 'conversations: cliente nao e da organizacao da unidade'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists conversations_channel_guard on public.conversations;
create trigger conversations_channel_guard
  before insert or update of channel, instagram_contact_id, customer_id, unit_id
  on public.conversations
  for each row execute function public.conversations_channel_guard();

-- ============================================================================
-- 5. RPCs do WhatsApp presas ao canal (corpos verbatim + filtro de canal)
-- ============================================================================
-- get_or_create_whatsapp_conversation: corpo verbatim de
-- 20260905143453_whatsapp_conversation_provider_parity.sql:202-256, mais a
-- linha "and channel = 'whatsapp'" na busca. O INSERT continua sem citar a
-- coluna: o default 'whatsapp' é o canal da conversa nova.
-- Serializa lookup-or-create sem depender de um índice novo que poderia falhar
-- sobre duplicatas históricas. O advisory lock vive só nesta transação/RPC.
create or replace function public.get_or_create_whatsapp_conversation(
  p_customer_id uuid,
  p_unit_id uuid,
  p_contact_name text default null,
  p_chat_lid text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not exists (
    select 1
    from public.customers c
    join public.units u on u.organization_id = c.organization_id
    where c.id = p_customer_id and u.id = p_unit_id
  ) then
    raise exception 'conversation_tenant_mismatch';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_unit_id::text || ':' || p_customer_id::text, 0));

  select id into v_id
  from public.conversations
  where customer_id = p_customer_id and unit_id = p_unit_id
    and channel = 'whatsapp'
  order by updated_at desc, id
  limit 1;

  if v_id is null then
    insert into public.conversations (customer_id, unit_id, messages, contact_name, wa_chat_lid)
    values (p_customer_id, p_unit_id, '[]'::jsonb, p_contact_name, p_chat_lid)
    returning id into v_id;
  else
    update public.conversations
    set contact_name = coalesce(nullif(p_contact_name, ''), contact_name),
        wa_chat_lid = coalesce(nullif(p_chat_lid, ''), wa_chat_lid),
        updated_at = now()
    where id = v_id;
  end if;

  return v_id;
end;
$$;

revoke all on function public.get_or_create_whatsapp_conversation(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.get_or_create_whatsapp_conversation(uuid, uuid, text, text)
  to service_role;

comment on function public.get_or_create_whatsapp_conversation(uuid, uuid, text, text) is
  'Lookup-or-create unit/customer serializado e tenant-safe para webhooks concorrentes.';

-- reconcile de aceitação: corpo verbatim de
-- 20261019183559_whatsapp_legacy_managed_intent_fence.sql:776-921, mais a
-- linha "and conversation.channel = 'whatsapp'" no exists da dedupe do
-- histórico (a conversa do Instagram do mesmo cliente não conta).
-- Corpo congelado de 20261017150000_whatsapp_automation_failed_notification_adoption.sql, linhas 5-148; acesso somente pelo wrapper guardado.
create or replace function app_private.reconcile_whatsapp_automation_acceptance_inner(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  j public.whatsapp_automation_jobs%rowtype;
  c public.customers%rowtype;
  v_customer uuid;
  v_unit uuid;
  v_fence uuid;
  v_conversation uuid;
  v_notification uuid;
  v_legacy_notification uuid;
  v_count integer;
  v_history text;
begin
  -- Discovery is not authority: reread the job after every parent wait.
  select * into j from public.whatsapp_automation_jobs where id=p_job_id;
  if not found then
    return jsonb_build_object('state','not_accepted','reason','job_not_found');
  end if;
  v_customer:=j.customer_id; v_unit:=j.unit_id; v_fence:=j.claim_token;
  if v_customer is not null then
    select * into c from public.customers where id=v_customer for update;
    if j.kind in('waitlist_feedback','voucher_issued') then
      perform 1 from public.whatsapp_promotion_slots
        where unit_id=v_unit and customer_id=v_customer and job_id=p_job_id
          and claim_token=v_fence for update;
    end if;
  end if;
  select * into j from public.whatsapp_automation_jobs where id=p_job_id for update;
  if not found then
    return jsonb_build_object('state','not_accepted','reason','job_not_found');
  end if;
  if j.pin_phase is distinct from 'bound' or j.state not in('accepted','reconciled') then
    return jsonb_build_object('state','not_accepted','reason','acceptance_not_recorded');
  end if;
  -- A formerly complete projection can lose its channel FK later. Any new
  -- deferral must remain visible even when the job was locally reconciled.
  update public.whatsapp_automation_jobs set state='accepted',reconcile_required=true where id=j.id;
  if j.posting_started_at is null or j.claim_token is null or j.finished_at is null
    or j.provider_message_id is null or char_length(j.provider_message_id) not between 1 and 512
    or j.provider_message_id ~ '[[:cntrl:]]' then
    return jsonb_build_object('state','deferred','reason','acceptance_evidence_missing');
  end if;
  -- Do not acquire a different earlier parent after the job lock.
  if j.unit_id is distinct from v_unit or j.claim_token is distinct from v_fence
    or (j.customer_id is distinct from v_customer and j.customer_erased_at is null) then
    return jsonb_build_object('state','deferred','reason','acceptance_identity_changed');
  end if;
  if not exists(select from public.units where id=j.unit_id and organization_id=j.organization_id) then
    return jsonb_build_object('state','deferred','reason','customer_scope_invalid');
  end if;
  if j.customer_erased_at is not null then
    if j.customer_id is not null or j.safe_log_body is not null then
      return jsonb_build_object('state','deferred','reason','customer_scope_invalid');
    end if;
    v_history:='skipped_erased';
  elsif j.customer_id is null then
    -- Only an operational entry may never have had a known customer.
    if j.kind not in('waitlist_entered','waitlist_table_ready') then
      return jsonb_build_object('state','deferred','reason','customer_scope_invalid');
    end if;
    v_history:='skipped_no_customer';
  elsif c.id is distinct from j.customer_id or c.deleted_at is not null
    or c.organization_id is distinct from j.organization_id then
    return jsonb_build_object('state','deferred','reason','customer_scope_invalid');
  elsif j.safe_log_body is null or char_length(j.safe_log_body) not between 1 and 4096 then
    return jsonb_build_object('state','deferred','reason','acceptance_evidence_missing');
  else
    v_history:='recorded';
  end if;

  -- Historical channel identity is retained. Never substitute the active channel.
  if not exists(select from public.whatsapp_channels where id=j.channel_id and unit_id=j.unit_id) then
    return jsonb_build_object('state','deferred','reason','notification_channel_missing');
  end if;
  -- The pre-ledger sender may have left one failed row under the natural key.
  -- Adopt only that unaccepted projection; never erase delivered/read evidence.
  -- The job lock is already held, and the row lock serializes concurrent repairs.
  select n.id into v_legacy_notification from public.notifications_sent n
    where n.unit_id=j.unit_id and n.kind=j.kind
      and (j.reservation_id is not null or j.waitlist_id is not null)
      and n.reservation_id is not distinct from j.reservation_id
      and n.waitlist_id is not distinct from j.waitlist_id
    for update;
  if v_legacy_notification is not null and v_legacy_notification<>j.notification_id then
    update public.notifications_sent n set
      id=j.notification_id,status='sent',sent_at=j.finished_at,error=null,failed_at=null,
      whatsapp_provider=j.provider,whatsapp_channel_id=j.channel_id,
      provider_message_id=j.provider_message_id
      where n.id=v_legacy_notification and n.unit_id=j.unit_id and n.kind=j.kind
        and n.reservation_id is not distinct from j.reservation_id
        and n.waitlist_id is not distinct from j.waitlist_id
        and n.status='failed' and n.provider_message_id is null
        and n.delivered_at is null and n.read_at is null
        and not exists (select from public.notifications_sent other where other.id=j.notification_id)
      returning n.id into v_notification;
    if v_notification is distinct from j.notification_id then
      return jsonb_build_object('state','deferred','reason','notification_conflict');
    end if;
  else
    insert into public.notifications_sent(id,unit_id,reservation_id,waitlist_id,kind,status,sent_at,
      whatsapp_provider,whatsapp_channel_id,provider_message_id)
      values(j.notification_id,j.unit_id,j.reservation_id,j.waitlist_id,j.kind,'sent',j.finished_at,
        j.provider,j.channel_id,j.provider_message_id)
      on conflict do nothing;
  end if;
  -- Exact frozen UUID plus resource and all four correlation fields. A legacy
  -- row with prior acceptance evidence remains a visible conflict.
  update public.notifications_sent n set sent_at=n.sent_at
    where n.id=j.notification_id and n.unit_id=j.unit_id and n.kind=j.kind
      and n.reservation_id is not distinct from j.reservation_id
      and n.waitlist_id is not distinct from j.waitlist_id
      and n.whatsapp_provider=j.provider and n.whatsapp_channel_id=j.channel_id
      and n.provider_message_id=j.provider_message_id
    returning n.id into v_notification;
  get diagnostics v_count=row_count;
  if v_count<>1 or v_notification is distinct from j.notification_id then
    return jsonb_build_object('state','deferred','reason','notification_conflict');
  end if;

  if v_history='recorded' then
    -- Same unit/customer key as the historical get-or-create helper. Its latest
    -- conversation may change; append's own event dedupe is only per row.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(j.unit_id::text||':'||j.customer_id::text,0));
    if not exists(
      select from public.conversations conversation
        cross join lateral jsonb_array_elements(coalesce(conversation.messages,'[]'::jsonb)) item
      where conversation.unit_id=j.unit_id and conversation.customer_id=j.customer_id
        and conversation.channel = 'whatsapp'
        and item->>'event_id'='automation:'||j.id::text||':accepted'
    ) then
      v_conversation:=public.get_or_create_whatsapp_conversation(j.customer_id,j.unit_id,null,null);
      perform public.append_conversation_message(v_conversation,jsonb_build_object(
        'event_id','automation:'||j.id::text||':accepted','role','assistant','author','automation',
        'content',j.safe_log_body,'timestamp',j.finished_at,'kind',j.kind));
    end if;
  end if;
  -- An exception above rolls back notification/history together, while the
  -- acceptance committed by finish in its earlier transaction remains intact.
  update public.whatsapp_automation_jobs set state='reconciled',reconcile_required=false,error_code=null
    where id=j.id and state in('accepted','reconciled') and provider_message_id=j.provider_message_id;
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'acceptance_projection_changed' using errcode='P0A17'; end if;
  return jsonb_build_object('state','reconciled','history',v_history);
end $$;
revoke all on function app_private.reconcile_whatsapp_automation_acceptance_inner(uuid) from public,anon,authenticated,service_role;

-- ============================================================================
-- 6. RPCs do Instagram (service_role)
-- ============================================================================
-- Uma conversa por contato. O `for update` no contato serializa chamadas
-- concorrentes do mesmo contato e a anonimização dele (que é UPDATE na linha);
-- o índice único parcial é a rede de segurança. Unidade e cliente vêm do
-- contato. Contato anonimizado é recusado (42501), inexistente dá P0002.
-- Na conversa já existente só o `contact_name` é renovado, e só se mudou.
create or replace function public.get_or_create_instagram_conversation(p_contact_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_unit     uuid;
  v_customer uuid;
  v_name     text;
  v_username text;
  v_anon     timestamptz;
  v_contact  text;
  v_id       uuid;
begin
  if p_contact_id is null then
    raise exception 'invalid_instagram_contact_argument' using errcode = '22023';
  end if;

  select c.unit_id, c.customer_id, c.name, c.username, c.anonymized_at
    into v_unit, v_customer, v_name, v_username, v_anon
    from public.instagram_contacts c
   where c.id = p_contact_id
   for update;
  if v_unit is null then
    raise exception 'instagram_contact_not_found' using errcode = 'P0002';
  end if;
  if v_anon is not null then
    raise exception 'instagram_contact_anonymized' using errcode = '42501';
  end if;

  v_contact := coalesce(v_name, '@' || v_username);

  select cv.id into v_id
    from public.conversations cv
   where cv.instagram_contact_id = p_contact_id;

  if v_id is null then
    insert into public.conversations (unit_id, customer_id, channel, instagram_contact_id, messages, contact_name)
    values (v_unit, v_customer, 'instagram', p_contact_id, '[]'::jsonb, v_contact)
    returning id into v_id;
  elsif v_contact is not null then
    update public.conversations cv
       set contact_name = v_contact
     where cv.id = v_id
       and cv.contact_name is distinct from v_contact;
  end if;

  return v_id;
end;
$$;

-- Liga (ou religa) o contato a um cliente vivo da organização do contato e
-- espelha o cliente na conversa do contato. Contato inexistente ou
-- anonimizado, cliente de outra organização, apagado ou inexistente: o MESMO
-- 42501.
--
-- Ordem de locks: CLIENTE antes do CONTATO, a mesma do caminho do soft delete
-- (UPDATE de `customers.deleted_at` -> trigger da Task 1.2 -> UPDATE do
-- contato). Ordem inversa abriria deadlock link x anonimização. Por isso a
-- organização do contato é lida SEM lock, o `for share` no cliente vem
-- primeiro (o soft delete dele espera o link, e o trigger alcança o contato
-- já ligado), e só então o `for update` no contato, com TODAS as condições
-- conferidas de novo sob os dois locks (contato não anonimizado, mesma
-- organização, cliente vivo).
create or replace function public.link_instagram_contact_customer(p_contact_id uuid, p_customer_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org  uuid;
  v_org2 uuid;
  v_anon timestamptz;
  v_ok   uuid;
  v_n    integer;
begin
  -- 1. Organização do contato, sem lock.
  select c.organization_id into v_org
    from public.instagram_contacts c
   where c.id = p_contact_id;

  -- 2. Cliente primeiro: vivo e da organização do contato.
  if v_org is not null and p_customer_id is not null then
    select cu.id into v_ok
      from public.customers cu
     where cu.id = p_customer_id
       and cu.organization_id = v_org
       and cu.deleted_at is null
     for share;
  end if;

  -- 3. Contato depois, e tudo conferido de novo sob os dois locks.
  if v_ok is not null then
    select c.organization_id, c.anonymized_at into v_org2, v_anon
      from public.instagram_contacts c
     where c.id = p_contact_id
     for update;
    if v_org2 is distinct from v_org or v_anon is not null or not exists (
      select 1
        from public.customers cu
       where cu.id = p_customer_id
       and cu.organization_id = v_org
       and cu.deleted_at is null
    ) then
      v_ok := null;
    end if;
  end if;

  if v_ok is null then
    raise exception 'instagram_contact_link_forbidden' using errcode = '42501';
  end if;

  update public.instagram_contacts c
     set customer_id = p_customer_id,
         customer_linked_at = now(),
         updated_at = now()
   where c.id = p_contact_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'instagram_contact_link_forbidden' using errcode = '42501';
  end if;

  update public.conversations cv
     set customer_id = p_customer_id
   where cv.instagram_contact_id = p_contact_id
     and cv.customer_id is distinct from p_customer_id;
end;
$$;

-- ============================================================================
-- 6b. LGPD: anonimizar o contato limpa o nome copiado para a conversa IG
-- ============================================================================
-- `contact_name` da conversa do Instagram é cópia de `name`/`@username` do
-- contato. Quando o contato é anonimizado (o soft delete do cliente aciona o
-- trigger da Task 1.2, ou qualquer outro caminho que marque `anonymized_at`),
-- a cópia também some. SECURITY DEFINER pelo mesmo motivo do trigger da 1.2:
-- `conversations` é FORCE RLS e `authenticated` não tem UPDATE em
-- `contact_name`; o soft delete feito por um membro pelo PostgREST precisa
-- alcançar a conversa. O dono efetivo precisa de BYPASSRLS (README §79).
-- Só `contact_name` é tocado: o guard de canal não dispara.
create or replace function public.conversations_clear_instagram_contact_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations cv
     set contact_name = null
   where cv.instagram_contact_id = new.id
     and cv.contact_name is not null;
  return null;
end;
$$;

drop trigger if exists conversations_clear_instagram_contact_name_trg on public.instagram_contacts;
create trigger conversations_clear_instagram_contact_name_trg
  after update of anonymized_at on public.instagram_contacts
  for each row
  when (old.anonymized_at is null and new.anonymized_at is not null)
  execute function public.conversations_clear_instagram_contact_name();

-- ============================================================================
-- 7. ACL das funções novas (assinatura completa)
-- ============================================================================
revoke all on function public.conversations_channel_guard() from public, anon, authenticated, service_role;
revoke all on function public.conversations_clear_instagram_contact_name() from public, anon, authenticated, service_role;

revoke all on function public.get_or_create_instagram_conversation(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_or_create_instagram_conversation(uuid) to service_role;
comment on function public.get_or_create_instagram_conversation(uuid) is
  'Conversa do Instagram do contato (uma por contato), com unidade e cliente tirados do contato. Recusa contato anonimizado. service_role only.';

revoke all on function public.link_instagram_contact_customer(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.link_instagram_contact_customer(uuid, uuid) to service_role;
comment on function public.link_instagram_contact_customer(uuid, uuid) is
  'Liga o contato do Instagram a um cliente vivo da organizacao do contato e espelha na conversa. 42501 caso contrario. service_role only.';

commit;

-- Validação pós-migration (somente leitura):
--   select channel, count(*), count(*) filter (where customer_id is null) from public.conversations group by 1;  -- só whatsapp, 0 nulos
--   select conname, convalidated from pg_constraint where conrelid = 'public.conversations'::regclass
--    and conname in ('conversations_channel_check', 'conversations_instagram_contact_id_fkey', 'conversations_channel_identity_check');
--   select proname, proacl from pg_proc where proname in ('get_or_create_whatsapp_conversation',
--    'reconcile_whatsapp_automation_acceptance_inner', 'get_or_create_instagram_conversation',
--    'link_instagram_contact_customer', 'conversations_channel_guard');
--
-- ROLLBACK (só enquanto não houver conversa do Instagram; reponha os corpos
-- de 20260905143453:204 e 20261019183559:777 sem o filtro de canal):
--   drop function if exists public.link_instagram_contact_customer(uuid, uuid);
--   drop function if exists public.get_or_create_instagram_conversation(uuid);
--   drop trigger if exists conversations_clear_instagram_contact_name_trg on public.instagram_contacts;
--   drop function if exists public.conversations_clear_instagram_contact_name();
--   drop trigger if exists conversations_channel_guard on public.conversations;
--   drop function if exists public.conversations_channel_guard();
--   drop index if exists public.conversations_unit_channel_status_idx;
--   drop index if exists public.conversations_instagram_contact_uidx;
--   alter table public.conversations drop constraint if exists conversations_channel_identity_check;
--   alter table public.conversations drop constraint if exists conversations_instagram_contact_id_fkey;
--   alter table public.conversations drop constraint if exists conversations_channel_check;
--   alter table public.conversations alter column customer_id set not null;
--   alter table public.conversations drop column if exists instagram_contact_id;
--   alter table public.conversations drop column if exists channel;
