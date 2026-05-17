-- Migration 059: hardening do módulo Cardápios
--
-- 1. CHECK em menu_banners.link_url — bloqueia javascript:/data:/vbscript:
--    direto no banco (defesa em profundidade; o frontend já valida em
--    MenuBannerEditor + bloqueia render em MenuPortal/BannerCarousel).
-- 2. Comentário documental em menus.theme registrando o contrato JSONB.
--
-- Antes de aplicar em produção, validar que não há dados violando o constraint:
--   select id, link_url from menu_banners
--   where link_url is not null and link_url !~* '^https?://';
-- Se retornar linhas, decidir caso a caso (sanitizar/anular antes do constraint).

begin;

-- ─── menu_banners.link_url: só http(s) ────────────────────────────────────────
alter table menu_banners
  drop constraint if exists menu_banners_link_url_safe_check;

alter table menu_banners
  add constraint menu_banners_link_url_safe_check
  check (
    link_url is null
    or link_url ~* '^https?://'
  );

-- ─── menus.theme: contrato documentado ────────────────────────────────────────
comment on column menus.theme is
  'JSONB com chaves font_primary, font_secondary, bg_primary, bg_secondary, accent — cada valor #RRGGBB. MenuPortal aplica fallback (DEFAULT_MENU_THEME) campo a campo se valor inválido.';

commit;
