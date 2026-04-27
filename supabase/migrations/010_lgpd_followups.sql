-- audit_trigger_func é chamada apenas por triggers (não precisa ser executável via /rpc/).
-- Advisor de segurança detectou exposição em /rest/v1/rpc/ — revogamos explicitamente.

revoke all on function public.audit_trigger_func() from public;
revoke execute on function public.audit_trigger_func() from anon;
revoke execute on function public.audit_trigger_func() from authenticated;
