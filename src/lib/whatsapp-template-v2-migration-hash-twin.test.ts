import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogHash } from '../../supabase/functions/_shared/whatsapp-template-catalog-core';
import { TEMPLATE_V2_CATALOG } from '../../supabase/functions/_shared/whatsapp-template-catalog-v2';
import { submissionPayloadHash } from '../../supabase/functions/_shared/whatsapp-template-submission-hash';

const migration = readFileSync(resolve(__dirname, '../../supabase/migrations/20261019133502_whatsapp_template_copy_v2_cohorts.sql'), 'utf8');
const tuplePattern = /\('((?:res|fila|mkt)_[a-z_]+_v2)',\s*(\d+),\s*'([^']+)',\s*'([^']+)',\s*'([a-f0-9]{64})',\s*'([a-f0-9]{64})'\)/g;
type ApprovedTuple = readonly [id: string, version: number, language: string, category: string, desiredHash: string, payloadHash: string];

function readTuples(sql: string): ApprovedTuple[] {
  const seed = /insert\s+into\s+app_private\.whatsapp_template_approved_submissions\s*\(logical_id,version,language,requested_category,desired_hash,payload_hash\)\s*values([\s\S]+?)on\s+conflict\s*\(logical_id\)\s*do\s+nothing\s*;/i.exec(sql);
  if (!seed) throw new Error('v2_seed_missing');
  const tuples: ApprovedTuple[] = [...seed[1].matchAll(tuplePattern)].map(match => [match[1], Number(match[2]), match[3], match[4], match[5], match[6]]);
  // Fail if a malformed/extra tuple would otherwise disappear from the extraction.
  if (seed[1].replace(tuplePattern, '').replace(/[,\s]/g, '') !== '') throw new Error('v2_seed_unparsed');
  return tuples;
}

function digest(tuples: readonly ApprovedTuple[]): string {
  const canonical = [...tuples].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(tuple => tuple.join(':')).join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

async function compareHashes(sql: string): Promise<string[]> {
  const tuples = readTuples(sql);
  const mismatches: string[] = [];
  if (tuples.length !== 9 || new Set(tuples.map(tuple => tuple[0])).size !== 9) mismatches.push('v2_cohort_count');
  const expected: ApprovedTuple[] = await Promise.all(Object.values(TEMPLATE_V2_CATALOG).map(async definition => [
    definition.id, definition.version, definition.language, definition.requestedCategory,
    await catalogHash(definition), await submissionPayloadHash(definition),
  ] as const));
  const ordered = (values: readonly ApprovedTuple[]) => [...values].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (JSON.stringify(ordered(tuples)) !== JSON.stringify(ordered(expected))) mismatches.push('v2_tuples_drift');
  const expectedDigest = digest(expected);
  const assertedDigest = /whatsapp_template_approved_catalog_digest\(2\)\s+is\s+distinct\s+from\s+'([a-f0-9]{64})'/i.exec(sql)?.[1];
  if (assertedDigest !== expectedDigest || digest(tuples) !== expectedDigest) mismatches.push('v2_digest_drift');
  const policyDigest = /insert\s+into\s+app_private\.whatsapp_template_v2_policy\s*\(id,enabled,revision,catalog_digest\)\s*values\s*\(1,false,0,'([a-f0-9]{64})'\)/i.exec(sql)?.[1];
  if (policyDigest !== expectedDigest) mismatches.push('v2_policy_digest_drift');
  return mismatches;
}

describe('allowlist SQL v2 ⇔ conteúdo e JSON completo com exemplos canônicos', () => {
  it('fixa as nove tuples v2 e o digest da coorte/política contra os hashes calculados do catálogo', async () => {
    expect(await compareHashes(migration)).toEqual([]);
    expect(readTuples(migration).map(tuple => tuple[0]).sort()).toEqual(Object.keys(TEMPLATE_V2_CATALOG).sort());
  });

  it.each(['content', 'payload', 'category', 'missing_tuple', 'digest', 'policy_digest'] as const)('CONTROLE RED: detecta drift SQL de %s', async fault => {
    const tuples = readTuples(migration);
    const first = tuples[0];
    let changed: string;
    if (fault === 'content') changed = migration.replace(first[4], '0'.repeat(64));
    if (fault === 'payload') changed = migration.replace(first[5], '0'.repeat(64));
    if (fault === 'category') changed = migration.replace(`'${first[0]}',2,'pt_BR','UTILITY'`, `'${first[0]}',2,'pt_BR','MARKETING'`);
    if (fault === 'missing_tuple') changed = migration.replace(tuplePattern, (tuple, id: string) => id === first[0] ? '' : tuple);
    if (fault === 'digest') changed = migration.replace(/(whatsapp_template_approved_catalog_digest\(2\)\s+is\s+distinct\s+from\s+')[a-f0-9]{64}/i, `$1${'0'.repeat(64)}`);
    if (fault === 'policy_digest') changed = migration.replace(/(values\s*\(1,false,0,')[a-f0-9]{64}/i, `$1${'0'.repeat(64)}`);
    expect(changed).not.toBe(migration);
    expect((await compareHashes(changed)).length).toBeGreaterThan(0);
  });
});
