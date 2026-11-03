import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import { buildWaitlistMessage } from "./waitlist-message";
import { WAITLIST_TEMPLATES, renderWaitlistTemplate } from "@/hooks/useWaitlistTemplates";
import type { WaitlistEntry, WaitlistMessageTemplate } from "@/types/reserva";

const entry = {
  id: "w1",
  customer_name: "Ana",
  party_size: 3,
  code: 12,
} as unknown as WaitlistEntry;
const origin = "https://app.test";

describe("buildWaitlistMessage", () => {
  it("usa o corpo padrão sem template", () => {
    const body = WAITLIST_TEMPLATES.find((t) => t.event === "table_ready")!.defaultBody;
    expect(buildWaitlistMessage(entry, "table_ready", { templates: undefined, unitName: "Casa", origin })).toBe(
      renderWaitlistTemplate(body, {
        cliente_nome: "Ana",
        unidade_nome: "Casa",
        party_size: 3,
        codigo_fila: 12,
        link_status: "https://app.test/acompanhar/w1",
      }),
    );
  });

  it("usa o template customizado e cai no padrão se vazio", () => {
    const custom = { event: "entered", customized: true, body: "Oi {{cliente_nome}}!" } as unknown as WaitlistMessageTemplate;
    const msg = buildWaitlistMessage(entry, "entered", { templates: [custom], unitName: "Casa", origin });
    expect(msg).toContain("Oi Ana!");
    const blank = { ...custom, body: "   " } as WaitlistMessageTemplate;
    const def = buildWaitlistMessage(entry, "entered", { templates: undefined, unitName: "Casa", origin });
    expect(buildWaitlistMessage(entry, "entered", { templates: [blank], unitName: "Casa", origin })).toBe(def);
  });

  it("cai em 'nosso restaurante' sem nome da unidade", () => {
    const custom = { event: "entered", customized: true, body: "{{unidade_nome}}" } as unknown as WaitlistMessageTemplate;
    expect(buildWaitlistMessage(entry, "entered", { templates: [custom], unitName: undefined, origin })).toBe("nosso restaurante");
  });
});
