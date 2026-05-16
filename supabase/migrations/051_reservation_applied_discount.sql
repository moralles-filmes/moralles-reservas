-- Migration 051: Persiste o desconto aplicado no momento da criação da reserva.
--
-- Cada `hall_schedule` pode ter um `discount_percent` configurado (0–50%).
-- Quando o cliente reserva um slot, o desconto vigente é capturado e gravado
-- nesta coluna para que mensagens (confirmação, lembrete) exibam o valor que
-- o cliente viu na hora — mesmo que o operador edite o schedule depois.
--
-- NULL = reserva criada antes desta feature OU schedule sem desconto.
-- A UI exibe linha de desconto apenas quando o valor > 0.

alter table public.reservations
  add column if not exists applied_discount_percent integer null
    check (
      applied_discount_percent is null
      or (applied_discount_percent >= 0 and applied_discount_percent <= 100)
    );

comment on column public.reservations.applied_discount_percent is
  'Desconto (%) capturado do hall_schedule (ou special_date override) no momento da criação da reserva. NULL = sem desconto aplicável ou reserva pré-feature.';
