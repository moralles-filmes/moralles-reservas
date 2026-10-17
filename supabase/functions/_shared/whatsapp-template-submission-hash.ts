import type { TemplateDefinition } from './whatsapp-template-catalog-core.ts';
import { buildTemplateSubmission } from './whatsapp-template-provider-core.ts';

/** Hash the exact JSON body sent to Datafy, including example values.
 * Object key order is normalized for a stable SQL allowlist; array order is significant.
 */
export async function submissionPayloadHash(definition: TemplateDefinition): Promise<string> {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, child]) => [key, canonical(child)]));
    }
    return value;
  };
  const body = JSON.stringify(canonical(buildTemplateSubmission(definition)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
