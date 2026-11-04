-- Instagram, Fase 1 (Task 4.5, herdado do Bloco 2): compare-and-set por
-- `connected_at` nas RPCs que mudam a conta a partir de uma leitura antiga.
--
-- Plano: docs/superpowers/plans/2026-10-20-instagram-fase-1-direct-conversas.md
-- Pré-voo: supabase/tests/local-preflight/79-instagram-module.sql (IG-8.2 e
--          C-IG-8.2; README, seção 79).
--
-- Problema: a varredura do `process-instagram-token-refresh`, o worker do
-- Direct (erro 190) e o envio manual (erro 190) leem a conta, falam com a Meta
-- e só DEPOIS gravam. Se o dono reconectar no meio (`store_…` grava token novo
-- e `connected_at = now()`), a gravação atrasada derrubaria a conexão nova
-- para `reauth_required` ou sobrescreveria o token novo com o renovado do
-- antigo. `connected_at` muda a cada (re)conexão, então ele é a geração.
--
-- Contrato (sinalização escolhida: retorno booleano, a de menor quebra):
--   * `set_instagram_account_status(id, status, erro, connected_at_lido)` e
--     `record_instagram_token_refresh(id, token, expira, connected_at_lido)`
--     devolvem `true` quando aplicaram e `false`, SEM efeito nenhum (nem no
--     Vault), quando o `connected_at` atual difere do lido (conexão nova).
--   * Os erros de antes ficam iguais e vêm ANTES da comparação: argumento
--     inválido 22023, conta inexistente P0002, desconectada 55000, segredo
--     trocado 42501. `connected_at_lido` nulo é argumento inválido (22023):
--     sem a geração, a RPC recusa em vez de gravar às cegas.
--
-- As assinaturas antigas (3 argumentos, `returns void`) são DROPADAS: mudar o
-- retorno exige drop, e deixá-las vivas manteria um caminho sem CAS. O drop +
-- create reabre o EXECUTE a PUBLIC, então os `revoke` com a assinatura
-- completa vêm depois do último `create` de cada uma, e o grant fica só para
-- `service_role`. Deploy: as três EFs chamadoras mudam junto (matriz no
-- relatório da Task 4.5); a EF antiga contra o banco novo recebe 42883/PGRST202
-- e conta falha, sem gravar.
--
-- Idempotente: `drop function if exists` das antigas, `create or replace` das
-- novas, `revoke`/`grant` reafirmados. Sem URL do projeto e sem segredo.

begin;

drop function if exists public.set_instagram_account_status(uuid, text, text);
drop function if exists public.record_instagram_token_refresh(uuid, text, timestamptz);

-- Renovação do token longo: troca o valor no MESMO segredo (preso ao nome) e
-- carimba `token_refreshed_at`, só se a conta ainda é a mesma conexão.
create or replace function public.record_instagram_token_refresh(
  p_account_id            uuid,
  p_token                 text,
  p_expires_at            timestamptz,
  p_expected_connected_at timestamptz
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_acc       record;
  v_name      text;
  v_secret_id uuid;
begin
  p_token := btrim(p_token);
  if p_token is null or length(p_token) < 8 or length(p_token) > 4096 then
    raise exception 'invalid_instagram_token' using errcode = '22023';
  end if;
  if p_expected_connected_at is null then
    raise exception 'invalid_instagram_account_generation' using errcode = '22023';
  end if;

  select a.id, a.status, a.token_secret_id, a.connected_at into v_acc
    from public.instagram_accounts a where a.id = p_account_id
    for update;
  if not found then
    raise exception 'instagram_account_not_found' using errcode = 'P0002';
  end if;
  if v_acc.status = 'disconnected' or v_acc.token_secret_id is null then
    raise exception 'instagram_account_not_active' using errcode = '55000';
  end if;
  -- CAS: reconexão depois da leitura do chamador; nada muda, nem o Vault.
  if v_acc.connected_at is distinct from p_expected_connected_at then
    return false;
  end if;

  v_name := 'instagram-account-' || p_account_id::text || '-token';
  if v_acc.token_secret_id is not null then
    select s.id into v_secret_id from vault.secrets s
     where s.id = v_acc.token_secret_id and s.name = v_name;
    if v_secret_id is null then
      raise exception 'instagram_account_secret_mismatch' using errcode = '42501';
    end if;
  end if;

  perform vault.update_secret(
    v_secret_id,
    p_token,
    v_name,
    'Instagram account token for internal account UUID'
  );

  update public.instagram_accounts a
     set token_expires_at = p_expires_at,
         token_refreshed_at = now(),
         updated_at = now()
   where a.id = p_account_id;
  return true;
end;
$$;

-- Só `connected` <-> `reauth_required`. Desconectar é `disconnect_…`, e
-- reconectar é `store_…` (que traz token novo). Voltar a `connected` limpa
-- `last_error_code`. Só aplica se a conta ainda é a conexão lida.
create or replace function public.set_instagram_account_status(
  p_account_id            uuid,
  p_status                text,
  p_error_code            text,
  p_expected_connected_at timestamptz
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_status       text;
  v_connected_at timestamptz;
begin
  if p_status is null or p_status not in ('connected', 'reauth_required') then
    raise exception 'invalid_instagram_account_status' using errcode = '22023';
  end if;
  if p_expected_connected_at is null then
    raise exception 'invalid_instagram_account_generation' using errcode = '22023';
  end if;

  select a.status, a.connected_at into v_status, v_connected_at
    from public.instagram_accounts a where a.id = p_account_id for update;
  if v_status is null then
    raise exception 'instagram_account_not_found' using errcode = 'P0002';
  end if;
  if v_status = 'disconnected' then
    raise exception 'instagram_account_not_active' using errcode = '55000';
  end if;
  -- CAS: reconexão depois da leitura do chamador; a conexão nova fica intacta.
  if v_connected_at is distinct from p_expected_connected_at then
    return false;
  end if;

  update public.instagram_accounts a
     set status = p_status,
         last_error_code = case when p_status = 'connected' then null else p_error_code end,
         updated_at = now()
   where a.id = p_account_id;
  return true;
end;
$$;

revoke all on function public.record_instagram_token_refresh(uuid, text, timestamptz, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.record_instagram_token_refresh(uuid, text, timestamptz, timestamptz) to service_role;
revoke all on function public.set_instagram_account_status(uuid, text, text, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.set_instagram_account_status(uuid, text, text, timestamptz) to service_role;

commit;

-- Validação pós-migration (somente leitura):
--   select oid::regprocedure, proacl, prosecdef from pg_proc
--    where proname in ('set_instagram_account_status', 'record_instagram_token_refresh');
--   -- uma linha cada, 4 argumentos, EXECUTE só de service_role
--
-- ROLLBACK (só junto com o rollback das três EFs chamadoras): dropar as duas
-- assinaturas de 4 argumentos e reaplicar o trecho das duas funções e dos
-- quatro revoke/grant da 20261103120100.
