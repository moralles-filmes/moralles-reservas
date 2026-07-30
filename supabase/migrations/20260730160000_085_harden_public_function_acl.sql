-- HOTFIX DE SEGURANÇA — ACL de EXECUTE das funções do schema public.
--
-- INDEPENDENTE DA FASE 5b. Não aplicar junto com 077–084.
--
-- ─── A CAUSA REAL (confirmada em produção e em ensaio, não suposta) ──────────
--
-- São DUAS superfícies INDEPENDENTES. Fechar uma não fecha a outra, e é isso que
-- enganou este repositório por 14 migrations.
--
-- Superfície A — grant DIRETO a anon/authenticated.
--   `pg_default_acl` tem, para FUNCTION no schema public, entradas de DUAS roles
--   criadoras:
--     postgres        -> {postgres=X, anon=X, authenticated=X, service_role=X}
--     supabase_admin  -> {postgres=X, anon=X, authenticated=X, service_role=X}
--   Toda função nova nasce com entrada PRÓPRIA para anon e authenticated.
--
-- Superfície B — grant IMPLÍCITO ao pseudo-papel PUBLIC.
--   `CREATE FUNCTION` concede EXECUTE a PUBLIC por padrão do Postgres. Como todo
--   papel é membro de PUBLIC, isso sozinho basta para anon executar.
--
-- As duas consequências, cada uma comprovada:
--
--   1. `REVOKE ... FROM public` NÃO revoga de anon nem de authenticated.
--      Remove só a entrada do pseudo-papel; as entradas diretas sobrevivem — a
--      migration parece ter protegido, o COMMENT afirma que protegeu, e a função
--      segue chamável por qualquer portador da anon key (pública no bundle, por
--      design) via POST /rest/v1/rpc/<nome>, porque public é o schema exposto ao
--      PostgREST.
--
--   2. Revogar só as entradas diretas NÃO elimina o acesso herdado de PUBLIC.
--      Verificado em ensaio: função com ACL {=X/postgres, postgres=X, service_role=X}
--      continua com has_function_privilege('anon', ..., 'EXECUTE') = true.
--
-- Por isso a forma correta revoga das DUAS de uma vez, e só então concede ao
-- papel mínimo — padrão já usado e comprovadamente eficaz neste banco
-- (resolve_or_activate_subscription e try_claim_conversation_for_ai mostram
-- {postgres=X, service_role=X} — limpas):
--
--   revoke all on function <sig> from public, anon, authenticated;
--   grant  execute on function <sig> to <papel mínimo>;
--
-- ─── O QUE ESTA MIGRATION NÃO FAZ, E POR QUÊ ────────────────────────────────
--
-- 1. NÃO revoga is_unit_member de anon. É chamada de DENTRO de policies RLS,
--    avaliadas no contexto de privilégio de quem consulta, e aparece em 24
--    policies com roles={public} — revogar de anon não faria a policy negar,
--    faria a query estourar com "permission denied for function", derrubando a
--    entrada pública na fila. Ver §1.1 e §4.1 de
--    docs/hotfix-acl/01-INVENTARIO-E-CLASSIFICACAO.md.
--
--    is_platform_admin e is_org_member SÃO revogadas de anon na seção 5.2: o
--    levantamento de policies mostra 0 policies roles={public} para as duas.
--
-- 2. NÃO toca funções que retornam `trigger`. PostgREST não as expõe, e o
--    Postgres checa EXECUTE em CREATE TRIGGER, não a cada disparo — revogar não
--    ganha segurança nem quebra nada. Fora do escopo por não ter efeito.
--
-- 3. NÃO revoga normalize_br_phone(text) de anon. O trigger
--    customers_canonical_phone_trg é SECURITY INVOKER: num INSERT anônimo em
--    customers ele roda COMO anon, e a chamada interna a normalize_br_phone é
--    checada em runtime nesse papel.
--
-- 4. NÃO altera ownership, NÃO usa DROP, NÃO usa CASCADE, NÃO concede EXECUTE
--    ao schema inteiro, e NÃO concede a service_role "por precaução" — só onde
--    há caller real. O dono (postgres) mantém EXECUTE implícito; os 14 jobs em
--    cron.job rodam com username='postgres', que é também o dono das funções,
--    então nenhum grant é necessário para o cron continuar funcionando.
--
-- Idempotente: revoke de privilégio ausente e grant de privilégio já concedido
-- são no-op, não erro. Pode rodar duas vezes.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. SNAPSHOT — estado ANTES, para auditoria e para reconstruir um grant que
--    porventura precise voltar. Tabela interna: FORCE RLS sem policies, padrão
--    do projeto para tabela que a UI nunca lê.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.function_acl_snapshot (
  id            bigserial primary key,
  taken_at      timestamptz not null default now(),
  label         text        not null,
  function_name text        not null,
  identity_args text        not null,
  owner_role    text        not null,
  is_secdef     boolean     not null,
  acl           text
);

alter table public.function_acl_snapshot enable row level security;
alter table public.function_acl_snapshot force row level security;

comment on table public.function_acl_snapshot is
  'Snapshot de ACL de funções antes de mudanças de privilégio. FORCE RLS sem policies: só service_role/owner.';

insert into public.function_acl_snapshot (label, function_name, identity_args, owner_role, is_secdef, acl)
select
  'pre-085',
  p.proname,
  pg_get_function_identity_arguments(p.oid),
  pg_get_userbyid(p.proowner),
  p.prosecdef,
  p.proacl::text
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.prokind = 'f'
  and not exists (
    select 1 from public.function_acl_snapshot s where s.label = 'pre-085'
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. SERVICE_ROLE_ONLY — callers são Edge Functions (service role key).
-- ─────────────────────────────────────────────────────────────────────────────

-- CRÍTICO. COMMENT no banco já dizia "service_role only" e a migration
-- 20260517120000 fez `revoke ... from public` — o anon sobreviveu. A função não
-- tem guarda interna: valida o formato do JSONB e faz o UPDATE. Quem tivesse o
-- UUID de uma conversa podia injetar mensagem arbitrária nela, em qualquer
-- tenant, escolhendo o `role`. Callers: webhook-whatsapp, send-manual-message,
-- _shared/conversation-log.ts.
revoke all    on function public.append_conversation_message(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.append_conversation_message(uuid, jsonb) to service_role;

-- Callers: process-notification-outbox.
revoke all    on function public.mark_outbox_done(uuid)         from public, anon, authenticated;
grant  execute on function public.mark_outbox_done(uuid)         to service_role;
revoke all    on function public.mark_outbox_failed(uuid, text) from public, anon, authenticated;
grant  execute on function public.mark_outbox_failed(uuid, text) to service_role;

-- Caller: cleanup-orphan-assets.
revoke all    on function public.list_orphan_unit_assets(integer) from public, anon, authenticated;
grant  execute on function public.list_orphan_unit_assets(integer) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. OWNER_CRON_TRIGGER_ONLY — executadas por postgres (dono) via pg_cron ou
--    SQL administrativo. SEM grant: o dono tem EXECUTE implícito.
-- ─────────────────────────────────────────────────────────────────────────────

-- Wrappers de cron. SECURITY DEFINER: leem internal_api_key do Vault e chamam a
-- Edge Function por pg_net. O x-internal-key NÃO protege — é a própria função
-- que o fornece. Chamáveis hoje sem argumento e sem conhecimento nenhum.
revoke all on function public.trigger_outbox_processor()            from public, anon, authenticated;
revoke all on function public.trigger_voucher_processor()           from public, anon, authenticated;
revoke all on function public.trigger_reminder_processor()          from public, anon, authenticated;
revoke all on function public.trigger_survey_processor()            from public, anon, authenticated;
revoke all on function public.trigger_waitlist_feedback_processor() from public, anon, authenticated;
revoke all on function public.trigger_cleanup_orphan_assets()       from public, anon, authenticated;
revoke all on function public.trigger_expire_pending_payments()     from public, anon, authenticated;
revoke all on function public.trigger_billing_overdue()             from public, anon, authenticated;
revoke all on function public.trigger_billing_reminders()           from public, anon, authenticated;
revoke all on function public.trigger_billing_reconcile()           from public, anon, authenticated;
revoke all on function public.trigger_billing_unblock()             from public, anon, authenticated;
revoke all on function public.trigger_billing_trial_expiry()        from public, anon, authenticated;
revoke all on function public.trigger_asaas_reconcile()             from public, anon, authenticated;
revoke all on function public.trigger_billing_notifications()       from public, anon, authenticated;

-- `delete from` sem guarda alguma, sem argumento, sem caller no repositório e
-- sem cron.job. Manutenção administrativa por SQL.
revoke all on function public.cleanup_processed_messages() from public, anon, authenticated;
revoke all on function public.cleanup_webhook_executions() from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. AUTHENTICATED_TENANT — operator-facing; a guarda interna PERMANECE, o ACL
--    correto é defesa em profundidade, não substituto dela.
-- ─────────────────────────────────────────────────────────────────────────────

-- Tem guarda interna (is_unit_member OR is_platform_admin, senão raise
-- 'forbidden'). Por isso NÃO vazou apesar do ACL errado: auth.uid() é NULL para
-- anon e a guarda derruba. Caller: src/hooks/useUndeliveredNotifications.ts.
revoke all    on function public.get_undelivered_notifications(uuid, timestamptz) from public, anon;
grant  execute on function public.get_undelivered_notifications(uuid, timestamptz) to authenticated;

-- SECURITY INVOKER: a RLS da tabela aplica. Caller: src/hooks/useReservas.ts.
revoke all    on function public.search_reservations(uuid, text, date, text) from public, anon;
grant  execute on function public.search_reservations(uuid, text, date, text) to authenticated;

-- Caller: src/hooks/useReservas.ts (hook do painel). O overload de 1 argumento
-- não tem caller localizado — revogado junto, e sob observação no roteiro.
revoke all    on function public.get_reservation_by_code(text, uuid) from public, anon;
grant  execute on function public.get_reservation_by_code(text, uuid) to authenticated;
revoke all    on function public.get_reservation_by_code(text)       from public, anon;
grant  execute on function public.get_reservation_by_code(text)       to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. UNKNOWN_REVIEW_REQUIRED — default-deny até revisão. Se algo quebrar, o
--    grant volta pontualmente E a função é reclassificada no inventário.
-- ─────────────────────────────────────────────────────────────────────────────

-- Nenhum caller no repositório, nenhuma policy a referencia. Possivelmente morta.
revoke all on function public.unit_role(uuid, uuid) from public, anon, authenticated;

-- Migration 036 concedeu a anon/authenticated deliberadamente, mas não há caller
-- no repositório. enter_waitlist é SECURITY DEFINER — se a chamar internamente,
-- roda como o dono e não precisa do grant.
revoke all on function public.next_waitlist_code(uuid) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. PUBLIC_ANON — allowlist explícita. Os grants abaixo já existem; são
--    reafirmados um a um para que a superfície pública fique legível NESTE
--    arquivo, e para que o guardrail tenha contra o que comparar. Nenhuma
--    política ampla, nenhum "manter as RPCs atuais".
-- ─────────────────────────────────────────────────────────────────────────────

-- REVOKE ANTES DO GRANT. Sem esta primeira metade, get_unit_public(text),
-- list_public_units() e normalize_br_phone(text) permanecem com o grant
-- implícito ao pseudo-papel PUBLIC (`=X/postgres` no proacl) — verificado em
-- ensaio. Conceder a anon/authenticated não remove PUBLIC: são superfícies
-- independentes (ver cabeçalho). Com PUBLIC no ACL, QUALQUER papel presente ou
-- futuro executa, não só os dois pretendidos.
revoke all on function public.get_unit_public(text)                  from public;
revoke all on function public.get_unit_public_full(text)             from public;
revoke all on function public.get_widget_public(text)                from public;
revoke all on function public.get_menu_public(text)                  from public;
revoke all on function public.get_public_tracking(uuid)              from public;
revoke all on function public.get_public_business_hours(uuid)        from public;
revoke all on function public.get_public_hall_schedules(uuid, date)  from public;
revoke all on function public.list_public_units()                    from public;
revoke all on function public.enter_waitlist(uuid, text, text, int, text, text, time) from public;
revoke all on function public.normalize_br_phone(text)               from public;

grant execute on function public.get_unit_public(text)                  to anon, authenticated;
grant execute on function public.get_unit_public_full(text)             to anon, authenticated;
grant execute on function public.get_widget_public(text)                to anon, authenticated;
grant execute on function public.get_menu_public(text)                  to anon, authenticated;
grant execute on function public.get_public_tracking(uuid)              to anon, authenticated;
grant execute on function public.get_public_business_hours(uuid)        to anon, authenticated;
grant execute on function public.get_public_hall_schedules(uuid, date)  to anon, authenticated;
grant execute on function public.list_public_units()                    to anon, authenticated;
grant execute on function public.enter_waitlist(uuid, text, text, int, text, text, time) to anon, authenticated;

-- NÃO é RPC de portal: é dependência do trigger INVOKER
-- customers_canonical_phone_trg, que num INSERT anônimo roda COMO anon.
grant execute on function public.normalize_br_phone(text) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5.2 HELPERS DE RLS — anon só onde uma policy roles={public} depende.
--
--     Levantamento sobre as 77 policies de public:
--       is_unit_member    -> 17 policies {authenticated} + 24 policies {public}
--       is_platform_admin -> 26 policies {authenticated} +  0 policies {public}
--       is_org_member     ->  3 policies {authenticated} +  0 policies {public}
--
--     E ZERO funções SECURITY INVOKER referenciam is_platform_admin ou
--     is_org_member (as SECURITY DEFINER que as chamam rodam como o dono, então
--     não dependem do EXECUTE do chamador).
--
--     Logo, anon nessas duas não serve a nenhuma policy nem a nenhum caller — só
--     entrega um oráculo de enumeração ("este UUID é platform admin?", "este
--     usuário pertence a esta organização?") a quem tem a anon key.
--
--     is_unit_member NÃO é tocada: as 24 policies {public} a exigem.
-- ─────────────────────────────────────────────────────────────────────────────

revoke all on function public.is_platform_admin(uuid)   from anon;
revoke all on function public.is_org_member(uuid, uuid) from anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5.1 SEARCH_PATH — única SECURITY DEFINER de public sem search_path fixo.
--
--     Sem ele, quem chama controla a resolução de nomes e pode sequestrar a
--     função criando um schema próprio à frente na busca. Todas as outras
--     DEFINER do projeto já têm `set search_path`; esta escapou.
--
--     `ALTER FUNCTION ... SET` de propósito, e não CREATE OR REPLACE: muda só a
--     configuração, sem reescrever o corpo — nada de reintroduzir uma versão
--     antiga por engano.
-- ─────────────────────────────────────────────────────────────────────────────

alter function public.expire_vouchers() set search_path = public;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. COMMENT — a política declarada tem que bater com a real.
-- ─────────────────────────────────────────────────────────────────────────────

comment on function public.append_conversation_message(uuid, jsonb) is
  'Append atômico em conversations.messages. Use no lugar de SELECT+push+UPDATE. '
  'service_role ONLY — Edge Functions consomem por RPC. ACL corrigido na 085: até lá '
  'era executável por anon/authenticated apesar deste comentário, porque o revoke '
  'original só removeu de PUBLIC. NÃO tem guarda interna de autorização — '
  'follow-up registrado em docs/hotfix-acl/01-INVENTARIO-E-CLASSIFICACAO.md §4.2.';

comment on function public.cleanup_processed_messages() is
  'Manutenção administrativa (delete de linhas antigas). Sem guarda interna: só owner/postgres.';

comment on function public.cleanup_webhook_executions() is
  'Manutenção administrativa (delete de linhas antigas). Sem guarda interna: só owner/postgres.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. RPC DE AUDITORIA — alimenta o guardrail scripts/audit-function-acl.ts.
--
--    Reporta FATO, não política: devolve toda função não-trigger de public que
--    anon ou authenticated podem executar. A allowlist (a política) vive em
--    scripts/function-acl-allowlist.json, versionada e revisável em code review;
--    o script compara os dois e falha nomeando assinatura.
--
--    Essa separação é deliberada: allowlist embutida em SQL só mudaria por
--    migration nova, e ninguém a revisaria como política.
--
--    Funções que retornam `trigger` ficam de fora porque PostgREST não as expõe
--    — incluí-las encheria o relatório de ruído permanente.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.audit_function_acl()
returns table (
  function_name    text,
  identity_args    text,
  is_secdef        boolean,
  anon_execute     boolean,
  auth_execute     boolean,
  public_execute   boolean,
  has_search_path  boolean,
  fn_comment       text,
  acl              text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.proname::text,
    pg_get_function_identity_arguments(p.oid),
    p.prosecdef,
    has_function_privilege('anon',          p.oid, 'EXECUTE'),
    has_function_privilege('authenticated', p.oid, 'EXECUTE'),
    -- Concessão DIRETA ao pseudo-papel PUBLIC: entrada de grantee vazio no ACL
    -- (`=X/owner`). proacl NULL significa privilégios default, que também
    -- incluem PUBLIC — os dois casos contam como exposto.
    (p.proacl is null or exists (
       select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'
     )),
    (p.proconfig is not null and exists (
       select 1 from unnest(p.proconfig) c where c like 'search\_path=%'
     )),
    coalesce(obj_description(p.oid, 'pg_proc'), ''),
    coalesce(p.proacl::text, '(default)')
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.prokind = 'f'
    -- Função que retorna `trigger` fica de fora: PostgREST não a expõe, e o
    -- Postgres checa EXECUTE em CREATE TRIGGER, não a cada disparo. Incluí-la
    -- encheria o relatório de ruído permanente.
    and p.prorettype <> 'trigger'::regtype
  order by p.proname, pg_get_function_identity_arguments(p.oid);
$$;

-- Dogfooding: a própria função de auditoria segue a regra que ela fiscaliza.
revoke all    on function public.audit_function_acl() from public, anon, authenticated;
grant  execute on function public.audit_function_acl() to service_role;

comment on function public.audit_function_acl() is
  'Reporta funções de public executáveis por anon/authenticated. Consumida por '
  'scripts/audit-function-acl.ts, que compara com scripts/function-acl-allowlist.json. '
  'service_role only.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. DEFESA PARCIAL — remove o grant DIRETO de funções futuras. NÃO é garantia.
--
--    LEIA ANTES DE CONFIAR NESTA SEÇÃO. Ela NÃO faz função nova nascer fechada.
--
--    O que ela faz: funções novas criadas por `postgres` deixam de receber
--    entrada DIRETA para anon/authenticated (superfície A do cabeçalho).
--
--    O que ela NÃO faz: o `CREATE FUNCTION` continua concedendo EXECUTE ao
--    pseudo-papel PUBLIC (superfície B), e todo papel é membro de PUBLIC. Medido
--    em ensaio, em schema virgem, nesta mesma versão de Postgres:
--
--      f1 (sem ALTER nenhum)                        -> proacl NULL, anon = true
--      alter default privileges ... revoke execute
--        on functions from public                   -> NENHUMA linha em pg_default_acl
--      f2 (criada depois do revoke)                 -> proacl NULL, anon = true
--
--    Ou seja: `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM
--    PUBLIC` foi NO-OP no ambiente ensaiado. Não existe, por este caminho,
--    proteção confiável para funções futuras. Por isso a linha abaixo revoga
--    apenas de anon/authenticated — pedir o revoke de PUBLIC aqui daria falsa
--    sensação de cobertura.
--
--    O ganho real, e é concreto: sem as entradas diretas, um `revoke ... from
--    public` pontual passa a ser SUFICIENTE para fechar uma função. Hoje não é —
--    e é exatamente esse o modo de falha que produziu este hotfix.
--
--    Escopo: SÓ a role `postgres`, que cria as funções deste projeto e é a role
--    auditada. `supabase_admin` tem default privilege equivalente e NÃO é
--    tocada: é da plataforma, alterá-la é mudança não auditada que a Supabase
--    pode reverter em manutenção. Default privilege é POR ROLE CRIADORA, não
--    configuração global.
--
--    CONTROLE OBRIGATÓRIO: como a prevenção é parcial, quem impede reabertura é
--    o guardrail scripts/audit-function-acl.ts rodando em CI (.github/workflows/
--    function-acl-audit.yml), não esta seção. Ele NÃO pode ser removido nem
--    tornado opcional — nem se um event trigger for criado no futuro, porque
--    manutenções da plataforma podem restaurar os defaults a qualquer momento.
--
--    Follow-up de desenho (NÃO improvisar aqui): event trigger em
--    ddl_command_end que feche funções novas. Requisitos em
--    docs/hotfix-acl/02-VALIDACAO-E-RISCOS.md §9.
-- ─────────────────────────────────────────────────────────────────────────────

alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;

commit;

-- =====================================================================
-- VERIFICAÇÃO (rodar DEPOIS; esperado: só a allowlist da seção 5 + os
-- helpers de RLS da §1.1 do inventário)
-- =====================================================================
--   select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.proacl::text
--     from pg_proc p
--    where p.pronamespace = 'public'::regnamespace
--      and p.prokind = 'f'
--      and p.prorettype <> 'trigger'::regtype
--      and has_function_privilege('anon', p.oid, 'EXECUTE')
--    order by p.proname;
--
-- Antes/depois, a partir do snapshot gravado na seção 0:
--   select s.function_name, s.identity_args, s.acl as antes, p.proacl::text as depois
--     from public.function_acl_snapshot s
--     join pg_proc p on p.proname = s.function_name
--      and pg_get_function_identity_arguments(p.oid) = s.identity_args
--      and p.pronamespace = 'public'::regnamespace
--    where s.label = 'pre-085'
--      and coalesce(s.acl,'') is distinct from coalesce(p.proacl::text,'')
--    order by s.function_name;
--
-- Default privilege da role auditada (esperado: sem anon, sem authenticated):
--   select defaclrole::regrole::text, defaclacl::text
--     from pg_default_acl
--    where defaclobjtype = 'f'
--      and defaclnamespace = 'public'::regnamespace;
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
-- Reverter em bloco significa reabrir a exposição — não é rollback legítimo.
-- Se um caller legítimo quebrar, conceda PONTUALMENTE ao papel que precisa, com
-- assinatura completa, e reclassifique a função no inventário:
--
--   grant execute on function public.<nome>(<args>) to <papel>;
--
-- O estado exato de antes está em public.function_acl_snapshot where label='pre-085'.
--
-- Para reverter a defesa parcial da seção 8 (não recomendado):
--   alter default privileges for role postgres in schema public
--     grant execute on functions to anon, authenticated;
