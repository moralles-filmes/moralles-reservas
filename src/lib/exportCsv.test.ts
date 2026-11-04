import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import { exportRangeKeys } from "./exportCsv";

describe("exportRangeKeys", () => {
  it("mantém o dia escolhido até o fim do dia, sem D+1", () => {
    expect(
      exportRangeKeys({ from: new Date(2026, 10, 4), to: new Date(2026, 10, 4, 23, 59, 59) }),
    ).toEqual({ fromKey: "2026-11-04", toKey: "2026-11-04" });
  });
});
