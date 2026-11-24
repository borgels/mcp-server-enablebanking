/**
 * Fixed, machine-readable codes for what can go wrong, so a host or a model
 * can act on a failure without reading its text. Our own closed list: derived
 * from the HTTP status and Enable Banking's documented error code, never from
 * the text of an answer.
 */
export const PROBLEM_CODES = [
  /** The consent's time has run out; a person must give it again. */
  'consent_expired',
  /** The consent was closed or revoked, by the person, the bank or the application. */
  'consent_revoked',
  /** The consent is not in a usable state (never completed, unknown, invalid). */
  'consent_not_active',
  /** The account is not, or no longer, part of the consent at the bank. */
  'account_not_in_consent',
  /** The account is not one this company has connected (host list or registry). */
  'account_not_connected',
  /** The bank does not let this account be read (blocked, closed, wrong type). */
  'account_not_accessible',
  /** The bank did not answer properly; trying again later can help. */
  'bank_unavailable',
  /** The bank allows no more reads for now. */
  'rate_limited',
  /** Not sent: nobody is present and the day's automatic reads for the consent are used. */
  'unattended_limit',
  /** The bank does not give transactions for the period asked for. */
  'period_not_available',
  /** The period itself is wrong (in the future, the end before the start). */
  'invalid_period',
  /** The person must do something at the bank before it gives data again. */
  'person_action_required',
  /** The details of the person present are missing a part the bank requires, or are malformed. */
  'presence_incomplete',
  'transaction_not_found',
  /** Enable Banking did not accept the application itself: its key, its address, or a service it is not enabled for. */
  'application_refused',
  /** The application runs in restricted mode and no account linked to it is covered: only linked accounts are served. */
  'application_restricted',
  /** Access was refused and Enable Banking named no reason: the application or the consent. */
  'access_refused',
  /** The consent was given, but it covers no account that can be read. */
  'no_accounts',
  'invalid_input',
  /** No consent was given with the call. */
  'no_consent',
  'page_token_invalid',
  /** Something was not found and no more is known. */
  'not_found',
  /** Any other failure at Enable Banking. */
  'upstream_error',
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

const KNOWN: ReadonlySet<string> = new Set(PROBLEM_CODES);

export function isProblemCode(value: unknown): value is ProblemCode {
  return typeof value === 'string' && KNOWN.has(value);
}

/** Enable Banking's documented error codes (API reference, ErrorCode) that name a problem of ours. */
const BY_VENDOR_CODE: Readonly<Record<string, ProblemCode>> = Object.freeze({
  EXPIRED_SESSION: 'consent_expired',
  REVOKED_SESSION: 'consent_revoked',
  CLOSED_SESSION: 'consent_revoked',
  SESSION_DOES_NOT_EXIST: 'consent_not_active',
  WRONG_SESSION_STATUS: 'consent_not_active',
  ACCOUNT_DOES_NOT_EXIST: 'account_not_in_consent',
  ASPSP_ACCOUNT_NOT_ACCESSIBLE: 'account_not_accessible',
  ASPSP_ERROR: 'bank_unavailable',
  ASPSP_TIMEOUT: 'bank_unavailable',
  ASPSP_RATE_LIMIT_EXCEEDED: 'rate_limited',
  ASPSP_PSU_ACTION_REQUIRED: 'person_action_required',
  WRONG_TRANSACTIONS_PERIOD: 'period_not_available',
  DATE_FROM_IN_FUTURE: 'invalid_period',
  DATE_TO_WITHOUT_DATE_FROM: 'invalid_period',
  WRONG_DATE_INTERVAL: 'invalid_period',
  WRONG_CONTINUATION_KEY: 'page_token_invalid',
  PSU_HEADER_NOT_PROVIDED: 'presence_incomplete',
  PSU_HEADER_INVALID: 'presence_incomplete',
  TRANSACTION_DOES_NOT_EXIST: 'transaction_not_found',
  // 'Access to this resource is denied. Check services available for your application.'
  ACCESS_DENIED: 'application_refused',
  UNAUTHORIZED_ACCESS: 'application_refused',
  UNAUTHORIZED_IP: 'application_refused',
  INVALID_HOST: 'application_refused',
  AUTHORIZATION_NOT_PROVIDED: 'application_refused',
  // 'No allowed accounts added to the application'
  NO_ACCOUNTS_ADDED: 'application_restricted',
  // 'Either iban or other account identification is required'
  INVALID_ACCOUNT_ID: 'invalid_input',
  WRONG_REQUEST_PARAMETERS: 'invalid_input',
});

/** What to tell a person, per problem. Our own text. */
const HINTS: Readonly<Partial<Record<ProblemCode, string>>> = Object.freeze({
  consent_expired: 'The bank consent has run out; a person must renew it at the bank.',
  consent_revoked: 'The bank consent was closed or revoked; a person must give it again at the bank.',
  consent_not_active: 'The bank consent is not active; a person must give it again at the bank.',
  account_not_in_consent: 'The bank consent does not cover that account.',
  account_not_accessible: 'The bank does not let this account be read; it may be blocked or closed.',
  bank_unavailable: 'The bank did not answer properly; try again later.',
  rate_limited:
    'The bank allows no more reads for now. Without a person present a bank often allows about four a day; try again in about six hours.',
  person_action_required: 'The bank needs the account holder to do something in the bank first (often a yearly questionnaire).',
  period_not_available:
    'The bank does not give transactions for that period. Many banks give only the last 90 days once an hour has passed since the consent; ask for a later start, or for the longest history the bank has.',
  invalid_period: 'The period is not valid: the start cannot be in the future or after the end.',
  page_token_invalid: 'The page can no longer be continued; start the listing again.',
  presence_incomplete: 'The bank requires more details of the person present than were given.',
  transaction_not_found: 'The bank has no further details for that transaction.',
  application_refused:
    'Enable Banking did not accept the application itself (its key, its address or the services it is enabled for). The bank consent is not the cause.',
  application_restricted:
    'The application runs in restricted mode at Enable Banking: only accounts linked to the application are served, and none is covered here.',
  access_refused: 'Access was refused, and Enable Banking named no reason: the application or the consent was not accepted.',
  no_accounts: 'The consent covers no account that can be read.',
});

/** The plain sentence of a problem, when it has one. */
export function problemHint(code: ProblemCode | undefined): string | undefined {
  return code === undefined ? undefined : HINTS[code];
}

/** The problem a session status that is not AUTHORIZED stands for. */
export function problemFromSessionStatus(status: string | undefined): ProblemCode {
  if (status === 'EXPIRED') return 'consent_expired';
  if (status === 'REVOKED' || status === 'CLOSED' || status === 'CANCELLED') return 'consent_revoked';
  return 'consent_not_active';
}

/** Seconds to wait before trying again, where Enable Banking's documentation recommends a wait. */
export function problemRetryAfterSeconds(code: ProblemCode | undefined): number | undefined {
  // FAQ, rate limits: 'we recommend to continue data fetching after 6 hours'.
  return code === 'rate_limited' ? 6 * 3600 : undefined;
}

/**
 * The problem an HTTP answer from Enable Banking stands for. Decided by its documented error code; the HTTP status is
 * used only when the answer names none. A 401 or 403 without a code is not taken as an ended consent.
 */
export function problemFromHttp(status: number, vendorCode: string | undefined): ProblemCode {
  const named = vendorCode !== undefined && Object.hasOwn(BY_VENDOR_CODE, vendorCode) ? BY_VENDOR_CODE[vendorCode] : undefined;
  if (named) return named;
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'access_refused';
  if (status === 404) return 'not_found';
  if (status === 408 || status >= 500) return 'bank_unavailable';
  return 'upstream_error';
}

/** An error of our own that names its problem. */
export class ProblemError extends Error {
  readonly problem: ProblemCode;
  constructor(problem: ProblemCode, message: string) {
    super(message);
    this.name = 'ProblemError';
    this.problem = problem;
  }
}

/** The problem an error stands for, or undefined when it names none. */
export function problemOf(error: unknown): ProblemCode | undefined {
  if (!(error instanceof Error)) return undefined;
  const { problem, status, code } = error as Error & { problem?: unknown; status?: unknown; code?: unknown };
  if (isProblemCode(problem)) return problem;
  if (error.name === 'EnableBankingHttpError' && typeof status === 'number') {
    return problemFromHttp(status, typeof code === 'string' ? code : undefined);
  }
  if (error.name === 'EnableBankingRedirectError') return 'upstream_error';
  return undefined;
}
