import { createSign, type KeyObject } from 'node:crypto';
import type {
  AccountIdentification,
  AccountResource,
  ApplicationResource,
  Aspsp,
  BalanceResource,
  FetchStrategy,
  SessionResource,
  SessionStatus,
  TransactionResource,
} from '../enablebanking/api.js';
import { EnableBankingHttpError, nestedFailuresAsStatus } from '../errors.js';
import { discardBody, isRedirect, readErrorBody, readTextUpTo } from '../upstream-http.js';
import { EnableBankingRedirectError, requestIdFrom } from './failure.js';

/**
 * The embedded gateway's client for Enable Banking. Account information and
 * the consent calls only: there is no payment method, and every request is one
 * of the fixed targets in UPSTREAM below, on the one origin fixed at creation.
 * Identifiers placed in a path must match ID_PATTERN (letters, digits and
 * dashes), so no value can add a segment, a dot segment or a query. A
 * transaction id, which a bank makes up, must match TRANSACTION_ID_PATTERN and
 * is percent-encoded as one segment.
 */

export const DEFAULT_API_BASE_URL = 'https://api.enablebanking.com';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Session ids and account uids (UUIDs at Enable Banking). */
export const ID_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

/**
 * A bank's id of a transaction, for the details request: unreserved and a few sub-delimiter characters only, so it is
 * one path segment whatever it holds. No slash, backslash, question mark, hash, percent sign or space, and not a dot
 * segment.
 */
export const TRANSACTION_ID_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._~:=+@,;!$*'()&-]{1,256}$/;

/** Every request the gateway can make, by name. */
export const UPSTREAM = Object.freeze({
  getSession: { method: 'GET', path: '/sessions/{session_id}' },
  accountDetails: { method: 'GET', path: '/accounts/{account_id}/details' },
  accountBalances: { method: 'GET', path: '/accounts/{account_id}/balances' },
  accountTransactions: { method: 'GET', path: '/accounts/{account_id}/transactions' },
  accountTransaction: { method: 'GET', path: '/accounts/{account_id}/transactions/{transaction_id}' },
  getApplication: { method: 'GET', path: '/application' },
  listAspsps: { method: 'GET', path: '/aspsps' },
  startAuthorization: { method: 'POST', path: '/auth' },
  createSession: { method: 'POST', path: '/sessions' },
  deleteSession: { method: 'DELETE', path: '/sessions/{session_id}' },
} as const);

export type UpstreamName = keyof typeof UPSTREAM;

export interface GatewayClientOptions {
  applicationId: string;
  key: KeyObject;
  /** Origin only, validated by the factory. */
  origin: string;
  timeoutMs: number;
  maxResponseBytes: number;
  fetchImpl: typeof fetch;
}

export class InvalidIdentifierError extends Error {
  constructor(what: string) {
    super(`Invalid ${what}.`);
    this.name = 'InvalidIdentifierError';
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function idSegment(value: string, what: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new InvalidIdentifierError(what);
  return value;
}

/** `Psu-*` request headers of a person present (src/enablebanking/psu.ts). Left out: a background fetch. */
export type PresenceHeaders = Readonly<Record<string, string>>;

export class GatewayClient {
  constructor(private readonly options: GatewayClientOptions) {}

  private jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { typ: 'JWT', alg: 'RS256', kid: this.options.applicationId };
    const payload = { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 600 };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    return `${input}.${b64url(createSign('RSA-SHA256').update(input).sign(this.options.key))}`;
  }

  /**
   * `onRaw` sees the parsed answer (a success or an error body) before any
   * lossy normalisation: a caller registers vendor-returned secrets there.
   */
  private async request<T>(
    name: UpstreamName,
    params: { session_id?: string; account_id?: string; transaction_id?: string } = {},
    query?: URLSearchParams,
    body?: unknown,
    onRaw?: (raw: unknown) => void,
    presence?: PresenceHeaders,
  ): Promise<T> {
    const target = UPSTREAM[name];
    let path: string = target.path;
    if (path.includes('{session_id}')) path = path.replace('{session_id}', idSegment(params.session_id ?? '', 'session id'));
    if (path.includes('{account_id}')) path = path.replace('{account_id}', idSegment(params.account_id ?? '', 'account id'));
    if (path.includes('{transaction_id}')) {
      const id = params.transaction_id ?? '';
      if (typeof id !== 'string' || !TRANSACTION_ID_PATTERN.test(id)) throw new InvalidIdentifierError('transaction id');
      path = path.replace('{transaction_id}', () => encodeURIComponent(id));
    }
    const qs = query && [...query.keys()].length > 0 ? `?${query.toString()}` : '';
    const url = new URL(`${path}${qs}`, this.options.origin);
    // Belt and braces: the request goes to the fixed origin and the fixed path.
    if (url.origin !== this.options.origin || url.pathname !== path) {
      throw new Error('Refused: the request target is not one of the fixed Enable Banking targets.');
    }

    let response: Response;
    try {
      response = await this.options.fetchImpl(url.toString(), {
        method: target.method,
        headers: {
          // The person's headers first, so none of them can replace one of ours.
          ...(presence ?? {}),
          Authorization: `Bearer ${this.jwt()}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Never follow a redirect: the JWT and the body would be re-sent elsewhere.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new Error(`Enable Banking did not answer within ${Math.round(this.options.timeoutMs / 1000)} seconds (${target.method} ${target.path}).`);
      }
      throw new Error(`Enable Banking could not be reached (${target.method} ${target.path}).`);
    }

    if (isRedirect(response.status)) {
      await discardBody(response);
      throw new EnableBankingRedirectError(
        `Enable Banking ${target.method} ${target.path} answered with a redirect (HTTP ${response.status}); redirects are not followed.`,
        response.status,
        requestIdFrom(response.headers),
      );
    }
    if (!response.ok) {
      // A body that cannot be read is dropped: the error is then the status alone.
      const payload = errorPayload(await readErrorBody(response).catch(() => null));
      onRaw?.(payload);
      // The template, not the concrete path: no identifier reaches the message.
      throw new EnableBankingHttpError({
        status: response.status,
        method: target.method,
        path: target.path,
        payload,
        requestId: requestIdFrom(response.headers),
      });
    }
    let read: { text: string; exceeded: boolean };
    try {
      read = await readTextUpTo(response, this.options.maxResponseBytes);
    } catch (error) {
      // Anything thrown while reading the body is replaced by our own text: its message is not ours.
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new Error(`Enable Banking did not answer within ${Math.round(this.options.timeoutMs / 1000)} seconds (${target.method} ${target.path}).`);
      }
      throw new Error(`The Enable Banking answer to ${target.method} ${target.path} could not be read.`);
    }
    const { text, exceeded } = read;
    if (exceeded) {
      throw new Error(`Enable Banking ${target.method} ${target.path} answered with more than ${this.options.maxResponseBytes} bytes; refused.`);
    }
    if (!text) return undefined as T;
    try {
      const parsed: unknown = JSON.parse(text);
      onRaw?.(parsed);
      // Failures Enable Banking or a bank reports inside a successful answer become status-only text.
      return nestedFailuresAsStatus(parsed) as T;
    } catch {
      throw new Error(`Enable Banking ${target.method} ${target.path} answered with something that is not JSON.`);
    }
  }

  /** The session as Enable Banking holds it. Not a read at the bank. */
  getSession(sessionId: string): Promise<SessionStatus> {
    return this.request('getSession', { session_id: sessionId });
  }

  getAccountDetails(uid: string, presence?: PresenceHeaders): Promise<AccountResource> {
    return this.request('accountDetails', { account_id: uid }, undefined, undefined, undefined, presence);
  }

  async getBalances(uid: string, presence?: PresenceHeaders): Promise<BalanceResource[]> {
    const body = await this.request<{ balances?: BalanceResource[] } | undefined>(
      'accountBalances',
      { account_id: uid },
      undefined,
      undefined,
      undefined,
      presence,
    );
    return Array.isArray(body?.balances) ? body.balances : [];
  }

  /** One page. Every parameter but the continuation key must be the same on each page of a listing. */
  async getTransactionsPage(
    uid: string,
    query: { dateFrom?: string; dateTo?: string; status?: 'BOOK' | 'PDNG'; strategy?: FetchStrategy; continuationKey?: string },
    presence?: PresenceHeaders,
  ): Promise<{ transactions: TransactionResource[]; continuationKey?: string }> {
    const params = new URLSearchParams();
    if (query.dateFrom) params.set('date_from', query.dateFrom);
    // With the longest strategy the API reads up to today and ignores an end date; none is sent.
    if (query.dateTo && query.strategy !== 'longest') params.set('date_to', query.dateTo);
    if (query.status) params.set('transaction_status', query.status);
    if (query.strategy === 'longest') params.set('strategy', 'longest');
    if (query.continuationKey) params.set('continuation_key', query.continuationKey);
    const body = await this.request<{ transactions?: TransactionResource[]; continuation_key?: string | null } | undefined>(
      'accountTransactions',
      { account_id: uid },
      params,
      undefined,
      undefined,
      presence,
    );
    const continuationKey = typeof body?.continuation_key === 'string' && body.continuation_key ? body.continuation_key : undefined;
    return { transactions: Array.isArray(body?.transactions) ? body.transactions : [], ...(continuationKey ? { continuationKey } : {}) };
  }

  /** The bank's further details of one transaction, by the transaction id of a listing. */
  getTransaction(uid: string, transactionId: string, presence?: PresenceHeaders): Promise<TransactionResource | undefined> {
    return this.request('accountTransaction', { account_id: uid, transaction_id: transactionId }, undefined, undefined, undefined, presence);
  }

  /** Banks offering account information. Without a country: every country the application covers. */
  async listAspsps(country?: string, psuType?: 'business' | 'personal'): Promise<Aspsp[]> {
    const params = new URLSearchParams();
    if (country) params.set('country', country);
    if (psuType) params.set('psu_type', psuType);
    params.set('service', 'AIS');
    const body = await this.request<{ aspsps?: Aspsp[] } | undefined>('listAspsps', {}, params);
    return Array.isArray(body?.aspsps) ? body.aspsps : [];
  }

  startAuthorization(body: {
    access: {
      valid_until: string;
      accounts?: AccountIdentification[];
      balances?: boolean;
      transactions?: boolean;
      transactions_extended_history?: boolean;
    };
    aspsp: { name: string; country: string };
    state: string;
    redirect_url: string;
    psu_type: 'business' | 'personal';
    auth_method?: string;
    language?: string;
  }): Promise<{ url?: string; authorization_id?: string } | undefined> {
    return this.request('startAuthorization', {}, undefined, body);
  }

  createSession(code: string, onRaw?: (raw: unknown) => void): Promise<SessionResource | undefined> {
    return this.request('createSession', {}, undefined, { code }, onRaw);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request('deleteSession', { session_id: sessionId });
  }

  /** The application as Enable Banking sees it. */
  getApplication(): Promise<ApplicationResource | undefined> {
    return this.request('getApplication');
  }
}

function errorPayload(body: unknown): object | undefined {
  if (typeof body === 'string') {
    try {
      const parsed: unknown = JSON.parse(body);
      return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return typeof body === 'object' && body !== null ? body : undefined;
}
