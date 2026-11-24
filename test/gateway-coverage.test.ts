// The embedded gateway's account information coverage: who is present, the budget for reads nobody is present
// for, fixed error codes, the tools added in 0.7.0 and the consent helpers. Made-up data only.
import { describe, expect, it, vi } from 'vitest';
import {
  createEnableBankingGateway,
  EnableBankingGatewayError,
  enableBankingProblemCodes,
  enableBankingPsuHeaders,
  resolveEnableBankingReadTarget,
  type EnableBankingGatewayOptions,
  type GatewayCallContext,
  type GatewayToolResult,
} from '../src/gateway.js';
import { dkIban, KEY } from './helpers.js';

const PEM = KEY.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const ORIGIN = 'https://eb.test';
const NOW = Date.parse('2026-11-24T10:00:00Z');
const HOUR = 3_600_000;

const SESSION = '44444444-dddd-4ddd-8ddd-444444444444';
const OTHER_SESSION = '55555555-eeee-4eee-8eee-555555555555';
const ACCOUNT_1 = 'd1d1d1d1-0000-4000-8000-00000000d001';
const ACCOUNT_2 = 'd2d2d2d2-0000-4000-8000-00000000d002';
const FOREIGN = 'e1e1e1e1-0000-4000-8000-00000000e001';

interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body?: unknown;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const row = (reference: string, amount: string, indicator: 'CRDT' | 'DBIT', party: string, day: string, extra: Record<string, unknown> = {}) => ({
  entry_reference: reference,
  transaction_id: `id-${reference}`,
  transaction_amount: { currency: 'EUR', amount },
  credit_debit_indicator: indicator,
  status: 'BOOK',
  booking_date: day,
  ...(indicator === 'DBIT' ? { creditor: { name: party } } : { debtor: { name: party } }),
  remittance_information: [`Invoice ${reference}`],
  ...extra,
});

const LINES: Record<string, unknown[]> = {
  [ACCOUNT_1]: [
    row('A-1', '100.00', 'DBIT', 'Made-up Supplies Ltd', '2026-11-03'),
    row('A-2', '40.00', 'DBIT', 'Made-up Supplies Ltd', '2026-11-10'),
    row('A-3', '500.00', 'CRDT', 'Invented Customer GmbH', '2026-11-05'),
  ],
  [ACCOUNT_2]: [row('B-1', '75.50', 'DBIT', 'Made-up Supplies Ltd', '2026-11-07'), row('B-2', '9.99', 'DBIT', 'Fictional Software Inc', '2026-11-08')],
};

function api(handle: (call: Call) => Response | undefined = () => undefined) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? 'GET', url, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const custom = handle(call);
    if (custom) return custom;
    if (/^\/sessions\/[^/]+$/.test(url.pathname) && call.method === 'GET') {
      return json({
        status: 'AUTHORIZED',
        accounts: [ACCOUNT_1, ACCOUNT_2],
        access: { valid_until: '2027-05-01T00:00:00Z', balances: true, transactions: true },
        aspsp: { name: 'Invented Bank', country: 'SE' },
        psu_type: 'business',
        created: '2026-11-01T08:00:00Z',
        authorized: '2026-11-01T08:05:00Z',
      });
    }
    const account = /^\/accounts\/([^/]+)\/(details|balances|transactions)$/.exec(url.pathname);
    if (account?.[2] === 'details') {
      return json({ name: 'Invented Trading AB', product: 'Business account', currency: 'EUR', account_id: { iban: dkIban('54700001234567') }, usage: 'ORGA' });
    }
    if (account?.[2] === 'balances') {
      return json({ balances: [{ balance_type: 'ITAV', balance_amount: { currency: 'EUR', amount: '1234.56' }, reference_date: '2026-11-24' }] });
    }
    if (account?.[2] === 'transactions') return json({ transactions: LINES[account[1]!] ?? [], continuation_key: null });
    if (/^\/accounts\/[^/]+\/transactions\/[^/]+$/.test(url.pathname)) {
      return json(row('A-1', '100.00', 'DBIT', 'Made-up Supplies Ltd', '2026-11-03', { note: 'More from the bank' }));
    }
    return json({ error: 'NOT_FOUND' }, 404);
  });
  return { calls, fetchImpl, bankReads: () => calls.filter(call => call.url.pathname.startsWith('/accounts/')) };
}

function gateway(fetchImpl: typeof fetch, extra: Partial<EnableBankingGatewayOptions> = {}) {
  return createEnableBankingGateway({ applicationId: 'app-0000-test', privateKey: PEM, apiBaseUrl: ORIGIN, fetchImpl, now: () => NOW, ...extra });
}

const ctx: GatewayCallContext = { credentials: { sessionId: SESSION, accountIds: [ACCOUNT_1, ACCOUNT_2] } };
const PERSON = { ipAddress: '192.0.2.10', userAgent: 'ExampleBrowser/1.0' };
const text = (result: GatewayToolResult) => result.content.map(part => part.text).join('\n');
const data = <T>(result: GatewayToolResult) => result.structuredContent as T;

describe('who is present', () => {
  it('sends the person’s details as Psu headers on reads at the bank, and never on the session check', async () => {
    const { calls, fetchImpl } = api();
    const result = await gateway(fetchImpl).callTool('get_balances', { account: ACCOUNT_1 }, { ...ctx, psu: { ...PERSON, acceptLanguage: 'sv-SE' } });
    expect(result.isError).toBeUndefined();
    const [session, balances] = calls;
    expect(session!.url.pathname).toBe(`/sessions/${SESSION}`);
    expect([...session!.headers.keys()].some(name => name.startsWith('psu-'))).toBe(false);
    expect(balances!.headers.get('Psu-Ip-Address')).toBe('192.0.2.10');
    expect(balances!.headers.get('Psu-User-Agent')).toBe('ExampleBrowser/1.0');
    expect(balances!.headers.get('Psu-Accept-Language')).toBe('sv-SE');
    expect(balances!.headers.get('Authorization')).toMatch(/^Bearer /);
    expect(enableBankingPsuHeaders.ipAddress).toBe('Psu-Ip-Address');
  });

  it('sends no Psu header when nobody is present or nothing is said, and invents none', async () => {
    for (const context of [ctx, { ...ctx, unattended: true }, { ...ctx, unattended: false }]) {
      const { calls, fetchImpl } = api();
      await gateway(fetchImpl).callTool('list_transactions', { account: ACCOUNT_1 }, context);
      for (const call of calls) expect([...call.headers.keys()].filter(name => name.startsWith('psu-'))).toEqual([]);
    }
  });

  it('refuses a malformed or contradictory statement before any request, instead of reading in the background', async () => {
    const { calls, fetchImpl } = api();
    const gw = gateway(fetchImpl);
    const bad: Array<Partial<GatewayCallContext>> = [
      { psu: {} },
      { psu: { ipAddress: 'not-an-ip' } },
      { psu: { userAgent: 'a\r\nX-Injected: 1' } },
      { psu: { authorization: 'Bearer x' } as never },
      { psu: 'yes' as never },
      { unattended: 'no' as never },
      { psu: PERSON, unattended: true },
    ];
    for (const extra of bad) {
      const result = await gw.callTool('get_balances', { account: ACCOUNT_1 }, { ...ctx, ...extra });
      expect(result.isError, JSON.stringify(extra)).toBe(true);
      expect(result.errorCode).toBe('presence_incomplete');
    }
    expect(calls).toHaveLength(0);
  });
});

describe('the budget for reads nobody is present for', () => {
  it('makes four unattended reads a day per consent, then refuses before anything reaches the bank', async () => {
    let clock = NOW;
    const { fetchImpl, bankReads } = api();
    const gw = gateway(fetchImpl, { now: () => clock });
    const unattended = { ...ctx, unattended: true };
    for (let i = 0; i < 4; i += 1) expect((await gw.callTool('get_balances', { account: ACCOUNT_1 }, unattended)).isError).toBeUndefined();
    expect(bankReads()).toHaveLength(4);

    const refused = await gw.callTool('get_balances', { account: ACCOUNT_2 }, unattended);
    expect(refused.isError).toBe(true);
    expect(refused.errorCode).toBe('unattended_limit');
    expect(text(refused)).toMatch(/^Not read: nobody is present, and only 4 automatic read\(s\) a day/);
    expect(text(refused)).toContain('2026-11-25 10:00 UTC');
    expect(bankReads()).toHaveLength(4);

    // A person who asks is not limited, and neither is another company's consent.
    expect((await gw.callTool('get_balances', { account: ACCOUNT_1 }, { ...ctx, psu: PERSON })).isError).toBeUndefined();
    const other = { credentials: { sessionId: OTHER_SESSION, accountIds: [ACCOUNT_1] }, unattended: true };
    expect((await gw.callTool('get_balances', { account: ACCOUNT_1 }, other)).isError).toBeUndefined();

    // A day later the budget is there again.
    clock += 24 * HOUR + 1;
    expect((await gw.callTool('get_balances', { account: ACCOUNT_1 }, unattended)).isError).toBeUndefined();
  });

  it('counts each account a call reads, and nothing for answers that need no read at the bank', async () => {
    const { fetchImpl, bankReads } = api();
    const gw = gateway(fetchImpl);
    const known = [
      { id: ACCOUNT_1, name: 'Operating account', maskedIban: 'SE12…3456', currency: 'EUR' },
      { id: ACCOUNT_2, name: 'Tax account', maskedIban: 'SE12…9876', currency: 'EUR' },
    ];
    const unattended: GatewayCallContext = { credentials: { ...ctx.credentials!, accounts: known }, unattended: true };
    // Listing the accounts from the consent costs nothing, however often.
    for (let i = 0; i < 6; i += 1) expect((await gw.callTool('list_accounts', {}, unattended)).isError).toBeUndefined();
    expect(bankReads()).toHaveLength(0);
    // A search over both accounts takes two.
    expect((await gw.callTool('search_transactions', { query: 'supplies' }, unattended)).isError).toBeUndefined();
    expect((await gw.callTool('search_transactions', { query: 'invoice' }, unattended)).isError).toBeUndefined();
    const third = await gw.callTool('search_transactions', { query: 'supplies' }, unattended);
    expect(third.errorCode).toBe('unattended_limit');
    expect(bankReads()).toHaveLength(4);
  });

  it('does not charge the next page of a listing a second time', async () => {
    let page = 0;
    const { fetchImpl } = api(call => (call.url.pathname.endsWith('/transactions') ? json({ transactions: [], continuation_key: `key-${++page}` }) : undefined));
    const gw = gateway(fetchImpl, { unattendedFetchesPerDay: 1 });
    const unattended = { ...ctx, unattended: true };
    const period = { account: ACCOUNT_1, from: '2026-11-01', to: '2026-11-10' };
    const first = await gw.callTool('list_transactions', period, unattended);
    const token = data<{ nextPageToken: string; hasMore: boolean }>(first);
    expect(token.hasMore).toBe(true);
    expect((await gw.callTool('list_transactions', { ...period, pageToken: token.nextPageToken }, unattended)).isError).toBeUndefined();
    expect((await gw.callTool('list_transactions', period, unattended)).errorCode).toBe('unattended_limit');
  });

  it('pauses unattended reads for six hours once the bank says its limit is reached', async () => {
    let clock = NOW;
    let limited = true;
    const { fetchImpl, bankReads } = api(call =>
      limited && call.url.pathname.endsWith('/balances') ? json({ error: 'ASPSP_RATE_LIMIT_EXCEEDED', message: 'made-up vendor text' }, 429) : undefined,
    );
    const gw = gateway(fetchImpl, { now: () => clock });
    const unattended = { ...ctx, unattended: true };
    const first = await gw.callTool('get_balances', { account: ACCOUNT_1 }, unattended);
    expect(first).toMatchObject({ isError: true, errorCode: 'rate_limited', retryAfterSeconds: 21_600, failure: { httpStatus: 429 } });
    expect(text(first)).toMatch(/HTTP 429 \(ASPSP_RATE_LIMIT_EXCEEDED\)\. .*six hours/);
    expect(text(first)).not.toContain('made-up vendor text');

    limited = false;
    const paused = await gw.callTool('get_balances', { account: ACCOUNT_1 }, unattended);
    expect(paused.errorCode).toBe('unattended_limit');
    expect(text(paused)).toContain('2026-11-24 16:00 UTC');
    expect(bankReads()).toHaveLength(1);
    // A person can still ask.
    expect((await gw.callTool('get_balances', { account: ACCOUNT_1 }, { ...ctx, psu: PERSON })).isError).toBeUndefined();
    clock += 6 * HOUR;
    expect((await gw.callTool('get_balances', { account: ACCOUNT_1 }, unattended)).isError).toBeUndefined();
  });

  it('can be turned off or changed by the host, within bounds', async () => {
    const { fetchImpl } = api();
    const off = gateway(fetchImpl, { unattendedFetchesPerDay: 0 });
    for (let i = 0; i < 8; i += 1) expect((await off.callTool('get_balances', { account: ACCOUNT_1 }, { ...ctx, unattended: true })).isError).toBeUndefined();
    expect(() => gateway(fetchImpl, { unattendedFetchesPerDay: -1 })).toThrow(/unattendedFetchesPerDay/);
    expect(() => gateway(fetchImpl, { unattendedFetchesPerDay: 2.5 })).toThrow(/unattendedFetchesPerDay/);
  });
});

describe('list_accounts', () => {
  it('answers from what the host stored with the consent, without a read at the bank', async () => {
    const { calls, fetchImpl } = api();
    const accounts = [
      { id: ACCOUNT_1, name: 'Operating account', maskedIban: 'SE12…3456', currency: 'EUR', product: 'Business account' },
      { id: ACCOUNT_2, name: 'Giro', maskedIban: null, currency: 'SEK', identification: { scheme: 'BGNR', masked: '…4567' } },
      // Not one of the company's accounts: ignored.
      { id: FOREIGN, name: 'Someone else', maskedIban: 'SE99…0000', currency: 'EUR' },
    ];
    const result = await gateway(fetchImpl).callTool('list_accounts', {}, { credentials: { ...ctx.credentials!, accounts } });
    expect(calls.map(call => call.url.pathname)).toEqual([`/sessions/${SESSION}`]);
    expect(result.structuredContent).toEqual({
      consentValidUntil: '2027-05-01T00:00:00.000Z',
      consent: {
        status: 'AUTHORIZED',
        validUntil: '2027-05-01T00:00:00.000Z',
        expiresInDays: 157,
        bank: { name: 'Invented Bank', country: 'SE' },
        psuType: 'business',
        authorizedAt: '2026-11-01T08:05:00.000Z',
      },
      source: 'consent',
      accounts: [
        { id: ACCOUNT_1, name: 'Operating account', maskedIban: 'SE12…3456', currency: 'EUR', product: 'Business account' },
        { id: ACCOUNT_2, name: 'Giro', maskedIban: null, currency: 'SEK', product: null, identification: { scheme: 'BGNR', masked: '…4567' } },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('Someone else');
  });

  it('reads only the accounts the host stored nothing about, and says where the answer came from', async () => {
    const { fetchImpl, bankReads } = api();
    const gw = gateway(fetchImpl);
    const mixed = await gw.callTool('list_accounts', {}, { credentials: { ...ctx.credentials!, accounts: [{ id: ACCOUNT_1, name: 'Operating account' }] } });
    expect(bankReads().map(call => call.url.pathname)).toEqual([`/accounts/${ACCOUNT_2}/details`]);
    expect(data<{ source: string; fetchedAt: string }>(mixed)).toMatchObject({ source: 'mixed', fetchedAt: '2026-11-24T10:00:00.000Z' });
    const fromBank = await gw.callTool('list_accounts', {}, ctx);
    expect(data<{ source: string; accounts: Array<{ maskedIban: string }> }>(fromBank).source).toBe('bank');
    expect(data<{ accounts: Array<{ maskedIban: string }> }>(fromBank).accounts[0]!.maskedIban).toMatch(/^DK\d\d…4567$/);
  });

  it('shows an account without an IBAN by its other number, masked', async () => {
    const { fetchImpl } = api(call =>
      call.url.pathname.endsWith('/details')
        ? json({ name: 'Bankgiro', currency: 'SEK', account_id: { other: { identification: '123-4567', scheme_name: 'BGNR' } } })
        : undefined,
    );
    const listed = data<{ accounts: Array<Record<string, unknown>> }>(await gateway(fetchImpl).callTool('list_accounts', {}, ctx));
    expect(listed.accounts[0]).toEqual({ id: ACCOUNT_1, name: 'Bankgiro', maskedIban: null, currency: 'SEK', product: null, identification: { scheme: 'BGNR', masked: '…4567' } });
    expect(JSON.stringify(listed)).not.toContain('123-4567');
  });
});

describe('fixed error codes', () => {
  it('tell an ended consent from a refused application, a rate limit and a bank that is down', async () => {
    const cases: Array<[number, string | undefined, string, number | undefined]> = [
      [401, 'EXPIRED_SESSION', 'consent_expired', undefined],
      [401, 'REVOKED_SESSION', 'consent_revoked', undefined],
      [401, 'CLOSED_SESSION', 'consent_revoked', undefined],
      [404, 'SESSION_DOES_NOT_EXIST', 'consent_not_active', undefined],
      [404, 'ACCOUNT_DOES_NOT_EXIST', 'account_not_in_consent', undefined],
      [400, 'ASPSP_ACCOUNT_NOT_ACCESSIBLE', 'account_not_accessible', undefined],
      [403, 'ACCESS_DENIED', 'application_refused', undefined],
      [401, 'UNAUTHORIZED_ACCESS', 'application_refused', undefined],
      [403, 'NO_ACCOUNTS_ADDED', 'application_restricted', undefined],
      [401, undefined, 'access_refused', undefined],
      [403, undefined, 'access_refused', undefined],
      [429, 'ASPSP_RATE_LIMIT_EXCEEDED', 'rate_limited', 21_600],
      [429, undefined, 'rate_limited', 21_600],
      [400, 'ASPSP_ERROR', 'bank_unavailable', undefined],
      [408, 'ASPSP_TIMEOUT', 'bank_unavailable', undefined],
      [503, undefined, 'bank_unavailable', undefined],
      [400, 'ASPSP_PSU_ACTION_REQUIRED', 'person_action_required', undefined],
      [422, 'WRONG_TRANSACTIONS_PERIOD', 'period_not_available', undefined],
      [422, 'PSU_HEADER_NOT_PROVIDED', 'presence_incomplete', undefined],
      [418, undefined, 'upstream_error', undefined],
    ];
    for (const [status, vendor, code, wait] of cases) {
      const { fetchImpl } = api(call => (call.url.pathname.endsWith('/balances') ? json(vendor ? { error: vendor, message: 'made-up vendor text' } : {}, status) : undefined));
      const result = await gateway(fetchImpl).callTool('get_balances', { account: ACCOUNT_1 }, ctx);
      expect(result.isError, `${status} ${vendor}`).toBe(true);
      expect(result.errorCode, `${status} ${vendor}`).toBe(code);
      expect(result.retryAfterSeconds, `${status} ${vendor}`).toBe(wait);
      expect(result.failure?.httpStatus).toBe(status);
      expect(enableBankingProblemCodes).toContain(result.errorCode);
      expect(text(result)).not.toContain('made-up vendor text');
    }
  });

  it('name the gateway’s own refusals too, and leave their fixed texts as they were', async () => {
    const { fetchImpl } = api(call => {
      if (call.url.pathname === `/sessions/${OTHER_SESSION}`) return json({ status: 'EXPIRED', accounts: [ACCOUNT_1], access: { valid_until: '2026-11-01T00:00:00Z' } });
      return undefined;
    });
    const gw = gateway(fetchImpl);
    const check = async (tool: string, input: Record<string, unknown>, context: GatewayCallContext | undefined, code: string, message: RegExp) => {
      const result = await gw.callTool(tool, input as never, context);
      expect(result.isError, tool).toBe(true);
      expect(result.errorCode, `${tool} ${JSON.stringify(input)}`).toBe(code);
      expect(text(result)).toMatch(message);
      expect(result.failure).toBeUndefined();
    };
    await check('get_balances', { account: ACCOUNT_1 }, undefined, 'no_consent', /^Refused: no Enable Banking consent was given with the call/);
    await check('get_balances', { account: FOREIGN }, ctx, 'account_not_connected', /^Refused: that account is not one of the accounts this company has connected\.$/);
    await check('get_balances', { account: FOREIGN }, { credentials: { sessionId: SESSION, accountIds: [FOREIGN] } }, 'account_not_in_consent', /^Refused: the bank consent no longer covers that account\. It must be connected again\.$/);
    await check('get_balances', { account: ACCOUNT_1 }, { credentials: { sessionId: OTHER_SESSION, accountIds: [ACCOUNT_1] } }, 'consent_expired', /^The bank consent is not active \(EXPIRED\)\. It must be renewed\.$/);
    await check('list_transactions', { account: ACCOUNT_1, from: '2026-11-10', to: '2026-11-01' }, ctx, 'invalid_period', /^from \(2026-11-10\) is after to \(2026-11-01\)\.$/);
    await check('list_transactions', { account: ACCOUNT_1, from: '2025-01-01', to: '2026-11-01' }, ctx, 'invalid_period', /366 days/);
    await check('list_transactions', { account: ACCOUNT_1, pageToken: 'A'.repeat(43) }, ctx, 'page_token_invalid', /^pageToken was not issued here/);
    await check('get_balances', { account: ACCOUNT_1, extra: 1 }, ctx, 'invalid_input', /^Unknown input field/);
    await check('make_a_payment', {}, ctx, 'invalid_input', /^Unsupported Enable Banking gateway tool\.$/);
  });

  it('are part of the read target a host resolves before a call', () => {
    expect(resolveEnableBankingReadTarget('list_transactions', { account: ACCOUNT_1, from: '2026-02-30' }, NOW)).toEqual({
      ok: false,
      reason: 'from must be a date, YYYY-MM-DD.',
      code: 'invalid_period',
    });
    expect(resolveEnableBankingReadTarget('get_balances', { account: 'x' }, NOW)).toMatchObject({ ok: false, code: 'account_not_connected' });
    expect(resolveEnableBankingReadTarget('get_account_details', { account: ACCOUNT_1 }, NOW)).toEqual({
      ok: true,
      target: { tool: 'get_account_details', exposure: 'balances', account: ACCOUNT_1 },
    });
    expect(resolveEnableBankingReadTarget('list_transactions', { account: ACCOUNT_1, strategy: 'longest', from: '2024-01-01' }, NOW)).toEqual({
      ok: true,
      target: { tool: 'list_transactions', exposure: 'transactions', account: ACCOUNT_1, from: '2024-01-01', status: 'booked', strategy: 'longest' },
    });
    expect(resolveEnableBankingReadTarget('search_transactions', { query: 'x', accounts: [ACCOUNT_1] }, NOW)).toEqual({
      ok: true,
      target: { tool: 'search_transactions', exposure: 'transactions', accounts: [ACCOUNT_1], from: '2026-10-26', to: '2026-11-24', status: 'booked' },
    });
  });
});

describe('account details and transaction details', () => {
  it('gives the bank’s description of an account', async () => {
    const { calls, fetchImpl } = api();
    const result = await gateway(fetchImpl).callTool('get_account_details', { account: ACCOUNT_1 }, ctx);
    expect(calls.map(call => call.url.pathname)).toEqual([`/sessions/${SESSION}`, `/accounts/${ACCOUNT_1}/details`]);
    expect(result.structuredContent).toMatchObject({
      account: ACCOUNT_1,
      fetchedAt: '2026-11-24T10:00:00.000Z',
      details: {
        holderName: 'Invented Trading AB',
        product: 'Business account',
        currency: 'EUR',
        multiCurrency: false,
        usage: { code: 'ORGA', meaning: 'professional account' },
        identifiers: [{ scheme: 'IBAN', identification: dkIban('54700001234567') }],
      },
    });
  });

  it('reads one transaction by the details id of a listing, as one fixed path segment', async () => {
    const { calls, fetchImpl } = api();
    const gw = gateway(fetchImpl);
    const listed = data<{ transactions: Array<{ detailsId: string }> }>(await gw.callTool('list_transactions', { account: ACCOUNT_1 }, ctx));
    expect(listed.transactions[0]!.detailsId).toBe('id-A-2');
    const result = await gw.callTool('get_transaction_details', { account: ACCOUNT_1, transaction: 'id:A=1+x@y' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(calls.at(-1)!.url.pathname).toBe(`/accounts/${ACCOUNT_1}/transactions/${encodeURIComponent('id:A=1+x@y')}`);
    expect(data<{ transaction: { note: string; counterparty: string } }>(result).transaction).toMatchObject({ note: 'More from the bank', counterparty: 'Made-up Supplies Ltd' });

    const before = calls.length;
    for (const transaction of ['..', '.', 'a/b', '../balances', 'a?b=1', 'a#b', 'a b', '', 'x'.repeat(257), 'ａ', 42]) {
      const refused = await gw.callTool('get_transaction_details', { account: ACCOUNT_1, transaction } as never, ctx);
      expect(refused.isError, String(transaction)).toBe(true);
      expect(refused.errorCode).toBe('invalid_input');
    }
    expect(calls.length).toBe(before);

    const missing = api(call => (/\/transactions\/[^/]+$/.test(call.url.pathname) ? json({ error: 'TRANSACTION_DOES_NOT_EXIST' }, 404) : undefined));
    expect((await gateway(missing.fetchImpl).callTool('get_transaction_details', { account: ACCOUNT_1, transaction: 'gone' }, ctx)).errorCode).toBe('transaction_not_found');
  });
});

describe('list_transactions', () => {
  it('reads as far back as the bank gives with strategy longest, and promises no end date', async () => {
    const { calls, fetchImpl } = api();
    const gw = gateway(fetchImpl);
    const result = await gw.callTool('list_transactions', { account: ACCOUNT_1, strategy: 'longest', from: '2020-01-01' }, ctx);
    const query = calls.at(-1)!.url.searchParams;
    expect(query.get('strategy')).toBe('longest');
    expect(query.get('date_from')).toBe('2020-01-01');
    expect(query.has('date_to')).toBe(false);
    expect(data<{ from: string; to: null; strategy: string; hasMore: boolean }>(result)).toMatchObject({ from: '2020-01-01', to: null, strategy: 'longest', hasMore: false });
    expect(text(result)).toMatch(/from 2020-01-01 to today/);

    await gw.callTool('list_transactions', { account: ACCOUNT_1, strategy: 'longest' }, ctx);
    expect(calls.at(-1)!.url.searchParams.has('date_from')).toBe(false);

    const refused = await gw.callTool('list_transactions', { account: ACCOUNT_1, strategy: 'longest', to: '2026-11-01' }, ctx);
    expect(refused).toMatchObject({ isError: true, errorCode: 'invalid_period' });
    expect((await gw.callTool('list_transactions', { account: ACCOUNT_1, strategy: 'all' }, ctx)).errorCode).toBe('invalid_input');
    // The default strategy sends none, and a bank that has no data for the period says so plainly.
    await gw.callTool('list_transactions', { account: ACCOUNT_1 }, ctx);
    expect(calls.at(-1)!.url.searchParams.has('strategy')).toBe(false);
    const unavailable = api(call => (call.url.pathname.endsWith('/transactions') ? json({ error: 'WRONG_TRANSACTIONS_PERIOD' }, 422) : undefined));
    const limited = await gateway(unavailable.fetchImpl).callTool('list_transactions', { account: ACCOUNT_1, from: '2026-01-01', to: '2026-03-01' }, ctx);
    expect(limited.errorCode).toBe('period_not_available');
    expect(text(limited)).toMatch(/90 days/);
  });

  it('keeps a page token to the strategy it was issued for', async () => {
    const { fetchImpl } = api(call => (call.url.pathname.endsWith('/transactions') ? json({ transactions: [], continuation_key: 'more' }) : undefined));
    const gw = gateway(fetchImpl);
    const input = { account: ACCOUNT_1, strategy: 'longest', from: '2026-01-01' };
    const token = data<{ nextPageToken: string }>(await gw.callTool('list_transactions', input, ctx)).nextPageToken;
    expect((await gw.callTool('list_transactions', { ...input, pageToken: token }, ctx)).isError).toBeUndefined();
    const other = await gw.callTool('list_transactions', { account: ACCOUNT_1, from: '2026-01-01', pageToken: token }, ctx);
    expect(other).toMatchObject({ isError: true, errorCode: 'page_token_invalid' });
  });

  it('follows an empty page that has a continuation key, with the same parameters on every page', async () => {
    const { calls, fetchImpl } = api(call => {
      if (!call.url.pathname.endsWith('/transactions')) return undefined;
      const key = call.url.searchParams.get('continuation_key');
      if (!key) return json({ transactions: [], continuation_key: 'second' });
      if (key === 'second') return json({ transactions: [row('P-1', '1.00', 'CRDT', 'A', '2026-11-02')], continuation_key: 'third' });
      return json({ transactions: [row('P-2', '2.00', 'CRDT', 'A', '2026-11-03')] });
    });
    const result = await gateway(fetchImpl).callTool('list_transactions', { account: ACCOUNT_1, from: '2026-11-01', to: '2026-11-10', status: 'all' }, ctx);
    expect(data<{ count: number; hasMore: boolean }>(result)).toMatchObject({ count: 2, hasMore: false });
    const pages = calls.filter(call => call.url.pathname.endsWith('/transactions')).map(call => Object.fromEntries(call.url.searchParams));
    expect(pages).toEqual([
      { date_from: '2026-11-01', date_to: '2026-11-10' },
      { date_from: '2026-11-01', date_to: '2026-11-10', continuation_key: 'second' },
      { date_from: '2026-11-01', date_to: '2026-11-10', continuation_key: 'third' },
    ]);
  });

  it('separates pending lines from booked ones, also when the bank ignores the status asked for', async () => {
    const mixed = [
      row('M-1', '1.00', 'DBIT', 'A', '2026-11-02'),
      row('M-2', '2.00', 'DBIT', 'A', '2026-11-03', { status: 'PDNG' }),
      row('M-3', '3.00', 'DBIT', 'A', '2026-11-04', { status: 'HOLD' }),
      row('M-4', '4.00', 'DBIT', 'A', '2026-11-05', { status: 'RJCT' }),
      row('M-5', '5.00', 'DBIT', 'A', '2026-11-06', { status: 'OTHR' }),
      row('M-6', '6.00', 'DBIT', 'A', '2026-11-07', { status: 'CNCL' }),
      row('M-7', '7.00', 'DBIT', 'A', '2026-11-08', { status: 'SCHD' }),
      row('M-8', '8.00', 'DBIT', 'A', '2026-11-09', { status: 'NOT-A-STATUS' }),
    ];
    const { calls, fetchImpl } = api(call => (call.url.pathname.endsWith('/transactions') ? json({ transactions: mixed }) : undefined));
    const gw = gateway(fetchImpl);
    const refs = async (status: string) =>
      data<{ transactions: Array<{ reference: string }> }>(await gw.callTool('list_transactions', { account: ACCOUNT_1, status }, ctx)).transactions.map(line => line.reference);
    expect(await refs('booked')).toEqual(['M-1']);
    expect(calls.at(-1)!.url.searchParams.get('transaction_status')).toBe('BOOK');
    // Pending is the bank's PDNG, HOLD and SCHD, and nothing else: not OTHR, not a status nobody knows.
    expect(await refs('pending')).toEqual(['M-7', 'M-3', 'M-2']);
    expect(calls.at(-1)!.url.searchParams.get('transaction_status')).toBe('PDNG');
    expect(await refs('all')).toEqual(['M-8', 'M-7', 'M-6', 'M-5', 'M-4', 'M-3', 'M-2', 'M-1']);
    expect(calls.at(-1)!.url.searchParams.has('transaction_status')).toBe(false);
  });
});

describe('derived tools', () => {
  it('summarises a period per counterparty from the bank lines and says so', async () => {
    const { fetchImpl } = api();
    const result = await gateway(fetchImpl).callTool('summarize_transactions', { account: ACCOUNT_1, from: '2026-11-01', to: '2026-11-20' }, ctx);
    expect(result.structuredContent).toEqual({
      account: ACCOUNT_1,
      from: '2026-11-01',
      to: '2026-11-20',
      status: 'booked',
      fetchedAt: '2026-11-24T10:00:00.000Z',
      derived: true,
      complete: true,
      lines: 3,
      totals: [{ currency: 'EUR', count: 3, in: '500.00', out: '-140.00', net: '360.00' }],
      counterparties: [
        { counterparty: 'Invented Customer GmbH', currency: 'EUR', count: 1, in: '500.00', out: '0.00', net: '500.00', firstDate: '2026-11-05', lastDate: '2026-11-05' },
        { counterparty: 'Made-up Supplies Ltd', currency: 'EUR', count: 2, in: '0.00', out: '-140.00', net: '-140.00', firstDate: '2026-11-03', lastDate: '2026-11-10' },
      ],
    });
    const top = await gateway(fetchImpl).callTool('summarize_transactions', { account: ACCOUNT_1, top: 1 }, ctx);
    expect(data<{ counterparties: unknown[]; counterpartiesNotShown: number }>(top)).toMatchObject({ counterpartiesNotShown: 1 });
    expect(data<{ counterparties: unknown[] }>(top).counterparties).toHaveLength(1);
  });

  it('says when a summary does not cover the whole period', async () => {
    let page = 0;
    const { calls, fetchImpl } = api(call =>
      call.url.pathname.endsWith('/transactions')
        ? json({ transactions: [row(`S-${++page}`, '1.00', 'DBIT', 'A', '2026-11-02')], continuation_key: `next-${page}` })
        : undefined,
    );
    const result = await gateway(fetchImpl).callTool('summarize_transactions', { account: ACCOUNT_1 }, ctx);
    expect(calls.filter(call => call.url.pathname.endsWith('/transactions'))).toHaveLength(20);
    expect(data<{ complete: boolean; lines: number }>(result)).toMatchObject({ complete: false, lines: 20 });
    expect(text(result)).toMatch(/the totals cover only these lines/);
  });

  it('searches every connected account and reports each account’s outcome', async () => {
    const { fetchImpl, bankReads } = api();
    const gw = gateway(fetchImpl);
    const result = await gw.callTool('search_transactions', { query: 'SUPPLIES', from: '2026-11-01', to: '2026-11-20' }, ctx);
    const found = data<{ complete: boolean; count: number; accounts: unknown[]; transactions: Array<{ account: string; reference: string }>; derived: boolean; totals: unknown[] }>(result);
    expect(found).toMatchObject({ derived: true, complete: true, count: 3 });
    expect(found.accounts).toEqual([
      { account: ACCOUNT_1, read: true, lines: 3, matches: 2, complete: true },
      { account: ACCOUNT_2, read: true, lines: 2, matches: 1, complete: true },
    ]);
    expect(found.transactions.map(line => `${line.account === ACCOUNT_1 ? 1 : 2}:${line.reference}`)).toEqual(['1:A-2', '2:B-1', '1:A-1']);
    expect(found.totals).toEqual([{ currency: 'EUR', count: 3, in: '0.00', out: '-215.50', net: '-215.50' }]);
    expect(bankReads()).toHaveLength(2);

    const byAmount = data<{ transactions: Array<{ reference: string }> }>(await gw.callTool('search_transactions', { minAmount: '75.5', maxAmount: '100', direction: 'out' }, ctx));
    expect(byAmount.transactions.map(line => line.reference)).toEqual(['B-1', 'A-1']);
    const limited = data<{ count: number; returned: number; truncated: boolean }>(await gw.callTool('search_transactions', { direction: 'out', limit: 1 }, ctx));
    expect(limited).toMatchObject({ count: 4, returned: 1, truncated: true });
    const one = data<{ accounts: unknown[] }>(await gw.callTool('search_transactions', { query: 'invoice', accounts: [ACCOUNT_2] }, ctx));
    expect(one.accounts).toHaveLength(1);
  });

  it('refuses a search with nothing to look for, or over an account that is not the company’s', async () => {
    const { calls, fetchImpl } = api();
    const gw = gateway(fetchImpl);
    expect((await gw.callTool('search_transactions', {}, ctx)).errorCode).toBe('invalid_input');
    expect((await gw.callTool('search_transactions', { query: '   ' }, ctx)).errorCode).toBe('invalid_input');
    expect((await gw.callTool('search_transactions', { query: 'x', minAmount: '1,50' }, ctx)).errorCode).toBe('invalid_input');
    expect((await gw.callTool('search_transactions', { query: 'x', strategy: 'longest' } as never, ctx)).errorCode).toBe('invalid_input');
    expect((await gw.callTool('search_transactions', { query: 'x', accounts: [ACCOUNT_1, FOREIGN] }, ctx)).errorCode).toBe('account_not_connected');
    expect((await gw.callTool('search_transactions', { query: 'x', accounts: [] }, ctx)).errorCode).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('still searches the other accounts when one cannot be read, and fails as a whole only when none can', async () => {
    const partly = api(call => (call.url.pathname === `/accounts/${ACCOUNT_1}/transactions` ? json({ error: 'ASPSP_ERROR' }, 400) : undefined));
    const result = await gateway(partly.fetchImpl).callTool('search_transactions', { query: 'supplies' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(data<{ complete: boolean; accounts: unknown[]; count: number }>(result)).toMatchObject({
      complete: false,
      count: 1,
      accounts: [
        { account: ACCOUNT_1, read: false, problem: 'bank_unavailable' },
        { account: ACCOUNT_2, read: true, lines: 2, matches: 1, complete: true },
      ],
    });

    const none = api(call => (call.url.pathname.endsWith('/transactions') ? json({ error: 'ASPSP_RATE_LIMIT_EXCEEDED' }, 429) : undefined));
    const failed = await gateway(none.fetchImpl).callTool('search_transactions', { query: 'supplies' }, ctx);
    expect(failed).toMatchObject({ isError: true, errorCode: 'rate_limited', retryAfterSeconds: 21_600 });
    // After the bank's rate limit the remaining accounts are not asked.
    expect(none.bankReads()).toHaveLength(1);
  });
});

describe('consent helpers', () => {
  const BANKS = {
    aspsps: [
      {
        name: 'Invented Bank',
        country: 'SE',
        bic: 'INVESESS',
        logo: 'https://cdn.example/invented.png',
        psu_types: ['business', 'personal'],
        maximum_consent_validity: 7_776_000,
        beta: true,
        group: { name: 'Invented Group', logo: 'https://cdn.example/group.png' },
        auth_methods: [
          { name: 'bankid', title: 'BankID', psu_type: 'personal', approach: 'DECOUPLED', hidden_method: false },
          {
            name: 'corporate',
            title: 'Corporate sign-in',
            psu_type: 'business',
            approach: 'REDIRECT',
            credentials: [{ name: 'userId', title: 'User ID', required: true, description: 'made-up', template: '^.*$' }],
          },
          { title: 'no name' },
        ],
        required_psu_headers: ['Psu-Ip-Address', 'Psu-User-Agent', 'X-Something-Else'],
        sandbox: { users: [{ username: 'sandbox-user', password: 'sandbox-password' }] },
        payments: [{ payment_type: 'SEPA' }],
      },
      { name: 'Fictional Savings', country: 'FI', psu_types: ['personal'], logo: 'http://cdn.example/plain.png' },
    ],
  };

  function consentApi(extra: (call: Call) => Response | undefined = () => undefined) {
    return api(call => {
      const custom = extra(call);
      if (custom) return custom;
      if (call.url.pathname === '/aspsps') return json(BANKS);
      if (call.url.pathname === '/auth') return json({ url: 'https://bank.example/authorize?x=1', authorization_id: 'auth-0001', psu_id_hash: 'x' });
      return undefined;
    });
  }

  it('lists what a host needs to offer a bank: customer types, sign-in methods, consent length, required headers', async () => {
    const { fetchImpl } = consentApi();
    const banks = await gateway(fetchImpl).listBanks();
    expect(banks[0]).toEqual({
      name: 'Invented Bank',
      country: 'SE',
      bic: 'INVESESS',
      psuTypes: ['business', 'personal'],
      maximumConsentDays: 90,
      maximumConsentSeconds: 7_776_000,
      beta: true,
      sandbox: true,
      group: 'Invented Group',
      logoUrl: 'https://cdn.example/invented.png',
      authMethods: [
        { name: 'bankid', title: 'BankID', psuType: 'personal', approach: 'DECOUPLED', hidden: false, credentials: [] },
        { name: 'corporate', title: 'Corporate sign-in', psuType: 'business', approach: 'REDIRECT', hidden: false, credentials: [{ name: 'userId', title: 'User ID', required: true }] },
      ],
      requiredPsuHeaders: ['Psu-Ip-Address', 'Psu-User-Agent'],
    });
    expect(banks[1]).toMatchObject({ name: 'Fictional Savings', country: 'FI', psuTypes: ['personal'], sandbox: false, logoUrl: null, authMethods: [] });
    // Sandbox test users and payment types of the raw answer are not passed on.
    expect(JSON.stringify(banks)).not.toMatch(/sandbox-user|sandbox-password|SEPA/);
  });

  it('starts a consent for a personal customer with a chosen sign-in method and chosen accounts', async () => {
    const { calls, fetchImpl } = consentApi();
    const gw = gateway(fetchImpl);
    const state = 'state-0123456789abcdef';
    const base = { bank: 'Invented Bank', country: 'se', redirectUrl: 'https://app.example/connect/bank', state };
    const selected = dkIban('54700001234567');
    const started = await gw.startAuthorization({
      ...base,
      psuType: 'personal',
      authMethod: 'bankid',
      accounts: [{ iban: selected.replace(/(.{4})/g, '$1 ').trim() }, { scheme: 'BGNR', identification: '123-4567' }],
      balances: true,
      transactions: true,
      extendedHistory: false,
      language: 'sv',
    });
    expect(started).toEqual({
      url: 'https://bank.example/authorize?x=1',
      validUntil: new Date(NOW + 7_776_000_000 - 300_000).toISOString(),
      maximumConsentDays: 90,
      authorizationId: 'auth-0001',
    });
    const listed = calls.find(call => call.url.pathname === '/aspsps')!;
    expect(Object.fromEntries(listed.url.searchParams)).toEqual({ country: 'SE', psu_type: 'personal', service: 'AIS' });
    expect(calls.find(call => call.url.pathname === '/auth')!.body).toEqual({
      access: {
        valid_until: started.validUntil,
        accounts: [{ iban: selected }, { other: { scheme_name: 'BGNR', identification: '123-4567' } }],
        balances: true,
        transactions: true,
        transactions_extended_history: false,
      },
      aspsp: { name: 'Invented Bank', country: 'SE' },
      state,
      redirect_url: 'https://app.example/connect/bank',
      psu_type: 'personal',
      auth_method: 'bankid',
      language: 'sv',
    });

    // A method the bank does not offer to that kind of customer, and malformed selections, are refused before /auth.
    const before = calls.filter(call => call.url.pathname === '/auth').length;
    await expect(gw.startAuthorization({ ...base, psuType: 'business', authMethod: 'bankid' })).rejects.toThrow(/offers no such authMethod/);
    await expect(gw.startAuthorization({ ...base, authMethod: 'made-up' })).rejects.toThrow(/offers no such authMethod/);
    await expect(gw.startAuthorization({ ...base, accounts: [] })).rejects.toThrow(/accounts must be/);
    await expect(gw.startAuthorization({ ...base, accounts: [{ iban: `DK${'0'.repeat(16)}` }] })).rejects.toThrow(/not a valid IBAN/);
    await expect(gw.startAuthorization({ ...base, accounts: [{ scheme: 'bgnr', identification: '1' }] })).rejects.toThrow(/accounts must be/);
    await expect(gw.startAuthorization({ ...base, accounts: [{ iban: selected, scheme: 'BGNR', identification: '1' } as never] })).rejects.toThrow(/accounts must be/);
    await expect(gw.startAuthorization({ ...base, extendedHistory: 'no' as never })).rejects.toThrow(/extendedHistory must be true or false/);
    // The bank's credentials are never carried: there is no field for them.
    await expect(gw.startAuthorization({ ...base, country: 'FI' })).rejects.toThrow(/no bank named/);
    expect(calls.filter(call => call.url.pathname === '/auth')).toHaveLength(before);
  });

  it('reports a consent that covers no readable account as its own result, not as an error', async () => {
    const SESSION_NEW = '66666666-ffff-4fff-8fff-666666666666';
    const { fetchImpl } = consentApi(call =>
      call.url.pathname === '/sessions' && call.method === 'POST'
        ? json({ session_id: SESSION_NEW, accounts: [], aspsp: { name: 'Invented Bank', country: 'SE' }, psu_type: 'business', access: { valid_until: '2027-02-01T00:00:00Z', balances: true, transactions: false } })
        : undefined,
    );
    expect(await gateway(fetchImpl).completeSession({ code: 'code-0000-1111' })).toEqual({
      sessionId: SESSION_NEW,
      outcome: 'no_accounts',
      validUntil: '2027-02-01T00:00:00.000Z',
      bank: { name: 'Invented Bank', country: 'SE' },
      psuType: 'business',
      accounts: [],
      accountsWithoutId: 0,
      access: { balances: true, transactions: false },
    });

    // Restricted mode with no linked account at all is an error with its own code.
    const restricted = consentApi(call => (call.url.pathname === '/sessions' && call.method === 'POST' ? json({ error: 'NO_ACCOUNTS_ADDED' }, 403) : undefined));
    const error = await gateway(restricted.fetchImpl).completeSession({ code: 'code-0000-1111' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnableBankingGatewayError);
    expect(error).toMatchObject({ status: 403, code: 'NO_ACCOUNTS_ADDED', problem: 'application_restricted' });
    expect((error as Error).message).toMatch(/restricted mode/);
  });

  it('describes each connected account, with or without an IBAN', async () => {
    const SESSION_NEW = '66666666-ffff-4fff-8fff-666666666666';
    const { fetchImpl } = consentApi(call =>
      call.url.pathname === '/sessions' && call.method === 'POST'
        ? json({
            session_id: SESSION_NEW,
            accounts: [
              { uid: ACCOUNT_1, name: 'Invented Trading AB', product: 'Business account', currency: 'SEK', cash_account_type: 'CACC', usage: 'ORGA', account_id: { other: { identification: '123-4567', scheme_name: 'BGNR' } } },
              { uid: ACCOUNT_2, details: 'Card', currency: 'XXX', cash_account_type: 'CARD', account_id: { other: { identification: ['9999', '0000', '0000', '1234'].join(''), scheme_name: 'CPAN' } } },
            ],
          })
        : undefined,
    );
    const done = await gateway(fetchImpl).completeSession({ code: 'code-0000-1111' });
    expect(done.outcome).toBe('connected');
    expect(done.accounts).toEqual([
      { id: ACCOUNT_1, name: 'Invented Trading AB', maskedIban: null, currency: 'SEK', identificationHash: null, product: 'Business account', identification: { scheme: 'BGNR', masked: '…4567' }, cashAccountType: 'CACC', usage: 'ORGA' },
      { id: ACCOUNT_2, name: 'Card', maskedIban: null, currency: 'XXX', identificationHash: null, product: null, identification: { scheme: 'CPAN', masked: '…1234' }, cashAccountType: 'CARD', usage: null },
    ]);
    expect(JSON.stringify(done)).not.toMatch(/123-4567|99990000/);
  });

  it('reads the state of a session: status, bank, times and what it covers', async () => {
    const { fetchImpl } = consentApi();
    expect(await gateway(fetchImpl).sessionStatus({ sessionId: SESSION })).toEqual({
      status: 'AUTHORIZED',
      validUntil: '2027-05-01T00:00:00.000Z',
      accountIds: [ACCOUNT_1, ACCOUNT_2],
      accounts: [
        { id: ACCOUNT_1, identificationHash: null },
        { id: ACCOUNT_2, identificationHash: null },
      ],
      bank: { name: 'Invented Bank', country: 'SE' },
      psuType: 'business',
      createdAt: '2026-11-01T08:00:00.000Z',
      authorizedAt: '2026-11-01T08:05:00.000Z',
      closedAt: null,
      access: { balances: true, transactions: true },
    });
  });

  it('ends a session at Enable Banking, and counts one that is already ended as ended', async () => {
    const { calls, fetchImpl } = consentApi(call => (call.method === 'DELETE' ? json({ message: 'OK' }) : undefined));
    expect(await gateway(fetchImpl).endSession({ sessionId: SESSION })).toEqual({ alreadyEnded: false });
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE' });
    expect(calls.at(-1)!.url.pathname).toBe(`/sessions/${SESSION}`);

    for (const [status, vendor] of [[401, 'EXPIRED_SESSION'], [401, 'CLOSED_SESSION'], [401, 'REVOKED_SESSION'], [404, 'SESSION_DOES_NOT_EXIST'], [422, 'WRONG_SESSION_STATUS']] as const) {
      const gone = consentApi(call => (call.method === 'DELETE' ? json({ error: vendor }, status) : undefined));
      expect(await gateway(gone.fetchImpl).endSession({ sessionId: SESSION }), vendor).toEqual({ alreadyEnded: true });
    }
    // Anything else is a failure: the session may still be open.
    for (const [status, vendor, problem] of [[403, 'ACCESS_DENIED', 'application_refused'], [401, undefined, 'access_refused'], [500, undefined, 'bank_unavailable']] as const) {
      const failing = consentApi(call => (call.method === 'DELETE' ? json(vendor ? { error: vendor } : {}, status) : undefined));
      const error = await gateway(failing.fetchImpl).endSession({ sessionId: SESSION }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EnableBankingGatewayError);
      expect(error).toMatchObject({ status, problem });
      expect((error as Error).message).not.toContain(SESSION);
    }
  });

  it('reads the application as Enable Banking sees it', async () => {
    const { calls, fetchImpl } = consentApi(call =>
      call.url.pathname === '/application'
        ? json({ name: 'Made-up app', description: 'x', kid: 'app-0000-test', environment: 'PRODUCTION', redirect_urls: ['https://app.example/connect/bank'], active: true, countries: ['DK', 'SE', 'xx'], services: ['AIS'] })
        : undefined,
    );
    expect(await gateway(fetchImpl).application()).toEqual({
      environment: 'PRODUCTION',
      active: true,
      countries: ['DK', 'SE'],
      services: ['AIS'],
      redirectUrls: ['https://app.example/connect/bank'],
    });
    expect(calls.at(-1)).toMatchObject({ method: 'GET' });

    const refused = consentApi(call => (call.url.pathname === '/application' ? json({ error: 'UNAUTHORIZED_ACCESS' }, 401) : undefined));
    const error = await gateway(refused.fetchImpl).application().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 401, problem: 'application_refused' });
  });
});
