-- Define a duração padrão de uma reserva (em minutos) por unit. Lida pelas
-- Edge Functions webhook-whatsapp e create-reservation ao calcular janela
-- de conflito entre reservas. Default 90 min cobre o uso típico
-- almoço/jantar; cada unit pode editar via SQL Editor sem deploy.

insert into settings (unit_id, key, value)
select id, 'reservation_duration_minutes', '90'::jsonb
from units
on conflict (unit_id, key) do nothing;
