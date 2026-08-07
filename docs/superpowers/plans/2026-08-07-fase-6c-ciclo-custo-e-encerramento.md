# Fase 6c — custo do ciclo, encerramento e teto de registro — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o custo do ciclo do fornecedor ser gravado nos três momentos em que ele é conhecido (nascimento, preenchimento e encerramento), e impedir que uma segunda instância seja registrada na mesma unidade sem decisão consciente.

**Architecture:** Duas RPCs `SECURITY DEFINER` novas assumem as escritas que hoje atravessam duas tabelas sem transação, tomando `FOR UPDATE` na mesma linha de instância que a RPC de rolagem 090 já trava. A Edge Function `manage-whatsapp-instances` passa a delegar a elas, ganha o snapshot de custo na criação do ciclo, uma guarda de unidade duplicada num núcleo puro próprio e uma ação auditada de correção de ciclo passado. O painel expõe as três coisas.

**Tech Stack:** Postgres/plpgsql (migrations Supabase CLI), Deno (Edge Functions), React + TanStack Query + shadcn/ui, vitest, harness `supabase/tests/local-preflight` (Postgres local descartável, sem Docker).

**Spec:** [docs/superpowers/specs/2026-08-07-fase-6c-ciclo-custo-e-encerramento-design.md](../specs/2026-08-07-fase-6c-ciclo-custo-e-encerramento-design.md)

## Global Constraints

- **Ren Sushi é vitalício grátis e não pode quebrar.** Nenhuma migration deste plano escreve, apaga ou corrige dado dele. O ciclo de julho (`PENDING_REVIEW`) só muda por ato humano no painel, depois do deploy.
- **Nenhuma chamada à Z-API**, em nenhum arquivo deste plano.
- **Não reescrever migration já aplicada.** A 088, a 090 e a 096 ficam exatamente como estão; toda correção entra na 104.
- **`whatsapp-connection-allowance-core.ts` não é alterado** — é compartilhado com `manage-channels`.
- **Migration:** número **104**, arquivo `supabase/migrations/20260807100000_104_whatsapp_cycle_cost_and_end.sql`. Timestamp precisa ser maior que `20260803120300`. Idempotente por design. Aplicar **sempre** por `supabase db push`, nunca pelo Studio.
- **ACL obrigatória:** toda função nova em `public` recebe `revoke all on function <assinatura completa> from public, anon, authenticated;` seguido de `grant execute … to service_role;`. `CREATE FUNCTION` concede `EXECUTE` a `PUBLIC` por padrão e o schema `public` é exposto ao PostgREST com a anon key.
- **Migration nunca embute segredo nem a URL do projeto Supabase.** Não há `pg_cron`/`pg_net` nesta migration.
- **`npm run typecheck` é `tsc -b --noEmit`.** Nunca `tsc --noEmit` sem `-b` (vira no-op silencioso). Baseline: zero erros.
- **`tsconfig.app.json` tem `strict: false`** — `if (!x.ok)` NÃO estreita união discriminada. Usar `x.ok === false` ou early-return.
- **Mensagens ao cliente em PT-BR curtas**; detalhe de erro só em `console.error`/`jsonLog`. Nunca devolver `error.message` cru do Postgres.
- **`UPDATE` do Supabase JS que casa zero linhas devolve `error: null`** — escrita com predicado precisa de `.select()` e conferência do tamanho do retorno.
- **Uma Edge Function afetada:** `manage-whatsapp-instances`. `manage-channels` **não** precisa de redeploy.
- **Ordem de aplicação:** migration 104 → deploy de `manage-whatsapp-instances` → deploy do frontend. A EF chama RPC que só existe depois da migration.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/20260807100000_104_whatsapp_cycle_cost_and_end.sql` **(criar)** | Duas RPCs transacionais, extensão do CHECK de `action` do ledger, comentários corrigidos das colunas mortas, ACL. |
| `supabase/functions/_shared/whatsapp-instance-registration-core.ts` **(criar)** | Núcleo puro: esta unidade já tem instância viva? Zero imports. |
| `src/lib/whatsapp-instance-registration-core.test.ts` **(criar)** | Testes do núcleo acima. |
| `supabase/functions/_shared/whatsapp-instance-notes-core.ts` **(modificar)** | Oitava ação `CORRECT_CYCLE_COST`. |
| `src/lib/whatsapp-instance-notes-core.test.ts` **(modificar)** | Passa a conferir o CHECK **efetivo** (096 estendida pela 104). |
| `src/lib/whatsapp-instance-format.ts` **(modificar)** | Rótulo PT-BR da ação nova. |
| `supabase/functions/manage-whatsapp-instances/index.ts` **(modificar)** | Guarda de unidade, snapshot em `confirm_cycle_date`, RPCs em `set_cost`/`confirm_end`, ação `correct_cycle_cost`. |
| `src/hooks/useWhatsappInstances.ts` **(modificar)** | `cost_source` no tipo do ciclo. |
| `src/components/platform/RegisterInstanceDialog.tsx` **(modificar)** | Confirmação de unidade já ocupada; copy do custo. |
| `src/pages/platform/WhatsappInstances.tsx` **(modificar)** | Copy do `set_cost` + procedência; ação "corrigir custo" em `PENDING_REVIEW`. |
| `supabase/tests/local-preflight/05-ciclo-custo-e-fim.sql` **(criar)** | Casos COST-1..4, END-1..3, CORR-1..2. |
| `supabase/tests/local-preflight/06-controles-104.sql` **(criar)** | Controles positivos 3 e 4. |
| `supabase/tests/local-preflight/README.md` **(modificar)** | Sequência com 090 e 104; descrição dos controles novos. |
| `CLAUDE.md` **(modificar)** | Quatro invariantes novos. |
| `docs/billing-asaas/FASE-6C-PENDENCIAS.md` **(modificar)** | Correção do diagnóstico do §2.2 e registro do fechamento dos quatro achados. |

---

## Task 1: Núcleo puro da guarda de unidade duplicada

**Files:**
- Create: `supabase/functions/_shared/whatsapp-instance-registration-core.ts`
- Test: `src/lib/whatsapp-instance-registration-core.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `checkUnitInstanceConflict(input: UnitConflictInput): UnitConflictResult`, tipos `UnitConflictInput`, `UnitConflictCandidate`, `UnitConflictResult`. Consumido pela Task 6.

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/lib/whatsapp-instance-registration-core.test.ts`:

```ts
/**
 * Nucleo da guarda de unidade duplicada (§2.1 da verificacao manual da 6c).
 *
 * SEPARADO de `checkConnectionAllowance` DE PROPOSITO: aquele nucleo e
 * compartilhado com `manage-channels`, que responde "posso conectar mais um
 * canal?" e nao tem nada a ver com unidade duplicada. Um campo novo la
 * obrigaria o `manage-channels` a preencher entrada que nao lhe diz respeito e
 * a interpretar um reasonCode que nunca produz.
 */
import { describe, expect, it } from "vitest";
import {
  checkUnitInstanceConflict,
} from "../../supabase/functions/_shared/whatsapp-instance-registration-core";

describe("checkUnitInstanceConflict", () => {
  it("libera quando o registro nao tem unidade — nao ha chave pela qual perguntar", () => {
    const r = checkUnitInstanceConflict({
      unitScoped: false,
      conflicts: [{ id: "i-1", lifecycleState: "ACTIVE" }],
      acknowledged: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok === true) expect(r.policy).toBe("NO_UNIT_SCOPE");
  });

  it("libera quando a unidade nao tem nenhuma instancia viva", () => {
    const r = checkUnitInstanceConflict({
      unitScoped: true,
      conflicts: [],
      acknowledged: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok === true) expect(r.policy).toBe("NO_CONFLICT");
  });

  it("recusa quando a unidade ja tem instancia viva e nao houve reconhecimento", () => {
    const r = checkUnitInstanceConflict({
      unitScoped: true,
      conflicts: [{ id: "i-1", lifecycleState: "ACTIVE" }],
      acknowledged: false,
    });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.code).toBe("UNIT_ALREADY_HAS_INSTANCE");
  });

  it("CANCELLATION_REQUESTED conta como viva — ela custa ate a confirmacao do fim", () => {
    const r = checkUnitInstanceConflict({
      unitScoped: true,
      conflicts: [{ id: "i-1", lifecycleState: "CANCELLATION_REQUESTED" }],
      acknowledged: false,
    });
    expect(r.ok).toBe(false);
  });

  it("libera com reconhecimento explicito — segunda instancia legitima e ato consciente", () => {
    const r = checkUnitInstanceConflict({
      unitScoped: true,
      conflicts: [{ id: "i-1", lifecycleState: "ACTIVE" }],
      acknowledged: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok === true) expect(r.policy).toBe("ACKNOWLEDGED");
  });

  it("reconhecimento sem conflito nenhum nao inventa politica de excecao", () => {
    const r = checkUnitInstanceConflict({
      unitScoped: true,
      conflicts: [],
      acknowledged: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok === true) expect(r.policy).toBe("NO_CONFLICT");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/whatsapp-instance-registration-core.test.ts`
Expected: FAIL — `Failed to resolve import ".../whatsapp-instance-registration-core"`.

- [ ] **Step 3: Implementar o núcleo**

Criar `supabase/functions/_shared/whatsapp-instance-registration-core.ts`:

```ts
/**
 * Nucleo PURO: esta UNIDADE ja tem instancia viva? ZERO IMPORTS.
 *
 * SEPARADO de `whatsapp-connection-allowance-core.ts` DE PROPOSITO. Aquele
 * nucleo responde "o modelo comercial permite mais uma conexao?" e e
 * compartilhado com `manage-channels`; este responde "esta unidade ja esta
 * ocupada?" e so o registro de instancia pergunta. Fundir os dois levaria um
 * reasonCode sem sentido para o `manage-channels`.
 *
 * O DEFEITO QUE ELE FECHA: sob cortesia vitalicia, `checkConnectionAllowance`
 * nao consulta `activeInstanceCount` (a contagem so e lida no ramo
 * PLAN_DECLARED), entao duas instancias na mesma unidade coexistiam sem que
 * nada reclamasse.
 *
 * NAO E FAIL-CLOSED CEGO: registro legitimo de segunda instancia continua
 * possivel como ATO CONSCIENTE — a recusa acontece uma vez, a tela mostra o que
 * ja existe e o operador confirma.
 */

export interface UnitConflictCandidate {
  id: string;
  /** `lifecycle_state` da instancia ja registrada na unidade. */
  lifecycleState: string;
}

export interface UnitConflictInput {
  /**
   * `false` quando `unit_id` vem nulo. Sem unidade nao ha chave pela qual
   * perguntar, e a ORGANIZACAO nao serve: rede com cinco unidades tem
   * legitimamente cinco instancias. O indice unico de `provider_instance_ref`
   * continua sendo a rede nesse caso.
   */
  unitScoped: boolean;
  /**
   * Instancias `lifecycle_state <> 'ENDED'` ja registradas NA MESMA UNIDADE.
   * `CANCELLATION_REQUESTED` entra: ela custa ate a confirmacao do fim.
   */
  conflicts: UnitConflictCandidate[];
  /** O corpo trouxe `acknowledge_unit_conflict: true`. */
  acknowledged: boolean;
}

export type UnitConflictResult =
  | { ok: true; policy: "NO_UNIT_SCOPE" | "NO_CONFLICT" | "ACKNOWLEDGED" }
  | { ok: false; code: "UNIT_ALREADY_HAS_INSTANCE" };

export function checkUnitInstanceConflict(input: UnitConflictInput): UnitConflictResult {
  if (!input.unitScoped) return { ok: true, policy: "NO_UNIT_SCOPE" };
  if (input.conflicts.length === 0) return { ok: true, policy: "NO_CONFLICT" };
  if (input.acknowledged) return { ok: true, policy: "ACKNOWLEDGED" };
  return { ok: false, code: "UNIT_ALREADY_HAS_INSTANCE" };
}

/** Mensagem PT-BR da recusa. Curta, e diz o que fazer. */
export const UNIT_ALREADY_HAS_INSTANCE_MESSAGE =
  "Esta unidade já tem instância registrada. Confirme que quer registrar uma segunda.";
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/whatsapp-instance-registration-core.test.ts`
Expected: PASS, 6 testes.

- [ ] **Step 5: Gates e commit**

```bash
npm run lint
npm run typecheck
git add supabase/functions/_shared/whatsapp-instance-registration-core.ts src/lib/whatsapp-instance-registration-core.test.ts
git commit -m "feat(6c): nucleo puro da guarda de unidade duplicada"
```

---

## Task 2: Migration 104 e a oitava ação do ledger

**Files:**
- Create: `supabase/migrations/20260807100000_104_whatsapp_cycle_cost_and_end.sql`
- Modify: `supabase/functions/_shared/whatsapp-instance-notes-core.ts`
- Modify: `src/lib/whatsapp-instance-notes-core.test.ts`
- Modify: `src/lib/whatsapp-instance-format.ts:101-113`

**Interfaces:**
- Consumes: nada.
- Produces: RPCs `public.set_whatsapp_instance_cost(uuid, integer, text, text, uuid)` retornando `(instance_found boolean, open_cycle_id uuid, cycle_filled boolean)` e `public.confirm_whatsapp_instance_end(uuid, text, uuid)` retornando `(instance_found boolean, lifecycle_before text, closed_cycle_id uuid, closed_cycle_status text)`. Constante `"CORRECT_CYCLE_COST"` em `INSTANCE_NOTE_ACTIONS`. Consumidos pelas Tasks 3, 4, 7 e 8.

- [ ] **Step 1: Escrever o teste que falha**

Editar `src/lib/whatsapp-instance-notes-core.test.ts`. Substituir a função `actionsInMigrationCheck` e o primeiro caso do `describe("INSTANCE_NOTE_ACTIONS")`:

```ts
const MIGRATION_104 = join(
  __dirname,
  "..",
  "..",
  "supabase",
  "migrations",
  "20260807100000_104_whatsapp_cycle_cost_and_end.sql",
);

/**
 * Os valores do CHECK **EFETIVO** de `action`, e nao os da 096 isolada.
 *
 * A 104 faz `drop constraint if exists` + `add constraint` com a lista
 * estendida: depois de aplicada, o CHECK que o banco tem e o DELA. Ler so a
 * 096 fixaria o teste numa foto anterior a migration seguinte — e o proximo
 * valor novo passaria a exigir editar a 096, que e migration aplicada e nao se
 * reescreve.
 */
function actionsInMigrationCheck(): string[] {
  const sql104 = readFileSync(MIGRATION_104, "utf8");
  const m104 = sql104.match(/add\s+constraint\s+whatsapp_instance_notes_action_check\s+check\s*\(\s*action\s+in\s*\(([^)]*)\)/i);
  if (m104) return Array.from(m104[1].matchAll(/'([A-Z_]+)'/g)).map((x) => x[1]);

  const sql = readFileSync(MIGRATION, "utf8");
  const m = sql.match(/action\s+text\s+not\s+null\s+check\s*\(\s*action\s+in\s*\(([^)]*)\)/i);
  if (!m) throw new Error("CHECK de `action` não encontrado na migration 096");
  return Array.from(m[1].matchAll(/'([A-Z_]+)'/g)).map((x) => x[1]);
}
```

E o caso da lista literal passa a ser:

```ts
  it("tem as sete ações que mudam a instância mais a correção de ciclo passado", () => {
    expect([...INSTANCE_NOTE_ACTIONS]).toEqual([
      "REGISTER",
      "UPDATE",
      "REACTIVATE",
      "SET_COST",
      "CONFIRM_CYCLE_DATE",
      "REQUEST_CANCELLATION",
      "CONFIRM_END",
      "CORRECT_CYCLE_COST",
    ]);
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/whatsapp-instance-notes-core.test.ts`
Expected: FAIL — `ENOENT` ao ler a migration 104, e a lista literal com 7 elementos contra 8 esperados.

- [ ] **Step 3: Escrever a migration 104**

Criar `supabase/migrations/20260807100000_104_whatsapp_cycle_cost_and_end.sql`:

```sql
-- Custo do ciclo e encerramento — as duas escritas que atravessam duas tabelas.
--
-- O DEFEITO QUE ESTA MIGRATION FECHA (verificacao manual da Fase 6c, §2.2 e
-- §2.3): `set_cost` gravava so em `whatsapp_instances` e nunca alcancava o
-- ciclo aberto; `confirm_end` deixava o ultimo ciclo OPEN para sempre, porque a
-- rolagem da 090 pula `lifecycle_state` fora de ACTIVE/CANCELLATION_REQUESTED.
--
-- POR QUE RPC E NAO DUAS ESCRITAS NA EDGE FUNCTION: PostgREST nao tem
-- transacao. Se a segunda escrita falha, o resultado e exatamente o bug de
-- hoje, em silencio. E ha corrida real com o worker diario — a rolagem toma
-- FOR UPDATE na instancia; escrita fora dessa trava pode preencher um ciclo que
-- o worker esta fechando no mesmo instante. As duas funcoes abaixo tomam A
-- MESMA trava, pelo principio que a 090 ja declara: juntos ou nao acontecem.
--
-- NAO REESCREVE A 090 NEM A 088. Migration aplicada nao se reescreve; o que
-- estiver errado no texto delas e corrigido AQUI, por `comment on column`.
--
-- NAO TOCA DADO DE NENHUMA ORGANIZACAO. Cria funcoes, estende um CHECK e
-- corrige comentarios.

begin;

-- =====================================================================
-- 1. Custo: instancia + ciclo aberto, numa transacao
-- =====================================================================
-- PRINCIPIO DA COMPETENCIA PRESERVADO. O ciclo congela o custo na ABERTURA e
-- representa a competencia que ja comecou — por isso valor JA GRAVADO nunca e
-- sobrescrito aqui. Preencher um NULO nao e reescrever historia: e registrar o
-- que nunca se soube. Custo errado ja gravado tem porta propria e auditada
-- (acao `correct_cycle_cost` do painel, restrita a PENDING_REVIEW).
create or replace function public.set_whatsapp_instance_cost(
  p_instance_id uuid,
  p_cost_cents integer,
  p_cost_source text,
  p_cost_note text,
  p_actor uuid
)
returns table (instance_found boolean, open_cycle_id uuid, cycle_filled boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inst record;
  v_open record;
  v_filled boolean := false;
begin
  select * into v_inst from whatsapp_instances where id = p_instance_id for update;
  if not found then
    return query select false, null::uuid, false;
    return;
  end if;

  update whatsapp_instances
     set current_monthly_cost_cents = p_cost_cents,
         cost_source = p_cost_source,
         -- Carimbo e autoria so existem quando existe numero. Custo
         -- desconhecido com data de atualizacao afirmaria que alguem informou
         -- algo.
         cost_updated_at = case when p_cost_cents is null then null else now() end,
         cost_updated_by = case when p_cost_cents is null then null else p_actor end,
         cost_note = p_cost_note,
         updated_by = p_actor,
         updated_at = now()
   where id = p_instance_id;

  select * into v_open
  from whatsapp_instance_cycles
  where instance_id = p_instance_id and status = 'OPEN'
  for update;

  if not found then
    return query select true, null::uuid, false;
    return;
  end if;

  -- As DUAS condicoes importam. `provider_cost_cents is null` protege o valor
  -- congelado; `p_cost_cents is not null` impede que "passei a nao saber" apague
  -- do ciclo um custo que ja estava la.
  if v_open.provider_cost_cents is null and p_cost_cents is not null then
    update whatsapp_instance_cycles
       set provider_cost_cents = p_cost_cents,
           cost_source = p_cost_source,
           cost_snapshot_at = now()
     where id = v_open.id;
    v_filled := true;
  end if;

  return query select true, v_open.id, v_filled;
end;
$$;

comment on function public.set_whatsapp_instance_cost(uuid, integer, text, text, uuid) is
  'Grava o custo na instancia e PREENCHE o ciclo OPEN quando ele esta sem custo. Nunca sobrescreve valor ja congelado. Transacional, sob FOR UPDATE na instancia — a mesma trava da rolagem 090.';

-- =====================================================================
-- 2. Encerramento: instancia ENDED + fecho do ciclo aberto
-- =====================================================================
-- O CICLO MANTEM `provider_due_on`. O fornecedor cobrou o periodo inteiro;
-- encurtar a data mentiria sobre o custo. Encerrar cedo FECHA o ciclo, nao o
-- reduz.
--
-- A TRANSICAO DE ESTADO NAO E REVALIDADA AQUI. `canTransition` roda na Edge
-- Function; duplicar a maquina de estados em plpgsql criaria a segunda verdade
-- que a Fase 6b existe para impedir.
create or replace function public.confirm_whatsapp_instance_end(
  p_instance_id uuid,
  p_note text,
  p_actor uuid
)
returns table (
  instance_found boolean,
  lifecycle_before text,
  closed_cycle_id uuid,
  closed_cycle_status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inst record;
  v_open record;
  v_status text;
  v_closed_id uuid := null;
begin
  select * into v_inst from whatsapp_instances where id = p_instance_id for update;
  if not found then
    return query select false, null::text, null::uuid, null::text;
    return;
  end if;

  update whatsapp_instances
     set lifecycle_state = 'ENDED',
         -- Repeticao NAO reescreve a data da primeira confirmacao.
         ended_at = coalesce(ended_at, now()),
         ended_by = p_actor,
         end_confirmation_note = p_note,
         -- Encerrada nao guarda vinculo de canal: libera o indice unico de
         -- channel_id para uma instancia futura no mesmo canal.
         channel_id = null,
         -- E o que faz o painel parar de anunciar "em curso" numa instancia
         -- encerrada. Mesmo que a 090 faz no ramo CLOSED_NO_REOPEN.
         current_cycle_started_on = null,
         current_cycle_due_on = null,
         updated_by = p_actor,
         updated_at = now()
   where id = p_instance_id;

  select * into v_open
  from whatsapp_instance_cycles
  where instance_id = p_instance_id and status = 'OPEN'
  for update;

  if found then
    -- MESMA regra do vencimento (090): custo desconhecido nao fecha como
    -- financeiramente concluido.
    v_status := case when v_open.provider_cost_cents is null then 'PENDING_REVIEW' else 'CLOSED' end;
    update whatsapp_instance_cycles
       set status = v_status,
           closed_at = now(),
           -- Ha humano identificado aqui, ao contrario da rolagem automatica.
           closed_by = p_actor
     where id = v_open.id
    returning id into v_closed_id;
  end if;

  return query select true, v_inst.lifecycle_state::text, v_closed_id, v_status;
end;
$$;

comment on function public.confirm_whatsapp_instance_end(uuid, text, uuid) is
  'Marca a instancia ENDED, limpa a projecao de ciclo e FECHA o ciclo OPEN pela regra do vencimento (sem custo -> PENDING_REVIEW). Idempotente. Nao revalida a transicao — isso e da Edge Function.';

-- =====================================================================
-- 3. Vocabulario do ledger de observacoes: a OITAVA acao
-- =====================================================================
-- A fonte canonica continua sendo INSTANCE_NOTE_ACTIONS em
-- _shared/whatsapp-instance-notes-core.ts. O acoplamento e verificado nas duas
-- direcoes por src/lib/whatsapp-instance-notes-core.test.ts, que le o CHECK
-- EFETIVO — o desta migration, nao o da 096.
--
-- `drop constraint if exists` antes de `add`: idempotente, e a 096 nao e
-- reescrita.
alter table whatsapp_instance_notes
  drop constraint if exists whatsapp_instance_notes_action_check;

alter table whatsapp_instance_notes
  add constraint whatsapp_instance_notes_action_check check (action in (
    'REGISTER', 'UPDATE', 'REACTIVATE', 'SET_COST',
    'CONFIRM_CYCLE_DATE', 'REQUEST_CANCELLATION', 'CONFIRM_END',
    'CORRECT_CYCLE_COST'
  ));

-- =====================================================================
-- 4. As tres colunas mortas — corrigir a PROMESSA, nao o comportamento
-- =====================================================================
-- A 090 afirma, num comentario inline, que "receita e margem ficam NULL aqui e
-- sao preenchidas pelo worker". E FALSO: o worker calcula a margem EM MEMORIA,
-- para o payload do alerta ECONOMIC_IMBALANCE, e nunca a grava. Os unicos dois
-- produtores desta tabela (o insert de `confirm_cycle_date` e a rolagem 090)
-- nao tocam nenhuma das tres colunas.
--
-- A 090 NAO e reescrita — migration aplicada nao se reescreve. O registro fica
-- aqui, onde o proximo leitor da coluna o encontra.
--
-- Persistir margem ficou FORA DE ESCOPO por decisao: o alerta ja a calcula ao
-- vivo e nao ha consumidor da versao persistida. Quando houver, e quem escrever
-- o produtor que corrige estes comentarios.
comment on column whatsapp_instance_cycles.customer_revenue_cents is
  'NAO E ESCRITA POR NENHUM PRODUTOR (Fase 6b/6c). Nem o insert de confirm_cycle_date nem a rolagem 090 a preenchem. O comentario inline da 090 que promete preenchimento pelo worker e falso.';

comment on column whatsapp_instance_cycles.revenue_source is
  'NAO E ESCRITA POR NENHUM PRODUTOR (Fase 6b/6c). Ver customer_revenue_cents.';

comment on column whatsapp_instance_cycles.gross_margin_cents is
  'NAO E ESCRITA POR NENHUM PRODUTOR (Fase 6b/6c). A margem e calculada EM MEMORIA pelo worker de ciclos, para o payload do alerta ECONOMIC_IMBALANCE, e descartada.';

-- =====================================================================
-- 5. ACL — CREATE FUNCTION concede EXECUTE a PUBLIC por padrao
-- =====================================================================
revoke all on function public.set_whatsapp_instance_cost(uuid, integer, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.confirm_whatsapp_instance_end(uuid, text, uuid)
  from public, anon, authenticated;

grant execute on function public.set_whatsapp_instance_cost(uuid, integer, text, text, uuid)
  to service_role;
grant execute on function public.confirm_whatsapp_instance_end(uuid, text, uuid)
  to service_role;

commit;

-- =====================================================================
-- Validacao pos-migration
-- =====================================================================
-- 1. ACL das duas funcoes (esperado: nenhuma com anon= ou authenticated=):
--   select proname, proacl from pg_proc
--    where proname in ('set_whatsapp_instance_cost', 'confirm_whatsapp_instance_end');
--
-- 2. search_path fixado nas duas (esperado: search_path=public em cada uma):
--   select proname, proconfig from pg_proc
--    where proname in ('set_whatsapp_instance_cost', 'confirm_whatsapp_instance_end');
--
-- 3. CHECK estendido (esperado: a expressao contem CORRECT_CYCLE_COST):
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'whatsapp_instance_notes_action_check';
--
-- 4. Reaplicar a migration inteira nao muda nada (idempotencia): rodar de novo
--    e repetir os itens 1 a 3.
--
-- 5. COMPORTAMENTO, nao estrutura — casos COST-1..4, END-1..3 e CORR-1..2 em
--    supabase/tests/local-preflight/05-ciclo-custo-e-fim.sql, com os controles
--    positivos do 06.
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- As duas funcoes podem ser dropadas sem perda de dado. O CHECK volta a lista
-- de sete SOMENTE se nenhuma linha CORRECT_CYCLE_COST existir — conferir antes,
-- senao o `add constraint` falha e o rollback aborta pela metade.
--   select count(*) from whatsapp_instance_notes where action = 'CORRECT_CYCLE_COST';
--   drop function if exists public.set_whatsapp_instance_cost(uuid, integer, text, text, uuid);
--   drop function if exists public.confirm_whatsapp_instance_end(uuid, text, uuid);
--   alter table whatsapp_instance_notes drop constraint if exists whatsapp_instance_notes_action_check;
--   alter table whatsapp_instance_notes add constraint whatsapp_instance_notes_action_check
--     check (action in ('REGISTER','UPDATE','REACTIVATE','SET_COST',
--                       'CONFIRM_CYCLE_DATE','REQUEST_CANCELLATION','CONFIRM_END'));
```

- [ ] **Step 4: Adicionar a oitava constante ao núcleo**

Em `supabase/functions/_shared/whatsapp-instance-notes-core.ts`, trocar o bloco de comentário sobre "AS SETE" e a lista:

```ts
// AS SETE PRIMEIRAS SAO AS ACOES QUE MUDAM A INSTANCIA E PEDEM MOTIVO. A
// oitava, `CORRECT_CYCLE_COST`, muda um CICLO PASSADO e nao a instancia — ela
// entra aqui, e nao num ledger proprio, porque e a unica escrita capaz de
// alterar custo ja gravado, e o lugar onde alguem procura por isso e a linha do
// tempo da instancia.

export const INSTANCE_NOTE_ACTIONS = [
  "REGISTER",
  "UPDATE",
  "REACTIVATE",
  "SET_COST",
  "CONFIRM_CYCLE_DATE",
  "REQUEST_CANCELLATION",
  "CONFIRM_END",
  "CORRECT_CYCLE_COST",
] as const;
```

E em `src/lib/whatsapp-instance-format.ts`, no mapa `NOTE_ACTION_LABEL`, acrescentar após `CONFIRM_END`:

```ts
  CORRECT_CYCLE_COST: "custo de ciclo corrigido",
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run src/lib/whatsapp-instance-notes-core.test.ts`
Expected: PASS. O mapa `NOTE_ACTION_LABEL` é `Record<(typeof INSTANCE_NOTE_ACTIONS)[number], string>`, então esquecer o rótulo quebra o `typecheck`.

- [ ] **Step 6: Aplicar a migration contra Postgres local e conferir idempotência**

```bash
PG="$USERPROFILE/scoop/apps/postgresql/current/bin"
"$PG/pg_ctl.exe" -D "$USERPROFILE/scoop/apps/postgresql/current/data" -l /tmp/pg.log -o "-p 55432" start
"$PG/dropdb.exe"   -h 127.0.0.1 -p 55432 -U postgres --if-exists fase6c
"$PG/createdb.exe" -h 127.0.0.1 -p 55432 -U postgres fase6c
P() { "$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d fase6c -v ON_ERROR_STOP=1 "$@"; }

P -f supabase/tests/local-preflight/00-bootstrap.sql
P -f supabase/tests/local-preflight/01-audit.sql
P -f supabase/migrations/20260801200000_087_whatsapp_instances.sql
P -f supabase/migrations/20260801200100_088_whatsapp_instance_cycles.sql
P -f supabase/migrations/20260801200300_090_whatsapp_instance_cycle_rpc.sql
P -f supabase/tests/local-preflight/02-seed.sql
P -f supabase/migrations/20260803120000_096_whatsapp_instance_notes.sql
P -f supabase/migrations/20260807100000_104_whatsapp_cycle_cost_and_end.sql
P -f supabase/migrations/20260807100000_104_whatsapp_cycle_cost_and_end.sql   # 2a vez: idempotente
P -c "select pg_get_constraintdef(oid) from pg_constraint where conname = 'whatsapp_instance_notes_action_check';"
P -c "select proname, proacl from pg_proc where proname in ('set_whatsapp_instance_cost','confirm_whatsapp_instance_end');"
```

Expected: as duas aplicações concluem sem erro; o `constraintdef` contém `CORRECT_CYCLE_COST`; `proacl` mostra apenas `postgres=X` e `service_role=X`, **sem** `anon=` nem `authenticated=`.

- [ ] **Step 7: Gates e commit**

```bash
npm run lint
npm run typecheck
npx vitest run
git add supabase/migrations/20260807100000_104_whatsapp_cycle_cost_and_end.sql supabase/functions/_shared/whatsapp-instance-notes-core.ts src/lib/whatsapp-instance-notes-core.test.ts src/lib/whatsapp-instance-format.ts
git commit -m "feat(6c): migration 104 — RPCs de custo e encerramento, oitava acao do ledger"
```

---

## Task 3: Harness local-preflight — comportamento das duas RPCs

**Files:**
- Create: `supabase/tests/local-preflight/05-ciclo-custo-e-fim.sql`
- Create: `supabase/tests/local-preflight/06-controles-104.sql`
- Modify: `supabase/tests/local-preflight/README.md`

**Interfaces:**
- Consumes: `set_whatsapp_instance_cost(uuid, integer, text, text, uuid)` e `confirm_whatsapp_instance_end(uuid, text, uuid)` da Task 2.
- Produces: nada consumido por código; produz o veredito que autoriza o deploy.

**Contexto para quem executa:** o harness é um Postgres local descartável, sem Docker e **sem `pg_cron`/`pg_net`** (treze migrations legadas embutem a URL de produção nos wrappers de cron — com as extensões presentes, o replay agendaria jobs apontando para lá). Ele prova trigger, CHECK, FK, ordem de execução e idempotência; **não** prova RLS, grants, ACL nem PostgREST. Os ids fixos das instâncias vêm de `02-seed.sql`.

- [ ] **Step 1: Conferir as colunas obrigatórias de `whatsapp_instances`**

Run: `grep -n "not null" supabase/migrations/20260801200000_087_whatsapp_instances.sql | head -20`

Os casos abaixo criam instâncias próprias com ids fixos (não reusam as do seed, para não interferir com `03`/`04`) e preenchem `organization_id`, `provider`, `lifecycle_state` e `cycle_source`. Se a 087 tiver alguma outra coluna `not null` sem default, acrescentá-la aos `insert` — o erro do Postgres nomeia a coluna. O `02-seed.sql` **não** é alterado; ele só precisa ter pelo menos uma organização, que os casos resolvem por `(select id from organizations order by id limit 1)`.

- [ ] **Step 2: Escrever os casos**

Criar `supabase/tests/local-preflight/05-ciclo-custo-e-fim.sql`. Cada caso roda numa subtransação própria e grava o veredito em `t_res`, no mesmo padrão do `03-notes-b-c-d.sql`:

```sql
-- COST-1..4, END-1..3, CORR-1..2 — comportamento das RPCs da migration 104.
--
-- Cada caso numa subtransacao, veredito em `t_res`. Os ids sao FIXOS: o
-- harness e descartavel e reproduzivel, e id gerado tornaria a leitura do
-- resultado dependente da execucao.

create table if not exists t_res (ord int, caso text, veredito text);

-- Instancia dedicada a estes casos, para nao interferir com 03/04.
insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, cycle_source)
values ('cc000000-0000-4000-8000-000000000001', (select id from organizations order by id limit 1),
        'zapi', 'ACTIVE', 'ADMIN_CONFIRMED')
on conflict (id) do nothing;

-- ── COST-1: preenche ciclo OPEN sem custo ────────────────────────────
do $$
declare v_filled boolean; v_cycle uuid;
begin
  delete from whatsapp_instance_cycles where instance_id = 'cc000000-0000-4000-8000-000000000001';
  insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on, status)
  values ('cc000000-0000-4000-8000-000000000001',
          (select organization_id from whatsapp_instances where id = 'cc000000-0000-4000-8000-000000000001'),
          date '2026-07-04', date '2026-08-04', 'OPEN');

  select cycle_filled into v_filled
  from set_whatsapp_instance_cost('cc000000-0000-4000-8000-000000000001', 9990, 'PROVIDER_PANEL', 'nota', null);

  select id into v_cycle from whatsapp_instance_cycles
   where instance_id = 'cc000000-0000-4000-8000-000000000001' and status = 'OPEN';

  insert into t_res values (51, 'COST-1 preenche ciclo OPEN sem custo',
    case when v_filled
      and (select provider_cost_cents from whatsapp_instance_cycles where id = v_cycle) = 9990
      and (select cost_source from whatsapp_instance_cycles where id = v_cycle) = 'PROVIDER_PANEL'
      and (select cost_snapshot_at from whatsapp_instance_cycles where id = v_cycle) is not null
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── COST-2: NAO sobrescreve custo ja congelado ───────────────────────
do $$
declare v_filled boolean;
begin
  select cycle_filled into v_filled
  from set_whatsapp_instance_cost('cc000000-0000-4000-8000-000000000001', 12000, 'PROVIDER_INVOICE', 'nota', null);

  insert into t_res values (52, 'COST-2 nao sobrescreve custo congelado do ciclo',
    case when v_filled = false
      and (select provider_cost_cents from whatsapp_instance_cycles
            where instance_id = 'cc000000-0000-4000-8000-000000000001' and status = 'OPEN') = 9990
      and (select current_monthly_cost_cents from whatsapp_instances
            where id = 'cc000000-0000-4000-8000-000000000001') = 12000
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── COST-3: custo desconhecido nao apaga o custo do ciclo ────────────
do $$
declare v_filled boolean;
begin
  select cycle_filled into v_filled
  from set_whatsapp_instance_cost('cc000000-0000-4000-8000-000000000001', null, null, 'nao sei mais', null);

  insert into t_res values (53, 'COST-3 custo desconhecido nao apaga o do ciclo',
    case when v_filled = false
      and (select provider_cost_cents from whatsapp_instance_cycles
            where instance_id = 'cc000000-0000-4000-8000-000000000001' and status = 'OPEN') = 9990
      and (select current_monthly_cost_cents from whatsapp_instances
            where id = 'cc000000-0000-4000-8000-000000000001') is null
      and (select cost_updated_at from whatsapp_instances
            where id = 'cc000000-0000-4000-8000-000000000001') is null
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── COST-4: sem ciclo OPEN, grava so na instancia ────────────────────
do $$
declare v_found boolean; v_cycle uuid; v_filled boolean;
begin
  delete from whatsapp_instance_cycles where instance_id = 'cc000000-0000-4000-8000-000000000001';

  select instance_found, open_cycle_id, cycle_filled into v_found, v_cycle, v_filled
  from set_whatsapp_instance_cost('cc000000-0000-4000-8000-000000000001', 7000, 'ESTIMATED', 'nota', null);

  insert into t_res values (54, 'COST-4 sem ciclo OPEN grava so na instancia',
    case when v_found and v_cycle is null and v_filled = false
      and (select current_monthly_cost_cents from whatsapp_instances
            where id = 'cc000000-0000-4000-8000-000000000001') = 7000
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── END-1: com custo, ciclo fecha CLOSED e a projecao e limpa ────────
do $$
declare v_status text;
begin
  insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on, status,
                                        provider_cost_cents, cost_source, cost_snapshot_at)
  values ('cc000000-0000-4000-8000-000000000001',
          (select organization_id from whatsapp_instances where id = 'cc000000-0000-4000-8000-000000000001'),
          date '2026-09-04', date '2026-10-04', 'OPEN', 9990, 'PROVIDER_PANEL', now());
  update whatsapp_instances
     set current_cycle_started_on = date '2026-09-04', current_cycle_due_on = date '2026-10-04'
   where id = 'cc000000-0000-4000-8000-000000000001';

  select closed_cycle_status into v_status
  from confirm_whatsapp_instance_end('cc000000-0000-4000-8000-000000000001', 'verificado no painel', null);

  insert into t_res values (55, 'END-1 com custo fecha CLOSED e limpa projecao',
    case when v_status = 'CLOSED'
      and (select lifecycle_state from whatsapp_instances
            where id = 'cc000000-0000-4000-8000-000000000001') = 'ENDED'
      and (select current_cycle_due_on from whatsapp_instances
            where id = 'cc000000-0000-4000-8000-000000000001') is null
      and (select count(*) from whatsapp_instance_cycles
            where instance_id = 'cc000000-0000-4000-8000-000000000001' and status = 'OPEN') = 0
      and (select provider_due_on from whatsapp_instance_cycles
            where instance_id = 'cc000000-0000-4000-8000-000000000001'
              and cycle_start = date '2026-09-04') = date '2026-10-04'
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── END-2: sem custo, ciclo fecha PENDING_REVIEW ─────────────────────
do $$
declare v_status text;
begin
  insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, cycle_source)
  values ('cc000000-0000-4000-8000-000000000002',
          (select id from organizations order by id limit 1), 'zapi', 'ACTIVE', 'ADMIN_CONFIRMED')
  on conflict (id) do nothing;
  insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on, status)
  values ('cc000000-0000-4000-8000-000000000002',
          (select organization_id from whatsapp_instances where id = 'cc000000-0000-4000-8000-000000000002'),
          date '2026-07-10', date '2026-08-10', 'OPEN');

  select closed_cycle_status into v_status
  from confirm_whatsapp_instance_end('cc000000-0000-4000-8000-000000000002', 'verificado', null);

  insert into t_res values (56, 'END-2 sem custo fecha PENDING_REVIEW',
    case when v_status = 'PENDING_REVIEW'
      and (select status from whatsapp_instance_cycles
            where instance_id = 'cc000000-0000-4000-8000-000000000002') = 'PENDING_REVIEW'
      and (select closed_at from whatsapp_instance_cycles
            where instance_id = 'cc000000-0000-4000-8000-000000000002') is not null
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── END-3: repeticao e idempotente e nao reescreve ended_at ──────────
do $$
declare v_first timestamptz; v_second timestamptz; v_cycle uuid;
begin
  -- `ended_at = coalesce(ended_at, now())` preserva a data da PRIMEIRA
  -- confirmacao; e isso que este caso mede.
  select ended_at into v_first from whatsapp_instances
   where id = 'cc000000-0000-4000-8000-000000000002';
  select closed_cycle_id into v_cycle
  from confirm_whatsapp_instance_end('cc000000-0000-4000-8000-000000000002', 'de novo', null);
  select ended_at into v_second from whatsapp_instances
   where id = 'cc000000-0000-4000-8000-000000000002';

  insert into t_res values (57, 'END-3 repeticao idempotente, ended_at preservado',
    case when v_first = v_second and v_cycle is null
      and (select count(*) from whatsapp_instance_cycles
            where instance_id = 'cc000000-0000-4000-8000-000000000002') = 1
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── CORR-1: correcao promove PENDING_REVIEW -> CLOSED ────────────────
-- O compare-and-set e o mesmo predicado que a Edge Function usa
-- (`status = 'PENDING_REVIEW'` no WHERE). O que este caso prova e a metade do
-- banco: que o CHECK `whatsapp_cycles_closed_needs_cost_chk` aceita custo e
-- status mudando juntos, e que o predicado casa.
do $$
declare v_rows int; v_id uuid;
begin
  select id into v_id from whatsapp_instance_cycles
   where instance_id = 'cc000000-0000-4000-8000-000000000002';

  update whatsapp_instance_cycles
     set provider_cost_cents = 9990, cost_source = 'PROVIDER_INVOICE',
         cost_snapshot_at = now(), status = 'CLOSED',
         notes = coalesce(notes || E'\n', '') || '[correcao de custo] fatura de julho'
   where id = v_id and status = 'PENDING_REVIEW';
  get diagnostics v_rows = row_count;

  insert into t_res values (58, 'CORR-1 promove PENDING_REVIEW para CLOSED e anexa motivo',
    case when v_rows = 1
      and (select status from whatsapp_instance_cycles where id = v_id) = 'CLOSED'
      and (select notes from whatsapp_instance_cycles where id = v_id) like '%[correcao de custo]%'
    then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── CORR-2: correcao sobre ciclo CLOSED casa ZERO linhas ─────────────
do $$
declare v_rows int; v_id uuid;
begin
  select id into v_id from whatsapp_instance_cycles
   where instance_id = 'cc000000-0000-4000-8000-000000000002';

  update whatsapp_instance_cycles
     set provider_cost_cents = 1
   where id = v_id and status = 'PENDING_REVIEW';
  get diagnostics v_rows = row_count;

  insert into t_res values (59, 'CORR-2 correcao sobre CLOSED casa zero linhas',
    case when v_rows = 0
      and (select provider_cost_cents from whatsapp_instance_cycles where id = v_id) = 9990
    then 'PASSOU' else 'FALHOU' end);
end $$;
```

- [ ] **Step 3: Rodar e ver os nove casos passarem**

```bash
P -f supabase/tests/local-preflight/05-ciclo-custo-e-fim.sql
P -c "select ord, caso, veredito from t_res where ord >= 51 order by ord;"
```

Expected: nove linhas, todas `PASSOU`.

- [ ] **Step 4: Escrever os dois controles positivos**

Criar `supabase/tests/local-preflight/06-controles-104.sql`. **Rodar SEM `ON_ERROR_STOP`** — ele reintroduz defeito de propósito.

```sql
-- CONTROLE-3 e CONTROLE-4: reintroduzem os defeitos que a 104 corrige.
--
-- Sem eles, "COST-2 passou" e "END-1 passou" nao distinguem *a guarda funciona*
-- de *o teste nao testa nada*. Cada controle quebra a funcao, mostra o caso
-- falhar, e a restauracao e reaplicar a 104.

-- ── CONTROLE-3: remover a protecao do custo congelado ────────────────
create or replace function public.set_whatsapp_instance_cost(
  p_instance_id uuid, p_cost_cents integer, p_cost_source text,
  p_cost_note text, p_actor uuid
)
returns table (instance_found boolean, open_cycle_id uuid, cycle_filled boolean)
language plpgsql security definer set search_path = public
as $$
declare v_open record;
begin
  select * into v_open from whatsapp_instance_cycles
   where instance_id = p_instance_id and status = 'OPEN' for update;
  if not found then
    return query select true, null::uuid, false;
    return;
  end if;
  -- DEFEITO REINTRODUZIDO: sem `v_open.provider_cost_cents is null`.
  update whatsapp_instance_cycles
     set provider_cost_cents = p_cost_cents, cost_snapshot_at = now()
   where id = v_open.id;
  return query select true, v_open.id, true;
end;
$$;

do $$
declare v_before int; v_after int;
begin
  delete from whatsapp_instance_cycles where instance_id = 'cc000000-0000-4000-8000-000000000001';
  insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on,
                                        status, provider_cost_cents, cost_source, cost_snapshot_at)
  values ('cc000000-0000-4000-8000-000000000001',
          (select organization_id from whatsapp_instances where id = 'cc000000-0000-4000-8000-000000000001'),
          date '2026-11-04', date '2026-12-04', 'OPEN', 9990, 'PROVIDER_PANEL', now());

  select provider_cost_cents into v_before from whatsapp_instance_cycles
   where instance_id = 'cc000000-0000-4000-8000-000000000001' and status = 'OPEN';
  perform set_whatsapp_instance_cost('cc000000-0000-4000-8000-000000000001', 12000, 'ESTIMATED', 'x', null);
  select provider_cost_cents into v_after from whatsapp_instance_cycles
   where instance_id = 'cc000000-0000-4000-8000-000000000001' and status = 'OPEN';

  insert into t_res values (61, 'CONTROLE-3 sem a guarda, o custo congelado E sobrescrito',
    case when v_before = 9990 and v_after = 12000 then 'REPRODUZIU' else 'NAO REPRODUZIU' end);
end $$;

-- ── CONTROLE-4: remover o fecho do ciclo no encerramento ─────────────
create or replace function public.confirm_whatsapp_instance_end(
  p_instance_id uuid, p_note text, p_actor uuid
)
returns table (instance_found boolean, lifecycle_before text,
               closed_cycle_id uuid, closed_cycle_status text)
language plpgsql security definer set search_path = public
as $$
declare v_inst record;
begin
  select * into v_inst from whatsapp_instances where id = p_instance_id for update;
  -- DEFEITO REINTRODUZIDO (§2.3): marca ENDED e NAO fecha o ciclo aberto.
  update whatsapp_instances
     set lifecycle_state = 'ENDED', ended_at = coalesce(ended_at, now()), updated_at = now()
   where id = p_instance_id;
  return query select true, v_inst.lifecycle_state::text, null::uuid, null::text;
end;
$$;

do $$
declare v_open int;
begin
  perform confirm_whatsapp_instance_end('cc000000-0000-4000-8000-000000000001', 'x', null);
  select count(*) into v_open from whatsapp_instance_cycles
   where instance_id = 'cc000000-0000-4000-8000-000000000001' and status = 'OPEN';

  insert into t_res values (62, 'CONTROLE-4 sem o fecho, o ciclo fica OPEN para sempre',
    case when v_open = 1 then 'REPRODUZIU' else 'NAO REPRODUZIU' end);
end $$;
```

- [ ] **Step 5: Rodar os controles e restaurar**

```bash
"$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d fase6c -f supabase/tests/local-preflight/06-controles-104.sql
P -f supabase/migrations/20260807100000_104_whatsapp_cycle_cost_and_end.sql   # restaura as funcoes reais
P -c "select ord, caso, veredito from t_res where ord >= 51 order by ord;"
```

Expected: as duas linhas de controle dizem `REPRODUZIU`. Depois de reaplicar a 104, repetir o `05` do zero (dropdb/createdb e a sequência inteira) deve devolver os nove `PASSOU` de novo.

- [ ] **Step 6: Atualizar o README do harness**

Em `supabase/tests/local-preflight/README.md`: acrescentar `05-ciclo-custo-e-fim.sql` e `06-controles-104.sql` à tabela de arquivos; inserir na sequência de comandos a aplicação da **090** (depois da 088, antes do seed) e da **104** (depois da 096); e acrescentar à seção final:

> **CONTROLE-3** remove da RPC de custo a condição `provider_cost_cents is null` e mostra o custo já congelado sendo sobrescrito. **CONTROLE-4** remove do encerramento o fecho do ciclo e mostra o ciclo ficando `OPEN` — é literalmente o defeito §2.3 reintroduzido. Os dois se desfazem reaplicando a 104.

- [ ] **Step 7: Commit**

```bash
git add supabase/tests/local-preflight/
git commit -m "test(6c): harness — comportamento das RPCs 104 com dois controles positivos"
```

---

## Task 4: `set_cost` e `confirm_end` passam pelas RPCs

**Files:**
- Modify: `supabase/functions/manage-whatsapp-instances/index.ts:858-898` (`set_cost`), `:950-995` (`confirm_end`), e o comentário de cabeçalho em `:855-857`

**Interfaces:**
- Consumes: `set_whatsapp_instance_cost(uuid, integer, text, text, uuid)` e `confirm_whatsapp_instance_end(uuid, text, uuid)` da Task 2; `loadInstanceState(id, columns, reqId, evt)` e `recordInstanceNote({instanceId, organizationId, action, note, callerId, reqId})` já existentes no arquivo.
- Produces: resposta de `set_cost` ganha `cycle_filled: boolean`; resposta de `confirm_end` ganha `closed_cycle_status: string | null`. Consumidos pela Task 8.

**Nota sobre verificação:** não há runner de teste para `supabase/functions/`. `tsc -b` não alcança essa pasta e não há Deno no ambiente. O gate real é `npm run lint` (a regra `no-undef` existe exatamente por causa de um `ReferenceError` que chegou ao caminho de autorização desta EF) mais o comportamento SQL já provado na Task 3.

- [ ] **Step 1: Trocar o corpo de `set_cost`**

Substituir o comentário de cabeçalho e o bloco do `update`:

```ts
    // ── Custo ────────────────────────────────────────────────────────────
    // Grava na instância E PREENCHE o ciclo aberto quando ele está sem custo.
    //
    // Valor JÁ CONGELADO no ciclo não é sobrescrito — o princípio da
    // competência continua de pé, porque preencher um nulo não é reescrever
    // história: é registrar o que nunca se soube. Custo errado já gravado tem
    // porta própria (`correct_cycle_cost`, restrita a PENDING_REVIEW).
    //
    // VIA RPC porque são DUAS tabelas e PostgREST não tem transação: com duas
    // escritas soltas, a segunda falhando devolve exatamente o bug que esta
    // frente corrige, em silêncio. A RPC toma `FOR UPDATE` na mesma linha de
    // instância que a rolagem 090 trava, o que fecha a corrida com o worker
    // diário.
    if (action === "set_cost") {
      const reason = requireReason(body);
      if (!reason) return jsonResponse(req, { error: "Informe o motivo e a procedência do custo." }, 400);

      const id = requireInstanceId(body);
      if (!id) return jsonResponse(req, { error: "instance_id é obrigatório." }, 400);

      const cost = parseCostCents(body.current_monthly_cost_cents ?? null);
      if (cost.ok === false) return jsonResponse(req, { error: cost.message, code: cost.code }, 400);
      const isNull = cost.unknownCost === true;

      const setCostSource = isNull ? null : normalizeCostSource(body.cost_source);
      if (!isNull && setCostSource === null) {
        return jsonResponse(req, { error: "Procedência do custo inválida." }, 400);
      }

      // `strict: false` não estreita a união por verdade crua do campo — o
      // if/else explícito estreita nos dois modos.
      let cents: number | null;
      if (cost.unknownCost === true) {
        cents = null;
      } else {
        cents = cost.cents;
      }

      const { data: rpc, error: rpcErr } = await supabase.rpc("set_whatsapp_instance_cost", {
        p_instance_id: id,
        p_cost_cents: cents,
        p_cost_source: setCostSource,
        p_cost_note: reason,
        p_actor: callerId,
      });
      if (rpcErr) {
        jsonLog("error", { reqId, evt: "wa_cost_update_failed", err: rpcErr.message });
        return jsonResponse(req, { error: "Não foi possível atualizar o custo." }, 500);
      }

      // A RPC devolve `returns table`, que o PostgREST entrega como array.
      const outcome = (Array.isArray(rpc) ? rpc[0] : rpc) as
        | { instance_found: boolean; open_cycle_id: string | null; cycle_filled: boolean }
        | undefined;
      if (!outcome?.instance_found) {
        return jsonResponse(req, { error: "Instância não encontrada." }, 404);
      }

      const after = await loadInstanceState(id, INSTANCE_COLUMNS, reqId, "wa_cost_reload_failed");
      if (after.ok === false) return jsonResponse(req, { error: after.message }, after.status);

      await recordInstanceNote({
        instanceId: id, organizationId: after.row.organization_id as string,
        action: "SET_COST", note: reason, callerId, reqId,
      });

      return jsonResponse(req, { instance: after.row, cycle_filled: outcome.cycle_filled });
    }
```

- [ ] **Step 2: Trocar o corpo de `confirm_end`**

Substituir o bloco do `update` (a validação de `reason`, `requireInstanceId`, `loadInstanceState` e `canTransition` acima dele ficam intactas):

```ts
      // VIA RPC: marcar ENDED e fechar o ciclo aberto são duas tabelas, e sem
      // transação a segunda falhando deixa o ciclo OPEN para sempre — a rolagem
      // 090 pula `lifecycle_state` fora de ACTIVE/CANCELLATION_REQUESTED, então
      // nada o fecharia depois. A transição já foi validada por `canTransition`
      // acima; a RPC não a revalida, de propósito.
      const { data: rpc, error: rpcErr } = await supabase.rpc("confirm_whatsapp_instance_end", {
        p_instance_id: id,
        p_note: reason,
        p_actor: callerId,
      });
      if (rpcErr) {
        jsonLog("error", { reqId, evt: "wa_confirm_end_failed", err: rpcErr.message });
        return jsonResponse(req, { error: "Não foi possível confirmar o encerramento." }, 500);
      }

      const outcome = (Array.isArray(rpc) ? rpc[0] : rpc) as
        | {
            instance_found: boolean;
            lifecycle_before: string | null;
            closed_cycle_id: string | null;
            closed_cycle_status: string | null;
          }
        | undefined;
      if (!outcome?.instance_found) {
        return jsonResponse(req, { error: "Instância não encontrada." }, 404);
      }

      const after = await loadInstanceState(id, INSTANCE_COLUMNS, reqId, "wa_confirm_end_reload_failed");
      if (after.ok === false) return jsonResponse(req, { error: after.message }, after.status);

      await recordInstanceNote({
        instanceId: id, organizationId: after.row.organization_id as string,
        action: "CONFIRM_END", note: reason, callerId, reqId,
      });

      jsonLog("info", {
        reqId, evt: "wa_instance_ended", instanceId: id,
        closedCycleStatus: outcome.closed_cycle_status,
      });
      return jsonResponse(req, {
        instance: after.row,
        closed_cycle_status: outcome.closed_cycle_status,
      });
```

- [ ] **Step 3: Rodar os gates**

```bash
npm run lint
npm run typecheck
```

Expected: zero erros. Se `no-undef` acusar algo, é identificador fora de escopo — corrigir antes de seguir.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/manage-whatsapp-instances/index.ts
git commit -m "fix(6c): set_cost alcanca o ciclo aberto e confirm_end fecha o ciclo (§2.2, §2.3)"
```

---

## Task 5: `confirm_cycle_date` fotografa o custo conhecido

**Files:**
- Modify: `supabase/functions/manage-whatsapp-instances/index.ts:792-810`

**Interfaces:**
- Consumes: `loadInstanceState` já existente.
- Produces: nada novo na resposta.

**Contexto:** este é o defeito **B1**, a causa raiz do único dano real. Os carimbos provam: o custo da instância do Ren Sushi foi informado às 17:31:07 de 02/08 e o ciclo de julho foi criado às 17:47:03 do mesmo dia, com `provider_cost_cents` nulo. A rolagem 090 fotografa o custo; a criação do primeiro ciclo, não.

- [ ] **Step 1: Ler as colunas de custo junto com a instância**

Trocar a linha 792:

```ts
      // Lê TAMBÉM o custo: o ciclo que nasce aqui precisa fotografá-lo, como a
      // rolagem 090 faz. Sem isso, o PRIMEIRO ciclo de toda instância nasce
      // cego mesmo quando o número já está gravado, e só a correção manual o
      // conserta depois.
      const found = await loadInstanceState(
        id,
        "id, organization_id, current_monthly_cost_cents, cost_source",
        reqId,
        "wa_cycle_lookup_failed",
      );
      if (found.ok === false) return jsonResponse(req, { error: found.message }, found.status);
```

- [ ] **Step 2: Fotografar no insert do ciclo**

Trocar o `insert` (linhas 797-805):

```ts
      // MESMA FORMA DA 090: `cost_snapshot_at` é nulo quando o custo é nulo —
      // carimbo sem valor afirmaria que alguém informou algo.
      const snapshotCost = found.row.current_monthly_cost_cents as number | null;
      const { error: cycleErr } = await supabase.from("whatsapp_instance_cycles").insert({
        instance_id: id,
        organization_id: found.row.organization_id,
        cycle_start: cycleStart,
        provider_due_on: dueOn,
        status: "OPEN",
        provider_cost_cents: snapshotCost,
        cost_source: snapshotCost === null ? null : found.row.cost_source,
        cost_snapshot_at: snapshotCost === null ? null : new Date().toISOString(),
        notes: reason,
        created_by: callerId,
      });
      // 23505 = o ciclo já existia (reexecução). Idempotente, não é erro — e o
      // ciclo que já estava lá NÃO é preenchido por este caminho: ele pode ter
      // sido rolado ou fechado desde então, e mexer nele como efeito colateral
      // de uma reexecução é o tipo de escrita não-auditada que esta frente
      // combate. Reparo de ciclo existente tem porta própria
      // (`correct_cycle_cost`).
      if (cycleErr && cycleErr.code !== "23505") {
```

- [ ] **Step 3: Rodar os gates**

```bash
npm run lint
npm run typecheck
```

Expected: zero erros.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/manage-whatsapp-instances/index.ts
git commit -m "fix(6c): confirm_cycle_date fotografa o custo conhecido no ciclo que cria"
```

---

## Task 6: Guarda de unidade já ocupada no `register_instance`

**Files:**
- Modify: `supabase/functions/manage-whatsapp-instances/index.ts` — imports (após a linha 54) e o bloco `register_instance` (701-721)

**Interfaces:**
- Consumes: `checkUnitInstanceConflict`, `UNIT_ALREADY_HAS_INSTANCE_MESSAGE` da Task 1.
- Produces: 409 com `code: "UNIT_ALREADY_HAS_INSTANCE"` e campo `conflicts: {id, lifecycle_state, provider_instance_ref, created_at}[]` no corpo. Aceita `acknowledge_unit_conflict: true`. Consumido pela Task 8.

- [ ] **Step 1: Importar o núcleo**

Acrescentar após o import de `whatsapp-subscription-resolver-core.ts`:

```ts
import {
  checkUnitInstanceConflict,
  UNIT_ALREADY_HAS_INSTANCE_MESSAGE,
} from "../_shared/whatsapp-instance-registration-core.ts";
```

- [ ] **Step 2: Inserir a guarda depois da allowance e antes do insert**

Entre o `if (allowance.allowed === false) { … }` (que termina na linha 720) e o `const { data, error } = await supabase.from("whatsapp_instances").insert({…})`:

```ts
      // ── Unidade já ocupada ───────────────────────────────────────────────
      // TERCEIRA pergunta, independente das duas acima. `assertProvisioningAllowed`
      // responde "a plataforma sabe provisionar?"; `checkConnectionAllowance`
      // responde "o modelo comercial permite mais uma conexão?"; esta responde
      // "esta unidade já está ocupada?".
      //
      // Ela existe porque a segunda NÃO cobre a cortesia vitalícia: naquele
      // núcleo, `activeInstanceCount` só é lido no ramo PLAN_DECLARED, então sob
      // override vitalício duas instâncias na mesma unidade coexistiam sem que
      // nada reclamasse (§2.1 da verificação manual).
      //
      // FORA do `checkConnectionAllowance` de propósito: aquele núcleo é
      // compartilhado com `manage-channels`, que não tem nada a ver com unidade
      // duplicada.
      const unitId = body.unit_id ? parseUuid(body.unit_id) : null;
      if (body.unit_id && !unitId) {
        return jsonResponse(req, { error: "unit_id inválido." }, 400);
      }

      let unitConflicts: Record<string, unknown>[] = [];
      if (unitId) {
        const { data: sameUnit, error: sameUnitErr } = await supabase
          .from("whatsapp_instances")
          .select("id, lifecycle_state, provider_instance_ref, created_at")
          .eq("unit_id", unitId)
          .neq("lifecycle_state", "ENDED");

        // FALHA em vez de degradar, como a contagem de allowance acima: lista
        // vazia por erro de leitura liberaria exatamente o registro que a guarda
        // existe para barrar.
        if (sameUnitErr) {
          jsonLog("error", {
            reqId, evt: "wa_unit_conflict_read_failed", unitId,
            err: sameUnitErr.message, needsAdminAction: true,
          });
          return jsonResponse(req, { error: ALLOWANCE_UNVERIFIABLE }, 503);
        }
        unitConflicts = (sameUnit ?? []) as Record<string, unknown>[];
      }

      const unitCheck = checkUnitInstanceConflict({
        unitScoped: unitId !== null,
        conflicts: unitConflicts.map((c) => ({
          id: String(c.id),
          lifecycleState: String(c.lifecycle_state),
        })),
        acknowledged: body.acknowledge_unit_conflict === true,
      });

      if (unitCheck.ok === false) {
        jsonLog("warn", {
          reqId, evt: "wa_unit_conflict_denied", unitId,
          conflicts: unitConflicts.length, callerId,
        });
        // Devolve as conflitantes para a tela poder mostrá-las. São
        // identificadores e datas — `provider_instance_ref` é identificador no
        // painel do fornecedor, não credencial, e esta EF é exclusiva de
        // platform_admin.
        return jsonResponse(req, {
          error: UNIT_ALREADY_HAS_INSTANCE_MESSAGE,
          code: "UNIT_ALREADY_HAS_INSTANCE",
          conflicts: unitConflicts,
        }, 409);
      }
```

- [ ] **Step 3: Usar o `unitId` já validado no insert**

Na chamada de `insert`, trocar `unit_id: body.unit_id ?? null,` por:

```ts
          unit_id: unitId,
```

- [ ] **Step 4: Registrar o reconhecimento no log de sucesso**

No `jsonLog("info", { … evt: "wa_instance_registered" … })`, acrescentar:

```ts
        unitConflictPolicy: unitCheck.ok === true ? unitCheck.policy : null,
```

- [ ] **Step 5: Rodar os gates**

```bash
npm run lint
npm run typecheck
npx vitest run src/lib/whatsapp-instance-registration-core.test.ts
```

Expected: zero erros; 6 testes passando.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/manage-whatsapp-instances/index.ts
git commit -m "fix(6c): registro recusa segunda instancia na mesma unidade sem reconhecimento (§2.1)"
```

---

## Task 7: Ação `correct_cycle_cost`

**Files:**
- Modify: `supabase/functions/manage-whatsapp-instances/index.ts` — bloco novo logo após `set_cost`

**Interfaces:**
- Consumes: `parseCostCents`, `normalizeCostSource`, `parseUuid`, `requireReason`, `recordInstanceNote`, constante `CYCLE_COLUMNS`, todos já no arquivo; ação `CORRECT_CYCLE_COST` da Task 2.
- Produces: action `correct_cycle_cost` aceitando `{cycle_id, current_monthly_cost_cents, cost_source, reason}` e devolvendo `{ cycle }`. Consumido pela Task 8.

- [ ] **Step 1: Escrever o bloco**

Inserir imediatamente depois do bloco `if (action === "set_cost") { … }`:

```ts
    // ── Correção de custo de ciclo passado ───────────────────────────────
    // A ÚNICA porta que muda custo já gravado, e ela é estreita de propósito.
    //
    // Só `PENDING_REVIEW` — o estado que significa "terminou sem custo". Ciclo
    // `CLOSED` fechou financeiramente concluído, e reabrir esse caso exigiria
    // política própria que não existe. Ciclo `OPEN` não precisa daqui: `set_cost`
    // o preenche.
    //
    // NÃO PRECISA DE RPC: escreve UMA tabela, e o predicado `status =
    // 'PENDING_REVIEW'` no próprio UPDATE é o compare-and-set que a trava faria.
    if (action === "correct_cycle_cost") {
      const reason = requireReason(body);
      if (!reason) {
        return jsonResponse(req, { error: "Informe a origem do valor corrigido." }, 400);
      }

      const cycleId = parseUuid(body.cycle_id);
      if (!cycleId) return jsonResponse(req, { error: "cycle_id inválido." }, 400);

      const cost = parseCostCents(body.current_monthly_cost_cents ?? null);
      if (cost.ok === false) return jsonResponse(req, { error: cost.message, code: cost.code }, 400);
      // Corrigir para "não sei" não é correção — e deixaria o ciclo num estado
      // que o CHECK `whatsapp_cycles_closed_needs_cost_chk` recusaria.
      if (cost.unknownCost === true) {
        return jsonResponse(req, { error: "A correção precisa de um valor. Deixar em branco não corrige." }, 400);
      }

      const costSource = normalizeCostSource(body.cost_source);
      if (costSource === null) {
        return jsonResponse(req, { error: "Procedência do custo inválida." }, 400);
      }

      const { data: current, error: readErr } = await supabase
        .from("whatsapp_instance_cycles")
        .select("id, instance_id, organization_id, status, notes")
        .eq("id", cycleId)
        .maybeSingle();
      if (readErr) {
        jsonLog("error", {
          reqId, evt: "wa_cycle_correct_lookup_failed", err: readErr.message,
          needsAdminAction: true,
        });
        return jsonResponse(req, { error: "Não foi possível consultar o ciclo agora. Tente novamente." }, 503);
      }
      if (!current) return jsonResponse(req, { error: "Ciclo não encontrado." }, 404);

      // APPEND, nunca sobrescrita: a nota original do ciclo é registro próprio.
      const mergedNotes = current.notes
        ? `${current.notes}\n[correção de custo] ${reason}`
        : `[correção de custo] ${reason}`;

      const { data: updated, error: updErr } = await supabase
        .from("whatsapp_instance_cycles")
        .update({
          provider_cost_cents: cost.cents,
          cost_source: costSource,
          cost_snapshot_at: new Date().toISOString(),
          // Custo e status mudam JUNTOS — é isso que satisfaz o CHECK
          // `whatsapp_cycles_closed_needs_cost_chk`. `closed_at` já é não-nulo:
          // PENDING_REVIEW o exige.
          status: "CLOSED",
          closed_by: callerId,
          notes: mergedNotes,
        })
        .eq("id", cycleId)
        .eq("status", "PENDING_REVIEW")
        .select(CYCLE_COLUMNS);

      if (updErr) {
        jsonLog("error", { reqId, evt: "wa_cycle_correct_failed", err: updErr.message });
        return jsonResponse(req, { error: "Não foi possível corrigir o custo do ciclo." }, 500);
      }
      // UPDATE que casa ZERO linhas devolve `error: null` no Supabase JS. Sem
      // esta conferência, "o predicado negou" seria indistinguível de "gravei".
      if (!updated || updated.length === 0) {
        return jsonResponse(req, {
          error: "Só é possível corrigir ciclo pendente de revisão. Ciclo já fechado não é reaberto.",
          code: "CYCLE_NOT_PENDING_REVIEW",
        }, 409);
      }

      await recordInstanceNote({
        instanceId: current.instance_id as string,
        organizationId: current.organization_id as string,
        action: "CORRECT_CYCLE_COST",
        note: reason,
        callerId,
        reqId,
      });

      jsonLog("info", {
        reqId, evt: "wa_cycle_cost_corrected", cycleId,
        instanceId: current.instance_id, callerId,
      });
      return jsonResponse(req, { cycle: updated[0] });
    }
```

- [ ] **Step 2: Rodar os gates**

```bash
npm run lint
npm run typecheck
```

Expected: zero erros.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/manage-whatsapp-instances/index.ts
git commit -m "feat(6c): acao auditada correct_cycle_cost para ciclo PENDING_REVIEW"
```

---

## Task 8: Painel

**Files:**
- Modify: `src/hooks/useWhatsappInstances.ts:33-44`
- Modify: `src/components/platform/RegisterInstanceDialog.tsx`
- Modify: `src/pages/platform/WhatsappInstances.tsx`

**Interfaces:**
- Consumes: 409 `UNIT_ALREADY_HAS_INSTANCE` com `conflicts` (Task 6); `cycle_filled` de `set_cost` (Task 4); action `correct_cycle_cost` (Task 7). O hook `callEf` já anexa `code` e `httpStatus` ao `Error`, mas **não** o resto do corpo.
- Produces: nada consumido por outra task.

- [ ] **Step 1: Expor o corpo do erro no hook**

Em `src/hooks/useWhatsappInstances.ts`, dentro de `callEf`, acrescentar o corpo bruto ao erro:

```ts
    const e = new Error(message) as Error & {
      code?: string;
      httpStatus?: number;
      /** Corpo non-2xx completo. O 409 de unidade ocupada traz `conflicts`, que
       *  a tela precisa MOSTRAR — mensagem sozinha não diz o que já existe. */
      body?: Record<string, unknown>;
    };
    e.code = code;
    e.httpStatus = httpStatus;
    e.body = parsedBody ?? undefined;
    throw e;
```

Para isso, guardar o objeto parseado numa variável no bloco `if (error instanceof FunctionsHttpError)`:

```ts
    let parsedBody: Record<string, unknown> | null = null;
    if (error instanceof FunctionsHttpError) {
      httpStatus = error.context?.status;
      const parsed = await error.context.json().catch(() => null);
      parsedBody = parsed;
      if (parsed?.error) message = parsed.error;
      code = parsed?.code;
    }
```

E acrescentar `cost_source: string | null;` ao tipo `WhatsappInstanceCycle` (a EF já o devolve em `CYCLE_COLUMNS`; o diálogo de correção precisa dele para pré-selecionar a procedência).

- [ ] **Step 2: Confirmação de unidade ocupada no diálogo de registro**

Em `src/components/platform/RegisterInstanceDialog.tsx`:

Acrescentar o estado e limpá-lo no `reset()`:

```ts
  /**
   * Instâncias vivas que a unidade escolhida já tem. O servidor recusa uma vez
   * e devolve a lista; a tela mostra o que existe e o operador decide. Segunda
   * instância legítima continua possível — como ATO CONSCIENTE.
   */
  const [unitConflicts, setUnitConflicts] = useState<
    { id: string; lifecycle_state: string; provider_instance_ref: string | null }[] | null
  >(null);
```

No `reset()`, acrescentar `setUnitConflicts(null);`. E no efeito que reseta o canal ao trocar de unidade (`useEffect(() => { setChannelId(NO_CHANNEL); }, [unitId])`), acrescentar `setUnitConflicts(null);` — o reconhecimento vale para a unidade que o produziu, e carregá-lo para outra unidade daria uma exceção que ninguém pediu.

Trocar `submit()` para aceitar o reconhecimento:

```ts
  function submit(acknowledgeConflict = false) {
    if (!selectedUnit) return;
    const parsed = parseCostReais(costReais);
    if (parsed.ok === false) return;
    const hasCost = parsed.unknownCost === false;

    action.mutate(
      {
        action: "register_instance",
        intent: "BACKFILL_EXISTING",
        provider: "zapi",
        organization_id: selectedUnit.organization_id,
        unit_id: selectedUnit.id,
        channel_id: channelId === NO_CHANNEL ? null : channelId,
        provider_instance_ref: ref.trim(),
        current_monthly_cost_cents: hasCost ? parsed.cents : null,
        ...(hasCost ? { cost_source: costSource } : {}),
        ...(acknowledgeConflict ? { acknowledge_unit_conflict: true } : {}),
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
        onError: (e: Error & { code?: string; body?: Record<string, unknown> }) => {
          // 409 de unidade ocupada não é erro terminal: é uma pergunta. A tela
          // mostra o que já existe e oferece a confirmação.
          if (e.code === "UNIT_ALREADY_HAS_INSTANCE") {
            setUnitConflicts(
              (e.body?.conflicts as {
                id: string;
                lifecycle_state: string;
                provider_instance_ref: string | null;
              }[]) ?? [],
            );
            return;
          }
          toast.error(e.message);
        },
      },
    );
  }
```

Antes do bloco de botões, renderizar o aviso:

```tsx
          {unitConflicts && unitConflicts.length > 0 && (
            <div className="rounded-md border border-warning bg-warning/10 p-3 space-y-2 text-sm">
              <p className="font-medium">Esta unidade já tem instância registrada.</p>
              <ul className="space-y-1 text-xs">
                {unitConflicts.map((c) => (
                  <li key={c.id}>
                    <span className="font-mono">{c.provider_instance_ref ?? "sem identificador"}</span>
                    {" — "}
                    {c.lifecycle_state === "CANCELLATION_REQUESTED"
                      ? "cancelamento solicitado (ainda custa)"
                      : "ativa"}
                  </li>
                ))}
              </ul>
              <p className="text-xs">
                Registrar uma segunda instância significa que a plataforma passa a pagar duas.
                Confirme só se for isso mesmo.
              </p>
            </div>
          )}
```

E o botão de ação passa a alternar:

```tsx
            <Button
              disabled={!canSubmit}
              onClick={() => submit(unitConflicts !== null && unitConflicts.length > 0)}
            >
              {unitConflicts && unitConflicts.length > 0 ? "Registrar mesmo assim" : "Registrar"}
            </Button>
```

Trocar também a copy do custo (linhas 282-285), que a Task 5 tornou desatualizada:

```tsx
            <p className="text-xs text-muted-foreground">
              Vazio grava <strong>desconhecido</strong>, nunca zero — e aí o ciclo fica pendente de
              revisão até o número existir. Com o valor preenchido, o ciclo já nasce com ele.
            </p>
```

- [ ] **Step 3: Copy e procedência no diálogo de `set_cost`**

Em `src/pages/platform/WhatsappInstances.tsx`, no bloco `dialog?.kind === "set_cost"`, trocar a copy e acrescentar o seletor de procedência:

```tsx
            {dialog?.kind === "set_cost" && (
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="cost">Custo mensal (R$) — deixe vazio se desconhecido</Label>
                  <Input
                    id="cost"
                    inputMode="decimal"
                    className="h-12 sm:h-10"
                    value={costReais}
                    onChange={(e) => setCostReais(e.target.value)}
                    placeholder="Ex.: 100,00"
                  />
                  <p className="text-xs text-muted-foreground">
                    Vazio grava <strong>desconhecido</strong>, nunca zero. Se o ciclo em curso estiver
                    sem custo, ele é preenchido agora; se já tiver um valor congelado, ele não é
                    sobrescrito. Ciclo já fechado só muda pela correção, no histórico.
                  </p>
                </div>
                {/* A procedência agora vai junto para o CICLO, onde vira parte do
                    registro financeiro congelado. Sem o seletor, o padrão do
                    servidor ("informado pelo administrador") entraria no ciclo
                    mesmo quando o número veio da fatura. */}
                <div className="space-y-1">
                  <Label htmlFor="cost-source">Procedência do custo</Label>
                  <Select value={costSource} onValueChange={setCostSource}>
                    <SelectTrigger id="cost-source" className="h-12 sm:h-10">
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
            )}
```

Acrescentar o estado `const [costSource, setCostSource] = useState(COST_SOURCE_OPTIONS[0].value);` junto dos outros estados de diálogo, resetá-lo em `closeDialog()`, e importar `COST_SOURCE_OPTIONS` de `@/lib/whatsapp-instance-format` e os componentes `Select`/`SelectContent`/`SelectItem`/`SelectTrigger`/`SelectValue` de `@/components/ui/select` (conferir se já estão importados no arquivo antes de duplicar).

No `onClick` do botão Confirmar, no ramo `set_cost`, mandar a procedência só quando há número — mandá-la com custo nulo afirmaria a origem de um valor que não foi informado:

```ts
                    run(
                      {
                        action: "set_cost",
                        instance_id: dialog.instance.id,
                        current_monthly_cost_cents: cents,
                        ...(cents === null ? {} : { cost_source: costSource }),
                        reason,
                      },
                      "Custo atualizado.",
                    );
```

- [ ] **Step 4: Ação "corrigir custo" nas linhas `PENDING_REVIEW`**

Ainda em `WhatsappInstances.tsx`, `CyclesPanel` passa a receber um callback e renderizar o botão:

```tsx
function CyclesPanel({
  instanceId,
  onCorrect,
}: {
  instanceId: string;
  onCorrect: (cycle: WhatsappInstanceCycle) => void;
}) {
```

E, dentro do bloco `c.status === "PENDING_REVIEW"`:

```tsx
            {c.status === "PENDING_REVIEW" && (
              <div className="space-y-2">
                <p className="text-xs text-warning">
                  Ciclo terminou sem custo informado. Custo desconhecido não é zero — a margem fica
                  indefinida até alguém informar.
                </p>
                <Button size="sm" variant="outline" onClick={() => onCorrect(c)}>
                  Corrigir custo
                </Button>
              </div>
            )}
```

No componente pai, acrescentar a variante ao tipo do diálogo e o estado:

```ts
type ReasonDialogKind =
  | { kind: "confirm_date"; instance: WhatsappInstance }
  | { kind: "set_cost"; instance: WhatsappInstance }
  | { kind: "correct_cycle"; cycle: WhatsappInstanceCycle }
  | { kind: "cancel"; instance: WhatsappInstance }
  | { kind: "confirm_end"; instance: WhatsappInstance }
  | { kind: "reactivate"; instance: WhatsappInstance }
  | { kind: "resolve_alert"; alert: WhatsappInstanceAlert }
  | null;
```

Passar `onCorrect` onde `CyclesPanel` é usado:

```tsx
<CyclesPanel
  instanceId={inst.id}
  onCorrect={(cycle) => {
    setCostReais("");
    setCostSource(cycle.cost_source ?? COST_SOURCE_OPTIONS[0].value);
    setDialog({ kind: "correct_cycle", cycle });
  }}
/>
```

Título do diálogo:

```tsx
              {dialog?.kind === "correct_cycle" && "Corrigir custo de ciclo fechado"}
```

Corpo do diálogo:

```tsx
            {dialog?.kind === "correct_cycle" && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Ciclo de {formatDateBR(dialog.cycle.cycle_start)} a{" "}
                  {formatDateBR(dialog.cycle.provider_due_on)}. A correção fecha o ciclo com o valor
                  informado e fica registrada com autoria e data.
                </p>
                <div className="space-y-1">
                  <Label htmlFor="corr-cost">Custo do período (R$)</Label>
                  <Input
                    id="corr-cost"
                    inputMode="decimal"
                    className="h-12 sm:h-10"
                    value={costReais}
                    onChange={(e) => setCostReais(e.target.value)}
                    placeholder="Ex.: 99,90"
                  />
                  <p className="text-xs text-muted-foreground">
                    Deixar em branco não corrige — a correção precisa de um valor.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="corr-source">Procedência do custo</Label>
                  <Select value={costSource} onValueChange={setCostSource}>
                    <SelectTrigger id="corr-source" className="h-12 sm:h-10">
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
            )}
```

Ramo do `onClick`:

```ts
                  } else if (dialog.kind === "correct_cycle") {
                    const parsed = parseCostReais(costReais);
                    if (parsed.ok === false) {
                      toast.error(parsed.message);
                      return;
                    }
                    if (parsed.unknownCost === true) {
                      toast.error("A correção precisa de um valor.");
                      return;
                    }
                    run(
                      {
                        action: "correct_cycle_cost",
                        cycle_id: dialog.cycle.id,
                        current_monthly_cost_cents: parsed.cents,
                        cost_source: costSource,
                        reason,
                      },
                      "Custo do ciclo corrigido.",
                    );
```

Importar `type WhatsappInstanceCycle` de `@/hooks/useWhatsappInstances` se ainda não estiver importado.

- [ ] **Step 5: Rodar os gates**

```bash
npm run lint
npm run typecheck
npx vitest run
npm run build
```

Expected: zero erros em todos.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useWhatsappInstances.ts src/components/platform/RegisterInstanceDialog.tsx src/pages/platform/WhatsappInstances.tsx
git commit -m "feat(6c): painel — confirmacao de unidade ocupada, copy do custo e correcao de ciclo"
```

---

## Task 9: Invariantes e correção do diagnóstico registrado

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/billing-asaas/FASE-6C-PENDENCIAS.md`

**Interfaces:**
- Consumes: tudo acima.
- Produces: nada.

- [ ] **Step 1: Corrigir o diagnóstico do §2.2 no documento de pendências**

Ler `docs/billing-asaas/FASE-6C-PENDENCIAS.md` e, no §2.2, acrescentar o bloco abaixo (sem apagar o texto original — o documento registra o que a verificação viu):

```markdown
> **Correção do diagnóstico (07/08/2026).** O achado culpava apenas o `set_cost`.
> A investigação do desenho encontrou a causa raiz um degrau antes:
> `confirm_cycle_date` cria o ciclo `OPEN` **sem fotografar o custo mesmo quando
> ele já é conhecido**. Os carimbos provam — o custo da instância foi informado
> às 17:31:07 de 02/08 e o ciclo de julho foi criado às 17:47:03 do mesmo dia,
> com `provider_cost_cents` nulo. Toda instância registrada por esse caminho
> perdia o custo do primeiro ciclo.
>
> **Segunda correção.** O achado diz que o período "nunca vira registro de
> margem". Isso vale para TODO ciclo: `customer_revenue_cents`, `revenue_source`
> e `gross_margin_cents` não são escritos por produtor nenhum, e a margem é
> calculada em memória pelo worker apenas para o alerta `ECONOMIC_IMBALANCE`. O
> que os §2.2 e §2.3 de fato perdiam era o **custo**. Persistir margem ficou
> fora de escopo por decisão; os comentários que prometiam o contrário estão
> corrigidos na migration 104.
```

E, no topo do documento, marcar os três achados como fechados pela frente, apontando para a spec e para o plano.

- [ ] **Step 2: Acrescentar os invariantes ao CLAUDE.md**

Na seção **Billing — mensalidades**, junto dos outros invariantes de `whatsapp_instance*`, acrescentar (formato obrigatório: regra em 1 frase, por quê em 1 frase, ponteiro):

```markdown
- **Custo de ciclo se escreve em TRÊS momentos e todos fotografam: nascimento (`confirm_cycle_date`), preenchimento de nulo (`set_cost` → RPC `set_whatsapp_instance_cost`) e rolagem (090).** A criação do ciclo não fotografava, então toda instância perdia o custo do primeiro período mesmo com o número já gravado — e só a correção manual o recupera. [migration 104](supabase/migrations/20260807100000_104_whatsapp_cycle_cost_and_end.sql).
- **Preencher `provider_cost_cents` nulo NÃO viola o congelamento na abertura; sobrescrever valor existente, sim — e só `correct_cycle_cost`, restrita a `status='PENDING_REVIEW'`, muda custo já gravado.** Preencher um nulo é registrar o que nunca se soube; ciclo `CLOSED` fechou financeiramente concluído e reabri-lo exigiria política que não existe. [manage-whatsapp-instances/index.ts](supabase/functions/manage-whatsapp-instances/index.ts).
- **`customer_revenue_cents`, `revenue_source` e `gross_margin_cents` de `whatsapp_instance_cycles` não são escritos por NENHUM produtor — a margem é calculada em memória pelo worker, só para o alerta `ECONOMIC_IMBALANCE`.** O comentário inline da 090 que promete preenchimento pelo worker é falso e está corrigido por `comment on column` na 104, porque migration aplicada não se reescreve. [migration 104](supabase/migrations/20260807100000_104_whatsapp_cycle_cost_and_end.sql).
- **Registro de instância faz TRÊS perguntas independentes, e a de unidade duplicada mora fora do `checkConnectionAllowance`.** Aquele núcleo é compartilhado com `manage-channels`, que não tem nada a ver com unidade ocupada — e sob cortesia vitalícia ele nunca consulta a contagem, que é como duas instâncias coexistiam na mesma unidade sem que nada reclamasse. [whatsapp-instance-registration-core.ts](supabase/functions/_shared/whatsapp-instance-registration-core.ts).
```

- [ ] **Step 3: Atualizar o checklist de redeploy do CLAUDE.md**

Na seção **Deploy → Edge Functions**, acrescentar à lista de `_shared/`:

```markdown
- **`whatsapp-instance-registration-core.ts`** (núcleo puro, testado em [src/lib/whatsapp-instance-registration-core.test.ts](src/lib/whatsapp-instance-registration-core.test.ts)) → `manage-whatsapp-instances` (único consumidor). NÃO é consumido por `manage-channels` — é justamente essa separação que existe para manter o teto de conexões e a guarda de unidade como perguntas distintas.
```

E, na linha existente de `whatsapp-instance-notes-core.ts` (se houver) ou criando-a, registrar que ele ganhou a oitava ação e que o CHECK efetivo vive na 104.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/billing-asaas/FASE-6C-PENDENCIAS.md
git commit -m "docs(6c): invariantes do custo de ciclo e correcao do diagnostico do §2.2"
```

---

## Aplicação (depois do merge, com autorização explícita)

Não faz parte das tasks — é o roteiro do dia do deploy, nesta ordem exata:

1. `supabase db push` da 104. Conferir os itens 1 a 3 do bloco de validação da própria migration.
2. `supabase functions deploy manage-whatsapp-instances`. **Só depois** da migration: a EF chama RPC que não existe antes dela.
3. Push em `main` → deploy do frontend pela Vercel.
4. Verificar o Ren Sushi no painel: instância ativa, ciclo de agosto `OPEN` com custo de R$ 99,90, ciclo de julho ainda `PENDING_REVIEW`.
5. Corrigir o ciclo de julho pelo painel, com motivo — o primeiro uso real da ação nova.
