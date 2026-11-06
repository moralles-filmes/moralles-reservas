// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveOrCreateCustomer } from './resolve-customer';

// Banco falso: lookup devolve `existing`; o update grava o que recebeu.
function fakeDb(existing: Record<string, unknown> | null) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    from: () => {
      let pending: Record<string, unknown> | null = null;
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = () => Promise.resolve({ data: existing, error: null });
      q.update = (u: Record<string, unknown>) => { pending = u; updates.push(u); return q; };
      q.single = () => Promise.resolve({ data: { ...existing, ...pending }, error: null });
      return q;
    },
  };
  return { db, updates };
}

const base = { organizationId: 'org-1', phone: '11988887777', name: 'Outra Pessoa' };
const stored = (over: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'Ana', phone: '11988887777', email: null, emails: [], birthday: null, ...over,
});

describe('resolveOrCreateCustomer com telefone não verificado (portal)', () => {
  it('cadastro sem e-mail não recebe o digitado nem o aniversário', async () => {
    const { db, updates } = fakeDb(stored());
    const out = await resolveOrCreateCustomer(db as never, { ...base, email: 'x@ex.com', birthday: '1990-01-01', unverifiedIdentity: true });
    expect(updates).toEqual([]);
    expect(out).toMatchObject({ id: 'c1', name: 'Ana', email: null, emails: [], birthday: null });
  });

  it('cadastro com e-mail ganha o digitado no fim da lista, sem trocar o principal', async () => {
    const { db, updates } = fakeDb(stored({ email: 'ana@ex.com', emails: ['ana@ex.com'] }));
    await resolveOrCreateCustomer(db as never, { ...base, email: 'X@ex.com', birthday: '1990-01-01', unverifiedIdentity: true });
    expect(updates).toEqual([{ emails: ['ana@ex.com', 'x@ex.com'] }]);
  });

  it('sem a flag (WhatsApp, recepção) o comportamento de sempre continua', async () => {
    const { db, updates } = fakeDb(stored());
    await resolveOrCreateCustomer(db as never, { ...base, email: 'x@ex.com', birthday: '1990-01-01' });
    expect(updates).toEqual([{ emails: ['x@ex.com'], birthday: '1990-01-01' }]);
  });
});
