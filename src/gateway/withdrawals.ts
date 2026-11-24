import type { ProblemCode } from '../enablebanking/problems.js';

/**
 * What one gateway instance has learned, while calls run, about consents and
 * accounts leaving: a session ended through endSession, a consent Enable
 * Banking says is over, an account it says has left the consent. Calls run
 * side by side; each call notes where the clock stood when it began
 * (`begin`), and its answer is returned only when, checked synchronously after
 * the call's last await, nothing was learned since against its consent or an
 * account its answer may come from (`stands`). What the call learned itself
 * about an account it then did not read (a search that skips it) does not
 * count against it.
 *
 * Nothing about the bank's answers is kept here: only session ids, account
 * ids and a counter. A session ended through endSession stays ended in this
 * instance. At most MAX_TRACKED_SESSIONS sessions are held, the least recently
 * changed dropped first; a call that began before a dropped entry changed is
 * refused, so a dropped entry never lets an answer through.
 */
export const MAX_TRACKED_SESSIONS = 10_000;

/** What a read failing with these says: the consent itself is over. */
const CONSENT_OVER: ReadonlySet<ProblemCode> = new Set<ProblemCode>(['consent_expired', 'consent_revoked', 'consent_not_active']);

interface Learned {
  /** Ended here by endSession: never read again in this instance. */
  ended: boolean;
  /** When a word against the whole consent was last learned. */
  consent: number;
  /** When a word against each account was last learned. */
  accounts: Map<string, number>;
}

/** One call's view: when it began, which accounts its answer may come from, and what it learned itself. */
export interface CallWatch {
  readonly session: string;
  readonly at: number;
  /** The accounts the answer may come from; undefined: every account of the session. */
  accounts?: ReadonlySet<string>;
  /** Accounts this call itself learned had left the consent (and so did not read). */
  readonly own: Set<string>;
}

export class Withdrawals {
  private clock = 0;
  /** Calls that began before this were made before an entry was dropped: they are not trusted. */
  private floor = 0;
  private readonly sessions = new Map<string, Learned>();

  begin(session: string): CallWatch {
    return { session, at: this.clock, own: new Set() };
  }

  /** The session was ended here: no answer read under it is returned any more by this instance. */
  end(session: string): void {
    const learned = this.entry(session);
    learned.ended = true;
    learned.consent = ++this.clock;
  }

  /** Acts on what Enable Banking said about a session (and, for a read of one account, that account). */
  learn(watch: CallWatch | undefined, problem: ProblemCode | undefined, account?: string): void {
    if (!watch || problem === undefined) return;
    if (CONSENT_OVER.has(problem) || (problem === 'account_not_in_consent' && account === undefined)) {
      this.entry(watch.session).consent = ++this.clock;
    } else if (problem === 'account_not_in_consent' && account !== undefined) {
      this.entry(watch.session).accounts.set(account, ++this.clock);
      watch.own.add(account);
    }
  }

  /** Accounts the session no longer lists: they have left the consent. */
  left(watch: CallWatch | undefined, accounts: Iterable<string>): void {
    for (const account of accounts) this.learn(watch, 'account_not_in_consent', account);
  }

  /** Whether an answer of the call may be returned now. Synchronous: called after the call's last await. */
  stands(watch: CallWatch): boolean {
    if (watch.at < this.floor) return false;
    const learned = this.sessions.get(watch.session);
    if (!learned) return true;
    if (learned.ended || learned.consent > watch.at) return false;
    for (const [account, at] of learned.accounts) {
      if (at <= watch.at || watch.own.has(account)) continue;
      if (watch.accounts === undefined || watch.accounts.has(account)) return false;
    }
    return true;
  }

  private entry(session: string): Learned {
    let learned = this.sessions.get(session);
    if (learned) {
      // The most recently changed last, so the least recently changed is dropped first.
      this.sessions.delete(session);
    } else {
      learned = { ended: false, consent: 0, accounts: new Map() };
    }
    this.sessions.set(session, learned);
    while (this.sessions.size > MAX_TRACKED_SESSIONS) {
      const [oldest] = this.sessions.keys();
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
      // Every call begun up to now may depend on what was dropped: it is refused; calls begun from now on are not.
      this.clock += 1;
      this.floor = this.clock;
    }
    return learned;
  }
}
