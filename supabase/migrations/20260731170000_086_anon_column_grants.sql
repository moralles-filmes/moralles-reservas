-- Migration 086: fecha a leitura anon POR COLUNA em `organizations` e `units`.
--
-- Problema (medido em 2026-07-31 com a anon key do bundle):
--
--   GET /rest/v1/organizations?select=name,billing_email,billing_status,blocked_reason
--   → 200, devolvendo o e-mail de cobrança real de organização cliente.
--
-- Causa: `public_read_organizations` / `public_read_units` são policies
-- `for select to anon using (is_public = true)` criadas na 013, quando as duas
-- tabelas só tinham colunas de vitrine. Policy filtra LINHA, nunca COLUNA — e
-- as colunas administrativas vieram depois (`billing_email`, `blocked_reason`
-- em organizations; `cnpj`, `financial_email` em units). Cada coluna nova
-- entrou no alcance de `anon` sozinha, sem ninguém decidir isso.
--
-- Em units o vazamento é latente: `cnpj` e `financial_email` estão nulos em
-- todas as unidades hoje. Vaza no primeiro preenchimento.
--
-- Correção: privilégio por coluna. Postgres não decompõe um GRANT de tabela,
-- então é preciso revogar o grant de tabela e reconceder a lista explícita —
-- `revoke select (col)` sozinho é no-op quando o privilégio veio no nível da
-- tabela.
--
-- EFEITO COLATERAL DESEJADO: coluna nova nasce INVISÍVEL pra `anon`. Quem
-- adicionar coluna que o portal público precise ler direto tem que concedê-la
-- aqui de propósito. Fail-closed, igual ao que a 084/085 fizeram com EXECUTE.
--
-- As policies NÃO são dropadas: três policies de INSERT anon
-- (`anon_insert_customers`, `anon_insert_reservations`, `anon_insert_waitlist`,
-- migration 023b) fazem `exists (select 1 from organizations ...)` e
-- `join organizations o on o.id = u.organization_id`. Subquery dentro de policy
-- é avaliada com os privilégios de quem chama — dropar a policy de leitura
-- derrubaria a criação de reserva pública. Por isso `id` e `is_public` seguem
-- concedidos nas duas tabelas: é exatamente o que essas subqueries leem.

begin;

-- ── organizations ───────────────────────────────────────────────────────────
-- Nenhum caminho anon do frontend lê esta tabela (o único `.from("organizations")`
-- é o BillingGuard, autenticado, que passa por `org_member_read_organizations`).
-- Sobra só o que as subqueries das policies precisam.
revoke select on public.organizations from anon;
grant select (id, is_public) on public.organizations to anon;

-- ── units ───────────────────────────────────────────────────────────────────
-- Aqui `anon` LÊ de verdade: `useDiscoverUnits` monta a vitrine pública com
-- `.from("units").eq("is_public", true)`. Filtrar por uma coluna também exige
-- privilégio nela, então `is_public` entra. `organization_id` entra pelas
-- subqueries das policies de INSERT.
--
-- Fora da lista, de propósito: `cnpj` e `financial_email` — dado fiscal e
-- contato financeiro do lojista, editados em Gestão e lidos por
-- `useUnitPublicContent`, que roda autenticado e não é afetado.
revoke select on public.units from anon;
grant select (
  id,
  organization_id,
  name,
  slug,
  description,
  address,
  timezone,
  is_public,
  created_at,
  updated_at,
  price_range_min,
  price_range_max,
  hero_image_url,
  logo_url,
  cuisine_types,
  opening_hours_text,
  payment_methods,
  facilities,
  phone,
  instagram,
  website,
  gallery_photos
) on public.units to anon;

-- ── escrita ─────────────────────────────────────────────────────────────────
-- `anon` nunca escreveu nestas duas (não existe policy de INSERT/UPDATE/DELETE
-- pra anon em nenhuma das 112 migrations), mas o grant de tabela do baseline
-- Supabase continua lá: hoje só a RLS separa. Camada única. Revogar torna a
-- barreira dupla, e uma policy acidental no futuro deixa de virar escrita real.
revoke insert, update, delete on public.organizations from anon;
revoke insert, update, delete on public.units from anon;

commit;

-- ── rollback ────────────────────────────────────────────────────────────────
-- Se o portal público quebrar, isto restaura o estado anterior. A ORDEM importa:
-- o `revoke` limpa os grants de coluna, que não somem sozinhos quando se
-- reconcede no nível da tabela — sem ele ficam pendurados e confundem auditoria.
--
--   begin;
--   revoke select on public.organizations from anon;
--   grant  select on public.organizations to anon;
--   revoke select on public.units from anon;
--   grant  select on public.units to anon;
--   grant  insert, update, delete on public.organizations, public.units to anon;
--   commit;
