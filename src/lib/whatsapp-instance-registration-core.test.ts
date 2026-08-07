/**
 * Nucleo da guarda de unidade duplicada (§2.1 da verificacao manual da 6c).
 *
 * SEPARADO de `checkConnectionAllowance` DE PROPOSITO: aquele nucleo e
 * compartilhado com `manage-channels`, que responde "posso conectar mais um
 * canal?" e nao tem nada a ver com unidade duplicada. Um campo novo la
 * obrigaria o `manage-channels` a preencher entrada que nao lhe diz respeito e
 * a interpretar um reasonCode que nunca produz.
 */
import { describe, expect, it } from "vitest";
import {
  checkUnitInstanceConflict,
} from "../../supabase/functions/_shared/whatsapp-instance-registration-core";

describe("checkUnitInstanceConflict", () => {
  it("libera quando o registro nao tem unidade — nao ha chave pela qual perguntar", () => {
    const r = checkUnitInstanceConflict({
      unitScoped: false,
      conflicts: [{ id: "i-1", lifecycleState: "ACTIVE" }],
      acknowledged: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok === true) expect(r.policy).toBe("NO_UNIT_SCOPE");
  });

  it("libera quando a unidade nao tem nenhuma instancia viva", () => {
    const r = checkUnitInstanceConflict({
      unitScoped: true,
      conflicts: [],
      acknowledged: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok === true) expect(r.policy).toBe("NO_CONFLICT");
  });

  it("recusa quando a unidade ja tem instancia viva e nao houve reconhecimento", () => {
    const r = checkUnitInstanceConflict({
      unitScoped: true,
      conflicts: [{ id: "i-1", lifecycleState: "ACTIVE" }],
      acknowledged: false,
    });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.code).toBe("UNIT_ALREADY_HAS_INSTANCE");
  });

  it("CANCELLATION_REQUESTED conta como viva — ela custa ate a confirmacao do fim", () => {
    const r = checkUnitInstanceConflict({
      unitScoped: true,
      conflicts: [{ id: "i-1", lifecycleState: "CANCELLATION_REQUESTED" }],
      acknowledged: false,
    });
    expect(r.ok).toBe(false);
  });

  it("libera com reconhecimento explicito — segunda instancia legitima e ato consciente", () => {
    const r = checkUnitInstanceConflict({
      unitScoped: true,
      conflicts: [{ id: "i-1", lifecycleState: "ACTIVE" }],
      acknowledged: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok === true) expect(r.policy).toBe("ACKNOWLEDGED");
  });

  it("reconhecimento sem conflito nenhum nao inventa politica de excecao", () => {
    const r = checkUnitInstanceConflict({
      unitScoped: true,
      conflicts: [],
      acknowledged: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok === true) expect(r.policy).toBe("NO_CONFLICT");
  });
});
