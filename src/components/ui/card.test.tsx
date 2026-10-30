import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { Card } from "./card";

describe("Card", () => {
  it("card e vidro sem desfoque", () => {
    render(<Card data-testid="c" />);
    const className = screen.getByTestId("c").className;
    expect(className).toContain("surface");
    expect(className).toContain("rounded-card");
    expect(className).not.toContain("glass");
    expect(className).not.toContain("backdrop");
  });

  it("className do chamador continua valendo", () => {
    render(<Card data-testid="c" className="p-0" />);
    expect(screen.getByTestId("c").className).toContain("p-0");
  });
});
