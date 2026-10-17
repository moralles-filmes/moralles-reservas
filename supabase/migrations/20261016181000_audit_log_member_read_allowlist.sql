-- audit_log: membro do cliente lê só as tabelas que a tela de Auditoria dele
-- conhece (customers, reservations, unit_members).
--
-- POR QUÊ: a policy anterior liberava a membro da organização/unidade TODA
-- linha com o organization_id/unit_id dele, e o audit_trigger_func grava a
-- linha inteira de whatsapp_instances (087), whatsapp_implementations (071) e
-- organization_entitlement_overrides — custo do fornecedor, notas internas,
-- motivos de override. A 096 já documentava o risco.
--
-- LISTA, NÃO EXCLUSÃO: tabela auditada nova nasce invisível para o cliente.
-- Quem precisar mostrar outra tabela na Auditoria do cliente acrescenta aqui
-- E no TABLE_LABEL de src/pages/gestao/Auditoria.tsx (o teste
-- scripts/audit-log-member-policy.test.ts amarra os dois).
--
-- platform_admin_read_audit não muda. Trigger e linhas existentes não mudam.
-- Não depende de Edge Function.

begin;

drop policy if exists "unit_member_read_audit" on public.audit_log;

create policy "unit_member_read_audit" on public.audit_log
  for select to authenticated
  using (
    table_name in ('customers', 'reservations', 'unit_members')
    and (
      (unit_id is not null and app_private.is_unit_member(auth.uid(), unit_id))
      or (organization_id is not null and app_private.is_org_member(auth.uid(), organization_id))
    )
  );

commit;

-- Validação pós-migration (somente leitura):
--   select policyname, qual from pg_policies
--    where schemaname = 'public' and tablename = 'audit_log' order by 1;
--
-- ROLLBACK (recria a policy anterior — reabre o vazamento; só em emergência).
-- Voltar à policy antiga agora também expõe ao membro o retrato dos ciclos que
-- a `20261016180000_whatsapp_instance_delete_without_cost.sql` grava em
-- `audit_log` (custo, receita, margem e notas), além das linhas que já vazavam:
--   drop policy if exists "unit_member_read_audit" on public.audit_log;
--   create policy "unit_member_read_audit" on public.audit_log for select to authenticated
--     using (((unit_id is not null) and app_private.is_unit_member(auth.uid(), unit_id))
--         or ((organization_id is not null) and app_private.is_org_member(auth.uid(), organization_id)));
