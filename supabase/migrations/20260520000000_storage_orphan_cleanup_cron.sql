-- Limpeza periódica de blobs órfãos no bucket `unit-assets`.
--
-- Cobre a limitação dos cleanups inline dos hooks (Conta, MenuDetail,
-- MeusCardapios, MenuBannerEditor): quando o usuário sobe imagem e fecha
-- a aba SEM salvar nem cancelar, o blob fica em Storage sem referência
-- em DB. Os hooks limpam órfãos da sessão atual; este job varre o bucket
-- inteiro semanalmente.
--
-- Componentes desta migration:
--   1. RPC `list_orphan_unit_assets(grace_minutes)` — SECURITY DEFINER que
--      cruza storage.objects com todas as colunas de imagem do schema.
--      Restrita a service_role (consumida pela edge function).
--   2. Wrapper `trigger_cleanup_orphan_assets()` — chama a edge function
--      via pg_net usando INTERNAL_API_KEY do Vault.
--   3. cron.schedule semanal — domingo 04:00 UTC = 01:00 BRT (off-peak).
--
-- Como o pg_cron roda no Postgres (sem acesso aos secrets de Edge Function),
-- INTERNAL_API_KEY precisa estar no Vault (já cadastrado pelos outros
-- workers — process-notification-outbox, process-voucher-triggers etc).
-- Se não estiver, o job ignora a chamada e loga notice — não quebra nada.

create extension if not exists pg_cron;

-- ─── 1. RPC SECURITY DEFINER pra listar órfãos ────────────────────────────────

create or replace function list_orphan_unit_assets(grace_minutes integer default 60)
returns table (path text, bytes bigint, created_at timestamptz)
language sql
stable
security definer
set search_path = public, storage
as $$
  with bucket_objects as (
    select name as path,
           (metadata->>'size')::bigint as bytes,
           created_at
    from storage.objects
    where bucket_id = 'unit-assets'
      and created_at < now() - make_interval(mins => grace_minutes)
  ),
  referenced_urls as (
    select hero_image_url as url from units where hero_image_url is not null
    union all
    select logo_url from units where logo_url is not null
    union all
    select unnest(gallery_photos) from units where gallery_photos is not null and array_length(gallery_photos, 1) > 0
    union all
    select cover_image_url from menus where cover_image_url is not null
    union all
    select image_url from menu_pages where image_url is not null
    union all
    select image_url from menu_banners where image_url is not null
  ),
  referenced_paths as (
    select distinct substring(url from '/storage/v1/object/public/unit-assets/(.*)$') as path
    from referenced_urls
    where url like '%/storage/v1/object/public/unit-assets/%'
  )
  select bo.path, bo.bytes, bo.created_at
  from bucket_objects bo
  left join referenced_paths rp on rp.path = bo.path
  where rp.path is null
  order by bo.created_at asc;
$$;

revoke all on function list_orphan_unit_assets(integer) from public;
grant execute on function list_orphan_unit_assets(integer) to service_role;

comment on function list_orphan_unit_assets(integer) is
  'Lista blobs órfãos no bucket unit-assets (sem referência em units/menus/menu_pages/menu_banners), respeitando grace period em minutos. Consumida pela edge function cleanup-orphan-assets — service_role apenas.';

-- ─── 2. Wrapper pra disparar a edge function via pg_net ──────────────────────

create or replace function trigger_cleanup_orphan_assets()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  api_key text;
  project_url text := 'https://gbabxcrntkwgblgqsiit.supabase.co';
begin
  select decrypted_secret into api_key
  from vault.decrypted_secrets
  where name = 'internal_api_key'
  limit 1;

  if api_key is null or api_key = '' then
    raise notice '[cleanup-orphans] internal_api_key ausente no Vault — skip';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/cleanup-orphan-assets',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-key', api_key
    ),
    body := jsonb_build_object('grace_minutes', 60),
    timeout_milliseconds := 60000
  );
end;
$$;

-- ─── 3. Schedule semanal ─────────────────────────────────────────────────────
--
-- Domingo 04:00 UTC = 01:00 BRT (madrugada, fora de qualquer horário de
-- pico de restaurante). Toda quarta-feira pode ser uma alternativa, mas
-- domingo é mais seguro pra cleanup que pode demorar.

do $$
begin
  perform cron.unschedule('cleanup-orphan-assets');
exception when others then
  null;
end $$;

select cron.schedule(
  'cleanup-orphan-assets',
  '0 4 * * 0',
  'select trigger_cleanup_orphan_assets();'
);
