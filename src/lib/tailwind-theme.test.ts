import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import config from "../../tailwind.config";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- leitura solta do objeto de config
const theme: Record<string, any> = config.theme?.extend ?? {};

function readFile(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("tailwind theme (Salão em vidro)", () => {
  it("fonte é Geist", () => {
    expect(theme.fontFamily?.sans?.[0]).toBe("Geist");
    expect(theme.fontFamily?.display?.[0]).toBe("Geist");
  });

  it("index.html carrega Geist e não carrega Plus Jakarta", () => {
    const html = readFile("index.html");
    expect(html).toContain("family=Geist:wght@300..700");
    expect(html).not.toContain("Plus+Jakarta");
  });

  it("index.css não importa fonte", () => {
    const css = readFile("src/index.css");
    expect(css).not.toContain("@import url(");
  });

  it("cores e raios novos existem", () => {
    const colors = theme.colors ?? {};
    const status = colors.status ?? {};
    for (const key of ["free", "reserved", "arriving", "seated", "late", "pending"]) {
      expect(status[key]).toBeDefined();
    }
    expect(colors.gold?.ink).toBeDefined();
    expect(colors.tertiary).toBeDefined();

    const radius = theme.borderRadius ?? {};
    for (const key of ["panel", "card", "block", "item"]) {
      expect(radius[key]).toBeDefined();
    }

    expect(theme.screens?.coarse?.raw).toBe("(pointer: coarse)");
  });
});
