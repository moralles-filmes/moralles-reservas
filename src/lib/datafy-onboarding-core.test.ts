import { describe, it, expect } from "vitest";
import {
  DATAFY_CONNECT_ORIGIN,
  OFFICIAL_CHECKLIST_ITEM_IDS,
  classifyConnectMessage,
  decideAdoptedCredentials,
  decideChannelReconciliation,
  decideConfirm,
  decideStartStep,
  decideSubscribeStep,
  decideReplacementConnectionRecorded,
  deriveOfficialChecklist,
  isDatafyMigrationGrant,
  selectDatafyOfflineLegacy,
  isDisposableRemoteChannel,
} from "../../supabase/functions/_shared/datafy-onboarding-core.ts";
import type {
  OnboardingState,
  RemoteChannelState,
  SubscribeGrantState,
} from "../../supabase/functions/_shared/datafy-onboarding-core.ts";

/**
 * Forma malformada que o adapter pode produzir: o `manage-channels` nunca passa
 * por type-check, então um nome de campo errado chega ao núcleo como
 * `undefined`. O cast por `unknown` é o "as any" destes testes.
 */
function malformed<T>(value: Record<string, unknown>): T {
  return value as unknown as T;
}

/** Valores que não são a evidência estrita que o núcleo exige. */
const ODD_VALUES: unknown[] = [undefined, null, "true", "false", 1, 0, ""];

// ─── decideStartStep ────────────────────────────────────────────────────────

type StartInput = Parameters<typeof decideStartStep>[0];

const NO_NUMBER_ON_TRIAL: RemoteChannelState = {
  found: true, phoneNumberId: null, subscribed: false, onTrial: true,
};

function onboarding(state: OnboardingState, datafyChannelId: string | null = "dfy_ch_1") {
  return {
    state,
    datafyChannelId,
    datafyWebhookId: state === "webhook_ready" || state === "connected" ? "dfy_wh_1" : null,
  };
}

function startInput(overrides: Partial<StartInput> = {}): StartInput {
  return {
    grantActive: true,
    gatesAllowed: true,
    unitHasActiveChannel: false,
    migrationAllowed: false,
    onboarding: null,
    remote: null,
    ...overrides,
  };
}

describe("decideStartStep — ordem: liberação → gates → unidade ativa → estado", () => {
  it("liberação revogada → GRANT_REQUIRED, mesmo com canal conectado", () => {
    const connectedRemote: RemoteChannelState = {
      found: true, phoneNumberId: "pn_1", subscribed: true, onTrial: false,
    };
    for (const state of ["channel_created", "webhook_ready"] as const) {
      expect(decideStartStep(startInput({
        grantActive: false, onboarding: onboarding(state), remote: connectedRemote,
      }))).toEqual({ kind: "refuse", code: "GRANT_REQUIRED" });
    }
    expect(decideStartStep(startInput({
      grantActive: false, onboarding: onboarding("connected"),
    }))).toEqual({ kind: "refuse", code: "GRANT_REQUIRED" });
    // A liberação vence as outras recusas.
    expect(decideStartStep(startInput({
      grantActive: false, gatesAllowed: false, unitHasActiveChannel: true,
    }))).toEqual({ kind: "refuse", code: "GRANT_REQUIRED" });
  });

  it("gates negados → PROVISIONING_BLOCKED, antes de olhar a unidade ou o estado", () => {
    expect(decideStartStep(startInput({ gatesAllowed: false })))
      .toEqual({ kind: "refuse", code: "PROVISIONING_BLOCKED" });
    expect(decideStartStep(startInput({
      gatesAllowed: false, unitHasActiveChannel: true, onboarding: onboarding("connected"),
    }))).toEqual({ kind: "refuse", code: "PROVISIONING_BLOCKED" });
  });

  it("unidade já com canal ativo → UNIT_ALREADY_ACTIVE", () => {
    expect(decideStartStep(startInput({ unitHasActiveChannel: true })))
      .toEqual({ kind: "refuse", code: "UNIT_ALREADY_ACTIVE" });
    expect(decideStartStep(startInput({
      unitHasActiveChannel: true, onboarding: onboarding("webhook_ready"), remote: NO_NUMBER_ON_TRIAL,
    }))).toEqual({ kind: "refuse", code: "UNIT_ALREADY_ACTIVE" });
  });

  it("sem onboarding → open_onboarding", () => {
    expect(decideStartStep(startInput())).toEqual({ kind: "open_onboarding" });
  });

  describe("migração: liberação presa ao binding atual", () => {
    it("migrationAllowed === true deixa a unidade com canal ativo seguir para o estado", () => {
      expect(decideStartStep(startInput({ unitHasActiveChannel: true, migrationAllowed: true })))
        .toEqual({ kind: "open_onboarding" });
      expect(decideStartStep(startInput({
        unitHasActiveChannel: true, migrationAllowed: true,
        onboarding: onboarding("webhook_ready"), remote: NO_NUMBER_ON_TRIAL,
      }))).toEqual({ kind: "issue_link" });
    });

    it("migrationAllowed false ou não-boolean falha fechado com canal ativo", () => {
      for (const migrationAllowed of [false, ...ODD_VALUES]) {
        expect(decideStartStep(startInput({
          unitHasActiveChannel: true, migrationAllowed: migrationAllowed as boolean,
        }))).toEqual({ kind: "refuse", code: "UNIT_ALREADY_ACTIVE" });
      }
      // `unitHasActiveChannel` malformado continua contando como canal ativo.
      for (const unitHasActiveChannel of ODD_VALUES) {
        expect(decideStartStep(startInput({
          unitHasActiveChannel: unitHasActiveChannel as boolean, migrationAllowed: "true" as unknown as boolean,
        }))).toEqual({ kind: "refuse", code: "UNIT_ALREADY_ACTIVE" });
      }
    });

    it("migração não dispensa liberação nem gates (ordem preservada)", () => {
      expect(decideStartStep(startInput({
        grantActive: false, unitHasActiveChannel: true, migrationAllowed: true,
      }))).toEqual({ kind: "refuse", code: "GRANT_REQUIRED" });
      expect(decideStartStep(startInput({
        gatesAllowed: false, unitHasActiveChannel: true, migrationAllowed: true,
      }))).toEqual({ kind: "refuse", code: "PROVISIONING_BLOCKED" });
    });

    it("sem canal ativo, migrationAllowed não muda a decisão", () => {
      for (const migrationAllowed of [true, false]) {
        expect(decideStartStep(startInput({ migrationAllowed }))).toEqual({ kind: "open_onboarding" });
      }
    });
  });

  it("onboarding completed/abandoned → ONBOARDING_CLOSED", () => {
    for (const state of ["completed", "abandoned"] as const) {
      expect(decideStartStep(startInput({
        onboarding: onboarding(state), remote: NO_NUMBER_ON_TRIAL,
      }))).toEqual({ kind: "refuse", code: "ONBOARDING_CLOSED" });
    }
  });

  it("estado desconhecido (fora do CHECK) → ONBOARDING_CLOSED pelo ramo default", () => {
    expect(decideStartStep(startInput({
      onboarding: malformed<StartInput["onboarding"]>({
        state: "estado_novo", datafyChannelId: "dfy_ch_1", datafyWebhookId: null,
      }),
      remote: NO_NUMBER_ON_TRIAL,
    }))).toEqual({ kind: "refuse", code: "ONBOARDING_CLOSED" });
  });

  it("open → create_channel (o estado `open` não depende do GET)", () => {
    expect(decideStartStep(startInput({ onboarding: onboarding("open", null) })))
      .toEqual({ kind: "create_channel" });
    expect(decideStartStep(startInput({
      onboarding: onboarding("open", null), remote: NO_NUMBER_ON_TRIAL,
    }))).toEqual({ kind: "create_channel" });
  });

  it("channel_created/webhook_ready sem `remote` → REMOTE_STATE_REQUIRED", () => {
    for (const state of ["channel_created", "webhook_ready"] as const) {
      expect(decideStartStep(startInput({ onboarding: onboarding(state), remote: null })))
        .toEqual({ kind: "refuse", code: "REMOTE_STATE_REQUIRED" });
    }
  });

  it("channel_created/webhook_ready sem id Datafy gravado → REMOTE_STATE_REQUIRED mesmo com `remote`", () => {
    // Estado impossível por construção (o mesmo UPDATE grava id e estado);
    // um GET sem id de origem não pode estar falando deste onboarding.
    for (const state of ["channel_created", "webhook_ready"] as const) {
      expect(decideStartStep(startInput({
        onboarding: onboarding(state, null), remote: NO_NUMBER_ON_TRIAL,
      }))).toEqual({ kind: "refuse", code: "REMOTE_STATE_REQUIRED" });
    }
  });

  it("canal sumido na Datafy (found === false, 404) → recreate_channel/channel_missing", () => {
    for (const state of ["channel_created", "webhook_ready"] as const) {
      expect(decideStartStep(startInput({
        onboarding: onboarding(state),
        remote: { found: false, phoneNumberId: null, subscribed: false, onTrial: false },
      }))).toEqual({ kind: "recreate_channel", reason: "channel_missing" });
    }
  });

  it("canal conectado prepara webhook e depois confirma, sem link em qualquer assinatura/trial", () => {
    // Fase 0, §4 item 2: link de canal com número devolve 200 e reabre o
    // Embedded Signup com troca de número. Também nunca é recriado (teria
    // número), nem com trial vencido e sem assinatura.
    for (const state of ["channel_created", "webhook_ready"] as const) {
      for (const subscribed of [false, true]) {
        for (const onTrial of [false, true]) {
          const verdict = decideStartStep(startInput({
            onboarding: onboarding(state),
            remote: { found: true, phoneNumberId: "pn_1", subscribed, onTrial },
          }));
          expect(verdict).toEqual({ kind: state === "channel_created" ? "create_webhook" : "go_confirm" });
          expect(verdict.kind).not.toBe("issue_link");
        }
      }
    }
  });

  it("número presente porém vazio conta como número → go_confirm", () => {
    expect(decideStartStep(startInput({
      onboarding: onboarding("webhook_ready"),
      remote: { found: true, phoneNumberId: "", subscribed: false, onTrial: true },
    }))).toEqual({ kind: "go_confirm" });
  });

  it("sem número, sem assinatura e sem trial → recreate_channel/trial_expired", () => {
    for (const state of ["channel_created", "webhook_ready"] as const) {
      expect(decideStartStep(startInput({
        onboarding: onboarding(state),
        remote: { found: true, phoneNumberId: null, subscribed: false, onTrial: false },
      }))).toEqual({ kind: "recreate_channel", reason: "trial_expired" });
    }
  });

  it("sem número e assinado (trial vencido) → segue o fluxo sem recriar", () => {
    const subscribedNoTrial: RemoteChannelState = {
      found: true, phoneNumberId: null, subscribed: true, onTrial: false,
    };
    expect(decideStartStep(startInput({
      onboarding: onboarding("channel_created"), remote: subscribedNoTrial,
    }))).toEqual({ kind: "create_webhook" });
    expect(decideStartStep(startInput({
      onboarding: onboarding("webhook_ready"), remote: subscribedNoTrial,
    }))).toEqual({ kind: "issue_link" });
  });

  it("channel_created em trial → create_webhook", () => {
    expect(decideStartStep(startInput({
      onboarding: onboarding("channel_created"), remote: NO_NUMBER_ON_TRIAL,
    }))).toEqual({ kind: "create_webhook" });
  });

  it("webhook_ready em trial → issue_link sem recriar nada", () => {
    expect(decideStartStep(startInput({
      onboarding: onboarding("webhook_ready"), remote: NO_NUMBER_ON_TRIAL,
    }))).toEqual({ kind: "issue_link" });
  });

  it("connected → go_confirm", () => {
    expect(decideStartStep(startInput({ onboarding: onboarding("connected") })))
      .toEqual({ kind: "go_confirm" });
  });

  describe("campo malformado do GET falha fechado (o adapter não tem type-check)", () => {
    it("`phoneNumberId` ausente prepara webhook ou confirma, nunca issue_link", () => {
      for (const state of ["channel_created", "webhook_ready"] as const) {
        const verdict = decideStartStep(startInput({
          onboarding: onboarding(state),
          remote: malformed<RemoteChannelState>({ found: true, subscribed: false, onTrial: true }),
        }));
        expect(verdict).toEqual({ kind: state === "channel_created" ? "create_webhook" : "go_confirm" });
      }
    });

    it("`found` que não é boolean → REMOTE_STATE_REQUIRED, nunca recreate (nem de canal assinado com número)", () => {
      for (const found of ODD_VALUES) {
        for (const remote of [
          { found, phoneNumberId: "pn_1", subscribed: true, onTrial: false },
          { found, phoneNumberId: null, subscribed: false, onTrial: false },
        ]) {
          expect(decideStartStep(startInput({
            onboarding: onboarding("webhook_ready"), remote: malformed<RemoteChannelState>(remote),
          }))).toEqual({ kind: "refuse", code: "REMOTE_STATE_REQUIRED" });
        }
      }
      expect(decideStartStep(startInput({
        onboarding: onboarding("webhook_ready"),
        remote: malformed<RemoteChannelState>({ phoneNumberId: "pn_1", subscribed: true, onTrial: false }),
      }))).toEqual({ kind: "refuse", code: "REMOTE_STATE_REQUIRED" });
    });

    it("`subscribed` ou `onTrial` que não são boolean → REMOTE_STATE_REQUIRED, nunca trial_expired", () => {
      for (const odd of ODD_VALUES) {
        for (const remote of [
          { found: true, phoneNumberId: null, subscribed: odd, onTrial: false },
          { found: true, phoneNumberId: null, subscribed: false, onTrial: odd },
          { found: true, phoneNumberId: null, subscribed: true, onTrial: odd },
          { found: true, phoneNumberId: null, subscribed: odd, onTrial: true },
        ]) {
          expect(decideStartStep(startInput({
            onboarding: onboarding("webhook_ready"), remote: malformed<RemoteChannelState>(remote),
          }))).toEqual({ kind: "refuse", code: "REMOTE_STATE_REQUIRED" });
        }
      }
    });

    it("propriedades sobre entradas geradas: issue_link ⇒ sem número; recreate ⇒ 404 ou descartável", () => {
      const FOUNDS: unknown[] = [true, false, ...ODD_VALUES];
      const PHONES: unknown[] = [null, "pn_1", "", undefined, 0, false];
      const BOOLS: unknown[] = [true, false, ...ODD_VALUES];
      const STATES = [
        "open", "channel_created", "webhook_ready", "connected", "completed", "abandoned", "estado_novo",
      ];
      const remotes: (RemoteChannelState | null)[] = [null];
      for (const found of FOUNDS) {
        for (const phoneNumberId of PHONES) {
          for (const subscribed of BOOLS) {
            for (const onTrial of BOOLS) {
              remotes.push(malformed<RemoteChannelState>({ found, phoneNumberId, subscribed, onTrial }));
            }
          }
        }
      }

      const found: string[] = [];
      let issuedLinks = 0;
      let recreatedPresent = 0;
      for (const state of STATES) {
        for (const datafyChannelId of ["dfy_ch_1", null]) {
          for (const remote of remotes) {
            const verdict = decideStartStep(startInput({
              onboarding: malformed<StartInput["onboarding"]>({ state, datafyChannelId, datafyWebhookId: null }),
              remote,
            }));
            const label = () => `${state}/${datafyChannelId}: ${JSON.stringify(remote)} → ${JSON.stringify(verdict)}`;
            if (verdict.kind === "issue_link") {
              issuedLinks += 1;
              if (!remote || remote.phoneNumberId !== null) found.push(`link com número: ${label()}`);
            }
            if (verdict.kind === "recreate_channel") {
              if (!remote) {
                found.push(`recreate sem GET: ${label()}`);
              } else if (remote.found === true) {
                recreatedPresent += 1;
                if (!isDisposableRemoteChannel(remote)) found.push(`recreate de comprometido: ${label()}`);
              } else if (remote.found !== false) {
                found.push(`recreate com found malformado: ${label()}`);
              }
              if (verdict.reason === "channel_missing" && remote?.found !== false) {
                found.push(`channel_missing sem 404: ${label()}`);
              }
            }
          }
        }
      }
      // Controle de vacuidade: a propriedade só vale se os dois desfechos ocorrem.
      expect(issuedLinks).toBeGreaterThan(0);
      expect(recreatedPresent).toBeGreaterThan(0);
      expect(found.slice(0, 3)).toEqual([]);
    });
  });
});

// ─── isDisposableRemoteChannel ──────────────────────────────────────────────

type DisposableInput = Parameters<typeof isDisposableRemoteChannel>[0];

describe("isDisposableRemoteChannel", () => {
  it("só nunca assinado E sem número", () => {
    expect(isDisposableRemoteChannel({ subscribed: false, phoneNumberId: null })).toBe(true);
    expect(isDisposableRemoteChannel({ subscribed: true, phoneNumberId: null })).toBe(false);
    expect(isDisposableRemoteChannel({ subscribed: false, phoneNumberId: "pn_1" })).toBe(false);
    expect(isDisposableRemoteChannel({ subscribed: true, phoneNumberId: "pn_1" })).toBe(false);
  });

  it("número presente porém vazio NÃO autoriza apagar (na dúvida, comprometido)", () => {
    expect(isDisposableRemoteChannel({ subscribed: false, phoneNumberId: "" })).toBe(false);
  });

  it("campo ausente ou malformado nunca autoriza apagar", () => {
    expect(isDisposableRemoteChannel(malformed<DisposableInput>({ subscribed: false }))).toBe(false);
    expect(isDisposableRemoteChannel(malformed<DisposableInput>({ phoneNumberId: null }))).toBe(false);
    expect(isDisposableRemoteChannel(malformed<DisposableInput>({}))).toBe(false);
    for (const odd of ODD_VALUES) {
      if (odd !== null) {
        expect(isDisposableRemoteChannel(malformed<DisposableInput>({ subscribed: false, phoneNumberId: odd })))
          .toBe(false);
      }
      expect(isDisposableRemoteChannel(malformed<DisposableInput>({ subscribed: odd, phoneNumberId: null })))
        .toBe(false);
    }
  });
});

// ─── decideChannelReconciliation ────────────────────────────────────────────

const RESERVED = "6f1c0d3e-0000-4000-8000-000000000001";

type ListedChannel = Parameters<typeof decideChannelReconciliation>[0]["channels"][number];

function listed(id: string, overrides: Partial<ListedChannel> = {}): ListedChannel {
  return {
    id,
    name: RESERVED,
    subscribed: false,
    phoneNumberId: null,
    trialEndsAt: "2026-10-16T10:00:00-03:00",
    ...overrides,
  };
}

function reconcile(channels: ListedChannel[]) {
  return decideChannelReconciliation({ reservedChannelId: RESERVED, channels });
}

describe("decideChannelReconciliation — name não é único e a listagem não tem created_at", () => {
  it("0 candidatos → absent", () => {
    expect(reconcile([])).toEqual({ kind: "absent" });
    expect(reconcile([listed("a", { name: "Moralles Reservas - Canal Teste" })]))
      .toEqual({ kind: "absent" });
  });

  it("nome parecido mas diferente não conta (igualdade exata)", () => {
    const lookalikes = [
      RESERVED.toUpperCase(), ` ${RESERVED}`, `${RESERVED} `, `${RESERVED}x`,
      RESERVED.slice(0, -1), `unit:${RESERVED}`,
    ];
    expect(reconcile(lookalikes.map((name, i) => listed(`id_${i}`, { name }))))
      .toEqual({ kind: "absent" });
  });

  it("1 candidato descartável → adota, sem descarte", () => {
    expect(reconcile([listed("a"), listed("z", { name: "outro" })]))
      .toEqual({ kind: "adopt", channelId: "a", discard: [] });
  });

  it("1 candidato comprometido → adota", () => {
    expect(reconcile([listed("a", { subscribed: true })]))
      .toEqual({ kind: "adopt", channelId: "a", discard: [] });
  });

  it("N descartáveis → adota o de maior trialEndsAt e descarta o resto", () => {
    const verdict = reconcile([
      listed("a", { trialEndsAt: "2026-10-15T10:00:00-03:00" }),
      listed("b", { trialEndsAt: "2026-10-16T09:00:00-03:00" }),
      listed("c", { trialEndsAt: "2026-10-14T10:00:00-03:00" }),
    ]);
    expect(verdict.kind).toBe("adopt");
    if (verdict.kind !== "adopt") return;
    expect(verdict.channelId).toBe("b");
    expect([...verdict.discard].sort()).toEqual(["a", "c"]);
  });

  it("compara o INSTANTE, não o texto: offsets diferentes", () => {
    // 10:00-03:00 = 13:00Z, depois de 12:00Z — a comparação lexical erraria.
    const verdict = reconcile([
      listed("a", { trialEndsAt: "2026-10-15T12:00:00Z" }),
      listed("b", { trialEndsAt: "2026-10-15T10:00:00-03:00" }),
    ]);
    expect(verdict).toEqual({ kind: "adopt", channelId: "b", discard: ["a"] });
  });

  it("trialEndsAt nulo ou inválido perde para qualquer data válida", () => {
    const verdict = reconcile([
      listed("a", { trialEndsAt: null }),
      listed("b", { trialEndsAt: "nao-e-data" }),
      listed("c", { trialEndsAt: "2020-01-01T00:00:00-03:00" }),
    ]);
    expect(verdict.kind).toBe("adopt");
    if (verdict.kind !== "adopt") return;
    expect(verdict.channelId).toBe("c");
    expect([...verdict.discard].sort()).toEqual(["a", "b"]);
  });

  it("empate → menor id (inclusive empate de nulos/inválidos)", () => {
    const same = "2026-10-16T10:00:00-03:00";
    const tied = reconcile([
      listed("c", { trialEndsAt: same }),
      listed("a", { trialEndsAt: same }),
      listed("b", { trialEndsAt: same }),
    ]);
    expect(tied.kind).toBe("adopt");
    if (tied.kind !== "adopt") return;
    expect(tied.channelId).toBe("a");
    expect([...tied.discard].sort()).toEqual(["b", "c"]);

    const allInvalid = reconcile([
      listed("y", { trialEndsAt: null }),
      listed("x", { trialEndsAt: "nao-e-data" }),
    ]);
    expect(allInvalid).toEqual({ kind: "adopt", channelId: "x", discard: ["y"] });
  });

  it("um comprometido entre descartáveis → adota o comprometido, mesmo com menos trial", () => {
    for (const committed of [{ subscribed: true }, { phoneNumberId: "pn_1" }]) {
      const verdict = reconcile([
        listed("a", { trialEndsAt: "2026-10-20T10:00:00-03:00" }),
        listed("m", { ...committed, trialEndsAt: null }),
        listed("b", { trialEndsAt: "2026-10-19T10:00:00-03:00" }),
      ]);
      expect(verdict.kind).toBe("adopt");
      if (verdict.kind !== "adopt") return;
      expect(verdict.channelId).toBe("m");
      expect([...verdict.discard].sort()).toEqual(["a", "b"]);
    }
  });

  it("dois comprometidos → ambiguous (nunca apaga comprometido)", () => {
    expect(reconcile([
      listed("a", { subscribed: true }),
      listed("b", { phoneNumberId: "pn_1" }),
    ])).toEqual({ kind: "ambiguous" });
    expect(reconcile([
      listed("a", { subscribed: true }),
      listed("x"),
      listed("b", { subscribed: true, phoneNumberId: "pn_1" }),
      listed("y"),
    ])).toEqual({ kind: "ambiguous" });
  });

  it("entrada com `subscribed`/`phoneNumberId` ausente conta como comprometida", () => {
    const missingSubscribed = malformed<ListedChannel>({
      id: "m", name: RESERVED, phoneNumberId: null, trialEndsAt: null,
    });
    const missingPhone = malformed<ListedChannel>({
      id: "n", name: RESERVED, subscribed: false, trialEndsAt: null,
    });
    // Adotada apesar de ter menos trial, e nunca descartada.
    expect(reconcile([listed("a", { trialEndsAt: "2026-10-20T10:00:00-03:00" }), missingSubscribed]))
      .toEqual({ kind: "adopt", channelId: "m", discard: ["a"] });
    expect(reconcile([listed("a", { trialEndsAt: "2026-10-20T10:00:00-03:00" }), missingPhone]))
      .toEqual({ kind: "adopt", channelId: "n", discard: ["a"] });
    expect(reconcile([missingSubscribed, missingPhone])).toEqual({ kind: "ambiguous" });
  });

  // Propriedade verificada sobre conjuntos EXAUSTIVOS de listagens pequenas,
  // não sobre um exemplo: o `discard` vira `deleteChannel` no adapter, e
  // apagar canal comprometido perde número conectado ou assinatura paga.
  describe("propriedade: discard nunca contém comprometido", () => {
    const NAMES = [RESERVED, "outro-nome"];
    const TRIALS = [null, "nao-e-data", "2026-10-15T10:00:00-03:00", "2026-10-16T10:00:00-03:00"];

    function shapes(subscribeds: unknown[], phones: unknown[]): Omit<ListedChannel, "id">[] {
      const out: Omit<ListedChannel, "id">[] = [];
      for (const name of NAMES) {
        for (const subscribed of subscribeds) {
          for (const phoneNumberId of phones) {
            for (const trialEndsAt of TRIALS) {
              out.push(malformed<Omit<ListedChannel, "id">>({ name, subscribed, phoneNumberId, trialEndsAt }));
            }
          }
        }
      }
      return out;
    }

    const WELL_FORMED = shapes([false, true], [null, "pn_1"]);
    const WITH_MALFORMED = shapes([false, true, undefined, "false"], [null, "pn_1", undefined, ""]);

    // Oráculo independente: descartável só com as duas evidências estritas.
    const isCommitted = (c: ListedChannel) => !(c.subscribed === false && c.phoneNumberId === null);

    function violations(channels: ListedChannel[]): string[] {
      const out: string[] = [];
      const verdict = reconcile(channels);
      const candidates = channels.filter((c) => c.name === RESERVED);
      const candidateIds = new Set(candidates.map((c) => c.id));
      // Comprometido em QUALQUER entrada com o mesmo id: id repetido é o
      // mesmo canal remoto.
      const committedIds = new Set(channels.filter(isCommitted).map((c) => c.id));
      const committedCandidates = [...candidateIds].filter((id) => committedIds.has(id));
      const label = () => JSON.stringify(channels);

      const expected =
        candidates.length === 0 ? "absent" : committedCandidates.length > 1 ? "ambiguous" : "adopt";
      if (verdict.kind !== expected) out.push(`esperava ${expected}, veio ${verdict.kind}: ${label()}`);
      // As checagens do descarte rodam em TODO `adopt`, inclusive no que
      // deveria ter sido `ambiguous`: é o descarte que vira DELETE.
      if (verdict.kind !== "adopt") return out;
      if (!candidateIds.has(verdict.channelId)) out.push(`adotou não-candidato: ${label()}`);
      if (committedCandidates.length === 1 && verdict.channelId !== committedCandidates[0]) {
        out.push(`não adotou o comprometido: ${label()}`);
      }
      for (const id of verdict.discard) {
        if (committedIds.has(id)) out.push(`discard com comprometido ${id}: ${label()}`);
        if (!candidateIds.has(id)) out.push(`discard com não-candidato ${id}: ${label()}`);
        if (id === verdict.channelId) out.push(`discard com o adotado ${id}: ${label()}`);
      }
      if (new Set(verdict.discard).size !== verdict.discard.length) {
        out.push(`discard com repetição: ${label()}`);
      }
      return out;
    }

    function exhaust(shapeSet: Omit<ListedChannel, "id">[], depth: number) {
      const found: string[] = [];
      let checked = 0;
      const walk = (prefix: ListedChannel[]) => {
        found.push(...violations(prefix));
        checked += 1;
        if (prefix.length === depth) return;
        const id = ["a", "b", "c"][prefix.length];
        for (const shape of shapeSet) walk([...prefix, { id, ...shape }]);
      };
      walk([]);
      return { found, checked };
    }

    it("listagens bem formadas de 0 a 3 canais com ids distintos (todas as combinações)", () => {
      const { found, checked } = exhaust(WELL_FORMED, 3);
      expect(checked).toBe(1 + 32 + 32 ** 2 + 32 ** 3);
      expect(found.filter((v) => v.startsWith("discard")).slice(0, 3)).toEqual([]);
      expect(found.slice(0, 3)).toEqual([]);
    });

    it("listagens de 0 a 2 canais com campos ausentes ou malformados", () => {
      const { found, checked } = exhaust(WITH_MALFORMED, 2);
      expect(checked).toBe(1 + 128 + 128 ** 2);
      expect(found.filter((v) => v.startsWith("discard")).slice(0, 3)).toEqual([]);
      expect(found.slice(0, 3)).toEqual([]);
    });

    it("listagens de 2 canais com id repetido (listagem inconsistente)", () => {
      const found: string[] = [];
      for (const first of WELL_FORMED) {
        for (const second of WELL_FORMED) {
          for (const secondId of ["a", "b"]) {
            found.push(...violations([{ id: "a", ...first }, { id: secondId, ...second }]));
          }
        }
      }
      expect(found.filter((v) => v.startsWith("discard")).slice(0, 3)).toEqual([]);
      expect(found.slice(0, 3)).toEqual([]);
    });
  });
});

// ─── decideAdoptedCredentials ───────────────────────────────────────────────

type AdoptedSnapshot = Parameters<typeof decideAdoptedCredentials>[0];

describe("decideAdoptedCredentials", () => {
  it("token e secret presentes → use (descartável ou comprometido)", () => {
    for (const shape of [
      { subscribed: false, phoneNumberId: null },
      { subscribed: true, phoneNumberId: "pn_1" },
    ]) {
      expect(decideAdoptedCredentials({ ...shape, token: "sk_live_x", webhookSecret: "whsec_y" }))
        .toEqual({ kind: "use", token: "sk_live_x", webhookSecret: "whsec_y" });
    }
  });

  it("sem token ou secret e descartável → discard_and_recreate", () => {
    for (const creds of [
      { token: null, webhookSecret: "whsec_y" },
      { token: "sk_live_x", webhookSecret: null },
      { token: null, webhookSecret: null },
      { token: "", webhookSecret: "whsec_y" },
      { token: "sk_live_x", webhookSecret: "   " },
    ]) {
      expect(decideAdoptedCredentials({ subscribed: false, phoneNumberId: null, ...creds }))
        .toEqual({ kind: "discard_and_recreate" });
    }
  });

  it("sem token ou secret e comprometido → recusa para o admin", () => {
    for (const shape of [
      { subscribed: true, phoneNumberId: null },
      { subscribed: false, phoneNumberId: "pn_1" },
    ]) {
      expect(decideAdoptedCredentials({ ...shape, token: null, webhookSecret: "whsec_y" }))
        .toEqual({ kind: "refuse", code: "DATAFY_CREDENTIALS_UNAVAILABLE" });
    }
  });

  it("sem token e com `subscribed`/`phoneNumberId` ausente → recusa, nunca recria", () => {
    for (const shape of [{ subscribed: false }, { phoneNumberId: null }, {}]) {
      expect(decideAdoptedCredentials(malformed<AdoptedSnapshot>({ ...shape, token: null, webhookSecret: null })))
        .toEqual({ kind: "refuse", code: "DATAFY_CREDENTIALS_UNAVAILABLE" });
    }
  });
});

// ─── decideConfirm ──────────────────────────────────────────────────────────

type ConfirmInput = Parameters<typeof decideConfirm>[0];

function confirmInput(
  remote: Partial<ConfirmInput["remote"]> = {},
  flags: Partial<Omit<ConfirmInput, "remote">> = {},
): ConfirmInput {
  return {
    grantActive: true,
    gatesAllowed: true,
    remote: { found: true, phoneNumberId: "pn_1", wabaId: "waba_1", businessId: "biz_1", ...remote },
    phoneNumberIdTakenByOtherChannel: false,
    wabaOwnedByOtherOrganization: false,
    ...flags,
  };
}

describe("decideConfirm — tudo vem do GET da Datafy", () => {
  it("liberação ou gates negados recusam antes de olhar o `remote`", () => {
    expect(decideConfirm(confirmInput({}, { grantActive: false })))
      .toEqual({ kind: "refuse", code: "GRANT_REQUIRED" });
    expect(decideConfirm(confirmInput({}, { gatesAllowed: false })))
      .toEqual({ kind: "refuse", code: "PROVISIONING_BLOCKED" });
    // Mesmo com o canal sumido ou sem número, a recusa é a da liberação.
    expect(decideConfirm(confirmInput({ found: false }, { grantActive: false, gatesAllowed: false })))
      .toEqual({ kind: "refuse", code: "GRANT_REQUIRED" });
    expect(decideConfirm(confirmInput({ phoneNumberId: null }, { gatesAllowed: false })))
      .toEqual({ kind: "refuse", code: "PROVISIONING_BLOCKED" });
    for (const odd of ODD_VALUES) {
      expect(decideConfirm(confirmInput({}, { grantActive: odd as boolean })).kind).toBe("refuse");
      expect(decideConfirm(confirmInput({}, { gatesAllowed: odd as boolean })).kind).toBe("refuse");
    }
  });

  it("canal sumido → REMOTE_CHANNEL_MISSING", () => {
    expect(decideConfirm(confirmInput({ found: false })))
      .toEqual({ kind: "refuse", code: "REMOTE_CHANNEL_MISSING" });
  });

  it("`found` que não é boolean → REMOTE_STATE_REQUIRED", () => {
    for (const odd of ODD_VALUES) {
      expect(decideConfirm(confirmInput({ found: odd as boolean })))
        .toEqual({ kind: "refuse", code: "REMOTE_STATE_REQUIRED" });
    }
  });

  it("sem número → not_connected_yet", () => {
    expect(decideConfirm(confirmInput({ phoneNumberId: null })))
      .toEqual({ kind: "not_connected_yet" });
  });

  it("número sem WABA, ou identidade malformada → REMOTE_IDENTITY_INCOMPLETE", () => {
    for (const remote of [
      { wabaId: null },
      { wabaId: "  " },
      { phoneNumberId: "" },
      { phoneNumberId: undefined },
      { phoneNumberId: 42 as unknown as string },
      { wabaId: undefined },
    ]) {
      expect(decideConfirm(confirmInput(remote)))
        .toEqual({ kind: "refuse", code: "REMOTE_IDENTITY_INCOMPLETE" });
    }
  });

  it("identidade com espaço nas bordas é recusada, não aparada (a colisão foi checada pelo valor cru)", () => {
    expect(decideConfirm(confirmInput({ phoneNumberId: " pn_1 " })))
      .toEqual({ kind: "refuse", code: "REMOTE_IDENTITY_INCOMPLETE" });
    expect(decideConfirm(confirmInput({ wabaId: "waba_1 " })))
      .toEqual({ kind: "refuse", code: "REMOTE_IDENTITY_INCOMPLETE" });
  });

  it("número que já ancora outro canal → PHONE_NUMBER_ALREADY_BOUND", () => {
    expect(decideConfirm(confirmInput({}, { phoneNumberIdTakenByOtherChannel: true })))
      .toEqual({ kind: "refuse", code: "PHONE_NUMBER_ALREADY_BOUND" });
  });

  it("WABA de outra organização → WABA_OWNED_BY_OTHER_ORG", () => {
    expect(decideConfirm(confirmInput({}, { wabaOwnedByOtherOrganization: true })))
      .toEqual({ kind: "refuse", code: "WABA_OWNED_BY_OTHER_ORG" });
  });

  it("flags de colisão que não são boolean falham fechado", () => {
    // Pega a mutação `!== false` → `=== true`: `undefined` (consulta que o
    // adapter esqueceu de fazer) nunca pode virar "sem colisão".
    for (const odd of ODD_VALUES) {
      expect(decideConfirm(confirmInput({}, { phoneNumberIdTakenByOtherChannel: odd as boolean })))
        .toEqual({ kind: "refuse", code: "PHONE_NUMBER_ALREADY_BOUND" });
      expect(decideConfirm(confirmInput({}, { wabaOwnedByOtherOrganization: odd as boolean })))
        .toEqual({ kind: "refuse", code: "WABA_OWNED_BY_OTHER_ORG" });
    }
  });

  it("as duas colisões juntas também recusam (nunca cria linha)", () => {
    expect(decideConfirm(confirmInput({}, {
      phoneNumberIdTakenByOtherChannel: true, wabaOwnedByOtherOrganization: true,
    })).kind).toBe("refuse");
  });

  it("feliz → create_channel_row com a identidade do GET", () => {
    expect(decideConfirm(confirmInput())).toEqual({
      kind: "create_channel_row", phoneNumberId: "pn_1", wabaId: "waba_1", businessId: "biz_1",
    });
    expect(decideConfirm(confirmInput({ businessId: null }))).toEqual({
      kind: "create_channel_row", phoneNumberId: "pn_1", wabaId: "waba_1", businessId: null,
    });
  });

  it("businessId só de espaços vira null; com espaço nas bordas é aparado", () => {
    expect(decideConfirm(confirmInput({ businessId: "   " }))).toEqual({
      kind: "create_channel_row", phoneNumberId: "pn_1", wabaId: "waba_1", businessId: null,
    });
    expect(decideConfirm(confirmInput({ businessId: " biz_1 " }))).toEqual({
      kind: "create_channel_row", phoneNumberId: "pn_1", wabaId: "waba_1", businessId: "biz_1",
    });
  });

  it("o tipo da entrada não tem campo de Coexistence (e um valor injetado não muda nada)", () => {
    // Teste de COMPILAÇÃO (Fase 0, §4 item 5): se alguém devolver um campo de
    // Coexistence ao tipo do `remote`, o `@ts-expect-error` fica sem erro para
    // suprimir e o `tsc -b` quebra. Em runtime, um `coexistence: false` que
    // escape para o objeto não pode barrar nem liberar o confirm.
    const verdict = decideConfirm({
      grantActive: true,
      gatesAllowed: true,
      remote: {
        found: true, phoneNumberId: "pn_1", wabaId: "waba_1", businessId: null,
        // @ts-expect-error — o GET da Datafy não traz coexistence; a prova é o eco
        coexistence: false,
      },
      phoneNumberIdTakenByOtherChannel: false,
      wabaOwnedByOtherOrganization: false,
    });
    expect(verdict.kind).toBe("create_channel_row");
  });
});

// ─── decideSubscribeStep ────────────────────────────────────────────────────

type SubscribeInput = Parameters<typeof decideSubscribeStep>[0];

function subscribeStep(
  grant: SubscribeGrantState,
  gatesAllowed: boolean,
  remote: SubscribeInput["remote"],
) {
  return decideSubscribeStep({ grant, gatesAllowed, remote });
}

const GRANTS: SubscribeGrantState[] = ["active", "consumed_by_this_channel", "none"];

describe("decideSubscribeStep — GET feito depois do claim", () => {
  it("canal sumido → REMOTE_CHANNEL_MISSING, em qualquer liberação/gate", () => {
    for (const grant of GRANTS) {
      for (const gates of [false, true]) {
        expect(subscribeStep(grant, gates, { found: false, subscribed: false }))
          .toEqual({ kind: "refuse", code: "REMOTE_CHANNEL_MISSING" });
      }
    }
  });

  it("`found`/`subscribed` que não são boolean → REMOTE_STATE_REQUIRED", () => {
    for (const odd of ODD_VALUES) {
      expect(subscribeStep("active", true, malformed<SubscribeInput["remote"]>({ found: odd, subscribed: false })))
        .toEqual({ kind: "refuse", code: "REMOTE_STATE_REQUIRED" });
      expect(subscribeStep("active", true, malformed<SubscribeInput["remote"]>({ found: true, subscribed: odd })))
        .toEqual({ kind: "refuse", code: "REMOTE_STATE_REQUIRED" });
    }
  });

  it("assinado + liberação ativa ou consumida por este canal + gates → already_subscribed", () => {
    expect(subscribeStep("active", true, { found: true, subscribed: true }))
      .toEqual({ kind: "already_subscribed" });
    expect(subscribeStep("consumed_by_this_channel", true, { found: true, subscribed: true }))
      .toEqual({ kind: "already_subscribed" });
  });

  it("assinado sem liberação → record_subscription/GRANT_REQUIRED (registra o fato, não finaliza)", () => {
    for (const gates of [false, true]) {
      expect(subscribeStep("none", gates, { found: true, subscribed: true }))
        .toEqual({ kind: "record_subscription", code: "GRANT_REQUIRED" });
    }
    expect(subscribeStep(malformed<SubscribeGrantState>({}), true, { found: true, subscribed: true }))
      .toEqual({ kind: "record_subscription", code: "GRANT_REQUIRED" });
  });

  it("assinado com gates negados → record_subscription/PROVISIONING_BLOCKED", () => {
    for (const grant of ["active", "consumed_by_this_channel"] as const) {
      expect(subscribeStep(grant, false, { found: true, subscribed: true }))
        .toEqual({ kind: "record_subscription", code: "PROVISIONING_BLOCKED" });
    }
  });

  it("não assinado + liberação ativa + gates → subscribe", () => {
    expect(subscribeStep("active", true, { found: true, subscribed: false }))
      .toEqual({ kind: "subscribe" });
  });

  it("não assinado sem liberação ATIVA → GRANT_REQUIRED (consumida não paga outra assinatura)", () => {
    for (const grant of ["consumed_by_this_channel", "none"] as const) {
      for (const gates of [false, true]) {
        expect(subscribeStep(grant, gates, { found: true, subscribed: false }))
          .toEqual({ kind: "refuse", code: "GRANT_REQUIRED" });
      }
    }
  });

  it("não assinado com gates negados → PROVISIONING_BLOCKED", () => {
    expect(subscribeStep("active", false, { found: true, subscribed: false }))
      .toEqual({ kind: "refuse", code: "PROVISIONING_BLOCKED" });
  });

  it("subscribe só nasce de liberação `active` + gates `true` + GET bem formado", () => {
    const odd: unknown[] = [true, false, ...ODD_VALUES];
    for (const grant of [...GRANTS, undefined, "ACTIVE"] as unknown[]) {
      for (const gatesAllowed of odd) {
        for (const found of odd) {
          for (const subscribed of odd) {
            const verdict = decideSubscribeStep(malformed<SubscribeInput>({
              grant, gatesAllowed, remote: { found, subscribed },
            }));
            if (verdict.kind === "subscribe") {
              expect({ grant, gatesAllowed, found, subscribed })
                .toEqual({ grant: "active", gatesAllowed: true, found: true, subscribed: false });
            }
            if (verdict.kind === "already_subscribed" || verdict.kind === "record_subscription") {
              expect({ found, subscribed }).toEqual({ found: true, subscribed: true });
            }
          }
        }
      }
    }
  });
});

// ─── classifyConnectMessage ─────────────────────────────────────────────────

function connectEvent(data: unknown, origin: string = DATAFY_CONNECT_ORIGIN) {
  return { origin, data };
}

const CONNECTED = {
  source: "datafy",
  event: "connected",
  data: { phone_number_id: "pn_1", waba_id: "waba_1", business_id: "biz_1", coexistence: true },
};

describe("classifyConnectMessage — origem exata e source datafy", () => {
  it("a origem é a medida na Fase 0", () => {
    expect(DATAFY_CONNECT_ORIGIN).toBe("https://app.datafyapi.com.br");
  });

  it("origem diferente → ignore (inclusive sufixo, esquema, barra, caixa e userinfo)", () => {
    for (const origin of [
      "https://app.datafyapi.com.br.evil.com",
      "http://app.datafyapi.com.br",
      "https://app.datafyapi.com.br/",
      "https://APP.datafyapi.com.br",
      "https://app.datafyapi.com.br@evil.com",
      "https://app.datafyapi.com.br:8443",
      "https://evil.app.datafyapi.com.br",
      "https://evil.com",
      "null",
      "",
    ]) {
      expect(classifyConnectMessage(connectEvent(CONNECTED, origin))).toBe("ignore");
      expect(classifyConnectMessage(connectEvent(
        { ...CONNECTED, data: { coexistence: false } }, origin,
      ))).toBe("ignore");
    }
  });

  it("data.source diferente de datafy → ignore", () => {
    expect(classifyConnectMessage(connectEvent({ ...CONNECTED, source: "outro" }))).toBe("ignore");
    expect(classifyConnectMessage(connectEvent({ ...CONNECTED, source: "Datafy" }))).toBe("ignore");
    expect(classifyConnectMessage(connectEvent({ event: "connected" }))).toBe("ignore");
  });

  it("data não-objeto → ignore", () => {
    for (const data of [null, undefined, "connected", 42, true, ["datafy"]]) {
      expect(classifyConnectMessage(connectEvent(data))).toBe("ignore");
    }
  });

  it("event connected → connected", () => {
    expect(classifyConnectMessage(connectEvent(CONNECTED))).toBe("connected");
    expect(classifyConnectMessage(connectEvent({ source: "datafy", event: "connected" })))
      .toBe("connected");
    expect(classifyConnectMessage(connectEvent({ source: "datafy", event: "connected", data: null })))
      .toBe("connected");
  });

  it("coexistence false (boolean) → connected_without_app", () => {
    expect(classifyConnectMessage(connectEvent({
      ...CONNECTED, data: { ...CONNECTED.data, coexistence: false },
    }))).toBe("connected_without_app");
  });

  it("coexistence não-boolean ou ausente conta como connected", () => {
    for (const coexistence of ["false", 0, null, undefined, "nao"]) {
      expect(classifyConnectMessage(connectEvent({
        ...CONNECTED, data: { ...CONNECTED.data, coexistence },
      }))).toBe("connected");
    }
  });

  it("event error → error", () => {
    expect(classifyConnectMessage(connectEvent({ source: "datafy", event: "error" }))).toBe("error");
  });

  it("outro event → ignore", () => {
    for (const event of ["closed", "Connected", "", undefined, 1]) {
      expect(classifyConnectMessage(connectEvent({ source: "datafy", event }))).toBe("ignore");
    }
  });
});

// ─── deriveOfficialChecklist ────────────────────────────────────────────────

type ChecklistInput = Parameters<typeof deriveOfficialChecklist>[0];
type ChecklistChannel = NonNullable<ChecklistInput["channel"]>;

function channelRow(overrides: Partial<ChecklistChannel> = {}): ChecklistChannel {
  return {
    status: "connected",
    isActive: false,
    subscribedAt: null,
    echoVerifiedAt: null,
    activationRequestedAt: "2026-10-14T12:00:00+00:00",
    ...overrides,
  };
}

function checklist(overrides: Partial<ChecklistInput> = {}) {
  return deriveOfficialChecklist({
    grantActive: false,
    onboardingState: null,
    channel: null,
    automationDispatchAdopted: false,
    ...overrides,
  });
}

function doneIds(result: ReturnType<typeof deriveOfficialChecklist>): string[] {
  return result.items.filter((item) => item.done).map((item) => item.id);
}

const UP_TO_NUMBER = ["granted", "channel_created", "webhook_ready", "number_connected"];

describe("deriveOfficialChecklist — só estado persistido", () => {
  it("itens são sempre os mesmos ids, na mesma ordem", () => {
    expect(OFFICIAL_CHECKLIST_ITEM_IDS).toEqual([
      "granted", "channel_created", "webhook_ready", "number_connected", "subscribed", "echo_verified", "active",
    ]);
    for (const input of [
      {},
      { grantActive: true, onboardingState: "webhook_ready" as const },
      { channel: channelRow({ isActive: true, subscribedAt: "x", echoVerifiedAt: "y" }) },
    ]) {
      expect(checklist(input).items.map((item) => item.id)).toEqual([...OFFICIAL_CHECKLIST_ITEM_IDS]);
    }
  });

  it("not_granted: sem liberação, sem onboarding vivo e sem canal", () => {
    for (const onboardingState of [null, "abandoned"] as const) {
      const result = checklist({ onboardingState });
      expect(result.step).toBe("not_granted");
      expect(doneIds(result)).toEqual([]);
    }
    // Onboarding concluído é fato histórico: canal e webhook existiram.
    const completed = checklist({ onboardingState: "completed" });
    expect(completed.step).toBe("not_granted");
    expect(doneIds(completed)).toEqual(["channel_created", "webhook_ready"]);
  });

  it("not_granted também com onboarding vivo sem liberação (nada avança sem ela)", () => {
    for (const onboardingState of ["open", "channel_created", "webhook_ready", "connected"] as const) {
      expect(checklist({ onboardingState }).step).toBe("not_granted");
    }
  });

  it("ready_to_connect: liberação ativa e nenhum onboarding vivo", () => {
    for (const onboardingState of [null, "abandoned"] as const) {
      const result = checklist({ grantActive: true, onboardingState });
      expect(result.step).toBe("ready_to_connect");
      expect(doneIds(result)).toEqual(["granted"]);
    }
    expect(checklist({ grantActive: true, onboardingState: "completed" }).step).toBe("ready_to_connect");
  });

  it("connecting: onboarding vivo, antes de a linha do canal existir", () => {
    const open = checklist({ grantActive: true, onboardingState: "open" });
    expect(open.step).toBe("connecting");
    expect(doneIds(open)).toEqual(["granted"]);

    const created = checklist({ grantActive: true, onboardingState: "channel_created" });
    expect(created.step).toBe("connecting");
    expect(doneIds(created)).toEqual(["granted", "channel_created"]);

    for (const onboardingState of ["webhook_ready", "connected"] as const) {
      const result = checklist({ grantActive: true, onboardingState });
      expect(result.step).toBe("connecting");
      expect(doneIds(result)).toEqual(["granted", "channel_created", "webhook_ready"]);
    }
  });

  it("subscription_pending: linha do canal existe e subscribedAt é nulo", () => {
    const result = checklist({ onboardingState: "connected", channel: channelRow() });
    expect(result.step).toBe("subscription_pending");
    // Liberação consumida (grantActive=false) não volta a dizer "não liberado".
    expect(doneIds(result)).toEqual(UP_TO_NUMBER);
  });

  it("subscription_pending vence mesmo com canal ativo (trial acaba e a entrega para)", () => {
    const result = checklist({
      channel: channelRow({ isActive: true, echoVerifiedAt: "2026-10-14T12:05:00+00:00" }),
    });
    expect(result.step).toBe("subscription_pending");
    expect(doneIds(result)).toEqual([...UP_TO_NUMBER, "echo_verified", "active"]);
  });

  it("awaiting_echo: assinado, sem eco ou sem ativação", () => {
    const subscribedAt = "2026-10-14T12:01:00+00:00";
    expect(checklist({ channel: channelRow({ subscribedAt }) }).step).toBe("awaiting_echo");
    expect(checklist({
      channel: channelRow({ subscribedAt, echoVerifiedAt: "2026-10-14T12:05:00+00:00", isActive: false }),
    }).step).toBe("awaiting_echo");
    expect(checklist({
      channel: channelRow({ subscribedAt, echoVerifiedAt: "2026-10-14T12:05:00+00:00", isActive: null }),
    }).step).toBe("awaiting_echo");
    expect(checklist({
      channel: channelRow({ subscribedAt, echoVerifiedAt: null, isActive: true }),
    }).step).toBe("awaiting_echo");
    expect(doneIds(checklist({ channel: channelRow({ subscribedAt }) })))
      .toEqual([...UP_TO_NUMBER, "subscribed"]);
  });

  it("active: assinado, eco verificado e ativo", () => {
    const result = checklist({
      grantActive: false,
      onboardingState: "completed",
      channel: channelRow({
        isActive: true,
        subscribedAt: "2026-10-14T12:01:00+00:00",
        echoVerifiedAt: "2026-10-14T12:05:00+00:00",
      }),
      automationDispatchAdopted: true,
    });
    expect(result.step).toBe("active");
    expect(doneIds(result)).toEqual([...OFFICIAL_CHECKLIST_ITEM_IDS]);
    expect(result.templatesPending).toBe(false);
  });

  it("`status` não muda o progresso (a UI mostra a conexão à parte)", () => {
    const base = {
      isActive: true,
      subscribedAt: "2026-10-14T12:01:00+00:00",
      echoVerifiedAt: "2026-10-14T12:05:00+00:00",
    };
    for (const status of ["connected", "disconnected", "provider_error", null]) {
      expect(checklist({ channel: channelRow({ ...base, status }) }))
        .toEqual(checklist({ channel: channelRow(base) }));
    }
  });

  describe("migrationHold: corte manual pelo suporte", () => {
    const subscribedAt = "2026-10-14T12:01:00+00:00";
    const echoVerifiedAt = "2026-10-14T12:05:00+00:00";

    it("assinado, eco presente e inativo → awaiting_cutover, com os mesmos itens", () => {
      for (const isActive of [false, null]) {
        const channel = channelRow({ subscribedAt, echoVerifiedAt, isActive, activationRequestedAt: null });
        const held = checklist({ channel, migrationHold: true });
        expect(held.step).toBe("awaiting_cutover");
        expect(held.items).toEqual(checklist({ channel }).items);
        expect(doneIds(held)).toEqual([...UP_TO_NUMBER, "subscribed", "echo_verified"]);
      }
    });

    it("sem eco, sem assinatura ou já ativo: migrationHold não muda a etapa", () => {
      for (const channel of [
        channelRow({ subscribedAt }),
        channelRow({ subscribedAt, isActive: true }),
        channelRow(),
        channelRow({ echoVerifiedAt, isActive: false }),
        channelRow({ subscribedAt, echoVerifiedAt, isActive: true }),
      ]) {
        expect(checklist({ channel, migrationHold: true })).toEqual(checklist({ channel }));
      }
      for (const input of [{}, { grantActive: true }, { grantActive: true, onboardingState: "connected" as const }]) {
        expect(checklist({ ...input, migrationHold: true })).toEqual(checklist(input));
      }
    });

    it("só `true` estrito retém: false, ausente ou não-boolean continua awaiting_echo", () => {
      const channel = channelRow({ subscribedAt, echoVerifiedAt, isActive: false });
      for (const migrationHold of [false, ...ODD_VALUES]) {
        expect(checklist({ channel, migrationHold: migrationHold as boolean }).step).toBe("awaiting_echo");
      }
      expect(checklist({ channel }).step).toBe("awaiting_echo");
    });
  });

  it("templatesPending = !automationDispatchAdopted, em qualquer passo", () => {
    for (const input of [
      {},
      { grantActive: true },
      { grantActive: true, onboardingState: "open" as const },
      { channel: channelRow() },
    ]) {
      expect(checklist({ ...input, automationDispatchAdopted: false }).templatesPending).toBe(true);
      expect(checklist({ ...input, automationDispatchAdopted: true }).templatesPending).toBe(false);
    }
  });
});

// ─── isDatafyMigrationGrant ─────────────────────────────────────────────────

type MigrationInput = Parameters<typeof isDatafyMigrationGrant>[0];

function migrationInput(overrides: Partial<MigrationInput> = {}): MigrationInput {
  return {
    grant: { revoked_at: null, consumed_channel_id: null, replaces_channel_id: "uaz-1" },
    binding: { id: "uaz-1", provider: "uazapi" },
    datafyChannelIds: ["dfy-1"],
    ...overrides,
  };
}

describe("isDatafyMigrationGrant — espelho de assert_datafy_first_configuration", () => {
  it("liberação ativa presa ao binding de outro provider vale", () => {
    expect(isDatafyMigrationGrant(migrationInput())).toBe(true);
    for (const provider of ["zapi", "waha", "official"]) {
      expect(isDatafyMigrationGrant(migrationInput({ binding: { id: "uaz-1", provider } }))).toBe(true);
    }
  });

  it("liberação consumida vale só se o consumidor é canal datafy da unidade", () => {
    const consumed = (consumed_channel_id: string) =>
      migrationInput({ grant: { revoked_at: null, consumed_channel_id, replaces_channel_id: "uaz-1" } });
    expect(isDatafyMigrationGrant(consumed("dfy-1"))).toBe(true);
    expect(isDatafyMigrationGrant(consumed("uaz-1"))).toBe(false);
    expect(isDatafyMigrationGrant(consumed("dfy-other-unit"))).toBe(false);
  });

  it("liberação comum, revogada, de outro binding ou ausente não vale", () => {
    expect(isDatafyMigrationGrant(migrationInput({
      grant: { revoked_at: null, consumed_channel_id: null, replaces_channel_id: null },
    }))).toBe(false);
    expect(isDatafyMigrationGrant(migrationInput({
      grant: { revoked_at: "2026-10-16T12:00:00Z", consumed_channel_id: null, replaces_channel_id: "uaz-1" },
    }))).toBe(false);
    expect(isDatafyMigrationGrant(migrationInput({ binding: { id: "uaz-2", provider: "uazapi" } }))).toBe(false);
    expect(isDatafyMigrationGrant(migrationInput({ grant: null }))).toBe(false);
  });

  it("sem binding ou binding datafy não é migração", () => {
    expect(isDatafyMigrationGrant(migrationInput({ binding: null }))).toBe(false);
    expect(isDatafyMigrationGrant(migrationInput({ binding: { id: "uaz-1", provider: "datafy" } }))).toBe(false);
  });

  it("campo malformado falha fechado", () => {
    // "true"/"false" são strings preenchidas: valem como id; malformado é o resto.
    for (const value of ODD_VALUES.filter((odd) => typeof odd !== "string" || odd === "")) {
      expect(isDatafyMigrationGrant(migrationInput({
        grant: malformed({ revoked_at: null, consumed_channel_id: null, replaces_channel_id: value }),
      }))).toBe(false);
      expect(isDatafyMigrationGrant(migrationInput({
        binding: malformed({ id: value, provider: "uazapi" }),
        grant: malformed({ revoked_at: null, consumed_channel_id: null, replaces_channel_id: value }),
      }))).toBe(false);
      expect(isDatafyMigrationGrant(migrationInput({ binding: malformed({ id: "uaz-1", provider: value }) }))).toBe(false);
    }
    // Projeção sem a coluna (`undefined`) não prova "não revogada" nem "não consumida".
    expect(isDatafyMigrationGrant(migrationInput({
      grant: malformed({ consumed_channel_id: null, replaces_channel_id: "uaz-1" }),
    }))).toBe(false);
    expect(isDatafyMigrationGrant(migrationInput({
      grant: malformed({ revoked_at: null, replaces_channel_id: "uaz-1" }),
    }))).toBe(false);
    expect(isDatafyMigrationGrant(migrationInput({ datafyChannelIds: malformed({}) }))).toBe(true);
    expect(isDatafyMigrationGrant(migrationInput({
      grant: { revoked_at: null, consumed_channel_id: "dfy-1", replaces_channel_id: "uaz-1" },
      datafyChannelIds: malformed({}),
    }))).toBe(false);
  });
});

describe("selectDatafyOfflineLegacy — fallback do pin SQL", () => {
  it("preserva a ordem SQL e escolhe o primeiro legado NULL sem filtrar status", () => {
    const rows = [
      { id: "datafy", provider: "datafy", is_active: null, status: "disconnected", created_at: "2020-01-01" },
      { id: "false", provider: "uazapi", is_active: false, status: "connected", created_at: "2020-01-01" },
      { id: "a", provider: "zapi", is_active: null, status: "connecting", created_at: "2025-01-01" },
      { id: "b", provider: "waha", is_active: null, status: "disconnected", created_at: "2025-01-01" },
      { id: "z", provider: "uazapi", is_active: null, status: "provider_error", created_at: "2026-01-01" },
    ];
    expect(selectDatafyOfflineLegacy(rows)?.id).toBe("a");
  });
  it("não reordena dois timestamps no mesmo milissegundo com micros distintos", () => {
    const sqlOrdered = [
      { id: "z", provider: "uazapi", is_active: null, created_at: "2025-01-01T00:00:00.000100+00:00" },
      { id: "a", provider: "waha", is_active: null, created_at: "2025-01-01T00:00:00.000200+00:00" },
    ];
    expect(selectDatafyOfflineLegacy(sqlOrdered)?.id).toBe("z");
  });
  it("grant pendente ou consumido pelo Datafy da unidade autoriza o candidato; revogado não", () => {
    const binding = selectDatafyOfflineLegacy([{ id: "uaz-1", provider: "uazapi", is_active: null, status: "disconnected" }]);
    expect(isDatafyMigrationGrant(migrationInput({ binding }))).toBe(true);
    expect(isDatafyMigrationGrant(migrationInput({ binding, grant: {
      revoked_at: null, consumed_channel_id: "dfy-1", replaces_channel_id: "uaz-1",
    } }))).toBe(true);
    expect(isDatafyMigrationGrant(migrationInput({ binding, grant: {
      revoked_at: "2026-10-17T00:00:00Z", consumed_channel_id: null, replaces_channel_id: "uaz-1",
    } }))).toBe(false);
    expect(selectDatafyOfflineLegacy([{ id: "inactive", provider: "uazapi", is_active: false, status: "disconnected" }])).toBeNull();
  });
});

// ─── decideReplacementConnectionRecorded ────────────────────────────────────

describe("decideReplacementConnectionRecorded — teto de conexões na migração", () => {
  const uaz = { id: "uaz-1", provider: "uazapi" };
  function run(options: {
    replacementConnection?: unknown;
    binding?: { id: unknown; provider: unknown } | null;
    bindingError?: boolean;
    count?: unknown;
    countError?: boolean;
  }) {
    const reads: string[] = [];
    const promise = decideReplacementConnectionRecorded({
      replacementConnection: ("replacementConnection" in options ? options.replacementConnection : true) as boolean,
      loadBinding: async () => {
        reads.push("binding");
        if (options.bindingError) throw new Error("channel_read_failed");
        return (options.binding === undefined ? uaz : options.binding) as { id: string; provider: string | null } | null;
      },
      countLiveInstances: async (channelId) => {
        reads.push(`count:${channelId}`);
        if (options.countError) throw new Error("instance_count_failed");
        return options.count as number;
      },
    });
    return { promise, reads };
  }

  it("uma instância viva no binding estrangeiro desconta a vaga", async () => {
    const { promise, reads } = run({ count: 1 });
    expect(await promise).toEqual({ ok: true, recorded: true });
    expect(reads).toEqual(["binding", "count:uaz-1"]);
  });

  it("zero ou duas instâncias não descontam (mesma regra do switch UazAPI)", async () => {
    for (const count of [0, 2]) expect(await run({ count }).promise).toEqual({ ok: true, recorded: false });
  });

  it("binding ausente ou datafy não desconta e não conta instâncias", async () => {
    for (const binding of [null, { id: "dfy-1", provider: "datafy" }]) {
      const { promise, reads } = run({ binding, count: 1 });
      expect(await promise).toEqual({ ok: true, recorded: false });
      expect(reads).toEqual(["binding"]);
    }
  });

  it("sem liberação de migração (ou valor não-boolean) não lê nada", async () => {
    for (const replacementConnection of [false, ...ODD_VALUES]) {
      const { promise, reads } = run({ replacementConnection, count: 1 });
      expect(await promise).toEqual({ ok: true, recorded: false });
      expect(reads).toEqual([]);
    }
  });

  it("erro de leitura é inverificável: o chamador fecha os gates", async () => {
    expect(await run({ bindingError: true }).promise).toEqual({ ok: false });
    expect(await run({ countError: true }).promise).toEqual({ ok: false });
    for (const count of [null, undefined, -1, 1.5, "1", Number.NaN]) {
      expect(await run({ count }).promise).toEqual({ ok: false });
    }
  });

  it("binding com id malformado não desconta", async () => {
    for (const id of [null, undefined, "", 1]) {
      const { promise, reads } = run({ binding: { id, provider: "uazapi" }, count: 1 });
      expect(await promise).toEqual({ ok: true, recorded: false });
      expect(reads).toEqual(["binding"]);
    }
  });
});
