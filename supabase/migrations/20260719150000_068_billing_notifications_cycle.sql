-- Fase 4b: correlação de ciclo em billing_notifications (dedupe por invoice) +
-- restored_at em organizations (carimbo da regularização). Aditiva, idempotente.

begin;

-- Handle de ciclo: uma nova mensalidade nasce numa nova billing_invoice, então o
-- mesmo event_type volta a disparar no ciclo seguinte, mas 1x por ciclo.
alter table billing_notifications
  add column if not exists invoice_id uuid references billing_invoices(id) on delete set null;

-- Dedupe DB-enforced. Parcial: linhas antigas (invoice_id null) não conflitam.
create unique index if not exists billing_notifications_org_type_invoice_uidx
  on billing_notifications (organization_id, event_type, invoice_id)
  where invoice_id is not null;

-- O dispatcher varre só as pendentes.
create index if not exists billing_notifications_pending_idx
  on billing_notifications (status)
  where status = 'pending';

-- Carimbo da regularização (não existia; blocked_at/blocked_reason já existem).
alter table organizations
  add column if not exists restored_at timestamptz;

commit;
