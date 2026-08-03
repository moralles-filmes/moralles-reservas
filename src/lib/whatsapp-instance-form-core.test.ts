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
