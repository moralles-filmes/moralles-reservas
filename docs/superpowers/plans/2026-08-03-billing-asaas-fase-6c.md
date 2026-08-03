# Fase 6c — Painel de instâncias completo e runbook do fluxo manual

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar interface às três ações órfãs de `manage-whatsapp-instances` (`register_instance`, `update_instance`, `reactivate`), consertar a perda de histórico em `whatsapp_instances.notes` com um ledger próprio, e publicar o runbook do fluxo manual assistido.

**Architecture:** Uma migration aditiva cria `whatsapp_instance_notes` (ledger append-only, `FORCE RLS` + policy `platform_admin_all_*`, no padrão das irmãs 087/088/089). A Edge Function ganha um helper best-effort que grava uma linha **depois** de cada uma das sete mutações que pedem motivo, mais a action de leitura `list_instance_notes`. O frontend ganha três diálogos novos no painel `/platform/instancias-whatsapp`, com a lógica não-trivial (conversão de valor, diff de patch, rótulos) extraída para módulos puros testados por vitest. Nenhuma chamada à Z-API, nenhuma flag, nenhuma mudança nos núcleos de decisão do worker.

**Tech Stack:** PostgreSQL/Supabase (migration + RLS + trigger plpgsql), Deno (Edge Function), React 18 + TypeScript + TanStack Query v5 + Radix/shadcn + Tailwind, vitest.

**Spec:** [docs/superpowers/specs/2026-08-02-billing-asaas-fase-6c-design.md](../specs/2026-08-02-billing-asaas-fase-6c-design.md) (corrigida no commit `0d43303`)

---

## Global Constraints

Estas valem em **todas** as tarefas. Um implementer que violar qualquer uma delas produz trabalho rejeitado no review.

**Ambiente — o que NÃO pode acontecer nesta frente:**

- **Nenhum comando do Supabase CLI.** Não rodar `supabase db push`, `supabase functions deploy`, `supabase migration repair`, `supabase start`. Não há Docker nesta máquina e o repo está ligado à **produção**.
- **Nenhuma migration aplicada, nenhuma Edge Function deployada, nenhuma flag alterada, nenhum cron mexido, nenhum merge.** O trabalho termina em commits na branch `dois-planos/fase-6c`.
- **Não usar as ferramentas MCP do Supabase** (`apply_migration`, `execute_sql`, `deploy_edge_function`) — elas escrevem no projeto remoto de produção.
- **Não mexer no inventário do Ren Sushi.** A observação da 6b em produção vai até 05/08 e a rolagem do ciclo é o que está sendo medido; qualquer escrita nele contamina a leitura.

**Coordenação — três frentes em paralelo (6c, Plano B, Plano D):**

- **Faixa de migration reservada para a 6c: `096`.** Nenhum outro número.
- **NÃO editar `CLAUDE.md`.** Tudo que entraria no checklist de redeploy ou na lista de invariantes vai para `docs/billing-asaas/FASE-6C-PENDENCIAS.md`, seção **"CLAUDE.md a consolidar"**. A consolidação é um commit único no fim, fora deste trabalho.
- **Arquivos desta frente:** a migration `096`, `supabase/functions/manage-whatsapp-instances/index.ts`, `src/pages/platform/WhatsappInstances.tsx`, `src/components/layouts/PlatformLayout.tsx`, `src/hooks/useWhatsappInstances.ts`, componentes novos em `src/components/platform/`, núcleos puros novos em `supabase/functions/_shared/`, módulos e testes em `src/lib/`, e os documentos em `docs/billing-asaas/`.
- **PARE E AVISE** se o trabalho começar a exigir `entitlements-core.ts`, `ai-providers.ts`, `manage-whatsapp-implementations`, `manage-channels` ou os componentes de pricing (`PricingCard.tsx`, `PricingTable.tsx`). São de outra frente.

**Gates que todo commit precisa passar:**

- `npm run test` — baseline atual: **767 testes, 32 arquivos, todos passando**. Qualquer novo erro é regressão.
- `npm run typecheck` (= `tsc -b --noEmit`; **nunca** `tsc --noEmit` sem `-b`, que vira no-op silencioso) — baseline: **zero erros**.
- `npm run lint` — baseline: **0 erros, 22 warnings** pré-existentes. Warning novo em arquivo desta entrega é regressão.
- `npx eslint supabase/functions --max-warnings=0` — baseline: **zero**.

**Regras de código do repositório que esta fase toca diretamente:**

- `tsconfig.app.json` tem `strict: false`. **`if (!x.ok) { x.campo }` NÃO estreita união discriminada.** Use `x.ok === false` ou early-return. Pior em `supabase/functions/`, que o `tsc -b` nem alcança.
- **Edge Function nunca devolve `error.message` cru do Postgres.** Mensagem curta em PT-BR no corpo, detalhe em `jsonLog`/`console.error`.
- **`invalidateQueries` é prefix-match por ELEMENTO do array.** `["whatsapp-instance"]` **não** casa `["whatsapp-instance-notes", id]` — são elementos diferentes na posição 0.
- **Lista TanStack trata `isError` separado de `!data.length`** — quatro branches: `isLoading`, `isError` (com `refetch()`), `empty`, `list`. Silenciar erro como lista vazia já mascarou incidente em produção neste projeto.
- **Pares de inputs em form usam `grid grid-cols-1 sm:grid-cols-2`**, nunca `grid-cols-2` cru. Inputs `h-12 sm:h-10` (tap target ≥44px no mobile).
- **Nunca hardcode cor** — tokens Tailwind sempre.
- **Migration nova nunca embute segredo nem a URL do projeto Supabase.** `scripts/migration-static-guard.test.ts` reprova com allowlist fechada.
- **Toda função nova em `public` nasce executável por `anon`** pelo grant implícito do `CREATE FUNCTION`. Migration que criar função revoga explicitamente: `revoke all on function <assinatura completa> from public, anon, authenticated;`.

**O que esta fase NÃO faz (fronteiras da spec §3):**

- `NEW_PROVISION` — bloqueado por `NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A`. Botão que sempre devolve 409 é botão fantasma.
- `AWAITING_PROVISION` — a fila já vive em `whatsapp_implementations`.
- Qualquer chamada à Z-API.
- Flag nova, decisão comercial, mudança no worker ou nos núcleos puros de decisão.

**Verificação: o que NÃO pode ser declarado provado por teste unitário.**

Teste de banco, lock, RLS e concorrência **não existem nesta frente**. Nenhum passo abaixo pode escrever "RLS verificada" ou "o `on delete set null` funciona" com base em vitest. Essas afirmações vão para `docs/billing-asaas/FASE-6C-PENDENCIAS.md` como pendências, e os casos verificáveis vão para `supabase/tests/whatsapp-instances.integration.md`.

---

## File Structure

| Arquivo | Responsabilidade | Tarefa |
|---|---|---|
| `supabase/functions/_shared/whatsapp-instance-notes-core.ts` | **Criar.** Fonte canônica das sete ações do ledger. Núcleo puro, sem I/O. | 1 |
| `supabase/migrations/20260803120000_096_whatsapp_instance_notes.sql` | **Criar.** Tabela, guardas, RLS, índice, backfill idempotente. | 1 |
| `src/lib/whatsapp-instance-notes-core.test.ts` | **Criar.** Acoplamento constante ↔ CHECK da migration, nas duas direções. | 1 |
| `src/lib/whatsapp-instance-form-core.ts` | **Criar.** `parseCostReais` e `buildUpdatePatch` — a lógica que não pode morar no componente. | 2 |
| `src/lib/whatsapp-instance-form-core.test.ts` | **Criar.** | 2 |
| `src/lib/whatsapp-instance-format.ts` | **Modificar.** Rótulos PT-BR de `COST_SOURCES` e das ações do ledger. | 3 |
| `src/lib/whatsapp-instance-format.test.ts` | **Modificar.** Acoplamento rótulo ↔ constante, nas duas direções. | 3 |
| `supabase/functions/manage-whatsapp-instances/index.ts` | **Modificar.** `recordInstanceNote` + 7 chamadas + action `list_instance_notes`. | 4 |
| `src/hooks/useWhatsappInstances.ts` | **Modificar.** Tipo `WhatsappInstanceNote`, hook `useWhatsappInstanceNotes`, 4ª invalidação. | 5 |
| `src/components/layouts/PlatformLayout.tsx` | **Modificar.** Link no menu lateral. | 5 |
| `src/components/platform/RegisterInstanceDialog.tsx` | **Criar.** Tela A. | 6 |
| `src/components/platform/UpdateInstanceDialog.tsx` | **Criar.** Tela B. | 7 |
| `src/components/platform/InstanceNotesPanel.tsx` | **Criar.** Seção Histórico. | 8 |
| `src/pages/platform/WhatsappInstances.tsx` | **Modificar.** Pontos de entrada, nome da organização, botão Reativar, encadeamento. | 5, 6, 7, 8 |
| `docs/billing-asaas/10-RUNBOOK-INSTANCIAS-ZAPI.md` | **Criar.** R1/R2/R3. | 9 |
| `docs/billing-asaas/FASE-6C-PENDENCIAS.md` | **Criar.** Pendências + "CLAUDE.md a consolidar" + roteiro manual. | 10 |
| `supabase/tests/whatsapp-instances.integration.md` | **Modificar.** Casos NOTE-A..NOTE-E. | 10 |

Os diálogos saem para `src/components/platform/` porque `WhatsappInstances.tsx` já tem 647 linhas e as três telas somam mais de 400. Diretório novo; nenhuma outra frente escreve nele.

---

## Task 1: Ledger de observações — núcleo canônico e migration 096

**Files:**
- Create: `supabase/functions/_shared/whatsapp-instance-notes-core.ts`
- Create: `supabase/migrations/20260803120000_096_whatsapp_instance_notes.sql`
- Create: `src/lib/whatsapp-instance-notes-core.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `INSTANCE_NOTE_ACTIONS: readonly ["REGISTER","UPDATE","REACTIVATE","SET_COST","CONFIRM_CYCLE_DATE","REQUEST_CANCELLATION","CONFIRM_END"]`
  - `type InstanceNoteAction = typeof INSTANCE_NOTE_ACTIONS[number]`
  - `isInstanceNoteAction(v: unknown): v is InstanceNoteAction`
  - Tabela `whatsapp_instance_notes` com colunas `id, instance_ref, instance_id, organization_id, action, note, created_by, created_at`.

- [ ] **Step 1: Criar o núcleo canônico das sete ações**

Create `supabase/functions/_shared/whatsapp-instance-notes-core.ts`:

```ts
// Vocabulário do ledger de observações da instância (Fase 6c).
//
// FONTE CANÔNICA ÚNICA. Três lugares dependem desta lista e nenhum pode
// redigitá-la: o CHECK da migration 096, o helper `recordInstanceNote` em
// `manage-whatsapp-instances` e os rótulos PT-BR do painel. É a mesma
// disciplina de `EVENT_TYPE_BY_ALERT` (Fase 6b) — lista redigitada é lista que
// diverge, e a divergência aparece só no dia em que alguém usa o valor novo.
//
// AS SETE SÃO AS AÇÕES QUE MUDAM A INSTÂNCIA E PEDEM MOTIVO. Cobrir as sete é
// o que torna a propriedade difícil de perder: ação nova que peça motivo já tem
// onde registrar.
//
// `acknowledge_alert` e `resolve_alert` ficam de FORA de propósito — elas
// também pedem motivo, mas escrevem no ledger de ALERTAS, que já guarda uma
// linha por alerta. Duplicar aqui misturaria dois assuntos na mesma linha do
// tempo.

export const INSTANCE_NOTE_ACTIONS = [
  "REGISTER",
  "UPDATE",
  "REACTIVATE",
  "SET_COST",
  "CONFIRM_CYCLE_DATE",
  "REQUEST_CANCELLATION",
  "CONFIRM_END",
] as const;

export type InstanceNoteAction = (typeof INSTANCE_NOTE_ACTIONS)[number];

export function isInstanceNoteAction(v: unknown): v is InstanceNoteAction {
  return typeof v === "string"
    && (INSTANCE_NOTE_ACTIONS as readonly string[]).indexOf(v) !== -1;
}
```

- [ ] **Step 2: Escrever o teste de acoplamento (falha por ausência da migration)**

Create `src/lib/whatsapp-instance-notes-core.test.ts`:

```ts
/**
 * Acoplamento constante ↔ CHECK da migration, nas DUAS direções.
 *
 * O CHECK de `whatsapp_instance_notes.action` e `INSTANCE_NOTE_ACTIONS` são a
 * mesma lista escrita em duas linguagens. Divergir uma delas produz um erro que
 * só aparece em runtime, contra o banco, no dia em que a ação nova for usada —
 * e best-effort como o helper é, ele engoliria o erro e o histórico sumiria em
 * silêncio. Mesmo padrão do teste bidirecional dos `event_type` da Fase 6b.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INSTANCE_NOTE_ACTIONS,
  isInstanceNoteAction,
} from "../../supabase/functions/_shared/whatsapp-instance-notes-core";

const MIGRATION = join(
  __dirname,
  "..",
  "..",
  "supabase",
  "migrations",
  "20260803120000_096_whatsapp_instance_notes.sql",
);

/** Os valores literais dentro de `check (action in ( ... ))`. */
function actionsInMigrationCheck(): string[] {
  const sql = readFileSync(MIGRATION, "utf8");
  const m = sql.match(/action\s+text\s+not\s+null\s+check\s*\(\s*action\s+in\s*\(([^)]*)\)/i);
  if (!m) throw new Error("CHECK de `action` não encontrado na migration 096");
  return Array.from(m[1].matchAll(/'([A-Z_]+)'/g)).map((x) => x[1]);
}

describe("INSTANCE_NOTE_ACTIONS", () => {
  it("tem exatamente as sete ações que mudam a instância e pedem motivo", () => {
    expect([...INSTANCE_NOTE_ACTIONS]).toEqual([
      "REGISTER",
      "UPDATE",
      "REACTIVATE",
      "SET_COST",
      "CONFIRM_CYCLE_DATE",
      "REQUEST_CANCELLATION",
      "CONFIRM_END",
    ]);
  });

  it("não inclui as ações de alerta, que têm ledger próprio", () => {
    expect(isInstanceNoteAction("ACKNOWLEDGE_ALERT")).toBe(false);
    expect(isInstanceNoteAction("RESOLVE_ALERT")).toBe(false);
  });

  it("recusa valor que não é string", () => {
    expect(isInstanceNoteAction(null)).toBe(false);
    expect(isInstanceNoteAction(7)).toBe(false);
    expect(isInstanceNoteAction(undefined)).toBe(false);
  });

  it("toda constante do núcleo está no CHECK da migration", () => {
    const inCheck = new Set(actionsInMigrationCheck());
    for (const a of INSTANCE_NOTE_ACTIONS) expect(inCheck.has(a)).toBe(true);
  });

  it("o CHECK da migration não tem valor fora do núcleo", () => {
    for (const a of actionsInMigrationCheck()) expect(isInstanceNoteAction(a)).toBe(true);
  });
});
```

- [ ] **Step 3: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/whatsapp-instance-notes-core.test.ts`
Expected: os três primeiros casos PASSAM; os dois de acoplamento FALHAM com `ENOENT ... 20260803120000_096_whatsapp_instance_notes.sql`.

- [ ] **Step 4: Escrever a migration 096**

Create `supabase/migrations/20260803120000_096_whatsapp_instance_notes.sql`:

```sql
-- Ledger de observações da instância (Fase 6c).
--
-- O DEFEITO QUE ESTA TABELA CONSERTA: a 087 declara que `notes`, `cost_note`,
-- `cancellation_reason` e `end_confirmation_note` "registram DECISÃO HUMANA
-- sobre o que a plataforma paga ao fornecedor, e não têm segunda cópia — o
-- painel da Z-API não reconstrói nenhum deles". E `manage-whatsapp-instances`
-- escreve `notes = reason` em register/update/reactivate, SOBRESCREVENDO. Cada
-- ação apagava a justificativa da anterior. A tabela prometia auditoria e
-- entregava último-valor.
--
-- POR QUE NÃO O TRIGGER GENÉRICO `audit_trigger_func()`: seriam quatro linhas
-- e zero mudança na EF, mas ele preenche `organization_id` e `audit_log` tem a
-- policy `unit_member_read_audit`, que libera leitura para MEMBRO da
-- organização. Auditar `whatsapp_instances` ali entregaria
-- `current_monthly_cost_cents` — o que a plataforma paga ao fornecedor — para
-- os membros do próprio cliente. É exatamente o que o FORCE RLS da tabela
-- existe para impedir.
--
-- `notes` CONTINUA sendo escrita: ela vira o resumo ("última observação") e
-- esta tabela vira o histórico. Ambas saem do mesmo `reason`, na mesma
-- operação.
--
-- ADITIVA E INERTE AO WORKER: cria tabela nova e lê `notes` no backfill, sem
-- tocar nenhuma coluna de `whatsapp_instances`.

begin;

create table if not exists whatsapp_instance_notes (
  id uuid primary key default gen_random_uuid(),

  -- IDENTIDADE HISTÓRICA IMUTÁVEL, no padrão de
  -- `whatsapp_instance_alerts.subject_id`: a observação sobrevive à remoção da
  -- instância, e é `instance_ref` que continua dizendo de quem ela era.
  instance_ref uuid not null,

  -- SEM CHECK exigindo `instance_id is not null`. Foi assim que a 089 tornou o
  -- `on delete set null` INEXECUTÁVEL: apagar a instância fazia a FK gravar
  -- NULL, o CHECK avaliar FALSE e o DELETE inteiro abortar com
  -- check_violation — o oposto exato do contrato desta tabela. O rigor de
  -- INSERT vive na trigger abaixo, que distingue INSERT de coerção da FK;
  -- distinção que um CHECK, por construção, não sabe fazer.
  instance_id uuid references whatsapp_instances(id) on delete set null,

  -- `restrict`, igual às três irmãs desta fase: registro de auditoria e a
  -- deleção de uma organização não pode apagá-lo em silêncio. A consequência
  -- para quem vier depois está escrita por extenso na 089.
  organization_id uuid not null references organizations(id) on delete restrict,

  -- SETE valores, um para cada constante de INSTANCE_NOTE_ACTIONS em
  -- _shared/whatsapp-instance-notes-core.ts (fonte canônica). O acoplamento é
  -- verificado nas duas direções por
  -- src/lib/whatsapp-instance-notes-core.test.ts.
  action text not null check (action in (
    'REGISTER', 'UPDATE', 'REACTIVATE', 'SET_COST',
    'CONFIRM_CYCLE_DATE', 'REQUEST_CANCELLATION', 'CONFIRM_END'
  )),

  -- O motivo que o operador digitou. A EF já exige 5 caracteres úteis
  -- (MIN_REASON_LENGTH); o banco recusa só o vazio, porque observação em branco
  -- não é observação.
  note text not null check (btrim(note) <> ''),

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

comment on table whatsapp_instance_notes is
  'Ledger APPEND-ONLY de observacoes da instancia (Fase 6c). Conserta a sobrescrita de whatsapp_instances.notes. NAO usa audit_log: la a policy unit_member_read_audit entregaria o custo do fornecedor ao proprio cliente. Sem credencial. FORCE RLS, so platform_admin.';

comment on column whatsapp_instance_notes.instance_ref is
  'Identidade historica IMUTAVEL. Sobrevive a remocao da instancia, quando instance_id vira NULL pela FK.';

comment on column whatsapp_instance_notes.note is
  'Resumo da mesma operacao fica em whatsapp_instances.notes; o historico e aqui. Ambos saem do mesmo reason.';

-- Leitura do painel: histórico de UMA instância, do mais recente ao mais
-- antigo. Chaveado por `instance_ref` e não por `instance_id`, senão o
-- histórico da instância apagada ficaria inalcançável.
create index if not exists whatsapp_instance_notes_ref_idx
  on whatsapp_instance_notes (instance_ref, created_at desc);

-- =====================================================================
-- Append-only e identidade — o rigor que o CHECK não consegue expressar
-- =====================================================================
-- Um CHECK avalia a linha isoladamente e não sabe se ela está NASCENDO ou
-- sendo coagida pela FK. A regra é diferente nas duas operações:
--   INSERT — a instância PRECISA existir e `instance_ref` tem que ser ela.
--   UPDATE — a instância pode desaparecer (a FK nula `instance_id`), mas nada
--            mais pode mudar. Ledger reescrito não é ledger.
create or replace function public.whatsapp_instance_note_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.instance_id is null or new.instance_ref <> new.instance_id then
      raise exception 'observacao nasce apontando instancia viva, com instance_ref igual a ela'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- APPEND-ONLY. A ÚNICA mudança tolerada é `instance_id` indo a NULL, que é
  -- ação da FK, não escrita de ninguém.
  if new.instance_ref is distinct from old.instance_ref
     or new.organization_id is distinct from old.organization_id
     or new.action is distinct from old.action
     or new.note is distinct from old.note
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'observacao e registro append-only e nao pode ser reescrita'
      using errcode = 'check_violation';
  end if;

  if old.instance_id is not null and new.instance_id is not null
     and new.instance_id <> old.instance_id then
    raise exception 'instance_id nao pode ser reapontado para outra instancia'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- CREATE FUNCTION concede EXECUTE a PUBLIC por padrão e o schema `public` é
-- exposto ao PostgREST com a anon key.
revoke all on function public.whatsapp_instance_note_guard()
  from public, anon, authenticated;

drop trigger if exists whatsapp_instance_notes_guard on whatsapp_instance_notes;
create trigger whatsapp_instance_notes_guard
  before insert or update on whatsapp_instance_notes
  for each row execute function public.whatsapp_instance_note_guard();

-- Guarda de tenant: REUSA a função da 088, como a 089 faz. Ela retorna cedo
-- quando `instance_id` é nulo, que é exatamente o estado da linha depois de a
-- instância ser apagada.
drop trigger if exists whatsapp_instance_notes_tenant_guard on whatsapp_instance_notes;
create trigger whatsapp_instance_notes_tenant_guard
  before insert or update of organization_id, instance_id on whatsapp_instance_notes
  for each row execute function public.whatsapp_instance_child_tenant_guard();

-- =====================================================================
-- RLS — padrão das três irmãs desta fase (087, 088, 089)
-- =====================================================================
-- FORCE RLS **mais** a policy de platform_admin. "FORCE RLS sem policies" é o
-- padrão das tabelas de CREDENCIAL (whatsapp_channels, platform_secrets), onde
-- nem o super-admin lê pelo PostgREST — esta tabela não guarda credencial e é
-- irmã dos dois ledgers da fase. `is_platform_admin` já exclui todo membro de
-- organização, que é a leitura que o audit_log não conseguia impedir.
alter table whatsapp_instance_notes enable row level security;
alter table whatsapp_instance_notes force row level security;

drop policy if exists platform_admin_all_whatsapp_instance_notes on whatsapp_instance_notes;
create policy platform_admin_all_whatsapp_instance_notes
  on whatsapp_instance_notes for all
  to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

-- =====================================================================
-- Backfill idempotente
-- =====================================================================
-- Cada `notes` não-nulo vira a PRIMEIRA entrada do histórico, com a autoria e a
-- data da criação da instância — que é o que `notes` de fato representava
-- naquele momento. `not exists` guarda a reexecução: a migration é idempotente
-- por design e nada aqui pode duplicar histórico numa segunda passada.
--
-- `action = 'REGISTER'` para todas: não há como saber, do valor sobrescrito,
-- qual ação o gravou por último. Afirmar outra coisa seria inventar histórico —
-- e inventar é pior que o buraco que estamos tapando.
insert into whatsapp_instance_notes
  (instance_ref, instance_id, organization_id, action, note, created_by, created_at)
select i.id, i.id, i.organization_id, 'REGISTER', i.notes, i.created_by, i.created_at
from whatsapp_instances i
where i.notes is not null
  and btrim(i.notes) <> ''
  and not exists (
    select 1 from whatsapp_instance_notes n where n.instance_ref = i.id
  );

commit;

-- =====================================================================
-- Validação pós-migration (rodar no Studio DEPOIS do db push autorizado)
-- =====================================================================
-- 1. RLS ligada e forçada (esperado: t, t):
--   select relrowsecurity, relforcerowsecurity from pg_class
--    where relname = 'whatsapp_instance_notes';
--
-- 2. A policy existe (esperado: 1 linha):
--   select policyname from pg_policies
--    where tablename = 'whatsapp_instance_notes';
--
-- 3. As DUAS guardas instaladas (esperado: 2 linhas):
--   select tgname from pg_trigger where tgrelid = 'whatsapp_instance_notes'::regclass
--    and tgname in ('whatsapp_instance_notes_guard',
--                   'whatsapp_instance_notes_tenant_guard');
--
-- 4. Nenhuma coluna de segredo (esperado: 0 linhas):
--   select column_name from information_schema.columns
--    where table_name = 'whatsapp_instance_notes'
--      and column_name ~* 'email|token|secret|credential';
--
-- 5. Backfill cobriu todo `notes` existente (esperado: 0 linhas):
--   select i.id from whatsapp_instances i
--    where i.notes is not null and btrim(i.notes) <> ''
--      and not exists (select 1 from whatsapp_instance_notes n
--                       where n.instance_ref = i.id);
--
-- 6. Reexecutar a migration inteira NÃO duplica (esperado: 0 linhas):
--   select instance_ref, count(*) from whatsapp_instance_notes
--    where action = 'REGISTER' group by 1 having count(*) > 1;
--
-- 7. COMPORTAMENTO, não estrutura — só verificável com banco. Roteiro
--    completo em supabase/tests/whatsapp-instances.integration.md, casos
--    NOTE-A..NOTE-E (inclui o controle positivo: apagar a instância NÃO apaga
--    a observação).
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- `drop table whatsapp_instance_notes` DESTRÓI AUDITORIA OPERACIONAL DE FORMA
-- IRREVERSÍVEL — inclusive o `notes` original, que o backfill copiou para cá e
-- que continua na 087 (esta tabela não apaga nada de lá). Leia a advertência da
-- 088 antes. Ordem inversa:
--   drop trigger if exists whatsapp_instance_notes_tenant_guard on whatsapp_instance_notes;
--   drop trigger if exists whatsapp_instance_notes_guard on whatsapp_instance_notes;
--   drop function if exists public.whatsapp_instance_note_guard();
--   drop table if exists whatsapp_instance_notes;
```

- [ ] **Step 5: Rodar os testes e confirmar que passam**

Run: `npx vitest run src/lib/whatsapp-instance-notes-core.test.ts scripts/migration-static-guard.test.ts`
Expected: PASS nos dois arquivos. O `migration-static-guard` prova que a 096 não embute segredo nem a URL do projeto.

- [ ] **Step 6: Rodar a suíte inteira e o typecheck**

Run: `npm run test && npm run typecheck`
Expected: 767+ testes passando (os 5 novos somam), zero erro de tipo.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/whatsapp-instance-notes-core.ts \
        supabase/migrations/20260803120000_096_whatsapp_instance_notes.sql \
        src/lib/whatsapp-instance-notes-core.test.ts
git commit -m "feat(6c): ledger append-only de observacoes da instancia (migration 096)"
```

---

## Task 2: Módulo puro do formulário — conversão de valor e diff de patch

**Files:**
- Create: `src/lib/whatsapp-instance-form-core.ts`
- Create: `src/lib/whatsapp-instance-form-core.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `parseCostReais(raw: string): CostReaisParse` onde `CostReaisParse = { ok: true; unknownCost: true } | { ok: true; unknownCost: false; cents: number } | { ok: false; message: string }`
  - `type InstanceLinkFields = { unit_id: string | null; channel_id: string | null; provider_instance_ref: string | null; planned_provision_on: string | null }`
  - `buildUpdatePatch(original: InstanceLinkFields, form: InstanceLinkFields): Partial<InstanceLinkFields>`

- [ ] **Step 1: Escrever os testes que falham**

Create `src/lib/whatsapp-instance-form-core.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildUpdatePatch,
  parseCostReais,
  type InstanceLinkFields,
} from "./whatsapp-instance-form-core";

describe("parseCostReais", () => {
  it("vazio é custo DESCONHECIDO, nunca zero", () => {
    expect(parseCostReais("")).toEqual({ ok: true, unknownCost: true });
    expect(parseCostReais("   ")).toEqual({ ok: true, unknownCost: true });
  });

  it("zero explícito é um fato, e passa", () => {
    expect(parseCostReais("0")).toEqual({ ok: true, unknownCost: false, cents: 0 });
    expect(parseCostReais("0,00")).toEqual({ ok: true, unknownCost: false, cents: 0 });
  });

  it("converte com vírgula decimal", () => {
    expect(parseCostReais("99,90")).toEqual({ ok: true, unknownCost: false, cents: 9990 });
    expect(parseCostReais("99,9")).toEqual({ ok: true, unknownCost: false, cents: 9990 });
  });

  it("converte com ponto decimal quando não há vírgula", () => {
    expect(parseCostReais("99.90")).toEqual({ ok: true, unknownCost: false, cents: 9990 });
  });

  it("converte inteiro sem separador", () => {
    expect(parseCostReais("100")).toEqual({ ok: true, unknownCost: false, cents: 10000 });
  });

  it("aceita ponto de milhar quando a vírgula é o decimal", () => {
    expect(parseCostReais("1.234,56")).toEqual({ ok: true, unknownCost: false, cents: 123456 });
    expect(parseCostReais("1.234")).toEqual({ ok: false, message: expect.any(String) });
  });

  it("não perde centavo por ponto flutuante", () => {
    // 99.9 * 100 === 9990.000000000001 em JS. A conversão é por string.
    expect(parseCostReais("99,90")).toEqual({ ok: true, unknownCost: false, cents: 9990 });
    expect(parseCostReais("0,07")).toEqual({ ok: true, unknownCost: false, cents: 7 });
    expect(parseCostReais("8,29")).toEqual({ ok: true, unknownCost: false, cents: 829 });
  });

  it("recusa negativo", () => {
    expect(parseCostReais("-1")).toEqual({ ok: false, message: expect.any(String) });
    expect(parseCostReais("-99,90")).toEqual({ ok: false, message: expect.any(String) });
  });

  it("recusa não-numérico", () => {
    expect(parseCostReais("abc")).toEqual({ ok: false, message: expect.any(String) });
    expect(parseCostReais("R$ 99,90")).toEqual({ ok: false, message: expect.any(String) });
    expect(parseCostReais("99,")).toEqual({ ok: false, message: expect.any(String) });
    expect(parseCostReais("1e3")).toEqual({ ok: false, message: expect.any(String) });
  });

  it("recusa mais de duas casas decimais em vez de arredondar", () => {
    // Arredondar em silêncio escreveria no banco um número que ninguém digitou,
    // num campo cujo propósito é dizer quanto a plataforma paga de verdade.
    expect(parseCostReais("99,999")).toEqual({ ok: false, message: expect.any(String) });
  });

  it("a mensagem de recusa é PT-BR e mostra o formato esperado", () => {
    const r = parseCostReais("abc");
    if (r.ok !== false) throw new Error("esperava recusa");
    expect(r.message).toContain("99,90");
  });
});

const ORIGINAL: InstanceLinkFields = {
  unit_id: "11111111-1111-4111-8111-111111111111",
  channel_id: "22222222-2222-4222-8222-222222222222",
  provider_instance_ref: "3D1A2B",
  planned_provision_on: null,
};

describe("buildUpdatePatch", () => {
  it("campo intocado NÃO entra no patch", () => {
    expect(buildUpdatePatch(ORIGINAL, { ...ORIGINAL })).toEqual({});
  });

  it("só o campo alterado entra — o canal NÃO é apagado", () => {
    // O defeito que esta função existe para impedir: a EF decide o que gravar
    // por `"campo" in body`. Mandar o objeto inteiro apagaria o canal de quem
    // só quis corrigir o identificador.
    const patch = buildUpdatePatch(ORIGINAL, { ...ORIGINAL, provider_instance_ref: "9Z8Y7X" });
    expect(patch).toEqual({ provider_instance_ref: "9Z8Y7X" });
    expect("channel_id" in patch).toBe(false);
    expect("unit_id" in patch).toBe(false);
  });

  it("campo esvaziado entra como null — desvincular é uma intenção", () => {
    const patch = buildUpdatePatch(ORIGINAL, { ...ORIGINAL, channel_id: "" });
    expect(patch).toEqual({ channel_id: null });
    expect("channel_id" in patch).toBe(true);
  });

  it('trata "" e null como o MESMO valor ausente', () => {
    const patch = buildUpdatePatch(
      { ...ORIGINAL, planned_provision_on: null },
      { ...ORIGINAL, planned_provision_on: "" },
    );
    expect(patch).toEqual({});
  });

  it("ignora espaço em volta ao comparar e grava o valor aparado", () => {
    expect(buildUpdatePatch(ORIGINAL, { ...ORIGINAL, provider_instance_ref: " 3D1A2B " })).toEqual({});
    expect(
      buildUpdatePatch(ORIGINAL, { ...ORIGINAL, provider_instance_ref: " 9Z8Y7X " }),
    ).toEqual({ provider_instance_ref: "9Z8Y7X" });
  });

  it("acumula múltiplas mudanças", () => {
    const patch = buildUpdatePatch(ORIGINAL, {
      ...ORIGINAL,
      channel_id: null,
      planned_provision_on: "2026-09-01",
    });
    expect(patch).toEqual({ channel_id: null, planned_provision_on: "2026-09-01" });
  });

  it("patch vazio é objeto sem chaves — o caller não dispara requisição", () => {
    expect(Object.keys(buildUpdatePatch(ORIGINAL, { ...ORIGINAL })).length).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/whatsapp-instance-form-core.test.ts`
Expected: FAIL — `Failed to resolve import "./whatsapp-instance-form-core"`.

- [ ] **Step 3: Implementar o módulo**

Create `src/lib/whatsapp-instance-form-core.ts`:

```ts
/**
 * Lógica do formulário de instância que NÃO pode morar no componente (Fase 6c).
 *
 * Duas regras, cada uma com um defeito conhecido atrás:
 *
 * 1. `parseCostReais` — o usuário digita reais, a EF exige inteiro em centavos.
 *    A conversão inline que existia no painel (`.replace(/\./g,"").replace(",",".")`)
 *    lia "99.90" como 9990 reais. E `99.9 * 100` é `9990.000000000001` em JS,
 *    então a conversão é por STRING, não por float.
 *
 * 2. `buildUpdatePatch` — a EF decide o que gravar por `"campo" in body`. Mandar
 *    uma chave significa *escreva isto, inclusive `null`*. Um formulário ingênuo
 *    que enviasse o objeto inteiro APAGARIA o canal de quem só quis corrigir o
 *    identificador.
 */

export type CostReaisParse =
  | { ok: true; unknownCost: true }
  | { ok: true; unknownCost: false; cents: number }
  | { ok: false; message: string };

const COST_INVALID_MESSAGE =
  "Valor inválido. Informe apenas números, no formato 99,90 — ou deixe vazio se o custo for desconhecido.";

/** `9,90` ou `9.90` ou `990`: um separador decimal opcional, 1 ou 2 casas. */
const SIMPLE = /^(\d+)(?:[.,](\d{1,2}))?$/;
/** `1.234,56`: ponto de milhar SÓ quando a vírgula é o decimal. */
const BR_THOUSANDS = /^(\d{1,3}(?:\.\d{3})+),(\d{1,2})$/;

/**
 * Reais digitados → centavos inteiros.
 *
 * Vazio é DESCONHECIDO e é estado legítimo desta fase: o administrador registra
 * a instância antes de ter a fatura, e o ciclo fica em `PENDING_REVIEW` até o
 * número existir. Zero é diferente de desconhecido e passa — instância cortesia
 * tem custo zero VERDADEIRO.
 *
 * Ambiguidade é RECUSADA, não adivinhada: "1.234" pode ser mil duzentos e
 * trinta e quatro ou um e vinte e três, e chutar erraria por mil vezes num
 * campo que diz quanto a plataforma paga.
 */
export function parseCostReais(raw: string): CostReaisParse {
  const value = (raw ?? "").trim();
  if (value.length === 0) return { ok: true, unknownCost: true };

  const br = BR_THOUSANDS.exec(value);
  if (br) return { ok: true, unknownCost: false, cents: toCents(br[1].replace(/\./g, ""), br[2]) };

  const simple = SIMPLE.exec(value);
  if (simple) return { ok: true, unknownCost: false, cents: toCents(simple[1], simple[2]) };

  return { ok: false, message: COST_INVALID_MESSAGE };
}

/** Inteiro e fração como STRING — nenhum float participa da conta. */
function toCents(intPart: string, fracPart: string | undefined): number {
  const frac = (fracPart ?? "").padEnd(2, "0");
  return Number(intPart) * 100 + Number(frac);
}

export type InstanceLinkFields = {
  unit_id: string | null;
  channel_id: string | null;
  provider_instance_ref: string | null;
  planned_provision_on: string | null;
};

const LINK_FIELDS: (keyof InstanceLinkFields)[] = [
  "unit_id",
  "channel_id",
  "provider_instance_ref",
  "planned_provision_on",
];

/** `""`, `null` e `undefined` são o MESMO valor ausente. */
function norm(v: string | null | undefined): string | null {
  const t = typeof v === "string" ? v.trim() : "";
  return t.length === 0 ? null : t;
}

/**
 * Só o que MUDOU. Campo intocado não aparece; campo esvaziado aparece como
 * `null` (desvincular é uma intenção, e a EF precisa da chave para executá-la);
 * patch vazio significa que o caller NÃO deve disparar requisição.
 */
export function buildUpdatePatch(
  original: InstanceLinkFields,
  form: InstanceLinkFields,
): Partial<InstanceLinkFields> {
  const patch: Partial<InstanceLinkFields> = {};
  for (const field of LINK_FIELDS) {
    const before = norm(original[field]);
    const after = norm(form[field]);
    if (before !== after) patch[field] = after;
  }
  return patch;
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/lib/whatsapp-instance-form-core.test.ts`
Expected: PASS, 19 casos.

- [ ] **Step 5: Rodar suíte, typecheck e lint**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: tudo verde; nenhum warning novo.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp-instance-form-core.ts src/lib/whatsapp-instance-form-core.test.ts
git commit -m "feat(6c): nucleo puro do formulario — centavos por string e patch so do que mudou"
```

---

## Task 3: Rótulos PT-BR acoplados às constantes canônicas

**Files:**
- Modify: `src/lib/whatsapp-instance-format.ts`
- Modify: `src/lib/whatsapp-instance-format.test.ts`

**Interfaces:**
- Consumes: `COST_SOURCES` de `supabase/functions/_shared/whatsapp-instance-core.ts`; `INSTANCE_NOTE_ACTIONS` de `supabase/functions/_shared/whatsapp-instance-notes-core.ts` (Task 1).
- Produces:
  - `COST_SOURCE_OPTIONS: readonly { value: string; label: string }[]`
  - `costSourceLabel(source: string | null): string`
  - `instanceNoteActionLabel(action: string): string`

- [ ] **Step 1: Escrever os testes de acoplamento (falham)**

Append to `src/lib/whatsapp-instance-format.test.ts`:

```ts
import { COST_SOURCES } from "../../supabase/functions/_shared/whatsapp-instance-core";
import { INSTANCE_NOTE_ACTIONS } from "../../supabase/functions/_shared/whatsapp-instance-notes-core";
import {
  COST_SOURCE_OPTIONS,
  costSourceLabel,
  instanceNoteActionLabel,
} from "./whatsapp-instance-format";

/**
 * Acoplamento nas DUAS direções, como o teste dos `event_type` da 6b.
 *
 * Só "toda constante tem rótulo" deixaria passar rótulo órfão — o resto de uma
 * constante removida, que continua oferecendo no `<select>` um valor que a EF
 * recusa com 400. As duas perguntas são independentes e as duas importam.
 */
describe("rótulos de COST_SOURCES", () => {
  it("toda constante do núcleo tem rótulo em português", () => {
    for (const source of COST_SOURCES) {
      const label = costSourceLabel(source);
      expect(label).not.toBe(source);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("nenhum rótulo sobra sem constante correspondente", () => {
    const canonical = new Set<string>(COST_SOURCES as readonly string[]);
    for (const opt of COST_SOURCE_OPTIONS) expect(canonical.has(opt.value)).toBe(true);
  });

  it("as opções do select cobrem exatamente o núcleo, sem faltar nem sobrar", () => {
    expect(COST_SOURCE_OPTIONS.map((o) => o.value).sort()).toEqual(
      [...COST_SOURCES].sort(),
    );
  });

  it("valor desconhecido volta como ele mesmo, sem quebrar a tela", () => {
    expect(costSourceLabel("QUALQUER_COISA")).toBe("QUALQUER_COISA");
  });

  it("custo sem procedência não inventa rótulo", () => {
    expect(costSourceLabel(null)).toBe("—");
  });
});

describe("rótulos das ações do ledger de observações", () => {
  it("toda ação canônica tem rótulo em português", () => {
    for (const action of INSTANCE_NOTE_ACTIONS) {
      const label = instanceNoteActionLabel(action);
      expect(label).not.toBe(action);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("ação desconhecida volta como ela mesma", () => {
    expect(instanceNoteActionLabel("ACKNOWLEDGE_ALERT")).toBe("ACKNOWLEDGE_ALERT");
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/whatsapp-instance-format.test.ts`
Expected: FAIL — `COST_SOURCE_OPTIONS is not exported`.

- [ ] **Step 3: Implementar os rótulos**

Append to `src/lib/whatsapp-instance-format.ts`:

```ts
import { COST_SOURCES } from "../../supabase/functions/_shared/whatsapp-instance-core";
import { INSTANCE_NOTE_ACTIONS } from "../../supabase/functions/_shared/whatsapp-instance-notes-core";

/**
 * Procedência do custo, em português.
 *
 * `COST_SOURCES` é a fonte canônica (a whitelist é a ÚNICA barreira: `cost_source`
 * é `text` sem CHECK no banco). O mapa abaixo é derivado dela — nunca redigitado —
 * e o teste reprova nas duas direções.
 */
const COST_SOURCE_LABEL: Record<(typeof COST_SOURCES)[number], string> = {
  ADMIN_INFORMED: "informado pelo administrador",
  PROVIDER_INVOICE: "fatura do fornecedor",
  PROVIDER_PANEL: "painel do fornecedor",
  ESTIMATED: "estimado",
};

export const COST_SOURCE_OPTIONS: readonly { value: string; label: string }[] =
  COST_SOURCES.map((value) => ({ value, label: COST_SOURCE_LABEL[value] }));

/** Ausente é travessão, nunca um rótulo inventado — custo sem procedência é um fato. */
export function costSourceLabel(source: string | null): string {
  if (!source) return "—";
  return COST_SOURCE_LABEL[source as (typeof COST_SOURCES)[number]] ?? source;
}

/** Ações do ledger de observações, em português. */
const NOTE_ACTION_LABEL: Record<(typeof INSTANCE_NOTE_ACTIONS)[number], string> = {
  REGISTER: "registro da instância",
  UPDATE: "correção de vínculo",
  REACTIVATE: "reativação",
  SET_COST: "custo informado",
  CONFIRM_CYCLE_DATE: "data do ciclo confirmada",
  REQUEST_CANCELLATION: "cancelamento solicitado",
  CONFIRM_END: "encerramento confirmado",
};

export function instanceNoteActionLabel(action: string): string {
  return NOTE_ACTION_LABEL[action as (typeof INSTANCE_NOTE_ACTIONS)[number]] ?? action;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/whatsapp-instance-format.test.ts`
Expected: PASS.

- [ ] **Step 5: Suíte + typecheck + lint**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: verde.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp-instance-format.ts src/lib/whatsapp-instance-format.test.ts
git commit -m "feat(6c): rotulos PT-BR de cost_source e das acoes do ledger, acoplados ao nucleo"
```

---

## Task 4: Edge Function — grava o ledger e expõe a leitura

**Files:**
- Modify: `supabase/functions/manage-whatsapp-instances/index.ts`

**Interfaces:**
- Consumes: `INSTANCE_NOTE_ACTIONS`, `type InstanceNoteAction` de `../_shared/whatsapp-instance-notes-core.ts` (Task 1).
- Produces: action `list_instance_notes` → `{ notes: Array<{ id, instance_ref, instance_id, organization_id, action, note, created_by, created_by_email, created_at }> }`.

**Regras que definem esta tarefa:**

- A escrita do ledger é **DEPOIS** da mutação, nunca antes. Observação sobre operação que não aconteceu é pior que observação ausente.
- É **best-effort**: falha do ledger **não** derruba a operação já concluída, mas emite `jsonLog` com `needsAdminAction: true`. Falhar a requisição depois de o efeito ter ocorrido faria o operador repetir uma ação já feita.
- `notes` **continua** sendo escrita como está. Ela vira o resumo; o ledger vira o histórico.

- [ ] **Step 1: Importar o núcleo e escrever o helper**

Em `supabase/functions/manage-whatsapp-instances/index.ts`, adicionar ao bloco de imports (depois do import de `whatsapp-subscription-resolver-core.ts`, linha ~44):

```ts
import type { InstanceNoteAction } from "../_shared/whatsapp-instance-notes-core.ts";
```

Adicionar após a constante `MIN_REASON_LENGTH` (linha ~78):

```ts
// Projeção explícita, como as três listas acima.
const NOTE_COLUMNS = [
  "id", "instance_ref", "instance_id", "organization_id",
  "action", "note", "created_by", "created_at",
].join(", ");

/** Teto de autores distintos resolvidos por listagem — ver `list_instance_notes`. */
const NOTE_AUTHOR_LOOKUP_CAP = 12;
```

Adicionar após a função `loadInstanceState` (linha ~152):

```ts
/**
 * Uma linha no ledger de observações — o HISTÓRICO que `whatsapp_instances.notes`
 * não guardava (ela é sobrescrita a cada ação; cada uma apagava a justificativa
 * da anterior).
 *
 * BEST-EFFORT E NUNCA LANÇA. Falha aqui não derruba a operação já concluída:
 * devolver erro depois de o efeito ter ocorrido faria o operador repetir uma
 * ação já feita — que, em `request_cancellation` ou `confirm_end`, é pior que o
 * buraco no histórico. A divergência entre `notes` e o ledger fica detectável
 * pela telemetria `needsAdminAction`.
 *
 * CHAMAR SEMPRE DEPOIS DA MUTAÇÃO. Observação sobre operação que não aconteceu
 * é pior que observação ausente.
 */
async function recordInstanceNote(args: {
  instanceId: string;
  organizationId: string;
  action: InstanceNoteAction;
  note: string;
  callerId: string;
  reqId: string;
}): Promise<void> {
  const { error } = await supabase.from("whatsapp_instance_notes").insert({
    // `instance_ref` é identidade histórica: quando a instância for apagada, a
    // FK nula `instance_id` e é `instance_ref` que continua dizendo de quem era
    // a observação. No INSERT os dois são o mesmo id — a trigger exige.
    instance_ref: args.instanceId,
    instance_id: args.instanceId,
    organization_id: args.organizationId,
    action: args.action,
    note: args.note,
    created_by: args.callerId,
  });

  if (error) {
    jsonLog("error", {
      reqId: args.reqId,
      evt: "wa_instance_note_write_failed",
      instanceId: args.instanceId,
      action: args.action,
      err: error.message,
      needsAdminAction: true,
    });
  }
}
```

- [ ] **Step 2: Chamar o helper nas SETE ações que mudam a instância**

Cada chamada vai **imediatamente antes** do `return jsonResponse(req, { instance: data })` da respectiva action, depois do bloco `if (error)`.

`register_instance` (antes do `jsonLog("info", { ... evt: "wa_instance_registered" ... })`, linha ~636):

```ts
      await recordInstanceNote({
        instanceId: data.id, organizationId: orgId,
        action: "REGISTER", note: reason, callerId, reqId,
      });
```

`confirm_cycle_date` — depois do `update` da instância e **antes** do `update` que resolve o alerta `DATE_REVIEW_REQUIRED` (linha ~708):

```ts
      await recordInstanceNote({
        instanceId: id, organizationId: found.row.organization_id as string,
        action: "CONFIRM_CYCLE_DATE", note: reason, callerId, reqId,
      });
```

`set_cost` (linha ~760):

```ts
      await recordInstanceNote({
        instanceId: id, organizationId: data.organization_id as string,
        action: "SET_COST", note: reason, callerId, reqId,
      });
```

`request_cancellation` — antes do `jsonLog("info", { ... evt: "wa_cancellation_requested" ... })` (linha ~802):

```ts
      await recordInstanceNote({
        instanceId: id, organizationId: data.organization_id as string,
        action: "REQUEST_CANCELLATION", note: reason, callerId, reqId,
      });
```

`confirm_end` (linha ~845):

```ts
      await recordInstanceNote({
        instanceId: id, organizationId: data.organization_id as string,
        action: "CONFIRM_END", note: reason, callerId, reqId,
      });
```

`reactivate` (linha ~889):

```ts
      await recordInstanceNote({
        instanceId: id, organizationId: data.organization_id as string,
        action: "REACTIVATE", note: reason, callerId, reqId,
      });
```

`update_instance` (linha ~926):

```ts
      await recordInstanceNote({
        instanceId: id, organizationId: data.organization_id as string,
        action: "UPDATE", note: reason, callerId, reqId,
      });
```

**Não** adicionar em `acknowledge_alert` nem em `resolve_alert` — elas escrevem no ledger de alertas, que já guarda uma linha por alerta.

- [ ] **Step 3: Adicionar a action de leitura `list_instance_notes`**

Inserir no bloco de leitura, logo após a action `list_alerts` (antes de `simulate_partner`, linha ~463):

```ts
    /**
     * Histórico de observações de UMA instância.
     *
     * Chaveado por `instance_ref` e NÃO por `instance_id`: depois de a instância
     * ser apagada, `instance_id` é NULL e o histórico ficaria inalcançável — que
     * é justamente o oposto do contrato da tabela.
     *
     * `instance_id` validado na FORMA e não só na presença — a mesma lição do
     * defeito de `alert_id` corrigido na 6b: `"abc"` chegava ao PostgREST,
     * virava `22P02` e subia como 500, culpando o servidor por um pedido
     * inválido.
     */
    if (action === "list_instance_notes") {
      const id = requireInstanceId(body);
      if (!id) return jsonResponse(req, { error: "instance_id inválido." }, 400);

      const { data, error } = await supabase
        .from("whatsapp_instance_notes")
        .select(NOTE_COLUMNS)
        .eq("instance_ref", id)
        .order("created_at", { ascending: false });

      if (error) {
        jsonLog("error", { reqId, evt: "wa_instance_notes_list_failed", err: error.message });
        return jsonResponse(req, { error: "Não foi possível carregar o histórico." }, 500);
      }

      const rows = (data ?? []) as Record<string, unknown>[];

      // O autor é um uuid na linha; o painel precisa de um nome. Os autores
      // distintos de um histórico são platform_admins — realisticamente um ou
      // dois — mas o teto existe para que um histórico longo não vire dezenas de
      // chamadas ao Auth Admin dentro de uma resposta. Acima do teto o painel
      // mostra "autor não identificado", que é honesto: a informação existe,
      // não foi resolvida aqui.
      const ids = Array.from(
        new Set(rows.map((r) => r.created_by).filter((v): v is string => typeof v === "string")),
      ).slice(0, NOTE_AUTHOR_LOOKUP_CAP);

      const emailById = new Map<string, string>();
      await Promise.all(
        ids.map(async (uid) => {
          const { data: u, error: uErr } = await supabase.auth.admin.getUserById(uid);
          // Falha de lookup NÃO esconde a observação: o histórico é o dado,
          // o nome do autor é o enfeite.
          if (uErr || !u?.user?.email) return;
          emailById.set(uid, u.user.email);
        }),
      );

      return jsonResponse(req, {
        notes: rows.map((r) => ({
          ...r,
          created_by_email:
            typeof r.created_by === "string" ? emailById.get(r.created_by) ?? null : null,
        })),
      });
    }
```

- [ ] **Step 4: Atualizar o cabeçalho do arquivo**

Substituir o bloco `// ORDEM DE APLICAÇÃO:` (linhas 13-18) por:

```ts
// ORDEM DE APLICAÇÃO — DUAS migrations precedem esta versão:
//
// 1. `register_instance` lê `billing_plans.included_features` e
//    `billing_plans.included_whatsapp_connections` (migration 094). A guarda de
//    allowance é FAIL-CLOSED: coluna inexistente vira 400 do PostgREST →
//    leitura falha → todo registro passa a responder 503.
//
// 2. O ledger `whatsapp_instance_notes` (migration 096). Aqui a consequência é
//    MENOR de propósito: o insert é best-effort, então a EF subir antes da
//    migration deixa o histórico vazio e um log com `needsAdminAction`, sem
//    quebrar nenhuma operação. Ainda assim, aplicar a migration primeiro evita
//    o buraco.
```

- [ ] **Step 5: Verificar tipo e lint da Edge Function**

Run: `npx eslint supabase/functions/manage-whatsapp-instances/index.ts --max-warnings=0`
Expected: zero.

Run: `npm run typecheck`
Expected: zero erros. (`tsc -b` **não** alcança `supabase/functions/` — por isso o eslint acima é o gate real deste arquivo.)

- [ ] **Step 6: Conferir manualmente as sete chamadas**

Run: `grep -c "recordInstanceNote({" supabase/functions/manage-whatsapp-instances/index.ts`
Expected: `7`.

Run: `grep -n "acknowledge_alert\|resolve_alert" -A 25 supabase/functions/manage-whatsapp-instances/index.ts | grep -c recordInstanceNote`
Expected: `0` — as duas ações de alerta ficam de fora de propósito.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/manage-whatsapp-instances/index.ts
git commit -m "feat(6c): EF grava o ledger nas sete acoes com motivo e expoe list_instance_notes"
```

---

## Task 5: Hooks, navegação e o nome da organização

**Files:**
- Modify: `src/hooks/useWhatsappInstances.ts`
- Modify: `src/components/layouts/PlatformLayout.tsx`
- Modify: `src/pages/platform/WhatsappInstances.tsx`

**Interfaces:**
- Consumes: action `list_instance_notes` (Task 4); `useAllUnits()` de `src/hooks/useAllUnits.ts` → `UnitWithOrg[]` com `{ id, slug, name, organization_id, organization_name, organization_slug }`.
- Produces:
  - `type WhatsappInstanceNote = { id: string; instance_ref: string; instance_id: string | null; organization_id: string; action: string; note: string; created_by: string | null; created_by_email: string | null; created_at: string }`
  - `useWhatsappInstanceNotes(instanceId: string | null)` → `UseQueryResult<WhatsappInstanceNote[]>`

- [ ] **Step 1: Adicionar o tipo e o hook do histórico**

Em `src/hooks/useWhatsappInstances.ts`, adicionar após o tipo `WhatsappInstanceAlert` (linha ~62):

```ts
export type WhatsappInstanceNote = {
  id: string;
  instance_ref: string;
  instance_id: string | null;
  organization_id: string;
  action: string;
  note: string;
  created_by: string | null;
  /** Resolvido pela EF; `null` quando o lookup falhou ou passou do teto. */
  created_by_email: string | null;
  created_at: string;
};
```

Adicionar após `useWhatsappInstanceAlerts` (linha ~131):

```ts
export function useWhatsappInstanceNotes(instanceId: string | null) {
  return useQuery({
    queryKey: ["whatsapp-instance-notes", instanceId],
    enabled: !!instanceId,
    queryFn: () =>
      callEf<{ notes: WhatsappInstanceNote[] }>({
        action: "list_instance_notes",
        instance_id: instanceId,
      }).then((r) => r.notes),
  });
}
```

- [ ] **Step 2: Adicionar a QUARTA invalidação**

Em `useWhatsappInstanceAction`, dentro de `onSettled` (linha ~143), adicionar:

```ts
      // QUARTA key. `invalidateQueries` é prefix-match POR ELEMENTO do array:
      // ["whatsapp-instance"] NÃO casa ["whatsapp-instance-notes", id] — são
      // strings diferentes na posição 0. Sem esta linha, o histórico só
      // atualizaria no próximo refetch e a observação recém-gravada não
      // apareceria depois da ação que a criou.
      qc.invalidateQueries({ queryKey: ["whatsapp-instance-notes"] });
```

- [ ] **Step 3: Adicionar o link no menu lateral da plataforma**

Em `src/components/layouts/PlatformLayout.tsx`:

Trocar a linha de import de ícones (linha 12) por:

```ts
import { Bot, Building2, CreditCard, LogOut, Smartphone, Users } from "lucide-react";
```

Trocar `navItems` (linhas 25-29) por:

```ts
  const navItems = [
    { to: "/platform/empresas", label: "Empresas", icon: Building2 },
    { to: "/platform/automacao", label: "Automação", icon: Bot },
    { to: "/platform/billing", label: "Cobranças", icon: CreditCard },
    // A rota existia desde a 6b e não era alcançável por navegação — só por URL
    // digitada. Painel sem link é painel que ninguém abre, e este é hoje o
    // ÚNICO canal dos alertas de instância (o dispatch de e-mail está OFF).
    { to: "/platform/instancias-whatsapp", label: "Instâncias WhatsApp", icon: Smartphone },
  ];
```

- [ ] **Step 4: Trocar o UUID cru pelo nome da organização**

Em `src/pages/platform/WhatsappInstances.tsx`:

Adicionar ao bloco de imports:

```ts
import { useAllUnits } from "@/hooks/useAllUnits";
```

Dentro de `WhatsappInstances()`, após `const simulation = usePartnerSimulation();` (linha ~143):

```ts
  const unitsQuery = useAllUnits();

  /**
   * Nome da organização e da unidade a partir do inventário de unidades.
   *
   * `whatsapp_instances` guarda ids, e `manage-whatsapp-instances` devolve ids —
   * a EF não junta com `organizations` de propósito (projeção explícita). O
   * nome vem do hook que o painel já teria que carregar para o seletor de
   * unidade da Tela A.
   */
  const orgNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of unitsQuery.data ?? []) {
      if (u.organization_name) m.set(u.organization_id, u.organization_name);
    }
    return m;
  }, [unitsQuery.data]);

  const unitNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of unitsQuery.data ?? []) m.set(u.id, u.name);
    return m;
  }, [unitsQuery.data]);
```

Trocar o parágrafo do card (linhas 271-273):

```tsx
                    <p className="text-xs text-muted-foreground">
                      {/* Ainda carregando ou organização fora do alcance de
                          `useAllUnits` (rede sem unidade): o id continua sendo
                          a identificação verdadeira, então ele aparece em vez
                          de um espaço em branco. */}
                      {orgNameById.get(inst.organization_id) ?? `Organização ${inst.organization_id}`}
                      {inst.unit_id && unitNameById.has(inst.unit_id) && (
                        <> · {unitNameById.get(inst.unit_id)}</>
                      )}
                    </p>
```

- [ ] **Step 5: Verificar tipo, lint e build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: zero erros; build conclui.

- [ ] **Step 6: Verificação manual (dev server)**

Run: `npm run dev`

Roteiro, em `http://localhost:8080`, logado como platform_admin:
1. O menu lateral da plataforma mostra **Instâncias WhatsApp** e o link navega para `/platform/instancias-whatsapp`.
2. O card da instância mostra o **nome** da organização (Ren Sushi), não o UUID. **Não clicar em nenhum botão de ação** — a observação da 6b está em curso.
3. Colapsar a sidebar e reabrir em largura mobile (`<lg`): a gaveta abre e o item novo aparece.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useWhatsappInstances.ts \
        src/components/layouts/PlatformLayout.tsx \
        src/pages/platform/WhatsappInstances.tsx
git commit -m "feat(6c): hook do historico, link no menu da plataforma e nome da organizacao no card"
```

---

## Task 6: Tela A — Registrar instância (backfill)

**Files:**
- Create: `src/components/platform/RegisterInstanceDialog.tsx`
- Modify: `src/pages/platform/WhatsappInstances.tsx`

**Interfaces:**
- Consumes: `parseCostReais`, `COST_SOURCE_OPTIONS` (Tasks 2 e 3); `useAllUnits()`; `useWhatsAppChannels(unitId)`; `useWhatsappInstanceAction()`.
- Produces: componente `<RegisterInstanceDialog open onOpenChange prefill onRegistered />` onde `prefill?: { organizationId: string; channelId: string | null }` e `onRegistered: (instance: WhatsappInstance) => void`.

**As três restrições da UI, mais apertadas que o backend (spec §5):**

- **Unidade obrigatória.** A EF aceita `unit_id: null`, mas instância sem unidade não é alcançada por nenhum alerta do worker e vira órfã silenciosa.
- **Canal opcional.** É realista que a instância exista na Z-API antes de o canal estar configurado — é o buraco que a Tela B fecha depois.
- **Identificador obrigatório.** Além da dedupe do índice único, o backend **recusa com 409 `BACKFILL_WITHOUT_PROVIDER_REF`** desde o Plano A. Campo obrigatório no formulário, não "melhor preencher".

- [ ] **Step 1: Criar o diálogo**

Create `src/components/platform/RegisterInstanceDialog.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { toast } from "sonner";
import { useAllUnits } from "@/hooks/useAllUnits";
import { useWhatsAppChannels } from "@/hooks/useWhatsAppChannels";
import {
  useWhatsappInstanceAction,
  type WhatsappInstance,
} from "@/hooks/useWhatsappInstances";
import { parseCostReais } from "@/lib/whatsapp-instance-form-core";
import { COST_SOURCE_OPTIONS } from "@/lib/whatsapp-instance-format";

const MIN_REASON_LENGTH = 5;
const NO_CHANNEL = "__none__";

/**
 * Tela A — registrar no inventário uma instância que JÁ EXISTE na Z-API.
 *
 * TODO REGISTRO É BACKFILL, e por isso não há seletor de intenção: a instância
 * nasce no painel do fornecedor e só depois é registrada aqui. Registrar antes
 * de provisionar não protegeria custo nenhum — o custo começa no clique dentro
 * da Z-API, não no registro — e a fila de "pedido pendente" já existe em
 * `whatsapp_implementations`.
 */
export function RegisterInstanceDialog({
  open,
  onOpenChange,
  prefill,
  onRegistered,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Vindo do card do alerta CHANNEL_WITHOUT_INSTANCE, que carrega os dois. */
  prefill?: { organizationId: string; channelId: string | null } | null;
  onRegistered: (instance: WhatsappInstance) => void;
}) {
  const unitsQuery = useAllUnits();
  const action = useWhatsappInstanceAction();

  const [unitId, setUnitId] = useState("");
  const [channelId, setChannelId] = useState(NO_CHANNEL);
  const [ref, setRef] = useState("");
  const [costReais, setCostReais] = useState("");
  const [costSource, setCostSource] = useState(COST_SOURCE_OPTIONS[0].value);
  const [reason, setReason] = useState("");

  const channelsQuery = useWhatsAppChannels(unitId);

  // Aberto pelo card do alerta: só as unidades da organização do alerta entram
  // na lista. Sem o filtro, o operador escolheria uma unidade de OUTRA rede e a
  // trigger de tenant recusaria com 409 depois — erro tardio para uma pergunta
  // que a interface já sabia responder.
  const units = useMemo(() => {
    const all = unitsQuery.data ?? [];
    if (!prefill?.organizationId) return all;
    return all.filter((u) => u.organization_id === prefill.organizationId);
  }, [unitsQuery.data, prefill?.organizationId]);

  // Uma unidade só na organização do alerta: escolher por ela é seguro.
  useEffect(() => {
    if (!open) return;
    if (prefill?.organizationId && units.length === 1) setUnitId(units[0].id);
  }, [open, prefill?.organizationId, units]);

  // O alerta carrega `channel_id` mas não `unit_id`: o canal só pode ser
  // pré-selecionado depois de a lista da unidade escolhida carregar E conter o
  // id. Se não contiver, a escolha do operador continua livre — nada é chutado.
  useEffect(() => {
    if (!open || !prefill?.channelId) return;
    const found = (channelsQuery.data ?? []).some((c) => c.id === prefill.channelId);
    if (found) setChannelId(prefill.channelId);
  }, [open, prefill?.channelId, channelsQuery.data]);

  function reset() {
    setUnitId("");
    setChannelId(NO_CHANNEL);
    setRef("");
    setCostReais("");
    setCostSource(COST_SOURCE_OPTIONS[0].value);
    setReason("");
  }

  const selectedUnit = units.find((u) => u.id === unitId) ?? null;
  const cost = parseCostReais(costReais);
  const costInvalid = cost.ok === false;
  const reasonTooShort = reason.trim().length < MIN_REASON_LENGTH;
  const canSubmit =
    !!selectedUnit && ref.trim().length > 0 && !costInvalid && !reasonTooShort && !action.isPending;

  function submit() {
    if (!selectedUnit) return;
    const parsed = parseCostReais(costReais);
    if (parsed.ok === false) return;
    const hasCost = parsed.unknownCost === false;

    action.mutate(
      {
        action: "register_instance",
        // Fixos: a fase inteira registra o que já existe no fornecedor, e o
        // único provedor do inventário é a Z-API.
        intent: "BACKFILL_EXISTING",
        provider: "zapi",
        organization_id: selectedUnit.organization_id,
        unit_id: selectedUnit.id,
        channel_id: channelId === NO_CHANNEL ? null : channelId,
        provider_instance_ref: ref.trim(),
        current_monthly_cost_cents: hasCost ? parsed.cents : null,
        // Procedência só faz sentido quando existe número. Mandá-la com custo
        // nulo afirmaria a origem de um valor que não foi informado.
        ...(hasCost ? { cost_source: costSource } : {}),
        reason,
      },
      {
        onSuccess: (data: unknown) => {
          const instance = (data as { instance: WhatsappInstance }).instance;
          toast.success("Instância registrada.");
          reset();
          onOpenChange(false);
          onRegistered(instance);
        },
        // A EF devolve mensagem curta em PT-BR (409 de duplicata, 409 de tenant,
        // 400 do identificador com URL); o hook já a extraiu do corpo non-2xx
        // que o `invoke` mascara.
        onError: (e: Error) => toast.error(e.message),
      },
    );
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Registrar instância existente</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            A instância precisa ter sido criada antes no painel da Z-API. Este registro é a
            afirmação da plataforma sobre o que existe lá — ele não cria nada no fornecedor.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="reg-unit">Unidade</Label>
            <Select value={unitId} onValueChange={setUnitId}>
              <SelectTrigger id="reg-unit" className="h-12 sm:h-10">
                <SelectValue placeholder="Escolha a unidade" />
              </SelectTrigger>
              <SelectContent>
                {units.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.organization_name} · {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Obrigatória. Instância sem unidade não é alcançada por nenhum alerta do worker e
              vira órfã silenciosa.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="reg-channel">Canal (opcional)</Label>
            <Select value={channelId} onValueChange={setChannelId} disabled={!unitId}>
              <SelectTrigger id="reg-channel" className="h-12 sm:h-10">
                <SelectValue placeholder={unitId ? "Sem canal por enquanto" : "Escolha a unidade primeiro"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CHANNEL}>Sem canal por enquanto</SelectItem>
                {(channelsQuery.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.provider} · {c.status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {channelsQuery.isError && (
              <p className="text-xs text-destructive">
                Não foi possível carregar os canais desta unidade. Você pode registrar sem canal e
                corrigir o vínculo depois.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              É normal a instância existir antes de o canal estar configurado. O vínculo pode ser
              corrigido depois.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="reg-ref">Identificador da instância no fornecedor</Label>
            <Input
              id="reg-ref"
              className="h-12 sm:h-10 font-mono"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="Ex.: 3D1A2B4C5D6E"
            />
            {/* A advertência vem ANTES do erro, não só depois: colar a URL de
                envio inteira aqui vazaria o token para uma tabela que a spec
                declara livre de segredo. */}
            <p className="text-xs text-warning">
              Apenas o identificador da instância, <strong>nunca a URL</strong> — ela contém o
              token.
            </p>
            <p className="text-xs text-muted-foreground">
              Obrigatório. Sem ele o registro é recusado: backfill sem referência da instância real
              é conexão nova entrando por outra porta.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="reg-cost">Custo mensal (R$)</Label>
              <Input
                id="reg-cost"
                inputMode="decimal"
                className="h-12 sm:h-10"
                value={costReais}
                onChange={(e) => setCostReais(e.target.value)}
                placeholder="Ex.: 99,90"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="reg-cost-source">Procedência do custo</Label>
              <Select
                value={costSource}
                onValueChange={setCostSource}
                disabled={cost.ok === false || cost.unknownCost === true}
              >
                <SelectTrigger id="reg-cost-source" className="h-12 sm:h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COST_SOURCE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {costInvalid ? (
            <p className="text-sm text-destructive">{cost.message}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Vazio grava <strong>desconhecido</strong>, nunca zero — e o ciclo fica pendente de
              revisão até o número existir.
            </p>
          )}

          <div className="space-y-1">
            <Label htmlFor="reg-reason">Motivo (fica registrado no histórico)</Label>
            <Textarea
              id="reg-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Ex.: instância criada na Z-API em 03/08 para a contratação da rede X."
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              Cancelar
            </Button>
            <Button disabled={!canSubmit} onClick={submit}>
              Registrar
            </Button>
          </div>
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
```

- [ ] **Step 2: Ligar os três pontos de entrada e o encadeamento**

Em `src/pages/platform/WhatsappInstances.tsx`:

Adicionar ao bloco de imports:

```ts
import { RegisterInstanceDialog } from "@/components/platform/RegisterInstanceDialog";
```

Adicionar ao estado do componente (após `const [dialog, setDialog] = useState<ReasonDialogKind>(null);`):

```ts
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registerPrefill, setRegisterPrefill] =
    useState<{ organizationId: string; channelId: string | null } | null>(null);

  function openRegister(prefill: { organizationId: string; channelId: string | null } | null) {
    setRegisterPrefill(prefill);
    setRegisterOpen(true);
  }
```

Adicionar o botão no cabeçalho — dentro do `<div className="flex flex-wrap items-end justify-between gap-3">`, depois do `</div>` que fecha o bloco de título (linha ~199):

```tsx
        <Button onClick={() => openRegister(null)}>Registrar instância</Button>
```

Adicionar o botão no estado vazio — dentro do `<CardContent>` do bloco de lista vazia (linha ~238), depois do texto:

```tsx
              <div className="pt-3">
                <Button size="sm" onClick={() => openRegister(null)}>
                  Registrar instância existente
                </Button>
              </div>
```

Adicionar o botão no card do alerta `DIVERGENCE` — dentro do `<div className="flex flex-wrap gap-2">` do card de alerta (linha ~392), antes do botão "Reconhecer":

```tsx
                  {/* O alerta deixa de ser aviso e vira o começo da tarefa: ele
                      já carrega organização e canal, então o formulário abre
                      preenchido. */}
                  {a.alert_type === "DIVERGENCE" && kind === "CHANNEL_WITHOUT_INSTANCE" && (
                    <Button
                      size="sm"
                      onClick={() =>
                        openRegister({
                          organizationId: a.organization_id,
                          channelId: a.channel_id,
                        })
                      }
                    >
                      Registrar esta instância
                    </Button>
                  )}
```

Adicionar o diálogo antes do `</div>` final do componente, junto do `ResponsiveDialog` existente:

```tsx
      <RegisterInstanceDialog
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        prefill={registerPrefill}
        onRegistered={(instance) => {
          // ENCADEAMENTO: a instância nasce em `cycle_source: "UNKNOWN"`, o que
          // faz o worker abrir DATE_REVIEW_REQUIRED na execução seguinte. Em vez
          // de esperar um dia, o fluxo emenda direto na confirmação da data —
          // foi assim que a instância do Ren Sushi foi operada, em dois passos
          // manuais.
          setRegisterPrefill(null);
          setDialog({ kind: "confirm_date", instance });
        }}
      />
```

- [ ] **Step 3: Verificar tipo, lint e build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: zero erros; nenhum warning novo.

- [ ] **Step 4: Verificação manual — roteiro fechado**

Run: `npm run dev`

Como `platform_admin`, em `/platform/instancias-whatsapp`. **Todos os casos abaixo são de RECUSA — nenhum deles cria linha.** Não completar um registro de sucesso contra produção nesta tarefa.

1. **URL colada no identificador** → digitar `https://api.z-api.io/instances/ABC/token/XYZ`, preencher o resto, submeter. **Esperado:** toast com "Informe apenas o identificador da instância, nunca a URL — ela contém o token." (400 `REF_LOOKS_LIKE_URL`).
2. **Identificador vazio** → o botão **Registrar** fica desabilitado. Não há viagem ao servidor.
3. **Unidade não escolhida** → botão desabilitado.
4. **Custo `abc`** → a mensagem de recusa aparece embaixo do par de campos, o seletor de procedência fica desabilitado e o botão não submete.
5. **Custo `99.90`** → aceito, sem mensagem de erro (a conversão por string não confunde com 9990 reais).
6. **Registro repetido da mesma instância** → usar o `provider_instance_ref` do Ren Sushi. **Esperado:** 409 "Esta instância ou este canal já está registrado." Confirmar no painel que **nenhuma linha nova** apareceu e que a instância do Ren Sushi não mudou.
7. **Card do alerta** → se houver `DIVERGENCE`/`CHANNEL_WITHOUT_INSTANCE` aberto, o botão "Registrar esta instância" abre o diálogo com a unidade da organização do alerta já filtrada. Fechar sem submeter.
8. **Mobile (`<640px`)** → o diálogo vira bottom-sheet, os inputs têm altura de toque e o rodapé respeita a safe-area.

Registrar o resultado de cada caso em `docs/billing-asaas/FASE-6C-PENDENCIAS.md` na Task 10.

- [ ] **Step 5: Commit**

```bash
git add src/components/platform/RegisterInstanceDialog.tsx src/pages/platform/WhatsappInstances.tsx
git commit -m "feat(6c): Tela A — registrar instancia existente, com ref obrigatoria e encadeamento da data"
```

---

## Task 7: Telas B e C — Corrigir vínculo e Reativar

**Files:**
- Create: `src/components/platform/UpdateInstanceDialog.tsx`
- Modify: `src/pages/platform/WhatsappInstances.tsx`

**Interfaces:**
- Consumes: `buildUpdatePatch`, `type InstanceLinkFields` (Task 2); `useAllUnits()`; `useWhatsAppChannels(unitId)`; `useWhatsappInstanceAction()`.
- Produces: componente `<UpdateInstanceDialog open onOpenChange instance />`.

- [ ] **Step 1: Criar o diálogo de correção de vínculo**

Create `src/components/platform/UpdateInstanceDialog.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { toast } from "sonner";
import { useAllUnits } from "@/hooks/useAllUnits";
import { useWhatsAppChannels } from "@/hooks/useWhatsAppChannels";
import {
  useWhatsappInstanceAction,
  type WhatsappInstance,
} from "@/hooks/useWhatsappInstances";
import {
  buildUpdatePatch,
  type InstanceLinkFields,
} from "@/lib/whatsapp-instance-form-core";

const MIN_REASON_LENGTH = 5;
const NO_CHANNEL = "__none__";

/**
 * Tela B — corrigir o vínculo de uma instância já registrada.
 *
 * A RESTRIÇÃO QUE DEFINE ESTE COMPONENTE: a EF decide o que gravar por
 * `"campo" in body`. Mandar uma chave significa *escreva isto, inclusive
 * `null`*. Um formulário ingênuo, que enviasse o objeto inteiro, APAGARIA o
 * canal de quem só quis corrigir o identificador. Por isso o corpo sai de
 * `buildUpdatePatch` — função pura, testada — e nunca do estado bruto.
 */
export function UpdateInstanceDialog({
  open,
  onOpenChange,
  instance,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  instance: WhatsappInstance | null;
}) {
  const unitsQuery = useAllUnits();
  const action = useWhatsappInstanceAction();

  const original: InstanceLinkFields = useMemo(
    () => ({
      unit_id: instance?.unit_id ?? null,
      channel_id: instance?.channel_id ?? null,
      provider_instance_ref: instance?.provider_instance_ref ?? null,
      planned_provision_on: instance?.planned_provision_on ?? null,
    }),
    [instance],
  );

  const [unitId, setUnitId] = useState("");
  const [channelId, setChannelId] = useState(NO_CHANNEL);
  const [ref, setRef] = useState("");
  const [plannedOn, setPlannedOn] = useState("");
  const [reason, setReason] = useState("");

  // Reabrir o diálogo em OUTRA instância precisa recarregar o formulário — sem
  // isto, o estado da instância anterior viraria "mudança" na próxima.
  useEffect(() => {
    if (!open) return;
    setUnitId(original.unit_id ?? "");
    setChannelId(original.channel_id ?? NO_CHANNEL);
    setRef(original.provider_instance_ref ?? "");
    setPlannedOn(original.planned_provision_on ?? "");
    setReason("");
  }, [open, original]);

  const channelsQuery = useWhatsAppChannels(unitId);

  // Só as unidades da MESMA organização: mover a instância para outra rede não é
  // correção de vínculo, e a trigger de tenant recusaria com 409.
  const units = useMemo(
    () => (unitsQuery.data ?? []).filter((u) => u.organization_id === instance?.organization_id),
    [unitsQuery.data, instance?.organization_id],
  );

  const form: InstanceLinkFields = {
    unit_id: unitId,
    channel_id: channelId === NO_CHANNEL ? null : channelId,
    provider_instance_ref: ref,
    planned_provision_on: plannedOn,
  };
  const patch = buildUpdatePatch(original, form);
  const hasChanges = Object.keys(patch).length > 0;
  const reasonTooShort = reason.trim().length < MIN_REASON_LENGTH;

  function submit() {
    if (!instance || !hasChanges) return;
    action.mutate(
      { action: "update_instance", instance_id: instance.id, ...patch, reason },
      {
        onSuccess: () => {
          toast.success("Vínculo corrigido.");
          onOpenChange(false);
        },
        onError: (e: Error) => toast.error(e.message),
      },
    );
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Corrigir vínculo</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Só os campos que você alterar são enviados. Campo esvaziado desvincula de propósito.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="upd-unit">Unidade</Label>
            <Select value={unitId} onValueChange={setUnitId}>
              <SelectTrigger id="upd-unit" className="h-12 sm:h-10">
                <SelectValue placeholder="Escolha a unidade" />
              </SelectTrigger>
              <SelectContent>
                {units.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.organization_name} · {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="upd-channel">Canal</Label>
            <Select value={channelId} onValueChange={setChannelId} disabled={!unitId}>
              <SelectTrigger id="upd-channel" className="h-12 sm:h-10">
                <SelectValue placeholder={unitId ? "Sem canal" : "Escolha a unidade primeiro"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CHANNEL}>Sem canal</SelectItem>
                {(channelsQuery.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.provider} · {c.status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {channelsQuery.isError && (
              <p className="text-xs text-destructive">
                Não foi possível carregar os canais desta unidade.
              </p>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="upd-ref">Identificador da instância no fornecedor</Label>
            <Input
              id="upd-ref"
              className="h-12 sm:h-10 font-mono"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
            />
            <p className="text-xs text-warning">
              Apenas o identificador, <strong>nunca a URL</strong> — ela contém o token.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="upd-planned">Data prevista de provisionamento (opcional)</Label>
            <Input
              id="upd-planned"
              type="date"
              className="h-12 sm:h-10"
              value={plannedOn}
              onChange={(e) => setPlannedOn(e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="upd-reason">Motivo (fica registrado no histórico)</Label>
            <Textarea
              id="upd-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
          </div>

          {!hasChanges && (
            <p className="text-xs text-muted-foreground">
              Nada foi alterado ainda. Sem mudança não há requisição.
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button
              disabled={!hasChanges || reasonTooShort || action.isPending}
              onClick={submit}
            >
              Salvar correção
            </Button>
          </div>
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
```

- [ ] **Step 2: Ligar a Tela B e a Tela C na página**

Em `src/pages/platform/WhatsappInstances.tsx`:

Adicionar ao bloco de imports:

```ts
import { UpdateInstanceDialog } from "@/components/platform/UpdateInstanceDialog";
```

Adicionar ao estado:

```ts
  const [updateTarget, setUpdateTarget] = useState<WhatsappInstance | null>(null);
```

Estender o tipo `ReasonDialogKind` (linha ~131) com a Tela C:

```ts
type ReasonDialogKind =
  | { kind: "confirm_date"; instance: WhatsappInstance }
  | { kind: "set_cost"; instance: WhatsappInstance }
  | { kind: "cancel"; instance: WhatsappInstance }
  | { kind: "confirm_end"; instance: WhatsappInstance }
  | { kind: "reactivate"; instance: WhatsappInstance }
  | { kind: "resolve_alert"; alert: WhatsappInstanceAlert }
  | null;
```

Adicionar os dois botões no card, dentro do `<div className="flex flex-wrap gap-2">` (linha ~303), depois do botão "Confirmar encerramento":

```tsx
                  {/* Tela C — SÓ em CANCELLATION_REQUESTED. `ENDED` não mostra
                      nada: `canTransition` recusa mesmo com evidência, e
                      oferecer um botão que sempre falha é mentir para o
                      operador. Instância encerrada que reapareça no fornecedor
                      exige linha nova. */}
                  {inst.lifecycle_state === "CANCELLATION_REQUESTED" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setDialog({ kind: "reactivate", instance: inst })}
                    >
                      Reativar
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setUpdateTarget(inst)}
                  >
                    Corrigir vínculo
                  </Button>
```

Adicionar o título da Tela C no `ResponsiveDialogTitle` (linha ~489), junto dos outros:

```tsx
              {dialog?.kind === "reactivate" && "Reativar instância"}
```

Adicionar o corpo da Tela C no `ResponsiveDialogBody`, depois do bloco `confirm_end` (linha ~572):

```tsx
            {dialog?.kind === "reactivate" && (
              <p className="text-sm text-muted-foreground">
                Reverter o cancelamento exige <strong>evidência</strong> de que ele foi desfeito no
                fornecedor. Descreva o que você verificou no painel da Z-API — a data-limite de
                acesso registrada será apagada.
              </p>
            )}
```

Adicionar o despacho da Tela C na cadeia de `if` do botão Confirmar (linha ~626), antes do ramo `resolve_alert`:

```tsx
                  } else if (dialog.kind === "reactivate") {
                    run(
                      { action: "reactivate", instance_id: dialog.instance.id, reason },
                      "Cancelamento revertido.",
                    );
```

Adicionar o diálogo da Tela B junto do `RegisterInstanceDialog`:

```tsx
      <UpdateInstanceDialog
        open={!!updateTarget}
        onOpenChange={(o) => !o && setUpdateTarget(null)}
        instance={updateTarget}
      />
```

- [ ] **Step 3: Verificar tipo, lint e build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: zero erros, nenhum warning novo.

- [ ] **Step 4: Verificação manual — roteiro fechado**

Run: `npm run dev`

1. **O defeito do §6 — alterar só o identificador NÃO apaga o canal.** Abrir "Corrigir vínculo" na instância do Ren Sushi, mudar **apenas** o identificador (um caractere), e **antes de salvar** abrir o DevTools na aba Network. Submeter e inspecionar o corpo da requisição: ele deve conter **exatamente** `action`, `instance_id`, `provider_instance_ref` e `reason` — **sem** `channel_id` nem `unit_id`.
   **Não completar este caso contra produção enquanto a observação da 6b estiver em curso (até 05/08).** Até lá, verificar só até o corpo montado: com o DevTools aberto e o botão desabilitado por motivo curto, o corpo pode ser conferido por `console.log` temporário do `patch` — removido antes do commit. Registrar como pendência na Task 10.
2. **Nada alterado** → o botão "Salvar correção" fica desabilitado e o aviso "Sem mudança não há requisição" aparece.
3. **Canal esvaziado** ("Sem canal") → o botão habilita e o patch conteria `channel_id: null`.
4. **Instância `ENDED`** → o botão **Reativar** está ausente no card.
5. **Instância `CANCELLATION_REQUESTED`** → o botão **Reativar** aparece; abrir o diálogo, ler o texto da evidência, fechar **sem** submeter.
6. **Mobile (`<640px`)** → os dois diálogos viram bottom-sheet e os inputs têm altura de toque.

- [ ] **Step 5: Commit**

```bash
git add src/components/platform/UpdateInstanceDialog.tsx src/pages/platform/WhatsappInstances.tsx
git commit -m "feat(6c): Telas B e C — corrigir vinculo com patch minimo e reativar com evidencia"
```

---

## Task 8: Seção Histórico no detalhe da instância

**Files:**
- Create: `src/components/platform/InstanceNotesPanel.tsx`
- Modify: `src/pages/platform/WhatsappInstances.tsx`

**Interfaces:**
- Consumes: `useWhatsappInstanceNotes` (Task 5); `instanceNoteActionLabel` (Task 3).
- Produces: componente `<InstanceNotesPanel instanceId />`.

- [ ] **Step 1: Criar o painel de histórico**

Create `src/components/platform/InstanceNotesPanel.tsx`:

```tsx
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateBR } from "@/lib/utils";
import { instanceNoteActionLabel } from "@/lib/whatsapp-instance-format";
import { useWhatsappInstanceNotes } from "@/hooks/useWhatsappInstances";

/**
 * Histórico de observações — o que `whatsapp_instances.notes` não guardava.
 *
 * `notes` é sobrescrita a cada ação e cada uma apagava a justificativa da
 * anterior. Ela continua existindo como RESUMO ("última observação"); esta
 * seção é o histórico, e as duas saem do mesmo `reason`, na mesma operação.
 */
export function InstanceNotesPanel({ instanceId }: { instanceId: string }) {
  const notes = useWhatsappInstanceNotes(instanceId);

  if (notes.isLoading) return <Skeleton className="h-20 w-full" />;

  // Branch PRÓPRIO: silenciar erro como "sem histórico" leria como "nunca houve
  // decisão registrada" sobre uma instância que tem custo correndo.
  if (notes.isError) {
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">Não foi possível carregar o histórico.</span>
        <Button variant="outline" size="sm" onClick={() => notes.refetch()}>
          Tentar de novo
        </Button>
      </div>
    );
  }

  const rows = notes.data ?? [];
  if (!rows.length) {
    return (
      <p className="text-sm text-muted-foreground">
        Nenhuma observação registrada. Toda ação com motivo passa a registrar uma linha aqui.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {rows.map((n) => (
        <div key={n.id} className="rounded-md border p-3 space-y-1 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{instanceNoteActionLabel(n.action)}</Badge>
            <span className="text-xs text-muted-foreground">
              {formatDateBR(n.created_at.slice(0, 10))} ·{" "}
              {/* Autor não resolvido é dito, não escondido: a informação existe
                  na linha, só não foi traduzida em nome. */}
              {n.created_by_email ?? "autor não identificado"}
            </span>
          </div>
          <p className="whitespace-pre-wrap">{n.note}</p>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Montar a seção no bloco expandido do card**

Em `src/pages/platform/WhatsappInstances.tsx`:

Adicionar ao bloco de imports:

```ts
import { InstanceNotesPanel } from "@/components/platform/InstanceNotesPanel";
```

Trocar o bloco expandido (linhas ~331-335) por:

```tsx
                {expandedId === inst.id && (
                  <div className="border-t pt-3 space-y-4">
                    <div>
                      <h3 className="text-sm font-semibold mb-2">Ciclos e margem</h3>
                      <CyclesPanel instanceId={inst.id} />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold mb-2">Histórico</h3>
                      <InstanceNotesPanel instanceId={inst.id} />
                    </div>
                  </div>
                )}
```

Trocar o rótulo do botão de expandir (linha ~327) por:

```tsx
                    {expandedId === inst.id ? "Ocultar detalhes" : "Ver ciclos, margem e histórico"}
```

- [ ] **Step 3: Trocar o rótulo do campo de motivo no diálogo compartilhado**

Trocar o `<Label htmlFor="reason">` (linha ~575) por:

```tsx
              <Label htmlFor="reason">Motivo (fica registrado no histórico)</Label>
```

E o `ResponsiveDialogDescription` do diálogo compartilhado (linha ~492) por:

```tsx
            <ResponsiveDialogDescription>
              O motivo é obrigatório e vira uma linha permanente no histórico da instância, com
              autoria e data.
            </ResponsiveDialogDescription>
```

- [ ] **Step 4: Verificar tipo, lint e build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: verde.

- [ ] **Step 5: Verificação manual**

Run: `npm run dev`

1. Expandir a instância do Ren Sushi → aparecem **duas** subseções, "Ciclos e margem" e "Histórico".
2. **Antes do `db push` da 096, o histórico devolve erro** (a tabela não existe) → confirmar que o branch `isError` aparece com o botão "Tentar de novo", e **não** um painel em branco nem a tela quebrada. Este é o comportamento correto no estado atual e vira nota na Task 10.
3. O rótulo do campo de motivo, nos cinco diálogos compartilhados, diz "fica registrado no histórico".

- [ ] **Step 6: Commit**

```bash
git add src/components/platform/InstanceNotesPanel.tsx src/pages/platform/WhatsappInstances.tsx
git commit -m "feat(6c): secao Historico no detalhe da instancia e rotulo honesto do campo motivo"
```

---

## Task 9: Runbook do fluxo manual assistido

**Files:**
- Create: `docs/billing-asaas/10-RUNBOOK-INSTANCIAS-ZAPI.md`

- [ ] **Step 1: Escrever o runbook**

Create `docs/billing-asaas/10-RUNBOOK-INSTANCIAS-ZAPI.md`:

````markdown
# Runbook — instâncias de WhatsApp (Z-API), fluxo manual assistido

**Fase 6c.** Painel: `/platform/instancias-whatsapp` (menu lateral da plataforma → **Instâncias WhatsApp**).

## A regra que atravessa tudo

**O painel nunca age no fornecedor.** Não temos a API de Parceiro da Z-API: criar e cancelar
instância é ato humano no painel deles. Cada linha do inventário é uma **afirmação humana** sobre
o que existe lá fora, e o worker diário é quem cobra essa afirmação de volta.

Este runbook existe porque essa afirmação envelhece.

---

## R1 — Contratar

1. Pagamento confirmado. (Fora deste escopo: `whatsapp_implementations`.)
2. **Criar a instância no painel da Z-API.** O custo começa aqui, e só aqui.
3. Anotar o **identificador** da instância, o **valor mensal** e o **dia do vencimento**.
4. Registrar no painel: **Registrar instância** → unidade, canal (se já existir), identificador,
   custo, procedência, motivo.
5. **Confirmar a data do ciclo** — o painel já emenda nesse passo depois do registro. A instância
   nasce em `cycle_source: UNKNOWN`, e sem esta confirmação o worker abre `DATE_REVIEW_REQUIRED`.
6. Configurar o canal em `/platform/automacao/<slug>` com as credenciais.

**Sobre o identificador:** apenas o identificador, **nunca a URL** — ela contém o token, e esta
tabela é declarada livre de segredo. O formulário recusa URL, espaço e mais de 128 caracteres.

**Sobre o custo:** vazio significa **desconhecido**, nunca zero. O ciclo fica em
`PENDING_REVIEW` até o número existir, e a margem fica indefinida — que é a verdade.

---

## R2 — Rotina mensal: um alerta, uma ação

| Alerta | `event_type` | Ação |
|---|---|---|
| `CYCLE_DUE_SOON` (D-7) | `admin_zapi_cycle_d7` | Nada obrigatório. Decidir se mantém. |
| `CYCLE_DUE_TOMORROW` (D-1) | `admin_zapi_cycle_d1_action_required` | **Ação hoje.** Ver os quatro motivos abaixo. |
| `END_CONFIRMATION_REQUIRED` | `admin_zapi_end_confirmation_required` | Conferir na Z-API e confirmar o encerramento. |
| `DATE_REVIEW_REQUIRED` | `admin_zapi_date_review_required` | Confirmar a data do ciclo. |
| `DIVERGENCE` | `admin_zapi_divergence` | Canal sem instância → **Registrar esta instância**, pelo próprio card do alerta. |
| `ECONOMIC_IMBALANCE` | `admin_zapi_economic_imbalance` | Decisão comercial, não técnica. Nunca dispara para cliente vitalício. |

### Os quatro motivos do D-1 (`D1Reason`)

| Motivo | O que fazer |
|---|---|
| `COST_UNKNOWN` | Informar o custo. |
| `OPEN_DIVERGENCE` | Resolver a divergência. |
| `CANCELLATION_INTENDED_NOT_REGISTERED` | **Cancelar na Z-API hoje.** O cancelamento foi registrado aqui e não foi feito lá. |
| `REVENUE_UNKNOWN` | Conferir assinatura ou override. |

### `ACKNOWLEDGED` não é `RESOLVED`

**Reconhecer** interrompe o lembrete; **resolver** afirma que o fato deixou de existir. Fato que
desaparece sozinho é resolvido pelo worker com nota do sistema — nunca apagado.

---

## R3 — Cancelar

1. **Registrar cancelamento** no painel: motivo + data-limite de acesso.
   A data informada é o **primeiro dia NÃO coberto** — o acesso vai até a véspera, e o painel
   escreve isso por extenso embaixo do campo.
2. **Cancelar de fato na Z-API.** Este é o passo que interrompe o custo. Sem ele, o registro é
   uma intenção e o dinheiro continua saindo.
3. Chega `END_CONFIRMATION_REQUIRED` → conferir no painel do fornecedor → **Confirmar
   encerramento**.
4. Se o fornecedor desfez o cancelamento: **Reativar**, com a evidência do que foi verificado.
   `ENDED` não reativa — instância encerrada que reapareça exige linha nova.

### O que o cancelamento aqui NÃO faz

Não altera assinatura, `billing_status`, entitlement, envio, canal nem credencial. Ele registra o
**término planejado do custo** — nada mais. Quem interrompe o serviço do cliente é o enforcement
por inadimplência, que é outro mecanismo.

### O caso que vem do downgrade (Plano C)

O downgrade revoga o WhatsApp no SaaS e abre um `request_cancellation` — **ele não cancela nada na
Z-API.** O passo 2 continua sendo humano. Sem alguém executá-lo, o cliente perde o serviço e a
plataforma segue pagando **R$ 99,90/mês** por uma instância que ninguém está usando. É a razão de
a cadência abaixo não ser opcional.

---

## O ponto operacional que este runbook não pode omitir

**Os seis avisos `admin_zapi_*` não viram e-mail hoje.** `billing_notifications_dispatch` segue
OFF para eles pela pendência `ADMIN_ZAPI_ALERT_TRANSACTIONAL_ENQUEUE`: resta um intervalo entre
enfileirar e carimbar, e ligar o dispatch transformaria uma falha de carimbo em e-mail duplicado
para o admin.

A fila acumula corretamente. O ledger registra corretamente. **Ninguém é notificado.**

Enquanto isso, o painel é o único canal — e fluxo manual sem aviso ativo exige cadência de
conferência.

### A cadência

**Toda segunda-feira, e obrigatoriamente entre o D-7 e o D-1 de cada instância.**

Com uma instância vencendo dia 4, isso é **dia 28 e dia 3**.

O painel mostra um aviso azul no topo quando existe alerta aberto nascido com o dispatch
desligado — ele existe exatamente para que ninguém leia "não recebi e-mail" como "não houve
alerta".
````

- [ ] **Step 2: Commit**

```bash
git add docs/billing-asaas/10-RUNBOOK-INSTANCIAS-ZAPI.md
git commit -m "docs(6c): runbook do fluxo manual assistido de instancias Z-API"
```

---

## Task 10: Pendências, roteiro de banco e gates finais

**Files:**
- Create: `docs/billing-asaas/FASE-6C-PENDENCIAS.md`
- Modify: `supabase/tests/whatsapp-instances.integration.md`

- [ ] **Step 1: Adicionar os casos de banco ao roteiro de integração**

Append to `supabase/tests/whatsapp-instances.integration.md`:

````markdown

---

## Fase 6c — ledger `whatsapp_instance_notes` (migration 096)

Nenhum caso abaixo é verificável por vitest. Roteiro para banco local
(PostgreSQL 18.4 em `127.0.0.1:55432`, sem `pg_cron`/`pg_net`), aplicando a
migration real sobre bootstrap mínimo — o mesmo procedimento usado para validar
a 089.

### NOTE-A — Backfill idempotente

1. Com pelo menos uma linha em `whatsapp_instances` com `notes` não-vazio,
   aplicar a 096.
2. `select count(*) from whatsapp_instance_notes where action = 'REGISTER';`
   → uma linha por instância com `notes`.
3. **Aplicar a migration de novo, inteira.**
4. Repetir a contagem. **Esperado: o mesmo número.**

**Reprova se:** a segunda aplicação duplicar qualquer linha.

### NOTE-B — Controle positivo: apagar a instância NÃO apaga a observação

1. Inserir uma observação para uma instância de teste.
2. `delete from whatsapp_instances where id = '<id de teste>';`
3. **Esperado:** o DELETE conclui; a linha em `whatsapp_instance_notes`
   continua existindo, com `instance_id` nulo e `instance_ref` intacto.

**Reprova se:** o DELETE abortar com `check_violation` — foi exatamente esse o
defeito que a 089 pagou, e este caso é o controle que prova que ele não voltou.

### NOTE-C — Append-only

1. `update whatsapp_instance_notes set note = 'outro texto' where id = '<id>';`
   **Esperado:** exceção `check_violation`, "observacao e registro append-only".
2. `update whatsapp_instance_notes set action = 'UPDATE' where id = '<id>';`
   **Esperado:** a mesma exceção.
3. `update whatsapp_instance_notes set instance_ref = gen_random_uuid() where id = '<id>';`
   **Esperado:** a mesma exceção.

### NOTE-D — Rigor de INSERT

1. `insert ... (instance_ref, instance_id, ...) values (gen_random_uuid(), null, ...)`
   **Esperado:** exceção, "observacao nasce apontando instancia viva".
2. `insert` com `instance_ref` diferente de `instance_id`
   **Esperado:** a mesma exceção.
3. `insert` com `organization_id` de OUTRA organização que não a da instância
   **Esperado:** exceção da trigger de tenant, "instance_id pertence a outra organizacao".
4. `insert` com `note = '   '`
   **Esperado:** violação do CHECK `btrim(note) <> ''`.

### NOTE-E — RLS

Pelo **client SDK**, nunca pelo SQL Editor (que bypassa RLS):

1. Como usuário `authenticated` **sem** linha em `platform_admins`:
   `select` em `whatsapp_instance_notes` → **zero linhas**.
2. Como usuário membro (`unit_members`) da organização dona da instância:
   **zero linhas**. É a diferença que justifica não ter usado `audit_log`.
3. Como `platform_admin`: as linhas aparecem.
4. Como `anon`: **erro ou zero linhas**, nunca dados.
````

- [ ] **Step 2: Escrever o documento de pendências**

Create `docs/billing-asaas/FASE-6C-PENDENCIAS.md`:

````markdown
# Pendências da Fase 6c — não declaráveis por teste unitário

Painel de instâncias completo + ledger de observações + runbook.
Ambiente sem Docker, repo ligado à produção. **Nenhuma migration aplicada,
nenhuma Edge Function deployada, nenhuma flag alterada, nenhum merge.**

**Gates desta entrega (execução real):**

| Gate | Resultado |
|---|---|
| `npm run test` | (preencher: N testes, M arquivos) |
| `npm run typecheck` (`tsc -b --noEmit`) | (preencher) |
| `npm run lint` | (preencher) |
| `npx eslint supabase/functions --max-warnings=0` | (preencher) |
| `npm run build` | (preencher) |

---

## 1. CLAUDE.md a consolidar

**Esta frente NÃO editou `CLAUDE.md`** — três frentes (6c, Plano B, Plano D)
tocam o mesmo arquivo e a consolidação é um commit único no fim, fora deste
trabalho. O que entra, quando chegar a hora:

### 1.1 Checklist de redeploy — linha nova

```
- **`whatsapp-instance-notes-core.ts`** (núcleo puro, testado em
  [src/lib/whatsapp-instance-notes-core.test.ts](src/lib/whatsapp-instance-notes-core.test.ts))
  → `manage-whatsapp-instances` (único consumidor de runtime). Carrega o
  vocabulário das sete ações do ledger; o mesmo teste verifica, nas duas
  direções, que ele e o CHECK da migration 096 não divergiram. O FRONTEND
  também importa daqui (`src/lib/whatsapp-instance-format.ts`, rótulos PT-BR)
  — cross-boundary deliberado, mesmo motivo do `whatsapp-implementation-core.ts`.
```

### 1.2 Invariantes novos

```
- **`whatsapp_instances` NÃO usa o trigger genérico `audit_trigger_func()` —
  o histórico vive em `whatsapp_instance_notes`.** `audit_log` tem a policy
  `unit_member_read_audit`, que libera leitura para membro da organização;
  auditar a instância ali entregaria `current_monthly_cost_cents` (o que a
  plataforma paga ao fornecedor) para os membros do próprio cliente — exatamente
  o que o FORCE RLS da tabela existe para impedir.
  [migration 096](supabase/migrations/20260803120000_096_whatsapp_instance_notes.sql).

- **`whatsapp_instance_notes` é `FORCE RLS` COM policy `platform_admin_all_*`,
  não sem policies.** "FORCE RLS sem policies" é o padrão das tabelas de
  CREDENCIAL; este é um ledger irmão de `whatsapp_instance_cycles`/`_alerts` e
  segue o padrão delas (087/088/089).

- **O ledger de observações é escrito DEPOIS da mutação e é best-effort.**
  `notes` continua sendo o resumo ("última observação") e a tabela nova é o
  histórico; as duas saem do mesmo `reason`, na mesma operação. Falha do insert
  não derruba operação já concluída — devolver erro depois do efeito faria o
  operador repetir uma ação já feita. A divergência entre as duas é detectável
  pela telemetria `wa_instance_note_write_failed` com `needsAdminAction`.
  [manage-whatsapp-instances/index.ts](supabase/functions/manage-whatsapp-instances/index.ts).

- **A EF decide o que gravar em `update_instance` por `"campo" in body`** —
  mandar uma chave significa *escreva isto, inclusive `null`*. Formulário que
  envie o objeto inteiro APAGA o canal de quem só quis corrigir o identificador.
  O corpo sai de `buildUpdatePatch`, função pura testada.
  [src/lib/whatsapp-instance-form-core.ts](src/lib/whatsapp-instance-form-core.ts).
```

### 1.3 Tabela de workers — sem mudança

Nenhum worker novo, nenhum cron novo, nenhuma flag nova.

---

## 2. Depende de banco real

- **Migration 096 nunca aplicada.** Idempotência do backfill, guardas de
  INSERT/UPDATE, guarda de tenant e RLS verificados **só por leitura**.
- **O controle positivo do §8 da spec — apagar a instância NÃO apaga a
  observação — não foi executado.** É o caso `NOTE-B` de
  `supabase/tests/whatsapp-instances.integration.md`, e é o que prova que o
  conflito FK × CHECK da 089 não voltou nesta tabela.
- **RLS não foi exercitada pelo client SDK** (casos `NOTE-E`). A afirmação
  "membro da organização não lê o custo do fornecedor" — que é a razão de não
  ter usado `audit_log` — continua não provada contra banco.
- **Nenhum registro de sucesso foi feito.** Toda a verificação manual desta
  entrega usou caminhos de RECUSA, para não escrever no inventário do Ren Sushi
  durante a observação da 6b (até 05/08).

## 3. Depende de deploy

- `manage-whatsapp-instances` precisa ser redeployada para o helper e a action
  `list_instance_notes` existirem. **Enquanto não for, a seção Histórico do
  painel devolve erro** — e o branch `isError` está implementado exatamente para
  esse estado (mostra "Não foi possível carregar o histórico" com botão de
  retry, nunca painel em branco).
- **Ordem quando autorizado:** `supabase db push` da 096 → `supabase functions
  deploy manage-whatsapp-instances` → frontend (push em `main` → Vercel),
  **depois** do merge da 6b → conferir `acl-estatico` na aba Checks.
- Se a EF subir antes da migration, o insert do ledger falha, é logado com
  `needsAdminAction` e a operação principal continua correta — mas a ordem acima
  evita o buraco.
- **Nenhum arquivo de `_shared/` existente mudou**, então o checklist de
  redeploy cruzado não é afetado. O arquivo `_shared/` **novo**
  (`whatsapp-instance-notes-core.ts`) tem um consumidor só.

## 4. Riscos que permanecem (spec §12)

1. **Registrar instância que não existe na Z-API.** O inventário passa a mentir
   sobre custo. Mitigado pelo identificador obrigatório e pelo motivo
   registrado; **não eliminado.**
2. **Disciplina humana.** O fluxo inteiro depende de alguém olhar o painel.
   Mitigado pela cadência do runbook (toda segunda + entre D-7 e D-1);
   **não eliminado.** É a razão de existir da 6a.
3. **`notes` e o ledger podem divergir** se o insert best-effort falhar.
   Escolha consciente: o alternativo é derrubar uma operação já concluída.
4. **Os seis avisos `admin_zapi_*` continuam sem virar e-mail.** Pendência
   `ADMIN_ZAPI_ALERT_TRANSACTIONAL_ENQUEUE`, herdada da 6b. O painel é o único
   canal.

## 5. Fora do escopo desta fase

- `NEW_PROVISION` — bloqueado por
  `NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A`.
- `AWAITING_PROVISION` — a fila já vive em `whatsapp_implementations`.
- Qualquer chamada à Z-API.
- Flag nova, decisão comercial, mudança no worker ou nos núcleos de decisão.
- A concorrência do teto de conexões
  (`FASE-DOIS-PLANOS-PENDENCIAS.md` §1) — continua em aberto e continua
  bloqueando o Plano Automação para novas contratações.

## 6. Verificação manual executada

(Preencher com o resultado de cada caso dos roteiros das Tasks 6, 7 e 8.
Um caso que não foi executado é registrado como **não executado**, com o motivo
— nunca omitido.)

| Caso | Resultado |
|---|---|
| URL colada no identificador → 400 com a mensagem sobre o token | |
| Identificador vazio → botão desabilitado, sem viagem ao servidor | |
| Custo `abc` → recusa na UI, procedência desabilitada | |
| Custo `99.90` → aceito, sem confundir com 9990 reais | |
| Registro repetido da mesma instância → 409, nenhuma linha nova | |
| Alterar só o identificador → o corpo NÃO contém `channel_id` | |
| Nada alterado → "Salvar correção" desabilitado | |
| Instância `ENDED` → botão Reativar ausente | |
| Instância `CANCELLATION_REQUESTED` → botão Reativar presente | |
| Histórico antes da 096 → branch `isError` com retry, não painel em branco | |
| Link "Instâncias WhatsApp" no menu lateral navega | |
| Nome da organização no card, no lugar do UUID | |
| Mobile `<640px` → diálogos viram bottom-sheet | |

## 7. Gate

**`FASE_6C_MERGE = aguardando`** — a branch `dois-planos/fase-6c` não é
mergeada até: (a) a observação da 6b fechar e a `billing-asaas/fase-6b` entrar
em `main`; (b) os casos `NOTE-A..NOTE-E` rodarem contra banco.

Ren Sushi segue vitalício e grátis — override LIFETIME em `system`, `whatsapp` e
`ai` intacto. Nada nesta fase o toca.
````

- [ ] **Step 3: Rodar TODOS os gates e preencher a tabela**

```bash
npm run test
npm run typecheck
npm run lint
npx eslint supabase/functions --max-warnings=0
npm run build
```

Preencher a tabela do §"Gates desta entrega" com os números **reais** da execução. Se algum falhar, corrigir antes de commitar — não registrar um gate como verde sem a saída que o prove.

- [ ] **Step 4: Preencher o §6 com o resultado da verificação manual**

Reexecutar o roteiro consolidado das Tasks 6, 7 e 8 com `npm run dev`, e preencher cada linha da tabela. Caso não executado por causa da observação da 6b entra como **"não executado — observação da 6b em curso"**, nunca em branco.

- [ ] **Step 5: Commit**

```bash
git add docs/billing-asaas/FASE-6C-PENDENCIAS.md supabase/tests/whatsapp-instances.integration.md
git commit -m "docs(6c): pendencias, roteiro de banco NOTE-A..NOTE-E e gates da entrega"
```

- [ ] **Step 6: Review whole-branch**

Rodar os gates de segurança do `CLAUDE.md` sobre o diff completo da branch — a fase toca banco, RLS e Edge Function:

- `saas-shield-br:migration-validator` sobre `supabase/migrations/20260803120000_096_whatsapp_instance_notes.sql`
- `saas-shield-br:rls-auditor` sobre a mesma migration
- `saas-shield-br:tenant-isolation-auditor` sobre o diff
- `saas-shield-br:secret-hunter` sobre o diff

Achado bloqueante vira correção nesta branch. **Não mergear.**

---

## Self-Review

**Cobertura da spec:**

| Seção da spec | Tarefa |
|---|---|
| §5 Tela A — Registrar instância (backfill) | 6 |
| §5 Três restrições da UI mais apertadas que o backend | 6 |
| §5 Conversão de valor, função pura testada | 2 |
| §5 Encadeamento com a confirmação da data | 6 |
| §5 Erros mapeados (409/409/400) | 6 (roteiro manual) |
| §6 Tela B — Corrigir vínculo, `buildUpdatePatch` | 2, 7 |
| §7 Tela C — Reativar, só em `CANCELLATION_REQUESTED` | 7 |
| §8 Tabela `whatsapp_instance_notes` + backfill idempotente | 1 |
| §8 Helper `recordInstanceNote` nas sete ações | 4 |
| §8 `acknowledge_alert`/`resolve_alert` fora de propósito | 4 |
| §8 Depois da mutação, best-effort, `notes` continua | 4 |
| §8 Action `list_instance_notes` com `parseUuid` | 4 |
| §8 UI — seção Histórico, rótulo do motivo | 8 |
| §9 Nome da organização no lugar do UUID | 5 |
| §9 Link no menu lateral | 5 |
| §10 Runbook R1/R2/R3 + cadência | 9 |
| §11 Três módulos puros testados | 1, 2, 3 |
| §11 Roteiro de verificação manual | 6, 7, 8, 10 |
| §11 Verificação do ledger contra banco local | 10 (`NOTE-A..NOTE-E`) |
| §12 Riscos | 10 |
| §13 Ordem de aplicação e redeploy | 10 |
| §14 CLAUDE.md (redirecionado para PENDENCIAS) | 10 |

**Consistência de tipos:** `InstanceNoteAction` (Task 1) é consumido por `recordInstanceNote` (Task 4) e por `NOTE_ACTION_LABEL` (Task 3). `InstanceLinkFields` (Task 2) é consumido pelo `UpdateInstanceDialog` (Task 7). `WhatsappInstanceNote` (Task 5) é consumido pelo `InstanceNotesPanel` (Task 8). `parseCostReais` (Task 2) e `COST_SOURCE_OPTIONS` (Task 3) são consumidos pelo `RegisterInstanceDialog` (Task 6). Nenhum nome divergente entre definição e uso.

**Dependências entre tarefas:** 1 → 3, 4. 2 → 6, 7. 3 → 6, 8. 4 → 5. 5 → 6, 7, 8. As tarefas 1, 2 e 9 não dependem de nada e podem começar em qualquer ordem.
