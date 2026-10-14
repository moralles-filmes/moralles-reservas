-- Somente harness local: dependências reais não presentes no bootstrap mínimo.
create table if not exists public.platform_admins (user_id uuid primary key);
alter table public.whatsapp_channels add column if not exists external_instance_id text;
alter table public.whatsapp_channels add column if not exists is_active boolean;
