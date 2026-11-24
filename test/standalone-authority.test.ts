// The standalone server keeps no answer from the bank between calls. This file is the proof of the rule it reads
// under (src/enablebanking/bank.ts, at the top of the class): the moment any answer from Enable Banking says a consent
// is over, or that an account has left it, nothing is read or returned under it, until it is seen in order again,
// also for a call that was already waiting for the bank. Every way the server can learn it has a test here, and every
// test goes through the tools as a client calls them. Made-up data only.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { EnableBankingConfig } from '../src/enablebanking/config.js';
import { createServer } from '../src/server.js';
import { IBAN, fakeApi, linkConsent, makeBank } from './helpers.js';

const DRIFT = 'uid-aaa-drift';
const SKAT = 'uid-aaa-skat';
const BOTH = [
  { uid: DRIFT, account_id: { iban: IBAN.aaaDrift }, name: 'Drift', currency: 'DKK' },
  { uid: SKAT, account_id: { iban: IBAN.aaaSkat }, name: 'Skat', currency: 'EUR' },
];
const CONSENT = 'dk-danske-bank-business';
const PERIOD = { from: '2026-09-01', to: '2026-09-30' };
/** The balance the bank answers at first. Every test changes it afterwards: an answer that still shows it is an old one. */
const OLD = '1234.50';
const NEW = '9999.25';

const respond = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const authorized = (uids: string[] = [DRIFT, SKAT], validUntil = '2099-01-01T00:00:00Z') => ({ status: 'AUTHORIZED', accounts: uids, access: { valid_until: validUntil } });

/** Enable Banking and the bank behind it, as this test steers them. */
function world() {
  const state = {
    /** What Enable Banking answers for the session. */
    session: (): unknown => authorized(),
    /** Failures by `${uid}/${kind}` or by kind alone: answered instead of data. */
    failing: new Map<string, () => unknown>(),
    balance: OLD,
    /** The account each uid is, as the bank describes it. */
    details: new Map<string, unknown>(BOTH.map(account => [account.uid, account])),
  };
  const api = fakeApi({
    'GET /sessions/[^/]+': () => state.session(),
    'GET /accounts/[^/]+/(balances|details|transactions)(/[^/]+)?': call => {
      const [, , uid, kind, one] = call.path.split('?')[0]!.split('/');
      const failure = state.failing.get(`${uid}/${kind}`) ?? state.failing.get(kind!);
      if (failure) return failure();
      if (kind === 'balances') return { balances: [{ balance_type: 'CLBD', balance_amount: { amount: state.balance, currency: 'DKK' }, reference_date: '2026-10-01' }] };
      if (kind === 'details') return state.details.get(uid!);
      const line = {
        entry_reference: 'line-1',
        transaction_id: 'details-1',
        credit_debit_indicator: 'DBIT',
        transaction_amount: { amount: state.balance, currency: 'DKK' },
        booking_date: '2026-09-10',
        status: 'BOOK',
        creditor: { name: 'Made-up Supplies' },
        remittance_information: ['Husleje'],
      };
      return one ? line : { transactions: [line] };
    },
  });
  return { state, api };
}

async function open(options: { now?: () => number } = {}) {
  const { state, api } = world();
  api.setSessionAccounts(BOTH);
  const { bank } = makeBank({ ...options, api });
  await bank.completeConsent({ user: 'anna@example.com', redirectUrl: (await linkConsent(bank, api)).redirect });
  const server = createServer({ bank, config: { consentEnabled: true, consentAdmins: [] } as unknown as EnableBankingConfig, actingAs: 'anna@example.com' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);

  /** One tool call as a client makes it: the text it gets back, and whether it is an error. */
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: `enablebanking_${name}`, arguments: args });
    const text = (result.content as Array<{ text: string }>).map(part => part.text).join('\n');
    return { failed: result.isError === true, text, code: /\nerrorCode: (\w+)/.exec(text)?.[1] };
  };
  /** Requests for bank data so far, of one kind or all. */
  const reads = (kind?: string) => api.calls.filter(call => call.path.startsWith('/accounts/') && (!kind || call.path.split('?')[0]!.split('/')[3] === kind)).length;
  return { state, api, bank, tool, reads };
}

type World = Awaited<ReturnType<typeof open>>;

/** A balance read once per account, and then a bank that answers something else: an answer with OLD is an old one. */
async function withBalancesRead(w: World, accounts = ['drift', 'skat']) {
  for (const account of accounts) {
    const first = await w.tool('get_balances', { account });
    expect(first.failed, first.text).toBe(false);
    expect(first.text).toContain(OLD);
  }
  expect(w.reads('balances')).toBe(accounts.length);
  w.state.balance = NEW;
}

/** A bank that holds the answer for one kind of read until `release`; `atTheBank` resolves when it has been asked. */
function slowAt(w: World, key: string, answer: () => unknown) {
  let release: () => void = () => undefined;
  const waiting = new Promise<void>(resolve => {
    release = resolve;
  });
  let arrived: () => void = () => undefined;
  const atTheBank = new Promise<void>(resolve => {
    arrived = resolve;
  });
  w.state.failing.set(key, async () => {
    arrived();
    await waiting;
    return answer();
  });
  return { release, atTheBank };
}

const oldBalance = () => ({ balances: [{ balance_type: 'CLBD', balance_amount: { amount: OLD, currency: 'DKK' }, reference_date: '2026-10-01' }] });

/** Every tool that reads an account answers with the refusal, shows nothing of the bank, and asks nobody. */
async function expectRefused(w: World, account: string, code: string) {
  const before = w.reads();
  for (const [name, args] of [
    ['get_balances', { account }],
    ['get_account_details', { account }],
    ['list_transactions', { account, ...PERIOD }],
    ['summarize_transactions', { account, ...PERIOD }],
    ['get_transaction_details', { account, transaction: 'details-1' }],
  ] as Array<[string, Record<string, unknown>]>) {
    const answer = await w.tool(name, args);
    expect(answer.failed, `${name}: ${answer.text}`).toBe(true);
    expect(answer.code, name).toBe(code);
    expect(answer.text, name).not.toContain(OLD);
    expect(answer.text, name).not.toContain(NEW);
    expect(answer.text, name).not.toContain('Husleje');
  }
  const search = await w.tool('search_transactions', { search: 'husleje', accounts: [account], ...PERIOD });
  expect(JSON.parse(search.text)).toMatchObject({ complete: false, count: 0, accounts: [{ account, read: false, problem: code }] });
  expect(w.reads(), 'nothing is asked of the bank for a withdrawn consent').toBe(before);
}

describe('standalone: the consent status tool', () => {
  it('refuses every read once Enable Banking answers that the session is revoked', async () => {
    const w = await open();
    await withBalancesRead(w);

    w.state.session = () => respond({ error: 'REVOKED_SESSION', message: 'made-up vendor text' }, 401);
    const status = await w.tool('get_consent_status');
    expect(JSON.parse(status.text).consents[0]).toMatchObject({ consent: CONSENT, status: null, problem: 'consent_revoked' });

    await expectRefused(w, 'drift', 'consent_revoked');
    await expectRefused(w, 'skat', 'consent_revoked');
    expect(w.reads('balances')).toBe(2);
    const listed = JSON.parse((await w.tool('list_accounts')).text);
    expect(listed.accounts.map((account: { status: string }) => account.status)).toEqual(['consent_ended', 'consent_ended']);
  });

  it.each([
    ['EXPIRED_SESSION', 401, 'consent_expired'],
    ['CLOSED_SESSION', 401, 'consent_revoked'],
    ['SESSION_DOES_NOT_EXIST', 404, 'consent_not_active'],
    ['WRONG_SESSION_STATUS', 422, 'consent_not_active'],
  ])('does the same for an error answer %s', async (error, status, code) => {
    const w = await open();
    await withBalancesRead(w);
    w.state.session = () => respond({ error }, status);
    await w.tool('get_consent_status');
    await expectRefused(w, 'drift', code);
  });

  it.each([
    ['REVOKED', 'consent_revoked'],
    ['CLOSED', 'consent_revoked'],
    ['CANCELLED', 'consent_revoked'],
    ['EXPIRED', 'consent_expired'],
    ['INVALID', 'consent_not_active'],
    ['PENDING_AUTHORIZATION', 'consent_not_active'],
    ['RETURNED_FROM_BANK', 'consent_not_active'],
    [undefined, 'consent_not_active'],
    [7, 'consent_not_active'],
  ])('does the same for an ordinary answer with status %s', async (status, code) => {
    const w = await open();
    await withBalancesRead(w);
    w.state.session = () => ({ ...authorized(), status });
    const answer = JSON.parse((await w.tool('get_consent_status')).text);
    expect(answer.consents[0].status).toBe(typeof status === 'string' ? status : null);
    await expectRefused(w, 'drift', code);
    await expectRefused(w, 'skat', code);
    expect(w.reads('balances')).toBe(2);
  });

  it('does the same for a session that is authorised but past its date', async () => {
    const w = await open();
    await withBalancesRead(w);
    w.state.session = () => authorized([DRIFT, SKAT], '2020-01-01T00:00:00Z');
    await w.tool('get_consent_status');
    await expectRefused(w, 'drift', 'consent_expired');
  });

  it('refuses an account that has left the session, and only that one', async () => {
    const w = await open();
    await withBalancesRead(w);

    w.state.session = () => authorized([SKAT]);
    const status = JSON.parse((await w.tool('get_consent_status')).text);
    expect(status.consents[0]).toMatchObject({ status: 'AUTHORIZED', noLongerCovered: ['drift'] });

    await expectRefused(w, 'drift', 'account_not_in_consent');
    // The other account stands as before: the bank is asked anew.
    const other = await w.tool('get_balances', { account: 'skat' });
    expect(other.failed).toBe(false);
    expect(other.text).toContain(NEW);
    expect(w.reads('balances')).toBe(3);
    const listed = JSON.parse((await w.tool('list_accounts')).text);
    expect(listed.accounts.map((account: { id: string; status: string }) => [account.id, account.status])).toEqual([
      ['drift', 'consent_ended'],
      ['skat', 'linked'],
    ]);
    // A search over both reads the one and says why not the other.
    const search = JSON.parse((await w.tool('search_transactions', { search: 'husleje', ...PERIOD })).text);
    expect(search.accounts).toMatchObject([
      { account: 'drift', read: false, problem: 'account_not_in_consent' },
      { account: 'skat', read: true },
    ]);
  });

  it('takes a session answer without a list of accounts to cover none', async () => {
    const w = await open();
    await withBalancesRead(w);
    w.state.session = () => ({ status: 'AUTHORIZED', access: { valid_until: '2099-01-01T00:00:00Z' } });
    await w.tool('get_consent_status');
    await expectRefused(w, 'drift', 'account_not_in_consent');
    await expectRefused(w, 'skat', 'account_not_in_consent');
  });

  it('lets the consent be read again once Enable Banking shows it in order, and then asks the bank anew', async () => {
    const w = await open();
    await withBalancesRead(w);
    w.state.session = () => ({ ...authorized([SKAT]), status: 'REVOKED' });
    await w.tool('get_consent_status');
    await expectRefused(w, 'skat', 'consent_revoked');

    // In order again at Enable Banking, but nobody has asked yet: still refused here.
    w.state.session = () => authorized([SKAT]);
    await expectRefused(w, 'skat', 'consent_revoked');

    await w.tool('get_consent_status');
    const again = await w.tool('get_balances', { account: 'skat' });
    expect(again.failed, again.text).toBe(false);
    expect(again.text).toContain(NEW);
    expect(again.text).not.toContain(OLD);
    expect(w.reads('balances')).toBe(3);
    // The account that is still missing stays refused, and comes back when it is listed again.
    await expectRefused(w, 'drift', 'account_not_in_consent');
    w.state.session = () => authorized();
    await w.tool('get_consent_status');
    expect((await w.tool('get_balances', { account: 'drift' })).text).toContain(NEW);
  });

  it('leaves everything as it is when the status cannot be read for another reason', async () => {
    const w = await open();
    await withBalancesRead(w);
    w.state.session = () => respond({ error: 'ASPSP_ERROR' }, 500);
    const status = JSON.parse((await w.tool('get_consent_status')).text);
    expect(status.consents[0]).toMatchObject({ problem: 'bank_unavailable' });
    // Nothing was learned about the consent: the account is read as before, at the bank.
    expect((await w.tool('get_balances', { account: 'drift' })).text).toContain(NEW);
    expect(w.reads('balances')).toBe(3);
  });
});

describe('standalone: a read that fails', () => {
  const READS: Array<[string, Record<string, unknown>, string]> = [
    ['get_balances', { account: 'skat' }, 'balances'],
    ['get_account_details', { account: 'skat' }, 'details'],
    ['list_transactions', { account: 'skat', ...PERIOD }, 'transactions'],
    ['summarize_transactions', { account: 'skat', ...PERIOD }, 'transactions'],
    ['get_transaction_details', { account: 'skat', transaction: 'details-1' }, 'transactions'],
    ['search_transactions', { search: 'husleje', accounts: ['skat'], ...PERIOD }, 'transactions'],
  ];

  it.each(READS)('with an ended consent, from %s, withdraws the whole consent', async (name, args, kind) => {
    const w = await open();
    await withBalancesRead(w, ['drift']);
    w.state.failing.set(`${SKAT}/${kind}`, () => respond({ error: 'REVOKED_SESSION' }, 401));
    const failed = await w.tool(name, args);
    if (name === 'search_transactions') expect(JSON.parse(failed.text).accounts[0]).toMatchObject({ read: false, problem: 'consent_revoked' });
    else expect(failed.code).toBe('consent_revoked');

    // The bank would answer the other account, but the consent it was read under is over.
    w.state.failing.clear();
    await expectRefused(w, 'drift', 'consent_revoked');
  });

  it.each([
    ['EXPIRED_SESSION', 'consent_expired'],
    ['CLOSED_SESSION', 'consent_revoked'],
    ['SESSION_DOES_NOT_EXIST', 'consent_not_active'],
    ['WRONG_SESSION_STATUS', 'consent_not_active'],
  ])('withdraws the consent for %s', async (error, code) => {
    const w = await open();
    await withBalancesRead(w, ['drift']);
    w.state.failing.set(`${SKAT}/details`, () => respond({ error }, 401));
    expect((await w.tool('get_account_details', { account: 'skat' })).code).toBe(code);
    w.state.failing.clear();
    await expectRefused(w, 'drift', code);
  });

  it('with an account the session does not have, withdraws that account and nothing else', async () => {
    const w = await open();
    await withBalancesRead(w);
    w.state.failing.set(`${DRIFT}/transactions`, () => respond({ error: 'ACCOUNT_DOES_NOT_EXIST' }, 404));
    expect((await w.tool('list_transactions', { account: 'drift', ...PERIOD })).code).toBe('account_not_in_consent');
    w.state.failing.clear();

    await expectRefused(w, 'drift', 'account_not_in_consent');
    const other = await w.tool('get_balances', { account: 'skat' });
    expect(other.text).toContain(NEW);
    expect(w.reads('balances')).toBe(3);
  });

  it('with an account the bank refuses, leaves read access as it is and asks the bank again next time', async () => {
    const w = await open();
    await withBalancesRead(w);
    w.state.failing.set(`${DRIFT}/transactions`, () => respond({ error: 'ASPSP_ACCOUNT_NOT_ACCESSIBLE' }, 403));
    expect((await w.tool('list_transactions', { account: 'drift', ...PERIOD })).code).toBe('account_not_accessible');

    const asked = await w.tool('get_balances', { account: 'drift' });
    expect(asked.text).toContain(NEW);
    expect(asked.text).not.toContain(OLD);
    expect((await w.tool('get_balances', { account: 'skat' })).text).toContain(NEW);
    expect(w.reads('balances')).toBe(4);
  });

  it.each([
    ['UNAUTHORIZED_ACCESS', 403, 'application_refused'],
    ['NO_ACCOUNTS_ADDED', 403, 'application_restricted'],
    [undefined, 401, 'access_refused'],
    [undefined, 403, 'access_refused'],
  ])('with the application refused (%s, %i), asks the bank again next time', async (error, status, code) => {
    const w = await open();
    await withBalancesRead(w);
    w.state.failing.set(`${DRIFT}/transactions`, () => respond(error ? { error } : {}, status));
    expect((await w.tool('list_transactions', { account: 'drift', ...PERIOD })).code).toBe(code);

    for (const account of ['drift', 'skat']) {
      const asked = await w.tool('get_balances', { account });
      expect(asked.text, account).toContain(NEW);
      expect(asked.text, account).not.toContain(OLD);
    }
    expect(w.reads('balances')).toBe(4);
  });

  it.each([
    ['ASPSP_ERROR', 500, 'bank_unavailable'],
    ['ASPSP_RATE_LIMIT_EXCEEDED', 429, 'rate_limited'],
    ['WRONG_TRANSACTIONS_PERIOD', 422, 'period_not_available'],
  ])('for a reason that says nothing of the consent (%s), leaves read access as it is', async (error, status, code) => {
    const w = await open();
    await withBalancesRead(w);
    w.state.failing.set(`${DRIFT}/transactions`, () => respond({ error }, status));
    expect((await w.tool('list_transactions', { account: 'drift', ...PERIOD })).code).toBe(code);
    expect((await w.tool('get_balances', { account: 'drift' })).text).toContain(NEW);
    expect(w.reads('balances')).toBe(3);
  });

  it('with another account behind the same id, withdraws that account', async () => {
    const w = await open();
    await withBalancesRead(w);
    w.state.details.set(DRIFT, { uid: DRIFT, account_id: { iban: IBAN.stray }, name: 'Made-up other account', currency: 'DKK' });
    const details = await w.tool('get_account_details', { account: 'drift' });
    expect(details.code).toBe('account_not_connected');
    expect(details.text).not.toContain('Made-up other account');

    await expectRefused(w, 'drift', 'account_not_connected');
    expect((await w.tool('get_balances', { account: 'skat' })).text).toContain(NEW);
  });

  it('does not return an answer that arrives after the consent was withdrawn', async () => {
    const w = await open();
    // The bank is slow to answer the balance ...
    const bank = slowAt(w, `${DRIFT}/balances`, oldBalance);
    const slow = w.tool('get_balances', { account: 'drift' });
    await bank.atTheBank;
    // ... and meanwhile the status tool learns that the consent is revoked.
    w.state.session = () => ({ ...authorized(), status: 'REVOKED' });
    await w.tool('get_consent_status');
    bank.release();
    const answer = await slow;
    expect(answer.failed).toBe(true);
    expect(answer.code).toBe('consent_revoked');
    expect(answer.text).not.toContain(OLD);
    // Once the consent is in order again, the bank is asked anew.
    w.state.failing.clear();
    w.state.balance = NEW;
    await expectRefused(w, 'drift', 'consent_revoked');
    w.state.session = () => authorized();
    await w.tool('get_consent_status');
    const anew = await w.tool('get_balances', { account: 'drift' });
    expect(anew.text).toContain(NEW);
    expect(anew.text).not.toContain(OLD);
  });
});

describe('standalone: calls side by side', () => {
  it('does not return a slow balance once the consent was revoked here meanwhile', async () => {
    const w = await open();
    const bank = slowAt(w, `${DRIFT}/balances`, oldBalance);
    const slow = w.tool('get_balances', { account: 'drift' });
    await bank.atTheBank;
    expect((await w.tool('revoke_consent', { consent: CONSENT })).failed).toBe(false);
    bank.release();
    const answer = await slow;
    expect(answer.failed, answer.text).toBe(true);
    expect(answer.code).toBe('no_consent');
    expect(answer.text).not.toContain(OLD);
    // Nothing of it stays behind: no consent covers the account, and the bank is not asked.
    w.state.failing.clear();
    const before = w.reads();
    const again = await w.tool('get_balances', { account: 'drift' });
    expect(again.code).toBe('no_consent');
    expect(w.reads()).toBe(before);
  });

  it.each([
    ['get_balances', { account: 'drift' }, 'balances'],
    ['list_transactions', { account: 'drift', ...PERIOD }, 'transactions'],
    ['get_transaction_details', { account: 'drift', transaction: 'details-1' }, 'transactions'],
  ] as Array<[string, Record<string, unknown>, string]>)(
    'does not return a slow %s once a refresh has taken the account out of the consent',
    async (name, args, kind) => {
      const w = await open();
      const bank = slowAt(w, `${DRIFT}/${kind}`, () =>
        kind === 'balances' ? oldBalance() : { transactions: [{ entry_reference: 'line-1', transaction_amount: { amount: OLD, currency: 'DKK' }, remittance_information: ['Husleje'] }] },
      );
      const slow = w.tool(name, args);
      await bank.atTheBank;
      w.state.session = () => authorized([SKAT]);
      const refreshed = await w.tool('refresh_consent', { consent: CONSENT });
      expect(refreshed.failed, refreshed.text).toBe(false);
      bank.release();
      const answer = await slow;
      expect(answer.failed, answer.text).toBe(true);
      expect(answer.code).toBe('no_consent');
      expect(answer.text).not.toContain(OLD);
      expect(answer.text).not.toContain('Husleje');
    },
  );

  it('does not return a slow balance when a refresh rebinds the account under another id meanwhile', async () => {
    const w = await open();
    const bank = slowAt(w, `${DRIFT}/balances`, oldBalance);
    const slow = w.tool('get_balances', { account: 'drift' });
    await bank.atTheBank;
    // Enable Banking now lists the same account under a new id.
    w.state.details.set('uid-aaa-drift-2', { uid: 'uid-aaa-drift-2', account_id: { iban: IBAN.aaaDrift }, name: 'Drift', currency: 'DKK' });
    w.state.session = () => authorized(['uid-aaa-drift-2', SKAT]);
    expect((await w.tool('refresh_consent', { consent: CONSENT })).failed).toBe(false);
    bank.release();
    const answer = await slow;
    expect(answer.failed, answer.text).toBe(true);
    expect(answer.code).toBe('consent_not_active');
    expect(answer.text).not.toContain(OLD);
  });

  it('a refresh that read the consent in order does not restore it after a status answer said it is revoked', async () => {
    const w = await open();
    // The refresh reads AUTHORIZED, then waits for the bank's account details ...
    const bank = slowAt(w, `${DRIFT}/details`, () => BOTH[0]);
    const refreshing = w.tool('refresh_consent', { consent: CONSENT });
    await bank.atTheBank;
    // ... while the status tool learns that the consent is revoked.
    w.state.session = () => ({ ...authorized(), status: 'REVOKED' });
    await w.tool('get_consent_status');
    bank.release();
    const refreshed = await refreshing;
    expect(refreshed.failed, refreshed.text).toBe(true);
    expect(refreshed.code).toBe('consent_revoked');
    // Access stays withdrawn: nothing is read, and the list says so.
    w.state.failing.clear();
    await expectRefused(w, 'drift', 'consent_revoked');
    await expectRefused(w, 'skat', 'consent_revoked');
    const listed = JSON.parse((await w.tool('list_accounts')).text);
    expect(listed.accounts.map((account: { status: string }) => account.status)).toEqual(['consent_ended', 'consent_ended']);
  });

  it('a status answer in order that was on its way does not lift a withdrawal learned meanwhile', async () => {
    const w = await open();
    let release: () => void = () => undefined;
    const waiting = new Promise<void>(resolve => {
      release = resolve;
    });
    let arrived: () => void = () => undefined;
    const atEnableBanking = new Promise<void>(resolve => {
      arrived = resolve;
    });
    // Enable Banking is slow to say the consent is in order ...
    w.state.session = async () => {
      arrived();
      await waiting;
      return authorized();
    };
    const status = w.tool('get_consent_status');
    await atEnableBanking;
    // ... and meanwhile a read learns that it is revoked.
    w.state.failing.set(`${DRIFT}/balances`, () => respond({ error: 'REVOKED_SESSION' }, 401));
    expect((await w.tool('get_balances', { account: 'drift' })).code).toBe('consent_revoked');
    release();
    await status;
    w.state.failing.clear();
    await expectRefused(w, 'drift', 'consent_revoked');
    // A status answer asked after the withdrawal does lift it.
    w.state.session = () => authorized();
    await w.tool('get_consent_status');
    expect((await w.tool('get_balances', { account: 'drift' })).failed).toBe(false);
  });

  it('a slow read that began before the consent was refreshed in order is still returned', async () => {
    const w = await open();
    const bank = slowAt(w, `${DRIFT}/balances`, oldBalance);
    const slow = w.tool('get_balances', { account: 'drift' });
    await bank.atTheBank;
    expect((await w.tool('refresh_consent', { consent: CONSENT })).failed).toBe(false);
    bank.release();
    const answer = await slow;
    expect(answer.failed, answer.text).toBe(false);
    expect(answer.text).toContain(OLD);
  });
});

describe('standalone: the consent tools', () => {
  it('refresh binds nothing to a consent Enable Banking no longer honours, and withdraws it', async () => {
    const w = await open();
    await withBalancesRead(w);
    w.state.session = () => ({ ...authorized(), status: 'REVOKED' });
    const refreshed = await w.tool('refresh_consent', { consent: CONSENT });
    expect(refreshed.failed).toBe(true);
    expect(refreshed.code).toBe('consent_revoked');
    await expectRefused(w, 'drift', 'consent_revoked');
  });

  it('refresh that fails with an ended consent withdraws it', async () => {
    const w = await open();
    await withBalancesRead(w);
    w.state.session = () => respond({ error: 'EXPIRED_SESSION' }, 401);
    expect((await w.tool('refresh_consent', { consent: CONSENT })).code).toBe('consent_expired');
    await expectRefused(w, 'skat', 'consent_expired');

    // The same when it is the read of an account, in the middle of the refresh, that says so.
    const second = await open();
    await withBalancesRead(second);
    second.state.failing.set('details', () => respond({ error: 'REVOKED_SESSION' }, 401));
    expect((await second.tool('refresh_consent', { consent: CONSENT })).code).toBe('consent_revoked');
    second.state.failing.clear();
    await expectRefused(second, 'drift', 'consent_revoked');
  });

  it('refresh: an account that has left is not readable, the rest is read anew', async () => {
    const w = await open();
    await withBalancesRead(w);
    w.state.session = () => authorized([SKAT]);
    const refreshed = await w.tool('refresh_consent', { consent: CONSENT });
    expect(refreshed.failed, refreshed.text).toBe(false);

    const gone = await w.tool('get_balances', { account: 'drift' });
    expect(gone.code).toBe('no_consent');
    expect(gone.text).not.toContain(OLD);
    const anew = await w.tool('get_balances', { account: 'skat' });
    expect(anew.text).toContain(NEW);
    expect(anew.text).not.toContain(OLD);
  });

  it('refresh of a consent in order lifts what was held against it', async () => {
    const w = await open();
    await withBalancesRead(w);
    w.state.session = () => authorized([SKAT]);
    await w.tool('get_consent_status');
    await expectRefused(w, 'drift', 'account_not_in_consent');

    w.state.session = () => authorized();
    expect((await w.tool('refresh_consent', { consent: CONSENT })).failed).toBe(false);
    const anew = await w.tool('get_balances', { account: 'drift' });
    expect(anew.failed, anew.text).toBe(false);
    expect(anew.text).toContain(NEW);
  });

  it('revoke removes read access', async () => {
    const w = await open();
    await withBalancesRead(w);
    expect((await w.tool('revoke_consent', { consent: CONSENT })).failed).toBe(false);
    const before = w.reads();
    for (const account of ['drift', 'skat']) {
      const answer = await w.tool('get_balances', { account });
      expect(answer.code).toBe('no_consent');
      expect(answer.text).not.toContain(OLD);
    }
    expect(w.reads()).toBe(before);
  });

  it('a new consent starts without what was held against the old one', async () => {
    const w = await open();
    await withBalancesRead(w);
    w.state.session = () => ({ ...authorized(), status: 'REVOKED' });
    await w.tool('get_consent_status');
    await expectRefused(w, 'drift', 'consent_revoked');

    // The administrator signs in at the bank again. The bank gives the accounts the same ids as before.
    w.state.session = () => authorized();
    await w.bank.completeConsent({ user: 'anna@example.com', redirectUrl: (await linkConsent(w.bank, w.api)).redirect });
    const anew = await w.tool('get_balances', { account: 'drift' });
    expect(anew.failed, anew.text).toBe(false);
    expect(anew.text).toContain(NEW);
    expect(anew.text).not.toContain(OLD);
  });

  it('asks the bank on every call: nothing is kept between calls', async () => {
    const w = await open();
    await w.tool('get_balances', { account: 'drift' });
    await w.tool('get_balances', { account: 'drift' });
    expect(w.reads('balances')).toBe(2);
    w.state.session = () => ({ ...authorized(), status: 'EXPIRED' });
    await w.tool('get_consent_status');
    w.state.balance = NEW;
    await expectRefused(w, 'drift', 'consent_expired');
  });
});
