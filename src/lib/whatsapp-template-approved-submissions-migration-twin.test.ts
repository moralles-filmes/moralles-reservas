import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TEMPLATE_CATALOG, catalogHash } from '../../supabase/functions/_shared/whatsapp-template-catalog-core';
import { submissionPayloadHash } from '../../supabase/functions/_shared/whatsapp-template-submission-hash';

const migration = readFileSync(resolve(__dirname,
  '../../supabase/migrations/20261017200000_whatsapp_template_approved_submission_pilot.sql'), 'utf8');
const seedRows = [...migration.matchAll(/\('((?:res|fila|mkt)_[a-z_]+_v1)',1,'pt_BR','(UTILITY|MARKETING)','([a-f0-9]{64})','([a-f0-9]{64})'\)/g)];

describe('approved Datafy submission migration twin', () => {
  it('pins exactly the active version-1 catalog and the full request payload', async () => {
    const approved = new Map(seedRows.map((row) => [row[1], {
      category: row[2], desiredHash: row[3], payloadHash: row[4],
    }]));
    const active = Object.values(TEMPLATE_CATALOG).filter((template) => template.state === 'active' && template.version === 1);
    expect(seedRows).toHaveLength(9);
    expect(approved.size).toBe(9);
    expect([...approved.keys()].sort()).toEqual(active.map((template) => template.id).sort());
    for (const template of active) {
      expect(approved.get(template.id)).toEqual({
        category: template.requestedCategory,
        desiredHash: await catalogHash(template),
        payloadHash: await submissionPayloadHash(template),
      });
    }
  });

  it('rejects changed submission examples even when the remote structural hash is unchanged', async () => {
    const template = TEMPLATE_CATALOG.res_confirmacao_v1;
    const approved = seedRows.find((row) => row[1] === template.id);
    expect(approved).toBeDefined();
    const changed = { ...template, examples: [['different']] };
    expect(await catalogHash(changed)).toBe(approved![3]);
    expect(await submissionPayloadHash(changed)).not.toBe(approved![4]);
  });
});
