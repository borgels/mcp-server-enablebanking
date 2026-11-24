// A soak test of the gateway's answers under random interleavings: reads held at the bank, status checks, accounts
// leaving and coming back, revocations at the bank, endSession and the clock moving on, over several sessions. It
// asserts that (a) no read answers after a withdrawal the gateway could have known (it learned it while the read was
// under way, or the validity date passed), and (b) no read is refused when nothing negative happened to its session
// or account. Seeded, so a failure can be repeated: SOAK_SEEDS=n runs more seeds. Made-up data only.
import { describe, expect, it } from 'vitest';
import { createEnableBankingGateway, type GatewayToolResult } from '../src/gateway.js';
import { KEY } from './helpers.js';

const PEM = KEY.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const START = Date.parse('2026-11-24T10:00:00Z');
/** Made-up session ids (the letters c to f only, so no piece of one is in an answer or the key's fixed texts): three connections at a time. */
const hex = (next: () => number, length: number) => Array.from({ length }, () => 'cdef'[Math.floor(next() * 4)]).join('');
const sessionIdOf = (next: () => number) => `${hex(next, 8)}-${hex(next, 4)}-4${hex(next, 3)}-8${hex(next, 3)}-${hex(next, 12)}`;
const ACCOUNTS = ['a1a1a1a1-0000-4000-8000-00000000a001', 'b2b2b2b2-0000-4000-8000-00000000b002'];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function random(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

interface Session {
  status: 'AUTHORIZED' | 'REVOKED' | 'CLOSED';
  accounts: Set<string>;
  until: number;
}

interface Pending {
  session: string;
  account: string;
  /** The session and account were in order at the bank when the read began. */
  startedOk: boolean;
  /** The validity date the read's own session check saw. */
  until: number;
  /** Something negative for its session or account happened at the bank while it was under way. */
  negative: boolean;
  /** The gateway learned such a thing (a request about the session after it happened) while it was under way. */
  learned: boolean;
  result: Promise<GatewayToolResult>;
  release: () => void;
}

async function soak(seed: number, steps: number) {
  const next = random(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
  let clock = START;
  const bank = new Map<string, Session>();
  let made = 0;
  const connect = () => {
    made += 1;
    const id = sessionIdOf(next);
    bank.set(id, { status: 'AUTHORIZED', accounts: new Set(ACCOUNTS), until: clock + (5 + Math.floor(next() * 60)) * 60_000 });
    return id;
  };
  const live = [connect(), connect(), connect()];
  /** Reads waiting at the bank, in the order they arrived. */
  const waiting: Array<() => void> = [];
  let arrived: (() => void) | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const sessionMatch = /^\/sessions\/([^/]+)$/.exec(url.pathname);
    if (sessionMatch) {
      const session = bank.get(sessionMatch[1]!)!;
      if ((init?.method ?? 'GET') === 'DELETE') {
        session.status = 'CLOSED';
        return json({});
      }
      if (session.status === 'REVOKED' && next() < 0.3) return json({ error: 'REVOKED_SESSION' }, 401);
      return json({ status: session.status, accounts: [...session.accounts], access: { valid_until: new Date(session.until).toISOString() } });
    }
    // Held until the test lets it go. The balance itself is always given: what the gateway knows decides.
    await new Promise<void>(resolve => {
      waiting.push(resolve);
      arrived?.();
    });
    return json({ balances: [{ balance_type: 'ITAV', balance_amount: { currency: 'EUR', amount: '5.00' } }] });
  };
  const gw = createEnableBankingGateway({ applicationId: 'app-0000-test', privateKey: PEM, apiBaseUrl: 'https://eb.test', fetchImpl, now: () => clock });

  const pending: Pending[] = [];
  const counts = { reads: 0, answered: 0, refused: 0, statusChecks: 0, revocations: 0, removals: 0, restorations: 0, ends: 0, advances: 0, renewals: 0, mustRefuse: 0, mustAnswer: 0, eitherWay: 0, refusedAtStart: 0 };

  /** A request about the session: what is negative at the bank now (its status, a missing account) is learned. */
  const learn = (sessionId: string) => {
    const session = bank.get(sessionId)!;
    for (const read of pending) {
      if (read.session !== sessionId || !read.negative) continue;
      if (session.status !== 'AUTHORIZED' || !session.accounts.has(read.account)) read.learned = true;
    }
  };
  const negative = (sessionId: string, account?: string) => {
    for (const read of pending) if (read.session === sessionId && (account === undefined || account === read.account)) read.negative = true;
  };

  const finish = async (read: Pending) => {
    pending.splice(pending.indexOf(read), 1);
    read.release();
    const result = await read.result;
    const ok = result.isError !== true;
    const expired = clock >= read.until;
    if (!read.startedOk || read.learned || expired) {
      expect(ok, `seed ${seed}: an answer after a withdrawal the gateway knew (${JSON.stringify({ ...read, result: undefined })})`).toBe(false);
      counts.mustRefuse += 1;
    } else if (!read.negative) {
      expect(ok, `seed ${seed}: a refusal with nothing negative: ${result.content[0]?.text}`).toBe(true);
      counts.mustAnswer += 1;
    } else {
      counts.eitherWay += 1;
    }
    if (ok) counts.answered += 1;
    else counts.refused += 1;
  };

  for (let step = 0; step < steps; step += 1) {
    const roll = next();
    const slot = Math.floor(next() * live.length);
    const sessionId = live[slot]!;
    const session = bank.get(sessionId)!;
    if (roll < 0.35) {
      // A read of one account, held at the bank until a later step lets it go.
      const account = pick(ACCOUNTS);
      counts.reads += 1;
      const startedOk = session.status === 'AUTHORIZED' && session.accounts.has(account) && clock < session.until;
      // The read's own session check is a request about the session: what is negative now is learned.
      learn(sessionId);
      const reached = startedOk ? new Promise<void>(resolve => (arrived = resolve)) : undefined;
      const result = gw.callTool('get_balances', { account }, { credentials: { sessionId, accountIds: ACCOUNTS } });
      if (reached) {
        await reached;
        const release = waiting.pop()!;
        pending.push({ session: sessionId, account, startedOk, until: session.until, negative: false, learned: false, result, release });
      } else {
        const refused = await result;
        expect(refused.isError, `seed ${seed}: a read began under a withdrawn consent and answered`).toBe(true);
        counts.refused += 1;
        counts.refusedAtStart += 1;
      }
    } else if (roll < 0.6 && pending.length > 0) {
      await finish(pick(pending));
    } else if (roll < 0.7) {
      counts.statusChecks += 1;
      learn(sessionId);
      await gw.sessionStatus({ sessionId }).catch(() => undefined);
    } else if (roll < 0.76) {
      if (session.status === 'AUTHORIZED') {
        counts.revocations += 1;
        session.status = 'REVOKED';
        negative(sessionId);
      }
    } else if (roll < 0.84) {
      const account = pick(ACCOUNTS);
      if (session.accounts.has(account)) {
        counts.removals += 1;
        session.accounts.delete(account);
        negative(sessionId, account);
      } else {
        // The account comes back (the person adds it again at the bank): nothing negative.
        counts.restorations += 1;
        session.accounts.add(account);
      }
    } else if (roll < 0.87) {
      counts.ends += 1;
      negative(sessionId);
      for (const read of pending) if (read.session === sessionId) read.learned = true;
      await gw.endSession({ sessionId });
    } else if (roll < 0.95) {
      counts.advances += 1;
      clock += Math.floor(next() * 3) * 60_000;
    } else if (session.status !== 'AUTHORIZED' || clock >= session.until) {
      // The host connects the company again: a new session takes the place of one that is over.
      counts.renewals += 1;
      live[slot] = connect();
    }
  }
  while (pending.length > 0) await finish(pending[0]!);
  return counts;
}

describe('the gateway under random interleavings', () => {
  const seeds = Number(process.env.SOAK_SEEDS ?? 40);
  it(`answers exactly when it may, over ${seeds} seeds`, async () => {
    const total: Record<string, number> = {};
    for (let seed = 1; seed <= seeds; seed += 1) {
      const counts = await soak(seed, 300);
      for (const [key, value] of Object.entries(counts)) total[key] = (total[key] ?? 0) + value;
    }
    if (process.env.SOAK_REPORT) console.log(JSON.stringify(total));
    // Both outcomes happen often enough for the test to mean something.
    expect(total.mustAnswer!).toBeGreaterThan(seeds * 10);
    expect(total.mustRefuse!).toBeGreaterThan(seeds * 5);
  }, Math.max(120_000, seeds * 1_000));
});
