import { decideIngestionMode, type IngestionMode } from "./whatsapp-inbound-queue-core.ts";

export async function readHealthIngestionMode(
  channel: { async_ingestion_enabled?: boolean | null } | null,
  providerRedelivery: "documented" | "unmeasured" | undefined,
  readFlag: () => Promise<{ enabled: boolean; readFailed: boolean }>,
): Promise<IngestionMode | null> {
  if (!channel) return null;
  const flag = channel.async_ingestion_enabled === true && providerRedelivery === "documented"
    ? await readFlag().catch(() => ({ enabled: false, readFailed: true }))
    : { enabled: false, readFailed: false };
  return decideIngestionMode({ source: "provider", channelEnabled: channel.async_ingestion_enabled,
    providerRedelivery, flagEnabled: flag.enabled, flagReadFailed: flag.readFailed });
}
