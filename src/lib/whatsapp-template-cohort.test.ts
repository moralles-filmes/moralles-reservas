import { describe, expect, it } from 'vitest';
import { APPROVED_CATALOG_DIGESTS, catalogDefinition, catalogDefinitions, decodeCatalogSelection } from '../../supabase/functions/_shared/whatsapp-template-cohort.ts';

describe('authoritative template cohort selection', () => {
  const v2 = { state: 'ready', version: 2, digest: APPROVED_CATALOG_DIGESTS[2], grant_binding_id: 'binding', generation: 1, credential_revision: 0 };
  it('requires a complete SQL cohort and never infers v1 from missing/unknown data', () => {
    for (const invalid of [null, undefined, {}, { state: 'v1' }, { ...v2, version: 1 }, { ...v2, digest: APPROVED_CATALOG_DIGESTS[1] }, { ...v2, generation: 0 }, { ...v2, credential_revision: 1.1 }, { state: 'unknown', version: null }])
      expect(() => decodeCatalogSelection(invalid)).toThrow('template_selection_unavailable');
    expect(decodeCatalogSelection(v2)).toEqual(v2);
    expect(decodeCatalogSelection({ state: 'pending', version: null })).toEqual({ state: 'pending', version: null });
  });
  it('selects exactly nine definitions with their true immutable identities', () => {
    for (const version of [1, 2] as const) {
      expect(catalogDefinitions(version)).toHaveLength(9);
      expect(catalogDefinitions(version).every(d => d.version === version && d.id.endsWith(`_v${version}`))).toBe(true);
    }
    expect(catalogDefinition('res_confirmacao_v2', 1)).toBeNull();
    expect(catalogDefinition('res_confirmacao_v1', 2)).toBeNull();
  });
});
