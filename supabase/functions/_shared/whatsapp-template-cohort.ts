import { TEMPLATE_CATALOG, type TemplateDefinition } from './whatsapp-template-catalog-core.ts';
import { TEMPLATE_V2_CATALOG, type TemplateV2Definition } from './whatsapp-template-catalog-v2.ts';

export type CatalogDefinition = TemplateDefinition | TemplateV2Definition;
export type CatalogVersion = 1 | 2;
export const APPROVED_CATALOG_DIGESTS = {
  1: 'a0fb939e3b2023c8f7c49a7f6fe77049fb312f6d274cf67f23e15f3906298965',
  2: '74512848434a9be4b89916aea5b047f15ddcffc801dba9cb23e41f6f73dcad55',
} as const;
export type TemplateCatalogSelection =
  | { state: 'v1' | 'ready'; version: CatalogVersion; digest: string; grant_binding_id: string | null; generation: number; credential_revision: number }
  | { state: 'pending' | 'paused'; version: null };

/** Absence or malformed SQL authority must never fall back to the legacy catalog. */
export function decodeCatalogSelection(value: unknown): TemplateCatalogSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('template_selection_unavailable');
  const row = value as Record<string, unknown>;
  if ((row.state === 'pending' || row.state === 'paused') && row.version === null) return { state: row.state, version: null };
  if (!((row.state === 'v1' && row.version === 1) || (row.state === 'ready' && row.version === 2))
    || row.digest !== APPROVED_CATALOG_DIGESTS[row.version as CatalogVersion]
    || !(row.grant_binding_id === null || typeof row.grant_binding_id === 'string')
    || !Number.isSafeInteger(row.generation) || Number(row.generation) < 1
    || !Number.isSafeInteger(row.credential_revision) || Number(row.credential_revision) < 0)
    throw new Error('template_selection_unavailable');
  return row as unknown as TemplateCatalogSelection;
}
export function catalogDefinitions(version: CatalogVersion): readonly CatalogDefinition[] {
  return version === 2 ? Object.values(TEMPLATE_V2_CATALOG) : Object.values(TEMPLATE_CATALOG).filter(d => d.state === 'active');
}
export function catalogDefinition(id: string, version: number): CatalogDefinition | null {
  return catalogDefinitions(version === 2 ? 2 : 1).find(d => d.id === id && d.version === version) ?? null;
}
