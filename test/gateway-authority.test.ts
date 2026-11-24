// What a call may return is decided by that call alone: its consent as Enable Banking holds it now, the accounts
// the host gave with it, and who is present. Nothing is kept between calls, the details of the person present never
// come back in a result, a bank's rate limit is acted on wherever it shows up, and a malformed statement of who is
// present is refused. Made-up data only.
import { describe, expect, it, vi } from 'vitest';
import {
  createEnableBankingGateway,
  type EnableBankingGatewayOptions,
  type GatewayCallContext,
  type GatewayToolResult,
} from '../src/gateway.js';
import { GatewayRedactor } from '../src/gateway/redact.js';
import { psuHeaders } from '../src/enablebanking/psu.js';
import { KEY } from './helpers.js';

const PEM = KEY.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const NOW = Date.parse('2026-11-24T10:00:00Z');
const HOUR = 3_600_000;

const SESSION = '77777777-aaaa-4aaa-8aaa-777777777777';
const ACCOUNT_A = 'a1a1a1a1-0000-4000-8000-00000000a001';
const ACCOUNT_B = 'b2b2b2b2-0000-4000-8000-00000000b002';

interface Call {
  method: string;
  url: URL;
  headers: Headers;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const line = (reference: string, party: string, extra: Record<string, unknown> = {}) => ({
  entry_reference: reference,
  transaction_id: `id-${reference}`,
  transaction_amount: { currency: 'EUR', amount: '10.00' },
  credit_debit_indicator: 'DBIT',
  status: 'BOOK',
  booking_date: '2026-11-10',
  creditor: { name: party },
  remittance_information: [`Invoice ${reference}`],
  ...extra,
});

interface Bank {
  /** The accounts the session holds right now. */
  sessionAccounts: string[];
  /** Per account: a failure to answer with, instead of data. */
  failing: Map<string, { status: number; error: string }>;
  /** Added to every line and every account, as a bank that repeats what it was sent. */
  echo?: Record<string, unknown>;
}

function api(bank: Bank) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? 'GET', url, headers: new Headers(init?.headers) });
    if (/^\/sessions\/[^/]+$/.test(url.pathname)) {
      return json({ status: 'AUTHORIZED', accounts: bank.sessionAccounts, access: { valid_until: '2027-05-01T00:00:00Z' } });
    }
    const match = /^\/accounts\/([^/]+)\/(details|balances|transactions)(?:\/[^/]+)?$/.exec(url.pathname);
    if (!match) return json({ error: 'NOT_FOUND' }, 404);
    const [, account, kind] = match;
    const failure = bank.failing.get(account!);
    if (failure) return json({ error: failure.error }, failure.status);
    const who = account === ACCOUNT_A ? 'Alpha' : 'Beta';
    if (kind === 'details') return json({ name: `${who} holder`, currency: 'EUR', product: 'Account', ...(bank.echo ?? {}) });
    if (kind === 'balances') {
      return json({ balances: [{ balance_type: 'ITAV', name: 'Available', balance_amount: { currency: 'EUR', amount: '5.00' }, ...(bank.echo ?? {}) }] });
    }
    if (url.pathname.endsWith('/transactions')) return json({ transactions: [line(`${who}-1`, `${who} Supplies`, bank.echo)] });
    return json(line(`${who}-1`, `${who} Supplies`, bank.echo));
  });
  return { calls, fetchImpl, bankReads: () => calls.filter(call => call.url.pathname.startsWith('/accounts/')) };
}

function gateway(fetchImpl: typeof fetch, extra: Partial<EnableBankingGatewayOptions> = {}) {
  return createEnableBankingGateway({ applicationId: 'app-0000-test', privateKey: PEM, apiBaseUrl: 'https://eb.test', fetchImpl, now: () => NOW, ...extra });
}

const both: GatewayCallContext = { credentials: { sessionId: SESSION, accountIds: [ACCOUNT_A, ACCOUNT_B] } };
const data = <T>(result: GatewayToolResult) => result.structuredContent as T;
type Search = { complete: boolean; accounts: Array<{ account: string; read: boolean; problem?: string }>; transactions: Array<{ account: string }> };

describe('no answer outlives its authority', () => {
  it('never returns an account the session no longer covers, however the same question was answered before', async () => {
    const bank: Bank = { sessionAccounts: [ACCOUNT_A, ACCOUNT_B], failing: new Map() };
    const { fetchImpl, bankReads } = api(bank);
    // An option of this name existed in a draft of 0.7.0; it must have no effect.
    const gw = gateway(fetchImpl, { cacheSeconds: 600 } as never);
    const search = { query: 'supplies' };

    const first = data<Search>(await gw.callTool('search_transactions', search, both));
    expect(first.transactions.map(row => row.account).sort()).toEqual([ACCOUNT_A, ACCOUNT_B]);
    const listed = data<{ accounts: Array<{ id: string }> }>(await gw.callTool('list_accounts', {}, both));
    expect(listed.accounts.map(account => account.id)).toEqual([ACCOUNT_A, ACCOUNT_B]);
    await gw.callTool('get_balances', { account: ACCOUNT_B }, both);
    await gw.callTool('list_transactions', { account: ACCOUNT_B }, both);
    await gw.callTool('summarize_transactions', { account: ACCOUNT_B }, both);

    // The person takes account B out of the consent at the bank. The host does not know yet.
    bank.sessionAccounts = [ACCOUNT_A];
    const before = bankReads().length;

    const second = await gw.callTool('search_transactions', search, both);
    expect(JSON.stringify(second)).not.toContain(ACCOUNT_B);
    expect(JSON.stringify(second)).not.toContain('Beta');
    expect(data<Search>(second).transactions.map(row => row.account)).toEqual([ACCOUNT_A]);

    const relisted = await gw.callTool('list_accounts', {}, both);
    expect(JSON.stringify(relisted)).not.toContain('Beta');
    expect(data<{ accounts: Array<{ id: string }>; noLongerInConsent: number }>(relisted)).toMatchObject({ accounts: [{ id: ACCOUNT_A }], noLongerInConsent: 1 });

    for (const [tool, input] of [
      ['get_balances', { account: ACCOUNT_B }],
      ['get_account_details', { account: ACCOUNT_B }],
      ['list_transactions', { account: ACCOUNT_B }],
      ['summarize_transactions', { account: ACCOUNT_B }],
      ['get_transaction_details', { account: ACCOUNT_B, transaction: 'id-Beta-1' }],
      ['search_transactions', { query: 'supplies', accounts: [ACCOUNT_A, ACCOUNT_B] }],
    ] as Array<[string, Record<string, unknown>]>) {
      const refused = await gw.callTool(tool, input as never, both);
      expect(refused, tool).toMatchObject({ isError: true, errorCode: 'account_not_in_consent' });
      expect(JSON.stringify(refused)).not.toContain('Beta');
    }
    // Account B was not asked for at the bank again after the session stopped covering it.
    expect(bankReads().slice(before).every(call => !call.url.pathname.includes(ACCOUNT_B))).toBe(true);
  });

  it('never returns an account the host has taken off the list, and reads the bank for every call', async () => {
    const bank: Bank = { sessionAccounts: [ACCOUNT_A, ACCOUNT_B], failing: new Map() };
    const { fetchImpl, bankReads } = api(bank);
    const gw = gateway(fetchImpl);
    const known = [
      { id: ACCOUNT_A, name: 'Alpha stored', currency: 'EUR' },
      { id: ACCOUNT_B, name: 'Beta stored', currency: 'EUR' },
    ];
    const withBoth: GatewayCallContext = { credentials: { sessionId: SESSION, accountIds: [ACCOUNT_A, ACCOUNT_B], accounts: known } };
    // The same consent, as a caller who was given account A only (the list still holds what was stored about B).
    const onlyA: GatewayCallContext = { credentials: { sessionId: SESSION, accountIds: [ACCOUNT_A], accounts: known } };

    await gw.callTool('search_transactions', { query: 'supplies' }, withBoth);
    await gw.callTool('list_accounts', {}, withBoth);
    const searched = await gw.callTool('search_transactions', { query: 'supplies' }, onlyA);
    expect(JSON.stringify(searched)).not.toMatch(/Beta|b2b2b2b2/);
    const listed = await gw.callTool('list_accounts', {}, onlyA);
    expect(JSON.stringify(listed)).not.toMatch(/Beta|b2b2b2b2/);
    expect((await gw.callTool('get_balances', { account: ACCOUNT_B }, onlyA)).errorCode).toBe('account_not_connected');

    // Asked twice, read twice: nothing is answered from memory.
    const reads = bankReads().length;
    await gw.callTool('get_balances', { account: ACCOUNT_A }, onlyA);
    await gw.callTool('get_balances', { account: ACCOUNT_A }, onlyA);
    expect(bankReads()).toHaveLength(reads + 2);
  });

  it('refuses every call once the consent is ended, also right after a good answer', async () => {
    let status = 'AUTHORIZED';
    const { fetchImpl, bankReads } = api({ sessionAccounts: [ACCOUNT_A, ACCOUNT_B], failing: new Map() });
    const wrapped = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('/sessions/')) return json({ status, accounts: [ACCOUNT_A, ACCOUNT_B] });
      return fetchImpl(input, init);
    });
    const gw = gateway(wrapped);
    expect((await gw.callTool('get_balances', { account: ACCOUNT_A }, both)).isError).toBeUndefined();
    for (const [ended, code] of [['REVOKED', 'consent_revoked'], ['CLOSED', 'consent_revoked'], ['EXPIRED', 'consent_expired'], ['INVALID', 'consent_not_active']] as const) {
      status = ended;
      for (const [tool, input] of [['get_balances', { account: ACCOUNT_A }], ['list_accounts', {}], ['search_transactions', { query: 'supplies' }]] as const) {
        const refused = await gw.callTool(tool, input, both);
        expect(refused, `${ended} ${tool}`).toMatchObject({ isError: true, errorCode: code });
        expect(JSON.stringify(refused)).not.toMatch(/Alpha|Beta/);
      }
    }
    expect(bankReads()).toHaveLength(1);
  });
});

describe('the details of the person present', () => {
  const PERSON = {
    ipAddress: '192.0.2.10',
    userAgent: 'ExampleBrowser 1.0 (made-up device)',
    referer: 'https://app.example/bank?view=a b',
    geoLocation: '55.676100,12.568300',
    acceptLanguage: 'sv-SE,sv;q=0.9',
  };
  const VALUES = Object.values(PERSON);
  // The same values as a bank might write them back: URL-encoded, and inside JSON. (The address of the page is not
  // URL-encoded here: an encoded "//" can look like a piece of this run's random test key, and the sink check would
  // then withhold the whole answer. The redactor's own test below covers the encoded address.)
  const ENCODED = VALUES.filter(value => value !== PERSON.referer).map(value => encodeURIComponent(value));
  const echoed = [...VALUES, ...ENCODED, JSON.stringify(PERSON)].join(' | ');

  it('never come back in a result, whatever the bank repeats and in whatever field', async () => {
    const echo = {
      note: `Request from ${echoed}`,
      name: `Holder ${PERSON.ipAddress}`,
      remittance_information: [`Seen ${PERSON.userAgent}`, PERSON.geoLocation, `ref ${encodeURIComponent(PERSON.geoLocation)}`],
      creditor: { name: `Party at ${PERSON.geoLocation}` },
      product: PERSON.referer,
      details: PERSON.acceptLanguage,
    };
    const { calls, fetchImpl } = api({ sessionAccounts: [ACCOUNT_A, ACCOUNT_B], failing: new Map(), echo });
    const gw = gateway(fetchImpl);
    const context = { ...both, psu: PERSON };
    const results: GatewayToolResult[] = [];
    for (const [tool, input] of [
      ['list_accounts', {}],
      ['get_account_details', { account: ACCOUNT_A }],
      ['get_balances', { account: ACCOUNT_A }],
      ['list_transactions', { account: ACCOUNT_A }],
      ['get_transaction_details', { account: ACCOUNT_A, transaction: 'id-Alpha-1' }],
      ['summarize_transactions', { account: ACCOUNT_A }],
      ['search_transactions', { query: 'invoice' }],
    ] as const) {
      const result = await gw.callTool(tool, input, context);
      expect(result.isError, tool).toBeUndefined();
      results.push(result);
      const out = JSON.stringify(result);
      for (const value of VALUES) {
        expect(out, `${tool}: ${value}`).not.toContain(value);
        expect(out, `${tool}: encoded ${value}`).not.toContain(encodeURIComponent(value));
        expect(out, `${tool}: escaped ${value}`).not.toContain(JSON.stringify(value).slice(1, -1));
      }
    }
    // They did go to the bank, and the rest of the bank's text is still there.
    expect(calls.find(call => call.url.pathname.endsWith('/balances'))!.headers.get('Psu-Geo-Location')).toBe(PERSON.geoLocation);
    expect(JSON.stringify(results)).toContain('Request from ');
    expect(JSON.stringify(results)).toContain('‹redacted›');

    // The same bank answers to a caller with nobody present: nothing was sent, so nothing of it is the caller's own
    // detail, and the text stays as the bank wrote it.
    const plain = await gw.callTool('get_transaction_details', { account: ACCOUNT_A, transaction: 'id-Alpha-1' }, { ...both, unattended: true });
    expect(JSON.stringify(plain)).toContain(PERSON.ipAddress);
  });

  it('do not come back in an error either', async () => {
    const { fetchImpl } = api({ sessionAccounts: [ACCOUNT_A], failing: new Map([[ACCOUNT_A, { status: 400, error: 'ASPSP_ERROR' }]]) });
    const failing = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('/balances')) throw new Error(`socket closed for ${PERSON.ipAddress} (${PERSON.userAgent})`);
      return fetchImpl(input, init);
    });
    const result = await gateway(failing).callTool('get_balances', { account: ACCOUNT_A }, { credentials: { sessionId: SESSION, accountIds: [ACCOUNT_A] }, psu: PERSON });
    expect(result.isError).toBe(true);
    for (const value of VALUES) expect(JSON.stringify(result)).not.toContain(value);
  });

  it('are removed whole: the address and the location always, the free-text values from eight characters', async () => {
    // A browser name of a few letters, a language of two: removing those would blank the same word in a bank line.
    // The shortest an address can be (seven characters), in a range nobody is routed to, put together here so that
    // no real address stands in the file.
    const shortIp = [0, 0, 0, 9].join('.');
    const SHORT = { ipAddress: shortIp, geoLocation: '1.2,3.4', userAgent: 'Robo7', acceptLanguage: 'da', acceptEncoding: 'gzip' };
    const echo = { note: `Robo7 betalt i dag, gzip, fra ${shortIp} ved 1.2,3.4 og 1${shortIp}5` };
    const { fetchImpl } = api({ sessionAccounts: [ACCOUNT_A], failing: new Map(), echo });
    const context = { credentials: { sessionId: SESSION, accountIds: [ACCOUNT_A] }, psu: SHORT };
    const result = await gateway(fetchImpl).callTool('get_transaction_details', { account: ACCOUNT_A, transaction: 'id-Alpha-1' }, context);
    expect(data<{ transaction: { note: string } }>(result).transaction.note).toBe('Robo7 betalt i dag, gzip, fra ‹redacted› ved ‹redacted› og 1‹redacted›5');
  });

  it('are held by the redactor of one call only, in every form a bank could write them', () => {
    const redactor = new GatewayRedactor();
    redactor.addExact('192.0.2.10');
    redactor.addExact('55.676100,12.568300');
    redactor.addExact(undefined);
    redactor.addExact('');
    redactor.add('https://app.example/bank?view=a b');
    expect(redactor.redactValues(`from ${encodeURIComponent('https://app.example/bank?view=a b')} and ${JSON.stringify('https://app.example/bank?view=a b')}`)).toBe('from ‹redacted› and "‹redacted›"');
    expect(redactor.redactValues('192.0.2.10 at 55.676100%2C12.568300')).toBe('‹redacted› at ‹redacted›');
    // Not a secret: a piece of it does not make the sink check withhold a result.
    expect(redactor.matches('192.0.2.10')).toBe(false);
    // Another call's redactor knows nothing of this call's person.
    expect(new GatewayRedactor().fork().redactValues('192.0.2.10')).toBe('192.0.2.10');
  });

  it('are refused, not sent, when reading them fails', async () => {
    const { calls, fetchImpl } = api({ sessionAccounts: [ACCOUNT_A], failing: new Map() });
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('made-up failure while reading the details');
        },
      },
    );
    const result = await gateway(fetchImpl).callTool('get_balances', { account: ACCOUNT_A }, { credentials: { sessionId: SESSION, accountIds: [ACCOUNT_A] }, psu: hostile as never });
    expect(result).toMatchObject({ isError: true, errorCode: 'presence_incomplete' });
    expect(JSON.stringify(result)).not.toContain('made-up failure');
    expect(calls).toHaveLength(0);
  });
});

describe('a rate limit inside an answer', () => {
  it('pauses unattended reads of the consent, also when the search itself succeeded for another account', async () => {
    let clock = NOW;
    const bank: Bank = { sessionAccounts: [ACCOUNT_A, ACCOUNT_B], failing: new Map([[ACCOUNT_B, { status: 429, error: 'ASPSP_RATE_LIMIT_EXCEEDED' }]]) };
    const { fetchImpl, bankReads } = api(bank);
    const gw = gateway(fetchImpl, { now: () => clock });
    const unattended = { ...both, unattended: true };

    const partial = await gw.callTool('search_transactions', { query: 'supplies' }, unattended);
    expect(partial.isError).toBeUndefined();
    expect(data<Search>(partial)).toMatchObject({
      complete: false,
      accounts: [
        { account: ACCOUNT_A, read: true },
        { account: ACCOUNT_B, read: false, problem: 'rate_limited' },
      ],
    });
    expect(bankReads()).toHaveLength(2);

    // The bank has said stop: no unattended call reaches it, whatever it asks for, until six hours have passed.
    bank.failing.clear();
    for (const [tool, input] of [['get_balances', { account: ACCOUNT_A }], ['search_transactions', { query: 'supplies' }], ['list_transactions', { account: ACCOUNT_B }]] as const) {
      const paused = await gw.callTool(tool, input, unattended);
      expect(paused, tool).toMatchObject({ isError: true, errorCode: 'unattended_limit' });
      expect(paused.content[0]!.text).toContain('2026-11-24 16:00 UTC');
    }
    expect(bankReads()).toHaveLength(2);

    // A person who asks is not held back, and the answer is read again, not repeated: account B is there now.
    const asked = await gw.callTool('search_transactions', { query: 'supplies' }, { ...both, psu: { ipAddress: '192.0.2.10' } });
    expect(data<Search>(asked)).toMatchObject({ complete: true, accounts: [{ read: true }, { read: true }] });

    clock += 6 * HOUR;
    const later = await gw.callTool('search_transactions', { query: 'supplies' }, unattended);
    expect(data<Search>(later).complete).toBe(true);
  });

  it('does not pause anything when a person was present for the limited read', async () => {
    const bank: Bank = { sessionAccounts: [ACCOUNT_A, ACCOUNT_B], failing: new Map([[ACCOUNT_B, { status: 429, error: 'ASPSP_RATE_LIMIT_EXCEEDED' }]]) };
    const { fetchImpl } = api(bank);
    const gw = gateway(fetchImpl);
    const partial = await gw.callTool('search_transactions', { query: 'supplies' }, { ...both, psu: { ipAddress: '192.0.2.10' } });
    expect(data<Search>(partial).accounts[1]).toMatchObject({ read: false, problem: 'rate_limited' });
    bank.failing.clear();
    expect((await gw.callTool('get_balances', { account: ACCOUNT_A }, { ...both, unattended: true })).isError).toBeUndefined();
  });

  it('is not acted on for another kind of failure', async () => {
    const bank: Bank = { sessionAccounts: [ACCOUNT_A, ACCOUNT_B], failing: new Map([[ACCOUNT_B, { status: 400, error: 'ASPSP_ERROR' }]]) };
    const { fetchImpl } = api(bank);
    const gw = gateway(fetchImpl);
    const unattended = { ...both, unattended: true };
    expect(data<Search>(await gw.callTool('search_transactions', { query: 'supplies' }, unattended)).accounts[1]).toMatchObject({ problem: 'bank_unavailable' });
    expect((await gw.callTool('get_balances', { account: ACCOUNT_A }, unattended)).isError).toBeUndefined();
  });
});

describe('a malformed statement of who is present', () => {
  const MALFORMED: Array<[string, unknown]> = [
    ['null', null],
    ['an empty object', {}],
    ['only undefined fields', { ipAddress: undefined }],
    ['a string', '192.0.2.10'],
    ['a number', 1],
    ['true', true],
    ['an array', [{ ipAddress: '192.0.2.10' }]],
    ['a line break at the end', { userAgent: 'Browser\r\n' }],
    ['a line break at the start', { userAgent: '\nBrowser' }],
    ['a header added by a line break', { userAgent: 'Browser\r\nX-Added: 1' }],
    ['a bare line feed', { referer: 'https://app.example/\nPsu-Ip-Address: 198.51.100.7' }],
    ['a carriage return', { accept: 'text/html\r' }],
    ['a tab', { userAgent: 'Browser\t1.0' }],
    ['a NUL', { userAgent: 'Browser\u0000' }],
    ['a DEL', { userAgent: 'Browser\u007f' }],
    ['non-ASCII', { userAgent: 'Bläddrare/1.0' }],
    ['a full-width digit', { ipAddress: '192.0.2.1０' }],
    ['a line separator', { acceptLanguage: 'sv SE' }],
    ['an over-long value', { userAgent: 'x'.repeat(513) }],
    ['an empty value', { userAgent: '' }],
    ['only spaces', { userAgent: '   ' }],
    ['a number as a value', { userAgent: 42 }],
    ['an object as a value', { ipAddress: { toString: () => '192.0.2.10' } }],
    ['null as a value', { ipAddress: null }],
    ['not an IP address', { ipAddress: '192.0.2' }],
    ['an IP address with a port', { ipAddress: '192.0.2.10:443' }],
    ['an IP address with a line break', { ipAddress: '192.0.2.10\n' }],
    ['a loopback form too short to be anyone’s address', { ipAddress: '::1' }],
    ['a place that is not coordinates', { geoLocation: 'Stockholm' }],
    ['a field that is not a Psu header', { ipAddress: '192.0.2.10', cookie: 'a=b' }],
    ['one good field and one bad', { ipAddress: '192.0.2.10', userAgent: 'Browser\r\n' }],
  ];

  it('is refused as it was given, before anything is trimmed', () => {
    for (const [name, psu] of MALFORMED) expect(psuHeaders(psu), name).toEqual({ ok: false });
    // What is accepted can never hold a control character or leave ASCII.
    const good = psuHeaders({ ipAddress: ' 192.0.2.10 ', userAgent: 'ExampleBrowser/1.0', referer: 'https://app.example/a?b=c' });
    expect(good).toEqual({ ok: true, headers: { 'Psu-Ip-Address': '192.0.2.10', 'Psu-User-Agent': 'ExampleBrowser/1.0', 'Psu-Referer': 'https://app.example/a?b=c' } });
    if (good.ok) for (const value of Object.values(good.headers)) expect(value).toMatch(/^[\x21-\x7E]([\x20-\x7E]*[\x21-\x7E])?$/);
  });

  it('refuses the call with presence_incomplete and sends nothing, never a background read instead', async () => {
    const { calls, fetchImpl } = api({ sessionAccounts: [ACCOUNT_A, ACCOUNT_B], failing: new Map() });
    const gw = gateway(fetchImpl);
    for (const [name, psu] of MALFORMED) {
      // `only undefined fields` aside, undefined itself is the one value that means "not said".
      for (const [tool, input] of [['get_balances', { account: ACCOUNT_A }], ['list_accounts', {}], ['search_transactions', { query: 'x' }]] as const) {
        const result = await gw.callTool(tool, input, { ...both, psu: psu as never });
        expect(result, `${name} ${tool}`).toMatchObject({ isError: true, errorCode: 'presence_incomplete' });
      }
    }
    for (const unattended of [null, 'true', 1, {}, []]) {
      const result = await gw.callTool('get_balances', { account: ACCOUNT_A }, { ...both, unattended: unattended as never });
      expect(result, `unattended ${JSON.stringify(unattended)}`).toMatchObject({ isError: true, errorCode: 'presence_incomplete' });
    }
    // Both at once is a contradiction, also when the statement of nobody present is the malformed one.
    expect((await gw.callTool('get_balances', { account: ACCOUNT_A }, { ...both, psu: { ipAddress: '192.0.2.10' }, unattended: true })).errorCode).toBe('presence_incomplete');
    expect(calls).toHaveLength(0);

    // A refused statement uses none of the day's unattended reads.
    for (let i = 0; i < 4; i += 1) expect((await gw.callTool('get_balances', { account: ACCOUNT_A }, { ...both, unattended: true })).isError).toBeUndefined();
  });

  it('means "not said" only when the field is not there', async () => {
    const { calls, fetchImpl } = api({ sessionAccounts: [ACCOUNT_A, ACCOUNT_B], failing: new Map() });
    const gw = gateway(fetchImpl, { unattendedFetchesPerDay: 1 });
    for (const context of [both, { ...both, psu: undefined }, { ...both, unattended: undefined }, { ...both, unattended: false }]) {
      for (let i = 0; i < 2; i += 1) expect((await gw.callTool('get_balances', { account: ACCOUNT_A }, context)).isError).toBeUndefined();
    }
    for (const call of calls) expect([...call.headers.keys()].filter(name => name.startsWith('psu-'))).toEqual([]);
  });
});
