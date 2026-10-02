import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Bank sessions for ONE company, encrypted at rest (AES-256-GCM).
 *
 * A session id plus the application key reads a company's bank data, so it is
 * kept like a token: never in config, never in a tool result, never in a log.
 * Only accounts that were bound to this company when the consent was completed
 * are stored at all — the uids of other companies' accounts in the same bank
 * session are thrown away, so this instance has no handle on them.
 *
 * The file also records which company it belongs to; an instance pinned to a
 * different company refuses to open it (a wrong volume mount fails loudly
 * instead of serving another company's consent).
 */

export interface BoundAccount {
  uid: string;
  iban: string;
  name?: string;
  currency?: string;
}

export interface ExcludedAccount {
  /** Masked: the store never keeps a full IBAN it is not allowed to read. */
  iban: string;
  reason: 'other_company' | 'unregistered' | 'no_iban';
}

export interface StoredSession {
  key: string;
  sessionId: string;
  aspsp: { name: string; country: string };
  psuType: 'business' | 'personal';
  validUntil: string;
  createdAt: string;
  createdBy: string;
  accounts: BoundAccount[];
  excluded: ExcludedAccount[];
}

interface StoreFile {
  company: string;
  sessions: StoredSession[];
  /** Consent states already used, until they would have expired anyway. */
  usedStates: Array<{ nonce: string; expiresAt: number }>;
}

interface Envelope {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

export function parseKey(value: string | undefined): Buffer {
  if (!value) throw new Error('ENABLEBANKING_ENCRYPTION_KEY is not set (32 bytes, hex or base64: openssl rand -hex 32)');
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('ENABLEBANKING_ENCRYPTION_KEY must decode to exactly 32 bytes');
  return key;
}

function derive(master: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `mcp-server-enablebanking/${purpose}`, 32));
}

export class SessionStore {
  private readonly path: string;
  private readonly storeKey: Buffer;
  private readonly stateKey: Buffer;

  constructor(
    private readonly company: string,
    dataDir: string,
    masterKey: Buffer,
  ) {
    this.path = join(dataDir, `sessions-${company}.enc.json`);
    this.storeKey = derive(masterKey, `store/${company}`);
    this.stateKey = derive(masterKey, `consent-state/${company}`);
    mkdirSync(dataDir, { recursive: true });
  }

  private read(): StoreFile {
    if (!existsSync(this.path)) return { company: this.company, sessions: [], usedStates: [] };
    const envelope = JSON.parse(readFileSync(this.path, 'utf8')) as Envelope;
    const decipher = createDecipheriv('aes-256-gcm', this.storeKey, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    decipher.setAAD(Buffer.from(this.company));
    let plain: string;
    try {
      plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error(`the session store ${this.path} cannot be decrypted for company ${this.company} (wrong key or wrong company)`);
    }
    const file = JSON.parse(plain) as StoreFile;
    if (file.company !== this.company) {
      throw new Error(`the session store belongs to ${file.company}, not ${this.company}; refusing to use it`);
    }
    return file;
  }

  private write(file: StoreFile): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.storeKey, iv);
    cipher.setAAD(Buffer.from(this.company));
    const data = Buffer.concat([cipher.update(JSON.stringify(file), 'utf8'), cipher.final()]);
    const envelope: Envelope = { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(envelope), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  sessions(): StoredSession[] {
    return this.read().sessions;
  }

  /** Store a session; returns the one it replaced (same bank + PSU type), if any. */
  upsert(session: StoredSession): StoredSession | undefined {
    const file = this.read();
    const previous = file.sessions.find(existing => existing.key === session.key);
    file.sessions = [...file.sessions.filter(existing => existing.key !== session.key), session];
    this.write(file);
    return previous;
  }

  remove(key: string): StoredSession | undefined {
    const file = this.read();
    const previous = file.sessions.find(existing => existing.key === key);
    if (!previous) return undefined;
    file.sessions = file.sessions.filter(existing => existing.key !== key);
    this.write(file);
    return previous;
  }

  // ---------------------------------------------------------------- consent state

  /**
   * The `state` sent to the bank and echoed back on the redirect. Signed, so
   * the redirect cannot be completed on another company's instance, by
   * another user, or after 30 minutes; single-use, so it cannot be replayed.
   */
  signState(claims: ConsentState): string {
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${body}.${createHmac('sha256', this.stateKey).update(body).digest('base64url')}`;
  }

  verifyState(state: string): ConsentState {
    const [body, signature] = state.split('.');
    if (!body || !signature) throw new Error('the consent state is malformed');
    const expected = createHmac('sha256', this.stateKey).update(body).digest();
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new Error('the consent state was not issued by this server (or for another company)');
    }
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ConsentState;
  }

  /** Mark a state used; false if it already was. */
  consumeState(nonce: string, expiresAt: number): boolean {
    const file = this.read();
    const now = Date.now();
    file.usedStates = file.usedStates.filter(entry => entry.expiresAt > now);
    if (file.usedStates.some(entry => entry.nonce === nonce)) return false;
    file.usedStates.push({ nonce, expiresAt });
    this.write(file);
    return true;
  }
}

export interface ConsentState {
  company: string;
  user: string;
  nonce: string;
  expiresAt: number;
  aspsp: { name: string; country: string };
  psuType: 'business' | 'personal';
  /** What was asked of the bank, used if the session answer omits it. */
  validUntil: string;
}
