-- 094 — Modelo comercial de dois planos: declaracao de features pelo plano.
--
-- ADITIVA. Plano com `included_features` vazio continua resolvendo por
-- FEATURE_CATEGORIES.
--
-- ATENCAO: `included_features` e AUTORIZACAO e NAO tem relacao com a coluna
-- `features` (jsonb), que e copy de marketing renderizada no PricingCard e
-- editada como textarea. Confundir as duas faria um administrador conceder
-- acesso ao editar uma frase comercial.

alter table billing_plans
  add column if not exists included_features text[] not null default '{}',
  add column if not exists included_whatsapp_connections integer not null default 0,
  add column if not exists whatsapp_component_cents integer;

do $$
begin
  -- conrelid junto do conname: nome de constraint e unico por TABELA, nao por
  -- banco. Checar so o nome faria um homonimo em outra tabela pular a criacao.
  if not exists (
    select 1 from pg_constraint
    where conname = 'billing_plans_included_features_chk'
      and conrelid = 'billing_plans'::regclass
  ) then
    alter table billing_plans
      add constraint billing_plans_included_features_chk
      check (
        -- Vocabulario FECHADO nos valores de EntitlementFeature.
        included_features <@ array['system','whatsapp','ai']::text[]
        -- E sem NULL DENTRO do array: `array['system',null] <@ array[...]`
        -- avalia UNKNOWN, e CHECK aceita UNKNOWN. Sem esta linha, um elemento
        -- nulo atravessaria o vocabulario fechado em silencio.
        and array_position(included_features, null) is null
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'billing_plans_included_connections_chk'
      and conrelid = 'billing_plans'::regclass
  ) then
    alter table billing_plans
      add constraint billing_plans_included_connections_chk
      check (included_whatsapp_connections >= 0);
  end if;

  -- O componente atribuido nunca excede o que o cliente paga.
  if not exists (
    select 1 from pg_constraint
    where conname = 'billing_plans_whatsapp_component_chk'
      and conrelid = 'billing_plans'::regclass
  ) then
    alter table billing_plans
      add constraint billing_plans_whatsapp_component_chk
      check (whatsapp_component_cents is null
             or (whatsapp_component_cents >= 0
                 and whatsapp_component_cents <= amount_cents));
  end if;
end $$;

comment on column billing_plans.included_features is
  'AUTORIZACAO. Features concedidas pelo plano (system|whatsapp|ai). NAO CONFUNDIR '
  'com billing_plans.features, que e copy de marketing sem efeito sobre acesso. '
  'Array vazio = plano legado, resolve por FEATURE_CATEGORIES. Array NAO vazio = '
  'declaracao explicita, que SUBSTITUI qualquer heranca implicita. '
  'Duplicatas nao sao proibidas pelo CHECK: a normalizacao e responsabilidade do '
  'seed e do fluxo administrativo de edicao (manage-billing), nao do banco.';

comment on column billing_plans.included_whatsapp_connections is
  'Conexoes de WhatsApp incluidas. Plano 1 = 0, Plano 2 = 1. Default 0 nas linhas '
  'PRE-EXISTENTES nao significa "sem conexao": contrato legado usa a politica '
  'historica, nao esta coluna. Ver whatsapp-connection-allowance-core.ts.';

comment on column billing_plans.whatsapp_component_cents is
  'Parcela contratual da mensalidade atribuivel ao PACOTE DE AUTOMACAO (WhatsApp '
  '+ IA + operacao relacionada). NAO e receita exclusiva da instancia Z-API. '
  'Congelada no ciclo na abertura (revenue_source=PLAN_COMPONENT).';

-- ROLLBACK (manual):
--   update billing_plans set included_features = '{}';
--   -- o resolvedor volta ao caminho de categoria, sem migration reversa.
