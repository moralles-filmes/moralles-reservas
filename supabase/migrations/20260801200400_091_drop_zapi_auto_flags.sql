-- Remoção de três flags ÓRFÃS criadas na migration 061 para a API de Parceiro
-- Integrador da Z-API (Fase 6b §9).
--
-- POR QUE REMOVER: nenhum código as lê (grep confirma: os três nomes aparecem
-- apenas no seed da 061). Os nomes prometem automação que não existe — a Z-API
-- não tem rota de cancelamento, o Partner não foi contratado, e platform_flags
-- deve representar controle operacional EXISTENTE, não ideia futura. Um
-- controle sem efeito no painel é pior que ausência: alguém liga e espera
-- consequência.
--
-- POR QUE MIGRATION NOVA E NÃO EDIÇÃO DA 061: a 061 JÁ FOI APLICADA em
-- produção (2026-07-16, Fase 1). Editá-la causaria drift em schema_migrations
-- e exigiria `supabase migration repair` — proibido pelo CLAUDE.md.
--
-- VALORES ANTERIORES, para restauração sem arqueologia:
--   ('zapi_auto_provisioning', 'false',
--    'Provisionamento automático de instância via API de parceiro Z-API (Fase 6).')
--   ('zapi_auto_disconnect', 'false',
--    'Desconectar instância Z-API automaticamente na suspensão D+6 (Fase 6).')
--   ('zapi_auto_cancel', 'false',
--    'Cancelar assinatura da instância na Z-API automaticamente na suspensão (Fase 6).')
--
-- Migration de restauração PRONTA em docs/billing-asaas/restore-zapi-auto-flags.sql
-- — não é comentário de rodapé, é arquivo executável versionado, fora de
-- supabase/migrations/ para não subir por engano num `db push`.
--
-- CONDIÇÃO PARA RECRIAR: só junto de automação real, com consumidor no código,
-- testes, auditoria e rollback. Nunca "para deixar preparado".

begin;

delete from platform_flags
 where key in ('zapi_auto_provisioning', 'zapi_auto_disconnect', 'zapi_auto_cancel');

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. As três sumiram (esperado: 0 linhas):
--   select key from platform_flags
--    where key in ('zapi_auto_provisioning','zapi_auto_disconnect','zapi_auto_cancel');
--
-- 2. Nenhuma flag VIVA foi removida por engano — as da 4/5a/5b seguem
--    presentes (esperado: 4 linhas, todas com value 'false'):
--   select key, value from platform_flags
--    where key in ('whatsapp_service_enforcement','billing_invoice_ingestion',
--                  'whatsapp_implementation_flow','whatsapp_subscription_checkout')
--    order by key;
--
-- 3. O painel não exibe controle sem efeito (esperado: 0 linhas):
--   -- no repositório: grep -rn "zapi_auto" src/
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- Copiar docs/billing-asaas/restore-zapi-auto-flags.sql para
-- supabase/migrations/ com nome no formato YYYYMMDDHHMMSS_nnn_*.sql e aplicar
-- com `supabase db push`. Restaurar as flags NÃO restaura automação nenhuma.
