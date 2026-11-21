import { describe, expect, it, vi } from 'vitest';
import { createEnableBankingGateway, type GatewayCallContext } from '../src/gateway.js';
import { KEY } from './helpers.js';

const PEM = KEY.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const ORIGIN = 'https://eb.test';
const NOW = Date.parse('2026-11-17T10:00:00Z');
const SESSION = '11111111-aaaa-4aaa-8aaa-111111111111';
const ACCOUNT = 'a1a1a1a1-0000-4000-8000-00000000a001';
const REQUEST_ID = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
const ctx: GatewayCallContext = { credentials: { sessionId: SESSION, accountIds: [ACCOUNT] } };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function gateway(balances: () => Response) {
  const fetchImpl = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    if (url.pathname === `/sessions/${SESSION}`) {
      return json({ status: 'AUTHORIZED', accounts: [ACCOUNT], access: { valid_until: '2027-05-01T00:00:00+00:00' } });
    }
    if (url.pathname === `/accounts/${ACCOUNT}/balances`) return balances();
    return json({ error: 'NOT_FOUND' }, 404);
  });
  return createEnableBankingGateway({ applicationId: 'app-0000-test', privateKey: PEM, apiBaseUrl: ORIGIN, fetchImpl, now: () => NOW });
}

describe('gateway: failure metadata', () => {
  it('gives the HTTP status and a request id in form on an error result from Enable Banking', async () => {
    const result = await gateway(() => json({ error: 'ASPSP_ERROR', message: 'bank text' }, 502, { 'x-request-id': REQUEST_ID })).callTool(
      'get_balances',
      { account: ACCOUNT },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 502, requestId: REQUEST_ID });
    expect(JSON.stringify(result)).not.toContain('bank text');
  });

  it('drops a request id that is not in the form of one, and gives the status alone', async () => {
    const result = await gateway(() => json({}, 429, { 'x-request-id': 'Fiktiv Person, a sentence' })).callTool('get_balances', { account: ACCOUNT }, ctx);
    expect(result.failure).toEqual({ httpStatus: 429 });
    const personal = await gateway(() => json({}, 500, { 'x-request-id': 'ab01020304056789' })).callTool('get_balances', { account: ACCOUNT }, ctx);
    expect(personal.failure).toEqual({ httpStatus: 500 });
  });

  it('drops a request id in form that redaction changes (here the session id itself), and gives the status alone', async () => {
    const result = await gateway(() => json({}, 503, { 'x-request-id': SESSION })).callTool('get_balances', { account: ACCOUNT }, ctx);
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 503 });
    expect(JSON.stringify(result)).not.toContain(SESSION);
  });

  it('gives the status of a refused redirect, never its address', async () => {
    const result = await gateway(() => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example.org/' } })).callTool(
      'get_balances',
      { account: ACCOUNT },
      ctx,
    );
    expect(result.failure).toEqual({ httpStatus: 307 });
    expect(JSON.stringify(result)).not.toContain('elsewhere');
  });

  it('has no failure on a refusal of ours or a successful answer', async () => {
    const ok = gateway(() => json({ balances: [{ balance_type: 'CLBD', balance_amount: { currency: 'DKK', amount: '1.00' } }] }));
    expect((await ok.callTool('get_balances', { account: ACCOUNT }, ctx)).failure).toBeUndefined();
    expect((await ok.callTool('get_balances', { account: 'b1b1b1b1-0000-4000-8000-00000000b001' }, ctx)).failure).toBeUndefined();
    expect((await ok.callTool('get_balances', { account: ACCOUNT })).failure).toBeUndefined();
  });
});
