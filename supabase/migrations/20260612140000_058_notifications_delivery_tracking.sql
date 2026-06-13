-- 058 — Rastreio de ENTREGA (não só "enviado") em notifications_sent.
--
-- Motivo: `status='sent'` só significa "o provedor (Z-API) aceitou a requisição
-- (HTTP 2xx)", NÃO "o cliente recebeu". Sem rastrear o messageId devolvido pelo
-- provedor + consumir o callback de status (DELIVERED/READ), o operador não tem
-- como saber quem de fato recebeu. Estas colunas guardam essa verdade; o webhook
-- (status callback) e o send-whatsapp passam a preenchê-las. Vale pra TODOS os
-- kinds (fila E reservas) porque a tabela é compartilhada.
--
-- Idempotente.

alter table notifications_sent
  add column if not exists provider_message_id text,
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at timestamptz,
  add column if not exists failed_at timestamptz;

-- Correlação do callback: a Z-API manda `ids:[<messageId>]`; buscamos a linha
-- por provider_message_id. Parcial pra não indexar as linhas antigas (NULL).
create index if not exists notifications_sent_provider_message_id_idx
  on notifications_sent (provider_message_id)
  where provider_message_id is not null;

comment on column notifications_sent.provider_message_id is
  'ID da mensagem devolvido pelo provedor (Z-API messageId / Meta messages[0].id). Correlaciona o callback de status.';
comment on column notifications_sent.delivered_at is
  'Quando o provedor confirmou entrega no aparelho do cliente (Z-API status RECEIVED). NULL = não confirmado.';
comment on column notifications_sent.read_at is
  'Quando o cliente leu (Z-API status READ/PLAYED).';
comment on column notifications_sent.failed_at is
  'Quando o provedor reportou falha de entrega.';
