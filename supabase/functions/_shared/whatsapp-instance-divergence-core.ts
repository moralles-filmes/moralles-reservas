// Núcleo puro (Fase 6b): os CINCO tipos canônicos de divergência. ZERO IMPORTS.
//
// Nenhuma divergência gera ação automática: não altera lifecycle_state, não
// cancela instância, não bloqueia envio, e NENHUMA afirma que a Z-API continua
// cobrando. Todas pedem revisão e todas geram linha no ledger.
//
// SILENT_CHANNEL não existe e não deve ser criado: mede USO, não consistência
// entre inventário, lifecycle e estado operacional.

/**
 * Parâmetro operacional INICIAL, não verdade comercial. Constante única e
 * documentada — nunca repetir o número solto em outro arquivo, e sem
 * platform_flag própria nesta fase. Revisão futura exige spec com evidência.
 */
export const LIFECYCLE_CHANNEL_DIVERGENCE_DAYS = 7;

export type DivergenceKind =
  | "CHANNEL_WITHOUT_INSTANCE"
  | "PAYING_WITHOUT_CHANNEL"
  | "INSTANCE_REF_MISMATCH"
  | "LIFECYCLE_VS_CHANNEL_STATE"
  | "ALIVE_AFTER_END";

export type DivergenceFinding = {
  kind: DivergenceKind;
  organizationId: string;
  instanceId: string | null;
  channelId: string | null;
  dedupeKey: string;
  detail: string;
};

export type ChannelRow = {
  channelId: string;
  organizationId: string;
  /**
   * Já resolvido pelo caller: canal real de inventário, não registro técnico
   * incompleto, canal de teste descartado, canal desativado nem registro não
   * faturável. Na dúvida o caller passa `false` e abre revisão administrativa
   * por outro caminho — nunca cria inventário automaticamente.
   */
  isEligibleInventoryChannel: boolean;
  hasLinkedInstance: boolean;
  /** "YYYY-MM" em BRT. */
  monthBrt: string;
};

export type InstanceRow = {
  instanceId: string;
  organizationId: string;
  lifecycleState: string;
  channelId: string | null;
  providerInstanceRef: string | null;
  legacyChannelInstanceRef: string | null;
  /** Último estado CONHECIDO do canal. `null` = ausente ou nunca sincronizado. */
  channelState: string | null;
  /** Idade em dias do último estado conhecido, calculada pelo caller em BRT. */
  channelStateAgeDays: number | null;
  hasAdminExplanation: boolean;
  endedAtIso: string | null;
  lastLocalSignalAtIso: string | null;
};

export function detectChannelWithoutInstance(row: ChannelRow): DivergenceFinding | null {
  if (!row.isEligibleInventoryChannel) return null;
  if (row.hasLinkedInstance) return null;
  return {
    kind: "CHANNEL_WITHOUT_INSTANCE",
    organizationId: row.organizationId,
    // Sujeito é a ORGANIZAÇÃO: não existe instância para apontar, e eleger uma
    // fictícia seria falso.
    instanceId: null,
    channelId: row.channelId,
    dedupeKey: `channel_without_instance:${row.channelId}:${row.monthBrt}`,
    detail:
      "Existe um canal operacional sem registro correspondente no inventário de instâncias. Revise e faça o backfill manual se ele for faturável.",
  };
}

export function detectInstanceDivergences(row: InstanceRow): DivergenceFinding[] {
  const out: DivergenceFinding[] = [];

  if (row.lifecycleState === "ACTIVE" && !row.channelId) {
    out.push({
      kind: "PAYING_WITHOUT_CHANNEL",
      organizationId: row.organizationId,
      instanceId: row.instanceId,
      channelId: null,
      dedupeKey: `paying_without_channel:${row.instanceId}`,
      detail: "Instância ativa no inventário sem canal associado. Verifique se há custo sem uso.",
    });
  }

  if (
    row.providerInstanceRef &&
    row.legacyChannelInstanceRef &&
    row.providerInstanceRef !== row.legacyChannelInstanceRef
  ) {
    // NUNCA escolher automaticamente nem sobrescrever: a decisão é da 6a.
    out.push({
      kind: "INSTANCE_REF_MISMATCH",
      organizationId: row.organizationId,
      instanceId: row.instanceId,
      channelId: row.channelId,
      dedupeKey: `instance_ref_mismatch:${row.instanceId}`,
      detail:
        "O identificador da instância no inventário diverge do usado pelo canal. Nenhuma correção automática foi feita — revise qual é o correto.",
    });
  }

  if (
    row.lifecycleState === "ACTIVE" &&
    row.channelId &&
    row.channelState !== null &&
    row.channelState !== undefined &&
    row.channelState !== "connected" &&
    !row.hasAdminExplanation &&
    row.channelStateAgeDays !== null &&
    row.channelStateAgeDays !== undefined &&
    row.channelStateAgeDays >= LIFECYCLE_CHANNEL_DIVERGENCE_DAYS
  ) {
    out.push({
      kind: "LIFECYCLE_VS_CHANNEL_STATE",
      organizationId: row.organizationId,
      instanceId: row.instanceId,
      channelId: row.channelId,
      dedupeKey: `lifecycle_vs_channel_state:${row.instanceId}`,
      detail: `O canal está fora de "conectado" há ${row.channelStateAgeDays} dias com a instância ativa. Verifique se o cliente perdeu o WhatsApp.`,
    });
  }

  if (
    row.lifecycleState === "ENDED" &&
    row.endedAtIso &&
    row.lastLocalSignalAtIso &&
    row.lastLocalSignalAtIso > row.endedAtIso
  ) {
    out.push({
      kind: "ALIVE_AFTER_END",
      organizationId: row.organizationId,
      instanceId: row.instanceId,
      channelId: row.channelId,
      dedupeKey: `alive_after_end:${row.instanceId}:${row.endedAtIso}`,
      // Texto FIXO e verificado em teste: dizer "a Z-API continua cobrando"
      // seria afirmar sobre o fornecedor a partir de evidência local.
      detail: "Há sinais posteriores ao encerramento registrado. Verifique o estado real no provider.",
    });
  }

  return out;
}
