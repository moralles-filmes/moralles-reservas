/**
 * Guardrail ESTÁTICO das migrations do Plano D.
 *
 * Não substitui a prova contra banco real (testes 42 e 44 da spec continuam
 * PENDENTES — ver docs/billing-asaas/PLANO-D-PENDENCIAS.md). O que ele prova é
 * que as garantias ESTÃO ESCRITAS: FORCE RLS, policy de platform_admin, fim
 * exclusivo, price_id NOT NULL, não sobreposição de ciclos, e ausência de
 * segredo. Uma migration que perca qualquer uma dessas linhas cai aqui, e não
 * só num code review.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "..", "..", "supabase", "migrations");

function read(nameFragment: string): string {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(nameFragment));
  if (!file) throw new Error(`migração não encontrada: ${nameFragment}`);
  return readFileSync(join(MIGRATIONS, file), "utf8");
}

const prices = read("099_ai_model_prices");
const budgets = read("100_ai_cycle_budgets");
const usage = read("101_ai_usage_and_reservations");
const all = [prices, budgets, usage];

const TABLES = ["ai_model_prices", "ai_cycle_budgets", "ai_cost_reservations", "ai_usage_events"];

describe("faixa de migration reservada ao Plano D", () => {
  it("usa apenas os números 099 a 103", () => {
    const mine = readdirSync(MIGRATIONS).filter((f) => /_(099|100|101|102|103)_ai_/.test(f));
    expect(mine.length).toBeGreaterThanOrEqual(3);
    for (const f of mine) expect(f).toMatch(/_(099|100|101|102|103)_/);
  });
});

describe("RLS das quatro tabelas", () => {
  const joined = all.join("\n");
  for (const t of TABLES) {
    it(`${t}: RLS habilitada E forçada`, () => {
      expect(joined).toContain(`alter table ${t} enable row level security`);
      expect(joined).toContain(`alter table ${t} force row level security`);
    });

    it(`${t}: tem policy platform_admin e NENHUMA policy para anon`, () => {
      expect(joined).toContain(`platform_admin_all_${t}`);
      // O lojista nunca lê custo. Uma policy `to anon`/`to authenticated` sem
      // is_platform_admin nestas tabelas é regressão de vazamento financeiro.
      const block = joined.slice(joined.indexOf(`create table if not exists ${t}`));
      const upToNext = block.slice(0, block.indexOf("commit;") + 1);
      expect(upToNext).not.toMatch(/create policy[^;]*to anon/i);
    });
  }
});

describe("ai_model_prices", () => {
  it("a taxa de câmbio vive NA LINHA de preço, não em variável global", () => {
    expect(prices).toMatch(/usd_to_brl\s+numeric\(12,6\)\s+not null/);
  });

  it("vigência fechada por effective_from/effective_to", () => {
    expect(prices).toContain("effective_from");
    expect(prices).toContain("effective_to");
  });

  it("impede vigências sobrepostas para o mesmo provider+model", () => {
    expect(prices).toMatch(/exclude\s+using\s+gist/i);
    expect(prices).toContain("btree_gist");
  });

  it("semeia o modelo de fallback do Gemini — ele custa múltiplas vezes o Flash", () => {
    expect(prices).toContain("gemini-2.5-pro");
    expect(prices).toContain("gemini-2.5-flash");
  });

  it("semeia os cinco provedores", () => {
    for (const p of ["claude", "openai", "gemini", "grok", "deepseek"]) {
      expect(prices).toContain(`'${p}'`);
    }
  });
});

describe("ai_cycle_budgets", () => {
  it("o fim do ciclo é EXCLUSIVO e está documentado como tal", () => {
    expect(budgets).toMatch(/cycle_end[\s\S]{0,400}EXCLUSIVO/i);
  });

  it("limite congelado na abertura e não relido do plano", () => {
    expect(budgets).toMatch(/limit_cents[\s\S]{0,600}congelad/i);
  });

  it("settled_cents nunca é negativo", () => {
    expect(budgets).toMatch(/settled_cents[\s\S]{0,200}check\s*\(settled_cents\s*>=\s*0\)/i);
  });

  it("um ciclo por (organização, início) — duplicado exato barrado", () => {
    expect(budgets).toMatch(/unique[\s\S]{0,120}organization_id[\s\S]{0,60}cycle_start/i);
  });

  it("ciclos da mesma organização não se sobrepõem — EXCLUDE, não só UNIQUE", () => {
    // UNIQUE(org, cycle_start) NÃO cobre sobreposição parcial: dois budgets no
    // mesmo intervalo significam teto DOBRADO sem ninguém decidir isso.
    expect(budgets).toMatch(/exclude\s+using\s+gist[\s\S]{0,200}daterange/i);
  });

  it("cycle_start é sempre anterior a cycle_end", () => {
    expect(budgets).toMatch(/check\s*\(\s*cycle_start\s*<\s*cycle_end\s*\)/i);
  });

  it("persiste o dia-âncora — nunca re-derivado do vencimento atual", () => {
    expect(budgets).toContain("cycle_anchor_day");
  });

  it("o estado carrega o MOMENTO do esgotamento, que não é derivável depois", () => {
    expect(budgets).toContain("exhausted_at");
    expect(budgets).toMatch(/state[\s\S]{0,200}'OPEN'[\s\S]{0,60}'EXHAUSTED'[\s\S]{0,60}'CLOSED'/);
  });
});

describe("ai_usage_events", () => {
  it("price_id é NOT NULL — evento financeiro só existe com preço conhecido", () => {
    expect(usage).toMatch(/price_id\s+uuid\s+not null\s+references\s+ai_model_prices/i);
  });

  it("aponta para o ORÇAMENTO do ciclo, não para um par de datas soltas", () => {
    expect(usage).toMatch(/cycle_id\s+uuid\s+not null\s+references\s+ai_cycle_budgets/i);
  });

  it("carrega a taxa efetivamente usada — consumo histórico não muda sozinho", () => {
    expect(usage).toMatch(/usd_to_brl\s+numeric/);
  });

  it("vocabulário fechado de usage_state, com os quatro estados", () => {
    for (const s of ["SETTLED", "USAGE_REVIEW_REQUIRED", "FAILED_BEFORE_PROVIDER", "PROVIDER_FAILED"]) {
      expect(usage).toContain(`'${s}'`);
    }
  });

  it("zero só é afirmação legítima em FAILED_BEFORE_PROVIDER e PROVIDER_FAILED", () => {
    expect(usage).toMatch(/check[\s\S]{0,400}FAILED_BEFORE_PROVIDER[\s\S]{0,200}cost_brl_cents\s*=\s*0/i);
  });

  it("idempotência por (organização, chave) — reexecução não debita duas vezes", () => {
    expect(usage).toMatch(/unique[\s\S]{0,120}organization_id[\s\S]{0,60}idempotency_key/i);
  });

  it("guarda turn_id, request_id e call_id — reserva por turno, consolidação por chamada", () => {
    for (const c of ["turn_id", "request_id", "call_id"]) expect(usage).toContain(c);
  });
});

describe("ai_cost_reservations", () => {
  it("os três valores são não negativos", () => {
    for (const c of ["reserved_cents", "consumed_cents", "released_cents"]) {
      expect(usage).toMatch(new RegExp(`${c}[\\s\\S]{0,200}check\\s*\\(${c}\\s*>=\\s*0\\)`, "i"));
    }
  });

  it("expires_at é obrigatório — reserva órfã de crash não come o teto para sempre", () => {
    expect(usage).toMatch(/expires_at\s+timestamptz\s+not null/i);
  });

  it("estados terminais são carimbados por finalized_at, não só a liquidação", () => {
    expect(usage).toContain("finalized_at");
    expect(usage).toMatch(/status[\s\S]{0,200}'HELD'[\s\S]{0,120}'SETTLED'[\s\S]{0,60}'RELEASED'[\s\S]{0,60}'EXPIRED'/);
  });

  it("reserva com usage pendente SAI do caminho de expiração automática", () => {
    // Sem esta coluna o TTL de recuperação de crash vira porta de saída para
    // consumo não contabilizado: bastaria toda resposta vazia esperar 5 minutos.
    expect(usage).toContain("usage_review_required");
  });

  it("uma reserva por (organização, chave de idempotência)", () => {
    expect(usage).toMatch(/unique[\s\S]{0,160}organization_id[\s\S]{0,80}idempotency_key/i);
  });
});

describe("nenhuma migration do Plano D embute segredo ou host", () => {
  it("sem chave, token, JWT ou URL de projeto", () => {
    for (const src of all) {
      expect(src).not.toMatch(/sk-|sk-ant-|xai-|re_|AIza|eyJ[A-Za-z0-9_-]{10}/);
      expect(src).not.toMatch(/service_role_key|SERVICE_ROLE_KEY/);
      expect(src).not.toMatch(/https:\/\/[a-z0-9]{20}\.supabase\.co/);
    }
  });

  it("controle positivo: o detector realmente pega o padrão", () => {
    expect("Authorization: Bearer eyJhbGciOiJIUzI1").toMatch(/eyJ[A-Za-z0-9_-]{10}/);
  });
});

const rpcs = read("102_ai_budget_rpcs");

const RPC_NAMES = [
  "open_ai_cycle_budget",
  "reserve_ai_budget",
  "extend_ai_reservation",
  "record_ai_call_usage",
  "finalize_ai_reservation",
];

describe("RPCs do orçamento (102)", () => {
  for (const fn of RPC_NAMES) {
    it(`${fn}: existe, é SECURITY DEFINER e fixa o search_path`, () => {
      const i = rpcs.indexOf(`function public.${fn}(`);
      expect(i, `${fn} não encontrada`).toBeGreaterThan(-1);
      const body = rpcs.slice(i, rpcs.indexOf("$$;", i));
      expect(body).toContain("security definer");
      expect(body).toMatch(/set search_path\s*=/);
    });

    it(`${fn}: revoga PUBLIC/anon/authenticated e concede só a service_role`, () => {
      // CREATE FUNCTION concede EXECUTE a PUBLIC por padrão e o schema public é
      // exposto ao PostgREST com a anon key.
      expect(rpcs).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\)\\s*\\n?\\s*from public, anon, authenticated`));
      expect(rpcs).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s*\\n?\\s*to service_role`));
      expect(rpcs).not.toMatch(new RegExp(`grant execute on function public\\.${fn}[^;]*to (anon|authenticated)`));
    });
  }

  it("o orçamento é lido sob lock de linha — não advisory lock", () => {
    expect(rpcs).toMatch(/from ai_cycle_budgets[\s\S]{0,200}for update/i);
    expect(rpcs).not.toMatch(/pg_try_advisory_lock/);
  });

  it("a fórmula do disponível separa liquidado de comprometido", () => {
    expect(rpcs).toMatch(/reserved_cents\s*-\s*consumed_cents/);
    expect(rpcs).toMatch(/limit_cents\s*-\s*[\s\S]{0,80}settled_cents/);
  });

  it("a varredura de expiradas NUNCA toca reserva com usage pendente", () => {
    expect(rpcs).toMatch(/usage_review_required\s*=\s*false/);
  });

  it("reserva expirada não autoriza chamada e reserva terminal não volta a ativa", () => {
    expect(rpcs).toMatch(/status\s*=\s*'HELD'/);
    expect(rpcs).toContain("'EXPIRED'");
  });

  it("record_ai_call_usage é idempotente por chave", () => {
    expect(rpcs).toMatch(/on conflict[\s\S]{0,120}do nothing/i);
    expect(rpcs).toContain("applied");
  });

  it("usage indeterminado marca a reserva e não libera nada automaticamente", () => {
    expect(rpcs).toMatch(/USAGE_REVIEW_REQUIRED[\s\S]{0,400}usage_review_required\s*=\s*true/i);
  });

  it("o esgotamento carimba o momento — não é só um estado derivado", () => {
    expect(rpcs).toMatch(/state\s*=\s*'EXHAUSTED'[\s\S]{0,160}exhausted_at/);
  });

  it("nenhuma RPC conta conversa, mensagem ou interação", () => {
    expect(rpcs).not.toMatch(/count\(\*\)[\s\S]{0,80}from conversations/i);
    expect(rpcs).not.toMatch(/message_count|conversation_count|interaction_count/i);
  });

  it("controle positivo: o detector de grant realmente funciona", () => {
    expect("grant execute on function public.reserve_ai_budget(uuid) to anon").toMatch(
      /grant execute on function public\.reserve_ai_budget[^;]*to (anon|authenticated)/,
    );
  });

  it("custo tardio de reserva já finalizada conta no ciclo, não some", () => {
    // O evento fica no ledger de qualquer jeito; o que não pode é o dinheiro
    // não chegar a settled_cents. Descartá-lo seria franquia adicional silenciosa.
    const i = rpcs.indexOf("function public.record_ai_call_usage(");
    const body = rpcs.slice(i, rpcs.indexOf("$$;", i));
    expect(body).toMatch(/status\s*<>\s*'HELD'/);
    expect(body).toMatch(/settled_cents\s*=\s*settled_cents\s*\+/);
  });

  it("extend_ai_reservation lê a reserva sob lock e só amplia reserva HELD", () => {
    const i = rpcs.indexOf("function public.extend_ai_reservation(");
    const body = rpcs.slice(i, rpcs.indexOf("$$;", i));
    expect(body).toMatch(/from ai_cost_reservations[\s\S]{0,200}for update/i);
    expect(body).toMatch(/update ai_cost_reservations[\s\S]{0,300}and status = 'HELD'/i);
  });
});
