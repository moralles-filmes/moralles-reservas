import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isLightOnlyRoute } from "./theme-routes";

describe("isLightOnlyRoute", () => {
  it.each([
    "/",
    "/r/casa",
    "/w/casa",
    "/m/casa",
    "/acompanhar/abc",
    "/preferencias/mensagens/tok",
    "/admin/login",
    "/reset-password",
  ])("retorna true para %s", (pathname) => {
    expect(isLightOnlyRoute(pathname)).toBe(true);
  });

  it("retorna true para pathname de rota pública sem query", () => {
    const url = new URL("https://exemplo.com/r/casa?x=1");
    expect(isLightOnlyRoute(url.pathname)).toBe(true);
  });

  it.each(["/R/casa", "/Admin/Login", "/admin/login/", "/reset-password/", "/r/casa/"])(
    "ignora maiúsculas e barra final como o React Router: %s",
    (pathname) => {
      expect(isLightOnlyRoute(pathname)).toBe(true);
    },
  );

  it.each([
    "/g/casa",
    "/o/casa",
    "/platform/empresas",
    "/admin",
    "/rx",
    "/report",
    "/g/casa/reservas",
  ])("retorna false para %s", (pathname) => {
    expect(isLightOnlyRoute(pathname)).toBe(false);
  });
});

describe("script anti-flash do index.html", () => {
  const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

  function runScript(pathname: string, saved: string | null) {
    const classes = new Set<string>();
    const documentElement = {
      classList: { toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)) },
      style: { colorScheme: "" },
    };
    const localStorage = { getItem: () => saved };
    new Function("location", "localStorage", "document", script)(
      { pathname },
      localStorage,
      { documentElement },
    );
    return { dark: classes.has("dark"), colorScheme: documentElement.style.colorScheme };
  }

  const paths = [
    "/", "/r/casa", "/w/casa", "/m/casa", "/acompanhar/abc", "/preferencias/mensagens/tok",
    "/admin/login", "/reset-password", "/R/casa", "/admin/login/", "/g/casa", "/o/casa",
    "/platform/empresas", "/admin", "/rx", "/report", "/g/casa/reservas",
  ];

  it("existe e aplica o tema", () => {
    expect(script).toContain("moralles-theme");
  });

  it.each(paths)("concorda com isLightOnlyRoute em %s", (pathname) => {
    for (const saved of [null, "dark", "light"]) {
      const expectedDark = !isLightOnlyRoute(pathname) && saved !== "light";
      const result = runScript(pathname, saved);
      expect(result.dark, `${pathname} salvo=${saved}`).toBe(expectedDark);
      expect(result.colorScheme).toBe(expectedDark ? "dark" : "light");
    }
  });
});
