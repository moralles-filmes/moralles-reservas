-- 060: Canonicaliza telefone de `customers` (9º dígito BR), mescla duplicatas
-- existentes (customers + conversas) e blinda o storage com trigger.
--
-- Problema: a dedupe (resolveOrCreateCustomer) fazia match exato de telefone, sem
-- tratar o 9º dígito. O mesmo cliente salvo como "4391336361" (sem o 9) e
-- "43991336361" (com o 9) virava DOIS customers — cada um com sua conversa.
--
-- Forma canônica: só dígitos, sem código de país; celular = 11 díg. (com o 9),
-- fixo = 10 díg. Espelha `canonicalBrPhone` em supabase/functions/_shared/phone.ts
-- e src/lib/phone.ts (manter os três sincronizados).
--
-- Idempotente: re-rodar não encontra mais grupos duplicados (no-op).

-- ─── 1. Função canônica ───────────────────────────────────────────────────────
create or replace function public.normalize_br_phone(raw text)
returns text
language plpgsql
immutable
as $$
declare
  d text;
begin
  d := regexp_replace(coalesce(raw, ''), '[^0-9]', '', 'g');
  -- Tira o código do país (55) só com 12/13 díg. — NÃO cru, pois DDD 55 (RS) existe.
  if length(d) in (12, 13) and left(d, 2) = '55' then
    d := substr(d, 3);
  end if;
  -- Celular sem o 9 (10 díg. e 1º dígito do assinante ∈ {6,7,8,9}) ganha o 9.
  if length(d) = 10 and substr(d, 3, 1) in ('6', '7', '8', '9') then
    d := substr(d, 1, 2) || '9' || substr(d, 3);
  end if;
  return d;
end;
$$;

comment on function public.normalize_br_phone(text) is
  'Telefone BR canônico (só dígitos, sem 55, celular com o 9). Espelha canonicalBrPhone em _shared/phone.ts / src/lib/phone.ts.';

-- ─── 2. Mescla de customers duplicados ────────────────────────────────────────
do $$
declare
  grp   record;
  canon record;
  dup   record;
begin
  for grp in
    select organization_id, public.normalize_br_phone(phone) as canon_phone
    from customers
    group by organization_id, public.normalize_br_phone(phone)
    having count(*) > 1
  loop
    -- Canônico do grupo: não-deletado > nome real (≠ telefone) > mais antigo > id.
    select * into canon
    from customers
    where organization_id = grp.organization_id
      and public.normalize_br_phone(phone) = grp.canon_phone
    order by
      (deleted_at is null) desc,
      (name is not null and name <> phone and name <> grp.canon_phone) desc,
      created_at asc,
      id asc
    limit 1;

    for dup in
      select * from customers
      where organization_id = grp.organization_id
        and public.normalize_br_phone(phone) = grp.canon_phone
        and id <> canon.id
    loop
      -- FKs simples → canônico.
      update reservations  set customer_id = canon.id where customer_id = dup.id;
      update conversations set customer_id = canon.id where customer_id = dup.id;
      update waitlist      set customer_id = canon.id where customer_id = dup.id;

      -- Vouchers: respeita o UNIQUE parcial (unit_id, rule_id, customer_id) WHERE
      -- status='active'. Expira o voucher do dup que colidiria antes de re-apontar.
      update vouchers v set status = 'expired'
      where v.customer_id = dup.id
        and v.status = 'active'
        and v.rule_id is not null
        and exists (
          select 1 from vouchers c
          where c.customer_id = canon.id
            and c.unit_id = v.unit_id
            and c.rule_id = v.rule_id
            and c.status = 'active'
        );
      update vouchers set customer_id = canon.id where customer_id = dup.id;

      -- Mescla campos no canônico (lê valores via record `canon`, atualizado a cada
      -- dup). `email` é derivado pelo trigger sync de emails[0], então só mexemos
      -- em `emails` (união preservando a ordem do canônico).
      update customers set
        emails = (
          select coalesce(jsonb_agg(e order by ord), '[]'::jsonb)
          from (
            select e, min(ord) as ord
            from (
              select value as e, ordinality as ord
                from jsonb_array_elements(coalesce(canon.emails, '[]'::jsonb))
                       with ordinality as t(value, ordinality)
              union all
              select value, 1000 + ordinality
                from jsonb_array_elements(coalesce(dup.emails, '[]'::jsonb))
                       with ordinality as t(value, ordinality)
            ) u
            group by e
          ) deduped
        ),
        birthday = coalesce(canon.birthday, dup.birthday),
        allergies = coalesce(canon.allergies, dup.allergies),
        dietary_restrictions = coalesce(canon.dietary_restrictions, dup.dietary_restrictions),
        vip_notes = coalesce(canon.vip_notes, dup.vip_notes),
        preferred_table_location = coalesce(canon.preferred_table_location, dup.preferred_table_location),
        do_not_contact = canon.do_not_contact or dup.do_not_contact,
        name = case
          when canon.name is null or canon.name = canon.phone or canon.name = grp.canon_phone
            then coalesce(nullif(dup.name, dup.phone), canon.name)
          else canon.name
        end
      where id = canon.id;

      -- Reflete os merges acumulados (vários dups no mesmo grupo).
      select * into canon from customers where id = canon.id;

      delete from customers where id = dup.id;
    end loop;

    -- Sobrevivente fica com o telefone canônico (dups já removidos → sem colisão).
    update customers set phone = grp.canon_phone where id = canon.id;
  end loop;

  -- Canoniza os singletons restantes que ainda estejam fora do padrão.
  update customers set phone = public.normalize_br_phone(phone)
  where phone <> public.normalize_br_phone(phone);
end;
$$;

-- ─── 3. Consolida conversas do mesmo (unit, customer) numa thread só ───────────
-- Após mesclar customers, o canônico pode ter 2 conversas (uma de cada dup) na
-- mesma unit → 2 linhas idênticas na lista. Junta as mensagens na conversa mais
-- recente (sobrevivente) e remove as demais.
do $$
declare
  grp  record;
  surv record;
begin
  for grp in
    select unit_id, customer_id
    from conversations
    group by unit_id, customer_id
    having count(*) > 1
  loop
    select * into surv
    from conversations
    where unit_id = grp.unit_id and customer_id = grp.customer_id
    order by coalesce(last_message_at, updated_at) desc, updated_at desc, id desc
    limit 1;

    update conversations set
      messages = (
        select coalesce(jsonb_agg(msg.elem order by (msg.elem->>'timestamp')), '[]'::jsonb)
        from conversations c
        cross join lateral jsonb_array_elements(coalesce(c.messages, '[]'::jsonb)) as msg(elem)
        where c.unit_id = grp.unit_id and c.customer_id = grp.customer_id
      ),
      last_message_at = (
        select max(coalesce(last_message_at, updated_at))
        from conversations
        where unit_id = grp.unit_id and customer_id = grp.customer_id
      )
    where id = surv.id;

    delete from conversations
    where unit_id = grp.unit_id and customer_id = grp.customer_id and id <> surv.id;
  end loop;
end;
$$;

-- ─── 4. Trigger: força telefone canônico em QUALQUER escrita ───────────────────
-- Rede de segurança: cobre writers que não passam por canonicalBrPhone (handler
-- de mídia, inserts futuros). Combinado com o UNIQUE (organization_id, phone),
-- fecha a porta de duplicatas no nível de dados.
create or replace function public.customers_force_canonical_phone()
returns trigger
language plpgsql
as $$
begin
  new.phone := public.normalize_br_phone(new.phone);
  return new;
end;
$$;

drop trigger if exists customers_canonical_phone_trg on customers;
create trigger customers_canonical_phone_trg
  before insert or update of phone on customers
  for each row
  execute function public.customers_force_canonical_phone();
