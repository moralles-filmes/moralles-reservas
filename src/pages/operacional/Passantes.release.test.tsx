// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Passantes from "./Passantes";

const mock = vi.hoisted(() => ({
  release: vi.fn(),
  updateStatus: vi.fn(),
  walkIns: [] as unknown[],
}));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@tanstack/react-query", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: [] }),
}));
vi.mock("@/hooks/useCurrentUnit", () => ({ useCurrentUnit: () => ({ unit_id: "u1" }) }));
vi.mock("@/hooks/useWalkIns", () => ({
  useWalkIns: () => ({ data: mock.walkIns, isLoading: false, isError: false, refetch: vi.fn() }),
  useCreateWalkIn: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateWalkInStatus: () => ({ mutate: mock.updateStatus, isPending: false, variables: undefined }),
  useDeleteWalkIn: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
}));
vi.mock("@/hooks/useMesaAcoes", () => ({
  useReleaseWalkIn: () => ({ mutate: mock.release, isPending: false, variables: undefined }),
}));

const base = {
  unit_id: "u1",
  customer_phone: null,
  party_size: 2,
  table_id: null,
  status: "seated",
  notes: null,
  arrived_at: "2026-11-03T22:00:00Z",
  seated_at: "2026-11-03T22:05:00Z",
  released_at: null,
  table: null,
};

beforeEach(() => {
  mock.release.mockReset();
  mock.updateStatus.mockReset();
  mock.walkIns = [];
});

describe("Passantes liberação", () => {
  it("passante seated com released_at não aparece em Na mesa", () => {
    mock.walkIns = [
      { ...base, id: "w1", customer_name: "Livre", released_at: "2026-11-03T23:00:00Z" },
      { ...base, id: "w2", customer_name: "Ocupado" },
    ];
    render(<Passantes />);
    expect(screen.queryByText("Livre")).not.toBeInTheDocument();
    expect(screen.getByText("Ocupado")).toBeInTheDocument();
    expect(screen.getByText("Na mesa (1)")).toBeInTheDocument();
  });

  it("Foi embora libera a mesa e não atualiza status", () => {
    mock.walkIns = [{ ...base, id: "w2", customer_name: "Ocupado" }];
    render(<Passantes />);
    screen.getByRole("button", { name: "Foi embora" }).click();
    expect(mock.release).toHaveBeenCalledWith({ walkInId: "w2" });
    expect(mock.updateStatus).not.toHaveBeenCalled();
  });
});
