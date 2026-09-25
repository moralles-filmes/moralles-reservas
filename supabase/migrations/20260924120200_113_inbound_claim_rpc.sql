-- Reivindicação cercada e finalização da fila de inbound (Fase C).
--
-- ESTA MIGRATION SÓ CRIA FUNÇÃO. Não agenda nada (o `cron.schedule` é a 114) e
-- não toca na tabela nem nos índices (é a 111 que os cria).
--
-- AS DUAS FUNÇÕES EXISTEM PELO MESMO RISCO: duas execuções da MESMA linha
-- significam duas IAs respondendo ao mesmo cliente. Dois caminhos podem alcançar
-- uma linha — o rápido (`EdgeRuntime.waitUntil`, disparado pela própria request
-- que a persistiu) e a varredura (`pg_cron`) —, e a cerca de UUID é o que decide
-- qual dos dois trabalha nela. O claim é o PRIMEIRO ato do processamento; a
-- finalização só escreve se o `claim_id` que ela apresenta é o que está na linha.
--
-- RELÓGIO ÚNICO. `claimed_until` e `next_attempt_at` são escritos por `now()` do
-- BANCO e comparados por `now()` do BANCO. Nunca escritos por um relógio para
-- serem comparados por outro: este repo já pagou essa borda em
-- `_shared/availability.ts`, e aqui ela produziria takeover cedo demais (duas
-- IAs) ou nunca (linha presa para sempre). O Deno passa SEGUNDOS
-- (`p_retry_delay_seconds`), nunca um instante.
--
-- GÊMEOS DECLARADOS (SQL não importa TypeScript, então o ponteiro é este
-- comentário — dois lugares com o mesmo número e nenhum ponteiro entre eles é
-- como a divergência nasce):
--   * os 90 segundos do lease abaixo são `INBOUND_LEASE_TTL_MS = 90_000` em
--     `supabase/functions/_shared/whatsapp-inbound-queue-core.ts`;
--   * o truncamento de `last_error` em 500 é o mesmo limite que o adapter aplica
--     antes de chamar (os dois truncam: aqui é o backstop para quem não passar
--     pelo adapter).
--
-- A escada de retentativa NÃO mora aqui. Quem decide `status`, `outcome` e o
-- atraso é `queuedEventVerdict`, no núcleo puro, porque o vitest alcança aquele
-- arquivo e não alcança nem o `index.ts` da Edge Function nem este SQL. Estas
-- funções são MECANISMO (cerca, lease, relógio), não política.

-- ─── Claim por id: o primeiro ato do processamento ───────────────────────────
--
-- Devolve ZERO LINHAS quando a linha não é reivindicável, e zero linhas não é
-- falha: é trabalho que pertence a outro processo (lease vivo), ou que já
-- terminou (`done`/`dead`), ou que deixou de existir (o canal foi apagado e a FK
-- `on delete cascade` levou a linha). O caller sai em silêncio nos quatro casos.
--
-- A SEGUNDA PERNA DO `where` É O TAKEOVER DE LEASE VENCIDO, e é ela que impede
-- uma linha de ficar presa quando o worker morre no meio — o modo de falha que o
-- `notification_outbox` documenta duas vezes não cobrir.
--
-- `claimed_until < now()` com `claimed_until` NULL avalia NULL, logo não é
-- verdadeiro, logo um `processing` sem lease nunca seria retomado. Não é caminho
-- alcançável: quem escreve `status = 'processing'` é este UPDATE (e o da
-- varredura), sempre gravando o lease no MESMO comando; a finalização nunca
-- escreve `processing` e sempre limpa o lease junto. Se algum dia outro escritor
-- gravar `processing`, ele carrega o lease ou reabre este buraco.
create or replace function public.claim_whatsapp_inbound_event(p_event_id uuid)
returns table (
  id          uuid,
  provider    text,
  channel_id  uuid,
  raw_body    bytea,
  attempts    integer,
  claim_id    uuid
)
language sql
security definer
set search_path = ''
as $$
  update public.whatsapp_inbound_events e
     set status        = 'processing',
         claim_id      = gen_random_uuid(),
         claimed_until = now() + make_interval(secs => 90),
         updated_at    = now()
   where e.id = p_event_id
     and (e.status = 'received'
          or (e.status = 'processing' and e.claimed_until < now()))
  returning e.id, e.provider, e.channel_id, e.raw_body, e.attempts, e.claim_id;
$$;

-- ─── Finalização cercada pelo claim ─────────────────────────────────────────
--
-- `where id = p_event_id and claim_id = p_claim_id`: sem a segunda perna, o
-- PERDEDOR de um takeover escreve por cima do veredito do vencedor — e o
-- vencedor é quem de fato respondeu ao cliente.
--
-- Devolve o NÚMERO DE LINHAS AFETADAS, e o caller confere. `UPDATE` do
-- supabase-js que casa zero linhas devolve `error: null` (invariante do
-- CLAUDE.md), então sem conferir "a cerca negou" fica indistinguível de
-- "gravei" — e o caller seguiria promovendo dead letter sobre linha que não
-- tocou.
--
-- `attempts = attempts + 1` acontece AQUI, em SQL, e só em retentativa
-- (`received`) ou `dead`: incrementar no Deno a partir do valor que o claim leu
-- é lost update por construção. Desfecho terminal de sucesso e recusa terminal
-- de 401 não gastam tentativa — não há nada a retentar.
--
-- `next_attempt_at` é NOT NULL, então o ramo terminal escreve `now()` em vez de
-- deixar a coluna intacta; a linha terminal nunca é selecionada pela varredura,
-- que filtra por `status`.
create or replace function public.finalize_whatsapp_inbound_event(
  p_event_id            uuid,
  p_claim_id            uuid,
  p_status              text,
  p_outcome             text,
  p_error               text,
  p_retry_delay_seconds integer
)
returns integer
language sql
security definer
set search_path = ''
as $$
  with fenced as (
    update public.whatsapp_inbound_events e
       set status          = p_status,
           outcome         = p_outcome,
           last_error      = left(p_error, 500),
           attempts        = case
                               when p_status in ('received', 'dead') then e.attempts + 1
                               else e.attempts
                             end,
           next_attempt_at = case
                               when p_retry_delay_seconds is null then now()
                               else now() + make_interval(secs => p_retry_delay_seconds)
                             end,
           claim_id        = null,
           claimed_until   = null,
           updated_at      = now()
     where e.id = p_event_id
       and e.claim_id = p_claim_id
    returning 1
  )
  select count(*)::integer from fenced;
$$;

-- CREATE FUNCTION concede EXECUTE a PUBLIC por padrão e o schema public é
-- exposto ao PostgREST com a anon key. Estas duas movem a fila de inbound —
-- ninguém além do service_role tem o que fazer com elas.
revoke all on function public.claim_whatsapp_inbound_event(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_whatsapp_inbound_event(uuid) to service_role;

revoke all on function public.finalize_whatsapp_inbound_event(uuid, uuid, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.finalize_whatsapp_inbound_event(uuid, uuid, text, text, text, integer)
  to service_role;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. ACL (esperado: sem anon= e sem authenticated=; service_role com X):
--   select proname, proacl from pg_proc
--    where proname in ('claim_whatsapp_inbound_event', 'finalize_whatsapp_inbound_event');
--
-- 2. Nenhuma linha reivindicada ainda (esperado: 0 — o gate nasce OFF):
--   select count(*) from whatsapp_inbound_events where status = 'processing';
--
-- 3. Nenhum job agendado (esperado: 0 linhas — o agendamento é a 114):
--   select jobname from cron.job where jobname = 'whatsapp-inbound-sweep';
--
-- Rollback:
--   drop function if exists public.claim_whatsapp_inbound_event(uuid);
--   drop function if exists public.finalize_whatsapp_inbound_event(uuid, uuid, text, text, text, integer);
