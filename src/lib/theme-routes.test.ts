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
