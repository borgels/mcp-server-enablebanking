import type { KeyObject } from 'node:crypto';
import type { ProblemCode } from '../enablebanking/problems.js';
import type { PsuPresence } from '../enablebanking/psu.js';
import type { EnableBankingExposure, GatewayJsonValue } from './catalog.js';
import type { FailureMetadata } from './failure.js';

/** The public types of the embedded gateway (`./gateway`). */

/**
 * Metadata about a failed call, on an error result whose cause is known: the HTTP status Enable Banking answered with,
 * and its own request id when a response header gives one as a UUID or hex id. For a host that counts failures
 * without reading their text. Never the response body, the error code or message, or the input.
 */
export type GatewayFailure = FailureMetadata;

/**
 * Our own fixed code for what went wrong, on every error result and on every error a consent helper throws: decided
 * by Enable Banking's documented error code (or, when it names none, the HTTP status), never by the text of an
 * answer. A closed list: see `enableBankingProblemCodes`.
 */
export type EnableBankingProblemCode = ProblemCode;

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
  /** On an error result from Enable Banking's API only: its HTTP status and request id (see GatewayFailure). */
  failure?: GatewayFailure;
  /** On an error result: what went wrong, as a fixed code. */
  errorCode?: EnableBankingProblemCode;
  /** On an error result, where Enable Banking's documentation recommends a wait before trying again: that wait. */
  retryAfterSeconds?: number;
}

/**
 * What the host stored about an account when the consent was completed (the fields of ConsentAccount). Given with a
 * call, it lets `list_accounts` answer without reading the account at the bank.
 */
export interface EnableBankingKnownAccount {
  id: string;
  name?: string | null;
  maskedIban?: string | null;
  currency?: string | null;
  product?: string | null;
  /** The account's main identifier when it has no IBAN: its scheme and masked value. */
  identification?: { scheme: string; masked: string } | null;
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
  /**
   * What the host stored about those accounts (from completeSession). Optional: with it, `list_accounts` answers from
   * the consent and makes no read at the bank; without it, each account is read at the bank on every listing.
   * An entry whose id is not in `accountIds` is ignored.
   */
  accounts?: readonly EnableBankingKnownAccount[];
}

/** The person behind a call, as the host saw them: sent to the bank as the API's `Psu-*` headers. */
export type EnableBankingPsu = PsuPresence;

/**
 * Per-call context. `caller` and `requestId` have the same shape as the other
 * servers' gateways; they are not sent to Enable Banking or stored.
 * `credentials` is required for every tool call; there is no fallback.
 *
 * Who is present decides how a bank counts the read:
 * - `psu` given: a person asked for this just now. Its fields go to the bank as `Psu-*` headers, and the bank's
 *   limit on background reads does not apply. Give only what the host really observed of that person.
 * - `unattended: true`: nobody is present (a schedule, a background job). No `Psu-*` header is sent, and the read is
 *   counted against the gateway's daily budget per consent; over budget it is refused before anything is sent.
 * - neither (the fields are not there): as before 0.7.0. No `Psu-*` header is sent, so the bank counts a background
 *   read, and the gateway keeps no budget. A host should say one or the other.
 *
 * Anything malformed (null, an empty or unknown `psu`, a value with a line break or another control character, both
 * at once) is refused, never read as "nobody is present". The values of `psu` are removed from the finished result
 * of the call, so a bank that repeats them does not hand them on: the address and the location always, the other
 * fields best effort and from 8 characters. It guards against an echo; it is no promise of anonymity (README, "Who
 * is present").
 */
export interface GatewayCallContext {
  caller?: string;
  requestId?: string;
  credentials?: EnableBankingGatewayCredentials;
  psu?: EnableBankingPsu;
  unattended?: boolean;
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
  /**
   * Reads allowed per consent in 24 hours for calls marked `unattended`. Default 4 (the PSD2 limit many banks apply).
   * 0 turns the budget off. Counted in the memory of this instance only.
   */
  unattendedFetchesPerDay?: number;
  /**
   * How many sessions ended through endSession this instance remembers, so that a call starting while (or just
   * after) a session is ended is refused even if Enable Banking has not closed it yet. Default 10 000; an entry is
   * never dropped while its endSession is under way. Calls under way do not depend on it (each holds its own watch).
   */
  endedSessionsKept?: number;
  /** Clock, for tests. */
  now?: () => number;
}

/** What a tool call will read, resolved before anything is sent. */
export interface EnableBankingReadTarget {
  readonly tool: string;
  readonly exposure: EnableBankingExposure;
  readonly account?: string;
  /** For a search over several accounts: the accounts named in the input. Left out: every connected account. */
  readonly accounts?: readonly string[];
  readonly from?: string;
  readonly to?: string;
  readonly status?: 'booked' | 'pending' | 'all';
  /** `longest`: as far back as the bank gives, up to today (`to` is then not set, and `from` only when given). */
  readonly strategy?: 'default' | 'longest';
  /** True when the call continues a previous page. */
  readonly continued?: boolean;
}

export type EnableBankingReadTargetResolution =
  | { readonly ok: true; readonly target: EnableBankingReadTarget }
  | { readonly ok: false; readonly reason: string; readonly code: EnableBankingProblemCode };

/** One way a bank lets a person authenticate. */
export interface EnableBankingAuthMethod {
  /** The value for startAuthorization's `authMethod`. */
  name: string;
  title: string | null;
  psuType: string | null;
  /** REDIRECT (the bank's own pages), DECOUPLED (an app on another device) or EMBEDDED (credentials typed elsewhere). */
  approach: string | null;
  /** True for a method the bank's own selection does not show. */
  hidden: boolean;
  /** What the person is asked to type before the bank's sign-in, e.g. a user id: name, title and whether it is required. */
  credentials: Array<{ name: string; title: string | null; required: boolean }>;
}

/** A bank (ASPSP) a company can connect. Identified by name and country together: there is no other id. */
export interface EnableBankingBank {
  name: string;
  country: string;
  /** For information only: a bank can have several, and an account can have another. */
  bic: string | null;
  psuTypes: string[];
  /** The longest consent the bank gives, in days (rounded down). Null when the bank does not say. */
  maximumConsentDays: number | null;
  /** The same in seconds, as Enable Banking gives it. */
  maximumConsentSeconds: number | null;
  /** A new integration; usable as any other. */
  beta: boolean;
  /** True for a bank's sandbox (a sandbox application lists only these). */
  sandbox: boolean;
  /** The bank group the brand belongs to. */
  group: string | null;
  /** An https address of the bank's logo. */
  logoUrl: string | null;
  authMethods: EnableBankingAuthMethod[];
  /**
   * The `Psu-*` headers this bank requires for a read to count as one a person asked for. When a call's `psu` lacks
   * one of them, the bank refuses the read (errorCode `presence_incomplete`): give all of them or none.
   */
  requiredPsuHeaders: string[];
}

/** An account to ask a bank for by number. */
export type EnableBankingAccountSelection = { iban: string } | { scheme: string; identification: string };

export interface StartAuthorizationInput {
  /** Exact bank name from listBanks. */
  bank: string;
  /** ISO 3166 two-letter code of the bank, from listBanks. */
  country: string;
  /** Default business. A sole trader with a personal online bank uses personal. */
  psuType?: 'business' | 'personal';
  /** Registered with the application at Enable Banking. https. */
  redirectUrl: string;
  /** The host's own unguessable, single-use value; it comes back on the redirect. 16-512 of A-Z a-z 0-9 . _ ~ - */
  state: string;
  /** End of the consent. Default: the bank's maximum (less five minutes). Refused beyond it. */
  validUntil?: string | Date;
  /** Language of the bank's pages, e.g. "da". */
  language?: string;
  /** One of the bank's authMethods (by name), when it offers several. Default: the bank's own choice. */
  authMethod?: string;
  /**
   * Ask for these accounts only. Without it the bank decides: some let the person pick accounts, some give all.
   * At most 50.
   */
  accounts?: readonly EnableBankingAccountSelection[];
  /** Default true. */
  balances?: boolean;
  /** Default true. */
  transactions?: boolean;
  /**
   * Default true: the person may be asked for an extra approval where a bank needs one for history older than 90
   * days. False: never ask; the history can then be limited to 90 days at such a bank.
   */
  extendedHistory?: boolean;
}

export interface StartAuthorizationResult {
  /** The bank's page; send the person there. */
  url: string;
  validUntil: string;
  maximumConsentDays: number;
  /** Enable Banking's id of the authorisation (for its consent widget). Null when it gave none in a plain form. */
  authorizationId: string | null;
}

export interface ConsentAccount {
  /** Enable Banking account uid: what goes into credentials.accountIds. */
  id: string;
  name: string | null;
  /** First four and last four characters, e.g. DK12…4567. */
  maskedIban: string | null;
  currency: string | null;
  /**
   * Enable Banking's identification hash of the account: the same for the same account in every consent, while the
   * uid changes with each new session. What a host uses to recognise an account again (renewal, duplicates). Null when
   * the bank gave none or it is not a plain token.
   */
  identificationHash: string | null;
  product: string | null;
  /** The account's main identifier when it has no IBAN (a BBAN, a Bankgiro number, a masked card number), masked. */
  identification: { scheme: string; masked: string } | null;
  /** CACC current, CARD card, CASH cash, LOAN loan, SVGS savings, OTHR other. */
  cashAccountType: string | null;
  /** PRIV private personal, ORGA professional. */
  usage: string | null;
}

export interface CompleteSessionResult {
  sessionId: string;
  /**
   * `connected`: at least one account can be read. `no_accounts`: the consent was given but covers no account that
   * can be read; the person chose none, the bank shared none, or the application runs in restricted mode at Enable
   * Banking and none of the chosen accounts is linked to it. The session exists either way; end it with endSession
   * when it is not kept.
   */
  outcome: 'connected' | 'no_accounts';
  validUntil: string | null;
  bank: { name: string; country: string } | null;
  psuType: string | null;
  accounts: ConsentAccount[];
  /** Accounts in the session without a uid (cannot be read; the bank may have blocked or closed them). */
  accountsWithoutId: number;
  /** What the consent covers, as Enable Banking states it. Null where it does not say. */
  access: { balances: boolean | null; transactions: boolean | null };
}

export interface SessionStatusResult {
  /** AUTHORIZED, CANCELLED, CLOSED, EXPIRED, INVALID, PENDING_AUTHORIZATION, RETURNED_FROM_BANK or REVOKED. */
  status: string | null;
  validUntil: string | null;
  accountIds: string[];
  /** The session's accounts with their identification hash (see ConsentAccount), where Enable Banking gave one. */
  accounts: Array<{ id: string; identificationHash: string | null }>;
  bank: { name: string; country: string } | null;
  psuType: string | null;
  createdAt: string | null;
  authorizedAt: string | null;
  closedAt: string | null;
  access: { balances: boolean | null; transactions: boolean | null };
}

export interface EndSessionResult {
  /** True when Enable Banking answered that the session was already closed, expired, revoked or unknown. */
  alreadyEnded: boolean;
}

/** The application as Enable Banking sees it. */
export interface EnableBankingApplicationStatus {
  /** PRODUCTION or SANDBOX. */
  environment: string | null;
  /**
   * False until Enable Banking has activated the application. An active production application can still be in
   * restricted mode, where only accounts linked to the application are served; the API does not say which.
   */
  active: boolean | null;
  countries: string[];
  /** AIS (account information) and, where enabled, PIS. */
  services: string[];
  redirectUrls: string[];
}
