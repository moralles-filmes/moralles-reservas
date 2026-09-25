-- Reivindicação cercada, finalização, seleção e purga da fila de inbound (Fase C).
--
-- ESTA MIGRATION SÓ CRIA FUNÇÃO. Não agenda nada (o `cron.schedule` é a 114) e
-- não toca na tabela nem nos índices (é a 111 que os cria).
--
-- QUATRO FUNÇÕES, e a divisão de trabalho é o desenho: `claim_...` e
-- `finalize_...` são a CERCA (uma linha, um dono); `select_due_...` é só a
-- ESCOLHA de quem tentar a seguir, sem escrever nada; `purge_...` é a retenção.
-- Quem decide o que cada desfecho significa é o núcleo puro em TypeScript, não
-- estas funções.
--
-- AS DUAS PRIMEIRAS EXISTEM PELO MESMO RISCO: duas execuções da MESMA linha
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
--   * o truncamento de `last_error` em 500 aqui é BACKSTOP, e o número é
--     DIFERENTE do limite real de propósito: o adapter corta em 300
--     (`INBOUND_ERROR_TEXT_MAX`, no mesmo núcleo) e é ele quem também remove o
--     que o Postgres recusa em `text` — um `\u0000` estouraria 22021 e a
--     finalização falharia SEMPRE, deixando a linha presa (ver
--     `sanitizeQueueErrorText`). Dois números iguais convidariam a "unificar" e
--     apagar a distinção entre o limite e a rede de segurança.
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
-- ESTE CLAIM IGNORA `next_attempt_at` DE PROPÓSITO, e a assimetria com a
-- varredura é a decisão: aqui o chamador JÁ ESCOLHEU a linha (é o caminho rápido,
-- disparado pela própria request que a persistiu, e `next_attempt_at` nasce
-- `now()`), então exigir a data só adicionaria uma corrida de milissegundos com o
-- próprio insert. Quem respeita a escada de retentativa é a SELEÇÃO da varredura,
-- que filtra por `next_attempt_at <= now()`. Consequência a manter em mente: uma
-- chamada por id alcança uma linha agendada para o futuro. Isso é o que se quer
-- no caminho rápido e é o que nenhum outro chamador deve fazer.
--
-- `claimed_until < now()` com `claimed_until` NULL avalia NULL, logo não é
-- verdadeiro, logo um `processing` sem lease nunca seria retomado. Não é caminho
-- alcançável: **este UPDATE é o ÚNICO escritor de `status = 'processing'`** em
-- todo o desenho, e ele grava o lease no MESMO comando; a finalização nunca
-- escreve `processing` e sempre limpa o lease junto. A varredura NÃO é um segundo
-- escritor — `select_due_whatsapp_inbound_events`, mais abaixo neste arquivo, é
-- somente leitura justamente por isto. Se algum dia outro escritor gravar
-- `processing`, ele carrega o lease ou reabre este buraco.
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

-- ─── Seleção das linhas DEVIDAS: SOMENTE LEITURA ────────────────────────────
--
-- NÃO ESCREVE NADA, e essa é a decisão. Uma versão anterior desta fase previa
-- um claim EM LOTE (reivindicar 20 linhas de uma vez, marcá-las `processing` e
-- processá-las em sequência). Estava errado duas vezes:
--
--   1. O wall clock da Edge Function é do WORKER, não da request. Reivindicar 20
--      e processar uma ou duas antes de o worker ser derrubado deixaria ~18
--      leases órfãos por minuto, trabalháveis de novo só 90 s depois pelo
--      takeover — e a varredura seguinte criaria outros 18. O estado estável
--      desse desenho é uma fila que nunca esvazia.
--   2. O claim POR LINHA então recusaria essas mesmas linhas: elas estariam
--      `processing` com lease vivo, e `processQueuedEventById` sairia em silêncio
--      (`queued_event_not_claimable`). O lote reivindicado seria exatamente o
--      trabalho que o processador se recusa a fazer.
--
-- Escrever `status = 'processing'` aqui reabriria, ainda por cima, o buraco que o
-- comentário do claim acima nomeia: um `processing` sem lease nunca é retomável.
-- A CERCA É O CLAIM, por linha, no primeiro ato do processamento. Duas varreduras
-- sobrepostas podem selecionar o mesmo id, e o custo é UMA chamada de claim
-- desperdiçada — por isso também não há `for update skip locked` aqui: fingir
-- exclusão nesta função daria duas cercas onde uma decide.
--
-- É RPC, e não filtro do supabase-js, por UMA razão: `next_attempt_at <= now()`
-- precisa do relógio do BANCO. Um `.lte("next_attempt_at", new Date().toISOString())`
-- reintroduziria o relógio do Deno que o cabeçalho desta migration proíbe.
--
-- DEVOLVE SÓ `id`, nunca a linha inteira: `raw_body` é PII (telefone e texto de
-- cliente) e o claim já o entrega a quem de fato vai processar. Trazê-lo aqui o
-- publicaria uma segunda vez, para linhas que talvez nem sejam processadas nesta
-- invocação (a varredura tem orçamento de laço e pode parar antes da última).
--
-- ─── POR QUE `order by updated_at`, E NÃO `order by next_attempt_at` ─────────
--
-- Porque é a finalização quem escreve `next_attempt_at` — e a linha que precisa
-- ceder a vez é justamente aquela cuja finalização FALHA. Se a falha for
-- independente do payload (banco fora, `PGRST202` por EF deployada antes do
-- `db push`), `attempts` e `next_attempt_at` nunca avançam: a linha fica
-- permanentemente devida com o `next_attempt_at` MAIS ANTIGO da tabela, e
-- ordenar por ele a coloca em primeiro lugar para sempre, consumindo o orçamento
-- de laço e adiando o inbound de outros tenants. Desempate por `attempts asc`
-- não resolve — `attempts` não avançar É o cenário.
--
-- `updated_at` é escrito pelo CLAIM (o UPDATE acima), isto é, pelo próprio ato de
-- SERVIR a linha. Então ser servida sempre custa à linha o seu lugar na fila, e
-- a envenenada volta para o fim enquanto as outras, tocadas há mais tempo, passam
-- na frente. Linha nunca tocada tem `updated_at` = instante do insert, então para
-- o tráfego normal isto é FIFO por chegada, que é o que o cliente espera.
--
-- `next_attempt_at` continua sendo o PORTÃO (o `where`), não a prioridade: a
-- escada de retentativa segue valendo integralmente.
--
-- O conjunto ordenado é só o DEVIDO e não-terminal (o `where` exclui `done` e
-- `dead`, que são a massa da tabela até a purga), então a ordenação não se apoia
-- no índice `whatsapp_inbound_events_due_idx` e não precisa: ordenar algumas
-- dezenas de linhas é ruído.
create or replace function public.select_due_whatsapp_inbound_events(p_limit integer default 20)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id
    from public.whatsapp_inbound_events e
   where e.next_attempt_at <= now()
     and (e.status = 'received'
          or (e.status = 'processing' and e.claimed_until < now()))
   order by e.updated_at
   limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

-- ─── Purga: a retenção é parte do desenho, não faxina ───────────────────────
--
-- `raw_body` carrega telefone e texto de cliente — é PII, e não fica além do
-- necessário. `done` sai em 7 dias; `dead` em 30, porque dead letter é o que uma
-- pessoa ainda vai investigar. Os dois números são GÊMEOS DECLARADOS de
-- `PURGE_DONE_AFTER_DAYS` e `PURGE_DEAD_AFTER_DAYS`, em
-- `supabase/functions/_shared/whatsapp-inbound-queue-core.ts` (SQL não importa
-- TypeScript, então o ponteiro é este comentário), e já estão escritos também no
-- cabeçalho da 111.
--
-- ESTA DIFERENÇA É LOAD-BEARING PARA UMA DECISÃO DE OUTRO ARQUIVO, e as duas
-- metades se perdem se ficarem separadas: a recusa TERMINAL de 401 morre em
-- `done`, e não em `dead` (ver `queuedEventVerdict`, em
-- `_shared/whatsapp-inbound-queue-core.ts`), exatamente para cair na purga de 7
-- dias em vez da de 30. Marcá-la `dead` reteria o corpo cru por um mês, quando
-- `webhook_executions` já guarda o rastro de segurança (`webhook_unauthorized`,
-- TTL 30 d) SEM o corpo. Encurtar a janela de `dead` para igualar a de `done`, ou
-- alongar a de `done`, desfaz essa escolha pelo outro lado.
--
-- Roda dentro da própria varredura — nenhum job novo de `pg_cron`.
create or replace function public.purge_whatsapp_inbound_events()
returns integer
language sql
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.whatsapp_inbound_events
     where (status = 'done' and received_at < now() - interval '7 days')
        or (status = 'dead' and received_at < now() - interval '30 days')
    returning 1
  ) select count(*)::integer from gone;
$$;

-- CREATE FUNCTION concede EXECUTE a PUBLIC por padrão e o schema public é
-- exposto ao PostgREST com a anon key. Estas quatro movem (ou leem) a fila de
-- inbound — ninguém além do service_role tem o que fazer com elas. A seleção não
-- escreve, mas devolve id de entrega de qualquer tenant: com `anon`, seria um
-- inventário de quem recebeu mensagem agora.
revoke all on function public.claim_whatsapp_inbound_event(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_whatsapp_inbound_event(uuid) to service_role;

revoke all on function public.finalize_whatsapp_inbound_event(uuid, uuid, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.finalize_whatsapp_inbound_event(uuid, uuid, text, text, text, integer)
  to service_role;

revoke all on function public.select_due_whatsapp_inbound_events(integer)
  from public, anon, authenticated;
grant execute on function public.select_due_whatsapp_inbound_events(integer) to service_role;

revoke all on function public.purge_whatsapp_inbound_events()
  from public, anon, authenticated;
grant execute on function public.purge_whatsapp_inbound_events() to service_role;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. ACL (esperado: 4 linhas, sem anon= e sem authenticated=; service_role com X):
--   select proname, proacl from pg_proc
--    where proname in ('claim_whatsapp_inbound_event', 'finalize_whatsapp_inbound_event',
--                      'select_due_whatsapp_inbound_events', 'purge_whatsapp_inbound_events');
--
-- 2. Nenhuma linha reivindicada ainda (esperado: 0 — o gate nasce OFF):
--   select count(*) from whatsapp_inbound_events where status = 'processing';
--
-- 3. Nada devido e nada a purgar (esperado: 0 e 0 — a tabela nasce vazia):
--   select count(*) from select_due_whatsapp_inbound_events(100);
--   select purge_whatsapp_inbound_events();
--
-- 4. Nenhum job agendado (esperado: 0 linhas — o agendamento é a 114):
--   select jobname from cron.job where jobname = 'whatsapp-inbound-sweep';
--
-- Rollback:
--   drop function if exists public.claim_whatsapp_inbound_event(uuid);
--   drop function if exists public.finalize_whatsapp_inbound_event(uuid, uuid, text, text, text, integer);
--   drop function if exists public.select_due_whatsapp_inbound_events(integer);
--   drop function if exists public.purge_whatsapp_inbound_events();
