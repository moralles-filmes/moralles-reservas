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
-- Reversível, mas a fonte NÃO é a mesma migration para as duas assinaturas —
-- checar por nome de função sozinho (sem checar a aridade que cada arquivo
-- define) erra isso, e foi exatamente o erro da versão anterior deste
-- cabeçalho:
--
--   * get_reservation_by_code(text) — a ÚNICA definição é
--     `20260427200008_005_hardening.sql:17-54`. A 013 NUNCA definiu o overload
--     de 1 argumento; ela define só `get_reservation_by_code(text, uuid)`
--     (`013:584-629`) e seu próprio comentário (`013:631-632`) afirma "a versão
--     antiga (text) já não existe como função separada" — afirmação falsa,
--     contradita pelo dump de produção usado nesta migration (ver
--     `09a-advisor-bootstrap.sql`) e pela própria existência deste `drop`.
--     013 é migration aplicada; não se reescreve o comentário dela.
--   * get_customer_stats(uuid) — a ÚLTIMA definição é `013:751-770` (o
--     wrapper "Manter assinatura antiga (1 arg) para backward-compat", que
--     chama a versão de 2 argumentos com `p_unit_id => null`), depois de
--     `007_product_features.sql`.
--
-- Reconstruir só por `grep create or replace function public.<nome>` e pegar
-- o arquivo mais recente por nome (sem checar a aridade que ELE define) foi o
-- erro: dá um arquivo por nome, nunca por assinatura.
--
-- Fonte alternativa, e melhor para as DUAS (catálogo, não migration que pode
-- ter sido superada): dump de produção `supabase db dump --linked --schema
-- public` (mesmo usado para popular `09a-advisor-bootstrap.sql`, 2026-09-10),
-- que já contém as quatro definições verbatim. O dump não fica commitado no
-- repo — retirar de novo com esse mesmo comando contra o projeto
-- `gbabxcrntkwgblgqsiit` reproduz o catálogo atual.
--
-- Migration separada da 106 de propósito — perfis de risco diferentes,
-- reversão independente.

begin;

drop function if exists public.get_reservation_by_code(p_code text);
drop function if exists public.get_customer_stats(p_customer_id uuid);

commit;
