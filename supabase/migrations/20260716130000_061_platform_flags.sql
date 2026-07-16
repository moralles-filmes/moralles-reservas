-- Feature flags globais da plataforma — infra nova (não existia nenhum mecanismo).
-- Fase 1 da migração de billing Stripe→Asaas (docs/billing-asaas/01-PLANO-IMPLEMENTACAO.md).
--
-- Padrão platform_secrets: FORCE RLS sem policies → acesso exclusivo via Edge
-- Function service_role (_shared/platform-flags.ts, cache 5min). Frontend nunca
-- lê a tabela direto.
--
-- value é jsonb: flags booleanas guardam true/false; flags de escolha guardam
-- string (ex.: billing_provider_default = "stripe"). Flag ausente = OFF
-- (fail-closed no resolver).

begin;

create table if not exists platform_flags (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value jsonb not null default 'false'::jsonb,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table platform_flags is
  'Feature flags globais (billing Asaas, entitlements, carteira IA, Z-API). FORCE RLS sem policies — leitura via _shared/platform-flags.ts com cache 5min. Flag ausente = OFF.';

alter table platform_flags enable row level security;
alter table platform_flags force row level security;

drop trigger if exists platform_flags_updated_at on platform_flags;
create trigger platform_flags_updated_at
  before update on platform_flags
  for each row execute function update_updated_at();

-- Seeds: todas OFF / default seguro (mundo atual = Stripe).
-- on conflict do nothing → idempotente e NÃO sobrescreve valor já alterado pelo admin.
insert into platform_flags (key, value, description) values
  ('asaas_enabled', 'false',
   'Liga o cliente Asaas e o processamento de webhooks Asaas (Fase 2).'),
  ('billing_provider_default', '"stripe"',
   'Provedor de pagamento para NOVAS contratações: "stripe" | "asaas" (Fase 4).'),
  ('entitlements_enforced', 'false',
   'Guards (BillingGuard/EFs) passam a usar resolveOrgEntitlements em vez do billing_status binário (Fase 4).'),
  ('billing_notifications_dispatch', 'false',
   'Worker passa a ENVIAR de verdade os billing_notifications pendentes (Fase 4).'),
  ('whatsapp_implementation_flow', 'false',
   'Fluxo comercial R$750 implementação + R$149/mês instância visível ao cliente (Fase 5).'),
  ('zapi_auto_provisioning', 'false',
   'Provisionamento automático de instância via API de parceiro Z-API (Fase 6).'),
  ('zapi_auto_disconnect', 'false',
   'Desconectar instância Z-API automaticamente na suspensão D+6 (Fase 6).'),
  ('zapi_auto_cancel', 'false',
   'Cancelar assinatura da instância na Z-API automaticamente na suspensão (Fase 6).'),
  ('ai_wallet_enforced', 'false',
   'Gate de saldo bloqueia chamadas LLM quando carteira zerada (Fase 7).'),
  ('asaas_card_tokenization_enabled', 'false',
   'Recarga automática de IA via autorização reutilizável Asaas (Fase 8).')
on conflict (key) do nothing;

commit;
