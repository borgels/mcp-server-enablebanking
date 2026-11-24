import { describe, expect, it, vi } from 'vitest';
import { EnableBankingClient } from '../src/enablebanking/client.js';
import { loadConfig } from '../src/enablebanking/config.js';
import { EnableBankingHttpError } from '../src/errors.js';
import { KEY } from './helpers.js';

function client(fetchImpl: typeof fetch) {
  return new EnableBankingClient({ applicationId: 'app-1', privateKey: KEY.privateKey, baseUrl: 'https://eb.test', fetch: fetchImpl });
}

describe('EnableBankingClient upstream hardening', () => {
  it('never follows redirects, so the JWT and the authorization code are not re-sent', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/sessions' } }),
    );
    const error = await client(fetchImpl).createSession('code-123').catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/redirect \(HTTP 307\)/);
    expect((error as Error).message).not.toContain('code-123');
    expect(fetchImpl.mock.calls[0]![1]?.redirect).toBe('manual');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps only a documented code of an error body, and nothing of an over-limit body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ error: 'WRONG_REQUEST_PARAMETERS', message: 'm'.repeat(10_000) }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const error = await client(fetchImpl).getApplication().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnableBankingHttpError);
    expect((error as EnableBankingHttpError).code).toBe('WRONG_REQUEST_PARAMETERS');
    expect((error as Error).message).toBe('Enable Banking GET /application failed with HTTP 400 (WRONG_REQUEST_PARAMETERS).');

    const undocumented = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: 'SOMETHING_ELSE', code: 'x' }), { status: 400 }));
    const undocumentedError = (await client(undocumented).getApplication().catch((e: unknown) => e)) as EnableBankingHttpError;
    expect(undocumentedError.code).toBeUndefined();
    expect(undocumentedError.message).not.toContain('SOMETHING_ELSE');

    const over = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ error: 'EXPIRED_SESSION', pad: 'p'.repeat(70_000) }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
    );
    expect(((await client(over).getApplication().catch((e: unknown) => e)) as EnableBankingHttpError).code).toBeUndefined();

    const huge = vi.fn<typeof fetch>(async () => new Response('x'.repeat(1_000_000), { status: 502 }));
    const hugeError = await client(huge).getApplication().catch((e: unknown) => e);
    expect((hugeError as EnableBankingHttpError).status).toBe(502);
  });

  it('redacts bearer tokens in upstream messages before truncating', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ message: `${'y'.repeat(490)} Bearer abcdefghijklmnopqrstuvwxyz` }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const error = await client(fetchImpl).getApplication().catch((e: unknown) => e);
    expect((error as Error).message).not.toContain('abcdefghij');
  });
});

describe('numeric configuration', () => {
  it('rejects non-integer values instead of silently using the default', () => {
    expect(() => loadConfig({ ENABLEBANKING_COMPANY: 'aaa', ENABLEBANKING_TIMEOUT_MS: 'abc' })).toThrow(
      /ENABLEBANKING_TIMEOUT_MS/,
    );
    expect(() => loadConfig({ ENABLEBANKING_COMPANY: 'aaa', ENABLEBANKING_CACHE_SECONDS: '5m' })).toThrow(
      /ENABLEBANKING_CACHE_SECONDS/,
    );
  });

  it('keeps defaults for unset values and clamps out-of-range integers', () => {
    expect(loadConfig({ ENABLEBANKING_COMPANY: 'aaa' })).toMatchObject({ timeoutMs: 30_000, cacheSeconds: 300 });
    expect(loadConfig({ ENABLEBANKING_COMPANY: 'aaa', ENABLEBANKING_TIMEOUT_MS: '10' }).timeoutMs).toBe(1_000);
    expect(loadConfig({ ENABLEBANKING_COMPANY: 'aaa', ENABLEBANKING_CACHE_SECONDS: '0' }).cacheSeconds).toBe(0);
  });
});

describe('error codes from non-JSON content types', () => {
  it('keeps the code of a JSON error body served as text/plain', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ error: 'EXPIRED_SESSION', message: 'Session expired' }), {
        status: 422,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );
    const error = (await client(fetchImpl).getApplication().catch((e: unknown) => e)) as EnableBankingHttpError;
    expect(error).toBeInstanceOf(EnableBankingHttpError);
    expect(error.code).toBe('EXPIRED_SESSION');
    expect(error.consentLost).toBe(true);
    // Enable Banking's own text is not kept.
    expect(error.message).not.toContain('Session expired');
  });

  it('ignores a non-JSON text body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('Bad gateway', { status: 502 }));
    const error = (await client(fetchImpl).getApplication().catch((e: unknown) => e)) as EnableBankingHttpError;
    expect(error.status).toBe(502);
    expect(error.code).toBeUndefined();
  });
});

describe('account information requests', () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  it('builds the transactions query the API documents, and sends a person’s headers only when given', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok({ transactions: [], continuation_key: 'next' }));
    const api = client(fetchImpl);
    const page = await api.getTransactionsPage('uid-1', { dateFrom: '2026-01-01', dateTo: '2026-01-31', status: 'PDNG', continuationKey: 'k 1' });
    expect(page).toEqual({ transactions: [], continuationKey: 'next' });
    const first = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(first.pathname).toBe('/accounts/uid-1/transactions');
    expect(Object.fromEntries(first.searchParams)).toEqual({ date_from: '2026-01-01', date_to: '2026-01-31', transaction_status: 'PDNG', continuation_key: 'k 1' });
    expect(Object.keys(fetchImpl.mock.calls[0]![1]!.headers as object).some(name => name.startsWith('Psu-'))).toBe(false);

    await api.getTransactionsPage('uid-1', { dateFrom: '2020-01-01', dateTo: '2026-01-31', strategy: 'longest' }, { 'Psu-Ip-Address': '192.0.2.10', Authorization: 'replaced?' });
    const second = new URL(String(fetchImpl.mock.calls[1]![0]));
    // With the longest strategy the API ignores an end date, so none is sent.
    expect(Object.fromEntries(second.searchParams)).toEqual({ date_from: '2020-01-01', strategy: 'longest' });
    const headers = fetchImpl.mock.calls[1]![1]!.headers as Record<string, string>;
    expect(headers['Psu-Ip-Address']).toBe('192.0.2.10');
    // A header of the person can never replace one of ours.
    expect(headers.Authorization).toMatch(/^Bearer ey/);
  });

  it('follows continuation keys to the end, through empty pages, and says when it stopped early', async () => {
    let page = 0;
    const three = vi.fn<typeof fetch>(async () => {
      page += 1;
      return ok({ transactions: page === 2 ? [] : [{ entry_reference: `r${page}` }], continuation_key: page < 3 ? `k${page}` : null });
    });
    expect(await client(three).listTransactions('uid-1', { dateFrom: '2026-01-01', dateTo: '2026-01-31' })).toMatchObject({ truncated: false, pages: 3, transactions: [{ entry_reference: 'r1' }, { entry_reference: 'r3' }] });
    const keys = three.mock.calls.map(call => new URL(String(call[0])).searchParams.get('continuation_key'));
    expect(keys).toEqual([null, 'k1', 'k2']);

    const endless = vi.fn<typeof fetch>(async () => ok({ transactions: [], continuation_key: 'again' }));
    expect(await client(endless).listTransactions('uid-1', {})).toMatchObject({ truncated: true, pages: 50 });
    expect(endless).toHaveBeenCalledTimes(50);
  });

  it('asks for banks that offer account information, in one country or all', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok({ aspsps: [] }));
    await client(fetchImpl).listAspsps();
    await client(fetchImpl).listAspsps('SE', 'personal');
    expect(fetchImpl.mock.calls.map(call => new URL(String(call[0])).search)).toEqual(['?service=AIS', '?service=AIS&country=SE&psu_type=personal']);
  });

  it('reads one transaction as a single path segment', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok({ transaction_id: 'x' }));
    await client(fetchImpl).getTransaction('uid-1', 'id:1=a');
    expect(new URL(String(fetchImpl.mock.calls[0]![0])).pathname).toBe(`/accounts/uid-1/transactions/${encodeURIComponent('id:1=a')}`);
    await expect(client(fetchImpl).getTransaction('uid-1', '../balances')).rejects.toThrow();
    await expect(client(fetchImpl).getTransaction('uid-1', 'a/b')).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
