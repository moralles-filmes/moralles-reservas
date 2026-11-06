-- Contract do lease do giftback (expand em 20261106120000): o
-- process-voucher-triggers usa acquire/release_giftback_lease desde a v35 e
-- ninguém mais chama os wrappers do advisory lock de sessão.
-- Rollback: recriar as duas funções como em 20260517110000_giftback_hardening.sql.
begin;

drop function if exists public.try_giftback_lock();
drop function if exists public.release_giftback_lock();

commit;
