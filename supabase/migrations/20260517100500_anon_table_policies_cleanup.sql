-- 057_anon_table_policies_cleanup.sql
-- Remove 3 policies que dão SELECT direto pra role `anon` em tabelas privadas.
-- Conforme CLAUDE.md: "Anon nunca lê tabelas direto — toda leitura pública via
-- RPC SECURITY DEFINER". Essas policies (criadas na migration 013) eram um
-- vazio normativo que permitia anon listar:
--
--   - tables ATIVAS de QUALQUER unit (topologia interna)
--   - business_hours de QUALQUER unit (mesmo as não-públicas)
--   - settings de QUALQUER unit (configs internas como SMTP, IA, etc.)
--
-- O portal público (`/r/:slug`, `/w/:slug`, `/m/:slug`) sempre vai via RPCs
-- `get_unit_public_full`, `get_widget_public`, `get_public_business_hours` e
-- `get_public_hall_schedules` — esses sim filtram por `is_public`.
--
-- Verificação prévia (executada): grep no src/pages/{Index,PublicPortal,
-- WidgetPortal,MenuPortal}.tsx por `.from("tables"|"business_hours"|"settings")`
-- retornou 0 matches. Páginas autenticadas (/g/, /o/, /platform) seguem usando
-- as policies `unit_member_all_*` (authenticated).

drop policy if exists "anon_read_active_tables" on tables;
drop policy if exists "anon_read_business_hours" on business_hours;
drop policy if exists "anon_read_settings" on settings;
