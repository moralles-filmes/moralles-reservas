-- Telemetria estruturada de execuções do webhook-whatsapp.
--
-- Antes: a única observabilidade era o log de Edge Function (jsonLog),
-- que decai depois de 24h e não permite agregação por unit/outcome.
--
-- Agora: cada execução do webhook grava uma linha aqui. Alimenta o painel
-- "Diagnóstico" em /platform/automacao/<slug> e permite identificar quando
-- uma unidade especifica está com problemas (ex.: muitos send_error).

create table if not exists webhook_executions (
  id            uuid primary key default gen_random_uuid(),
  request_id    text not null,
  unit_id       uuid references units(id) on delete set null,
  channel_id    uuid references whatsapp_channels(id) on delete set null,
  phone_hash    text,
  outcome       text not null,
  error         text,
  duration_ms   integer,
  meta          jsonb default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists idx_webhook_executions_unit_created
  on webhook_executions (unit_id, created_at desc);

create index if not exists idx_webhook_executions_outcome
  on webhook_executions (outcome, created_at desc);

alter table webhook_executions enable row level security;
alter table webhook_executions force row level security;
-- Sem policies: só service_role acessa (Edge Functions). UI consome via
-- whatsapp-health (action 'list') que filtra por unit_id e platform_admin.

create or replace function cleanup_webhook_executions()
returns void
language sql
security definer
set search_path = public
as $$
  delete from webhook_executions
  where created_at < now() - interval '30 days';
$$;
