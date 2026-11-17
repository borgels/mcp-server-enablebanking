import { createHmac, createPrivateKey, randomBytes, timingSafeEqual, type KeyObject } from 'node:crypto';
import type { AccountResource, SessionStatus, TransactionResource } from './enablebanking/client.js';
import { balanceView, isoDate, summarize, transactionView, type TransactionView } from './enablebanking/format.js';
import { maskIban, normalizeIban } from './enablebanking/registry.js';
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  GatewayClient,
  ID_PATTERN,
} from './gateway/client.js';
import {
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  SPEC_BY_NAME,
  enableBankingGatewayTools,
  type EnableBankingExposure,
  type GatewayToolDefinition,
  type GatewayJsonObject,
  type GatewayJsonValue,
} from './gateway/catalog.js';
import { GatewayRedactor } from './gateway/redact.js';

/**
 * Embeddable entry point: a host that serves many companies from one process
 * (and does its own per-user authorization and logging) lists the tools, reads
 * the catalog, and invokes `callTool` with the company's consent in the call
 * context.
 *
 * - The application's credentials (id and RS256 key) are given once, at
 *   creation. Nothing is read from ENABLEBANKING_* or any other environment
 *   variable on this path.
 * - Each call carries the company's `sessionId` and `accountIds`: the accounts
 *   the company consented to and the host stored. An account outside that list
 *   is refused before any request; the bank session must also still contain it.
 * - Read-only: accounts, balances, transactions. There is no payment tool,
 *   method or endpoint anywhere in this surface.
 * - The consent helpers (listBanks, startAuthorization, completeSession,
 *   sessionStatus, endSession) are plain functions for the host's own consent
 *   page; they are not tools and an AI client cannot reach them.
 */

export {
  enableBankingGatewayTools,
  enableBankingServiceCatalog,
  enableBankingToolCatalog,
  type EnableBankingDefaultRead,
  type EnableBankingEndpointCatalogEntry,
  type EnableBankingExposure,
  type EnableBankingServiceCatalog,
  type GatewayJsonObject,
  type GatewayJsonValue,
  type GatewayReadonlyJsonValue,
  type GatewayRiskLevel,
  type GatewayToolCatalogEntry,
  type GatewayToolDefinition,
  type GatewayUpstreamOperation,
} from './gateway/catalog.js';

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
}

/** One company's consent, passed with each call. */
export interface EnableBankingGatewayCredentials {
  /** The Enable Banking session id from completeSession. */
  sessionId: string;
  /**
   * The accounts (Enable Banking account uids) this company has consented to
   * and the host has stored. Only these can be read; matched exactly.
   */
  accountIds: readonly string[];
}

/**
 * Per-call context. `caller` and `requestId` have the same shape as the other
 * servers' gateways; they are not sent to Enable Banking or stored.
 * `credentials` is required for every tool call; there is no fallback.
 */
export interface GatewayCallContext {
  caller?: string;
  requestId?: string;
  credentials?: EnableBankingGatewayCredentials;
}

export interface EnableBankingGatewayOptions {
  /** The Enable Banking application id (the JWT `kid`). */
  applicationId: string;
  /** The application's RS256 private key: PEM text or a KeyObject. */
  privateKey: string | KeyObject;
  /** Default https://api.enablebanking.com. An https origin (http only on loopback, for tests). */
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Per-request time limit. Default 30 seconds; 1-120 seconds. */
  timeoutMs?: number;
  /** Largest successful response body accepted. Default 4 MB. */
  maxResponseBytes?: number;
  /** Clock, for tests. */
  now?: () => number;
}

/** What a tool call will read, resolved before anything is sent. */
export interface EnableBankingReadTarget {
  readonly tool: string;
  readonly exposure: EnableBankingExposure;
  readonly account?: string;
  readonly from?: string;
  readonly to?: string;
  readonly status?: 'booked' | 'pending' | 'all';
  /** True when the call continues a previous page. */
  readonly continued?: boolean;
}

export type EnableBankingReadTargetResolution =
  | { readonly ok: true; readonly target: EnableBankingReadTarget }
  | { readonly ok: false; readonly reason: string };

/** A bank (ASPSP) a company can connect. */
export interface EnableBankingBank {
  name: string;
  country: string;
  bic: string | null;
  psuTypes: string[];
  /** The longest consent the bank gives, in days (rounded down). Null when the bank does not say. */
  maximumConsentDays: number | null;
  beta: boolean;
}

export interface StartAuthorizationInput {
  /** Exact bank name from listBanks. */
  bank: string;
  /** ISO 3166 two-letter code. Default DK. */
  country?: string;
  /** Default business. */
  psuType?: 'business' | 'personal';
  /** Registered with the application at Enable Banking. https. */
  redirectUrl: string;
  /** The host's own unguessable, single-use value; it comes back on the redirect. 16-512 of A-Z a-z 0-9 . _ ~ - */
  state: string;
  /** End of the consent. Default: the bank's maximum (less five minutes). Refused beyond it. */
  validUntil?: string | Date;
  /** Language of the bank's pages, e.g. "da". */
  language?: string;
}

export interface StartAuthorizationResult {
  /** The bank's page; send the person there. */
  url: string;
  validUntil: string;
  maximumConsentDays: number;
}

export interface ConsentAccount {
  /** Enable Banking account uid: what goes into credentials.accountIds. */
  id: string;
  name: string | null;
  /** First four and last four characters, e.g. DK12…4567. */
  maskedIban: string | null;
  currency: string | null;
}

export interface CompleteSessionResult {
  sessionId: string;
  validUntil: string | null;
  bank: { name: string; country: string } | null;
  psuType: string | null;
  accounts: ConsentAccount[];
  /** Accounts in the session without a uid (cannot be read). */
  accountsWithoutId: number;
}

export interface SessionStatusResult {
  status: string | null;
  validUntil: string | null;
  accountIds: string[];
}

/** Error thrown by the consent helpers. Its message is redacted and carries no cause. */
export class EnableBankingGatewayError extends Error {
  readonly status?: number;
  readonly code?: string;
  constructor(message: string, details: { status?: number; code?: string } = {}) {
    super(message);
    this.name = 'EnableBankingGatewayError';
    if (details.status !== undefined) this.status = details.status;
    if (details.code !== undefined) this.code = details.code;
  }
}

const DAY_MS = 86_400_000;
const MAX_PAGES_PER_CALL = 5;
const MAX_ROWS_PER_CALL = 1_000;
const MAX_ACCOUNT_IDS = 100;
const MAX_LIST_ACCOUNTS = 25;
const DEFAULT_MAXIMUM_CONSENT_SECONDS = 90 * 86_400;
const STATE_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;
const CODE_PATTERN = /^[A-Za-z0-9._~+/=-]{1,2048}$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const LANGUAGE_PATTERN = /^[a-z]{2}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Enable Banking's documented session statuses (API reference, SessionStatus). */
const SESSION_STATUSES: ReadonlySet<string> = new Set([
  'AUTHORIZED',
  'CANCELLED',
  'CLOSED',
  'EXPIRED',
  'INVALID',
  'PENDING_AUTHORIZATION',
  'RETURNED_FROM_BANK',
  'REVOKED',
]);

const NOT_ALLOWED = 'Refused: that account is not one of the accounts this company has connected.';
const NO_CREDENTIALS =
  'Refused: no Enable Banking consent was given with the call (credentials.sessionId and credentials.accountIds are required).';

// ------------------------------------------------------------------ input

function refuse(reason: string): EnableBankingReadTargetResolution {
  return { ok: false, reason };
}

function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && isoDate(parsed) === value;
}

/**
 * A page token: where the next page starts (the Enable Banking continuation
 * key of the page to fetch, empty for the first page, and how many rows of
 * that page were already returned), bound to account, period and status.
 * Signed with HMAC-SHA256 under a random key of the gateway instance, so a
 * token is only accepted by the instance that issued it and cannot be made
 * by hand.
 */
interface PageToken {
  k: string;
  o: number;
  a: string;
  f: string;
  t: string;
  s: string;
}

const MAX_CONTINUATION_KEY_LENGTH = 2048;
/** Rows of one bank page a token may skip (banks with very large pages). */
const MAX_PAGE_OFFSET = 100_000;

/** The token's content, unverified (for resolving what a call reads). */
function pagePayload(value: string): PageToken | undefined {
  const [payload, mac, ...rest] = value.split('.');
  if (!payload || !mac || rest.length > 0 || !/^[A-Za-z0-9_-]{1,4096}$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(mac)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<PageToken>;
    const strings = (['k', 'a', 'f', 't', 's'] as const).every(key => typeof parsed[key] === 'string');
    const offset = parsed.o;
    if (!strings || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_PAGE_OFFSET) {
      return undefined;
    }
    if (parsed.k!.length > MAX_CONTINUATION_KEY_LENGTH || (!parsed.k && offset === 0)) return undefined;
    return parsed as PageToken;
  } catch {
    return undefined;
  }
}

function signPageToken(key: Buffer, token: PageToken): string {
  const payload = Buffer.from(JSON.stringify(token)).toString('base64url');
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}

/** The token's content when it carries this instance's signature (constant-time comparison). */
function verifyPageToken(key: Buffer, value: string): PageToken | undefined {
  const token = pagePayload(value);
  if (!token) return undefined;
  const [payload, mac] = value.split('.') as [string, string];
  const expected = createHmac('sha256', key).update(payload).digest();
  const given = Buffer.from(mac, 'base64url');
  return given.length === expected.length && timingSafeEqual(given, expected) ? token : undefined;
}

/**
 * Resolves what a tool call will read, with the same checks callTool applies
 * before any request: known tool, no unknown fields, well-formed account,
 * dates and page token, and a period of at most 366 days. The account
 * allowlist needs the call's credentials and is checked by callTool.
 */
export function resolveEnableBankingReadTarget(
  toolName: string,
  input: GatewayJsonObject = {},
  now: number = Date.now(),
): EnableBankingReadTargetResolution {
  const spec = typeof toolName === 'string' ? SPEC_BY_NAME.get(toolName) : undefined;
  // The name and the field names are the host's input: not repeated, so nothing it carries is echoed.
  if (!spec) return refuse('Unsupported Enable Banking gateway tool.');
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return refuse('Input must be an object.');
  const properties = (spec.inputSchema.properties ?? {}) as GatewayJsonObject;
  const unknown = Object.keys(input).filter(key => !Object.hasOwn(properties, key));
  if (unknown.length > 0) {
    return refuse(`Unknown input field(s) for ${spec.name}: ${unknown.length}.`);
  }

  if (spec.name === 'list_accounts') return { ok: true, target: { tool: spec.name, exposure: spec.exposure } };

  const account = input.account;
  if (typeof account !== 'string' || !ID_PATTERN.test(account)) return refuse(NOT_ALLOWED);
  if (spec.name === 'get_balances') return { ok: true, target: { tool: spec.name, exposure: spec.exposure, account } };

  // list_transactions
  for (const key of ['from', 'to', 'status', 'pageToken'] as const) {
    if (input[key] !== undefined && input[key] !== null && typeof input[key] !== 'string') return refuse(`${key} must be a string.`);
  }
  const status = (input.status ?? 'booked') as string;
  if (status !== 'booked' && status !== 'pending' && status !== 'all') return refuse('status must be booked, pending or all.');
  const today = isoDate(new Date(now));
  const to = (input.to as string | null | undefined) ?? today;
  if (!isValidDate(to)) return refuse('to must be a date, YYYY-MM-DD.');
  // The default period is DEFAULT_RANGE_DAYS days including `to`.
  const from = (input.from as string | null | undefined) ?? isoDate(new Date(Date.parse(to) - (DEFAULT_RANGE_DAYS - 1) * DAY_MS));
  if (!isValidDate(from)) return refuse('from must be a date, YYYY-MM-DD.');
  if (from > to) return refuse(`from (${from}) is after to (${to}).`);
  if (to > isoDate(new Date(now + DAY_MS))) return refuse('to cannot be in the future.');
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > MAX_RANGE_DAYS) {
    return refuse(`The period is longer than ${MAX_RANGE_DAYS} days; ask for a shorter one.`);
  }
  const pageToken = input.pageToken as string | null | undefined;
  if (pageToken) {
    // The signature is checked by callTool, which holds the instance key.
    const token = pagePayload(pageToken);
    if (!token || token.a !== account || token.f !== from || token.t !== to || token.s !== status) {
      return refuse('pageToken does not belong to this account and period; start again without it.');
    }
  }
  return {
    ok: true,
    target: { tool: spec.name, exposure: spec.exposure, account, from, to, status, ...(pageToken ? { continued: true } : {}) },
  };
}

/** The call's consent, or undefined when it is missing, empty or malformed. No fallback. */
function callCredentials(context: GatewayCallContext | undefined): { sessionId: string; accountIds: ReadonlySet<string> } | undefined {
  const credentials = context?.credentials as unknown;
  if (!credentials || typeof credentials !== 'object') return undefined;
  const { sessionId, accountIds } = credentials as { sessionId?: unknown; accountIds?: unknown };
  if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) return undefined;
  if (!Array.isArray(accountIds) || accountIds.length === 0 || accountIds.length > MAX_ACCOUNT_IDS) return undefined;
  if (!accountIds.every(id => typeof id === 'string' && ID_PATTERN.test(id))) return undefined;
  return { sessionId, accountIds: new Set(accountIds as string[]) };
}

// ------------------------------------------------------------------ factory

function validateOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('createEnableBankingGateway: apiBaseUrl must be an absolute URL.');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
  if (!allowed || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('createEnableBankingGateway: apiBaseUrl must be an https origin without path, query or credentials.');
  }
  return url.origin;
}

function boundedInt(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`createEnableBankingGateway: ${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function createEnableBankingGateway(options: EnableBankingGatewayOptions) {
  if (!options || typeof options !== 'object') throw new Error('createEnableBankingGateway: options are required.');
  const applicationId = typeof options.applicationId === 'string' ? options.applicationId.trim() : '';
  if (!applicationId || !/^[A-Za-z0-9-]{1,128}$/.test(applicationId)) {
    throw new Error(
      'createEnableBankingGateway: applicationId is required (the gateway does not read ENABLEBANKING_* environment variables).',
    );
  }
  const redactor = new GatewayRedactor();
  // Signs page tokens; never leaves the instance.
  const pageKey = randomBytes(32);
  let key: KeyObject;
  if (typeof options.privateKey === 'string') {
    if (!options.privateKey.trim()) throw new Error('createEnableBankingGateway: privateKey is required.');
    redactor.addKey(options.privateKey);
    try {
      key = createPrivateKey(options.privateKey);
    } catch {
      throw new Error('createEnableBankingGateway: privateKey is not a readable private key.');
    }
  } else if (options.privateKey && typeof options.privateKey === 'object' && options.privateKey.type === 'private') {
    key = options.privateKey;
    try {
      redactor.addKey(String(key.export({ type: 'pkcs8', format: 'pem' })));
    } catch {
      // A key that cannot be exported cannot be echoed in this form either.
    }
  } else {
    throw new Error('createEnableBankingGateway: privateKey is required.');
  }
  if (key.asymmetricKeyType !== 'rsa') throw new Error('createEnableBankingGateway: privateKey must be an RSA key (RS256).');

  const now = options.now ?? Date.now;
  const client = new GatewayClient({
    applicationId,
    key,
    origin: validateOrigin(options.apiBaseUrl ?? DEFAULT_API_BASE_URL),
    timeoutMs: boundedInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 120_000, 'timeoutMs'),
    maxResponseBytes: boundedInt(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1_024, 64 * 1024 * 1024, 'maxResponseBytes'),
    fetchImpl: options.fetchImpl ?? fetch,
  });

  /** Runs a consent helper; any failure becomes a redacted EnableBankingGatewayError without a cause. */
  async function helper<T>(secrets: Array<string | undefined>, work: () => Promise<T>): Promise<T> {
    const callRedactor = redactor.fork();
    for (const secret of secrets) callRedactor.add(secret);
    try {
      // The answer is the host's data (the session id included); only the instance's key is removed from it.
      return redactor.redactDeep(await work()) as T;
    } catch (error) {
      const details = httpDetails(error);
      throw new EnableBankingGatewayError(callRedactor.message(error), details);
    }
  }

  async function bankByName(country: string, psuType: 'business' | 'personal', name: string) {
    const banks = await client.listAspsps(country, psuType);
    return banks.find(candidate => candidate.name === name && candidate.country === country);
  }

  return {
    /** A fresh copy on each read, so one part of the host cannot change another's list. */
    get tools(): GatewayToolDefinition[] {
      return structuredClone(enableBankingGatewayTools) as GatewayToolDefinition[];
    },

    async callTool(toolName: string, input: GatewayJsonObject = {}, context?: GatewayCallContext): Promise<GatewayToolResult> {
      const callRedactor = redactor.fork();
      try {
        const resolution = resolveEnableBankingReadTarget(toolName, input ?? {}, now());
        if (!resolution.ok) return errorResult(resolution.reason);
        const target = resolution.target;

        const credentials = callCredentials(context);
        if (!credentials) return errorResult(NO_CREDENTIALS);
        callRedactor.add(credentials.sessionId);
        if (target.account !== undefined && !credentials.accountIds.has(target.account)) return errorResult(NOT_ALLOWED);

        // The bank session must still be authorised and still contain the account.
        const session = await client.getSession(credentials.sessionId);
        const consent = consentState(session, now());
        if (!consent.ok) return errorResult(consent.reason);
        if (target.account !== undefined && !consent.accounts.has(target.account)) {
          return errorResult('Refused: the bank consent no longer covers that account. It must be connected again.');
        }

        let result: GatewayToolResult;
        switch (target.tool) {
          case 'list_accounts':
            result = await listAccounts(client, credentials.accountIds, consent);
            break;
          case 'get_balances':
            result = await getBalances(client, target.account!);
            break;
          default: {
            let start: PageToken | undefined;
            if (target.continued) {
              start = verifyPageToken(pageKey, input.pageToken as string);
              if (!start) return errorResult('pageToken was not issued here for this account and period; start again without it.');
            }
            result = await listTransactions(client, pageKey, target, start);
          }
        }
        return redactResult(result, callRedactor);
      } catch (error) {
        return errorResult(callRedactor.message(error));
      }
    },

    /** Banks (ASPSPs) offering account information in a country. */
    listBanks(input: { country?: string; psuType?: 'business' | 'personal' } = {}): Promise<EnableBankingBank[]> {
      return helper([], async () => {
        const country = checkCountry(input.country);
        const psuType = checkPsuType(input.psuType);
        const banks = await client.listAspsps(country, psuType);
        return banks
          .filter(bank => typeof bank?.name === 'string' && typeof bank.country === 'string')
          .map(bank => ({
            name: bank.name,
            country: bank.country,
            bic: typeof bank.bic === 'string' ? bank.bic : null,
            psuTypes: Array.isArray(bank.psu_types) ? bank.psu_types.filter(value => typeof value === 'string') : [],
            maximumConsentDays:
              typeof bank.maximum_consent_validity === 'number' ? Math.floor(bank.maximum_consent_validity / 86_400) : null,
            beta: bank.beta === true,
          }));
      });
    },

    /**
     * Starts a consent at a bank and returns the bank's page. `validUntil` is
     * checked against the bank's maximum consent length. The host must keep
     * `state`, check it when the person returns, and use it once.
     */
    startAuthorization(input: StartAuthorizationInput): Promise<StartAuthorizationResult> {
      return helper([input?.state], async () => {
        if (!input || typeof input !== 'object') throw new Error('startAuthorization: input is required.');
        const country = checkCountry(input.country);
        const psuType = checkPsuType(input.psuType);
        const bankName = typeof input.bank === 'string' ? input.bank.trim() : '';
        if (!bankName || bankName.length > 200) throw new Error('startAuthorization: bank is required.');
        const redirectUrl = checkRedirectUrl(input.redirectUrl);
        if (typeof input.state !== 'string' || !STATE_PATTERN.test(input.state)) {
          throw new Error('startAuthorization: state must be 16-512 characters of A-Z, a-z, 0-9, ".", "_", "~" or "-".');
        }
        if (input.language !== undefined && (typeof input.language !== 'string' || !LANGUAGE_PATTERN.test(input.language))) {
          throw new Error('startAuthorization: language must be two lower-case letters.');
        }

        const bank = await bankByName(country, psuType, bankName);
        if (!bank) throw new Error(`startAuthorization: no bank named that offers account information to ${psuType} customers in ${country}.`);
        const maximumSeconds =
          typeof bank.maximum_consent_validity === 'number' && bank.maximum_consent_validity > 0
            ? bank.maximum_consent_validity
            : DEFAULT_MAXIMUM_CONSENT_SECONDS;
        const latest = now() + maximumSeconds * 1000;
        let validUntil: number;
        if (input.validUntil === undefined) {
          validUntil = latest - 5 * 60_000;
        } else {
          validUntil = input.validUntil instanceof Date ? input.validUntil.getTime() : Date.parse(String(input.validUntil));
          if (Number.isNaN(validUntil)) throw new Error('startAuthorization: validUntil is not a date and time.');
          if (validUntil <= now() + 60 * 60_000) throw new Error('startAuthorization: validUntil must be at least an hour from now.');
          if (validUntil > latest) {
            throw new Error(`startAuthorization: validUntil is beyond the bank's maximum of ${Math.floor(maximumSeconds / 86_400)} days.`);
          }
        }
        const validUntilIso = new Date(validUntil).toISOString();

        const answer = await client.startAuthorization({
          access: { valid_until: validUntilIso },
          aspsp: { name: bank.name, country: bank.country },
          state: input.state,
          redirect_url: redirectUrl,
          psu_type: psuType,
          ...(input.language ? { language: input.language } : {}),
        });
        const url = typeof answer?.url === 'string' ? answer.url : '';
        let parsed: URL | undefined;
        try {
          parsed = new URL(url);
        } catch {
          parsed = undefined;
        }
        if (!parsed || parsed.protocol !== 'https:') throw new Error('startAuthorization: Enable Banking did not return an https address for the bank.');
        return { url: parsed.toString(), validUntil: validUntilIso, maximumConsentDays: Math.floor(maximumSeconds / 86_400) };
      });
    },

    /**
     * Exchanges the `code` from the redirect for a session. The host checks
     * the returned `state` itself before calling this. The result's sessionId
     * and account ids are what the host stores as the company's credentials.
     */
    completeSession(input: { code: string }): Promise<CompleteSessionResult> {
      const code = input && typeof input === 'object' ? input.code : undefined;
      return helper([typeof code === 'string' ? code : undefined], async () => {
        if (typeof code !== 'string' || !CODE_PATTERN.test(code)) throw new Error('completeSession: code is missing or malformed.');
        const session = await client.createSession(code);
        const sessionId = session?.session_id;
        if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) {
          throw new Error('completeSession: Enable Banking did not return a usable session.');
        }
        const rawAccounts = Array.isArray(session?.accounts) ? session.accounts : [];
        const accounts: ConsentAccount[] = [];
        let accountsWithoutId = 0;
        for (const account of rawAccounts) {
          if (typeof account?.uid !== 'string' || !ID_PATTERN.test(account.uid)) {
            accountsWithoutId += 1;
            continue;
          }
          accounts.push(consentAccount(account as AccountResource & { uid: string }));
        }
        return {
          sessionId,
          validUntil: instant(session?.access?.valid_until),
          bank:
            session?.aspsp && typeof session.aspsp.name === 'string' && typeof session.aspsp.country === 'string'
              ? { name: session.aspsp.name, country: session.aspsp.country }
              : null,
          psuType: typeof session?.psu_type === 'string' ? session.psu_type : null,
          accounts,
          accountsWithoutId,
        };
      });
    },

    /** The state of a session at Enable Banking (for renewal reminders). */
    sessionStatus(input: { sessionId: string }): Promise<SessionStatusResult> {
      const sessionId = input && typeof input === 'object' ? input.sessionId : undefined;
      return helper([typeof sessionId === 'string' ? sessionId : undefined], async () => {
        if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) throw new Error('sessionStatus: sessionId is missing or malformed.');
        const session = await client.getSession(sessionId);
        return {
          status: typeof session?.status === 'string' && SESSION_STATUSES.has(session.status) ? session.status : null,
          validUntil: instant(session?.access?.valid_until),
          accountIds: [...sessionAccounts(session)],
        };
      });
    },

    /** Closes a session at Enable Banking, which ends the consent at the bank. */
    endSession(input: { sessionId: string }): Promise<void> {
      const sessionId = input && typeof input === 'object' ? input.sessionId : undefined;
      return helper([typeof sessionId === 'string' ? sessionId : undefined], async () => {
        if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) throw new Error('endSession: sessionId is missing or malformed.');
        await client.deleteSession(sessionId);
      });
    },
  };
}

/** One gateway instance, as returned by createEnableBankingGateway. */
export type EnableBankingGateway = ReturnType<typeof createEnableBankingGateway>;

// ------------------------------------------------------------------ helpers

function checkCountry(value: unknown): string {
  const country = value === undefined ? 'DK' : typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!COUNTRY_PATTERN.test(country)) throw new Error('country must be a two-letter country code.');
  return country;
}

function checkPsuType(value: unknown): 'business' | 'personal' {
  if (value === undefined) return 'business';
  if (value === 'business' || value === 'personal') return value;
  throw new Error('psuType must be business or personal.');
}

function checkRedirectUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error('startAuthorization: redirectUrl must be an absolute https address.');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash) {
    throw new Error('startAuthorization: redirectUrl must be an absolute https address without credentials or fragment.');
  }
  return url.toString();
}

function httpDetails(error: unknown): { status?: number; code?: string } {
  if (error && typeof error === 'object' && 'status' in error && typeof (error as { status: unknown }).status === 'number') {
    const code = (error as { code?: unknown }).code;
    return {
      status: (error as { status: number }).status,
      ...(typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? { code } : {}),
    };
  }
  return {};
}

/** A date and time from Enable Banking as ISO 8601 in UTC, or null when it is not one. Nothing else of it is kept. */
function instant(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function sessionAccounts(session: SessionStatus | undefined): Set<string> {
  const ids = new Set<string>();
  for (const id of Array.isArray(session?.accounts) ? session.accounts : []) if (typeof id === 'string') ids.add(id);
  const data = (session as { accounts_data?: unknown } | undefined)?.accounts_data;
  if (Array.isArray(data)) {
    for (const entry of data) {
      const uid = (entry as { uid?: unknown } | null)?.uid;
      if (typeof uid === 'string') ids.add(uid);
    }
  }
  return ids;
}

type ConsentCheck =
  | { ok: true; accounts: Set<string>; validUntil: string | null }
  | { ok: false; reason: string };

function consentState(session: SessionStatus | undefined, now: number): ConsentCheck {
  const status = typeof session?.status === 'string' ? session.status : undefined;
  if (status !== 'AUTHORIZED') {
    // Only a documented status is named; anything else from Enable Banking is not repeated.
    return {
      ok: false,
      reason: `The bank consent is not active${status && SESSION_STATUSES.has(status) ? ` (${status})` : ''}. It must be renewed.`,
    };
  }
  const validUntil = instant(session?.access?.valid_until);
  if (validUntil && Date.parse(validUntil) <= now) {
    return { ok: false, reason: `The bank consent expired on ${validUntil.slice(0, 10)}. It must be renewed.` };
  }
  return { ok: true, accounts: sessionAccounts(session), validUntil };
}

function ibanOf(account: AccountResource): string | null {
  const direct = account.account_id?.iban;
  if (typeof direct === 'string' && direct) return normalizeIban(direct);
  const other = Array.isArray(account.all_account_ids)
    ? account.all_account_ids.find(id => id?.scheme_name === 'IBAN' && typeof id.identification === 'string')
    : undefined;
  return other?.identification ? normalizeIban(other.identification) : null;
}

function text(value: unknown): string | null {
  // Over 200 characters is dropped, not cut: nothing is shortened before the result is redacted.
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed && trimmed.length <= 200 ? trimmed : null;
}

function consentAccount(account: AccountResource & { uid: string }): ConsentAccount {
  const iban = ibanOf(account);
  return {
    id: account.uid,
    name: text(account.name) ?? text(account.product) ?? text(account.details),
    maskedIban: iban ? maskIban(iban) : null,
    currency: text(account.currency),
  };
}

async function listAccounts(
  client: GatewayClient,
  allowed: ReadonlySet<string>,
  consent: { accounts: Set<string>; validUntil: string | null },
): Promise<GatewayToolResult> {
  const readable = [...allowed].filter(id => consent.accounts.has(id));
  const shown = readable.slice(0, MAX_LIST_ACCOUNTS);
  const accounts = [];
  for (const id of shown) {
    const details = await client.getAccountDetails(id);
    const view = consentAccount({ ...(details ?? {}), uid: id });
    accounts.push({ ...view, product: text(details?.product) });
  }
  const structured = {
    consentValidUntil: consent.validUntil,
    accounts,
    ...(readable.length > shown.length ? { notShown: readable.length - shown.length } : {}),
    ...(allowed.size > readable.length ? { noLongerInConsent: allowed.size - readable.length } : {}),
  };
  const untilMs = consent.validUntil ? Date.parse(consent.validUntil) : Number.NaN;
  const until = Number.isNaN(untilMs) ? '' : `; the consent runs until ${isoDate(new Date(untilMs))}`;
  return jsonResult(`${accounts.length} bank account(s)${until}.`, structured);
}

async function getBalances(client: GatewayClient, account: string): Promise<GatewayToolResult> {
  const balances = (await client.getBalances(account)).map(balanceView);
  return jsonResult(`${balances.length} balance(s) for the account.`, { account, balances });
}

async function listTransactions(
  client: GatewayClient,
  pageKey: Buffer,
  target: { account?: string; from?: string; to?: string; status?: 'booked' | 'pending' | 'all' },
  start: PageToken | undefined,
): Promise<GatewayToolResult> {
  const account = target.account!;
  const from = target.from!;
  const to = target.to!;
  const status = target.status ?? 'booked';
  const raw: TransactionResource[] = [];
  // The page to fetch next (undefined: the first page) and how many of its rows to skip.
  let continuation: string | undefined = start?.k || undefined;
  let skip = start?.o ?? 0;
  let next: { k: string; o: number } | undefined;
  for (let page = 0; page < MAX_PAGES_PER_CALL; page++) {
    const fetchedWith = continuation;
    const result = await client.getTransactionsPage(account, {
      dateFrom: from,
      dateTo: to,
      ...(status === 'booked' ? { status: 'BOOK' as const } : status === 'pending' ? { status: 'PDNG' as const } : {}),
      ...(fetchedWith ? { continuationKey: fetchedWith } : {}),
    });
    const rows = result.transactions.slice(skip);
    const room = MAX_ROWS_PER_CALL - raw.length;
    if (rows.length > room) {
      // Cut the page: the next call fetches the same page again and skips what was returned.
      raw.push(...rows.slice(0, room));
      next = { k: fetchedWith ?? '', o: skip + room };
      break;
    }
    raw.push(...rows);
    skip = 0;
    continuation = result.continuationKey;
    if (!continuation) break;
    if (raw.length >= MAX_ROWS_PER_CALL || page === MAX_PAGES_PER_CALL - 1) {
      next = { k: continuation, o: 0 };
      break;
    }
  }
  let incomplete = false;
  if (next && (next.k.length > MAX_CONTINUATION_KEY_LENGTH || next.o > MAX_PAGE_OFFSET)) {
    // The bank's page key is too long (or a single page too large) to hand on.
    next = undefined;
    incomplete = true;
  }
  let rows: TransactionView[] = raw.map(transactionView);
  // Some banks ignore transaction_status; filter here too.
  if (status === 'booked') rows = rows.filter(row => row.status === 'BOOK');
  if (status === 'pending') rows = rows.filter(row => row.status !== 'BOOK');
  rows.sort((a, b) => (b.bookingDate ?? b.valueDate ?? '').localeCompare(a.bookingDate ?? a.valueDate ?? ''));
  const nextPageToken = next ? signPageToken(pageKey, { ...next, a: account, f: from, t: to, s: status }) : undefined;
  const structured = {
    account,
    from,
    to,
    status,
    count: rows.length,
    totals: summarize(rows),
    transactions: rows,
    ...(nextPageToken ? { nextPageToken } : {}),
    // The bank said there is more, but where to continue cannot be handed on: ask for a shorter period.
    ...(incomplete ? { incomplete: true } : {}),
  };
  const more = nextPageToken ? ' More lines follow: pass nextPageToken as pageToken.' : '';
  return jsonResult(`${rows.length} transaction(s) from ${from} to ${to}.${more}`, structured);
}

/** The data as it came; callTool redacts it and only then copies it as JSON. */
function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  return { content: [{ type: 'text', text }], structuredContent: (structuredContent ?? null) as GatewayJsonValue };
}

/**
 * A result as returned to the host: its structured data normalised to JSON
 * and then redacted as values (object keys included), its text redacted.
 * Account ids stay: only the call's values and pieces of the key are removed.
 */
function redactResult(result: GatewayToolResult, redactor: GatewayRedactor): GatewayToolResult {
  return {
    ...(result.isError ? { isError: true } : {}),
    content: result.content.map(part => ({ type: 'text' as const, text: redactor.redactValues(part.text) })),
    // Redacted first, as data and depth-limited, and only then copied as JSON.
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: JSON.parse(JSON.stringify(redactor.redactDeep(result.structuredContent))) as GatewayJsonValue }),
  };
}

function errorResult(text: string): GatewayToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}
