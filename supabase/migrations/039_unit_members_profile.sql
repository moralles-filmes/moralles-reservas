-- Migration 039: módulo "Usuários" — adiciona dados de perfil em unit_members.
--
-- Hoje a UI tenta exibir o e-mail mas a tabela não tem essa coluna; o código cai
-- em fallback `user_id.slice(0, 8)` (mostra fragmento do UUID). Bug latente.
--
-- Adicionar colunas denormalizadas `email` e `name` resolve isso e permite
-- a tabela "Nome | E-mail | Função" da UI nova sem fazer JOIN com auth.users
-- (que precisa de service_role e quebraria o `select *` do hook do frontend).
--
-- O `email` é mantido em sync via Edge Function `manage-members` quando o membro
-- é criado. Se o usuário trocar o e-mail via Auth, a denormalização fica desync
-- — fora do escopo desta fase (frontend não bloqueia operação por isso).

begin;

alter table unit_members
  add column if not exists email text,
  add column if not exists name  text;

-- Backfill: copia o email atual de auth.users.
update unit_members um
set email = au.email
from auth.users au
where um.user_id = au.id and um.email is null;

commit;
