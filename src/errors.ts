/**
 * Errors from Enable Banking.
 *
 * The rule: no text Enable Banking or a bank controls reaches a host, a
 * result or a log through an error. An HTTP error carries the status, our own
 * hint and, when Enable Banking names one, an error code from its documented
 * list (ERROR_CODES); never the message or detail of the body. Their text can
 * quote the request, and no redactor recognises every fragment of it.
 */

/** Enable Banking's documented error codes (API reference, ErrorCode). Anything else is dropped. */
export const ERROR_CODES: ReadonlySet<string> = new Set([
  'ACCESS_DENIED',
  'ACCOUNT_DOES_NOT_EXIST',
  'ALREADY_AUTHORIZED',
  'ASPSP_ACCOUNT_NOT_ACCESSIBLE',
  'ASPSP_ERROR',
  'ASPSP_PAYMENT_NOT_ACCESSIBLE',
  'ASPSP_PSU_ACTION_REQUIRED',
  'ASPSP_RATE_LIMIT_EXCEEDED',
  'ASPSP_TIMEOUT',
  'AUTHORIZATION_NOT_PROVIDED',
  'CLOSED_SESSION',
  'DATE_FROM_IN_FUTURE',
  'DATE_TO_WITHOUT_DATE_FROM',
  'EXPIRED_AUTHORIZATION_CODE',
  'EXPIRED_SESSION',
  'INVALID_ACCOUNT_ID',
  'INVALID_HOST',
  'INVALID_PAYMENT',
  'NO_ACCOUNTS_ADDED',
  'PAYMENT_LIMIT_EXCEEDED',
  'PAYMENT_NOT_AUTHORIZED',
  'PAYMENT_NOT_FINALIZED',
  'PAYMENT_NOT_FOUND',
  'PAYMENT_SUBMISSION_NOT_DEFERRED',
  'PAYMENT_SUBMISSION_NOT_SUPPORTED',
  'PSU_HEADER_INVALID',
  'PSU_HEADER_NOT_PROVIDED',
  'REDIRECT_URI_NOT_ALLOWED',
  'REVOKED_SESSION',
  'SESSION_DOES_NOT_EXIST',
  'TRANSACTION_DOES_NOT_EXIST',
  'UNAUTHORIZED_ACCESS',
  'UNAUTHORIZED_IP',
  'UNTRUSTED_PAYMENT_PARTY',
  'WEBHOOK_URI_NOT_ALLOWED',
  'WRONG_ASPSP_PROVIDED',
  'WRONG_AUTHORIZATION_CODE',
  'WRONG_CONTINUATION_KEY',
  'WRONG_CREDENTIALS_PROVIDED',
  'WRONG_DATE_INTERVAL',
  'WRONG_REQUEST_PARAMETERS',
  'WRONG_SESSION_STATUS',
  'WRONG_TRANSACTIONS_PERIOD',
]);

/** Our own guidance per HTTP status. */
function statusHint(status: number): string | undefined {
  if (status === 401) return 'The application or the consent was not accepted.';
  if (status === 403) return 'Access was refused.';
  if (status === 404) return 'Not found.';
  if (status === 429) return 'Too many requests; wait and try again.';
  if (status >= 500) return 'Enable Banking or the bank is not answering properly; try again later.';
  return undefined;
}

/** The documented error code in an error body, or undefined. The rest of the body is not kept. */
export function documentedErrorCode(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const body = payload as Record<string, unknown>;
  for (const candidate of [body.error, body.code]) {
    if (typeof candidate === 'string' && ERROR_CODES.has(candidate)) return candidate;
  }
  return undefined;
}

/** Non-2xx answer from the Enable Banking API: the status and a documented code. Nothing else of the body is kept. */
export class EnableBankingHttpError extends Error {
  readonly status: number;
  readonly path: string;
  readonly code?: string;

  constructor(init: { status: number; method: string; path: string; payload?: unknown }) {
    const code = documentedErrorCode(init.payload);
    const path = redactPath(init.path);
    const hint = statusHint(init.status);
    super(`Enable Banking ${init.method} ${path} failed with HTTP ${init.status}${code ? ` (${code})` : ''}.${hint ? ` ${hint}` : ''}`);
    this.name = 'EnableBankingHttpError';
    this.status = init.status;
    this.path = path;
    if (code !== undefined) this.code = code;
  }

  /** The bank or Enable Banking no longer honours the consent behind this call. */
  get consentLost(): boolean {
    return (
      this.status === 401 ||
      this.status === 403 ||
      /^(EXPIRED_SESSION|CLOSED_SESSION|REVOKED_SESSION|SESSION_DOES_NOT_EXIST|ACCOUNT_DOES_NOT_EXIST)$/.test(this.code ?? '')
    );
  }
}

/** Keys whose value is a failure context: anything inside that carries an error or a message is a failure. */
const FAILURE_CONTEXTS = new Set(['failures', 'failure', 'errors', 'error', 'metadata', 'warnings', 'amount']);
/** Fields that make an object in a failure context a failure. */
const FAILURE_FIELDS = ['error', 'errors', 'failures', 'warnings', 'message', 'detail', 'description'];
/** Failure lists: every element in one is a failure, whatever its fields. */
const FAILURE_LISTS = new Set(['failures', 'failure', 'errors', 'error', 'warnings']);

/** One element of a failure list, reduced to a numeric status (when it has one) and our own text. */
function failureEntry(value: unknown): { status?: number; message: string } {
  const status =
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>).status : undefined;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? { status, message: `Enable Banking reported a failure with HTTP ${status}.` }
    : { message: 'Enable Banking reported a failure.' };
}

/** A failure list: every element (an object with any fields, a text, a list) becomes a failureEntry. */
function failureList(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  return Array.isArray(value) ? value.map(failureEntry) : failureEntry(value);
}

/**
 * Copy of a successful body with every failure reported inside it reduced to
 * its HTTP status and our own text.
 *
 * - Every element of a failure list (`failures`, `failure`, `errors`,
 *   `error`, `warnings`), at any depth, becomes `{ status?, message }`: a
 *   numeric status is kept, and every other field, whatever its name, is
 *   dropped. Nothing below a failure list is kept.
 * - Elsewhere a failure is an object with a numeric `status` of 400 or
 *   more, an object with an `error` field, or an object in a failure
 *   context (`metadata`, `amount` and the like, also through wrappers such
 *   as `data` below them) with any of `error`, `errors`, `failures`,
 *   `warnings`, `message`, `detail` or `description`. It becomes
 *   `{ status?, error }` with our own text.
 *
 * A text outside a failure list, an amount among them, is kept.
 * Depth-limited.
 */
export function nestedFailuresAsStatus(value: unknown, depth = 0, context = false): unknown {
  if (depth > 64) {
    return '[nested too deep]';
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(entry => nestedFailuresAsStatus(entry, depth + 1, context));
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  const failedStatus = typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599;
  const present = (field: string) => Object.hasOwn(record, field) && record[field] !== null && record[field] !== undefined;
  if (failedStatus || present('error') || (context && FAILURE_FIELDS.some(present))) {
    return failedStatus
      ? { status, error: `Enable Banking reported a failure with HTTP ${status}.` }
      : { error: 'Enable Banking reported a failure.' };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      FAILURE_LISTS.has(key)
        ? failureList(entry)
        : // A failure context holds through wrappers such as `data` below it.
          nestedFailuresAsStatus(entry, depth + 1, context || FAILURE_CONTEXTS.has(key)),
    ]),
  );
}

/** Account uids and session ids are bearer-like in combination with the key: keep them out of messages. */
export function redactPath(path: string): string {
  return path
    .split('?')[0]!
    .replace(/\/(accounts|sessions)\/[^/]+/g, '/$1/…')
    .replace(/\/transactions\/[^/]+/g, '/transactions/…');
}

const SECRET_PATTERNS = [
  /bearer\s+[A-Za-z0-9._-]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(code|state|session_id)=[^&\s]+/gi,
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, match => `${match.split(/[\s=]/)[0]} ‹redacted›`),
    value,
  );
}

export function formatUnknownError(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}
