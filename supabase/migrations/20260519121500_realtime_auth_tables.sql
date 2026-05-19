-- 20260519121500_realtime_auth_tables.sql
-- Garante que `unit_members` e `platform_admins` estejam na publication
-- `supabase_realtime`, pra que o `AuthContext` consiga detectar quando o
-- usuário corrente perde acesso (último unit_member deletado ou platform_admin
-- revogado) e disparar auto-logout no frontend em runtime.
--
-- Idempotente: usa DO block que ignora erro "table already in publication"
-- (SQLSTATE 42710). Seguro pra rodar várias vezes.
--
-- RLS dessas tabelas já restringe o que cada user lê; o subscribe do frontend
-- ainda filtra por `user_id=eq.<auth.uid()>`, então não há vazamento cross-user.

do $$
begin
  begin
    alter publication supabase_realtime add table unit_members;
  exception
    when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table platform_admins;
  exception
    when duplicate_object then null;
  end;
end $$;
