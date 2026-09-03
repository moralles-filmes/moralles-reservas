-- Wrapper + agendamento pg_cron da observação periódica de conexão dos canais.
--
-- POR QUE: `whatsapp_channels.status` só tinha dois escritores, e os dois
-- dependem de alguém — o callback do provider e a abertura do portal. Em
-- 2026-08-28 o canal Z-API do Ren Sushi caiu, a Z-API não mandou
-- `DisconnectedCallback`, ninguém abriu o painel, e a projeção ficou
-- `connected` por 6,6 dias. O envio confiou nela, a Z-API aceitou com 2xx
-- enfileirando, e 88 mensagens saíram em 2,5 minutos na reconexão.
--
-- Este é o terceiro escritor: o único que não depende de ninguém.
--
-- AGENDA JUNTO, ao contrário da 092. Lá o worker escrevia estado financeiro e
-- disparava e-mail para admin, o que exigia execução manual sob observação
-- antes do cron. Aqui o worker só LÊ o provider e carimba a projeção — não
-- envia mensagem, não bloqueia envio, não escreve billing. Nascer agendado é o
-- comportamento desejado: enquanto ele não roda, a projeção continua podendo
-- mentir, que é o defeito em aberto.
--
-- ORDEM DE DEPLOY INVERTIDA EM RELAÇÃO À REGRA USUAL DO PROJETO. Como esta
-- migration AGENDA junto, a Edge Function precisa existir ANTES do `db push`:
--   1. supabase functions deploy process-whatsapp-channel-health
--   2. supabase db push
-- Na ordem contrária o cron faz POST 404 a cada 5 minutos SEM ERRO VISÍVEL —
-- pg_net é fire-and-forget e não propaga status. `verify_jwt = false` já está
-- em config.toml; sem ele o gateway responde 401 antes do requireInternalAuth.
--
-- URL DO PROJETO E CHAVE VÊM DO VAULT, NUNCA EMBUTIDAS — ver 092 e
-- scripts/migration-static-guard.test.ts.
--
-- FAIL-CLOSED: sem `project_url` ou `internal_api_key` no Vault, avisa e
-- retorna sem POST.
--
-- VIZINHANÇA DE MINUTO (mesma análise que a 093 documenta): `*/5` coincide com
-- `billing-unblock` e `billing-notifications`, e a cada 5 min com o `*/1` do
-- outbox. Mantido assim de propósito — este worker não lê `platform_flags`,
-- não escreve billing e não toca `notification_outbox`, então não há recurso
-- em disputa. Se algum dia passar a escrever estado compartilhado, desalinhar
-- para `2-59/5` é a saída, não aumentar timeout.
--
-- `search_path = public, extensions` acompanha a 092, não o `''` da RPC irmã:
-- é o padrão já comprovado em produção para wrapper de pg_cron, e tudo no
-- corpo é qualificado (`vault.`, `net.`). A diferença é deliberada porque uma
-- falha aqui é INVISÍVEL (pg_net não propaga erro), então o lado seguro é o
-- padrão que já roda, não o mais novo.

create extension if not exists pg_cron;

create or replace function public.trigger_whatsapp_channel_health()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  api_key text;
  project_url text;
begin
  select decrypted_secret into api_key
  from vault.decrypted_secrets where name = 'internal_api_key' limit 1;

  select decrypted_secret into project_url
  from vault.decrypted_secrets where name = 'project_url' limit 1;

  if api_key is null or api_key = '' then
    raise notice '[whatsapp-channel-health] internal_api_key ausente no Vault — skip';
    return;
  end if;

  if project_url is null or project_url = '' then
    raise notice '[whatsapp-channel-health] project_url ausente no Vault — skip';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/process-whatsapp-channel-health',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-key', api_key
    ),
    body := '{}'::jsonb,
    -- pg_net é fire-and-forget: este teto encerra a ESPERA do POST, não a
    -- execução da Edge Function, e o pg_cron não pula execução sobreposta.
    -- Ou seja, este número NÃO garante exclusão entre varreduras — se ela
    -- algum dia for necessária, a saída é claim/lock dentro da própria EF
    -- (padrão `try_claim_conversation_for_ai`), nunca ajustar este valor.
    timeout_milliseconds := 60000
  );
end;
$$;

-- CREATE FUNCTION concede EXECUTE a PUBLIC por padrão e o schema public é
-- exposto ao PostgREST com a anon key. Vale para toda função, não só trigger_*.
revoke all on function public.trigger_whatsapp_channel_health() from public, anon, authenticated;

-- Idempotente: `db push` reaplicado não pode duplicar o job nem falhar.
--
-- `perform ... from cron.job`, e não `if exists (...) then unschedule(name)`:
-- desagenda por `jobid` sobre 0..N linhas visíveis, sem levantar exceção
-- quando não há nenhuma. A forma com nome tem uma aresta em pg_cron >=1.4, em
-- que `cron.job` filtra por `username = current_user`: um job homônimo criado
-- sob outro papel não apareceria no `exists`, o `unschedule` seria pulado e o
-- `cron.schedule` abaixo criaria uma SEGUNDA linha — dupla execução silenciosa.
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'whatsapp-channel-health';
end;
$$;

select cron.schedule(
  'whatsapp-channel-health',
  '*/5 * * * *',
  $$select public.trigger_whatsapp_channel_health();$$
);

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. ACL (esperado: sem anon= e sem authenticated=):
--   select proacl from pg_proc where proname = 'trigger_whatsapp_channel_health';
--
-- 2. Job agendado exatamente uma vez:
--   select jobname, schedule, active from cron.job where jobname = 'whatsapp-channel-health';
--
-- 3. Segredos presentes no Vault (esperado: 2 linhas):
--   select name from vault.decrypted_secrets
--    where name in ('internal_api_key', 'project_url');
--
-- 4. Primeira execução chegou à Edge Function (esperado: status_code 200):
--   select status_code, created from net._http_response order by created desc limit 5;
--
-- 5. A projeção passou a ser carimbada sem ninguém abrir o painel.
--    `is distinct from false`, não `where is_active`: o worker também observa
--    canal legado `is_active IS NULL`, e filtrar só pelos `true` mostraria zero
--    linhas numa unidade legada — levando à conclusão errada de que o worker
--    não está carimbando.
--   select id, status, last_health_check_at from whatsapp_channels
--    where is_active is distinct from false;
--
-- 6. Idempotência (o harness local não tem pg_cron, então esta é a única prova
--    real): reaplicar a migration e conferir que continua UMA linha.
--   select count(*) from cron.job where jobname = 'whatsapp-channel-health';
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- Mesma forma por `jobid` do corpo, pelo mesmo motivo: `unschedule(<nome>)`
-- levanta exceção se o job já não existir, e rollback que falha no primeiro
-- comando deixa a função órfã.
--   do $$ begin perform cron.unschedule(jobid) from cron.job
--     where jobname = 'whatsapp-channel-health'; end; $$;
--   drop function if exists public.trigger_whatsapp_channel_health();
--
-- Atenção: com o worker desagendado, `last_health_check_at` volta a envelhecer
-- e a guarda de `whatsapp-send.ts` passa a consultar o provider no caminho de
-- envio a cada mensagem. Correto, porém mais lento — não é rollback silencioso.
