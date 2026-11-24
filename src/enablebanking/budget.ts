import { createHash } from 'node:crypto';

/**
 * The budget for fetches nobody is present for. A bank may refuse account
 * data after about four background fetches a day (PSD2), and each refused
 * attempt is still an attempt. So background fetches are counted here, per
 * consent, and refused with a plain message once the day's budget is used,
 * instead of being sent to the bank.
 *
 * In memory only, per process: a restart forgets the count, and several
 * processes each keep their own. The bank's own limit still applies; when it
 * answers that the limit is reached, the consent is closed for background
 * fetches for a while (`block`).
 */

export const DEFAULT_UNATTENDED_FETCHES_PER_DAY = 4;
/** Enable Banking's advice after a bank's rate limit: continue after six hours. */
export const RATE_LIMIT_PAUSE_MS = 6 * 3_600_000;
const WINDOW_MS = 24 * 3_600_000;
const MAX_CONSENTS = 10_000;

export type BudgetDecision = { ok: true; remaining: number } | { ok: false; nextAt: number; limit: number; wanted: number };

interface Entry {
  taken: number[];
  blockedUntil: number;
}

export class UnattendedBudget {
  private readonly entries = new Map<string, Entry>();

  constructor(
    /** Fetches allowed per consent in 24 hours. Zero or less: no local budget. */
    private readonly limit: number,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.limit > 0;
  }

  /** The key a consent is counted under: a hash, so no session id is kept here. */
  private key(consent: string): string {
    return createHash('sha256').update(consent).digest('base64url');
  }

  private entry(consent: string): Entry {
    const key = this.key(consent);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= MAX_CONSENTS) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
      entry = { taken: [], blockedUntil: 0 };
      this.entries.set(key, entry);
    }
    const from = this.now() - WINDOW_MS;
    entry.taken = entry.taken.filter(at => at > from);
    return entry;
  }

  /**
   * Takes `count` fetches for the consent, all or none. A count of zero takes
   * nothing but is still refused while the consent is paused after the bank's
   * rate limit.
   */
  take(consent: string, count = 1): BudgetDecision {
    if (!this.enabled) return { ok: true, remaining: Number.MAX_SAFE_INTEGER };
    const entry = this.entry(consent);
    const now = this.now();
    if (entry.blockedUntil > now) return { ok: false, nextAt: entry.blockedUntil, limit: this.limit, wanted: count };
    if (entry.taken.length + count > this.limit) {
      // The earliest moment enough of the window has passed for `count` fetches to fit.
      const free = this.limit - entry.taken.length;
      const needed = Math.min(count - free, entry.taken.length);
      const nextAt = needed > 0 ? entry.taken[needed - 1]! + WINDOW_MS : now + WINDOW_MS;
      return { ok: false, nextAt, limit: this.limit, wanted: count };
    }
    for (let i = 0; i < count; i += 1) entry.taken.push(now);
    return { ok: true, remaining: this.limit - entry.taken.length };
  }

  /** The bank said its limit is reached: no background fetch for this consent until the pause is over. */
  block(consent: string, pauseMs: number = RATE_LIMIT_PAUSE_MS): void {
    if (!this.enabled) return;
    this.entry(consent).blockedUntil = this.now() + pauseMs;
  }
}

/** A plain sentence for a refused background fetch. Our own text only. */
export function budgetRefusal(decision: Extract<BudgetDecision, { ok: false }>): string {
  const next = new Date(decision.nextAt).toISOString().slice(0, 16).replace('T', ' ');
  const wanted = decision.wanted > decision.limit ? ` This read needs ${decision.wanted}.` : '';
  return (
    `Not read: nobody is present, and only ${decision.limit} automatic read(s) a day are made for a bank consent.${wanted} ` +
    `The next automatic read is possible from ${next} UTC. A read that a person asks for is not limited.`
  );
}
