import type { SessionStatus } from '../enablebanking/api.js';
import type { ProblemCode } from '../enablebanking/problems.js';

/**
 * What one gateway instance has learned, while calls run, that can make an
 * answer of a call under way invalid:
 * - a session ended through endSession;
 * - a consent Enable Banking says is over: a session status other than
 *   AUTHORIZED, a validity date that has passed, or a request about the
 *   session or one of its accounts failing with an ended consent;
 * - an account that has left the consent: a session status that no longer
 *   lists it, or a read of it failing with ACCOUNT_DOES_NOT_EXIST;
 * - when the consent runs out (its `valid_until`): the earliest date any answer
 *   about the session gave.
 * Every request this instance makes about a session feeds it: the session
 * check at the start of every call, every read of an account, and the consent
 * helpers sessionStatus, completeSession and endSession.
 *
 * Calls run side by side; each call notes where the clock stood when it began
 * (`begin`), and its answer is returned only when, checked synchronously after
 * the call's last await and against the time of that check, nothing was
 * learned since against its consent or an account its answer may come from,
 * and no known validity date has passed (`stands`). What the call learned
 * itself about an account it then did not read (a search that skips it) does
 * not count against it.
 *
 * Nothing of the bank's answers is kept here: only session ids, account ids,
 * dates of validity and a counter. A session ended through endSession stays
 * ended in this instance. At most MAX_TRACKED_SESSIONS sessions are held, the
 * least recently changed dropped first; every call under way when an entry is
 * dropped is refused, so a dropped entry never lets an answer through.
 */
export const MAX_TRACKED_SESSIONS = 10_000;
/** Session listings kept per session; when more arrive, the oldest is dropped and counts as a word against the consent. */
const MAX_LISTINGS = 16;

/** What a request failing with these says: the consent itself is over. */
const CONSENT_OVER: ReadonlySet<ProblemCode> = new Set<ProblemCode>(['consent_expired', 'consent_revoked', 'consent_not_active']);

interface Learned {
  /** Ended here by endSession: never read again in this instance. */
  ended: boolean;
  /** When a word against the whole consent was last learned. */
  consent: number;
  /** When a word against each account was last learned. */
  accounts: Map<string, number>;
  /** The accounts each session status listed, with when it was learned: an account not listed has left. */
  listings: Array<{ at: number; accounts: ReadonlySet<string> }>;
  /** The earliest validity date any answer about the session gave (ms), or NaN. */
  until: number;
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
  /** Calls that began before this were under way when an entry was dropped: they are not trusted. */
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

  /**
   * Acts on a failed request about a session: an ended consent is a word against it; a missing account (for a read
   * of one account) a word against that account, which the call that learned it (`watch`) does not hold against itself.
   */
  failed(session: string, problem: ProblemCode | undefined, account?: string, watch?: CallWatch): void {
    if (problem === undefined) return;
    if (CONSENT_OVER.has(problem) || (problem === 'account_not_in_consent' && account === undefined)) {
      this.entry(session).consent = ++this.clock;
    } else if (problem === 'account_not_in_consent' && account !== undefined) {
      this.entry(session).accounts.set(account, ++this.clock);
      watch?.own.add(account);
    }
  }

  /**
   * Acts on a session status from Enable Banking, whoever asked: not AUTHORIZED, or a validity date that has passed
   * (at `now`), is a word against the consent; the accounts it lists are the only ones it still covers; its validity
   * date is the latest any answer may be returned.
   */
  status(session: string, status: SessionStatus | undefined, now: number, listed: ReadonlySet<string>): void {
    const learned = this.entry(session);
    const until = typeof status?.access?.valid_until === 'string' ? Date.parse(status.access.valid_until) : Number.NaN;
    if (!Number.isNaN(until) && !(learned.until <= until)) learned.until = until;
    if (status?.status !== 'AUTHORIZED' || (!Number.isNaN(until) && until <= now)) {
      learned.consent = ++this.clock;
      return;
    }
    learned.listings.push({ at: ++this.clock, accounts: listed });
    if (learned.listings.length > MAX_LISTINGS) {
      learned.listings.shift();
      // What the dropped listing said is no longer known: it counts against every call under way.
      learned.consent = ++this.clock;
    }
  }

  /** Whether an answer of the call may be returned now. Synchronous: called after the call's last await, at `now`. */
  stands(watch: CallWatch, now: number): boolean {
    if (watch.at < this.floor) return false;
    const learned = this.sessions.get(watch.session);
    if (!learned) return true;
    if (learned.ended || learned.consent > watch.at) return false;
    if (learned.until <= now) return false;
    const counts = (account: string) => !watch.own.has(account) && (watch.accounts === undefined || watch.accounts.has(account));
    for (const [account, at] of learned.accounts) {
      if (at > watch.at && counts(account)) return false;
    }
    for (const listing of learned.listings) {
      if (listing.at <= watch.at) continue;
      // A listing learned after the call began: an account the call depends on that it does not list has left.
      if (watch.accounts === undefined) return false;
      for (const account of watch.accounts) if (counts(account) && !listing.accounts.has(account)) return false;
    }
    return true;
  }

  private entry(session: string): Learned {
    let learned = this.sessions.get(session);
    if (learned) {
      // The most recently changed last, so the least recently changed is dropped first.
      this.sessions.delete(session);
    } else {
      learned = { ended: false, consent: 0, accounts: new Map(), listings: [], until: Number.NaN };
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
