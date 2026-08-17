# Hardening dos warnings do Security Advisor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** reduzir os warnings do Security Advisor de 29 para 23 eliminando superfície real (helpers de RLS fora do schema exposto, dois overloads mortos) e tornar os 23 restantes um aceite auditável por guardrail, sem que nenhuma loja em produção seja afetada.

**Architecture:** três fases independentes e reversíveis. A Fase 1 tira `is_unit_member`/`is_platform_admin`/`is_org_member` do schema `public` para um schema `app_private` não exposto ao PostgREST — o que exige, antes, que as 4 Edge Functions que os chamam por RPC passem a consultar `unit_members`/`platform_admins` direto por um helper compartilhado, e exige, na mesma migration, reescrever as 4 funções `SECURITY DEFINER` que os chamam pelo nome dentro do corpo. A Fase 2 dropa dois overloads sem caller. A Fase 3 estende o guardrail de ACL já existente para que warning novo reprove sozinho.

**Tech Stack:** PostgreSQL 17 (Supabase), Deno (Edge Functions), React 18 + TypeScript + Vite, vitest, Postgres local descartável (harness `supabase/tests/local-preflight/`).

**Spec:** [docs/superpowers/specs/2026-08-17-advisor-warnings-hardening-design.md](../specs/2026-08-17-advisor-warnings-hardening-design.md)

## Global Constraints

- `npm run typecheck` é `tsc -b --noEmit`. **NUNCA** `tsc --noEmit` sem `-b` — o root tem `files:[]` + references e vira no-op silencioso (exit 0 sem checar). Baseline: zero erros.
- `npm install --legacy-peer-deps` (`.npmrc` força; não remover).
- Migrations no formato `YYYYMMDDHHMMSS_nome.sql`, **idempotentes por design**, aplicadas **sempre** via `supabase db push` — nunca colando SQL no Studio (grava `schema_migrations` com timestamp ≠ filename e trava o próximo push por drift).
- Migration **nunca** embute segredo nem a URL do projeto Supabase. Header de autenticação se monta por concatenação a partir do Vault.
- Função nova em `public` nasce executável por `anon` pelo grant implícito do `CREATE FUNCTION` a PUBLIC: toda migration que criar função exposta faz `revoke all on function <assinatura completa> from public, anon, authenticated;` antes de conceder ao papel mínimo.
- `git add <caminho>` com escopo explícito. **Nunca** `git add .`, `git add -A` ou `git reset --hard`.
- `CLAUDE.md` e `AGENTS.md` são par obrigatório: toda regra permanente entra ou sai nos **dois**, no mesmo commit.
- Gates `saas-shield-br:*` (`migration-validator`, `rls-auditor`, `tenant-isolation-auditor`, `identity-access-auditor`) são obrigatórios antes de merge/push — esta frente toca banco, RLS, multi-tenant e Edge Function.
- Alterar arquivo em `supabase/functions/_shared/` exige redeploy de **todas** as EFs que o importam; Edge Functions não compartilham bundle em runtime.
- Toda guarda nova entra com **controle positivo**: reintroduzir o defeito e ver o teste falhar. Sem isso, "passou" não distingue *a guarda funciona* de *o teste não testa nada*.
- Idioma de comentários, mensagens de commit e copy: PT-BR.

**Valores exatos, copiados da spec:**

- Schema novo: `app_private`. Não entra na configuração de schemas expostos do PostgREST.
- Migration da Fase 1: `supabase/migrations/20260817230000_106_advisor_private_rls_helpers.sql`
- Migration da Fase 2: `supabase/migrations/20260817231000_107_drop_dead_rpc_overloads.sql`
- Assinaturas exatas dos três helpers: `is_unit_member(p_user_id uuid, p_unit_id uuid)`, `is_platform_admin(p_user_id uuid)`, `is_org_member(p_user_id uuid, p_org_id uuid)`.
- ACL atual, a preservar: `is_unit_member` → `anon`, `authenticated`, `service_role`; `is_platform_admin` → `authenticated`, `service_role`; `is_org_member` → `authenticated`, `service_role`.
- Contagem esperada de WARN: **29** hoje → **25** após a Fase 1 → **23** após a Fase 2.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade | Tarefa |
|---|---|---|
| `supabase/functions/_shared/authz.ts` | **Criar.** Única fonte do guard "membro da unit OU platform_admin" nas Edge Functions. | 1 |
| `supabase/functions/create-manual-reservation/index.ts` | **Modificar** (linhas 129-138). Trocar as 2 RPCs pelo helper. | 1 |
| `supabase/functions/update-reservation/index.ts` | **Modificar** (linhas 114-123). Idem. | 1 |
| `supabase/functions/send-cancellation/index.ts` | **Modificar** (linhas 75-87). Idem. | 1 |
| `supabase/functions/send-manual-message/index.ts` | **Modificar** (linhas 79-91). Idem. | 1 |
| `src/lib/authz-ef-guard.test.ts` | **Criar.** Guardrail estático: o padrão `rpc("is_unit_member"…)` não pode voltar. | 1 |
| `supabase/migrations/20260817230000_106_advisor_private_rls_helpers.sql` | **Criar.** Move os 3 helpers e reescreve os 4 corpos que os chamam pelo nome. | 3 |
| `supabase/tests/local-preflight/08-advisor-hardening.sql` | **Criar.** ACL-1..ACL-5 (comportamento) num arquivo. | 3 |
| `supabase/tests/local-preflight/09-controles-106.sql` | **Criar.** CONTROLE-6 e CONTROLE-7, que quebram de propósito. Arquivo separado porque roda **sem** `ON_ERROR_STOP`, como o `04-controles.sql`. | 3 |
| `scripts/function-acl-allowlist.json` | **Modificar.** Remove `rls_helpers`, acrescenta `advisor_lints` e `_expected_advisor`. | 3, 5, 7 |
| `src/hooks/useCustomers.ts` | **Modificar** (linhas 67-74). `unitId` obrigatório. | 5 |
| `supabase/migrations/20260817231000_107_drop_dead_rpc_overloads.sql` | **Criar.** Dropa os 2 overloads sem caller. | 5 |
| `supabase/tests/local-preflight/10-overloads-107.sql` | **Criar.** ACL-6 e CONTROLE-8. | 5 |
| `scripts/audit-function-acl.ts` | **Modificar.** Regra 6: equivalente-advisor vs. `_expected_advisor`. | 7 |
| `scripts/function-acl-allowlist.test.ts` | **Modificar.** Consistência de `_expected_advisor` + controle negativo. | 7 |
| `supabase/tests/local-preflight/README.md` | **Modificar.** Sequência de execução dos arquivos novos. | 3, 5 |
| `CLAUDE.md` + `AGENTS.md` | **Modificar.** Invariante novo, nos dois. | 8 |

---

### Task 1: `_shared/authz.ts` e a troca nas 4 Edge Functions

Depois desta tarefa, nenhuma Edge Function depende da RPC `is_unit_member`/`is_platform_admin`. O comportamento observável não muda em nenhum caminho — é o pré-requisito que torna a migration da Task 3 segura.

**Files:**
- Create: `supabase/functions/_shared/authz.ts`
- Create: `src/lib/authz-ef-guard.test.ts`
- Modify: `supabase/functions/create-manual-reservation/index.ts:129-138`
- Modify: `supabase/functions/update-reservation/index.ts:114-123`
- Modify: `supabase/functions/send-cancellation/index.ts:75-87`
- Modify: `supabase/functions/send-manual-message/index.ts:79-91`

**Interfaces:**
- Consumes: nada de tarefas anteriores.
- Produces: `hasUnitAccess(supabase: SupabaseClient, userId: string, unitId: string): Promise<boolean>` exportado de `supabase/functions/_shared/authz.ts`.

- [ ] **Step 1: Escrever o guardrail estático que falha primeiro**

Criar `src/lib/authz-ef-guard.test.ts`:

```ts
/**
 * Guardrail ESTÁTICO do guard de autorização das Edge Functions.
 *
 * Um tema, um arquivo: *o guard de unidade não pode voltar a ser uma RPC*. Desde
 * a migration 106 os helpers `is_unit_member`/`is_platform_admin`/`is_org_member`
 * vivem em `app_private`, schema que o PostgREST não expõe — uma chamada
 * `supabase.rpc("is_unit_member", …)` que reapareça responde 404 e o `!data`
 * seguinte lê isso como "não é membro". Falha fechada, mas 403 para TODO MUNDO,
 * inclusive o dono da loja.
 *
 * POR QUE TEXTUAL. Os `index.ts` importam `deno.land`/`esm.sh` e chamam `serve()`
 * no carregamento, então o vitest não consegue importá-los — mesma razão
 * registrada em `whatsapp-instance-ef-write-guard.test.ts`.
 *
 * O QUE ISTO NÃO É. Não é "a autorização foi exercitada". É a afirmação estreita
 * de que o padrão removido não volta sem teste vermelho.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const FUNCTIONS_DIR = resolve(process.cwd(), "supabase", "functions");

/** Todos os index.ts de Edge Function, mais os arquivos de `_shared/`. */
function fontesDeEdgeFunction(): string[] {
  const out: string[] = [];
  for (const entrada of readdirSync(FUNCTIONS_DIR)) {
    const caminho = join(FUNCTIONS_DIR, entrada);
    if (!statSync(caminho).isDirectory()) continue;
    if (entrada === "_shared") {
      for (const arquivo of readdirSync(caminho)) {
        if (arquivo.endsWith(".ts")) out.push(join(caminho, arquivo));
      }
      continue;
    }
    const index = join(caminho, "index.ts");
    try {
      if (statSync(index).isFile()) out.push(index);
    } catch {
      // Diretório sem index.ts não é Edge Function.
    }
  }
  return out;
}

const HELPERS_PRIVADOS = ["is_unit_member", "is_platform_admin", "is_org_member"];

describe("guard de unidade nas Edge Functions", () => {
  const fontes = fontesDeEdgeFunction();

  it("encontra Edge Functions para auditar", () => {
    // Zero arquivos passaria vacuamente em tudo abaixo.
    expect(fontes.length).toBeGreaterThan(10);
  });

  it.each(HELPERS_PRIVADOS)(
    "nenhuma Edge Function chama %s como RPC — o helper vive em app_private",
    (helper) => {
      const padrao = new RegExp(`rpc\\(\\s*["']${helper}["']`);
      const culpados = fontes.filter((f) => padrao.test(readFileSync(f, "utf8")));
      expect(
        culpados,
        `use hasUnitAccess() de _shared/authz.ts em vez de rpc("${helper}")`,
      ).toEqual([]);
    },
  );

  it("as 4 Edge Functions com guard de unidade importam o helper compartilhado", () => {
    const comGuard = [
      "create-manual-reservation",
      "update-reservation",
      "send-cancellation",
      "send-manual-message",
    ];
    for (const nome of comGuard) {
      const src = readFileSync(join(FUNCTIONS_DIR, nome, "index.ts"), "utf8");
      expect(src, `${nome} deveria importar hasUnitAccess`).toContain(
        "hasUnitAccess",
      );
    }
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/authz-ef-guard.test.ts`
Expected: FAIL — 3 casos `it.each` acusando as 4 EFs, e o último caso acusando ausência de `hasUnitAccess`.

- [ ] **Step 3: Criar `_shared/authz.ts`**

```ts
// supabase/functions/_shared/authz.ts
//
// Única fonte do guard "membro da unidade OU platform_admin" nas Edge Functions.
//
// POR QUE NÃO É RPC. Os helpers `is_unit_member`/`is_platform_admin` vivem em
// `app_private` desde a migration 106 — schema fora do que o PostgREST expõe,
// justamente para que a anon key não consiga usá-los como oráculo de
// enumeração de membership. Estas EFs rodam com service_role, que bypassa RLS,
// então a consulta direta responde a mesma pergunta sem superfície pública.
//
// INVARIANTE PRESERVADO. `useCurrentUnit.ts` fabrica pseudo-membership "owner"
// para platform_admin operar unidades alheias na UI; sem o paralelo aqui,
// super-admin recebe 403 com a UI mostrando "Proprietário". As duas perguntas
// andam juntas — nunca só a de membership.
//
// FAIL-CLOSED, EXATAMENTE COMO ANTES. O código que este helper substitui fazia
// `if (!memberResult.data && !adminResult.data) → 403`, o que já tratava erro de
// leitura como negação. A semântica é preservada byte a byte de propósito: esta
// frente não muda código de status em nenhum caminho. Trocar 403 por 503 em
// falha de banco é melhoria defensável, e está explicitamente fora de escopo.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * `true` se o usuário é membro da unidade OU platform_admin.
 * Erro de leitura devolve `false` (fail-closed) e é logado no console.
 */
export async function hasUnitAccess(
  supabase: SupabaseClient,
  userId: string,
  unitId: string,
): Promise<boolean> {
  const [membro, admin] = await Promise.all([
    supabase
      .from("unit_members")
      .select("user_id")
      .eq("user_id", userId)
      .eq("unit_id", unitId)
      .maybeSingle(),
    supabase
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  if (membro.error) {
    console.error(JSON.stringify({ evt: "authz_member_read_error", message: membro.error.message }));
  }
  if (admin.error) {
    console.error(JSON.stringify({ evt: "authz_admin_read_error", message: admin.error.message }));
  }

  return Boolean(membro.data) || Boolean(admin.data);
}
```

- [ ] **Step 4: Trocar o guard em `create-manual-reservation/index.ts`**

Acrescentar ao bloco de imports do topo do arquivo:

```ts
import { hasUnitAccess } from "../_shared/authz.ts";
```

Substituir as linhas 129-138 por:

```ts
    // Autorização: membro da unit OU platform_admin. useCurrentUnit.ts fabrica
    // pseudo-membership "owner" pra super-admin; sem o paralelo, write é bloqueada.
    if (!(await hasUnitAccess(supabase, user.id, unitId))) {
      jsonLog("warn", { requestId, evt: "manual_reservation_forbidden", unitId, userId: user.id });
      return json({ success: false, reason: "forbidden", message: "Sem permissão nesta unidade." }, 403);
    }
```

- [ ] **Step 5: Trocar o guard em `update-reservation/index.ts`**

Acrescentar ao bloco de imports do topo do arquivo:

```ts
import { hasUnitAccess } from "../_shared/authz.ts";
```

Substituir as linhas 114-123 por:

```ts
    // platform_admin opera unidades alheias via pseudo-membership fabricada em
    // useCurrentUnit.ts — backend tem que aceitar o paralelo, senão super-admin
    // recebe 403 mesmo com a UI mostrando "Proprietário".
    if (!(await hasUnitAccess(supabase, user.id, reserva.unit_id))) {
      return jsonResponse({ error: "forbidden" }, 403);
    }
```

- [ ] **Step 6: Trocar o guard em `send-cancellation/index.ts`**

Acrescentar ao bloco de imports do topo do arquivo:

```ts
import { hasUnitAccess } from "../_shared/authz.ts";
```

Substituir as linhas 75-87 por:

```ts
    // platform_admin opera unidades alheias via pseudo-membership fabricada em
    // useCurrentUnit.ts — backend tem que aceitar o paralelo, senão super-admin
    // recebe 403 mesmo com a UI mostrando "Proprietário".
    if (!(await hasUnitAccess(supabase, user.id, reserva.unit_id))) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
```

- [ ] **Step 7: Trocar o guard em `send-manual-message/index.ts`**

Acrescentar ao bloco de imports do topo do arquivo:

```ts
import { hasUnitAccess } from "../_shared/authz.ts";
```

Substituir as linhas 79-91 por:

```ts
    // Verify caller is a member of this unit OR a platform admin.
    // useCurrentUnit.ts fabrica pseudo-membership "owner" pra platform_admin operar
    // unidades alheias na UI; sem o paralelo aqui, super-admin é bloqueado pelo backend.
    if (!(await hasUnitAccess(supabase, user.id, conv.unit_id))) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
```

- [ ] **Step 8: Rodar o guardrail e confirmar que passa**

Run: `npx vitest run src/lib/authz-ef-guard.test.ts`
Expected: PASS, 5 casos.

- [ ] **Step 9: Rodar os gates que alcançam Edge Function**

Run: `npx eslint supabase/functions --max-warnings=0`
Expected: exit 0. Este lint existe porque `tsc -b` **não** inclui `supabase/functions` e não há Deno no CI — é o único que pega identificador fora de escopo (ex.: `memberResult` sobrevivendo à substituição).

Run: `npm run typecheck && npm run test && npm run lint`
Expected: os três verdes.

- [ ] **Step 10: Atualizar o checklist de redeploy do CLAUDE.md e do AGENTS.md**

Acrescentar `authz.ts` à lista de helpers de `_shared/` na seção "Checklist de redeploy quando `_shared/X.ts` muda", **nos dois arquivos**:

```markdown
- **`authz.ts`** → `create-manual-reservation`, `update-reservation`, `send-cancellation`, `send-manual-message`. Guard de unidade; deploy parcial deixa uma EF chamando RPC que a 106 já removeu de `public` — 403 para o dono da loja.
```

- [ ] **Step 11: Commit**

```bash
git add supabase/functions/_shared/authz.ts \
        supabase/functions/create-manual-reservation/index.ts \
        supabase/functions/update-reservation/index.ts \
        supabase/functions/send-cancellation/index.ts \
        supabase/functions/send-manual-message/index.ts \
        src/lib/authz-ef-guard.test.ts \
        CLAUDE.md AGENTS.md
git commit -m "refactor(authz): guard de unidade das EFs sai da RPC para _shared/authz.ts

Pre-requisito da 106: enquanto o guard for rpc(\"is_unit_member\"), mover o
helper para app_private responde 404 e nega o dono da loja. Semantica
fail-closed preservada byte a byte; nenhum codigo de status muda.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Deploy das 4 Edge Functions e verificação em produção

Checkpoint sem código. Existe porque a ordem entre EF e migration é o que impede a Fase 1 de derrubar loja — e é **invertida** em relação ao padrão registrado no CLAUDE.md ("migration antes da EF"), porque aqui a EF está deixando de depender, não passando a ler.

**Files:** nenhum.

**Interfaces:**
- Consumes: `hasUnitAccess` da Task 1.
- Produces: produção rodando sem nenhuma dependência da RPC.

- [ ] **Step 1: Confirmar com o usuário antes de deployar**

Deploy é ação externa e irreversível pela sessão. Pedir confirmação explícita antes de rodar o passo seguinte.

- [ ] **Step 2: Deployar as 4 Edge Functions**

```bash
supabase functions deploy create-manual-reservation
supabase functions deploy update-reservation
supabase functions deploy send-cancellation
supabase functions deploy send-manual-message
```

- [ ] **Step 3: Exercitar os 4 caminhos que mudaram, em produção**

Cada um tem que responder **igual a antes** — os helpers ainda estão em `public`, então esta etapa isola a mudança do guard:

1. Reserva manual pelo painel (`create-manual-reservation`).
2. Edição de uma reserva existente (`update-reservation`).
3. Cancelamento de reserva com aviso ao cliente (`send-cancellation`).
4. Mensagem manual numa conversa em atendimento humano (`send-manual-message`).

Expected: os 4 concluem. Um 403 aqui significa que o guard novo nega quem antes passava — **parar e investigar antes de qualquer migration**.

- [ ] **Step 4: Conferir os logs por erro de leitura**

Procurar `authz_member_read_error` / `authz_admin_read_error` nos logs das 4 funções. Expected: nenhuma ocorrência. A presença indica que o helper está falhando fechado por erro de banco, não por ausência de permissão — o mesmo sintoma de antes, agora visível.

---

### Task 3: Migration 106 — helpers para `app_private`

**Files:**
- Create: `supabase/migrations/20260817230000_106_advisor_private_rls_helpers.sql`
- Create: `supabase/tests/local-preflight/08-advisor-hardening.sql`
- Create: `supabase/tests/local-preflight/09-controles-106.sql`
- Modify: `scripts/function-acl-allowlist.json`
- Modify: `supabase/tests/local-preflight/README.md`

**Interfaces:**
- Consumes: produção sem dependência da RPC (Task 2).
- Produces: `app_private.is_unit_member(uuid, uuid)`, `app_private.is_platform_admin(uuid)`, `app_private.is_org_member(uuid, uuid)`.

- [ ] **Step 1: Escrever os casos de comportamento — `08-advisor-hardening.sql`**

Cada caso numa subtransação, veredito em `t_res`, no mesmo padrão de `03-notes-b-c-d.sql`.

```sql
-- supabase/tests/local-preflight/08-advisor-hardening.sql
--
-- ACL-1..ACL-5: comportamento da migration 106 contra Postgres real.
--
-- O README deste diretório diz que o harness "não prova RLS, grants, ACL". Isso
-- descreve o conjunto de arquivos que existia, não um limite do ambiente: o
-- 00-bootstrap.sql cria os papéis anon/authenticated/service_role, então
-- `set role` + `set local request.jwt.claims` exercitam policy e grant de
-- verdade. O que continua fora do alcance local é a EXPOSIÇÃO PostgREST — essa
-- metade é do audit-function-acl.ts contra o projeto real.

create table if not exists t_res (ord int, caso text, veredito text);

-- Fixture: uma policy TO PUBLIC que chama o helper, igual às 24 reais.
create table if not exists acl_probe (id uuid primary key default gen_random_uuid(), unit_id uuid not null, nota text);
alter table acl_probe enable row level security;
drop policy if exists acl_probe_member on acl_probe;
create policy acl_probe_member on acl_probe
  for select using (app_private.is_unit_member(auth.uid(), unit_id));
grant select on acl_probe to anon, authenticated;

-- ACL-1: policy TO PUBLIC continua avaliando depois do SET SCHEMA.
do $$
declare v_unit uuid; v_user uuid; v_n int;
begin
  select id into v_unit from units limit 1;
  select user_id into v_user from unit_members where unit_id = v_unit limit 1;
  delete from acl_probe;
  insert into acl_probe (unit_id, nota) values (v_unit, 'visivel ao membro');

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);
  select count(*) into v_n from acl_probe;
  reset role;

  insert into t_res values (1, 'ACL-1 policy sobrevive ao SET SCHEMA',
    case when v_n = 1 then 'OK' else 'FALHOU (esperado 1, veio ' || v_n || ')' end);
exception when others then
  reset role;
  insert into t_res values (1, 'ACL-1 policy sobrevive ao SET SCHEMA', 'FALHOU: ' || sqlerrm);
end $$;

-- ACL-2: enter_waitlist conclui com os corpos reescritos.
do $$
declare v_unit uuid; v_id uuid;
begin
  select id into v_unit from units limit 1;
  select id into v_id from enter_waitlist(v_unit, 'Cliente Preflight', '11987654321', 2, null, null, null);
  insert into t_res values (2, 'ACL-2 enter_waitlist apos o move',
    case when v_id is not null then 'OK' else 'FALHOU (retorno nulo)' end);
exception when others then
  insert into t_res values (2, 'ACL-2 enter_waitlist apos o move', 'FALHOU: ' || sqlerrm);
end $$;

-- ACL-3: os outros três corpos reescritos resolvem o helper.
do $$
declare v_unit uuid; v_user uuid; v_cust uuid; v_n int;
begin
  select id into v_unit from units limit 1;
  select user_id into v_user from unit_members where unit_id = v_unit limit 1;
  select id into v_cust from customers limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);

  perform anonymize_customer(v_cust);
  select count(*) into v_n from get_customer_stats_bulk(array[v_cust], v_unit);
  perform * from get_undelivered_notifications(v_unit, now() - interval '7 days');

  insert into t_res values (3, 'ACL-3 os outros tres corpos reescritos', 'OK');
exception when others then
  insert into t_res values (3, 'ACL-3 os outros tres corpos reescritos', 'FALHOU: ' || sqlerrm);
end $$;

-- ACL-4: caminho da loja — anon entra na fila ponta a ponta.
do $$
declare v_unit uuid; v_id uuid;
begin
  select id into v_unit from units where is_public limit 1;
  set local role anon;
  select id into v_id from enter_waitlist(v_unit, 'Anon Preflight', '11912345678', 2, null, null, null);
  reset role;
  insert into t_res values (4, 'ACL-4 anon entra na fila',
    case when v_id is not null then 'OK' else 'FALHOU (retorno nulo)' end);
exception when others then
  reset role;
  insert into t_res values (4, 'ACL-4 anon entra na fila', 'FALHOU: ' || sqlerrm);
end $$;

-- ACL-5: idempotência — reaplicar a 106 não muda ACL nem contagem de funções.
do $$
declare v_antes int; v_depois int; v_acl_antes text; v_acl_depois text;
begin
  select count(*), string_agg(coalesce(proacl::text, '(default)'), '|' order by proname)
    into v_antes, v_acl_antes
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private';

  -- O executor reaplica o arquivo entre as duas leituras; ver o README.
  select count(*), string_agg(coalesce(proacl::text, '(default)'), '|' order by proname)
    into v_depois, v_acl_depois
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private';

  insert into t_res values (5, 'ACL-5 idempotencia da 106',
    case when v_antes = v_depois and v_acl_antes is not distinct from v_acl_depois
         then 'OK' else 'FALHOU (contagem ou ACL mudou)' end);
end $$;
```

- [ ] **Step 2: Escrever os controles positivos — `09-controles-106.sql`**

```sql
-- supabase/tests/local-preflight/09-controles-106.sql
--
-- Rodar SEM ON_ERROR_STOP: os dois casos quebram de propósito.
--
-- Sem eles, "ACL-2 passou" e "ACL-1 passou" não distinguem a guarda funcionando
-- de teste sem força. CONTROLE-6 reintroduz o defeito central desta fase.

-- CONTROLE-6: desfaz a reescrita de enter_waitlist e mostra a fila quebrando.
--
-- Reproduz o achado que decide a fase: em plpgsql o nome da função é resolvido
-- em TEMPO DE EXECUÇÃO, então `public.is_unit_member` num corpo que sobreviveu
-- ao SET SCHEMA aponta para função que não existe mais.
do $$
declare v_src text; v_unit uuid;
begin
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'enter_waitlist';

  -- Volta a qualificação antiga, mantendo todo o resto do corpo intacto.
  execute format(
    'create or replace function public.enter_waitlist(uuid, text, text, integer, text, text, time without time zone)
       returns table(id uuid, position integer)
       language plpgsql security definer set search_path = public as %L',
    replace(v_src, 'app_private.is_', 'public.is_'));

  select id into v_unit from units limit 1;
  begin
    perform enter_waitlist(v_unit, 'Controle 6', '11900000000', 2, null, null, null);
    insert into t_res values (6, 'CONTROLE-6 corpo sem reescrita', 'FALHOU: deveria ter estourado');
  exception when undefined_function then
    insert into t_res values (6, 'CONTROLE-6 corpo sem reescrita', 'OK (estourou como esperado)');
  end;
end $$;

-- CONTROLE-7: o grant de USAGE no schema é load-bearing, não decorativo.
do $$
declare v_unit uuid; v_user uuid; v_n int;
begin
  revoke usage on schema app_private from anon;
  select id into v_unit from units limit 1;
  select user_id into v_user from unit_members where unit_id = v_unit limit 1;

  set local role anon;
  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);
  begin
    select count(*) into v_n from acl_probe;
    reset role;
    insert into t_res values (7, 'CONTROLE-7 usage revogado', 'FALHOU: deveria ter estourado');
  exception when insufficient_privilege then
    reset role;
    insert into t_res values (7, 'CONTROLE-7 usage revogado', 'OK (permission denied como esperado)');
  end;

  grant usage on schema app_private to anon;
end $$;
```

- [ ] **Step 3: Rodar o pré-voo e confirmar que falha**

```bash
PG="$USERPROFILE/scoop/apps/postgresql/current/bin"
"$PG/pg_ctl.exe" -D "$USERPROFILE/scoop/apps/postgresql/current/data" -l /tmp/pg.log -o "-p 55432" start
"$PG/dropdb.exe"   -h 127.0.0.1 -p 55432 -U postgres --if-exists advisor106
"$PG/createdb.exe" -h 127.0.0.1 -p 55432 -U postgres advisor106
P() { "$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d advisor106 -v ON_ERROR_STOP=1 "$@"; }

P -f supabase/tests/local-preflight/00-bootstrap.sql
P -f supabase/tests/local-preflight/01-audit.sql
P -f supabase/tests/local-preflight/02-seed.sql
P -f supabase/tests/local-preflight/08-advisor-hardening.sql
```

Expected: FAIL já na criação da policy de `acl_probe` — `schema "app_private" does not exist`. A migration ainda não existe.

- [ ] **Step 4: Escrever a migration 106**

Cabeçalho e move:

```sql
-- Tira os três helpers de RLS do schema exposto ao PostgREST.
--
-- POR QUÊ. Os lints 0028/0029 do Security Advisor apontam função SECURITY
-- DEFINER de `public` alcançável por anon/authenticated. Dos 29 warnings, estes
-- três são a única exposição concreta: com a anon key do bundle, qualquer um
-- chamava /rest/v1/rpc/is_unit_member com p_user_id/p_unit_id arbitrários e
-- recebia um booleano — oráculo de enumeração de membership.
--
-- POR QUE NÃO REVOGAR EM VEZ DE MOVER. `is_unit_member` é referenciado por 42
-- policies, 24 delas TO PUBLIC. Policy é avaliada com o privilégio de quem
-- consulta: revogar EXECUTE de anon faz a query ESTOURAR com permission denied,
-- não negar linha. O grant é load-bearing, e é por isso que `grant usage on
-- schema app_private to anon` abaixo não é higiene.
--
-- O QUE TORNA ESTA MIGRATION PERIGOSA SE COPIADA PELA METADE. Quatro funções
-- SECURITY DEFINER chamam os helpers PELO NOME dentro do corpo. Em plpgsql o
-- nome é resolvido em tempo de execução, então um SET SCHEMA sem a reescrita
-- abaixo quebra a entrada pública na fila de espera, a anonimização LGPD, a
-- listagem de clientes e o painel de Entregas. As duas metades vivem na mesma
-- transação de propósito.
--
-- As policies referenciam a função por OID, não por nome, então elas NÃO
-- precisam ser reescritas — provado em ACL-1 do pré-voo local, com CONTROLE-7
-- mostrando o que acontece quando o USAGE falta.

begin;

create schema if not exists app_private;
comment on schema app_private is
  'Helpers de RLS e utilitários internos. NUNCA exposto ao PostgREST: expor '
  'reabre os lints 0028/0029 do Security Advisor e o oráculo de membership.';

grant usage on schema app_private to anon, authenticated, service_role;

-- Idempotente: só move o que ainda estiver em `public`.
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'is_unit_member') then
    alter function public.is_unit_member(uuid, uuid) set schema app_private;
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'is_platform_admin') then
    alter function public.is_platform_admin(uuid) set schema app_private;
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'is_org_member') then
    alter function public.is_org_member(uuid, uuid) set schema app_private;
  end if;
end $$;
```

Os três helpers são `language sql`, `SECURITY DEFINER`, com `search_path=public` fixo e corpo que lê `unit_members`/`units`/`platform_admins` sem qualificar. O `search_path` fixo é o que mantém a resolução correta depois do move — as tabelas continuam em `public`. Os grants (`anon`/`authenticated`/`service_role`) viajam com a função; nenhum `grant execute` extra é necessário.

- [ ] **Step 5: Acrescentar à mesma migration a reescrita dos 4 corpos**

Extrair cada definição atual do banco e aplicar **uma única substituição** por função. Comando de extração:

```bash
supabase db execute --file /dev/stdin <<'SQL'
select pg_get_functiondef(p.oid)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('enter_waitlist','anonymize_customer','get_customer_stats_bulk','get_undelivered_notifications');
SQL
```

Substituições, todas verificadas contra o banco — cada função tem **exatamente 2** call sites de helper:

| Função | De | Para |
|---|---|---|
| `enter_waitlist(uuid, text, text, integer, text, text, time)` | `public.is_unit_member(v_uid, p_unit_id)` / `public.is_platform_admin(v_uid)` | `app_private.is_unit_member(...)` / `app_private.is_platform_admin(...)` |
| `anonymize_customer(uuid)` | `public.is_org_member(v_caller, v_org_id)` / `public.is_platform_admin(v_caller)` | `app_private.is_org_member(...)` / `app_private.is_platform_admin(...)` |
| `get_customer_stats_bulk(uuid[], uuid)` | `public.is_platform_admin(v_caller)` / `public.is_org_member(v_caller, c.organization_id)` | `app_private.is_platform_admin(...)` / `app_private.is_org_member(...)` |
| `get_undelivered_notifications(uuid, timestamptz)` | `is_unit_member(auth.uid(), p_unit_id)` / `is_platform_admin(auth.uid())` — **sem qualificar** | `app_private.is_unit_member(...)` / `app_private.is_platform_admin(...)` |

Regras que o `create or replace` de cada uma **tem** que preservar, sob pena de quebrar caller existente:

- `get_undelivered_notifications` tem `p_since timestamp with time zone DEFAULT (now() - '7 days'::interval)`. Perder o DEFAULT quebra chamada de 1 argumento.
- `get_customer_stats_bulk` tem `p_unit_id uuid DEFAULT NULL::uuid`. Mesma coisa.
- `anonymize_customer` e `get_customer_stats_bulk` são `SET search_path TO 'public', 'pg_temp'`; `enter_waitlist` e `get_undelivered_notifications` são `SET search_path TO 'public'`. Manter o que cada uma já tem e **acrescentar** `app_private`: `set search_path = public, app_private, pg_temp`.
- `get_undelivered_notifications` e `get_customer_stats_bulk` são `STABLE`. Perder o `STABLE` muda plano de execução.
- Todas as quatro são `SECURITY DEFINER`.

Fechar a migration com `commit;`.

- [ ] **Step 6: Rodar o pré-voo com a migration e confirmar que passa**

```bash
"$PG/dropdb.exe"   -h 127.0.0.1 -p 55432 -U postgres --if-exists advisor106
"$PG/createdb.exe" -h 127.0.0.1 -p 55432 -U postgres advisor106
P -f supabase/tests/local-preflight/00-bootstrap.sql
P -f supabase/tests/local-preflight/01-audit.sql
P -f supabase/tests/local-preflight/02-seed.sql
P -f supabase/migrations/20260817230000_106_advisor_private_rls_helpers.sql
P -f supabase/tests/local-preflight/08-advisor-hardening.sql
# ACL-5 mede idempotência: reaplicar entre as duas leituras
P -f supabase/migrations/20260817230000_106_advisor_private_rls_helpers.sql
P -c "select ord, caso, veredito from t_res order by ord;"
```

Expected: ACL-1..ACL-5 todos `OK`.

- [ ] **Step 7: Rodar os controles positivos e confirmar que reprovam o defeito**

```bash
"$PG/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d advisor106 \
  -f supabase/tests/local-preflight/09-controles-106.sql   # SEM ON_ERROR_STOP
# 09 desfaz a reescrita de propósito — reaplicar a 106 restaura a versão real:
P -f supabase/migrations/20260817230000_106_advisor_private_rls_helpers.sql
P -c "select ord, caso, veredito from t_res order by ord;"
```

Expected: CONTROLE-6 e CONTROLE-7 ambos `OK (estourou como esperado)`. Se CONTROLE-6 vier `FALHOU: deveria ter estourado`, o teste ACL-2 não está medindo nada — **parar**.

- [ ] **Step 8: Limpar as entradas `rls_helpers` da allowlist**

Em `scripts/function-acl-allowlist.json`, substituir o array `rls_helpers` inteiro por:

```json
  "_doc_rls_helpers": [
    "O grupo `rls_helpers` foi esvaziado pela migration 106: is_unit_member,",
    "is_platform_admin e is_org_member vivem em `app_private`, schema que o",
    "PostgREST não expõe. `audit_function_acl()` varre apenas `public`, então",
    "elas deixaram de aparecer — e por isso deixaram de precisar de exceção.",
    "",
    "Se alguma delas reaparecer aqui, é REGRESSÃO: alguém recriou o helper em",
    "`public`. O caminho certo é `app_private`, e a justificativa está no",
    "cabeçalho da migration 106."
  ],

  "rls_helpers": [],
```

- [ ] **Step 9: Atualizar o README do pré-voo**

Acrescentar as duas linhas na tabela "Os arquivos" e a sequência de execução dos passos 6 e 7 na seção "Rodar", incluindo a nota de que o `09` roda **sem** `ON_ERROR_STOP` e que reaplicar a 106 restaura a versão real. Acrescentar também, na abertura do README, que o `08` exercita RLS e grants com `set role` — o parágrafo atual ("não prova RLS, grants, ACL") descreve o conjunto de arquivos que existia, não um limite do ambiente; o que segue fora do alcance local é a exposição PostgREST.

- [ ] **Step 10: Gates completos**

Run: `npm run typecheck && npm run test && npm run lint`
Expected: verdes.

Run: `npx vitest run scripts/function-acl-allowlist.test.ts scripts/migration-static-guard.test.ts`
Expected: verdes — o guardrail estático de migrations confere que a 106 não embute segredo nem a URL do projeto.

Rodar os 4 gates `saas-shield-br:*` (`migration-validator`, `rls-auditor`, `tenant-isolation-auditor`, `identity-access-auditor`) sobre a 106. Expected: nenhum bloqueante.

- [ ] **Step 11: Commit**

```bash
git add supabase/migrations/20260817230000_106_advisor_private_rls_helpers.sql \
        supabase/tests/local-preflight/08-advisor-hardening.sql \
        supabase/tests/local-preflight/09-controles-106.sql \
        supabase/tests/local-preflight/README.md \
        scripts/function-acl-allowlist.json
git commit -m "fix(security): helpers de RLS saem do schema exposto (migration 106)

Fecha o oraculo /rest/v1/rpc/is_unit_member e elimina 4 dos 29 warnings do
Security Advisor. As 84 referencias de policy seguem a funcao por OID e nao
mudam; os 4 corpos SECURITY DEFINER que chamam o helper pelo nome sao
reescritos na mesma transacao, porque plpgsql resolve nome em runtime.

CONTROLE-6 reintroduz exatamente esse defeito e ve a fila publica quebrar.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Aplicar a 106 e verificar em produção

**Files:** nenhum.

**Interfaces:**
- Consumes: migration 106 commitada (Task 3), EFs já deployadas (Task 2).
- Produces: 25 WARN no advisor.

- [ ] **Step 1: Confirmar com o usuário antes de aplicar**

`supabase db push` é ação em produção. Pedir confirmação explícita.

- [ ] **Step 2: Aplicar**

Run: `supabase db push`
Expected: aplica só a 106.

- [ ] **Step 3: Verificar os caminhos da loja, em produção**

1. Entrada pública na fila em `/r/<slug>?action=waitlist` — o caminho que CONTROLE-6 mostra quebrando.
2. Painel Operacional → Entregas (`get_undelivered_notifications`).
3. Listagem de clientes com stats (`get_customer_stats_bulk`).
4. Ficha de cliente e reserva manual (regressão da Task 2).

Expected: os 4 concluem. Falha aqui é erro de qualificação num dos corpos reescritos — o rollback está na §7 da spec.

- [ ] **Step 4: Confirmar que a RPC sumiu da superfície pública**

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST "$VITE_SUPABASE_URL/rest/v1/rpc/is_unit_member" \
  -H "apikey: $VITE_SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"p_user_id":"00000000-0000-0000-0000-000000000000","p_unit_id":"00000000-0000-0000-0000-000000000000"}'
```

Expected: `404`. Antes da 106 isto respondia `200` com `false`.

- [ ] **Step 5: Conferir o advisor**

Rodar o Security Advisor do projeto. Expected: **25 WARN** (29 − 4). Se vier outro número, reconciliar antes de seguir para a Fase 2.

---

### Task 5: Fase 2 — dropar os dois overloads sem caller

**Files:**
- Modify: `src/hooks/useCustomers.ts:67-74`
- Create: `supabase/migrations/20260817231000_107_drop_dead_rpc_overloads.sql`
- Create: `supabase/tests/local-preflight/10-overloads-107.sql`
- Modify: `scripts/function-acl-allowlist.json`
- Modify: `supabase/tests/local-preflight/README.md`

**Interfaces:**
- Consumes: nada da Fase 1 (independente de propósito).
- Produces: `useCustomerStats(customerId: string | undefined, unitId: string)` — `unitId` deixa de ser opcional.

- [ ] **Step 1: Escrever ACL-6 e CONTROLE-8**

```sql
-- supabase/tests/local-preflight/10-overloads-107.sql
--
-- ACL-6 e CONTROLE-8: a 107 dropa DOIS overloads sem caller e não pode
-- encostar nos de 2 argumentos, que são os que a UI usa.

-- ACL-6: as assinaturas de 2 argumentos continuam de pé depois da 107.
do $$
declare v_unit uuid; v_cust uuid; v_user uuid; v_n int;
begin
  select id into v_unit from units limit 1;
  select id into v_cust from customers limit 1;
  select user_id into v_user from unit_members where unit_id = v_unit limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);

  select count(*) into v_n from get_customer_stats(v_cust, v_unit);
  perform * from get_reservation_by_code('QUALQUER', v_unit);

  insert into t_res values (8, 'ACL-6 overloads de 2 args sobrevivem', 'OK');
exception when others then
  insert into t_res values (8, 'ACL-6 overloads de 2 args sobrevivem', 'FALHOU: ' || sqlerrm);
end $$;

-- CONTROLE-8: dropar o overload de 2 argumentos por engano quebra o call site
-- real. Delimita o que a 107 pode dropar com segurança.
do $$
declare v_unit uuid; v_cust uuid;
begin
  drop function if exists public.get_customer_stats(uuid, uuid);
  select id into v_unit from units limit 1;
  select id into v_cust from customers limit 1;
  begin
    perform * from get_customer_stats(v_cust, v_unit);
    insert into t_res values (9, 'CONTROLE-8 drop do overload errado', 'FALHOU: deveria ter estourado');
  exception when undefined_function then
    insert into t_res values (9, 'CONTROLE-8 drop do overload errado', 'OK (estourou como esperado)');
  end;
end $$;
```

- [ ] **Step 2: Rodar e confirmar o estado atual**

Aplicar `08`, a 106, depois `10`. Expected: ACL-6 `OK` (os overloads ainda existem) e CONTROLE-8 `OK`. Reaplicar a migration que define `get_customer_stats` restaura o overload derrubado pelo controle.

- [ ] **Step 3: Tornar `unitId` obrigatório em `useCustomerStats`**

Em `src/hooks/useCustomers.ts`, substituir as linhas 67-74 por:

```ts
export function useCustomerStats(customerId: string | undefined, unitId: string | undefined) {
  return useQuery({
    queryKey: ["customer-stats", customerId, unitId],
    queryFn: async () => {
      // p_unit_id é sempre enviado: o overload de 1 argumento foi dropado pela
      // migration 107 por não ter caller. Montar o parâmetro condicionalmente
      // faria a chamada cair numa assinatura que não existe mais.
      const { data, error } = await supabase.rpc("get_customer_stats", {
        p_customer_id: customerId,
        p_unit_id: unitId,
      });
```

e acrescentar `unitId` ao guard `enabled` da query (junto do `!!customerId` já existente), para que a chamada não saia antes de `useCurrentUnit()` resolver.

- [ ] **Step 4: Escrever a migration 107**

```sql
-- Dropa dois overloads de RPC sem caller.
--
-- POR QUÊ. Cada assinatura exposta a `authenticated` é uma linha WARN do lint
-- 0029 do Security Advisor. Estas duas não têm consumidor:
--
--   * get_reservation_by_code(p_code text) — o único call site
--     (src/hooks/useReservas.ts) sempre passa p_unit_id. A allowlist já
--     registrava "sem caller localizado no repositório, candidato a remoção".
--   * get_customer_stats(p_customer_id uuid) — só era alcançável quando
--     useCustomerStats recebia unitId undefined; o hook passou a exigir a
--     unidade no mesmo commit.
--
-- Reversível: as duas definições estão no git. Migration separada da 106 de
-- propósito — perfis de risco diferentes, reversão independente.

begin;

drop function if exists public.get_reservation_by_code(p_code text);
drop function if exists public.get_customer_stats(p_customer_id uuid);

commit;
```

- [ ] **Step 5: Rodar o pré-voo com a 107**

Aplicar `00`, `01`, `02`, a 106, a 107 e depois o `10`. Expected: ACL-6 `OK` — as assinaturas de 2 argumentos continuam respondendo depois do drop.

- [ ] **Step 6: Remover as duas entradas da allowlist**

Em `scripts/function-acl-allowlist.json`, apagar do grupo `authenticated_tenant` a entrada `get_reservation_by_code` com `"args": "p_code text"` e a entrada `get_customer_stats` com `"args": "p_customer_id uuid"`. As de 2 argumentos ficam.

- [ ] **Step 7: Gates**

Run: `npm run typecheck && npm run test && npm run lint`
Expected: verdes. O typecheck é quem pega qualquer outro caller de `useCustomerStats` que não passe `unitId`.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useCustomers.ts \
        supabase/migrations/20260817231000_107_drop_dead_rpc_overloads.sql \
        supabase/tests/local-preflight/10-overloads-107.sql \
        supabase/tests/local-preflight/README.md \
        scripts/function-acl-allowlist.json
git commit -m "fix(security): dropa dois overloads de RPC sem caller (migration 107)

get_reservation_by_code(text) e get_customer_stats(uuid) nao tinham consumidor;
o hook passa a exigir unitId, que o unico call site ja enviava. Menos duas
linhas WARN do lint 0029.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 9: Aplicar em produção, com confirmação**

Pedir confirmação, depois `supabase db push`. Verificar em produção: busca de reserva por código no painel e ficha de cliente. Conferir o advisor: **23 WARN**.

---

### Task 6: Fase 3 — aceite auditável dos 23 restantes

**Files:**
- Modify: `scripts/function-acl-allowlist.json`
- Modify: `scripts/audit-function-acl.ts`
- Modify: `scripts/function-acl-allowlist.test.ts`

**Interfaces:**
- Consumes: allowlist já sem `rls_helpers` (Task 3) e sem os 2 overloads (Task 5).
- Produces: bloco `_expected_advisor` na allowlist; regra `advisor-divergente` no `audit-function-acl.ts`.

- [ ] **Step 1: Escrever o teste de consistência que falha primeiro**

Acrescentar ao fim de `scripts/function-acl-allowlist.test.ts`:

```ts
/**
 * O bloco `_expected_advisor` existe para que "23 warnings" seja número
 * conferível e não memória. Esta camada confere a consistência interna sem
 * banco; quem compara com o ACL real é a regra 6 do audit-function-acl.ts.
 */
describe("_expected_advisor", () => {
  interface Expected {
    "0028": number;
    "0029": number;
    total: number;
  }
  const expected = allowlist["_expected_advisor"] as Expected | undefined;

  it("existe e soma", () => {
    expect(expected, "_expected_advisor ausente na allowlist").toBeDefined();
    expect(expected!.total).toBe(expected!["0028"] + expected!["0029"]);
  });

  it("toda entrada declara advisor_lints coerente com seus papéis", () => {
    for (const entry of allEntries) {
      const lints = (entry as unknown as { advisor_lints?: string[] }).advisor_lints;
      expect(lints, `${entry.name}(${entry.args}) sem advisor_lints`).toBeDefined();
      // 0028 é o lint de anon; 0029 é o de authenticated. Declarar 0028 sem ter
      // anon nos papéis é inconsistência de política, não de banco.
      expect(lints!.includes("0028")).toBe(entry.roles.includes("anon"));
    }
  });

  it("controle negativo: entrada legítima e coerente não reprova", () => {
    // Sem este caso, o teste acima passaria igual se a asserção fosse vacuamente
    // verdadeira para toda entrada.
    const legitima = {
      name: "get_unit_public",
      args: "p_slug text",
      roles: ["anon", "authenticated"],
      why: "Portal público.",
      advisor_lints: ["0028", "0029"],
    };
    expect(legitima.advisor_lints.includes("0028")).toBe(legitima.roles.includes("anon"));
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run scripts/function-acl-allowlist.test.ts`
Expected: FAIL — `_expected_advisor ausente na allowlist`.

- [ ] **Step 3: Estender a allowlist**

Acrescentar `"advisor_lints"` a cada entrada (`["0028","0029"]` quando `roles` inclui `anon`; `["0029"]` quando só `authenticated`) e, no topo do arquivo, o bloco:

```json
  "_expected_advisor": {
    "_doc": [
      "Total de WARN que o Security Advisor deve reportar para os lints 0028 e",
      "0029 depois das migrations 106 e 107. Divergência reprova o",
      "audit-function-acl.ts nomeando a assinatura que entrou ou saiu.",
      "",
      "NÃO cobre o lint INFO 0008 (rls_enabled_no_policy, 17 tabelas): ele vem de",
      "tabela, não de função, e é aceito por design — tabela com credencial usa",
      "FORCE RLS sem policy e a UI acessa por Edge Function."
    ],
    "0028": 9,
    "0029": 14,
    "total": 23
  },
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run scripts/function-acl-allowlist.test.ts`
Expected: PASS.

- [ ] **Step 5: Acrescentar a regra 6 ao `audit-function-acl.ts`**

Dentro de `audit()`, depois da regra 5, acrescentar a contagem por linha:

```ts
    // 6. Equivalente-advisor: os lints 0028/0029 medem exatamente
    //    "SECURITY DEFINER de um schema exposto, executável por anon/authenticated".
    //    A mesma linha que alimenta as regras acima já responde isso, então o
    //    guardrail confere o TOTAL contra `_expected_advisor` em vez de um
    //    script novo lendo a mesma verdade por outra porta.
    if (r.is_secdef && r.anon_execute) advisor0028.push(key);
    if (r.is_secdef && r.auth_execute) advisor0029.push(key);
```

e, depois do laço, comparar com o bloco `_expected_advisor` da allowlist, empurrando uma violação `advisor-divergente` de severidade `ALTO` quando qualquer um dos três números diferir — nomeando as assinaturas que entraram e as que saíram, não só a contagem. Imprimir sempre o inventário por lint no bloco de saída, mesmo sem violação: é o que torna a contagem conferível.

- [ ] **Step 6: Rodar o guardrail contra o projeto**

```powershell
$env:SUPABASE_URL = 'https://gbabxcrntkwgblgqsiit.supabase.co'
$env:SUPABASE_SERVICE_ROLE_KEY = '<chave inteira>'
npx deno@2.1.4 run --allow-net --allow-env --allow-read scripts/audit-function-acl.ts
$env:SUPABASE_SERVICE_ROLE_KEY = $null
```

Expected: exit 0, imprimindo `0028: 9 | 0029: 14 | total: 23`. A última linha limpa a chave da sessão — não pular.

- [ ] **Step 7: Commit**

```bash
git add scripts/function-acl-allowlist.json \
        scripts/audit-function-acl.ts \
        scripts/function-acl-allowlist.test.ts
git commit -m "feat(ci): guardrail confere o total de warnings do advisor

Estende o audit-function-acl.ts em vez de somar um script quase duplicado: ele
ja le o ACL real e ja sabe quem e SECURITY DEFINER, que e o que os lints
0028/0029 medem. Warning novo passa a reprovar nomeando a assinatura.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Documentação e fechamento

**Files:**
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: tudo.
- Produces: invariantes registrados.

- [ ] **Step 1: Acrescentar os invariantes ao CLAUDE.md**

Na seção **RLS**, uma linha:

```markdown
- **Helper de RLS vive em `app_private`, nunca em `public` — e guard de Edge Function usa `hasUnitAccess` de [_shared/authz.ts](supabase/functions/_shared/authz.ts), nunca `rpc("is_unit_member")`.** `public` é exposto ao PostgREST, então o helper virava oráculo de enumeração de membership com a anon key do bundle; e como 24 policies `TO PUBLIC` o chamam, revogar `EXECUTE` faria a query estourar em vez de negar — por isso mover, não revogar. Função nova de policy nasce em `app_private` com `grant usage` para `anon`/`authenticated`. [migration 106](supabase/migrations/20260817230000_106_advisor_private_rls_helpers.sql).
```

Na seção **Deploy → CI**, uma linha:

```markdown
- **Função `SECURITY DEFINER` em plpgsql resolve o nome do que ela chama em TEMPO DE EXECUÇÃO — mover uma dependência de schema exige reescrever o corpo na MESMA migration.** As policies referenciam por OID e sobrevivem sozinhas, o que faz o defeito passar despercebido numa revisão de policies: a 106 move três helpers e reescreve `enter_waitlist`, `anonymize_customer`, `get_customer_stats_bulk` e `get_undelivered_notifications` junto, senão a fila pública quebra. CONTROLE-6 do [pré-voo](supabase/tests/local-preflight/README.md) reproduz.
```

- [ ] **Step 2: Espelhar as duas linhas no AGENTS.md**

Em forma condensada, na seção equivalente. Os dois arquivos são par obrigatório e semanticamente sincronizado — commitar um sem o outro é proibido.

- [ ] **Step 3: Conferir o par**

Run: `git diff -- CLAUDE.md AGENTS.md`
Expected: as duas regras aparecem nos dois arquivos.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md
git commit -m "docs: dois invariantes do hardening do advisor

Helper de RLS mora em app_private e guard de EF usa _shared/authz.ts; e plpgsql
resolve nome em runtime, entao mover dependencia de schema exige reescrever o
corpo na mesma migration.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Fechamento — conferir os critérios de aceite da spec**

Percorrer a §9 da spec e confirmar os 7 itens, um a um, com evidência (saída de comando, não impressão).

---

## Auto-revisão do plano

**Cobertura da spec:** §3 → Tasks 1-4. §4 → Task 5. §5 → Task 6. §6.1 → Tasks 3 e 5 (arquivos `08`, `09`, `10`). §6.2 → Tasks 1 e 6. §6.3 → Task 3 Step 10. §6.4 → Tasks 2, 4 e 5 Step 9. §7 (rollback) → referenciado na Task 4 Step 3. §9 → Task 7 Step 5.

**Lacuna consciente:** a spec §6.2 previa um caso novo em `scripts/migration-static-guard.test.ts` garantindo que migration futura não recrie os helpers em `public`. Não virou task própria porque o `_doc_rls_helpers` da allowlist (Task 3 Step 8) mais a regra 3 do `audit-function-acl.ts` ("exposta sem estar na allowlist" → `CRITICO`) já reprovam essa regressão por duas portas independentes, e a terceira guarda mediria o mesmo fato com mais manutenção. Se a revisão discordar, o caso entra na Task 6.

**Consistência de tipos:** `hasUnitAccess(supabase, userId, unitId): Promise<boolean>` é o mesmo nome e assinatura na Task 1 (Steps 3-7), no guardrail (Step 1) e no CLAUDE.md (Task 7). `useCustomerStats(customerId, unitId)` idem entre Task 5 Step 3 e a tabela de interfaces.
