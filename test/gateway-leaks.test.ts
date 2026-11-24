// One property, proved through every channel at once: no piece of the instance's private key (six characters or
// more of its content) reaches a host result or a thrown error, and the call's session id is not repeated. Enable
// Banking echoes the key whole (with its line breaks, so its JSON-escaped form differs), without its armour, in
// pieces and in object keys: in successful answers, error bodies, an over-limit body, a redirect's Location, a
// network failure, the session status, and the consent helpers' answers; the host's options and input carry it too.
// The gateway has no audit channel of its own: the host logs.
import { describe, expect, it, vi } from 'vitest';
import { createEnableBankingGateway, type GatewayCallContext } from '../src/gateway.js';
import { FRAGMENT_LENGTH } from '../src/gateway/redact.js';
import { KEY, dkIban } from './helpers.js';

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
        results.push(await gateway.callTool('get_account_details', { account: ACCOUNT }, ctx));
        results.push(await gateway.callTool('get_transaction_details', { account: ACCOUNT, transaction: 'tx-0001' }, ctx));
        results.push(await gateway.callTool('summarize_transactions', { account: ACCOUNT, from: '2026-11-01', to: '2026-11-17' }, ctx));
        results.push(await gateway.callTool('search_transactions', { query: PIECE.slice(0, 20), from: '2026-11-01', to: '2026-11-17' }, ctx));
        results.push(await gateway.callTool('list_transactions', { account: ACCOUNT, strategy: 'longest' }, ctx));
        // The host's own notes about the account, and its account of who is present, carry the key too.
        const noted = { ...ctx, credentials: { ...ctx.credentials!, accounts: [{ id: ACCOUNT, name: PIECE, maskedIban: PEM, currency: PIECE, product: CONTENT }] } };
        results.push(await gateway.callTool('list_accounts', {}, noted));
        results.push(await gateway.callTool('get_balances', { account: ACCOUNT }, { ...ctx, psu: { userAgent: PIECE, ipAddress: '192.0.2.10' } }));
        results.push(await gateway.callTool('get_balances', { account: ACCOUNT }, { ...ctx, unattended: true }));
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
        () => gateway.startAuthorization({ country: 'DK', bank: 'Opdigtet Bank', redirectUrl: 'https://host.test/retur', state: 'state-0123456789abcdef' }),
        () => gateway.startAuthorization({ country: 'DK', bank: PEM, redirectUrl: `https://host.test/${PIECE}`, state: PIECE.replace(/[^A-Za-z0-9]/g, 'x') }),
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
    const NUMERIC = '1234567890123456';
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
    // A value from the bank that is not a text is not passed on at all.
    expect(result.structuredContent).toMatchObject({ balances: [{ name: null, amount: '' }] });

    // Echoed as a text, it is redacted.
    const echoing = gatewayWith(url =>
      url.pathname.startsWith('/sessions/')
        ? json({ status: 'AUTHORIZED', accounts: [ACCOUNT], access: { valid_until: '2027-05-01T00:00:00Z' } })
        : json({ balances: [{ balance_type: 'CLBD', name: `Konto ${NUMERIC}`, balance_amount: { currency: 'DKK', amount: '12.00' } }] }),
    );
    const echoed = await echoing.callTool('get_balances', { account: ACCOUNT }, { credentials: { sessionId: NUMERIC, accountIds: [ACCOUNT] } });
    expect(JSON.stringify(echoed)).not.toContain(NUMERIC);
    expect(echoed.structuredContent).toMatchObject({ balances: [{ name: 'Konto ‹redacted›', amount: '12.00' }] });
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

  it('keeps a continuation key that holds the key or the session id inside the gateway: the page token is opaque', async () => {
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
      expect(result.structuredContent).not.toHaveProperty('incomplete');
      expect((result.structuredContent as { nextPageToken: string }).nextPageToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
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
    // The failure is reduced to its status by the client, and an amount that is not a decimal text is then not shown.
    expect(result.structuredContent).toMatchObject({ balances: [{ amount: '' }] });
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

describe('round 7: the sink check', () => {
  const sessionPieces = (sessionId: string) => {
    const out: string[] = [];
    for (let i = 0; i + 6 <= sessionId.length; i += 1) out.push(sessionId.slice(i, i + 6));
    return out;
  };

  /** Results of a normal session with this session id, or the refusal; and the pieces of it that leaked. */
  async function runSession(sessionId: string): Promise<{ refused?: Error; leaked: string[]; outputs: unknown[] }> {
    const gateway = gatewayWith(url =>
      url.pathname.startsWith('/sessions/')
        ? json({ status: 'AUTHORIZED', accounts: [ACCOUNT], access: { valid_until: '2027-05-01T00:00:00Z' } })
        : url.pathname.endsWith('/details')
          ? json({ name: 'Driftskonto', currency: 'DKK', product: 'Erhvervskonto' })
          : json({ balances: [{ balance_type: 'CLBD', balance_amount: { currency: 'DKK', amount: '1250.00' } }] }),
    );
    const call = { credentials: { sessionId, accountIds: [ACCOUNT] } };
    // The tool list counts for a session that is used; a refused one is used for nothing.
    const outputs: unknown[] = [];
    let refused: Error | undefined;
    try {
      outputs.push(
        await gateway.callTool('list_accounts', {}, call),
        await gateway.callTool('get_balances', { account: ACCOUNT }, call),
        await gateway.callTool('list_transactions', { account: ACCOUNT, from: 'x' }, call),
      );
      outputs.push(gateway.tools);
    } catch (error) {
      refused = error as Error;
      outputs.push(refused.message, refused.name, refused.stack ?? '');
    }
    const texts = outputs.map(output => (typeof output === 'string' ? output : JSON.stringify(output)));
    const raw = outputs.flatMap(output => (typeof output === 'string' ? [output] : JSON.stringify(output) ?? ''));
    const leaked = sessionPieces(sessionId).filter(piece => [...texts, ...raw].some(text => text.includes(piece)));
    return { ...(refused ? { refused } : {}), leaked, outputs };
  }

  it('refuses a session id that shares a piece with a fixed field, as an error that repeats none of it', async () => {
    const { refused, leaked } = await runSession('Zq7pX2visError9mWb4TnR');
    expect(refused?.message).toMatch(/cannot be used safely|…/);
    expect(leaked).toEqual([]);
  });

  it('refuses a key text that is not printable ASCII before anything is built from it', () => {
    for (const privateKey of [`${PEM}\uD800`, `${PEM.slice(0, 40)}é${PEM.slice(40)}`]) {
      let message = '';
      try {
        createEnableBankingGateway({ applicationId: 'app-0000-test', privateKey });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/key was refused/);
      expect(message).not.toMatch(/URI malformed/);
      expect(leaks(message)).toEqual([]);
    }
  });

  it('holds for session ids spliced from the outputs of a normal session', async () => {
    const base = await runSession('11111111-aaaa-4aaa-8aaa-111111111111');
    expect(base.refused).toBeUndefined();
    const texts = base.outputs.map(output => (typeof output === 'string' ? output : JSON.stringify(output) ?? ''));
    let seed = 17;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const filler = (n: number) => Array.from({ length: n }, () => ALPHABET[random(ALPHABET.length)]).join('');
    let tried = 0;
    for (let round = 0; round < 200 && tried < 30; round += 1) {
      const text = texts[random(texts.length)]!;
      const start = random(Math.max(1, text.length - 5));
      const window = text.slice(start, start + 6);
      if (!/^[A-Za-z0-9-]{6}$/.test(window)) continue;
      tried += 1;
      const sessionId = `${filler(6)}${window}${filler(6)}`;
      const { leaked } = await runSession(sessionId);
      expect(leaked, sessionId).toEqual([]);
    }
    expect(tried).toBeGreaterThan(0);
  });

  it('replaces texts in a failure list inside an amount', async () => {
    const gateway = gatewayWith(url =>
      url.pathname.startsWith('/sessions/')
        ? session()
        : json({ balances: [{ balance_amount: { amount: { failures: ['Leverandørens interne fejltekst'] } } }] }),
    );
    const result = await gateway.callTool('get_balances', { account: ACCOUNT }, ctx);
    expect(JSON.stringify(result)).not.toContain('Leverand');
  });
});

describe('round 8', () => {
  /** A piece of the key content that can be part of a function name. */
  const NAME_PIECE = (() => {
    for (let i = 0; i + 6 <= CONTENT.length; i += 1) {
      const piece = CONTENT.slice(i, i + 6);
      if (/^[A-Za-z][A-Za-z0-9]{5}$/.test(piece)) return piece;
    }
    throw new Error('no usable piece');
  })();

  /** Runs `work` inside a function whose name holds a piece of the key, so a raw stack would name it. */
  function inNamedFunction<T>(work: () => T): T {
    const name = `call${NAME_PIECE}`;
    const holder = { [name]: () => work() };
    return holder[name]!();
  }

  function expectFinalForm(error: Error): void {
    const stack = String(error.stack);
    expect(stack).toBe(`${error.name}: ${error.message}`);
    expect(stack).not.toMatch(/\n\s+at /);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(leaks([stack, error.message, error.name])).toEqual([]);
  }

  it('throws construction errors in final form, also from a caller whose name holds a piece of the key', () => {
    let caught: Error | undefined;
    try {
      inNamedFunction(() => createEnableBankingGateway({ applicationId: 'app-0000-test', privateKey: PEM, timeoutMs: 0 }));
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expectFinalForm(caught!);
  });

  it('throws consent-helper errors in final form', async () => {
    const gateway = gatewayWith(() => json({ error: 'X', message: 'no' }, 500));
    let caught: Error | undefined;
    try {
      await inNamedFunction(() => gateway.listBanks({ country: 'DK' }));
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expectFinalForm(caught!);
  });

  it('reduces every element of a failure list, whatever its fields, also below a wrapper', async () => {
    const gateway = gatewayWith(url =>
      url.pathname.startsWith('/sessions/')
        ? session()
        : json({
            balances: [
              { balance_type: 'CLBD', balance_amount: { currency: 'DKK', amount: { data: { failures: [{ reason: 'Leverandørens interne fejltekst' }] } } } },
            ],
          }),
    );
    const result = await gateway.callTool('get_balances', { account: ACCOUNT }, ctx);
    expect(JSON.stringify(result)).not.toContain('Leverand');
  });
});

describe('round 9: consent helpers', () => {
  const NAME_PIECE = (() => {
    for (let i = 0; i + 6 <= CONTENT.length; i += 1) {
      const piece = CONTENT.slice(i, i + 6);
      if (/^[A-Za-z][A-Za-z0-9]{5}$/.test(piece)) return piece;
    }
    throw new Error('no usable piece');
  })();

  /** Runs `work` inside a function whose name holds a piece of the key, so a raw stack would name it. */
  async function caughtIn(work: () => Promise<unknown>): Promise<Error> {
    const name = `call${NAME_PIECE}`;
    const holder = { [name]: () => work() };
    try {
      await holder[name]!();
    } catch (error) {
      return error as Error;
    }
    throw new Error('no error');
  }

  it('checks every helper input before encoding it, and throws every error in final form', async () => {
    const gateway = gatewayWith(() => json({ error: 'X', message: 'no' }, 500));
    const LONE = '12345678\uD800';
    const errors = [
      await caughtIn(() => gateway.completeSession({ code: LONE })),
      await caughtIn(() => gateway.sessionStatus({ sessionId: LONE })),
      await caughtIn(() => gateway.endSession({ sessionId: LONE })),
      await caughtIn(() =>
        gateway.startAuthorization({ country: 'DK', bank: 'Fiktiv Bank', redirectUrl: 'https://example.test/return', state: `state-${LONE}-0123456789` }),
      ),
      await caughtIn(() => gateway.listBanks({ country: 'DK' })),
      await caughtIn(() => gateway.completeSession({ code: 'code-0123456789' })),
      await caughtIn(() => gateway.sessionStatus({ sessionId: '11111111-aaaa-4aaa-8aaa-111111111111' })),
      await caughtIn(() => gateway.endSession({ sessionId: '11111111-aaaa-4aaa-8aaa-111111111111' })),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      const stack = String(error.stack);
      expect(stack).toBe(`${error.name}: ${error.message}`);
      expect(stack).not.toMatch(/\n\s+at /);
      expect(stack).not.toMatch(/URI malformed/);
      expect((error as { cause?: unknown }).cause).toBeUndefined();
      expect(stack).not.toContain(NAME_PIECE);
      expect(leaks([stack, error.message, error.name])).toEqual([]);
    }
    expect(errors.slice(0, 4).map(error => error.message)).toEqual(Array(4).fill('Refused: a state, code or session id must be printable ASCII.'));
  });
});

describe('round 10', () => {
  it('refuses a key object that cannot be exported or exports no content, never running without a secret', () => {
    const throwing = { type: 'private', asymmetricKeyType: 'rsa', export: () => { throw new Error(`export failed ${PIECE}`); } };
    const empty = { type: 'private', asymmetricKeyType: 'rsa', export: () => '' };
    for (const privateKey of [throwing, empty]) {
      let caught: Error | undefined;
      try {
        createEnableBankingGateway({ applicationId: 'app-0000-test', privateKey: privateKey as never });
      } catch (error) {
        caught = error as Error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught!.message).toMatch(/key was refused/);
      expect(String(caught!.stack)).toBe(`${caught!.name}: ${caught!.message}`);
      expect(leaks([caught!.message, String(caught!.stack)])).toEqual([]);
    }
  });

  it('refuses a session id as an error that holds no piece of it or of the key, in any field', async () => {
    const gateway = gatewayWith(() => json({ status: 'AUTHORIZED', accounts: [ACCOUNT] }));
    for (const sessionId of ['Zq7pX2visError9mWb4TnR', 'EnableBankingGatewayErrorZq7pX2']) {
      let caught: Error | undefined;
      try {
        await gateway.callTool('list_accounts', {}, { credentials: { sessionId, accountIds: [ACCOUNT] } });
      } catch (error) {
        caught = error as Error;
      }
      expect(caught, sessionId).toBeInstanceOf(Error);
      const fields = [caught!.name, caught!.message, String(caught!.stack), JSON.stringify(caught)];
      for (let i = 0; i + 6 <= sessionId.length; i += 1) {
        for (const field of fields) expect(field, sessionId).not.toContain(sessionId.slice(i, i + 6));
      }
    }
  });
});

describe('round 11', () => {
  it('keeps a session id returned by completeSession in the final seal and sink check of the call', async () => {
    const RETURNED = 'EnableBankingGatewayErrorZq7pX2';
    const gateway = gatewayWith(url => (url.pathname === '/sessions' ? json({ session_id: RETURNED, accounts: [] }) : json({}, 404)));
    let caught: Error | undefined;
    try {
      await gateway.completeSession({ code: 'code-0123456789' });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    const fields = [caught!.name, caught!.message, String(caught!.stack), JSON.stringify(caught)];
    for (let i = 0; i + 6 <= RETURNED.length; i += 1) {
      for (const field of fields) expect(field).not.toContain(RETURNED.slice(i, i + 6));
    }
    expect(String(caught!.stack)).toBe(`${caught!.name}: ${caught!.message}`);
    expect(leaks(fields)).toEqual([]);
  });
});

describe('round 14', () => {
  it('ends in the ultimate fallback when masking could make a piece of a returned session id', async () => {
    const RETURNED = 'Enable\u2026BankiZq7pX2';
    const answers = [
      () => json({ session_id: RETURNED, accounts: [] }),
      () => json({ session_id: RETURNED, accounts: [], error: 'vendor diagnostic' }),
      () => json({ session_id: RETURNED, error: 'vendor diagnostic' }, 500),
    ];
    for (const answer of answers) {
      const gateway = gatewayWith(url => (url.pathname === '/sessions' ? answer() : json({}, 404)));
      let caught: Error | undefined;
      try {
        await gateway.completeSession({ code: 'code-0123456789' });
      } catch (error) {
        caught = error as Error;
      }
      expect(caught).toBeInstanceOf(Error);
      const ultimate = caught!.name === 'Error' && caught!.message === '' && caught!.stack === 'Error';
      expect(ultimate || caught!.stack === `${caught!.name}: ${caught!.message}`).toBe(true);
      expect(ultimate).toBe(true);
      expect(JSON.stringify(caught)).toBe('{}');
      const fields = [caught!.name, caught!.message, String(caught!.stack), JSON.stringify(caught)];
      for (let i = 0; i + 6 <= RETURNED.length; i += 1) {
        for (const field of fields) expect(field).not.toContain(RETURNED.slice(i, i + 6));
      }
    }
  });

  it('leaves every error either sealed in final form or as the ultimate fallback', async () => {
    const RETURNED = 'EnableBankingGatewayError_Zq7pX2';
    const gateway = gatewayWith(url => (url.pathname === '/sessions' ? json({ session_id: RETURNED, status: 500 }) : json({}, 404)));
    let caught: Error | undefined;
    try {
      await gateway.completeSession({ code: 'code-0123456789' });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    const ultimate = caught!.name === 'Error' && caught!.message === '' && caught!.stack === 'Error';
    expect(ultimate || caught!.stack === `${caught!.name}: ${caught!.message}`).toBe(true);
  });
});

describe('round 13', () => {
  it('registers a returned session id from the raw answer, before the normalisation can drop it', async () => {
    const RETURNED = 'EnableBankingGatewayError_Zq7pX2';
    const answers = [
      () => json({ session_id: RETURNED, accounts: [], error: 'vendor diagnostic' }),
      () => json({ session_id: RETURNED, accounts: [], status: 500 }),
      () => json({ session_id: RETURNED, error: 'vendor diagnostic' }, 500),
    ];
    for (const answer of answers) {
      const gateway = gatewayWith(url => (url.pathname === '/sessions' ? answer() : json({}, 404)));
      let caught: Error | undefined;
      try {
        await gateway.completeSession({ code: 'code-0123456789' });
      } catch (error) {
        caught = error as Error;
      }
      expect(caught).toBeInstanceOf(Error);
      const fields = [caught!.name, caught!.message, String(caught!.stack), JSON.stringify(caught)];
      for (let i = 0; i + 6 <= RETURNED.length; i += 1) {
        for (const field of fields) expect(field).not.toContain(RETURNED.slice(i, i + 6));
      }
    }
  });
});

describe('round 12', () => {
  it('masks a returned session id that fails the format check in the final error', async () => {
    for (const RETURNED of ['EnableBankingGatewayError_Zq7pX2', 'EnableBankingGatewayError\uD800Zq7pX2']) {
      const gateway = gatewayWith(url => (url.pathname === '/sessions' ? json({ session_id: RETURNED, accounts: [] }) : json({}, 404)));
      let caught: Error | undefined;
      try {
        await gateway.completeSession({ code: 'code-0123456789' });
      } catch (error) {
        caught = error as Error;
      }
      expect(caught, RETURNED).toBeInstanceOf(Error);
      const fields = [caught!.name, caught!.message, String(caught!.stack), JSON.stringify(caught)];
      for (let i = 0; i + 6 <= RETURNED.length; i += 1) {
        for (const field of fields) expect(field, RETURNED).not.toContain(RETURNED.slice(i, i + 6));
      }
      // Sealed in final form, or (a returned id that is not printable ASCII) the ultimate fallback.
      const ultimate = caught!.name === 'Error' && caught!.message === '' && caught!.stack === 'Error';
      expect(ultimate || caught!.stack === `${caught!.name}: ${caught!.message}`, RETURNED).toBe(true);
    }
  });
});

describe('identification hashes', () => {
  // Invented: an account number of zeros with a checksum worked out here, and a name nobody has.
  const MADE_UP_IBAN = dkIban('0'.repeat(14));
  const MADE_UP_OWNER = 'Made-up Owner (invented)';
  const HASH = 'WwUJU8ZJw2Xy0rFdrDFBF2tV3+sRuI3qPk4ZdHs/fTI=.zQx6z2rN4qkc9u1D4TfjtWAeFqa+X7LrV7K0J6P5jVZtnF8KfE';
  const session = (hash: string) => ({
    session_id: SESSION,
    status: 'AUTHORIZED',
    aspsp: { name: 'Opdigtet Bank', country: 'DK' },
    access: { valid_until: '2099-01-01T00:00:00Z' },
    accounts: [ACCOUNT],
    accounts_data: [{ uid: ACCOUNT, identification_hash: hash, iban: MADE_UP_IBAN, owner: MADE_UP_OWNER, extra: { nested: HASH } }],
  });

  it('carries no piece of the key in a hash, and nothing else of accounts_data', async () => {
    const answers: unknown[] = [];
    for (const hash of [`${PIECE}.${PIECE}`, PIECE, `x.${PIECE.slice(0, 30)}`]) {
      const gateway = gatewayWith(url =>
        url.pathname === '/sessions'
          ? json({ ...session(hash), accounts: [{ uid: ACCOUNT, identification_hash: hash, name: 'Konto' }] })
          : json(session(hash)),
      );
      for (const attempt of [() => gateway.completeSession({ code: 'code-0123456789' }), () => gateway.sessionStatus({ sessionId: SESSION })]) {
        try {
          // completeSession gives the session id on purpose: the host stores it. Only the rest is checked.
          const { sessionId: _own, ...rest } = (await attempt()) as { sessionId?: string };
          answers.push(rest);
        } catch (error) {
          answers.push({ message: (error as Error).message, ...(error as object) });
        }
      }
    }
    expect(leaks(answers)).toEqual([]);
    expect(JSON.stringify(answers)).not.toMatch(/nested/);
    expect(JSON.stringify(answers)).not.toContain(MADE_UP_IBAN);
    expect(JSON.stringify(answers)).not.toContain('Made-up Owner');
  });

  it('gives the hash to the consent helpers and keeps it out of the list_accounts answer', async () => {
    const gateway = gatewayWith(url =>
      url.pathname.endsWith('/details') ? json({ uid: ACCOUNT, name: 'Konto', identification_hash: HASH }) : json(session(HASH)),
    );
    expect((await gateway.sessionStatus({ sessionId: SESSION })).accounts).toEqual([{ id: ACCOUNT, identificationHash: HASH }]);
    const listed = await gateway.callTool('list_accounts', {}, ctx);
    expect(JSON.stringify(listed)).not.toContain('identificationHash');
    expect(JSON.stringify(listed)).not.toContain(HASH);
  });
});
