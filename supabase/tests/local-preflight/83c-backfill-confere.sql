-- 83c: confere o backfill da 20261105130100 sobre a semente do 83b (README §83).
-- Termina com erro se o estado diverge.
\set ON_ERROR_STOP on
do $$
declare
  v text;
  v_expected constant text :=
    '101:11:t/f 102:12:t/f 1b1:31:t/f 801:13:t/f 802:13:f/t 803:13:f/f 804:14:t/f|w:301:12 3b1:31';
begin
  select (select string_agg(right(ot.reservation_id::text, 3) || ':' || t.number || ':'
                            || left(ot.blocks_slot::text, 1) || '/' || left(ot.overlap_ok::text, 1),
                            ' ' order by ot.reservation_id)
            from public.occupant_tables ot join public.tables t on t.id = ot.table_id
           where ot.reservation_id is not null)
      || '|w:' ||
         (select string_agg(right(ot.walk_in_id::text, 3) || ':' || t.number, ' ' order by ot.walk_in_id)
            from public.occupant_tables ot join public.tables t on t.id = ot.table_id
           where ot.walk_in_id is not null)
    into v;
  raise notice '83c: %', v;
  if v is distinct from v_expected then
    raise exception '83c: backfill divergente: % (esperado %)', v, v_expected;
  end if;
  raise notice '83c: PASS';
end $$;
