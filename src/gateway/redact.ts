/**
 * Redaction for the embedded gateway. Each gateway instance owns a redactor
 * holding its key material; each call forks it and adds the call's session id
 * (and, for the consent helpers, the authorization code). Nothing is added to
 * process-wide state, so one company's values never reach another call.
 */

/** Values shorter than this are not redacted by value (too likely to hit normal text). */
const MIN_SECRET_LENGTH = 8;
/** Upper bound on values held by one redactor; the oldest are dropped first. */
export const MAX_REDACTED_VALUES = 64;
/** Longest error message the gateway returns. */
export const MAX_ERROR_MESSAGE_LENGTH = 500;

const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED KEY]'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  // A signed JWT, wherever it appears.
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '[REDACTED JWT]'],
  [/\b(code|state|session_id|sessionId|continuation_key)(["']?\s*[=:]\s*["']?)[^&\s"',}]+/gi, '$1$2[REDACTED]'],
  // Session ids and account uids at Enable Banking are UUIDs.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[REDACTED ID]'],
];

export class GatewayRedactor {
  private readonly values = new Set<string>();

  /** Adds a value (and its URL-encoded form). Short or empty values are ignored. */
  add(value: string | undefined): void {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) return;
    this.remember(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) this.remember(encoded);
  }

  /** A new redactor with the same values; adding to the fork does not change this one. */
  fork(): GatewayRedactor {
    const copy = new GatewayRedactor();
    for (const value of this.values) copy.remember(value);
    return copy;
  }

  get size(): number {
    return this.values.size;
  }

  redact(text: string): string {
    let result = text;
    // Longest first, so a value containing another is removed whole.
    for (const value of [...this.values].sort((a, b) => b.length - a.length)) {
      result = result.split(value).join('[REDACTED]');
    }
    for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
    return result;
  }

  /** The message of an error (or any thrown value), redacted and then shortened. */
  message(error: unknown): string {
    const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
    const redacted = this.redact(raw);
    return redacted.length > MAX_ERROR_MESSAGE_LENGTH
      ? `${redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH)}... [truncated]`
      : redacted;
  }

  private remember(value: string): void {
    if (value.length < MIN_SECRET_LENGTH) return;
    this.values.delete(value);
    this.values.add(value);
    while (this.values.size > MAX_REDACTED_VALUES) {
      const oldest = this.values.values().next().value;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }
}
