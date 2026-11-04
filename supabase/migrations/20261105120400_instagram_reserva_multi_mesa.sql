-- Escolha de mesa no Instagram: a reserva do contato (create_instagram_contact_reservation)
-- passa a aceitar mesas juntas e a registrar como ganhou a mesa, com as mesmas
-- regras da reserva pelo WhatsApp e pela página (insert_reservation_with_tables).
--
-- Spec:  docs/superpowers/specs/2026-11-04-escolha-de-mesa-design.md
-- Plano: docs/superpowers/plans/2026-11-04-escolha-de-mesa.md (E2; decisão do
--        dono em 2026-11-04: "as regras valem também para o Instagram").
-- Pré-voo: supabase/tests/local-preflight/83-escolha-de-mesa.sql, casos IG-M-*.
--
-- O que muda em relação à 20261103120600 (corpo copiado, só estas diferenças):
--   * `p_reservation` aceita `table_ids` (array de 2 a 12 uuids distintos, o
--     primeiro igual a `table_id`) e `table_choice` ('customer' ou 'system').
--     As mesas extras entram em occupant_tables na mesma transação, com a
--     janela da reserva; colisão com outra reserva levanta 23P01
--     (occupant_tables_no_overlap) e nada fica gravado. O retry do reserveSlot
--     trata 23505 e 23P01.
--   * Toda mesa da linha (table_id e table_ids) precisa ser da unidade do
--     contato, ATIVA e RESERVÁVEL (antes só a unidade). Fora disso, o mesmo
--     42501 instagram_contact_reservation_forbidden, sem oráculo.
--   * `table_choice` grava em reservations.table_choice (o CHECK da coluna
--     aceita customer/system/staff; aqui só customer/system, staff é da recepção).
--
-- Ordem de deploy: esta migration ANTES do redeploy de process-instagram-inbound
-- (a versão antiga da RPC ignoraria table_ids e gravaria só a mesa principal).
-- Mesma assinatura: create or replace mantém o ACL; revoke/grant reafirmados.
-- Idempotente. Sem URL do projeto e sem segredo.

begin;
set local lock_timeout = '5s';

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
  v_tables uuid[];
  v_n      integer;
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
  v_date   date;
  v_time   time;
begin
  -- 0. Ids da linha. Texto que não é uuid cai na mesma recusa.
  if p_reservation is not null and jsonb_typeof(p_reservation) = 'object' then
    begin
      v_cust := (p_reservation->>'customer_id')::uuid;
      v_unit := (p_reservation->>'unit_id')::uuid;
      v_table_txt := p_reservation->>'table_id';
      v_table := v_table_txt::uuid;
      -- Mesas juntas: array de uuids; o primeiro é a mesa principal.
      if p_reservation ? 'table_ids' then
        if jsonb_typeof(p_reservation->'table_ids') = 'array' then
          select pg_catalog.array_agg(x::uuid order by o) into v_tables
            from pg_catalog.jsonb_array_elements_text(p_reservation->'table_ids') with ordinality e(x, o);
        end if;
        v_n := coalesce(pg_catalog.cardinality(v_tables), 0);
        if v_n not between 2 and 12
           or pg_catalog.array_position(v_tables, null) is not null
           or (select count(distinct t) from pg_catalog.unnest(v_tables) t) <> v_n
           or v_table is null or v_tables[1] is distinct from v_table then
          v_cust := null;
        end if;
      else
        v_tables := case when v_table is null then '{}'::uuid[] else array[v_table] end;
        v_n := pg_catalog.cardinality(v_tables);
      end if;
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
       -- Como ganhou a mesa: só cliente ou automático, e só com mesa.
       or (p_reservation ? 'table_choice' and (
             (p_reservation->>'table_choice') is null
             or (p_reservation->>'table_choice') not in ('customer', 'system')
             or v_table is null))
       -- Mesas, se vierem: todas da unidade do contato, ativas e reserváveis.
       or (v_n > 0 and (
         select count(*)
           from public.tables t
          where t.id = any (v_tables)
            and t.unit_id = v_c_unit
            and t.active
            and t.bookable
       ) <> v_n)
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

  -- 5. Reserva, mesas extras e ledger na mesma transação: qualquer erro desfaz tudo.
  v_date := (p_reservation->>'date')::date;
  v_time := (p_reservation->>'time')::time;
  insert into public.reservations as r (
    customer_id, unit_id, table_id, date, time, party_size, notes, reservation_code,
    status, payment_status, payment_amount_cents, payment_expires_at,
    applied_discount_percent, source, table_choice
  ) values (
    v_cust,
    v_c_unit,
    v_table,
    v_date,
    v_time,
    (p_reservation->>'party_size')::integer,
    (p_reservation->>'notes')::text,
    (p_reservation->>'reservation_code')::text,
    (p_reservation->>'status')::text,
    (p_reservation->>'payment_status')::text,
    (p_reservation->>'payment_amount_cents')::integer,
    (p_reservation->>'payment_expires_at')::timestamptz,
    (p_reservation->>'applied_discount_percent')::integer,
    (p_reservation->>'source')::text,
    (p_reservation->>'table_choice')::text
  )
  returning r.id, r.status, r.payment_status into v_id, v_status, v_pay;

  -- A principal já entrou em occupant_tables pelo trigger de reservations.
  if v_n > 1 then
    insert into public.occupant_tables (unit_id, table_id, reservation_id, slot, blocks_slot)
    select v_c_unit, x.id, v_id, app_private.reservation_slot(v_c_unit, v_date, v_time),
           v_status in ('pending', 'confirmed')
      from pg_catalog.unnest(v_tables[2:]) x(id);
  end if;

  insert into public.instagram_contact_reservations (reservation_id, instagram_contact_id, unit_id)
  values (v_id, p_contact_id, v_c_unit);

  return query select v_id, v_status, v_pay;
end;
$$;

revoke all on function public.create_instagram_contact_reservation(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.create_instagram_contact_reservation(uuid, jsonb) to service_role;
comment on function public.create_instagram_contact_reservation(uuid, jsonb) is
  'Só service_role (process-instagram-inbound): reserva do contato do Instagram + ledger numa transação, sob lock do contato, teto de 3 ativas. Aceita table_ids (mesas juntas, 2..12, o primeiro = table_id) e table_choice (customer/system); toda mesa da unidade do contato, ativa e reservável. Recusa de identidade/estado/mesa: 42501 instagram_contact_reservation_forbidden; teto: P0001; colisão de mesa: 23505 ou 23P01 (nada gravado).';

commit;

-- Rollback (emergência, só com autorização): reaplicar o corpo da função da
-- 20261103120600 §2 (create or replace, mesma assinatura) e os revoke/grant
-- acima. Reservas com várias mesas já gravadas continuam válidas.
