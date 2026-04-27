-- Hardening followups detectados pelos advisors após 005:
-- 1. check_rate_limit estava herdando EXECUTE para anon/authenticated mesmo
--    com `revoke from public` — exigiu revoke explícito por role.
-- 2. update_updated_at (criada em 002) tinha search_path mutável.

revoke execute on function public.check_rate_limit(text, integer, integer) from anon;
revoke execute on function public.check_rate_limit(text, integer, integer) from authenticated;

create or replace function public.update_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
