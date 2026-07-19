-- billing_checkout_sessions — mapa checkoutId → organização, para correlacionar
-- pagamentos nascidos de checkout hospedado do Asaas.
--
-- DESCOBERTA (verificada ao vivo em 19/07/2026, §13.7 do doc 03): o checkout
-- hospedado do Asaas NÃO propaga o externalReference que criamos — nem para a
-- assinatura, nem para a cobrança gerada (ambas nascem com
-- externalReference=null). Além disso o pagador digita os dados na própria
-- página, gerando um customer NOVO (diferente do que pré-criamos em
-- billing_customers). Resultado: no webhook, NEM externalReference NEM customer
-- resolvem a organização. O único elo que sobrevive é o `checkoutSession` (id do
-- checkout), presente tanto na cobrança quanto na assinatura. Gravamos aqui
-- checkoutId → org/plano/purpose no momento da criação (create-billing-checkout)
-- e o aplicador (asaas-billing-events-apply.ts) reidrata a org a partir dele.
--
-- Escopo 4a (1ª cobrança/ativação): a renovação mensal NÃO carrega
-- checkoutSession (a cobrança nasce da assinatura, não do checkout) — a
-- correlação dela é por provider_subscription_id, trabalho da Fase 4b.
--
-- Padrão platform_secrets/platform_flags: FORCE RLS sem policies → acesso
-- exclusivo via Edge Function service_role. Frontend nunca lê esta tabela.

begin;

create table if not exists billing_checkout_sessions (
  provider_checkout_id text primary key,
  provider text not null default 'asaas',
  organization_id uuid not null references organizations(id) on delete cascade,
  plan_id uuid references billing_plans(id) on delete set null,
  purpose text not null
    check (purpose in ('subscription', 'implementation', 'ai_topup', 'other')),
  -- externalReference completo que gravamos no checkout; o aplicador o reparsa
  -- (parseExternalReference) para reidratar plano+purpose de forma idêntica ao
  -- caminho primário.
  external_reference text,
  created_at timestamptz not null default now()
);

comment on table billing_checkout_sessions is
  'Mapa checkoutId (Asaas) -> org/plano/purpose. O checkout hospedado nao propaga externalReference nem preserva o customer (13.7), entao o checkoutSession e o unico elo para correlacionar o pagamento a org no webhook. FORCE RLS sem policies — so service_role.';

create index if not exists billing_checkout_sessions_org_idx
  on billing_checkout_sessions (organization_id);

alter table billing_checkout_sessions enable row level security;
alter table billing_checkout_sessions force row level security;

commit;
