import { randomBytes } from 'node:crypto';
import type { AccountResource, SessionStatus, TransactionResource } from '../enablebanking/api.js';
import { parseDecimal } from '../enablebanking/decimal.js';
import {
  accountDetailsView,
  balanceView,
  identifiersOf,
  isoDate,
  isPending,
  matchesLine,
  newestFirst,
  summarize,
  summarizeByCounterparty,
  transactionView,
  type LineFilter,
  type TransactionView,
} from '../enablebanking/format.js';
import { problemHint, problemOf, problemRetryAfterSeconds, type ProblemCode } from '../enablebanking/problems.js';
import { maskIban, normalizeIban } from '../enablebanking/registry.js';
import {
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  MAX_SEARCH_ACCOUNTS,
  SPEC_BY_NAME,
  type GatewayJsonObject,
  type GatewayJsonValue,
} from './catalog.js';
import { ID_PATTERN, TRANSACTION_ID_PATTERN, type GatewayClient, type PresenceHeaders } from './client.js';
import type {
  ConsentAccount,
  EnableBankingReadTarget,
  GatewayCallContext,
  GatewayFailure,
  GatewayToolResult,
} from './types.js';

/**
 * The gateway's tools: what a call asks for (checked before anything is
 * sent), and how each tool reads and shows bank data. Read-only: every
 * request here is a GET of account information.
 */

const DAY_MS = 86_400_000;
/** One call of list_transactions follows at most this many bank pages and returns at most this many lines. */
const MAX_PAGES_PER_CALL = 5;
const MAX_ROWS_PER_CALL = 1_000;
/** A summary needs the whole period: more pages and lines in one call, and `complete: false` beyond them. */
const SUMMARY_MAX_PAGES = 20;
const SUMMARY_MAX_ROWS = 5_000;
/** A search reads this much of each account, and says per account whether that was all of it. */
const SEARCH_MAX_PAGES = 10;
const SEARCH_MAX_ROWS = 2_500;
const MAX_ACCOUNT_IDS = 100;
const MAX_LIST_ACCOUNTS = 25;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT_PATTERN = /^\d{1,15}(\.\d{1,6})?$/;

/** Enable Banking's documented session statuses (API reference, SessionStatus). */
export const SESSION_STATUSES: ReadonlySet<string> = new Set([
  'AUTHORIZED',
  'CANCELLED',
  'CLOSED',
  'EXPIRED',
  'INVALID',
  'PENDING_AUTHORIZATION',
  'RETURNED_FROM_BANK',
  'REVOKED',
]);

export const NOT_ALLOWED = 'Refused: that account is not one of the accounts this company has connected.';
export const NO_CREDENTIALS =
  'Refused: no Enable Banking consent was given with the call (credentials.sessionId and credentials.accountIds are required).';
export const NOT_IN_CONSENT = 'Refused: the bank consent no longer covers that account. It must be connected again.';
export const PAGE_TOKEN_UNKNOWN = 'pageToken was not issued here, or it has expired; start again without it.';
export const PAGE_TOKEN_MISMATCH = 'pageToken does not belong to this account and period; start again without it.';
export const PRESENCE_CONTRADICTION =
  'Refused: the call says both that a person is present and that it is unattended; it can only be one.';

// ------------------------------------------------------------------ results

/** The data as it came; callTool redacts it and only then copies it as JSON. */
export function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  return { content: [{ type: 'text', text }], structuredContent: (structuredContent ?? null) as GatewayJsonValue };
}

export function errorResult(text: string, failure?: GatewayFailure, code?: ProblemCode): GatewayToolResult {
  const retryAfterSeconds = problemRetryAfterSeconds(code);
  return {
    isError: true,
    content: [{ type: 'text', text }],
    ...(failure ? { failure } : {}),
    ...(code ? { errorCode: code } : {}),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

// ------------------------------------------------------------------ page tokens

/**
 * Page tokens are opaque: 32 random bytes (base64url, 43 characters) that
 * name, in the memory of the gateway instance that issued them, where the
 * next page starts (Enable Banking's continuation key of the page to fetch,
 * empty for the first page, and how many rows of it were already returned)
 * and what it belongs to (session, account, period, status and strategy).
 * Nothing of that is in the token. A token is accepted only by the instance
 * that issued it, for PAGE_TOKEN_TTL_MS; at most MAX_PAGE_TOKENS are kept,
 * the oldest dropped first.
 */
export interface PageState {
  k: string;
  o: number;
  session: string;
  a: string;
  f: string;
  t: string;
  s: string;
  g: string;
  expires: number;
}

const PAGE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PAGE_TOKEN_TTL_MS = 15 * 60_000;
const MAX_PAGE_TOKENS = 10_000;
/** Longest continuation key kept for a page token; a longer one ends the listing as incomplete. */
const MAX_CONTINUATION_KEY_LENGTH = 2048;
/** Rows of one bank page a token may skip (banks with very large pages). */
const MAX_PAGE_OFFSET = 100_000;

export class PageTokens {
  private readonly entries = new Map<string, PageState>();

  constructor(private readonly now: () => number) {}

  issue(state: Omit<PageState, 'expires'>): string {
    this.prune();
    while (this.entries.size >= MAX_PAGE_TOKENS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const id = randomBytes(32).toString('base64url');
    this.entries.set(id, { ...state, expires: this.now() + PAGE_TOKEN_TTL_MS });
    return id;
  }

  find(id: string): PageState | undefined {
    this.prune();
    return this.entries.get(id);
  }

  /** Entries are kept in the order they were issued, so the expired ones come first. */
  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expires > now) break;
      this.entries.delete(id);
    }
  }
}

// ------------------------------------------------------------------ input

type Status = 'booked' | 'pending' | 'all';

interface Period {
  /** Not set only with the longest strategy and no start date. */
  from?: string;
  /** Not set with the longest strategy: the bank reads up to today. */
  to?: string;
  status: Status;
  strategy: 'default' | 'longest';
}

export type ParsedCall =
  | { tool: 'list_accounts' }
  | { tool: 'get_balances' | 'get_account_details'; account: string }
  | { tool: 'get_transaction_details'; account: string; transaction: string }
  | { tool: 'list_transactions'; account: string; period: Period; pageToken?: string }
  | { tool: 'summarize_transactions'; account: string; period: Period; top: number }
  | { tool: 'search_transactions'; accounts?: string[]; period: Period; filter: LineFilter; query?: string; limit: number };

export type CallResolution =
  | { ok: true; target: EnableBankingReadTarget; call: ParsedCall }
  | { ok: false; reason: string; code: ProblemCode };

function refuse(reason: string, code: ProblemCode = 'invalid_input'): CallResolution {
  return { ok: false, reason, code };
}

function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && isoDate(parsed) === value;
}

/** The period of a call, or the refusal. The texts are fixed: a host matches on them. */
function parsePeriod(input: GatewayJsonObject, now: number, allowLongest: boolean): { ok: true; period: Period } | { ok: false; reason: string; code: ProblemCode } {
  for (const key of ['from', 'to', 'status', 'strategy'] as const) {
    if (input[key] !== undefined && input[key] !== null && typeof input[key] !== 'string') return { ok: false, reason: `${key} must be a string.`, code: 'invalid_input' };
  }
  const status = (input.status ?? 'booked') as string;
  if (status !== 'booked' && status !== 'pending' && status !== 'all') {
    return { ok: false, reason: 'status must be booked, pending or all.', code: 'invalid_input' };
  }
  const strategy = (input.strategy ?? 'default') as string;
  if (strategy !== 'default' && !(allowLongest && strategy === 'longest')) {
    return { ok: false, reason: 'strategy must be default or longest.', code: 'invalid_input' };
  }
  const today = isoDate(new Date(now));
  const tomorrow = isoDate(new Date(now + DAY_MS));
  const givenFrom = input.from as string | null | undefined;
  const givenTo = input.to as string | null | undefined;
  if (strategy === 'longest') {
    // The API ignores an end date with this strategy; one that is given would promise a period that is not read.
    if (givenTo) return { ok: false, reason: 'to cannot be given with strategy longest: the bank reads up to today.', code: 'invalid_period' };
    if (givenFrom && !isValidDate(givenFrom)) return { ok: false, reason: 'from must be a date, YYYY-MM-DD.', code: 'invalid_period' };
    if (givenFrom && givenFrom > tomorrow) return { ok: false, reason: 'from cannot be in the future.', code: 'invalid_period' };
    return { ok: true, period: { ...(givenFrom ? { from: givenFrom } : {}), status, strategy } };
  }
  const to = givenTo ?? today;
  if (!isValidDate(to)) return { ok: false, reason: 'to must be a date, YYYY-MM-DD.', code: 'invalid_period' };
  // The default period is DEFAULT_RANGE_DAYS days including `to`.
  const from = givenFrom ?? isoDate(new Date(Date.parse(to) - (DEFAULT_RANGE_DAYS - 1) * DAY_MS));
  if (!isValidDate(from)) return { ok: false, reason: 'from must be a date, YYYY-MM-DD.', code: 'invalid_period' };
  if (from > to) return { ok: false, reason: `from (${from}) is after to (${to}).`, code: 'invalid_period' };
  if (to > tomorrow) return { ok: false, reason: 'to cannot be in the future.', code: 'invalid_period' };
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > MAX_RANGE_DAYS) {
    return { ok: false, reason: `The period is longer than ${MAX_RANGE_DAYS} days; ask for a shorter one.`, code: 'invalid_period' };
  }
  return { ok: true, period: { from, to, status, strategy } };
}

function wholeNumber(value: GatewayJsonValue | undefined, fallback: number, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return fallback;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

function periodTarget(period: Period): Pick<EnableBankingReadTarget, 'from' | 'to' | 'status' | 'strategy'> {
  return {
    ...(period.from ? { from: period.from } : {}),
    ...(period.to ? { to: period.to } : {}),
    status: period.status,
    ...(period.strategy === 'longest' ? { strategy: period.strategy } : {}),
  };
}

/**
 * Resolves what a tool call asks for, with every check that needs nothing
 * but the input: known tool, no unknown fields, well-formed account, dates,
 * amounts and page token, and a period of at most 366 days. The account
 * allowlist needs the call's credentials and is checked by callTool.
 */
export function parseCall(toolName: string, input: GatewayJsonObject = {}, now: number = Date.now()): CallResolution {
  const spec = typeof toolName === 'string' ? SPEC_BY_NAME.get(toolName) : undefined;
  // The name and the field names are the host's input: not repeated, so nothing it carries is echoed.
  if (!spec) return refuse('Unsupported Enable Banking gateway tool.');
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return refuse('Input must be an object.');
  const properties = (spec.inputSchema.properties ?? {}) as GatewayJsonObject;
  const unknown = Object.keys(input).filter(key => !Object.hasOwn(properties, key));
  if (unknown.length > 0) {
    return refuse(`Unknown input field(s) for ${spec.name}: ${unknown.length}.`);
  }
  const base = { tool: spec.name, exposure: spec.exposure };

  if (spec.name === 'list_accounts') return { ok: true, target: base, call: { tool: 'list_accounts' } };

  if (spec.name === 'search_transactions') {
    let accounts: string[] | undefined;
    if (input.accounts !== undefined && input.accounts !== null) {
      const given = input.accounts;
      if (!Array.isArray(given) || given.length === 0 || given.length > MAX_SEARCH_ACCOUNTS) {
        return refuse(`accounts must be a list of 1 to ${MAX_SEARCH_ACCOUNTS} account ids.`);
      }
      if (!given.every((id): id is string => typeof id === 'string' && ID_PATTERN.test(id))) return refuse(NOT_ALLOWED, 'account_not_connected');
      accounts = [...new Set(given)];
    }
    const parsed = parsePeriod(input, now, false);
    if (!parsed.ok) return parsed;
    const filter: LineFilter = {};
    let query: string | undefined;
    if (input.query !== undefined && input.query !== null) {
      if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 200) return refuse('query must be a text of 1 to 200 characters.');
      query = input.query.trim();
      filter.search = query;
    }
    if (input.direction !== undefined && input.direction !== null) {
      if (input.direction !== 'in' && input.direction !== 'out') return refuse('direction must be in or out.');
      filter.direction = input.direction;
    }
    for (const key of ['minAmount', 'maxAmount'] as const) {
      const value = input[key];
      if (value === undefined || value === null) continue;
      const amount = typeof value === 'string' && AMOUNT_PATTERN.test(value) ? parseDecimal(value) : null;
      if (!amount) return refuse(`${key} must be a decimal with a dot and no sign, such as 1000 or 99.50.`);
      filter[key] = amount;
    }
    if (!filter.search && !filter.direction && !filter.minAmount && !filter.maxAmount) {
      return refuse('Give at least one of query, minAmount, maxAmount and direction.');
    }
    const limit = wholeNumber(input.limit, 100, 1, 500);
    if (limit === undefined) return refuse('limit must be a whole number from 1 to 500.');
    return {
      ok: true,
      target: { ...base, ...(accounts ? { accounts } : {}), ...periodTarget(parsed.period) },
      call: { tool: 'search_transactions', ...(accounts ? { accounts } : {}), period: parsed.period, filter, ...(query ? { query } : {}), limit },
    };
  }

  const account = input.account;
  if (typeof account !== 'string' || !ID_PATTERN.test(account)) return refuse(NOT_ALLOWED, 'account_not_connected');
  if (spec.name === 'get_balances' || spec.name === 'get_account_details') {
    return { ok: true, target: { ...base, account }, call: { tool: spec.name, account } };
  }
  if (spec.name === 'get_transaction_details') {
    const transaction = input.transaction;
    if (typeof transaction !== 'string' || !TRANSACTION_ID_PATTERN.test(transaction)) {
      return refuse('transaction must be the detailsId of a line from list_transactions.');
    }
    return { ok: true, target: { ...base, account }, call: { tool: 'get_transaction_details', account, transaction } };
  }
  if (spec.name === 'summarize_transactions') {
    const parsed = parsePeriod(input, now, false);
    if (!parsed.ok) return parsed;
    const top = wholeNumber(input.top, 50, 1, 200);
    if (top === undefined) return refuse('top must be a whole number from 1 to 200.');
    return {
      ok: true,
      target: { ...base, account, ...periodTarget(parsed.period) },
      call: { tool: 'summarize_transactions', account, period: parsed.period, top },
    };
  }

  // list_transactions
  if (input.pageToken !== undefined && input.pageToken !== null && typeof input.pageToken !== 'string') return refuse('pageToken must be a string.');
  const parsed = parsePeriod(input, now, true);
  if (!parsed.ok) return parsed;
  const pageToken = input.pageToken as string | null | undefined;
  // Only the form is checked here: what a token stands for is known only to the instance that issued it (callTool).
  if (pageToken && !PAGE_TOKEN_PATTERN.test(pageToken)) return refuse(PAGE_TOKEN_UNKNOWN, 'page_token_invalid');
  return {
    ok: true,
    target: { ...base, account, ...periodTarget(parsed.period), ...(pageToken ? { continued: true } : {}) },
    call: { tool: 'list_transactions', account, period: parsed.period, ...(pageToken ? { pageToken } : {}) },
  };
}

// ------------------------------------------------------------------ credentials and consent

function text(value: unknown): string | null {
  // Over 200 characters is dropped, not cut: nothing is shortened before the result is redacted.
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed && trimmed.length <= 200 ? trimmed : null;
}

/** An account as list_accounts shows it. */
interface ListedAccount {
  id: string;
  name: string | null;
  maskedIban: string | null;
  currency: string | null;
  product: string | null;
  identification?: { scheme: string; masked: string };
}

export interface CallCredentials {
  sessionId: string;
  accountIds: ReadonlySet<string>;
  /** What the host stored about its accounts, by id. */
  known: ReadonlyMap<string, ListedAccount>;
}

function knownIdentification(value: unknown): { scheme: string; masked: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const scheme = text((value as { scheme?: unknown }).scheme);
  const masked = text((value as { masked?: unknown }).masked);
  return scheme && masked ? { scheme, masked } : undefined;
}

/** The call's consent, or undefined when it is missing, empty or malformed. No fallback. */
export function callCredentials(context: GatewayCallContext | undefined): CallCredentials | undefined {
  const credentials = context?.credentials as unknown;
  if (!credentials || typeof credentials !== 'object') return undefined;
  const { sessionId, accountIds, accounts } = credentials as { sessionId?: unknown; accountIds?: unknown; accounts?: unknown };
  if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) return undefined;
  if (!Array.isArray(accountIds) || accountIds.length === 0 || accountIds.length > MAX_ACCOUNT_IDS) return undefined;
  if (!accountIds.every(id => typeof id === 'string' && ID_PATTERN.test(id))) return undefined;
  const allowed = new Set(accountIds as string[]);
  const known = new Map<string, ListedAccount>();
  // The host's own notes about its accounts. One that names another account, or is malformed, is left out: the
  // account is then read at the bank instead.
  for (const entry of Array.isArray(accounts) ? accounts.slice(0, MAX_ACCOUNT_IDS) : []) {
    if (!entry || typeof entry !== 'object') continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== 'string' || !allowed.has(id) || known.has(id)) continue;
    const record = entry as Record<string, unknown>;
    const identification = knownIdentification(record.identification);
    known.set(id, {
      id,
      name: text(record.name),
      maskedIban: text(record.maskedIban),
      currency: text(record.currency),
      product: text(record.product),
      ...(identification ? { identification } : {}),
    });
  }
  return { sessionId, accountIds: allowed, known };
}

/** A date and time from Enable Banking as ISO 8601 in UTC, or null when it is not one. Nothing else of it is kept. */
export function instant(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function sessionAccounts(session: SessionStatus | undefined): Set<string> {
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

/**
 * Enable Banking's identification hash of an account: opaque, in their documented examples two base64 parts joined by
 * a dot (about 100 characters). Anything else than that alphabet, or over 256 characters, is dropped.
 */
const HASH_PATTERN = /^[A-Za-z0-9+/=_.-]{8,256}$/;
export function identificationHash(value: unknown): string | null {
  return typeof value === 'string' && HASH_PATTERN.test(value) ? value : null;
}

/** The session's accounts (uids from `accounts` and `accounts_data`) with the identification hash where given. */
export function sessionAccountHashes(session: SessionStatus | undefined): Array<{ id: string; identificationHash: string | null }> {
  const hashes = new Map<string, string | null>();
  const data = (session as { accounts_data?: unknown } | undefined)?.accounts_data;
  if (Array.isArray(data)) {
    for (const entry of data) {
      const uid = (entry as { uid?: unknown } | null)?.uid;
      if (typeof uid === 'string' && ID_PATTERN.test(uid)) {
        hashes.set(uid, identificationHash((entry as { identification_hash?: unknown }).identification_hash));
      }
    }
  }
  return [...sessionAccounts(session)].filter(id => ID_PATTERN.test(id)).map(id => ({ id, identificationHash: hashes.get(id) ?? null }));
}

/** The bank of a session, when Enable Banking names it in plain form. */
export function sessionBank(session: { aspsp?: unknown } | undefined | null): { name: string; country: string } | null {
  const aspsp = session?.aspsp as { name?: unknown; country?: unknown } | null | undefined;
  const name = text(aspsp?.name);
  const country = typeof aspsp?.country === 'string' && /^[A-Z]{2}$/.test(aspsp.country) ? aspsp.country : null;
  return name && country ? { name, country } : null;
}

export function sessionAccess(session: { access?: unknown } | undefined | null): { balances: boolean | null; transactions: boolean | null } {
  const access = session?.access as { balances?: unknown; transactions?: unknown } | null | undefined;
  return {
    balances: typeof access?.balances === 'boolean' ? access.balances : null,
    transactions: typeof access?.transactions === 'boolean' ? access.transactions : null,
  };
}

export interface ActiveConsent {
  accounts: Set<string>;
  validUntil: string | null;
  bank: { name: string; country: string } | null;
  psuType: string | null;
  authorizedAt: string | null;
}

export type ConsentCheck = ({ ok: true } & ActiveConsent) | { ok: false; reason: string; code: ProblemCode };

/** The problem a session status that is not AUTHORIZED stands for. */
function statusProblem(status: string | undefined): ProblemCode {
  if (status === 'EXPIRED') return 'consent_expired';
  if (status === 'REVOKED' || status === 'CLOSED' || status === 'CANCELLED') return 'consent_revoked';
  return 'consent_not_active';
}

export function consentState(session: SessionStatus | undefined, now: number): ConsentCheck {
  const status = typeof session?.status === 'string' ? session.status : undefined;
  if (status !== 'AUTHORIZED') {
    // Only a documented status is named; anything else from Enable Banking is not repeated.
    return {
      ok: false,
      reason: `The bank consent is not active${status && SESSION_STATUSES.has(status) ? ` (${status})` : ''}. It must be renewed.`,
      code: statusProblem(status),
    };
  }
  const validUntil = instant(session?.access?.valid_until);
  if (validUntil && Date.parse(validUntil) <= now) {
    return { ok: false, reason: `The bank consent expired on ${validUntil.slice(0, 10)}. It must be renewed.`, code: 'consent_expired' };
  }
  return {
    ok: true,
    accounts: sessionAccounts(session),
    validUntil,
    bank: sessionBank(session),
    psuType: session?.psu_type === 'business' || session?.psu_type === 'personal' ? session.psu_type : null,
    authorizedAt: instant(session?.authorized),
  };
}

function ibanOf(account: AccountResource): string | null {
  const direct = account.account_id?.iban;
  if (typeof direct === 'string' && direct) return normalizeIban(direct);
  const other = Array.isArray(account.all_account_ids)
    ? account.all_account_ids.find(id => id?.scheme_name === 'IBAN' && typeof id.identification === 'string')
    : undefined;
  return other?.identification ? normalizeIban(other.identification) : null;
}

/** A number other than an IBAN, shown by its last four characters only. */
function maskNumber(value: string): string {
  const plain = value.replace(/[^A-Za-z0-9]/g, '');
  return plain.length > 4 ? `…${plain.slice(-4)}` : '…';
}

/** The account's main identifier when it has no IBAN, masked. Null when it has an IBAN or no number at all. */
function otherIdentification(account: AccountResource): { scheme: string; masked: string } | null {
  if (ibanOf(account)) return null;
  const other = identifiersOf(account.account_id, account.all_account_ids).find(identifier => identifier.scheme !== 'IBAN');
  if (!other || other.scheme.length > 16) return null;
  return { scheme: other.scheme, masked: other.scheme === 'CPAN' ? other.identification : maskNumber(other.identification) };
}

export function consentAccount(account: AccountResource & { uid: string }): ConsentAccount {
  const iban = ibanOf(account);
  return {
    id: account.uid,
    name: text(account.name) ?? text(account.product) ?? text(account.details),
    maskedIban: iban ? maskIban(iban) : null,
    currency: text(account.currency),
    identificationHash: identificationHash(account.identification_hash),
    product: text(account.product),
    identification: otherIdentification(account),
    cashAccountType: text(account.cash_account_type),
    usage: text(account.usage),
  };
}

// ------------------------------------------------------------------ tools

export interface ToolEnvironment {
  client: GatewayClient;
  /** `Psu-*` headers of the person present; undefined for a background read. */
  presence?: PresenceHeaders;
  now: () => number;
  issuePageToken: (next: { k: string; o: number }) => string;
  /**
   * Told of every failed read at the bank, also one that ends up inside an
   * answer (a search that could read some accounts and not others), so the
   * caller can act on it: a bank's rate limit pauses unattended reads.
   */
  onProblem?: (problem: ProblemCode) => void;
}

/** The connected accounts that the consent still covers, in the host's order. */
function readable(credentials: CallCredentials, consent: ActiveConsent): string[] {
  return [...credentials.accountIds].filter(id => consent.accounts.has(id));
}

/**
 * How many accounts a call reads at the bank: what an unattended call takes
 * from the day's budget. A continued page belongs to the read that started
 * the listing.
 */
export function bankReads(call: ParsedCall, credentials: CallCredentials, consent: ActiveConsent): number {
  if (call.tool === 'list_accounts') {
    return readable(credentials, consent)
      .slice(0, MAX_LIST_ACCOUNTS)
      .filter(id => !credentials.known.has(id)).length;
  }
  if (call.tool === 'search_transactions') return (call.accounts ?? readable(credentials, consent).slice(0, MAX_SEARCH_ACCOUNTS)).length;
  if (call.tool === 'list_transactions' && call.pageToken) return 0;
  return 1;
}

function fetchedAt(env: ToolEnvironment): string {
  return new Date(env.now()).toISOString();
}

async function listAccounts(env: ToolEnvironment, credentials: CallCredentials, consent: ActiveConsent): Promise<GatewayToolResult> {
  const all = readable(credentials, consent);
  const shown = all.slice(0, MAX_LIST_ACCOUNTS);
  const accounts: ListedAccount[] = [];
  let fromBank = 0;
  for (const id of shown) {
    const known = credentials.known.get(id);
    if (known) {
      accounts.push(known);
      continue;
    }
    const details = await env.client.getAccountDetails(id, env.presence);
    fromBank += 1;
    // The identification hash is for the host's consent page only; the tool's answer does not carry it.
    const view = consentAccount({ ...(details ?? {}), uid: id });
    accounts.push({
      id: view.id,
      name: view.name,
      maskedIban: view.maskedIban,
      currency: view.currency,
      product: view.product,
      ...(view.identification ? { identification: view.identification } : {}),
    });
  }
  const untilMs = consent.validUntil ? Date.parse(consent.validUntil) : Number.NaN;
  const structured = {
    consentValidUntil: consent.validUntil,
    consent: {
      status: 'AUTHORIZED',
      validUntil: consent.validUntil,
      expiresInDays: Number.isNaN(untilMs) ? null : Math.floor((untilMs - env.now()) / DAY_MS),
      bank: consent.bank,
      psuType: consent.psuType,
      authorizedAt: consent.authorizedAt,
    },
    // Where the account lines come from: the consent as the host stored it, or a read at the bank just now.
    source: fromBank === 0 ? 'consent' : fromBank === shown.length ? 'bank' : 'mixed',
    ...(fromBank > 0 ? { fetchedAt: fetchedAt(env) } : {}),
    accounts,
    ...(all.length > shown.length ? { notShown: all.length - shown.length } : {}),
    ...(credentials.accountIds.size > all.length ? { noLongerInConsent: credentials.accountIds.size - all.length } : {}),
  };
  const until = Number.isNaN(untilMs) ? '' : `; the consent runs until ${isoDate(new Date(untilMs))}`;
  return jsonResult(`${accounts.length} bank account(s)${until}.`, structured);
}

async function getBalances(env: ToolEnvironment, account: string): Promise<GatewayToolResult> {
  const balances = (await env.client.getBalances(account, env.presence)).map(balanceView);
  return jsonResult(`${balances.length} balance(s) for the account.`, { account, fetchedAt: fetchedAt(env), balances });
}

async function getAccountDetails(env: ToolEnvironment, account: string): Promise<GatewayToolResult> {
  const details = accountDetailsView(await env.client.getAccountDetails(account, env.presence));
  return jsonResult('The bank’s description of the account.', { account, fetchedAt: fetchedAt(env), details });
}

async function getTransactionDetails(env: ToolEnvironment, account: string, transaction: string): Promise<GatewayToolResult> {
  const raw = await env.client.getTransaction(account, transaction, env.presence);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return errorResult(problemHint('transaction_not_found')!, undefined, 'transaction_not_found');
  }
  return jsonResult('The bank’s details of the transaction.', { account, fetchedAt: fetchedAt(env), transaction: transactionView(raw) });
}

interface Collected {
  raw: TransactionResource[];
  /** Where the bank's listing continues, when it was not read to its end. */
  next?: { k: string; o: number };
}

/**
 * Reads the bank's pages of one listing until its end, or until `pages`
 * pages or `rows` lines are reached. An empty page with a continuation key is
 * followed like any other. Every page is asked for with the same parameters.
 */
async function collect(
  env: ToolEnvironment,
  account: string,
  period: Period,
  limits: { pages: number; rows: number },
  start?: { k: string; o: number },
): Promise<Collected> {
  const raw: TransactionResource[] = [];
  // The page to fetch next (undefined: the first page) and how many of its rows to skip.
  let continuation: string | undefined = start?.k || undefined;
  let skip = start?.o ?? 0;
  for (let page = 0; page < limits.pages; page++) {
    const fetchedWith = continuation;
    const result = await env.client.getTransactionsPage(
      account,
      {
        ...(period.from ? { dateFrom: period.from } : {}),
        ...(period.to ? { dateTo: period.to } : {}),
        ...(period.status === 'booked' ? { status: 'BOOK' as const } : period.status === 'pending' ? { status: 'PDNG' as const } : {}),
        ...(period.strategy === 'longest' ? { strategy: 'longest' as const } : {}),
        ...(fetchedWith ? { continuationKey: fetchedWith } : {}),
      },
      env.presence,
    );
    const rows = result.transactions.slice(skip);
    const room = limits.rows - raw.length;
    if (rows.length > room) {
      // Cut the page: the next call fetches the same page again and skips what was returned.
      raw.push(...rows.slice(0, room));
      return { raw, next: { k: fetchedWith ?? '', o: skip + room } };
    }
    raw.push(...rows);
    skip = 0;
    continuation = result.continuationKey;
    if (!continuation) return { raw };
    if (raw.length >= limits.rows || page === limits.pages - 1) return { raw, next: { k: continuation, o: 0 } };
  }
  return { raw };
}

/** The bank's lines as views, in the status asked for, newest first. */
function views(raw: TransactionResource[], status: Status): TransactionView[] {
  // A line without a status, returned for a request that asked for one status, is taken to have it.
  const assumed = status === 'booked' ? 'BOOK' : status === 'pending' ? 'PDNG' : undefined;
  let rows = raw.map(row => transactionView(row, assumed));
  // Some banks ignore transaction_status; filter here too.
  if (status === 'booked') rows = rows.filter(row => row.status === 'BOOK');
  if (status === 'pending') rows = rows.filter(row => isPending(row.status));
  return rows.sort(newestFirst);
}

function periodText(period: Period): string {
  if (period.strategy === 'longest') return period.from ? `from ${period.from} to today` : 'as far back as the bank gives, to today';
  return `from ${period.from} to ${period.to}`;
}

async function listTransactions(
  env: ToolEnvironment,
  account: string,
  period: Period,
  start: { k: string; o: number } | undefined,
): Promise<GatewayToolResult> {
  let { raw, next } = await collect(env, account, period, { pages: MAX_PAGES_PER_CALL, rows: MAX_ROWS_PER_CALL }, start);
  let incomplete = false;
  if (next && (next.k.length > MAX_CONTINUATION_KEY_LENGTH || next.o > MAX_PAGE_OFFSET)) {
    // The bank's page key is too long to keep (or a single page too large): the listing ends here, incomplete.
    next = undefined;
    incomplete = true;
  }
  const rows = views(raw, period.status);
  // An opaque id; the continuation key and the account stay in the instance.
  const nextPageToken = next ? env.issuePageToken(next) : undefined;
  const structured = {
    account,
    from: period.from ?? null,
    to: period.to ?? null,
    status: period.status,
    ...(period.strategy === 'longest' ? { strategy: period.strategy } : {}),
    fetchedAt: fetchedAt(env),
    count: rows.length,
    // Whether the bank has more lines for the period than this answer holds.
    hasMore: Boolean(nextPageToken) || incomplete,
    totals: summarize(rows),
    transactions: rows,
    ...(nextPageToken ? { nextPageToken } : {}),
    // The bank said there is more, but where to continue cannot be handed on: ask for a shorter period.
    ...(incomplete ? { incomplete: true } : {}),
  };
  const more = nextPageToken
    ? ' More lines follow: pass nextPageToken as pageToken.'
    : incomplete
      ? ' The bank has more lines that cannot be continued from here: ask for a shorter period.'
      : '';
  return jsonResult(`${rows.length} transaction(s) ${periodText(period)}.${more}`, structured);
}

async function summarizeTransactions(env: ToolEnvironment, account: string, period: Period, top: number): Promise<GatewayToolResult> {
  const { raw, next } = await collect(env, account, period, { pages: SUMMARY_MAX_PAGES, rows: SUMMARY_MAX_ROWS });
  const rows = views(raw, period.status);
  const groups = summarizeByCounterparty(rows);
  const complete = !next;
  const structured = {
    account,
    from: period.from ?? null,
    to: period.to ?? null,
    status: period.status,
    fetchedAt: fetchedAt(env),
    // Computed here from the bank's lines; nothing is added to them.
    derived: true,
    // False: the period held more lines than one call reads, and the numbers cover only the lines read.
    complete,
    lines: rows.length,
    totals: summarize(rows),
    counterparties: groups.slice(0, top),
    ...(groups.length > top ? { counterpartiesNotShown: groups.length - top } : {}),
  };
  const partial = complete ? '' : ' The period held more lines than one call reads: the totals cover only these lines; ask for a shorter period.';
  return jsonResult(`${rows.length} transaction(s) ${periodText(period)} in ${groups.length} counterparty group(s).${partial}`, structured);
}

async function searchTransactions(
  env: ToolEnvironment,
  call: Extract<ParsedCall, { tool: 'search_transactions' }>,
  credentials: CallCredentials,
  consent: ActiveConsent,
): Promise<GatewayToolResult> {
  const candidates = readable(credentials, consent);
  const searched = call.accounts ?? candidates.slice(0, MAX_SEARCH_ACCOUNTS);
  const perAccount: Array<{ account: string; read: boolean; lines?: number; matches?: number; complete?: boolean; problem?: ProblemCode }> = [];
  const matches: Array<TransactionView & { account: string }> = [];
  let stopped: ProblemCode | undefined;
  let firstFailure: { problem: ProblemCode; error: unknown } | undefined;
  for (const account of searched) {
    if (stopped) {
      // The bank allows no more reads: the remaining accounts are not asked.
      perAccount.push({ account, read: false, problem: stopped });
      continue;
    }
    try {
      const { raw, next } = await collect(env, account, call.period, { pages: SEARCH_MAX_PAGES, rows: SEARCH_MAX_ROWS });
      const rows = views(raw, call.period.status);
      const found = rows.filter(row => matchesLine(row, call.filter));
      for (const row of found) matches.push({ account, ...row });
      perAccount.push({ account, read: true, lines: rows.length, matches: found.length, complete: !next });
    } catch (error) {
      const problem = problemOf(error) ?? 'upstream_error';
      env.onProblem?.(problem);
      firstFailure ??= { problem, error };
      perAccount.push({ account, read: false, problem });
      if (problem === 'rate_limited') stopped = problem;
    }
  }
  // Nothing could be read: the failure itself is the answer.
  if (firstFailure && perAccount.every(entry => !entry.read)) throw firstFailure.error;
  matches.sort(newestFirst);
  const returned = matches.slice(0, call.limit);
  const complete = perAccount.every(entry => entry.read && entry.complete) && candidates.length <= searched.length;
  const structured = {
    ...(call.query ? { query: call.query } : {}),
    from: call.period.from ?? null,
    to: call.period.to ?? null,
    status: call.period.status,
    fetchedAt: fetchedAt(env),
    // Computed here from the bank's lines; nothing is added to them.
    derived: true,
    // True only when every connected account was read to the end of the period.
    complete,
    accounts: perAccount,
    ...(call.accounts === undefined && candidates.length > searched.length ? { accountsNotSearched: candidates.length - searched.length } : {}),
    count: matches.length,
    returned: returned.length,
    truncated: matches.length > returned.length,
    totals: summarize(returned),
    transactions: returned,
  };
  const partial = complete ? '' : ' Not every line of every account was searched: see complete and accounts.';
  return jsonResult(`${matches.length} matching transaction(s) in ${perAccount.filter(entry => entry.read).length} account(s).${partial}`, structured);
}

/** Runs a call that passed every check. `start` is where a continued listing goes on. */
export function runTool(
  env: ToolEnvironment,
  call: ParsedCall,
  credentials: CallCredentials,
  consent: ActiveConsent,
  start?: { k: string; o: number },
): Promise<GatewayToolResult> {
  switch (call.tool) {
    case 'list_accounts':
      return listAccounts(env, credentials, consent);
    case 'get_balances':
      return getBalances(env, call.account);
    case 'get_account_details':
      return getAccountDetails(env, call.account);
    case 'get_transaction_details':
      return getTransactionDetails(env, call.account, call.transaction);
    case 'list_transactions':
      return listTransactions(env, call.account, call.period, start);
    case 'summarize_transactions':
      return summarizeTransactions(env, call.account, call.period, call.top);
    default:
      return searchTransactions(env, call, credentials, consent);
  }
}
