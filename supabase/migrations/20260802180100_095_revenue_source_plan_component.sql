-- 095 — Quinto valor de revenue_source: PLAN_COMPONENT.
--
-- Unica operacao deste modelo que toca constraint ja aplicada. SUPERSET:
-- nenhuma linha existente viola o CHECK novo e nenhuma linha e reescrita.
-- Ciclos ja fechados mantem o revenue_source que tem — e isso e o que
-- "congelado historicamente" significa.
--
-- O nome do constraint e o gerado pelo Postgres para o CHECK inline da coluna
-- na 088 (`revenue_source text check (...)`).

alter table whatsapp_instance_cycles
  drop constraint if exists whatsapp_instance_cycles_revenue_source_check;

alter table whatsapp_instance_cycles
  add constraint whatsapp_instance_cycles_revenue_source_check
  check (revenue_source is null or revenue_source in (
    'SUBSCRIPTION_SOLE_INSTANCE',
    'AMBIGUOUS_MULTI_INSTANCE',
    'LIFETIME_OVERRIDE',
    'NO_ENTITLEMENT',
    'PLAN_COMPONENT'
  ));

comment on column whatsapp_instance_cycles.revenue_source is
  'Origem da receita atribuida ao ciclo. PLAN_COMPONENT = componente contratual '
  'de AUTOMACAO declarado pelo plano de sistema (WhatsApp + IA + operacao). '
  'Nao e rateio e nao e receita pura da instancia: a margem consolidada precisa '
  'descontar tambem o custo de IA (Plano D).';

-- ROLLBACK: reversivel pelo par drop/add ENQUANTO nenhum ciclo tiver gravado
-- PLAN_COMPONENT. Depois disso, reverter exige decidir o que fazer com linhas
-- que sao historico financeiro.
