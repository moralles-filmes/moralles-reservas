import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { requestManagement } from './useWhatsappTemplates';
import {
  dispatchVersionMatches, dispatchVersionResultSchema, dispatchVersionSchema, dispatchVersionSnapshotSchema,
  type DispatchVersionPin,
} from '@/features/whatsapp/template-dispatch-versions';

type ChannelPin = { channelId: string; generation: number; credentialRevision: number };
type Attempt = { pin: DispatchVersionPin; readCount: number; readQuery: object; settled: boolean; refused: boolean };
const attemptsByClient = new WeakMap<object, Map<string, Attempt>>();
function attemptMap(client: object) {
  let attempts = attemptsByClient.get(client);
  if (!attempts) { attempts = new Map(); attemptsByClient.set(client, attempts); }
  return attempts;
}
function identity(actorId: string, unitId: string, pin: Pick<DispatchVersionPin, 'bindingId' | 'generation' | 'credentialRevision' | 'kind'>) {
  return `${actorId}:${unitId}:${pin.bindingId}:${pin.generation}:${pin.credentialRevision}:${pin.kind}`;
}
const changed = () => new Error('configuration_changed');

export function useWhatsappTemplateDispatchVersions(unitId: string, actorId: string, channel: ChannelPin | null, authorized: boolean) {
  const client = useQueryClient();
  const channelId = channel?.channelId;
  const generation = channel?.generation;
  const credentialRevision = channel?.credentialRevision;
  const key = useMemo(() => ['whatsapp-dispatch-versions', actorId, unitId, channelId, generation, credentialRevision] as const,
    [actorId, unitId, channelId, generation, credentialRevision]);
  const query = useQuery({
    queryKey: key, enabled: authorized && !!actorId && !!unitId && !!channel,
    retry: false, refetchOnWindowFocus: false, refetchInterval: () => document.hidden ? false : 180_000,
    queryFn: async () => {
      if (!authorized || !channel) throw changed();
      const parsed = dispatchVersionSnapshotSchema.safeParse(await requestManagement({ action: 'dispatch_version_snapshot', channel_id: channel.channelId }));
      if (!parsed.success) throw new Error('dependency_unavailable');
      if (parsed.data.channel_id !== channel.channelId || parsed.data.generation !== channel.generation
        || parsed.data.credential_revision !== channel.credentialRevision) throw changed();
      return parsed.data;
    },
  });
  const [attempts] = useState(() => attemptMap(client));
  const [, refreshAttempts] = useState(0);
  useEffect(() => {
    if (query.isFetching || query.isError || !query.data) return;
    const state = client.getQueryState(key);
    const readQuery = client.getQueryCache().find({ queryKey: key, exact: true });
    let cleared = false;
    for (const current of query.data.entries) {
      const attemptKey = identity(actorId, unitId, { bindingId: query.data.binding_id, generation: query.data.generation,
        credentialRevision: query.data.credential_revision, kind: current.kind });
      const attempt = attempts.get(attemptKey);
      if (!attempt || !attempt.settled || !state
        || (readQuery === attempt.readQuery ? state.dataUpdateCount <= attempt.readCount : state.dataUpdateCount < 1)) continue;
      // A timeout remains fenced until a subsequent authoritative read proves the selected revision.
      if (attempt.refused || (current.selected_version === attempt.pin.version && current.selection_source === 'admin'
        && current.revision > attempt.pin.revision)) {
        attempts.delete(attemptKey); cleared = true;
      }
    }
    if (cleared) refreshAttempts(value => value + 1);
  }, [actorId, attempts, client, key, query.data, query.dataUpdatedAt, query.isError, query.isFetching, unitId]);
  const select = useMutation({
    retry: false,
    mutationFn: async (pin: DispatchVersionPin) => {
      const attemptKey = identity(actorId, unitId, pin);
      if (!authorized || !actorId || query.isError || query.isFetching || !channel
        || pin.channelId !== channel.channelId || pin.generation !== channel.generation || pin.credentialRevision !== channel.credentialRevision
        || !dispatchVersionSchema.safeParse(pin.version).success || !dispatchVersionMatches(query.data, pin)
        || attempts.has(attemptKey)) throw changed();
      const attempt: Attempt = { pin: { ...pin }, readCount: client.getQueryState(key)?.dataUpdateCount ?? 0,
        readQuery: client.getQueryCache().find({ queryKey: key, exact: true }), settled: false, refused: false };
      attempts.set(attemptKey, attempt); refreshAttempts(value => value + 1);
      const parsed = dispatchVersionResultSchema.safeParse(await requestManagement({
        action: 'select_dispatch_version', binding_id: pin.bindingId, kind: pin.kind, version: pin.version,
        expected_revision: pin.revision, expected_generation: pin.generation, expected_credential_revision: pin.credentialRevision,
      }));
      if (!parsed.success) throw new Error('dependency_unavailable');
      if (parsed.data.state === 'selected' && (parsed.data.version !== pin.version || parsed.data.revision <= pin.revision)) throw new Error('dependency_unavailable');
      attempt.refused = parsed.data.state !== 'selected';
      return parsed.data;
    },
    onSettled: (_data, _error, pin) => {
      const attempt = attempts.get(identity(actorId, unitId, pin));
      if (attempt) attempt.settled = true;
      return Promise.all([
        client.invalidateQueries({ queryKey: key, exact: true }),
        client.invalidateQueries({ queryKey: ['whatsapp-templates', unitId], exact: true }),
        client.invalidateQueries({ queryKey: ['whatsapp-dispatch-status', unitId] }),
      ]);
    },
  });
  return { query, select, wasAttempted: (pin: DispatchVersionPin) => attempts.has(identity(actorId, unitId, pin)) };
}
