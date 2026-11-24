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
 *   lists an account an earlier status listed, or a read of it failing with
 *   ACCOUNT_DOES_NOT_EXIST;
 * - when the consent runs out: the earliest validity date any answer about the
 *   session gave.
 * Every request this instance makes about a session feeds it: the session
 * check at the start of every call, every read of an account, and the consent
 * helpers sessionStatus, completeSession and endSession.
 *
 * Calls run side by side; each call notes where the clock stood when it began
 * (`begin`) and the validity date its own session check gave, and its answer
 * is returned only when, checked synchronously after the call's last await and
 * against the time of that check, nothing negative was learned since against
 * its consent or an account its answer may come from, and no known validity
 * date has passed (`stands`). What the call learned itself about an account it
 * then did not read (a search that skips it) does not count against it.
 *
 * The record of a session does not grow with use: a status that says the
 * same as before changes nothing. It holds, per session, whether it was ended
 * here, the counter of the last word against the consent, the counter of the
 * last word against each account, the accounts any status listed, and the
 * earliest validity date. Nothing of the bank's answers is kept here.
 *
 * At most MAX_TRACKED_SESSIONS sessions are held, the least recently changed
 * dropped first. Dropping a record that holds only what was in order loses
 * nothing a call depends on (each call has its own session check). Dropping
 * one that holds a word against the consent, an account or an earlier date
 * refuses every call that began before it was dropped; calls that begin
 * afterwards ask Enable Banking themselves.
 */
export const MAX_TRACKED_SESSIONS = 10_000;
/** Accounts remembered per session; a session listing more counts as a word against its consent (fail closed). */
const MAX_KNOWN_ACCOUNTS = 1_000;

/** What a request failing with these says: the consent itself is over. */
const CONSENT_OVER: ReadonlySet<ProblemCode> = new Set<ProblemCode>(['consent_expired', 'consent_revoked', 'consent_not_active']);

interface Learned {
  /** Ended here by endSession: never read again in this instance. */
  ended: boolean;
  /** The counter of the last word against the whole consent; 0: none. */
  consent: number;
  /** The counter of the last word against each account. */
  accounts: Map<string, number>;
  /** Every account a status of the session listed: one a later status leaves out has left the consent. */
  known: Set<string>;
  /** The earliest validity date any answer about the session gave (ms), or NaN. */
  until: number;
  /** Whether an answer gave an earlier validity date than one before it: a word against the calls under way. */
  lowered: boolean;
}

/** One call's view: when it began, which accounts its answer may come from, and what it learned itself. */
export interface CallWatch {
  readonly session: string;
  readonly at: number;
  /** The accounts the answer may come from; undefined: every account of the session. */
  accounts?: ReadonlySet<string>;
  /** Accounts this call itself learned had left the consent (and so did not read). */
  readonly own: Set<string>;
  /** The validity date the call's own session check gave (ms), or NaN. */
  until: number;
}

export class Withdrawals {
  private clock = 0;
  /** Calls that began before this were under way when a record with a word against it was dropped: refused. */
  private floor = 0;
  private readonly sessions = new Map<string, Learned>();

  begin(session: string): CallWatch {
    return { session, at: this.clock, own: new Set(), until: Number.NaN };
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
   * (at `now`), is a word against the consent; an account an earlier status listed and this one does not has left;
   * the earliest validity date is the latest moment any answer may be returned. A status that says what the record
   * already holds changes nothing. Returns the status's validity date (ms), or NaN.
   */
  status(session: string, status: SessionStatus | undefined, now: number, listed: ReadonlySet<string>): number {
    const learned = this.entry(session);
    const until = typeof status?.access?.valid_until === 'string' ? Date.parse(status.access.valid_until) : Number.NaN;
    if (!Number.isNaN(until)) {
      if (Number.isNaN(learned.until)) learned.until = until;
      else if (until < learned.until) {
        learned.until = until;
        learned.lowered = true;
      }
    }
    if (status?.status !== 'AUTHORIZED' || (!Number.isNaN(until) && until <= now)) {
      learned.consent = ++this.clock;
      return until;
    }
    for (const account of learned.known) if (!listed.has(account)) learned.accounts.set(account, ++this.clock);
    for (const account of listed) {
      if (learned.known.size >= MAX_KNOWN_ACCOUNTS && !learned.known.has(account)) {
        learned.consent = ++this.clock;
        break;
      }
      learned.known.add(account);
    }
    return until;
  }

  /** Whether an answer of the call may be returned now. Synchronous: called after the call's last await, at `now`. */
  stands(watch: CallWatch, now: number): boolean {
    if (watch.at < this.floor) return false;
    if (watch.until <= now) return false;
    const learned = this.sessions.get(watch.session);
    if (!learned) return true;
    if (learned.ended || learned.consent > watch.at || learned.until <= now) return false;
    for (const [account, at] of learned.accounts) {
      if (at <= watch.at || watch.own.has(account)) continue;
      if (watch.accounts === undefined || watch.accounts.has(account)) return false;
    }
    return true;
  }

  /** How many sessions are on record (for tests). */
  get size(): number {
    return this.sessions.size;
  }

  private entry(session: string): Learned {
    let learned = this.sessions.get(session);
    if (learned) {
      // The most recently changed last, so the least recently changed is dropped first.
      this.sessions.delete(session);
    } else {
      learned = { ended: false, consent: 0, accounts: new Map(), known: new Set(), until: Number.NaN, lowered: false };
    }
    this.sessions.set(session, learned);
    while (this.sessions.size > MAX_TRACKED_SESSIONS) {
      const [oldest, record] = this.sessions.entries().next().value as [string, Learned];
      this.sessions.delete(oldest);
      if (record.ended || record.consent > 0 || record.accounts.size > 0 || record.lowered) {
        // A word against a call under way is lost: every call begun up to now is refused; calls begun later are not.
        this.clock += 1;
        this.floor = this.clock;
      }
    }
    return learned;
  }
}
