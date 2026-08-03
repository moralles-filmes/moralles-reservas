-- 097 — PLAN_AUTOMACAO_CHECKOUT = NO-GO, no nivel do banco.
--
-- O teto de R$ 100 por ciclo (Plano D) e parte do modelo economico do Plano
-- Automacao: sem ele NAO EXISTE pior caso de custo, e a margem de 43% da §13
-- da spec perde o piso. Enquanto o teto nao estiver provado contra banco real,
-- nenhum plano que declare franquia de IA pode ser vendido.
--
-- `active = false` no seed ja basta para o checkout recusar
-- (create-billing-checkout/subscription.ts:50 devolve "Plano inativo."), mas
-- `active` e um ESTADO EDITAVEL: um clique em /platform/planos ligaria a venda
-- de um produto sem protecao financeira, e o painel nao tem como saber que
-- aquele switch especifico custa dinheiro. Este CHECK e o que transforma a
-- decisao comercial em invariante: nenhum painel, nenhuma Edge Function e
-- nenhum UPDATE manual conseguem ativar.
--
-- DEPENDE de 094 (coluna included_features, not null default '{}').
--
-- ROLLBACK / ENTREGA DO PLANO D:
--   alter table billing_plans
--     drop constraint if exists billing_plans_ai_plan_not_sellable_chk;
-- Dropar este constraint e a ULTIMA acao do Plano D, depois de o teto estar
-- provado contra banco real — nunca antes, e nunca "so pra testar".

do $$
begin
  -- conrelid junto do conname: nome de constraint e unico por TABELA, nao por
  -- banco. Checar so o nome faria um homonimo em outra tabela pular a criacao.
  -- Mesmo cuidado da 094.
  if not exists (
    select 1 from pg_constraint
    where conname = 'billing_plans_ai_plan_not_sellable_chk'
      and conrelid = 'billing_plans'::regclass
  ) then
    alter table billing_plans
      add constraint billing_plans_ai_plan_not_sellable_chk
      -- coalesce defensivo: a 094 declara NOT NULL, mas se a coluna algum dia
      -- virar nullable, `'ai' = any(null)` avalia UNKNOWN e o CHECK ACEITA
      -- UNKNOWN — o plano passaria. Mesma classe do array_position(...,null)
      -- da 094.
      check (not (active and 'ai' = any(coalesce(included_features, '{}'::text[]))));
  end if;
end $$;

comment on constraint billing_plans_ai_plan_not_sellable_chk on billing_plans is
  'PLAN_AUTOMACAO_CHECKOUT = NO-GO. Plano que declara franquia de IA em '
  'included_features nao pode ficar ativo enquanto o teto financeiro por ciclo '
  '(Plano D) nao existir e nao estiver provado contra banco real. Dropar este '
  'constraint e a ultima acao do Plano D.';
