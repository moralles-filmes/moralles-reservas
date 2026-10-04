export interface TemplateStateInput {
  remoteStatus: string;
  hashMatches: boolean | null;
  categoryAllowed: boolean | null;
  syncRequired: boolean;
  quality: string;
  promotional: boolean;
}

/** GET observations are usable only after SQL accepts their complete generation/epoch set. */
export function deriveTemplateState(input: TemplateStateInput): string {
  if (input.syncRequired) return 'sync_error';
  if (input.remoteStatus === 'APPROVED' && input.hashMatches === true && input.categoryAllowed === true
    && !(input.promotional && input.quality === 'RED')) return 'usable';
  if (input.remoteStatus === 'REJECTED') return 'rejected';
  if (input.remoteStatus === 'PAUSED' || (input.promotional && input.quality === 'RED')) return 'paused';
  if (['DISABLED', 'DELETED', 'PENDING_DELETION'].includes(input.remoteStatus)) return 'disabled';
  if (input.hashMatches !== null && (input.hashMatches === false || input.categoryAllowed === false)) return 'conflict';
  return 'pending';
}
