-- Escolha de mesa, E6b: o link de escolha também sai pelo Direct do Instagram.
-- Plano: .tasks/escolha-de-mesa/PLAN.md (Fase 1); base: 20261105130200.
--
-- Aditiva (expand), nada a ler pelo front publicado.
--   * `seat_choice_links.instagram_account_id`: a conta do Instagram da
--     unidade pela qual o agente mandou o link. A EF `public-seat-map` lê dela
--     o @ da loja para o botão de volta (o WhatsApp segue por `channel_id`).
--     `on delete set null`, como `channel_id`: o link continua mostrando o
--     salão, só sem o botão de volta.
--   * CHECK: um link é de um canal só (WhatsApp OU Instagram; nenhum vale, como
--     já valia com `channel_id` nulo).
--   * `guard_seat_choice_link`: a conta do Instagram também precisa ser da
--     unidade do link (42501 seat_link_invalid, a mesma mensagem para conta
--     alheia e inexistente). O service role ignora RLS e o link vai para a mão
--     do cliente. `instagram_accounts.unit_id` é imutável
--     (`unit_module_tenant_guard`), então a conta não muda de unidade depois.
--     No UPDATE o guard passa a conferir só a coluna que mudou: corrige a
--     exclusão de unidade com link vivo, que esbarrava no salão já apagado
--     quando a cascata zerava o canal (defeito da 20261105130200).
--   Grants inalterados: a tabela segue só de service_role (select, insert, delete).
--
-- Rollback (migration nova, nunca edição desta): recriar
-- app_private.guard_seat_choice_link com o corpo da 20261105130200, drop da
-- constraint seat_choice_links_one_channel_check, do índice
-- seat_choice_links_instagram_account_idx e da coluna instagram_account_id.
-- Pré-voo: supabase/tests/local-preflight/83-escolha-de-mesa.sql (K-IG-*, README §83).
begin;
set local lock_timeout = '5s';

alter table public.seat_choice_links
  add column if not exists instagram_account_id uuid
    references public.instagram_accounts(id) on delete set null;
create index if not exists seat_choice_links_instagram_account_idx
  on public.seat_choice_links (instagram_account_id);

alter table public.seat_choice_links
  drop constraint if exists seat_choice_links_one_channel_check;
alter table public.seat_choice_links
  add constraint seat_choice_links_one_channel_check
    check (num_nonnulls(channel_id, instagram_account_id) <= 1);

comment on column public.seat_choice_links.instagram_account_id is
  'Conta do Instagram da unidade pela qual o link saiu (Direct). Nula para link do WhatsApp. O guard confere a unidade.';
comment on table public.seat_choice_links is
  'Link de escolha de mesa enviado pelo agente no WhatsApp (channel_id) ou no Direct do Instagram (instagram_account_id): salão, data, hora e pessoas do pedido, válido até expires_at (6 h no código, 24 h no máximo). Só o SHA-256 hex do token. Sem policy e sem privilégio para anon/authenticated: só service_role (EF public-seat-map e agente), filtrando unit_id. Sem PII.';

-- No UPDATE confere só o que mudou. O único UPDATE que existe é o `set null`
-- das FKs (service_role não tem UPDATE): ao apagar a unidade, salão (cascade)
-- e canal/conta (set null) somem no mesmo comando, e reconferir o salão já
-- apagado recusava a cascata inteira (42501), também pelo canal do WhatsApp.
create or replace function app_private.guard_seat_choice_link()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_all boolean := tg_op = 'INSERT' or new.unit_id is distinct from old.unit_id;
begin
  if v_all or new.hall_id is distinct from old.hall_id then
    perform 1 from public.halls h where h.id = new.hall_id and h.unit_id = new.unit_id;
    if not found then
      raise exception 'seat_link_invalid' using errcode = '42501';
    end if;
  end if;
  if new.channel_id is not null and (v_all or new.channel_id is distinct from old.channel_id) then
    perform 1 from public.whatsapp_channels c where c.id = new.channel_id and c.unit_id = new.unit_id;
    if not found then
      raise exception 'seat_link_invalid' using errcode = '42501';
    end if;
  end if;
  if new.instagram_account_id is not null
     and (v_all or new.instagram_account_id is distinct from old.instagram_account_id) then
    perform 1 from public.instagram_accounts a
     where a.id = new.instagram_account_id and a.unit_id = new.unit_id;
    if not found then
      raise exception 'seat_link_invalid' using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;
comment on function app_private.guard_seat_choice_link() is
  'seat_choice_links: salão, canal do WhatsApp e conta do Instagram da mesma unidade do link (42501 seat_link_invalid, mesma mensagem para alheio e inexistente).';
revoke all on function app_private.guard_seat_choice_link() from public, anon, authenticated, service_role;

commit;
