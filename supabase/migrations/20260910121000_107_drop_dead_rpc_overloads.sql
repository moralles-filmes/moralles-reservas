-- Dropa dois overloads de RPC sem caller.
--
-- POR QUÊ. Cada assinatura exposta a `authenticated` é uma linha WARN do lint
-- 0029 do Security Advisor. Estas duas não têm consumidor:
--
--   * get_reservation_by_code(p_code text) — o único call site
--     (src/hooks/useReservas.ts:101) sempre passa p_code E p_unit_id, então o
--     overload de 1 argumento já não tinha caller.
--   * get_customer_stats(p_customer_id uuid) — só era alcançável quando
--     useCustomerStats(customerId, unitId?) recebia unitId undefined; o hook
--     (src/hooks/useCustomers.ts) passa a exigir a unidade no mesmo commit e a
--     enviar p_unit_id sempre, então este overload também fica sem caller.
--
-- Os overloads de 2 argumentos — get_reservation_by_code(text, uuid) e
-- get_customer_stats(uuid, uuid) — NÃO são tocados: são os que a UI usa de
-- verdade. supabase/tests/local-preflight/11-overloads-107.sql prova os dois
-- lados: ACL-6 que eles sobrevivem, CONTROLE-8 que dropar o de 2 argumentos
-- por engano quebra o call site real.
--
-- Reversível: `013_multi_tenant.sql` é a ÚLTIMA migration a definir cada uma
-- das duas assinaturas — verificado por grep de
-- `create or replace function public.get_reservation_by_code`/`get_customer_stats`
-- em TODO o diretório de migrations, não assumido. Nenhuma migration entre a
-- 013 e esta redefine nenhuma das duas, então reaplicar os blocos da 013
-- restaura o corpo exato que existia em produção até este ponto. Migration
-- separada da 106 de propósito — perfis de risco diferentes, reversão
-- independente.

begin;

drop function if exists public.get_reservation_by_code(p_code text);
drop function if exists public.get_customer_stats(p_customer_id uuid);

commit;
