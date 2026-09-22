-- Migration 109: consulta pública por código resolve o TOKEN, nunca o dado.
--
-- Fecha dois defeitos trançados de `public.get_reservation_by_code(text,uuid)`.
--
-- (A) FUNCIONAL. O único call site dessa RPC em todo o repositório é
--     `src/pages/PublicPortal.tsx` -> ReservaCodeLookup -> useReservas.ts:97: o
--     PORTAL PÚBLICO, não o painel. A migration 085 anotou
--     `-- Caller: src/hooks/useReservas.ts (hook do painel)` e, com base nessa
--     leitura, revogou `anon`. Desde 2026-07-30 o diálogo "Já tem reserva?
--     Consulte pelo código" responde HTTP 401 / 42501 para todo visitante —
--     medido com a anon key real. O componente só lia `data`/`isLoading`, então
--     o erro chegava ao cliente como "Reserva não encontrada. Verifique o
--     código.". As migrations 005 e 013 tinham concedido `anon` de propósito e
--     diziam "consulta pública" e "portal público" no comentário.
--
-- (B) SEGURANÇA (P1). A função é SECURITY DEFINER, `language sql`, sem
--     `auth.uid()` em lugar nenhum e sem helper de membresia, concedida a
--     `authenticated`. Qualquer usuário logado de qualquer organização que
--     possua um `reservation_code` lia `customer_name`, `customer_phone`,
--     `customer_email` e `notes` da reserva de QUALQUER organização.
--     `p_unit_id` não protegia: `reservation_code` tem índice UNIQUE GLOBAL
--     (`reservations_reservation_code_key`), então o parâmetro só estreitava 1
--     linha para 0 — filtrava, nunca autorizava.
--
-- (C) De quebra, o diálogo renderizava `<ReservaCard>`, componente de painel que
--     exibe nome completo, telefone e `notes` do operador. Antes da 085 isso
--     estava no ar no portal público.
--
-- A CORREÇÃO NÃO É UM GUARD. Guard de membresia numa RPC cujo único chamador é
-- anônimo consolidaria (A); e devolver o payload atual a `anon` publicaria
-- telefone, e-mail e `notes`, contra a régua de superfície pública. Em vez
-- disso, o portal passa a resolver o código para o TOKEN de /acompanhar/:token e
-- `get_reservation_by_code` é DROPADA — (B) fecha por remoção, sem guard novo
-- para auditar, e (C) some junto quando o portal deixa de renderizar ReservaCard.
--
-- NENHUM PAYLOAD PÚBLICO NOVO NASCE AQUI: quem entrega dado continua sendo
-- `get_public_tracking` (migration 055), fonte única da régua de privacidade —
-- 1º nome, sem telefone/e-mail/`notes`.
--
-- POR QUE `language sql` E NÃO `plpgsql` COM `raise`, ao contrário da 108: lá a
-- recusa tinha de ser `raise ... 42501` porque `count(*)` sobre conjunto vazio
-- sempre produz linha, e "negar" ficaria indistinguível de "não achar nada".
-- Aqui o retorno é uma linha ou nenhuma: `null` já responde código errado,
-- unidade errada e unidade não pública — os três indistinguíveis, sem oráculo.
--
-- O GATE `units.is_public` TEM DE CASAR COM O DE `get_public_tracking`. Se este
-- for mais frouxo, o código resolve um token que a página de acompanhamento
-- depois recusa, e o cliente cai em "Acompanhamento indisponível" DEPOIS de
-- digitar o código certo. Afrouxar um lado sem o outro é regressão.
--
-- `p_unit_id` É OBRIGATÓRIO E NÃO AUTORIZA — quem autoriza é `u.is_public`. Ele
-- vem do slug da URL e só ESTREITA, impedindo que o portal de uma loja vire
-- oráculo universal onde código de qualquer tenant resolve. Isso não repete o
-- erro que a 108 corrigiu: lá o parâmetro do chamador era a única fonte do
-- tenant e podia ser escolhido para afrouxar o guard; aqui ele só pode tornar a
-- checagem mais estrita.
--
-- SÓ RESERVA, NUNCA FILA: `waitlist.code` é inteiro pequeno por unidade
-- ("senha #7"), trivialmente enumerável. Resolvê-lo para um token seria buraco.
--
-- Idempotente: `create or replace` + `drop ... if exists`.

begin;

create or replace function public.resolve_tracking_token_by_code(
  p_code text,
  p_unit_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = 'public'
as $$
  select r.id
    from reservations r
    join units u on u.id = r.unit_id
   where r.reservation_code = upper(btrim(p_code))
     and r.unit_id = p_unit_id
     and u.is_public = true;
$$;

-- CREATE FUNCTION concede EXECUTE a PUBLIC por padrão e o schema `public` é
-- exposto ao PostgREST com a anon key. Revogar antes de conceder ao papel mínimo.
revoke all on function public.resolve_tracking_token_by_code(text, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_tracking_token_by_code(text, uuid)
  to anon, authenticated;

comment on function public.resolve_tracking_token_by_code(text, uuid) is
  'Resolve reservation_code -> reservations.id (token de /acompanhar/:token). Devolve SO o token, nunca dado: o payload publico e de get_public_tracking, fonte unica da regua de privacidade. Gateada por units.is_public, que TEM de casar com o gate da get_public_tracking. p_unit_id e obrigatorio e so estreita — quem autoriza e o is_public. Nao resolve codigo de waitlist (inteiro pequeno, enumeravel).';

-- Fecha o P1 por remoção. Ver o cabeçalho.
drop function if exists public.get_reservation_by_code(text, uuid);

commit;
