-- Implantação do WhatsApp (Fase 5a). Uma linha por venda/entrega da configuração
-- assistida de R$ 750 — vendida no checkout ou registrada à mão pelo admin.
--
-- DOIS eixos de estado, nunca um só:
--   payment_status      — o dinheiro (ou a ausência dele, quando é cortesia)
--   operational_status  — a execução do serviço
-- Colapsar os dois num campo faz "pago mas não entregue" e "entregue de graça"
-- caírem no mesmo balde, e é exatamente o que o operador precisa distinguir.
--
-- AUSÊNCIA DE LINHA = "não solicitado". Não existe linha vazia representando
-- "nada aconteceu": ela não teria origem, valor nem responsável, e tornaria
-- inútil o índice de "uma implantação aberta por organização".
--
-- RLS: ENABLE + FORCE, policy só de platform_admin. Membro da organização NÃO
-- lê esta tabela — ela carrega notas internas, motivo da cortesia, referência
-- do pagamento externo e responsáveis. O cliente vê a projeção segura devolvida
-- pela EF manage-whatsapp-implementations (action get_service_status).

begin;

create table if not exists whatsapp_implementations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,

  origin text not null
    check (origin in ('ASAAS', 'EXTERNAL_PAYMENT', 'COURTESY', 'ADMIN_OVERRIDE')),
  payment_status text not null
    check (payment_status in ('PENDING', 'CONFIRMED', 'WAIVED', 'REFUNDED', 'CHARGEBACK', 'CANCELED')),
  operational_status text not null default 'NOT_STARTED'
    check (operational_status in ('NOT_STARTED', 'SCHEDULED', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'COMPLETED', 'CANCELED')),

  -- Cobrado (ASAAS) ou efetivamente recebido (EXTERNAL_PAYMENT). NULL em WAIVED:
  -- cortesia não tem valor recebido, e gravar 75000 ali inflaria o faturamento.
  amount_cents integer check (amount_cents is null or amount_cents >= 0),

  billing_plan_id uuid references billing_plans(id),
  billing_invoice_id uuid references billing_invoices(id),
  provider_checkout_id text,

  paid_at timestamptz,
  -- Livre de propósito: 'pix', 'card', 'transferencia', 'dinheiro'... O CHECK de
  -- billing_subscriptions.payment_method não serve aqui (pagamento externo tem
  -- formas que o provedor não conhece).
  payment_method text,
  external_payment_reference text,

  reason text,
  notes text,
  owner_admin_id uuid references auth.users(id),

  scheduled_for date,
  started_at timestamptz,
  completed_at timestamptz,
  canceled_at timestamptz,
  cancel_reason text,

  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Matriz origem × pagamento. Pagamento externo é CONFIRMED com valor e data
  -- reais (entra no relatório financeiro); cortesia e override são WAIVED (não
  -- entram). Trocar um pelo outro falsifica o faturamento nas duas direções.
  constraint whatsapp_impl_origin_payment_chk check (
    (origin = 'ASAAS'
      and payment_status in ('PENDING', 'CONFIRMED', 'REFUNDED', 'CHARGEBACK', 'CANCELED'))
    or (origin = 'EXTERNAL_PAYMENT'
      and payment_status in ('CONFIRMED', 'REFUNDED', 'CANCELED'))
    or (origin in ('COURTESY', 'ADMIN_OVERRIDE')
      and payment_status in ('WAIVED', 'CANCELED'))
  ),

  -- Sem id falso do Asaas: operação manual NUNCA aponta para fatura ou checkout
  -- que não existe lá. Sem isto, um relatório de conciliação passa a mentir.
  constraint whatsapp_impl_no_fake_asaas_chk check (
    origin = 'ASAAS'
    or (billing_invoice_id is null and provider_checkout_id is null)
  ),

  -- Concluir exige pagamento resolvido. REFUNDED/CHARGEBACK entram porque
  -- estorno DEPOIS da entrega não desfaz o trabalho — a linha continua
  -- COMPLETED. Quem impede concluir COM estorno em curso é a Edge Function
  -- (canTransitionOperational só aceita CONFIRMED|WAIVED na transição).
  constraint whatsapp_impl_completed_needs_payment_chk check (
    operational_status <> 'COMPLETED'
    or payment_status in ('CONFIRMED', 'WAIVED', 'REFUNDED', 'CHARGEBACK')
  )
);

comment on table whatsapp_implementations is
  'Implantacao do WhatsApp (R$750). payment_status e operational_status sao eixos SEPARADOS. Ausencia de linha = NOT_REQUESTED. FORCE RLS, so platform_admin; cliente le a projecao segura via manage-whatsapp-implementations.';

-- Uma implantação ABERTA por organização. COMPLETED continua bloqueando: uma
-- segunda implantação para a mesma empresa é reimplantação, fluxo explícito de
-- fase futura, e não pode nascer de um clique acidental no botão de contratar.
-- Histórico nunca é apagado — só CANCELED sai do índice.
create unique index if not exists whatsapp_impl_one_open_per_org_idx
  on whatsapp_implementations (organization_id)
  where operational_status <> 'CANCELED';

-- O aplicador do webhook correlaciona a confirmação por este id.
create index if not exists whatsapp_impl_checkout_idx
  on whatsapp_implementations (provider_checkout_id)
  where provider_checkout_id is not null;

create index if not exists whatsapp_impl_operational_idx
  on whatsapp_implementations (operational_status);

alter table whatsapp_implementations enable row level security;
alter table whatsapp_implementations force row level security;

drop policy if exists platform_admin_all_whatsapp_implementations on whatsapp_implementations;
create policy platform_admin_all_whatsapp_implementations
  on whatsapp_implementations
  for all
  to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

drop trigger if exists whatsapp_implementations_updated_at on whatsapp_implementations;
create trigger whatsapp_implementations_updated_at
  before update on whatsapp_implementations
  for each row execute function update_updated_at();

-- Mesma trilha genérica de customers/reservations/unit_members e de
-- organization_entitlement_overrides. audit_trigger_func extrai
-- organization_id do row automaticamente.
drop trigger if exists whatsapp_implementations_audit on whatsapp_implementations;
create trigger whatsapp_implementations_audit
  after insert or update or delete on whatsapp_implementations
  for each row execute function public.audit_trigger_func();

commit;

-- =====================================================================
-- Validação pós-migration (rodar após `supabase db push`)
-- =====================================================================
-- 1. RLS ligada e forçada (esperado: t, t):
--   select relrowsecurity, relforcerowsecurity
--     from pg_class where relname = 'whatsapp_implementations';
--
-- 2. As três constraints de invariante existem (esperado: 3 linhas):
--   select conname from pg_constraint
--    where conrelid = 'whatsapp_implementations'::regclass
--      and conname like 'whatsapp_impl_%_chk';
--
-- 3. A matriz recusa o par proibido (esperado: erro 23514 nas duas):
--   insert into whatsapp_implementations (organization_id, origin, payment_status, notes)
--   select id, 'COURTESY', 'CONFIRMED', 'teste-071' from organizations limit 1;
--   insert into whatsapp_implementations (organization_id, origin, payment_status, notes)
--   select id, 'EXTERNAL_PAYMENT', 'WAIVED', 'teste-071' from organizations limit 1;
--
-- 4. Id falso do Asaas é recusado (esperado: erro 23514):
--   insert into whatsapp_implementations
--     (organization_id, origin, payment_status, provider_checkout_id, notes)
--   select id, 'COURTESY', 'WAIVED', 'chk_falso', 'teste-071' from organizations limit 1;
--
-- 5. Conclusão sem pagamento é recusada (esperado: erro 23514):
--   insert into whatsapp_implementations
--     (organization_id, origin, payment_status, operational_status, notes)
--   select id, 'ASAAS', 'PENDING', 'COMPLETED', 'teste-071' from organizations limit 1;
--
-- 6. Uma aberta por org: repita um insert válido duas vezes (1ª passa, 2ª dá
--    23505). LIMPE ao final:
--   delete from whatsapp_implementations where notes = 'teste-071';
--
-- =====================================================================
-- Rollback
-- =====================================================================
--   drop table if exists whatsapp_implementations;
-- Seguro enquanto nenhuma linha real existir. Com linhas, prefira manter a
-- tabela e desligar a flag whatsapp_implementation_flow — apagar destrói
-- registro financeiro (pagamento externo confirmado mora aqui).
