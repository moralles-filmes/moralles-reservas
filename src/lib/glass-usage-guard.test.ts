// Teste-guarda de uso de vidro com desfoque.
// REGRA: incluir um arquivo em ALLOWED_BLUR_FILES exige que a superfície com
// backdrop-filter seja ÚNICA na tela (sobreposição, casco, painel principal).
// Nunca aplicar glass/backdrop-blur em item repetido de lista — para esses, usar .surface.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ALLOWED_BLUR_FILES = [
  "src/components/dashboard/DashboardHero.tsx",
  "src/components/layouts/AdminShell.tsx",
  "src/components/ui/dialog.tsx",
  "src/components/ui/alert-dialog.tsx",
  "src/components/ui/responsive-dialog.tsx",
  "src/components/ui/popover.tsx",
  "src/components/ui/dropdown-menu.tsx",
  "src/components/ui/tooltip.tsx",
  "src/components/ui/select.tsx",
  "src/components/ui/sonner.tsx",
  "src/components/ui/toast.tsx",
  "src/pages/Index.tsx",
  "src/pages/PublicPortal.tsx",
  "src/pages/Auth.tsx",
  "src/pages/ResetPassword.tsx",
  "src/pages/gestao/Conta.tsx",
];

const readCss = () => fs.readFileSync(path.resolve(process.cwd(), "src/index.css"), "utf8");

function collectTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsxFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

function extractBlock(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) return "";
  const open = css.indexOf("{", start);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  return css.slice(start);
}

describe("glass-usage-guard", () => {
  it("surface nunca desfoca", () => {
    const block = extractBlock(readCss(), ".surface {");
    expect(block).not.toBe("");
    expect(block).not.toContain("backdrop-filter");
  });

  it("vidro fica em @layer components, para o utilitário do chamador vencer", () => {
    const css = readCss();
    const components = extractBlock(css, "@layer components {");
    const utilities = extractBlock(css, "@layer utilities {");
    for (const cls of [".surface {", ".glass {", ".glass-strong {"]) {
      expect(components, cls).toContain(cls);
      expect(utilities, cls).not.toContain(cls);
    }
  });

  it("fallbacks existem", () => {
    const css = readCss();
    expect(css).toContain("@supports not ((backdrop-filter");
    expect(css).toContain("prefers-reduced-transparency: reduce");
  });

  it("fallbacks ficam fora de @layer e depois dos utilitários, para vencer pela ordem", () => {
    const css = readCss();
    const utilitiesLayer = css.indexOf("@layer utilities {");
    const utilitiesEnd = extractBlock(css, "@layer utilities {").length + utilitiesLayer;
    for (const marker of ["@supports not ((backdrop-filter", "@media (prefers-reduced-transparency: reduce)"]) {
      const at = css.indexOf(marker);
      expect(at, marker).toBeGreaterThan(utilitiesEnd);
      expect(css.indexOf("@layer", at), `${marker} seguido de @layer`).toBe(-1);
    }
  });

  it("vidro com desfoque só em superfícies únicas", () => {
    const pattern = /\bglass(-strong)?\b|backdrop-blur/;
    const offenders: string[] = [];

    for (const file of collectTsxFiles(path.resolve(process.cwd(), "src"))) {
      const rel = path.relative(process.cwd(), file).split(path.sep).join("/");
      // A variante "glass" do Button usa .surface (sem desfoque): o nome da
      // variante não conta como classe. A chave `glass:` só é descontada no
      // button.tsx — em outro arquivo, `cn({ glass: x })` aplica a classe.
      let source = fs
        .readFileSync(file, "utf8")
        .replace(/variant\s*[=:]\s*\{?\s*["']glass["']/g, "");
      if (rel === "src/components/ui/button.tsx") source = source.replace(/\bglass\s*:/g, "");
      if (pattern.test(source) && !ALLOWED_BLUR_FILES.includes(rel)) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });
});
