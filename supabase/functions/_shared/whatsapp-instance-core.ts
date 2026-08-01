// Núcleo puro (Fase 6b): gate de provisionamento e máquina de lifecycle.
// ZERO IMPORTS — ver o cabeçalho de whatsapp-instance-cycle-core.ts.

/**
 * Proibição ESTRUTURAL e TEMPORÁRIA, não rollout gradual: por isso constante
 * e não platform_flag. Uma flag existiria para ser ligada; esta constante
 * existe para ser REMOVIDA pelo PR da Fase 6a, que substitui os testes de
 * recusa por testes de liberação condicionada.
 */
export const NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A = true;

export const PROVISIONING_BLOCKED_CODE =
  "NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A";

const PROVISIONING_BLOCKED_MESSAGE =
  "Provisionamento de instância nova está bloqueado até a Fase 6a (criptografia das credenciais em repouso). Registro de instância já existente (backfill) continua permitido.";

export type LifecycleState =
  | "AWAITING_PROVISION"
  | "ACTIVE"
  | "CANCELLATION_REQUESTED"
  | "ENDED";

export type CoreResult = { ok: true } | { ok: false; code: string; message: string };

export type ProvisioningIntent = "BACKFILL_EXISTING" | "NEW_PROVISION" | "AMBIGUOUS";

/**
 * AMBIGUOUS bloqueia junto com NEW_PROVISION: na dúvida entre "já existe lá
 * fora" e "vamos criar", a direção segura é não autorizar custo novo.
 */
export function assertProvisioningAllowed(intent: ProvisioningIntent): CoreResult {
  if (intent === "BACKFILL_EXISTING") return { ok: true };
  if (!NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A) return { ok: true };
  return {
    ok: false,
    code: PROVISIONING_BLOCKED_CODE,
    message: PROVISIONING_BLOCKED_MESSAGE,
  };
}

const ALLOWED: Record<LifecycleState, LifecycleState[]> = {
  AWAITING_PROVISION: ["ACTIVE", "ENDED"],
  ACTIVE: ["CANCELLATION_REQUESTED"],
  CANCELLATION_REQUESTED: ["ENDED", "ACTIVE"],
  ENDED: [],
};

export function canTransition(
  from: LifecycleState,
  to: LifecycleState,
  opts: { hasProviderEvidence: boolean },
): CoreResult {
  if (from === to) return { ok: true };

  if (!ALLOWED[from] || ALLOWED[from].indexOf(to) === -1) {
    return {
      ok: false,
      code: "LIFECYCLE_TRANSITION_NOT_ALLOWED",
      message: `Transição ${from} → ${to} não é permitida.`,
    };
  }

  // Reverter um cancelamento é afirmar que o fornecedor desfez algo. Sem
  // evidência, seria o bug 08 outra vez: o sistema afirmando o que o provedor
  // nunca fez.
  if (from === "CANCELLATION_REQUESTED" && to === "ACTIVE" && !opts.hasProviderEvidence) {
    return {
      ok: false,
      code: "REACTIVATION_REQUIRES_EVIDENCE",
      message: "Reverter o cancelamento exige evidência registrada de que ele foi desfeito no fornecedor.",
    };
  }

  return { ok: true };
}

const MAX_REF_LENGTH = 128;

/**
 * Sanidade, não autenticação. O identificador sozinho não envia mensagem — o
 * token, a outra metade da URL, fica só no canal. Recusar URL completa é o que
 * impede alguém colar a URL de envio inteira neste campo e vazar o token para
 * uma tabela que a spec declara livre de segredo.
 */
export function validateProviderInstanceRef(
  raw: string,
): { ok: true; value: string } | { ok: false; code: string; message: string } {
  const value = typeof raw === "string" ? raw.trim() : "";

  if (value.length === 0) {
    return { ok: false, code: "REF_EMPTY", message: "Identificador da instância é obrigatório." };
  }
  if (value.length > MAX_REF_LENGTH) {
    return { ok: false, code: "REF_TOO_LONG", message: "Identificador da instância excede o tamanho esperado." };
  }
  if (/\s/.test(value)) {
    return { ok: false, code: "REF_HAS_WHITESPACE", message: "Identificador da instância não pode conter espaços." };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.indexOf("/") !== -1) {
    return {
      ok: false,
      code: "REF_LOOKS_LIKE_URL",
      message: "Informe apenas o identificador da instância, nunca a URL — ela contém o token.",
    };
  }
  return { ok: true, value };
}
