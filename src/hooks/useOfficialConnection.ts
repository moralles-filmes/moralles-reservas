import { useCallback, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { readOfficialConnection, startOfficialConnection, confirmOfficialConnection, type OfficialConnectionState } from "@/features/whatsapp/official-connection-api";
export type { OfficialConnectionState } from "@/features/whatsapp/official-connection-api";

function subscribeVisibility(callback: () => void) {
  document.addEventListener("visibilitychange", callback);
  return () => document.removeEventListener("visibilitychange", callback);
}
const pageVisible = () => !document.hidden;

export function officialPollingInterval(state: OfficialConnectionState | null | undefined, visible: boolean) {
  if (!visible) return false;
  return state?.step === "connecting" || state?.step === "awaiting_echo" ? 5_000 : 30_000;
}

export function useOfficialConnection(unitId: string) {
  const client = useQueryClient();
  const visible = useSyncExternalStore(subscribeVisibility, pageVisible, () => true);
  const query = useQuery<OfficialConnectionState | null>({
    queryKey: ["official-connection", unitId],
    queryFn: () => readOfficialConnection(unitId),
    enabled: !!unitId,
    refetchOnWindowFocus: false,
    refetchInterval: (q) => officialPollingInterval(q.state.data, visible),
  });
  // Deliberately NOT a mutation: even a mutation's result cache must never retain the link.
  const start = useCallback(async (popup: Window, isCurrent: () => boolean) => {
    return startOfficialConnection(unitId, popup, isCurrent);
  }, [unitId]);
  const confirm = useCallback(async () => {
    await confirmOfficialConnection(unitId);
    await Promise.all([
      client.invalidateQueries({ queryKey: ["official-connection", unitId] }),
      client.invalidateQueries({ queryKey: ["whatsapp-connection", unitId] }),
    ]);
  }, [client, unitId]);
  return { ...query, start, confirm };
}
