import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EnableBankingHttpError, redactPath } from '../errors.js';
import { discardBody, isRedirect, readErrorBody } from '../upstream-http.js';
import { encodePathParam } from '../path-params.js';
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
} from './api.js';

// Enable Banking, account information (AIS) only. This client has no method
// that could move money.
//
// Every call is authenticated by the APPLICATION: a short-lived RS256 JWT
// signed with its private key (kid = application id). Access to a company's
// accounts additionally needs a CONSENT: a session a person creates at the
// bank with the bank's own sign-in, valid for a limited time (often at most
// 180 days).

export type {
  AccountResource,
  Amount,
  ApplicationResource,
  Aspsp,
  BalanceResource,
  FetchStrategy,
  SessionResource,
  SessionStatus,
  TransactionResource,
} from './api.js';

export interface ClientOptions {
  applicationId: string;
  privateKey: KeyObject | string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** `Psu-*` request headers of a person present (src/enablebanking/psu.ts). Left out: a background fetch. */
export type PresenceHeaders = Readonly<Record<string, string>>;

/** One page of transactions as the bank returned it. */
export interface TransactionsPage {
  transactions: TransactionResource[];
  /** Set when the bank has more; an empty page can still carry one. */
  continuationKey?: string;
}

export interface TransactionsQuery {
  dateFrom?: string;
  dateTo?: string;
  status?: 'BOOK' | 'PDNG';
  /** `longest`: as far back as the bank gives, up to today; `dateTo` is then not sent. */
  strategy?: FetchStrategy;
  continuationKey?: string;
}

/** The most pages one listing follows. A bank's page holds what the bank decides, often 10 to several hundred lines. */
export const MAX_PAGES = 50;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export class EnableBankingClient {
  private readonly key: KeyObject;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    if (!options.applicationId) throw new Error('ENABLEBANKING_APPLICATION_ID is not set');
    this.key = typeof options.privateKey === 'string' ? createPrivateKey(options.privateKey) : options.privateKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.enablebanking.com').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  static fromKeyFile(options: Omit<ClientOptions, 'privateKey'> & { privateKeyPath: string }): EnableBankingClient {
    return new EnableBankingClient({ ...options, privateKey: createPrivateKey(readFileSync(options.privateKeyPath)) });
  }

  private jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { typ: 'JWT', alg: 'RS256', kid: this.options.applicationId };
    const payload = { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    return `${input}.${b64url(createSign('RSA-SHA256').update(input).sign(this.key))}`;
  }

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, presence?: PresenceHeaders): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        // The person's headers first, so none of them can replace one of ours.
        ...(presence ?? {}),
        Authorization: `Bearer ${this.jwt()}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Never follow redirects: the signed JWT and the body (e.g. an authorization
      // code) would be re-sent to the new location.
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (isRedirect(response.status)) {
      await discardBody(response);
      throw new Error(
        `Enable Banking ${method} ${redactPath(path)} answered with a redirect (HTTP ${response.status}); ` +
          'redirects are not followed. Check ENABLEBANKING_API_BASE_URL.',
      );
    }
    if (!response.ok) {
      const payload = errorPayload(await readErrorBody(response));
      throw new EnableBankingHttpError({ status: response.status, method, path, payload });
    }
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = undefined;
    }
    return payload as T;
  }

  /** The application as Enable Banking sees it: environment, whether it is active, countries and services. */
  getApplication(): Promise<ApplicationResource> {
    return this.request('GET', '/application');
  }

  /** Banks offering account information. Without a country: every country the application covers. */
  async listAspsps(country?: string, psuType?: 'business' | 'personal'): Promise<Aspsp[]> {
    const params = new URLSearchParams({ service: 'AIS' });
    if (country) params.set('country', country);
    if (psuType) params.set('psu_type', psuType);
    const body = await this.request<{ aspsps?: Aspsp[] } | undefined>('GET', `/aspsps?${params}`);
    return Array.isArray(body?.aspsps) ? body.aspsps : [];
  }

  /** Start a consent; returns the address of the bank's sign-in for a person to open. */
  async startAuthorization(input: {
    aspsp: { name: string; country: string };
    psuType: 'business' | 'personal';
    validUntil: string;
    redirectUrl: string;
    state: string;
    language?: string;
    /** One of the bank's auth_methods, when it offers several. */
    authMethod?: string;
    /** Ask for these accounts only; what a bank does without it differs per bank. */
    accounts?: AccountIdentification[];
    balances?: boolean;
    transactions?: boolean;
    /** False: never ask the person for the extra approval some banks need for history older than 90 days. */
    extendedHistory?: boolean;
  }): Promise<{ url: string; authorization_id?: string }> {
    return this.request('POST', '/auth', {
      access: {
        valid_until: input.validUntil,
        ...(input.accounts && input.accounts.length > 0 ? { accounts: input.accounts } : {}),
        ...(input.balances === undefined ? {} : { balances: input.balances }),
        ...(input.transactions === undefined ? {} : { transactions: input.transactions }),
        ...(input.extendedHistory === undefined ? {} : { transactions_extended_history: input.extendedHistory }),
      },
      aspsp: input.aspsp,
      state: input.state,
      redirect_url: input.redirectUrl,
      psu_type: input.psuType,
      ...(input.authMethod ? { auth_method: input.authMethod } : {}),
      ...(input.language ? { language: input.language } : {}),
    });
  }

  /** Exchange the code from the redirect for a session. */
  createSession(code: string): Promise<SessionResource> {
    return this.request('POST', '/sessions', { code });
  }

  /** The session as Enable Banking holds it. Not a read at the bank. */
  getSession(sessionId: string): Promise<SessionStatus> {
    return this.request('GET', `/sessions/${encodePathParam(sessionId, 'sessionId')}`);
  }

  /** Close the session and revoke the consent at the bank. */
  async deleteSession(sessionId: string): Promise<void> {
    await this.request('DELETE', `/sessions/${encodePathParam(sessionId, 'sessionId')}`);
  }

  getAccountDetails(uid: string, presence?: PresenceHeaders): Promise<AccountResource> {
    return this.request('GET', `/accounts/${encodePathParam(uid, 'uid')}/details`, undefined, presence);
  }

  async getBalances(uid: string, presence?: PresenceHeaders): Promise<BalanceResource[]> {
    const body = await this.request<{ balances?: BalanceResource[] } | undefined>(
      'GET',
      `/accounts/${encodePathParam(uid, 'uid')}/balances`,
      undefined,
      presence,
    );
    return Array.isArray(body?.balances) ? body.balances : [];
  }

  /** One page. Every parameter but the continuation key must be the same on each page of a listing. */
  async getTransactionsPage(uid: string, query: TransactionsQuery, presence?: PresenceHeaders): Promise<TransactionsPage> {
    const params = new URLSearchParams();
    if (query.dateFrom) params.set('date_from', query.dateFrom);
    if (query.dateTo && query.strategy !== 'longest') params.set('date_to', query.dateTo);
    if (query.status) params.set('transaction_status', query.status);
    if (query.strategy === 'longest') params.set('strategy', 'longest');
    if (query.continuationKey) params.set('continuation_key', query.continuationKey);
    const qs = [...params.keys()].length > 0 ? `?${params}` : '';
    const body = await this.request<{ transactions?: TransactionResource[]; continuation_key?: string | null } | undefined>(
      'GET',
      `/accounts/${encodePathParam(uid, 'uid')}/transactions${qs}`,
      undefined,
      presence,
    );
    const continuationKey = typeof body?.continuation_key === 'string' && body.continuation_key ? body.continuation_key : undefined;
    return { transactions: Array.isArray(body?.transactions) ? body.transactions : [], ...(continuationKey ? { continuationKey } : {}) };
  }

  /**
   * Every page of a listing, up to MAX_PAGES. An empty page with a
   * continuation key is followed like any other. `truncated` is true when
   * the bank still had more after the last page read.
   */
  async listTransactions(
    uid: string,
    query: Omit<TransactionsQuery, 'continuationKey'>,
    presence?: PresenceHeaders,
  ): Promise<{ transactions: TransactionResource[]; truncated: boolean; pages: number }> {
    const transactions: TransactionResource[] = [];
    let continuation: string | undefined;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await this.getTransactionsPage(uid, { ...query, ...(continuation ? { continuationKey: continuation } : {}) }, presence);
      transactions.push(...result.transactions);
      continuation = result.continuationKey;
      if (!continuation) return { transactions, truncated: false, pages: page };
    }
    return { transactions, truncated: true, pages: MAX_PAGES };
  }

  /** The bank's further details of one transaction, by the `transaction_id` of a listing. */
  async getTransaction(uid: string, transactionId: string, presence?: PresenceHeaders): Promise<TransactionResource> {
    return this.request(
      'GET',
      `/accounts/${encodePathParam(uid, 'uid')}/transactions/${encodePathParam(transactionId, 'transaction')}`,
      undefined,
      presence,
    );
  }
}

/**
 * The error object from a (size-capped) error body. JSON is used whatever the
 * content type, so a code such as EXPIRED_SESSION is kept even when the body is
 * served as text/plain.
 */
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
