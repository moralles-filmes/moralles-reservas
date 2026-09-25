-- Agendamento da varredura de eventos inbound de WhatsApp (Fase C).
--
-- ESTA MIGRATION SÓ AGENDA. A função `trigger_whatsapp_inbound_sweep()` foi
-- criada na 112 e lê `project_url` E `internal_api_key` do Vault, fail-closed:
-- faltando qualquer um, ela avisa e retorna sem POST. Por isso NÃO há URL de
-- projeto aqui — diferente das treze migrations legadas, que embutem o host e
-- fariam um banco reconstruído agendar cron apontando para PRODUÇÃO. O guardrail
-- scripts/migration-static-guard.test.ts reprova quem regredir.
--
-- POR QUE SEPARADA DA 113 (mesma razão da 092/093): `db push` aplica tudo que
-- está pendente. Com o `cron.schedule` dentro da 113, o cron nasceria no mesmo
-- push das RPCs, antes de qualquer execução sob observação. A ORDEM DE APLICAÇÃO
-- É 111/112/113 -> deploy das Edge Functions -> exercitar `?sweep=1` À MÃO, com
-- e sem a chave interna (200 e 401) -> só então ESTA migration.
--
-- INVERTER `db push` E `functions deploy` faz o gate da Fase C ler uma coluna
-- inexistente (`whatsapp_channels.async_ingestion_enabled`): 400 do PostgREST no
-- SELECT do canal, 404 em resposta, e **503 em todo inbound de todo canal** —
-- inclusive Z-API e UazAPI, que não têm nada a ver com esta fase.
--
-- ─── DUAS FRASES QUE A CONFERÊNCIA EXIGE ────────────────────────────────────
--
-- 1. `timeout_milliseconds` do `pg_net` (30 s, na 112) encerra a ESPERA pelo
--    POST, NÃO a execução da Edge Function. Estourado o prazo, a varredura
--    continua rodando do outro lado; o que se perde é a resposta. Quem lê
--    "timeout" e conclui "a varredura foi interrompida" investiga o lugar errado
--    — e o orçamento de laço da varredura é de 120 s justamente porque ela PODE
--    passar dos 30 s sem que nada esteja errado.
--
-- 2. `pg_cron` NÃO PULA EXECUÇÕES SOBREPOSTAS. Uma varredura que passe de um
--    minuto conviverá com a seguinte, e as duas podem selecionar o mesmo id. O
--    que torna isso seguro é o claim POR LINHA da 113 (a perdedora recebe zero
--    linhas e segue adiante), não o agendamento.
--
-- O QUE ESTE CRON NÃO FAZ: não aceita payload, não injeta inbound, não escolhe
-- canal e não escreve `status` na fila. Ele pede ao webhook que SELECIONE as
-- linhas devidas, processe o que couber no orçamento e purgue o que venceu a
-- retenção. Enquanto o gate da fase estiver OFF (flag global `false` + nenhum
-- canal optado), a tabela fica vazia e toda execução devolve
-- `{"selected":0,"processed":0,"skipped":0,"purged":0}`.

create extension if not exists pg_cron;

-- Idempotência: reagendar sem remover antes duplicaria o job — e job duplicado
-- aqui é varredura dobrada a cada minuto.
--
-- Desagenda por `jobid`, não por nome, e SEM `exception when others then null`.
-- É o idioma que a migration do health de canais (2026-09-03) adotou depois de
-- descrever o defeito do idioma antigo, e ele é melhor por duas razões: `perform
-- ... from cron.job` age sobre 0..N linhas sem levantar exceção quando não há
-- nenhuma (então não precisa de handler), e engolir `when others` esconderia um
-- erro de permissão real — a migration seguiria, o `cron.schedule` criaria a
-- linha, e ninguém saberia que a remoção não aconteceu.
--
-- Esta migration nasceu com o idioma antigo porque o brief a trouxe verbatim do
-- plano, que é anterior àquela decisão.
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'whatsapp-inbound-sweep';
end;
$$;

select cron.schedule(
  'whatsapp-inbound-sweep',
  '*/1 * * * *',
  $$select public.trigger_whatsapp_inbound_sweep();$$
);

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. Job agendado (esperado: 1 linha, '*/1 * * * *', active = true):
--   select jobname, schedule, active from cron.job
--    where jobname = 'whatsapp-inbound-sweep';
--
-- 2. Nenhum job duplicado com o mesmo nome (esperado: 1):
--   select count(*) from cron.job where jobname = 'whatsapp-inbound-sweep';
--
-- 3. A CONFERÊNCIA REAL É `net._http_response`, NÃO `cron.job_run_details`.
--    `status = succeeded` ali significa que o `pg_net` ACEITOU o POST, não que a
--    Edge Function respondeu 200 — `pg_net` é fire-and-forget. Esperado com o
--    gate OFF: 200 e corpo com `processed: 0`.
--   select status_code, content, created
--     from net._http_response
--    order by created desc limit 5;
--
-- 4. A fila não deve acumular `processing` preso (esperado: 0 — e qualquer linha
--    aqui com `claimed_until` no passado é lease órfão, que a própria varredura
--    seguinte retoma):
--   select count(*) from whatsapp_inbound_events
--    where status = 'processing' and claimed_until < now();
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- Desagendar é seguro e reversível a qualquer momento. O caminho rápido
-- (`EdgeRuntime.waitUntil`) continua processando o que chega; o que se perde é o
-- BACKSTOP — entrega cujo worker morreu no meio fica na fila até alguém
-- reagendar ou chamar `?sweep=1` à mão:
--   select cron.unschedule('whatsapp-inbound-sweep');
--
-- A remoção das FUNÇÕES é degrau da 113 e da 112. Desagende ANTES de removê-las,
-- senão o cron dispara contra função inexistente.
