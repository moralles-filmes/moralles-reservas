import { toE164BrPhone } from './phone.ts';
import type { TemplateDefinition } from './whatsapp-template-catalog-core.ts';
import type { WhatsAppProviderErrorCode } from './whatsapp-provider-core.ts';

export type TemplateSubmissionDefinition = Omit<Pick<TemplateDefinition,
  'name' | 'language' | 'requestedCategory' | 'parameterFormat' | 'components' | 'examples'>, 'name'>
  & Readonly<{ name: string }>;

export interface TemplateMessageInput {
  toPhone: string;
  name: string;
  language: string;
  parameters: readonly string[];
}

/** Remote observations only: this snapshot never decides approval or usability. */
export interface RemoteTemplateSnapshot {
  remoteId: string;
  name: string;
  language: string;
  parameterFormat: string | null;
  status: string;
  category: string;
  quality: string | null;
  components: readonly Readonly<Record<string, unknown>>[] | null;
  rejectionCode: string | null;
}

export interface TemplatePage {
  templates: RemoteTemplateSnapshot[];
  nextCursor: string | null;
}

export type TemplateMutationFailure =
  | { state: 'rejected'; error: string; errorCode: WhatsAppProviderErrorCode;
    status?: number; retryable: boolean; retryAfterSeconds?: number }
  | { state: 'uncertain'; error: string; errorCode: WhatsAppProviderErrorCode; status?: number };

/** Accepted submission is independent of the GET that can later establish approval. */
export type TemplateCreateOutcome = TemplateMutationFailure | {
  state: 'accepted'; status: number; remoteId: string;
  remoteStatus: string | null; category: string | null;
};

/** Accepted means provider acceptance, never delivery. Missing IDs are uncertain. */
export type TemplateSendOutcome = TemplateMutationFailure | {
  state: 'accepted'; status: number; providerMessageId: string;
};

export interface TemplateListInput { wabaId: string; after?: string; }
export interface TemplateCreateInput { wabaId: string; definition: TemplateDefinition; }
export interface TemplateSendInput extends TemplateMessageInput { phoneNumberId: string; }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function technicalCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : null;
}

export function buildTemplateMessage(input: TemplateMessageInput) {
  const to = toE164BrPhone(input.toPhone);
  if (!/^55\d{10,11}$/.test(to) || !/^[a-z0-9_]{1,512}$/.test(input.name)
    || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(input.language)
    || !Array.isArray(input.parameters) || input.parameters.some(value => typeof value !== 'string' || !value)) {
    throw new Error('template_input_invalid');
  }
  return {
    messaging_product: 'whatsapp' as const, recipient_type: 'individual' as const, to,
    type: 'template' as const,
    template: {
      name: input.name, language: { code: input.language },
      components: [{ type: 'body' as const,
        parameters: input.parameters.map(value => ({ type: 'text' as const, text: value })) }],
    },
  };
}

export function buildTemplateSubmission(definition: TemplateSubmissionDefinition) {
  return {
    name: definition.name, language: definition.language, category: definition.requestedCategory,
    parameter_format: definition.parameterFormat,
    components: definition.components.map(component => ({
      ...component,
      ...(component.type === 'BODY' ? { example: { body_text: definition.examples.map(row => [...row]) } } : {}),
    })),
  };
}

/** Opaque cursor; encode when constructing the fixed-origin request, never follow paging.next. */
export function nextTemplateCursor(cursor: unknown, seen: ReadonlySet<string>): string {
  if (typeof cursor !== 'string' || !cursor || cursor.length > 4096 || /[\s\p{Cc}\p{Cf}\p{Cs}]/u.test(cursor)) {
    throw new Error('template_cursor_invalid');
  }
  if (seen.has(cursor)) throw new Error('template_cursor_cycle');
  return cursor;
}

export function parseTemplatePage(body: unknown, seen: ReadonlySet<string> = new Set()): TemplatePage {
  const page = record(body);
  if (!page || !Array.isArray(page.data)) throw new Error('template_response_invalid');
  const templates = page.data.map(item => {
    const entry = record(item);
    if (!entry || !text(entry.id) || !text(entry.name) || !text(entry.language)
      || !text(entry.status) || !text(entry.category)) throw new Error('template_response_invalid');
    if (entry.components !== undefined && (!Array.isArray(entry.components) || entry.components.some(value => !record(value)))) {
      throw new Error('template_response_invalid');
    }
    return {
      remoteId: text(entry.id)!, name: text(entry.name)!, language: text(entry.language)!,
      status: text(entry.status)!, category: text(entry.category)!,
      parameterFormat: text(entry.parameter_format),
      // Absence remains unknown. It cannot erase a RED event in the sync service.
      quality: technicalCode(record(entry.quality_score)?.score),
      components: entry.components === undefined ? null : entry.components as Record<string, unknown>[],
      rejectionCode: technicalCode(entry.rejected_reason),
    };
  });
  const paging = record(page.paging);
  if (page.paging !== undefined && !paging) throw new Error('template_response_invalid');
  if (!paging || paging.next === undefined) return { templates, nextCursor: null };
  if (!text(paging.next) || !text(record(paging.cursors)?.after)) throw new Error('template_response_invalid');
  return { templates, nextCursor: nextTemplateCursor(record(paging.cursors)!.after, seen) };
}

export function classifyTemplateMutationResponse(status: number, body: unknown): TemplateMutationFailure | null {
  if (status >= 200 && status < 300) return null;
  const payload = record(body);
  // Documented Datafy preproxy errors prove that Meta has not received the POST.
  const preproxy = payload?.statusCode === status && typeof payload?.message === 'string'
    && payload.error === undefined && [401, 402, 403, 409, 429].includes(status);
  const metaError = record(payload?.error);
  // Nontransient Meta 4xx with an actual error code is an explicit refusal.
  const metaRejection = status >= 400 && status < 500 && status !== 408 && status !== 429
    && Number.isSafeInteger(metaError?.code);
  const errorCode: WhatsAppProviderErrorCode = status === 429 ? 'RATE_LIMITED'
    : [401, 402, 403].includes(status) ? 'AUTH_ERROR'
    : status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'INVALID_REQUEST';
  const error = `datafy_template_http_${status}`;
  if (!preproxy && !metaRejection) return { state: 'uncertain', status, error, errorCode };
  const match = preproxy && status === 429 ? /Tente novamente em (\d+)s\./.exec(payload!.message as string) : null;
  const seconds = match ? Number(match[1]) : 0;
  return { state: 'rejected', status, error, errorCode, retryable: preproxy && status === 429,
    ...(Number.isSafeInteger(seconds) && seconds > 0 ? { retryAfterSeconds: seconds } : {}) };
}
