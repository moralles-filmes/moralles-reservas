-- Revoga EXECUTE de public/anon/authenticated em todas as funções
-- trigger_* do schema public (fix de gate de segurança pré-merge, Fase 5b).
--
-- O FATO: toda função nova nasce com EXECUTE liberado para PUBLIC — é o
-- comportamento padrão do Postgres ao criar uma função, sem revoke
-- explícito. Nenhuma das 16 funções trigger_* do repo (as 14 pré-existentes
-- de outros workers + trigger_asaas_invoice_reconcile e
-- trigger_whatsapp_enforcement, migrations 082/083 desta fase) tem revoke —
-- confirmado por
-- `grep -rn "on function trigger_" supabase/migrations/`, zero ocorrências
-- antes deste arquivo. O padrão correto já existe em toda outra função
-- SECURITY DEFINER do projeto (get_widget_public, enter_waitlist,
-- get_public_tracking, try_claim_conversation_for_ai,
-- get_undelivered_notifications, resolve_or_activate_subscription, ...) —
-- a família trigger_* é a única omissão, lapso repetido 16 vezes, não decisão.
--
-- IMPACTO: `anon` tem USAGE no schema public, exposto ao PostgREST. Qualquer
-- portador da VITE_SUPABASE_ANON_KEY (pública por design) podia chamar
-- `POST /rest/v1/rpc/trigger_whatsapp_enforcement` e disparar o worker fora
-- de hora — a função é SECURITY DEFINER, roda como o dono, lê
-- internal_api_key do Vault e chama pg_net.http_post sozinha; o
-- x-internal-key não protege isso, porque é a própria função que o fornece.
--
-- POR QUE NÃO QUEBRA O CRON: os jobs são `cron.schedule(..., 'select
-- trigger_x();')` executando como o role que rodou a migration (postgres,
-- também dono das funções). Revoke de public/anon/authenticated nunca toca o
-- privilégio implícito do dono — o cron continua funcionando mesmo sem
-- nenhuma linha deste arquivo. O `grant execute ... to postgres` abaixo é
-- redundante de propósito: só deixa a intenção legível e sobrevive a uma
-- eventual troca de dono; se falhar (ex.: nome de role diferente do
-- esperado), o bloco captura a exceção e segue sem abortar a migration nem
-- desfazer o revoke já aplicado naquela função.
--
-- BLOCO DO QUE ITERA pg_proc, não 16 statements literais: (a) idempotente
-- por construção — revoke de privilégio ausente é no-op, não erro; (b) não
-- quebra se alguma assinatura divergir da lista conhecida; (c) cobre
-- automaticamente qualquer trigger_* futura nascida com o mesmo lapso, que é
-- o modo de falha real aqui (aconteceu 16 vezes seguidas).

begin;

do $$
declare
  fn record;
  fn_count integer := 0;
begin
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname like 'trigger\_%'
  loop
    begin
      execute format('revoke all on function %s from public, anon, authenticated', fn.sig);
      -- Redundante por desenho (ver header) — falha aqui não pode derrubar
      -- o revoke acima nem abortar o laço para as próximas funções.
      execute format('grant execute on function %s to postgres', fn.sig);
      fn_count := fn_count + 1;
    exception when others then
      raise warning '[084] falha ao ajustar privilegios de %: %', fn.sig, sqlerrm;
    end;
  end loop;

  raise notice '[084] revoke execute (public/anon/authenticated) aplicado a % funcao(oes) trigger_*', fn_count;
end $$;

commit;

-- =====================================================================
-- Validação pós-migration (esperado: zero linhas)
-- =====================================================================
--   select p.proname, r.grantee, r.privilege_type
--     from information_schema.routine_privileges r
--     join pg_proc p on p.oid = (r.specific_schema || '.' || r.specific_name)::regprocedure
--    where p.proname like 'trigger\_%'
--      and r.grantee in ('PUBLIC', 'anon', 'authenticated');
--
-- Se o join acima não funcionar como escrito (specific_name x regprocedure é
-- inconsistente entre versões do Postgres), a consulta abaixo é equivalente
-- e mais robusta — lê o ACL cru de cada função trigger_* direto:
--   select p.proname, p.proacl
--     from pg_proc p
--    where p.pronamespace = 'public'::regnamespace
--      and p.proname like 'trigger\_%';
--   -- Esperado: proacl sem entrada "=X/..." (PUBLIC), "anon=X/..." nem
--   -- "authenticated=X/...". Só o dono (implícito, sem entrada no array) e,
--   -- se o grant redundante teve sucesso, "postgres=X/...".
--
-- 2. Confirma que o cron continua funcionando (rodar manualmente com
--    internal_api_key configurada no Vault, mesmo padrão de 082/083):
--   select trigger_whatsapp_enforcement();
--   select trigger_asaas_invoice_reconcile();
--   -- depois: select * from net._http_response order by created desc limit 2;
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- Não há "desfazer" seguro em massa sem saber quais das 16 funções tinham
-- PUBLIC/anon/authenticated concedido antes desta migration (provavelmente
-- todas, pelo default do Postgres ao criar função — mas restaurar esse
-- estado seria reabrir a falha que este arquivo corrige, não um rollback
-- legítimo). Se algum caller além do dono/cron precisar chamar uma
-- trigger_* específica (não deveria — são workers internos), conceda
-- pontualmente:
--   grant execute on function public.trigger_<nome>() to <role>;
