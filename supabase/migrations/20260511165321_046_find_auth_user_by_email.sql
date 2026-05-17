-- Migration 046: RPC para buscar auth.users.id por email a partir de Edge Function.
--
-- Necessária porque o schema `auth` não é exposto via PostgREST e o caso de uso
-- "owner cadastra colaborador que já é membro de outra unidade da rede" precisa
-- reaproveitar o auth.users existente em vez de tentar criar e falhar com
-- "email already registered".
--
-- A função é SECURITY DEFINER (corre como dono = postgres) e tem execute
-- restrito a service_role — Edge Function manage-members chama via
-- supabase.rpc(...) usando service key.

begin;

create or replace function public.find_auth_user_by_email(p_email text)
returns uuid
language sql
security definer
set search_path = public, auth
as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1;
$$;

revoke all on function public.find_auth_user_by_email(text) from public;
revoke all on function public.find_auth_user_by_email(text) from anon;
revoke all on function public.find_auth_user_by_email(text) from authenticated;
grant execute on function public.find_auth_user_by_email(text) to service_role;

commit;
