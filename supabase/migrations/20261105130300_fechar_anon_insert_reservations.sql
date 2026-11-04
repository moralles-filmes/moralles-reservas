-- Fecha a escrita direta de anon em reservations (policy anon_insert_reservations
-- da 023b + o grant de tabela que o Supabase dá a anon por padrão).
--
-- Nenhum caminho do produto grava reservations como anon: a reserva pública vai
-- pela EF create-reservation com service role (reserveSlot), a manual pela
-- create-manual-reservation, o agente e o Instagram também por service role.
-- A tela não insere em reservations. A policy só deixava a anon key do bundle
-- criar reserva crua pela REST, sem disponibilidade, sem duração, sem
-- rate-limit e, com a exclusão por duração da 20261105130100, trancando a
-- janela de quem reservasse depois.
--
-- Duas trancas, cada uma suficiente (pré-voo 83, A-1…A-7):
--   1. sem a policy, a RLS (FORCE) recusa qualquer linha de anon;
--   2. sem INSERT, anon nem chega à RLS (42501 permission denied).
-- O guard app_private.guard_anon_reservation_table (120100) fica como terceira
-- tranca para o caso de alguém reabrir as duas.
--
-- Não mexe em anon_insert_customers nem em waitlist (decisões à parte). A
-- leitura anon de units/organizations da 086 continua: outras policies e RPCs
-- públicas dependem dela.
--
-- Idempotente: drop if exists + revoke (revoke do que não existe é no-op).
--
-- Rollback (só em emergência; reabre a escrita crua de anon pela REST):
--   grant insert on table public.reservations to anon;
--   create policy "anon_insert_reservations" on public.reservations
--     for insert to anon with check (unit_id is not null and exists (
--       select 1 from public.units u join public.organizations o on o.id = u.organization_id
--        where u.id = unit_id and u.is_public = true and o.is_public = true));

begin;

drop policy if exists "anon_insert_reservations" on public.reservations;

revoke insert on table public.reservations from anon;

commit;
