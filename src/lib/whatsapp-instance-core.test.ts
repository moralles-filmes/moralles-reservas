import { describe, it, expect } from "vitest";
import {
  COST_SOURCES,
  NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A,
  PROVISIONING_BLOCKED_CODE,
  assertProvisioningAllowed,
  canTransition,
  normalizeCostSource,
  parseCostCents,
  parseUuid,
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

  it("libera somente o caminho que comprova token criptografado no Vault", () => {
    expect(assertProvisioningAllowed("NEW_PROVISION", {
      credentialsEncryptedAtRest: true,
    })).toEqual({ ok: true });

    expect(assertProvisioningAllowed("AMBIGUOUS", {
      credentialsEncryptedAtRest: true,
    }).ok).toBe(false);
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
    expect(r.ok).toBe(false);
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

// ─────────────────────────────────────────────────────────────────────────
// J — custo em centavos
// ─────────────────────────────────────────────────────────────────────────
// A validação vivia duplicada em `register_instance` e `set_cost` dentro da
// Edge Function, e as duas cópias já divergiram uma vez: um payload não inteiro
// caía em erro do Postgres e virava 500 genérico num dos caminhos e 400 no
// outro. Agora é UMA função, testada.

describe("parseCostCents", () => {
  it("aceita inteiro positivo em centavos", () => {
    const r = parseCostCents(14900);
    expect(r.ok).toBe(true);
    if (r.ok && r.unknownCost === false) expect(r.cents).toBe(14900);
  });

  it("ZERO é custo verdadeiro, não desconhecido — instância cortesia", () => {
    const r = parseCostCents(0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.unknownCost).toBe(false);
    if (r.ok && r.unknownCost === false) expect(r.cents).toBe(0);
  });

  it("null e undefined são DESCONHECIDO, estado legítimo desta fase", () => {
    for (const v of [null, undefined]) {
      const r = parseCostCents(v);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.unknownCost).toBe(true);
    }
  });

  it("recusa decimal em vez de arredondar", () => {
    // Arredondar escreveria no banco um número que ninguém digitou, num campo
    // cujo propósito é dizer quanto a plataforma paga de verdade.
    expect(parseCostCents(149.5).ok).toBe(false);
    expect(parseCostCents(0.1).ok).toBe(false);
  });

  it("recusa negativo", () => {
    expect(parseCostCents(-1).ok).toBe(false);
  });

  it("recusa string, inclusive string numérica", () => {
    expect(parseCostCents("14900").ok).toBe(false);
    expect(parseCostCents("").ok).toBe(false);
    expect(parseCostCents("abc").ok).toBe(false);
  });

  it("recusa NaN e Infinity", () => {
    expect(parseCostCents(NaN).ok).toBe(false);
    expect(parseCostCents(Infinity).ok).toBe(false);
    expect(parseCostCents(-Infinity).ok).toBe(false);
  });

  it("recusa booleano, array e objeto", () => {
    for (const v of [true, false, [], {}, [1]]) {
      expect(parseCostCents(v).ok).toBe(false);
    }
  });

  it("devolve código estável para a UI diferenciar do erro genérico", () => {
    const r = parseCostCents(1.5);
    if (r.ok === false) expect(r.code).toBe("COST_NOT_INTEGER_CENTS");
  });
});

describe("parseUuid", () => {
  it("aceita UUID canônico, em qualquer caixa, com espaço em volta", () => {
    expect(parseUuid("11111111-1111-4111-8111-111111111111"))
      .toBe("11111111-1111-4111-8111-111111111111");
    expect(parseUuid("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"))
      .toBe("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE");
    expect(parseUuid("  11111111-1111-4111-8111-111111111111  "))
      .toBe("11111111-1111-4111-8111-111111111111");
  });

  it("recusa ausência e string vazia", () => {
    for (const v of [undefined, null, "", "   "]) expect(parseUuid(v)).toBeNull();
  });

  it("recusa forma inválida — é o que virava 503 e alarme falso", () => {
    // `id=eq.abc` levantava 22P02 no Postgres, o erro subia pelo caminho de
    // indisponibilidade e o operador era mandado "tentar de novo".
    for (const v of ["abc", "1111", "11111111-1111-4111-8111", "11111111111141118111111111111111"]) {
      expect(parseUuid(v)).toBeNull();
    }
  });

  it("recusa tipo não-string", () => {
    for (const v of [42, true, {}, [], ["11111111-1111-4111-8111-111111111111"]]) {
      expect(parseUuid(v)).toBeNull();
    }
  });
});

describe("normalizeCostSource", () => {
  it("ausência vira ADMIN_INFORMED — o padrão desta fase é entrada manual", () => {
    expect(normalizeCostSource(undefined)).toBe("ADMIN_INFORMED");
    expect(normalizeCostSource(null)).toBe("ADMIN_INFORMED");
  });

  it("aceita as quatro procedências canônicas", () => {
    for (const s of COST_SOURCES) expect(normalizeCostSource(s)).toBe(s);
  });

  it("recusa valor livre — a coluna não tem CHECK no banco", () => {
    expect(normalizeCostSource("CHUTE")).toBeNull();
    expect(normalizeCostSource("admin_informed")).toBeNull();
    expect(normalizeCostSource(42)).toBeNull();
  });
});
