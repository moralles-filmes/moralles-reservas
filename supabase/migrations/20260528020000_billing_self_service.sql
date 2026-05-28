-- Self-service de assinaturas: cliente escolhe plano e cadastra próprio cartão via Stripe Checkout.
--
-- Adiciona em billing_plans:
--   - trial_days  → trial configurável por plano (default 0 = sem trial)
--   - description → subtítulo curto exibido na pricing table pública
--   - popular     → flag de destaque na pricing table
--
-- O schema features jsonb já existe (default '{}') — a partir desta migration
-- a UI passa a popular como array de strings ["Feature 1", "Feature 2", ...].
-- Parse defensivo no frontend trata o legado '{}' como [] automaticamente.

begin;

alter table billing_plans
  add column if not exists trial_days int not null default 0,
  add column if not exists description text,
  add column if not exists popular boolean not null default false;

-- CHECK separado pra permitir add column if not exists sem conflito
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'billing_plans_trial_days_check'
  ) then
    alter table billing_plans
      add constraint billing_plans_trial_days_check
      check (trial_days >= 0);
  end if;
end $$;

comment on column billing_plans.trial_days is
  'Dias de trial antes da primeira cobrança via Stripe. 0 = sem trial. Usado em Checkout Session via subscription_data[trial_period_days].';
comment on column billing_plans.description is
  'Subtítulo curto do plano exibido abaixo do nome na pricing table pública.';
comment on column billing_plans.popular is
  'Flag de destaque visual na pricing table. Apenas 1 plano deveria estar marcado por vez (não enforced via constraint — flexibilidade comercial).';

commit;
