import { createSign, type KeyObject } from 'node:crypto';
import type { AccountResource, Aspsp, BalanceResource, SessionResource, SessionStatus, TransactionResource } from '../enablebanking/client.js';
import { EnableBankingHttpError, nestedFailuresAsStatus } from '../errors.js';
import { discardBody, isRedirect, readErrorBody, readTextUpTo } from '../upstream-http.js';

/**
 * The embedded gateway's client for Enable Banking. Account information and
 * the consent calls only: there is no payment method, and every request is one
 * of the fixed targets in UPSTREAM below, on the one origin fixed at creation.
 * Identifiers placed in a path must match ID_PATTERN (letters, digits and
 * dashes), so no value can add a segment, a dot segment or a query.
 */

export const DEFAULT_API_BASE_URL = 'https://api.enablebanking.com';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Session ids and account uids (UUIDs at Enable Banking). */
export const ID_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

/** Every request the gateway can make, by name. */
export const UPSTREAM = Object.freeze({
  getSession: { method: 'GET', path: '/sessions/{session_id}' },
  accountDetails: { method: 'GET', path: '/accounts/{account_id}/details' },
  accountBalances: { method: 'GET', path: '/accounts/{account_id}/balances' },
  accountTransactions: { method: 'GET', path: '/accounts/{account_id}/transactions' },
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
    params: { session_id?: string; account_id?: string } = {},
    query?: URLSearchParams,
    body?: unknown,
    onRaw?: (raw: unknown) => void,
  ): Promise<T> {
    const target = UPSTREAM[name];
    let path: string = target.path;
    if (path.includes('{session_id}')) path = path.replace('{session_id}', idSegment(params.session_id ?? '', 'session id'));
    if (path.includes('{account_id}')) path = path.replace('{account_id}', idSegment(params.account_id ?? '', 'account id'));
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
      throw new Error(`Enable Banking ${target.method} ${target.path} answered with a redirect (HTTP ${response.status}); redirects are not followed.`);
    }
    if (!response.ok) {
      // A body that cannot be read is dropped: the error is then the status alone.
      const payload = errorPayload(await readErrorBody(response).catch(() => null));
      onRaw?.(payload);
      // The template, not the concrete path: no identifier reaches the message.
      throw new EnableBankingHttpError({ status: response.status, method: target.method, path: target.path, payload });
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

  getSession(sessionId: string): Promise<SessionStatus> {
    return this.request('getSession', { session_id: sessionId });
  }

  getAccountDetails(uid: string): Promise<AccountResource> {
    return this.request('accountDetails', { account_id: uid });
  }

  async getBalances(uid: string): Promise<BalanceResource[]> {
    const body = await this.request<{ balances?: BalanceResource[] } | undefined>('accountBalances', { account_id: uid });
    return Array.isArray(body?.balances) ? body.balances : [];
  }

  async getTransactionsPage(
    uid: string,
    query: { dateFrom: string; dateTo: string; status?: 'BOOK' | 'PDNG'; continuationKey?: string },
  ): Promise<{ transactions: TransactionResource[]; continuationKey?: string }> {
    const params = new URLSearchParams({ date_from: query.dateFrom, date_to: query.dateTo });
    if (query.status) params.set('transaction_status', query.status);
    if (query.continuationKey) params.set('continuation_key', query.continuationKey);
    const body = await this.request<{ transactions?: TransactionResource[]; continuation_key?: string | null } | undefined>(
      'accountTransactions',
      { account_id: uid },
      params,
    );
    const continuationKey = typeof body?.continuation_key === 'string' && body.continuation_key ? body.continuation_key : undefined;
    return { transactions: Array.isArray(body?.transactions) ? body.transactions : [], ...(continuationKey ? { continuationKey } : {}) };
  }

  async listAspsps(country: string, psuType: 'business' | 'personal'): Promise<Aspsp[]> {
    const body = await this.request<{ aspsps?: Aspsp[] } | undefined>(
      'listAspsps',
      {},
      new URLSearchParams({ country, psu_type: psuType, service: 'AIS' }),
    );
    return Array.isArray(body?.aspsps) ? body.aspsps : [];
  }

  startAuthorization(body: {
    access: { valid_until: string };
    aspsp: { name: string; country: string };
    state: string;
    redirect_url: string;
    psu_type: 'business' | 'personal';
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
