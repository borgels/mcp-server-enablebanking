import { isIP } from 'node:net';
import { decodeHTML } from 'entities/decode';

/**
 * Redaction for the embedded gateway. Each gateway instance owns a redactor
 * holding its key material; each call forks it and adds the call's session id
 * (and, for the consent helpers, the authorization code). Nothing is added to
 * process-wide state, so one company's values never reach another call.
 *
 * Redaction is the second line: the gateway's own errors carry no text from
 * Enable Banking or a bank (see errors.ts). What it removes:
 * - every value added, however it is written: the text is searched as it is
 *   and in every reading (see readings): up to MAX_DECODE_DEPTH layers of
 *   encoding undone, each any mix of percent-encoding as UTF-8, JSON and
 *   JavaScript escapes and HTML character references (ESCAPE); each layer
 *   also normalised (NFKC, digits of any script, dashes), without the
 *   characters that are not seen, and with any run of separators (any
 *   Unicode whitespace or separator, the zero-width characters) as one space;
 * - an IP address and a location added as such, also in another spelling
 *   that says the same: an IPv6 address in upper case, written out in full
 *   or shortened differently, an IPv4 address as an IPv4-mapped IPv6
 *   address; a location as two numbers equal to its latitude and longitude,
 *   with any number of trailing zeros, a decimal point or a decimal comma,
 *   a minus or a dash, and a comma, a semicolon or separators between them,
 *   in every reading. They are matched whole: an address or a number inside
 *   a longer number or word is not one (standsWhole, COORDINATES), and two
 *   whole numbers ("1055,12", "55 12") are read as an amount or a number,
 *   not as a location. A location is only taken with decimals in both
 *   numbers (addLocation), and is found through COORDINATES alone, also in
 *   the form it was given in;
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
/** Layers of encoding undone when a text is searched for a value (a value encoded, that encoded again, ...). */
export const MAX_DECODE_DEPTH = 3;
/** A decoded or re-spaced form of a value shorter than this is not searched for: it would hit normal text. */
const MIN_EQUIVALENT_LENGTH = 6;
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

/** A text as it reads with a layer of encoding undone, and where each of its characters came from in the original. */
interface View {
  text: string;
  /** For character i of text: where its source starts in the original (inclusive) ... */
  from: Int32Array;
  /** ... and ends (exclusive). */
  to: Int32Array;
}

/**
 * One escaped character, in the ways a text passed through a URL, a form, JSON, JavaScript or HTML writes it:
 * - a percent-encoded UTF-8 sequence of one to four bytes, upper- or lower-case hex (%2C, %C2%A0, %E2%80%89), and
 *   JavaScript's %uXXXX;
 * - a JSON or JavaScript escape: \uXXXX, \u{X}, \xXX, a legacy octal escape (\040), \t, \n, \r, \f, \v, \b, and a
 *   quote, slash or backslash;
 * - an HTML character reference: every numeric one (decimal or hex, with or without the semicolon), and every named
 *   one of the HTML5 table, also those a browser reads without the semicolon. They are decoded by the `entities`
 *   package (the full WHATWG table; pinned in package.json) as a browser decodes text;
 * - "+" as a space, in the reading of a form.
 */
const ESCAPE = new RegExp(
  [
    '(%(?:[0-7][0-9a-fA-F]|[cdCD][0-9a-fA-F]%[89abAB][0-9a-fA-F]|[eE][0-9a-fA-F](?:%[89abAB][0-9a-fA-F]){2}|[fF][0-4](?:%[89abAB][0-9a-fA-F]){3}))',
    String.raw`\\u([0-9a-fA-F]{4})`,
    String.raw`\\x([0-9a-fA-F]{2})`,
    String.raw`\\(["'\\/])`,
    '(&(?:#[xX][0-9a-fA-F]{1,32}|#[0-9]{1,32}|[A-Za-z][A-Za-z0-9]{1,31});?)',
    String.raw`(\+)`,
    String.raw`\\([tnrfvb])`,
    // JavaScript's code point escape, the %u escape of JavaScript's escape(), and a legacy octal escape.
    String.raw`\\u\{([0-9a-fA-F]{1,6})\}`,
    '%u([0-9a-fA-F]{4})',
    String.raw`\\([0-3][0-7]{0,2}|[4-7][0-7]?)`,
  ].join('|'),
  'g',
);
/** A backslash escape of JSON or JavaScript for a control character: \t, \n, \r, \f, \v and \b. */
const CONTROL: Readonly<Record<string, string>> = { t: '\t', n: '\n', r: '\r', f: '\f', v: '\v', b: '\b' };
const UTF8 = new TextDecoder('utf-8', { fatal: true });
/**
 * A character that separates words or numbers: any Unicode whitespace or separator (\s, \p{Z}), the next-line
 * control U+0085, the Mongolian vowel separator U+180E, the zero-width characters U+200B-U+200D, U+2060 and U+FEFF,
 * and the characters that are drawn blank (the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0, the blank Braille
 * pattern U+2800).
 */
const SEPARATOR = String.raw`[\s\p{Z}\u0085\u115F\u1160\u180E\u200B-\u200D\u2060\u2800\u3164\uFEFF\uFFA0]`;
const SEPARATORS = new RegExp(`${SEPARATOR}+`, 'gu');
/** Characters that are not seen: format characters (zero-width, soft hyphen, direction marks) and combining marks. */
const INVISIBLE = /[\p{Cf}\p{Mn}\p{Me}]+/gu;
/** A character outside ASCII with the combining marks that follow it: what normalised works on. */
const NON_ASCII = /[^\x00-\x7F]\p{M}*/gu;
/** The dashes a minus may be written with. */
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu;
/** Other ways to write a decimal point, a comma and a semicolon that NFKC leaves as they are. */
const MARKS: Readonly<Record<string, string>> = {
  '\u00B7': '.',
  '\u066B': '.',
  '\u3002': '.',
  '\u060C': ',',
  '\u201A': ',',
  '\u3001': ',',
  '\u061B': ';',
};
const UNICODE_DIGIT = /\p{Nd}/u;
/** Whether a text can read differently decoded, normalised or re-spaced; one that cannot is compared as it is only. */
const MAY_DIFFER = /[%\\&+]|\s\s|[^\S ]|[^\x00-\x7F]/;

function unescaped(match: RegExpExecArray, plus: boolean): string | undefined {
  if (match[1] !== undefined) {
    const bytes = Uint8Array.from(match[1].slice(1).split('%'), hex => Number.parseInt(hex, 16));
    try {
      return UTF8.decode(bytes);
    } catch {
      // Not a UTF-8 sequence (an overlong form, a stray continuation byte): left as it is.
      return undefined;
    }
  }
  if (match[2] !== undefined) return String.fromCharCode(Number.parseInt(match[2], 16));
  if (match[3] !== undefined) return String.fromCharCode(Number.parseInt(match[3], 16));
  if (match[4] !== undefined) return match[4];
  if (match[5] !== undefined) return decodeHTML(match[5]);
  if (match[6] !== undefined) return plus ? ' ' : undefined;
  if (match[7] !== undefined) return CONTROL[match[7]];
  if (match[8] !== undefined) {
    const point = Number.parseInt(match[8], 16);
    return point <= 0x10ffff ? String.fromCodePoint(point) : undefined;
  }
  if (match[9] !== undefined) return String.fromCharCode(Number.parseInt(match[9], 16));
  if (match[10] !== undefined) return String.fromCharCode(Number.parseInt(match[10], 8));
  return undefined;
}

/** The value of a decimal digit of any script: its distance from the zero of its run of ten. */
function digitValue(point: number): number {
  let start = point;
  while (start > 0 && point - start < 100 && UNICODE_DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
  return (point - start) % 10;
}

/**
 * A character outside ASCII as it reads: NFKC (a fullwidth or other compatibility form becomes what it stands for:
 * "５" is "5", "，" is ","), a decimal digit of any script as its ASCII digit, any dash as a minus, and the other
 * points, commas and semicolons of MARKS as theirs.
 */
function normalised(cluster: string): string {
  let out = '';
  for (const char of cluster.normalize('NFKC')) {
    const point = char.codePointAt(0)!;
    if (point > 0x7f && UNICODE_DIGIT.test(char)) out += String(digitValue(point));
    else out += MARKS[char] ?? char;
  }
  return out.replace(DASHES, '-');
}

const isWordChar = (c: string | undefined) => c !== undefined && /[0-9A-Za-z]/.test(c);
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/**
 * Whether text[start, end) stands as a whole: an address or a location found there is not part of a longer number or
 * word. A letter or digit, or a decimal mark with a digit beyond it, right next to it makes it part of something else.
 */
function standsWhole(text: string, start: number, end: number): boolean {
  if (isWordChar(text[start])) {
    const before = text[start - 1];
    if (isWordChar(before) || ((before === '.' || before === ',') && isDigit(text[start - 2]))) return false;
  }
  if (isWordChar(text[end - 1])) {
    const after = text[end];
    if (isWordChar(after) || ((after === '.' || after === ',') && isDigit(text[end + 1]))) return false;
  }
  return true;
}

/** The text itself as a view: every character stands where it stands. */
function identity(text: string): View {
  const from = new Int32Array(text.length);
  const to = new Int32Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    from[i] = i;
    to[i] = i + 1;
  }
  return { text, from, to };
}

/** The view with every match of a pattern replaced; undefined when nothing changed. */
function rewritten(view: View, pattern: RegExp, replacement: (match: RegExpExecArray) => string | undefined): View | undefined {
  const from: number[] = [];
  const to: number[] = [];
  const parts: string[] = [];
  let last = 0;
  let changed = false;
  const copy = (start: number, end: number) => {
    for (let i = start; i < end; i += 1) {
      from.push(view.from[i]!);
      to.push(view.to[i]!);
    }
    parts.push(view.text.slice(start, end));
  };
  pattern.lastIndex = 0;
  for (let match = pattern.exec(view.text); match; match = pattern.exec(view.text)) {
    const value = replacement(match);
    if (value === undefined || value === match[0]) continue;
    const end = match.index + match[0].length;
    copy(last, match.index);
    // Every character the match became stands for the whole match in the original.
    for (let k = 0; k < value.length; k += 1) {
      from.push(view.from[match.index]!);
      to.push(view.to[end - 1]!);
    }
    parts.push(value);
    last = end;
    changed = true;
  }
  if (!changed) return undefined;
  copy(last, view.text.length);
  return { text: parts.join(''), from: Int32Array.from(from), to: Int32Array.from(to) };
}

/**
 * Every other way a text reads. The text and each layer of encoding undone (up to MAX_DECODE_DEPTH, "+" taken as
 * itself and as a space) is read
 * - as it is, and with every run of separators (SEPARATOR) as one space;
 * - normalised (NFKC, digits of any script as ASCII digits, any dash as a minus), and that re-spaced;
 * - normalised without the characters that are not seen (INVISIBLE), and that re-spaced.
 * The next layer is undone on the normalised reading, so an escape written in fullwidth characters is undone too.
 * The text itself is not among the readings.
 */
function readings(text: string, visit: (view: View) => void): void {
  if (!MAY_DIFFER.test(text)) return;
  const seen = new Set([text]);
  const see = (view: View | undefined) => {
    if (!view || seen.has(view.text)) return;
    seen.add(view.text);
    visit(view);
  };
  const respaced = (view: View) => rewritten(view, SEPARATORS, () => ' ');
  /** Sees the view and its other readings; returns the normalised one. */
  const variants = (view: View): View => {
    see(view);
    see(respaced(view));
    const normal = rewritten(view, NON_ASCII, match => normalised(match[0])) ?? view;
    see(normal);
    see(respaced(normal));
    const plain = rewritten(normal, INVISIBLE, () => '');
    if (plain) {
      see(plain);
      see(respaced(plain));
    }
    return normal;
  };
  const base = variants(identity(text));
  for (const plus of [false, true]) {
    let view = base;
    for (let depth = 0; depth < MAX_DECODE_DEPTH; depth += 1) {
      const next = rewritten(view, ESCAPE, match => unescaped(match, plus));
      if (!next) break;
      view = variants(next);
    }
  }
}

/** A stretch of the characters an IP address is written with. Whether it is one is decided by parsing it. */
const ADDRESS_TOKEN = /[0-9A-Fa-f:.]{3,}/g;
/**
 * A latitude or a longitude: a minus (ASCII or the Unicode minus sign), up to three digits, then a decimal point or
 * comma and any number of digits.
 */
const COORDINATE = String.raw`[-−]?\d{1,3}(?:[.,]\d+)?`;
/**
 * Two such numbers with a comma or a semicolon between them, or only separators (SEPARATOR: any whitespace, the
 * zero-width characters), as coordinates are written. Each is a whole number: not preceded by a digit (or a digit
 * and a decimal mark), not followed by a digit (or a decimal mark and a digit), so a coordinate is never found inside
 * an amount, a date or an account number.
 */
const COORDINATES = new RegExp(
  String.raw`(?<!\d|\d[.,])(${COORDINATE})(${SEPARATOR}{0,3}[,;]${SEPARATOR}{0,3}|${SEPARATOR}{1,3})(${COORDINATE})(?!\d|[.,]\d)`,
  'gu',
);
/** A location as the gateway admits it: latitude and longitude, each with a decimal point and at least one decimal. */
const LOCATION = /^-?\d{1,3}\.\d{1,20},-?\d{1,3}\.\d{1,20}$/;

/** The latitude and longitude two matched numbers say; undefined when they are better read as something else. */
function coordinates(match: RegExpExecArray): [number, number] | undefined {
  const [, first, , second] = match as unknown as [string, string, string, string];
  // Two whole numbers are an amount ("1055,12"), a date or an account number far more often than a location.
  if (/^[-−]?\d+$/.test(first) && /^[-−]?\d+$/.test(second)) return undefined;
  const number = (written: string) => Number(written.replace(',', '.').replace('−', '-'));
  return [number(first), number(second)];
}

/**
 * What an IP address says, whatever its spelling: its 16 bytes as 32 hex
 * digits, an IPv4 address as its IPv4-mapped IPv6 address. Undefined for a
 * text that is not an address.
 */
export function addressKey(text: string): string | undefined {
  const kind = isIP(text);
  const pair = (high: string, low: string) => ((Number(high) << 8) | Number(low)).toString(16);
  if (kind === 4) {
    const [a, b, c, d] = text.split('.') as [string, string, string, string];
    return `${'0'.repeat(20)}ffff${pair(a, b).padStart(4, '0')}${pair(c, d).padStart(4, '0')}`;
  }
  if (kind !== 6) return undefined;
  let written = text;
  if (written.includes('.')) {
    // The last 32 bits written as an IPv4 address.
    const at = written.lastIndexOf(':');
    const [a, b, c, d] = written.slice(at + 1).split('.') as [string, string, string, string];
    written = `${written.slice(0, at + 1)}${pair(a, b)}:${pair(c, d)}`;
  }
  const [head, tail] = written.split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...new Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return groups.length === 8 ? groups.map(group => group.padStart(4, '0').toLowerCase()).join('') : undefined;
}

/** The address a token is, with what stands around it (a full stop, a colon before a port) cut off. */
function tokenAddress(token: string): { key: string; start: number; end: number } | undefined {
  let start = 0;
  let end = token.length;
  for (let attempt = 0; attempt < 6 && end - start >= 2; attempt += 1) {
    const key = addressKey(token.slice(start, end));
    if (key) return { key, start, end };
    const last = token[end - 1];
    if (last === '.' || (last === ':' && token[end - 2] !== ':')) end -= 1;
    else if (token[start] === '.' || (token[start] === ':' && token[start + 1] !== ':')) start += 1;
    else return undefined;
  }
  return undefined;
}

export class GatewayRedactor {
  /** IP addresses, by what they say (addressKey). */
  private readonly addresses = new Set<string>();
  /** Locations, as latitude and longitude. */
  private readonly locations: Array<[number, number]> = [];
  /** The values, each with whether it is found only where it stands whole (an address or a location: standsWhole). */
  private readonly values = new Map<string, boolean>();
  /** The values and every other way each of them reads, longest first; built when first needed. */
  private searched: Searched[] | undefined;
  private readonly fragments = new Set<string>();
  /** Pieces the sink check looks for: of the key content and of the call's session id, in every form. */
  private readonly watched = new Set<string>();

  /** Adds a value, matched whole however it is written (see the top of this file). Short or empty values are ignored. */
  add(value: string | undefined): void {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) return;
    for (const form of forms(value)) this.remember(form);
  }

  /**
   * Adds a value whose shape the caller has checked (an IP address, a geolocation): matched whole like add, however
   * it is written, but whatever its length. Not for free text: a short word added here would be removed from every
   * text it occurs in.
   */
  addExact(value: string | undefined): void {
    if (typeof value !== 'string' || value === '') return;
    // An address or a location is a number of a kind: it is found where it stands whole, not inside a longer number.
    for (const form of forms(value)) this.keep(form, true);
  }

  /** Adds an IP address: as addExact, and in every other spelling that says the same address. */
  addAddress(value: string | undefined): void {
    this.addExact(value);
    const key = typeof value === 'string' ? addressKey(value) : undefined;
    if (key) this.addresses.add(key);
  }

  /**
   * Adds a location: "latitude,longitude", each with decimals, as the gateway admits it (PSU-Geo-Location). It is
   * found as two numbers equal to its latitude and longitude that stand whole (COORDINATES), however they are
   * written, the form it was given in included: one matcher, so every form has the same whole-number boundaries.
   * A position without decimals ("55,12") is not taken: it says no more than an area of about a hundred kilometres
   * and is written exactly as a Danish amount, so it is not looked for in bank text.
   */
  addLocation(value: string | undefined): void {
    if (typeof value !== 'string' || !LOCATION.test(value)) return;
    const [latitude, longitude] = value.split(',').map(Number) as [number, number];
    this.locations.push([latitude, longitude]);
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
    for (const [value, whole] of this.values) copy.keep(value, whole);
    for (const address of this.addresses) copy.addresses.add(address);
    for (const location of this.locations) copy.locations.push(location);
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
    const searched = this.everyForm();
    for (const { value, whole } of searched) {
      result = whole ? replaceWhole(result, value) : result.split(value).join('‹redacted›');
    }
    // Then the text as it reads decoded and re-spaced: what a value covers there is removed from the text itself.
    result = this.redactReadings(result, searched);
    return this.fragments.size === 0 ? result : this.redactFragments(result);
  }

  /** The values held, and every other way each of them reads (decoded, re-spaced), longest first. */
  private everyForm(): Searched[] {
    if (this.searched) return this.searched;
    // A form that is also the form of a value found anywhere is found anywhere.
    const all = new Map<string, boolean>();
    const add = (form: string, whole: boolean) => all.set(form, (all.get(form) ?? true) && whole);
    for (const [value, whole] of this.values) add(value, whole);
    for (const [value, whole] of this.values) {
      readings(value, view => {
        if (view.text.length >= MIN_EQUIVALENT_LENGTH && view.text.trim() !== '') add(view.text, whole);
      });
    }
    this.searched = [...all].map(([value, whole]) => ({ value, whole })).sort((a, b) => b.value.length - a.value.length);
    return this.searched;
  }

  /**
   * Removes from a text every stretch that reads as a held value once the text is decoded or re-spaced, and every
   * stretch that says a held address or location in another spelling, in the text as it is and as it reads decoded.
   */
  private redactReadings(text: string, searched: Searched[]): string {
    const meanings = this.addresses.size > 0 || this.locations.length > 0;
    if (searched.length === 0 && !meanings) return text;
    const spans: Array<[number, number]> = [];
    const meant = (view: View) => {
      if (this.addresses.size > 0) {
        ADDRESS_TOKEN.lastIndex = 0;
        for (let match = ADDRESS_TOKEN.exec(view.text); match; match = ADDRESS_TOKEN.exec(view.text)) {
          const found = match[0].includes(':') ? tokenAddress(match[0]) : undefined;
          if (found && this.addresses.has(found.key)) spans.push([view.from[match.index + found.start]!, view.to[match.index + found.end - 1]!]);
        }
      }
      if (this.locations.length > 0) {
        COORDINATES.lastIndex = 0;
        for (let match = COORDINATES.exec(view.text); match; match = COORDINATES.exec(view.text)) {
          const said = coordinates(match);
          if (said && this.locations.some(([a, b]) => a === said[0] && b === said[1])) {
            spans.push([view.from[match.index]!, view.to[match.index + match[0].length - 1]!]);
          } else {
            // Not this pair: its second number may be the first of the next one ("12 55.6761 12.5683").
            COORDINATES.lastIndex = match.index + 1;
          }
        }
      }
    };
    if (meanings) meant(identity(text));
    readings(text, view => {
      for (const { value, whole } of searched) {
        for (let at = view.text.indexOf(value); at !== -1; at = view.text.indexOf(value, at + (whole ? 1 : value.length))) {
          if (whole && !standsWhole(view.text, at, at + value.length)) continue;
          spans.push([view.from[at]!, view.to[at + value.length - 1]!]);
        }
      }
      if (meanings) meant(view);
    });
    if (spans.length === 0) return text;
    spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    let out = '';
    let last = 0;
    for (const [start, end] of spans) {
      if (end <= last) continue;
      // A stretch that overlaps the one before it is part of the same removal.
      if (start >= last) out += `${text.slice(last, start)}‹redacted›`;
      last = end;
    }
    return out + text.slice(last);
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
    this.keep(value, false);
  }

  /** Holds a value; one held both ways is found anywhere. */
  private keep(value: string, whole: boolean): void {
    this.searched = undefined;
    const anywhere = this.values.get(value) === false || !whole;
    this.values.delete(value);
    this.values.set(value, !anywhere);
    while (this.values.size > MAX_REDACTED_VALUES) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }
}

/** A form searched for, and whether it is found only where it stands whole. */
interface Searched {
  value: string;
  whole: boolean;
}

/** The text with every place where the value stands whole replaced by the marker. */
function replaceWhole(text: string, value: string): string {
  let out = '';
  let last = 0;
  for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
    if (at < last || !standsWhole(text, at, at + value.length)) continue;
    out += `${text.slice(last, at)}‹redacted›`;
    last = at + value.length;
  }
  return out + text.slice(last);
}

/** The value as it may appear: raw, URL-encoded and escaped inside a JSON string. */
function forms(value: string): string[] {
  return [...new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])];
}
