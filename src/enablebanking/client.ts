import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EnableBankingHttpError } from '../errors.js';

// Enable Banking, account information (AIS) only. The application is not
// registered for payment initiation and this client has no method that could
// move money.
//
// Every call is authenticated by the APPLICATION: a short-lived RS256 JWT
// signed with its private key (kid = application id). Access to a company's
// accounts additionally needs a CONSENT — a session a human creates with MitID
// at the bank, valid for a limited time (often at most 180 days).

export interface Aspsp {
  name: string;
  country: string;
  bic?: string;
  psu_types?: string[];
  maximum_consent_validity?: number;
  beta?: boolean;
  sandbox?: unknown;
}

export interface AccountResource {
  uid?: string;
  account_id?: { iban?: string | null; other?: unknown } | null;
  all_account_ids?: Array<{ identification?: string; scheme_name?: string }> | null;
  account_servicer?: { bic_fi?: string | null; name?: string | null } | null;
  name?: string | null;
  details?: string | null;
  usage?: string | null;
  cash_account_type?: string | null;
  product?: string | null;
  currency?: string | null;
  identification_hash?: string | null;
  credit_limit?: { currency?: string; amount?: string } | null;
}

export interface SessionResource {
  session_id: string;
  accounts?: AccountResource[];
  aspsp?: { name: string; country: string };
  psu_type?: string;
  access?: { valid_until?: string };
}

export interface SessionStatus {
  status?: string;
  accounts?: string[];
  access?: { valid_until?: string };
  aspsp?: { name: string; country: string };
  psu_type?: string;
}

export interface Amount {
  currency?: string;
  amount?: string;
}

export interface BalanceResource {
  name?: string | null;
  balance_amount?: Amount;
  balance_type?: string | null;
  last_change_date_time?: string | null;
  reference_date?: string | null;
}

export interface TransactionResource {
  entry_reference?: string | null;
  transaction_id?: string | null;
  transaction_amount?: Amount;
  credit_debit_indicator?: 'CRDT' | 'DBIT' | string;
  status?: string;
  booking_date?: string | null;
  value_date?: string | null;
  transaction_date?: string | null;
  creditor?: { name?: string | null } | null;
  debtor?: { name?: string | null } | null;
  creditor_account?: { iban?: string | null } | null;
  debtor_account?: { iban?: string | null } | null;
  remittance_information?: string[] | null;
  reference_number?: string | null;
  bank_transaction_code?: { description?: string | null; code?: string | null; sub_code?: string | null } | null;
  balance_after_transaction?: Amount | null;
  merchant_category_code?: string | null;
  note?: string | null;
}

export interface ClientOptions {
  applicationId: string;
  privateKey: KeyObject | string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const MAX_PAGES = 50;

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

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.jwt()}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = undefined;
    }
    if (!response.ok) {
      throw new EnableBankingHttpError({ status: response.status, method, path, payload });
    }
    return payload as T;
  }

  getApplication(): Promise<Record<string, unknown>> {
    return this.request('GET', '/application');
  }

  async listAspsps(country: string, psuType?: 'business' | 'personal'): Promise<Aspsp[]> {
    const params = new URLSearchParams({ country });
    if (psuType) params.set('psu_type', psuType);
    const body = await this.request<{ aspsps?: Aspsp[] }>('GET', `/aspsps?${params}`);
    return body.aspsps ?? [];
  }

  /** Start a consent; returns the bank's MitID URL for a human to open. */
  async startAuthorization(input: {
    aspsp: { name: string; country: string };
    psuType: 'business' | 'personal';
    validUntil: string;
    redirectUrl: string;
    state: string;
    language?: string;
  }): Promise<{ url: string; authorization_id?: string }> {
    return this.request('POST', '/auth', {
      access: { valid_until: input.validUntil },
      aspsp: input.aspsp,
      state: input.state,
      redirect_url: input.redirectUrl,
      psu_type: input.psuType,
      ...(input.language ? { language: input.language } : {}),
    });
  }

  /** Exchange the code from the redirect for a session. */
  createSession(code: string): Promise<SessionResource> {
    return this.request('POST', '/sessions', { code });
  }

  getSession(sessionId: string): Promise<SessionStatus> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}`);
  }

  /** Close the session and revoke the consent at the bank. */
  async deleteSession(sessionId: string): Promise<void> {
    await this.request('DELETE', `/sessions/${encodeURIComponent(sessionId)}`);
  }

  getAccountDetails(uid: string): Promise<AccountResource> {
    return this.request('GET', `/accounts/${encodeURIComponent(uid)}/details`);
  }

  async getBalances(uid: string): Promise<BalanceResource[]> {
    const body = await this.request<{ balances?: BalanceResource[] }>('GET', `/accounts/${encodeURIComponent(uid)}/balances`);
    return body.balances ?? [];
  }

  /** All pages of transactions in a window. `truncated` is true when the page cap was hit. */
  async listTransactions(
    uid: string,
    query: { dateFrom: string; dateTo?: string; status?: 'BOOK' | 'PDNG' },
  ): Promise<{ transactions: TransactionResource[]; truncated: boolean }> {
    const transactions: TransactionResource[] = [];
    let continuation: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({ date_from: query.dateFrom });
      if (query.dateTo) params.set('date_to', query.dateTo);
      if (query.status) params.set('transaction_status', query.status);
      if (continuation) params.set('continuation_key', continuation);
      const body = await this.request<{ transactions?: TransactionResource[]; continuation_key?: string | null }>(
        'GET',
        `/accounts/${encodeURIComponent(uid)}/transactions?${params}`,
      );
      transactions.push(...(body.transactions ?? []));
      continuation = body.continuation_key ?? undefined;
      if (!continuation) return { transactions, truncated: false };
    }
    return { transactions, truncated: true };
  }
}
