-- Observabilidade do ciclo de vida da mensagem WhatsApp inbound.
--
-- Antes: idempotência cega — INSERT no message_id (PK) e qualquer falha
-- após o INSERT (agente, sendOutbound) deixava a mensagem "marcada como
-- processada" sem nunca ter respondido, e a retransmissão era descartada.
--
-- Agora: registramos started_at/completed_at/outcome. O webhook pode
-- detectar registros "presos" (started_at antigo, completed_at NULL) e
-- permitir o reprocessamento da mesma message_id após um timeout.

alter table processed_messages
  add column if not exists unit_id uuid references units(id) on delete set null,
  add column if not exists started_at timestamptz not null default now(),
  add column if not exists completed_at timestamptz,
  add column if not exists outcome text,
  add column if not exists error text;

create index if not exists idx_processed_messages_unit_started
  on processed_messages (unit_id, started_at desc);

create index if not exists idx_processed_messages_outcome
  on processed_messages (outcome) where outcome is not null;

-- Limpeza periódica (TTL ~30 dias) — função invocável por cron externo
-- ou pg_cron. Não cria job aqui pra não depender de extensão habilitada.
create or replace function cleanup_processed_messages()
returns void
language sql
security definer
set search_path = public
as $$
  delete from processed_messages
  where processed_at < now() - interval '30 days';
$$;
