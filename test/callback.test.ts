import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/enablebanking/config.js';
import { consentCallbackPath, escapeHtml, handleConsentCallback } from '../src/transports/consent-page.js';
import { IBAN, linkConsent, makeBank } from './helpers.js';

function fakeResponse() {
  const out = { status: 0, headers: {} as Record<string, string>, body: '' };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      out.status = status;
      out.headers = headers;
      return res;
    },
    end(body: string) {
      out.body = body;
    },
  } as unknown as ServerResponse;
  return { res, out };
}

function config(dataDir: string, extra: Record<string, string> = {}) {
  return loadConfig({
    ENABLEBANKING_COMPANY: 'aaa',
    ENABLEBANKING_ENABLE_CONSENT: 'true',
    ENABLEBANKING_CONSENT_CALLBACK: 'true',
    ENABLEBANKING_REDIRECT_URL: 'https://consent.example.com/bank-consent',
    ENABLEBANKING_RETURN_URL: 'https://claude.ai/',
    ENABLEBANKING_AUDIT_LOG: join(dataDir, 'audit.jsonl'),
    ...extra,
  });
}

describe('consent callback', () => {
  it('serves only when consent and the callback are both on', () => {
    expect(consentCallbackPath(config('/tmp'))).toBe('/bank-consent');
    expect(consentCallbackPath(config('/tmp', { ENABLEBANKING_CONSENT_CALLBACK: 'false' }))).toBeUndefined();
    expect(consentCallbackPath(config('/tmp', { ENABLEBANKING_ENABLE_CONSENT: 'false' }))).toBeUndefined();
    expect(() => config('/tmp', { ENABLEBANKING_RETURN_URL: 'javascript:alert(1)' })).toThrow(/https/);
  });

  it('completes the consent from the redirect, attributed to whoever started it', async () => {
    const { bank, api, dataDir } = makeBank();
    const { redirect } = await linkConsent(bank, api, 'anna@example.com');
    const { res, out } = fakeResponse();
    await handleConsentCallback(bank, config(dataDir), new URL(redirect).pathname + new URL(redirect).search, res);

    expect(out.status).toBe(200);
    expect(out.body).toContain('Samtykke gennemført');
    expect(out.body).toContain('Driftskonto');
    expect(out.body).not.toContain(IBAN.aaaDrift); // masked
    expect(out.body).not.toContain(IBAN.bbbDrift);
    expect(out.body).not.toContain('c-1'); // never echoes the code
    expect(out.body).toContain('href="https://claude.ai/"');
    expect(out.headers['Cache-Control']).toBe('no-store');
    expect(out.headers['Referrer-Policy']).toBe('no-referrer');
    expect(out.headers['Content-Security-Policy']).toContain("default-src 'none'");

    expect(bank.linked('drift').uid).toBe('uid-aaa-drift');
    expect(bank.listAccounts().consents[0]).toMatchObject({ createdBy: 'anna@example.com' });
    const audit = readFileSync(join(dataDir, 'audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(audit.at(-1)).toMatchObject({ tool: 'consent_callback', action: 'finish', actingAs: 'anna@example.com' });
  });

  it('refuses a forged, replayed or foreign state with a plain error page', async () => {
    const { bank, api, dataDir } = makeBank();
    const { redirect } = await linkConsent(bank, api);
    const path = new URL(redirect).pathname + new URL(redirect).search;

    const forged = fakeResponse();
    await handleConsentCallback(bank, config(dataDir), '/bank-consent?code=c-1&state=eyJ4IjoxfQ.AAAA', forged.res);
    expect(forged.out.status).toBe(400);
    expect(forged.out.body).toContain('ikke gennemført');

    const first = fakeResponse();
    await handleConsentCallback(bank, config(dataDir), path, first.res);
    expect(first.out.status).toBe(200);
    const replay = fakeResponse();
    await handleConsentCallback(bank, config(dataDir), path, replay.res);
    expect(replay.out.status).toBe(400);
    expect(replay.out.body).toContain('already completed');

    const other = makeBank({ company: 'bbb', api });
    const foreign = fakeResponse();
    const started = await linkConsent(bank, api);
    await handleConsentCallback(other.bank, config(other.dataDir, { ENABLEBANKING_COMPANY: 'bbb' }), new URL(started.redirect).pathname + new URL(started.redirect).search, foreign.res);
    expect(foreign.out.status).toBe(400);
  });

  it('shows the bank refusing without completing anything', async () => {
    const { bank, dataDir } = makeBank();
    const { res, out } = fakeResponse();
    await handleConsentCallback(bank, config(dataDir), '/bank-consent?error=access_denied&error_description=%3Cscript%3Ex%3C%2Fscript%3E', res);
    expect(out.status).toBe(400);
    expect(out.body).not.toContain('<script>x');
    expect(bank.listAccounts().consents).toEqual([]);
  });

  it('escapes html', () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  });
});
