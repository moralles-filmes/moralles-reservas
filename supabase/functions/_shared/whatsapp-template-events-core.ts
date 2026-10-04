/** Closed WABA management families; no provider JSON is persisted by this module. */
export const TEMPLATE_EVENT_FIELDS = [
  'message_template_status_update', 'message_template_quality_update',
  'template_category_update', 'message_template_components_update',
] as const;
type TemplateEventField = typeof TEMPLATE_EVENT_FIELDS[number];
const CHAT_FIELDS = new Set(['messages', 'smb_message_echoes']);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export const isTemplateEventField = (field: unknown): field is TemplateEventField =>
  typeof field === 'string' && (TEMPLATE_EVENT_FIELDS as readonly string[]).includes(field);

/** Inspection alone introduces no WABA/catalog dependency for existing chat. */
export function inspectTemplateEventFamilies(payload: unknown): 'chat' | 'management' | 'unsupported' {
  if (!record(payload) || !Array.isArray(payload.entry)) return 'chat';
  let unsupported = false;
  let management = false;
  for (const entry of payload.entry) {
    if (!record(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!record(change)) continue;
      if (isTemplateEventField(change.field)) management = true;
      else if (typeof change.field === 'string' && !CHAT_FIELDS.has(change.field)) unsupported = true;
    }
  }
  return management ? 'management' : unsupported ? 'unsupported' : 'chat';
}

export interface ValidatedTemplateEvent {
  field: TemplateEventField; remoteId: string; name: string | null; language: string | null;
  remoteTime: string | null;
  technical: Record<string, string | null>;
  componentText: string | null;
}
export interface EventCatalogIdentity { remote_id: string | null; name: string; language: string }
export interface SanitizedTemplateEvent {
  field: TemplateEventField; remote_id: string; name: null; language: 'pt_BR' | null;
  event_time: string; digest: string; remote_status: string | null; quality: 'RED' | null;
  effective_category: null;
}
function remoteId(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value.toString(10) : null;
  // Decimal string is local defensive tolerance; Datafy docs show numbers.
  return typeof value === 'string' && /^[1-9][0-9]{0,511}$/.test(value) ? value : null;
}
function remoteTime(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  const date = new Date(value * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  const iso = date.toISOString();
  // Use interoperable four-digit ISO years; PostgreSQL has no year zero.
  return /^\d{4}-/.test(iso) && !iso.startsWith('0000-') ? iso : null;
}
function optionalString(value: unknown, pattern: RegExp, max: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= max && pattern.test(value));
}

/** Validate the entire envelope before the caller may perform any write. */
export function validateTemplateEventBatch(payload: unknown, identity: { wabaId: string; phoneNumberId: string }): {
  ok: boolean; reason?: 'template_batch_invalid'; management: ValidatedTemplateEvent[]; hasChat: boolean;
} {
  const invalid = () => ({ ok: false, reason: 'template_batch_invalid' as const, management: [], hasChat: false });
  if (!record(payload) || payload.object !== 'whatsapp_business_account'
    || !Array.isArray(payload.entry) || !payload.entry.length || !identity.wabaId || !identity.phoneNumberId) return invalid();
  const management: ValidatedTemplateEvent[] = [];
  let hasChat = false;
  for (const entry of payload.entry) {
    if (!record(entry) || entry.id !== identity.wabaId || !Array.isArray(entry.changes) || !entry.changes.length) return invalid();
    for (const change of entry.changes) {
      if (!record(change) || !record(change.value)) return invalid();
      const value = change.value;
      if (!isTemplateEventField(change.field)) {
        if (typeof change.field !== 'string' || !CHAT_FIELDS.has(change.field)
          || !record(value.metadata) || value.metadata.phone_number_id !== identity.phoneNumberId) return invalid();
        const arrays = change.field === 'smb_message_echoes' ? ['message_echoes'] : ['messages', 'statuses'];
        if (!arrays.some(key => Array.isArray(value[key]))) return invalid();
        for (const key of ['messages', 'statuses', 'message_echoes']) {
          if (value[key] === undefined) continue;
          const items = value[key];
          if (!arrays.includes(key) || !Array.isArray(items)) return invalid();
          for (const item of items) {
            if (!record(item) || typeof item.id !== 'string' || !item.id) return invalid();
            const required = key === 'statuses' ? ['status'] : key === 'message_echoes' ? ['type', 'to'] : ['type', 'from'];
            if (required.some(name => typeof item[name] !== 'string' || !item[name])) return invalid();
          }
        }
        hasChat = true;
        continue;
      }
      const id = remoteId(value.message_template_id);
      if (!id || !optionalString(value.message_template_name, /^[a-z0-9_]+$/, 512)
        || !optionalString(value.message_template_language, /^[a-z]{2,3}(?:_[A-Za-z]{2,8})?$/, 32)) return invalid();
      const keys = change.field === 'message_template_status_update' ? ['event', 'message_template_category']
        : change.field === 'message_template_quality_update' ? ['previous_quality_score', 'new_quality_score']
        : change.field === 'template_category_update' ? ['previous_category', 'new_category', 'correct_category', 'category_appeal_status'] : [];
      const technical: Record<string, string | null> = {};
      for (const key of keys) {
        if (!optionalString(value[key], /^[A-Z_]+$/, 64)) return invalid();
        technical[key] = typeof value[key] === 'string' ? value[key] : null;
      }
      const componentText = change.field === 'message_template_components_update' ? value.message_template_element : undefined;
      if (componentText !== undefined && (typeof componentText !== 'string' || componentText.length > 65536)) return invalid();
      management.push({ field: change.field, remoteId: id,
        name: typeof value.message_template_name === 'string' ? value.message_template_name : null,
        language: typeof value.message_template_language === 'string' ? value.message_template_language : null,
        remoteTime: remoteTime(entry.time), technical, componentText: typeof componentText === 'string' ? componentText : null });
      if (management.length > 100) return invalid(); // RPC transaction bound.
    }
  }
  return { ok: true, management, hasChat };
}

async function digest(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
/** ID-only persistence prevents SQL's name fallback from matching a foreign homonym. */
export async function sanitizeTemplateEvents(events: ValidatedTemplateEvent[], catalog: EventCatalogIdentity[], observedAt: string): Promise<SanitizedTemplateEvent[]> {
  const receiptTime = new Date(observedAt);
  if (!Number.isFinite(receiptTime.getTime())) throw new Error('template_observed_time_invalid');
  return Promise.all(events.map(async event => {
    const verified = event.language === 'pt_BR' && event.name !== null && catalog.some(t =>
      t.remote_id === event.remoteId && t.name === event.name && t.language === 'pt_BR');
    const status = event.technical.event;
    const restrictiveStatus = event.field === 'message_template_status_update' && status
      && ['PAUSED', 'DISABLED', 'REJECTED', 'DELETED', 'PENDING_DELETION'].includes(status) ? status : null;
    // Fixed tuple and sorted technical keys make arrival/reentry/object key order irrelevant.
    const canonical = JSON.stringify([event.field, event.remoteId, event.name, event.language, event.remoteTime,
      Object.keys(event.technical).sort().map(key => [key, event.technical[key]]),
      event.componentText === null ? null : await digest(event.componentText)]);
    return { field: event.field, remote_id: event.remoteId, name: null, language: verified ? 'pt_BR' : null,
      // Receipt fallback is technical metadata, never a remote ordering authority.
      event_time: event.remoteTime ?? receiptTime.toISOString(), digest: await digest(canonical),
      remote_status: verified ? restrictiveStatus : null,
      quality: verified && event.field === 'message_template_quality_update' && event.technical.new_quality_score === 'RED' ? 'RED' : null,
      effective_category: null };
  }));
}

export interface TemplateEventChannel { id: string; unit_id: string; provider: string; phoneNumberId: string }
export interface TemplateEventAuthority {
  bindingId: string; bindingGeneration: number; accountGeneration: number;
  accountId: string; wabaId: string; organizationId: string; unitOrganizationId: string;
  channelId: string; unitId: string; provider: string; phoneNumberId: string;
  verifiedAt: string | null; credentialRevision: number; bindingCredentialRevision: number;
}
export interface TemplateEventDependencies {
  loadAuthority(channel: TemplateEventChannel): Promise<TemplateEventAuthority | null>;
  loadCatalog(accountId: string): Promise<EventCatalogIdentity[]>;
  persistTemplateEvents(input: { capture: TemplateEventAuthority; events: SanitizedTemplateEvent[] }): Promise<void>;
}
export type TemplateEventResult = { kind: 'chat' } | { kind: 'persisted'; hasChat: boolean; count: number }
  | { kind: 'refused'; status: 401; reason: 'template_batch_invalid' }
  | { kind: 'refused'; status: 503; reason: 'template_dependency_unavailable' };
/** Called only after raw signature verification. No management event enters atendimento. */
export function createTemplateEventService(deps: TemplateEventDependencies) {
  return {
    async process(payload: unknown, channel: TemplateEventChannel, observedAt: string): Promise<TemplateEventResult> {
      const family = inspectTemplateEventFamilies(payload);
      if (family === 'chat') return { kind: 'chat' };
      if (family === 'unsupported') return { kind: 'refused', status: 401, reason: 'template_batch_invalid' };
      try {
        const authority = await deps.loadAuthority(channel);
        if (!authority?.verifiedAt || !authority.accountId || !authority.wabaId || !authority.bindingId
          || !Number.isSafeInteger(authority.bindingGeneration) || authority.bindingGeneration < 1
          || !Number.isSafeInteger(authority.accountGeneration) || authority.accountGeneration < 1
          || authority.channelId !== channel.id || authority.unitId !== channel.unit_id || authority.provider !== channel.provider
          || authority.organizationId !== authority.unitOrganizationId || !authority.organizationId
          || authority.phoneNumberId !== channel.phoneNumberId || !authority.phoneNumberId
          || !Number.isSafeInteger(authority.credentialRevision) || authority.credentialRevision < 0
          || authority.credentialRevision !== authority.bindingCredentialRevision) {
          return { kind: 'refused', status: 503, reason: 'template_dependency_unavailable' };
        }
        const validated = validateTemplateEventBatch(payload, { wabaId: authority.wabaId, phoneNumberId: authority.phoneNumberId });
        if (!validated.ok) return { kind: 'refused', status: 401, reason: 'template_batch_invalid' };
        const catalog = await deps.loadCatalog(authority.accountId);
        const events = await sanitizeTemplateEvents(validated.management, catalog, observedAt);
        // One transaction: sanitized records, dedupe, epochs/revision and reconciliation job.
        await deps.persistTemplateEvents({ capture: authority, events });
        return { kind: 'persisted', hasChat: validated.hasChat, count: events.length };
      } catch {
        // Do not leak provider JSON, SQL messages, component text or rejection reasons.
        return { kind: 'refused', status: 503, reason: 'template_dependency_unavailable' };
      }
    },
  };
}
