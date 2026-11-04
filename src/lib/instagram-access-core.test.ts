import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INSTAGRAM_CONNECT_ACTIONS,
  type InstagramConnectAction,
  decideInstagramAccess,
  instagramActionRequiresGrant,
} from "../../supabase/functions/_shared/instagram-access-core.ts";

/**
 * Tabela completa ação × papel × grant × platform_admin (Task 2.4, C1/C2).
 * Operador e não membro sempre negados; `start`, `callback` e `resubscribe`
 * exigem grant ativo inclusive para platform_admin; `status` e `disconnect`
 * não (desconectar tem de funcionar depois da revogação do módulo).
 */

const ROLES = ["owner", "gerente", "operador", null] as const;
const GRANT_ACTIONS: InstagramConnectAction[] = ["start", "callback", "resubscribe"];
const NO_GRANT_ACTIONS: InstagramConnectAction[] = ["status", "disconnect"];

function expected(
  action: InstagramConnectAction,
  role: (typeof ROLES)[number],
  isPlatformAdmin: boolean,
  grantActive: boolean,
): "allow" | "deny_role" | "deny_grant" {
  const roleOk = isPlatformAdmin || role === "owner" || role === "gerente";
  if (!roleOk) return "deny_role";
  if (GRANT_ACTIONS.includes(action) && !grantActive) return "deny_grant";
  return "allow";
}

describe("INSTAGRAM_CONNECT_ACTIONS", () => {
  it("são exatamente as cinco ações do contrato", () => {
    expect([...INSTAGRAM_CONNECT_ACTIONS].sort()).toEqual(["callback", "disconnect", "resubscribe", "start", "status"]);
  });
  it("grant exigido só em start, callback e resubscribe", () => {
    for (const a of GRANT_ACTIONS) expect(instagramActionRequiresGrant(a)).toBe(true);
    for (const a of NO_GRANT_ACTIONS) expect(instagramActionRequiresGrant(a)).toBe(false);
  });
});

describe("decideInstagramAccess — tabela completa", () => {
  const cases: [InstagramConnectAction, (typeof ROLES)[number], boolean, boolean][] = [];
  for (const action of INSTAGRAM_CONNECT_ACTIONS) {
    for (const role of ROLES) {
      for (const isPlatformAdmin of [false, true]) {
        for (const grantActive of [false, true]) cases.push([action, role, isPlatformAdmin, grantActive]);
      }
    }
  }

  it("cobre 5 ações × 4 papéis × 2 × 2 = 80 casos", () => {
    expect(cases).toHaveLength(80);
  });

  it.each(cases)("%s role=%s admin=%s grant=%s", (action, role, isPlatformAdmin, grantActive) => {
    expect(decideInstagramAccess({ action, role, isPlatformAdmin, grantActive })).toBe(
      expected(action, role, isPlatformAdmin, grantActive),
    );
  });
});

describe("decideInstagramAccess — casos nomeados", () => {
  it("operador é negado em todas as ações, mesmo com grant", () => {
    for (const action of INSTAGRAM_CONNECT_ACTIONS) {
      expect(decideInstagramAccess({ action, role: "operador", isPlatformAdmin: false, grantActive: true })).toBe("deny_role");
    }
  });
  it("não membro é negado em todas as ações", () => {
    for (const action of INSTAGRAM_CONNECT_ACTIONS) {
      expect(decideInstagramAccess({ action, role: null, isPlatformAdmin: false, grantActive: true })).toBe("deny_role");
    }
  });
  it("papel é conferido antes do grant: não membro sem grant é deny_role, não deny_grant", () => {
    expect(decideInstagramAccess({ action: "start", role: null, isPlatformAdmin: false, grantActive: false })).toBe("deny_role");
  });
  it("platform_admin sem grant: start/callback/resubscribe negados; status/disconnect liberados", () => {
    for (const action of GRANT_ACTIONS) {
      expect(decideInstagramAccess({ action, role: null, isPlatformAdmin: true, grantActive: false })).toBe("deny_grant");
    }
    for (const action of NO_GRANT_ACTIONS) {
      expect(decideInstagramAccess({ action, role: null, isPlatformAdmin: true, grantActive: false })).toBe("allow");
    }
  });
  it("gerente com grant revogado ainda desconecta", () => {
    expect(decideInstagramAccess({ action: "disconnect", role: "gerente", isPlatformAdmin: false, grantActive: false })).toBe("allow");
  });
  it("ação desconhecida ou papel inesperado em runtime falham fechado", () => {
    expect(decideInstagramAccess({
      action: "delete" as unknown as InstagramConnectAction, role: "owner", isPlatformAdmin: true, grantActive: true,
    })).toBe("deny_role");
    expect(decideInstagramAccess({
      action: "status", role: "admin" as unknown as "owner", isPlatformAdmin: false, grantActive: true,
    })).toBe("deny_role");
    expect(decideInstagramAccess({
      action: "status", role: "owner", isPlatformAdmin: "true" as unknown as boolean, grantActive: true,
    })).toBe("allow");
    expect(decideInstagramAccess({
      action: "start", role: "owner", isPlatformAdmin: false, grantActive: "true" as unknown as boolean,
    })).toBe("deny_grant");
  });
});

describe("guarda estática", () => {
  it("módulo puro: sem Deno nem import remoto", () => {
    const src = readFileSync(resolve(__dirname, "../../supabase/functions/_shared/instagram-access-core.ts"), "utf8");
    expect(src).not.toMatch(/\bDeno\b/);
    expect(src).not.toMatch(/esm\.sh|deno\.land|process\.env/);
  });
});
