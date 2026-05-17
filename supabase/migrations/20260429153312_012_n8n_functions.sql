-- 012_n8n_functions.sql
-- N8N integration functions:
--   1. check_rate_limit          — re-declared for idempotency (originally in 005)
--   2. append_message            — log automated WhatsApp messages to conversation history
--   3. get_upcoming_reservations — query reservations in a date range for N8N workflows

-- ─── 1. check_rate_limit (idempotent re-declaration from 005) ─────────────────

CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_phone          text,
  p_window_seconds integer,
  p_max            integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM rate_limit_events
   WHERE created_at < now() - interval '1 hour';

  SELECT count(*)
    INTO v_count
    FROM rate_limit_events
   WHERE phone = p_phone
     AND created_at > now() - make_interval(secs => p_window_seconds);

  IF v_count >= p_max THEN
    RETURN false;
  END IF;

  INSERT INTO rate_limit_events(phone) VALUES (p_phone);
  RETURN true;
END;
$$;

REVOKE ALL     ON FUNCTION public.check_rate_limit(text, integer, integer) FROM public;
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) TO service_role;

-- ─── 2. append_message ───────────────────────────────────────────────────────
-- Appends a {role, content, timestamp} object to conversations.messages (JSONB
-- array) and bumps updated_at. Used by N8N to record outbound WhatsApp messages.

CREATE OR REPLACE FUNCTION public.append_message(
  p_conv_id uuid,
  p_role    text,
  p_content text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE conversations
     SET messages   = messages || jsonb_build_object(
                        'role',      p_role,
                        'content',   p_content,
                        'timestamp', to_char(now() AT TIME ZONE 'UTC',
                                             'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                      ),
         updated_at = now()
   WHERE id = p_conv_id;
$$;

REVOKE ALL     ON FUNCTION public.append_message(uuid, text, text) FROM public;
REVOKE EXECUTE ON FUNCTION public.append_message(uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.append_message(uuid, text, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.append_message(uuid, text, text) TO service_role;

-- ─── 3. get_upcoming_reservations ────────────────────────────────────────────
-- Returns pending/confirmed reservations within a date range for N8N workflows
-- (e.g. daily digest, bulk reminders, capacity planning).

CREATE OR REPLACE FUNCTION public.get_upcoming_reservations(
  p_from_date date,
  p_to_date   date
)
RETURNS TABLE (
  reservation_id    uuid,
  reservation_code  text,
  reservation_date  date,
  reservation_time  time,
  party_size        integer,
  status            text,
  notes             text,
  customer_name     text,
  customer_phone    text,
  customer_email    text,
  table_number      integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    r.id,
    r.reservation_code,
    r.date,
    r.time,
    r.party_size,
    r.status,
    r.notes,
    c.name,
    c.phone,
    c.email,
    t.number
  FROM reservations r
  JOIN customers c   ON c.id = r.customer_id
  LEFT JOIN tables t ON t.id = r.table_id
  WHERE r.date BETWEEN p_from_date AND p_to_date
    AND r.status IN ('pending', 'confirmed')
  ORDER BY r.date, r.time;
$$;

REVOKE ALL     ON FUNCTION public.get_upcoming_reservations(date, date) FROM public;
REVOKE EXECUTE ON FUNCTION public.get_upcoming_reservations(date, date) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_upcoming_reservations(date, date) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.get_upcoming_reservations(date, date) TO service_role;
