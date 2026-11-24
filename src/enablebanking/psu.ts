import { isIP } from 'node:net';

/**
 * The person behind a fetch, as the Enable Banking API takes it: the `Psu-*`
 * request headers on the account data endpoints. A fetch with them is one a
 * person asked for just now; a fetch without them is a background fetch,
 * which many banks allow about four times a day (PSD2).
 *
 * These are facts about a real person's request, observed by the host. They
 * are never invented here: without them a fetch is sent as a background one.
 */
export interface PsuPresence {
  /** The person's IP address (IPv4 or IPv6) as the host saw it. */
  ipAddress?: string;
  /** The User-Agent of the person's browser or app. */
  userAgent?: string;
  referer?: string;
  accept?: string;
  acceptCharset?: string;
  acceptEncoding?: string;
  acceptLanguage?: string;
  /** "latitude,longitude", as in the API reference. */
  geoLocation?: string;
}

/** The request header of each field. */
export const PSU_HEADER_NAMES: Readonly<Record<keyof PsuPresence, string>> = Object.freeze({
  ipAddress: 'Psu-Ip-Address',
  userAgent: 'Psu-User-Agent',
  referer: 'Psu-Referer',
  accept: 'Psu-Accept',
  acceptCharset: 'Psu-Accept-Charset',
  acceptEncoding: 'Psu-Accept-Encoding',
  acceptLanguage: 'Psu-Accept-Language',
  geoLocation: 'Psu-Geo-Location',
});

export const PSU_REFUSED =
  'Refused: the details of the person present are malformed (an IP address, and header values of printable characters, are expected).';

/** A header value: printable ASCII and spaces, so no line break can add a header. */
const HEADER_VALUE = /^[\x20-\x7E]{1,512}$/;
const GEO_LOCATION = /^-?\d{1,2}\.\d{1,6},-?\d{1,3}\.\d{1,6}$/;

export type PsuHeaders = { ok: true; headers: Record<string, string> } | { ok: false };

/**
 * The `Psu-*` headers of a person present. At least one field must be given
 * and every given field must be well formed; otherwise nothing is sent and
 * the call is refused, so a host's mistake never turns into a background
 * fetch that counts against the bank's daily limit.
 */
export function psuHeaders(psu: unknown): PsuHeaders {
  if (psu === null || typeof psu !== 'object' || Array.isArray(psu)) return { ok: false };
  const headers: Record<string, string> = {};
  for (const [field, value] of Object.entries(psu as Record<string, unknown>)) {
    if (value === undefined) continue;
    const name = Object.hasOwn(PSU_HEADER_NAMES, field) ? PSU_HEADER_NAMES[field as keyof PsuPresence] : undefined;
    if (!name || typeof value !== 'string') return { ok: false };
    const trimmed = value.trim();
    if (!HEADER_VALUE.test(trimmed)) return { ok: false };
    if (field === 'ipAddress' && isIP(trimmed) === 0) return { ok: false };
    if (field === 'geoLocation' && !GEO_LOCATION.test(trimmed)) return { ok: false };
    headers[name] = trimmed;
  }
  return Object.keys(headers).length > 0 ? { ok: true, headers } : { ok: false };
}
