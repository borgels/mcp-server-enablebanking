// The gateway returns an answer only when nothing was learned against its consent or its accounts while the call
// ran, checked after the call's last await: a session ended through endSession, a consent another call learned is
// over, an account another call learned has left the consent. Each data tool is held at its read at the bank while
// that happens. Made-up data only.
import { describe, expect, it } from 'vitest';
import { createEnableBankingGateway, type GatewayCallContext, type GatewayToolResult } from '../src/gateway.js';
import { WITHDRAWN_MEANWHILE } from '../src/gateway/tools.js';
import { KEY } from './helpers.js';

const PEM = KEY.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const NOW = Date.parse('2026-11-24T10:00:00Z');
const SESSION = '77777777-aaaa-4aaa-8aaa-777777777777';
const ACCOUNT_A = 'a1a1a1a1-0000-4000-8000-00000000a001';
const ACCOUNT_B = 'b2b2b2b2-0000-4000-8000-00000000b002';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A fake Enable Banking whose reads of one account can be held until let go, and that can fail reads. */
function bank() {
  let sessionAccounts = [ACCOUNT_A, ACCOUNT_B];
  let sessionStatus = 'AUTHORIZED';
  let validUntil = '2027-05-01T00:00:00Z';
  let sessionFailure: string | undefined;
  const failing = new Map<string, string>();
  let holding: string | undefined;
  let reached: (() => void) | undefined;
  let letGo: (() => void) | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (/^\/sessions\/[^/]+$/.test(url.pathname)) {
      if ((init?.method ?? 'GET') === 'DELETE') return json({});
      if (sessionFailure) return json({ error: sessionFailure }, 401);
      return json({ status: sessionStatus, accounts: sessionAccounts, access: { valid_until: validUntil } });
    }
    const match = /^\/accounts\/([^/]+)\/(details|balances|transactions)(?:\/[^/]+)?$/.exec(url.pathname);
    if (!match) return json({ error: 'NOT_FOUND' }, 404);
    const [, account, kind] = match as unknown as [string, string, string];
    const failure = failing.get(account);
    if (failure) return json({ error: failure }, failure === 'REVOKED_SESSION' ? 401 : 404);
    if (holding === account) {
      holding = undefined;
      await new Promise<void>(resolve => {
        letGo = resolve;
        reached?.();
      });
    }
    const who = account === ACCOUNT_A ? 'Alpha' : 'Beta';
    const line = {
      entry_reference: `${who}-1`,
      transaction_id: `id-${who}-1`,
      transaction_amount: { currency: 'EUR', amount: '10.00' },
      credit_debit_indicator: 'DBIT',
      status: 'BOOK',
      booking_date: '2026-11-10',
      creditor: { name: `${who} Supplies` },
    };
    if (kind === 'details') return json({ name: `${who} holder`, currency: 'EUR', product: 'Account' });
    if (kind === 'balances') return json({ balances: [{ balance_type: 'ITAV', balance_amount: { currency: 'EUR', amount: '5.00' } }] });
    if (url.pathname.endsWith('/transactions')) return json({ transactions: [line] });
    return json(line);
  };
  return {
    fetchImpl,
    /** Holds the next read of the account; resolves once it is held. */
    hold(account: string): Promise<void> {
      holding = account;
      return new Promise<void>(resolve => {
        reached = resolve;
      });
    },
    letGo: () => letGo?.(),
    fail: (account: string, error: string) => failing.set(account, error),
    setSessionAccounts: (accounts: string[]) => {
      sessionAccounts = accounts;
    },
    setSession: (status: string, until = validUntil) => {
      sessionStatus = status;
      validUntil = until;
    },
    failSession: (error: string) => {
      sessionFailure = error;
    },
  };
}

const gateway = (fetchImpl: typeof fetch, now: () => number = () => NOW) =>
  createEnableBankingGateway({ applicationId: 'app-0000-test', privateKey: PEM, apiBaseUrl: 'https://eb.test', fetchImpl, now });
const context: GatewayCallContext = { credentials: { sessionId: SESSION, accountIds: [ACCOUNT_A, ACCOUNT_B] } };

/** Every gateway tool, each reading account A (list_accounts and a search read both, A first). */
const TOOLS: Array<[string, Record<string, unknown>]> = [
  ['list_accounts', {}],
  ['get_balances', { account: ACCOUNT_A }],
  ['get_account_details', { account: ACCOUNT_A }],
  ['list_transactions', { account: ACCOUNT_A }],
  ['get_transaction_details', { account: ACCOUNT_A, transaction: 'id-Alpha-1' }],
  ['summarize_transactions', { account: ACCOUNT_A }],
  ['search_transactions', { query: 'supplies' }],
];

const refused = (result: GatewayToolResult) => {
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toBe(WITHDRAWN_MEANWHILE);
  expect(result.errorCode).toBe('consent_not_active');
  expect(JSON.stringify(result)).not.toMatch(/Alpha|Beta|5\.00|10\.00/);
};

describe('a gateway answer, checked after the call’s last await', () => {
  it.each(TOOLS)('%s answers as usual when nothing is learned while it reads', async (tool, input) => {
    const fake = bank();
    const gw = gateway(fake.fetchImpl);
    const held = fake.hold(ACCOUNT_A);
    const call = gw.callTool(tool, input as never, context);
    await held;
    fake.letGo();
    const result = await call;
    expect(result.isError, result.content[0]!.text).toBeUndefined();
  });

  it.each(TOOLS)('%s returns nothing when the session is ended through endSession while the bank is read', async (tool, input) => {
    const fake = bank();
    const gw = gateway(fake.fetchImpl);
    const held = fake.hold(ACCOUNT_A);
    const call = gw.callTool(tool, input as never, context);
    await held;
    expect(await gw.endSession({ sessionId: SESSION })).toEqual({ alreadyEnded: false });
    fake.letGo();
    refused(await call);
  });

  it.each(TOOLS)('%s returns nothing when another call learns that the consent is over while the bank is read', async (tool, input) => {
    const fake = bank();
    const gw = gateway(fake.fetchImpl);
    const held = fake.hold(ACCOUNT_A);
    const call = gw.callTool(tool, input as never, context);
    await held;
    // Another call, beside this one, is told by the bank that the consent was revoked.
    fake.fail(ACCOUNT_B, 'REVOKED_SESSION');
    const other = await gw.callTool('get_balances', { account: ACCOUNT_B }, context);
    expect(other.errorCode).toBe('consent_revoked');
    fake.letGo();
    const result = await call;
    // A call that goes on to read account B is told so by the bank itself; the others are refused here.
    if (result.errorCode === 'consent_revoked') expect(JSON.stringify(result)).not.toMatch(/Alpha|Beta|5\.00|10\.00/);
    else refused(result);
  });

  it.each(TOOLS)('%s returns nothing when another call learns that its account has left the consent', async (tool, input) => {
    const fake = bank();
    const gw = gateway(fake.fetchImpl);
    const held = fake.hold(ACCOUNT_A);
    const call = gw.callTool(tool, input as never, context);
    await held;
    // Enable Banking no longer lists account A in the session: another call learns it when it starts.
    fake.setSessionAccounts([ACCOUNT_B]);
    const other = await gw.callTool('get_balances', { account: ACCOUNT_B }, context);
    expect(other.isError).toBeUndefined();
    fake.letGo();
    refused(await call);
  });

  it('keeps an answer from another account when only one account left the consent', async () => {
    const fake = bank();
    const gw = gateway(fake.fetchImpl);
    const held = fake.hold(ACCOUNT_B);
    const call = gw.callTool('get_balances', { account: ACCOUNT_B }, context);
    await held;
    fake.setSessionAccounts([ACCOUNT_B]);
    await gw.callTool('get_balances', { account: ACCOUNT_B }, context);
    fake.letGo();
    expect((await call).isError).toBeUndefined();
  });

  it('keeps what the other accounts of a search gave when the search itself finds one account gone', async () => {
    const fake = bank();
    fake.fail(ACCOUNT_B, 'ACCOUNT_DOES_NOT_EXIST');
    const result = await gateway(fake.fetchImpl).callTool('search_transactions', { query: 'supplies' }, context);
    expect(result.isError).toBeUndefined();
    const found = result.structuredContent as { accounts: Array<{ account: string; read: boolean }>; transactions: Array<{ account: string }> };
    expect(found.accounts).toMatchObject([
      { account: ACCOUNT_A, read: true },
      { account: ACCOUNT_B, read: false },
    ]);
    expect(found.transactions.map(line => line.account)).toEqual([ACCOUNT_A]);
  });

  it.each([
    ['REVOKED', (fake: ReturnType<typeof bank>) => fake.setSession('REVOKED')],
    ['EXPIRED', (fake: ReturnType<typeof bank>) => fake.setSession('EXPIRED')],
    ['CLOSED', (fake: ReturnType<typeof bank>) => fake.setSession('CLOSED')],
    ['an unknown status', (fake: ReturnType<typeof bank>) => fake.setSession('SOMETHING_NEW')],
    ['a validity date that has passed', (fake: ReturnType<typeof bank>) => fake.setSession('AUTHORIZED', '2026-11-24T09:00:00Z')],
    ['REVOKED_SESSION as an error', (fake: ReturnType<typeof bank>) => fake.failSession('REVOKED_SESSION')],
    ['EXPIRED_SESSION as an error', (fake: ReturnType<typeof bank>) => fake.failSession('EXPIRED_SESSION')],
    ['the session no longer listing the account', (fake: ReturnType<typeof bank>) => fake.setSessionAccounts([ACCOUNT_B])],
  ])('returns nothing when sessionStatus learns %s while the bank is read', async (_, change) => {
    for (const [tool, input] of TOOLS) {
      const fake = bank();
      const gw = gateway(fake.fetchImpl);
      const held = fake.hold(ACCOUNT_A);
      const call = gw.callTool(tool, input as never, context);
      await held;
      change(fake);
      // The host's renewal reminder asks for the session's status while the read is held.
      await gw.sessionStatus({ sessionId: SESSION }).catch(() => undefined);
      fake.letGo();
      const result = await call;
      if (tool === 'search_transactions' || tool === 'list_accounts') {
        // A call that goes on to account B may be told by the bank itself; nothing of either account comes back.
        expect(result.isError, tool).toBe(true);
        expect(JSON.stringify(result), tool).not.toMatch(/Alpha|Beta|5\.00|10\.00/);
      } else {
        refused(result);
      }
    }
  });

  it('keeps an answer when sessionStatus finds the session in order', async () => {
    const fake = bank();
    const gw = gateway(fake.fetchImpl);
    const held = fake.hold(ACCOUNT_A);
    const call = gw.callTool('get_balances', { account: ACCOUNT_A }, context);
    await held;
    expect((await gw.sessionStatus({ sessionId: SESSION })).status).toBe('AUTHORIZED');
    fake.letGo();
    expect((await call).isError).toBeUndefined();
  });

  it.each(TOOLS)('%s returns nothing when the consent runs out while the bank is read (checked against the clock at return)', async (tool, input) => {
    const fake = bank();
    // Authorised, and valid for one more second when the call starts.
    fake.setSession('AUTHORIZED', new Date(NOW + 1_000).toISOString());
    let clock = NOW;
    const gw = gateway(fake.fetchImpl, () => clock);
    const held = fake.hold(ACCOUNT_A);
    const call = gw.callTool(tool, input as never, context);
    await held;
    clock = NOW + 2_000;
    fake.letGo();
    refused(await call);
  });

  it('keeps an answer returned before the consent runs out', async () => {
    const fake = bank();
    fake.setSession('AUTHORIZED', new Date(NOW + 1_000).toISOString());
    let clock = NOW;
    const gw = gateway(fake.fetchImpl, () => clock);
    const held = fake.hold(ACCOUNT_A);
    const call = gw.callTool('get_balances', { account: ACCOUNT_A }, context);
    await held;
    clock = NOW + 999;
    fake.letGo();
    expect((await call).isError).toBeUndefined();
  });

  it('reads nothing back under a session ended here, even while Enable Banking still says it is authorised', async () => {
    const fake = bank();
    const gw = gateway(fake.fetchImpl);
    await gw.endSession({ sessionId: SESSION });
    refused(await gw.callTool('get_balances', { account: ACCOUNT_A }, context));
  });
});
