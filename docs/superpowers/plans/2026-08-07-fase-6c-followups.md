# Fase 6c — os cinco follow-ups do review final: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar os cinco follow-ups deixados pelo review final de `fase-6c/ciclo-custo-e-encerramento` — toast que diz a verdade, primeira-confirmação-vence no encerramento, guardrail estático sobre as escritas condicionais da Edge Function, guarda de unidade duplicada nas duas portas, e desambiguação do `23505` de `confirm_cycle_date`.

**Arquitetura:** Cada item ganha **duas** provas quando atravessa banco e Edge Function: o caso de comportamento no harness `supabase/tests/local-preflight/` (com controle positivo) e o guardrail estático textual sobre a fonte da EF. Nenhuma migration aplicada é reescrita — a correção da RPC vai na **105**. Nenhum arquivo de `_shared/` muda, então o checklist de redeploy do `CLAUDE.md` não é afetado.

**Tech Stack:** Postgres/plpgsql (Supabase), Deno (Edge Functions), React 18 + TanStack Query + shadcn/ui, vitest, ESLint.

**Spec-mãe deste plano:** [2026-08-07-fase-6c-followups-design.md](../specs/2026-08-07-fase-6c-followups-design.md).

## Global Constraints

- **Só há um cliente ativo (Ren Sushi), vitalício grátis, e ele não pode quebrar.** Nenhuma migration escreve, apaga ou corrige dado dele. A 105 é DDL pura: `create or replace function` + `comment on function` + `revoke`/`grant`. Zero DML.
- **Nenhuma chamada à Z-API.**
- **Migration aplicada não se reescreve.** A 104 já estará aplicada em produção. Correção em migration nova: número **105**, timestamp **maior que `20260807100000`**.
- **`whatsapp-connection-allowance-core.ts` NÃO pode ser alterado** — é compartilhado com `manage-channels`.
- **`whatsapp-instance-registration-core.ts` NÃO muda** — o item 4 o *reusa* como está.
- **Função nova/substituída em `public` nasce executável por `anon`.** Toda migration que crie ou substitua função emite `revoke all on function <assinatura completa> from public, anon, authenticated;` e `grant execute on function <assinatura completa> to service_role;`.
- **`supabase/functions/` não é alcançada pelo `tsc -b`** e não há Deno no ambiente. O único gate automático nativo lá é o `no-undef` do ESLint (`npx eslint supabase/functions --max-warnings=0`).
- **`tsconfig.app.json` tem `strict: false`** — `if (!x.ok) { x.campo }` NÃO estreita união discriminada. Use `x.ok === false` ou early-return.
- **Caso novo no harness entra COM CONTROLE POSITIVO** — reintroduzir o defeito e ver o teste ficar vermelho.
- **NÃO fazer `supabase db push` nem `supabase functions deploy`** sem autorização explícita do dono do projeto.
- **Gates antes de cada commit:** `npm run lint` · `npm run typecheck` · `npx vitest run` · `npm run build` · `npx eslint supabase/functions --max-warnings=0`.
- **Segurança de commit:** `git add <caminho>` explícito, nunca `git add .`. Revisar `git diff --cached` inteiro contra a lista de padrões de secret do `CLAUDE.md`.

**Branch:** `fase-6c/followups-do-review` (já criada a partir de `main`, com o commit `7b78368` da spec).

---

## Estrutura de arquivos

| Arquivo | Responsabilidade | Tarefa |
|---|---|---|
| `src/lib/whatsapp-instance-format.ts` | **Modificar.** Ganha as duas funções puras de copy do toast + os dois leitores da resposta da EF. É onde os rótulos PT-BR desta tela já moram. | 1 |
| `src/lib/whatsapp-instance-format.test.ts` | **Modificar.** Ganha o bloco dos sete ramos de toast. | 1 |
| `src/pages/platform/WhatsappInstances.tsx` | **Modificar.** `run()` passa a aceitar função; dois call sites trocam a string literal pelo leitor. | 1 |
| `supabase/migrations/20260807110000_105_whatsapp_end_confirmation_first_wins.sql` | **Criar.** `create or replace` de `confirm_whatsapp_instance_end` com os três campos coalescendo. | 2 |
| `supabase/tests/local-preflight/05-ciclo-custo-e-fim.sql` | **Modificar.** Ganha `END-4` (item 2) e `CYCLE-1`/`CYCLE-2` (item 5). | 2, 3 |
| `supabase/tests/local-preflight/06-controles-104.sql` | **Modificar.** Ganha `CONTROLE-5`, o controle positivo do `END-4`. | 2 |
| `supabase/tests/local-preflight/README.md` | **Modificar.** A 105 entra na sequência; a ressalva sobre CORR-1/CORR-2 entra por escrito. | 2, 5 |
| `supabase/functions/manage-whatsapp-instances/index.ts` | **Modificar.** `set_cost` devolve `has_open_cycle` (item 1); `confirm_cycle_date` desambigua o `23505` (item 5); `update_instance` consulta a guarda de unidade (item 4). | 1, 3, 4 |
| `src/components/platform/UpdateInstanceDialog.tsx` | **Modificar.** Espelha o fluxo de conflito de unidade do `RegisterInstanceDialog`. | 4 |
| `src/lib/whatsapp-instance-ef-write-guard.test.ts` | **Criar.** Guardrail estático das escritas condicionais da EF. | 5 |
| `CLAUDE.md` | **Modificar.** Três invariantes novos + correção da linha existente sobre a guarda de unidade. | 6 |

**Ordem obrigatória:** a tarefa 5 (guardrail) afirma sobre código que as tarefas 3 e 4 produzem. Ela vem depois. As tarefas 1, 2, 3, 4 são independentes entre si.

---

## Task 1: O toast passa a dizer a verdade

**Files:**
- Modify: `src/lib/whatsapp-instance-format.ts` (acrescentar ao fim)
- Test: `src/lib/whatsapp-instance-format.test.ts` (acrescentar ao fim)
- Modify: `supabase/functions/manage-whatsapp-instances/index.ts:1022`
- Modify: `src/pages/platform/WhatsappInstances.tsx:234-247`, `:834`, `:869`

**Interfaces:**
- Consome: a resposta da EF `set_cost` (`{ instance, cycle_filled }`) e `confirm_end` (`{ instance, closed_cycle_status }`).
- Produz: `setCostToast`, `setCostToastFromResponse`, `confirmEndToast`, `confirmEndToastFromResponse` em `@/lib/whatsapp-instance-format`. A tarefa 5 não depende delas.

**Uma adição deliberada à spec §2.3.** A spec descreve três ramos para `setCostToast`. Este plano usa **quatro**: `hasOpenCycle` é `boolean | null`, e `null` significa *"a EF não disse"*. Razão: entre o deploy da EF e o do frontend (ou vice-versa) existe uma janela em que a resposta não traz `has_open_cycle`; tratar ausente como `false` faria a tela afirmar *"não há ciclo em aberto"* sem saber — que é exatamente o defeito que este item fecha, reintroduzido pela porta do deploy. O ramo `null` não afirma nada sobre o ciclo.

- [ ] **Step 1: Escrever os testes que falham**

Acrescentar ao fim de `src/lib/whatsapp-instance-format.test.ts`:

```ts
describe("copy do toast — a tela não afirma o que não sabe", () => {
  it("custo aplicado ao ciclo aberto", () => {
    expect(setCostToast({ filled: true, hasOpenCycle: true })).toBe(
      "Custo atualizado e aplicado ao ciclo em aberto.",
    );
  });

  it("ciclo aberto existe mas manteve o que tinha", () => {
    expect(setCostToast({ filled: false, hasOpenCycle: true })).toBe(
      "Custo atualizado na instância. O ciclo em aberto não mudou.",
    );
  });

  it("não há ciclo aberto", () => {
    expect(setCostToast({ filled: false, hasOpenCycle: false })).toBe(
      "Custo atualizado na instância. Não há ciclo em aberto.",
    );
  });

  it("a EF não disse se há ciclo aberto: NÃO afirma nada sobre o ciclo", () => {
    // Janela de deploy (EF antiga, frontend novo). Tratar ausente como `false`
    // faria a tela afirmar "não há ciclo em aberto" sem saber — o mesmo defeito
    // que este item fecha, por outra porta.
    const msg = setCostToast({ filled: false, hasOpenCycle: null });
    expect(msg).toBe("Custo atualizado na instância.");
    expect(msg).not.toMatch(/ciclo/);
  });

  it("filled=true vence mesmo com hasOpenCycle desconhecido", () => {
    // `filled` só pode ser true se havia ciclo aberto — é fato próprio.
    expect(setCostToast({ filled: true, hasOpenCycle: null })).toBe(
      "Custo atualizado e aplicado ao ciclo em aberto.",
    );
  });

  it("encerramento com o último ciclo fechado", () => {
    expect(confirmEndToast("CLOSED")).toBe(
      "Encerramento confirmado. O último ciclo foi fechado.",
    );
  });

  it("encerramento com o último ciclo sem custo aponta a tarefa pendente", () => {
    expect(confirmEndToast("PENDING_REVIEW")).toBe(
      "Encerramento confirmado. O último ciclo fechou sem custo — informe o valor em Ciclos e margem.",
    );
  });

  it("encerramento sem ciclo aberto", () => {
    expect(confirmEndToast(null)).toBe(
      "Encerramento confirmado. Não havia ciclo em aberto.",
    );
  });

  it("lê a resposta da EF sem confiar no formato", () => {
    expect(setCostToastFromResponse({ cycle_filled: true, has_open_cycle: true })).toBe(
      "Custo atualizado e aplicado ao ciclo em aberto.",
    );
    expect(setCostToastFromResponse({ cycle_filled: false, has_open_cycle: false })).toBe(
      "Custo atualizado na instância. Não há ciclo em aberto.",
    );
    // EF antiga: `has_open_cycle` ausente.
    expect(setCostToastFromResponse({ cycle_filled: false })).toBe(
      "Custo atualizado na instância.",
    );
    expect(setCostToastFromResponse(null)).toBe("Custo atualizado na instância.");

    expect(confirmEndToastFromResponse({ closed_cycle_status: "PENDING_REVIEW" })).toMatch(
      /sem custo/,
    );
    expect(confirmEndToastFromResponse({})).toBe(
      "Encerramento confirmado. Não havia ciclo em aberto.",
    );
    expect(confirmEndToastFromResponse(undefined)).toBe(
      "Encerramento confirmado. Não havia ciclo em aberto.",
    );
  });
});
```

Acrescentar os quatro nomes ao `import` de `@/lib/whatsapp-instance-format` que já existe no topo do arquivo de teste (`setCostToast`, `setCostToastFromResponse`, `confirmEndToast`, `confirmEndToastFromResponse`).

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/whatsapp-instance-format.test.ts`
Expected: FAIL — `setCostToast is not a function` / erro de import.

- [ ] **Step 3: Implementar as quatro funções puras**

Acrescentar ao fim de `src/lib/whatsapp-instance-format.ts`:

```ts
/**
 * Copy do toast das duas ações que a EF sabe descrever e a tela não usava.
 *
 * O PROBLEMA QUE ISTO FECHA: `"Custo atualizado."` seco afirma que a promessa
 * do diálogo ("o ciclo fica pendente de revisão até o número existir") foi
 * cumprida — mesmo quando `cycle_filled` é `false` e o ciclo aberto não mudou.
 * E o `PENDING_REVIEW` só aparece DENTRO da seção expandida, que o operador
 * precisa abrir: o toast é o único retorno no instante da ação.
 *
 * `hasOpenCycle: null` é *a EF não disse* — janela entre os deploys. Ele não
 * afirma nada sobre o ciclo, em vez de afirmar o negativo por default.
 */
export function setCostToast(r: { filled: boolean; hasOpenCycle: boolean | null }): string {
  // `filled` é fato próprio: só é `true` se havia ciclo aberto para preencher.
  if (r.filled) return "Custo atualizado e aplicado ao ciclo em aberto.";
  if (r.hasOpenCycle === true) {
    // "não mudou", não "manteve o valor congelado": com custo submetido nulo o
    // ciclo pode não ter valor nenhum a manter. A frase precisa ser verdadeira
    // nos dois casos.
    return "Custo atualizado na instância. O ciclo em aberto não mudou.";
  }
  if (r.hasOpenCycle === false) return "Custo atualizado na instância. Não há ciclo em aberto.";
  return "Custo atualizado na instância.";
}

export function confirmEndToast(closedCycleStatus: string | null): string {
  if (closedCycleStatus === "CLOSED") return "Encerramento confirmado. O último ciclo foi fechado.";
  if (closedCycleStatus === "PENDING_REVIEW") {
    return "Encerramento confirmado. O último ciclo fechou sem custo — informe o valor em Ciclos e margem.";
  }
  return "Encerramento confirmado. Não havia ciclo em aberto.";
}

/** Lê a resposta da EF sem confiar no formato — `unknown` é o que o hook entrega. */
export function setCostToastFromResponse(data: unknown): string {
  const d = (data ?? {}) as { cycle_filled?: unknown; has_open_cycle?: unknown };
  let hasOpenCycle: boolean | null;
  if (typeof d.has_open_cycle === "boolean") {
    hasOpenCycle = d.has_open_cycle;
  } else {
    hasOpenCycle = null;
  }
  return setCostToast({ filled: d.cycle_filled === true, hasOpenCycle });
}

export function confirmEndToastFromResponse(data: unknown): string {
  const d = (data ?? {}) as { closed_cycle_status?: unknown };
  return confirmEndToast(typeof d.closed_cycle_status === "string" ? d.closed_cycle_status : null);
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/whatsapp-instance-format.test.ts`
Expected: PASS.

- [ ] **Step 5: A EF passa a devolver `has_open_cycle`**

Em `supabase/functions/manage-whatsapp-instances/index.ts`, no fim do bloco `set_cost`, substituir:

```ts
      return jsonResponse(req, { instance: after.row, cycle_filled: outcome.cycle_filled });
```

por:

```ts
      // `has_open_cycle` é BOOLEANO, não o id: a tela precisa distinguir "o
      // ciclo manteve o valor dele" de "não há ciclo aberto", e não precisa do
      // identificador para isso.
      return jsonResponse(req, {
        instance: after.row,
        cycle_filled: outcome.cycle_filled,
        has_open_cycle: outcome.open_cycle_id !== null,
      });
```

`confirm_end` já devolve `closed_cycle_status`; não muda.

- [ ] **Step 6: O painel usa a copy condicional**

Em `src/pages/platform/WhatsappInstances.tsx`, acrescentar ao import existente de `@/lib/whatsapp-instance-format` os dois leitores:

```ts
  setCostToastFromResponse,
  confirmEndToastFromResponse,
```

Substituir o helper `run` (linha ~234):

```ts
  function run(
    body: { action: string; [k: string]: unknown },
    // Função quando a mensagem depende do que a EF respondeu — o toast é o
    // único retorno no instante da ação, e afirmar sucesso genérico esconde
    // justamente os casos que exigem uma segunda providência.
    successMsg: string | ((data: unknown) => string),
  ) {
    action.mutate(body, {
      onSuccess: (data: unknown) => {
        toast.success(typeof successMsg === "function" ? successMsg(data) : successMsg);
        closeDialog();
      },
      // A EF devolve mensagem curta em PT-BR; o hook já a extraiu do corpo
      // non-2xx que o invoke mascara.
      onError: (e: Error) => toast.error(e.message),
    });
  }
```

No call site do `set_cost` (linha ~834), trocar `"Custo atualizado."` por `setCostToastFromResponse`.
No call site do `confirm_end` (linha ~869), trocar `"Encerramento confirmado."` por `confirmEndToastFromResponse`.

Os demais call sites (`correct_cycle_cost`, `cancel`, `reactivate`, `resolve_alert`, `confirm_date`) continuam com string literal — a união aceita as duas formas.

- [ ] **Step 7: Gates**

```bash
npm run lint
npm run typecheck
npx vitest run
npm run build
npx eslint supabase/functions --max-warnings=0
```
Expected: todos verdes.

- [ ] **Step 8: Commit**

```bash
git add src/lib/whatsapp-instance-format.ts src/lib/whatsapp-instance-format.test.ts \
        src/pages/platform/WhatsappInstances.tsx \
        supabase/functions/manage-whatsapp-instances/index.ts
git diff --cached
git commit -m "$(cat <<'EOF'
feat(6c): toast de custo e encerramento passa a dizer o que a EF respondeu

Os campos `cycle_filled` e `closed_cycle_status` viajavam sem consumidor e o
toast era literal — afirmava sucesso genérico exatamente nos dois casos em que
resta uma providencia: ciclo aberto que nao mudou, e ciclo que fechou sem custo.
O `PENDING_REVIEW` so aparece dentro da secao expandida, entao o toast e o unico
retorno no instante da acao.

`set_cost` passa a devolver `has_open_cycle` (booleano, nao o id). A copy vive em
quatro funcoes puras em src/lib/, onde o tsc -b as alcanca e o vitest as testa de
verdade — ao contrario da EF. `hasOpenCycle: null` significa "a EF nao disse" e
nao afirma nada sobre o ciclo: na janela entre os deploys, tratar ausente como
`false` reintroduziria o mesmo defeito por outra porta.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Migration 105 — primeira confirmação vence nos três campos

**Files:**
- Create: `supabase/migrations/20260807110000_105_whatsapp_end_confirmation_first_wins.sql`
- Modify: `supabase/tests/local-preflight/05-ciclo-custo-e-fim.sql` (acrescentar `END-4` após `END-3`)
- Modify: `supabase/tests/local-preflight/06-controles-104.sql` (acrescentar `CONTROLE-5`)
- Modify: `supabase/tests/local-preflight/README.md`

**Interfaces:**
- Consome: a função `confirm_whatsapp_instance_end(uuid, text, uuid)` da migration 104.
- Produz: a mesma assinatura e o mesmo `returns table` — **nenhuma Edge Function muda**.

**A porta de entrada real (não é corrida):** `canTransition` tem curto-circuito de mesmo estado (`if (from === to) return { ok: true }`, `whatsapp-instance-core.ts:54`), e o botão "Confirmar encerramento" é renderizado a partir do `lifecycle_state` **em cache** do React Query, com `refetchOnWindowFocus: false` global. Uma aba parada de outro administrador, que ainda vê `CANCELLATION_REQUESTED`, continua oferecendo o botão depois do primeiro encerramento.

**Por que coalescer os três, e não nenhum:** `recordInstanceNote` roda em **toda** chamada de `confirm_end`, depois da RPC e sem condição — a segunda confirmação sobrevive em `whatsapp_instance_notes` com ator, nota e carimbo próprios. Coalescer não perde informação; move-a para onde ela pertence. Coalescer nenhum faria `ended_at = now()` a cada repetição, reescrevendo a data em que a plataforma parou de pagar o fornecedor por causa de uma aba desatualizada.

- [ ] **Step 1: Escrever o caso `END-4` (que vai falhar contra a 104)**

Acrescentar em `supabase/tests/local-preflight/05-ciclo-custo-e-fim.sql`, logo após o bloco `END-3` (antes de `CORR-1`):

```sql
-- ── END-4: repeticao NAO reescreve autoria nem nota do encerramento ──
-- A porta nao e corrida. `canTransition` tem curto-circuito de mesmo estado
-- (ENDED -> ENDED passa) e o botao do painel e renderizado a partir do
-- lifecycle_state EM CACHE do React Query, com refetchOnWindowFocus desligado:
-- uma aba parada de outro administrador continua oferecendo o botao.
--
-- Os dois atores sao os usuarios do 02-seed.sql — `ended_by` tem FK para
-- auth.users, entao uuid inventado abortaria o caso com foreign_key_violation.
do $$
declare v_at1 timestamptz; v_at2 timestamptz; v_by uuid; v_note text;
begin
  insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, cycle_source)
  values ('cc000000-0000-4000-8000-000000000003',
          (select id from organizations order by id limit 1), 'zapi', 'ACTIVE', 'ADMIN_CONFIRMED')
  on conflict (id) do nothing;

  perform confirm_whatsapp_instance_end('cc000000-0000-4000-8000-000000000003',
    'primeira', '11111111-1111-1111-1111-111111111111');
  select ended_at into v_at1 from whatsapp_instances
   where id = 'cc000000-0000-4000-8000-000000000003';

  perform confirm_whatsapp_instance_end('cc000000-0000-4000-8000-000000000003',
    'segunda', '22222222-2222-2222-2222-222222222222');
  select ended_at, ended_by, end_confirmation_note into v_at2, v_by, v_note
    from whatsapp_instances where id = 'cc000000-0000-4000-8000-000000000003';

  insert into t_res (ord, caso, veredito) values (60,
    'END-4 repeticao nao reescreve ended_by nem end_confirmation_note',
    case when v_at1 = v_at2
      and v_by = '11111111-1111-1111-1111-111111111111'
      and v_note = 'primeira'
    then 'PASSOU' else 'FALHOU' end);
end $$;
```

- [ ] **Step 2: Escrever a migration 105**

Criar `supabase/migrations/20260807110000_105_whatsapp_end_confirmation_first_wins.sql`:

```sql
-- Encerramento: a PRIMEIRA confirmacao vence nos TRES campos.
--
-- O DEFEITO QUE ESTA MIGRATION FECHA: na 104, `ended_at` coalesce mas `ended_by`
-- e `end_confirmation_note` sao sobrescritos. Numa repeticao a linha passa a
-- afirmar "encerrada em T1, por B, com a nota X" — quando B nao confirmou em T1.
-- Os tres campos descrevem O MESMO ato; dois deles falando de um ato e o
-- terceiro de outro nao e registro parcial, e registro falso.
--
-- A PORTA DE ENTRADA NAO E CORRIDA. `canTransition` tem curto-circuito de mesmo
-- estado (ENDED -> ENDED passa) e o botao "Confirmar encerramento" e renderizado
-- a partir do `lifecycle_state` EM CACHE do React Query, com
-- `refetchOnWindowFocus: false` global: uma aba parada de outro administrador
-- continua oferecendo o botao depois do primeiro encerramento.
--
-- NADA SE PERDE. `recordInstanceNote` roda em TODA chamada de `confirm_end`,
-- depois da RPC e sem condicao: a segunda confirmacao sobrevive em
-- `whatsapp_instance_notes` com ator, nota e carimbo proprios. Coalescer move a
-- informacao para onde ela pertence — a linha da instancia registra
-- coerentemente a PRIMEIRA confirmacao, o ledger registra todas.
--
-- NAO SE RECUSA `ENDED -> ENDED`. A RPC se declara idempotente, e recusar
-- transformaria um retry legitimo (timeout de rede sobre chamada que de fato
-- completou) num 409 confuso sobre operacao que ja deu certo.
--
-- NAO REESCREVE A 104. Migration aplicada nao se reescreve.
--
-- NAO TOCA DADO DE NENHUMA ORGANIZACAO. Substitui uma funcao, reescreve um
-- comentario e reemite ACL. Zero DML.

begin;

-- Corpo IDENTICO ao da 104, exceto pelos dois `coalesce` marcados abaixo.
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
         -- Os TRES campos do ato de encerrar coalescem JUNTOS. Separa-los faria
         -- a linha descrever dois atos ao mesmo tempo.
         ended_at = coalesce(ended_at, now()),
         ended_by = coalesce(ended_by, p_actor),
         end_confirmation_note = coalesce(end_confirmation_note, p_note),
         -- Encerrada nao guarda vinculo de canal: libera o indice unico de
         -- channel_id para uma instancia futura no mesmo canal.
         channel_id = null,
         -- E o que faz o painel parar de anunciar "em curso" numa instancia
         -- encerrada. Mesmo que a 090 faz no ramo CLOSED_NO_REOPEN.
         current_cycle_started_on = null,
         current_cycle_due_on = null,
         -- `updated_by`/`updated_at` NAO coalescem, de proposito: eles descrevem
         -- a ultima escrita na linha, nao o ato de encerrar.
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
  'Marca a instancia ENDED, limpa a projecao de ciclo e FECHA o ciclo OPEN pela regra do vencimento (sem custo -> PENDING_REVIEW). Idempotente: a PRIMEIRA confirmacao vence em ended_at, ended_by e end_confirmation_note — repeticoes ficam no ledger whatsapp_instance_notes. Nao revalida a transicao — isso e da Edge Function.';

-- ACL — `create or replace` PRESERVA a ACL existente, mas reemitir e idempotente
-- e mantem esta migration correta num replay onde a funcao ainda nao exista
-- (CREATE FUNCTION concede EXECUTE a PUBLIC por padrao).
revoke all on function public.confirm_whatsapp_instance_end(uuid, text, uuid)
  from public, anon, authenticated;

grant execute on function public.confirm_whatsapp_instance_end(uuid, text, uuid)
  to service_role;

commit;

-- =====================================================================
-- Validacao pos-migration
-- =====================================================================
-- 1. ACL (esperado: nenhuma entrada anon= ou authenticated=):
--   select proname, proacl from pg_proc where proname = 'confirm_whatsapp_instance_end';
--
-- 2. search_path fixado (esperado: search_path=public):
--   select proname, proconfig from pg_proc where proname = 'confirm_whatsapp_instance_end';
--
-- 3. Corpo com os tres coalesce (esperado: 3 ocorrencias):
--   select prosrc from pg_proc where proname = 'confirm_whatsapp_instance_end';
--
-- 4. Reaplicar a migration inteira nao muda nada (idempotencia).
--
-- 5. COMPORTAMENTO — caso END-4 em
--    supabase/tests/local-preflight/05-ciclo-custo-e-fim.sql, com o
--    CONTROLE-5 do 06.
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- Reaplicar a 104 restaura a versao anterior da funcao. Nenhum dado precisa ser
-- desfeito: esta migration nao escreve linha nenhuma.
```

- [ ] **Step 3: Escrever o `CONTROLE-5`**

Acrescentar ao fim de `supabase/tests/local-preflight/06-controles-104.sql`:

```sql
-- ── CONTROLE-5: reintroduzir a sobrescrita de autoria e nota (105) ───
-- Sem ele, "END-4 passou" nao distingue *a guarda funciona* de *o teste nao
-- testa nada*. `ended_at` MANTEM o coalesce aqui: o defeito isolado e o dos
-- outros dois campos, e mexer nos tres borraria o que este controle mede.
--
-- Restaurar = reaplicar a 104 e DEPOIS a 105, nesta ordem (a 105 supera a 104).
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
  if not found then
    return query select false, null::text, null::uuid, null::text;
    return;
  end if;
  -- DEFEITO REINTRODUZIDO (105): autoria e nota sobrescritas na repeticao.
  update whatsapp_instances
     set lifecycle_state = 'ENDED',
         ended_at = coalesce(ended_at, now()),
         ended_by = p_actor,
         end_confirmation_note = p_note,
         updated_at = now()
   where id = p_instance_id;
  return query select true, v_inst.lifecycle_state::text, null::uuid, null::text;
end;
$$;

do $$
declare v_at1 timestamptz; v_at2 timestamptz; v_by uuid; v_note text;
begin
  -- Instancia PROPRIA deste controle: a do END-4 (…0003) ja esta ENDED com a
  -- autoria da primeira confirmacao, e reusa-la mediria a linha errada.
  insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, cycle_source)
  values ('cc000000-0000-4000-8000-000000000005',
          (select id from organizations order by id limit 1), 'zapi', 'ACTIVE', 'ADMIN_CONFIRMED')
  on conflict (id) do nothing;

  perform confirm_whatsapp_instance_end('cc000000-0000-4000-8000-000000000005',
    'primeira', '11111111-1111-1111-1111-111111111111');
  select ended_at into v_at1 from whatsapp_instances
   where id = 'cc000000-0000-4000-8000-000000000005';

  perform confirm_whatsapp_instance_end('cc000000-0000-4000-8000-000000000005',
    'segunda', '22222222-2222-2222-2222-222222222222');
  select ended_at, ended_by, end_confirmation_note into v_at2, v_by, v_note
    from whatsapp_instances where id = 'cc000000-0000-4000-8000-000000000005';

  insert into t_res (ord, caso, veredito) values (65,
    'CONTROLE-5 sem o coalesce, a repeticao reescreve autoria e nota sobre a data da primeira',
    case when v_at1 = v_at2
      and v_by = '22222222-2222-2222-2222-222222222222'
      and v_note = 'segunda'
    then 'REPRODUZIU' else 'NAO REPRODUZIU' end);
end $$;
```

- [ ] **Step 4: Atualizar o README do harness**

Em `supabase/tests/local-preflight/README.md`:

1. Na tabela de arquivos, trocar a linha do `05` por:

```markdown
| `05-ciclo-custo-e-fim.sql` | COST-1..4, END-1..4, CORR-1..2 e CYCLE-1..2 — comportamento das RPCs `set_whatsapp_instance_cost` (104) e `confirm_whatsapp_instance_end` (104 + 105), e a colisão dos dois índices que produzem `23505`. Mesmo padrão: cada caso numa subtransação, veredito em `t_res`. |
```

2. Na tabela, trocar a linha do `06` por:

```markdown
| `06-controles-104.sql` | Os **três** controles positivos (104 e 105). Sem eles, "COST-2 passou", "END-1 passou" e "END-4 passou" não distinguem a guarda funcionando de teste sem força. |
```

3. No bloco `## Rodar`, substituir as quatro últimas linhas de `P -f` por:

```bash
P -f supabase/migrations/20260807100000_104_whatsapp_cycle_cost_and_end.sql
P -f supabase/migrations/20260807110000_105_whatsapp_end_confirmation_first_wins.sql
P -f supabase/tests/local-preflight/05-ciclo-custo-e-fim.sql
P -f supabase/tests/local-preflight/06-controles-104.sql   # SEM ON_ERROR_STOP
# 06 mexe nas RPCs de proposito — reaplicar 104 e DEPOIS 105 restaura as reais.
# A ordem importa: a 105 supera a 104 em confirm_whatsapp_instance_end.
P -f supabase/migrations/20260807100000_104_whatsapp_cycle_cost_and_end.sql
P -f supabase/migrations/20260807110000_105_whatsapp_end_confirmation_first_wins.sql
```

4. Na seção "O que os dois controles do `06` fazem", trocar o título para "O que os três controles do `06` fazem" e acrescentar ao fim:

```markdown
**CONTROLE-5** devolve a `confirm_whatsapp_instance_end` a sobrescrita de
`ended_by` e `end_confirmation_note` que a 105 corrige, mantendo o `coalesce` de
`ended_at` — e mostra a linha afirmando "encerrada em T1, por B, com a nota de
B", que é o registro falso. Restaurar exige reaplicar a **104 e depois a 105**,
nesta ordem.
```

- [ ] **Step 5: Rodar o harness inteiro**

```bash
PG="$USERPROFILE/scoop/apps/postgresql/current/bin"
"$PG/pg_ctl.exe" -D "$USERPROFILE/scoop/apps/postgresql/current/data" -l /tmp/pg.log -o "-p 55432" start
"$PG/dropdb.exe"   -h 127.0.0.1 -p 55432 -U postgres --if-exists fase6c
"$PG/createdb.exe" -h 127.0.0.1 -p 55432 -U postgres fase6c
```

Depois a sequência completa do README (com a 105 inserida). Expected:

- `END-4` → `PASSOU`
- `CONTROLE-5` → `REPRODUZIU`
- Todos os casos anteriores (`51`–`59`, `61`, `62`) mantêm o veredito que já tinham.

**Verificação do controle positivo:** rodar o harness UMA vez sem aplicar a 105 (só a 104) e confirmar que `END-4` sai `FALHOU`. Só então aplicar a 105 e confirmar `PASSOU`. Sem esse par, o caso não prova nada.

Ao terminar: `dropdb fase6c` e `pg_ctl stop`.

- [ ] **Step 6: Gates**

```bash
npm run lint && npm run typecheck && npx vitest run && npm run build
```
Expected: verdes. (A 105 é SQL; não afeta o build, mas o gate roda inteiro.)

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260807110000_105_whatsapp_end_confirmation_first_wins.sql \
        supabase/tests/local-preflight/05-ciclo-custo-e-fim.sql \
        supabase/tests/local-preflight/06-controles-104.sql \
        supabase/tests/local-preflight/README.md
git diff --cached
git commit -m "$(cat <<'EOF'
fix(6c): migration 105 — primeira confirmacao vence nos tres campos do encerramento

Na 104 `ended_at` coalesce mas `ended_by` e `end_confirmation_note` sao
sobrescritos: numa repeticao a linha afirma "encerrada em T1, por B, com a nota
de B" — registro falso, nao registro parcial.

A porta nao e corrida. `canTransition` tem curto-circuito de mesmo estado e o
botao do painel e renderizado a partir do lifecycle_state EM CACHE, com
refetchOnWindowFocus desligado: uma aba parada de outro administrador continua
oferecendo o botao. Nada se perde ao coalescer — `recordInstanceNote` roda em
toda chamada, entao a segunda confirmacao sobrevive no ledger com ator, nota e
carimbo proprios.

END-4 no harness com CONTROLE-5 (o defeito reintroduzido, `ended_at` intacto
para isolar o que se mede). README ganha a 105 na sequencia e a ordem de
restauracao 104 -> 105.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `confirm_cycle_date` distingue os dois erros por trás do `23505`

**Files:**
- Modify: `supabase/functions/manage-whatsapp-instances/index.ts` (bloco `confirm_cycle_date`, ~linhas 902-911)
- Modify: `supabase/tests/local-preflight/05-ciclo-custo-e-fim.sql` (acrescentar `CYCLE-1` e `CYCLE-2` ao fim)

**Interfaces:**
- Consome: nada de tarefas anteriores.
- Produz: o código de erro `OPEN_CYCLE_DATE_MISMATCH` (409). A tarefa 5 afirma sobre ele.

**A alcançabilidade, rastreada.** Dois índices de `whatsapp_instance_cycles` produzem `23505` (migration 088, linhas 79-87): `whatsapp_cycles_instance_start_idx (instance_id, cycle_start)` — reexecução com a MESMA data, idempotência genuína — e `whatsapp_cycles_one_open_idx (instance_id) WHERE status='OPEN'` — já existe outro ciclo aberto, com data DIFERENTE. A EF trata os dois como reexecução e segue gravando a projeção **com a data nova**. Para divergir é preciso o estado *ciclo OPEN + `cycle_source = 'UNKNOWN'`*: o botão "Confirmar data" só aparece com `UNKNOWN` e some após o sucesso; a rolagem grava `SYSTEM_ROLLED` e nunca alcança instância com `current_cycle_due_on` nulo. Sobra **uma** porta — a falha parcial que a própria EF documenta (insert do ciclo OK, `UPDATE` da projeção falha, 500 *"Ciclo registrado, mas a projeção na instância falhou"*), que deixa `UNKNOWN` **com** ciclo OPEN e o botão visível. Um retry com data diferente faz instância e ciclo discordarem da janela: o D-7/D-1 dispara pela data errada e a rolagem 090 abre o ciclo seguinte a partir do `provider_due_on` do **ciclo**, deixando um buraco permanente.

- [ ] **Step 1: Escrever `CYCLE-1` e `CYCLE-2` (a metade do banco)**

Acrescentar ao fim de `supabase/tests/local-preflight/05-ciclo-custo-e-fim.sql`:

```sql
-- ── CYCLE-1 / CYCLE-2: os DOIS indices que produzem 23505 ────────────
-- `whatsapp_cycles_instance_start_idx (instance_id, cycle_start)` significa
-- reexecucao com a MESMA data (idempotencia genuina).
-- `whatsapp_cycles_one_open_idx (instance_id) WHERE status='OPEN'` significa
-- que existe OUTRO ciclo aberto, com data DIFERENTE.
-- Os dois erros sao 23505. O par de casos abaixo torna a colisao visivel e
-- prova o DISCRIMINADOR que a Edge Function usa: existe linha com ESTA
-- cycle_start?

-- ── CYCLE-1: mesma data — 23505 E a linha daquela data existe ────────
do $$
declare v_code text; v_exists boolean;
begin
  insert into whatsapp_instances (id, organization_id, provider, lifecycle_state, cycle_source)
  values ('cc000000-0000-4000-8000-000000000004',
          (select id from organizations order by id limit 1), 'zapi', 'ACTIVE', 'UNKNOWN')
  on conflict (id) do nothing;
  delete from whatsapp_instance_cycles where instance_id = 'cc000000-0000-4000-8000-000000000004';
  insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on, status)
  values ('cc000000-0000-4000-8000-000000000004',
          (select organization_id from whatsapp_instances where id = 'cc000000-0000-4000-8000-000000000004'),
          date '2026-05-01', date '2026-06-01', 'OPEN');

  begin
    insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on, status)
    values ('cc000000-0000-4000-8000-000000000004',
            (select organization_id from whatsapp_instances where id = 'cc000000-0000-4000-8000-000000000004'),
            date '2026-05-01', date '2026-06-01', 'OPEN');
  exception when unique_violation then
    v_code := sqlstate;
  end;

  select exists (select 1 from whatsapp_instance_cycles
                  where instance_id = 'cc000000-0000-4000-8000-000000000004'
                    and cycle_start = date '2026-05-01') into v_exists;

  insert into t_res (ord, caso, veredito) values (63,
    'CYCLE-1 mesma data: 23505 e a linha daquela cycle_start EXISTE (reexecucao)',
    case when v_code = '23505' and v_exists then 'PASSOU' else 'FALHOU' end);
end $$;

-- ── CYCLE-2: data diferente — 23505 E nenhuma linha daquela data ─────
do $$
declare v_code text; v_exists boolean;
begin
  begin
    insert into whatsapp_instance_cycles (instance_id, organization_id, cycle_start, provider_due_on, status)
    values ('cc000000-0000-4000-8000-000000000004',
            (select organization_id from whatsapp_instances where id = 'cc000000-0000-4000-8000-000000000004'),
            date '2026-06-15', date '2026-07-15', 'OPEN');
  exception when unique_violation then
    v_code := sqlstate;
  end;

  select exists (select 1 from whatsapp_instance_cycles
                  where instance_id = 'cc000000-0000-4000-8000-000000000004'
                    and cycle_start = date '2026-06-15') into v_exists;

  insert into t_res (ord, caso, veredito) values (64,
    'CYCLE-2 data diferente: 23505 e NENHUMA linha daquela cycle_start (divergencia)',
    case when v_code = '23505' and v_exists = false then 'PASSOU' else 'FALHOU' end);
end $$;
```

- [ ] **Step 2: Rodar os dois casos e confirmar `PASSOU`**

Rodar a sequência do README. Expected: `CYCLE-1` e `CYCLE-2` → `PASSOU`. Os dois já passam contra o schema atual — eles descrevem o **banco**, e é a EF que vai mudar. O que eles impedem é alguém "simplificar" os índices da 088 e quebrar o discriminador em silêncio.

- [ ] **Step 3: Desambiguar o `23505` na Edge Function**

Em `supabase/functions/manage-whatsapp-instances/index.ts`, no bloco `confirm_cycle_date`, substituir o comentário e o `if` que hoje tratam o `23505` (o trecho que começa em `// 23505 = o ciclo já existia (reexecução).` e vai até o fecho do `if (cycleErr && cycleErr.code !== "23505") { … }`) por:

```ts
      if (cycleErr) {
        if (cycleErr.code === "23505") {
          // DOIS indices produzem 23505 aqui, e significam coisas OPOSTAS:
          //
          //   whatsapp_cycles_instance_start_idx (instance_id, cycle_start)
          //     -> reexecucao com a MESMA data. Idempotencia genuina.
          //   whatsapp_cycles_one_open_idx (instance_id) WHERE status='OPEN'
          //     -> ja existe OUTRO ciclo aberto, com data DIFERENTE.
          //
          // Tratar os dois como reexecucao gravava a projecao com a data NOVA
          // sobre um ciclo que guarda outra: instancia e ciclo passavam a
          // discordar da janela em silencio, o D-7/D-1 disparava pela data
          // errada e a rolagem 090 abria o ciclo seguinte a partir do
          // `provider_due_on` do CICLO, deixando um buraco permanente.
          //
          // O discriminador e a existencia da linha com ESTA `cycle_start` —
          // `(instance_id, cycle_start)` e UNIQUE, entao `maybeSingle` aqui nao
          // pode receber duas linhas.
          const { data: sameStart, error: sameStartErr } = await supabase
            .from("whatsapp_instance_cycles")
            .select("id")
            .eq("instance_id", id)
            .eq("cycle_start", cycleStart)
            .maybeSingle();

          if (sameStartErr) {
            jsonLog("error", {
              reqId, evt: "wa_cycle_conflict_read_failed", instanceId: id,
              err: sameStartErr.message, needsAdminAction: true,
            });
            // FAIL-CLOSED: gravar a projecao sem saber qual indice recusou e
            // exatamente a divergencia que este ramo existe para impedir.
            return jsonResponse(req, {
              error: "Não foi possível verificar o ciclo já existente. Tente de novo.",
            }, 503);
          }

          if (!sameStart) {
            jsonLog("warn", {
              reqId, evt: "wa_cycle_open_date_mismatch", instanceId: id,
              cycleStart, needsAdminAction: true,
            });
            return jsonResponse(req, {
              error: "Já existe um ciclo em aberto com outra data de início. Confira os ciclos desta instância antes de confirmar a data.",
              code: "OPEN_CYCLE_DATE_MISMATCH",
            }, 409);
          }

          // Mesma data: reexecucao. Segue — e o ciclo que ja estava la NAO e
          // preenchido por este caminho: ele pode ter sido rolado ou fechado
          // desde entao, e mexer nele como efeito colateral de uma reexecucao e
          // o tipo de escrita nao-auditada que esta frente combate. Reparo de
          // ciclo existente tem porta propria (`correct_cycle_cost`).
        } else {
          jsonLog("error", { reqId, evt: "wa_cycle_confirm_failed", err: cycleErr.message });
          return jsonResponse(req, { error: "Não foi possível registrar o ciclo." }, 500);
        }
      }
```

- [ ] **Step 4: Gates**

```bash
npx eslint supabase/functions --max-warnings=0
npm run lint && npm run typecheck && npx vitest run && npm run build
```
Expected: verdes.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/manage-whatsapp-instances/index.ts \
        supabase/tests/local-preflight/05-ciclo-custo-e-fim.sql
git diff --cached
git commit -m "$(cat <<'EOF'
fix(6c): confirm_cycle_date distingue os dois erros por tras do 23505

Dois indices de whatsapp_instance_cycles produzem 23505 e significam coisas
opostas: `(instance_id, cycle_start)` e reexecucao da mesma data; o parcial
`WHERE status='OPEN'` e outro ciclo aberto com data DIFERENTE. A EF tratava os
dois como reexecucao e seguia gravando a projecao com a data nova — instancia e
ciclo passavam a discordar da janela em silencio, o D-7/D-1 disparava pela data
errada e a rolagem 090 abria o ciclo seguinte a partir do provider_due_on do
CICLO, deixando buraco permanente.

Alcancavel por uma porta so, rastreada: a falha parcial que a propria EF
documenta (insert OK, projecao falha, 500) deixa cycle_source=UNKNOWN com ciclo
OPEN e o botao visivel; o retry com data diferente cai no indice parcial.

Discriminador: existe linha com ESTA cycle_start? Sim -> idempotente. Nao -> 409
OPEN_CYCLE_DATE_MISMATCH sem gravar a projecao. Erro de leitura -> 503,
fail-closed. CYCLE-1/CYCLE-2 no harness tornam a colisao visivel.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: A guarda de unidade duplicada vale nas DUAS portas

**Files:**
- Modify: `supabase/functions/manage-whatsapp-instances/index.ts` (bloco `update_instance`, ~linhas 1287-1305)
- Modify: `src/components/platform/UpdateInstanceDialog.tsx`

**Interfaces:**
- Consome: `checkUnitInstanceConflict` e `UNIT_ALREADY_HAS_INSTANCE_MESSAGE` de `../_shared/whatsapp-instance-registration-core.ts` — **já importados** no topo da EF pelo caminho do registro. Nenhum import novo.
- Produz: 409 `UNIT_ALREADY_HAS_INSTANCE` com `conflicts: []` também no `update_instance`. A tarefa 5 afirma sobre isso.

**Por que entra.** `if ("unit_id" in body) patch.unit_id = body.unit_id ?? null;` não consulta nada, e não é porta de fundos: `UpdateInstanceDialog` tem um `Select` **"Unidade"** — mover instância entre unidades é caminho de UI comum. O estado que a guarda do registro impede (duas instâncias `lifecycle_state <> 'ENDED'` na mesma unidade) fica plenamente alcançável, e *"registro recusa, mover aceita"* é pior que *"nenhum dos dois confere"*: cria confiança falsa numa guarda que esta mesma frente instalou.

- [ ] **Step 1: Validar o `unit_id` no patch**

Em `supabase/functions/manage-whatsapp-instances/index.ts`, no bloco `update_instance`, substituir:

```ts
      if ("unit_id" in body) patch.unit_id = body.unit_id ?? null;
```

por:

```ts
      // `parseUuid` como no registro. Sem ele, um valor malformado cairia na
      // consulta de conflito abaixo e viraria 503 — mensagem errada para o que
      // e um erro do cliente. Hoje o banco recusa com 22P02 e a EF devolve 500.
      if ("unit_id" in body) {
        if (body.unit_id == null) {
          patch.unit_id = null;
        } else {
          const parsed = parseUuid(body.unit_id);
          if (!parsed) return jsonResponse(req, { error: "unit_id inválido." }, 400);
          patch.unit_id = parsed;
        }
      }
```

- [ ] **Step 2: Consultar a guarda antes do `UPDATE`**

Ainda em `update_instance`, imediatamente **antes** do `const { data, error } = await supabase.from("whatsapp_instances").update(patch)…`, inserir:

```ts
      // A GUARDA DE UNIDADE DUPLICADA VALE NAS DUAS PORTAS. O registro a tem
      // desde a 6c; sem ela aqui, mover uma instancia para uma unidade ja
      // ocupada produz exatamente o estado que o registro recusa — e "registro
      // recusa, mover aceita" e pior que nenhum dos dois conferir: cria
      // confianca falsa numa guarda que existe.
      //
      // MESMO nucleo do registro (`checkUnitInstanceConflict`), nao uma segunda
      // regra. `whatsapp-connection-allowance-core.ts` continua fora disto: ele
      // responde "o modelo comercial permite mais uma conexao?" e e
      // compartilhado com `manage-channels`.
      const nextUnitId = typeof patch.unit_id === "string" ? patch.unit_id : null;
      if (nextUnitId) {
        const cur = await loadInstanceState(
          id, "unit_id", reqId, "wa_instance_update_lookup_failed",
        );
        if (cur.ok === false) return jsonResponse(req, { error: cur.message }, cur.status);

        // Patch que reenvia a MESMA unidade nao e conflito. Sem este pulo, uma
        // unidade com duas instancias legitimamente reconhecidas no passado
        // exigiria nova confirmacao a cada correcao de identificador.
        if (cur.row.unit_id !== nextUnitId) {
          const { data: sameUnit, error: sameUnitErr } = await supabase
            .from("whatsapp_instances")
            .select("id, lifecycle_state, provider_instance_ref, created_at")
            .eq("unit_id", nextUnitId)
            .neq("lifecycle_state", "ENDED")
            // Unica diferenca de desenho contra o registro. Redundante DADO o
            // pulo acima — e de proposito: mantem a consulta correta por si so,
            // para que reestruturar o pulo nao reintroduza o auto-conflito em
            // silencio.
            .neq("id", id);

          // FALHA em vez de degradar, como no registro: lista vazia por erro de
          // leitura liberaria exatamente o que a guarda existe para barrar.
          if (sameUnitErr) {
            jsonLog("error", {
              reqId, evt: "wa_unit_conflict_read_failed", unitId: nextUnitId,
              err: sameUnitErr.message, needsAdminAction: true,
            });
            return jsonResponse(req, { error: ALLOWANCE_UNVERIFIABLE }, 503);
          }

          const conflicts = (sameUnit ?? []) as Record<string, unknown>[];
          const unitCheck = checkUnitInstanceConflict({
            unitScoped: true,
            conflicts: conflicts.map((c) => ({
              id: String(c.id),
              lifecycleState: String(c.lifecycle_state),
            })),
            acknowledged: body.acknowledge_unit_conflict === true,
          });

          if (unitCheck.ok === false) {
            jsonLog("warn", {
              reqId, evt: "wa_unit_conflict_denied", unitId: nextUnitId,
              conflicts: conflicts.length, callerId, action: "update_instance",
            });
            return jsonResponse(req, {
              error: UNIT_ALREADY_HAS_INSTANCE_MESSAGE,
              code: "UNIT_ALREADY_HAS_INSTANCE",
              conflicts,
            }, 409);
          }
        }
      }
```

- [ ] **Step 3: O diálogo trata o 409 como pergunta, não como erro**

Em `src/components/platform/UpdateInstanceDialog.tsx`:

**3a.** Acrescentar o estado, logo após `const [reason, setReason] = useState("");`:

```tsx
  /**
   * 409 de unidade ocupada nao e erro terminal: e uma pergunta. Mover uma
   * segunda instancia para a mesma unidade continua possivel — como ATO
   * CONSCIENTE. Mesmo fluxo do RegisterInstanceDialog.
   */
  const [unitConflicts, setUnitConflicts] = useState<
    { id: string; lifecycle_state: string; provider_instance_ref: string | null }[] | null
  >(null);
```

**3b.** No `useEffect` de recarga, acrescentar `setUnitConflicts(null);` junto com `setReason("");`.

**3c.** No `onValueChange` do `Select` de unidade, acrescentar `setUnitConflicts(null);` após `setChannelId(NO_CHANNEL);` — trocar a unidade de destino invalida o conflito já mostrado.

**3d.** Substituir `submit()` por:

```tsx
  function submit(acknowledgeConflict = false) {
    if (!instance || !hasChanges) return;
    action.mutate(
      {
        action: "update_instance",
        instance_id: instance.id,
        ...patch,
        ...(acknowledgeConflict ? { acknowledge_unit_conflict: true } : {}),
        reason,
      },
      {
        onSuccess: () => {
          toast.success("Vínculo corrigido.");
          setUnitConflicts(null);
          onOpenChange(false);
        },
        onError: (e: Error & { code?: string; body?: Record<string, unknown> }) => {
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

**3e.** Antes do bloco `{!hasChanges && (…)}`, inserir o aviso:

```tsx
          {unitConflicts && unitConflicts.length > 0 && (
            <div className="rounded-md border border-warning bg-warning/10 p-3 space-y-2 text-sm">
              <p className="font-medium">A unidade de destino já tem instância registrada.</p>
              <ul className="space-y-1 text-xs">
                {unitConflicts.map((c) => (
                  <li key={c.id}>
                    <span className="font-mono">
                      {c.provider_instance_ref ?? "sem identificador"}
                    </span>
                    {" — "}
                    {c.lifecycle_state === "CANCELLATION_REQUESTED"
                      ? "cancelamento solicitado (ainda custa)"
                      : "ativa"}
                  </li>
                ))}
              </ul>
              <p className="text-xs">
                Mover esta instância para lá significa que a unidade passa a ter duas. Confirme só
                se for isso mesmo.
              </p>
            </div>
          )}
```

**3f.** Substituir o botão de salvar:

```tsx
            <Button
              disabled={!hasChanges || reasonTooShort || action.isPending}
              onClick={() => submit(unitConflicts !== null && unitConflicts.length > 0)}
            >
              {unitConflicts && unitConflicts.length > 0 ? "Mover mesmo assim" : "Salvar correção"}
            </Button>
```

- [ ] **Step 4: Gates**

```bash
npx eslint supabase/functions --max-warnings=0
npm run lint && npm run typecheck && npx vitest run && npm run build
```
Expected: verdes.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/manage-whatsapp-instances/index.ts \
        src/components/platform/UpdateInstanceDialog.tsx
git diff --cached
git commit -m "$(cat <<'EOF'
fix(6c): guarda de unidade duplicada vale tambem ao mover a instancia

`update_instance` gravava unit_id sem consultar nada, e o UpdateInstanceDialog
tem um Select de unidade — mover instancia entre unidades e caminho de UI comum.
O estado que o registro recusa (duas instancias nao-ENDED na mesma unidade)
ficava plenamente alcancavel, e "registro recusa, mover aceita" e pior que
nenhum dos dois conferir: cria confianca falsa numa guarda que existe.

REUSO do `checkUnitInstanceConflict`, nao regra nova; o nucleo nao muda e
whatsapp-connection-allowance-core.ts (compartilhado com manage-channels) nao e
tocado. Duas diferencas contra o registro: pula a checagem quando unit_id nao
esta mudando (patch que reenvia a mesma unidade nao e conflito) e exclui a
propria instancia da consulta. unit_id ganha parseUuid — sem ele, valor
malformado viraria 503 em vez de 400.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Guardrail estático das escritas condicionais da EF + a ressalva no README

**Files:**
- Create: `src/lib/whatsapp-instance-ef-write-guard.test.ts`
- Modify: `supabase/tests/local-preflight/README.md`

**Interfaces:**
- Consome: o código produzido pelas tarefas 3 e 4 (o `OPEN_CYCLE_DATE_MISMATCH` e a chamada a `checkUnitInstanceConflict` em `update_instance`). **Esta tarefa roda depois delas.**
- Produz: nada consumido por outra tarefa.

**O achado.** `CORR-1` e `CORR-2` reescrevem o `UPDATE` à mão em SQL. Provam que o CHECK `whatsapp_cycles_closed_needs_cost_chk` aceita custo e status mudando juntos e que o predicado casa — **a metade do banco**. Nenhum teste falharia se o `UPDATE` real de `correct_cycle_cost` perdesse o `.eq("status", "PENDING_REVIEW")` ou a conferência de `updated.length`. O próprio arquivo `05` admite isso num comentário; o **README não admite**, e é ele que se lê.

**O que este guardrail é, e o que não é.** O repo tem doze guardrails estáticos que leem fonte de Edge Function com `readFileSync` + regex, e `whatsapp-gate-coupling-guard.test.ts:11-14` já registra a razão: os `index.ts` importam `deno.land`/`esm.sh` e chamam `serve()` no carregamento, então o vitest não consegue importá-los. Isto **não** é "a EF foi exercitada". É uma afirmação mais estreita e verdadeira: *as coisas que quebrariam em silêncio não podem sumir sem teste vermelho.*

**Alternativa descartada:** extrair um núcleo puro de `correct_cycle_cost`. O que está em risco é **forma de I/O** — o predicado do PostgREST e a conferência do retorno —, não decisão. Um núcleo puro não sustenta nenhum dos dois e daria a mesma impressão falsa com mais cerimônia.

- [ ] **Step 1: Escrever o guardrail**

Criar `src/lib/whatsapp-instance-ef-write-guard.test.ts`:

```ts
/**
 * Guardrail ESTÁTICO das escritas CONDICIONAIS de
 * `manage-whatsapp-instances/index.ts`.
 *
 * Um tema, um arquivo: *o predicado que protege uma escrita não pode sumir sem
 * teste vermelho*. É a família de defeito que a frente 6c inteira combate —
 * escrita condicional cujo predicado, se some, some em silêncio.
 *
 * POR QUE TEXTUAL. Os `index.ts` importam `deno.land` / `esm.sh` e chamam
 * `serve()` no carregamento, então o vitest não consegue importá-los (mesma
 * razão registrada em `whatsapp-gate-coupling-guard.test.ts`). Análise estática
 * de texto é o que resta — e é mais do que existia antes.
 *
 * O QUE ISTO NÃO É. Não é "a Edge Function foi exercitada". Os casos CORR-1 e
 * CORR-2 do harness reescrevem o UPDATE à mão em SQL: provam que o CHECK aceita
 * custo e status mudando juntos e que o predicado casa — a metade do banco.
 * Nenhum teste falharia se o UPDATE real perdesse o `.eq("status", …)` ou a
 * conferência de zero linhas. Este arquivo fecha essa metade, e só ela.
 *
 * ALTERNATIVA DESCARTADA: extrair núcleo puro de `correct_cycle_cost`. O risco é
 * FORMA DE I/O (predicado do PostgREST, conferência do retorno), não decisão —
 * um núcleo puro não sustenta nenhum dos dois e daria a mesma impressão falsa
 * com mais cerimônia.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EF = "supabase/functions/manage-whatsapp-instances/index.ts";
const src = readFileSync(resolve(process.cwd(), EF), "utf8");

/** O corpo de um `if (action === "<nome>") { … }` até o próximo bloco de ação. */
function blocoDaAcao(nome: string): string {
  const inicio = src.indexOf(`action === "${nome}"`);
  expect(inicio, `bloco da ação ${nome} não encontrado`).toBeGreaterThan(-1);
  const resto = src.slice(inicio + 1);
  const proximo = resto.search(/action === "/);
  return proximo === -1 ? resto : resto.slice(0, proximo);
}

describe("correct_cycle_cost — a única porta que muda custo já gravado", () => {
  const bloco = blocoDaAcao("correct_cycle_cost");

  it("o UPDATE carrega o compare-and-set de PENDING_REVIEW", () => {
    // Sem este predicado, a correção alcança ciclo CLOSED — que fechou
    // financeiramente concluído e cuja reabertura exigiria política que não
    // existe.
    expect(bloco).toMatch(/\.eq\(\s*["'`]status["'`]\s*,\s*["'`]PENDING_REVIEW["'`]\s*\)/);
  });

  it("confere que alguma linha foi tocada, e não confia em error === null", () => {
    // UPDATE do Supabase JS que casa ZERO linhas devolve `error: null`. Sem a
    // conferência, "o predicado negou" é indistinguível de "gravei".
    expect(bloco).toMatch(/\.select\(/);
    expect(bloco).toMatch(/\.length\b/);
  });

  it("recusa com CYCLE_NOT_PENDING_REVIEW quando nada foi tocado", () => {
    expect(bloco).toMatch(/CYCLE_NOT_PENDING_REVIEW/);
  });
});

describe("confirm_cycle_date — o 23505 não é presumido reexecução", () => {
  const bloco = blocoDaAcao("confirm_cycle_date");

  it("desambigua o 23505 consultando a cycle_start", () => {
    // Dois índices produzem 23505 e significam coisas opostas. O discriminador
    // é a existência da linha com ESTA `cycle_start`.
    expect(bloco).toMatch(/23505/);
    expect(bloco).toMatch(/\.eq\(\s*["'`]cycle_start["'`]\s*,\s*cycleStart\s*\)/);
  });

  it("recusa com OPEN_CYCLE_DATE_MISMATCH a data divergente", () => {
    expect(bloco).toMatch(/OPEN_CYCLE_DATE_MISMATCH/);
  });

  it("não trata o 23505 como sucesso puro e simples", () => {
    // A forma antiga — `if (cycleErr && cycleErr.code !== "23505")` — seguia
    // direto para a projeção com a data nova. Ela não pode voltar.
    expect(bloco).not.toMatch(/cycleErr\.code\s*!==\s*["'`]23505["'`]/);
  });
});

describe("update_instance — a guarda de unidade vale nesta porta também", () => {
  const bloco = blocoDaAcao("update_instance");

  it("chama o MESMO núcleo do registro, não uma segunda regra", () => {
    expect(bloco).toMatch(/checkUnitInstanceConflict\s*\(/);
  });

  it("consulta as instâncias não-ENDED da unidade de destino", () => {
    expect(bloco).toMatch(/\.neq\(\s*["'`]lifecycle_state["'`]\s*,\s*["'`]ENDED["'`]\s*\)/);
  });

  it("exclui a própria instância da consulta de conflito", () => {
    // Sem isto a instância se auto-conflita quando o patch reenvia a unidade em
    // que ela já está.
    expect(bloco).toMatch(/\.neq\(\s*["'`]id["'`]\s*,\s*id\s*\)/);
  });

  it("recusa com UNIT_ALREADY_HAS_INSTANCE e devolve as conflitantes", () => {
    expect(bloco).toMatch(/UNIT_ALREADY_HAS_INSTANCE/);
    expect(bloco).toMatch(/conflicts/);
  });

  it("falha fechado quando a leitura do conflito falha", () => {
    // Lista vazia por erro de leitura liberaria exatamente o que a guarda barra.
    expect(bloco).toMatch(/ALLOWANCE_UNVERIFIABLE/);
  });

  it("valida o unit_id como uuid antes de consultar", () => {
    expect(bloco).toMatch(/parseUuid\s*\(/);
  });
});

describe("a EF importa o núcleo compartilhado, não uma cópia", () => {
  it("importa checkUnitInstanceConflict do registro", () => {
    expect(src).toMatch(/whatsapp-instance-registration-core\.ts/);
  });

  it("NÃO importa o núcleo de allowance para decidir unidade ocupada", () => {
    // A separação existe porque `whatsapp-connection-allowance-core.ts` é
    // compartilhado com `manage-channels`, que não tem nada a ver com unidade
    // duplicada. Fundir os dois levaria um reasonCode sem sentido para lá.
    const nucleo = readFileSync(
      resolve(process.cwd(), "supabase/functions/_shared/whatsapp-connection-allowance-core.ts"),
      "utf8",
    );
    expect(nucleo).not.toMatch(/UNIT_ALREADY_HAS_INSTANCE/);
  });
});
```

- [ ] **Step 2: Rodar e ver passar**

Run: `npx vitest run src/lib/whatsapp-instance-ef-write-guard.test.ts`
Expected: PASS (as tarefas 3 e 4 já produziram tudo o que ele afirma).

- [ ] **Step 3: Controle positivo do guardrail**

Provar que o guardrail tem força — três remoções temporárias, uma de cada vez, em `supabase/functions/manage-whatsapp-instances/index.ts`:

1. Apagar `.eq("status", "PENDING_REVIEW")` do `correct_cycle_cost` → rodar o teste → Expected: FAIL no caso "o UPDATE carrega o compare-and-set". Restaurar.
2. Apagar `.neq("id", id)` do `update_instance` → rodar → Expected: FAIL em "exclui a própria instância". Restaurar.
3. Trocar o novo bloco do `23505` pela forma antiga (`if (cycleErr && cycleErr.code !== "23505")`) → rodar → Expected: FAIL em "não trata o 23505 como sucesso puro". Restaurar.

Depois de cada restauração, confirmar `npx vitest run src/lib/whatsapp-instance-ef-write-guard.test.ts` verde. **Restaurar com `git checkout -- <arquivo>` ou desfazendo a edição — nada dessas remoções pode entrar no commit.** Conferir com `git diff` antes de seguir.

- [ ] **Step 4: A ressalva entra no README do harness**

Em `supabase/tests/local-preflight/README.md`, ao fim da seção "O que os três controles do `06` fazem", acrescentar uma seção nova:

```markdown
## O que CORR-1 e CORR-2 NÃO provam

Os dois casos **reescrevem o `UPDATE` à mão em SQL**. Eles provam a metade do
banco: que o CHECK `whatsapp_cycles_closed_needs_cost_chk` aceita custo e status
mudando juntos, e que o predicado `status = 'PENDING_REVIEW'` casa (CORR-1) e
deixa de casar (CORR-2).

Eles **não exercitam a Edge Function**. Se o `UPDATE` real de
`correct_cycle_cost` perdesse o `.eq("status", "PENDING_REVIEW")` ou a
conferência de zero linhas — lembrando que `UPDATE` do Supabase JS que casa zero
linhas devolve `error: null` —, nenhum caso deste diretório ficaria vermelho.

Essa metade é fechada por [../../../src/lib/whatsapp-instance-ef-write-guard.test.ts](../../../src/lib/whatsapp-instance-ef-write-guard.test.ts),
guardrail **estático textual** sobre a fonte da EF: os `index.ts` importam
`deno.land`/`esm.sh` e chamam `serve()` no carregamento, então o vitest não
consegue importá-los. É uma afirmação mais estreita que "a EF foi testada" — *o
predicado não pode sumir sem teste vermelho* — e é o que existe.

O mesmo par (caso de banco aqui + guardrail estático lá) cobre `CYCLE-1`/`CYCLE-2`
e a guarda de unidade do `update_instance`.
```

- [ ] **Step 5: Gates**

```bash
npm run lint && npm run typecheck && npx vitest run && npm run build
npx eslint supabase/functions --max-warnings=0
```
Expected: verdes. Conferir na saída do vitest que o arquivo novo aparece com todos os casos passando.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp-instance-ef-write-guard.test.ts \
        supabase/tests/local-preflight/README.md
git diff --cached
git commit -m "$(cat <<'EOF'
test(6c): guardrail estatico das escritas condicionais da EF de instancias

CORR-1 e CORR-2 reescrevem o UPDATE a mao em SQL: provam a metade do banco (o
CHECK aceita custo e status mudando juntos, e o predicado casa). Nenhum caso do
harness ficaria vermelho se o UPDATE real de correct_cycle_cost perdesse o
`.eq("status","PENDING_REVIEW")` ou a conferencia de zero linhas — e UPDATE que
casa zero linhas devolve error: null.

O guardrail fecha a metade que da: um tema, um arquivo — o predicado que protege
uma escrita nao pode sumir sem teste vermelho. Cobre correct_cycle_cost,
confirm_cycle_date (23505) e update_instance (unidade duplicada). Textual porque
os index.ts importam deno.land/esm.sh e chamam serve() no carregamento; e a
mesma razao ja registrada em whatsapp-gate-coupling-guard.test.ts.

E o README passa a dizer o que CORR-1/CORR-2 nao provam — o lugar onde a lacuna
e lida e o lugar onde ela precisa estar escrita.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Invariantes no `CLAUDE.md` e verificação final

**Files:**
- Modify: `CLAUDE.md` (seção "Billing — mensalidades", junto das demais linhas de `whatsapp_instance*`)

**Interfaces:** nenhuma.

- [ ] **Step 1: Corrigir a linha existente sobre a guarda de unidade**

Em `CLAUDE.md`, localizar:

```markdown
- **Registro de instância faz TRÊS perguntas independentes, e a de unidade duplicada mora fora do `checkConnectionAllowance`.** Aquele núcleo é compartilhado com `manage-channels`, que não tem nada a ver com unidade ocupada — e sob cortesia vitalícia ele nunca consulta a contagem, que é como duas instâncias coexistiam na mesma unidade sem que nada reclamasse. [whatsapp-instance-registration-core.ts](supabase/functions/_shared/whatsapp-instance-registration-core.ts).
```

e substituir por:

```markdown
- **Registro de instância faz TRÊS perguntas independentes, e a de unidade duplicada mora fora do `checkConnectionAllowance`.** Aquele núcleo é compartilhado com `manage-channels`, que não tem nada a ver com unidade ocupada — e sob cortesia vitalícia ele nunca consulta a contagem, que é como duas instâncias coexistiam na mesma unidade sem que nada reclamasse. **A guarda vale nas DUAS portas: `register_instance` E `update_instance`** — mover instância para unidade ocupada produzia o mesmo estado que o registro recusa, e "registro recusa, mover aceita" cria confiança falsa numa guarda que existe. No `update_instance` ela pula quando `unit_id` não muda (patch que reenvia a mesma unidade não é conflito) e exclui a própria instância da consulta. [whatsapp-instance-registration-core.ts](supabase/functions/_shared/whatsapp-instance-registration-core.ts).
```

- [ ] **Step 2: Acrescentar os três invariantes novos**

Logo após a linha do custo de ciclo (a que termina em `[migration 104](../../../supabase/migrations/20260807100000_104_whatsapp_cycle_cost_and_end.sql)`), inserir:

```markdown
- **No encerramento de instância, a PRIMEIRA confirmação vence nos TRÊS campos (`ended_at`, `ended_by`, `end_confirmation_note`) — repetições ficam no ledger `whatsapp_instance_notes`.** Coalescer só a data faria a linha afirmar "encerrada em T1, por B, com a nota de B": registro falso, não parcial. A porta não é corrida — `canTransition` tem curto-circuito de mesmo estado e o botão do painel é renderizado a partir do `lifecycle_state` em cache, com `refetchOnWindowFocus: false`, então uma aba parada de outro admin continua oferecendo o botão. Nada se perde porque `recordInstanceNote` roda em toda chamada. [migration 105](supabase/migrations/20260807110000_105_whatsapp_end_confirmation_first_wins.sql).
- **O `23505` do insert de ciclo em `confirm_cycle_date` NÃO é reexecução por default — desambigua consultando `(instance_id, cycle_start)`.** Dois índices produzem esse código e significam coisas opostas: `whatsapp_cycles_instance_start_idx` é reexecução da mesma data; o parcial `whatsapp_cycles_one_open_idx (WHERE status='OPEN')` é outro ciclo aberto com data DIFERENTE. Presumir reexecução gravava a projeção com a data nova sobre um ciclo que guarda outra, e o D-7/D-1 passava a disparar pela data errada. Linha ausente → 409 `OPEN_CYCLE_DATE_MISMATCH` sem gravar; erro de leitura → 503. [manage-whatsapp-instances/index.ts](supabase/functions/manage-whatsapp-instances/index.ts).
- **Toast de ação administrativa que tem consequência pendente diz QUAL — a copy vive em função pura em `src/`, nunca como string literal no call site.** `"Custo atualizado."` seco afirmava que o ciclo aberto foi preenchido mesmo quando `cycle_filled` é `false`, e o `PENDING_REVIEW` só aparece dentro da seção expandida: o toast é o único retorno no instante da ação. `hasOpenCycle: null` significa "a EF não disse" (janela entre deploys) e não afirma nada sobre o ciclo. [whatsapp-instance-format.ts](src/lib/whatsapp-instance-format.ts).
```

- [ ] **Step 3: Rodar a bateria inteira, do zero**

```bash
npm run lint
npm run typecheck
npx vitest run
npm run build
npx eslint supabase/functions --max-warnings=0
```
Expected: todos verdes, sem warning novo.

Depois o harness completo, na sequência do README com a 105, e conferir o quadro final:

```bash
P -c "select ord, caso, veredito from t_res order by ord;"
```

Expected: `PASSOU` em todos os casos `NOTE-*`, `COST-1..4`, `END-1..4`, `CORR-1..2`, `CYCLE-1..2`; `REPRODUZIU` em `CONTROLE-1..5`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git diff --cached
git commit -m "$(cat <<'EOF'
docs: tres invariantes dos follow-ups 6c e a guarda de unidade nas duas portas

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Gate de segurança da migration**

Rodar o agente `saas-shield-br:migration-validator` sobre
`supabase/migrations/20260807110000_105_whatsapp_end_confirmation_first_wins.sql`.
Há migration nova tocando função `SECURITY DEFINER` — este gate é obrigatório
pelo `CLAUDE.md` antes de merge.

Expected: sem bloqueantes. Corrigir o que aparecer antes de seguir.

- [ ] **Step 6: Review whole-branch**

Revisão da branch inteira contra a spec e contra os gates. Expected: nenhum
achado bloqueante; follow-ups não-bloqueantes registrados por escrito, como esta
própria frente foi originada.

- [ ] **Step 7: Relatar ao dono do projeto**

Nada de `supabase db push`, `supabase functions deploy` nem `git push` sem
autorização explícita. Ao relatar, incluir a ordem de aplicação da spec §8:

1. `supabase db push` (aplica a 105)
2. `supabase functions deploy manage-whatsapp-instances`
3. frontend (push em `main` → Vercel)
4. conferir `acl-estatico` na aba Checks — a 105 substitui função em `public`, que é exatamente o diff que ele audita

Sem hazard de ordem inversa: a assinatura e o `returns table` não mudam, e a EF já chama a RPC assim. A ordem é convenção, não dependência.

---

## Self-review deste plano

**Cobertura da spec:**

| Seção da spec | Tarefa |
|---|---|
| §2 item 1 — toast condicional, `has_open_cycle`, núcleo puro de copy, `run()` | 1 |
| §3 item 2 — migration 105, `END-4`, `CONTROLE-5`, README | 2 |
| §4 item 3 — guardrail estático, ressalva no README | 5 |
| §5 item 4 — guarda de unidade no `update_instance`, `parseUuid`, `.neq("id", id)`, 503, 409, diálogo | 4 |
| §6 item 5 — desambiguação do `23505`, `CYCLE-1`/`CYCLE-2` | 3 |
| §7 fora de escopo | nenhuma tarefa o viola: a 104/096/090/089 não são reescritas, nada persiste margem, nenhuma chamada à Z-API, `ENDED → ENDED` continua aceito, nenhum núcleo puro para `correct_cycle_cost` |
| §8 impacto operacional — `CLAUDE.md`, ordem de deploy | 6 |
| §9 gates | em cada tarefa + tarefa 6 |

**Desvio consciente da spec:** §2.3 descreve três ramos para `setCostToast`; o plano usa quatro (`hasOpenCycle: boolean | null`). Justificado no cabeçalho da tarefa 1 — a janela entre deploys tornaria o ramo `false` uma afirmação sem base, que é o defeito que o item fecha.

**Consistência de nomes verificada:** `setCostToast` / `setCostToastFromResponse` / `confirmEndToast` / `confirmEndToastFromResponse` (tarefa 1, usados só ali); `has_open_cycle` (EF, tarefa 1 → lido em `setCostToastFromResponse`); `OPEN_CYCLE_DATE_MISMATCH` (tarefa 3 → afirmado na tarefa 5); `checkUnitInstanceConflict` / `UNIT_ALREADY_HAS_INSTANCE_MESSAGE` / `ALLOWANCE_UNVERIFIABLE` (já existentes na EF, reusados na tarefa 4 → afirmados na tarefa 5); `unitConflicts` (estado local, tarefa 4).

**`ord` do `t_res`, sem colisão:** `51`–`59` já existiam no `05`; `60` = `END-4` (`05`); `61`–`62` já existiam no `06`; `63`–`64` = `CYCLE-1`/`CYCLE-2` (`05`); `65` = `CONTROLE-5` (`06`).

**Ids fixos de instância, sem colisão:** `…0001` e `…0002` já existiam no `05`; `…0003` = `END-4`; `…0004` = `CYCLE-1`/`CYCLE-2`; `…0005` = `CONTROLE-5`.
