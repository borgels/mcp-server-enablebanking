// A soak test of the gateway's answers under random interleavings over several sessions. Every answer Enable Banking
// gives is held, the session statuses as well as the reads, and let go in random order, so a status can arrive long
// after a newer one. Meanwhile: revocations at the bank, accounts leaving and coming back, validity dates shortened,
// endSession, the clock moving on, renewals, and sessions of other companies asked about (so that bounded records
// are dropped: `endedSessionsKept` is 2 here).
//
// The oracle is exact. A read is registered as under way before its call starts. Every answer the gateway receives
// while the read is under way (its own session check included) is put on the read's record when it is let go: a
// status other than AUTHORIZED or an error that says the consent is over, a status without the read's account, every
// validity date (the earliest is kept), endSession. When the read's call ends, it must be refused if anything on its
// record says so (or its earliest date has passed by the clock at that moment), and answered otherwise. A refusal
// must hold no bank data. Seeded: SOAK_SEEDS=n runs more seeds, SOAK_FIRST_SEED=n starts elsewhere, SOAK_REPORT=1
// prints the totals, SOAK_COLLECT=1 goes on after a failure and prints the first seed of each kind. Made-up data only.
import { describe, expect, it } from 'vitest';
import { createEnableBankingGateway, type GatewayToolResult } from '../src/gateway.js';
import { KEY } from './helpers.js';

const PEM = KEY.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const START = Date.parse('2026-11-24T10:00:00Z');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise<void>(resolve => setImmediate(resolve));
};

function random(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Session ids of the letters c to f, account ids of digits: no piece of a session id can be in an answer. */
const letters = (next: () => number, length: number) => Array.from({ length }, () => 'cdef'[Math.floor(next() * 4)]).join('');
const sessionIdOf = (next: () => number) => `${letters(next, 8)}-${letters(next, 4)}-4${letters(next, 3)}-8${letters(next, 3)}-${letters(next, 12)}`;
const accountIdOf = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface BankSession {
  status: 'AUTHORIZED' | 'REVOKED' | 'CLOSED';
  accounts: Set<string>;
  until: number;
}
type Snapshot = { error: string } | { status: string; accounts: string[]; until: number };

interface Held {
  session: string;
  respond: () => void;
  /** For a status: what Enable Banking said when the request arrived. */
  snapshot?: Snapshot;
  /** The read this request belongs to (its own session check or its read at the bank). */
  read?: Read;
}

interface Read {
  session: string;
  account: string;
  refused: boolean;
  missing: boolean;
  until: number;
  done: boolean;
  result?: GatewayToolResult;
}

/** Failures by kind, with the first seed of each. SOAK_COLLECT=1 goes on after a failure, to see every kind. */
const failures = new Map<string, string>();
function check(ok: boolean, kind: string, record: string) {
  if (ok) return;
  if (!process.env.SOAK_COLLECT) expect.fail(`${kind}: ${record}`);
  if (!failures.has(kind)) failures.set(kind, record);
}

async function soak(seed: number, steps: number) {
  const next = random(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
  let clock = START;
  let accountsMade = 0;
  const bank = new Map<string, BankSession>();
  const ownerOf = new Map<string, string>();
  const connect = () => {
    const id = sessionIdOf(next);
    const accounts = [accountIdOf(++accountsMade), accountIdOf(++accountsMade)];
    for (const account of accounts) ownerOf.set(account, id);
    bank.set(id, { status: 'AUTHORIZED', accounts: new Set(accounts), until: clock + (5 + Math.floor(next() * 60)) * 60_000 });
    return id;
  };
  const live = [connect(), connect(), connect()];
  const accountsOf = new Map([...bank.entries()].map(([id, session]) => [id, [...session.accounts]]));

  const statuses: Held[] = [];
  const reads: Held[] = [];
  const deletes: Held[] = [];
  /**
   * The documented list of sessions ended here (README, "Answers after a withdrawal"), as the oracle keeps it: each
   * session with how many endSession calls for it are under way, newest last; at most ENDED_KEPT, the oldest without
   * an endSession under way dropped first. A read that starts while its session is on the list must be refused.
   */
  const endedList = new Map<string, number>();
  const ENDED_KEPT = 2;
  const startEnd = (id: string) => {
    const running = endedList.get(id) ?? 0;
    endedList.delete(id);
    endedList.set(id, running + 1);
  };
  const finishEnd = (id: string) => {
    const running = endedList.get(id);
    if (running !== undefined && running > 0) endedList.set(id, running - 1);
    for (const [entry, under] of endedList) {
      if (endedList.size <= ENDED_KEPT) break;
      if (under === 0) endedList.delete(entry);
    }
  };
  /** endSession, not awaited: its DELETE is held until let go. */
  const endSession = async (id: string) => {
    for (const read of underWay) if (read.session === id && !read.done) read.refused = true;
    startEnd(id);
    void gw.endSession({ sessionId: id }).catch(() => undefined);
    await settle();
  };
  const deliverDelete = async (held: Held) => {
    deletes.splice(deletes.indexOf(held), 1);
    held.respond();
    await settle();
    finishEnd(held.session);
    collect();
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const sessionMatch = /^\/sessions\/([^/]+)$/.exec(url.pathname);
    if (sessionMatch) {
      const id = sessionMatch[1]!;
      const session = bank.get(id) ?? { status: 'AUTHORIZED', accounts: new Set<string>(), until: clock + 3_600_000 };
      if ((init?.method ?? 'GET') === 'DELETE') {
        // Held too, and sometimes failing: the session is closed at the bank only when one succeeds.
        return new Promise<Response>(resolve => {
          deletes.push({
            session: id,
            respond: () => {
              if (next() < 0.3) {
                counts.endFailures += 1;
                resolve(json({ error: 'INTERNAL_ERROR' }, 500));
              } else {
                session.status = 'CLOSED';
                resolve(json({}));
              }
            },
          });
        });
      }
      const snapshot: Snapshot =
        session.status === 'REVOKED' && next() < 0.3
          ? { error: 'REVOKED_SESSION' }
          : { status: session.status, accounts: [...session.accounts], until: session.until };
      return new Promise<Response>(resolve => {
        statuses.push({
          session: id,
          snapshot,
          respond: () =>
            resolve(
              'error' in snapshot
                ? json({ error: snapshot.error }, 401)
                : json({ status: snapshot.status, accounts: snapshot.accounts, access: { valid_until: new Date(snapshot.until).toISOString() } }),
            ),
        });
      });
    }
    const [, account] = /^\/accounts\/([^/]+)\/balances$/.exec(url.pathname)!;
    return new Promise<Response>(resolve => {
      reads.push({
        session: ownerOf.get(account!)!,
        respond: () => resolve(json({ balances: [{ balance_type: 'ITAV', balance_amount: { currency: 'EUR', amount: '5.00' } }] })),
      });
    });
  };
  const gw = createEnableBankingGateway({
    applicationId: 'app-0000-test',
    privateKey: PEM,
    apiBaseUrl: 'https://eb.test',
    fetchImpl,
    now: () => clock,
    endedSessionsKept: 2,
  });

  const underWay: Read[] = [];
  const counts = { reads: 0, answered: 0, refused: 0, refusedForAccount: 0, refusedForConsent: 0, refusedForDate: 0, statusesOutOfOrder: 0, revocations: 0, removals: 0, restorations: 0, shortened: 0, ends: 0, endFailures: 0, concurrentEnds: 0, advances: 0, renewals: 0, otherSessions: 0, readsOnEndedList: 0 };

  /** The read's call has ended: the oracle. */
  const judge = (read: Read) => {
    const result = read.result!;
    const answered = result.isError !== true;
    const why = read.refused ? 'consent' : read.missing ? 'account' : read.until <= clock ? 'date' : undefined;
    const record = JSON.stringify({ seed, read: { ...read, result: undefined }, clock, text: result.content[0]?.text });
    if (why) {
      check(!answered, `an answer after a withdrawal the gateway knew (${why})`, record);
      counts[why === 'consent' ? 'refusedForConsent' : why === 'account' ? 'refusedForAccount' : 'refusedForDate'] += 1;
    } else {
      check(answered, 'a refusal with nothing against the read', record);
    }
    if (answered) counts.answered += 1;
    else {
      counts.refused += 1;
      check(!/5\.00|ITAV|balances/.test(JSON.stringify(result)), 'a refusal with bank data', record);
    }
  };
  const collect = () => {
    for (const read of [...underWay]) {
      if (!read.done) continue;
      underWay.splice(underWay.indexOf(read), 1);
      judge(read);
    }
  };

  /** Let one held status go: what it says goes on every read under way on its session. */
  const deliverStatus = async (held: Held) => {
    if (held !== statuses[0]) counts.statusesOutOfOrder += 1;
    statuses.splice(statuses.indexOf(held), 1);
    const snapshot = held.snapshot!;
    for (const read of underWay) {
      if (read.session !== held.session || read.done) continue;
      if ('error' in snapshot) {
        read.refused = true;
        continue;
      }
      if (!(read.until <= snapshot.until)) read.until = snapshot.until;
      if (snapshot.status !== 'AUTHORIZED' || snapshot.until <= clock) read.refused = true;
      if (!snapshot.accounts.includes(read.account)) read.missing = true;
    }
    held.respond();
    await settle();
    collect();
  };
  const deliverRead = async (held: Held) => {
    reads.splice(reads.indexOf(held), 1);
    held.respond();
    await settle();
    collect();
  };

  for (let step = 0; step < steps; step += 1) {
    const roll = next();
    const slot = Math.floor(next() * live.length);
    const sessionId = live[slot]!;
    const session = bank.get(sessionId)!;
    if (roll < 0.3) {
      // A read, under way from before its call starts.
      counts.reads += 1;
      const account = pick(accountsOf.get(sessionId)!);
      const read: Read = { session: sessionId, account, refused: false, missing: false, until: Number.NaN, done: false };
      if (endedList.has(sessionId)) {
        // Ended here, and still on the list: refused, whatever Enable Banking says now.
        read.refused = true;
        counts.readsOnEndedList += 1;
      }
      underWay.push(read);
      void gw.callTool('get_balances', { account }, { credentials: { sessionId, accountIds: accountsOf.get(sessionId)! } }).then(result => {
        read.result = result;
        read.done = true;
      });
      await settle();
      collect();
    } else if (roll < 0.5 && statuses.length > 0) {
      await deliverStatus(pick(statuses));
    } else if (roll < 0.62 && reads.length > 0) {
      await deliverRead(pick(reads));
    } else if (roll < 0.68) {
      // The host's renewal reminder: a status request, held like any other.
      void gw.sessionStatus({ sessionId }).catch(() => undefined);
      await settle();
    } else if (roll < 0.71) {
      if (session.status === 'AUTHORIZED') {
        counts.revocations += 1;
        session.status = 'REVOKED';
      }
    } else if (roll < 0.77) {
      const account = pick(accountsOf.get(sessionId)!);
      if (session.accounts.has(account)) {
        counts.removals += 1;
        session.accounts.delete(account);
      } else {
        counts.restorations += 1;
        session.accounts.add(account);
      }
    } else if (roll < 0.81) {
      // Enable Banking gives an earlier validity date than before.
      counts.shortened += 1;
      session.until = Math.min(session.until, clock + (1 + Math.floor(next() * 3)) * 60_000);
    } else if (roll < 0.83) {
      counts.ends += 1;
      if (deletes.some(held => held.session === sessionId)) counts.concurrentEnds += 1;
      await endSession(sessionId);
      collect();
    } else if (roll < 0.86 && deletes.length > 0) {
      await deliverDelete(pick(deletes));
    } else if (roll < 0.89) {
      counts.advances += 1;
      clock += Math.floor(next() * 3) * 60_000;
    } else if (roll < 0.97) {
      // Another company's session is asked about: records of other sessions come and go.
      counts.otherSessions += 1;
      const other = sessionIdOf(next);
      bank.set(other, { status: 'AUTHORIZED', accounts: new Set(), until: clock + 3_600_000 });
      if (next() < Number(process.env.SOAK_END_OTHERS ?? 0.3)) {
        // Sometimes one that is then ended: the list of ended sessions overflows.
        await endSession(other);
        const held = deletes.find(entry => entry.session === other);
        if (held) await deliverDelete(held);
      }
      void gw.sessionStatus({ sessionId: other }).catch(() => undefined);
      await settle();
      const held = statuses.find(entry => entry.session === other);
      if (held) await deliverStatus(held);
    } else if (session.status !== 'AUTHORIZED' || clock >= session.until) {
      counts.renewals += 1;
      const id = connect();
      accountsOf.set(id, [...bank.get(id)!.accounts]);
      live[slot] = id;
    }
  }
  // Everything still held is let go, in random order, until every read has ended.
  for (let guard = 0; (underWay.length > 0 || statuses.length > 0 || reads.length > 0 || deletes.length > 0) && guard < 10_000; guard += 1) {
    const roll = next();
    if (statuses.length > 0 && roll < 0.4) await deliverStatus(pick(statuses));
    else if (reads.length > 0 && roll < 0.8) await deliverRead(pick(reads));
    else if (deletes.length > 0) await deliverDelete(pick(deletes));
    else if (statuses.length > 0) await deliverStatus(pick(statuses));
    else if (reads.length > 0) await deliverRead(pick(reads));
    else await settle();
    collect();
  }
  expect(underWay, `seed ${seed}: reads that never ended`).toEqual([]);
  return counts;
}

describe('the gateway under random interleavings', () => {
  const seeds = Number(process.env.SOAK_SEEDS ?? 40);
  it(
    `answers exactly when it may, over ${seeds} seeds`,
    async () => {
      const total: Record<string, number> = {};
      const first = Number(process.env.SOAK_FIRST_SEED ?? 1);
      for (let seed = first; seed < first + seeds; seed += 1) {
        const counts = await soak(seed, 300);
        for (const [key, value] of Object.entries(counts)) total[key] = (total[key] ?? 0) + value;
      }
      if (process.env.SOAK_REPORT) console.log(JSON.stringify(total));
      for (const [kind, record] of failures) console.log(`FIRST ${kind}: ${record}`);
      expect([...failures.keys()]).toEqual([]);
      // Each outcome happens often enough for the test to mean something.
      expect(total.answered!).toBeGreaterThan(seeds * 5);
      expect(total.refusedForConsent!).toBeGreaterThan(seeds);
      expect(total.refusedForAccount!).toBeGreaterThan(seeds / 4);
      expect(total.refusedForDate!).toBeGreaterThan(seeds / 10);
      expect(total.statusesOutOfOrder!).toBeGreaterThan(seeds * 5);
      expect(total.concurrentEnds!).toBeGreaterThan(seeds / 10);
      expect(total.endFailures!).toBeGreaterThan(seeds);
      expect(total.readsOnEndedList!).toBeGreaterThan(seeds);
    },
    Math.max(120_000, seeds * 2_000),
  );
});
