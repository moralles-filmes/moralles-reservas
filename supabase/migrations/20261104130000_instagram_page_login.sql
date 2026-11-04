-- Instagram, plano B (login pela Página do Facebook), Task 2: a conta guarda
-- a Página ligada a ela, a conexão passa a receber essa Página e o
-- agendamento da renovação do token sai.
--
-- Spec:  docs/superpowers/specs/2026-11-04-instagram-fase-1-login-pela-pagina-design.md
-- Plano: docs/superpowers/plans/2026-11-04-instagram-fase-1-login-pela-pagina.md
--        (Task 2)
-- Pré-voo: supabase/tests/local-preflight/79-instagram-module.sql (README,
--          seção "79 — Módulo Instagram"), casos IG-9.1..IG-9.3 e controles
--          C-IG-9.1..C-IG-9.3 (faixa 79101–79199).
-- Gêmeo:   src/lib/instagram-queue-migration-twin.test.ts confere, como texto,
--          o desagendamento de `instagram-token-refresh` (o harness não tem
--          pg_cron).
--
-- O que muda:
--   * `instagram_accounts.page_id`: a Página do Facebook ligada à conta, que é
--     o endereço do envio no login pela Página. Só dígitos (1–64). Nulo só em
--     linha anterior a esta migration.
--   * `store_instagram_account_connection` ganha `p_page_id` (3º argumento) e
--     passa a ter 8 argumentos. O corpo é o da 20261103120100 sem mudança de
--     regra, mais três acréscimos: `p_page_id` aparado e validado (senão
--     `invalid_instagram_account_argument`, 22023), gravado no UPDATE e no
--     INSERT, e `p_expires_at` nulo aceito (o token da Página não traz
--     vencimento). A assinatura de 7 argumentos sai antes do `create`: um
--     overload antigo deixaria a EF chamar a forma sem Página.
--   * O job `instagram-token-refresh` (20261103120500) é desagendado: o token
--     da Página não é renovado pelo endpoint do Instagram Login. Os jobs
--     `instagram-inbound-sweep` e `instagram-inbound-purge` ficam. O wrapper
--     `trigger_instagram_token_refresh()` e a EF continuam existindo; só o
--     agendamento sai. Onde o schema `cron` não existe (harness local), o
--     bloco não faz nada.
--
-- Ordem do deploy: esta migration e a EF `instagram-connect` que chama a
-- assinatura de 8 argumentos sobem juntas. Entre o push e o deploy da EF, a
-- conexão pela EF antiga (7 argumentos) recebe erro de função inexistente.
--
-- Idempotente: `add column if not exists`, CHECK criado só se faltar (NOT
-- VALID + VALIDATE), `drop function if exists` das duas assinaturas antes do
-- `create`, revoke/grant reafirmados, unschedule por `jobid` (0..N linhas).
-- Sem URL do projeto e sem segredo.

begin;

set local lock_timeout = '5s';

-- ============================================================================
-- 1. Coluna page_id
-- ============================================================================
alter table public.instagram_accounts add column if not exists page_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.instagram_accounts'::regclass
       and conname = 'instagram_accounts_page_id_chk'
  ) then
    alter table public.instagram_accounts
      add constraint instagram_accounts_page_id_chk
      check (page_id is null or page_id ~ '^[0-9]{1,64}$') not valid;
  end if;
end;
$$;

alter table public.instagram_accounts validate constraint instagram_accounts_page_id_chk;

comment on column public.instagram_accounts.page_id is
  'Página do Facebook ligada à conta; endereço do envio. Nulo só em linha anterior ao login pela Página.';

-- ============================================================================
-- 2. store_instagram_account_connection com p_page_id
-- ============================================================================
-- Conexão. `ig_user_id`, `page_id` e token entram sem espaços nas pontas, e
-- `ig_user_id` e `page_id` são só dígitos. Serializa por `ig_user_id` e depois
-- por unidade (ordem fixa, sem ciclo). A conta ativa noutra unidade é
-- recusada; outra conta ativa na mesma unidade é desconectada antes; a mesma
-- conta na mesma unidade (ativa ou desconectada) reaproveita a linha, o que
-- mantém os contatos e o segredo, e troca a Página. A organização sai de
-- `units`. `p_expires_at` nulo é aceito (token sem vencimento informado).
drop function if exists public.store_instagram_account_connection(uuid, text, text, text, text, timestamptz, uuid);
drop function if exists public.store_instagram_account_connection(uuid, text, text, text, text, text, timestamptz, uuid);

create function public.store_instagram_account_connection(
  p_unit_id      uuid,
  p_ig_user_id   text,
  p_page_id      text,
  p_username     text,
  p_account_type text,
  p_token        text,
  p_expires_at   timestamptz,
  p_actor        uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org       uuid;
  v_other     record;
  v_row       record;
  v_id        uuid;
  v_secret_id uuid;
  v_name      text;
begin
  p_ig_user_id := btrim(p_ig_user_id);
  p_page_id := btrim(p_page_id);
  p_token := btrim(p_token);

  if p_unit_id is null
     or p_ig_user_id is null or p_ig_user_id !~ '^[0-9]{1,64}$'
     or p_page_id is null or p_page_id !~ '^[0-9]{1,64}$' then
    raise exception 'invalid_instagram_account_argument' using errcode = '22023';
  end if;
  if p_token is null or length(p_token) < 8 or length(p_token) > 4096 then
    raise exception 'invalid_instagram_token' using errcode = '22023';
  end if;

  -- Autorização no SQL, não só na EF: o ator é owner/gerente DESTA unidade ou
  -- platform_admin, e a unidade tem o módulo liberado (grant ativo). Ator
  -- nulo, unidade inexistente, papel insuficiente e módulo não liberado caem
  -- no MESMO 42501 (sem oráculo de existência).
  select u.organization_id into v_org from public.units u where u.id = p_unit_id;
  if v_org is null or p_actor is null
     or not (
       exists (
         select 1 from public.unit_members um
          where um.unit_id = p_unit_id
            and um.user_id = p_actor
            and um.role in ('owner', 'gerente')
       )
       or app_private.is_platform_admin(p_actor)
     )
     or not exists (
       select 1 from public.unit_module_grants g
        where g.unit_id = p_unit_id
          and g.module = 'instagram'
          and g.revoked_at is null
     ) then
    raise exception 'instagram_account_forbidden' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('instagram_account_ig:' || p_ig_user_id, 0));
  perform pg_advisory_xact_lock(hashtextextended('instagram_account_unit:' || p_unit_id::text, 0));

  if exists (
    select 1 from public.instagram_accounts a
     where a.ig_user_id = p_ig_user_id
       and a.status <> 'disconnected'
       and a.unit_id <> p_unit_id
  ) then
    raise exception 'instagram_account_in_use' using errcode = 'P0001';
  end if;

  for v_other in
    select a.id from public.instagram_accounts a
     where a.unit_id = p_unit_id
       and a.status <> 'disconnected'
       and a.ig_user_id <> p_ig_user_id
     for update
  loop
    perform public.disconnect_instagram_account(v_other.id, p_actor);
  end loop;

  select a.id, a.status, a.token_secret_id into v_row
    from public.instagram_accounts a
   where a.unit_id = p_unit_id and a.ig_user_id = p_ig_user_id
   order by (a.status <> 'disconnected') desc, a.updated_at desc, a.id desc
   limit 1
   for update;

  if found then
    v_id := v_row.id;
    update public.instagram_accounts a
       set username = p_username,
           account_type = p_account_type,
           page_id = p_page_id,
           status = 'connected',
           token_expires_at = p_expires_at,
           token_refreshed_at = null,
           subscribed_fields = case when v_row.status = 'disconnected' then '{}'::text[] else a.subscribed_fields end,
           last_error_code = null,
           connected_by = p_actor,
           connected_at = now(),
           disconnected_at = null,
           disconnected_by = null,
           updated_at = now()
     where a.id = v_id;
  else
    insert into public.instagram_accounts (
      organization_id, unit_id, ig_user_id, username, account_type, status,
      token_expires_at, connected_by, page_id
    ) values (
      v_org, p_unit_id, p_ig_user_id, p_username, p_account_type, 'connected',
      p_expires_at, p_actor, p_page_id
    )
    returning id into v_id;
  end if;

  v_name := 'instagram-account-' || v_id::text || '-token';
  if v_row.token_secret_id is not null then
    select s.id into v_secret_id from vault.secrets s
     where s.id = v_row.token_secret_id and s.name = v_name;
    if v_secret_id is null then
      raise exception 'instagram_account_secret_mismatch' using errcode = '42501';
    end if;
  else
    select s.id into v_secret_id from vault.secrets s where s.name = v_name limit 1;
  end if;

  if v_secret_id is not null then
    perform vault.update_secret(
      v_secret_id,
      p_token,
      v_name,
      'Instagram account token for internal account UUID'
    );
  else
    select vault.create_secret(
      p_token,
      v_name,
      'Instagram account token for internal account UUID'
    ) into v_secret_id;
  end if;

  update public.instagram_accounts a
     set token_secret_id = v_secret_id
   where a.id = v_id;

  return v_id;
end;
$$;

-- ACL (assinatura completa): o `create` acima nasce com EXECUTE para PUBLIC.
revoke all on function public.store_instagram_account_connection(uuid, text, text, text, text, text, timestamptz, uuid) from public, anon, authenticated, service_role;
grant execute on function public.store_instagram_account_connection(uuid, text, text, text, text, text, timestamptz, uuid) to service_role;

-- ============================================================================
-- 3. Fim do agendamento da renovação do token
-- ============================================================================
-- Só `instagram-token-refresh`; a varredura e a purga continuam agendadas.
-- Por `jobid` (0..N linhas, sem exceção quando o job não existe), e só onde o
-- schema `cron` existe.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'instagram-token-refresh';
  end if;
end;
$$;

commit;

-- Validação pós-migration (somente leitura):
--   select jobname, schedule, active from cron.job where jobname like 'instagram-%' order by jobname;
--     -- esperado: instagram-inbound-purge e instagram-inbound-sweep; nenhum instagram-token-refresh
--   select pg_get_function_identity_arguments(oid), proacl from pg_proc
--    where proname = 'store_instagram_account_connection';   -- uma linha, 8 argumentos, só service_role
--   select conname, convalidated from pg_constraint where conname = 'instagram_accounts_page_id_chk';
--
-- ROLLBACK (só antes de a EF passar a gravar a Página):
--   select cron.schedule('instagram-token-refresh', '40 9 * * *', $$select public.trigger_instagram_token_refresh();$$);
--   drop function if exists public.store_instagram_account_connection(uuid, text, text, text, text, text, timestamptz, uuid);
--   -- recriar a de 7 argumentos com o corpo da 20261103120100 e o revoke/grant dela
--   alter table public.instagram_accounts drop constraint if exists instagram_accounts_page_id_chk;
--   alter table public.instagram_accounts drop column if exists page_id;
