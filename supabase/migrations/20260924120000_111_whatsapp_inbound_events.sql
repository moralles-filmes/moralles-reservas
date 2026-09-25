-- Fase C — fila durável de eventos inbound de WhatsApp.
--
-- UMA LINHA POR ENTREGA, não por parte de lote. O corpo cru fica armazenado
-- uma vez e INTACTO: guardar a parte já dividida seria re-serializar
-- (`JSON.stringify(part)`), o que destrói a capacidade de revalidar a
-- assinatura. O processador divide o lote em memória, e a idempotência POR
-- PARTE já é de `processed_messages (provider, message_id)`.
--
-- `raw_body` é `bytea`, não `text`: Postgres recusa `\u0000` em `text`
-- (SQLSTATE 22021), e um único inbound com NUL faria o INSERT falhar, virar
-- 503, e o provider reentregar até desistir. `bytea` aceita qualquer octeto e
-- devolve o corpo byte a byte — que é exatamente o que a revalidação exige.
--
-- MEDIDO, e é o motivo de o caso INBOUND-1 do pré-voo comparar
-- `octet_length(raw_body)` em vez de ler a coluna para uma variável `bytea`:
-- com a coluna em `text`, inserir os octetos NÃO estoura — o coerce de
-- atribuição bytea→text grava a REPRESENTAÇÃO HEX (`\x7b22...`, 24 caracteres)
-- em lugar do corpo de 11 octetos, e uma leitura para variável `bytea`
-- converte o hex de volta, escondendo o dano. Quem estoura 22021 é o caminho
-- honesto do escritor (`convert_from(corpo, 'UTF8')`). As duas metades estão no
-- controle C-111-1 de `supabase/tests/local-preflight/17-controles-111.sql`.
--
-- RETENÇÃO (constantes em `_shared/whatsapp-inbound-queue-core.ts`, documentadas
-- aqui e NÃO importadas — SQL não importa TypeScript): `done` é purgado depois
-- de PURGE_DONE_AFTER_DAYS = 7 dias, `dead` depois de
-- PURGE_DEAD_AFTER_DAYS = 30. O worker de purga é de fase posterior; esta
-- migration só cria a tabela.

create table if not exists whatsapp_inbound_events (
  id                uuid        primary key default gen_random_uuid(),
  provider          text        not null
                    check (provider in ('zapi','uazapi','waha','official','datafy')),
  channel_id        uuid        not null references whatsapp_channels(id) on delete cascade,
  unit_id           uuid        not null references units(id) on delete cascade,
  raw_body          bytea       not null,
  signature_header  text,
  signature_scheme  text,
  delivery_id       text        check (delivery_id is null
                                       or length(btrim(delivery_id)) between 1 and 512),
  received_at       timestamptz not null default now(),
  status            text        not null default 'received'
                    check (status in ('received','processing','done','dead')),
  attempts          integer     not null default 0 check (attempts >= 0),
  next_attempt_at   timestamptz not null default now(),
  claim_id          uuid,
  claimed_until     timestamptz,
  outcome           text,
  last_error        text,
  updated_at        timestamptz not null default now()
);

comment on table whatsapp_inbound_events is
  'Fila duravel de entregas inbound de WhatsApp (Fase C). Uma linha por ENTREGA do provider, nunca por parte de lote. FORCE RLS sem policies: acesso exclusivo por service_role via Edge Function. Retencao: done 7d, dead 30d (constantes em _shared/whatsapp-inbound-queue-core.ts).';
comment on column whatsapp_inbound_events.raw_body is
  'Corpo CRU da entrega, byte a byte. bytea e nao text porque text recusa \u0000. Nunca re-serializar: a revalidacao de assinatura depende do byte exato.';
comment on column whatsapp_inbound_events.delivery_id is
  'x-datafy-delivery-id. Só a Datafy declara; legados usam processed_messages como autoridade. Vazio normaliza para NULL no caller (o unique e parcial e '''' nao e null). O 512 do CHECK e o mesmo numero de MAX_DELIVERY_ID_LEN em _shared/whatsapp-inbound-queue-core.ts (normalizeDeliveryId), que aponta de volta para este CHECK: mudar um lado sem o outro e o comeco do drift, e quem edita pelo lado do SQL nao tem outro ponteiro.';

-- Dedupe de ENTREGA, escopado por canal: um id de entrega só tem significado
-- dentro do canal que o emitiu.
--
-- O predicado parcial NÃO é o que faz duas entregas legadas (`delivery_id`
-- NULL) coexistirem — MEDIDO: em Postgres, NULL num índice unique já é
-- distinto de outro NULL por default, então derrubar o `where` mantém as duas
-- linhas entrando. O que derrubaria é `nulls not distinct`, e é essa a
-- sabotagem do controle C-111-2. O `where` fica pelo que ele de fato dá: o
-- índice não carrega as linhas legadas, que são a maioria absoluta.
create unique index if not exists whatsapp_inbound_events_delivery_idx
  on whatsapp_inbound_events (channel_id, delivery_id)
  where delivery_id is not null;

-- Consulta da varredura: due e não-terminal.
create index if not exists whatsapp_inbound_events_due_idx
  on whatsapp_inbound_events (next_attempt_at)
  where status in ('received','processing');

-- Painel: dead por unidade.
create index if not exists whatsapp_inbound_events_unit_status_idx
  on whatsapp_inbound_events (unit_id, status, received_at desc);

alter table whatsapp_inbound_events enable row level security;
alter table whatsapp_inbound_events force row level security;
-- Sem policies: só service_role, via Edge Function. Mesma disciplina de
-- whatsapp_channels, processed_messages e webhook_executions.

-- Opt-in POR CANAL. A linha do canal já é lida antes do ACK, então ler mais
-- esta coluna custa zero I/O. Rollout e rollback de um UPDATE, um canal por vez.
alter table whatsapp_channels
  add column if not exists async_ingestion_enabled boolean not null default false;

comment on column whatsapp_channels.async_ingestion_enabled is
  'Perna por canal do gate da Fase C. A outra e platform_flags.whatsapp_async_ingestion. AS DUAS precisam ser verdadeiras.';

-- Kill-switch global, fail-closed: ausente = OFF.
--
-- `platform_flags` NÃO tem coluna `enabled` — o valor mora em `value jsonb`
-- (migration 061, `default 'false'::jsonb`), e o resolver
-- `_shared/platform-flags.ts` lê dali. Semear numa coluna inexistente faria
-- esta migration inteira falhar ao aplicar.
insert into platform_flags (key, value, description) values
  ('whatsapp_async_ingestion', 'false',
   'Fase C: ingestao assincrona do webhook de WhatsApp. Precisa de async_ingestion_enabled no canal TAMBEM. NAO ligar para provider com trafego real antes do alerta ativo da Fase J (ASYNC_INGESTION_DEADLETTER_ALERT).')
on conflict (key) do nothing;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. RLS forçada e sem policies (esperado: relrowsecurity=t, relforcerowsecurity=t, 0 policies):
--   select relrowsecurity, relforcerowsecurity from pg_class
--    where relname = 'whatsapp_inbound_events';
--   select count(*) from pg_policies where tablename = 'whatsapp_inbound_events';
--
-- 2. Flag semeada DESLIGADA (esperado: false):
--   select value from platform_flags where key = 'whatsapp_async_ingestion';
--
-- 3. Nenhum canal optado (esperado: 0):
--   select count(*) from whatsapp_channels where async_ingestion_enabled;
--
-- Rollback:
--   drop table if exists whatsapp_inbound_events;
--   alter table whatsapp_channels drop column if exists async_ingestion_enabled;
--   delete from platform_flags where key = 'whatsapp_async_ingestion';
