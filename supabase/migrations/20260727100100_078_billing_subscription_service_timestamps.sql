-- Marcos de suspensão e restauração por assinatura (Fase 5b).
--
-- A suspensão do serviço de WhatsApp é `billing_subscriptions.status='unpaid'`:
-- `ALLOWED_SUB_STATUSES` do núcleo de entitlements é {active, trialing,
-- past_due}, então `unpaid` já derruba o entitlement de `whatsapp` sem nenhuma
-- alteração no núcleo. `unpaid` também não é `canceled`, então a RPC
-- `resolve_or_activate_subscription` continua encontrando a linha suspensa e
-- não cria uma segunda assinatura.
--
-- O status sozinho não diz QUANDO. Estas duas colunas dão o marco para a tela
-- do cliente ("suspenso desde"), para a auditoria e para o teste de que
-- restaurar duas vezes não reescreve a data.

begin;

alter table billing_subscriptions
  add column if not exists suspended_at timestamptz,
  add column if not exists restored_at timestamptz;

comment on column billing_subscriptions.suspended_at is
  'Quando o serviço desta assinatura foi suspenso por inadimplência. Limpo na restauração. Vale para qualquer categoria; hoje só a de WhatsApp é suspensa por worker.';

comment on column billing_subscriptions.restored_at is
  'Quando o serviço voltou após pagamento confirmado. Preservado entre ciclos — é o último retorno, não um contador.';

commit;

-- Validação (esperado: 2 linhas):
--   select column_name from information_schema.columns
--    where table_name = 'billing_subscriptions'
--      and column_name in ('suspended_at', 'restored_at');
--
-- Rollback:
--   alter table billing_subscriptions
--     drop column if exists restored_at,
--     drop column if exists suspended_at;
