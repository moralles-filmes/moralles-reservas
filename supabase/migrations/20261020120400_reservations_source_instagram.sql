-- Instagram, Fase 1 (Task 1.5): `reservations.source` passa a aceitar
-- 'instagram', a origem da reserva feita pelo agente no Direct.
--
-- Spec:  docs/superpowers/specs/2026-10-19-instagram-modulo-design.md
-- Plano: docs/superpowers/plans/2026-10-20-instagram-fase-1-direct-conversas.md
--        (Task 1.5 e a decisão D6)
-- Pré-voo: supabase/tests/local-preflight/79a-instagram-bootstrap.sql (seção
--          3c) e 79-instagram-module.sql (README, seção "79 — Módulo
--          Instagram"), casos IG-5.1..IG-5.2 e controles C-IG-5.x.
--
-- O CHECK nasceu inline na 022 (20260506181440), então tem o nome automático
-- `reservations_source_check`. Ele é derrubado e recriado POR NOME com a lista
-- nova; um ADD sem o DROP somaria um segundo CHECK ao antigo e o antigo
-- continuaria recusando 'instagram'. Entra NOT VALID e é validado em seguida
-- (as linhas existentes são 'web'/'whatsapp', contidas na lista nova).
--
-- D6 — CONFIRMAÇÃO DA RESERVA DO INSTAGRAM VAI PELO WHATSAPP. O trigger
-- `enqueue_confirmation_notification` (028, `enqueue_confirmation_after_insert`)
-- NÃO MUDA: ele continua pulando só 'whatsapp' (o agente do WhatsApp confirma
-- na conversa). A reserva 'instagram' enfileira a `confirmation` em
-- `notification_outbox` como a 'web', e confirmação e lembretes chegam ao
-- cliente pelo WhatsApp; a IA do Direct diz isso ao cliente. Quem um dia
-- quiser confirmar pelo Direct muda o trigger em migration própria, não aqui.
-- Prova: IG-5.1 (a reserva 'instagram' enfileira a confirmação) e C-IG-5.1
-- (com o filtro `not in ('whatsapp','instagram')` o IG-5.1 reprova).
--
-- `reservations` é tabela quente de produção: o DROP/ADD pede ACCESS
-- EXCLUSIVE. Com `lock_timeout` a migration desiste em 5 s em vez de ficar na
-- fila atrás de uma leitura longa e travar toda escrita de reserva atrás dela.
-- Desistiu: nada muda (a transação inteira volta) e basta repetir o push.
--
-- Idempotente: reaplicar derruba e recria o mesmo CHECK. Sem função nova,
-- sem grant, sem URL do projeto e sem segredo.

begin;
set local lock_timeout = '5s';

alter table public.reservations
  drop constraint if exists reservations_source_check;
alter table public.reservations
  add constraint reservations_source_check
  check (source in ('web', 'whatsapp', 'instagram')) not valid;
alter table public.reservations
  validate constraint reservations_source_check;

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. Um CHECK de origem, validado, com a lista nova (esperado: 1 linha,
--    convalidated = true):
--   select conname, convalidated, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.reservations'::regclass and contype = 'c'
--      and pg_get_constraintdef(oid) like '%source%';
--
-- 2. O trigger de confirmação continua o da 028 (esperado: o corpo filtra só
--    'whatsapp'):
--   select prosrc from pg_proc
--    where oid = 'public.enqueue_confirmation_notification()'::regprocedure;
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- Só depois de confirmar que não há reserva 'instagram' (senão o VALIDATE
-- falha):
--   begin; set local lock_timeout = '5s';
--   alter table public.reservations drop constraint if exists reservations_source_check;
--   alter table public.reservations add constraint reservations_source_check
--     check (source in ('web', 'whatsapp')) not valid;
--   alter table public.reservations validate constraint reservations_source_check;
--   commit;
