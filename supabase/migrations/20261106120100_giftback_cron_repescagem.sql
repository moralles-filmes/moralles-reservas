-- Segunda execução diária do process-voucher-triggers (repescagem), 18:00 UTC = 15:00 BRT,
-- e wrapper `trigger_voucher_processor()` lendo `project_url` do Vault.
--
-- Plano: .tasks/vouchers-fatura-brt (Fase 1, regra R2 aprovada pelo dono).
-- A EF ganhou orçamento de tempo: quando ele acaba, para de emitir. O
-- aniversário não tem retentativa (a data não volta), então esta rodada emite
-- o que a das 09:00 BRT não alcançou. Repetir é seguro: aniversário é no
-- máximo 1 voucher por regra e cliente por ano civil BRT, frequência tem
-- cooldown de `validity_days`, e o lease (20261106120000) impede sobreposição.
--
-- Wrapper: a 043 embutia a URL de produção no corpo (só a chave vinha do
-- Vault). Com dois jobs chamando-o, ele passa a ler `project_url` e
-- `internal_api_key` do Vault, fail-closed (faltando um, avisa e volta sem
-- POST), como os wrappers do Instagram (20261103120200). Nenhuma URL nem
-- segredo aqui. `create or replace` mantém a ACL, mas o revoke da 085 é
-- repetido por garantia. O pré-voo não roda este arquivo: sem pg_cron/Vault.
--
-- Idempotência: desagenda por jobid antes (padrão da 20261103120500).
-- ROLLBACK: select cron.unschedule(jobid) from cron.job where jobname = 'process-voucher-triggers-repescagem';
--   (o wrapper novo é compatível com o job das 12:00; voltar ao corpo da 043 não é necessário)

create extension if not exists pg_cron;

create or replace function public.trigger_voucher_processor()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_url text;
begin
  select ds.decrypted_secret into v_key
    from vault.decrypted_secrets ds where ds.name = 'internal_api_key' limit 1;
  select ds.decrypted_secret into v_url
    from vault.decrypted_secrets ds where ds.name = 'project_url' limit 1;

  if v_key is null or v_key = '' then
    raise notice '[voucher-triggers] internal_api_key ausente no Vault — skip';
    return;
  end if;
  if v_url is null or v_url = '' then
    raise notice '[voucher-triggers] project_url ausente no Vault — skip';
    return;
  end if;

  perform net.http_post(
    url := v_url || '/functions/v1/process-voucher-triggers',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-key', v_key),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

revoke all on function public.trigger_voucher_processor() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'process-voucher-triggers-repescagem';
end;
$$;

select cron.schedule(
  'process-voucher-triggers-repescagem',
  '0 18 * * *',
  $$select public.trigger_voucher_processor();$$
);
