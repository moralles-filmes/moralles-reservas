// Vocabulário do ledger de observações da instância (Fase 6c).
//
// FONTE CANÔNICA ÚNICA. Três lugares dependem desta lista e nenhum pode
// redigitá-la: o CHECK da migration 096, o helper `recordInstanceNote` em
// `manage-whatsapp-instances` e os rótulos PT-BR do painel. É a mesma
// disciplina de `EVENT_TYPE_BY_ALERT` (Fase 6b) — lista redigitada é lista que
// diverge, e a divergência aparece só no dia em que alguém usa o valor novo.
//
// AS SETE PRIMEIRAS SAO AS ACOES QUE MUDAM A INSTANCIA E PEDEM MOTIVO. A
// oitava, `CORRECT_CYCLE_COST`, muda um CICLO PASSADO e nao a instancia — ela
// entra aqui, e nao num ledger proprio, porque e a unica escrita capaz de
// alterar custo ja gravado, e o lugar onde alguem procura por isso e a linha do
// tempo da instancia.
//
// A NONA, `DELETE`, e gravada so pela RPC `delete_whatsapp_instance_without_cost`
// (migration 20261016180000), na mesma transacao que apaga a instancia. Ela fica
// com `instance_id` nulo e `instance_ref` intacto: e o registro de quem apagou o
// que, e por que.
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
  "CORRECT_CYCLE_COST",
  "DELETE",
] as const;

export type InstanceNoteAction = (typeof INSTANCE_NOTE_ACTIONS)[number];

export function isInstanceNoteAction(v: unknown): v is InstanceNoteAction {
  return typeof v === "string"
    && (INSTANCE_NOTE_ACTIONS as readonly string[]).indexOf(v) !== -1;
}
