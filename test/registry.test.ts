import { describe, expect, it } from 'vitest';
import { AccountRegistry, isValidIban, maskIban, normalizeIban } from '../src/enablebanking/registry.js';
import { IBAN, REGISTRY } from './helpers.js';

describe('account registry', () => {
  it('validates IBAN checksums', () => {
    expect(isValidIban('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(isValidIban(IBAN.aaaDrift)).toBe(true);
    expect(isValidIban(IBAN.aaaDrift.replace(/\d$/, d => String((Number(d) + 1) % 10)))).toBe(false);
  });

  it('refuses an IBAN listed under two companies', () => {
    const raw = structuredClone(REGISTRY);
    raw.companies.bbb.accounts.push({ iban: IBAN.aaaDrift, id: 'x', name: 'Dobbelt', bank: 'Danske Bank' });
    expect(() => new AccountRegistry(raw)).toThrow(/listed under both aaa and bbb/);
  });

  it('refuses an invalid IBAN and a bad company code', () => {
    expect(() => new AccountRegistry({ companies: { aaa: { name: 'B', cvr: '12345678', accounts: [{ iban: 'DK0000000000000000', name: 'x' }] } } })).toThrow(/checksum/);
    expect(() => new AccountRegistry({ companies: { BOS1: { name: 'B', cvr: '12345678', accounts: [] } } })).toThrow(/three lowercase/);
  });

  it('resolves ids and IBANs only within the company', () => {
    const registry = new AccountRegistry(REGISTRY);
    expect(registry.resolve('aaa', 'drift').iban).toBe(IBAN.aaaDrift);
    const spaced = IBAN.aaaSkat.replace(/(.{4})/g, '$1 ').toLowerCase();
    expect(registry.resolve('aaa', spaced).id).toBe('skat');
    expect(() => registry.resolve('aaa', IBAN.bbbDrift)).toThrow(/does not belong to Alfa Drift ApS/);
    expect(() => registry.resolve('aaa', IBAN.bbbDrift)).not.toThrow(/Beta/);
    expect(() => registry.resolve('aaa', IBAN.stray)).toThrow(/unknown account/);
    expect(registry.accountOf('bbb', IBAN.aaaDrift)).toBeUndefined();
  });

  it('masks and normalizes', () => {
    expect(normalizeIban('dk50 0040-0440')).toBe('DK5000400440');
    expect(maskIban(IBAN.aaaDrift)).toMatch(/^DK\d\d….{4}$/);
  });
});
