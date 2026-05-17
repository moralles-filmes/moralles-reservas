-- Backfill: units.price_range_min = NULL quando igual a price_range_max.
--
-- Auditoria 2026-05-17 (bug B1 do módulo "Minha Conta") flagrou que o painel
-- Conta.tsx tinha um único campo "Ticket médio" mas gravava o valor em DUAS
-- colunas idênticas (price_range_min = price_range_max). Resultado: portal
-- público renderiza "de R$ 150 até R$ 150" no lugar de "até R$ 150" (UX feio
-- e duplicação inútil).
--
-- O fix no frontend (commit acompanhante) passa a gravar apenas
-- price_range_max e deixar price_range_min NULL — formatters em
-- src/pages/PublicPortal.tsx (formatPriceRange) e src/pages/Index.tsx
-- (formatPriceRangeShort) já cobrem o branch min==null && max!=null
-- renderizando "até R$ X".
--
-- Esta migration faz o backfill de UNITS EXISTENTES: qualquer row que tinha
-- min == max (sinal claro de que veio do bug e não de configuração manual
-- via SQL admin) passa a ter min=NULL. Rows com min != max (alguém setou
-- faixa real via SQL admin) ficam intactas.
--
-- Idempotente: na 2ª execução, nenhum row casa o filtro (price_range_min
-- já foi para NULL na 1ª), o UPDATE não toca nada.
--
-- Safety:
--   * Sem mudança de schema, sem novo índice, sem nova policy. Só DML
--     escopado por WHERE estrito.
--   * Não toca em rows onde min IS NULL (já estão corretas).
--   * Não toca em rows onde min IS NOT NULL AND min <> max (configuração
--     manual legítima, fora do escopo do bug).
--   * Não dispara nenhum trigger custom em units (sem triggers escutando
--     UPDATE em price_range_*).

begin;

update public.units
set price_range_min = null
where price_range_min is not null
  and price_range_max is not null
  and price_range_min = price_range_max;

commit;
