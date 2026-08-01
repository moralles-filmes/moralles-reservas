# Fase 6b — Ciclo de vida da instância de WhatsApp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rastrear ciclo, custo, estado e vínculo de cada instância Z-API que a plataforma paga, com alerta D-7 antes de cada cobrança do fornecedor — sem tocar credencial, envio, entitlement ou `billing_status`.

**Architecture:** Seis núcleos puros (zero imports, testados por vitest a partir de `src/`) concentram toda a decisão; três tabelas novas com `FORCE RLS` sem policy de tenant guardam os fatos; uma RPC transacional faz a rolagem de ciclo; um worker `pg_cron` executa cinco passos isolados; uma Edge Function de super-admin serve o painel. O worker **nunca** chama a Z-API — divergência é comparação entre fatos já persistidos.

**Tech Stack:** Postgres/Supabase (migrations SQL idempotentes, RPC `SECURITY DEFINER`, `pg_cron` + `pg_net` + Vault), Deno Edge Functions, React + TanStack Query + Tailwind, vitest.

**Spec:** [docs/superpowers/specs/2026-08-01-billing-asaas-fase-6b-design.md](../specs/2026-08-01-billing-asaas-fase-6b-design.md) — Seções A, B, C e D fechadas. Onde este plano e a spec divergirem, **a spec vence**.

## Global Constraints

Valem para **todas** as tasks. Não repetidas em cada uma.

- **`whatsapp_instances.lifecycle_state` MUST NOT be used as an entitlement or message-sending authorization source.** Nenhum consumidor de envio, agente, webhook ou job decide permissão lendo esse campo. A fonte de direito de uso continua sendo o gate de sete estados da 5b (`_shared/whatsapp-service-state-core.ts`).
- **Zero credencial.** Nenhuma tabela, log, payload de erro ou resposta desta fase carrega token, senha, API key, client token ou URL contendo segredo. Nada duplica `whatsapp_channels.credentials`.
- **Nenhuma chamada ao provedor.** O worker não importa cliente Z-API e não faz `fetch` externo. Nenhuma criação, alteração ou cancelamento na Z-API.
- **Nenhuma escrita em** `organizations.billing_status`, `billing_subscriptions`, `organization_entitlement_overrides`, `whatsapp_channels.credentials`.
- **Flags inalteradas:** `whatsapp_service_enforcement` OFF · `whatsapp_implementation_flow` OFF · `whatsapp_subscription_checkout` OFF · `billing_notifications_dispatch` OFF · Asaas em **sandbox**. **A Fase 6b não cria flag própria.**
- **Núcleo puro = zero `import`.** Nem `esm.sh`, nem `import type` de fora, nem `Deno.*`. Um único import quebra a resolução do Vite e derruba a suíte inteira.
- **`tsconfig.app.json` tem `strict: false`:** `if (!x.ok) { x.campo }` **não** estreita união discriminada. Use `x.ok === false` ou early-return.
- **Data civil sempre BRT** via `todayBrt(nowMs)` de `_shared/billing-delinquency-core.ts`. **Não criar outro helper.** Nunca `new Date()` cru — Deno roda em UTC.
- **Valores monetários em centavos inteiros.** Custo desconhecido é `NULL`, **nunca zero**.
- **`cycle_start` é inclusivo, `provider_due_on` e `provider_access_until` são exclusivos.** Não existe campo `cycle_end`.
- **Migration nova não repete o padrão legado:** nenhuma URL de projeto Supabase *hardcoded*, nenhum *endpoint* de produção, nenhum segredo, nenhum cron apontando para ambiente fixo (§11.0).
- **Toda função nova em `public`** revoga `PUBLIC`, `anon` e `authenticated` e concede só a `service_role`, com `search_path` explícito mínimo. Allowlist de ACL atualizada no mesmo PR quando aplicável.
- **`supabase db push` sempre** — nunca SQL colado no Studio.
- **Motivo obrigatório na própria action** para alteração de custo, cancelamento, correção de ciclo, mudança de vínculo e confirmação de encerramento. Não depende do trigger genérico de auditoria.
- **Commits frequentes**, um por task no mínimo. `npm run typecheck` (= `tsc -b --noEmit`) antes de cada commit que toque TypeScript.

---

## File Structure

**Núcleos puros** — `supabase/functions/_shared/`, testados de `src/lib/*.test.ts`:

| Arquivo | Responsabilidade única |
|---|---|
| `whatsapp-instance-core.ts` | Gate de provisionamento, transições de lifecycle, sanidade de `provider_instance_ref` |
| `whatsapp-instance-cycle-core.ts` | Aritmética de calendário: vencimento, rolagem, dia-âncora com *clamp* |
| `whatsapp-instance-revenue-core.ts` | Atribuição de receita e margem |
| `whatsapp-instance-alerts-core.ts` | Tipos de alerta, `resolveD1Reasons`, `dedupe_key`, hash econômico |
| `whatsapp-instance-divergence-core.ts` | Os cinco tipos de divergência e o limiar de sete dias |
| `whatsapp-partner-simulator-core.ts` | Simulação do Plano Partner |

**Migrations** — `supabase/migrations/`:

| Arquivo | Conteúdo |
|---|---|
| `20260801200000_087_whatsapp_instances.sql` | Tabela, *constraints*, integridade cross-tenant, RLS, auditoria |
| `20260801200100_088_whatsapp_instance_cycles.sql` | Histórico imutável de ciclos |
| `20260801200200_089_whatsapp_instance_alerts.sql` | Ledger de alertas |
| `20260801200300_090_whatsapp_instance_cycle_rpc.sql` | RPC transacional de rolagem + lock advisory + ACL |
| `20260801200400_091_drop_zapi_auto_flags.sql` | Remoção das três flags órfãs |
| `20260801200500_092_whatsapp_instance_cycles_trigger.sql` | *Wrapper* `trigger_*` lendo `project_url` do Vault — **sem agendar** |
| `20260801200600_093_cron_whatsapp_instance_cycles.sql` | `cron.schedule` — **só entra no repo no passo 12 do rollout** |

**Edge Functions** — `supabase/functions/`:

| Arquivo | Responsabilidade |
|---|---|
| `manage-whatsapp-instances/index.ts` | Painel administrativo (`verify_jwt = true`) |
| `process-whatsapp-instance-cycles/index.ts` | Worker de cinco passos (`verify_jwt = false`) |
| `process-billing-notifications/index.ts` *(modificar)* | Seis entradas novas em `TEMPLATE_BY_EVENT` |

**Frontend** — `src/`:

| Arquivo | Responsabilidade |
|---|---|
| `hooks/useWhatsappInstances.ts` | Queries e mutations contra a EF |
| `pages/platform/WhatsappInstances.tsx` | Lista, detalhe, ações e simulador |
| `App.tsx` *(modificar)* | Rota `/platform/instancias-whatsapp` |

**Guardrails** — `scripts/`, `.github/`:

| Arquivo | Responsabilidade |
|---|---|
| `scripts/migration-static-guard.test.ts` | Falha o CI se migration nova tiver URL de projeto, *endpoint* de produção ou segredo |
| `.github/workflows/function-acl-audit.yml` *(modificar)* | Passo novo no job `acl-estatico` |

**Testes de integração** — `supabase/tests/` (nascem `ENVIRONMENT_BLOCKED`, §11.2).

---

## Task 1: Núcleo de calendário (`whatsapp-instance-cycle-core.ts`)

**Files:**
- Create: `supabase/functions/_shared/whatsapp-instance-cycle-core.ts`
- Test: `src/lib/whatsapp-instance-cycle-core.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  ```ts
  export type IsoDate = string; // "YYYY-MM-DD"
  export function daysInMonth(year: number, month1: number): number
  export function clampDayToMonth(year: number, month1: number, day: number): number
  export function nextDueFromAnchor(fromIso: IsoDate, anchorDay: number): IsoDate
  export function isCycleDue(providerDueOn: IsoDate, todayIso: IsoDate): boolean
  export function daysUntil(targetIso: IsoDate, todayIso: IsoDate): number
  export function nextCycleFrom(providerDueOn: IsoDate, anchorDay: number): { cycleStart: IsoDate; providerDueOn: IsoDate }
  ```

- [ ] **Step 1: Escrever o teste que falha**

`src/lib/whatsapp-instance-cycle-core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  clampDayToMonth,
  nextDueFromAnchor,
  isCycleDue,
  daysUntil,
  nextCycleFrom,
} from "../../supabase/functions/_shared/whatsapp-instance-cycle-core";

describe("isCycleDue — o limite exato (spec §6.4)", () => {
  it("antes do vencimento: não venceu", () => {
    expect(isCycleDue("2026-08-10", "2026-08-09")).toBe(false);
  });

  it("EXATAMENTE no vencimento: venceu — o fim é exclusivo, `>` atrasaria um dia", () => {
    expect(isCycleDue("2026-08-10", "2026-08-10")).toBe(true);
  });

  it("depois do vencimento: venceu", () => {
    expect(isCycleDue("2026-08-10", "2026-08-11")).toBe(true);
  });

  it("compara data civil, não instante: a virada UTC entre 21h e 00h BRT não antecipa nada", () => {
    // 2026-08-09T23:30-03:00 é 2026-08-10T02:30Z. Quem passar a data civil BRT
    // correta ("2026-08-09") não vence; quem usar o dia UTC vence um dia antes.
    expect(isCycleDue("2026-08-10", "2026-08-09")).toBe(false);
    expect(isCycleDue("2026-08-10", "2026-08-10")).toBe(true);
  });
});

describe("clampDayToMonth", () => {
  it("mês de 28 dias", () => {
    expect(clampDayToMonth(2026, 2, 31)).toBe(28);
  });

  it("fevereiro bissexto tem 29", () => {
    expect(clampDayToMonth(2028, 2, 31)).toBe(29);
  });

  it("mês de 30 dias", () => {
    expect(clampDayToMonth(2026, 4, 31)).toBe(30);
  });

  it("mês de 31 dias não altera nada", () => {
    expect(clampDayToMonth(2026, 5, 31)).toBe(31);
  });
});

describe("nextDueFromAnchor — a âncora sobrevive ao clamp (spec §6.3)", () => {
  it("31 → 28/02 → 31/03: o clamp do mês corrente NUNCA substitui a âncora", () => {
    expect(nextDueFromAnchor("2026-01-31", 31)).toBe("2026-02-28");
    expect(nextDueFromAnchor("2026-02-28", 31)).toBe("2026-03-31");
    expect(nextDueFromAnchor("2026-03-31", 31)).toBe("2026-04-30");
    expect(nextDueFromAnchor("2026-04-30", 31)).toBe("2026-05-31");
  });

  it("ano vira corretamente", () => {
    expect(nextDueFromAnchor("2026-12-15", 15)).toBe("2027-01-15");
  });

  it("âncora 29 em ano não bissexto vira 28/02 e volta a 29", () => {
    expect(nextDueFromAnchor("2026-01-29", 29)).toBe("2026-02-28");
    expect(nextDueFromAnchor("2026-02-28", 29)).toBe("2026-03-29");
  });
});

describe("daysUntil", () => {
  it("conta dias civis, sem hora", () => {
    expect(daysUntil("2026-08-10", "2026-08-03")).toBe(7);
    expect(daysUntil("2026-08-10", "2026-08-09")).toBe(1);
    expect(daysUntil("2026-08-10", "2026-08-10")).toBe(0);
    expect(daysUntil("2026-08-10", "2026-08-11")).toBe(-1);
  });

  it("atravessa mês e ano", () => {
    expect(daysUntil("2027-01-01", "2026-12-25")).toBe(7);
  });
});

describe("nextCycleFrom — reexecução idempotente", () => {
  it("o próximo ciclo começa exatamente no vencimento do anterior", () => {
    expect(nextCycleFrom("2026-01-31", 31)).toEqual({
      cycleStart: "2026-01-31",
      providerDueOn: "2026-02-28",
    });
  });

  it("chamar duas vezes com a mesma entrada produz o mesmo resultado", () => {
    const a = nextCycleFrom("2026-02-28", 31);
    const b = nextCycleFrom("2026-02-28", 31);
    expect(a).toEqual(b);
    expect(a).toEqual({ cycleStart: "2026-02-28", providerDueOn: "2026-03-31" });
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/whatsapp-instance-cycle-core.test.ts`
Expected: FAIL — `Failed to resolve import ".../whatsapp-instance-cycle-core"`.

- [ ] **Step 3: Implementar o núcleo**

`supabase/functions/_shared/whatsapp-instance-cycle-core.ts`:

```ts
// Núcleo puro (Fase 6b): aritmética do calendário do FORNECEDOR.
//
// ZERO IMPORTS — importado por Edge Function (Deno) e por vitest a partir de
// src/. Um único import de esm.sh, mesmo `import type`, quebra a resolução do
// Vite e derruba a suíte inteira.
//
// Não lê relógio. A data civil de referência entra SEMPRE por parâmetro, já
// resolvida em BRT pelo caller via todayBrt() de billing-delinquency-core.ts.

export type IsoDate = string; // "YYYY-MM-DD"

function parts(iso: IsoDate): { y: number; m: number; d: number } {
  return {
    y: Number(iso.slice(0, 4)),
    m: Number(iso.slice(5, 7)),
    d: Number(iso.slice(8, 10)),
  };
}

function fmt(y: number, m: number, d: number): IsoDate {
  const mm = m < 10 ? `0${m}` : `${m}`;
  const dd = d < 10 ? `0${d}` : `${d}`;
  return `${y}-${mm}-${dd}`;
}

export function daysInMonth(year: number, month1: number): number {
  // Dia 0 do mês seguinte = último dia deste mês. Date.UTC evita fuso.
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Dia-âncora ajustado ao mês, sem NUNCA sobrescrever a âncora original. */
export function clampDayToMonth(year: number, month1: number, day: number): number {
  const max = daysInMonth(year, month1);
  return day > max ? max : day;
}

/**
 * Próximo vencimento: avança UM mês a partir de `fromIso` e aplica a âncora
 * com clamp. A âncora vem da instância (persistida), nunca do dia de `fromIso`
 * — é o que faz 31/01 → 28/02 → 31/03 em vez de degradar para 28 pra sempre.
 */
export function nextDueFromAnchor(fromIso: IsoDate, anchorDay: number): IsoDate {
  const { y, m } = parts(fromIso);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return fmt(ny, nm, clampDayToMonth(ny, nm, anchorDay));
}

/**
 * O ciclo cobre [cycle_start, provider_due_on) — fim EXCLUSIVO. Por isso `>=`
 * e não `>`: com `>` a rolagem sairia um dia atrasada.
 */
export function isCycleDue(providerDueOn: IsoDate, todayIso: IsoDate): boolean {
  return todayIso >= providerDueOn;
}

/** Dias civis até o alvo. Positivo = futuro, 0 = hoje, negativo = passado. */
export function daysUntil(targetIso: IsoDate, todayIso: IsoDate): number {
  const t = parts(targetIso);
  const n = parts(todayIso);
  const ms = Date.UTC(t.y, t.m - 1, t.d) - Date.UTC(n.y, n.m - 1, n.d);
  return Math.round(ms / 86400000);
}

/** Próximo ciclo. `cycleStart` do novo == `providerDueOn` do anterior (§6.1). */
export function nextCycleFrom(
  providerDueOn: IsoDate,
  anchorDay: number,
): { cycleStart: IsoDate; providerDueOn: IsoDate } {
  return {
    cycleStart: providerDueOn,
    providerDueOn: nextDueFromAnchor(providerDueOn, anchorDay),
  };
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/lib/whatsapp-instance-cycle-core.test.ts`
Expected: PASS, todos os casos.

- [ ] **Step 5: Typecheck e commit**

```bash
npm run typecheck
git add supabase/functions/_shared/whatsapp-instance-cycle-core.ts src/lib/whatsapp-instance-cycle-core.test.ts
git commit -m "feat(6b): nucleo puro do calendario do fornecedor"
```

---

## Task 2: Gate de provisionamento e lifecycle (`whatsapp-instance-core.ts`)

**Files:**
- Create: `supabase/functions/_shared/whatsapp-instance-core.ts`
- Test: `src/lib/whatsapp-instance-core.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  ```ts
  export const NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A = true;
  export const PROVISIONING_BLOCKED_CODE = "NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A";
  export type LifecycleState = "AWAITING_PROVISION" | "ACTIVE" | "CANCELLATION_REQUESTED" | "ENDED";
  export type CoreResult = { ok: true } | { ok: false; code: string; message: string };
  export type ProvisioningIntent = "BACKFILL_EXISTING" | "NEW_PROVISION" | "AMBIGUOUS";
  export function assertProvisioningAllowed(intent: ProvisioningIntent): CoreResult
  export function canTransition(from: LifecycleState, to: LifecycleState, opts: { hasProviderEvidence: boolean }): CoreResult
  export function validateProviderInstanceRef(raw: string): { ok: true; value: string } | { ok: false; code: string; message: string }
  ```

- [ ] **Step 1: Escrever o teste que falha**

`src/lib/whatsapp-instance-core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A,
  PROVISIONING_BLOCKED_CODE,
  assertProvisioningAllowed,
  canTransition,
  validateProviderInstanceRef,
} from "../../supabase/functions/_shared/whatsapp-instance-core";

describe("gate de provisionamento (spec §2)", () => {
  it("a constante existe e está LIGADA até a Fase 6a", () => {
    expect(NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A).toBe(true);
  });

  it("provisionamento novo é recusado", () => {
    const r = assertProvisioningAllowed("NEW_PROVISION");
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.code).toBe(PROVISIONING_BLOCKED_CODE);
  });

  it("backfill de instância que já existe no fornecedor é PERMITIDO", () => {
    expect(assertProvisioningAllowed("BACKFILL_EXISTING").ok).toBe(true);
  });

  it("ambiguidade entre backfill e criação nova BLOQUEIA — fail-closed", () => {
    const r = assertProvisioningAllowed("AMBIGUOUS");
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.code).toBe(PROVISIONING_BLOCKED_CODE);
  });

  it("a mensagem de bloqueio não expõe segredo nem detalhe de credencial", () => {
    const r = assertProvisioningAllowed("NEW_PROVISION");
    if (r.ok === false) {
      expect(r.message).not.toMatch(/token|secret|credential|senha/i);
      expect(r.message.length).toBeGreaterThan(0);
    }
  });
});

describe("transições de lifecycle (spec §4)", () => {
  const noEvidence = { hasProviderEvidence: false };
  const evidence = { hasProviderEvidence: true };

  it("ACTIVE → CANCELLATION_REQUESTED é permitido", () => {
    expect(canTransition("ACTIVE", "CANCELLATION_REQUESTED", noEvidence).ok).toBe(true);
  });

  it("CANCELLATION_REQUESTED → ENDED é permitido (confirmação humana)", () => {
    expect(canTransition("CANCELLATION_REQUESTED", "ENDED", noEvidence).ok).toBe(true);
  });

  it("CANCELLATION_REQUESTED → ACTIVE exige evidência de reversão no fornecedor", () => {
    expect(canTransition("CANCELLATION_REQUESTED", "ACTIVE", noEvidence).ok).toBe(false);
    expect(canTransition("CANCELLATION_REQUESTED", "ACTIVE", evidence).ok).toBe(true);
  });

  it("ENDED NÃO volta a ACTIVE silenciosamente, nem com evidência", () => {
    expect(canTransition("ENDED", "ACTIVE", evidence).ok).toBe(false);
  });

  it("ACTIVE → ENDED direto é recusado: passa por CANCELLATION_REQUESTED", () => {
    expect(canTransition("ACTIVE", "ENDED", evidence).ok).toBe(false);
  });

  it("transição para o mesmo estado é no-op permitido (idempotência)", () => {
    expect(canTransition("ACTIVE", "ACTIVE", noEvidence).ok).toBe(true);
  });
});

describe("validateProviderInstanceRef — identificador, nunca credencial (§3.3)", () => {
  it("aceita identificador simples", () => {
    const r = validateProviderInstanceRef("  3A2F9C1D  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("3A2F9C1D");
  });

  it("recusa string vazia", () => {
    expect(validateProviderInstanceRef("   ").ok).toBe(false);
  });

  it("recusa URL completa — ela carregaria o token na outra metade", () => {
    expect(validateProviderInstanceRef("https://api.z-api.io/instances/X/token/Y").ok).toBe(false);
  });

  it("recusa valor longo demais para ser identificador", () => {
    expect(validateProviderInstanceRef("A".repeat(129)).ok).toBe(false);
  });

  it("recusa valor com espaço interno ou quebra de linha", () => {
    expect(validateProviderInstanceRef("abc def").ok).toBe(false);
    expect(validateProviderInstanceRef("abc\ndef").ok).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/whatsapp-instance-core.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar o núcleo**

`supabase/functions/_shared/whatsapp-instance-core.ts`:

```ts
// Núcleo puro (Fase 6b): gate de provisionamento e máquina de lifecycle.
// ZERO IMPORTS — ver o cabeçalho de whatsapp-instance-cycle-core.ts.

/**
 * Proibição ESTRUTURAL e TEMPORÁRIA, não rollout gradual: por isso constante
 * e não platform_flag. Uma flag existiria para ser ligada; esta constante
 * existe para ser REMOVIDA pelo PR da Fase 6a, que substitui os testes de
 * recusa por testes de liberação condicionada.
 */
export const NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A = true;

export const PROVISIONING_BLOCKED_CODE =
  "NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A";

const PROVISIONING_BLOCKED_MESSAGE =
  "Provisionamento de instância nova está bloqueado até a Fase 6a (criptografia das credenciais em repouso). Registro de instância já existente (backfill) continua permitido.";

export type LifecycleState =
  | "AWAITING_PROVISION"
  | "ACTIVE"
  | "CANCELLATION_REQUESTED"
  | "ENDED";

export type CoreResult = { ok: true } | { ok: false; code: string; message: string };

export type ProvisioningIntent = "BACKFILL_EXISTING" | "NEW_PROVISION" | "AMBIGUOUS";

/**
 * AMBIGUOUS bloqueia junto com NEW_PROVISION: na dúvida entre "já existe lá
 * fora" e "vamos criar", a direção segura é não autorizar custo novo.
 */
export function assertProvisioningAllowed(intent: ProvisioningIntent): CoreResult {
  if (intent === "BACKFILL_EXISTING") return { ok: true };
  if (!NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A) return { ok: true };
  return {
    ok: false,
    code: PROVISIONING_BLOCKED_CODE,
    message: PROVISIONING_BLOCKED_MESSAGE,
  };
}

const ALLOWED: Record<LifecycleState, LifecycleState[]> = {
  AWAITING_PROVISION: ["ACTIVE", "ENDED"],
  ACTIVE: ["CANCELLATION_REQUESTED"],
  CANCELLATION_REQUESTED: ["ENDED", "ACTIVE"],
  ENDED: [],
};

export function canTransition(
  from: LifecycleState,
  to: LifecycleState,
  opts: { hasProviderEvidence: boolean },
): CoreResult {
  if (from === to) return { ok: true };

  if (!ALLOWED[from] || ALLOWED[from].indexOf(to) === -1) {
    return {
      ok: false,
      code: "LIFECYCLE_TRANSITION_NOT_ALLOWED",
      message: `Transição ${from} → ${to} não é permitida.`,
    };
  }

  // Reverter um cancelamento é afirmar que o fornecedor desfez algo. Sem
  // evidência, seria o bug 08 outra vez: o sistema afirmando o que o provedor
  // nunca fez.
  if (from === "CANCELLATION_REQUESTED" && to === "ACTIVE" && !opts.hasProviderEvidence) {
    return {
      ok: false,
      code: "REACTIVATION_REQUIRES_EVIDENCE",
      message: "Reverter o cancelamento exige evidência registrada de que ele foi desfeito no fornecedor.",
    };
  }

  return { ok: true };
}

const MAX_REF_LENGTH = 128;

/**
 * Sanidade, não autenticação. O identificador sozinho não envia mensagem — o
 * token, a outra metade da URL, fica só no canal. Recusar URL completa é o que
 * impede alguém colar a URL de envio inteira neste campo e vazar o token para
 * uma tabela que a spec declara livre de segredo.
 */
export function validateProviderInstanceRef(
  raw: string,
): { ok: true; value: string } | { ok: false; code: string; message: string } {
  const value = typeof raw === "string" ? raw.trim() : "";

  if (value.length === 0) {
    return { ok: false, code: "REF_EMPTY", message: "Identificador da instância é obrigatório." };
  }
  if (value.length > MAX_REF_LENGTH) {
    return { ok: false, code: "REF_TOO_LONG", message: "Identificador da instância excede o tamanho esperado." };
  }
  if (/\s/.test(value)) {
    return { ok: false, code: "REF_HAS_WHITESPACE", message: "Identificador da instância não pode conter espaços." };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.indexOf("/") !== -1) {
    return {
      ok: false,
      code: "REF_LOOKS_LIKE_URL",
      message: "Informe apenas o identificador da instância, nunca a URL — ela contém o token.",
    };
  }
  return { ok: true, value };
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/lib/whatsapp-instance-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck e commit**

```bash
npm run typecheck
git add supabase/functions/_shared/whatsapp-instance-core.ts src/lib/whatsapp-instance-core.test.ts
git commit -m "feat(6b): gate de provisionamento e maquina de lifecycle"
```

---

## Task 3: Receita atribuída e margem (`whatsapp-instance-revenue-core.ts`)

**Files:**
- Create: `supabase/functions/_shared/whatsapp-instance-revenue-core.ts`
- Test: `src/lib/whatsapp-instance-revenue-core.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  ```ts
  export type RevenueSource = "SUBSCRIPTION_SOLE_INSTANCE" | "AMBIGUOUS_MULTI_INSTANCE" | "LIFETIME_OVERRIDE" | "NO_ENTITLEMENT";
  export type RevenueAttribution = { customerRevenueCents: number | null; revenueSource: RevenueSource };
  export type RevenueInput = { activeInstanceCount: number; subscriptionAmountCents: number | null; hasLifetimeWhatsappOverride: boolean };
  export function attributeRevenue(input: RevenueInput): RevenueAttribution
  export function grossMarginCents(revenueCents: number | null, costCents: number | null): number | null
  export type MarginDisplay = { kind: "PERCENT"; value: number } | { kind: "NOT_APPLICABLE" } | { kind: "PENDING" };
  export function grossMarginDisplay(revenueCents: number | null, costCents: number | null): MarginDisplay
  export function consolidateOrgMargin(costs: (number | null)[], revenueCents: number | null): { knownCostCents: number; unknownCostInstances: number; marginCents: number | null }
  ```

- [ ] **Step 1: Escrever o teste que falha**

`src/lib/whatsapp-instance-revenue-core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  attributeRevenue,
  grossMarginCents,
  grossMarginDisplay,
  consolidateOrgMargin,
} from "../../supabase/functions/_shared/whatsapp-instance-revenue-core";

describe("attributeRevenue (spec §7.3)", () => {
  it("1 instância + 1 assinatura: receita é o valor da assinatura", () => {
    expect(
      attributeRevenue({
        activeInstanceCount: 1,
        subscriptionAmountCents: 14900,
        hasLifetimeWhatsappOverride: false,
      }),
    ).toEqual({ customerRevenueCents: 14900, revenueSource: "SUBSCRIPTION_SOLE_INSTANCE" });
  });

  it("N>1 instâncias + 1 assinatura: NULL — copiar os R$149 para cada uma inflaria a receita em N×", () => {
    expect(
      attributeRevenue({
        activeInstanceCount: 3,
        subscriptionAmountCents: 14900,
        hasLifetimeWhatsappOverride: false,
      }),
    ).toEqual({ customerRevenueCents: null, revenueSource: "AMBIGUOUS_MULTI_INSTANCE" });
  });

  it("override vitalício: ZERO verdadeiro, não desconhecido — e vence a assinatura", () => {
    expect(
      attributeRevenue({
        activeInstanceCount: 1,
        subscriptionAmountCents: 14900,
        hasLifetimeWhatsappOverride: true,
      }),
    ).toEqual({ customerRevenueCents: 0, revenueSource: "LIFETIME_OVERRIDE" });
  });

  it("override vitalício vence também com N instâncias", () => {
    expect(
      attributeRevenue({
        activeInstanceCount: 4,
        subscriptionAmountCents: null,
        hasLifetimeWhatsappOverride: true,
      }).revenueSource,
    ).toBe("LIFETIME_OVERRIDE");
  });

  it("sem assinatura e sem override: NULL + NO_ENTITLEMENT (gera alerta no caller)", () => {
    expect(
      attributeRevenue({
        activeInstanceCount: 1,
        subscriptionAmountCents: null,
        hasLifetimeWhatsappOverride: false,
      }),
    ).toEqual({ customerRevenueCents: null, revenueSource: "NO_ENTITLEMENT" });
  });

  it("assinatura de valor zero NÃO é ausência de assinatura", () => {
    expect(
      attributeRevenue({
        activeInstanceCount: 1,
        subscriptionAmountCents: 0,
        hasLifetimeWhatsappOverride: false,
      }),
    ).toEqual({ customerRevenueCents: 0, revenueSource: "SUBSCRIPTION_SOLE_INSTANCE" });
  });
});

describe("grossMarginCents", () => {
  it("receita menos custo", () => {
    expect(grossMarginCents(14900, 10000)).toBe(4900);
  });

  it("Ren Sushi: receita 0 e custo conhecido dá margem NEGATIVA — é o produto da fase", () => {
    expect(grossMarginCents(0, 10000)).toBe(-10000);
  });

  it("receita desconhecida não vira margem", () => {
    expect(grossMarginCents(null, 10000)).toBeNull();
  });

  it("custo desconhecido não vira margem", () => {
    expect(grossMarginCents(14900, null)).toBeNull();
  });
});

describe("grossMarginDisplay — nunca 0% para desconhecido (§7.3)", () => {
  it("receita positiva: percentual", () => {
    expect(grossMarginDisplay(14900, 10000)).toEqual({ kind: "PERCENT", value: 4900 / 14900 * 100 });
  });

  it("receita zero: NÃO APLICÁVEL, nunca 0% e nunca divisão por zero", () => {
    expect(grossMarginDisplay(0, 10000)).toEqual({ kind: "NOT_APPLICABLE" });
  });

  it("receita NULL: PENDENTE", () => {
    expect(grossMarginDisplay(null, 10000)).toEqual({ kind: "PENDING" });
  });

  it("custo NULL: PENDENTE", () => {
    expect(grossMarginDisplay(14900, null)).toEqual({ kind: "PENDING" });
  });
});

describe("consolidateOrgMargin — a margem verdadeira quando há N instâncias", () => {
  it("soma os custos conhecidos e conta os desconhecidos separadamente", () => {
    expect(consolidateOrgMargin([10000, null, 12000], 14900)).toEqual({
      knownCostCents: 22000,
      unknownCostInstances: 1,
      marginCents: null,
    });
  });

  it("com todos os custos conhecidos, a margem consolidada existe", () => {
    expect(consolidateOrgMargin([10000, 12000], 14900)).toEqual({
      knownCostCents: 22000,
      unknownCostInstances: 0,
      marginCents: -7100,
    });
  });

  it("receita NULL não produz margem consolidada", () => {
    expect(consolidateOrgMargin([10000], null).marginCents).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/whatsapp-instance-revenue-core.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar o núcleo**

`supabase/functions/_shared/whatsapp-instance-revenue-core.ts`:

```ts
// Núcleo puro (Fase 6b): atribuição de receita e margem. ZERO IMPORTS.
//
// A política existe porque N instâncias por organização é PERMITIDO (§5).
// Nunca copiar a assinatura para cada instância (inflaria em N×) e nunca
// ratear igualmente sem decisão comercial explícita e versionada.

export type RevenueSource =
  | "SUBSCRIPTION_SOLE_INSTANCE"
  | "AMBIGUOUS_MULTI_INSTANCE"
  | "LIFETIME_OVERRIDE"
  | "NO_ENTITLEMENT";

export type RevenueAttribution = {
  customerRevenueCents: number | null;
  revenueSource: RevenueSource;
};

export type RevenueInput = {
  activeInstanceCount: number;
  subscriptionAmountCents: number | null;
  hasLifetimeWhatsappOverride: boolean;
};

export function attributeRevenue(input: RevenueInput): RevenueAttribution {
  // Override PRIMEIRO: cortesia vitalícia é decisão comercial que substitui a
  // assinatura, e 0 aqui é zero VERDADEIRO — não "não sei".
  if (input.hasLifetimeWhatsappOverride) {
    return { customerRevenueCents: 0, revenueSource: "LIFETIME_OVERRIDE" };
  }
  if (input.subscriptionAmountCents === null || input.subscriptionAmountCents === undefined) {
    return { customerRevenueCents: null, revenueSource: "NO_ENTITLEMENT" };
  }
  if (input.activeInstanceCount > 1) {
    return { customerRevenueCents: null, revenueSource: "AMBIGUOUS_MULTI_INSTANCE" };
  }
  return {
    customerRevenueCents: input.subscriptionAmountCents,
    revenueSource: "SUBSCRIPTION_SOLE_INSTANCE",
  };
}

export function grossMarginCents(
  revenueCents: number | null,
  costCents: number | null,
): number | null {
  if (revenueCents === null || revenueCents === undefined) return null;
  if (costCents === null || costCents === undefined) return null;
  return revenueCents - costCents;
}

export type MarginDisplay =
  | { kind: "PERCENT"; value: number }
  | { kind: "NOT_APPLICABLE" }
  | { kind: "PENDING" };

/**
 * O percentual é DERIVADO, nunca armazenado: um percentual gravado só pode
 * divergir dos dois inteiros que já estão persistidos.
 */
export function grossMarginDisplay(
  revenueCents: number | null,
  costCents: number | null,
): MarginDisplay {
  if (revenueCents === null || revenueCents === undefined) return { kind: "PENDING" };
  if (costCents === null || costCents === undefined) return { kind: "PENDING" };
  if (revenueCents === 0) return { kind: "NOT_APPLICABLE" };
  return { kind: "PERCENT", value: ((revenueCents - costCents) / revenueCents) * 100 };
}

/**
 * Margem consolidada da ORGANIZAÇÃO. Custo desconhecido em qualquer instância
 * impede a consolidação — somar só o que se conhece produziria uma margem
 * otimista que parece um fato.
 */
export function consolidateOrgMargin(
  costs: (number | null)[],
  revenueCents: number | null,
): { knownCostCents: number; unknownCostInstances: number; marginCents: number | null } {
  let knownCostCents = 0;
  let unknownCostInstances = 0;
  for (const c of costs) {
    if (c === null || c === undefined) unknownCostInstances++;
    else knownCostCents += c;
  }
  const marginCents =
    unknownCostInstances > 0 || revenueCents === null || revenueCents === undefined
      ? null
      : revenueCents - knownCostCents;
  return { knownCostCents, unknownCostInstances, marginCents };
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/lib/whatsapp-instance-revenue-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck e commit**

```bash
npm run typecheck
git add supabase/functions/_shared/whatsapp-instance-revenue-core.ts src/lib/whatsapp-instance-revenue-core.test.ts
git commit -m "feat(6b): atribuicao de receita e margem por instancia e por org"
```

---

## Task 4: Alertas, `resolveD1Reasons` e dedupe (`whatsapp-instance-alerts-core.ts`)

**Files:**
- Create: `supabase/functions/_shared/whatsapp-instance-alerts-core.ts`
- Test: `src/lib/whatsapp-instance-alerts-core.test.ts`

**Interfaces:**
- Consumes: `RevenueSource` de `whatsapp-instance-revenue-core.ts` — **replicado como união literal local**, não importado (núcleo puro é zero-import; `import type` também quebra o Vite).
- Produces:
  ```ts
  export type AlertType = "CYCLE_DUE_SOON" | "CYCLE_DUE_TOMORROW" | "END_CONFIRMATION_REQUIRED" | "DIVERGENCE" | "CYCLE_COST_UNKNOWN" | "ECONOMIC_IMBALANCE" | "DATE_REVIEW_REQUIRED";
  export type NotifiableAlertType = Exclude<AlertType, "DATE_REVIEW_REQUIRED">;
  export const EVENT_TYPE_BY_ALERT: Record<NotifiableAlertType, string>; // SEIS entradas
  export function dedupeKeyDateReview(instanceId: string): string
  export const D7_WINDOW_DAYS = 7;
  export type D1Reason = "COST_UNKNOWN" | "OPEN_DIVERGENCE" | "CANCELLATION_INTENDED_NOT_REGISTERED" | "REVENUE_UNKNOWN";
  export type D1Input = { costCents: number | null; hasOpenDivergence: boolean; cancellationIntendedNotRegistered: boolean; revenueSource: string; customerRevenueCents: number | null };
  export function resolveD1Reasons(input: D1Input): D1Reason[]
  export function shouldEmitD7(daysUntilDue: number): boolean
  export function shouldEmitD1(daysUntilDue: number, reasons: D1Reason[]): boolean
  export function fnv1a32(input: string): string
  export function economicImbalanceHash(items: { instanceId: string; costCents: number | null }[], revenueCents: number | null): string
  export function dedupeKeyD7(cycleStart: string): string
  export function dedupeKeyD1(cycleStart: string, reasons: D1Reason[]): string
  export function dedupeKeyEndConfirmation(providerAccessUntil: string): string
  export function dedupeKeyCostUnknown(cycleStart: string): string
  export function dedupeKeyEconomicImbalance(monthBrt: string, hash: string): string
  ```

- [ ] **Step 1: Escrever o teste que falha**

`src/lib/whatsapp-instance-alerts-core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  EVENT_TYPE_BY_ALERT,
  resolveD1Reasons,
  shouldEmitD7,
  shouldEmitD1,
  economicImbalanceHash,
  dedupeKeyD1,
  dedupeKeyD7,
  type D1Input,
} from "../../supabase/functions/_shared/whatsapp-instance-alerts-core";

function d1(p: Partial<D1Input> = {}): D1Input {
  return {
    costCents: 10000,
    hasOpenDivergence: false,
    cancellationIntendedNotRegistered: false,
    revenueSource: "SUBSCRIPTION_SOLE_INSTANCE",
    customerRevenueCents: 14900,
    ...p,
  };
}

describe("EVENT_TYPE_BY_ALERT — o acoplamento por string com process-billing-notifications", () => {
  it("os seis event_type são exatamente os da spec §10.6", () => {
    expect(EVENT_TYPE_BY_ALERT).toEqual({
      CYCLE_DUE_SOON: "admin_zapi_cycle_due_soon",
      CYCLE_DUE_TOMORROW: "admin_zapi_cycle_due_tomorrow",
      END_CONFIRMATION_REQUIRED: "admin_zapi_end_confirmation_required",
      DIVERGENCE: "admin_zapi_instance_divergence",
      CYCLE_COST_UNKNOWN: "admin_zapi_cycle_cost_unknown",
      ECONOMIC_IMBALANCE: "admin_zapi_org_economic_imbalance",
    });
  });
});

describe("resolveD1Reasons — sem motivo, silêncio (spec §10.5)", () => {
  it("tudo em ordem: lista VAZIA — é o que torna o D-1 condicional", () => {
    expect(resolveD1Reasons(d1())).toEqual([]);
  });

  it("custo desconhecido é motivo", () => {
    expect(resolveD1Reasons(d1({ costCents: null }))).toEqual(["COST_UNKNOWN"]);
  });

  it("divergência aberta é motivo", () => {
    expect(resolveD1Reasons(d1({ hasOpenDivergence: true }))).toEqual(["OPEN_DIVERGENCE"]);
  });

  it("cancelamento pretendido e não registrado é motivo", () => {
    expect(resolveD1Reasons(d1({ cancellationIntendedNotRegistered: true }))).toEqual([
      "CANCELLATION_INTENDED_NOT_REGISTERED",
    ]);
  });

  it("receita NULL fora dos casos previstos é motivo", () => {
    expect(
      resolveD1Reasons(d1({ customerRevenueCents: null, revenueSource: "NO_ENTITLEMENT" })),
    ).toEqual(["REVENUE_UNKNOWN"]);
  });

  it("AMBIGUOUS_MULTI_INSTANCE é caso PREVISTO: receita NULL ali não é motivo", () => {
    expect(
      resolveD1Reasons(d1({ customerRevenueCents: null, revenueSource: "AMBIGUOUS_MULTI_INSTANCE" })),
    ).toEqual([]);
  });

  it("LIFETIME_OVERRIDE com receita 0 não é motivo", () => {
    expect(
      resolveD1Reasons(d1({ customerRevenueCents: 0, revenueSource: "LIFETIME_OVERRIDE" })),
    ).toEqual([]);
  });

  it("múltiplos motivos mantêm ORDEM DEFINIDA e não duplicam", () => {
    const r = resolveD1Reasons(
      d1({
        costCents: null,
        hasOpenDivergence: true,
        cancellationIntendedNotRegistered: true,
        customerRevenueCents: null,
        revenueSource: "NO_ENTITLEMENT",
      }),
    );
    expect(r).toEqual([
      "COST_UNKNOWN",
      "OPEN_DIVERGENCE",
      "CANCELLATION_INTENDED_NOT_REGISTERED",
      "REVENUE_UNKNOWN",
    ]);
    expect(new Set(r).size).toBe(r.length);
  });

  it("é determinístico: mesma entrada, mesma saída", () => {
    const input = d1({ costCents: null, hasOpenDivergence: true });
    expect(resolveD1Reasons(input)).toEqual(resolveD1Reasons(input));
  });
});

describe("janelas de emissão", () => {
  it("D-7 cobre a janela 1..7 — o worker que perder um dia ainda avisa", () => {
    expect(shouldEmitD7(8)).toBe(false);
    expect(shouldEmitD7(7)).toBe(true);
    expect(shouldEmitD7(3)).toBe(true);
    expect(shouldEmitD7(1)).toBe(true);
    expect(shouldEmitD7(0)).toBe(false);
  });

  it("D-1 só com motivo, na janela 0..1", () => {
    expect(shouldEmitD1(1, [])).toBe(false);
    expect(shouldEmitD1(1, ["COST_UNKNOWN"])).toBe(true);
    expect(shouldEmitD1(0, ["COST_UNKNOWN"])).toBe(true);
    expect(shouldEmitD1(2, ["COST_UNKNOWN"])).toBe(false);
  });
});

describe("dedupe", () => {
  it("D-7 deduplica por cycle_start: um por ciclo", () => {
    expect(dedupeKeyD7("2026-08-10")).toBe("cycle_d7:2026-08-10");
  });

  it("D-1 muda de chave só quando o CONJUNTO de motivos muda, não a ordem", () => {
    const a = dedupeKeyD1("2026-08-10", ["OPEN_DIVERGENCE", "COST_UNKNOWN"]);
    const b = dedupeKeyD1("2026-08-10", ["COST_UNKNOWN", "OPEN_DIVERGENCE"]);
    expect(a).toBe(b);
    expect(dedupeKeyD1("2026-08-10", ["COST_UNKNOWN"])).not.toBe(a);
  });
});

describe("economicImbalanceHash", () => {
  it("ordem diferente das MESMAS instâncias produz o MESMO hash", () => {
    const a = economicImbalanceHash(
      [{ instanceId: "i2", costCents: 12000 }, { instanceId: "i1", costCents: 10000 }],
      14900,
    );
    const b = economicImbalanceHash(
      [{ instanceId: "i1", costCents: 10000 }, { instanceId: "i2", costCents: 12000 }],
      14900,
    );
    expect(a).toBe(b);
  });

  it("mudança material de composição produz hash DIFERENTE", () => {
    const base = economicImbalanceHash([{ instanceId: "i1", costCents: 10000 }], 14900);
    expect(economicImbalanceHash([{ instanceId: "i1", costCents: 11000 }], 14900)).not.toBe(base);
    expect(economicImbalanceHash([{ instanceId: "i9", costCents: 10000 }], 14900)).not.toBe(base);
    expect(economicImbalanceHash([{ instanceId: "i1", costCents: 10000 }], 9900)).not.toBe(base);
  });

  it("custo desconhecido é distinto de zero no hash", () => {
    expect(economicImbalanceHash([{ instanceId: "i1", costCents: null }], 14900)).not.toBe(
      economicImbalanceHash([{ instanceId: "i1", costCents: 0 }], 14900),
    );
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/whatsapp-instance-alerts-core.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar o núcleo**

`supabase/functions/_shared/whatsapp-instance-alerts-core.ts`:

```ts
// Núcleo puro (Fase 6b): tipos de alerta, motivos do D-1 e chaves de dedupe.
// ZERO IMPORTS — `RevenueSource` é replicado como string para não importar
// whatsapp-instance-revenue-core.ts (nem `import type`, que também quebra o
// Vite quando o alvo tiver qualquer import futuro).

export type AlertType =
  | "CYCLE_DUE_SOON"
  | "CYCLE_DUE_TOMORROW"
  | "END_CONFIRMATION_REQUIRED"
  | "DIVERGENCE"
  | "CYCLE_COST_UNKNOWN"
  | "ECONOMIC_IMBALANCE"
  // Pendência de PAINEL, sem e-mail: nenhum aviso pode afirmar uma data que
  // ninguém confirmou (§6.2). Fora de EVENT_TYPE_BY_ALERT de propósito.
  | "DATE_REVIEW_REQUIRED";

export type NotifiableAlertType = Exclude<AlertType, "DATE_REVIEW_REQUIRED">;

/**
 * ACOPLAMENTO POR STRING com TEMPLATE_BY_EVENT de process-billing-notifications
 * (§10.6). Sem a entrada lá, a linha morre em `failed/unknown_event_type` e o
 * aviso some. Mexer aqui exige mexer lá NO MESMO COMMIT, com deploy conjunto.
 * SEIS entradas — `DATE_REVIEW_REQUIRED` fica fora, e o tipo garante isso.
 */
export const EVENT_TYPE_BY_ALERT: Record<NotifiableAlertType, string> = {
  CYCLE_DUE_SOON: "admin_zapi_cycle_due_soon",
  CYCLE_DUE_TOMORROW: "admin_zapi_cycle_due_tomorrow",
  END_CONFIRMATION_REQUIRED: "admin_zapi_end_confirmation_required",
  DIVERGENCE: "admin_zapi_instance_divergence",
  CYCLE_COST_UNKNOWN: "admin_zapi_cycle_cost_unknown",
  ECONOMIC_IMBALANCE: "admin_zapi_org_economic_imbalance",
};

export const D7_WINDOW_DAYS = 7;

export type D1Reason =
  | "COST_UNKNOWN"
  | "OPEN_DIVERGENCE"
  | "CANCELLATION_INTENDED_NOT_REGISTERED"
  | "REVENUE_UNKNOWN";

export type D1Input = {
  costCents: number | null;
  hasOpenDivergence: boolean;
  cancellationIntendedNotRegistered: boolean;
  revenueSource: string;
  customerRevenueCents: number | null;
};

// Receita NULL nestes dois casos é PREVISTA pela política de §7.3, não lacuna.
const REVENUE_NULL_EXPECTED = ["AMBIGUOUS_MULTI_INSTANCE", "LIFETIME_OVERRIDE"];

/** Ordem fixa: a chave de dedupe do D-1 depende do conjunto, não da ordem —
 *  mas a lista exibida ao admin precisa ser estável entre execuções. */
export function resolveD1Reasons(input: D1Input): D1Reason[] {
  const out: D1Reason[] = [];
  if (input.costCents === null || input.costCents === undefined) out.push("COST_UNKNOWN");
  if (input.hasOpenDivergence) out.push("OPEN_DIVERGENCE");
  if (input.cancellationIntendedNotRegistered) out.push("CANCELLATION_INTENDED_NOT_REGISTERED");
  if (
    (input.customerRevenueCents === null || input.customerRevenueCents === undefined) &&
    REVENUE_NULL_EXPECTED.indexOf(input.revenueSource) === -1
  ) {
    out.push("REVENUE_UNKNOWN");
  }
  return out;
}

/**
 * Janela 1..7 e não "exatamente 7": o worker é diário e `pg_net` é
 * fire-and-forget. Um dia perdido não pode apagar o único alerta que dá tempo
 * de cancelar antes da cobrança. A unicidade por ciclo vem do dedupe_key.
 */
export function shouldEmitD7(daysUntilDue: number): boolean {
  return daysUntilDue >= 1 && daysUntilDue <= D7_WINDOW_DAYS;
}

export function shouldEmitD1(daysUntilDue: number, reasons: D1Reason[]): boolean {
  return daysUntilDue >= 0 && daysUntilDue <= 1 && reasons.length > 0;
}

/** FNV-1a 32 bits em hex. Implementado aqui porque núcleo puro não importa. */
export function fnv1a32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Hash da COMPOSIÇÃO econômica da organização. Ordenado por instanceId para
 * ser independente da ordem que o banco devolveu; custo desconhecido escreve
 * "null" e não "0", porque desconhecido não é zero.
 */
export function economicImbalanceHash(
  items: { instanceId: string; costCents: number | null }[],
  revenueCents: number | null,
): string {
  const sorted = items
    .map((i) => `${i.instanceId}:${i.costCents === null || i.costCents === undefined ? "null" : i.costCents}`)
    .sort();
  return fnv1a32(`${sorted.join("|")}#${revenueCents === null || revenueCents === undefined ? "null" : revenueCents}`);
}

export function dedupeKeyD7(cycleStart: string): string {
  return `cycle_d7:${cycleStart}`;
}

export function dedupeKeyD1(cycleStart: string, reasons: D1Reason[]): string {
  return `cycle_d1:${cycleStart}:${reasons.slice().sort().join(",")}`;
}

export function dedupeKeyEndConfirmation(providerAccessUntil: string): string {
  return `end_confirmation_required:${providerAccessUntil}`;
}

export function dedupeKeyCostUnknown(cycleStart: string): string {
  return `cycle_cost_unknown:${cycleStart}`;
}

/** Uma pendência de data por instância — ela não se repete por ciclo, porque
 *  enquanto a data não for confirmada não existe ciclo. */
export function dedupeKeyDateReview(instanceId: string): string {
  return `date_review_required:${instanceId}`;
}

export function dedupeKeyEconomicImbalance(monthBrt: string, hash: string): string {
  return `economic_imbalance:${monthBrt}:${hash}`;
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/lib/whatsapp-instance-alerts-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck e commit**

```bash
npm run typecheck
git add supabase/functions/_shared/whatsapp-instance-alerts-core.ts src/lib/whatsapp-instance-alerts-core.test.ts
git commit -m "feat(6b): alertas, motivos do D-1 e chaves de dedupe"
```

---

## Task 5: Divergências (`whatsapp-instance-divergence-core.ts`)

**Files:**
- Create: `supabase/functions/_shared/whatsapp-instance-divergence-core.ts`
- Test: `src/lib/whatsapp-instance-divergence-core.test.ts`

**Interfaces:**
- Consumes: `daysUntil` de `whatsapp-instance-cycle-core.ts` — **não importado**; a idade em dias entra pronta por parâmetro (`channelStateAgeDays`), calculada pelo caller.
- Produces:
  ```ts
  export const LIFECYCLE_CHANNEL_DIVERGENCE_DAYS = 7;
  export type DivergenceKind = "CHANNEL_WITHOUT_INSTANCE" | "PAYING_WITHOUT_CHANNEL" | "INSTANCE_REF_MISMATCH" | "LIFECYCLE_VS_CHANNEL_STATE" | "ALIVE_AFTER_END";
  export type DivergenceFinding = { kind: DivergenceKind; organizationId: string; instanceId: string | null; channelId: string | null; dedupeKey: string; detail: string };
  export type ChannelRow = { channelId: string; organizationId: string; isEligibleInventoryChannel: boolean; hasLinkedInstance: boolean; monthBrt: string };
  export type InstanceRow = { instanceId: string; organizationId: string; lifecycleState: string; channelId: string | null; providerInstanceRef: string | null; legacyChannelInstanceRef: string | null; channelState: string | null; channelStateAgeDays: number | null; hasAdminExplanation: boolean; endedAtIso: string | null; lastLocalSignalAtIso: string | null };
  export function detectChannelWithoutInstance(row: ChannelRow): DivergenceFinding | null
  export function detectInstanceDivergences(row: InstanceRow): DivergenceFinding[]
  ```

- [ ] **Step 1: Escrever o teste que falha**

`src/lib/whatsapp-instance-divergence-core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  LIFECYCLE_CHANNEL_DIVERGENCE_DAYS,
  detectChannelWithoutInstance,
  detectInstanceDivergences,
  type ChannelRow,
  type InstanceRow,
} from "../../supabase/functions/_shared/whatsapp-instance-divergence-core";

function channel(p: Partial<ChannelRow> = {}): ChannelRow {
  return {
    channelId: "ch1",
    organizationId: "org1",
    isEligibleInventoryChannel: true,
    hasLinkedInstance: false,
    monthBrt: "2026-08",
    ...p,
  };
}

function instance(p: Partial<InstanceRow> = {}): InstanceRow {
  return {
    instanceId: "in1",
    organizationId: "org1",
    lifecycleState: "ACTIVE",
    channelId: "ch1",
    providerInstanceRef: "REF1",
    legacyChannelInstanceRef: "REF1",
    channelState: "connected",
    channelStateAgeDays: 0,
    hasAdminExplanation: false,
    endedAtIso: null,
    lastLocalSignalAtIso: null,
    ...p,
  };
}

describe("o limiar é constante única e documentada", () => {
  it("sete dias", () => {
    expect(LIFECYCLE_CHANNEL_DIVERGENCE_DAYS).toBe(7);
  });
});

describe("CHANNEL_WITHOUT_INSTANCE — custo invisível (spec §10.7)", () => {
  it("canal elegível sem instância correspondente GERA", () => {
    const f = detectChannelWithoutInstance(channel());
    expect(f?.kind).toBe("CHANNEL_WITHOUT_INSTANCE");
    expect(f?.instanceId).toBeNull();
    expect(f?.channelId).toBe("ch1");
    expect(f?.dedupeKey).toBe("channel_without_instance:ch1:2026-08");
  });

  it("canal já associado NÃO gera", () => {
    expect(detectChannelWithoutInstance(channel({ hasLinkedInstance: true }))).toBeNull();
  });

  it("canal desativado ou fora de escopo NÃO gera", () => {
    expect(detectChannelWithoutInstance(channel({ isEligibleInventoryChannel: false }))).toBeNull();
  });
});

describe("PAYING_WITHOUT_CHANNEL", () => {
  it("instância ACTIVE sem channel_id GERA", () => {
    const f = detectInstanceDivergences(instance({ channelId: null, legacyChannelInstanceRef: null, channelState: null, channelStateAgeDays: null }));
    expect(f.map((x) => x.kind)).toContain("PAYING_WITHOUT_CHANNEL");
  });

  it("AWAITING_PROVISION NÃO é tratada da mesma forma — ainda não existe canal por definição", () => {
    const f = detectInstanceDivergences(
      instance({ lifecycleState: "AWAITING_PROVISION", channelId: null, legacyChannelInstanceRef: null, channelState: null, channelStateAgeDays: null }),
    );
    expect(f.map((x) => x.kind)).not.toContain("PAYING_WITHOUT_CHANNEL");
  });

  it("ENDED NÃO gera este tipo", () => {
    const f = detectInstanceDivergences(
      instance({ lifecycleState: "ENDED", channelId: null, legacyChannelInstanceRef: null, channelState: null, channelStateAgeDays: null, endedAtIso: "2026-07-01T12:00:00Z" }),
    );
    expect(f.map((x) => x.kind)).not.toContain("PAYING_WITHOUT_CHANNEL");
  });
});

describe("INSTANCE_REF_MISMATCH — nunca corrige sozinho (§3.3)", () => {
  it("referências diferentes GERAM", () => {
    const f = detectInstanceDivergences(instance({ legacyChannelInstanceRef: "OUTRO" }));
    expect(f.map((x) => x.kind)).toContain("INSTANCE_REF_MISMATCH");
  });

  it("referências iguais NÃO geram", () => {
    expect(detectInstanceDivergences(instance()).map((x) => x.kind)).not.toContain("INSTANCE_REF_MISMATCH");
  });

  it("valor ausente NÃO vira mismatch automaticamente", () => {
    expect(
      detectInstanceDivergences(instance({ legacyChannelInstanceRef: null })).map((x) => x.kind),
    ).not.toContain("INSTANCE_REF_MISMATCH");
    expect(
      detectInstanceDivergences(instance({ providerInstanceRef: null })).map((x) => x.kind),
    ).not.toContain("INSTANCE_REF_MISMATCH");
  });
});

describe("LIFECYCLE_VS_CHANNEL_STATE — as cinco condições", () => {
  it("desconectado há MENOS de sete dias NÃO gera", () => {
    const f = detectInstanceDivergences(instance({ channelState: "disconnected", channelStateAgeDays: 6 }));
    expect(f.map((x) => x.kind)).not.toContain("LIFECYCLE_VS_CHANNEL_STATE");
  });

  it("sete dias COMPLETOS gera — limite exato", () => {
    const f = detectInstanceDivergences(instance({ channelState: "disconnected", channelStateAgeDays: 7 }));
    expect(f.map((x) => x.kind)).toContain("LIFECYCLE_VS_CHANNEL_STATE");
  });

  it("status desconhecido ou nunca sincronizado NÃO gera, nem com idade alta", () => {
    const f = detectInstanceDivergences(instance({ channelState: null, channelStateAgeDays: 90 }));
    expect(f.map((x) => x.kind)).not.toContain("LIFECYCLE_VS_CHANNEL_STATE");
  });

  it("connected RESOLVE", () => {
    const f = detectInstanceDivergences(instance({ channelState: "connected", channelStateAgeDays: 90 }));
    expect(f.map((x) => x.kind)).not.toContain("LIFECYCLE_VS_CHANNEL_STATE");
  });

  it("explicação administrativa registrada suprime", () => {
    const f = detectInstanceDivergences(
      instance({ channelState: "disconnected", channelStateAgeDays: 30, hasAdminExplanation: true }),
    );
    expect(f.map((x) => x.kind)).not.toContain("LIFECYCLE_VS_CHANNEL_STATE");
  });

  it("instância não-ACTIVE não gera", () => {
    const f = detectInstanceDivergences(
      instance({ lifecycleState: "CANCELLATION_REQUESTED", channelState: "disconnected", channelStateAgeDays: 30 }),
    );
    expect(f.map((x) => x.kind)).not.toContain("LIFECYCLE_VS_CHANNEL_STATE");
  });
});

describe("ALIVE_AFTER_END — evidência local, nunca afirmação sobre cobrança", () => {
  it("ENDED com sinal POSTERIOR gera", () => {
    const f = detectInstanceDivergences(
      instance({
        lifecycleState: "ENDED",
        endedAtIso: "2026-07-01T12:00:00Z",
        lastLocalSignalAtIso: "2026-07-05T09:00:00Z",
      }),
    );
    expect(f.map((x) => x.kind)).toContain("ALIVE_AFTER_END");
  });

  it("ENDED sem sinal posterior NÃO gera", () => {
    const f = detectInstanceDivergences(
      instance({ lifecycleState: "ENDED", endedAtIso: "2026-07-01T12:00:00Z", lastLocalSignalAtIso: null }),
    );
    expect(f.map((x) => x.kind)).not.toContain("ALIVE_AFTER_END");
  });

  it("sinal ANTERIOR a ended_at NÃO gera", () => {
    const f = detectInstanceDivergences(
      instance({
        lifecycleState: "ENDED",
        endedAtIso: "2026-07-01T12:00:00Z",
        lastLocalSignalAtIso: "2026-06-20T09:00:00Z",
      }),
    );
    expect(f.map((x) => x.kind)).not.toContain("ALIVE_AFTER_END");
  });

  it("o texto NUNCA afirma que a Z-API continua cobrando", () => {
    const f = detectInstanceDivergences(
      instance({
        lifecycleState: "ENDED",
        endedAtIso: "2026-07-01T12:00:00Z",
        lastLocalSignalAtIso: "2026-07-05T09:00:00Z",
      }),
    );
    const alive = f.find((x) => x.kind === "ALIVE_AFTER_END");
    expect(alive?.detail).toBe(
      "Há sinais posteriores ao encerramento registrado. Verifique o estado real no provider.",
    );
    expect(alive?.detail).not.toMatch(/cobran|cobrando|pagando/i);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/whatsapp-instance-divergence-core.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar o núcleo**

`supabase/functions/_shared/whatsapp-instance-divergence-core.ts`:

```ts
// Núcleo puro (Fase 6b): os CINCO tipos canônicos de divergência. ZERO IMPORTS.
//
// Nenhuma divergência gera ação automática: não altera lifecycle_state, não
// cancela instância, não bloqueia envio, e NENHUMA afirma que a Z-API continua
// cobrando. Todas pedem revisão e todas geram linha no ledger.
//
// SILENT_CHANNEL não existe e não deve ser criado: mede USO, não consistência
// entre inventário, lifecycle e estado operacional.

/**
 * Parâmetro operacional INICIAL, não verdade comercial. Constante única e
 * documentada — nunca repetir o número solto em outro arquivo, e sem
 * platform_flag própria nesta fase. Revisão futura exige spec com evidência.
 */
export const LIFECYCLE_CHANNEL_DIVERGENCE_DAYS = 7;

export type DivergenceKind =
  | "CHANNEL_WITHOUT_INSTANCE"
  | "PAYING_WITHOUT_CHANNEL"
  | "INSTANCE_REF_MISMATCH"
  | "LIFECYCLE_VS_CHANNEL_STATE"
  | "ALIVE_AFTER_END";

export type DivergenceFinding = {
  kind: DivergenceKind;
  organizationId: string;
  instanceId: string | null;
  channelId: string | null;
  dedupeKey: string;
  detail: string;
};

export type ChannelRow = {
  channelId: string;
  organizationId: string;
  /** Já resolvido pelo caller: canal real de inventário, não registro técnico
   *  incompleto, canal de teste descartado, canal desativado nem registro não
   *  faturável. Na dúvida o caller passa `false` e abre revisão administrativa
   *  por outro caminho — nunca cria inventário automaticamente. */
  isEligibleInventoryChannel: boolean;
  hasLinkedInstance: boolean;
  /** "YYYY-MM" em BRT. */
  monthBrt: string;
};

export type InstanceRow = {
  instanceId: string;
  organizationId: string;
  lifecycleState: string;
  channelId: string | null;
  providerInstanceRef: string | null;
  legacyChannelInstanceRef: string | null;
  /** Último estado CONHECIDO do canal. `null` = ausente ou nunca sincronizado. */
  channelState: string | null;
  /** Idade em dias do último estado conhecido, calculada pelo caller em BRT. */
  channelStateAgeDays: number | null;
  hasAdminExplanation: boolean;
  endedAtIso: string | null;
  lastLocalSignalAtIso: string | null;
};

export function detectChannelWithoutInstance(row: ChannelRow): DivergenceFinding | null {
  if (!row.isEligibleInventoryChannel) return null;
  if (row.hasLinkedInstance) return null;
  return {
    kind: "CHANNEL_WITHOUT_INSTANCE",
    organizationId: row.organizationId,
    // Sujeito é a ORGANIZAÇÃO: não existe instância para apontar, e eleger uma
    // fictícia seria falso.
    instanceId: null,
    channelId: row.channelId,
    dedupeKey: `channel_without_instance:${row.channelId}:${row.monthBrt}`,
    detail:
      "Existe um canal operacional sem registro correspondente no inventário de instâncias. Revise e faça o backfill manual se ele for faturável.",
  };
}

export function detectInstanceDivergences(row: InstanceRow): DivergenceFinding[] {
  const out: DivergenceFinding[] = [];

  if (row.lifecycleState === "ACTIVE" && !row.channelId) {
    out.push({
      kind: "PAYING_WITHOUT_CHANNEL",
      organizationId: row.organizationId,
      instanceId: row.instanceId,
      channelId: null,
      dedupeKey: `paying_without_channel:${row.instanceId}`,
      detail: "Instância ativa no inventário sem canal associado. Verifique se há custo sem uso.",
    });
  }

  if (
    row.providerInstanceRef &&
    row.legacyChannelInstanceRef &&
    row.providerInstanceRef !== row.legacyChannelInstanceRef
  ) {
    // NUNCA escolher automaticamente nem sobrescrever: a decisão é da 6a.
    out.push({
      kind: "INSTANCE_REF_MISMATCH",
      organizationId: row.organizationId,
      instanceId: row.instanceId,
      channelId: row.channelId,
      dedupeKey: `instance_ref_mismatch:${row.instanceId}`,
      detail:
        "O identificador da instância no inventário diverge do usado pelo canal. Nenhuma correção automática foi feita — revise qual é o correto.",
    });
  }

  if (
    row.lifecycleState === "ACTIVE" &&
    row.channelId &&
    row.channelState !== null &&
    row.channelState !== undefined &&
    row.channelState !== "connected" &&
    !row.hasAdminExplanation &&
    row.channelStateAgeDays !== null &&
    row.channelStateAgeDays !== undefined &&
    row.channelStateAgeDays >= LIFECYCLE_CHANNEL_DIVERGENCE_DAYS
  ) {
    out.push({
      kind: "LIFECYCLE_VS_CHANNEL_STATE",
      organizationId: row.organizationId,
      instanceId: row.instanceId,
      channelId: row.channelId,
      dedupeKey: `lifecycle_vs_channel_state:${row.instanceId}`,
      detail: `O canal está fora de "conectado" há ${row.channelStateAgeDays} dias com a instância ativa. Verifique se o cliente perdeu o WhatsApp.`,
    });
  }

  if (
    row.lifecycleState === "ENDED" &&
    row.endedAtIso &&
    row.lastLocalSignalAtIso &&
    row.lastLocalSignalAtIso > row.endedAtIso
  ) {
    out.push({
      kind: "ALIVE_AFTER_END",
      organizationId: row.organizationId,
      instanceId: row.instanceId,
      channelId: row.channelId,
      dedupeKey: `alive_after_end:${row.instanceId}:${row.endedAtIso}`,
      // Texto FIXO e verificado em teste: dizer "a Z-API continua cobrando"
      // seria afirmar sobre o fornecedor a partir de evidência local.
      detail: "Há sinais posteriores ao encerramento registrado. Verifique o estado real no provider.",
    });
  }

  return out;
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/lib/whatsapp-instance-divergence-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck e commit**

```bash
npm run typecheck
git add supabase/functions/_shared/whatsapp-instance-divergence-core.ts src/lib/whatsapp-instance-divergence-core.test.ts
git commit -m "feat(6b): os cinco tipos canonicos de divergencia"
```

---

## Task 6: Simulador do Partner (`whatsapp-partner-simulator-core.ts`)

**Files:**
- Create: `supabase/functions/_shared/whatsapp-partner-simulator-core.ts`
- Test: `src/lib/whatsapp-partner-simulator-core.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  ```ts
  export type PartnerSimulationInput = { instanceCosts: (number | null)[]; partnerMonthlyTargetCents: number };
  export type PartnerSimulationOk = { ok: true; simulated: true; instancesWithKnownCost: number; instancesWithUnknownCost: number; currentKnownCostCents: number; partnerMonthlyTargetCents: number; savingsCents: number; breakEvenInstances: number | null };
  export type PartnerSimulationResult = PartnerSimulationOk | { ok: false; code: string; message: string };
  export function simulatePartner(input: PartnerSimulationInput): PartnerSimulationResult
  ```

- [ ] **Step 1: Escrever o teste que falha**

`src/lib/whatsapp-partner-simulator-core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { simulatePartner } from "../../supabase/functions/_shared/whatsapp-partner-simulator-core";

describe("simulatePartner (spec §10.10)", () => {
  it("preço-alvo é OBRIGATÓRIO — não existe preço de Partner no código", () => {
    const r = simulatePartner({ instanceCosts: [10000], partnerMonthlyTargetCents: undefined as unknown as number });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.code).toBe("PARTNER_TARGET_REQUIRED");
  });

  it("preço-alvo zero é recusado", () => {
    expect(simulatePartner({ instanceCosts: [10000], partnerMonthlyTargetCents: 0 }).ok).toBe(false);
  });

  it("preço-alvo negativo é recusado", () => {
    expect(simulatePartner({ instanceCosts: [10000], partnerMonthlyTargetCents: -1 }).ok).toBe(false);
  });

  it("usa APENAS custo real registrado e rotula como simulação", () => {
    const r = simulatePartner({ instanceCosts: [10000, 10000, 10000], partnerMonthlyTargetCents: 25000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.simulated).toBe(true);
      expect(r.currentKnownCostCents).toBe(30000);
      expect(r.instancesWithKnownCost).toBe(3);
      expect(r.instancesWithUnknownCost).toBe(0);
      expect(r.savingsCents).toBe(5000);
    }
  });

  it("custo desconhecido é contado à parte e NÃO entra na soma como zero", () => {
    const r = simulatePartner({ instanceCosts: [10000, null], partnerMonthlyTargetCents: 25000 });
    if (r.ok) {
      expect(r.currentKnownCostCents).toBe(10000);
      expect(r.instancesWithUnknownCost).toBe(1);
    }
  });

  it("ponto de equilíbrio: quantas instâncias ao custo médio conhecido igualam o alvo", () => {
    const r = simulatePartner({ instanceCosts: [10000, 10000], partnerMonthlyTargetCents: 100000 });
    if (r.ok) expect(r.breakEvenInstances).toBe(10);
  });

  it("sem custo conhecido não há ponto de equilíbrio inventado", () => {
    const r = simulatePartner({ instanceCosts: [null, null], partnerMonthlyTargetCents: 100000 });
    if (r.ok) {
      expect(r.breakEvenInstances).toBeNull();
      expect(r.currentKnownCostCents).toBe(0);
    }
  });

  it("economia negativa aparece como negativa — o Partner pode não compensar", () => {
    const r = simulatePartner({ instanceCosts: [10000], partnerMonthlyTargetCents: 25000 });
    if (r.ok) expect(r.savingsCents).toBe(-15000);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/whatsapp-partner-simulator-core.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar o núcleo**

`supabase/functions/_shared/whatsapp-partner-simulator-core.ts`:

```ts
// Núcleo puro (Fase 6b): simulação do Plano Partner. ZERO IMPORTS.
//
// NUNCA constante de preço de Partner no código: a Z-API não publicou preço
// para nós, e um número inventado viraria base de decisão comercial. O alvo é
// informado pelo administrador no momento da simulação. Não persiste nada.

export type PartnerSimulationInput = {
  instanceCosts: (number | null)[];
  partnerMonthlyTargetCents: number;
};

export type PartnerSimulationOk = {
  ok: true;
  simulated: true;
  instancesWithKnownCost: number;
  instancesWithUnknownCost: number;
  currentKnownCostCents: number;
  partnerMonthlyTargetCents: number;
  /** Positivo = o Partner economiza. Negativo = não compensa hoje. */
  savingsCents: number;
  breakEvenInstances: number | null;
};

export type PartnerSimulationResult =
  | PartnerSimulationOk
  | { ok: false; code: string; message: string };

export function simulatePartner(input: PartnerSimulationInput): PartnerSimulationResult {
  const target = input.partnerMonthlyTargetCents;
  if (typeof target !== "number" || !isFinite(target) || target <= 0) {
    return {
      ok: false,
      code: "PARTNER_TARGET_REQUIRED",
      message: "Informe o preço-alvo mensal do Plano Partner para simular. O sistema não tem esse preço.",
    };
  }

  let currentKnownCostCents = 0;
  let instancesWithKnownCost = 0;
  let instancesWithUnknownCost = 0;
  for (const c of input.instanceCosts || []) {
    if (c === null || c === undefined) instancesWithUnknownCost++;
    else {
      currentKnownCostCents += c;
      instancesWithKnownCost++;
    }
  }

  // Média só existe se houver custo conhecido — senão o ponto de equilíbrio
  // seria uma divisão por zero disfarçada de resposta.
  const breakEvenInstances =
    instancesWithKnownCost > 0
      ? Math.ceil(target / (currentKnownCostCents / instancesWithKnownCost))
      : null;

  return {
    ok: true,
    simulated: true,
    instancesWithKnownCost,
    instancesWithUnknownCost,
    currentKnownCostCents,
    partnerMonthlyTargetCents: target,
    savingsCents: currentKnownCostCents - target,
    breakEvenInstances,
  };
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/lib/whatsapp-partner-simulator-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Rodar a suíte inteira e commitar**

```bash
npx vitest run
npm run typecheck
git add supabase/functions/_shared/whatsapp-partner-simulator-core.ts src/lib/whatsapp-partner-simulator-core.test.ts
git commit -m "feat(6b): simulador do Plano Partner, sem preco inventado"
```

---

## Task 7: Migration 087 — `whatsapp_instances`

**Files:**
- Create: `supabase/migrations/20260801200000_087_whatsapp_instances.sql`

**Interfaces:**
- Consumes: `organizations`, `units`, `whatsapp_channels`, `auth.users`, `public.audit_trigger_func()`, `public.set_updated_at()`, `public.is_platform_admin(uuid)`.
- Produces: tabela `whatsapp_instances` e função `public.whatsapp_instance_tenant_guard()` (trigger).

- [ ] **Step 1: Escrever a migration**

`supabase/migrations/20260801200000_087_whatsapp_instances.sql`:

```sql
-- Inventário de CUSTO da plataforma com a Z-API (Fase 6b). Uma linha por
-- instância que a plataforma paga (ou pagará).
--
-- ZERO SEGREDO: nenhuma coluna de token, senha, API key ou client token. O
-- `provider_instance_ref` é IDENTIFICADOR, não credencial — ele sozinho não
-- envia mensagem, porque o token (a outra metade da URL) fica só no canal.
--
-- `lifecycle_state` NÃO É FONTE DE AUTORIZAÇÃO. Quem decide direito de envio é
-- o gate de sete estados da 5b (_shared/whatsapp-service-state-core.ts).
-- Cancelar no painel da Z-API interrompe o CUSTO DA PLATAFORMA, não o SERVIÇO
-- DO CLIENTE — duas ações, dois relógios, duas consequências.
--
-- RLS: ENABLE + FORCE, policy só de platform_admin, como whatsapp_implementations
-- (071). O lojista NÃO lê esta tabela: ela contém o que a plataforma paga.

begin;

create table if not exists whatsapp_instances (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null references organizations(id) on delete restrict,
  -- Nulo APENAS em backfill incompleto ou revisão administrativa, com motivo
  -- explícito; o painel destaca a pendência.
  unit_id uuid references units(id) on delete set null,
  channel_id uuid references whatsapp_channels(id) on delete set null,

  provider text not null check (provider in ('zapi', 'waha', 'official')),
  provider_instance_ref text,

  lifecycle_state text not null
    check (lifecycle_state in ('AWAITING_PROVISION', 'ACTIVE', 'CANCELLATION_REQUESTED', 'ENDED')),

  provider_cycle_anchor_day smallint
    check (provider_cycle_anchor_day is null
           or (provider_cycle_anchor_day >= 1 and provider_cycle_anchor_day <= 31)),

  -- PROJEÇÃO do ciclo OPEN. A fonte histórica é whatsapp_instance_cycles.
  current_cycle_started_on date,
  current_cycle_due_on date,
  cycle_source text not null default 'UNKNOWN'
    check (cycle_source in ('ADMIN_CONFIRMED', 'SYSTEM_ROLLED', 'UNKNOWN')),

  -- NULL = desconhecido. NUNCA zero: zero é um fato ("não custa nada"), e
  -- gravá-lo no lugar de "não sei" produz margem falsa.
  current_monthly_cost_cents integer
    check (current_monthly_cost_cents is null or current_monthly_cost_cents >= 0),
  cost_source text,
  cost_updated_at timestamptz,
  cost_updated_by uuid references auth.users(id),
  cost_note text,

  cancellation_requested_at timestamptz,
  cancellation_requested_by uuid references auth.users(id),
  cancellation_reason text,
  -- EXCLUSIVO, igual em natureza a provider_due_on: é o primeiro dia NÃO
  -- coberto. O último dia de acesso real é provider_access_until - 1.
  provider_access_until date,

  end_confirmation_required_at timestamptz,
  ended_at timestamptz,
  ended_by uuid references auth.users(id),
  end_confirmation_note text,

  planned_provision_on date,

  last_synced_at timestamptz,
  last_seen_provider_status text,
  last_divergence_kind text,
  last_divergence_at timestamptz,

  notes text,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Cancelamento é congelado no ato: sem a data-limite o custo não tem fim
  -- registrado e a rolagem não sabe onde parar.
  constraint whatsapp_instances_cancel_needs_until_chk check (
    lifecycle_state <> 'CANCELLATION_REQUESTED'
    or (provider_access_until is not null and cancellation_requested_at is not null)
  ),

  -- ENDED é confirmação humana, não dedução: exige quem confirmou e quando.
  constraint whatsapp_instances_ended_needs_confirmation_chk check (
    lifecycle_state <> 'ENDED' or ended_at is not null
  ),

  -- Custo informado exige procedência. Número sem origem vira folclore.
  constraint whatsapp_instances_cost_needs_source_chk check (
    current_monthly_cost_cents is null
    or (cost_source is not null and cost_updated_at is not null)
  ),

  -- Projeção coerente: ou as duas datas existem, ou nenhuma.
  constraint whatsapp_instances_cycle_pair_chk check (
    (current_cycle_started_on is null) = (current_cycle_due_on is null)
  ),
  constraint whatsapp_instances_cycle_order_chk check (
    current_cycle_due_on is null or current_cycle_due_on > current_cycle_started_on
  ),

  -- UNKNOWN não pode carregar projeção: seria data inventada com aparência de
  -- fato confirmado, e é exatamente o que §6.2 proíbe.
  constraint whatsapp_instances_unknown_has_no_cycle_chk check (
    cycle_source <> 'UNKNOWN' or current_cycle_due_on is null
  )
);

comment on table whatsapp_instances is
  'Inventario de CUSTO da plataforma por instancia do fornecedor (Fase 6b). ZERO credencial. lifecycle_state NAO autoriza envio — isso e o gate da 5b. FORCE RLS, so platform_admin.';

comment on column whatsapp_instances.provider_instance_ref is
  'Identificador da instancia no painel do fornecedor. NAO e credencial: sozinho nao autentica. Nunca gravar URL completa (ela contem o token).';

comment on column whatsapp_instances.provider_access_until is
  'EXCLUSIVO: primeiro dia NAO coberto. Ultimo dia de acesso real = provider_access_until - 1.';

-- A mesma instância física do fornecedor não pertence a duas organizações nem
-- a duas linhas internas.
create unique index if not exists whatsapp_instances_provider_ref_idx
  on whatsapp_instances (provider, provider_instance_ref)
  where provider_instance_ref is not null;

-- Um canal não aponta para duas instâncias de custo ao mesmo tempo. Troca
-- histórica preserva a linha antiga com channel_id = NULL ao encerrar.
create unique index if not exists whatsapp_instances_channel_idx
  on whatsapp_instances (channel_id)
  where channel_id is not null;

-- SEM unicidade por organization_id: N instâncias por organização é permitido
-- (§5) e o sistema precisa conseguir REVELAR o caso, não impedi-lo.
create index if not exists whatsapp_instances_org_idx
  on whatsapp_instances (organization_id, lifecycle_state);

create index if not exists whatsapp_instances_due_idx
  on whatsapp_instances (current_cycle_due_on)
  where lifecycle_state in ('ACTIVE', 'CANCELLATION_REQUESTED');

-- =====================================================================
-- Integridade cross-tenant — FK isolada NÃO garante
-- =====================================================================
-- Três FKs para três tabelas não impedem unir a unidade de uma organização com
-- o canal de outra. Sem esta trigger, uma linha coerente com todas as FKs
-- ainda pode misturar tenants. NÃO confiar em validação de frontend.
create or replace function public.whatsapp_instance_tenant_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit_org uuid;
  v_chan_org uuid;
  v_chan_unit uuid;
begin
  if new.unit_id is not null then
    select organization_id into v_unit_org from units where id = new.unit_id;
    if v_unit_org is null or v_unit_org <> new.organization_id then
      raise exception 'unit_id pertence a outra organizacao'
        using errcode = 'check_violation';
    end if;
  end if;

  if new.channel_id is not null then
    select u.organization_id, c.unit_id into v_chan_org, v_chan_unit
    from whatsapp_channels c
    join units u on u.id = c.unit_id
    where c.id = new.channel_id;

    if v_chan_org is null or v_chan_org <> new.organization_id then
      raise exception 'channel_id pertence a outra organizacao'
        using errcode = 'check_violation';
    end if;

    if new.unit_id is not null and v_chan_unit is not null and v_chan_unit <> new.unit_id then
      raise exception 'channel_id pertence a outra unidade'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

-- CREATE FUNCTION concede EXECUTE a PUBLIC por padrão e o schema public é
-- exposto ao PostgREST com a anon key. Revogar PUBLIC E os grants diretos
-- (lição do hotfix de ACL, migration 085).
revoke all on function public.whatsapp_instance_tenant_guard() from public, anon, authenticated;

drop trigger if exists whatsapp_instances_tenant_guard on whatsapp_instances;
create trigger whatsapp_instances_tenant_guard
  before insert or update of organization_id, unit_id, channel_id on whatsapp_instances
  for each row execute function public.whatsapp_instance_tenant_guard();

-- =====================================================================
-- RLS
-- =====================================================================
alter table whatsapp_instances enable row level security;
alter table whatsapp_instances force row level security;

drop policy if exists platform_admin_all_whatsapp_instances on whatsapp_instances;
create policy platform_admin_all_whatsapp_instances
  on whatsapp_instances for all
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

drop trigger if exists whatsapp_instances_updated_at on whatsapp_instances;
create trigger whatsapp_instances_updated_at
  before update on whatsapp_instances
  for each row execute function public.set_updated_at();

drop trigger if exists whatsapp_instances_audit on whatsapp_instances;
create trigger whatsapp_instances_audit
  after insert or update or delete on whatsapp_instances
  for each row execute function public.audit_trigger_func();

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. RLS ligada e forçada (esperado: t, t):
--   select relrowsecurity, relforcerowsecurity from pg_class
--    where relname = 'whatsapp_instances';
--
-- 2. Nenhuma coluna com cara de segredo (esperado: 0 linhas):
--   select column_name from information_schema.columns
--    where table_name = 'whatsapp_instances'
--      and column_name ~* 'token|secret|password|senha|api_key|credential';
--
-- 3. ACL da função de guarda (esperado: sem anon/authenticated):
--   select proacl from pg_proc where proname = 'whatsapp_instance_tenant_guard';
--
-- =====================================================================
-- Rollback
-- =====================================================================
--   drop table if exists whatsapp_instances;
--   drop function if exists public.whatsapp_instance_tenant_guard();
```

- [ ] **Step 2: Conferir os helpers antes de aplicar**

O SQL acima assume três funções existentes. **Confirme os nomes reais no repositório antes do push** — se algum divergir, ajuste a migration, não invente:

```bash
grep -rn "function public.set_updated_at\|function set_updated_at" supabase/migrations/ | head -3
grep -rn "function public.audit_trigger_func\|function audit_trigger_func" supabase/migrations/ | head -3
grep -rn "function public.is_platform_admin\|function is_platform_admin" supabase/migrations/ | head -3
```

Esperado: as três existem. Se `set_updated_at` tiver outro nome no projeto, use o nome real.

- [ ] **Step 3: Rodar o gate de migration (`migration-validator`)**

Dispare o agente `saas-shield-br:migration-validator` sobre o arquivo criado. *Finding* alto ou crítico é **NO-GO** — corrija antes de seguir.

- [ ] **Step 4: Aplicar**

```bash
supabase db push
```
Expected: a migration aplica sem erro. Rode as três consultas de validação do rodapé e confirme `t, t`, zero colunas com cara de segredo, e ACL sem `anon`/`authenticated`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260801200000_087_whatsapp_instances.sql
git commit -m "feat(6b): tabela whatsapp_instances com guarda cross-tenant e FORCE RLS"
```

---

## Task 8: Migration 088 — `whatsapp_instance_cycles`

**Files:**
- Create: `supabase/migrations/20260801200100_088_whatsapp_instance_cycles.sql`

**Interfaces:**
- Consumes: `whatsapp_instances`, `organizations`, `billing_subscriptions`, `auth.users`.
- Produces: tabela `whatsapp_instance_cycles`.

- [ ] **Step 1: Escrever a migration**

`supabase/migrations/20260801200100_088_whatsapp_instance_cycles.sql`:

```sql
-- Histórico IMUTÁVEL de ciclos do fornecedor (Fase 6b).
--
-- O ciclo cobre [cycle_start, provider_due_on) — início INCLUSIVO, fim
-- EXCLUSIVO. NÃO existe coluna `cycle_end`: o nome admitia duas leituras
-- ("último dia pago" vs "dia da próxima cobrança") e a diferença de um dia é
-- justamente a que erra o D-7.
--
-- PENDING_REVIEW é POSTERIOR a OPEN, nunca concorrente: designa ciclo que
-- terminou mas não fechou financeiramente (custo ausente). Por isso não
-- conflita com a unicidade de OPEN e o ciclo seguinte abre normalmente.

begin;

create table if not exists whatsapp_instance_cycles (
  id uuid primary key default gen_random_uuid(),

  instance_id uuid not null references whatsapp_instances(id) on delete cascade,
  -- Denormalizado para escopo de consulta e auditoria sem join.
  organization_id uuid not null references organizations(id) on delete restrict,

  cycle_start date not null,
  provider_due_on date not null,

  status text not null check (status in ('OPEN', 'CLOSED', 'PENDING_REVIEW')),

  -- Congelado na ABERTURA do ciclo: representa o custo vigente quando a
  -- competência começou. Mudança no custo da instância afeta só ciclos FUTUROS.
  provider_cost_cents integer check (provider_cost_cents is null or provider_cost_cents >= 0),
  cost_source text,
  cost_snapshot_at timestamptz,

  -- NULL = desconhecido/ambíguo; 0 = zero VERDADEIRO (override vitalício).
  customer_revenue_cents integer check (customer_revenue_cents is null or customer_revenue_cents >= 0),
  revenue_source text check (revenue_source is null or revenue_source in (
    'SUBSCRIPTION_SOLE_INSTANCE', 'AMBIGUOUS_MULTI_INSTANCE', 'LIFETIME_OVERRIDE', 'NO_ENTITLEMENT'
  )),
  customer_revenue_snapshot_at timestamptz,
  -- Referência ao que produziu a receita, para auditoria posterior.
  billing_subscription_id uuid references billing_subscriptions(id) on delete set null,

  -- Armazenado porque é a diferença de dois inteiros já congelados no ciclo.
  -- O PERCENTUAL, esse, nunca é gravado: é derivável e só poderia divergir.
  gross_margin_cents integer,

  closed_at timestamptz,
  closed_by uuid references auth.users(id),
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint whatsapp_cycles_order_chk check (provider_due_on > cycle_start),

  -- Ciclo fechado tem data de fechamento; ciclo OPEN não tem.
  constraint whatsapp_cycles_closed_chk check (
    (status = 'OPEN' and closed_at is null)
    or (status in ('CLOSED', 'PENDING_REVIEW') and closed_at is not null)
  ),

  -- CLOSED significa financeiramente concluído. Sem custo, o ciclo é
  -- PENDING_REVIEW — o worker não inventa default.
  constraint whatsapp_cycles_closed_needs_cost_chk check (
    status <> 'CLOSED' or provider_cost_cents is not null
  ),

  -- Margem só existe com os dois lados conhecidos.
  constraint whatsapp_cycles_margin_chk check (
    (gross_margin_cents is null)
    or (provider_cost_cents is not null and customer_revenue_cents is not null)
  )
);

comment on table whatsapp_instance_cycles is
  'Historico imutavel de ciclos do fornecedor (Fase 6b). [cycle_start, provider_due_on) — fim EXCLUSIVO, sem coluna cycle_end. Custo congelado na ABERTURA. Sem credenciais.';

-- Reexecução do fechamento não duplica.
create unique index if not exists whatsapp_cycles_instance_start_idx
  on whatsapp_instance_cycles (instance_id, cycle_start);

-- NUNCA dois ciclos economicamente correntes na mesma instância.
create unique index if not exists whatsapp_cycles_one_open_idx
  on whatsapp_instance_cycles (instance_id)
  where status = 'OPEN';

create index if not exists whatsapp_cycles_org_idx
  on whatsapp_instance_cycles (organization_id, cycle_start desc);

create index if not exists whatsapp_cycles_pending_idx
  on whatsapp_instance_cycles (status)
  where status = 'PENDING_REVIEW';

alter table whatsapp_instance_cycles enable row level security;
alter table whatsapp_instance_cycles force row level security;

drop policy if exists platform_admin_all_whatsapp_instance_cycles on whatsapp_instance_cycles;
create policy platform_admin_all_whatsapp_instance_cycles
  on whatsapp_instance_cycles for all
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

drop trigger if exists whatsapp_instance_cycles_updated_at on whatsapp_instance_cycles;
create trigger whatsapp_instance_cycles_updated_at
  before update on whatsapp_instance_cycles
  for each row execute function public.set_updated_at();

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. RLS ligada e forçada (esperado: t, t):
--   select relrowsecurity, relforcerowsecurity from pg_class
--    where relname = 'whatsapp_instance_cycles';
--
-- 2. Não existe coluna cycle_end (esperado: 0 linhas):
--   select column_name from information_schema.columns
--    where table_name = 'whatsapp_instance_cycles' and column_name = 'cycle_end';
--
-- 3. Índices de unicidade presentes (esperado: 2 linhas):
--   select indexname from pg_indexes where tablename = 'whatsapp_instance_cycles'
--    and indexname in ('whatsapp_cycles_instance_start_idx', 'whatsapp_cycles_one_open_idx');
--
-- =====================================================================
-- Rollback
-- =====================================================================
--   drop table if exists whatsapp_instance_cycles;
```

- [ ] **Step 2: Rodar o `migration-validator`**

Dispare `saas-shield-br:migration-validator` sobre o arquivo. Alto/crítico = NO-GO.

- [ ] **Step 3: Aplicar e validar**

```bash
supabase db push
```
Rode as três consultas do rodapé. Expected: `t, t`; zero coluna `cycle_end`; dois índices.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260801200100_088_whatsapp_instance_cycles.sql
git commit -m "feat(6b): historico imutavel de ciclos, um OPEN por instancia"
```

---

## Task 9: Migration 089 — `whatsapp_instance_alerts` (o ledger)

**Files:**
- Create: `supabase/migrations/20260801200200_089_whatsapp_instance_alerts.sql`

**Interfaces:**
- Consumes: `whatsapp_instances`, `organizations`, `whatsapp_channels`, `auth.users`.
- Produces: tabela `whatsapp_instance_alerts`.

- [ ] **Step 1: Escrever a migration**

`supabase/migrations/20260801200200_089_whatsapp_instance_alerts.sql`:

```sql
-- Ledger de alertas administrativos da instância (Fase 6b).
--
-- INDEPENDENTE DA FILA: billing_notifications_dispatch está OFF nesta fase, e
-- o painel é a superfície viva do alerta. Por isso o ledger carrega o próprio
-- tempo e a própria contagem — verificado no ambiente real que
-- billing_notifications NÃO tem created_at nem contador de tentativa, e hoje
-- não há como detectar uma fila parada. `dispatch_enabled_at_enqueue` existe
-- para que ninguém leia "não recebi e-mail" como "não houve alerta".
--
-- Chave de assunto em DOIS campos e não em instance_id: alerta econômico
-- pertence à ORGANIZAÇÃO, e chavear tudo por instância obrigaria a eleger uma
-- instância arbitrária para representar um desequilíbrio da organização.
--
-- Sem credencial e sem payload de provedor.

begin;

create table if not exists whatsapp_instance_alerts (
  id uuid primary key default gen_random_uuid(),

  subject_type text not null check (subject_type in ('INSTANCE', 'ORGANIZATION')),
  subject_id uuid not null,
  organization_id uuid not null references organizations(id) on delete cascade,
  instance_id uuid references whatsapp_instances(id) on delete set null,
  -- Só CHANNEL_WITHOUT_INSTANCE preenche: o painel precisa dizer QUAL canal
  -- está fora do inventário e a resolução por backfill precisa da referência.
  -- `on delete set null` porque o ledger é registro de auditoria e não pode
  -- ser apagado em cascata; a identidade textual sobrevive no dedupe_key.
  channel_id uuid references whatsapp_channels(id) on delete set null,

  -- SETE tipos no ledger, SEIS event_type no dispatcher (§10.6):
  -- DATE_REVIEW_REQUIRED é pendência de PAINEL e não tem e-mail. Nenhum aviso
  -- pode afirmar uma data que ninguém confirmou — é exatamente o que §6.2
  -- proíbe —, então ele existe para ser visto, não enviado. Inventar um sétimo
  -- event_type abriria acoplamento por string que a spec não previu.
  alert_type text not null check (alert_type in (
    'CYCLE_DUE_SOON', 'CYCLE_DUE_TOMORROW', 'END_CONFIRMATION_REQUIRED',
    'DIVERGENCE', 'CYCLE_COST_UNKNOWN', 'ECONOMIC_IMBALANCE',
    'DATE_REVIEW_REQUIRED'
  )),
  dedupe_key text not null,

  status text not null default 'OPEN'
    check (status in ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'SUPERSEDED')),

  first_detected_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrences integer not null default 1 check (occurrences >= 1),
  last_reminder_at timestamptz,

  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users(id),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id),
  resolution_note text,

  -- Sem segredo, sem payload do provedor, sem conteúdo de conversa, sem dado
  -- pessoal do cliente final.
  payload jsonb not null default '{}'::jsonb,
  dispatch_enabled_at_enqueue boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Sujeito coerente: alerta de organização não aponta instância.
  constraint whatsapp_alerts_subject_chk check (
    (subject_type = 'INSTANCE' and instance_id is not null and subject_id = instance_id)
    or (subject_type = 'ORGANIZATION' and subject_id = organization_id)
  ),

  -- Resolver exige registro de quando; encerrar administrativamente exige nota.
  constraint whatsapp_alerts_resolved_chk check (
    status <> 'RESOLVED' or resolved_at is not null
  ),
  constraint whatsapp_alerts_ack_chk check (
    status <> 'ACKNOWLEDGED' or acknowledged_at is not null
  )
);

comment on table whatsapp_instance_alerts is
  'Ledger de alertas da instancia (Fase 6b). INDEPENDENTE da fila billing_notifications — registra mesmo com o dispatcher OFF. Sem credencial. FORCE RLS, so platform_admin.';

comment on column whatsapp_instance_alerts.channel_id is
  'Preenchido SO por CHANNEL_WITHOUT_INSTANCE. NULL nos demais tipos.';

create unique index if not exists whatsapp_alerts_dedupe_idx
  on whatsapp_instance_alerts (subject_type, subject_id, alert_type, dedupe_key);

create index if not exists whatsapp_alerts_open_idx
  on whatsapp_instance_alerts (organization_id, status)
  where status in ('OPEN', 'ACKNOWLEDGED');

create index if not exists whatsapp_alerts_reminder_idx
  on whatsapp_instance_alerts (status, last_reminder_at)
  where status = 'OPEN';

alter table whatsapp_instance_alerts enable row level security;
alter table whatsapp_instance_alerts force row level security;

drop policy if exists platform_admin_all_whatsapp_instance_alerts on whatsapp_instance_alerts;
create policy platform_admin_all_whatsapp_instance_alerts
  on whatsapp_instance_alerts for all
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

drop trigger if exists whatsapp_instance_alerts_updated_at on whatsapp_instance_alerts;
create trigger whatsapp_instance_alerts_updated_at
  before update on whatsapp_instance_alerts
  for each row execute function public.set_updated_at();

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. RLS ligada e forçada (esperado: t, t):
--   select relrowsecurity, relforcerowsecurity from pg_class
--    where relname = 'whatsapp_instance_alerts';
--
-- 2. Índice de dedupe presente (esperado: 1 linha):
--   select indexname from pg_indexes where tablename = 'whatsapp_instance_alerts'
--    and indexname = 'whatsapp_alerts_dedupe_idx';
--
-- =====================================================================
-- Rollback
-- =====================================================================
--   drop table if exists whatsapp_instance_alerts;
```

- [ ] **Step 2: Rodar o `migration-validator` e o `rls-auditor`**

Dispare `saas-shield-br:migration-validator` e `saas-shield-br:rls-auditor` sobre as três migrations (087, 088, 089) juntas. Alto/crítico = NO-GO.

- [ ] **Step 3: Aplicar e validar**

```bash
supabase db push
```
Rode as duas consultas do rodapé. Expected: `t, t`; índice presente.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260801200200_089_whatsapp_instance_alerts.sql
git commit -m "feat(6b): ledger de alertas independente da fila de e-mail"
```

---

## Task 10: Migration 090 — RPC transacional de rolagem e lock

**Files:**
- Create: `supabase/migrations/20260801200300_090_whatsapp_instance_cycle_rpc.sql`
- Modify: `scripts/function-acl-allowlist.json` *(só se o `acl-estatico` acusar — as três funções são `service_role`-only e **não** entram na allowlist de `anon`/`authenticated`)*

**Interfaces:**
- Consumes: `whatsapp_instances`, `whatsapp_instance_cycles`.
- Produces:
  ```sql
  public.roll_whatsapp_instance_cycle(p_instance_id uuid, p_today date, p_next_due_on date)
    returns table (action text, closed_cycle_id uuid, opened_cycle_id uuid)
  public.try_whatsapp_instance_cycles_lock() returns boolean
  public.release_whatsapp_instance_cycles_lock() returns void
  ```
  **`p_next_due_on` vem calculado pelo caller** (núcleo puro `nextDueFromAnchor`, Task 1) — a aritmética de calendário fica testada em vitest, não duplicada em plpgsql.

- [ ] **Step 1: Escrever a migration**

`supabase/migrations/20260801200300_090_whatsapp_instance_cycle_rpc.sql`:

```sql
-- Rolagem de ciclo: UMA operação transacional e idempotente (Fase 6b §7.1).
--
-- Fechar o ciclo vencido, abrir o próximo e projetar na instância acontecem
-- juntos ou não acontecem. NUNCA pode existir estado intermediário persistido
-- em que o anterior fechou e o próximo não nasceu, ou em que a projeção da
-- instância aponta para datas diferentes do ciclo OPEN.
--
-- A ARITMÉTICA DE CALENDÁRIO NÃO MORA AQUI: `p_next_due_on` chega pronto do
-- núcleo puro (nextDueFromAnchor), que é testado em vitest com os dez casos de
-- §6.4. Reimplementar o clamp em plpgsql criaria uma segunda verdade sobre a
-- âncora — exatamente o que §6.3 proíbe.
--
-- O LOCK NÃO É A GARANTIA. Advisory lock é session-scoped e não sobrevive de
-- forma confiável ao pooling transaction-mode do PgBouncer (foi por isso que o
-- lock de conversa usa TTL em coluna, migration 056). A correção vem da
-- transação + UNIQUE (instance_id, cycle_start) + UNIQUE (instance_id) WHERE
-- status='OPEN'. O lock economiza trabalho; ele não é o invariante.

begin;

create or replace function public.roll_whatsapp_instance_cycle(
  p_instance_id uuid,
  p_today date,
  p_next_due_on date
)
returns table (action text, closed_cycle_id uuid, opened_cycle_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inst record;
  v_open record;
  v_closed_id uuid;
  v_opened_id uuid;
  v_status text;
begin
  -- FOR UPDATE serializa duas execuções simultâneas na mesma instância mesmo
  -- sem o advisory lock.
  select * into v_inst from whatsapp_instances where id = p_instance_id for update;
  if not found then
    return query select 'INSTANCE_NOT_FOUND'::text, null::uuid, null::uuid;
    return;
  end if;

  if v_inst.lifecycle_state not in ('ACTIVE', 'CANCELLATION_REQUESTED') then
    return query select 'SKIPPED_LIFECYCLE'::text, null::uuid, null::uuid;
    return;
  end if;

  select * into v_open
  from whatsapp_instance_cycles
  where instance_id = p_instance_id and status = 'OPEN'
  for update;

  if not found then
    return query select 'NO_OPEN_CYCLE'::text, null::uuid, null::uuid;
    return;
  end if;

  -- Fim EXCLUSIVO: `>=` e não `>`. Com `>` a rolagem sairia um dia atrasada.
  if p_today < v_open.provider_due_on then
    return query select 'NOT_DUE'::text, null::uuid, null::uuid;
    return;
  end if;

  -- Custo desconhecido não fecha como financeiramente concluído.
  v_status := case when v_open.provider_cost_cents is null then 'PENDING_REVIEW' else 'CLOSED' end;

  update whatsapp_instance_cycles
     set status = v_status, closed_at = now()
   where id = v_open.id
  returning id into v_closed_id;

  -- Instância em cancelamento NÃO abre ciclo novo além de provider_access_until.
  if v_inst.lifecycle_state = 'CANCELLATION_REQUESTED'
     and v_inst.provider_access_until is not null
     and v_open.provider_due_on >= v_inst.provider_access_until then
    update whatsapp_instances
       set current_cycle_started_on = null,
           current_cycle_due_on = null,
           updated_at = now()
     where id = p_instance_id;
    return query select 'CLOSED_NO_REOPEN'::text, v_closed_id, null::uuid;
    return;
  end if;

  -- Custo congelado na ABERTURA: o custo vigente quando a competência começa.
  -- Receita e margem ficam NULL aqui e são preenchidas pelo worker, que é quem
  -- conhece assinatura e override — plpgsql não replica a política de §7.3.
  insert into whatsapp_instance_cycles (
    instance_id, organization_id, cycle_start, provider_due_on, status,
    provider_cost_cents, cost_source, cost_snapshot_at
  ) values (
    p_instance_id, v_inst.organization_id, v_open.provider_due_on, p_next_due_on, 'OPEN',
    v_inst.current_monthly_cost_cents, v_inst.cost_source,
    case when v_inst.current_monthly_cost_cents is null then null else now() end
  )
  on conflict (instance_id, cycle_start) do nothing
  returning id into v_opened_id;

  if v_opened_id is null then
    -- Reexecução: o ciclo já existia. Idempotente, não é erro.
    select id into v_opened_id from whatsapp_instance_cycles
     where instance_id = p_instance_id and cycle_start = v_open.provider_due_on;
  end if;

  update whatsapp_instances
     set current_cycle_started_on = v_open.provider_due_on,
         current_cycle_due_on = p_next_due_on,
         cycle_source = 'SYSTEM_ROLLED',
         updated_at = now()
   where id = p_instance_id;

  return query select 'ROLLED'::text, v_closed_id, v_opened_id;
end;
$$;

-- Advisory lock do worker, mesmo padrão do giftback, com chave PRÓPRIA.
-- Falha aberta é aceitável: a garantia real está nos UNIQUE.
create or replace function public.try_whatsapp_instance_cycles_lock()
returns boolean
language sql
security definer
set search_path = public, pg_catalog
as $$
  select pg_try_advisory_lock(hashtext('whatsapp_instance_cycles_worker'));
$$;

create or replace function public.release_whatsapp_instance_cycles_lock()
returns void
language sql
security definer
set search_path = public, pg_catalog
as $$
  select pg_advisory_unlock(hashtext('whatsapp_instance_cycles_worker'));
$$;

-- CREATE FUNCTION concede EXECUTE a PUBLIC por padrão e o schema public é
-- exposto ao PostgREST com a anon key. Revogar PUBLIC **e** os grants diretos.
revoke all on function public.roll_whatsapp_instance_cycle(uuid, date, date) from public, anon, authenticated;
revoke all on function public.try_whatsapp_instance_cycles_lock() from public, anon, authenticated;
revoke all on function public.release_whatsapp_instance_cycles_lock() from public, anon, authenticated;

grant execute on function public.roll_whatsapp_instance_cycle(uuid, date, date) to service_role;
grant execute on function public.try_whatsapp_instance_cycles_lock() to service_role;
grant execute on function public.release_whatsapp_instance_cycles_lock() to service_role;

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. ACL das três funções (esperado: nenhuma com anon= ou authenticated=):
--   select proname, proacl from pg_proc
--    where proname in ('roll_whatsapp_instance_cycle',
--                      'try_whatsapp_instance_cycles_lock',
--                      'release_whatsapp_instance_cycles_lock');
--
-- 2. search_path fixado nas três (esperado: search_path=... em cada uma):
--   select proname, proconfig from pg_proc
--    where proname like '%whatsapp_instance_cycle%';
--
-- =====================================================================
-- Rollback
-- =====================================================================
--   drop function if exists public.roll_whatsapp_instance_cycle(uuid, date, date);
--   drop function if exists public.try_whatsapp_instance_cycles_lock();
--   drop function if exists public.release_whatsapp_instance_cycles_lock();
```

- [ ] **Step 2: Rodar o guardrail estático de ACL**

```bash
npx vitest run scripts/function-acl-allowlist.test.ts
```
Expected: PASS. As três funções são `service_role`-only e **não** devem aparecer na allowlist de `anon`/`authenticated`. Se o teste falhar acusando alguma delas, o defeito está na migration (grant sobrando), **não na allowlist** — não adicione entrada para o teste parar de falhar.

- [ ] **Step 3: Rodar `migration-validator` e `identity-access-auditor`**

Alto/crítico = NO-GO.

- [ ] **Step 4: Aplicar e validar**

```bash
supabase db push
```
Rode as duas consultas do rodapé. Expected: nenhum `anon=`/`authenticated=` no `proacl`; `search_path` fixado nas três.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260801200300_090_whatsapp_instance_cycle_rpc.sql
git commit -m "feat(6b): RPC transacional de rolagem e lock do worker"
```

---

## Task 11: Migration 091 — remover as três flags `zapi_auto_*`

**Files:**
- Create: `supabase/migrations/20260801200400_091_drop_zapi_auto_flags.sql`
- Create: `docs/billing-asaas/restore-zapi-auto-flags.sql` *(migration de restauração pronta, fora de `supabase/migrations/` para não ser aplicada por engano)*

**Interfaces:**
- Consumes: `platform_flags`.
- Produces: nada de código — remoção de três linhas vivas.

- [ ] **Step 1: Reconfirmar que não há consumidor**

```bash
grep -rn "zapi_auto_provisioning\|zapi_auto_disconnect\|zapi_auto_cancel" \
  --include="*.ts" --include="*.tsx" --include="*.sql" --include="*.json" . | grep -v node_modules
```
Expected: os nomes aparecem **apenas** na migration 061 (o seed) e em documentação da fase. **Se aparecer qualquer consumidor de código, cron, RPC ou UI, PARE** — a remoção deixa de ser segura e vira decisão do dono.

Confirme também: nenhum *dashboard* externo, nenhuma documentação operacional dependente, nenhuma consulta manual recorrente.

- [ ] **Step 2: Escrever a migration de remoção**

`supabase/migrations/20260801200400_091_drop_zapi_auto_flags.sql`:

```sql
-- Remoção de três flags ÓRFÃS criadas na migration 061 para a API de Parceiro
-- Integrador da Z-API (Fase 6b §9).
--
-- POR QUE REMOVER: nenhum código as lê. Os nomes prometem automação que não
-- existe — a Z-API não tem rota de cancelamento, o Partner não foi contratado,
-- e platform_flags deve representar controle operacional EXISTENTE, não ideia
-- futura. Um controle sem efeito no painel é pior que ausência: alguém liga e
-- espera consequência.
--
-- POR QUE MIGRATION NOVA E NÃO EDIÇÃO DA 061: a 061 JÁ FOI APLICADA em
-- produção (2026-07-16, Fase 1). Editá-la causaria drift em schema_migrations
-- e exigiria `supabase migration repair` — proibido pelo CLAUDE.md.
--
-- VALORES ANTERIORES, para restauração sem arqueologia:
--   zapi_auto_provisioning = 'false'
--   zapi_auto_disconnect   = 'false'
--   zapi_auto_cancel       = 'false'
-- Migration de restauração PRONTA em docs/billing-asaas/restore-zapi-auto-flags.sql
-- — não é comentário de rodapé, é arquivo executável versionado.
--
-- CONDIÇÃO PARA RECRIAR: só junto de automação real, com consumidor no código,
-- testes, auditoria e rollback. Nunca "para deixar preparado".

begin;

delete from platform_flags
 where key in ('zapi_auto_provisioning', 'zapi_auto_disconnect', 'zapi_auto_cancel');

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. As três sumiram (esperado: 0 linhas):
--   select key from platform_flags
--    where key in ('zapi_auto_provisioning','zapi_auto_disconnect','zapi_auto_cancel');
--
-- 2. Nenhuma flag VIVA foi removida por engano — as da 5a/5b seguem presentes
--    (esperado: 4 linhas, todas com value 'false'):
--   select key, value from platform_flags
--    where key in ('whatsapp_service_enforcement','billing_invoice_ingestion',
--                  'whatsapp_implementation_flow','whatsapp_subscription_checkout')
--    order by key;
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- Aplicar docs/billing-asaas/restore-zapi-auto-flags.sql como migration nova
-- (renomeando para o formato YYYYMMDDHHMMSS_nnn_*.sql).
```

- [ ] **Step 3: Escrever a migration de restauração, pronta para uso**

`docs/billing-asaas/restore-zapi-auto-flags.sql`:

```sql
-- RESTAURAÇÃO das três flags removidas pela migration 091 (Fase 6b §9).
--
-- Este arquivo NÃO está em supabase/migrations/ de propósito: ele não deve ser
-- aplicado por engano num `db push`. Para usá-lo, copie para
-- supabase/migrations/ com o nome YYYYMMDDHHMMSS_nnn_restore_zapi_auto_flags.sql
-- e aplique com `supabase db push`.
--
-- Valores restaurados são os que existiam antes da remoção: todas 'false'.
-- Restaurar as flags NÃO restaura automação nenhuma — se a intenção for
-- automatizar de verdade, a flag é a última etapa, não a primeira.

insert into platform_flags (key, value, description)
values
  ('zapi_auto_provisioning', 'false', 'Provisionamento automatico de instancia Z-API (sem consumidor).'),
  ('zapi_auto_disconnect',   'false', 'Desconexao automatica de instancia Z-API (sem consumidor).'),
  ('zapi_auto_cancel',       'false', 'Cancelamento automatico de instancia Z-API (sem consumidor).')
on conflict (key) do nothing;
```

**Antes de escrever este arquivo, confira as colunas reais de `platform_flags`** (a 061 pode não ter `description`):

```bash
grep -n "create table.*platform_flags" -A 15 supabase/migrations/20260716130000_061_platform_flags.sql
```
Ajuste o `insert` às colunas que existem — não invente coluna.

- [ ] **Step 4: Aplicar e validar**

```bash
supabase db push
```
Rode as duas consultas do rodapé. Expected: zero linhas das três removidas; **quatro** flags vivas intactas.

- [ ] **Step 5: Verificar que o painel não exibe controle sem efeito**

```bash
grep -rn "zapi_auto" src/ | grep -v node_modules
```
Expected: zero resultados.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260801200400_091_drop_zapi_auto_flags.sql docs/billing-asaas/restore-zapi-auto-flags.sql
git commit -m "chore(6b): remove tres flags zapi_auto orfas, com restauracao pronta"
```

---

## Task 12: Guardrail estático de migration + testes de integração `ENVIRONMENT_BLOCKED`

**Files:**
- Create: `scripts/migration-static-guard.test.ts`
- Modify: `.github/workflows/function-acl-audit.yml`
- Create: `supabase/tests/whatsapp-instances.integration.md`

**Interfaces:**
- Consumes: os arquivos de `supabase/migrations/`.
- Produces: um teste de CI que falha quando migration nova embute URL de projeto, *endpoint* de produção ou segredo.

- [ ] **Step 1: Escrever o guardrail (que já falha se alguém regredir)**

`scripts/migration-static-guard.test.ts`:

```ts
// Guardrail estático de migrations — BLOQUEANTE no CI.
//
// Motivo (spec §11.0): treze migrations legadas embutem a URL do projeto de
// PRODUÇÃO dentro dos wrappers de pg_cron. Um banco local reconstruído por
// esse histórico, com pg_cron ativo, agenda jobs que fazem POST nas Edge
// Functions de produção. Consertar as treze é frente estrutural separada
// (BASELINE_REPRODUCIBLE_DATABASE_ENVIRONMENT); o que a Fase 6b garante é que
// NENHUMA MIGRATION NOVA repete o padrão.
//
// A allowlist abaixo é fechada e histórica: ela nunca cresce. Arquivo novo com
// URL de projeto é falha, não pedido de allowlist.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

/** Os 13 arquivos que JÁ estavam aplicados quando a regra nasceu. Fechada. */
const LEGACY_HARDCODED_URL = new Set([
  "20260506181440_022_reservation_source.sql",
  "20260507153701_029_outbox_cron.sql",
  "20260508161319_043_giftback_cron.sql",
  "20260508211157_045_reservation_automation_cron.sql",
  "20260514181701_048_waitlist_automation.sql",
  "20260520000000_storage_orphan_cleanup_cron.sql",
  "20260527140001_stripe_expire_payments_cron.sql",
  "20260528010000_billing_crons.sql",
  "20260528030000_billing_trial_auto.sql",
  "20260716140000_064_process_asaas_reconcile_cron.sql",
  "20260719151000_069_process_billing_notifications_cron.sql",
  "20260727100400_082_cron_asaas_invoice_reconcile.sql",
  "20260727100500_083_cron_whatsapp_enforcement.sql",
]);

const PROJECT_URL = /https:\/\/[a-z0-9]{20}\.supabase\.co/i;
const SECRET_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{10,}/,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/,
  /\bxai-[A-Za-z0-9_-]{10,}/,
  /\bre_[A-Za-z0-9_-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /postgres(?:ql)?:\/\/[^\s:]+:[^\s@]+@/i, // URL com credencial
];

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
}

describe("guardrail estático de migrations", () => {
  it("nenhuma migration NOVA embute URL de projeto Supabase", () => {
    const offenders = migrationFiles().filter(
      (f) => !LEGACY_HARDCODED_URL.has(f) && PROJECT_URL.test(readFileSync(join(MIGRATIONS_DIR, f), "utf8")),
    );
    expect(offenders, `URL de projeto hardcoded em: ${offenders.join(", ")}. Leia a config do ambiente (Vault), não embuta o host.`).toEqual([]);
  });

  it("nenhuma migration embute segredo", () => {
    const offenders: string[] = [];
    for (const f of migrationFiles()) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (SECRET_SHAPES.some((re) => re.test(sql))) offenders.push(f);
    }
    expect(offenders, `Possível segredo em: ${offenders.join(", ")}`).toEqual([]);
  });

  it("a allowlist legada não cresce — ela é histórica e fechada", () => {
    expect(LEGACY_HARDCODED_URL.size).toBe(13);
  });

  it("controle positivo: o guardrail realmente detecta o padrão", () => {
    // Sem isto, um regex quebrado passaria como "nada encontrado".
    expect(PROJECT_URL.test("url := 'https://gbabxcrntkwgblgqsiit.supabase.co';")).toBe(true);
    expect(PROJECT_URL.test("url := project_url_from_vault;")).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que passa com as migrations atuais**

Run: `npx vitest run scripts/migration-static-guard.test.ts`
Expected: PASS — os 13 legados estão na allowlist, as migrations 087–091 não têm URL nem segredo.

Se falhar acusando 087–091, **o defeito está na migration**, não no guardrail.

- [ ] **Step 3: Ligar no CI**

Em `.github/workflows/function-acl-audit.yml`, no job `acl-estatico`, **depois** do passo "Auditoria estática de ACL", acrescente:

```yaml
      # Guardrail de migration: nenhuma migration NOVA pode embutir URL do
      # projeto Supabase, endpoint de produção ou segredo. Os 13 arquivos
      # legados estão numa allowlist fechada — ver spec da Fase 6b §11.0 e a
      # frente BASELINE_REPRODUCIBLE_DATABASE_ENVIRONMENT.
      - name: Guardrail estático de migrations
        run: npx vitest run scripts/migration-static-guard.test.ts
```

- [ ] **Step 4: Escrever os testes de integração como `ENVIRONMENT_BLOCKED`**

`supabase/tests/whatsapp-instances.integration.md` — **especificação executável ainda não executável**. Não é `.test.ts` de propósito: um arquivo de teste que não roda vira `skip` silencioso, e `skip` verde é a mentira que §11.2 proíbe.

````markdown
# Testes de integração da Fase 6b — status `ENVIRONMENT_BLOCKED`

**Status:** `ENVIRONMENT_BLOCKED`

**Motivo exato (obrigatório, literal — "infra indisponível" não serve):**

> Rebuild não executado porque o ambiente local não possui Supabase CLI/Docker/psql
> e migrations com wrappers de `pg_cron` contêm URL de produção, tornando a
> execução local insegura sem isolamento prévio.
>
> **Emenda:** o rebuild também não completaria se o ambiente existisse — o replay
> reprovou em 2026-07-30 com `42P13 — cannot change return type of existing
> function` (54 `create or replace function` alterando retorno tabular contra 4
> `drop function`). Dois bloqueios independentes.

**Desbloqueio:** a frente `BASELINE_REPRODUCIBLE_DATABASE_ENVIRONMENT` entrega o
ambiente. Nada aqui é reescrito quando isso acontecer — os casos já estão
especificados.

**Proibições que não mudam:** nunca contra produção · nunca acionado pelo CI ·
Ren Sushi e Moralles nunca como fixture · limpeza em `teardown`/`finally`
mesmo com falha de assertion.

**Ambiente, por ordem de preferência:** (1) Supabase local descartável —
*bloqueado hoje*; (2) projeto Supabase separado de teste; (3) banco temporário
do job; (4) roteiro manual em produção, só para evidência inalcançável nos
anteriores e com autorização específica.

## Casos, com controle positivo obrigatório

| # | Negativo (deve falhar) | Controle positivo (deve funcionar) |
|---|---|---|
| 1 | `authenticated` não lê `whatsapp_instances` | `service_role` lê |
| 2 | `anon` não lê nenhuma das três tabelas | `service_role` lê |
| 3 | `anon`/`authenticated` sem `EXECUTE` em `roll_whatsapp_instance_cycle` | `service_role` executa |
| 4 | segunda rolagem simultânea não cria ciclo duplicado | rolagem legítima cria |
| 5 | dois ciclos `OPEN` na mesma instância são rejeitados | `PENDING_REVIEW` + `OPEN` coexistem |
| 6 | `dedupe_key` repetido no ledger é rejeitado | combinação diferente é aceita |
| 7 | `unit_id` de outra organização é rejeitado pela trigger | `unit_id` coerente é aceito |
| 8 | `channel_id` de outra organização é rejeitado | `channel_id` coerente é aceito |
| 9 | `ENDED` sem `ended_at` viola CHECK | `ENDED` com `ended_at` é aceito |
| 10 | `CLOSED` sem `provider_cost_cents` viola CHECK | `PENDING_REVIEW` sem custo é aceito |
| 11 | `cycle_source='UNKNOWN'` com `current_cycle_due_on` viola CHECK | `UNKNOWN` sem projeção é aceito |
| 12 | `CANCELLATION_REQUESTED` sem `provider_access_until` viola CHECK | com a data é aceito |
| 13 | transição `ENDED → ACTIVE` é recusada pela EF | `ACTIVE → CANCELLATION_REQUESTED` conclui |

**Por que integração e não unitário:** o hotfix do Risco 7 provou o ponto — a
classificação estava certa e a retenção não persistia porque o `UPDATE` violava
um `CHECK`. **Nenhum mock teria pego.** Metade dos casos acima são
exatamente dessa família: a regra vive no banco.

**Caso 4 explicitamente aqui e não no núcleo puro:** concorrência é fato de
banco, não aritmética de calendário — simulá-la com mock provaria apenas que o
mock foi escrito de acordo.
````

- [ ] **Step 5: Commit**

```bash
git add scripts/migration-static-guard.test.ts .github/workflows/function-acl-audit.yml supabase/tests/whatsapp-instances.integration.md
git commit -m "test(6b): guardrail de migration no CI e integracao marcada ENVIRONMENT_BLOCKED"
```

---

## Task 13: Os seis templates em `process-billing-notifications` — **antes do produtor**

**Files:**
- Modify: `supabase/functions/process-billing-notifications/index.ts` (dentro de `TEMPLATE_BY_EVENT`, após `admin_invoice_value_mismatch`)
- Test: `src/lib/whatsapp-instance-alerts-core.test.ts` *(já cobre o mapa `EVENT_TYPE_BY_ALERT`; nada muda aqui)*

**Interfaces:**
- Consumes: `TemplateData = { orgName: string; amountBrl: string; paymentUrl: string | null }` e o helper `wrapHtml(title, paragraphs)` — **já existentes no arquivo**. Não há campo de instância nem de data no `TemplateData`, e **isso é adequado**: §10.5 proíbe credencial, conteúdo de conversa e dado pessoal no alerta, e o painel é a superfície viva desta fase.
- Produces: seis chaves novas em `TEMPLATE_BY_EVENT`.

**Ordem:** esta task vem **antes** de qualquer código que enfileire esses `event_type`. Com `billing_notifications_dispatch` OFF não há envio, mas `unknown_event_type` ainda marca a linha como `failed` e **mata o aviso**. É a quarta ocorrência do mesmo acoplamento por string no projeto.

- [ ] **Step 1: Acrescentar as seis entradas**

Em `supabase/functions/process-billing-notifications/index.ts`, dentro de `TEMPLATE_BY_EVENT`:

```ts
  // ── Fase 6b: calendário e custo da instância Z-API ─────────────────────
  // Destinatário é SEMPRE platform_admin. O lojista não conhece o ciclo da
  // Z-API — para ele esse calendário não existe — e mandar o calendário do
  // FORNECEDOR para o cliente exporia custo interno.
  //
  // Texto deliberadamente genérico: TemplateData não carrega instância nem
  // data, e §10.5 proíbe credencial, token, conteúdo de conversa e dado
  // pessoal no alerta. O detalhe fica no painel, que é a superfície viva
  // enquanto billing_notifications_dispatch está OFF.
  admin_zapi_cycle_due_soon: (d) => ({
    subject: `[interno] Instância Z-API vence em até 7 dias — ${d.orgName}`,
    text: `Uma instância de WhatsApp da organização ${d.orgName} tem cobrança do fornecedor prevista para os próximos 7 dias. Se ela não for mais necessária, cancele no painel da Z-API antes do vencimento — cancelar depois não devolve o ciclo já pago. Detalhes em Plataforma → Instâncias de WhatsApp.`,
    html: wrapHtml("Instância Z-API vence em até 7 dias", [
      `Uma instância de WhatsApp da organização <strong>${d.orgName}</strong> tem cobrança do fornecedor prevista para os <strong>próximos 7 dias</strong>.`,
      `Se ela não for mais necessária, cancele no painel da Z-API <strong>antes</strong> do vencimento — cancelar depois não devolve o ciclo já pago.`,
      `Detalhes em <strong>Plataforma → Instâncias de WhatsApp</strong>.`,
    ]),
  }),
  admin_zapi_cycle_due_tomorrow: (d) => ({
    subject: `[interno] Instância Z-API vence amanhã e tem pendência — ${d.orgName}`,
    text: `Uma instância de WhatsApp da organização ${d.orgName} vence amanhã e tem pendência registrada (custo desconhecido, divergência aberta, cancelamento não registrado ou receita indefinida). Verifique em Plataforma → Instâncias de WhatsApp antes do vencimento.`,
    html: wrapHtml("Instância Z-API vence amanhã e tem pendência", [
      `Uma instância de WhatsApp da organização <strong>${d.orgName}</strong> vence <strong>amanhã</strong> e tem pendência registrada.`,
      `Pode ser custo desconhecido, divergência aberta, cancelamento pretendido e não registrado, ou receita indefinida.`,
      `Verifique em <strong>Plataforma → Instâncias de WhatsApp</strong> antes do vencimento.`,
    ]),
  }),
  admin_zapi_end_confirmation_required: (d) => ({
    subject: `[interno] Confirme o encerramento da instância — ${d.orgName}`,
    text: `O prazo de acesso de uma instância cancelada da organização ${d.orgName} terminou. O sistema NÃO encerrou nada sozinho: confirme no painel do fornecedor se a instância realmente deixou de existir e registre a confirmação em Plataforma → Instâncias de WhatsApp.`,
    html: wrapHtml("Confirme o encerramento da instância", [
      `O prazo de acesso de uma instância cancelada da organização <strong>${d.orgName}</strong> terminou.`,
      `O sistema <strong>não</strong> encerrou nada sozinho — afirmar um encerramento que o fornecedor não fez já custou caro neste projeto.`,
      `Confirme no painel do fornecedor e registre em <strong>Plataforma → Instâncias de WhatsApp</strong>.`,
    ]),
  }),
  admin_zapi_instance_divergence: (d) => ({
    subject: `[interno] Divergência no inventário de instâncias — ${d.orgName}`,
    text: `Há divergência entre o inventário de instâncias e o estado registrado dos canais da organização ${d.orgName}. Nenhuma ação automática foi tomada e nenhum envio foi bloqueado. Revise em Plataforma → Instâncias de WhatsApp.`,
    html: wrapHtml("Divergência no inventário de instâncias", [
      `Há divergência entre o inventário de instâncias e o estado registrado dos canais da organização <strong>${d.orgName}</strong>.`,
      `<strong>Nenhuma</strong> ação automática foi tomada e <strong>nenhum</strong> envio foi bloqueado.`,
      `Revise em <strong>Plataforma → Instâncias de WhatsApp</strong>.`,
    ]),
  }),
  admin_zapi_cycle_cost_unknown: (d) => ({
    subject: `[interno] Ciclo fechado sem custo informado — ${d.orgName}`,
    text: `Um ciclo de instância da organização ${d.orgName} terminou sem custo informado e ficou pendente de revisão. Custo desconhecido não é zero — enquanto ele não for informado, a margem dessa organização fica indefinida. Informe em Plataforma → Instâncias de WhatsApp.`,
    html: wrapHtml("Ciclo fechado sem custo informado", [
      `Um ciclo de instância da organização <strong>${d.orgName}</strong> terminou <strong>sem custo informado</strong> e ficou pendente de revisão.`,
      `Custo desconhecido não é zero — enquanto ele não for informado, a margem dessa organização fica indefinida.`,
      `Informe em <strong>Plataforma → Instâncias de WhatsApp</strong>.`,
    ]),
  }),
  admin_zapi_org_economic_imbalance: (d) => ({
    subject: `[interno] Custo de instâncias acima da receita — ${d.orgName}`,
    text: `O custo conhecido das instâncias de WhatsApp da organização ${d.orgName} está acima da receita atribuída. Isto é informação administrativa, não erro: cortesia vitalícia aparece assim por definição. Nada foi bloqueado. Avalie em Plataforma → Instâncias de WhatsApp.`,
    html: wrapHtml("Custo de instâncias acima da receita", [
      `O custo conhecido das instâncias de WhatsApp da organização <strong>${d.orgName}</strong> está <strong>acima</strong> da receita atribuída.`,
      `Isto é informação administrativa, não erro — cortesia vitalícia aparece assim por definição. <strong>Nada foi bloqueado.</strong>`,
      `Avalie em <strong>Plataforma → Instâncias de WhatsApp</strong>.`,
    ]),
  }),
```

- [ ] **Step 2: Verificar que as seis strings batem com o núcleo**

```bash
node -e "const s=require('fs').readFileSync('supabase/functions/process-billing-notifications/index.ts','utf8'); ['admin_zapi_cycle_due_soon','admin_zapi_cycle_due_tomorrow','admin_zapi_end_confirmation_required','admin_zapi_instance_divergence','admin_zapi_cycle_cost_unknown','admin_zapi_org_economic_imbalance'].forEach(k=>{ if(!s.includes(k+':')) { console.error('FALTA: '+k); process.exit(1);} }); console.log('as seis entradas existem');"
```
Expected: `as seis entradas existem`.

- [ ] **Step 3: Deploy imediato — o dispatcher vai primeiro**

```bash
supabase functions deploy process-billing-notifications
```

**Não siga para a Task 17 antes deste deploy.** O worker produtor só existe depois que o dispatcher sabe renderizar os seis `event_type`.

- [ ] **Step 4: Commit**

```bash
npm run typecheck
git add supabase/functions/process-billing-notifications/index.ts
git commit -m "feat(6b): seis templates do calendario da instancia Z-API no dispatcher"
```

---

## Task 14: `manage-whatsapp-instances` — leitura, autorização e projeção explícita

**Files:**
- Create: `supabase/functions/manage-whatsapp-instances/index.ts`
- Modify: `supabase/config.toml`

**Interfaces:**
- Consumes: `_shared/cors.ts`, `_shared/security.ts` (`genRequestId`, `jsonLog`), `is_platform_admin` via RPC, os núcleos das Tasks 1–6.
- Produces: as actions `list_instances`, `get_instance`, `list_alerts`, `simulate_partner` — e o esqueleto de autorização que as Tasks 15 e 16 estendem.

- [ ] **Step 1: Registrar `verify_jwt` ANTES do primeiro deploy**

Em `supabase/config.toml`, ao final:

```toml
# Painel administrativo do inventário de instâncias Z-API (super-admin).
# verify_jwt explícito como defesa em profundidade — a EF valida
# platform_admin no JWT por conta própria, e o gateway barra antes.
[functions.manage-whatsapp-instances]
verify_jwt = true

# Worker: rolagem de ciclo, alertas e divergências da instância Z-API
# (pg_cron 12:10 UTC). Obrigatório explicitar — CLI >=2.95 default vira true e
# o gateway responde 401 antes do requireInternalAuth, cron silencia.
[functions.process-whatsapp-instance-cycles]
verify_jwt = false
```

- [ ] **Step 2: Escrever a EF com autorização e leitura**

`supabase/functions/manage-whatsapp-instances/index.ts`:

```ts
// Painel administrativo do inventário de instâncias Z-API (Fase 6b).
// EXCLUSIVO de platform_admin: esta tabela contém o que a PLATAFORMA paga.
//
// PROJEÇÃO SEGURA, NÃO FILTRO TARDIO: as respostas montam lista EXPLÍCITA de
// colunas. É a lição paga duas vezes — o vazamento de billing_email por
// privilégio de coluna (migration 086) e o molde de ORG_BILLING_PUBLIC_COLUMNS
// em manage-billing. Com `select("*")` moldado depois, campo novo entra e vaza
// sozinho.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { genRequestId, jsonLog } from "../_shared/security.ts";
import { simulatePartner } from "../_shared/whatsapp-partner-simulator-core.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Lista EXPLÍCITA. `provider_instance_ref` entra porque o admin precisa
// identificar a instância no painel do fornecedor — é identificador, não
// credencial (§3.3). Nenhuma coluna de segredo existe nesta tabela.
const INSTANCE_COLUMNS = [
  "id", "organization_id", "unit_id", "channel_id", "provider", "provider_instance_ref",
  "lifecycle_state", "provider_cycle_anchor_day", "current_cycle_started_on",
  "current_cycle_due_on", "cycle_source", "current_monthly_cost_cents", "cost_source",
  "cost_updated_at", "cost_note", "cancellation_requested_at", "cancellation_reason",
  "provider_access_until", "end_confirmation_required_at", "ended_at",
  "end_confirmation_note", "planned_provision_on", "last_synced_at",
  "last_seen_provider_status", "last_divergence_kind", "last_divergence_at",
  "notes", "created_at", "updated_at",
].join(", ");

const CYCLE_COLUMNS = [
  "id", "instance_id", "cycle_start", "provider_due_on", "status",
  "provider_cost_cents", "cost_source", "customer_revenue_cents", "revenue_source",
  "gross_margin_cents", "closed_at", "notes", "created_at",
].join(", ");

const ALERT_COLUMNS = [
  "id", "subject_type", "subject_id", "organization_id", "instance_id", "channel_id",
  "alert_type", "dedupe_key", "status", "first_detected_at", "last_seen_at",
  "occurrences", "last_reminder_at", "acknowledged_at", "resolved_at",
  "resolution_note", "payload", "dispatch_enabled_at_enqueue",
].join(", ");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Resolve o usuário do JWT e exige platform_admin. Sem exceção org-scoped
 *  nesta fase: nenhuma action desta EF é client-friendly. */
async function requirePlatformAdmin(req: Request): Promise<{ userId: string } | null> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return null;

  const { data: isAdmin } = await supabase.rpc("is_platform_admin", { uid: userData.user.id });
  if (!isAdmin) return null;

  return { userId: userData.user.id };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const reqId = genRequestId();

  try {
    const admin = await requirePlatformAdmin(req);
    if (!admin) {
      // Mensagem curta em PT-BR; nada do Postgres, nada de detalhe interno.
      return json({ error: "Acesso restrito a administradores da plataforma." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "");

    if (action === "list_instances") {
      const { data, error } = await supabase
        .from("whatsapp_instances")
        .select(INSTANCE_COLUMNS)
        .order("created_at", { ascending: false });
      if (error) {
        jsonLog("error", { reqId, evt: "wa_instances_list_failed", err: error.message });
        return json({ error: "Não foi possível carregar as instâncias." }, 500);
      }
      return json({ instances: data ?? [] });
    }

    if (action === "get_instance") {
      const id = String(body?.instance_id ?? "");
      if (!id) return json({ error: "instance_id é obrigatório." }, 400);

      const [inst, cycles, alerts] = await Promise.all([
        supabase.from("whatsapp_instances").select(INSTANCE_COLUMNS).eq("id", id).maybeSingle(),
        supabase.from("whatsapp_instance_cycles").select(CYCLE_COLUMNS)
          .eq("instance_id", id).order("cycle_start", { ascending: false }),
        supabase.from("whatsapp_instance_alerts").select(ALERT_COLUMNS)
          .eq("instance_id", id).order("first_detected_at", { ascending: false }),
      ]);

      if (inst.error || !inst.data) return json({ error: "Instância não encontrada." }, 404);
      return json({ instance: inst.data, cycles: cycles.data ?? [], alerts: alerts.data ?? [] });
    }

    if (action === "list_alerts") {
      const status = body?.status ? String(body.status) : null;
      let q = supabase.from("whatsapp_instance_alerts").select(ALERT_COLUMNS)
        .order("first_detected_at", { ascending: false });
      if (status) q = q.eq("status", status);
      const { data, error } = await q;
      if (error) {
        jsonLog("error", { reqId, evt: "wa_alerts_list_failed", err: error.message });
        return json({ error: "Não foi possível carregar os alertas." }, 500);
      }
      return json({ alerts: data ?? [] });
    }

    if (action === "simulate_partner") {
      // NÃO ESCREVE NADA — nem instância, nem ciclo, nem alerta.
      const orgId = body?.organization_id ? String(body.organization_id) : null;
      let q = supabase.from("whatsapp_instances")
        .select("id, current_monthly_cost_cents")
        .in("lifecycle_state", ["ACTIVE", "CANCELLATION_REQUESTED"]);
      if (orgId) q = q.eq("organization_id", orgId);
      const { data, error } = await q;
      if (error) {
        jsonLog("error", { reqId, evt: "wa_partner_sim_failed", err: error.message });
        return json({ error: "Não foi possível carregar os custos para simular." }, 500);
      }

      const result = simulatePartner({
        instanceCosts: (data ?? []).map((r) => r.current_monthly_cost_cents),
        partnerMonthlyTargetCents: Number(body?.partner_monthly_target_cents),
      });
      if (result.ok === false) return json({ error: result.message, code: result.code }, 400);
      return json({ simulation: result });
    }

    return json({ error: "Ação desconhecida." }, 400);
  } catch (err) {
    jsonLog("error", { reqId, evt: "wa_instances_unhandled", err: String(err) });
    return json({ error: "Erro interno." }, 500);
  }
});
```

- [ ] **Step 3: Conferir o nome do parâmetro da RPC `is_platform_admin`**

```bash
grep -rn "is_platform_admin" supabase/functions/manage-whatsapp-implementations/index.ts | head -5
```
Ajuste `{ uid: ... }` para o nome real do parâmetro usado no projeto. **Não invente** — copie o do consumidor existente.

- [ ] **Step 4: Deploy e validar autorização**

```bash
supabase functions deploy manage-whatsapp-instances
```

Valide as três respostas:

| Chamada | Esperado |
|---|---|
| sem `Authorization` | **401** do gateway (`verify_jwt = true`) |
| JWT de `owner`/`gerente` | **403** com "Acesso restrito a administradores da plataforma." |
| JWT de `platform_admin`, `{"action":"list_instances"}` | **200** com `{"instances":[]}` |

O terceiro é o **controle positivo**: sem ele, um 403 universal por EF quebrada passaria como "autorização funcionando".

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add supabase/functions/manage-whatsapp-instances/index.ts supabase/config.toml
git commit -m "feat(6b): EF de inventario — leitura com projecao explicita e guard de platform_admin"
```

---

## Task 15: `manage-whatsapp-instances` — ações administrativas de escrita

**Files:**
- Modify: `supabase/functions/manage-whatsapp-instances/index.ts`

**Interfaces:**
- Consumes: `assertProvisioningAllowed`, `canTransition`, `validateProviderInstanceRef` (Task 2); `nextDueFromAnchor` (Task 1); `todayBrt` de `_shared/billing-delinquency-core.ts`.
- Produces: as actions `register_instance`, `update_instance`, `confirm_cycle_date`, `set_cost`, `request_cancellation`, `confirm_end`, `reactivate`.

**Regra transversal desta task:** **toda** ação que altere fato financeiro, data, vínculo ou estado exige `reason` **na própria requisição**, com autoria, valor anterior e valor novo. Motivo não é campo opcional preenchido depois, e não depende do trigger genérico de auditoria.

- [ ] **Step 1: Acrescentar os imports e o helper de motivo**

No topo de `supabase/functions/manage-whatsapp-instances/index.ts`:

```ts
import {
  assertProvisioningAllowed,
  canTransition,
  validateProviderInstanceRef,
  type LifecycleState,
  type ProvisioningIntent,
} from "../_shared/whatsapp-instance-core.ts";
import { nextDueFromAnchor } from "../_shared/whatsapp-instance-cycle-core.ts";
import { todayBrt } from "../_shared/billing-delinquency-core.ts";
```

E, junto dos helpers:

```ts
const MIN_REASON_LENGTH = 5;

/** Motivo é obrigatório NA PRÓPRIA ação. String vazia ou " " não passa. */
function requireReason(body: Record<string, unknown>): string | null {
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  return reason.length >= MIN_REASON_LENGTH ? reason : null;
}
```

- [ ] **Step 2: Acrescentar as sete actions**

Dentro do `serve`, antes do `return json({ error: "Ação desconhecida." }, 400)`:

```ts
    // ── Registro de instância ────────────────────────────────────────────
    // `intent` é EXPLÍCITO e obrigatório: a EF não adivinha se é backfill de
    // algo que já existe no fornecedor ou criação nova. Ausente ou
    // irreconhecível vira AMBIGUOUS, que o núcleo bloqueia (fail-closed).
    if (action === "register_instance") {
      const rawIntent = String(body?.intent ?? "");
      const intent: ProvisioningIntent =
        rawIntent === "BACKFILL_EXISTING" || rawIntent === "NEW_PROVISION"
          ? (rawIntent as ProvisioningIntent)
          : "AMBIGUOUS";

      const gate = assertProvisioningAllowed(intent);
      if (gate.ok === false) return json({ error: gate.message, code: gate.code }, 409);

      const reason = requireReason(body);
      if (!reason) return json({ error: "Informe o motivo do registro." }, 400);

      const orgId = String(body?.organization_id ?? "");
      if (!orgId) return json({ error: "organization_id é obrigatório." }, 400);

      let ref: string | null = null;
      if (body?.provider_instance_ref) {
        const v = validateProviderInstanceRef(String(body.provider_instance_ref));
        if (v.ok === false) return json({ error: v.message, code: v.code }, 400);
        ref = v.value;
      }

      // Backfill NASCE em UNKNOWN quando a data não for confirmada: data
      // ausente não vira vencimento inventado, vira fila de revisão (§6.2).
      const { data, error } = await supabase
        .from("whatsapp_instances")
        .insert({
          organization_id: orgId,
          unit_id: body?.unit_id ?? null,
          channel_id: body?.channel_id ?? null,
          provider: String(body?.provider ?? "zapi"),
          provider_instance_ref: ref,
          lifecycle_state: "ACTIVE",
          cycle_source: "UNKNOWN",
          current_monthly_cost_cents: body?.current_monthly_cost_cents ?? null,
          cost_source: body?.cost_source ?? null,
          cost_updated_at: body?.current_monthly_cost_cents == null ? null : new Date().toISOString(),
          cost_updated_by: body?.current_monthly_cost_cents == null ? null : admin.userId,
          notes: reason,
          created_by: admin.userId,
          updated_by: admin.userId,
        })
        .select(INSTANCE_COLUMNS)
        .single();

      if (error) {
        // 23505 = a instância física já está registrada (índice por
        // provider+ref) ou o canal já aponta para outra instância.
        if (error.code === "23505") {
          return json({ error: "Esta instância ou este canal já está registrado." }, 409);
        }
        jsonLog("error", { reqId, evt: "wa_instance_register_failed", err: error.message });
        return json({ error: "Não foi possível registrar a instância." }, 500);
      }

      jsonLog("info", { reqId, evt: "wa_instance_registered", instanceId: data.id, intent });
      return json({ instance: data });
    }

    // ── Confirmação da data do ciclo ─────────────────────────────────────
    // Transacional na prática: cria o ciclo OPEN, projeta na instância e
    // resolve a pendência DATE_REVIEW_REQUIRED. Só aqui `cycle_source` vira
    // ADMIN_CONFIRMED e o D-7/D-1 daquele ciclo em diante é liberado.
    if (action === "confirm_cycle_date") {
      const reason = requireReason(body);
      if (!reason) return json({ error: "Informe a origem da informação da data." }, 400);

      const id = String(body?.instance_id ?? "");
      const cycleStart = String(body?.cycle_start ?? "");
      const anchorDay = Number(body?.provider_cycle_anchor_day);

      if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(cycleStart)) {
        return json({ error: "Informe a instância e a data de início do ciclo." }, 400);
      }
      // A âncora é PERSISTIDA e nunca re-derivada: 31/01 → 28/02 → 31/03 só
      // funciona porque o 31 original sobrevive ao clamp (§6.3). Quando a data
      // cai em 28, 29 ou 30, o painel PEDE a âncora explícita em vez de
      // adivinhar — por isso ela é obrigatória aqui.
      if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
        return json({ error: "Informe o dia-âncora do ciclo (1 a 31)." }, 400);
      }

      const dueOn = nextDueFromAnchor(cycleStart, anchorDay);

      const { error: cycleErr } = await supabase.from("whatsapp_instance_cycles").insert({
        instance_id: id,
        organization_id: String(body?.organization_id ?? ""),
        cycle_start: cycleStart,
        provider_due_on: dueOn,
        status: "OPEN",
        notes: reason,
        created_by: admin.userId,
      });
      if (cycleErr && cycleErr.code !== "23505") {
        jsonLog("error", { reqId, evt: "wa_cycle_confirm_failed", err: cycleErr.message });
        return json({ error: "Não foi possível registrar o ciclo." }, 500);
      }

      const { data, error } = await supabase
        .from("whatsapp_instances")
        .update({
          provider_cycle_anchor_day: anchorDay,
          current_cycle_started_on: cycleStart,
          current_cycle_due_on: dueOn,
          cycle_source: "ADMIN_CONFIRMED",
          updated_by: admin.userId,
        })
        .eq("id", id)
        .select(INSTANCE_COLUMNS)
        .single();
      if (error) {
        jsonLog("error", { reqId, evt: "wa_cycle_project_failed", err: error.message });
        return json({ error: "Ciclo registrado, mas a projeção falhou. Verifique o painel." }, 500);
      }

      // A pendência de data deixa de existir — RESOLVIDA, nunca apagada: o
      // histórico de alerta é registro administrativo.
      await supabase.from("whatsapp_instance_alerts")
        .update({ status: "RESOLVED", resolved_at: new Date().toISOString(),
                  resolved_by: admin.userId, resolution_note: "Data confirmada pelo administrador." })
        .eq("instance_id", id).eq("alert_type", "DATE_REVIEW_REQUIRED")
        .in("status", ["OPEN", "ACKNOWLEDGED"]);

      return json({ instance: data });
    }

    // ── Custo ────────────────────────────────────────────────────────────
    // Muda SÓ ciclos futuros: o custo do ciclo corrente foi congelado na
    // abertura e representa a competência que já começou.
    if (action === "set_cost") {
      const reason = requireReason(body);
      if (!reason) return json({ error: "Informe o motivo e a procedência do custo." }, 400);

      const id = String(body?.instance_id ?? "");
      const cents = body?.current_monthly_cost_cents;
      if (!id) return json({ error: "instance_id é obrigatório." }, 400);
      if (cents !== null && (!Number.isInteger(cents) || cents < 0)) {
        return json({ error: "Custo deve ser inteiro em centavos, ou nulo se desconhecido." }, 400);
      }

      const { data, error } = await supabase
        .from("whatsapp_instances")
        .update({
          current_monthly_cost_cents: cents,
          cost_source: cents === null ? null : String(body?.cost_source ?? "ADMIN_INFORMED"),
          cost_updated_at: cents === null ? null : new Date().toISOString(),
          cost_updated_by: cents === null ? null : admin.userId,
          cost_note: reason,
          updated_by: admin.userId,
        })
        .eq("id", id)
        .select(INSTANCE_COLUMNS)
        .single();
      if (error) {
        jsonLog("error", { reqId, evt: "wa_cost_update_failed", err: error.message });
        return json({ error: "Não foi possível atualizar o custo." }, 500);
      }
      return json({ instance: data });
    }

    // ── Cancelamento: congela no ato ─────────────────────────────────────
    // NÃO altera assinatura, billing_status, entitlement, envio, canal nem
    // credencial. Registra o término planejado do CUSTO — nada mais.
    if (action === "request_cancellation") {
      const reason = requireReason(body);
      if (!reason) return json({ error: "Informe o motivo do cancelamento." }, 400);

      const id = String(body?.instance_id ?? "");
      const until = String(body?.provider_access_until ?? "");
      if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
        return json({ error: "Informe a instância e a data-limite de acesso." }, 400);
      }

      const { data: cur, error: curErr } = await supabase
        .from("whatsapp_instances").select("lifecycle_state").eq("id", id).maybeSingle();
      if (curErr || !cur) return json({ error: "Instância não encontrada." }, 404);

      const t = canTransition(cur.lifecycle_state as LifecycleState, "CANCELLATION_REQUESTED",
        { hasProviderEvidence: false });
      if (t.ok === false) return json({ error: t.message, code: t.code }, 409);

      const { data, error } = await supabase
        .from("whatsapp_instances")
        .update({
          lifecycle_state: "CANCELLATION_REQUESTED",
          cancellation_requested_at: new Date().toISOString(),
          cancellation_requested_by: admin.userId,
          cancellation_reason: reason,
          // Congelado. O worker NÃO recalcula isto a cada execução.
          provider_access_until: until,
          updated_by: admin.userId,
        })
        .eq("id", id)
        .select(INSTANCE_COLUMNS)
        .single();
      if (error) {
        jsonLog("error", { reqId, evt: "wa_cancel_failed", err: error.message });
        return json({ error: "Não foi possível registrar o cancelamento." }, 500);
      }
      jsonLog("info", { reqId, evt: "wa_cancellation_requested", instanceId: id });
      return json({ instance: data });
    }

    // ── Confirmação humana do encerramento (§8.2) ────────────────────────
    if (action === "confirm_end") {
      const reason = requireReason(body);
      if (!reason) return json({ error: "Descreva o que foi verificado no painel do fornecedor." }, 400);

      const id = String(body?.instance_id ?? "");
      const { data: cur } = await supabase
        .from("whatsapp_instances").select("lifecycle_state").eq("id", id).maybeSingle();
      if (!cur) return json({ error: "Instância não encontrada." }, 404);

      const t = canTransition(cur.lifecycle_state as LifecycleState, "ENDED",
        { hasProviderEvidence: true });
      if (t.ok === false) return json({ error: t.message, code: t.code }, 409);

      const { data, error } = await supabase
        .from("whatsapp_instances")
        .update({
          lifecycle_state: "ENDED",
          ended_at: new Date().toISOString(),
          ended_by: admin.userId,
          end_confirmation_note: reason,
          // Encerrada não guarda vínculo de canal: libera o índice único para
          // uma instância futura no mesmo canal (§3.2).
          channel_id: null,
          updated_by: admin.userId,
        })
        .eq("id", id)
        .select(INSTANCE_COLUMNS)
        .single();
      if (error) {
        jsonLog("error", { reqId, evt: "wa_confirm_end_failed", err: error.message });
        return json({ error: "Não foi possível confirmar o encerramento." }, 500);
      }
      return json({ instance: data });
    }

    // ── Reversão do cancelamento, só com evidência ───────────────────────
    if (action === "reactivate") {
      const reason = requireReason(body);
      if (!reason) return json({ error: "Descreva a evidência de que o cancelamento foi desfeito." }, 400);

      const id = String(body?.instance_id ?? "");
      const { data: cur } = await supabase
        .from("whatsapp_instances").select("lifecycle_state").eq("id", id).maybeSingle();
      if (!cur) return json({ error: "Instância não encontrada." }, 404);

      // ENDED nunca volta: o núcleo recusa mesmo com evidência. Instância
      // encerrada que reapareça exige linha NOVA (outra instância física) ou
      // reativação administrativa fora deste caminho.
      const t = canTransition(cur.lifecycle_state as LifecycleState, "ACTIVE",
        { hasProviderEvidence: true });
      if (t.ok === false) return json({ error: t.message, code: t.code }, 409);

      const { data, error } = await supabase
        .from("whatsapp_instances")
        .update({
          lifecycle_state: "ACTIVE",
          cancellation_requested_at: null,
          cancellation_reason: null,
          provider_access_until: null,
          end_confirmation_required_at: null,
          notes: reason,
          updated_by: admin.userId,
        })
        .eq("id", id)
        .select(INSTANCE_COLUMNS)
        .single();
      if (error) {
        jsonLog("error", { reqId, evt: "wa_reactivate_failed", err: error.message });
        return json({ error: "Não foi possível reverter o cancelamento." }, 500);
      }
      return json({ instance: data });
    }

    // ── Vínculo e metadados ──────────────────────────────────────────────
    if (action === "update_instance") {
      const reason = requireReason(body);
      if (!reason) return json({ error: "Informe o motivo da alteração." }, 400);

      const id = String(body?.instance_id ?? "");
      const patch: Record<string, unknown> = { updated_by: admin.userId, notes: reason };
      if ("unit_id" in body) patch.unit_id = body.unit_id ?? null;
      if ("channel_id" in body) patch.channel_id = body.channel_id ?? null;
      if ("planned_provision_on" in body) patch.planned_provision_on = body.planned_provision_on ?? null;
      if ("provider_instance_ref" in body) {
        if (body.provider_instance_ref === null) patch.provider_instance_ref = null;
        else {
          const v = validateProviderInstanceRef(String(body.provider_instance_ref));
          if (v.ok === false) return json({ error: v.message, code: v.code }, 400);
          patch.provider_instance_ref = v.value;
        }
      }

      const { data, error } = await supabase
        .from("whatsapp_instances").update(patch).eq("id", id)
        .select(INSTANCE_COLUMNS).single();
      if (error) {
        if (error.code === "23505") return json({ error: "Este canal já está vinculado a outra instância." }, 409);
        // A trigger de tenant devolve check_violation com mensagem própria.
        if (error.code === "23514") return json({ error: "Unidade ou canal pertence a outra organização." }, 409);
        jsonLog("error", { reqId, evt: "wa_instance_update_failed", err: error.message });
        return json({ error: "Não foi possível atualizar a instância." }, 500);
      }
      return json({ instance: data });
    }
```

- [ ] **Step 3: Deploy e validar o gate na prática**

```bash
supabase functions deploy manage-whatsapp-instances
```

Com JWT de `platform_admin`, confirme:

| Requisição | Esperado |
|---|---|
| `{"action":"register_instance","intent":"NEW_PROVISION",...}` | **409** com código `NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A` |
| `{"action":"register_instance"}` sem `intent` | **409**, mesmo código (ambiguidade bloqueia) |
| `{"action":"register_instance","intent":"BACKFILL_EXISTING","organization_id":"<org de teste>","reason":"backfill de teste"}` | **200** — **controle positivo** |
| qualquer action de escrita sem `reason` | **400** |
| `{"action":"update_instance","instance_id":"<x>","unit_id":"<unidade de outra org>","reason":"teste"}` | **409** "pertence a outra organização" |

**Nenhuma dessas validações usa Ren Sushi nem Moralles como fixture.** Limpe as linhas de teste ao final.

- [ ] **Step 4: Commit**

```bash
npm run typecheck
git add supabase/functions/manage-whatsapp-instances/index.ts
git commit -m "feat(6b): acoes administrativas com motivo obrigatorio e gate de provisionamento"
```

---

## Task 16: `manage-whatsapp-instances` — reconhecer e resolver alerta

**Files:**
- Modify: `supabase/functions/manage-whatsapp-instances/index.ts`

**Interfaces:**
- Consumes: `whatsapp_instance_alerts`.
- Produces: as actions `acknowledge_alert` e `resolve_alert`.

- [ ] **Step 1: Acrescentar as duas actions**

```ts
    // ACKNOWLEDGED interrompe o LEMBRETE, não fecha o fato. RESOLVED diz que o
    // fato deixou de existir. Fato que desaparece sozinho é resolvido pelo
    // worker com nota do sistema — NUNCA apagado: o histórico de alerta é
    // registro administrativo.
    if (action === "acknowledge_alert") {
      const id = String(body?.alert_id ?? "");
      if (!id) return json({ error: "alert_id é obrigatório." }, 400);

      const { data, error } = await supabase
        .from("whatsapp_instance_alerts")
        .update({
          status: "ACKNOWLEDGED",
          acknowledged_at: new Date().toISOString(),
          acknowledged_by: admin.userId,
        })
        .eq("id", id)
        .eq("status", "OPEN")
        .select(ALERT_COLUMNS)
        .maybeSingle();
      if (error) {
        jsonLog("error", { reqId, evt: "wa_alert_ack_failed", err: error.message });
        return json({ error: "Não foi possível reconhecer o alerta." }, 500);
      }
      if (!data) return json({ error: "Alerta não está aberto." }, 409);
      return json({ alert: data });
    }

    if (action === "resolve_alert") {
      const note = requireReason(body);
      if (!note) return json({ error: "Informe o motivo da resolução." }, 400);

      const id = String(body?.alert_id ?? "");
      if (!id) return json({ error: "alert_id é obrigatório." }, 400);

      const { data, error } = await supabase
        .from("whatsapp_instance_alerts")
        .update({
          status: "RESOLVED",
          resolved_at: new Date().toISOString(),
          resolved_by: admin.userId,
          resolution_note: note,
        })
        .eq("id", id)
        .in("status", ["OPEN", "ACKNOWLEDGED"])
        .select(ALERT_COLUMNS)
        .maybeSingle();
      if (error) {
        jsonLog("error", { reqId, evt: "wa_alert_resolve_failed", err: error.message });
        return json({ error: "Não foi possível resolver o alerta." }, 500);
      }
      if (!data) return json({ error: "Alerta já foi encerrado." }, 409);
      return json({ alert: data });
    }
```

- [ ] **Step 2: Deploy e validar**

```bash
supabase functions deploy manage-whatsapp-instances
```

Sem alertas ainda no banco, valide o caminho de erro: `{"action":"acknowledge_alert","alert_id":"<uuid inexistente>"}` → **409** "Alerta não está aberto.". O controle positivo desta task acontece na Task 18, quando o worker produzir o primeiro alerta.

- [ ] **Step 3: Commit**

```bash
npm run typecheck
git add supabase/functions/manage-whatsapp-instances/index.ts
git commit -m "feat(6b): reconhecer e resolver alerta sem apagar historico"
```

---

## Task 17: Worker `process-whatsapp-instance-cycles` — rolagem, D-7 e D-1

**Files:**
- Create: `supabase/functions/process-whatsapp-instance-cycles/index.ts`

**Interfaces:**
- Consumes: `_shared/security.ts` (`requireInternalAuth`, `genRequestId`, `jsonLog`), `todayBrt` de `_shared/billing-delinquency-core.ts`, os núcleos das Tasks 1, 3, 4 e a RPC da Task 10.
- Produces:
  ```ts
  // internas, consumidas pela Task 18 no mesmo arquivo:
  type StepSummary = { step: string; processed: number; failed: number };
  async function upsertAlert(a: { subjectType, subjectId, organizationId, instanceId, channelId, alertType, dedupeKey, payload }): Promise<"created" | "reminded" | "seen" | "failed">
  ```

- [ ] **Step 1: Escrever o worker com os três primeiros passos**

`supabase/functions/process-whatsapp-instance-cycles/index.ts`:

```ts
// Worker do calendário do FORNECEDOR (Fase 6b). pg_cron 12:10 UTC (09:10 BRT).
//
// UM worker e não vários porque os cinco passos leem o mesmo conjunto de
// instâncias e ciclos: separá-los faria três varreduras da mesma tabela
// decidindo sobre estados que o passo anterior acabou de mudar.
//
// NUNCA CHAMA A Z-API. Não importa cliente do provedor e não faz fetch
// externo — divergência aqui é comparação entre fatos já persistidos. A
// chamada real ao fornecedor continua exclusiva do caminho acionado por
// humano (manage-channels action `test`, whatsapp-health).
//
// NÃO ESCREVE em organizations.billing_status, billing_subscriptions,
// organization_entitlement_overrides nem whatsapp_channels.
//
// Responde 200 com o resumo por passo MESMO com falha parcial: pg_net é
// fire-and-forget e não faz retry por status, então 500 não recuperaria nada e
// apagaria o resumo. O sinal de falha é a TELEMETRIA, não o código HTTP.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalAuth, genRequestId, jsonLog } from "../_shared/security.ts";
import { todayBrt } from "../_shared/billing-delinquency-core.ts";
import { nextDueFromAnchor, daysUntil } from "../_shared/whatsapp-instance-cycle-core.ts";
import { attributeRevenue, grossMarginCents } from "../_shared/whatsapp-instance-revenue-core.ts";
import {
  EVENT_TYPE_BY_ALERT,
  resolveD1Reasons,
  shouldEmitD7,
  shouldEmitD1,
  dedupeKeyD7,
  dedupeKeyD1,
  type AlertType,
} from "../_shared/whatsapp-instance-alerts-core.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const REMINDER_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // mensal, não diário

type StepSummary = { step: string; processed: number; failed: number };

let reqId = "";

/**
 * Cria o alerta ou incrementa o existente. O ledger é INDEPENDENTE da fila de
 * e-mail: com billing_notifications_dispatch OFF o alerta continua registrado,
 * e `dispatch_enabled_at_enqueue` diz se havia envio no momento — para que
 * ninguém leia "não recebi e-mail" como "não houve alerta".
 *
 * Lembrete REEMITE e incrementa `occurrences`; não cria linha nova. Cadência
 * MENSAL e não diária pela mesma razão que descartou o alerta diário na janela
 * dos 7 dias: aviso diário treina o administrador a ignorar.
 */
async function upsertAlert(a: {
  subjectType: "INSTANCE" | "ORGANIZATION";
  subjectId: string;
  organizationId: string;
  instanceId: string | null;
  channelId: string | null;
  alertType: AlertType;
  dedupeKey: string;
  payload: Record<string, unknown>;
}): Promise<"created" | "reminded" | "seen" | "failed"> {
  const nowIso = new Date().toISOString();

  const { data: existing, error: selErr } = await supabase
    .from("whatsapp_instance_alerts")
    .select("id, status, occurrences, last_reminder_at")
    .eq("subject_type", a.subjectType)
    .eq("subject_id", a.subjectId)
    .eq("alert_type", a.alertType)
    .eq("dedupe_key", a.dedupeKey)
    .maybeSingle();

  if (selErr) {
    jsonLog("error", { reqId, evt: "wa_alert_lookup_failed", alertType: a.alertType, err: selErr.message, needsAdminAction: true });
    return "failed";
  }

  if (!existing) {
    const { error } = await supabase.from("whatsapp_instance_alerts").insert({
      subject_type: a.subjectType,
      subject_id: a.subjectId,
      organization_id: a.organizationId,
      instance_id: a.instanceId,
      channel_id: a.channelId,
      alert_type: a.alertType,
      dedupe_key: a.dedupeKey,
      status: "OPEN",
      payload: a.payload,
      dispatch_enabled_at_enqueue: false, // flag OFF nesta fase; o painel é a superfície viva
    });
    // 23505 = outra execução criou entre o SELECT e o INSERT. Dedupe silencioso.
    if (error && error.code !== "23505") {
      jsonLog("error", { reqId, evt: "wa_alert_insert_failed", alertType: a.alertType, err: error.message, needsAdminAction: true });
      return "failed";
    }
    return error ? "seen" : "created";
  }

  if (existing.status !== "OPEN") return "seen";

  const last = existing.last_reminder_at ? Date.parse(existing.last_reminder_at) : 0;
  const due = Date.now() - last >= REMINDER_INTERVAL_MS;

  const { error: updErr } = await supabase
    .from("whatsapp_instance_alerts")
    .update({
      last_seen_at: nowIso,
      occurrences: existing.occurrences + (due ? 1 : 0),
      last_reminder_at: due ? nowIso : existing.last_reminder_at,
    })
    .eq("id", existing.id);

  if (updErr) {
    jsonLog("error", { reqId, evt: "wa_alert_touch_failed", alertType: a.alertType, err: updErr.message, needsAdminAction: true });
    return "failed";
  }
  return due ? "reminded" : "seen";
}

/** Passo 1 — rolagem. PRECEDE tudo: muda as datas que os passos 2-3 leem. */
async function stepRollCycles(today: string): Promise<StepSummary> {
  const s: StepSummary = { step: "roll_cycles", processed: 0, failed: 0 };

  const { data: rows, error } = await supabase
    .from("whatsapp_instances")
    .select("id, provider_cycle_anchor_day, current_cycle_due_on, cycle_source")
    .in("lifecycle_state", ["ACTIVE", "CANCELLATION_REQUESTED"])
    .not("current_cycle_due_on", "is", null)
    .lte("current_cycle_due_on", today);

  if (error) {
    jsonLog("error", { reqId, evt: "wa_roll_query_failed", err: error.message, needsAdminAction: true });
    s.failed++;
    return s;
  }

  for (const r of rows ?? []) {
    // Falha em UMA instância não aborta as demais.
    try {
      if (!r.provider_cycle_anchor_day) {
        // Sem âncora não há rolagem honesta — a pendência de data já existe.
        jsonLog("warn", { reqId, evt: "wa_roll_skipped_no_anchor", instanceId: r.id });
        continue;
      }
      // A aritmética vem do núcleo puro; a RPC só persiste.
      const nextDue = nextDueFromAnchor(r.current_cycle_due_on, r.provider_cycle_anchor_day);
      const { data, error: rpcErr } = await supabase.rpc("roll_whatsapp_instance_cycle", {
        p_instance_id: r.id,
        p_today: today,
        p_next_due_on: nextDue,
      });
      if (rpcErr) {
        jsonLog("error", { reqId, evt: "wa_roll_failed", instanceId: r.id, err: rpcErr.message, needsAdminAction: true });
        s.failed++;
        continue;
      }
      s.processed++;
      jsonLog("info", { reqId, evt: "wa_roll_done", instanceId: r.id, action: data?.[0]?.action });
    } catch (e) {
      jsonLog("error", { reqId, evt: "wa_roll_exception", instanceId: r.id, err: String(e), needsAdminAction: true });
      s.failed++;
    }
  }
  return s;
}

/** Passos 2 e 3 — D-7 sempre, D-1 condicional. D-3 não existe: três avisos
 *  para a mesma data é a cadência que produz cegueira. */
async function stepCycleAlerts(today: string): Promise<StepSummary[]> {
  const d7: StepSummary = { step: "alerts_d7", processed: 0, failed: 0 };
  const d1: StepSummary = { step: "alerts_d1", processed: 0, failed: 0 };

  const { data: rows, error } = await supabase
    .from("whatsapp_instances")
    .select("id, organization_id, channel_id, lifecycle_state, cycle_source, current_cycle_started_on, current_cycle_due_on, current_monthly_cost_cents, cancellation_requested_at, provider_access_until")
    .in("lifecycle_state", ["ACTIVE", "CANCELLATION_REQUESTED"])
    .not("current_cycle_due_on", "is", null);

  if (error) {
    jsonLog("error", { reqId, evt: "wa_alerts_query_failed", err: error.message, needsAdminAction: true });
    d7.failed++;
    return [d7, d1];
  }

  for (const r of rows ?? []) {
    try {
      // cycle_source UNKNOWN não emite D-7/D-1: a instância está na fila de
      // revisão de data e nenhum aviso pode AFIRMAR uma data que ninguém
      // confirmou (§6.2).
      if (r.cycle_source === "UNKNOWN") continue;

      const days = daysUntil(r.current_cycle_due_on, today);

      if (shouldEmitD7(days)) {
        const res = await upsertAlert({
          subjectType: "INSTANCE",
          subjectId: r.id,
          organizationId: r.organization_id,
          instanceId: r.id,
          channelId: null,
          alertType: "CYCLE_DUE_SOON",
          dedupeKey: dedupeKeyD7(r.current_cycle_started_on),
          payload: { days_until_due: days, due_on: r.current_cycle_due_on },
        });
        if (res === "failed") d7.failed++;
        else d7.processed++;
      }

      // Receita atribuída para saber se "receita NULL" é lacuna ou caso previsto.
      const revenue = await resolveRevenueForOrg(r.organization_id);
      const reasons = resolveD1Reasons({
        costCents: r.current_monthly_cost_cents,
        hasOpenDivergence: await hasOpenDivergence(r.id),
        cancellationIntendedNotRegistered:
          r.lifecycle_state === "CANCELLATION_REQUESTED" && !r.provider_access_until,
        revenueSource: revenue.revenueSource,
        customerRevenueCents: revenue.customerRevenueCents,
      });

      if (shouldEmitD1(days, reasons)) {
        const res = await upsertAlert({
          subjectType: "INSTANCE",
          subjectId: r.id,
          organizationId: r.organization_id,
          instanceId: r.id,
          channelId: null,
          alertType: "CYCLE_DUE_TOMORROW",
          dedupeKey: dedupeKeyD1(r.current_cycle_started_on, reasons),
          payload: { days_until_due: days, reasons },
        });
        if (res === "failed") d1.failed++;
        else d1.processed++;
      }
    } catch (e) {
      jsonLog("error", { reqId, evt: "wa_alerts_exception", instanceId: r.id, err: String(e), needsAdminAction: true });
      d7.failed++;
    }
  }
  return [d7, d1];
}

async function hasOpenDivergence(instanceId: string): Promise<boolean> {
  const { data } = await supabase
    .from("whatsapp_instance_alerts")
    .select("id")
    .eq("instance_id", instanceId)
    .eq("alert_type", "DIVERGENCE")
    .in("status", ["OPEN", "ACKNOWLEDGED"])
    .limit(1);
  return (data ?? []).length > 0;
}

/** Receita da organização segundo a política de §7.3. Não escreve nada. */
async function resolveRevenueForOrg(organizationId: string) {
  const [{ count }, sub, override] = await Promise.all([
    supabase.from("whatsapp_instances").select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId).eq("lifecycle_state", "ACTIVE"),
    supabase.from("billing_subscriptions").select("amount_cents")
      .eq("organization_id", organizationId).eq("status", "active").maybeSingle(),
    supabase.from("organization_entitlement_overrides").select("id")
      .eq("organization_id", organizationId).eq("feature", "whatsapp")
      .eq("grant_type", "LIFETIME").eq("enabled", true).is("revoked_at", null).maybeSingle(),
  ]);

  return attributeRevenue({
    activeInstanceCount: count ?? 0,
    subscriptionAmountCents: sub.data?.amount_cents ?? null,
    hasLifetimeWhatsappOverride: !!override.data,
  });
}

serve(async (req) => {
  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  reqId = genRequestId();
  const today = todayBrt();
  jsonLog("info", { reqId, evt: "wa_instance_cycles_start", today });

  const steps: StepSummary[] = [];
  let lockHeld = false;

  try {
    // Lock economiza trabalho; NÃO é o invariante. A correção vem da RPC
    // transacional + os dois UNIQUE. Falha aberta é aceitável.
    const { data: got } = await supabase.rpc("try_whatsapp_instance_cycles_lock");
    lockHeld = got === true;
    if (!lockHeld) jsonLog("warn", { reqId, evt: "wa_lock_not_acquired" });

    // Falha em um passo NÃO aborta os seguintes.
    steps.push(await stepRollCycles(today));
    steps.push(...(await stepCycleAlerts(today)));
    // Passos 4 e 5 entram na Task 18.

    jsonLog("info", { reqId, evt: "wa_instance_cycles_done", steps });
    return new Response(JSON.stringify({ success: true, today, steps }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    jsonLog("error", { reqId, evt: "wa_instance_cycles_error", err: String(err), steps, needsAdminAction: true });
    // 200 mesmo assim: o resumo por passo é mais útil que um 500 que pg_net
    // ignora.
    return new Response(JSON.stringify({ success: false, today, steps }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    if (lockHeld) {
      await supabase.rpc("release_whatsapp_instance_cycles_lock").catch(() => {});
    }
  }
});
```

- [ ] **Step 2: Conferir os nomes reais das colunas consultadas**

O `resolveRevenueForOrg` toca duas tabelas de outra fase. **Confirme antes de deployar** — se algum nome divergir, ajuste o código, não invente:

```bash
grep -rn "amount_cents\|unit_amount_cents" supabase/migrations/*billing_subscriptions* | head -5
grep -rn "create table.*organization_entitlement_overrides" -A 20 supabase/migrations/ | head -30
```
Confirmado contra o schema real: `billing_subscriptions` **não tem coluna de valor** — o preço vem de `billing_plans.amount_cents` via `billing_plan_id`, e o filtro é `category = 'WHATSAPP_SUBSCRIPTION'`. Em `organization_entitlement_overrides` a coluna é **`grant_type`**, não `override_type`, e o override vivo exige `enabled = true` e `revoked_at is null`.

- [ ] **Step 3: Deploy sem cron**

```bash
supabase functions deploy process-whatsapp-instance-cycles
```

**O cron ainda não existe** — isso é deliberado (passo 12 do rollout).

- [ ] **Step 4: Execução manual controlada, com o banco ainda vazio**

```bash
curl -s -X POST "$SUPABASE_URL/functions/v1/process-whatsapp-instance-cycles" \
  -H "x-internal-key: $INTERNAL_API_KEY" -H "Content-Type: application/json" -d '{}'
```
Expected: `{"success":true,"today":"YYYY-MM-DD","steps":[{"step":"roll_cycles","processed":0,"failed":0},{"step":"alerts_d7",...},{"step":"alerts_d1",...}]}`

Confirme no log que **não há** `needsAdminAction: true` e que nenhuma linha foi criada em `whatsapp_instance_alerts`.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add supabase/functions/process-whatsapp-instance-cycles/index.ts
git commit -m "feat(6b): worker — rolagem transacional, D-7 sempre e D-1 condicional"
```

---

## Task 18: Worker — confirmação de encerramento, divergências e desequilíbrio

**Files:**
- Modify: `supabase/functions/process-whatsapp-instance-cycles/index.ts`

**Interfaces:**
- Consumes: `upsertAlert`, `resolveRevenueForOrg` (Task 17); `detectChannelWithoutInstance`, `detectInstanceDivergences` (Task 5); `consolidateOrgMargin`, `economicImbalanceHash`, `dedupeKeyEndConfirmation`, `dedupeKeyCostUnknown`, `dedupeKeyEconomicImbalance`.
- Produces: `stepEndConfirmation`, `stepDivergences`, `stepCostUnknown` — e o resumo completo dos cinco passos.

- [ ] **Step 1: Acrescentar os imports**

```ts
import {
  detectChannelWithoutInstance,
  detectInstanceDivergences,
  type InstanceRow,
} from "../_shared/whatsapp-instance-divergence-core.ts";
import { consolidateOrgMargin } from "../_shared/whatsapp-instance-revenue-core.ts";
import {
  economicImbalanceHash,
  dedupeKeyEndConfirmation,
  dedupeKeyCostUnknown,
  dedupeKeyDateReview,
  dedupeKeyEconomicImbalance,
} from "../_shared/whatsapp-instance-alerts-core.ts";
```

- [ ] **Step 2: Acrescentar os passos 4 e 5**

```ts
/** Passo 4 — "worker propõe, admin confirma" (§8.2). O worker NÃO move para
 *  ENDED só porque a data passou: afirmar um encerramento que o fornecedor não
 *  fez é a família do bug 08. */
async function stepEndConfirmation(today: string): Promise<StepSummary> {
  const s: StepSummary = { step: "end_confirmation", processed: 0, failed: 0 };

  const { data: rows, error } = await supabase
    .from("whatsapp_instances")
    .select("id, organization_id, provider_access_until, end_confirmation_required_at")
    .eq("lifecycle_state", "CANCELLATION_REQUESTED")
    .not("provider_access_until", "is", null)
    .lte("provider_access_until", today);

  if (error) {
    jsonLog("error", { reqId, evt: "wa_end_query_failed", err: error.message, needsAdminAction: true });
    s.failed++;
    return s;
  }

  for (const r of rows ?? []) {
    try {
      if (!r.end_confirmation_required_at) {
        const { error: updErr } = await supabase
          .from("whatsapp_instances")
          .update({ end_confirmation_required_at: new Date().toISOString() })
          .eq("id", r.id)
          .is("end_confirmation_required_at", null);
        if (updErr) {
          jsonLog("error", { reqId, evt: "wa_end_stamp_failed", instanceId: r.id, err: updErr.message, needsAdminAction: true });
          s.failed++;
          continue;
        }
      }

      // lifecycle_state PERMANECE CANCELLATION_REQUESTED. Só o admin move.
      const res = await upsertAlert({
        subjectType: "INSTANCE",
        subjectId: r.id,
        organizationId: r.organization_id,
        instanceId: r.id,
        channelId: null,
        alertType: "END_CONFIRMATION_REQUIRED",
        dedupeKey: dedupeKeyEndConfirmation(r.provider_access_until),
        payload: { provider_access_until: r.provider_access_until },
      });
      if (res === "failed") s.failed++;
      else s.processed++;
    } catch (e) {
      jsonLog("error", { reqId, evt: "wa_end_exception", instanceId: r.id, err: String(e), needsAdminAction: true });
      s.failed++;
    }
  }
  return s;
}

/** Passo 5a — divergências passivas. NENHUMA gera ação automática: não altera
 *  lifecycle, não cancela instância, não bloqueia envio, e NENHUMA afirma que
 *  a Z-API continua cobrando. */
async function stepDivergences(today: string): Promise<StepSummary> {
  const s: StepSummary = { step: "divergences", processed: 0, failed: 0 };
  const monthBrt = today.slice(0, 7);

  // (a) Instâncias — quatro dos cinco tipos.
  const { data: instances, error: instErr } = await supabase
    .from("whatsapp_instances")
    .select("id, organization_id, lifecycle_state, channel_id, provider_instance_ref, ended_at, last_synced_at, last_seen_provider_status, notes")
    .neq("lifecycle_state", "AWAITING_PROVISION");

  if (instErr) {
    jsonLog("error", { reqId, evt: "wa_div_inst_query_failed", err: instErr.message, needsAdminAction: true });
    s.failed++;
  }

  for (const r of instances ?? []) {
    try {
      // O identificador LEGADO vive em whatsapp_channels.credentials.instance_id.
      // Extrair SOMENTE o identificador — nunca copiar o objeto de credenciais
      // inteiro, nunca logar, nunca escrever de volta.
      let legacyRef: string | null = null;
      let channelState: string | null = null;
      let channelStateAgeDays: number | null = null;

      if (r.channel_id) {
        const { data: ch } = await supabase
          .from("whatsapp_channels")
          .select("credentials, status, updated_at")
          .eq("id", r.channel_id)
          .maybeSingle();
        if (ch) {
          // jsonb volta como objeto: NUNCA interpolar em template literal.
          const creds = (ch.credentials ?? {}) as Record<string, unknown>;
          const raw = creds["instance_id"];
          legacyRef = typeof raw === "string" && raw.length > 0 ? raw : null;
          channelState = ch.status ?? null;
          channelStateAgeDays = ch.updated_at
            ? Math.floor((Date.now() - Date.parse(ch.updated_at)) / 86400000)
            : null;
        }
      }

      const row: InstanceRow = {
        instanceId: r.id,
        organizationId: r.organization_id,
        lifecycleState: r.lifecycle_state,
        channelId: r.channel_id,
        providerInstanceRef: r.provider_instance_ref,
        legacyChannelInstanceRef: legacyRef,
        channelState,
        channelStateAgeDays,
        hasAdminExplanation: false,
        endedAtIso: r.ended_at,
        lastLocalSignalAtIso: r.last_synced_at,
      };

      for (const f of detectInstanceDivergences(row)) {
        const res = await upsertAlert({
          subjectType: "INSTANCE",
          subjectId: r.id,
          organizationId: f.organizationId,
          instanceId: f.instanceId,
          channelId: f.channelId,
          alertType: "DIVERGENCE",
          dedupeKey: f.dedupeKey,
          // Sem credencial, sem identificador legado, sem payload do provedor.
          payload: { kind: f.kind, detail: f.detail },
        });
        if (res === "failed") s.failed++;
        else s.processed++;

        await supabase.from("whatsapp_instances")
          .update({ last_divergence_kind: f.kind, last_divergence_at: new Date().toISOString() })
          .eq("id", r.id);
      }
    } catch (e) {
      jsonLog("error", { reqId, evt: "wa_div_exception", instanceId: r.id, err: String(e), needsAdminAction: true });
      s.failed++;
    }
  }

  // (b) CHANNEL_WITHOUT_INSTANCE — o custo invisível, o mais caro dos cinco.
  const { data: channels, error: chErr } = await supabase
    .from("whatsapp_channels")
    .select("id, status, unit_id, units!inner(organization_id)");

  if (chErr) {
    jsonLog("error", { reqId, evt: "wa_div_chan_query_failed", err: chErr.message, needsAdminAction: true });
    s.failed++;
    return s;
  }

  const linked = new Set((instances ?? []).map((i) => i.channel_id).filter(Boolean));

  for (const c of channels ?? []) {
    try {
      // Elegibilidade CONSERVADORA: só canal que representa integração real.
      // Canal desativado, de teste ou sem status conhecido NÃO gera alerta —
      // e na ambiguidade a resposta é não inferir, nunca criar inventário.
      const eligible = c.status === "connected" || c.status === "disconnected";
      const orgId = (c as unknown as { units?: { organization_id?: string } }).units?.organization_id;
      if (!orgId) continue;

      const f = detectChannelWithoutInstance({
        channelId: c.id,
        organizationId: orgId,
        isEligibleInventoryChannel: eligible,
        hasLinkedInstance: linked.has(c.id),
        monthBrt,
      });
      if (!f) continue;

      const res = await upsertAlert({
        subjectType: "ORGANIZATION",
        subjectId: f.organizationId,
        organizationId: f.organizationId,
        instanceId: null,
        channelId: f.channelId,
        alertType: "DIVERGENCE",
        dedupeKey: f.dedupeKey,
        payload: { kind: f.kind, detail: f.detail },
      });
      if (res === "failed") s.failed++;
      else s.processed++;
    } catch (e) {
      jsonLog("error", { reqId, evt: "wa_div_chan_exception", channelId: c.id, err: String(e), needsAdminAction: true });
      s.failed++;
    }
  }

  return s;
}

/** Passo 5b — pendências (data e custo) e desequilíbrio econômico da org. */
async function stepEconomics(today: string): Promise<StepSummary> {
  const s: StepSummary = { step: "economics", processed: 0, failed: 0 };
  const monthBrt = today.slice(0, 7);

  // Pendência de DATA: cycle_source UNKNOWN. Ela NÃO gera e-mail (não há
  // event_type para ela, §10.6) — nenhum aviso pode afirmar uma data que
  // ninguém confirmou. A pendência existe para aparecer no painel e ser
  // resolvida por `confirm_cycle_date`. Ausência de data NÃO é erro de
  // implantação, NÃO bloqueia o uso da instância e NÃO gera data padrão.
  const { data: unknownDate } = await supabase
    .from("whatsapp_instances")
    .select("id, organization_id")
    .eq("cycle_source", "UNKNOWN")
    .in("lifecycle_state", ["ACTIVE", "CANCELLATION_REQUESTED"]);

  for (const r of unknownDate ?? []) {
    const res = await upsertAlert({
      subjectType: "INSTANCE",
      subjectId: r.id,
      organizationId: r.organization_id,
      instanceId: r.id,
      channelId: null,
      alertType: "DATE_REVIEW_REQUIRED",
      dedupeKey: dedupeKeyDateReview(r.id),
      payload: { reason: "cycle_source UNKNOWN" },
    });
    if (res === "failed") s.failed++;
    else s.processed++;
  }

  // Ciclo que terminou sem custo informado.
  const { data: pending } = await supabase
    .from("whatsapp_instance_cycles")
    .select("id, instance_id, organization_id, cycle_start")
    .eq("status", "PENDING_REVIEW");

  for (const c of pending ?? []) {
    const res = await upsertAlert({
      subjectType: "INSTANCE",
      subjectId: c.instance_id,
      organizationId: c.organization_id,
      instanceId: c.instance_id,
      channelId: null,
      alertType: "CYCLE_COST_UNKNOWN",
      dedupeKey: dedupeKeyCostUnknown(c.cycle_start),
      payload: { cycle_start: c.cycle_start },
    });
    if (res === "failed") s.failed++;
    else s.processed++;
  }

  // Desequilíbrio pertence à ORGANIZAÇÃO (§10.8).
  const { data: all } = await supabase
    .from("whatsapp_instances")
    .select("id, organization_id, current_monthly_cost_cents")
    .in("lifecycle_state", ["ACTIVE", "CANCELLATION_REQUESTED"]);

  const byOrg = new Map<string, { instanceId: string; costCents: number | null }[]>();
  for (const i of all ?? []) {
    const list = byOrg.get(i.organization_id) ?? [];
    list.push({ instanceId: i.id, costCents: i.current_monthly_cost_cents });
    byOrg.set(i.organization_id, list);
  }

  for (const [orgId, items] of byOrg) {
    try {
      const revenue = await resolveRevenueForOrg(orgId);

      // LIFETIME_OVERRIDE NÃO É ERRO: margem negativa do Ren Sushi é o custo
      // conhecido de uma decisão comercial. Aparece rotulada no painel e nunca
      // vira alerta de anomalia.
      if (revenue.revenueSource === "LIFETIME_OVERRIDE") continue;

      // Receita NULL por ambiguidade é DADO AUSENTE, não prejuízo.
      const isNoEntitlement = revenue.revenueSource === "NO_ENTITLEMENT";
      const cons = consolidateOrgMargin(items.map((i) => i.costCents), revenue.customerRevenueCents);
      const negative = cons.marginCents !== null && cons.marginCents < 0;

      if (!isNoEntitlement && !negative) continue;

      const res = await upsertAlert({
        subjectType: "ORGANIZATION",
        subjectId: orgId,
        organizationId: orgId,
        instanceId: null,
        channelId: null,
        alertType: "ECONOMIC_IMBALANCE",
        dedupeKey: dedupeKeyEconomicImbalance(
          monthBrt,
          economicImbalanceHash(items, revenue.customerRevenueCents),
        ),
        payload: {
          revenue_source: revenue.revenueSource,
          known_cost_cents: cons.knownCostCents,
          unknown_cost_instances: cons.unknownCostInstances,
          margin_cents: cons.marginCents,
        },
      });
      if (res === "failed") s.failed++;
      else s.processed++;
    } catch (e) {
      jsonLog("error", { reqId, evt: "wa_econ_exception", orgId, err: String(e), needsAdminAction: true });
      s.failed++;
    }
  }

  return s;
}
```

E, no `serve`, logo após `steps.push(...(await stepCycleAlerts(today)));`:

```ts
    steps.push(await stepEndConfirmation(today));
    steps.push(await stepDivergences(today));
    steps.push(await stepEconomics(today));
```

- [ ] **Step 3: Conferir a relação canal → organização**

```bash
grep -rn "create table.*whatsapp_channels" -A 25 supabase/migrations/ | head -35
```
Confirme se `whatsapp_channels` tem `unit_id` (e portanto organização via `units`) ou se já carrega `organization_id`. **Ajuste o `select` do passo 5b ao schema real** — o embed `units!inner(organization_id)` só funciona se a FK existir.

- [ ] **Step 4: Deploy e execução manual**

```bash
supabase functions deploy process-whatsapp-instance-cycles
curl -s -X POST "$SUPABASE_URL/functions/v1/process-whatsapp-instance-cycles" \
  -H "x-internal-key: $INTERNAL_API_KEY" -H "Content-Type: application/json" -d '{}'
```
Expected: cinco passos no resumo (`roll_cycles`, `alerts_d7`, `alerts_d1`, `end_confirmation`, `divergences`, `economics`).

**Atenção esperada:** com o inventário ainda vazio e o canal do Ren Sushi existindo, o passo `divergences` deve produzir **exatamente uma** ocorrência de `CHANNEL_WITHOUT_INSTANCE`. Isso é o comportamento correto — é o alerta que o *backfill* da Task 22 vai resolver. Confirme:

```sql
select alert_type, dedupe_key, status, occurrences
  from whatsapp_instance_alerts;
```

- [ ] **Step 5: Verificar que nada proibido foi escrito**

```sql
-- Esperado: nenhuma mudança causada pelo worker.
select id, billing_status, updated_at from organizations order by updated_at desc limit 5;
select id, status, updated_at from billing_subscriptions order by updated_at desc limit 5;
```
E no código:
```bash
grep -n "fetch(\|z-api\|zapi\|api.z-api" supabase/functions/process-whatsapp-instance-cycles/index.ts
```
Expected: **zero** resultados — o worker não faz `fetch` externo e não conhece a Z-API.

- [ ] **Step 6: Commit**

```bash
npm run typecheck
git add supabase/functions/process-whatsapp-instance-cycles/index.ts
git commit -m "feat(6b): worker — confirmacao de encerramento, divergencias e desequilibrio"
```

---

## Task 19: Hooks do painel (`useWhatsappInstances.ts`)

**Files:**
- Create: `src/hooks/useWhatsappInstances.ts`
- Create: `src/lib/whatsapp-instance-format.ts`
- Test: `src/lib/whatsapp-instance-format.test.ts`

**Interfaces:**
- Consumes: `supabase` de `@/integrations/supabase/client`, `grossMarginDisplay` de `supabase/functions/_shared/whatsapp-instance-revenue-core` (import cross-boundary deliberado, mesmo padrão de `whatsapp-implementation-core.ts` — duas fórmulas divergentes é pior que um import fora do padrão).
- Produces:
  ```ts
  export type WhatsappInstance = { id: string; organization_id: string; unit_id: string | null; channel_id: string | null; provider: string; provider_instance_ref: string | null; lifecycle_state: string; provider_cycle_anchor_day: number | null; current_cycle_started_on: string | null; current_cycle_due_on: string | null; cycle_source: string; current_monthly_cost_cents: number | null; provider_access_until: string | null; ended_at: string | null; last_divergence_kind: string | null };
  export function useWhatsappInstances(): UseQueryResult<WhatsappInstance[]>
  export function useWhatsappInstance(id: string | null): UseQueryResult<{ instance; cycles; alerts }>
  export function useWhatsappInstanceAlerts(status?: string): UseQueryResult<WhatsappAlert[]>
  export function useWhatsappInstanceAction(): UseMutationResult<unknown, Error, { action: string; [k: string]: unknown }>
  export function usePartnerSimulation(): UseMutationResult<...>
  // format:
  export function formatCents(cents: number | null): string
  export function formatMargin(revenueCents: number | null, costCents: number | null): string
  export function lastAccessDayLabel(providerAccessUntil: string | null): string | null
  ```

- [ ] **Step 1: Escrever o teste de formatação**

`src/lib/whatsapp-instance-format.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatCents, formatMargin, lastAccessDayLabel } from "./whatsapp-instance-format";

describe("formatCents — desconhecido nunca vira R$ 0,00", () => {
  it("valor conhecido", () => {
    expect(formatCents(14900)).toBe("R$ 149,00");
  });
  it("zero é zero de verdade", () => {
    expect(formatCents(0)).toBe("R$ 0,00");
  });
  it("desconhecido é travessão", () => {
    expect(formatCents(null)).toBe("—");
  });
});

describe("formatMargin — nunca 0% para desconhecido", () => {
  it("receita positiva mostra percentual", () => {
    expect(formatMargin(14900, 10000)).toBe("32,9%");
  });
  it("receita zero é 'não aplicável', não 0%", () => {
    expect(formatMargin(0, 10000)).toBe("não aplicável");
  });
  it("receita desconhecida é 'pendente'", () => {
    expect(formatMargin(null, 10000)).toBe("pendente");
  });
  it("custo desconhecido é 'pendente'", () => {
    expect(formatMargin(14900, null)).toBe("pendente");
  });
});

describe("lastAccessDayLabel — provider_access_until é EXCLUSIVO", () => {
  it("o último dia de acesso real é a véspera", () => {
    expect(lastAccessDayLabel("2026-09-01")).toBe("31/08/2026");
  });
  it("atravessa mês e ano corretamente", () => {
    expect(lastAccessDayLabel("2027-01-01")).toBe("31/12/2026");
  });
  it("sem data não inventa rótulo", () => {
    expect(lastAccessDayLabel(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/whatsapp-instance-format.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar o formatador**

`src/lib/whatsapp-instance-format.ts`:

```ts
import { grossMarginDisplay } from "../../supabase/functions/_shared/whatsapp-instance-revenue-core";

/** Desconhecido é travessão, NUNCA "R$ 0,00": zero é um fato ("não custa
 *  nada") e exibi-lo no lugar de "não sei" mente sobre a margem. */
export function formatCents(cents: number | null): string {
  if (cents === null || cents === undefined) return "—";
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function formatMargin(revenueCents: number | null, costCents: number | null): string {
  const d = grossMarginDisplay(revenueCents, costCents);
  if (d.kind === "NOT_APPLICABLE") return "não aplicável";
  if (d.kind === "PENDING") return "pendente";
  return `${d.value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

/**
 * `provider_access_until` é EXCLUSIVO — primeiro dia NÃO coberto. A UI escreve
 * "acesso até <until - 1>" para o leitor humano, senão o operador lê um dia a
 * mais de acesso do que existe.
 */
export function lastAccessDayLabel(providerAccessUntil: string | null): string | null {
  if (!providerAccessUntil) return null;
  const y = Number(providerAccessUntil.slice(0, 4));
  const m = Number(providerAccessUntil.slice(5, 7));
  const d = Number(providerAccessUntil.slice(8, 10));
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  const dd = String(prev.getUTCDate()).padStart(2, "0");
  const mm = String(prev.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${prev.getUTCFullYear()}`;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/whatsapp-instance-format.test.ts`
Expected: PASS.

- [ ] **Step 5: Escrever os hooks**

`src/hooks/useWhatsappInstances.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export type WhatsappInstance = {
  id: string;
  organization_id: string;
  unit_id: string | null;
  channel_id: string | null;
  provider: string;
  provider_instance_ref: string | null;
  lifecycle_state: string;
  provider_cycle_anchor_day: number | null;
  current_cycle_started_on: string | null;
  current_cycle_due_on: string | null;
  cycle_source: string;
  current_monthly_cost_cents: number | null;
  provider_access_until: string | null;
  ended_at: string | null;
  last_divergence_kind: string | null;
};

export type WhatsappAlert = {
  id: string;
  subject_type: string;
  organization_id: string;
  instance_id: string | null;
  channel_id: string | null;
  alert_type: string;
  status: string;
  first_detected_at: string;
  last_seen_at: string;
  occurrences: number;
  payload: Record<string, unknown>;
  dispatch_enabled_at_enqueue: boolean;
};

/**
 * `supabase.functions.invoke` MASCARA o corpo de erro non-2xx. Sem extrair via
 * FunctionsHttpError, o gate de provisionamento (409 com código) chegaria à UI
 * como "Edge Function returned a non-2xx status code" e o operador não saberia
 * o que fazer.
 */
async function callEf<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("manage-whatsapp-instances", { body });
  if (error) {
    let message = error.message;
    let code: string | undefined;
    if (error instanceof FunctionsHttpError) {
      const parsed = await error.context.json().catch(() => null);
      if (parsed?.error) message = parsed.error;
      code = parsed?.code;
    }
    const e = new Error(message) as Error & { code?: string };
    e.code = code;
    throw e;
  }
  return data as T;
}

export function useWhatsappInstances() {
  return useQuery({
    queryKey: ["whatsapp-instances"],
    queryFn: () => callEf<{ instances: WhatsappInstance[] }>({ action: "list_instances" })
      .then((r) => r.instances),
  });
}

export function useWhatsappInstance(id: string | null) {
  return useQuery({
    queryKey: ["whatsapp-instance", id],
    enabled: !!id,
    queryFn: () => callEf<{ instance: WhatsappInstance; cycles: unknown[]; alerts: WhatsappAlert[] }>({
      action: "get_instance",
      instance_id: id,
    }),
  });
}

export function useWhatsappInstanceAlerts(status?: string) {
  return useQuery({
    queryKey: ["whatsapp-instance-alerts", status ?? "all"],
    queryFn: () => callEf<{ alerts: WhatsappAlert[] }>({ action: "list_alerts", status })
      .then((r) => r.alerts),
  });
}

export function useWhatsappInstanceAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { action: string; [k: string]: unknown }) => callEf(body),
    onSettled: () => {
      // Invalidate BROAD: as três keys começam com prefixos distintos e
      // invalidateQueries é prefix-match — invalidar uma não pega as outras.
      qc.invalidateQueries({ queryKey: ["whatsapp-instances"] });
      qc.invalidateQueries({ queryKey: ["whatsapp-instance"] });
      qc.invalidateQueries({ queryKey: ["whatsapp-instance-alerts"] });
    },
  });
}

export function usePartnerSimulation() {
  return useMutation({
    mutationFn: (v: { organization_id?: string | null; partner_monthly_target_cents: number }) =>
      callEf<{ simulation: Record<string, unknown> }>({ action: "simulate_partner", ...v }),
  });
}
```

- [ ] **Step 6: Typecheck e commit**

```bash
npm run typecheck
npx vitest run src/lib/whatsapp-instance-format.test.ts
git add src/hooks/useWhatsappInstances.ts src/lib/whatsapp-instance-format.ts src/lib/whatsapp-instance-format.test.ts
git commit -m "feat(6b): hooks e formatadores do painel de instancias"
```

---

## Task 20: Página `/platform/instancias-whatsapp`

**Files:**
- Create: `src/pages/platform/WhatsappInstances.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: os hooks da Task 19; `AdminShell` via o layout de `/platform/*` já existente; `PlatformGuard`.
- Produces: a rota e a tela.

- [ ] **Step 1: Registrar a rota**

Em `src/App.tsx`, junto dos outros `lazy` de plataforma:

```tsx
const PWhatsappInstances = lazy(() => import("./pages/platform/WhatsappInstances"));
```

E junto das rotas `/platform/*`:

```tsx
              <Route path="/platform/instancias-whatsapp" element={<PlatformGuard><PWhatsappInstances /></PlatformGuard>} />
```

- [ ] **Step 2: Escrever a página**

`src/pages/platform/WhatsappInstances.tsx` — siga estes requisitos, que são a especificação da tela (o layout copia o padrão de `src/pages/platform/WhatsappImplementations.tsx`, que já resolve casca, tabela e diálogos):

1. **Quatro branches de estado, sempre** — `isLoading`, `isError` (com botão `refetch()`), lista vazia, lista. Silenciar erro como "lista vazia" já mascarou incidente em produção.
2. **Coluna de ciclo** mostra `current_cycle_due_on` **e** o rótulo de `cycle_source`. Quando `cycle_source === "UNKNOWN"`, mostrar **"data não confirmada"** com destaque e botão "Confirmar data" — **nunca** uma data derivada.
3. **Custo** via `formatCents` — `null` vira `—`, nunca `R$ 0,00`.
4. **Margem** via `formatMargin` — `pendente` / `não aplicável` / percentual. Linha com `revenue_source === "LIFETIME_OVERRIDE"` recebe rótulo **"cortesia vitalícia"** e **não** é pintada como anomalia, mesmo com margem negativa.
5. **`provider_access_until`** é exibido via `lastAccessDayLabel` como *"acesso até 31/08/2026"* — nunca o valor cru, que é o primeiro dia **não** coberto.
6. **Toda ação de escrita abre diálogo com campo `reason` obrigatório** (mínimo 5 caracteres), com o valor anterior visível ao lado do novo. Sem motivo, o botão de confirmar fica desabilitado — a EF também recusa, mas a UI não deve deixar chegar lá.
7. **Confirmar data** pede `cycle_start` **e** `provider_cycle_anchor_day`. Quando o dia informado for 28, 29 ou 30, exibir aviso: *"Não é possível saber se houve ajuste de mês curto. Confirme o dia-âncora original da cobrança."* — a spec proíbe adivinhar (§6.3).
8. **Aba de alertas** com `status` (`OPEN`/`ACKNOWLEDGED`/`RESOLVED`), `occurrences`, `first_detected_at`, e os botões Reconhecer e Resolver. Quando `dispatch_enabled_at_enqueue === false`, exibir a nota: *"O envio de e-mails de billing está desligado. Este painel é a superfície viva dos alertas."*
9. **Simulador do Partner** com campo obrigatório de preço-alvo, rótulo **"Simulação"** visível, e o texto: *"O sistema não conhece o preço do Plano Partner. O valor abaixo é informado por você."* Resultado mostra custo conhecido, instâncias com custo desconhecido, economia e ponto de equilíbrio. **Nenhuma persistência.**
10. **Desabilitar um botão entre N** que compartilham a mesma mutation usa `mutation.variables`, não state extra — `mutation.isPending && mutation.variables?.instance_id === row.id`.
11. **Nada de credencial na tela.** `provider_instance_ref` aparece; token, `credentials` e URL de envio, não.
12. **Cores por token Tailwind**, nunca hardcode; `cn()` de `@/lib/utils` para classes condicionais.

- [ ] **Step 3: Verificar visualmente com o banco ainda vazio**

```bash
npm run dev
```
Abra `/platform/instancias-whatsapp` autenticado como `platform_admin`. Expected: estado vazio com a mensagem correta e **sem erro no console**. Confirme que a aba de alertas mostra a ocorrência de `CHANNEL_WITHOUT_INSTANCE` produzida na Task 18, com a nota do dispatcher desligado.

Confirme também que um usuário `owner`/`gerente` recebe o bloqueio do `PlatformGuard` (não a tela).

- [ ] **Step 4: Typecheck, lint e commit**

```bash
npm run typecheck
npm run lint
git add src/pages/platform/WhatsappInstances.tsx src/App.tsx
git commit -m "feat(6b): painel de instancias de WhatsApp em /platform"
```

---

## Task 21: Migration 092 — *wrapper* de cron sem URL embutida

**Files:**
- Create: `supabase/migrations/20260801200500_092_whatsapp_instance_cycles_trigger.sql`

**Interfaces:**
- Consumes: Vault (`internal_api_key` e **`project_url`**), `pg_net`.
- Produces: `public.trigger_whatsapp_instance_cycles()` — **sem agendar nada**.

**Por que separada do agendamento:** `supabase db push` aplica tudo que está pendente. Se o `cron.schedule` estivesse aqui, o cron nasceria no passo 1 do rollout, e a spec exige que ele seja o passo 12 — depois da execução manual sob observação. A função existir sem estar agendada é inofensiva: ninguém a chama.

- [ ] **Step 1: Semear o `project_url` no Vault**

**Pré-requisito operacional, antes de aplicar a migration.** No SQL Editor do projeto (isto **não** é migration — é semeadura de segredo, como o `internal_api_key` já é hoje):

```sql
select vault.create_secret('<URL do projeto>', 'project_url');
```

Confirme:
```sql
select name from vault.decrypted_secrets where name in ('internal_api_key', 'project_url');
```
Expected: duas linhas.

- [ ] **Step 2: Escrever a migration**

`supabase/migrations/20260801200500_092_whatsapp_instance_cycles_trigger.sql`:

```sql
-- Wrapper pg_cron do worker de ciclos da instância (Fase 6b).
--
-- ESTA MIGRATION NÃO AGENDA NADA. O agendamento é a 093, aplicada só no passo
-- 12 do rollout, depois da execução manual sob observação humana. A função
-- existir sem estar agendada é inofensiva: ninguém a chama.
--
-- URL DO PROJETO VEM DO VAULT, NÃO EMBUTIDA. As treze migrations legadas
-- embutem 'https://<ref>.supabase.co' e, por isso, um banco local
-- reconstruído por esse histórico com pg_cron ativo agenda jobs que fazem POST
-- em PRODUÇÃO (spec §11.0). Consertar as treze é a frente
-- BASELINE_REPRODUCIBLE_DATABASE_ENVIRONMENT; o que garantimos aqui é que
-- nenhuma migration NOVA repete o padrão. O guardrail
-- scripts/migration-static-guard.test.ts falha o CI se alguém regredir.
--
-- FAIL-CLOSED: sem project_url ou sem internal_api_key no Vault, a função
-- avisa e RETORNA sem fazer POST. Num banco reconstruído sem segredos, ela
-- simplesmente não dispara — que é exatamente o comportamento desejado.

create extension if not exists pg_cron;

create or replace function public.trigger_whatsapp_instance_cycles()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  api_key text;
  project_url text;
begin
  select decrypted_secret into api_key
  from vault.decrypted_secrets where name = 'internal_api_key' limit 1;

  select decrypted_secret into project_url
  from vault.decrypted_secrets where name = 'project_url' limit 1;

  if api_key is null or api_key = '' then
    raise notice '[whatsapp-instance-cycles] internal_api_key ausente no Vault — skip';
    return;
  end if;

  if project_url is null or project_url = '' then
    raise notice '[whatsapp-instance-cycles] project_url ausente no Vault — skip';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/process-whatsapp-instance-cycles',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-key', api_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

-- Toda função trigger_* precisa disto: CREATE FUNCTION concede EXECUTE a
-- PUBLIC por padrão e o schema public é exposto ao PostgREST com a anon key
-- (migration 084 fez a limpeza retroativa das antigas).
revoke all on function public.trigger_whatsapp_instance_cycles() from public, anon, authenticated;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. ACL (esperado: sem anon= e sem authenticated=):
--   select proacl from pg_proc where proname = 'trigger_whatsapp_instance_cycles';
--
-- 2. Nenhum job agendado ainda (esperado: 0 linhas — o agendamento é a 093):
--   select jobname from cron.job where jobname = 'whatsapp-instance-cycles';
--
-- 3. Disparo manual controlado (só quando autorizado no rollout):
--   select trigger_whatsapp_instance_cycles();
--   select * from net._http_response order by created desc limit 1;
--
-- =====================================================================
-- Rollback
-- =====================================================================
--   drop function if exists public.trigger_whatsapp_instance_cycles();
```

- [ ] **Step 3: Rodar o guardrail e aplicar**

```bash
npx vitest run scripts/migration-static-guard.test.ts
supabase db push
```
Expected: guardrail PASS (a 092 não tem URL embutida); migration aplica. Rode as validações 1 e 2 do rodapé — ACL limpa, **zero** jobs agendados.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260801200500_092_whatsapp_instance_cycles_trigger.sql
git commit -m "feat(6b): wrapper de cron lendo project_url do Vault, sem agendar"
```

---

## Task 22: Gates de segurança — os seis auditores

**Files:** nenhum arquivo novo. Esta task produz **evidência**, e a evidência é entregável.

- [ ] **Step 1: Rodar os seis gates**

Dispare os seis agentes `saas-shield-br` sobre o *branch* completo:

| Agente | Escopo desta fase |
|---|---|
| `migration-validator` | migrations 087–092 |
| `rls-auditor` | as três tabelas novas e suas policies |
| `tenant-isolation-auditor` | trigger de tenant, EF, worker, painel |
| `identity-access-auditor` | `verify_jwt`, guard de `platform_admin`, ACL das RPCs |
| `secret-hunter` | o contrato negativo de §0.3 |
| `integration-reliability-auditor` | idempotência da rolagem, dedupe do ledger, isolamento de falha |

- [ ] **Step 2: Apresentar os resultados INDIVIDUALMENTE**

**"Gates verdes" não é relatório.** Para cada um dos seis: nome, veredito, e a lista de *findings* com severidade.

- *Finding* **alto ou crítico** → **NO-GO**. Corrige e roda de novo.
- *Finding* **médio** → correção **ou** aceite explícito com justificativa e *follow-up* nomeado.

- [ ] **Step 3: Provar os nove itens que o `secret-hunter` precisa cobrir**

Cada linha é uma verificação com comando e resultado esperado:

```bash
# 1-2. Nenhuma coluna de segredo nas tabelas novas
grep -nE "token|secret|password|senha|api_key|credential" \
  supabase/migrations/20260801200000_087_whatsapp_instances.sql \
  supabase/migrations/20260801200100_088_whatsapp_instance_cycles.sql
# Esperado: só as linhas de COMENTÁRIO que dizem que NÃO há segredo.

# 3. Ledger sem e-mail duplicado
grep -nE "email|recipient" supabase/migrations/20260801200200_089_whatsapp_instance_alerts.sql
# Esperado: zero.

# 4-5. Log e payload sem credenciais
grep -nE "credentials|jsonLog.*creds|payload:.*creds" \
  supabase/functions/process-whatsapp-instance-cycles/index.ts \
  supabase/functions/manage-whatsapp-instances/index.ts
# Esperado: só a leitura de `credentials` no passo 5a, que EXTRAI o
# identificador e nunca o loga nem o grava.

# 6. provider_instance_ref tratado como identificador
grep -n "validateProviderInstanceRef" supabase/functions/manage-whatsapp-instances/index.ts
# Esperado: chamado em register_instance e update_instance.

# 7. Nenhum arquivo novo acessando credenciais além do reaproveitamento aprovado
grep -rln "whatsapp_channels" supabase/functions/manage-whatsapp-instances/ \
  supabase/functions/process-whatsapp-instance-cycles/
# Esperado: só o worker (passo 5a).

# 8-9. O worker não importa cliente Z-API e não faz fetch externo
grep -nE "fetch\(|z-api|zapi|whatsapp-providers|whatsapp-send" \
  supabase/functions/process-whatsapp-instance-cycles/index.ts
# Esperado: ZERO.
```

- [ ] **Step 4: Provar o gate da 6a com teste, não com disciplina**

Com JWT de `platform_admin`, contra organização de teste (**nunca** Ren Sushi ou Moralles):

| Deve **bloquear** | Verificação |
|---|---|
| criação de instância real nova | `register_instance` com `intent: "NEW_PROVISION"` → 409 |
| `AWAITING_PROVISION` inicial | nenhuma action cria esse estado — `grep -n "AWAITING_PROVISION" supabase/functions/manage-whatsapp-instances/index.ts` retorna zero |
| contorno pelo frontend | a UI não expõe `NEW_PROVISION`; a EF recusa de qualquer forma |
| contorno por chamada direta à EF | o 409 acima é da EF, não da UI |
| ambiguidade backfill × criação | `register_instance` sem `intent` → 409 |

| Deve **passar** | Verificação |
|---|---|
| *backfill* de instância existente | `intent: "BACKFILL_EXISTING"` → 200 (**controle positivo**) |
| *update* administrativo | `update_instance` com `reason` → 200 |
| teste de conexão | `manage-channels` action `test` segue funcionando, inalterado |

E ainda: **nenhuma flag de banco desativa a constante** (`grep -rn "NEW_REAL_INSTANCE_PROVISIONING" supabase/ src/` mostra só a constante e seus usos, nenhuma leitura de `platform_flags`); e o **erro não expõe segredo** (a mensagem foi verificada por teste na Task 2).

Limpe as fixtures ao final, em `finally`.

- [ ] **Step 5: Registrar a evidência**

Crie `docs/billing-asaas/FASE-6B-GATES.md` com os seis resultados individuais, os nove itens do `secret-hunter` e a tabela do gate da 6a, cada um com o comando e a saída. Sem isso, "os gates passaram" é afirmação sem lastro.

```bash
git add docs/billing-asaas/FASE-6B-GATES.md
git commit -m "docs(6b): evidencia individual dos seis gates e do gate da 6a"
```

---

## Task 23: Rollout — *backfill* do Ren Sushi, execução manual e cron

**Files:**
- Create: `supabase/migrations/20260801200600_093_cron_whatsapp_instance_cycles.sql` — **criado e commitado somente no passo 12**

**Esta task é operacional e tem GO/NO-GO.** Nenhum passo avança com o anterior pendente.

- [ ] **Step 1: Gate antes do *backfill***

Confirme **todos**, e registre cada resposta:

- [ ] nenhuma falha **alta ou crítica** nos seis auditores (Task 22);
- [ ] worker **ainda sem cron** — `select jobname from cron.job where jobname = 'whatsapp-instance-cycles';` → 0 linhas;
- [ ] actions administrativas validadas (Tasks 15, 16 e 22);
- [ ] **nenhum acesso direto por `authenticated`** — como `authenticated`, `select * from whatsapp_instances` → 0 linhas ou erro de permissão, **nunca** dados;
- [ ] nenhuma chamada externa nova (`secret-hunter`, itens 8–9).

**Qualquer item pendente = NO-GO.**

- [ ] **Step 2: *Backfill* do Ren Sushi — o estado inicial é exatamente este**

Pelo painel (**não** por SQL — a action grava autoria, motivo e auditoria):

```
action: register_instance
intent: BACKFILL_EXISTING
organization_id: <Ren Sushi>
unit_id: <unidade do Ren Sushi>
channel_id: <canal existente do Ren Sushi>
provider: zapi
provider_instance_ref: <identificador lido no painel da Z-API>
current_monthly_cost_cents: <custo real, se conhecido; senão NULO>
reason: "Backfill da instância existente — Fase 6b"
```

Estado resultante, a conferir:

| Campo | Valor esperado |
|---|---|
| `lifecycle_state` | `ACTIVE` |
| `cycle_source` | `UNKNOWN` — a data ainda não foi confirmada |
| `current_cycle_due_on` | **ausente** — data ausente **não** vira vencimento inventado |
| alerta aberto | `DATE_REVIEW_REQUIRED` — pendência de painel, sem e-mail |
| custo | real se conhecido; `NULL` (nunca zero) se não |
| `revenue_source` no próximo ciclo | `LIFETIME_OVERRIDE`, receita `0` |
| margem | **negativa e visível** — custo conhecido de uma decisão comercial, não anomalia |

E o que **não** pode ter acontecido: nenhuma criação no provedor · nenhuma alteração no canal existente · nenhuma mudança de entitlement · nenhuma mudança em `organizations.billing_status`.

- [ ] **Step 3: Conferência dos dados**

```sql
select id, organization_id, unit_id, channel_id, lifecycle_state, cycle_source,
       current_cycle_due_on, current_monthly_cost_cents, provider_instance_ref
  from whatsapp_instances;

-- Esperado: 1 linha, cycle_source='UNKNOWN', current_cycle_due_on NULL.

select alert_type, status, occurrences from whatsapp_instance_alerts;
-- Esperado: a divergência CHANNEL_WITHOUT_INSTANCE da Task 18 deve ser
-- RESOLVIDA na próxima execução do worker, porque o canal agora tem instância.
```

Confirme no painel que o Ren Sushi aparece com **"data não confirmada"** e **não** com uma data derivada.

- [ ] **Step 4: Confirmar a data do ciclo (quando conhecida)**

Se a data real da cobrança for conhecida, use `confirm_cycle_date` com `cycle_start` e `provider_cycle_anchor_day`. Estado após:

| Campo | Valor |
|---|---|
| `cycle_source` | `ADMIN_CONFIRMED` |
| ciclo `OPEN` | coerente com a projeção da instância |
| custo | congelado no ciclo |
| D-7/D-1 | liberados daquele ciclo em diante |

**Se a data não for conhecida, PARE aqui e siga com `UNKNOWN`.** Inventar a data para "destravar o rollout" é exatamente o que §6.2 proíbe.

- [ ] **Step 5: Execução manual controlada do worker**

```bash
curl -s -X POST "$SUPABASE_URL/functions/v1/process-whatsapp-instance-cycles" \
  -H "x-internal-key: $INTERNAL_API_KEY" -H "Content-Type: application/json" -d '{}'
```

Rode **duas vezes seguidas**. A segunda execução prova idempotência: nenhum ciclo novo, nenhum alerta duplicado, `occurrences` inalterado (o lembrete é mensal).

- [ ] **Step 6: Inspeção do ledger e dos ciclos**

```sql
select instance_id, cycle_start, provider_due_on, status, provider_cost_cents,
       customer_revenue_cents, revenue_source, gross_margin_cents
  from whatsapp_instance_cycles order by cycle_start;

select alert_type, subject_type, dedupe_key, status, occurrences,
       first_detected_at, last_seen_at, dispatch_enabled_at_enqueue
  from whatsapp_instance_alerts order by first_detected_at;

-- Nada mudou fora do escopo:
select id, billing_status from organizations where id = '<Ren Sushi>';
select id, status from billing_subscriptions where organization_id = '<Ren Sushi>';
select id, status from whatsapp_channels where id = '<canal do Ren Sushi>';
```

- [ ] **Step 7: Gate antes do cron**

Confirme **todos**:

- [ ] *backfill* conferido;
- [ ] execução manual **idempotente** (duas execuções, mesmo resultado);
- [ ] **nenhuma duplicação** de ciclo ou alerta;
- [ ] **nenhuma alteração** de `billing_status`;
- [ ] **nenhuma alteração** de entitlement;
- [ ] **nenhuma chamada** ao provedor;
- [ ] telemetria **sanitizada** — nenhum log com `credentials`, token ou URL com segredo;
- [ ] *rollback* por desagendamento documentado (passo 9).

**Qualquer item pendente = NO-GO.**

- [ ] **Step 8: Criar e aplicar a migration do cron**

`supabase/migrations/20260801200600_093_cron_whatsapp_instance_cycles.sql`:

```sql
-- Agendamento do worker de ciclos da instância (Fase 6b, passo 12 do rollout).
--
-- SEPARADA DA 092 de propósito: o wrapper existe desde o passo 1, o
-- AGENDAMENTO só depois de o worker ter rodado manualmente sob observação
-- humana e de o gate pré-cron ter passado.
--
-- 12:10 UTC = 09:10 BRT. O :10 evita colidir com process-voucher-triggers
-- (0 12 * * *). Vizinhos: 03h trial-expiry, 04h dom cleanup-orphan-assets,
-- 06h billing-reconcile, 07h asaas-reconcile, 08h asaas-invoice-reconcile,
-- 10h billing-overdue, 11h whatsapp-enforcement, 12h voucher-triggers,
-- 12:10 (este), 13h reservation/billing-reminders, 17h satisfaction-surveys.
--
-- RESSALVA DE UTC, registrada de propósito: pg_cron agenda em UTC fixo. Hoje o
-- Brasil não tem horário de verão; se voltar, o horário civil desloca e
-- ninguém será avisado pelo sistema. É aceitável porque NENHUM VEREDITO
-- DEPENDE DA HORA: toda decisão de data compara contra todayBrt(). Rodar às
-- 09:10 ou 10:10 BRT muda quando o alerta chega, nunca se ele deve existir.

do $$
begin
  perform cron.unschedule('whatsapp-instance-cycles');
exception when others then null;
end $$;

select cron.schedule(
  'whatsapp-instance-cycles',
  '10 12 * * *',
  'select trigger_whatsapp_instance_cycles();'
);

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. Job agendado (esperado: 1 linha, '10 12 * * *', active=true):
--   select jobname, schedule, active from cron.job
--    where jobname = 'whatsapp-instance-cycles';
--
-- 2. Primeira execução automática (no dia seguinte):
--   select status, start_time, end_time from cron.job_run_details
--    where jobname = 'whatsapp-instance-cycles' order by start_time desc limit 3;
--
-- =====================================================================
-- Rollback — FREIO DE PRIMEIRA LINHA, efeito imediato, sem deploy
-- =====================================================================
--   select cron.unschedule('whatsapp-instance-cycles');
```

```bash
npx vitest run scripts/migration-static-guard.test.ts
supabase db push
git add supabase/migrations/20260801200600_093_cron_whatsapp_instance_cycles.sql
git commit -m "feat(6b): agenda o worker de ciclos em 12:10 UTC"
```

- [ ] **Step 9: Observação diária**

Por **sete dias**, confirme diariamente:

```sql
select status, start_time from cron.job_run_details
 where jobname = 'whatsapp-instance-cycles' order by start_time desc limit 3;

select alert_type, status, occurrences, last_seen_at
  from whatsapp_instance_alerts order by last_seen_at desc;
```

E nos logs da EF: nenhum `needsAdminAction: true` inesperado.

**Freio, em ordem, se algo aparecer:** desagendar o cron → manter tabelas e registros **intactos** → impedir novas ações administrativas sensíveis, se o defeito estiver nelas → corrigir o código → redeploy → **reagendar somente após novo GO**.

**Regra herdada do Risco 7: NO-GO não é corrigido "no dado" para manter o rollout verde.** Não apagar ciclos ou alertas para "voltar ao verde"; não alterar lifecycle por SQL direto; preservar todas as linhas para auditoria.

- [ ] **Step 10: Observação de um ciclo completo**

Quando o primeiro `provider_due_on` do Ren Sushi vencer, confirme: o D-7 saiu na janela; a rolagem fechou o ciclo e abriu o próximo; o custo do novo ciclo é o custo vigente na abertura; a projeção da instância bate com o ciclo `OPEN`; nenhum ciclo duplicado.

Registre o resultado em `docs/billing-asaas/FASE-6B-RESUMO.md`, incluindo **previsão do sistema × ocorrido**.

- [ ] **Step 11: Atualizar o CLAUDE.md com os invariantes novos**

Aplique o filtro do próprio CLAUDE.md — só entra o que muda decisão de código futuro. Candidatos:

- `whatsapp_instances.lifecycle_state` **não** é fonte de autorização de envio;
- o checklist de redeploy dos seis núcleos novos (`whatsapp-instance-*-core.ts` → `manage-whatsapp-instances`, `process-whatsapp-instance-cycles`);
- os seis `event_type` novos e o acoplamento por string com `process-billing-notifications` (quinta ocorrência);
- `provider_due_on` e `provider_access_until` são **exclusivos**; não existe `cycle_end`;
- migration nova lê `project_url` do Vault — URL de projeto *hardcoded* é reprovada pelo guardrail do CI;
- a linha nova na tabela de workers `pg_cron` (`process-whatsapp-instance-cycles`, `10 12 * * *`).

```bash
git add CLAUDE.md
git commit -m "docs(6b): invariantes do inventario de instancias no CLAUDE.md"
```

---

## Self-Review

Executada sobre a spec fechada, antes da entrega do plano.

**1. Cobertura da spec.** Cada seção tem task:

| Spec | Task |
|---|---|
| §2 gate de provisionamento | 2, 15, 22 |
| §3 tabela e `provider_instance_ref` | 2, 7 |
| §4 lifecycle | 2, 7, 15 |
| §5 N instâncias | 3, 7 (sem unicidade por org), 18 |
| §6 vencimento como fato | 1, 7, 15 |
| §7 rolagem e ciclos | 1, 3, 8, 10, 17 |
| §8 cancelamento e confirmação | 7, 15, 18 |
| §9 flags órfãs | 11 |
| §10.1–10.3 worker e lock | 10, 17 |
| §10.4–10.6 ledger, D-7/D-1, `event_type` | 4, 9, 13, 17 |
| §10.7 divergências | 5, 18 |
| §10.8 desequilíbrio | 3, 18 |
| §10.9 painel | 14, 19, 20 |
| §10.10 simulador | 6, 14, 20 |
| §10.11 `verify_jwt` | 14 |
| §11.0 prova de reconstrução | 12, 21 |
| §11.1 núcleos puros | 1–6 |
| §11.2 integração `ENVIRONMENT_BLOCKED` | 12 |
| §11.3 produção não é ambiente de teste | 12, 15, 22 |
| §11.7 segurança e RLS | 7, 8, 9, 10, 14, 22 |
| §11.8 gates | 22 |
| §11.9–11.13 rollout, *backfill*, *rollback* | 21, 22, 23 |

**Lacunas conhecidas, deliberadas:** §11.4 (Camada 2, leitura ao vivo pelo caminho existente) e §11.6 (protocolo da primeira ocorrência real) **não viram task** — a primeira é validação operacional com o canal existente, sem código novo; a segunda só se aplica quando houver criação ou cancelamento real, o que a 6b bloqueia. §11.5 é declaradamente não executável nesta fase.

**2. Varredura de *placeholder*.** Nenhum "TBD", "implementar depois" ou "similar à Task N". Onde o plano manda conferir schema antes de codar (Tasks 7, 11, 14, 17, 18), o comando de verificação está escrito e o esperado, também — é instrução verificável, não lacuna.

**3. Consistência de tipos.** `nextDueFromAnchor(fromIso, anchorDay)` tem a mesma assinatura na Task 1, no `p_next_due_on` da Task 10 e na chamada da Task 17. `EVENT_TYPE_BY_ALERT` (Task 4) tem exatamente as seis chaves dos templates da Task 13. `DivergenceFinding.dedupeKey` (Task 5) alimenta `upsertAlert.dedupeKey` (Task 17). `grossMarginDisplay` (Task 3) é consumido por `formatMargin` (Task 19) com os três `kind` cobertos.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-01-billing-asaas-fase-6b.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — um subagente novo por task, revisão entre tasks, iteração rápida.

**2. Inline Execution** — as tasks executadas nesta sessão, em lotes com pontos de conferência.

**Which approach?**

**Independente da escolha:** as Tasks 1–6 são puras e seguras para executar em sequência; a Task 13 vem **obrigatoriamente antes** da 17; e a Task 23 é operacional, com dois GO/NO-GO que dependem de você.

