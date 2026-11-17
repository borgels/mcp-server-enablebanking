import { createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as gatewayModule from '../src/gateway.js';
import {
  createEnableBankingGateway,
  enableBankingServiceCatalog,
  enableBankingToolCatalog,
  resolveEnableBankingReadTarget,
  type GatewayCallContext,
} from '../src/gateway.js';
import { dkIban, KEY } from './helpers.js';

const PEM = KEY.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const ORIGIN = 'https://eb.test';
const NOW = Date.parse('2026-11-17T10:00:00Z');

// Made-up sessions and accounts of two made-up companies.
const SESSION_A = '11111111-aaaa-4aaa-8aaa-111111111111';
const SESSION_B = '22222222-bbbb-4bbb-8bbb-222222222222';
const ACCOUNT_A1 = 'a1a1a1a1-0000-4000-8000-00000000a001';
const ACCOUNT_A2 = 'a2a2a2a2-0000-4000-8000-00000000a002';
const ACCOUNT_B1 = 'b1b1b1b1-0000-4000-8000-00000000b001';

const SESSIONS: Record<string, { status: string; accounts: string[]; valid_until: string }> = {
  [SESSION_A]: { status: 'AUTHORIZED', accounts: [ACCOUNT_A1, ACCOUNT_A2], valid_until: '2027-05-01T00:00:00+00:00' },
  [SESSION_B]: { status: 'AUTHORIZED', accounts: [ACCOUNT_B1], valid_until: '2027-05-01T00:00:00+00:00' },
};

const BALANCES: Record<string, string> = { [ACCOUNT_A1]: '1000.00', [ACCOUNT_A2]: '2000.00', [ACCOUNT_B1]: '9999.00' };

interface Call {
  method: string;
  url: URL;
  body?: unknown;
  authorization?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A stand-in for Enable Banking. Optional `delay` per path makes concurrent calls interleave. */
function stubApi(overrides: { delay?: (url: URL) => number; handle?: (call: Call) => Response | undefined } = {}) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: headers.get('authorization') ?? undefined,
    };
    calls.push(call);
    const wait = overrides.delay?.(url) ?? 0;
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    const custom = overrides.handle?.(call);
    if (custom) return custom;
    const session = /^\/sessions\/([^/]+)$/.exec(url.pathname);
    if (session && call.method === 'GET') {
      const found = SESSIONS[session[1]!];
      return found ? json({ status: found.status, accounts: found.accounts, access: { valid_until: found.valid_until } }) : json({ error: 'SESSION_DOES_NOT_EXIST', message: 'no' }, 404);
    }
    const balances = /^\/accounts\/([^/]+)\/balances$/.exec(url.pathname);
    if (balances) {
      return json({ balances: [{ balance_type: 'CLBD', balance_amount: { currency: 'DKK', amount: BALANCES[balances[1]!] } }] });
    }
    const details = /^\/accounts\/([^/]+)\/details$/.exec(url.pathname);
    if (details) {
      return json({ uid: details[1], name: `Account ${details[1]!.slice(0, 2)}`, currency: 'DKK', product: 'Erhvervskonto', account_id: { iban: dkIban('54700001234567') } });
    }
    const transactions = /^\/accounts\/([^/]+)\/transactions$/.exec(url.pathname);
    if (transactions) {
      const key = url.searchParams.get('continuation_key');
      const row = (n: number) => ({
        entry_reference: `ref-${transactions[1]!.slice(0, 2)}-${n}`,
        transaction_amount: { currency: 'DKK', amount: '100.00' },
        credit_debit_indicator: n % 2 ? 'DBIT' : 'CRDT',
        status: 'BOOK',
        booking_date: '2026-11-0' + String(n),
        creditor: { name: 'Fiktiv Leverandør ApS' },
        debtor: { name: 'Opdigtet Kunde A/S' },
        remittance_information: ['Faktura 1234'],
      });
      if (!key) return json({ transactions: [row(1), row(2)], continuation_key: 'page-2-key' });
      return json({ transactions: [row(3)], continuation_key: null });
    }
    return json({ error: 'NOT_FOUND', message: 'unknown path' }, 404);
  });
  return { calls, fetchImpl };
}

function gateway(fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createEnableBankingGateway>[0]> = {}) {
  return createEnableBankingGateway({ applicationId: 'app-0000-test', privateKey: PEM, apiBaseUrl: ORIGIN, fetchImpl, now: () => NOW, ...extra });
}

const ctxA: GatewayCallContext = { caller: 'person-a', requestId: 'r-a', credentials: { sessionId: SESSION_A, accountIds: [ACCOUNT_A1, ACCOUNT_A2] } };
const ctxB: GatewayCallContext = { caller: 'person-b', requestId: 'r-b', credentials: { sessionId: SESSION_B, accountIds: [ACCOUNT_B1] } };

function text(result: { content: Array<{ text: string }> }): string {
  return result.content.map(part => part.text).join('\n');
}

describe('gateway: credentials per call', () => {
  it('keeps two companies apart in concurrent calls', async () => {
    // Company A's requests are slow, so B's run in between.
    const { calls, fetchImpl } = stubApi({ delay: url => (url.pathname.includes('a1a1') || url.pathname.includes(SESSION_A) ? 30 : 0) });
    const gw = gateway(fetchImpl);
    const [a, b, a2] = await Promise.all([
      gw.callTool('get_balances', { account: ACCOUNT_A1 }, ctxA),
      gw.callTool('get_balances', { account: ACCOUNT_B1 }, ctxB),
      gw.callTool('get_balances', { account: ACCOUNT_A2 }, ctxA),
    ]);
    expect(a.isError).toBeUndefined();
    expect(JSON.stringify(a.structuredContent)).toContain('1000.00');
    expect(JSON.stringify(a.structuredContent)).not.toContain('9999.00');
    expect(JSON.stringify(b.structuredContent)).toContain('9999.00');
    expect(JSON.stringify(b.structuredContent)).not.toContain('1000.00');
    expect(JSON.stringify(a2.structuredContent)).toContain('2000.00');
    // Each session id was only used for its own company's session check.
    const sessionCalls = calls.filter(call => call.url.pathname.startsWith('/sessions/')).map(call => call.url.pathname);
    expect(sessionCalls.filter(path => path.endsWith(SESSION_B))).toHaveLength(1);
    expect(sessionCalls.filter(path => path.endsWith(SESSION_A))).toHaveLength(2);
    // Every request is to the fixed origin and signed by the application key.
    for (const call of calls) {
      expect(call.url.origin).toBe(ORIGIN);
      const [header, payload, signature] = call.authorization!.replace('Bearer ', '').split('.');
      expect(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(KEY.publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
      expect(JSON.parse(Buffer.from(header!, 'base64url').toString()).kid).toBe('app-0000-test');
    }
  });

  it('refuses missing, empty and malformed credentials before any request, with no fallback', async () => {
    const { fetchImpl } = stubApi();
    const gw = gateway(fetchImpl);
    const bad: Array<GatewayCallContext | undefined> = [
      undefined,
      {},
      { caller: 'x' },
      { credentials: undefined },
      { credentials: { sessionId: '', accountIds: [ACCOUNT_A1] } },
      { credentials: { sessionId: '   ', accountIds: [ACCOUNT_A1] } },
      { credentials: { sessionId: SESSION_A, accountIds: [] } },
      { credentials: { sessionId: SESSION_A, accountIds: [''] } },
      { credentials: { sessionId: SESSION_A } as never },
      { credentials: { accountIds: [ACCOUNT_A1] } as never },
      { credentials: { sessionId: SESSION_A, accountIds: ACCOUNT_A1 as never } },
      { credentials: { sessionId: `${SESSION_A}/../x`, accountIds: [ACCOUNT_A1] } },
      { credentials: { sessionId: SESSION_A, accountIds: [ACCOUNT_A1, 42 as never] } },
    ];
    for (const context of bad) {
      for (const [tool, input] of [['list_accounts', {}], ['get_balances', { account: ACCOUNT_A1 }]] as const) {
        const result = await gw.callTool(tool, input, context);
        expect(result.isError, JSON.stringify(context)).toBe(true);
        expect(text(result)).toMatch(/no Enable Banking consent/);
      }
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never reads the environment on the embedded path', async () => {
    const saved = { ...process.env };
    process.env.ENABLEBANKING_API_BASE_URL = 'https://env.example';
    process.env.ENABLEBANKING_APPLICATION_ID = 'env-app';
    process.env.ENABLEBANKING_COMPANY = 'zzz';
    try {
      const { calls, fetchImpl } = stubApi();
      const result = await gateway(fetchImpl).callTool('get_balances', { account: ACCOUNT_A1 }, ctxA);
      expect(result.isError).toBeUndefined();
      expect(calls.every(call => call.url.origin === ORIGIN)).toBe(true);
      expect(() => createEnableBankingGateway({ applicationId: '', privateKey: PEM })).toThrow(/applicationId is required/);
    } finally {
      process.env = saved;
    }
    for (const file of ['../src/gateway.ts', '../src/gateway/client.ts', '../src/gateway/catalog.ts', '../src/gateway/redact.ts']) {
      expect(readFileSync(new URL(file, import.meta.url), 'utf8')).not.toMatch(/process\.env|config-env|loadConfig/);
    }
  });

  it('refuses bad options at creation', () => {
    expect(() => createEnableBankingGateway({ applicationId: 'app-1', privateKey: '' })).toThrow(/privateKey is required/);
    expect(() => createEnableBankingGateway({ applicationId: 'app-1', privateKey: 'not a key' })).toThrow(/not a readable private key/);
    expect(() => createEnableBankingGateway({ applicationId: 'app-1', privateKey: PEM, apiBaseUrl: 'http://eb.test' })).toThrow(/https origin/);
    expect(() => createEnableBankingGateway({ applicationId: 'app-1', privateKey: PEM, apiBaseUrl: 'https://eb.test/api' })).toThrow(/https origin/);
    expect(() => createEnableBankingGateway({ applicationId: 'app-1', privateKey: PEM, timeoutMs: 0 })).toThrow(/timeoutMs/);
  });
});

describe('gateway: the account allowlist', () => {
  const tricks = [
    ACCOUNT_B1, // another company's account (and in another session)
    ACCOUNT_A1.toUpperCase(),
    ` ${ACCOUNT_A1}`,
    `${ACCOUNT_A1} `,
    encodeURIComponent(`${ACCOUNT_A1}/`),
    `${ACCOUNT_A1}%2F..%2F${ACCOUNT_B1}`,
    `${ACCOUNT_A1}/../${ACCOUNT_B1}`,
    `../accounts/${ACCOUNT_B1}`,
    `${ACCOUNT_A1}?x=1`,
    `${ACCOUNT_A1}#x`,
    ACCOUNT_A1.replace('a', 'ａ'),
    `${ACCOUNT_A1}\u0000`,
    '',
    '*',
  ];

  it.each(tricks)('refuses %j before any request', async account => {
    const { fetchImpl } = stubApi();
    const gw = gateway(fetchImpl);
    for (const tool of ['get_balances', 'list_transactions']) {
      const result = await gw.callTool(tool, { account }, ctxA);
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/not one of the accounts/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an allowed account that the bank session no longer contains', async () => {
    const { calls, fetchImpl } = stubApi();
    const context: GatewayCallContext = { credentials: { sessionId: SESSION_A, accountIds: [ACCOUNT_A1, ACCOUNT_B1] } };
    const result = await gateway(fetchImpl).callTool('get_balances', { account: ACCOUNT_B1 }, context);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/no longer covers/);
    expect(calls.map(call => call.url.pathname)).toEqual([`/sessions/${SESSION_A}`]);
  });

  it('refuses when the consent is expired or not authorised', async () => {
    for (const [status, validUntil, message] of [
      ['EXPIRED', '2027-05-01T00:00:00Z', /not active \(EXPIRED\)/],
      ['AUTHORIZED', '2026-11-01T00:00:00Z', /expired on 2026-11-01/],
    ] as const) {
      const { calls, fetchImpl } = stubApi({
        handle: call => (call.url.pathname.startsWith('/sessions/') ? json({ status, accounts: [ACCOUNT_A1], access: { valid_until: validUntil } }) : undefined),
      });
      const result = await gateway(fetchImpl).callTool('get_balances', { account: ACCOUNT_A1 }, ctxA);
      expect(text(result)).toMatch(message);
      expect(calls).toHaveLength(1);
    }
  });

  it('lists only allowed accounts that are in the session', async () => {
    const { calls, fetchImpl } = stubApi();
    const context: GatewayCallContext = { credentials: { sessionId: SESSION_A, accountIds: [ACCOUNT_A1, ACCOUNT_B1] } };
    const result = await gateway(fetchImpl).callTool('list_accounts', {}, context);
    const data = result.structuredContent as { accounts: Array<{ id: string; maskedIban: string }>; noLongerInConsent: number };
    expect(data.accounts.map(account => account.id)).toEqual([ACCOUNT_A1]);
    expect(data.accounts[0]!.maskedIban).toMatch(/^DK\d\d…\d{4}$/);
    expect(data.noLongerInConsent).toBe(1);
    expect(calls.some(call => call.url.pathname.includes(ACCOUNT_B1))).toBe(false);
    expect(calls.some(call => call.url.pathname.includes(ACCOUNT_A2))).toBe(false);
  });
});

describe('gateway: reads', () => {
  it('pages transactions with a token bound to account and period', async () => {
    const { calls, fetchImpl } = stubApi({
      handle: call => {
        // One page per call here, so the token is exercised.
        if (call.url.pathname.endsWith('/transactions') && !call.url.searchParams.get('continuation_key')) {
          return json({ transactions: [], continuation_key: 'k'.repeat(10) });
        }
        return undefined;
      },
    });
    const gw = gateway(fetchImpl);
    const first = await gw.callTool('list_transactions', { account: ACCOUNT_A1, from: '2026-11-01', to: '2026-11-10' }, ctxA);
    expect(first.isError).toBeUndefined();
    const query = calls.find(call => call.url.pathname.endsWith('/transactions'))!.url.searchParams;
    expect(query.get('date_from')).toBe('2026-11-01');
    expect(query.get('date_to')).toBe('2026-11-10');
    expect(query.get('transaction_status')).toBe('BOOK');
    const data = first.structuredContent as { transactions: Array<{ counterparty: string; amount: string }>; totals: unknown[] };
    expect(data.transactions).toHaveLength(1);
    expect(data.transactions[0]!.counterparty).toBe('Fiktiv Leverandør ApS');
    expect(data.transactions[0]!.amount).toBe('-100.00');

    const other = await gw.callTool('list_transactions', { account: ACCOUNT_A1, from: '2026-11-01', to: '2026-11-10', pageToken: 'bogus' }, ctxA);
    expect(text(other)).toMatch(/pageToken does not belong/);
  });

  it('stops after a bounded number of pages and continues from the token', async () => {
    let page = 0;
    const { calls, fetchImpl } = stubApi({
      handle: call =>
        call.url.pathname.endsWith('/transactions') ? json({ transactions: [], continuation_key: `key-${++page}` }) : undefined,
    });
    const gw = gateway(fetchImpl);
    const period = { account: ACCOUNT_A1, from: '2026-11-01', to: '2026-11-10' };
    const first = await gw.callTool('list_transactions', period, ctxA);
    expect(calls.filter(call => call.url.pathname.endsWith('/transactions'))).toHaveLength(5);
    const token = (first.structuredContent as { nextPageToken: string }).nextPageToken;
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);

    // The token works only with the same account and period.
    expect(text(await gw.callTool('list_transactions', { ...period, to: '2026-11-09', pageToken: token }, ctxA))).toMatch(/does not belong/);
    expect(text(await gw.callTool('list_transactions', { ...period, account: ACCOUNT_A2, pageToken: token }, ctxA))).toMatch(/does not belong/);

    calls.length = 0;
    await gw.callTool('list_transactions', { ...period, pageToken: token }, ctxA);
    const continued = calls.find(call => call.url.pathname.endsWith('/transactions'))!;
    expect(continued.url.searchParams.get('continuation_key')).toBe('key-5');
  });

  it('bounds the period and the dates', () => {
    const resolve = (input: Record<string, string>) => resolveEnableBankingReadTarget('list_transactions', { account: ACCOUNT_A1, ...input }, NOW);
    expect(resolve({ from: '2025-01-01', to: '2026-11-17' })).toMatchObject({ ok: false, reason: expect.stringMatching(/366 days/) });
    expect(resolve({ from: '2026-11-10', to: '2026-11-01' })).toMatchObject({ ok: false });
    expect(resolve({ from: '2026-02-30' })).toMatchObject({ ok: false });
    expect(resolve({ to: '2027-01-01' })).toMatchObject({ ok: false, reason: expect.stringMatching(/future/) });
    expect(resolve({})).toEqual({
      ok: true,
      target: { tool: 'list_transactions', exposure: 'transactions', account: ACCOUNT_A1, from: '2026-10-18', to: '2026-11-17', status: 'booked' },
    });
    expect(resolveEnableBankingReadTarget('get_balances', { account: ACCOUNT_A1, extra: 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/Unknown input/) });
    expect(resolveEnableBankingReadTarget('initiate_payment', {})).toMatchObject({ ok: false, reason: expect.stringMatching(/Unsupported/) });
  });

  it('refuses an oversized response and a redirect', async () => {
    const big = stubApi({ handle: call => (call.url.pathname.endsWith('/balances') ? json({ balances: [], pad: 'x'.repeat(5000) }) : undefined) });
    const result = await gateway(big.fetchImpl, { maxResponseBytes: 2048 }).callTool('get_balances', { account: ACCOUNT_A1 }, ctxA);
    expect(text(result)).toMatch(/more than 2048 bytes/);

    const redirect = stubApi({ handle: () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }) });
    const redirected = await gateway(redirect.fetchImpl).callTool('get_balances', { account: ACCOUNT_A1 }, ctxA);
    expect(text(redirected)).toMatch(/redirect/);
    expect(redirect.fetchImpl.mock.calls[0]![1]?.redirect).toBe('manual');
  });

  it('reports a timeout without identifiers', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      }),
    );
    const result = await gateway(fetchImpl, { timeoutMs: 1000 }).callTool('get_balances', { account: ACCOUNT_A1 }, ctxA);
    expect(text(result)).toMatch(/did not answer within 1 seconds/);
    expect(text(result)).not.toContain(SESSION_A);
  });
});

describe('gateway: redaction', () => {
  it('keeps session ids, account ids and key material out of errors', async () => {
    const leak = `session ${SESSION_A} account ${ACCOUNT_A1} key ${PEM} Bearer eyJabc.eyJdef.sig code=secret-code-123`;
    const { fetchImpl } = stubApi({
      handle: call => (call.url.pathname.endsWith('/balances') ? json({ error: 'ACCESS_DENIED', message: leak, detail: SESSION_A }, 403) : undefined),
    });
    const result = await gateway(fetchImpl).callTool('get_balances', { account: ACCOUNT_A1 }, ctxA);
    const message = text(result);
    expect(result.isError).toBe(true);
    expect(message).toMatch(/HTTP 403 \(ACCESS_DENIED\)/);
    for (const secret of [SESSION_A, ACCOUNT_A1, 'BEGIN PRIVATE KEY', PEM.split('\n')[1]!, 'eyJabc', 'secret-code-123']) {
      expect(message).not.toContain(secret);
    }
  });

  it('does not carry one call’s session id into another call’s redactor', async () => {
    // A thrown error that contains company A's session id in a non-UUID form is redacted by value
    // in A's call, which shows the per-call fork holds it; B's call is unaffected by A's values.
    const sessionA = 'session-of-company-a-0001';
    const sessionB = 'session-of-company-b-0002';
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error(`boom ${sessionA} ${sessionB}`);
    });
    const gw = gateway(fetchImpl);
    const a = await gw.callTool('list_accounts', {}, { credentials: { sessionId: sessionA, accountIds: [ACCOUNT_A1] } });
    // The client never repeats the cause of a network failure at all.
    expect(text(a)).toBe('Enable Banking could not be reached (GET /sessions/{session_id}).');

    const thrower = gateway(
      vi.fn<typeof fetch>(async () => json({ error: 'X', message: `seen ${sessionA} and ${sessionB}` }, 500)),
    );
    const resultA = text(await thrower.callTool('list_accounts', {}, { credentials: { sessionId: sessionA, accountIds: [ACCOUNT_A1] } }));
    const resultB = text(await thrower.callTool('list_accounts', {}, { credentials: { sessionId: sessionB, accountIds: [ACCOUNT_A1] } }));
    expect(resultA).not.toContain(sessionA);
    expect(resultA).toContain(sessionB);
    expect(resultB).not.toContain(sessionB);
    expect(resultB).toContain(sessionA);
  });
});

describe('gateway: catalog and surface', () => {
  it('is read-only and exports no payment surface', () => {
    for (const name of Object.keys(gatewayModule)) expect(name).not.toMatch(/pay|transfer|initiat/i);
    const gw = gateway(stubApi().fetchImpl);
    for (const name of Object.keys(gw)) expect(name).not.toMatch(/pay|transfer|initiat/i);
    for (const tool of gw.tools) expect(tool.name).not.toMatch(/pay|transfer|initiat/i);
    for (const entry of enableBankingToolCatalog) {
      expect(entry.riskLevel).toBe('read');
      expect(entry.broad).toBe(false);
      for (const op of entry.upstream) {
        expect(op).toMatchObject({ access: 'read', method: 'GET' });
        expect(op.path).not.toMatch(/payment/i);
      }
    }
    for (const endpoint of enableBankingServiceCatalog.endpoints) {
      expect(endpoint.pathTemplate).not.toMatch(/payment/i);
      if (endpoint.usedBy === 'tools') expect(endpoint.method).toBe('GET');
    }
    const sources = ['../src/gateway.ts', '../src/gateway/client.ts', '../src/gateway/catalog.ts'].map(file => readFileSync(new URL(file, import.meta.url), 'utf8'));
    for (const source of sources) expect(source).not.toMatch(/\/payments/);
  });

  it('is deeply frozen and marks what each tool exposes', () => {
    expect(Object.isFrozen(enableBankingToolCatalog)).toBe(true);
    expect(Object.isFrozen(enableBankingToolCatalog[0]!.upstream)).toBe(true);
    expect(Object.isFrozen(enableBankingServiceCatalog.endpoints[0])).toBe(true);
    expect(() => {
      (enableBankingToolCatalog[0] as { name: string }).name = 'x';
    }).toThrow();
    const byName = Object.fromEntries(enableBankingToolCatalog.map(entry => [entry.name, entry]));
    expect(Object.keys(byName)).toEqual(['list_accounts', 'get_balances', 'list_transactions']);
    expect(byName.get_balances).toMatchObject({ exposure: 'balances', transactionDetails: false });
    expect(byName.list_accounts).toMatchObject({ exposure: 'accounts', transactionDetails: false });
    expect(byName.list_transactions).toMatchObject({ exposure: 'transactions', transactionDetails: true });
    for (const entry of enableBankingToolCatalog) expect(entry.summary.length).toBeGreaterThan(10);
  });

  it('makes only the requests declared in each tool’s upstream', async () => {
    for (const entry of enableBankingToolCatalog) {
      const { calls, fetchImpl } = stubApi();
      const input: Record<string, string> = entry.name === "list_accounts" ? {} : { account: ACCOUNT_A1 };
      const result = await gateway(fetchImpl).callTool(entry.name, input, ctxA);
      expect(result.isError).toBeUndefined();
      const templates = entry.upstream.map(op => new RegExp(`^${op.path.replace(/\{[a-z_]+\}/g, '[A-Za-z0-9-]+')}$`));
      for (const call of calls) {
        expect(call.method).toBe('GET');
        expect(templates.some(template => template.test(call.url.pathname)), call.url.pathname).toBe(true);
      }
    }
  });
});

describe('consent helpers', () => {
  const ASPSPS = {
    aspsps: [
      { name: 'Opdigtet Bank', country: 'DK', bic: 'OPDIDKKK', psu_types: ['business', 'personal'], maximum_consent_validity: 15_552_000 },
      { name: 'Fiktiv Sparekasse', country: 'DK', psu_types: ['business'], beta: true },
    ],
  };

  function consentApi(extra: (call: Call) => Response | undefined = () => undefined) {
    return stubApi({
      handle: call => {
        const custom = extra(call);
        if (custom) return custom;
        if (call.url.pathname === '/aspsps') return json(ASPSPS);
        if (call.url.pathname === '/auth') return json({ url: 'https://bank.example/authorize?x=1', authorization_id: 'auth-1' });
        if (call.url.pathname === '/sessions' && call.method === 'POST') {
          return json({
            session_id: SESSION_A,
            aspsp: { name: 'Opdigtet Bank', country: 'DK' },
            psu_type: 'business',
            access: { valid_until: '2027-05-16T09:55:00+00:00' },
            accounts: [
              { uid: ACCOUNT_A1, name: 'Driftskonto', currency: 'DKK', account_id: { iban: dkIban('54700001234567') } },
              { uid: ACCOUNT_A2, currency: 'EUR', all_account_ids: [{ scheme_name: 'IBAN', identification: dkIban('54700007654321') }] },
              { name: 'no uid', currency: 'DKK' },
            ],
          });
        }
        if (call.method === 'DELETE') return json({ message: 'OK' });
        return undefined;
      },
    });
  }

  it('lists banks for a country, DK by default', async () => {
    const { calls, fetchImpl } = consentApi();
    const banks = await gateway(fetchImpl).listBanks();
    expect(calls[0]!.url.searchParams.get('country')).toBe('DK');
    expect(calls[0]!.url.searchParams.get('psu_type')).toBe('business');
    expect(banks[0]).toEqual({ name: 'Opdigtet Bank', country: 'DK', bic: 'OPDIDKKK', psuTypes: ['business', 'personal'], maximumConsentDays: 180, beta: false });
    expect(banks[1]).toMatchObject({ maximumConsentDays: null, beta: true });
    await expect(gateway(fetchImpl).listBanks({ country: 'Denmark' })).rejects.toThrow(/two-letter/);
  });

  it('starts an authorization within the bank’s maximum', async () => {
    const { calls, fetchImpl } = consentApi();
    const gw = gateway(fetchImpl);
    const state = 'state-0123456789abcdef';
    const started = await gw.startAuthorization({ bank: 'Opdigtet Bank', redirectUrl: 'https://app.example/forbind/bank', state, language: 'da' });
    expect(started.url).toBe('https://bank.example/authorize?x=1');
    expect(started.maximumConsentDays).toBe(180);
    const auth = calls.find(call => call.url.pathname === '/auth')!;
    expect(auth.method).toBe('POST');
    expect(auth.body).toEqual({
      access: { valid_until: new Date(NOW + 15_552_000_000 - 300_000).toISOString() },
      aspsp: { name: 'Opdigtet Bank', country: 'DK' },
      state,
      redirect_url: 'https://app.example/forbind/bank',
      psu_type: 'business',
      language: 'da',
    });

    await expect(
      gw.startAuthorization({ bank: 'Opdigtet Bank', redirectUrl: 'https://app.example/r', state, validUntil: new Date(NOW + 181 * 86_400_000) }),
    ).rejects.toThrow(/maximum of 180 days/);
    // A bank that does not state a maximum gets 90 days at most.
    await expect(
      gw.startAuthorization({ bank: 'Fiktiv Sparekasse', redirectUrl: 'https://app.example/r', state, validUntil: new Date(NOW + 91 * 86_400_000) }),
    ).rejects.toThrow(/maximum of 90 days/);
    await expect(gw.startAuthorization({ bank: 'Ukendt Bank', redirectUrl: 'https://app.example/r', state })).rejects.toThrow(/no bank named/);
    await expect(gw.startAuthorization({ bank: 'Opdigtet Bank', redirectUrl: 'http://app.example/r', state })).rejects.toThrow(/https/);
    await expect(gw.startAuthorization({ bank: 'Opdigtet Bank', redirectUrl: 'https://app.example/r', state: 'short' })).rejects.toThrow(/state/);
    const notHttps = consentApi(call => (call.url.pathname === '/auth' ? json({ url: 'javascript:alert(1)' }) : undefined));
    await expect(gateway(notHttps.fetchImpl).startAuthorization({ bank: 'Opdigtet Bank', redirectUrl: 'https://app.example/r', state })).rejects.toThrow(/https address/);
  });

  it('completes a session with ids, names, masked IBANs and currency', async () => {
    const { calls, fetchImpl } = consentApi();
    const done = await gateway(fetchImpl).completeSession({ code: 'code-0000-1111' });
    expect(calls[0]!.body).toEqual({ code: 'code-0000-1111' });
    expect(done).toEqual({
      sessionId: SESSION_A,
      validUntil: '2027-05-16T09:55:00+00:00',
      bank: { name: 'Opdigtet Bank', country: 'DK' },
      psuType: 'business',
      accounts: [
        { id: ACCOUNT_A1, name: 'Driftskonto', maskedIban: expect.stringMatching(/^DK\d\d…4567$/), currency: 'DKK' },
        { id: ACCOUNT_A2, name: null, maskedIban: expect.stringMatching(/^DK\d\d…4321$/), currency: 'EUR' },
      ],
      accountsWithoutId: 1,
    });
    for (const account of done.accounts) expect(JSON.stringify(account)).not.toMatch(/54700001234567|54700007654321/);
  });

  it('never puts the code, the session id or the key in an error', async () => {
    const code = 'very-secret-code-4242';
    const failing = consentApi(call =>
      call.url.pathname.startsWith('/sessions')
        ? json({ error: 'WRONG_CODE', message: `code ${code} for ${SESSION_B} rejected; key ${PEM}` }, 400)
        : undefined,
    );
    const gw = gateway(failing.fetchImpl);
    const error = await gw.completeSession({ code }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(gatewayModule.EnableBankingGatewayError);
    expect((error as Error).message).toMatch(/HTTP 400 \(WRONG_CODE\)/);
    expect((error as { status: number }).status).toBe(400);
    expect((error as Error).cause).toBeUndefined();
    for (const secret of [code, SESSION_B, 'PRIVATE KEY']) expect((error as Error).message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(code);

    const ended = await gw.endSession({ sessionId: 'session-not-a-uuid-xyz' }).catch((e: unknown) => e);
    expect((ended as Error).message).not.toContain('session-not-a-uuid-xyz');
    await expect(gw.completeSession({ code: 'has space' })).rejects.toThrow(/malformed/);
  });

  it('reads the status of a session and ends it', async () => {
    const { calls, fetchImpl } = consentApi();
    const gw = gateway(fetchImpl);
    expect(await gw.sessionStatus({ sessionId: SESSION_A })).toEqual({
      status: 'AUTHORIZED',
      validUntil: '2027-05-01T00:00:00+00:00',
      accountIds: [ACCOUNT_A1, ACCOUNT_A2],
    });
    await gw.endSession({ sessionId: SESSION_A });
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE' });
    expect(calls.at(-1)!.url.pathname).toBe(`/sessions/${SESSION_A}`);
    await expect(gw.endSession({ sessionId: '../aspsps' })).rejects.toThrow(/malformed/);
  });
});
