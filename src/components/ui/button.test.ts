import { describe, it, expect } from "vitest";
import { buttonVariants } from "./button";

describe("buttonVariants", () => {
  it("variantes antigas continuam", () => {
    const variants = ["default", "destructive", "outline", "secondary", "ghost", "link"] as const;
    for (const variant of variants) {
      const classes = buttonVariants({ variant });
      expect(typeof classes).toBe("string");
      expect(classes.trim().length).toBeGreaterThan(0);
    }
  });

  it("variante glass existe e usa surface", () => {
    const classes = buttonVariants({ variant: "glass" });
    expect(classes).toContain("surface");
  });

  it("botão é cápsula com alvo de toque", () => {
    const classes = buttonVariants({});
    expect(classes).toContain("rounded-full");
    expect(classes).toContain("coarse:h-11");
  });
});
