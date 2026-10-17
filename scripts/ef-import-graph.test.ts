/**
 * O grafo de imports substitui a checklist manual de redeploy de Edge Functions.
 * Se ele errar para MENOS, um deploy parcial deixa uma EF com `_shared/` velho em
 * memória — por isso os casos abaixo cobrem o que a checklist escrita já errou:
 * import em várias linhas, reexport, import de arquivo local da própria EF e
 * `import type`, que é apagado e não amplia o deploy.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — módulo .mjs sem declaração de tipos
import { buildConsumerMap, consumersOf, valueImports } from "./ef-import-graph.mjs";

const tmp = mkdtempSync(join(tmpdir(), "ef-graph-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function write(rel: string, body: string) {
  const p = join(tmp, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

describe("valueImports", () => {
  it("ignora import type e export type, aceita import multilinha e reexport", () => {
    const src = [
      'import type { A } from "./a.ts";',
      "import {",
      "  b,",
      "  c,",
      '} from "./b.ts";',
      'export { d } from "./d.ts";',
      'export type { E } from "./e.ts";',
      'import "./side.ts";',
      'import { serve } from "https://deno.land/std/http/server.ts";',
    ].join("\n");
    expect(valueImports("x.ts", src)).toEqual(["./b.ts", "./d.ts", "./side.ts"]);
  });
});

describe("buildConsumerMap (fixture)", () => {
  write("_shared/leaf.ts", "export const leaf = 1;");
  write("_shared/mid.ts", 'import { leaf } from "./leaf.ts"; export const mid = leaf;');
  write("_shared/typeonly.ts", "export type T = number;");
  write("ef-a/index.ts", 'import { mid } from "../_shared/mid.ts";');
  write("ef-b/local.ts", 'export { leaf } from "../_shared/leaf.ts";');
  write("ef-b/index.ts", 'import { leaf } from "./local.ts"; import type { T } from "../_shared/typeonly.ts";');
  const map = buildConsumerMap(tmp);
  const of = (rel: string) => map.get(join(tmp, rel)) ?? [];

  it("segue a cadeia transitiva e arquivos locais da EF", () => {
    expect(of("_shared/leaf.ts")).toEqual(["ef-a", "ef-b"]);
    expect(of("_shared/mid.ts")).toEqual(["ef-a"]);
  });

  it("import type não coloca o arquivo no bundle", () => {
    expect(of("_shared/typeonly.ts")).toEqual([]);
  });
});

describe("repositório real (fatos que a checklist antiga afirmava)", () => {
  const map = buildConsumerMap();
  it("authz.ts alcança as sete EFs de guard de unidade após os produtores", () => {
    expect(consumersOf("supabase/functions/_shared/authz.ts", map)).toEqual([
      "create-manual-reservation",
      "notify-waitlist-ready",
      "resend-notification",
      "send-cancellation",
      "send-manual-message",
      "send-scheduled-whatsapp",
      "update-reservation",
    ]);
  });
  it("ai-providers.ts tem webhook-whatsapp como único consumidor (manage-ai-providers não importa)", () => {
    expect(consumersOf("supabase/functions/_shared/ai-providers.ts", map)).toEqual(["webhook-whatsapp"]);
  });
  it("billing-cancel-core.ts só por valor em manage-billing (billing-provider importa só o tipo)", () => {
    expect(consumersOf("supabase/functions/_shared/billing-cancel-core.ts", map)).toEqual(["manage-billing"]);
  });
});
