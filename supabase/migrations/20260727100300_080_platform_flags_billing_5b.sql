-- Flags da Fase 5b. Todas OFF; ligar é decisão explícita, na ordem do runbook.
--
-- SEPARADAS DE PROPÓSITO de `whatsapp_service_enforcement` (criada na 075):
-- esta controla a ENTRADA de dados (criação e correlação automática de
-- faturas), aquela controla as CONSEQUÊNCIAS operacionais da inadimplência.
-- Uma flag só obrigaria a ligar as duas juntas — e o ponto do desenho é pôr o
-- elo financeiro em produção, observar, e só depois permitir suspensões.
--
-- `billing_invoice_ingestion_since` NÃO é booleana: guarda a data ISO em que a
-- ingestão foi ligada. É ela que define "cobrança anterior ao go-live da
-- ingestão", que é o único critério automático de retenção por antiguidade.
-- Vazia = ingestão nunca ativada.

begin;

insert into platform_flags (key, value, description) values
  ('billing_invoice_ingestion', 'false',
   'Cria e correlaciona faturas internas automaticamente a partir das cobrancas do Asaas (PAYMENT_CREATED e reconciliacao). OFF ate a validacao em sandbox da Fase 5b.'),
  ('billing_invoice_ingestion_since', '',
   'Data ISO (YYYY-MM-DD) em que billing_invoice_ingestion foi ligada. Cobranca com due_date anterior a esta data e retida com motivo PRE_GO_LIVE_INVOICE. Vazia = nunca ativada.')
on conflict (key) do nothing;

commit;

-- Validação (esperado: 4 linhas — as 2 novas e as 2 de WhatsApp da 075):
--   select key, value from platform_flags
--    where key in ('billing_invoice_ingestion', 'billing_invoice_ingestion_since',
--                  'whatsapp_subscription_checkout', 'whatsapp_service_enforcement');
--
-- Rollback:
--   delete from platform_flags
--    where key in ('billing_invoice_ingestion', 'billing_invoice_ingestion_since');
