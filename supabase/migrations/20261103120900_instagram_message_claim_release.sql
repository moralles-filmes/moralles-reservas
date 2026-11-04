-- Instagram, Fase 1 (Task 4.5, Ruling R4-k): liberação cercada do claim de
-- mensagem do Direct.
--
-- Plano: docs/superpowers/plans/2026-10-20-instagram-fase-1-direct-conversas.md
-- Pré-voo: supabase/tests/local-preflight/79-instagram-module.sql (IG-8.3 e
--          C-IG-8.3; README, seção 79).
--
-- Quando o turno do agente lança ANTES de qualquer efeito externo, o worker
-- `process-instagram-inbound` reagenda o evento, mas a mensagem ficava
-- `processing` até o lease de 90 s vencer: a próxima tentativa achava a
-- mensagem "em voo" e reagendava de novo. `release_instagram_message_claim`
-- devolve a mensagem à fila na hora.
--
-- Cerca: a MESMA de `complete_instagram_message` (20261103120200) — conta,
-- `mid`, `claim_id` gravado por `claim_instagram_message` e `status =
-- 'processing'`. Claim antigo (outro worker já assumiu depois do lease), linha
-- `done` ou inexistente devolvem `false` sem tocar nada. Ao liberar, `claim_id`
-- vira nulo e `claimed_until` vira `-infinity`: o takeover do
-- `claim_instagram_message` (`claimed_until < now()`) e a purga do ledger
-- (`claimed_until < now()`) tratam a linha como lease vencido, e nenhum
-- `complete_…` com o claim liberado a fecha depois.
--
-- SECURITY DEFINER, `search_path` vazio, EXECUTE só `service_role` (revoke com
-- a assinatura completa depois do create). Idempotente. Sem URL e sem segredo.

begin;

create or replace function public.release_instagram_message_claim(
  p_account_id uuid,
  p_mid        text,
  p_claim_id   uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_account_id is null or p_mid is null or p_claim_id is null then
    return false;
  end if;
  update public.instagram_processed_messages m
     set claim_id      = null,
         claimed_until = '-infinity'::timestamptz
   where m.instagram_account_id = p_account_id
     and m.mid = p_mid
     and m.claim_id = p_claim_id
     and m.status = 'processing';
  return found;
end;
$$;

revoke all on function public.release_instagram_message_claim(uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.release_instagram_message_claim(uuid, text, uuid) to service_role;

commit;

-- ROLLBACK: drop function if exists public.release_instagram_message_claim(uuid, text, uuid);
-- (o worker volta a depender do lease de 90 s; reverter a EF junto.)
