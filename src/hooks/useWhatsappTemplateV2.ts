import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import { supabase } from '@/lib/supabase';
import type { TemplateControls, TemplateSnapshot } from '@/hooks/useWhatsappTemplates';

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const policySchema = z.object({
  version: z.literal(2), enabled: z.boolean(), revision: safeInteger,
  catalogDigest: hash, updatedAt: z.iso.datetime({ offset: true }).nullable(),
}).strict();
const updatedSchema = z.object({ status: z.literal('updated') }).strict();
export type TemplateV2Policy = z.infer<typeof policySchema>;
export type TemplateV2PolicyPin = Pick<TemplateV2Policy, 'enabled' | 'revision' | 'catalogDigest'>;
const policyKey = ['whatsapp-template-v2-policy'] as const;

type V2Request = { action: 'v2_policy_snapshot' }
  | { action: 'set_v2_policy'; enabled: boolean; expected_revision: number }
  | { action: 'select_v2_channel'; channel_id: string; expected_binding_generation: number; expected_credential_revision: number; expected_digest: string }
  | { action: 'stop_v2_channel'; channel_id: string; expected_binding_generation: number; expected_credential_revision: number };
const knownErrors = new Set(['forbidden', 'unauthorized', 'configuration_changed', 'dependency_unavailable', 'not_eligible', 'invalid_request']);
const closedError = (code: unknown) => new Error(typeof code === 'string' && knownErrors.has(code) ? code : 'dependency_unavailable');
async function invokeV2(body: V2Request): Promise<unknown> {
  try {
    const { data, error } = await supabase.functions.invoke('manage-whatsapp-templates', { body });
    if (error) {
      if (error instanceof FunctionsHttpError) {
        const response = await error.context.json().catch(() => null);
        throw closedError(response?.error);
      }
      throw closedError(null);
    }
    return data;
  } catch (error) { throw closedError(error instanceof Error ? error.message : null); }
}
async function readPolicy(): Promise<TemplateV2Policy> {
  const parsed = policySchema.safeParse(await invokeV2({ action: 'v2_policy_snapshot' }));
  if (!parsed.success) throw closedError(null);
  return parsed.data;
}
export function v2PolicyMatches(policy: TemplateV2Policy | undefined, pin: TemplateV2PolicyPin): boolean {
  return policy?.enabled === pin.enabled && policy.revision === pin.revision && policy.catalogDigest === pin.catalogDigest;
}
export function useWhatsappTemplateV2Policy() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: policyKey, queryFn: readPolicy, retry: false, refetchOnWindowFocus: false });
  const change = useMutation({
    retry: false,
    mutationFn: async (pin: TemplateV2PolicyPin) => {
      if (query.isError || query.isFetching || !v2PolicyMatches(query.data, pin)) throw closedError('configuration_changed');
      const parsed = policySchema.safeParse(await invokeV2({ action: 'set_v2_policy', enabled: !pin.enabled, expected_revision: pin.revision }));
      if (!parsed.success) throw closedError(null);
      if (parsed.data.enabled === pin.enabled || parsed.data.revision <= pin.revision || parsed.data.catalogDigest !== pin.catalogDigest) throw closedError('configuration_changed');
      return parsed.data;
    },
    onSettled: () => client.invalidateQueries({ queryKey: policyKey, exact: true }),
  });
  return { query, change };
}

export type TemplateV2ChannelPin = {
  kind: 'select' | 'stop'; channelId: string; bindingGeneration: number; credentialRevision: number;
  digest: string; selectionDigest: string;
};
export function v2ChannelMatches(snapshot: TemplateSnapshot | undefined, pin: TemplateV2ChannelPin, policy?: TemplateV2Policy): boolean {
  if (!snapshot || snapshot.providerLabel !== 'Datafy' || snapshot.channelId !== pin.channelId
    || snapshot.configuration.bindingGeneration !== pin.bindingGeneration
    || snapshot.configuration.credentialRevision !== pin.credentialRevision) return false;
  const selection = snapshot.catalogSelection;
  if (pin.kind === 'select') return selection?.state === 'v1' && selection.version === 1
    && selection.digest === pin.selectionDigest && policy?.catalogDigest === pin.digest;
  return selection?.state === 'ready' && selection.version === 2 && selection.digest === pin.digest
    && selection.digest === pin.selectionDigest;
}
const attemptKey = (pin: TemplateV2ChannelPin) => `${pin.kind}:${pin.channelId}:${pin.bindingGeneration}:${pin.credentialRevision}:${pin.digest}:${pin.selectionDigest}`;
// Keep an ambiguous attempt fenced across card remounts within this query-client session.
const attemptsByClient = new WeakMap<object, Set<string>>();
function channelAttempts(client: object): Set<string> {
  let attempts = attemptsByClient.get(client);
  if (!attempts) { attempts = new Set(); attemptsByClient.set(client, attempts); }
  return attempts;
}
export function useWhatsappTemplateV2Channel(unitId: string, controls: TemplateControls, policy: ReturnType<typeof useWhatsappTemplateV2Policy>['query']) {
  const client = useQueryClient();
  const [attempted] = useState(() => channelAttempts(client));
  const [, setAttemptRevision] = useState(0);
  const change = useMutation({
    retry: false,
    mutationFn: async (pin: TemplateV2ChannelPin) => {
      if (!controls.canAdministerCatalog || controls.query.isError || controls.query.isFetching
        || (pin.kind === 'select' && (policy.isError || policy.isFetching))
        || !v2ChannelMatches(controls.query.data, pin, policy.data)
        || !z.uuid().safeParse(pin.channelId).success || !safeInteger.min(1).safeParse(pin.bindingGeneration).success
        || !safeInteger.safeParse(pin.credentialRevision).success || !hash.safeParse(pin.digest).success
        || attempted.has(attemptKey(pin))) throw closedError('configuration_changed');
      // An ambiguous response must be reconciled by reads, never a repeated grant click.
      attempted.add(attemptKey(pin));
      setAttemptRevision(revision => revision + 1);
      const body = { channel_id: pin.channelId, expected_binding_generation: pin.bindingGeneration, expected_credential_revision: pin.credentialRevision };
      const result = await invokeV2(pin.kind === 'select' ? { ...body, action: 'select_v2_channel', expected_digest: pin.digest } : { ...body, action: 'stop_v2_channel' });
      if (!updatedSchema.safeParse(result).success) throw closedError(null);
    },
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['whatsapp-templates', unitId], exact: true }),
        client.invalidateQueries({ queryKey: ['whatsapp-onboarding-catalog', unitId], exact: true }),
      ]);
    },
  });
  return { change, wasAttempted: (pin: TemplateV2ChannelPin) => attempted.has(attemptKey(pin)) };
}
