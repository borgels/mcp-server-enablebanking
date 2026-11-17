/**
 * Redaction for the embedded gateway. Each gateway instance owns a redactor
 * holding its key material; each call forks it and adds the call's session id
 * (and, for the consent helpers, the authorization code). Nothing is added to
 * process-wide state, so one company's values never reach another call.
 *
 * Redaction is the second line: the gateway's own errors carry no text from
 * Enable Banking or a bank (see errors.ts). What it removes:
 * - every value added: exactly, URL-encoded and JSON-escaped;
 * - for the key material, also every piece of it of FRAGMENT_LENGTH
 *   characters, so a part of the key is not left after a cut or an echo.
 *   Session ids and authorization codes are matched whole: a session id is a
 *   UUID like the account ids the results must keep.
 * Errors also pass through the patterns below. Results are redacted as
 * values (redactDeep), before they are serialised.
 */

/**
 * What a redacted value is replaced by. Its brackets are not ASCII, so it cannot be a piece of the key's base64
 * content or of a session id; a key whose content shares a FRAGMENT_LENGTH piece with any text of ours is refused (src/key-admission.ts).
 */
export const REDACTION_MARKER = '‹redacted›';

/** Whether a secret could survive its own redaction: it contains the marker, or shares a piece with it. */
export function overlapsMarker(value: string): boolean {
  if (value.includes(REDACTION_MARKER)) return true;
  for (let i = 0; i + 6 <= REDACTION_MARKER.length; i += 1) {
    if (value.includes(REDACTION_MARKER.slice(i, i + 6))) return true;
  }
  return false;
}

/** Values shorter than this are not redacted by value (too likely to hit normal text). */
export const MIN_SECRET_LENGTH = 8;
/** Pieces of the key material this long or longer are redacted wherever they appear. */
export const FRAGMENT_LENGTH = 6;
/** Values nested deeper than this are replaced by redactDeep, never passed on. */
export const MAX_REDACT_DEPTH = 64;
/** Upper bound on values held by one redactor; the oldest are dropped first. */
export const MAX_REDACTED_VALUES = 64;
/** Longest error message the gateway returns. */
export const MAX_ERROR_MESSAGE_LENGTH = 500;

const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '‹redacted›'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ‹redacted›'],
  // A signed JWT, wherever it appears.
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '‹redacted›'],
  [/\b(code|state|session_id|sessionId|continuation_key)(["']?\s*[=:]\s*["']?)[^&\s"',}]+/gi, '$1$2‹redacted›'],
  // Session ids and account uids at Enable Banking are UUIDs.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '‹redacted›'],
];

export class GatewayRedactor {
  private readonly values = new Set<string>();
  private readonly fragments = new Set<string>();
  /** Pieces the sink check looks for: of the key content and of the call's session id, in every form. */
  private readonly watched = new Set<string>();

  /** Adds a value (and its URL-encoded and JSON-escaped forms), matched whole. Short or empty values are ignored. */
  add(value: string | undefined): void {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) return;
    for (const form of forms(value)) this.remember(form);
  }

  /**
   * Adds key material: the value as with add, and its content without
   * PEM armour and whitespace, with every piece of FRAGMENT_LENGTH characters.
   */
  addKey(value: string): void {
    this.add(value);
    const content = value.replace(/-----(BEGIN|END) [A-Z ]*-----/g, '').replace(/\s+/g, '');
    this.add(content);
    for (let i = 0; i + FRAGMENT_LENGTH <= content.length; i += 1) this.fragments.add(content.slice(i, i + FRAGMENT_LENGTH));
    this.watch(content);
  }

  /**
   * Adds a secret to the sink check only (`matches`): every piece of it, in
   * every form, makes an output withheld. Redaction is not changed, so a
   * session id is still matched whole there and account ids stay.
   */
  watch(value: string | undefined): void {
    if (typeof value !== 'string') return;
    for (const form of forms(value)) {
      for (let i = 0; i + FRAGMENT_LENGTH <= form.length; i += 1) this.watched.add(form.slice(i, i + FRAGMENT_LENGTH));
    }
  }

  /** Whether a text holds a piece of the key content or of a watched session id (the sink check). */
  matches(text: string): boolean {
    for (let i = 0; i + FRAGMENT_LENGTH <= text.length; i += 1) {
      if (this.watched.has(text.slice(i, i + FRAGMENT_LENGTH))) return true;
    }
    return false;
  }

  /** A new redactor with the same values; adding to the fork does not change this one. */
  fork(): GatewayRedactor {
    const copy = new GatewayRedactor();
    for (const value of this.values) copy.remember(value);
    for (const fragment of this.fragments) copy.fragments.add(fragment);
    for (const piece of this.watched) copy.watched.add(piece);
    return copy;
  }

  get size(): number {
    return this.values.size;
  }

  /** The values and the pieces of the key removed; no patterns. For results, which keep their account ids. */
  redactValues(text: string): string {
    let result = text;
    // Longest first, so a value containing another is removed whole.
    for (const value of [...this.values].sort((a, b) => b.length - a.length)) {
      result = result.split(value).join('‹redacted›');
    }
    return this.fragments.size === 0 ? result : this.redactFragments(result);
  }

  /** The values, the pieces of the key and the credential patterns removed. For errors. */
  redact(text: string): string {
    let result = this.redactValues(text);
    for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
    return result;
  }

  /**
   * Copy of a JSON-like value with every string, object keys included, passed
   * through redactValues, and every number or boolean whose string form would
   * be redacted replaced by the string "‹redacted›". Anything nested deeper
   * than MAX_REDACT_DEPTH is replaced, never passed on.
   */
  redactDeep(value: unknown, depth = 0): unknown {
    if (depth > MAX_REDACT_DEPTH) return '[nested too deep]';
    if (typeof value === 'string') return this.redactValues(value);
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      // The string form of a primitive is checked too; a match becomes the string "‹redacted›", so JSON stays valid.
      const text = String(value);
      if (this.redactValues(text) !== text) return '‹redacted›';
      return typeof value === 'bigint' ? text : value;
    }
    if (typeof value !== 'object' || value === null) return value;
    const json = (value as { toJSON?: unknown }).toJSON;
    if (typeof json === 'function') return this.redactDeep(json.call(value), depth + 1);
    if (Array.isArray(value)) return value.map(entry => this.redactDeep(entry, depth + 1));
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [this.redactValues(key), this.redactDeep(entry, depth + 1)]),
    );
  }

  /** The message of an error (or any thrown value), redacted and then shortened. */
  message(error: unknown): string {
    const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
    const redacted = this.redact(raw);
    const assembled =
      redacted.length > MAX_ERROR_MESSAGE_LENGTH ? `${redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH)}... [truncated]` : redacted;
    // The final pass, over the whole message as it leaves.
    return this.redactValues(assembled);
  }

  /** Every run of text covered by a piece of the key becomes one ‹redacted›. */
  private redactFragments(text: string): string {
    const covered = new Uint8Array(text.length);
    let any = false;
    for (let i = 0; i + FRAGMENT_LENGTH <= text.length; i += 1) {
      if (this.fragments.has(text.slice(i, i + FRAGMENT_LENGTH))) {
        covered.fill(1, i, i + FRAGMENT_LENGTH);
        any = true;
      }
    }
    if (!any) return text;
    let out = '';
    for (let i = 0; i < text.length; i += 1) {
      if (!covered[i]) out += text[i];
      else if (i === 0 || !covered[i - 1]) out += '‹redacted›';
    }
    return out;
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

/** The value as it may appear: raw, URL-encoded and escaped inside a JSON string. */
function forms(value: string): string[] {
  return [...new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])];
}
