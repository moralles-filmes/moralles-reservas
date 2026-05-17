-- 056_reservations_unique_table_slot.sql
-- Previne double-booking quando duas requisições concorrentes encaixam na mesma
-- mesa/dia/hora (TOCTOU entre checkAvailability e INSERT em reserveSlot).
--
-- Partial unique index: aplica apenas a reservas ATIVAS (pending/confirmed) com
-- table_id atribuída. Reservas canceladas, no_show ou floating (overbooking)
-- são ignoradas, como esperado.
--
-- Quando o índice é violado, o Postgres retorna SQLSTATE 23505. O caller em
-- `_shared/availability.ts.reserveSlot` captura esse erro, re-checa
-- disponibilidade e tenta novamente — o usuário perdedor recebe "no_capacity"
-- ao invés de "insert_failed".
--
-- IMPORTANTE: antes de aplicar, validar que não há duplicatas pré-existentes:
--
--   select table_id, date, time, count(*)
--   from reservations
--   where table_id is not null and status in ('pending','confirmed')
--   group by 1,2,3 having count(*) > 1;
--
-- Se retornar linhas, resolver manualmente (mover ou cancelar) antes da migration.

create unique index if not exists reservations_unique_active_table_slot
  on reservations (table_id, date, time)
  where table_id is not null
    and status in ('pending', 'confirmed');

comment on index reservations_unique_active_table_slot is
  'Garante que mesma mesa/dia/hora não tenha 2 reservas ativas. Edge Function reserveSlot trata erro 23505 com retry e re-checagem.';
