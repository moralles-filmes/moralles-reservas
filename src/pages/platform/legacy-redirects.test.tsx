// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { LegacyPlatformUnitRedirect } from "./legacy-redirects";

function WhereAmI() {
  const { pathname, search, hash } = useLocation();
  return <p data-testid="where">{`${pathname}|${search}|${hash}`}</p>;
}

afterEach(cleanup);

describe("LegacyPlatformUnitRedirect", () => {
  it("leva /platform/automacao/:slug para /platform/unidades/:slug preservando query e hash", () => {
    // É o retorno do onboarding Stripe Connect, montado no servidor
    // (manage-stripe-accounts) com o endereço antigo.
    render(
      <MemoryRouter
        initialEntries={["/platform/automacao/ren-sushi?stripe=complete#topo"]}
      >
        <Routes>
          <Route path="/platform/automacao/:unitSlug" element={<LegacyPlatformUnitRedirect />} />
          <Route path="/platform/unidades/:unitSlug" element={<WhereAmI />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("where").textContent).toBe(
      "/platform/unidades/ren-sushi|?stripe=complete|#topo",
    );
  });
});
