-- Migration 024: dropa policy SELECT do bucket unit-assets.
--
-- O bucket é público (bucket.public = true), o que já permite recuperar
-- objetos pela URL pública (`/storage/v1/object/public/unit-assets/<path>`)
-- sem nenhuma policy SELECT. A policy `public_read_unit_assets` apenas
-- habilitava o endpoint /list/ — listar todos os arquivos do bucket — o
-- que aparecia como WARN no advisor (lint 0025) e não é necessário pra UX
-- do portal/painel (URLs são guardadas em colunas como hero_image_url e
-- logo_url, nunca por listagem).
--
-- Após esta migration:
--   • <project>.supabase.co/storage/v1/object/public/unit-assets/<path> → continua OK
--   • <project>.supabase.co/storage/v1/object/list/unit-assets         → 401/403
--
-- Policies de INSERT/UPDATE/DELETE permanecem inalteradas (writes restritos
-- a owner/gerente da unit-dona do path).

drop policy if exists "public_read_unit_assets" on storage.objects;
