-- Instagram, Fase 1 (Task 4.0b, Rulings R4-a e R4-b): a reserva do contato do
-- Instagram e a linha do ledger nascem na MESMA transação, e cada contato tem
-- teto de reservas ativas e de trocas de telefone.
--
-- Spec:  docs/superpowers/specs/2026-10-19-instagram-modulo-design.md
-- Plano: docs/superpowers/plans/2026-10-20-instagram-fase-1-direct-conversas.md
--        (Bloco 4, Task 4.0b)
-- Pré-voo: supabase/tests/local-preflight/79a-instagram-bootstrap.sql (seção
--          3d) e 79-instagram-module.sql (README, seção "79 — Módulo
--          Instagram"), casos IG-7.1..IG-7.6 e controles C-IG-7.x.
--
-- Por quê: o núcleo do agente criava a reserva (`reserveSlot`) e só depois
-- gravava o ledger (`record_instagram_contact_reservation`). Se o registro
-- falhasse, a reserva existia mas sumia das consultas do contato, e o LLM podia
-- criar outra. supabase-js não tem transação entre duas chamadas, então a
-- reserva do canal de identidade declarada passa a ser criada por esta RPC
-- (o `reserveSlot` chama a porta no lugar do INSERT; disponibilidade, mesa,
-- código, desconto e o retry do 23505 continuam no TS).
--
-- O que muda:
--   * `create_instagram_contact_reservation` (nova, service_role): confere o
--     contato e o cliente sob lock, aplica o teto de reservas ativas e insere
--     reserva + ledger. É a ÚNICA barreira de identidade do núcleo com porta:
--     o TS não faz I/O de cliente nesse caminho (Ruling R4-f).
--   * `record_instagram_contact_reservation` (recriada): reserva que já está
--     no ledger de OUTRO contato é recusada (antes o `on conflict do nothing`
--     aceitava calado). O mesmo contato continua no-op. Perde o EXECUTE de
--     `service_role` (Task 4.0d): ela não aplica o teto de reservas ativas, e a
--     criação atômica é o único caminho do adapter.
--   * `link_instagram_contact_customer` (recriada): teto de trocas de cliente
--     por contato numa janela, com o contador em `instagram_contacts`.
--
-- Tenant: unidade e organização saem do CONTATO; o `unit_id` e o
-- `customer_id` da linha só são aceitos se forem os do contato. Toda recusa de
-- identidade é o MESMO 42501 (sem oráculo de existência).
--
-- Estado da linha (Task 4.0d): o jsonb não é confiável além da identidade.
-- `status` só `pending`/`confirmed`; `payment_status` nulo ou `not_required` e
-- `payment_amount_cents`/`payment_expires_at` nulos (o agente nunca gera
-- `payment_*`: só `initialStateForSlot`, do fluxo público, o faz); `table_id` nulo
-- ou mesa da UNIDADE DO CONTATO (`reservations` não tem FK nem trigger de
-- coerência mesa x unidade). A linha não carrega `hall_id`; o salão vem da mesa.
--
-- Idempotente: `add column if not exists`, constraint recriada por nome,
-- `create or replace function`, revokes/grants reafirmados. Sem URL do projeto
-- e sem segredo.

begin;
set local lock_timeout = '5s';

-- ============================================================================
-- 1. Contador de trocas do contato (R4-b)
-- ============================================================================
-- Janela fixa: começa na primeira troca e vale `c_link_window` (30 dias);
-- passada a janela, a próxima troca abre outra. Escrito só por
-- `link_instagram_contact_customer`. `authenticated` lê o contato (policy de
-- membro): as colunas novas são só contagem e instante, nada sensível.
alter table public.instagram_contacts
  add column if not exists link_changes_count smallint not null default 0,
  add column if not exists link_changes_window_started_at timestamptz;

alter table public.instagram_contacts
  drop constraint if exists instagram_contacts_link_changes_count_chk;
alter table public.instagram_contacts
  add constraint instagram_contacts_link_changes_count_chk check (link_changes_count >= 0);

comment on column public.instagram_contacts.link_changes_count is
  'Trocas de cliente (customer_id nao nulo para outro) na janela atual. Teto em link_instagram_contact_customer (R4-b).';
comment on column public.instagram_contacts.link_changes_window_started_at is
  'Inicio da janela de contagem de trocas de cliente; nulo ate a primeira troca.';

-- ============================================================================
-- 2. Reserva + ledger numa transação (R4-a)
-- ============================================================================
-- `p_reservation` é a linha que o `reserveSlot` monta (`ReservationInsertRow`
-- em _shared/availability.ts). Só as colunas dela entram em `reservations`,
-- cada uma com cast explícito; nada além.
--
-- Ordem de locks: a mesma de `link_instagram_contact_customer` (CLIENTE antes
-- do CONTATO, a do soft delete: UPDATE de `customers.deleted_at` -> trigger de
-- anonimização -> UPDATE do contato). A organização do contato é lida SEM
-- lock, o `for share` no cliente vem primeiro, depois o `for update` no
-- contato, e tudo é conferido de novo sob os dois locks.
--
-- Recusa com o MESMO 42501 `instagram_contact_reservation_forbidden`: contato
-- inexistente ou anonimizado; contato sem cliente ou com cliente diferente do
-- `customer_id` da linha; cliente apagado ou de outra organização; `unit_id`
-- da linha diferente do do contato; `source` diferente de `instagram`; id que
-- não é uuid; `status`, `payment_*` ou `table_id` fora do estado acima. O `for update` no contato serializa as criações do mesmo contato,
-- o que torna o teto exato.
--
-- Unique violation da mesa (23505, `reservations_unique_active_table_slot`)
-- propaga como está: o retry do `reserveSlot` depende do code.
create or replace function public.create_instagram_contact_reservation(p_contact_id uuid, p_reservation jsonb)
returns table(id uuid, status text, payment_status text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  -- Teto de reservas ativas por contato (R4-b): pending/confirmed de hoje em
  -- diante (dia de BRT). A 4ª é recusada com P0001.
  c_max_active constant integer := 3;
  v_cust   uuid;
  v_unit   uuid;
  v_table  uuid;
  v_table_txt text;
  v_org    uuid;
  v_ok     uuid;
  v_c_org  uuid;
  v_c_unit uuid;
  v_c_cust uuid;
  v_anon   timestamptz;
  v_active integer;
  v_id     uuid;
  v_status text;
  v_pay    text;
begin
  -- 0. Ids da linha. Texto que não é uuid cai na mesma recusa.
  if p_reservation is not null and jsonb_typeof(p_reservation) = 'object' then
    begin
      v_cust := (p_reservation->>'customer_id')::uuid;
      v_unit := (p_reservation->>'unit_id')::uuid;
      v_table_txt := p_reservation->>'table_id';
      v_table := v_table_txt::uuid;
    exception when invalid_text_representation then
      v_cust := null;
      v_unit := null;
    end;
  end if;

  -- 1. Organização do contato, sem lock.
  select c.organization_id into v_org
    from public.instagram_contacts c
   where c.id = p_contact_id;

  -- 2. Cliente primeiro: vivo e da organização do contato.
  if v_org is not null and v_cust is not null then
    select cu.id into v_ok
      from public.customers cu
     where cu.id = v_cust
       and cu.organization_id = v_org
       and cu.deleted_at is null
     for share;
  end if;

  -- 3. Contato depois, e tudo conferido de novo sob os dois locks.
  if v_ok is not null then
    select c.organization_id, c.unit_id, c.customer_id, c.anonymized_at
      into v_c_org, v_c_unit, v_c_cust, v_anon
      from public.instagram_contacts c
     where c.id = p_contact_id
     for update;
    if v_c_org is distinct from v_org
       or v_anon is not null
       or v_c_cust is null or v_c_cust is distinct from v_cust
       or v_unit is null or v_unit is distinct from v_c_unit
       or (p_reservation->>'source') is distinct from 'instagram'
       -- Estado da linha: só pending/confirmed, sem pagamento.
       or (p_reservation->>'status') is null
       or (p_reservation->>'status') not in ('pending', 'confirmed')
       or coalesce(p_reservation->>'payment_status', 'not_required') <> 'not_required'
       or (p_reservation->>'payment_amount_cents') is not null
       or (p_reservation->>'payment_expires_at') is not null
       -- Mesa, se vier, é da unidade do contato.
       or (v_table_txt is not null and not exists (
         select 1
           from public.tables t
          where t.id = v_table
            and t.unit_id = v_c_unit
       ))
       or not exists (
         select 1
           from public.customers cu
          where cu.id = v_cust
            and cu.organization_id = v_org
            and cu.deleted_at is null
       ) then
      v_ok := null;
    end if;
  end if;

  if v_ok is null then
    raise exception 'instagram_contact_reservation_forbidden' using errcode = '42501';
  end if;

  -- 4. Teto de reservas ativas do contato (sob o lock do contato).
  select count(*) into v_active
    from public.instagram_contact_reservations l
    join public.reservations r on r.id = l.reservation_id
   where l.instagram_contact_id = p_contact_id
     and r.status in ('pending', 'confirmed')
     and r.date >= (now() at time zone 'America/Sao_Paulo')::date;
  if v_active >= c_max_active then
    raise exception 'instagram_contact_reservation_limit' using errcode = 'P0001';
  end if;

  -- 5. Reserva e ledger na mesma transação: qualquer erro desfaz os dois.
  insert into public.reservations as r (
    customer_id, unit_id, table_id, date, time, party_size, notes, reservation_code,
    status, payment_status, payment_amount_cents, payment_expires_at,
    applied_discount_percent, source
  ) values (
    v_cust,
    v_c_unit,
    v_table,
    (p_reservation->>'date')::date,
    (p_reservation->>'time')::time,
    (p_reservation->>'party_size')::integer,
    (p_reservation->>'notes')::text,
    (p_reservation->>'reservation_code')::text,
    (p_reservation->>'status')::text,
    (p_reservation->>'payment_status')::text,
    (p_reservation->>'payment_amount_cents')::integer,
    (p_reservation->>'payment_expires_at')::timestamptz,
    (p_reservation->>'applied_discount_percent')::integer,
    (p_reservation->>'source')::text
  )
  returning r.id, r.status, r.payment_status into v_id, v_status, v_pay;

  insert into public.instagram_contact_reservations (reservation_id, instagram_contact_id, unit_id)
  values (v_id, p_contact_id, v_c_unit);

  return query select v_id, v_status, v_pay;
end;
$$;

-- ============================================================================
-- 3. Ledger de reserva já existente: recusa reserva de outro contato
-- ============================================================================
-- Corpo de 20261103120100 §7 com UMA mudança: depois do `on conflict do
-- nothing`, a reserva tem de estar no ledger DESTE contato; se está no de
-- outro, o mesmo 42501. O mesmo contato continua no-op.
create or replace function public.record_instagram_contact_reservation(p_contact_id uuid, p_reservation_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c_unit uuid;
  v_c_cust uuid;
  v_r_unit uuid;
  v_r_cust uuid;
  v_owner  uuid;
begin
  select c.unit_id, c.customer_id into v_c_unit, v_c_cust
    from public.instagram_contacts c where c.id = p_contact_id;
  select r.unit_id, r.customer_id into v_r_unit, v_r_cust
    from public.reservations r where r.id = p_reservation_id;

  if v_c_unit is null or v_r_unit is null
     or v_r_unit is distinct from v_c_unit
     or v_c_cust is null or v_r_cust is distinct from v_c_cust then
    raise exception 'instagram_contact_reservation_forbidden' using errcode = '42501';
  end if;

  insert into public.instagram_contact_reservations (reservation_id, instagram_contact_id, unit_id)
  values (p_reservation_id, p_contact_id, v_r_unit)
  on conflict do nothing;

  -- Reserva já ligada a outro contato: recusa (sem isso, o conflito acima
  -- aceitava calado e o caller achava que a reserva era dele).
  select l.instagram_contact_id into v_owner
    from public.instagram_contact_reservations l
   where l.reservation_id = p_reservation_id;
  if v_owner is distinct from p_contact_id then
    raise exception 'instagram_contact_reservation_forbidden' using errcode = '42501';
  end if;
end;
$$;

-- ============================================================================
-- 4. Link com teto de trocas (R4-b)
-- ============================================================================
-- Corpo de 20261103120300 §6 (mesma ordem de locks, mesmas conferências e o
-- mesmo 42501) mais o teto, conferido sob o `for update` do contato e DEPOIS
-- da recusa de identidade (quem não pode ligar recebe o 42501, nunca o teto).
-- Troca = cliente atual não nulo e diferente de `p_customer_id`. O primeiro
-- link (de nulo) e religar o mesmo cliente não contam. Mais de
-- `c_max_link_changes` trocas na janela de `c_link_window` -> P0001
-- `instagram_contact_link_limit`, sem gravar nada.
create or replace function public.link_instagram_contact_customer(p_contact_id uuid, p_customer_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- Teto de trocas de cliente por contato (R4-b): 3 trocas a cada 30 dias.
  c_max_link_changes constant integer := 3;
  c_link_window      constant interval := interval '30 days';
  v_org     uuid;
  v_org2    uuid;
  v_anon    timestamptz;
  v_ok      uuid;
  v_n       integer;
  v_cur     uuid;
  v_changes integer;
  v_window  timestamptz;
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
    select c.organization_id, c.anonymized_at, c.customer_id, c.link_changes_count, c.link_changes_window_started_at
      into v_org2, v_anon, v_cur, v_changes, v_window
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

  -- 4. Teto de trocas, sob o lock do contato.
  if v_cur is not null and v_cur is distinct from p_customer_id then
    if v_window is null or v_window <= now() - c_link_window then
      v_changes := 0;
      v_window := now();
    end if;
    if v_changes >= c_max_link_changes then
      raise exception 'instagram_contact_link_limit' using errcode = 'P0001';
    end if;
    v_changes := v_changes + 1;
  end if;

  update public.instagram_contacts c
     set customer_id = p_customer_id,
         customer_linked_at = now(),
         link_changes_count = v_changes,
         link_changes_window_started_at = v_window,
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

comment on table public.instagram_contact_reservations is
  'Reserva nascida de um contato do Instagram. Gravada so por create_instagram_contact_reservation (junto com a reserva, mesma transacao; service_role) e por record_instagram_contact_reservation (reserva ja existente; sem EXECUTE para API), com unidade e cliente conferidos. FORCE RLS sem policies.';

-- ============================================================================
-- 5. ACL (assinatura completa)
-- ============================================================================
revoke all on function public.create_instagram_contact_reservation(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.create_instagram_contact_reservation(uuid, jsonb) to service_role;
comment on function public.create_instagram_contact_reservation(uuid, jsonb) is
  'Cria a reserva do contato do Instagram e a linha do ledger na mesma transacao, com cliente/unidade/origem conferidos contra o contato sob lock, estado da linha travado (pending/confirmed, sem pagamento, mesa da unidade) e teto de 3 reservas ativas. 42501 sem oraculo; P0001 instagram_contact_reservation_limit. service_role only.';

-- record_ fica SEM grant a ninguém (só o dono executa). Ela não aplica o teto de
-- reservas ativas nem confere o estado da reserva, então deixá-la a
-- service_role furaria o teto (M-2 da review da 4.0b): a criação atômica é o
-- único caminho do adapter. Religar uma reserva existente exige RPC própria,
-- com teto, numa migration futura.
revoke all on function public.record_instagram_contact_reservation(uuid, uuid) from public, anon, authenticated, service_role;
comment on function public.record_instagram_contact_reservation(uuid, uuid) is
  'Liga reserva existente ao ledger do contato (unidade e cliente conferidos; recusa a de outro contato). NAO aplica o teto de reservas ativas: sem EXECUTE para ninguem (so o dono); o adapter usa create_instagram_contact_reservation.';

revoke all on function public.link_instagram_contact_customer(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.link_instagram_contact_customer(uuid, uuid) to service_role;
comment on function public.link_instagram_contact_customer(uuid, uuid) is
  'Liga o contato do Instagram a um cliente vivo da organizacao do contato e espelha na conversa. 42501 caso contrario; mais de 3 trocas em 30 dias da P0001 instagram_contact_link_limit. service_role only.';

commit;

-- Validação pós-migration (somente leitura):
--   select proname, prosecdef, proconfig, proacl from pg_proc
--    where proname in ('create_instagram_contact_reservation', 'record_instagram_contact_reservation',
--                      'link_instagram_contact_customer');
--   select attname, atttypid::regtype, attnotnull from pg_attribute
--    where attrelid = 'public.instagram_contacts'::regclass
--      and attname in ('link_changes_count', 'link_changes_window_started_at');
--
-- ROLLBACK (só enquanto o adapter do Instagram não chamar a RPC nova; reponha
-- os corpos de 20261103120100 §7 e 20261103120300 §6 com os mesmos
-- revoke/grant):
--   begin; set local lock_timeout = '5s';
--   drop function if exists public.create_instagram_contact_reservation(uuid, jsonb);
--   -- recriar record_instagram_contact_reservation e link_instagram_contact_customer
--   -- a partir das migrations 200100 e 200300
--   alter table public.instagram_contacts drop constraint if exists instagram_contacts_link_changes_count_chk;
--   alter table public.instagram_contacts drop column if exists link_changes_window_started_at;
--   alter table public.instagram_contacts drop column if exists link_changes_count;
--   commit;
