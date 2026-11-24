// The gateway's register of withdrawals on its own: a record that does not grow with use, and dropping records under
// pressure that refuses only the calls under way, and only when what was dropped held a word against them.
import { describe, expect, it } from 'vitest';
import type { SessionStatus } from '../src/enablebanking/api.js';
import { MAX_TRACKED_SESSIONS, Withdrawals } from '../src/gateway/withdrawals.js';

const NOW = Date.parse('2026-11-24T10:00:00Z');
const A = 'account-a';
const B = 'account-b';
const authorised = (accounts: string[], until = '2027-05-01T00:00:00Z'): SessionStatus =>
  ({ status: 'AUTHORIZED', accounts, access: { valid_until: until } }) as SessionStatus;

/** A call as the gateway makes one: begun, its own session check recorded, its accounts named. */
function call(register: Withdrawals, session: string, accounts: string[] = [A]) {
  const watch = register.begin(session);
  watch.until = register.status(session, authorised([A, B]), NOW, new Set([A, B]));
  watch.accounts = new Set(accounts);
  return watch;
}

describe('the register of withdrawals', () => {
  it('stays the same size however often an unchanged session is checked, and lets every call through', () => {
    const register = new Withdrawals();
    for (let i = 0; i < 1_000; i += 1) {
      const watch = call(register, 'session-1');
      register.status('session-1', authorised([A, B]), NOW, new Set([A, B]));
      expect(register.stands(watch, NOW), `call ${i + 1}`).toBe(true);
    }
    expect(register.size).toBe(1);
  });

  it('refuses a call under way for its account, not for another, when a status leaves the account out', () => {
    const register = new Withdrawals();
    const onA = call(register, 'session-1', [A]);
    const onB = call(register, 'session-1', [B]);
    register.status('session-1', authorised([B]), NOW, new Set([B]));
    expect(register.stands(onA, NOW)).toBe(false);
    expect(register.stands(onB, NOW)).toBe(true);
    // The account comes back: a call that begins now is let through.
    register.status('session-1', authorised([A, B]), NOW, new Set([A, B]));
    expect(register.stands(call(register, 'session-1', [A]), NOW)).toBe(true);
  });

  it('refuses a call under way when its validity date, or an earlier one learned since, passes before it returns', () => {
    const register = new Withdrawals();
    const watch = register.begin('session-1');
    watch.until = register.status('session-1', authorised([A], new Date(NOW + 1_000).toISOString()), NOW, new Set([A]));
    watch.accounts = new Set([A]);
    expect(register.stands(watch, NOW + 999)).toBe(true);
    expect(register.stands(watch, NOW + 1_000)).toBe(false);

    const other = call(register, 'session-2');
    register.status('session-2', authorised([A, B], new Date(NOW + 500).toISOString()), NOW, new Set([A, B]));
    expect(register.stands(other, NOW + 400)).toBe(true);
    expect(register.stands(other, NOW + 600)).toBe(false);
  });

  it('drops records of sessions in order without refusing anything under way', () => {
    const register = new Withdrawals();
    const watch = call(register, 'busy');
    for (let i = 0; i <= MAX_TRACKED_SESSIONS; i += 1) register.status(`quiet-${i}`, authorised([A]), NOW, new Set([A]));
    expect(register.size).toBe(MAX_TRACKED_SESSIONS);
    expect(register.stands(watch, NOW)).toBe(true);
  });

  it('refuses the calls under way, and only those, when a dropped record held a word against a consent', () => {
    const register = new Withdrawals();
    const underWay = call(register, 'busy');
    register.failed('revoked', 'consent_revoked');
    for (let i = 0; i < MAX_TRACKED_SESSIONS; i += 1) register.status(`quiet-${i}`, authorised([A]), NOW, new Set([A]));
    // The revoked session's record was the oldest and is gone: what it said could concern a call under way.
    expect(register.size).toBe(MAX_TRACKED_SESSIONS);
    expect(register.stands(underWay, NOW)).toBe(false);
    // A call that begins after the drop asks Enable Banking itself and is not refused for it.
    expect(register.stands(call(register, 'busy'), NOW)).toBe(true);
  });

  it('keeps a session ended here ended for as long as its record is held', () => {
    const register = new Withdrawals();
    register.end('ended');
    expect(register.stands(call(register, 'ended'), NOW)).toBe(false);
  });
});
