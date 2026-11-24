import type { SessionStatus } from '../enablebanking/api.js';
import type { ProblemCode } from '../enablebanking/problems.js';

/**
 * What can make the answer of a call under way invalid, kept on the call
 * itself.
 *
 * Every call makes a watch at its start, synchronously, before anything is
 * awaited, and registers it on its session id with the accounts it depends
 * on. The watch lives exactly as long as the call (the call holds it and
 * removes it when it ends) and is never dropped for room. Every fact this
 * instance learns about a session, from any request about it, is pushed to
 * every live watch on that session at the moment it arrives:
 * - a status other than AUTHORIZED (an unknown one included), a validity date
 *   that has passed, a request failing with an ended consent, endSession: the
 *   watch is refused;
 * - a status that does not list an account the watch depends on, or a read of
 *   that account failing with ACCOUNT_DOES_NOT_EXIST: the account is marked
 *   missing on the watch;
 * - any validity date: the watch keeps the earliest it has seen.
 * Nothing on a watch is ever cleared: a status that arrives later and says all
 * is well does not lift a fact the watch already holds, whatever order the
 * answers arrive in. The final check of a call (`stands`) is synchronous,
 * after the call's last await, and reads only its own watch and the clock.
 *
 * A call that starts later asks Enable Banking itself, so nothing else is
 * needed for it, with one exception: a session ended through endSession is
 * kept in a bounded list, so that a call starting while (or after) the
 * session is being ended is refused even when its own check reached Enable
 * Banking before the end did. An entry is never dropped while its endSession
 * is under way; at most `maxEnded` other entries are kept, the oldest dropped
 * first (by then Enable Banking itself says the session is closed).
 *
 * Nothing of the bank's answers is kept: only session ids, account ids and
 * dates of validity, and only while a call that depends on them runs.
 */
export const DEFAULT_ENDED_SESSIONS_KEPT = 10_000;

/** What a request failing with these says: the consent itself is over. */
const CONSENT_OVER: ReadonlySet<ProblemCode> = new Set<ProblemCode>(['consent_expired', 'consent_revoked', 'consent_not_active']);

/** One call's watch on its session. */
export interface CallWatch {
  readonly session: string;
  /** The accounts the answer may come from. Narrowed (never widened) once the call is read. */
  accounts: ReadonlySet<string>;
  /** A word against the consent arrived while the call ran (or the session was ended here). Never cleared. */
  refused: boolean;
  /** Accounts the call depends on that some answer said have left the consent. Never cleared. */
  readonly missing: Set<string>;
  /** Accounts the call's own session check found missing: it does not read them, so they do not count against it. */
  readonly own: Set<string>;
  /** The earliest validity date any answer about the session gave while the call ran (ms), or NaN. */
  until: number;
}

export class Withdrawals {
  /** Live watches by session id. A watch is here from the call's start to its end, and only then. */
  private readonly live = new Map<string, Set<CallWatch>>();
  /** Sessions ended here, oldest first; the value is how many endSession calls for it are under way. */
  private readonly ended = new Map<string, number>();

  constructor(private readonly maxEnded = DEFAULT_ENDED_SESSIONS_KEPT) {}

  /** A watch for a call that starts now. Call synchronously, before the call awaits anything; `done` it in a finally. */
  begin(session: string, accounts: Iterable<string>): CallWatch {
    const watch: CallWatch = { session, accounts: new Set(accounts), refused: this.ended.has(session), missing: new Set(), own: new Set(), until: Number.NaN };
    let watches = this.live.get(session);
    if (!watches) {
      watches = new Set();
      this.live.set(session, watches);
    }
    watches.add(watch);
    return watch;
  }

  /** The call has ended: its watch is removed. */
  done(watch: CallWatch): void {
    const watches = this.live.get(watch.session);
    if (!watches) return;
    watches.delete(watch);
    if (watches.size === 0) this.live.delete(watch.session);
  }

  /** endSession has started for the session: every call under way is refused, and every call that starts while it is kept. */
  ending(session: string): void {
    for (const watch of this.watches(session)) watch.refused = true;
    this.ended.delete(session);
    this.ended.set(session, (this.ended.get(session) ?? 0) + 1);
  }

  /** endSession has finished (or failed): its entry may now be dropped for room. */
  endingDone(session: string): void {
    const running = this.ended.get(session);
    if (running !== undefined && running > 0) this.ended.set(session, running - 1);
    // The oldest entries without an endSession under way go first.
    for (const [id, under] of this.ended) {
      if (this.ended.size <= this.maxEnded) break;
      if (under === 0) this.ended.delete(id);
    }
  }

  /**
   * A request about the session failed: an ended consent refuses every call under way on it; a missing account (for
   * a read of one account) marks it missing on every call under way that depends on it, except the one that asked
   * (`watch`), which does not read it further.
   */
  failed(session: string, problem: ProblemCode | undefined, account?: string, watch?: CallWatch): void {
    if (problem === undefined) return;
    if (CONSENT_OVER.has(problem) || (problem === 'account_not_in_consent' && account === undefined)) {
      for (const live of this.watches(session)) live.refused = true;
    } else if (problem === 'account_not_in_consent' && account !== undefined) {
      watch?.own.add(account);
      for (const live of this.watches(session)) if (live.accounts.has(account)) live.missing.add(account);
    }
  }

  /**
   * A session status from Enable Banking, whoever asked, in whatever order it arrives: not AUTHORIZED, or a validity
   * date that has passed at `now`, refuses every call under way on the session; an account a call depends on that it
   * does not list is missing for that call; every call keeps the earliest validity date. Returns that date (ms) or NaN.
   */
  status(session: string, status: SessionStatus | undefined, now: number, listed: ReadonlySet<string>): number {
    const until = typeof status?.access?.valid_until === 'string' ? Date.parse(status.access.valid_until) : Number.NaN;
    const over = status?.status !== 'AUTHORIZED' || (!Number.isNaN(until) && until <= now);
    for (const watch of this.watches(session)) {
      if (!Number.isNaN(until) && !(watch.until <= until)) watch.until = until;
      if (over) watch.refused = true;
      for (const account of watch.accounts) if (!listed.has(account)) watch.missing.add(account);
    }
    return until;
  }

  /** Whether the call's answer may be returned now. Synchronous, after the call's last await: its own watch and the clock. */
  stands(watch: CallWatch, now: number): boolean {
    if (watch.refused || watch.until <= now) return false;
    for (const account of watch.missing) if (watch.accounts.has(account) && !watch.own.has(account)) return false;
    return true;
  }

  /** Live watches and kept ended sessions (for tests). */
  get size(): { live: number; ended: number } {
    let live = 0;
    for (const watches of this.live.values()) live += watches.size;
    return { live, ended: this.ended.size };
  }

  private watches(session: string): Iterable<CallWatch> {
    return this.live.get(session) ?? [];
  }
}
