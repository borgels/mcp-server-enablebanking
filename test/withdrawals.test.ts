// The watches of calls under way, on their own: every fact about a session is put on every live watch on it, in
// whatever order the answers arrive, and nothing on a watch is ever cleared. Made-up ids only.
import { describe, expect, it } from 'vitest';
import type { SessionStatus } from '../src/enablebanking/api.js';
import { Withdrawals } from '../src/gateway/withdrawals.js';

const NOW = Date.parse('2026-11-24T10:00:00Z');
const A = 'account-a';
const B = 'account-b';
const status = (accounts: string[], until = '2027-05-01T00:00:00Z', state = 'AUTHORIZED'): [SessionStatus, ReadonlySet<string>] => [
  { status: state, accounts, access: { valid_until: until } } as SessionStatus,
  new Set(accounts),
];
const tell = (register: Withdrawals, session: string, [answer, listed]: [SessionStatus, ReadonlySet<string>], now = NOW) =>
  register.status(session, answer, now, listed);

describe('the watch of a call under way', () => {
  it('lets a call through when every answer is in order, and leaves nothing behind when it ends', () => {
    const register = new Withdrawals();
    for (let i = 0; i < 1_000; i += 1) {
      const watch = register.begin('s1', [A]);
      tell(register, 's1', status([A, B]));
      expect(register.stands(watch, NOW)).toBe(true);
      register.done(watch);
    }
    expect(register.size).toEqual({ live: 0, ended: 0 });
  });

  it('keeps an account missing when a later answer, arriving after, still lists it (the order does not matter)', () => {
    const register = new Withdrawals();
    const watch = register.begin('s1', [A]);
    // A newer status without A arrives first; the call's own, older status with A arrives after it.
    tell(register, 's1', status([B]));
    tell(register, 's1', status([A, B]));
    expect(register.stands(watch, NOW)).toBe(false);
  });

  it('marks an account missing for a call that has not had its first answer yet', () => {
    const register = new Withdrawals();
    const watch = register.begin('s1', [A]);
    tell(register, 's1', status([B]));
    expect(watch.missing.has(A)).toBe(true);
    expect(register.stands(watch, NOW)).toBe(false);
  });

  it('refuses for a word against the consent, whichever comes later', () => {
    for (const negative of [status([A], undefined, 'REVOKED'), status([A], undefined, 'SOMETHING_NEW'), status([A], '2026-11-24T09:00:00Z')]) {
      const register = new Withdrawals();
      const watch = register.begin('s1', [A]);
      tell(register, 's1', negative);
      tell(register, 's1', status([A]));
      expect(register.stands(watch, NOW)).toBe(false);
    }
    const register = new Withdrawals();
    const watch = register.begin('s1', [A]);
    register.failed('s1', 'consent_revoked');
    expect(register.stands(watch, NOW)).toBe(false);
  });

  it('keeps the earliest validity date it has seen, and checks it against the clock at the end', () => {
    const register = new Withdrawals();
    const watch = register.begin('s1', [A]);
    tell(register, 's1', status([A], new Date(NOW + 1_000).toISOString()));
    tell(register, 's1', status([A], new Date(NOW + 60_000).toISOString()));
    expect(register.stands(watch, NOW + 999)).toBe(true);
    expect(register.stands(watch, NOW + 1_000)).toBe(false);
  });

  it('counts a missing account only for the calls that depend on it, and not for the call that found it itself', () => {
    const register = new Withdrawals();
    const onA = register.begin('s1', [A]);
    const onB = register.begin('s1', [B]);
    const search = register.begin('s1', [A, B]);
    register.failed('s1', 'account_not_in_consent', A, search);
    expect(register.stands(onA, NOW)).toBe(false);
    expect(register.stands(onB, NOW)).toBe(true);
    expect(register.stands(search, NOW)).toBe(true);
  });

  it('refuses calls under way and calls that start while a session is ended, and drops old ended sessions only when done', () => {
    const register = new Withdrawals(2);
    const underWay = register.begin('s1', [A]);
    register.ending('s1');
    expect(register.stands(underWay, NOW)).toBe(false);
    expect(register.stands(register.begin('s1', [A]), NOW)).toBe(false);
    // Three more sessions are ended; s1's endSession is still under way, so it is kept.
    for (const id of ['s2', 's3', 's4']) {
      register.ending(id);
      register.endingDone(id);
    }
    expect(register.stands(register.begin('s1', [A]), NOW)).toBe(false);
    register.endingDone('s1');
    expect(register.size.ended).toBeLessThanOrEqual(2);
  });

  it('does not depend on anything but the call: other sessions do not touch its watch', () => {
    const register = new Withdrawals(1);
    const watch = register.begin('s1', [A]);
    tell(register, 's1', status([A], new Date(NOW + 1_000).toISOString()));
    for (let i = 0; i < 10_000; i += 1) {
      register.ending(`other-${i}`);
      register.endingDone(`other-${i}`);
    }
    expect(register.stands(watch, NOW + 2_000)).toBe(false);
    expect(register.stands(watch, NOW + 500)).toBe(true);
  });
});
