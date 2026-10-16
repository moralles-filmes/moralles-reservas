# Instâncias encerradas: aba e exclusão sem custo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separar instâncias `ENDED` numa aba própria em `/platform/instancias-whatsapp` e permitir apagar somente instância encerrada que nunca teve custo, com a decisão tomada pelo banco.

**Architecture:** Uma migration acrescenta a ação `DELETE` ao ledger `whatsapp_instance_notes` e cria a RPC service-role-only `delete_whatsapp_instance_without_cost`, que trava, confere estado e custo, grava a nota e apaga numa transação. A Edge Function `manage-whatsapp-instances` ganha `has_cost_history` em `list_instances` e a ação `delete_instance`, traduzida por um núcleo puro novo. A tela divide o Inventário em abas pela URL (`?aba=encerradas`) e só oferece "Apagar" onde o banco vai aceitar.

**Tech Stack:** Postgres/Supabase (plpgsql, migrations), Deno Edge Functions, React 18 + TanStack Query + Radix Tabs, Vitest, harness `supabase/tests/local-preflight` (Postgres 18 local via scoop).

**Spec:** `docs/superpowers/specs/2026-10-15-instancias-encerradas-aba-e-exclusao-design.md`

## Global Constraints

- Branch: `feat/instancias-encerradas-exclusao`. Nada de push, `supabase db push` ou `functions deploy` nesta execução.
- Git: `git add <caminho>` explícito; rodar `git diff --cached --stat` antes de cada commit; NUNCA `git add .`/`-A`, `reset`, `stash`, `checkout --`, `restore` sem `--staged`. Um implementer por vez.
- Commits terminam com a linha `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `npm run typecheck` é `tsc -b --noEmit` (nunca `tsc --noEmit` sem `-b`). `tsconfig.app.json` tem `strict:false`: estreitar união com `x.ok === false`, não `!x.ok`.
- Migration: arquivo `supabase/migrations/20261015223000_whatsapp_instance_delete_without_cost.sql`, idempotente, com `begin;`/`commit;` no próprio arquivo; nunca embutir URL do projeto nem segredo.
- Função nova: `revoke all ... from public, anon, authenticated;` e `grant execute ... to service_role;`, cada um em UMA linha com a assinatura completa `(uuid, text, uuid)`.
- Copy de UI em PT-BR. Edge Function nunca devolve `error.message` do Postgres ao cliente.
- `MIN_REASON_LENGTH = 5` (igual ao que já existe na EF e na tela).
- Toda regra nova entra com teste e controle positivo (reintroduzir o defeito e ver o teste falhar).

## Review Focus

1. Instância encerrada cujo custo foi informado só num ciclo (não no custo atual) — o banco recusa e a tela não oferece Apagar. Coberto por DEL-3 (Task 2) e `canOfferInstanceDelete` (Task 4).
2. Custo informado entre a tela carregar e o clique em Apagar — a RPC trava e reconfere; resposta 409 `INSTANCE_HAS_COST_HISTORY` vira toast com a mensagem da EF. Coberto por DEL-2/DEL-3 e pelo mapeamento (Task 3).
3. EF antiga em produção sem `has_cost_history` (janela entre deploy do front e da EF) — botão não aparece. Coberto por `canOfferInstanceDelete` com campo ausente (Task 4).
4. Aba vazia com outra aba cheia — mostra "Nenhuma instância encerrada." / "Nenhuma instância ativa.", nunca área em branco. Coberto no teste de página (Task 4).
5. Motivo só com espaços chegando à RPC por outro caminho — a RPC recusa com `check_violation` e não apaga. Coberto por DEL-8 (Task 2).

---

### Task 1: Migration, vocabulário `DELETE` e guardas estáticas

**Files:**
- Create: `supabase/migrations/20261015223000_whatsapp_instance_delete_without_cost.sql`
- Modify: `supabase/functions/_shared/whatsapp-instance-notes-core.ts` (lista + cabeçalho)
- Modify: `src/lib/whatsapp-instance-format.ts` (rótulo `DELETE` em `NOTE_ACTION_LABEL`, perto da linha 101)
- Modify: `src/lib/whatsapp-instance-notes-core.test.ts` (ler o CHECK efetivo = último na ordem dos arquivos)
- Modify: `scripts/function-acl-allowlist.json` (chave `_service_only_whatsapp_instance_delete`)
- Modify: `scripts/function-acl-allowlist.test.ts` (describe novo)

**Interfaces:**
- Produces: RPC `public.delete_whatsapp_instance_without_cost(p_instance_id uuid, p_note text, p_actor uuid) returns table (outcome text)`; `outcome ∈ {'deleted','not_found','not_ended','has_cost'}`; motivo vazio levanta `check_violation`. Ação de ledger `"DELETE"` em `INSTANCE_NOTE_ACTIONS`.

- [ ] **Step 1: Atualizar os testes de vocabulário para esperar nove ações (vermelho)**

Em `src/lib/whatsapp-instance-notes-core.test.ts`:
- trocar `import { readFileSync } from "node:fs";` por `import { readFileSync, readdirSync } from "node:fs";`;
- remover a constante `MIGRATION_104` e substituir `actionsInMigrationCheck` por:

```ts
const MIGRATIONS_DIR = join(__dirname, "..", "..", "supabase", "migrations");

/**
 * Os valores do CHECK **EFETIVO** de `action`: o do ÚLTIMO arquivo de migration
 * (ordem de nome = ordem de aplicação) que faz `add constraint
 * whatsapp_instance_notes_action_check`. A 104 e a 20261015223000 fazem
 * `drop constraint if exists` + `add constraint`; fixar o teste numa delas
 * deixaria a próxima ação nova sem cobertura.
 */
function actionsInMigrationCheck(): string[] {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  let last: string[] | null = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const m = sql.match(/add\s+constraint\s+whatsapp_instance_notes_action_check\s+check\s*\(\s*action\s+in\s*\(([^)]*)\)/i);
    if (m) last = Array.from(m[1].matchAll(/'([A-Z_]+)'/g)).map((x) => x[1]);
  }
  if (last) return last;

  const sql = readFileSync(MIGRATION, "utf8");
  const m = sql.match(/action\s+text\s+not\s+null\s+check\s*\(\s*action\s+in\s*\(([^)]*)\)/i);
  if (!m) throw new Error("CHECK de `action` não encontrado na migration 096");
  return Array.from(m[1].matchAll(/'([A-Z_]+)'/g)).map((x) => x[1]);
}
```

- trocar o primeiro `it` do describe `INSTANCE_NOTE_ACTIONS` por:

```ts
  it("tem as sete ações que mudam a instância, a correção de ciclo passado e a exclusão", () => {
    expect([...INSTANCE_NOTE_ACTIONS]).toEqual([
      "REGISTER",
      "UPDATE",
      "REACTIVATE",
      "SET_COST",
      "CONFIRM_CYCLE_DATE",
      "REQUEST_CANCELLATION",
      "CONFIRM_END",
      "CORRECT_CYCLE_COST",
      "DELETE",
    ]);
  });
```

Em `scripts/function-acl-allowlist.test.ts`, acrescentar no fim do arquivo:

```ts
describe('Instâncias WhatsApp: exclusão sem custo', () => {
  // Espaços normalizados: a migration escreve `(uuid, text, uuid)`.
  const sql = readFileSync(join(MIGRATIONS_DIR, '20261015223000_whatsapp_instance_delete_without_cost.sql'), 'utf8')
    .replace(/,\s+/g, ',');
  it('a RPC é service-only, fora da allowlist pública, revogada de PUBLIC/anon/authenticated', () => {
    const signature = 'delete_whatsapp_instance_without_cost(uuid,text,uuid)';
    expect(allowlist._service_only_whatsapp_instance_delete).toEqual([signature]);
    expect(allEntries.some(entry => entry.name === signature.split('(')[0])).toBe(false);
    expect(sql).toContain(`revoke all on function public.${signature} from public,anon,authenticated;`);
    expect(sql).toContain(`grant execute on function public.${signature} to service_role;`);
    expect(sql).not.toMatch(/grant\s+execute[^;]*delete_whatsapp_instance_without_cost[^;]*\b(anon|authenticated|public)\b/i);
  });
});
```

(Conferir no topo do arquivo os nomes reais de `allowlist` e `allEntries`; os describes existentes já os usam.)

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/whatsapp-instance-notes-core.test.ts scripts/function-acl-allowlist.test.ts`
Expected: FAIL — lista de ações sem `DELETE` e migration inexistente (`ENOENT`).

- [ ] **Step 3: Criar a migration**

`supabase/migrations/20261015223000_whatsapp_instance_delete_without_cost.sql`:

```sql
-- Instancias de WhatsApp: exclusao de instancia ENCERRADA e SEM CUSTO.
--
-- Spec: docs/superpowers/specs/2026-10-15-instancias-encerradas-aba-e-exclusao-design.md
--
-- Duas mudancas, uma transacao:
--   1. o ledger `whatsapp_instance_notes` ganha a NONA acao, `DELETE`. Fonte
--      canonica: INSTANCE_NOTE_ACTIONS em _shared/whatsapp-instance-notes-core.ts;
--      src/lib/whatsapp-instance-notes-core.test.ts le o CHECK EFETIVO (o do
--      ultimo arquivo que o redefine) e confere as duas direcoes.
--   2. a RPC `delete_whatsapp_instance_without_cost`, UNICA porta que apaga uma
--      instancia. Apagar com custo destruiria a margem historica: os ciclos
--      saem em cascata (088). Por isso a regra mora AQUI, sob lock, e nao na
--      Edge Function nem na tela.
--
-- O que sobrevive a exclusao: as notas e os alertas ficam com `instance_id`
-- nulo por `on delete set null` (096/089) e guardam `instance_ref`/`subject_id`;
-- o trigger de auditoria da 087 grava a linha apagada em `audit_log`.
--
-- ORDEM DE APLICACAO: esta migration ANTES do deploy de
-- `manage-whatsapp-instances`. Sem ela a acao `delete_instance` responde 500;
-- `list_instances` nao depende dela.

begin;

alter table whatsapp_instance_notes
  drop constraint if exists whatsapp_instance_notes_action_check;

alter table whatsapp_instance_notes
  add constraint whatsapp_instance_notes_action_check check (action in (
    'REGISTER', 'UPDATE', 'REACTIVATE', 'SET_COST',
    'CONFIRM_CYCLE_DATE', 'REQUEST_CANCELLATION', 'CONFIRM_END',
    'CORRECT_CYCLE_COST', 'DELETE'
  ));

create or replace function public.delete_whatsapp_instance_without_cost(
  p_instance_id uuid,
  p_note text,
  p_actor uuid
)
returns table (outcome text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inst record;
begin
  -- O motivo vai para o ledger, que recusa nota vazia; recusar aqui antes de
  -- qualquer lock deixa o erro dizer o que de fato faltou.
  if p_note is null or btrim(p_note) = '' then
    raise exception 'motivo obrigatorio para apagar instancia'
      using errcode = 'check_violation';
  end if;

  select id, organization_id, lifecycle_state, current_monthly_cost_cents
    into v_inst
    from whatsapp_instances
   where id = p_instance_id
   for update;
  if not found then
    return query select 'not_found'::text;
    return;
  end if;

  -- Mesma ordem de lock de confirm_whatsapp_instance_end: instancia -> ciclos.
  -- Travar os ciclos impede que um custo gravado em paralelo num ciclo escape
  -- da conferencia abaixo.
  perform 1 from whatsapp_instance_cycles where instance_id = p_instance_id for update;

  if v_inst.lifecycle_state <> 'ENDED' then
    return query select 'not_ended'::text;
    return;
  end if;

  if v_inst.current_monthly_cost_cents is not null
     or exists (
       select 1 from whatsapp_instance_cycles
        where instance_id = p_instance_id
          and provider_cost_cents is not null
     ) then
    return query select 'has_cost'::text;
    return;
  end if;

  -- A nota nasce ANTES do delete, apontando a instancia viva (a trigger da
  -- 096 exige); o delete a deixa com instance_id nulo e instance_ref intacto.
  insert into whatsapp_instance_notes
    (instance_ref, instance_id, organization_id, action, note, created_by)
  values
    (p_instance_id, p_instance_id, v_inst.organization_id, 'DELETE', p_note, p_actor);

  delete from whatsapp_instances where id = p_instance_id;

  return query select 'deleted'::text;
end;
$$;

comment on function public.delete_whatsapp_instance_without_cost(uuid, text, uuid) is
  'Unica porta de exclusao de instancia: so ENDED e sem custo (atual ou em ciclo). Trava instancia e ciclos, grava nota DELETE e apaga; ciclos saem em cascata, notas e alertas ficam com instance_id nulo. Devolve deleted | not_found | not_ended | has_cost.';

revoke all on function public.delete_whatsapp_instance_without_cost(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.delete_whatsapp_instance_without_cost(uuid, text, uuid) to service_role;

commit;

-- Validacao pos-migration:
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'whatsapp_instance_notes_action_check';   -- contem 'DELETE'
--   select proacl from pg_proc where proname = 'delete_whatsapp_instance_without_cost';
--     -- esperado: so postgres e service_role, sem anon=, authenticated= ou =X/
```

- [ ] **Step 4: Vocabulário, rótulo e allowlist**

Em `supabase/functions/_shared/whatsapp-instance-notes-core.ts`, acrescentar `"DELETE",` depois de `"CORRECT_CYCLE_COST",` e, no cabeçalho, depois do parágrafo da oitava ação, o parágrafo:

```ts
// A NONA, `DELETE`, e gravada so pela RPC `delete_whatsapp_instance_without_cost`
// (migration 20261015223000), na mesma transacao que apaga a instancia. Ela fica
// com `instance_id` nulo e `instance_ref` intacto: e o registro de quem apagou o
// que, e por que.
```

Em `src/lib/whatsapp-instance-format.ts`, em `NOTE_ACTION_LABEL`, depois de `CORRECT_CYCLE_COST`:

```ts
  DELETE: "instância apagada",
```

Em `scripts/function-acl-allowlist.json`, logo depois da chave `_service_only_whatsapp_ops_alerts`:

```json
  "_service_only_whatsapp_instance_delete": [
    "delete_whatsapp_instance_without_cost(uuid,text,uuid)"
  ],
```

- [ ] **Step 5: Rodar e ver passar; controle positivo**

Run: `npx vitest run src/lib/whatsapp-instance-notes-core.test.ts scripts/function-acl-allowlist.test.ts scripts/migration-static-guard.test.ts src/lib/whatsapp-instance-format.test.ts`
Expected: PASS.

Controle positivo (não commitar): tirar `'DELETE'` do CHECK da migration nova e rodar o teste de vocabulário → FAIL em "toda constante do núcleo está no CHECK da migration"; trocar `service_role` por `authenticated` no `grant` → FAIL no teste de ACL. Desfazer as duas edições e rodar de novo → PASS.

Run: `npm run typecheck`
Expected: zero erros (o `Record` de rótulos exige a entrada `DELETE`).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261015223000_whatsapp_instance_delete_without_cost.sql supabase/functions/_shared/whatsapp-instance-notes-core.ts src/lib/whatsapp-instance-format.ts src/lib/whatsapp-instance-notes-core.test.ts scripts/function-acl-allowlist.json scripts/function-acl-allowlist.test.ts
git diff --cached --stat
git commit -m "feat(db): add cost-free deletion RPC for ended WhatsApp instances

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Harness local — casos DEL e controles positivos

**Files:**
- Create: `supabase/tests/local-preflight/65-instance-delete.sql`
- Create: `supabase/tests/local-preflight/66-controles-instance-delete.sql`
- Modify: `supabase/tests/local-preflight/README.md` (linhas na tabela "Os arquivos" e seção nova "### Exclusão de instância sem custo (65/66)" depois de "### Alertas operacionais externos (64)")

**Interfaces:**
- Consumes: migration da Task 1; sequência base do README ("## Rodar", banco `fase6c`), que aplica 087, 088, 090, 096, 104 e 105 e cria `t_res` e `audit_log`.
- Produces: ordinais 301–308 (casos) e 311–312 (controles) em `t_res`.

- [ ] **Step 1: Escrever `65-instance-delete.sql`**

```sql
-- DEL-1..8 — RPC delete_whatsapp_instance_without_cost (migration 20261015223000).
-- Roda no banco da sequencia base do README (fase6c), DEPOIS da migration nova
-- aplicada duas vezes. Ids fixos; cada caso grava veredito em t_res.

create table if not exists t_res (ord int, caso text, veredito text);

-- Fixtures: org A do 02-seed. ENDED exige ended_at (087); custo atual exige
-- cost_source + cost_updated_at (087); ciclo PENDING_REVIEW/CLOSED exige
-- closed_at, e CLOSED exige custo (088).
insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, cycle_source, ended_at)
values
  ('de000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'zapi', 'ENDED', 'ADMIN_CONFIRMED', now()),
  ('de000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'zapi', 'ENDED', 'ADMIN_CONFIRMED', now()),
  ('de000000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', 'zapi', 'ENDED', 'ADMIN_CONFIRMED', now())
on conflict (id) do nothing;

insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, cycle_source, ended_at,
                                current_monthly_cost_cents, cost_source, cost_updated_at)
values ('de000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'zapi', 'ENDED',
        'ADMIN_CONFIRMED', now(), 9990, 'PROVIDER_PANEL', now())
on conflict (id) do nothing;

insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, cycle_source)
values ('de000000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'zapi', 'ACTIVE', 'ADMIN_CONFIRMED')
on conflict (id) do nothing;

insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on, status, closed_at)
select 'de000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
       date '2026-08-01', date '2026-09-01', 'PENDING_REVIEW', now()
where not exists (select 1 from whatsapp_instance_cycles where instance_id = 'de000000-0000-4000-8000-000000000001');

insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on, status,
                                      provider_cost_cents, cost_source, cost_snapshot_at, closed_at)
select 'de000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
       date '2026-08-01', date '2026-09-01', 'CLOSED', 9990, 'PROVIDER_PANEL', now(), now()
where not exists (select 1 from whatsapp_instance_cycles where instance_id = 'de000000-0000-4000-8000-000000000003');

insert into whatsapp_instance_notes (instance_ref, instance_id, organization_id, action, note, created_by)
select 'de000000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001',
       'aaaaaaaa-0000-0000-0000-000000000001', 'REGISTER', 'instancia de teste', '11111111-1111-1111-1111-111111111111'
where not exists (select 1 from whatsapp_instance_notes where instance_ref = 'de000000-0000-4000-8000-000000000001' and action = 'REGISTER');

-- ── DEL-1: encerrada sem custo e apagada; ciclo sai, notas ficam orfas ──
do $$
declare v_out text;
begin
  select outcome into v_out from delete_whatsapp_instance_without_cost(
    'de000000-0000-4000-8000-000000000001', 'era instancia de teste', '11111111-1111-1111-1111-111111111111');
  insert into t_res (ord, caso, veredito) values (301, 'DEL-1 apaga encerrada sem custo; ciclo sai, notas ficam',
    case when v_out = 'deleted'
      and not exists (select 1 from whatsapp_instances where id = 'de000000-0000-4000-8000-000000000001')
      and not exists (select 1 from whatsapp_instance_cycles where instance_id = 'de000000-0000-4000-8000-000000000001')
      and exists (select 1 from whatsapp_instance_notes
                   where instance_ref = 'de000000-0000-4000-8000-000000000001' and action = 'DELETE'
                     and instance_id is null and note = 'era instancia de teste'
                     and created_by = '11111111-1111-1111-1111-111111111111')
      and exists (select 1 from whatsapp_instance_notes
                   where instance_ref = 'de000000-0000-4000-8000-000000000001' and action = 'REGISTER'
                     and instance_id is null)
      and exists (select 1 from audit_log
                   where table_name = 'whatsapp_instances' and action = 'DELETE'
                     and record_id = 'de000000-0000-4000-8000-000000000001')
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── DEL-2: custo atual informado bloqueia ─────────────────────────────
do $$
declare v_out text;
begin
  select outcome into v_out from delete_whatsapp_instance_without_cost(
    'de000000-0000-4000-8000-000000000002', 'tentativa', null);
  insert into t_res (ord, caso, veredito) values (302, 'DEL-2 custo atual bloqueia a exclusao',
    case when v_out = 'has_cost'
      and exists (select 1 from whatsapp_instances where id = 'de000000-0000-4000-8000-000000000002')
      and not exists (select 1 from whatsapp_instance_notes
                       where instance_ref = 'de000000-0000-4000-8000-000000000002' and action = 'DELETE')
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── DEL-3: custo so em ciclo tambem bloqueia ──────────────────────────
do $$
declare v_out text;
begin
  select outcome into v_out from delete_whatsapp_instance_without_cost(
    'de000000-0000-4000-8000-000000000003', 'tentativa', null);
  insert into t_res (ord, caso, veredito) values (303, 'DEL-3 custo so no ciclo bloqueia a exclusao',
    case when v_out = 'has_cost'
      and exists (select 1 from whatsapp_instances where id = 'de000000-0000-4000-8000-000000000003')
      and exists (select 1 from whatsapp_instance_cycles where instance_id = 'de000000-0000-4000-8000-000000000003')
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── DEL-4: instancia nao encerrada nao e apagada ──────────────────────
do $$
declare v_out text;
begin
  select outcome into v_out from delete_whatsapp_instance_without_cost(
    'de000000-0000-4000-8000-000000000004', 'tentativa', null);
  insert into t_res (ord, caso, veredito) values (304, 'DEL-4 ACTIVE nao e apagada',
    case when v_out = 'not_ended'
      and exists (select 1 from whatsapp_instances where id = 'de000000-0000-4000-8000-000000000004')
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── DEL-5: id inexistente ─────────────────────────────────────────────
do $$
declare v_out text;
begin
  select outcome into v_out from delete_whatsapp_instance_without_cost(
    'de000000-0000-4000-8000-0000000000ff', 'tentativa', null);
  insert into t_res (ord, caso, veredito) values (305, 'DEL-5 id inexistente devolve not_found',
    case when v_out = 'not_found' then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── DEL-6: ACL ────────────────────────────────────────────────────────
insert into t_res (ord, caso, veredito)
select 306, 'DEL-6 so service_role executa; PUBLIC, anon e authenticated nao',
  case when not has_function_privilege('anon', 'public.delete_whatsapp_instance_without_cost(uuid,text,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.delete_whatsapp_instance_without_cost(uuid,text,uuid)', 'execute')
    and has_function_privilege('service_role', 'public.delete_whatsapp_instance_without_cost(uuid,text,uuid)', 'execute')
    and not exists (
      select 1 from pg_proc p, aclexplode(p.proacl) a
       where p.proname = 'delete_whatsapp_instance_without_cost' and a.grantee = 0)
  then 'PASSOU' else 'FALHOU' end;

-- ── DEL-7: migration aplicada duas vezes nao duplica nada ─────────────
insert into t_res (ord, caso, veredito)
select 307, 'DEL-7 idempotencia: um CHECK com DELETE, uma funcao',
  case when (select count(*) from pg_constraint where conname = 'whatsapp_instance_notes_action_check') = 1
    and (select pg_get_constraintdef(oid) from pg_constraint
          where conname = 'whatsapp_instance_notes_action_check') like '%''DELETE''%'
    and (select count(*) from pg_proc where proname = 'delete_whatsapp_instance_without_cost') = 1
  then 'PASSOU' else 'FALHOU' end;

-- ── DEL-8: motivo vazio e recusado e nada e apagado ───────────────────
do $$
declare v_state text;
begin
  begin
    perform delete_whatsapp_instance_without_cost('de000000-0000-4000-8000-000000000005', '   ', null);
    v_state := 'apagou';
  exception when check_violation then
    v_state := 'recusou';
  end;
  insert into t_res (ord, caso, veredito) values (308, 'DEL-8 motivo vazio e recusado',
    case when v_state = 'recusou'
      and exists (select 1 from whatsapp_instances where id = 'de000000-0000-4000-8000-000000000005')
    then 'PASSOU' else 'FALHOU' end);
end $$;
```

- [ ] **Step 2: Escrever `66-controles-instance-delete.sql`**

Cada controle sabota o corpo real via `pg_get_functiondef`, chama a RPC dentro de um bloco `begin … exception` que é desfeito por `raise`, e grava o desfecho capturado. O rollback do bloco desfaz a sabotagem E a exclusão; o caso confere ao fim que a função real voltou a recusar.

```sql
-- CONTROLE-DEL-1/2 — controles positivos dos casos DEL-3 e DEL-4.
-- Rodar SEM ON_ERROR_STOP. Cada sabotagem vive num subbloco desfeito por raise,
-- entao nada precisa de reapply; o fim de cada caso confere o corpo real.

create table if not exists t_res (ord int, caso text, veredito text);

-- ── CONTROLE-DEL-1: sem a checagem de custo em ciclo, DEL-3 apagaria ──
do $$
declare v_def text; v_sab text; v_out text; v_after text;
begin
  v_def := pg_get_functiondef('public.delete_whatsapp_instance_without_cost(uuid,text,uuid)'::regprocedure);
  v_sab := regexp_replace(v_def, 'or exists \(\s*select 1 from whatsapp_instance_cycles.*?is not null\s*\)', '');
  if v_sab = v_def then
    insert into t_res (ord, caso, veredito) values (311, 'CONTROLE-DEL-1 sem checar custo do ciclo, apagaria', 'FALHOU (sabotagem nao casou)');
    return;
  end if;
  begin
    execute v_sab;
    select outcome into v_out from delete_whatsapp_instance_without_cost(
      'de000000-0000-4000-8000-000000000003', 'controle', null);
    raise exception 'desfazer controle';
  exception when raise_exception then null;
  end;
  select outcome into v_after from delete_whatsapp_instance_without_cost(
    'de000000-0000-4000-8000-000000000003', 'controle', null);
  insert into t_res (ord, caso, veredito) values (311, 'CONTROLE-DEL-1 sem checar custo do ciclo, apagaria',
    case when v_out = 'deleted' and v_after = 'has_cost' then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── CONTROLE-DEL-2: sem a checagem de estado, DEL-4 apagaria ──────────
do $$
declare v_def text; v_sab text; v_out text; v_after text;
begin
  v_def := pg_get_functiondef('public.delete_whatsapp_instance_without_cost(uuid,text,uuid)'::regprocedure);
  v_sab := replace(v_def, 'if v_inst.lifecycle_state <> ''ENDED'' then', 'if false then');
  if v_sab = v_def then
    insert into t_res (ord, caso, veredito) values (312, 'CONTROLE-DEL-2 sem checar estado, apagaria ACTIVE', 'FALHOU (sabotagem nao casou)');
    return;
  end if;
  begin
    execute v_sab;
    select outcome into v_out from delete_whatsapp_instance_without_cost(
      'de000000-0000-4000-8000-000000000004', 'controle', null);
    raise exception 'desfazer controle';
  exception when raise_exception then null;
  end;
  select outcome into v_after from delete_whatsapp_instance_without_cost(
    'de000000-0000-4000-8000-000000000004', 'controle', null);
  insert into t_res (ord, caso, veredito) values (312, 'CONTROLE-DEL-2 sem checar estado, apagaria ACTIVE',
    case when v_out = 'deleted' and v_after = 'not_ended' then 'PASSOU' else 'FALHOU' end);
end $$;
```

Nota para o implementer: sem flag, o regex do Postgres deixa `.` casar quebra de linha (a flag `n` impediria). `raise exception` sem `using errcode` levanta `P0001` (`raise_exception`), e o `exception when raise_exception` do subbloco o captura, desfazendo o `execute v_sab` (o `create or replace` faz parte da subtransação) e a exclusão. Se o regex do CONTROLE-DEL-1 não casar com o texto devolvido por `pg_get_functiondef`, ajustar o padrão até casar — o caso grava `FALHOU (sabotagem nao casou)` exatamente para não ficar verde sem sabotar.

- [ ] **Step 3: Rodar a sequência base mais os arquivos novos**

Seguir "## Rodar" do README (Git Bash; `PGCLIENTENCODING=UTF8`; porta 55432 ou a que já estiver no ar). Depois da última linha da sequência base (reaplicar 104 e 105), rodar:

```bash
P -f supabase/migrations/20261015223000_whatsapp_instance_delete_without_cost.sql
P -f supabase/migrations/20261015223000_whatsapp_instance_delete_without_cost.sql
P -f supabase/tests/local-preflight/65-instance-delete.sql
"$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d fase6c -f supabase/tests/local-preflight/66-controles-instance-delete.sql
P -c "select ord, caso, veredito from t_res where ord between 301 and 312 order by ord;"
P -c "select ord, caso, veredito from t_res where veredito <> 'PASSOU' order by ord;"
```

Expected: 301–308 e 311–312 todos `PASSOU`; a segunda consulta não traz linha nova desta tarefa (linhas pré-existentes que não sejam `PASSOU`, se houver, registrar no relatório sem corrigir). Depois: `dropdb fase6c` e `pg_ctl stop` se a instância foi iniciada só para isto.

- [ ] **Step 4: README**

Acrescentar à tabela "## Os arquivos":

```markdown
| `65-instance-delete.sql` | DEL-1..8 (ordinais 301–308, migration `20261015223000`): a RPC `delete_whatsapp_instance_without_cost`. Encerrada sem custo é apagada com o ciclo em cascata, as notas (inclusive a `DELETE` nova) ficam com `instance_id` nulo e `instance_ref` intacto, e o `audit_log` grava o DELETE; custo atual, custo só em ciclo, estado não encerrado, id inexistente e motivo vazio são recusados sem apagar; ACL só `service_role`; migration aplicada duas vezes sem duplicar. Roda no banco `fase6c` da sequência base. |
| `66-controles-instance-delete.sql` | CONTROLE-DEL-1/2 (ordinais 311–312): tira do corpo real a checagem de custo em ciclo e depois a de estado, vê a instância de DEL-3/DEL-4 ser apagada, e desfaz a sabotagem por rollback de subbloco — sem reapply. Rodar sem `ON_ERROR_STOP`. |
```

E a seção, depois de "### Alertas operacionais externos (64)":

````markdown
### Exclusão de instância sem custo (65/66)

Continua o banco `fase6c` da sequência base, depois de reaplicar 104 e 105:

```bash
P -f supabase/migrations/20261015223000_whatsapp_instance_delete_without_cost.sql
P -f supabase/migrations/20261015223000_whatsapp_instance_delete_without_cost.sql   # idempotência (DEL-7)
P -f supabase/tests/local-preflight/65-instance-delete.sql
"$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d fase6c -f supabase/tests/local-preflight/66-controles-instance-delete.sql
P -c "select ord, caso, veredito from t_res where ord between 301 and 312 order by ord;"
```

O que NÃO prova: o caminho PostgREST/Edge Function (`delete_instance`) — esse é coberto pelo guardrail textual de `src/lib/whatsapp-instance-ef-write-guard.test.ts` e pelo teste da tela.
````

- [ ] **Step 5: Commit**

```bash
git add supabase/tests/local-preflight/65-instance-delete.sql supabase/tests/local-preflight/66-controles-instance-delete.sql supabase/tests/local-preflight/README.md
git diff --cached --stat
git commit -m "test(db): preflight cases and positive controls for instance deletion

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Edge Function — `has_cost_history` e ação `delete_instance`

**Files:**
- Create: `supabase/functions/_shared/whatsapp-instance-delete-core.ts`
- Create: `src/lib/whatsapp-instance-delete-core.test.ts`
- Modify: `supabase/functions/manage-whatsapp-instances/index.ts` (bloco `list_instances` ~linha 468; ação nova depois do bloco `reactivate`; cabeçalho "ORDEM DE APLICAÇÃO" ganha item 4)
- Modify: `src/lib/whatsapp-instance-ef-write-guard.test.ts` (describes novos)

**Interfaces:**
- Consumes: RPC da Task 1 (`outcome` texto).
- Produces: `deleteInstanceOutcomeResponse(outcome: unknown): { status: 200 | 404 | 409 | 500; body: Record<string, unknown> }`; `hasCostHistory(currentMonthlyCostCents: unknown, instanceId: string, idsWithCycleCost: ReadonlySet<string>): boolean`. `list_instances` devolve cada instância com `has_cost_history: boolean`. Ação `{ action: "delete_instance", instance_id: uuid, reason: string }` → 200 `{ deleted: true }` | 400 | 404 | 409 `{ error, code: "INSTANCE_NOT_ENDED" | "INSTANCE_HAS_COST_HISTORY" }` | 500.

- [ ] **Step 1: Teste do núcleo (vermelho)**

`src/lib/whatsapp-instance-delete-core.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  deleteInstanceOutcomeResponse,
  hasCostHistory,
} from "../../supabase/functions/_shared/whatsapp-instance-delete-core";

describe("deleteInstanceOutcomeResponse", () => {
  it("deleted vira 200", () => {
    expect(deleteInstanceOutcomeResponse("deleted")).toEqual({ status: 200, body: { deleted: true } });
  });
  it("not_found vira 404", () => {
    expect(deleteInstanceOutcomeResponse("not_found").status).toBe(404);
  });
  it("not_ended vira 409 com código próprio", () => {
    const r = deleteInstanceOutcomeResponse("not_ended");
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("INSTANCE_NOT_ENDED");
  });
  it("has_cost vira 409 com código próprio e diz que o histórico fica", () => {
    const r = deleteInstanceOutcomeResponse("has_cost");
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("INSTANCE_HAS_COST_HISTORY");
    expect(String(r.body.error)).toMatch(/custo/);
  });
  it("desfecho desconhecido ou ausente nunca vira sucesso", () => {
    for (const v of [undefined, null, "", "DELETED", 1]) {
      const r = deleteInstanceOutcomeResponse(v);
      expect(r.status).toBe(500);
      expect(r.body).not.toHaveProperty("deleted");
    }
  });
});

describe("hasCostHistory", () => {
  const vazio = new Set<string>();
  it("custo atual informado é histórico", () => {
    expect(hasCostHistory(9990, "i1", vazio)).toBe(true);
    expect(hasCostHistory(0, "i1", vazio)).toBe(true);
  });
  it("custo só em ciclo é histórico", () => {
    expect(hasCostHistory(null, "i1", new Set(["i1"]))).toBe(true);
  });
  it("sem custo atual e sem ciclo com custo não é", () => {
    expect(hasCostHistory(null, "i1", new Set(["outra"]))).toBe(false);
    expect(hasCostHistory(undefined, "i1", vazio)).toBe(false);
  });
});
```

Run: `npx vitest run src/lib/whatsapp-instance-delete-core.test.ts`
Expected: FAIL (módulo inexistente).

- [ ] **Step 2: Núcleo**

`supabase/functions/_shared/whatsapp-instance-delete-core.ts`:

```ts
// Exclusão de instância de WhatsApp — a parte da Edge Function que dá para
// testar sem Deno.
//
// QUEM DECIDE SE PODE APAGAR É O BANCO (RPC `delete_whatsapp_instance_without_cost`,
// migration 20261015223000), sob lock. Este arquivo não reimplementa a regra:
// traduz o desfecho da RPC em resposta HTTP e calcula o `has_cost_history` que
// a tela usa para decidir se OFERECE o botão. Vive em `_shared/` porque o
// `index.ts` de `manage-whatsapp-instances` chama `serve()` no carregamento e
// importa `deno.land` — o vitest não o importa.
//
// Consumidor único: `manage-whatsapp-instances`.

export type DeleteInstanceResponse = {
  status: 200 | 404 | 409 | 500;
  body: Record<string, unknown>;
};

/** Desfecho da RPC → resposta. Desconhecido é 500, nunca sucesso. */
export function deleteInstanceOutcomeResponse(outcome: unknown): DeleteInstanceResponse {
  switch (outcome) {
    case "deleted":
      return { status: 200, body: { deleted: true } };
    case "not_found":
      return { status: 404, body: { error: "Instância não encontrada." } };
    case "not_ended":
      return {
        status: 409,
        body: { error: "Só é possível apagar instância encerrada.", code: "INSTANCE_NOT_ENDED" },
      };
    case "has_cost":
      return {
        status: 409,
        body: {
          error: "Esta instância tem custo registrado e não pode ser apagada: o histórico financeiro dela fica guardado.",
          code: "INSTANCE_HAS_COST_HISTORY",
        },
      };
    default:
      return { status: 500, body: { error: "Não foi possível apagar a instância." } };
  }
}

/**
 * Se a instância tem histórico financeiro: custo atual informado OU algum ciclo
 * com custo. É o que a tela usa para OFERECER "Apagar"; falso negativo é
 * seguro (o banco recusa), falso positivo esconderia um botão legítimo.
 */
export function hasCostHistory(
  currentMonthlyCostCents: unknown,
  instanceId: string,
  idsWithCycleCost: ReadonlySet<string>,
): boolean {
  return typeof currentMonthlyCostCents === "number" || idsWithCycleCost.has(instanceId);
}
```

Run: `npx vitest run src/lib/whatsapp-instance-delete-core.test.ts`
Expected: PASS.

- [ ] **Step 3: Guardrail textual da EF (vermelho)**

Em `src/lib/whatsapp-instance-ef-write-guard.test.ts`, acrescentar no fim:

```ts
describe("delete_instance — a única porta que apaga instância", () => {
  const bloco = blocoDaAcao("delete_instance");

  it("apaga só pela RPC que trava e confere estado e custo", () => {
    expect(bloco).toMatch(/\.rpc\(\s*["'`]delete_whatsapp_instance_without_cost["'`]/);
  });

  it("exige motivo antes de chamar a RPC", () => {
    const motivo = bloco.indexOf("requireReason(");
    expect(motivo).toBeGreaterThan(-1);
    expect(motivo).toBeLessThan(bloco.indexOf(".rpc("));
  });

  it("traduz o desfecho pelo núcleo compartilhado", () => {
    expect(bloco).toMatch(/deleteInstanceOutcomeResponse\(/);
  });

  it("nenhum ponto da EF apaga instância direto pela tabela", () => {
    expect(src).not.toMatch(/from\(\s*["'`]whatsapp_instances["'`]\s*\)\s*\.delete\(/);
  });
});

describe("list_instances — has_cost_history", () => {
  const bloco = blocoDaAcao("list_instances");

  it("lê os ciclos com custo e calcula pelo núcleo", () => {
    expect(bloco).toMatch(/whatsapp_instance_cycles/);
    expect(bloco).toMatch(/provider_cost_cents/);
    expect(bloco).toMatch(/hasCostHistory\(/);
  });

  it("falha na leitura dos ciclos é erro, não 'sem custo'", () => {
    // Duas respostas 500 no bloco: a leitura principal e a dos ciclos.
    expect(bloco.match(/,\s*500\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
```

Run: `npx vitest run src/lib/whatsapp-instance-ef-write-guard.test.ts`
Expected: FAIL (bloco `delete_instance` não encontrado; `hasCostHistory` ausente).

- [ ] **Step 4: Implementar na EF**

Em `supabase/functions/manage-whatsapp-instances/index.ts`:

1. Import, junto dos outros de `_shared`:

```ts
import {
  deleteInstanceOutcomeResponse,
  hasCostHistory,
} from "../_shared/whatsapp-instance-delete-core.ts";
```

2. No cabeçalho "ORDEM DE APLICAÇÃO — TRÊS migrations", trocar "TRÊS" por "QUATRO" e acrescentar:

```ts
// 4. A RPC `delete_whatsapp_instance_without_cost` e a ação `DELETE` no CHECK de
//    `whatsapp_instance_notes` (migration 20261015223000). Sem ela,
//    `delete_instance` responde 500; nenhuma outra ação depende dela.
```

3. Substituir o bloco `list_instances` por:

```ts
    if (action === "list_instances") {
      const { data, error } = await supabase
        .from("whatsapp_instances")
        .select(INSTANCE_COLUMNS)
        .order("created_at", { ascending: false });
      if (error) {
        jsonLog("error", { reqId, evt: "wa_instances_list_failed", err: error.message });
        return jsonResponse(req, { error: "Não foi possível carregar as instâncias." }, 500);
      }

      // `has_cost_history` decide se a tela OFERECE "Apagar"; quem decide se
      // PODE é a RPC. Falha desta leitura é 500 como a principal: devolver
      // "sem custo" por default mostraria o botão onde o banco vai recusar.
      const { data: costed, error: costedErr } = await supabase
        .from("whatsapp_instance_cycles")
        .select("instance_id")
        .not("provider_cost_cents", "is", null);
      if (costedErr) {
        jsonLog("error", { reqId, evt: "wa_instances_cost_history_failed", err: costedErr.message });
        return jsonResponse(req, { error: "Não foi possível carregar as instâncias." }, 500);
      }
      const idsWithCycleCost = new Set(
        (costed ?? []).map((r) => (r as { instance_id: string }).instance_id),
      );

      const instances = (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        return {
          ...r,
          has_cost_history: hasCostHistory(r.current_monthly_cost_cents, r.id as string, idsWithCycleCost),
        };
      });
      return jsonResponse(req, { instances });
    }
```

4. Depois do bloco `if (action === "reactivate") { … }` (antes do próximo `if (action === …)`), inserir:

```ts
    // ── Exclusão: só encerrada e sem custo, decidido pelo banco ──────────
    if (action === "delete_instance") {
      const reason = requireReason(body);
      if (!reason) {
        return jsonResponse(req, { error: "Descreva por que esta instância pode ser apagada." }, 400);
      }

      const id = requireInstanceId(body);
      if (!id) return jsonResponse(req, { error: "instance_id é obrigatório." }, 400);

      // VIA RPC e SEM pré-checagem aqui: trava instância e ciclos, confere
      // estado e custo, grava a nota DELETE e apaga numa transação. Conferir
      // antes na EF reabriria a janela entre conferir e apagar.
      const { data: rpc, error: rpcErr } = await supabase.rpc("delete_whatsapp_instance_without_cost", {
        p_instance_id: id,
        p_note: reason,
        p_actor: callerId,
      });
      if (rpcErr) {
        jsonLog("error", {
          reqId, evt: "wa_instance_delete_failed", instanceId: id,
          err: rpcErr.message, needsAdminAction: true,
        });
        const failed = deleteInstanceOutcomeResponse(null);
        return jsonResponse(req, failed.body, failed.status);
      }

      const row = (Array.isArray(rpc) ? rpc[0] : rpc) as { outcome?: unknown } | undefined;
      const res = deleteInstanceOutcomeResponse(row?.outcome);
      jsonLog(res.status === 200 ? "info" : "warn", {
        reqId, evt: "wa_instance_delete", instanceId: id, outcome: row?.outcome ?? null,
      });
      return jsonResponse(req, res.body, res.status);
    }
```

Conferir que o `blocoDaAcao("delete_instance")` do guardrail não acha uma menção anterior (comentários não podem conter o texto `action === "delete_instance"`).

- [ ] **Step 5: Rodar e ver passar; controle positivo; checagem Deno**

Run: `npx vitest run src/lib/whatsapp-instance-delete-core.test.ts src/lib/whatsapp-instance-ef-write-guard.test.ts`
Expected: PASS.

Controle positivo (não commitar): trocar no bloco `delete_instance` a chamada da RPC por `await supabase.from("whatsapp_instances").delete().eq("id", id)` → guardrail FAIL em "apaga só pela RPC" e "nenhum ponto da EF apaga". Desfazer → PASS.

Run (se `deno` estiver instalado): `deno check supabase/functions/manage-whatsapp-instances/index.ts`
Expected: sem erros (se `deno` não existir, registrar no relatório).

Run: `npx eslint supabase/functions/manage-whatsapp-instances/index.ts supabase/functions/_shared/whatsapp-instance-delete-core.ts --max-warnings=0`
Expected: limpo.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/whatsapp-instance-delete-core.ts src/lib/whatsapp-instance-delete-core.test.ts supabase/functions/manage-whatsapp-instances/index.ts src/lib/whatsapp-instance-ef-write-guard.test.ts
git diff --cached --stat
git commit -m "feat(whatsapp-instances): expose cost history and cost-free delete action

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Tela — abas Ativas/Encerradas e botão Apagar

**Files:**
- Modify: `src/lib/whatsapp-instance-format.ts` (três funções novas no fim)
- Modify: `src/lib/whatsapp-instance-format.test.ts` (describes novos)
- Modify: `src/hooks/useWhatsappInstances.ts` (`has_cost_history?: boolean` em `WhatsappInstance`)
- Modify: `src/pages/platform/WhatsappInstances.tsx`
- Create: `src/pages/platform/WhatsappInstances.test.tsx`

**Interfaces:**
- Consumes: `has_cost_history` e ação `delete_instance` da Task 3.
- Produces: `type InstanceTab = "ativas" | "encerradas"`; `instanceTab(param: string | null): InstanceTab`; `partitionInstancesByTab<T extends { lifecycle_state: string }>(instances: readonly T[]): { ativas: T[]; encerradas: T[] }`; `canOfferInstanceDelete(inst: { lifecycle_state: string; has_cost_history?: boolean }): boolean`.

- [ ] **Step 1: Testes das funções puras (vermelho)**

Acrescentar em `src/lib/whatsapp-instance-format.test.ts` (importando as três funções novas do mesmo módulo já importado no arquivo):

```ts
describe("instanceTab", () => {
  it("só 'encerradas' abre a aba de encerradas", () => {
    expect(instanceTab("encerradas")).toBe("encerradas");
    expect(instanceTab(null)).toBe("ativas");
    expect(instanceTab("ativas")).toBe("ativas");
    expect(instanceTab("ENCERRADAS")).toBe("ativas");
    expect(instanceTab("")).toBe("ativas");
  });
});

describe("partitionInstancesByTab", () => {
  it("ENDED vai para encerradas; todo o resto, inclusive estado desconhecido, para ativas", () => {
    const r = partitionInstancesByTab([
      { id: "a", lifecycle_state: "ACTIVE" },
      { id: "b", lifecycle_state: "ENDED" },
      { id: "c", lifecycle_state: "CANCELLATION_REQUESTED" },
      { id: "d", lifecycle_state: "AWAITING_PROVISION" },
      { id: "e", lifecycle_state: "ALGO_NOVO" },
    ]);
    expect(r.ativas.map((i) => i.id)).toEqual(["a", "c", "d", "e"]);
    expect(r.encerradas.map((i) => i.id)).toEqual(["b"]);
  });
  it("preserva a ordem recebida", () => {
    const r = partitionInstancesByTab([
      { id: "x", lifecycle_state: "ENDED" },
      { id: "y", lifecycle_state: "ENDED" },
    ]);
    expect(r.encerradas.map((i) => i.id)).toEqual(["x", "y"]);
  });
});

describe("canOfferInstanceDelete", () => {
  it("encerrada sem histórico de custo: oferece", () => {
    expect(canOfferInstanceDelete({ lifecycle_state: "ENDED", has_cost_history: false })).toBe(true);
  });
  it("encerrada com custo: não oferece", () => {
    expect(canOfferInstanceDelete({ lifecycle_state: "ENDED", has_cost_history: true })).toBe(false);
  });
  it("não encerrada: não oferece, mesmo sem custo", () => {
    expect(canOfferInstanceDelete({ lifecycle_state: "ACTIVE", has_cost_history: false })).toBe(false);
    expect(canOfferInstanceDelete({ lifecycle_state: "CANCELLATION_REQUESTED", has_cost_history: false })).toBe(false);
  });
  it("campo ausente (EF anterior a esta versão): não oferece", () => {
    expect(canOfferInstanceDelete({ lifecycle_state: "ENDED" })).toBe(false);
  });
});
```

Run: `npx vitest run src/lib/whatsapp-instance-format.test.ts`
Expected: FAIL (funções inexistentes).

- [ ] **Step 2: Funções puras**

No fim de `src/lib/whatsapp-instance-format.ts`:

```ts
/** Aba do Inventário de instâncias. */
export type InstanceTab = "ativas" | "encerradas";

/** Aba a partir de `?aba=`. Só o valor exato "encerradas" abre as encerradas. */
export function instanceTab(param: string | null): InstanceTab {
  return param === "encerradas" ? "encerradas" : "ativas";
}

/**
 * Encerrada = `ENDED`. Todo o resto — inclusive estado que a tela ainda não
 * conhece — fica em Ativas: esconder uma instância viva custa mais que mostrar
 * uma encerrada a mais.
 */
export function partitionInstancesByTab<T extends { lifecycle_state: string }>(
  instances: readonly T[],
): { ativas: T[]; encerradas: T[] } {
  const ativas: T[] = [];
  const encerradas: T[] = [];
  for (const inst of instances) {
    if (inst.lifecycle_state === "ENDED") encerradas.push(inst);
    else ativas.push(inst);
  }
  return { ativas, encerradas };
}

/**
 * Se a tela OFERECE "Apagar". Quem decide se PODE é a RPC
 * `delete_whatsapp_instance_without_cost`; aqui só se evita mostrar botão que o
 * banco vai recusar. `has_cost_history` ausente (EF anterior a esta versão) não
 * oferece.
 */
export function canOfferInstanceDelete(inst: {
  lifecycle_state: string;
  has_cost_history?: boolean;
}): boolean {
  return inst.lifecycle_state === "ENDED" && inst.has_cost_history === false;
}
```

Em `src/hooks/useWhatsappInstances.ts`, no tipo `WhatsappInstance`, depois de `updated_at: string;`:

```ts
  /** Calculado pela EF: custo atual ou algum ciclo com custo. Ausente em EF antiga. */
  has_cost_history?: boolean;
```

Run: `npx vitest run src/lib/whatsapp-instance-format.test.ts`
Expected: PASS.

- [ ] **Step 3: Teste da página (vermelho)**

`src/pages/platform/WhatsappInstances.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import WhatsappInstances from "./WhatsappInstances";

const base = {
  organization_id: "org-1", unit_id: null, channel_id: null, provider: "zapi",
  provider_cycle_anchor_day: null, current_cycle_started_on: null, current_cycle_due_on: null,
  cycle_source: "ADMIN_CONFIRMED", current_monthly_cost_cents: null, cost_source: null, cost_note: null,
  cancellation_requested_at: null, cancellation_reason: null, provider_access_until: null,
  end_confirmation_required_at: null, ended_at: null, planned_provision_on: null,
  last_divergence_kind: null, last_divergence_at: null, notes: null,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
};

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  instances: [] as unknown[],
}));

vi.mock("@/hooks/useWhatsappInstances", () => ({
  useWhatsappInstances: () => ({ isLoading: false, isError: false, data: mocks.instances, refetch: vi.fn() }),
  useWhatsappInstance: () => ({ isLoading: false, isError: false, data: { cycles: [] }, refetch: vi.fn() }),
  useWhatsappInstanceAlerts: () => ({ isLoading: false, isError: false, data: [], refetch: vi.fn() }),
  useWhatsappInstanceAction: () => ({ mutate: mocks.mutate, isPending: false, variables: undefined }),
  usePartnerSimulation: () => ({ mutate: vi.fn(), isPending: false, data: undefined, reset: vi.fn() }),
}));
vi.mock("@/hooks/useAllUnits", () => ({
  useAllUnits: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("@/components/platform/InstanceNotesPanel", () => ({ InstanceNotesPanel: () => null }));
vi.mock("@/components/platform/RegisterInstanceDialog", () => ({ RegisterInstanceDialog: () => null }));
vi.mock("@/components/platform/UpdateInstanceDialog", () => ({ UpdateInstanceDialog: () => null }));

const renderAt = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <WhatsappInstances />
    </MemoryRouter>,
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const setInstances = () => {
  mocks.instances = [
    { ...base, id: "i-ativa", provider_instance_ref: "REF-ATIVA", lifecycle_state: "ACTIVE", has_cost_history: false },
    { ...base, id: "i-teste", provider_instance_ref: "REF-TESTE", lifecycle_state: "ENDED",
      ended_at: "2026-10-14T00:00:00Z", has_cost_history: false },
    { ...base, id: "i-custo", provider_instance_ref: "REF-CUSTO", lifecycle_state: "ENDED",
      ended_at: "2026-10-14T00:00:00Z", current_monthly_cost_cents: 9990, has_cost_history: true },
  ];
};

describe("Instâncias de WhatsApp — abas e exclusão", () => {
  it("sem ?aba mostra só as ativas, com as duas contagens", () => {
    setInstances();
    renderAt("/platform/instancias-whatsapp");
    expect(screen.getByRole("tab", { name: "Ativas (1)" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Encerradas (2)" })).toBeTruthy();
    expect(screen.getByText("REF-ATIVA")).toBeTruthy();
    expect(screen.queryByText("REF-TESTE")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apagar" })).toBeNull();
  });

  it("?aba=encerradas mostra as encerradas e oferece Apagar só na sem custo", () => {
    setInstances();
    renderAt("/platform/instancias-whatsapp?aba=encerradas");
    expect(screen.getByText("REF-TESTE")).toBeTruthy();
    expect(screen.getByText("REF-CUSTO")).toBeTruthy();
    expect(screen.queryByText("REF-ATIVA")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Apagar" })).toHaveLength(1);
  });

  it("Apagar pede motivo e envia delete_instance com o id certo", () => {
    setInstances();
    renderAt("/platform/instancias-whatsapp?aba=encerradas");
    fireEvent.click(screen.getByRole("button", { name: "Apagar" }));
    fireEvent.change(screen.getByLabelText(/Motivo/), { target: { value: "era instância de teste" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0][0]).toEqual({
      action: "delete_instance",
      instance_id: "i-teste",
      reason: "era instância de teste",
    });
  });

  it("aba sem instância diz isso, em vez de área em branco", () => {
    mocks.instances = [{ ...base, id: "i-ativa", provider_instance_ref: "REF-ATIVA", lifecycle_state: "ACTIVE", has_cost_history: false }];
    renderAt("/platform/instancias-whatsapp?aba=encerradas");
    expect(screen.getByText("Nenhuma instância encerrada.")).toBeTruthy();
  });
});
```

Se algum hook/componente filho usado pela página não estiver mockado e quebrar o render (ex.: algum hook de `@/hooks` que faz query real), mockar no mesmo estilo — o objetivo do teste é a lista e o diálogo, não os filhos. Se `ResponsiveDialog` exigir `matchMedia` e `src/test/setup.ts` não o fornecer, mockar `window.matchMedia` no topo do teste.

Run: `npx vitest run src/pages/platform/WhatsappInstances.test.tsx`
Expected: FAIL (sem abas, sem botão Apagar).

- [ ] **Step 4: Implementar na página**

Em `src/pages/platform/WhatsappInstances.tsx`:

1. Imports:

```ts
import { useSearchParams } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
```

e acrescentar `instanceTab`, `partitionInstancesByTab`, `canOfferInstanceDelete` e `type InstanceTab` ao import de `@/lib/whatsapp-instance-format`.

2. Em `ReasonDialogKind`, acrescentar `| { kind: "delete"; instance: WhatsappInstance }` antes de `| null`.

3. Dentro do componente, logo depois de `const instancesQuery = useWhatsappInstances();` e dos outros hooks:

```ts
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = instanceTab(searchParams.get("aba"));
  const { ativas, encerradas } = useMemo(
    () => partitionInstancesByTab(instancesQuery.data ?? []),
    [instancesQuery.data],
  );
  const visibleInstances = tab === "encerradas" ? encerradas : ativas;

  function setTab(next: InstanceTab) {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === "encerradas") params.set("aba", "encerradas");
        else params.delete("aba");
        return params;
      },
      { replace: true },
    );
  }
```

4. Na seção Inventário, logo depois do bloco de estado vazio total (`!instancesQuery.data?.length`), inserir as abas e o vazio por aba:

```tsx
        {!instancesQuery.isLoading && !instancesQuery.isError && !!instancesQuery.data?.length && (
          <Tabs value={tab} onValueChange={(v) => setTab(instanceTab(v))}>
            <TabsList>
              <TabsTrigger value="ativas">Ativas ({ativas.length})</TabsTrigger>
              <TabsTrigger value="encerradas">Encerradas ({encerradas.length})</TabsTrigger>
            </TabsList>
          </Tabs>
        )}

        {!instancesQuery.isLoading && !instancesQuery.isError && !!instancesQuery.data?.length &&
          !visibleInstances.length && (
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">
              {tab === "encerradas" ? "Nenhuma instância encerrada." : "Nenhuma instância ativa."}
            </CardContent>
          </Card>
        )}
```

5. Trocar `{(instancesQuery.data ?? []).map((inst) => {` por `{visibleInstances.map((inst) => {`.

6. Na fileira de botões do cartão, depois do botão "Corrigir vínculo" e antes de "Ver ciclos, margem e histórico":

```tsx
                  {canOfferInstanceDelete(inst) && (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => setDialog({ kind: "delete", instance: inst })}
                    >
                      Apagar
                    </Button>
                  )}
```

7. No `ResponsiveDialogTitle`, acrescentar `{dialog?.kind === "delete" && "Apagar instância"}`. No corpo do diálogo, junto dos outros textos por tipo:

```tsx
            {dialog?.kind === "delete" && (
              <p className="text-sm text-muted-foreground">
                A instância e os ciclos dela somem para sempre. O histórico de ações e os alertas
                continuam guardados, marcados como instância removida. Só instância encerrada e sem
                custo registrado pode ser apagada.
              </p>
            )}
```

8. No `onClick` de Confirmar, antes do ramo `resolve_alert`:

```ts
                  } else if (dialog.kind === "delete") {
                    run(
                      { action: "delete_instance", instance_id: dialog.instance.id, reason },
                      "Instância apagada.",
                    );
```

- [ ] **Step 5: Rodar e ver passar; controle positivo**

Run: `npx vitest run src/pages/platform/WhatsappInstances.test.tsx src/lib/whatsapp-instance-format.test.ts`
Expected: PASS.

Controle positivo (não commitar): em `canOfferInstanceDelete`, trocar `inst.has_cost_history === false` por `true` → teste "oferece Apagar só na sem custo" FAIL (2 botões) e o teste do núcleo FAIL; voltar `visibleInstances.map` para `(instancesQuery.data ?? []).map` → teste "sem ?aba mostra só as ativas" FAIL. Desfazer → PASS.

Run: `npm run typecheck && npx eslint src/pages/platform/WhatsappInstances.tsx src/pages/platform/WhatsappInstances.test.tsx src/lib/whatsapp-instance-format.ts --max-warnings=0`
Expected: limpo.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp-instance-format.ts src/lib/whatsapp-instance-format.test.ts src/hooks/useWhatsappInstances.ts src/pages/platform/WhatsappInstances.tsx src/pages/platform/WhatsappInstances.test.tsx
git diff --cached --stat
git commit -m "feat(platform): split ended WhatsApp instances into a tab and allow cost-free delete

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: CLAUDE.md/AGENTS.md e gates finais

**Files:**
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: tudo das Tasks 1–4.

- [ ] **Step 1: CLAUDE.md**

1. Na seção "Billing — mensalidades", logo depois do bullet que começa com `**No encerramento de instância, a PRIMEIRA confirmação vence nos TRÊS campos`, acrescentar:

```markdown
- **Instância só é apagada pela RPC `delete_whatsapp_instance_without_cost`, e só se estiver `ENDED` e sem custo (nem o atual nem em ciclo).** Os ciclos saem em cascata, então apagar com custo destruiria a margem histórica; a regra mora no banco, sob lock de instância e ciclos, e a tela só oferece o botão onde ele vai passar. Notas (inclusive a `DELETE`) e alertas ficam com `instance_id` nulo e identidade preservada. [migration](supabase/migrations/20261015223000_whatsapp_instance_delete_without_cost.sql).
```

2. No checklist de redeploy, no bullet de `whatsapp-instance-notes-core.ts`, trocar "Carrega o vocabulário das AGORA OITO ações do ledger (`CORRECT_CYCLE_COST` somou-se às sete originais na Fase 6c) — o CHECK efetivo que precisa concordar com esta lista vive na [migration 104](supabase/migrations/20260807100000_104_whatsapp_cycle_cost_and_end.sql), não mais só na 096." por "Carrega o vocabulário das NOVE ações do ledger (`CORRECT_CYCLE_COST` na Fase 6c, `DELETE` na exclusão sem custo) — o CHECK efetivo é o do último arquivo de migration que o redefine (hoje [20261015223000](supabase/migrations/20261015223000_whatsapp_instance_delete_without_cost.sql)), e o teste de acoplamento lê esse." (conferir o texto exato no arquivo antes de editar).

3. No mesmo checklist, depois do bullet de `whatsapp-instance-registration-core.ts`, acrescentar:

```markdown
- **`whatsapp-instance-delete-core.ts`** (núcleo puro, testado em [src/lib/whatsapp-instance-delete-core.test.ts](src/lib/whatsapp-instance-delete-core.test.ts)) → `manage-whatsapp-instances` (único consumidor). Traduz o desfecho da RPC de exclusão e calcula `has_cost_history`; não reimplementa a regra, que é do banco.
```

- [ ] **Step 2: AGENTS.md**

Abrir `AGENTS.md`, achar a seção espelho de Billing/instâncias de WhatsApp e acrescentar o espelho condensado da regra nova (uma linha), e — se o arquivo tiver a linha do vocabulário de notas ou do checklist de redeploy — atualizar igual. Formato do arquivo: frases curtas, mesmo conteúdo semântico do CLAUDE.md.

- [ ] **Step 3: Gates**

Run: `npm run lint`
Expected: 0 erros (warnings pré-existentes permitidos; nenhum novo em arquivo tocado).

Run: `npm run typecheck`
Expected: zero erros.

Run: `npm run test`
Expected: todos passando.

Run: `npm run build`
Expected: sucesso.

Run: `git diff main -- CLAUDE.md AGENTS.md`
Expected: as duas alterações presentes e coerentes.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md
git diff --cached --stat
git commit -m "docs: record cost-free instance deletion invariant

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
