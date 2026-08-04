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
const rpcs = read("102_ai_budget_rpcs");
const milestones = read("103_ai_budget_milestones");
/**
 * AS CINCO, não três. A varredura de segredo abaixo itera esta lista, e 102/103
 * são justamente as migrations que montam funções `SECURITY DEFINER` e
 * `grant execute` — a superfície onde uma chave literal teria motivo plausível
 * para aparecer (foi assim que uma `INTERNAL_API_KEY` em claro atravessou 88
 * dias num `create trigger ... http_request(...)`). Deixá-las de fora era um
 * ponto cego com cara de cobertura.
 */
const all = [prices, budgets, usage, rpcs, milestones];

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
    // Alias OPCIONAL nos dois lados: a doutrina do cabeçalho da 102 manda
    // qualificar toda coluna que possa vir a ser homônima de OUT param, e a
    // versão anterior deste padrão (`reserved_cents - consumed_cents`, cru) só
    // continuava verde por causa da ÚNICA ocorrência que ainda não estava
    // qualificada — ou seja, estava ancorada no defeito.
    expect(rpcs).toMatch(/(?:\w+\.)?reserved_cents\s*-\s*(?:\w+\.)?consumed_cents/);
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
    // O lado direito aceita alias (`b.settled_cents`) — qualificar é a doutrina
    // do cabeçalho da 102, e exigir a forma crua reprovaria o código correto.
    const i = rpcs.indexOf("function public.record_ai_call_usage(");
    const body = rpcs.slice(i, rpcs.indexOf("$$;", i));
    expect(body).toMatch(/status\s*<>\s*'HELD'/);
    expect(body).toMatch(/settled_cents\s*=\s*(?:\w+\.)?settled_cents\s*\+/);
  });

  it("extend_ai_reservation lê a reserva sob lock e só amplia reserva HELD", () => {
    const i = rpcs.indexOf("function public.extend_ai_reservation(");
    const body = rpcs.slice(i, rpcs.indexOf("$$;", i));
    expect(body).toMatch(/from ai_cost_reservations[\s\S]{0,200}for update/i);
    // Com alias: toda referência a coluna homônima de OUT param é qualificada
    // (ver o bloco "sem ambiguidade de coluna" abaixo).
    expect(body).toMatch(/update ai_cost_reservations r[\s\S]{0,400}and r\.status = 'HELD'/i);
  });

  it("as cinco RPCs travam o orçamento ANTES da reserva — ordem de lock única", () => {
    // Inverter em UMA delas reintroduz deadlock entre a varredura de expiradas
    // (reserve_ai_budget) e a extensão de reserva.
    for (const fn of RPC_NAMES) {
      const i = rpcs.indexOf(`function public.${fn}(`);
      const body = rpcs.slice(i, rpcs.indexOf("$$;", i));
      const budgetLock = body.search(/from ai_cycle_budgets[\s\S]{0,200}?for update/i);
      const resLock = body.search(/from ai_cost_reservations[\s\S]{0,200}?for update/i);
      if (budgetLock === -1 || resLock === -1) continue; // função que só trava um dos dois
      expect(budgetLock, `${fn} trava a reserva antes do orçamento`).toBeLessThan(resLock);
    }
  });

  it("controle positivo: o detector de ordem enxerga os dois locks", () => {
    const i = rpcs.indexOf("function public.finalize_ai_reservation(");
    const body = rpcs.slice(i, rpcs.indexOf("$$;", i));
    expect(body.search(/from ai_cycle_budgets[\s\S]{0,200}?for update/i)).toBeGreaterThan(-1);
    expect(body.search(/from ai_cost_reservations[\s\S]{0,200}?for update/i)).toBeGreaterThan(-1);
  });
});

describe("ledger dos marcos (103)", () => {
  it("RLS habilitada, forçada e só platform_admin", () => {
    expect(milestones).toContain("alter table ai_budget_milestones enable row level security");
    expect(milestones).toContain("alter table ai_budget_milestones force row level security");
    expect(milestones).toContain("platform_admin_all_ai_budget_milestones");
  });

  it("cada marco dispara no máximo uma vez por ciclo — UNIQUE (cycle_id, milestone_percent)", () => {
    expect(milestones).toMatch(/unique\s*\(\s*cycle_id\s*,\s*milestone_percent\s*\)/i);
  });

  it("o vocabulário de marco é fechado nos quatro percentuais", () => {
    expect(milestones).toMatch(/milestone_percent[\s\S]{0,200}in\s*\(\s*70\s*,\s*80\s*,\s*90\s*,\s*100\s*\)/i);
  });

  it("distingue 'registrei o marco' de 'o aviso foi enfileirado'", () => {
    // Sem notified_at separado, uma falha de enfileiramento seria indistinguível
    // de sucesso e o aviso morreria em silêncio.
    expect(milestones).toContain("notified_at");
    expect(milestones).toContain("enqueue_attempts");
  });

  it("registra se o dispatch estava ligado — 'não recebi e-mail' não é 'não houve alerta'", () => {
    expect(milestones).toContain("dispatch_enabled_at_enqueue");
  });

  it("guarda o custo liquidado no momento do marco — auditável depois", () => {
    expect(milestones).toContain("settled_cents_at_cross");
  });
});

// ─── Cobertura de preço × catálogo de modelos ──────────────────────────────
//
// Depois que preço desconhecido passou a FALHAR FECHADO em qualquer modo,
// acrescentar um modelo a `KNOWN_MODELS` sem semear preço na 099 CALA o agente
// da organização que o resolver. A cobertura de hoje é exata, mas isso é
// coincidência, não invariante — este bloco a torna invariante.

const providersSrc = readFileSync(
  join(__dirname, "..", "..", "supabase", "functions", "_shared", "ai-providers.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

/** Par de chaves balanceado a partir do primeiro `{` em/depois de `from`. */
function braceBlock(src: string, from: number): string {
  const open = src.indexOf("{", from);
  if (open === -1) throw new Error(`nenhum '{' depois de ${from}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`chaves desbalanceadas a partir de ${open}`);
}

/** Pares (provider, model) declarados em `KNOWN_MODELS`. */
function knownModelPairs(src: string): Array<[string, string]> {
  const i = src.indexOf("const KNOWN_MODELS");
  if (i === -1) throw new Error("KNOWN_MODELS não encontrado em ai-providers.ts");
  const block = braceBlock(src, i);
  const out: Array<[string, string]> = [];
  for (const entry of block.matchAll(/(\w+):\s*new Set\(\[([^\]]*)\]\)/g)) {
    for (const model of entry[2].matchAll(/"([^"]+)"/g)) out.push([entry[1], model[1]]);
  }
  return out;
}

/** Só o bloco `values (...)` do seed — nunca o arquivo inteiro. */
const priceSeed = prices.slice(
  prices.indexOf("insert into ai_model_prices"),
  prices.indexOf(") as v(provider, model"),
);

function seeded(provider: string, model: string): boolean {
  const esc = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`'${provider}'\\s*,\\s*'${esc}'`).test(priceSeed);
}

describe("todo modelo conhecido tem preço semeado", () => {
  it("o extrator de KNOWN_MODELS funciona, e o recorte do seed não é o arquivo", () => {
    // Controles do detector, antes de qualquer afirmação sobre o alvo.
    const sintetico = `const KNOWN_MODELS: Record<AIProvider, ReadonlySet<string>> = {
  claude: new Set(["a-1", "a-2"]),
  gemini: new Set(["b-1"]),
};`;
    expect(knownModelPairs(sintetico)).toEqual([
      ["claude", "a-1"],
      ["claude", "a-2"],
      ["gemini", "b-1"],
    ]);
    expect(priceSeed.length, "o recorte do seed ficou vazio").toBeGreaterThan(200);
    expect(priceSeed.length, "o recorte do seed engoliu o arquivo").toBeLessThan(prices.length * 0.5);
    expect(priceSeed, "o recorte perdeu as linhas de preço").toContain("'gemini-2.5-flash'");
    // Negativo: um par que NÃO está no seed tem de dar falso, senão a checagem
    // abaixo passaria com qualquer coisa.
    expect(seeded("gemini", "gemini-9.9-inexistente")).toBe(false);
    expect(seeded("claude", "claude-haiku-4-5")).toBe(true);
  });

  it("cada par (provider, model) de KNOWN_MODELS tem linha no seed da 099", () => {
    // Preço desconhecido falha FECHADO em qualquer modo (sem preço não há
    // price_id, que é NOT NULL): um modelo conhecido sem preço não degrada, cala.
    const pairs = knownModelPairs(providersSrc);
    expect(pairs.length, "o extrator não achou os modelos reais").toBeGreaterThanOrEqual(8);
    for (const [provider, model] of pairs) {
      expect(seeded(provider, model), `modelo conhecido sem preço semeado: ${provider}/${model}`).toBe(
        true,
      );
    }
  });

  it("o fallback de cada provedor também tem preço — é o modelo da 2ª tentativa", () => {
    // GUARDA PARA O FUTURO, e é honesto dizer: hoje o único fallback não-nulo
    // (`gemini-2.5-pro`) também está em KNOWN_MODELS, então este caso é
    // subconjunto estrito do anterior e não prova nada sozinho. Ele ganha dente
    // no dia em que um fallback FORA de KNOWN_MODELS aparecer — e é justamente
    // esse dia que interromperia a IA no momento em que o modelo principal
    // falhou, com o preço faltando só na segunda tentativa.
    const block = braceBlock(providersSrc, providersSrc.indexOf("const FALLBACK_MODELS"));
    for (const m of block.matchAll(/(\w+):\s*"([^"]+)"/g)) {
      expect(seeded(m[1], m[2]), `fallback sem preço semeado: ${m[1]}/${m[2]}`).toBe(true);
    }
  });
});

// ─── Toque atômico do marco (103) ──────────────────────────────────────────

describe("touch_ai_budget_milestone (103)", () => {
  it("existe, é SECURITY DEFINER e fixa o search_path", () => {
    const i = milestones.indexOf("function public.touch_ai_budget_milestone(");
    expect(i, "a função de toque não existe").toBeGreaterThan(-1);
    const body = milestones.slice(i, milestones.indexOf("$$;", i));
    expect(body).toContain("security definer");
    expect(body).toMatch(/set search_path\s*=/);
  });

  it("revoga PUBLIC/anon/authenticated e concede só a service_role", () => {
    expect(milestones).toMatch(
      /revoke all on function public\.touch_ai_budget_milestone\([^)]*\)\s*\n?\s*from public, anon, authenticated/,
    );
    expect(milestones).toMatch(
      /grant execute on function public\.touch_ai_budget_milestone\([^)]*\)\s*\n?\s*to service_role/,
    );
    expect(milestones).not.toMatch(
      /grant execute on function public\.touch_ai_budget_milestone[^;]*to (anon|authenticated)/,
    );
  });

  it("o incremento é avaliado NO SERVIDOR, e o teto entra no mesmo UPDATE", () => {
    // Read-modify-write no cliente perde tentativa sob concorrência genuína.
    // Alias opcional: `m.enqueue_attempts + 1` é igualmente do servidor, e
    // qualificar é a doutrina do cabeçalho da 102 (ver o bloco de SET abaixo).
    expect(milestones).toMatch(/set enqueue_attempts = (?:\w+\.)?enqueue_attempts \+ 1/);
    const i = milestones.indexOf("update ai_budget_milestones");
    const stmt = milestones.slice(i, milestones.indexOf("returning", i));
    expect(stmt, "o toque não é escopado por tenant").toContain("organization_id = p_organization_id");
    expect(stmt, "o toque reenfileira aviso já enviado").toContain("notified_at is null");
    expect(stmt, "o teto não é aplicado no mesmo UPDATE").toContain("enqueue_attempts <");
  });

  it("recusa DIZ por que — e cada motivo está no ramo que o produz", () => {
    // Só exigir que os três literais existam fica verde se os RAMOS forem
    // trocados entre si, que é o erro plausível (copiar/colar o bloco e esquecer
    // de trocar o texto). O recorte é a própria cadeia `if / elsif / else`.
    const i = milestones.indexOf("function public.touch_ai_budget_milestone(");
    const body = milestones.slice(i, milestones.indexOf("$$;", i));
    const chain = body.slice(body.lastIndexOf("if not found then"));
    const aElsif = chain.indexOf("elsif");
    const aElse = chain.indexOf("else", aElsif);
    const aEnd = chain.indexOf("end if;");
    expect(aElsif, "a cadeia de motivos sumiu").toBeGreaterThan(-1);
    expect(aElse, "a cadeia perdeu o ramo final").toBeGreaterThan(aElsif);
    expect(aEnd, "a cadeia não fecha").toBeGreaterThan(aElse);

    const ramoNaoExiste = chain.slice(0, aElsif);
    const ramoJaAvisado = chain.slice(aElsif, aElse);
    const ramoTetoEstourado = chain.slice(aElse, aEnd);

    expect(ramoNaoExiste, "linha ausente/tenant errado não devolve not_found").toContain(
      "'not_found'",
    );
    expect(ramoJaAvisado, "o ramo de notified_at não é o de already_notified").toContain(
      "notified_at is not null",
    );
    expect(ramoJaAvisado).toContain("'already_notified'");
    expect(ramoTetoEstourado, "o ramo restante não devolve attempts_exhausted").toContain(
      "'attempts_exhausted'",
    );
    // E nenhum motivo aparece em dois ramos — troca de blocos ficaria verde.
    for (const [nome, ramo] of [
      ["not_found", ramoNaoExiste],
      ["already_notified", ramoJaAvisado],
      ["attempts_exhausted", ramoTetoEstourado],
    ] as const) {
      for (const outro of ["not_found", "already_notified", "attempts_exhausted"]) {
        if (outro === nome) continue;
        expect(ramo, `o ramo de ${nome} também devolve ${outro}`).not.toContain(`'${outro}'`);
      }
    }
  });
});

// ─── Ambiguidade de coluna × OUT param (42702) ─────────────────────────────
//
// `RETURNS TABLE` declara cada coluna de saída como VARIÁVEL plpgsql em escopo
// no corpo inteiro. Referenciar uma coluna de tabela homônima sem qualificar
// estoura 42702 em TEMPO DE EXECUÇÃO — a migration aplica limpa e a RPC quebra
// na primeira chamada real, que é o pior lugar possível para descobrir.
//
// O detector abaixo codifica a REGRA REAL do Postgres, não uma aproximação: são
// isentas exatamente as duas posições que o próprio Postgres nunca substitui —
// o alvo do SET num UPDATE e a lista de colunas de um INSERT — mais, é claro, a
// referência já qualificada. Nenhuma exceção foi acrescentada para acomodar o
// código; se fosse preciso, o caso não valeria a linha.

/** Apaga comentários SQL (`--` e blocos), preservando índices. */
function blankSqlComments(src: string): string {
  const out: string[] = [];
  let mode: "code" | "line" | "block" | "str" = "code";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === "code") {
      if (c === "-" && d === "-") {
        mode = "line";
        out.push(" ", " ");
        i += 2;
        continue;
      }
      if (c === "/" && d === "*") {
        mode = "block";
        out.push(" ", " ");
        i += 2;
        continue;
      }
      if (c === "'") mode = "str";
      out.push(c);
      i++;
      continue;
    }
    if (mode === "line") {
      out.push(c === "\n" ? "\n" : " ");
      if (c === "\n") mode = "code";
      i++;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && d === "/") {
        mode = "code";
        out.push(" ", " ");
        i += 2;
        continue;
      }
      out.push(c === "\n" ? "\n" : " ");
      i++;
      continue;
    }
    // Dentro de literal: `''` é aspa escapada, não fim de literal.
    if (c === "'" && d === "'") {
      out.push(c, d);
      i += 2;
      continue;
    }
    if (c === "'") mode = "code";
    out.push(c);
    i++;
  }
  return out.join("");
}

/** Par de parênteses balanceado a partir do primeiro `(` em/depois de `from`. */
function parenRange(src: string, from: number): [number, number] {
  const open = src.indexOf("(", from);
  if (open === -1) throw new Error(`nenhum '(' depois de ${from}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return [open, i + 1];
    }
  }
  throw new Error(`parênteses desbalanceados a partir de ${open}`);
}

interface SqlFunction {
  name: string;
  /** Colunas de `returns table (...)` — as variáveis que criam a ambiguidade. */
  outNames: string[];
  /** Corpo entre `as $$` e `$$;`, com comentários apagados. */
  body: string;
}

function parseSqlFunctions(src: string): SqlFunction[] {
  const clean = blankSqlComments(src);
  const out: SqlFunction[] = [];
  for (const m of clean.matchAll(/create or replace function public\.(\w+)\(/g)) {
    const head = clean.slice(m.index!);
    const rt = head.indexOf("returns table");
    const bodyStart = head.indexOf("as $$");
    if (rt === -1 || bodyStart === -1 || rt > bodyStart) continue; // não devolve tabela
    const [a, b] = parenRange(head, rt);
    const outNames = head
      .slice(a + 1, b - 1)
      .split(",")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((n) => /^[a-z_][a-z0-9_]*$/.test(n));
    const bodyEnd = head.indexOf("$$;", bodyStart);
    out.push({
      name: m[1],
      outNames,
      body: head.slice(bodyStart, bodyEnd === -1 ? head.length : bodyEnd),
    });
  }
  return out;
}

/** Intervalos das listas de colunas de INSERT — posição que o Postgres não substitui. */
function insertColumnRanges(body: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of body.matchAll(/insert into\s+\w+\s*\(/g)) {
    out.push(parenRange(body, m.index! + m[0].length - 1));
  }
  return out;
}

/**
 * Ocorrências de `name` no corpo que NÃO são: qualificadas (`x.name`), alvo de
 * SET, ou item de lista de colunas de INSERT. Cada uma dessas é 42702 na
 * primeira chamada.
 */
function ambiguousRefs(fn: SqlFunction, name: string): number[] {
  const inserts = insertColumnRanges(fn.body);
  const hits: number[] = [];
  for (const m of fn.body.matchAll(new RegExp(`\\b${name}\\b`, "g"))) {
    const i = m.index!;
    // 1. Qualificada: `alias.name` (ou `v_row.name`, que é campo de record).
    if (fn.body[i - 1] === ".") continue;
    // 2. Lista de colunas de INSERT.
    if (inserts.some(([s, e]) => i > s && i < e)) continue;
    // 3. Alvo de SET: `set name =` ou `, name =` (dentro de um UPDATE ... set).
    const depois = fn.body.slice(i + name.length).match(/^\s*=/);
    const antes = fn.body.slice(0, i).match(/(?:\bset\b|,)\s*$/i);
    if (depois && antes) continue;
    hits.push(i);
  }
  return hits;
}

const SQL_FUNCTION_SOURCES: Array<[string, string]> = [
  ["102", rpcs],
  ["103", milestones],
];

describe("nenhuma RPC referencia coluna homônima de OUT param sem qualificar", () => {
  it("controle do detector: pega a referência crua e ignora as três posições isentas", () => {
    const sintetico = `
create or replace function public.f_ruim(p_id uuid)
returns table (
  reserved_cents integer,
  consumed_cents integer
)
language plpgsql
as $$
begin
  -- comentario citando reserved_cents de proposito
  insert into t (reserved_cents, consumed_cents) values (1, 2);
  update t set reserved_cents = 5 where id = p_id;
  update t x set consumed_cents = x.consumed_cents + 1 where x.id = p_id;
  select reserved_cents into v from t where id = p_id;
end;
$$;
`;
    const [fn] = parseSqlFunctions(sintetico);
    expect(fn.name).toBe("f_ruim");
    expect(fn.outNames).toEqual(["reserved_cents", "consumed_cents"]);
    // A ÚNICA referência crua é a do último select. As outras são: comentário
    // (apagado), lista de INSERT, alvo de SET, e qualificada por alias.
    expect(ambiguousRefs(fn, "reserved_cents")).toHaveLength(1);
    expect(ambiguousRefs(fn, "consumed_cents")).toHaveLength(0);
  });

  it("as funções com returns table são todas encontradas", () => {
    const nomes = SQL_FUNCTION_SOURCES.flatMap(([, src]) => parseSqlFunctions(src)).map((f) => f.name);
    for (const esperada of [...RPC_NAMES, "touch_ai_budget_milestone"]) {
      expect(nomes, `função não encontrada pelo detector: ${esperada}`).toContain(esperada);
    }
  });

  for (const [migration, src] of SQL_FUNCTION_SOURCES) {
    for (const fn of parseSqlFunctions(src)) {
      it(`${migration}/${fn.name}: toda coluna homônima de OUT param é qualificada`, () => {
        expect(fn.outNames.length, "OUT params não extraídos").toBeGreaterThan(0);
        for (const name of fn.outNames) {
          const hits = ambiguousRefs(fn, name);
          expect(
            hits,
            `${fn.name}: '${name}' referenciado sem qualificar (42702 na 1ª chamada) nos índices ${hits.join(", ")}`,
          ).toEqual([]);
        }
      });
    }
  }

  it("`#variable_conflict use_column` não é usado — troca erro barulhento por bug quieto", () => {
    // Sobre o CÓDIGO, não sobre a prosa: o cabeçalho da 102 explica de propósito
    // por que a diretiva é proibida, e citá-la não é usá-la.
    for (const [, src] of SQL_FUNCTION_SOURCES) {
      expect(blankSqlComments(src)).not.toMatch(/#variable_conflict/i);
    }
    // Controle: a prosa realmente menciona, e o detector não confunde as duas.
    expect(rpcs, "a explicação da proibição sumiu do cabeçalho").toMatch(/#variable_conflict/i);
  });
});

// ─── Ordem de lock × locks IMPLÍCITOS de FK (40P01) ────────────────────────
//
// O caso irmão acima ("as cinco RPCs travam o orçamento ANTES da reserva") mede
// a posição dos `for update` EXPLÍCITOS e é estruturalmente cego ao lock que
// uma FK adquire sozinha: toda checagem de chave estrangeira roda
// `select … for key share` na linha-pai, então um `insert into ai_usage_events`
// trava, por si só, a linha do orçamento e a da reserva. Com o INSERT antes do
// `for update` do orçamento, a mesma transação segurava KEY SHARE e depois pedia
// UPDATE na MESMA linha — deadlock de upgrade contra qualquer concorrente da
// organização já na fila.
//
// Sobre o corpo com COMENTÁRIOS APAGADOS: a prosa do arquivo cita
// `insert into ai_usage_events` e `for update` de propósito, e medir posição
// sobre o texto cru mediria a explicação em vez do código.

describe("record_ai_call_usage: o INSERT não precede o lock do orçamento", () => {
  const cleanRpcs = blankSqlComments(rpcs);
  const inicio = cleanRpcs.indexOf("create or replace function public.record_ai_call_usage(");
  const body = cleanRpcs.slice(inicio, cleanRpcs.indexOf("$$;", inicio));

  it("o recorte é o corpo da função, e não o arquivo", () => {
    expect(inicio, "a função sumiu do arquivo").toBeGreaterThan(-1);
    expect(body.length, "recorte vazio").toBeGreaterThan(400);
    expect(body.length, "o recorte engoliu o arquivo").toBeLessThan(rpcs.length * 0.6);
    expect(body, "o recorte perdeu a função vizinha de propósito").not.toContain(
      "function public.finalize_ai_reservation(",
    );
  });

  it("o `for update` do orçamento vem ANTES do insert em ai_usage_events", () => {
    const lock = body.search(/from ai_cycle_budgets[\s\S]*?for update/i);
    const ins = body.indexOf("insert into ai_usage_events");
    expect(lock, "o lock do orçamento sumiu do corpo").toBeGreaterThan(-1);
    expect(ins, "o INSERT do evento sumiu do corpo").toBeGreaterThan(-1);
    expect(
      ins,
      "o INSERT voltou a preceder o lock: as FKs dele travam orçamento e reserva em KEY SHARE, e o `for update` seguinte vira upgrade (40P01)",
    ).toBeGreaterThan(lock);
  });

  it("a guarda de `not found` do orçamento fica ENTRE o lock e o INSERT", () => {
    // Sem ela, `v_budget` fica NULL, o ramo de custo tardio calcula NULL e roda
    // `update … where id = null`: zero linhas, zero erro, custo tardio sumindo
    // em silêncio. Depois do INSERT ela não serve — o evento já teria entrado
    // apontando para um ciclo que a transação não conseguiu travar.
    const lock = body.search(/from ai_cycle_budgets[\s\S]*?for update/i);
    const ins = body.indexOf("insert into ai_usage_events");
    const guarda = body.indexOf("if not found then", lock);
    expect(guarda, "a guarda de orçamento inexistente não existe").toBeGreaterThan(lock);
    expect(guarda, "a guarda ficou depois do INSERT — não protege mais nada").toBeLessThan(ins);
  });

  it("a anomalia é DISTINGUÍVEL pelo chamador, não um turno de aparência normal", () => {
    // `applied = false` sozinho já significava "reexecução idempotente", que é
    // rotina. Sem uma coluna própria, "o orçamento sumiu" chegava ao adapter com
    // a mesma forma de um turno em que tudo deu certo.
    expect(body, "a coluna de motivo sumiu do retorno").toContain("reason_code");
    expect(body, "o orçamento inexistente deixou de ter motivo próprio").toContain(
      "'cycle_not_found'",
    );
    const gate = readFileSync(
      join(__dirname, "..", "..", "supabase", "functions", "_shared", "ai-budget-gate.ts"),
      "utf8",
    );
    expect(gate, "o adapter não loga a anomalia que a RPC passou a informar").toContain(
      "ai_usage_record_not_applied",
    );
  });
});

// ─── Coluna crua no lado DIREITO de um SET ─────────────────────────────────
//
// O detector genérico de 42702 acima só enxerga coluna que é OUT param DAQUELA
// função — e é por isso que reverter a qualificação de `settled_cents` (102) ou
// de `reserved_cents - consumed_cents` (finalize) passava VERDE: nenhuma das
// duas é OUT param da função onde aparece. As duas estavam corretas por
// ACIDENTE da lista de retorno vigente, que é a coisa que mais muda no arquivo.
//
// A regra é a doutrina do cabeçalho da 102, sem lista de exceção: **no lado
// direito de um `set`, nenhuma coluna da tabela atualizada aparece crua**. O
// alvo do SET (esquerda) é isento porque o Postgres proíbe qualificá-lo.
//
// LIMITE DECLARADO: a regra cobre o SET, não o WHERE. Qualificar o WHERE
// exigiria alias em `touch_ai_budget_milestone` inteiro e reescreveria três
// asserções que hoje leem o predicado por texto — trabalho maior que o risco,
// já que `id`/`organization_id` não são nome de OUT param em nenhuma das seis
// funções. Se alguma passar a ser, esta é a fresta.

/** Colunas declaradas por uma `create table if not exists <t> (…)`. */
function tableColumns(src: string, table: string): string[] {
  const clean = blankSqlComments(src);
  const i = clean.indexOf(`create table if not exists ${table} (`);
  if (i === -1) return [];
  const [a, b] = parenRange(clean, i);
  const inner = clean.slice(a + 1, b - 1);
  const partes: string[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      partes.push(inner.slice(start, k));
      start = k + 1;
    }
  }
  partes.push(inner.slice(start));
  const NAO_COLUNA = new Set(["constraint", "check", "unique", "primary", "foreign", "exclude"]);
  const out: string[] = [];
  for (const p of partes) {
    const tok = p.trim().split(/\s+/)[0];
    if (!/^[a-z_][a-z0-9_]*$/.test(tok) || NAO_COLUNA.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

interface SetAssign {
  tabela: string;
  alvo: string;
  rhs: string;
}

/** Cada `<coluna> = <expressão>` das cláusulas SET de um arquivo. */
function setAssignments(src: string): SetAssign[] {
  const clean = blankSqlComments(src);
  const out: SetAssign[] = [];
  for (const m of clean.matchAll(/\bupdate\s+([a-z_][a-z0-9_]*)\s+(?:([a-z_][a-z0-9_]*)\s+)?set\b/gi)) {
    const tabela = m[1];
    const ini = m.index! + m[0].length;
    const fim = clean.indexOf(";", ini);
    const corpo = clean.slice(ini, fim === -1 ? clean.length : fim);
    // A cláusula SET termina no primeiro `where`/`returning` de profundidade 0.
    let depth = 0;
    let setFim = corpo.length;
    for (let k = 0; k < corpo.length; k++) {
      const c = corpo[k];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (depth === 0 && /\s/.test(c) && /^\s(where|returning)\b/i.test(corpo.slice(k, k + 11))) {
        setFim = k;
        break;
      }
    }
    const setClause = corpo.slice(0, setFim);
    // Fatia por vírgulas de profundidade 0 — o `case … end` interno não conta.
    depth = 0;
    let start = 0;
    const pedacos: string[] = [];
    for (let k = 0; k < setClause.length; k++) {
      const c = setClause[k];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === "," && depth === 0) {
        pedacos.push(setClause.slice(start, k));
        start = k + 1;
      }
    }
    pedacos.push(setClause.slice(start));
    for (const p of pedacos) {
      const eq = p.indexOf("=");
      if (eq === -1) continue;
      out.push({ tabela, alvo: p.slice(0, eq).trim(), rhs: p.slice(eq + 1) });
    }
  }
  return out;
}

/** Tokens do RHS que são coluna da tabela e NÃO estão qualificados. */
function colunasCruasNoRhs(a: SetAssign, colunas: string[]): string[] {
  const conhecidas = new Set(colunas);
  const cruas: string[] = [];
  for (const m of a.rhs.matchAll(/[a-z_][a-z0-9_]*/g)) {
    if (a.rhs[m.index! - 1] === ".") continue; // qualificada
    if (conhecidas.has(m[0])) cruas.push(m[0]);
  }
  return cruas;
}

const SCHEMA_SOURCES = [budgets, usage, milestones];

function colunasDe(tabela: string): string[] {
  for (const src of SCHEMA_SOURCES) {
    const cols = tableColumns(src, tabela);
    if (cols.length) return cols;
  }
  return [];
}

describe("nenhum SET referencia coluna crua da tabela atualizada", () => {
  it("controle do extrator de colunas", () => {
    const cols = colunasDe("ai_cycle_budgets");
    expect(cols, "as colunas reais não foram extraídas").toContain("settled_cents");
    expect(cols).toContain("exhausted_at");
    expect(cols, "uma constraint entrou como se fosse coluna").not.toContain("constraint");
    expect(colunasDe("ai_cost_reservations")).toContain("consumed_cents");
    expect(colunasDe("ai_budget_milestones")).toContain("enqueue_attempts");
  });

  it("controle do detector: pega a forma crua e ignora a qualificada", () => {
    const sintetico = `
update ai_cycle_budgets set settled_cents = settled_cents + 1 where id = v;
update ai_cycle_budgets b set settled_cents = b.settled_cents + 1 where b.id = v;
`;
    const [cru, ok] = setAssignments(sintetico);
    const cols = colunasDe("ai_cycle_budgets");
    expect(colunasCruasNoRhs(cru, cols), "o detector não viu a coluna crua").toEqual([
      "settled_cents",
    ]);
    expect(colunasCruasNoRhs(ok, cols), "o detector acusou a forma qualificada").toEqual([]);
  });

  it("o detector alcança os SET reais das duas migrations", () => {
    // Sanidade GLOBAL, não por arquivo: a 103 tem um único UPDATE (o toque
    // atômico), e exigir um piso alto nela reprovaria o arquivo correto.
    const total = SQL_FUNCTION_SOURCES.reduce((n, [, src]) => n + setAssignments(src).length, 0);
    expect(total, "o detector deixou de enxergar os UPDATEs — piso de sanidade").toBeGreaterThan(10);
    const tabelas = new Set(
      SQL_FUNCTION_SOURCES.flatMap(([, src]) => setAssignments(src).map((a) => a.tabela)),
    );
    expect(tabelas, "o detector perdeu os UPDATEs do orçamento").toContain("ai_cycle_budgets");
    expect(tabelas, "o detector perdeu os UPDATEs da reserva").toContain("ai_cost_reservations");
    expect(tabelas, "o detector perdeu o toque do marco").toContain("ai_budget_milestones");
  });

  for (const [migration, src] of SQL_FUNCTION_SOURCES) {
    it(`${migration}: todo lado direito de SET é qualificado`, () => {
      const atribuicoes = setAssignments(src);
      expect(atribuicoes.length, "nenhum SET encontrado neste arquivo").toBeGreaterThan(0);
      for (const a of atribuicoes) {
        const cruas = colunasCruasNoRhs(a, colunasDe(a.tabela));
        expect(
          cruas,
          `${migration}: \`set ${a.alvo} = …\` em ${a.tabela} referencia ${cruas.join(", ")} sem qualificar — correto só enquanto essa coluna não for OUT param (42702 na 1ª chamada)`,
        ).toEqual([]);
      }
    });
  }
});

// ─── Correções da revisão final de branch ──────────────────────────────────

describe("099 — a extensão não polui `public`", () => {
  it("btree_gist é criada no schema `extensions`", () => {
    // Sem a cláusula, ~100 funções de suporte nascem em `public` com EXECUTE
    // para PUBLIC, e `audit_function_acl()` varre `public` SEM filtrar por
    // extensão: o job `acl-com-banco` passaria a reprovar com dezenas de
    // violações que ninguém introduziu — e guardrail ruidoso acaba ignorado.
    expect(prices).toMatch(/create extension if not exists btree_gist\s+with schema extensions/i);
  });

  it("controle: o detector reprova a forma sem schema", () => {
    expect("create extension if not exists btree_gist;").not.toMatch(
      /create extension if not exists btree_gist\s+with schema extensions/i,
    );
  });
});

describe("099 — o seed é reexecutável mesmo com vigência fechada", () => {
  /** O `where not exists (…)` do seed, por parênteses balanceados. */
  const predicado = (() => {
    const clean = blankSqlComments(prices);
    const i = clean.indexOf("where not exists", clean.indexOf(") as v(provider, model"));
    const [a, b] = parenRange(clean, i);
    return clean.slice(a, b);
  })();

  it("o recorte é o predicado do seed", () => {
    expect(predicado, "o recorte perdeu a subconsulta").toContain("from ai_model_prices");
    expect(predicado.length, "o recorte engoliu o arquivo").toBeLessThan(400);
  });

  it("casa provider+model e IGNORA a vigência", () => {
    // Com `and p.effective_to is null` no predicado, FECHAR a vigência de um
    // modelo (o procedimento normal para trocar preço ou câmbio) fazia o seed
    // recriar `[2026-01-01, ∞)` num replay e estourar 23P01 no EXCLUDE.
    expect(predicado).toContain("p.provider");
    expect(predicado).toContain("p.model");
    expect(
      predicado,
      "o predicado voltou a filtrar por vigência — replay estoura 23P01",
    ).not.toContain("effective_to");
  });
});

describe("100 — fechar um ciclo esgotado não apaga o carimbo", () => {
  const chk = (() => {
    const clean = blankSqlComments(budgets);
    const i = clean.indexOf("ai_cycle_budgets_exhausted_chk");
    return clean.slice(i, clean.indexOf("\n", clean.indexOf("check", i) + 200));
  })();

  it("o CHECK é implicação, não bicondicional", () => {
    // `(state = 'EXHAUSTED') = (exhausted_at is not null)` obriga a APAGAR
    // `exhausted_at` para migrar EXHAUSTED → CLOSED, destruindo o momento que a
    // coluna existe para preservar — e ele não é derivável depois.
    expect(chk).toMatch(/state\s*<>\s*'EXHAUSTED'\s+or\s+exhausted_at is not null/i);
    expect(chk, "o bicondicional voltou").not.toMatch(
      /\(\s*state\s*=\s*'EXHAUSTED'\s*\)\s*=\s*\(/i,
    );
  });

  it("controle: o detector distingue as duas formas", () => {
    const bicondicional = "check ((state = 'EXHAUSTED') = (exhausted_at is not null))";
    expect(bicondicional).not.toMatch(/state\s*<>\s*'EXHAUSTED'\s+or\s+exhausted_at is not null/i);
    expect(bicondicional).toMatch(/\(\s*state\s*=\s*'EXHAUSTED'\s*\)\s*=\s*\(/i);
  });

  it("`CLOSED` continua no vocabulário — a transição existe", () => {
    expect(budgets).toMatch(/state\s+text[\s\S]{0,200}'CLOSED'/);
  });
});

describe("101 — a guarda de tenant cobre unit_id, não só cycle_id", () => {
  const cleanUsage = blankSqlComments(usage);
  const guardStart = cleanUsage.indexOf("function public.ai_budget_child_tenant_guard()");
  const guard = cleanUsage.slice(guardStart, cleanUsage.indexOf("$$;", guardStart));

  it("o recorte é o corpo da guarda", () => {
    expect(guardStart, "a guarda sumiu").toBeGreaterThan(-1);
    expect(guard, "o recorte perdeu a checagem de ciclo").toContain("ai_cycle_budgets");
    expect(guard.length, "o recorte engoliu o arquivo").toBeLessThan(usage.length * 0.5);
  });

  it("uma unidade de outra organização é recusada", () => {
    // As FKs garantem que a unidade EXISTE, não que é da mesma organização. Este
    // é o segundo caminho de atribuição de custo, e o cabeçalho da própria
    // função diz que ela existe para que nenhum produtor atribua custo à
    // organização errada em silêncio.
    expect(guard, "a guarda não consulta units").toMatch(/from units/i);
    expect(guard, "a guarda não compara com a organização da linha").toContain(
      "new.organization_id",
    );
    expect(guard, "não há recusa própria de unidade").toContain(
      "unit_id pertence a outra organizacao",
    );
  });

  it("não acessa `new.unit_id` cru — a função é compartilhada com tabelas sem a coluna", () => {
    // `ai_cost_reservations` e `ai_budget_milestones` não têm `unit_id`: o acesso
    // cru estoura 42703 em TEMPO DE EXECUÇÃO em todo INSERT delas, com a
    // migration aplicada limpa.
    expect(guard, "`new.unit_id` quebra as tabelas irmãs").not.toMatch(/new\.unit_id/);
    expect(guard, "o campo deixou de ser lido de forma segura").toMatch(/to_jsonb\s*\(\s*new\s*\)/);
  });

  it("a trigger de ai_usage_events dispara quando SÓ unit_id muda", () => {
    // Sem `unit_id` na lista do `update of`, a validação acima é letra morta em
    // tudo que não for INSERT.
    const i = usage.indexOf("create trigger ai_usage_events_tenant_guard");
    expect(i, "a trigger sumiu").toBeGreaterThan(-1);
    const stmt = usage.slice(i, usage.indexOf(";", i) + 1);
    expect(stmt, "unit_id ficou fora do `update of`").toMatch(/update of[^;]*\bunit_id\b/i);
  });

  it("as tabelas SEM a coluna não listam unit_id — `update of` inexistente é erro de DDL", () => {
    for (const [nome, src] of [
      ["ai_cost_reservations_tenant_guard", usage],
      ["ai_budget_milestones_tenant_guard", milestones],
    ] as const) {
      const i = src.indexOf(`create trigger ${nome}`);
      expect(i, `${nome}: trigger não encontrada`).toBeGreaterThan(-1);
      const stmt = src.slice(i, src.indexOf(";", i) + 1);
      expect(stmt, `${nome}: lista uma coluna que a tabela não tem`).not.toMatch(
        /update of[^;]*\bunit_id\b/i,
      );
    }
  });
});
