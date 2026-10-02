import { createVerify } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/enablebanking/store.js';
import { IBAN, KEY, MASTER_KEY, REGISTRY, fakeApi, linkConsent, makeBank } from './helpers.js';

describe('consent binding', () => {
  it('binds only the accounts registered to the pinned company', async () => {
    const { bank, api } = makeBank();
    const { redirect, started } = await linkConsent(bank, api);
    expect(started.validDays).toBe(180); // capped at the bank's maximum
    const report = await bank.completeConsent({ user: 'ANNA@example.com', redirectUrl: redirect });

    expect(report.bound.map(a => a.id)).toEqual(['drift']);
    expect(report.otherCompany).toHaveLength(1);
    expect(report.otherCompany[0]).not.toContain(IBAN.bbbDrift);
    expect(report.unregistered.map(a => a.iban)).toEqual([IBAN.stray]);
    expect(report.registeredButNotInConsent.map(a => a.id)).toEqual(['skat']);

    expect(bank.linked('drift').uid).toBe('uid-aaa-drift');
    expect(() => bank.linked(IBAN.bbbDrift)).toThrow(/does not belong/);
    expect(() => bank.linked('skat')).toThrow(/no bank consent covers it/);
  });

  it('never stores the uids of accounts it may not read', async () => {
    const { bank, api, dataDir } = makeBank();
    const { redirect } = await linkConsent(bank, api);
    await bank.completeConsent({ user: 'anna@example.com', redirectUrl: redirect });
    const file = readdirSync(dataDir).find(name => name.startsWith('sessions-aaa'))!;
    const raw = readFileSync(join(dataDir, file), 'utf8');
    expect(raw).not.toContain('uid-');
    expect(raw).not.toContain(IBAN.aaaDrift); // encrypted at rest
    const sessions = new SessionStore('aaa', dataDir, MASTER_KEY).sessions();
    expect(sessions[0]!.accounts.map(a => a.uid)).toEqual(['uid-aaa-drift']);
    expect(JSON.stringify(sessions)).not.toContain('uid-bbb');
    expect(JSON.stringify(sessions)).not.toContain(IBAN.stray);
  });

  it('revokes a consent that contains nothing of this company', async () => {
    const api = fakeApi();
    api.setSessionAccounts([{ uid: 'uid-bbb-drift', account_id: { iban: IBAN.bbbDrift }, name: 'Beta', currency: 'DKK' }]);
    const { bank } = makeBank({ api });
    const { redirect } = await linkConsent(bank, api);
    const report = await bank.completeConsent({ user: 'anna@example.com', redirectUrl: redirect });
    expect(report.bound).toEqual([]);
    expect(api.deleted).toEqual(['s1']);
    expect(bank.listAccounts().consents).toEqual([]);
  });

  it('refuses a redirect started on another company, by another user, twice, or too late', async () => {
    const api = fakeApi();
    const bbb = makeBank({ company: 'bbb', api });
    const { redirect } = await linkConsent(bbb.bank, api);
    const aaa = makeBank({ api, dataDir: bbb.dataDir });
    // Same master key and data dir, different company: the store namespace and AAD differ.
    await expect(aaa.bank.completeConsent({ user: 'anna@example.com', redirectUrl: redirect })).rejects.toThrow(/for another company/);

    await expect(bbb.bank.completeConsent({ user: 'bo@example.com', redirectUrl: redirect })).rejects.toThrow(/another user/);
    await bbb.bank.completeConsent({ user: 'anna@example.com', redirectUrl: redirect });
    await expect(bbb.bank.completeConsent({ user: 'anna@example.com', redirectUrl: redirect })).rejects.toThrow(/already completed/);

    let now = Date.now();
    const late = makeBank({ api, company: 'bbb', now: () => now });
    const second = await linkConsent(late.bank, api);
    now += 31 * 60_000;
    await expect(late.bank.completeConsent({ user: 'anna@example.com', redirectUrl: second.redirect })).rejects.toThrow(/older than 30 minutes/);
  });

  it('rejects a forged state and passes bank errors through', async () => {
    const { bank } = makeBank();
    await expect(bank.completeConsent({ user: 'a', redirectUrl: 'https://x.test/?code=1&state=e30.AAAA' })).rejects.toThrow(/not issued by this server/);
    await expect(bank.completeConsent({ user: 'a', redirectUrl: 'https://x.test/?error=access_denied' })).rejects.toThrow(/access_denied/);
  });

  it('replaces and revokes the previous consent at the same bank', async () => {
    const { bank, api } = makeBank();
    await bank.completeConsent({ user: 'anna@example.com', redirectUrl: (await linkConsent(bank, api)).redirect });
    await bank.completeConsent({ user: 'anna@example.com', redirectUrl: (await linkConsent(bank, api)).redirect });
    expect(api.deleted).toEqual(['s1']);
    expect(bank.listAccounts().consents.map(c => c.consent)).toEqual(['dk-danske-bank-business']);
  });

  it('re-binds against the registry as it is now', async () => {
    const api = fakeApi();
    const first = makeBank({ api });
    await first.bank.completeConsent({ user: 'anna@example.com', redirectUrl: (await linkConsent(first.bank, api)).redirect });
    const registry = structuredClone(REGISTRY);
    registry.companies.aaa.accounts.push({ iban: IBAN.stray, id: 'opsparing', name: 'Opsparing', bank: 'Danske Bank' } as never);
    const later = makeBank({ api, registry, dataDir: first.dataDir });
    const report = await later.bank.refreshConsent('dk-danske-bank-business');
    expect(report.bound.map(a => a.id).sort()).toEqual(['drift', 'opsparing']);
    expect(later.bank.linked('opsparing').uid).toBe('uid-stray');
  });

  it('a registry edit revokes access without touching the consent', async () => {
    const api = fakeApi();
    const first = makeBank({ api });
    await first.bank.completeConsent({ user: 'anna@example.com', redirectUrl: (await linkConsent(first.bank, api)).redirect });
    const registry = structuredClone(REGISTRY);
    registry.companies.aaa.accounts = registry.companies.aaa.accounts.filter(a => a.id !== 'drift');
    const later = makeBank({ api, registry, dataDir: first.dataDir });
    expect(() => later.bank.linked(IBAN.aaaDrift)).toThrow(/unknown account/);
  });
});

describe('reads', () => {
  async function linked(options: Parameters<typeof makeBank>[0] = {}) {
    const made = makeBank(options);
    await made.bank.completeConsent({ user: 'anna@example.com', redirectUrl: (await linkConsent(made.bank, made.api)).redirect });
    return made;
  }

  it('lists transactions across pages with exact totals and filters', async () => {
    const { bank, api } = await linked();
    const result = await bank.transactions('drift', { from: '2026-09-01', to: '2026-09-30' });
    expect(result.transactions.map(t => t.reference)).toEqual(['t3', 't2', 't1']);
    expect(result.transactions[1]).toMatchObject({ amount: '-49.95', direction: 'out', counterparty: 'Software Inc' });
    expect(result.totals).toEqual([{ currency: 'DKK', count: 3, in: '100.00', out: '-299.95', net: '-199.95' }]);
    const txCalls = api.calls.filter(c => c.path.includes('/transactions'));
    expect(txCalls).toHaveLength(2);
    expect(txCalls[0]!.path).toContain('/accounts/uid-aaa-drift/');

    const filtered = await bank.transactions('drift', { from: '2026-09-01', to: '2026-09-30', search: 'husleje', direction: 'out' });
    expect(filtered.transactions.map(t => t.reference)).toEqual(['t1']);
    // Served from cache: no new bank calls.
    expect(api.calls.filter(c => c.path.includes('/transactions'))).toHaveLength(2);
  });

  it('reads balances and refuses details for a uid that turned into another IBAN', async () => {
    const { bank, api } = await linked({ cacheSeconds: 0 });
    expect((await bank.balances('drift')).balances[0]).toMatchObject({ amount: '1234.50', currency: 'DKK' });
    api.setSessionAccounts([{ uid: 'uid-aaa-drift', account_id: { iban: IBAN.bbbDrift }, name: 'x', currency: 'DKK' }]);
    await expect(bank.details('drift')).rejects.toThrow(/different account/);
  });

  it('reports an expired consent instead of calling the bank', async () => {
    let now = Date.now();
    const { bank, api } = await linked({ now: () => now });
    now = Date.parse('2099-01-02T00:00:00Z');
    const before = api.calls.length;
    expect(() => bank.linked('drift')).toThrow(/expired on 2099-01-01/);
    expect(api.calls.length).toBe(before);
    expect(bank.listAccounts().accounts[0]!.status).toBe('consent_expired');
  });

  it('turns a refused consent into a renewal hint', async () => {
    const api = fakeApi({
      'GET /accounts/[^/]+/balances': () => new Response(JSON.stringify({ error: 'EXPIRED_SESSION', message: 'Session expired' }), { status: 401 }),
    });
    const { bank } = await linked({ api });
    await expect(bank.balances('drift')).rejects.toThrow(/renew it with enablebanking_start_consent/);
  });
});

describe('client', () => {
  it('signs RS256 JWTs with the application id as kid', async () => {
    const api = fakeApi();
    const { bank } = makeBank({ api });
    await bank.listBanks('dk');
    const token = api.calls[0]!.authorization!.replace('Bearer ', '');
    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'RS256', kid: 'app-1' });
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toMatchObject({ iss: 'enablebanking.com', aud: 'api.enablebanking.com' });
    const ok = createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(KEY.publicKey, Buffer.from(signature!, 'base64url'));
    expect(ok).toBe(true);
  });
});

describe('store', () => {
  it('refuses to open another company’s store file', async () => {
    const api = fakeApi();
    const aaa = makeBank({ api });
    await aaa.bank.completeConsent({ user: 'anna@example.com', redirectUrl: (await linkConsent(aaa.bank, api)).redirect });
    const file = readdirSync(aaa.dataDir).find(name => name.startsWith('sessions-aaa'))!;
    const { copyFileSync } = await import('node:fs');
    copyFileSync(join(aaa.dataDir, file), join(aaa.dataDir, 'sessions-bbb.enc.json'));
    expect(() => new SessionStore('bbb', aaa.dataDir, MASTER_KEY).sessions()).toThrow(/cannot be decrypted for company bbb/);
  });
});
