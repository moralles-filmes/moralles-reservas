-- RESTAURAÇÃO das três flags removidas pela migration 091 (Fase 6b §9).
--
-- Este arquivo NÃO está em supabase/migrations/ de propósito: ele não deve ser
-- aplicado por engano num `db push`. Para usá-lo, copie para
-- supabase/migrations/ com o nome YYYYMMDDHHMMSS_nnn_restore_zapi_auto_flags.sql
-- e aplique com `supabase db push`.
--
-- Valores restaurados são EXATAMENTE os que existiam antes da remoção — chave,
-- valor e descrição copiados do seed original da migration 061.
--
-- `platform_flags.value` é jsonb: 'false' precisa do cast explícito, senão o
-- insert falha por tipo.
--
-- RESTAURAR AS FLAGS NÃO RESTAURA AUTOMAÇÃO NENHUMA. Se a intenção for
-- automatizar de verdade, a flag é a ÚLTIMA etapa — depois do consumidor no
-- código, dos testes, da auditoria e do rollback —, nunca a primeira.

insert into platform_flags (key, value, description)
values
  ('zapi_auto_provisioning', 'false'::jsonb,
   'Provisionamento automático de instância via API de parceiro Z-API (Fase 6).'),
  ('zapi_auto_disconnect', 'false'::jsonb,
   'Desconectar instância Z-API automaticamente na suspensão D+6 (Fase 6).'),
  ('zapi_auto_cancel', 'false'::jsonb,
   'Cancelar assinatura da instância na Z-API automaticamente na suspensão (Fase 6).')
on conflict (key) do nothing;

-- Conferência (esperado: 3 linhas, todas 'false'):
--   select key, value from platform_flags
--    where key in ('zapi_auto_provisioning','zapi_auto_disconnect','zapi_auto_cancel');
