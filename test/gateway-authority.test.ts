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
  /** The bank always has one more page of lines. */
  continues?: boolean;
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
    if (url.pathname.endsWith('/transactions')) {
      return json({ transactions: [line(`${who}-1`, `${who} Supplies`, bank.echo)], ...(bank.continues ? { continuation_key: 'made-up-next-page' } : {}) });
    }
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

describe('the details of the person present, written another way', () => {
  // Checked independently of the redactor: the text with every layer of encoding undone, as a reader could undo it.
  const hex = (char: string, upper: boolean) => {
    const code = char.charCodeAt(0).toString(16).padStart(2, '0');
    return upper ? code.toUpperCase() : code;
  };
  const percentAll = (value: string, upper: boolean) => [...value].map(char => `%${hex(char, upper)}`).join('');
  const BACKSLASH = String.fromCharCode(92);
  const lowerHex = (value: string) => encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, escape => escape.toLowerCase());
  const SPELLINGS: Array<[string, (value: string) => string]> = [
    ['percent-encoded with upper-case hex', value => encodeURIComponent(value)],
    ['percent-encoded with lower-case hex', lowerHex],
    ['percent-encoded with mixed-case hex', value => encodeURIComponent(value).replace(/%([0-9A-F])([A-F])/g, (_, a: string, b: string) => `%${a}${b.toLowerCase()}`)],
    ['every character percent-encoded, upper case', value => percentAll(value, true)],
    ['every character percent-encoded, lower case', value => percentAll(value, false)],
    ['the characters a URL leaves alone percent-encoded too', value => encodeURIComponent(value).replace(/[.a-z-]/g, char => `%${hex(char, false)}`)],
    ['encoded twice', value => encodeURIComponent(encodeURIComponent(value))],
    ['encoded twice with lower-case hex', value => lowerHex(lowerHex(value))],
    ['encoded three times', value => encodeURIComponent(encodeURIComponent(encodeURIComponent(value)))],
    ['as a form writes it, with + for a space', value => encodeURIComponent(value).replace(/%20/g, '+')],
    ['as a form writes it, encoded again', value => encodeURIComponent(encodeURIComponent(value).replace(/%20/g, '+'))],
    ['with JSON unicode escapes', value => [...value].map(char => `\\u00${hex(char, false)}`).join('')],
    ['with JSON unicode escapes for the punctuation only', value => value.replace(/[^A-Za-z0-9]/g, char => `\\u00${hex(char, true)}`)],
    ['with JavaScript hex escapes', value => value.replace(/[^A-Za-z0-9]/g, char => `\\x${hex(char, false)}`)],
    // Not an escaping of anything: one of the spellings a bank's JSON may come in, each slash with a backslash before it.
    ['with a backslash before each slash', value => value.split('/').join(`${BACKSLASH}/`)],
    ['inside JSON inside JSON', value => JSON.stringify(JSON.stringify(value).slice(1, -1)).slice(1, -1)],
    ['with decimal HTML entities', value => value.replace(/[^A-Za-z0-9]/g, char => `&#${char.charCodeAt(0)};`)],
    ['with hexadecimal HTML entities', value => value.replace(/[^A-Za-z0-9]/g, char => `&#x${hex(char, true)};`)],
    ['with named HTML entities', value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;')],
    ['percent-encoded inside an HTML entity encoding', value => encodeURIComponent(value).replace(/%/g, '&#37;')],
    ['with two spaces for one', value => value.replace(/ /g, '  ')],
    ['with a tab or a line break for a space', value => value.replace(/ /, '\t').replace(/ /, '\n')],
    ['with a non-breaking space for a space', value => value.replace(/ /g, '\u00a0')],
  ];
  const PEOPLE: Array<[string, Record<string, string>]> = [
    [
      'an IPv4 address',
      { ipAddress: '192.0.2.10', geoLocation: '55.676100,12.568300', userAgent: 'ExampleBrowser 1.0 (made-up device; rv:1)', referer: 'https://app.example/bank?view=a b&tab=<1>' },
    ],
    ['an IPv6 address', { ipAddress: '2001:db8::a1', geoLocation: '-33.8568,151.2153', userAgent: 'Made-up "Agent" \ 2.0', acceptLanguage: 'sv-SE,sv;q=0.9' }],
  ];

  for (const [who, person] of PEOPLE) {
    it.each(SPELLINGS)(`never come back for ${who}: %s`, async (_, spell) => {
      const written = Object.values(person).map(spell);
      const echo = {
        note: `Request from ${written.join(' | ')} end`,
        remittance_information: written.map(value => `Seen ${value} here`),
        creditor: { name: `Party ${written[0]}` },
      };
      const { fetchImpl } = api({ sessionAccounts: [ACCOUNT_A], failing: new Map(), echo });
      const context = { credentials: { sessionId: SESSION, accountIds: [ACCOUNT_A] }, psu: person };
      const gw = gateway(fetchImpl);

      const details = await gw.callTool('get_transaction_details', { account: ACCOUNT_A, transaction: 'id-Alpha-1' }, context);
      expect(details.isError).toBeUndefined();
      const view = data<{ transaction: { note: string; remittance: string[]; text: string; counterparty: string } }>(details).transaction;
      // The whole of each echo is gone, and nothing but it: the bank's own words around it are still there.
      expect(view.note).toBe(`Request from ${written.map(() => '‹redacted›').join(' | ')} end`);
      expect(view.remittance).toEqual(written.map(() => 'Seen ‹redacted› here'));
      expect(view.text).toBe(written.map(() => 'Seen ‹redacted› here').join(' '));
      expect(view.counterparty).toBe('Party ‹redacted›');

      for (const [tool, input] of [
        ['list_transactions', { account: ACCOUNT_A }],
        ['search_transactions', { query: 'invoice' }],
        ['summarize_transactions', { account: ACCOUNT_A }],
        ['get_transaction_details', { account: ACCOUNT_A, transaction: 'id-Alpha-1' }],
      ] as Array<[string, Record<string, unknown>]>) {
        const out = JSON.stringify(await gw.callTool(tool, input as never, context));
        for (const [index, value] of Object.values(person).entries()) {
          expect(out, `${tool}: ${value}`).not.toContain(value);
          expect(out, `${tool}: ${value} as written`).not.toContain(written[index]!);
          expect(out, `${tool}: ${value} as written, inside JSON`).not.toContain(JSON.stringify(written[index]).slice(1, -1));
        }
      }
    });
  }

  it('are removed after the server’s own joining and spacing of the bank’s texts', async () => {
    const person = { ipAddress: '192.0.2.10', userAgent: 'Example  Browser 1.0' };
    // The bank repeats the browser name as it was sent, with its two spaces; the listing shows the remittance lines
    // joined and with single spaces. And a bank that splits it over two lines: the server joins them again.
    const echo = { remittance_information: ['Seen Example  Browser 1.0', 'Example', 'Browser 1.0'] };
    const { fetchImpl } = api({ sessionAccounts: [ACCOUNT_A], failing: new Map(), echo });
    const context = { credentials: { sessionId: SESSION, accountIds: [ACCOUNT_A] }, psu: person };
    const gw = gateway(fetchImpl);
    for (const [tool, input] of [
      ['list_transactions', { account: ACCOUNT_A }],
      ['search_transactions', { query: 'browser' }],
      ['get_transaction_details', { account: ACCOUNT_A, transaction: 'id-Alpha-1' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await gw.callTool(tool, input as never, context);
      expect(result.isError, tool).toBeUndefined();
      const out = JSON.stringify(result);
      expect(out, tool).not.toMatch(/Example\s+Browser 1\.0/);
      expect(out, tool).toContain('Seen ‹redacted›');
    }
    const view = data<{ transaction: { text: string; remittance: string[] } }>(
      await gw.callTool('get_transaction_details', { account: ACCOUNT_A, transaction: 'id-Alpha-1' }, context),
    ).transaction;
    expect(view.text).toBe('Seen ‹redacted› ‹redacted›');
    // What is not promised: a value the bank itself has cut in two stays where the two parts are shown apart.
    expect(view.remittance).toEqual(['Seen ‹redacted›', 'Example', 'Browser 1.0']);
  });

  it('are found however they are written, by the redactor itself', () => {
    const redactor = new GatewayRedactor();
    redactor.addExact('55.676100,12.568300');
    redactor.addExact('2001:db8::a1');
    redactor.add('Made-up Agent / 2.0');
    const check = (text: string, expected: string) => expect(redactor.redactValues(text), text).toBe(expected);
    check('at 55.676100%2c12.568300.', 'at ‹redacted›.');
    check('at 55.676100%2C12.568300.', 'at ‹redacted›.');
    check('at 55.676100%252c12.568300.', 'at ‹redacted›.');
    check('at 55.676100%25252C12.568300.', 'at ‹redacted›.');
    check('from 2001%3adb8%3a%3aa1, 2001%3Adb8%3A%3Aa1 and 2001&#58;db8&#x3a;:a1', 'from ‹redacted›, ‹redacted› and ‹redacted›');
    check('ua=Made-up+Agent+%2f+2.0&x=1', 'ua=‹redacted›&x=1');
    check('ua Made-up\tAgent \n/  2.0!', 'ua ‹redacted›!');
    check('"Made-up Agent \\/ 2.0"', '"‹redacted›"');
    // Two echoes side by side are two removals; one inside the other is one.
    check('55.676100%2c12.568300 55.676100,12.568300', '‹redacted› ‹redacted›');
    // What does not read as the value stays: another number, a + that is a plus, a stray percent sign.
    check('55.676100%2d12.568300, 1+1=2, 100% sure, A&B, C:\\dir', '55.676100%2d12.568300, 1+1=2, 100% sure, A&B, C:\\dir');
    // Layers are undone to a fixed depth (MAX_DECODE_DEPTH), not without end.
    check(`55.676100%${'25'.repeat(3)}2C12.568300`, '‹redacted›');
    check(`55.676100%${'25'.repeat(8)}2C12.568300`, `55.676100%${'25'.repeat(8)}2C12.568300`);
  });
});

describe('an address or a location of the person present, in another spelling that says the same', () => {
  const through = async (person: Record<string, string>, note: string) => {
    const { fetchImpl } = api({ sessionAccounts: [ACCOUNT_A], failing: new Map(), echo: { note } });
    const context = { credentials: { sessionId: SESSION, accountIds: [ACCOUNT_A] }, psu: person };
    const result = await gateway(fetchImpl).callTool('get_transaction_details', { account: ACCOUNT_A, transaction: 'id-Alpha-1' }, context);
    expect(result.isError).toBeUndefined();
    return data<{ transaction: { note: string } }>(result).transaction.note;
  };

  it.each([
    ['in upper case', '2001:DB8::A1'],
    ['written out in full', '2001:0db8:0000:0000:0000:0000:0000:00a1'],
    ['written out without leading zeros', '2001:db8:0:0:0:0:0:a1'],
    ['shortened in another place', '2001:db8:0:0::a1'],
    ['with its end as an IPv4 address', ['2001:db8::0.0.0', 161].join('.')],
    ['in brackets with a port', '[2001:Db8::a1]:443'],
    ['at the end of a sentence', '2001:DB8:0::A1.'],
    ['percent-encoded in upper case', '2001%3ADB8%3A%3AA1'],
    ['percent-encoded with lower-case hex, written out', '2001%3a0db8%3a0%3a0%3a0%3a0%3a0%3aa1'],
  ])('removes an IPv6 address %s', async (_, written) => {
    const note = await through({ ipAddress: '2001:db8::a1' }, `Seen from ${written} today`);
    expect(note).not.toMatch(/a1|A1/);
    expect(['Seen from ‹redacted› today', 'Seen from [‹redacted›]:443 today', 'Seen from ‹redacted›. today']).toContain(note);
  });

  it('removes an IPv4 address written as an IPv6 address, and leaves other addresses alone', async () => {
    const mapped = ['::ffff:', 'c000:20a'].join('');
    const note = await through({ ipAddress: '192.0.2.10' }, `Seen from ${mapped}, ::FFFF:192.0.2.10 and 0:0:0:0:0:ffff:C000:020A, not 2001:db8::b2 or 12:30:45`);
    // (The address as it was sent is removed first, wherever it stands; what is left of that spelling says nothing.)
    expect(note).toBe('Seen from ‹redacted›, ::FFFF:‹redacted› and ‹redacted›, not 2001:db8::b2 or 12:30:45');
  });

  it.each([
    ['with fewer zeros', '55.6761,12.5683'],
    ['with more zeros', '55.67610000,12.56830000'],
    ['with a space after the comma', '55.676100, 12.568300'],
    ['with a semicolon', '55.676100;12.568300'],
    ['with a percent-encoded comma and space', '55.6761%2c%2012.5683'],
    ['with a space and no comma', '55.6761 12.5683'],
    ['with a tab and no comma', '55.6761\t12.5683'],
    ['with a percent-encoded space and no comma', '55.6761%2012.5683'],
    ['with an HTML-encoded space and no comma', '55.6761&#32;12.5683'],
    ['with thirteen decimals', '55.6761000000000,12.5683000000000'],
    ['with twenty decimals and a space', '55.67610000000000000000 12.56830000000000000000'],
    ['with decimal commas and a semicolon', '55,6761;12,5683'],
    ['with decimal commas and a space', '55,676100 12,568300'],
  ])('removes a location %s', async (_, written) => {
    const note = await through({ geoLocation: '55.676100,12.568300' }, `Seen at ${written} today, paid 55.67, 12.56 and 10.00,20.00`);
    expect(note).toBe('Seen at ‹redacted› today, paid 55.67, 12.56 and 10.00,20.00');
  });

  it('finds a location right after a number that is not one of its coordinates', async () => {
    const note = await through({ geoLocation: '55.676100,12.568300' }, 'Seen 12 55.6761 12.5683 today');
    expect(note).toBe('Seen 12 ‹redacted› today');
  });

  it.each([
    'Beløb 1055,12 DKK',
    'Beløb 1.055,12 kr.',
    'Beløb 55,12 kr. og 12,00 kr.',
    'Beløb 1055.12 DKK og 255.0, 12.0 point',
    'Bogført 2026-09-10, valør 10.09.2026 kl. 12.00',
    'Konto 5470 0001234567, reg. 5470-1234567',
    'Faktura 55 12 0 betalt',
  ])('leaves ordinary Danish amounts, dates and numbers alone near the location 55.0,12.0: %s', async text => {
    expect(await through({ geoLocation: '55.0,12.0' }, text)).toBe(text);
  });

  it('removes the location 55.0,12.0 itself, also with other zeros', async () => {
    expect(await through({ geoLocation: '55.0,12.0' }, 'At 55.0, 12.0 and 55.000 12.00, paid 1055,12 DKK')).toBe('At ‹redacted› and ‹redacted›, paid 1055,12 DKK');
  });
});

describe('the redactor on text it has no business with', () => {
  // A fixed sequence, so a failure can be repeated.
  function sequence(seed: number) {
    let state = seed;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }
  const ALPHABET = ['%', '%2', '%2c', '%25', '\\', '\\u00', '\\u002c', '\\x', '&', '&#', '&#44;', '&amp;', ';', '+', ' ', '  ', '\t', ':', '::', '.', ',', 'a', 'F', '0', '1', '9', 'db8', 'x', 'é', '‹', '"'];
  const noise = (next: () => number, length: number) => Array.from({ length }, () => ALPHABET[Math.floor(next() * ALPHABET.length)]!).join('');

  const redactor = new GatewayRedactor();
  redactor.addAddress('2001:db8::a1');
  redactor.addLocation('55.676100,12.568300');
  redactor.add('Made-up Agent / 2.0');

  it('leaves every text that holds none of its values exactly as it is', () => {
    const next = sequence(20261124);
    for (let round = 0; round < 3000; round += 1) {
      const text = noise(next, 1 + Math.floor(next() * 60));
      expect(redactor.redactValues(text), JSON.stringify(text)).toBe(text);
    }
  });

  it('removes a value from the middle of any such text and keeps the text around it', () => {
    const next = sequence(7);
    const written = ['2001%3aDB8%3A%3aa1', '55.6761%2C%2012.5683', 'Made-up+Agent+%2f+2.0', '2001:db8:0:0:0:0:0:a1', 'Made-up\\u0020Agent / 2.0'];
    for (let round = 0; round < 1500; round += 1) {
      // Letters around the value, so that what stands next to it cannot be read as part of an escape or an address.
      const before = `${noise(next, Math.floor(next() * 30))} x `;
      const after = ` x ${noise(next, Math.floor(next() * 30))}`;
      const value = written[round % written.length]!;
      expect(redactor.redactValues(`${before}${value}${after}`), JSON.stringify([before, value, after])).toBe(`${before}‹redacted›${after}`);
    }
  });

  it('answers at once for a long text of nothing but escapes', () => {
    const started = Date.now();
    for (const text of ['%25'.repeat(20_000), '&#37;'.repeat(10_000), ':'.repeat(50_000), '1.1,'.repeat(20_000), ' \t'.repeat(30_000), '\\u005c'.repeat(10_000)]) {
      redactor.redactValues(text);
    }
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('a continued listing during the pause after a rate limit', () => {
  const period = { account: ACCOUNT_A, from: '2026-11-01', to: '2026-11-10' };

  async function tokenThenLimit(extra: Partial<EnableBankingGatewayOptions> = {}) {
    let clock = NOW;
    const bank: Bank = { sessionAccounts: [ACCOUNT_A, ACCOUNT_B], failing: new Map(), continues: true };
    const { fetchImpl, bankReads } = api(bank);
    const gw = gateway(fetchImpl, { now: () => clock, ...extra });
    const unattended = { ...both, unattended: true };
    const first = await gw.callTool('list_transactions', period, unattended);
    const token = data<{ nextPageToken: string; hasMore: boolean }>(first).nextPageToken;
    expect(token).toEqual(expect.any(String));
    // The bank says stop, for another account of the same consent.
    bank.failing.set(ACCOUNT_B, { status: 429, error: 'ASPSP_RATE_LIMIT_EXCEEDED' });
    expect((await gw.callTool('get_balances', { account: ACCOUNT_B }, unattended)).errorCode).toBe('rate_limited');
    bank.failing.clear();
    return { gw, bankReads, token, unattended, advance: (ms: number) => (clock += ms) };
  }

  it('is refused like any other read with nobody present, until the pause is over', async () => {
    const { gw, bankReads, token, unattended, advance } = await tokenThenLimit();
    const before = bankReads().length;

    const continued = await gw.callTool('list_transactions', { ...period, pageToken: token }, unattended);
    expect(continued).toMatchObject({ isError: true, errorCode: 'unattended_limit' });
    expect(continued.content[0]!.text).toContain('2026-11-24 16:00 UTC');
    expect(JSON.stringify(continued)).not.toContain('Alpha');
    // The same as an ordinary read gets, and neither reached the bank.
    expect((await gw.callTool('get_balances', { account: ACCOUNT_A }, unattended)).errorCode).toBe('unattended_limit');
    expect(bankReads()).toHaveLength(before);

    // (The token itself lasts fifteen minutes; after the pause a listing is started anew and continued as before.)
    advance(6 * HOUR);
    const anew = await gw.callTool('list_transactions', period, unattended);
    expect(anew.isError).toBeUndefined();
    const next = data<{ nextPageToken: string }>(anew).nextPageToken;
    expect((await gw.callTool('list_transactions', { ...period, pageToken: next }, unattended)).isError).toBeUndefined();
    expect(bankReads().length).toBeGreaterThan(before);
  });

  it('is not held back for a person who asks', async () => {
    const { gw, bankReads, token } = await tokenThenLimit();
    const before = bankReads().length;
    const asked = await gw.callTool('list_transactions', { ...period, pageToken: token }, { ...both, psu: { ipAddress: '192.0.2.10' } });
    expect(asked.isError).toBeUndefined();
    expect(bankReads().length).toBeGreaterThan(before);
  });

  it('still costs nothing of the budget when there is no pause', async () => {
    const bank: Bank = { sessionAccounts: [ACCOUNT_A, ACCOUNT_B], failing: new Map(), continues: true };
    const { fetchImpl } = api(bank);
    const gw = gateway(fetchImpl, { unattendedFetchesPerDay: 1 });
    const unattended = { ...both, unattended: true };
    const token = data<{ nextPageToken: string }>(await gw.callTool('list_transactions', period, unattended)).nextPageToken;
    // The day's one read is used; the listing can still be continued, and a new read cannot be started.
    expect((await gw.callTool('list_transactions', { ...period, pageToken: token }, unattended)).isError).toBeUndefined();
    expect((await gw.callTool('get_balances', { account: ACCOUNT_A }, unattended)).errorCode).toBe('unattended_limit');
  });
});
