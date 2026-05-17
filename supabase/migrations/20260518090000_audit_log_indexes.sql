-- Auditoria 2026-05-18: índices compostos para audit_log.
--
-- Motivação: o hook useAuditLog passou a filtrar por
--   (unit_id = X OR organization_id = Y)
-- porque o trigger audit_trigger_func popula unit_id apenas para reservations
-- e organization_id apenas para customers — antes o frontend usava só unit_id e
-- todo o histórico de customers ficava invisível na UI.
--
-- O índice antigo audit_log_created_at_idx (DESC global) não acelera o filtro
-- escopado por tenant: o planner tinha que ler a tabela inteira até reunir limit
-- linhas. Os índices abaixo cobrem cada lado da OR e são partial (NOT NULL) para
-- ficarem compactos.
--
-- CONCURRENTLY evita ACCESS EXCLUSIVE lock em produção; por isso o arquivo NÃO
-- usa begin/commit (Postgres não permite CREATE INDEX CONCURRENTLY em
-- transaction). IF NOT EXISTS permite reexecução segura.

create index concurrently if not exists audit_log_unit_table_created_idx
  on audit_log (unit_id, table_name, created_at desc)
  where unit_id is not null;

create index concurrently if not exists audit_log_org_table_created_idx
  on audit_log (organization_id, table_name, created_at desc)
  where organization_id is not null;

comment on index audit_log_unit_table_created_idx is
  'Suporta filtro por unit_id (eventos de reservations) com order by created_at desc.';
comment on index audit_log_org_table_created_idx is
  'Suporta filtro por organization_id (eventos de customers) com order by created_at desc.';
