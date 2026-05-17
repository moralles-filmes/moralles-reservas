-- Índices compostos para queries comuns do admin e do agente IA.

-- Lista de reservas filtradas por status + data (página /admin/reservas).
create index if not exists reservations_status_date_idx
  on reservations(status, date desc);

-- check_availability no agente IA: filtra (date, time) + status confirmed/pending.
create index if not exists reservations_date_time_idx
  on reservations(date, time);

-- Última reserva por cliente (drawer em /admin/clientes, get_customer_stats).
create index if not exists reservations_customer_created_idx
  on reservations(customer_id, created_at desc);
