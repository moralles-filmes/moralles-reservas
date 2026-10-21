import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { requestServicePreference } from '@/features/whatsapp/api';
import {
  servicePreferenceMatches, servicePreferenceResultSchema, servicePreferencesSchema,
  type ServicePreferencePin,
} from '@/features/whatsapp/service-preferences';

type Attempt = { pin: ServicePreferencePin; readCount: number; readQuery: object | undefined; settled: boolean; refused: boolean };
const attemptsByClient = new WeakMap<object, Map<string, Attempt>>();
function attemptMap(client: object) {
  let value = attemptsByClient.get(client);
  if (!value) { value = new Map(); attemptsByClient.set(client, value); }
  return value;
}
function identity(actorId: string, pin: ServicePreferencePin) {
  return `${actorId}:${pin.unitId}:${pin.bindingId}:${pin.generation}:${pin.credentialRevision}:${pin.kind}`;
}
const recognizedErrors = new Set(['unauthorized', 'forbidden', 'configuration_changed', 'not_eligible', 'dependency_unavailable']);
function closedError(code?: unknown): Error {
  return new Error(typeof code === 'string' && recognizedErrors.has(code) ? code : 'dependency_unavailable');
}
export function servicePreferenceErrorMessage(error: unknown): string {
  switch (error instanceof Error ? error.message : '') {
    case 'unauthorized': return 'Sua sessão expirou. Entre novamente.';
    case 'forbidden': return 'Você não tem permissão para alterar estes avisos.';
    case 'configuration_changed': return 'O canal ou a preferência mudou. Atualize os dados antes de escolher novamente.';
    case 'not_eligible': return 'Este aviso ainda não pode ser alterado. Confira os estados e tente mais tarde.';
    default: return 'Não foi possível conferir os avisos. Atualize os dados e fale com o suporte se o erro continuar.';
  }
}

export function useWhatsappServicePreferences(unitId: string, actorId: string) {
  const client = useQueryClient();
  const key = useMemo(() => ['whatsapp-service-preferences', actorId, unitId] as const, [actorId, unitId]);
  const query = useQuery({
    queryKey: key, enabled: !!actorId && !!unitId, retry: false, refetchOnWindowFocus: false,
    refetchInterval: () => document.hidden ? false : 30_000,
    queryFn: async () => {
      const parsed = servicePreferencesSchema.safeParse(await requestServicePreference({ action: 'service_preferences_snapshot', unit_id: unitId }));
      if (!parsed.success || parsed.data.unit_id !== unitId) throw closedError();
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
    for (const current of query.data.kinds) {
      if (!query.data.binding_id || !query.data.binding_generation || query.data.credential_revision === null) continue;
      const attemptKey = identity(actorId, {
        unitId, channelId: query.data.channel_id!, bindingId: query.data.binding_id,
        generation: query.data.binding_generation, credentialRevision: query.data.credential_revision,
        kind: current.kind, enabled: current.enabled, revision: current.revision, nextEnabled: current.enabled,
      });
      const attempt = attempts.get(attemptKey);
      if (!attempt || !attempt.settled || !state
        || (readQuery === attempt.readQuery ? state.dataUpdateCount <= attempt.readCount : state.dataUpdateCount < 1)) continue;
      if (attempt.refused || (current.enabled === attempt.pin.nextEnabled && current.revision > attempt.pin.revision)) {
        attempts.delete(attemptKey); cleared = true;
      }
    }
    if (cleared) refreshAttempts(value => value + 1);
  }, [actorId, attempts, client, key, query.data, query.dataUpdatedAt, query.isError, query.isFetching, unitId]);
  const setPreference = useMutation({
    retry: false,
    mutationFn: async (pin: ServicePreferencePin) => {
      const attemptKey = identity(actorId, pin);
      if (!actorId || query.isError || query.isFetching || !servicePreferenceMatches(query.data, pin)
        || attempts.has(attemptKey)) throw closedError('configuration_changed');
      const attempt: Attempt = { pin: { ...pin }, readCount: client.getQueryState(key)?.dataUpdateCount ?? 0,
        readQuery: client.getQueryCache().find({ queryKey: key, exact: true }), settled: false, refused: false };
      attempts.set(attemptKey, attempt); refreshAttempts(value => value + 1);
      try {
        const parsed = servicePreferenceResultSchema.safeParse(await requestServicePreference({
          action: 'set_service_preference', binding_id: pin.bindingId, kind: pin.kind, enabled: pin.nextEnabled,
          expected_revision: pin.revision, expected_generation: pin.generation,
          expected_credential_revision: pin.credentialRevision,
        }));
        if (!parsed.success || parsed.data.kind !== pin.kind || parsed.data.enabled !== pin.nextEnabled
          || parsed.data.revision <= pin.revision) throw closedError();
        return parsed.data;
      } catch (error) {
        // An explicit gate/CAS refusal can be retried only after a new authoritative read.
        attempt.refused = error instanceof Error && ['configuration_changed', 'not_eligible', 'forbidden'].includes(error.message);
        throw error;
      }
    },
    onSettled: (_data, _error, pin) => {
      const attempt = attempts.get(identity(actorId, pin));
      if (attempt) attempt.settled = true;
      return Promise.all([
        client.invalidateQueries({ queryKey: key, exact: true }),
        client.invalidateQueries({ queryKey: ['whatsapp-dispatch-status', unitId] }),
        client.invalidateQueries({ queryKey: ['whatsapp-templates', unitId] }),
      ]);
    },
  });
  const syncModels = useMutation({
    retry: false,
    mutationFn: async () => {
      const snapshot = query.data;
      if (!snapshot?.eligible || !snapshot.rollout_ready || !snapshot.can_manage || query.isError || query.isFetching
        || !snapshot.channel_id || !snapshot.binding_generation) throw closedError('not_eligible');
      const parsed = z.union([
        z.object({ status: z.literal('requested'), requestId: z.uuid() }).strict(),
        z.object({ status: z.literal('unavailable') }).strict(),
      ]).safeParse(await requestServicePreference({
        action: 'sync', unit_id: unitId, channel_id: snapshot.channel_id,
        expected_binding_generation: snapshot.binding_generation,
      }));
      if (!parsed.success) throw closedError();
      return parsed.data;
    },
    onSettled: () => Promise.all([
      client.invalidateQueries({ queryKey: key, exact: true }),
      client.invalidateQueries({ queryKey: ['whatsapp-onboarding-catalog', unitId] }),
    ]),
  });
  return { query, setPreference, syncModels, wasAttempted: (pin: ServicePreferencePin) => attempts.has(identity(actorId, pin)) };
}
