-- Adiciona trigger de auditoria em unit_members.
--
-- A função genérica public.audit_trigger_func() (mig 013, linhas 1036-1107)
-- lê unit_id de qualquer tabela que tenha essa coluna via
-- (v_new->>'unit_id')::uuid — unit_members tem unit_id NOT NULL desde a sua
-- criação na mig 013, então o trigger registra unit_id corretamente em
-- audit_log sem precisar alterar a função.
--
-- Antes desta migration, toda criação/promoção/remoção de membro ficava
-- invisível em audit_log — gap de conformidade LGPD e forense para o módulo
-- Usuários.
--
-- Idempotente: drop trigger if exists antes de create.

begin;

drop trigger if exists unit_members_audit on unit_members;

create trigger unit_members_audit
  after insert or update or delete on unit_members
  for each row execute function public.audit_trigger_func();

commit;
