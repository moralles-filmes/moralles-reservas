-- Dependências locais mínimas adicionais; não é schema Supabase completo.
create table if not exists public.unit_members(unit_id uuid,user_id uuid,role text);
create table if not exists public.whatsapp_template_accounts(
  id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),
  waba_id text not null unique,verified_at timestamptz
);
