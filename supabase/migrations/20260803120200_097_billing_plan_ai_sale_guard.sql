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
-- Dropar este constraint e a ULTIMA acao do Plano D, depois de o teto estar
-- provado contra banco real — nunca antes, e nunca "so pra testar".
--
-- Entregar como MIGRATION, nunca como SQL avulso no Studio. Duas razoes:
--   1. SQL colado no Studio grava schema_migrations com timestamp != filename e
--      trava o proximo `db push` por drift (recovery exige migration repair).
--   2. Um `db reset` / replay do historico RESSUSCITA o constraint. Sem uma
--      migration que o derrube, o Plano D seria silenciosamente desfeito.
--
-- Numero e timestamp da migration de drop:
--   - o numero NAO e 099. 099 a 103 ja sao do Plano D — usar 104 ou o proximo
--     livre no momento da entrega.
--   - o timestamp precisa ser MAIOR que 20260803120300 (a 098 deste par).
--     `drop constraint if exists` aplicado ANTES da constraint existir e no-op
--     SILENCIOSO: o portao parece aberto, o plano-automacao segue invendavel, e
--     ninguem descobre ate a primeira tentativa de venda.
--
--   -- supabase/migrations/<ts > 20260803120300>_104_drop_ai_sale_guard.sql
--   alter table billing_plans
--     drop constraint if exists billing_plans_ai_plan_not_sellable_chk;

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
