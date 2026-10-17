// Tabelas de `audit_log` que o MEMBRO do cliente pode ler: é a lista da policy
// `unit_member_read_audit` (migration 20261015233000). O teste
// `scripts/audit-log-member-policy.test.ts` amarra as três pontas — a policy,
// esta constante e o `TABLE_LABEL` de `src/pages/gestao/Auditoria.tsx`.
// `useAuditLog` filtra sempre por ela: platform_admin em pseudo-owner lê tudo
// pela policy de admin e, sem o filtro, veria na tela do cliente o custo do
// fornecedor e as notas internas das tabelas da plataforma.
export const AUDIT_LOG_MEMBER_TABLES = ["customers", "reservations", "unit_members"] as const;

export type AuditLogMemberTable = (typeof AUDIT_LOG_MEMBER_TABLES)[number];
