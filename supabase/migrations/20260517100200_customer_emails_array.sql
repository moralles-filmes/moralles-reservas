-- 054_customer_emails_array.sql
-- Suporte a múltiplos e-mails por cliente.
--
-- Decisão de design:
--   * `emails jsonb` é a fonte da verdade (array de strings, lower+trim).
--   * `email text` (já existente) continua sendo o ESPELHO de emails[0],
--     mantido sincronizado por trigger. Isso preserva compat com:
--       - send-confirmation / send-cancellation (lêem customer.email)
--       - useCustomers / Clientes.tsx (renderizam customer.email)
--       - exportCsv (Fluxo de Clientes, coluna E-mail)
--
-- Casos de uso:
--   * Cliente reserva com phone X e email A → emails = ['a@x.com']
--   * Mesmo phone X reserva de novo com email B → emails = ['a@x.com', 'b@x.com']
--   * UI pode remover qualquer email (cliente colocou falso) → array reduz
--
-- A coluna email permanece editável (writable) para não quebrar inserts
-- legados que ainda mandam só email — nesses casos, o trigger popula emails.

alter table public.customers
  add column if not exists emails jsonb not null default '[]'::jsonb;

-- Backfill: copia email atual para emails[0] (case-insensitive, trim)
update public.customers
   set emails = jsonb_build_array(lower(trim(email)))
 where email is not null
   and trim(email) <> ''
   and emails = '[]'::jsonb;

-- Trigger: mantém customers.email sincronizado com emails[0]
create or replace function public.customers_sync_email()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Se emails foi setado e tem itens → email vira o primeiro item
  if new.emails is not null and jsonb_array_length(new.emails) > 0 then
    new.email := new.emails->>0;

  -- Se email foi setado mas emails está vazio → popula emails
  elsif new.email is not null and trim(new.email) <> ''
        and (new.emails is null or new.emails = '[]'::jsonb) then
    new.emails := jsonb_build_array(lower(trim(new.email)));

  -- Ambos vazios → normaliza
  else
    new.email := null;
    new.emails := coalesce(new.emails, '[]'::jsonb);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_customers_sync_email on public.customers;
create trigger trg_customers_sync_email
  before insert or update of email, emails on public.customers
  for each row execute function public.customers_sync_email();

comment on column public.customers.emails is
  'Array de e-mails do cliente. customers.email é espelho de emails[0] via trigger trg_customers_sync_email.';

-- Atualiza anonymize_customer pra limpar também o array de emails.
-- (Definição original em 009_lgpd.sql; redefinida aqui via create or replace.)
-- SECURITY DEFINER + SET search_path explícito previne hijack via PATH (CVE-2018-1058).
create or replace function public.anonymize_customer(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.customers
     set name = 'Cliente removido',
         phone = 'anon-' || substring(id::text, 1, 8),
         email = null,
         emails = '[]'::jsonb,
         allergies = null,
         dietary_restrictions = null,
         vip_notes = null,
         preferred_table_location = null,
         do_not_contact = true,
         deleted_at = now()
   where id = p_id and deleted_at is null;
end;
$$;
