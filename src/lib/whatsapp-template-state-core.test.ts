import { describe, expect, it } from 'vitest';
import { deriveTemplateState } from '../../supabase/functions/_shared/whatsapp-template-state-core.ts';

const approved = { remoteStatus: 'APPROVED', hashMatches: true, categoryAllowed: true,
  syncRequired: false, quality: 'GREEN', promotional: false };
describe('template state authority', () => {
  it('requires a current complete GET', () => {
    expect(deriveTemplateState(approved)).toBe('usable');
    expect(deriveTemplateState({ ...approved, syncRequired: true })).toBe('sync_error');
  });
  it.each(['PENDING', 'UNKNOWN'])('missing observation is pending, not an external conflict: %s', remoteStatus => {
    expect(deriveTemplateState({ ...approved, remoteStatus, hashMatches: null, categoryAllowed: null })).toBe('pending');
  });
  it.each(['PENDING', 'UNKNOWN', 'SOMETHING_NEW'])('never releases %s', remoteStatus => {
    expect(deriveTemplateState({ ...approved, remoteStatus })).not.toBe('usable');
  });
  it.each(['REJECTED', 'PAUSED', 'DISABLED', 'DELETED'])('blocks %s regardless of category', remoteStatus => {
    expect(deriveTemplateState({ ...approved, remoteStatus })).not.toBe('usable');
  });
  it('blocks structural mismatch and category reclassification', () => {
    expect(deriveTemplateState({ ...approved, hashMatches: false })).toBe('conflict');
    expect(deriveTemplateState({ ...approved, categoryAllowed: false })).toBe('conflict');
  });
  it('RED blocks only promotional content after current GET', () => {
    expect(deriveTemplateState({ ...approved, quality: 'RED' })).toBe('usable');
    expect(deriveTemplateState({ ...approved, quality: 'RED', promotional: true })).toBe('paused');
    expect(deriveTemplateState({ ...approved, quality: 'UNKNOWN' })).toBe('usable');
  });
});
