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

  it('reads at most 64 KB of an error body and shortens upstream text', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ error: 'BAD', message: 'm'.repeat(10_000) }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const error = await client(fetchImpl).getApplication().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnableBankingHttpError);
    expect((error as EnableBankingHttpError).code).toBe('BAD');
    expect((error as Error).message.length).toBeLessThan(1_000);

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
    expect(error.message).toContain('Session expired');
  });

  it('ignores a non-JSON text body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('Bad gateway', { status: 502 }));
    const error = (await client(fetchImpl).getApplication().catch((e: unknown) => e)) as EnableBankingHttpError;
    expect(error.status).toBe(502);
    expect(error.code).toBeUndefined();
  });
});
