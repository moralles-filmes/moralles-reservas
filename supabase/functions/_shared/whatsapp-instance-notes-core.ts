// Vocabulário do ledger de observações da instância (Fase 6c).
//
// FONTE CANÔNICA ÚNICA. Três lugares dependem desta lista e nenhum pode
// redigitá-la: o CHECK da migration 096, o helper `recordInstanceNote` em
// `manage-whatsapp-instances` e os rótulos PT-BR do painel. É a mesma
// disciplina de `EVENT_TYPE_BY_ALERT` (Fase 6b) — lista redigitada é lista que
// diverge, e a divergência aparece só no dia em que alguém usa o valor novo.
//
// AS SETE SÃO AS AÇÕES QUE MUDAM A INSTÂNCIA E PEDEM MOTIVO. Cobrir as sete é
// o que torna a propriedade difícil de perder: ação nova que peça motivo já tem
// onde registrar.
//
// `acknowledge_alert` e `resolve_alert` ficam de FORA de propósito — elas
// também pedem motivo, mas escrevem no ledger de ALERTAS, que já guarda uma
// linha por alerta. Duplicar aqui misturaria dois assuntos na mesma linha do
// tempo.

export const INSTANCE_NOTE_ACTIONS = [
  "REGISTER",
  "UPDATE",
  "REACTIVATE",
  "SET_COST",
  "CONFIRM_CYCLE_DATE",
  "REQUEST_CANCELLATION",
  "CONFIRM_END",
] as const;

export type InstanceNoteAction = (typeof INSTANCE_NOTE_ACTIONS)[number];

export function isInstanceNoteAction(v: unknown): v is InstanceNoteAction {
  return typeof v === "string"
    && (INSTANCE_NOTE_ACTIONS as readonly string[]).indexOf(v) !== -1;
}
