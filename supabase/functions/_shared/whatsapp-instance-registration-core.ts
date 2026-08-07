/**
 * Nucleo PURO: esta UNIDADE ja tem instancia viva? ZERO IMPORTS.
 *
 * SEPARADO de `whatsapp-connection-allowance-core.ts` DE PROPOSITO. Aquele
 * nucleo responde "o modelo comercial permite mais uma conexao?" e e
 * compartilhado com `manage-channels`; este responde "esta unidade ja esta
 * ocupada?" e so o registro de instancia pergunta. Fundir os dois levaria um
 * reasonCode sem sentido para o `manage-channels`.
 *
 * O DEFEITO QUE ELE FECHA: sob cortesia vitalicia, `checkConnectionAllowance`
 * nao consulta `activeInstanceCount` (a contagem so e lida no ramo
 * PLAN_DECLARED), entao duas instancias na mesma unidade coexistiam sem que
 * nada reclamasse.
 *
 * NAO E FAIL-CLOSED CEGO: registro legitimo de segunda instancia continua
 * possivel como ATO CONSCIENTE — a recusa acontece uma vez, a tela mostra o que
 * ja existe e o operador confirma.
 */

export interface UnitConflictCandidate {
  id: string;
  /** `lifecycle_state` da instancia ja registrada na unidade. */
  lifecycleState: string;
}

export interface UnitConflictInput {
  /**
   * `false` quando `unit_id` vem nulo. Sem unidade nao ha chave pela qual
   * perguntar, e a ORGANIZACAO nao serve: rede com cinco unidades tem
   * legitimamente cinco instancias. O indice unico de `provider_instance_ref`
   * continua sendo a rede nesse caso.
   */
  unitScoped: boolean;
  /**
   * Instancias `lifecycle_state <> 'ENDED'` ja registradas NA MESMA UNIDADE.
   * `CANCELLATION_REQUESTED` entra: ela custa ate a confirmacao do fim.
   */
  conflicts: UnitConflictCandidate[];
  /** O corpo trouxe `acknowledge_unit_conflict: true`. */
  acknowledged: boolean;
}

export type UnitConflictResult =
  | { ok: true; policy: "NO_UNIT_SCOPE" | "NO_CONFLICT" | "ACKNOWLEDGED" }
  | { ok: false; code: "UNIT_ALREADY_HAS_INSTANCE" };

export function checkUnitInstanceConflict(input: UnitConflictInput): UnitConflictResult {
  if (!input.unitScoped) return { ok: true, policy: "NO_UNIT_SCOPE" };
  if (input.conflicts.length === 0) return { ok: true, policy: "NO_CONFLICT" };
  if (input.acknowledged) return { ok: true, policy: "ACKNOWLEDGED" };
  return { ok: false, code: "UNIT_ALREADY_HAS_INSTANCE" };
}

/** Mensagem PT-BR da recusa. Curta, e diz o que fazer. */
export const UNIT_ALREADY_HAS_INSTANCE_MESSAGE =
  "Esta unidade já tem instância registrada. Confirme que quer registrar uma segunda.";
