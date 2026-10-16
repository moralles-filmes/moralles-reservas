-- Migração de loja para o oficial (migration 20261016140200): o que o `65`
-- precisa além da cadeia do 63. Somente banco descartável.
--
-- SEQUÊNCIA (mesmo banco do 62/63, ver a seção "Datafy — migração de loja em
-- produção (65)" no README):
--   00 -> 00a -> 61a -> 20261014120000 -> 62a -> 63a -> 20261014170540
--   -> 65a (este) -> 65 (esperado: ERROR, RED) -> 20261016140200 -> 65 ...
--
-- O `65` não precisa de schema novo: `uazapi` já está no CHECK de provider do
-- 61a, `is_active`/`manual_echo_verified_at`/`activation_requested_at` vêm do
-- 62a, `unit_members` do 63a. Este arquivo existe por UMA medida que só pode
-- ser tomada ANTES da migration: a ACL (`proacl`) das duas funções que ela
-- substitui por `create or replace`. O cabeçalho da migration afirma que
-- `create or replace` preserva a ACL do objeto; o M9 do `65` compara o
-- `proacl` de depois com o gravado aqui, e é isso que transforma a afirmação em
-- medida. Gravado depois da migration, o snapshot compararia a ACL consigo
-- mesma e o M9 ficaria verde medindo nada — por isso o arquivo RECUSA rodar com
-- a migration já aplicada.
--
-- `t_snap065` é tabela de harness e fica fora de qualquer rollback (o `65`
-- também guarda nela a assinatura do M10 entre execuções).

do $$
begin
  if exists (select 1 from pg_catalog.pg_attribute
              where attrelid = to_regclass('public.whatsapp_official_connection_grants')
                and attname = 'replaces_channel_id' and not attisdropped) then
    raise exception '65a exige rodar ANTES da migration 20261016140200: o snapshot da ACL de antes seria a ACL de depois e o M9 nao mediria nada. Recrie o banco.';
  end if;
  if to_regprocedure('public.assert_datafy_first_configuration(uuid)') is null
     or to_regprocedure('public.finalize_datafy_channel_subscription(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint,text)') is null
     or to_regprocedure('public.authorize_datafy_mutation(uuid,uuid,uuid,uuid,uuid,text,text,bigint,uuid)') is null then
    raise exception '65a exige a migration 20261014170540 aplicada (autoridades Datafy ausentes).';
  end if;
  if to_regclass('public.unit_members') is null or to_regclass('public.whatsapp_template_accounts') is null then
    raise exception '65a exige 63a-datafy-final-bootstrap.sql aplicado.';
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'public.whatsapp_channels'::regclass
                    and conname = 'whatsapp_channels_provider_check'
                    and pg_catalog.pg_get_constraintdef(oid) like '%uazapi%'
                    and pg_catalog.pg_get_constraintdef(oid) like '%datafy%') then
    raise exception '65a exige 61a-datafy-partner-bootstrap.sql (CHECK de provider sem uazapi/datafy).';
  end if;
end $$;

create table if not exists t_snap065 (k text primary key, v text not null);

insert into t_snap065 (k, v)
select 'acl_antes:' || p.oid::regprocedure::text, coalesce(p.proacl::text, 'null')
  from pg_catalog.pg_proc p
 where p.oid in ('public.assert_datafy_first_configuration(uuid)'::regprocedure,
                 'public.finalize_datafy_channel_subscription(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint,text)'::regprocedure)
on conflict (k) do update set v = excluded.v;

select k, v from t_snap065 where k like 'acl_antes:%' order by k;
