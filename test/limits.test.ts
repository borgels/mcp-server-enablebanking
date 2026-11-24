// Fixed problem codes, the person-present headers and the budget for reads nobody is present for.
import { describe, expect, it } from 'vitest';
import { budgetRefusal, DEFAULT_UNATTENDED_FETCHES_PER_DAY, UnattendedBudget } from '../src/enablebanking/budget.js';
import { isProblemCode, PROBLEM_CODES, problemFromHttp, problemHint, problemOf, problemRetryAfterSeconds, ProblemError } from '../src/enablebanking/problems.js';
import { PSU_HEADER_NAMES, psuHeaders } from '../src/enablebanking/psu.js';
import { EnableBankingHttpError, ERROR_CODES } from '../src/errors.js';

describe('problem codes', () => {
  it('are decided by Enable Banking’s documented error code, not by the HTTP status', () => {
    // The same status, different problems.
    expect(problemFromHttp(401, 'EXPIRED_SESSION')).toBe('consent_expired');
    expect(problemFromHttp(401, 'REVOKED_SESSION')).toBe('consent_revoked');
    expect(problemFromHttp(401, 'CLOSED_SESSION')).toBe('consent_revoked');
    expect(problemFromHttp(401, 'UNAUTHORIZED_ACCESS')).toBe('application_refused');
    expect(problemFromHttp(403, 'ACCESS_DENIED')).toBe('application_refused');
    expect(problemFromHttp(403, 'UNAUTHORIZED_IP')).toBe('application_refused');
    expect(problemFromHttp(403, 'NO_ACCOUNTS_ADDED')).toBe('application_restricted');
    // The same problem, whatever the status.
    for (const status of [400, 401, 422, 500]) expect(problemFromHttp(status, 'EXPIRED_SESSION')).toBe('consent_expired');
    expect(problemFromHttp(404, 'ACCOUNT_DOES_NOT_EXIST')).toBe('account_not_in_consent');
    expect(problemFromHttp(400, 'ASPSP_ACCOUNT_NOT_ACCESSIBLE')).toBe('account_not_accessible');
    expect(problemFromHttp(400, 'ASPSP_ERROR')).toBe('bank_unavailable');
    expect(problemFromHttp(408, 'ASPSP_TIMEOUT')).toBe('bank_unavailable');
    expect(problemFromHttp(429, 'ASPSP_RATE_LIMIT_EXCEEDED')).toBe('rate_limited');
    expect(problemFromHttp(400, 'ASPSP_PSU_ACTION_REQUIRED')).toBe('person_action_required');
    expect(problemFromHttp(422, 'WRONG_TRANSACTIONS_PERIOD')).toBe('period_not_available');
    expect(problemFromHttp(422, 'PSU_HEADER_NOT_PROVIDED')).toBe('presence_incomplete');
    expect(problemFromHttp(404, 'TRANSACTION_DOES_NOT_EXIST')).toBe('transaction_not_found');
  });

  it('never take a bare 401 or 403 as an ended consent', () => {
    expect(problemFromHttp(401, undefined)).toBe('access_refused');
    expect(problemFromHttp(403, undefined)).toBe('access_refused');
    expect(problemFromHttp(401, 'NOT_A_DOCUMENTED_CODE')).toBe('access_refused');
    expect(problemFromHttp(429, undefined)).toBe('rate_limited');
    expect(problemFromHttp(503, undefined)).toBe('bank_unavailable');
    expect(problemFromHttp(404, undefined)).toBe('not_found');
    expect(problemFromHttp(418, undefined)).toBe('upstream_error');
    const bare = new EnableBankingHttpError({ status: 401, method: 'GET', path: '/accounts/x/balances' });
    expect(bare.consentLost).toBe(false);
    expect(bare.problem).toBe('access_refused');
    const refused = new EnableBankingHttpError({ status: 403, method: 'GET', path: '/accounts/x/balances', payload: { error: 'ACCESS_DENIED' } });
    expect(refused.consentLost).toBe(false);
    expect(refused.message).toMatch(/ failed with HTTP 403 \(ACCESS_DENIED\)\. .*The bank consent is not the cause\.$/);
    const expired = new EnableBankingHttpError({ status: 401, method: 'GET', path: '/sessions/x', payload: { error: 'EXPIRED_SESSION' } });
    expect(expired.consentLost).toBe(true);
  });

  it('give the wait Enable Banking recommends after a bank’s rate limit, and a plain sentence', () => {
    expect(problemRetryAfterSeconds('rate_limited')).toBe(6 * 3600);
    expect(problemRetryAfterSeconds('bank_unavailable')).toBeUndefined();
    expect(problemHint('rate_limited')).toMatch(/six hours/);
    expect(problemHint('period_not_available')).toMatch(/90 days/);
  });

  it('are a closed list, and every code Enable Banking documents that we map is one it documents', () => {
    expect(new Set(PROBLEM_CODES).size).toBe(PROBLEM_CODES.length);
    expect(isProblemCode('rate_limited')).toBe(true);
    expect(isProblemCode('RATE_LIMITED')).toBe(false);
    expect(isProblemCode(undefined)).toBe(false);
    for (const vendor of ['EXPIRED_SESSION', 'ASPSP_RATE_LIMIT_EXCEEDED', 'NO_ACCOUNTS_ADDED', 'PSU_HEADER_NOT_PROVIDED', 'WRONG_TRANSACTIONS_PERIOD', 'ASPSP_ACCOUNT_NOT_ACCESSIBLE']) {
      expect(ERROR_CODES.has(vendor), vendor).toBe(true);
    }
    expect(problemOf(new ProblemError('unattended_limit', 'x'))).toBe('unattended_limit');
    expect(problemOf(new Error('x'))).toBeUndefined();
    expect(problemOf('x')).toBeUndefined();
  });
});

describe('the person present', () => {
  it('maps each field to its Psu header of the API', () => {
    expect(PSU_HEADER_NAMES).toEqual({
      ipAddress: 'Psu-Ip-Address',
      userAgent: 'Psu-User-Agent',
      referer: 'Psu-Referer',
      accept: 'Psu-Accept',
      acceptCharset: 'Psu-Accept-Charset',
      acceptEncoding: 'Psu-Accept-Encoding',
      acceptLanguage: 'Psu-Accept-Language',
      geoLocation: 'Psu-Geo-Location',
    });
    expect(psuHeaders({ ipAddress: ' 192.0.2.10 ', userAgent: 'ExampleBrowser/1.0', acceptLanguage: 'sv-SE,sv;q=0.9', geoLocation: '55.676100,12.568300' })).toEqual({
      ok: true,
      headers: { 'Psu-Ip-Address': '192.0.2.10', 'Psu-User-Agent': 'ExampleBrowser/1.0', 'Psu-Accept-Language': 'sv-SE,sv;q=0.9', 'Psu-Geo-Location': '55.676100,12.568300' },
    });
    expect(psuHeaders({ ipAddress: '2001:db8::10' })).toMatchObject({ ok: true });
  });

  it('refuses anything malformed rather than send a read as a background one', () => {
    for (const bad of [
      undefined,
      null,
      'present',
      [],
      {},
      { ipAddress: undefined },
      { ipAddress: 'not-an-ip' },
      { ipAddress: '192.0.2.10', userAgent: 'line\r\nX-Injected: 1' },
      { userAgent: 'x'.repeat(513) },
      { userAgent: 'ünicode' },
      { userAgent: 42 },
      { geoLocation: 'somewhere' },
      { ipAddress: '192.0.2.10', authorization: 'Bearer x' },
    ]) {
      expect(psuHeaders(bad), JSON.stringify(bad)).toEqual({ ok: false });
    }
  });
});

describe('the budget for reads nobody is present for', () => {
  const HOUR = 3_600_000;

  it('allows four a day per consent by default, over a rolling 24 hours', () => {
    let now = Date.parse('2026-11-24T08:00:00Z');
    const budget = new UnattendedBudget(DEFAULT_UNATTENDED_FETCHES_PER_DAY, () => now);
    expect(DEFAULT_UNATTENDED_FETCHES_PER_DAY).toBe(4);
    for (let i = 0; i < 4; i += 1) {
      expect(budget.take('consent-one')).toMatchObject({ ok: true, remaining: 3 - i });
      now += HOUR;
    }
    const refused = budget.take('consent-one');
    expect(refused).toMatchObject({ ok: false, limit: 4, wanted: 1, nextAt: Date.parse('2026-11-25T08:00:00Z') });
    // Another consent has its own budget.
    expect(budget.take('consent-two').ok).toBe(true);
    // Once the first read is 24 hours old, one more fits.
    now = Date.parse('2026-11-25T08:00:01Z');
    expect(budget.take('consent-one').ok).toBe(true);
    expect(budget.take('consent-one').ok).toBe(false);
  });

  it('takes all or none of a call that reads several accounts', () => {
    const now = Date.parse('2026-11-24T08:00:00Z');
    const budget = new UnattendedBudget(4, () => now);
    expect(budget.take('c', 3).ok).toBe(true);
    expect(budget.take('c', 2)).toMatchObject({ ok: false, wanted: 2 });
    expect(budget.take('c', 1).ok).toBe(true);
    const tooMany = new UnattendedBudget(4, () => now).take('c', 9);
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(budgetRefusal(tooMany)).toMatch(/This read needs 9\./);
  });

  it('pauses a consent for six hours when the bank says its limit is reached', () => {
    let now = Date.parse('2026-11-24T08:00:00Z');
    const budget = new UnattendedBudget(4, () => now);
    budget.block('c');
    const refused = budget.take('c');
    expect(refused).toMatchObject({ ok: false, nextAt: Date.parse('2026-11-24T14:00:00Z') });
    if (!refused.ok) {
      expect(budgetRefusal(refused)).toBe(
        'Not read: nobody is present, and only 4 automatic read(s) a day are made for a bank consent. ' +
          'The next automatic read is possible from 2026-11-24 14:00 UTC. A read that a person asks for is not limited.',
      );
    }
    now += 6 * HOUR;
    expect(budget.take('c').ok).toBe(true);
  });

  it('is off at zero', () => {
    const budget = new UnattendedBudget(0);
    expect(budget.enabled).toBe(false);
    for (let i = 0; i < 100; i += 1) expect(budget.take('c').ok).toBe(true);
    budget.block('c');
    expect(budget.take('c').ok).toBe(true);
  });
});
