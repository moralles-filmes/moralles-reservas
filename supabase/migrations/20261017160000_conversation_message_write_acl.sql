-- Conversation history is provider evidence for the Meta 24h service window.
-- Browser clients may change handoff state but must never create or rewrite
-- inbound messages (or delete the whole conversation). Service-role writers
-- remain responsible for appending customer/assistant/human events.
begin;

revoke insert, update, delete, truncate on table public.conversations from public, anon, authenticated;
-- Table-level REVOKE does not remove older column-level grants. Revoke all
-- current columns as well, including grants added outside this migration chain.
do $$
declare v_columns text;
begin
  select string_agg(format('%I', a.attname), ', ' order by a.attnum)
    into v_columns
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.conversations'::pg_catalog.regclass
      and a.attnum > 0 and not a.attisdropped;
  execute format('revoke update (%s) on table public.conversations from public, anon, authenticated', v_columns);
  execute format('revoke insert (%s) on table public.conversations from public, anon, authenticated', v_columns);
end $$;
grant update (status, assigned_to, handoff_reason, handoff_at, updated_at)
  on table public.conversations to authenticated;

commit;
