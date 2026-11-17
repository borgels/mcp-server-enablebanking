// One property, proved through every channel at once: no piece of the instance's private key (six characters or
// more of its content) reaches a host result or a thrown error, and the call's session id is not repeated. Enable
// Banking echoes the key whole (with its line breaks, so its JSON-escaped form differs), without its armour, in
// pieces and in object keys: in successful answers, error bodies, an over-limit body, a redirect's Location, a
// network failure, the session status, and the consent helpers' answers; the host's options and input carry it too.
// The gateway has no audit channel of its own: the host logs.
import { describe, expect, it, vi } from 'vitest';
import { createEnableBankingGateway, type GatewayCallContext } from '../src/gateway.js';
import { FRAGMENT_LENGTH } from '../src/gateway/redact.js';
import { KEY } from './helpers.js';

const PEM = KEY.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CONTENT = PEM.replace(/-----(BEGIN|END) [A-Z ]*-----/g, '').replace(/\s+/g, '');
const PIECE = CONTENT.slice(100, 140);
const ORIGIN = 'https://eb.test';
const NOW = Date.parse('2026-11-17T10:00:00Z');
const SESSION = '33333333-cccc-4ccc-8ccc-333333333333';
const ACCOUNT = 'c1c1c1c1-0000-4000-8000-00000000c001';
const ctx: GatewayCallContext = { caller: 'person-c', requestId: 'r-c', credentials: { sessionId: SESSION, accountIds: [ACCOUNT] } };

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(entry => strings(entry, out));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      out.push(key);
      strings(entry, out);
    }
  }
  return out;
}

/** The pieces of the key's content found anywhere in `value`, raw or serialised, and whether the session id is. */
function leaks(value: unknown): string[] {
  const texts = [...strings(value), JSON.stringify(value) ?? ''];
  const found = new Set<string>();
  for (let i = 0; i + FRAGMENT_LENGTH <= CONTENT.length; i += 1) {
    const piece = CONTENT.slice(i, i + FRAGMENT_LENGTH);
    if (texts.some(text => text.includes(piece))) found.add(piece);
  }
  if (texts.some(text => text.includes(SESSION))) found.add('session id');
  return [...found];
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const echoed = { [PEM]: CONTENT, [`k ${PIECE}`]: [PEM, `${PIECE} ${SESSION}`] };

const session = (extra: Record<string, unknown> = {}) =>
  json({ status: 'AUTHORIZED', accounts: [ACCOUNT], access: { valid_until: '2027-05-01T00:00:00Z' }, ...extra });

/** Enable Banking stand-ins: each answers the reads of every tool through one channel. */
const CHANNELS: Record<string, (url: URL) => Response> = {
  echo: url => {
    if (url.pathname.startsWith('/sessions/')) return session({ note: PEM });
    if (url.pathname.endsWith('/details')) return json({ name: PIECE, product: `${SESSION}`, currency: PIECE.slice(0, 12), ...echoed });
    if (url.pathname.endsWith('/balances')) {
      return json({ balances: [{ balance_type: PIECE, name: PEM, balance_amount: { currency: PIECE, amount: PEM }, ...echoed }] });
    }
    return json({
      transactions: [
        {
          entry_reference: PIECE,
          transaction_amount: { currency: PIECE, amount: CONTENT },
          credit_debit_indicator: 'DBIT',
          status: 'BOOK',
          booking_date: PIECE,
          creditor: { name: PEM },
          remittance_information: [PEM, PIECE, SESSION],
          bank_transaction_code: { description: JSON.stringify(PEM) },
          ...echoed,
        },
      ],
      continuation_key: null,
    });
  },
  errorBody: url =>
    url.pathname.startsWith('/sessions/') ? session() : json({ error: PIECE, code: PEM, message: PEM, detail: `${CONTENT} ${SESSION}` }, 400),
  sessionError: () => json({ error: 'ACCESS_DENIED', message: `${PEM} ${SESSION}` }, 403),
  overLimit: url =>
    url.pathname.startsWith('/sessions/')
      ? session()
      : new Response(`${' '.repeat(70_000)}${PEM}`, { status: 500, headers: { 'Content-Type': 'text/plain' } }),
  bigAnswer: url => (url.pathname.startsWith('/sessions/') ? session() : json({ pad: 'x'.repeat(5_000), name: PEM })),
  redirect: () => new Response(null, { status: 302, headers: { location: `https://elsewhere.test/${PIECE}?k=${CONTENT}&s=${SESSION}` } }),
  network: () => {
    throw new TypeError(`fetch failed ${PEM} ${SESSION}`, { cause: Object.assign(new Error(PIECE), { code: PIECE }) });
  },
  notJson: url => (url.pathname.startsWith('/sessions/') ? session() : new Response(`${PEM}`, { status: 200 })),
  inactive: () => json({ status: PIECE, accounts: [ACCOUNT], access: { valid_until: `${PIECE} ${PEM}` } }),
  expiredOddDate: () => json({ status: 'AUTHORIZED', accounts: [ACCOUNT], access: { valid_until: `2020-01-01T00:00:00Z ${PIECE}` } }),
};

function gatewayWith(channel: (url: URL) => Response, extra: Record<string, unknown> = {}) {
  const fetchImpl = vi.fn<typeof fetch>(async input => channel(new URL(String(input))));
  return createEnableBankingGateway({
    applicationId: 'app-0000-test',
    privateKey: PEM,
    apiBaseUrl: ORIGIN,
    fetchImpl,
    now: () => NOW,
    maxResponseBytes: 4_096,
    ...extra,
  });
}

describe('no piece of the key leaves an instance', () => {
  it('holds for every channel: results of every tool, and errors', async () => {
    const results: unknown[] = [];
    for (const [name, channel] of Object.entries(CHANNELS)) {
      for (const extra of [{}, { privateKey: KEY.privateKey }]) {
        const gateway = gatewayWith(channel, name === 'bigAnswer' ? {} : { maxResponseBytes: 1024 * 1024, ...extra });
        results.push(await gateway.callTool('list_accounts', {}, ctx));
        results.push(await gateway.callTool('get_balances', { account: ACCOUNT }, ctx));
        results.push(await gateway.callTool('list_transactions', { account: ACCOUNT, from: '2026-11-01', to: '2026-11-17' }, ctx));
      }
    }
    // The host's own input, through the tool name, the field names and the credentials.
    const gateway = gatewayWith(CHANNELS.echo!);
    results.push(
      await gateway.callTool(`list_accounts ${PEM}`, {}, ctx),
      await gateway.callTool('get_balances', { account: ACCOUNT, [PEM]: 1, [PIECE]: 2 }, ctx),
      await gateway.callTool('get_balances', { account: PIECE }, ctx),
      await gateway.callTool('list_transactions', { account: ACCOUNT, from: PIECE }, ctx),
      await gateway.callTool('list_transactions', { account: ACCOUNT, pageToken: `${PIECE}.${PIECE}` }, ctx),
      await gateway.callTool('list_accounts', {}, { credentials: { sessionId: PIECE, accountIds: [PEM] } }),
    );

    expect(results.length).toBeGreaterThan(50);
    expect(leaks(results)).toEqual([]);
    // The echoing answers really were read: the data that is not the key is still there.
    expect(JSON.stringify(results)).toContain(ACCOUNT);
  });

  it('holds for the consent helpers', async () => {
    const errors: unknown[] = [];
    const answers: unknown[] = [];
    for (const channel of Object.values(CHANNELS)) {
      const gateway = gatewayWith(url => (url.pathname === '/aspsps' ? json({ aspsps: [{ name: 'Opdigtet Bank', country: 'DK' }] }) : channel(url)));
      const attempts: Array<() => Promise<unknown>> = [
        () => gateway.listBanks({ country: 'DK' }),
        () => gateway.startAuthorization({ bank: 'Opdigtet Bank', redirectUrl: 'https://host.test/retur', state: 'state-0123456789abcdef' }),
        () => gateway.startAuthorization({ bank: PEM, redirectUrl: `https://host.test/${PIECE}`, state: PIECE.replace(/[^A-Za-z0-9]/g, 'x') }),
        () => gateway.completeSession({ code: 'code-0123456789' }),
        () => gateway.sessionStatus({ sessionId: SESSION }),
        () => gateway.endSession({ sessionId: SESSION }),
      ];
      for (const attempt of attempts) {
        try {
          answers.push(await attempt());
        } catch (error) {
          errors.push({ message: (error as Error).message, ...(error as object) });
        }
      }
    }
    expect(errors.length).toBeGreaterThan(20);
    expect(leaks(errors)).toEqual([]);
    expect(answers.length).toBeGreaterThan(10);
    expect(leaks(answers)).toEqual([]);
  });

  it('holds for errors about the options', () => {
    const messages: string[] = [];
    for (const options of [
      { apiBaseUrl: `https://eb.test/${PIECE}` },
      { apiBaseUrl: `not a url ${PEM}` },
      { privateKey: `${PEM.slice(0, 200)}${PIECE}` },
      { privateKey: PIECE },
      { applicationId: PEM },
      { timeoutMs: Number.NaN },
    ]) {
      try {
        createEnableBankingGateway({ applicationId: 'app-0000-test', privateKey: PEM, ...options });
      } catch (error) {
        messages.push((error as Error).message);
      }
    }
    expect(messages).toHaveLength(6);
    expect(leaks(messages)).toEqual([]);
  });
});

describe('numbers', () => {
  it('redacts a numeric session id echoed as a number, and the result stays valid JSON', async () => {
    const NUMERIC = '12345678';
    const gateway = gatewayWith(url =>
      url.pathname.startsWith('/sessions/')
        ? json({ status: 'AUTHORIZED', accounts: [ACCOUNT], access: { valid_until: '2027-05-01T00:00:00Z' } })
        : json({ balances: [{ balance_type: 'CLBD', name: Number(NUMERIC), balance_amount: { currency: 'DKK', amount: Number(NUMERIC) } }] }),
    );
    const result = await gateway.callTool('get_balances', { account: ACCOUNT }, { credentials: { sessionId: NUMERIC, accountIds: [ACCOUNT] } });
    expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
    const serialised = JSON.stringify(result);
    expect(JSON.parse(serialised)).toEqual(result);
    expect(serialised).not.toContain(NUMERIC);
    expect(result.structuredContent).toMatchObject({ balances: [{ name: '‹redacted›', amount: '‹redacted›' }] });
  });
});

describe('round 5 of the threat model', () => {
  const failing = (status: number) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(Object.assign(new Error(`Vendor diagnostic ${PIECE.slice(0, 5)}`), { status: 500, code: 'VENDOR_UNLISTED' }));
        },
      }),
      { status, headers: { 'Content-Type': 'application/json' } },
    );

  it('does not encode a continuation key that holds the key or the session id into a page token', async () => {
    for (const continuation of [PIECE, `page-${SESSION}`]) {
      const gateway = gatewayWith(url =>
        url.pathname.startsWith('/sessions/')
          ? session()
          : json({
              transactions: [{ entry_reference: 'r1', transaction_amount: { currency: 'DKK', amount: '1.00' }, status: 'BOOK', booking_date: '2026-11-02' }],
              continuation_key: continuation,
            }),
      );
      const result = await gateway.callTool('list_transactions', { account: ACCOUNT, from: '2026-11-01', to: '2026-11-17' }, ctx);
      expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ incomplete: true });
      expect(result.structuredContent).not.toHaveProperty('nextPageToken');
      expect(leaks(result)).toEqual([]);
    }
  });

  it('keeps only the status of a failure reported inside an answer', async () => {
    const gateway = gatewayWith(url =>
      url.pathname.startsWith('/sessions/')
        ? session()
        : json({
            balances: [
              {
                balance_type: 'CLBD',
                balance_amount: { currency: 'DKK', amount: { status: 500, error: 'Vendor text', message: 'Vendor message', code: 'VENDOR' } },
              },
            ],
          }),
    );
    const result = await gateway.callTool('get_balances', { account: ACCOUNT }, ctx);
    expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      balances: [{ amount: { status: 500, error: 'Enable Banking reported a failure with HTTP 500.' } }],
    });
    expect(JSON.stringify(result)).not.toContain('Vendor');
  });

  it('gives our own text when an answer or an error body cannot be read', async () => {
    for (const status of [200, 401, 500]) {
      const gateway = gatewayWith(url => (url.pathname.startsWith('/sessions/') ? session() : failing(status)));
      const result = await gateway.callTool('get_balances', { account: ACCOUNT }, ctx);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('Vendor');
      expect(JSON.stringify(result)).not.toContain(PIECE.slice(0, 5));
      if (status !== 200) expect(result.content[0]?.text).toContain(`HTTP ${status}`);
    }
    const helperError = await gatewayWith(() => failing(200))
      .completeSession({ code: 'code-0123456789' })
      .then(
        () => ({ message: 'no error' }) as { message: string; status?: number; code?: string },
        (error: unknown) => error as { message: string; status?: number; code?: string },
      );
    expect(helperError.message).not.toContain('Vendor');
    expect(helperError.status).toBeUndefined();
    expect(helperError.code).toBeUndefined();
  });
});
