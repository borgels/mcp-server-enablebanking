import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertAuthorized,
  getHttpConfig,
  HttpRequestError,
  isOriginAllowed,
  readJsonBody,
} from '../src/transports/http-helpers.js';

const originalEnv = { ...process.env };

describe('HTTP transport hardening', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('binds to loopback and uses a 10 MiB request limit by default', () => {
    delete process.env.HOST;
    delete process.env.MCP_HTTP_HOST;
    delete process.env.MCP_MAX_BODY_BYTES;

    expect(getHttpConfig()).toMatchObject({
      host: '127.0.0.1',
      maxBodyBytes: 10_485_760,
    });
  });

  it('allows loopback origins by default and supports explicit origin allowlists', () => {
    expect(isOriginAllowed('http://localhost:5173')).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:3000')).toBe(true);
    expect(isOriginAllowed('https://evil.example')).toBe(false);

    process.env.MCP_ALLOWED_ORIGINS = 'https://app.example';
    expect(isOriginAllowed('https://app.example')).toBe(true);
    expect(isOriginAllowed('http://localhost:5173')).toBe(false);
  });

  it('requires the optional HTTP token when configured', () => {
    process.env.MCP_HTTP_TOKEN = 'secret';
    expect(() => assertAuthorized({ headers: {} } as never)).toThrow(HttpRequestError);
    expect(() =>
      assertAuthorized({ headers: { authorization: 'Bearer secret' } } as never),
    ).not.toThrow();
  });

  it('rejects oversized JSON request bodies', async () => {
    await expect(readJsonBody(Readable.from(['{"ok":true}']) as never, 4)).rejects.toMatchObject({
      status: 413,
    });
  });
});
