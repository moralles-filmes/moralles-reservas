-- Entrega B, bloco B2: camada global do prompt do agente (versionada, só
-- platform_admin publica/restaura) + classe e guard de valor em `settings`.
-- Spec: docs/superpowers/specs/2026-10-19-agente-ia-prompt-global-e-modelos-design.md
-- (§4.2, §4.3, §5, §6.1, §6.2, §9). Pré-voo: supabase/tests/local-preflight/78*.
--
-- Twins (src/lib/global-prompt-sql-twin.test.ts) against
-- supabase/functions/_shared/agent/global-prompt-core.ts: the seed body, the
-- placeholders and the 4000 cap of `ai_prompt_body_valid`, the limits of
-- `unit_setting_value_limit` and the `agent_mode` enum of the value guard.
--
-- Writes to the three ai_prompt_* tables happen only inside the two SECURITY
-- DEFINER RPCs. The tables are FORCE RLS with a single SELECT policy, so those
-- writes rely on the function owner having BYPASSRLS (`postgres`, measured in
-- production on 2026-09-27 and 2026-10-17; preflight 80 C4 shows the
-- dependency with a non-superuser owner).
begin;
-- `drop trigger` on `settings` takes ACCESS EXCLUSIVE on a table every worker
-- reads: fail fast instead of queueing reads behind a long transaction.
set local lock_timeout = '5s';

-- ─── Validators (single rule for the CHECKs and the RPCs) ────────────────────
-- Body: 1..4000 chars, at least one non-blank, only {{agent_name}} and
-- {{restaurant_name}} as placeholders, no <<< / >>> (store-data delimiters),
-- no control char other than \t and \n (NUL never reaches a text value).
create or replace function app_private.ai_prompt_body_valid(p_body text)
returns boolean language sql immutable set search_path = '' as $$
  select p_body is not null
     and pg_catalog.char_length(p_body) between 1 and 4000
     and p_body ~ '\S'
     and pg_catalog.regexp_replace(p_body, '\{\{(agent_name|restaurant_name)\}\}', '', 'g') !~ '\{\{|\}\}'
     and p_body !~ '<<<|>>>'
     and p_body !~ '[\x01-\x08\x0b-\x1f\x7f]'
$$;

create or replace function app_private.ai_prompt_note_valid(p_note text)
returns boolean language sql immutable set search_path = '' as $$
  select p_note is not null
     and pg_catalog.char_length(p_note) between 1 and 280
     and p_note ~ '\S'
$$;

revoke all on function app_private.ai_prompt_body_valid(text) from public, anon, authenticated, service_role;
revoke all on function app_private.ai_prompt_note_valid(text) from public, anon, authenticated, service_role;

-- ─── Tables ──────────────────────────────────────────────────────────────────
-- `body_sha256` is filled by the writers (seed and publish RPC): a generated
-- column is refused because convert_to/textsend are STABLE, not IMMUTABLE.
create table if not exists public.ai_prompt_versions (
  id          uuid primary key default gen_random_uuid(),
  slot        text not null check (slot in ('global_persona')),
  version     integer not null check (version >= 1),
  body        text not null check (app_private.ai_prompt_body_valid(body)),
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  note        text not null check (app_private.ai_prompt_note_valid(note)),
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users (id),
  constraint ai_prompt_versions_slot_version_key unique (slot, version),
  constraint ai_prompt_versions_slot_id_key unique (slot, id),
  constraint ai_prompt_versions_author_check check (created_by is not null or version = 1)
);

create table if not exists public.ai_prompt_slots (
  slot              text primary key check (slot in ('global_persona')),
  active_version_id uuid not null,
  activated_at      timestamptz not null default now(),
  activated_by      uuid,
  constraint ai_prompt_slots_active_version_fkey foreign key (slot, active_version_id)
    references public.ai_prompt_versions (slot, id)
);

create table if not exists public.ai_prompt_activations (
  id                  uuid primary key default gen_random_uuid(),
  slot                text not null check (slot in ('global_persona')),
  version_id          uuid not null,
  previous_version_id uuid,
  kind                text not null check (kind in ('seed', 'publish', 'rollback')),
  actor               uuid,
  note                text not null check (app_private.ai_prompt_note_valid(note)),
  at                  timestamptz not null default now(),
  constraint ai_prompt_activations_version_fkey foreign key (slot, version_id)
    references public.ai_prompt_versions (slot, id),
  constraint ai_prompt_activations_previous_fkey foreign key (slot, previous_version_id)
    references public.ai_prompt_versions (slot, id),
  constraint ai_prompt_activations_actor_check check (actor is not null or kind = 'seed'),
  constraint ai_prompt_activations_previous_check check ((kind = 'seed') = (previous_version_id is null))
);

-- ─── Append-only history ─────────────────────────────────────────────────────
create or replace function app_private.ai_prompt_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'ai_prompt_history_append_only' using errcode = '42501';
end
$$;

revoke all on function app_private.ai_prompt_append_only() from public, anon, authenticated, service_role;

drop trigger if exists ai_prompt_versions_append_only on public.ai_prompt_versions;
create trigger ai_prompt_versions_append_only
  before update or delete on public.ai_prompt_versions
  for each row execute function app_private.ai_prompt_append_only();
drop trigger if exists ai_prompt_versions_no_truncate on public.ai_prompt_versions;
create trigger ai_prompt_versions_no_truncate
  before truncate on public.ai_prompt_versions
  for each statement execute function app_private.ai_prompt_append_only();

drop trigger if exists ai_prompt_activations_append_only on public.ai_prompt_activations;
create trigger ai_prompt_activations_append_only
  before update or delete on public.ai_prompt_activations
  for each row execute function app_private.ai_prompt_append_only();
drop trigger if exists ai_prompt_activations_no_truncate on public.ai_prompt_activations;
create trigger ai_prompt_activations_no_truncate
  before truncate on public.ai_prompt_activations
  for each statement execute function app_private.ai_prompt_append_only();

-- The slot row is updated by the RPCs but never removed: without it publish
-- fails forever and reapplying this file would re-seed the slot on v1.
drop trigger if exists ai_prompt_slots_no_delete on public.ai_prompt_slots;
create trigger ai_prompt_slots_no_delete
  before delete on public.ai_prompt_slots
  for each row execute function app_private.ai_prompt_append_only();
drop trigger if exists ai_prompt_slots_no_truncate on public.ai_prompt_slots;
create trigger ai_prompt_slots_no_truncate
  before truncate on public.ai_prompt_slots
  for each statement execute function app_private.ai_prompt_append_only();

-- ─── RLS and grants ──────────────────────────────────────────────────────────
alter table public.ai_prompt_versions enable row level security;
alter table public.ai_prompt_versions force row level security;
alter table public.ai_prompt_slots enable row level security;
alter table public.ai_prompt_slots force row level security;
alter table public.ai_prompt_activations enable row level security;
alter table public.ai_prompt_activations force row level security;

drop policy if exists platform_admin_read_ai_prompt_versions on public.ai_prompt_versions;
create policy platform_admin_read_ai_prompt_versions on public.ai_prompt_versions
  for select to authenticated using (app_private.is_platform_admin((select auth.uid())));
drop policy if exists platform_admin_read_ai_prompt_slots on public.ai_prompt_slots;
create policy platform_admin_read_ai_prompt_slots on public.ai_prompt_slots
  for select to authenticated using (app_private.is_platform_admin((select auth.uid())));
drop policy if exists platform_admin_read_ai_prompt_activations on public.ai_prompt_activations;
create policy platform_admin_read_ai_prompt_activations on public.ai_prompt_activations
  for select to authenticated using (app_private.is_platform_admin((select auth.uid())));

-- service_role included: the Supabase default privileges give it ALL on new
-- tables, and the history is written only by the RPCs.
revoke all on table public.ai_prompt_versions, public.ai_prompt_slots, public.ai_prompt_activations
  from public, anon, authenticated, service_role;
grant select on table public.ai_prompt_versions, public.ai_prompt_slots, public.ai_prompt_activations
  to authenticated, service_role;

-- ─── RPCs ────────────────────────────────────────────────────────────────────
-- The `-- <x>` / `-- </x>` markers delimit each guard for the preflight 80
-- positive controls (C5..C8); keep them around the guard they name.
create or replace function public.publish_ai_prompt_version(
  p_slot text, p_body text, p_note text, p_expected_active_version_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_active uuid;
  v_next integer;
  v_id uuid;
begin
  -- <guard>
  -- Real platform_admin from the JWT only; service_role has no `sub` and lands here too.
  if v_uid is null or not app_private.is_platform_admin(v_uid) then
    raise exception 'prompt_forbidden' using errcode = '42501';
  end if;
  -- </guard>

  select s.active_version_id into v_active
    from public.ai_prompt_slots s
   where s.slot = p_slot
     for update;
  if not found then
    raise exception 'prompt_slot_invalid' using errcode = '22023';
  end if;
  -- <conflict>
  if v_active is distinct from p_expected_active_version_id then
    raise exception 'prompt_version_conflict' using errcode = '40001';
  end if;
  -- </conflict>
  -- <body-check>
  if app_private.ai_prompt_body_valid(p_body) is not true then
    raise exception 'prompt_body_invalid' using errcode = '22023';
  end if;
  -- </body-check>
  -- <note-check>
  if app_private.ai_prompt_note_valid(p_note) is not true then
    raise exception 'prompt_note_invalid' using errcode = '22023';
  end if;
  -- </note-check>

  -- The slot row lock serializes publishers, so max + 1 cannot collide.
  select pg_catalog.max(v.version) + 1 into v_next
    from public.ai_prompt_versions v
   where v.slot = p_slot;

  insert into public.ai_prompt_versions (slot, version, body, body_sha256, note, created_by)
  values (p_slot, v_next, p_body,
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_body, 'UTF8')), 'hex'),
          p_note, v_uid)
  returning id into v_id;

  update public.ai_prompt_slots
     set active_version_id = v_id, activated_at = pg_catalog.now(), activated_by = v_uid
   where slot = p_slot;

  insert into public.ai_prompt_activations (slot, version_id, previous_version_id, kind, actor, note)
  values (p_slot, v_id, v_active, 'publish', v_uid, p_note);

  return v_id;
end
$$;

-- Rollback / restore of an existing version of the same slot.
create or replace function public.activate_ai_prompt_version(
  p_slot text, p_version_id uuid, p_expected_active_version_id uuid, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_active uuid;
begin
  -- <guard>
  if v_uid is null or not app_private.is_platform_admin(v_uid) then
    raise exception 'prompt_forbidden' using errcode = '42501';
  end if;
  -- </guard>

  select s.active_version_id into v_active
    from public.ai_prompt_slots s
   where s.slot = p_slot
     for update;
  if not found then
    raise exception 'prompt_slot_invalid' using errcode = '22023';
  end if;
  -- <conflict>
  if v_active is distinct from p_expected_active_version_id then
    raise exception 'prompt_version_conflict' using errcode = '40001';
  end if;
  -- </conflict>
  if app_private.ai_prompt_note_valid(p_note) is not true then
    raise exception 'prompt_note_invalid' using errcode = '22023';
  end if;
  -- <version-check>
  -- The composite FK also refuses a foreign slot; this gives the clean code
  -- and refuses a no-op activation of the version already active.
  if p_version_id is null
     or p_version_id = v_active
     or not exists (select 1 from public.ai_prompt_versions v
                     where v.slot = p_slot and v.id = p_version_id) then
    raise exception 'prompt_version_invalid' using errcode = '22023';
  end if;
  -- </version-check>

  update public.ai_prompt_slots
     set active_version_id = p_version_id, activated_at = pg_catalog.now(), activated_by = v_uid
   where slot = p_slot;

  insert into public.ai_prompt_activations (slot, version_id, previous_version_id, kind, actor, note)
  values (p_slot, p_version_id, v_active, 'rollback', v_uid, p_note);
end
$$;

revoke all on function public.publish_ai_prompt_version(text, text, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.activate_ai_prompt_version(text, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.publish_ai_prompt_version(text, text, text, uuid) to authenticated;
grant execute on function public.activate_ai_prompt_version(text, uuid, uuid, text) to authenticated;

-- ─── Seed (v1 = the persona segment of the agent prompt, byte for byte) ──────
-- Reapplying never moves the slot back to v1 after a publication.
with seed(body) as (
  values ($seed$IDENTIDADE: Você se chama {{agent_name}} e atende como parte da equipe do {{restaurant_name}} — fale sempre na primeira pessoa, de forma natural e humana, tratando o cliente por "você". NÃO diga espontaneamente que é um assistente virtual, robô, IA, bot ou sistema automático, e não use linguagem robótica. Só revele que é um atendimento virtual se o cliente perguntar DIRETAMENTE se está falando com um robô/IA/atendente automático — nesse caso seja honesta e responda com naturalidade (ex: "Sou a {{agent_name}}, faço o atendimento virtual do {{restaurant_name}} e quando precisar chamo alguém da equipe"). Ao transferir para um colega (handoff), dizer que vai chamar alguém da equipe NÃO exige revelar que você é virtual. Seja cordial, eficiente e responda sempre em português brasileiro. Respostas curtas e diretas — em geral 3 a 4 linhas; use mais espaço só quando precisar listar horários, opções ou preços. Evite excesso de emojis. $seed$)
)
insert into public.ai_prompt_versions (slot, version, body, body_sha256, note, created_by)
select 'global_persona', 1, s.body,
       pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(s.body, 'UTF8')), 'hex'),
       'seed', null
  from seed s
on conflict (slot, version) do nothing;

insert into public.ai_prompt_slots (slot, active_version_id, activated_at, activated_by)
select v.slot, v.id, now(), null
  from public.ai_prompt_versions v
 where v.slot = 'global_persona' and v.version = 1
on conflict (slot) do nothing;

insert into public.ai_prompt_activations (slot, version_id, previous_version_id, kind, actor, note)
select v.slot, v.id, null, 'seed', null, 'seed'
  from public.ai_prompt_versions v
 where v.slot = 'global_persona' and v.version = 1
   and not exists (select 1 from public.ai_prompt_activations a
                    where a.slot = 'global_persona' and a.kind = 'seed');

-- ─── settings: the three factual store keys become `manager` ─────────────────
-- Keep in sync with scripts/settings-write-acl.test.ts (Gestão writers; the new
-- keys come from AI_STORE_SETTING_KEYS in src/lib/ai-store-settings.ts).
create or replace function app_private.unit_setting_write_class(p_key text)
returns text language sql immutable set search_path = '' as $$
  select case when p_key = any (array[
    'reservation_duration_minutes','booking_window_days','reservation_tolerance_minutes',
    'rules_and_conditions','additional_info','reminder_d1_enabled','survey_d1_enabled',
    'waitlist_qr_enabled','waitlist_menu_link_enabled','waitlist_priority_enabled',
    'waitlist_code_min','waitlist_code_max','waitlist_tolerance_minutes',
    'waitlist_remote_entry_enabled','waitlist_remote_entry_limit',
    'waitlist_entered_enabled','waitlist_feedback_enabled',
    'giftback_whatsapp_enabled','giftback_email_enabled','giftback_message_template',
    'restaurant_menu','delivery_response','restaurant_extra_info',
    'allow_overbooking','restaurant_name'
  ]::text[]) then 'manager' else 'platform' end
$$;

revoke all on function app_private.unit_setting_write_class(text) from public, anon, authenticated, service_role;

-- ─── settings: value guard (shape and size, every role) ──────────────────────
-- Text keys that reach the agent prompt. Key outside the list -> null (not
-- validated here).
create or replace function app_private.unit_setting_value_limit(p_key text)
returns integer language sql immutable set search_path = '' as $$
  select case p_key
    when 'restaurant_menu' then 6000
    when 'restaurant_extra_info' then 3000
    when 'delivery_response' then 1500
    when 'rules_and_conditions' then 3000
    when 'additional_info' then 2000
    when 'ai_context_extra' then 3000
    when 'ai_system_prompt' then 4000
    when 'agent_name' then 40
  end
$$;

-- Runs for every role, service_role and migrations included: data shape is not
-- a role question. The refusal depends only on the value sent, never on the
-- state of another unit (no oracle). SECURITY DEFINER because the caller has no
-- EXECUTE on the limit function.
create or replace function app_private.guard_unit_setting_value()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_limit integer;
  v_text text;
begin
  if new.key = 'agent_mode' then
    if pg_catalog.jsonb_typeof(new.value) is distinct from 'string'
       or (new.value #>> '{}') <> all (array['reservations', 'reservations_faq']) then
      raise exception 'setting_value_invalid' using errcode = '22023';
    end if;
    return new;
  end if;

  v_limit := app_private.unit_setting_value_limit(new.key);
  if v_limit is null then
    return new;
  end if;
  if pg_catalog.jsonb_typeof(new.value) is distinct from 'string' then
    raise exception 'setting_value_invalid' using errcode = '22023';
  end if;
  v_text := new.value #>> '{}';
  if pg_catalog.char_length(v_text) > v_limit or v_text ~ '[\x01-\x08\x0b-\x1f\x7f]' then
    raise exception 'setting_value_invalid' using errcode = '22023';
  end if;
  return new;
end
$$;

revoke all on function app_private.unit_setting_value_limit(text) from public, anon, authenticated, service_role;
revoke all on function app_private.guard_unit_setting_value() from public, anon, authenticated, service_role;

-- Name orders it after settings_write_role_guard (BEFORE triggers fire by name):
-- the role is checked first, so an invalid value from a forbidden role still
-- gets setting_write_forbidden.
drop trigger if exists settings_write_value_guard on public.settings;
create trigger settings_write_value_guard
  before insert or update on public.settings
  for each row execute function app_private.guard_unit_setting_value();

commit;
