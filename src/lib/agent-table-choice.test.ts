import { describe, expect, it } from "vitest";
import {
  choiceLabelsFromMap,
  parseTableChoice,
  resolveTableChoice,
} from "../../supabase/functions/_shared/agent/table-choice-core";

describe("parseTableChoice", () => {
  it.each([
    ["12", [12]],
    ["mesa 12", [12]],
    ["Quero a mesa 12", [12]],
    ["3+4+5", [3, 4, 5]],
    ["3, 4 e 5", [3, 4, 5]],
    ["Quero as mesas 5+3+4", [3, 4, 5]],
    ["4 4 3", [3, 4]],
  ])("%s → %j", (text, expected) => {
    expect(parseTableChoice(text)).toEqual(expected);
  });

  it.each(["mesa doze", "", "   ", "qualquer uma"])("sem número → null (%s)", (text) => {
    expect(parseTableChoice(text)).toBeNull();
  });

  it("número absurdo ou lista longa demais → null", () => {
    expect(parseTableChoice("mesa 123456")).toBeNull();
    expect(parseTableChoice(Array.from({ length: 13 }, (_, i) => i + 1).join("+"))).toBeNull();
  });

  it("entrada que não é texto → null", () => {
    expect(parseTableChoice(undefined as unknown as string)).toBeNull();
    expect(parseTableChoice(12 as unknown as string)).toBeNull();
  });
});

const tables = [
  { id: "t3", number: 3, bookable: true },
  { id: "t4", number: 4, bookable: true },
  { id: "t5", number: 5, bookable: true },
  { id: "t9", number: 9, bookable: false },
  { id: "t12", number: 12, bookable: true },
];
const combinations = [{ id: "c345", tableIds: ["t5", "t3", "t4"] }];

describe("resolveTableChoice", () => {
  it("um número → mesa reservável", () => {
    expect(resolveTableChoice([12], tables, combinations)).toEqual({ kind: "table", id: "t12" });
  });

  it("mesa não reservável → null", () => {
    expect(resolveTableChoice([9], tables, combinations)).toBeNull();
  });

  it("número que não existe no salão → null", () => {
    expect(resolveTableChoice([77], tables, combinations)).toBeNull();
  });

  it("vários números → combinação com exatamente esse conjunto", () => {
    expect(resolveTableChoice([3, 4, 5], tables, combinations)).toEqual({ kind: "combination", id: "c345" });
  });

  it("conjunto sem combinação cadastrada → null", () => {
    expect(resolveTableChoice([3, 4], tables, combinations)).toBeNull();
    expect(resolveTableChoice([3, 4, 5, 12], tables, combinations)).toBeNull();
  });

  it("número repetido no salão (ambíguo) → null", () => {
    const dup = [...tables, { id: "t12b", number: 12, bookable: true }];
    expect(resolveTableChoice([12], dup, combinations)).toBeNull();
  });

  it("lista vazia → null", () => {
    expect(resolveTableChoice([], tables, combinations)).toBeNull();
  });
});

describe("choiceLabelsFromMap", () => {
  it("rótulos das opções livres, na ordem do mapa, até o limite", () => {
    const map = {
      tables: tables.map((t) => ({ id: t.id, number: t.number })),
      options: [
        { choice: { kind: "table" as const, id: "t12" }, tableIds: ["t12"], available: false },
        { choice: { kind: "table" as const, id: "t3" }, tableIds: ["t3"], available: true },
        { choice: { kind: "table" as const, id: "t4" }, tableIds: ["t4"], available: true },
        { choice: { kind: "combination" as const, id: "c345" }, tableIds: ["t5", "t3", "t4"], available: true },
        { choice: { kind: "table" as const, id: "t5" }, tableIds: ["t5"], available: true },
      ],
    };
    expect(choiceLabelsFromMap(map, 3)).toEqual(["Mesa 3", "Mesa 4", "Mesas 3+4+5"]);
  });
});
