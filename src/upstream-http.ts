/**
 * Helpers for calls to the upstream API: redirects are never followed (so
 * credentials are not re-sent to another location), error bodies are read up
 * to a fixed size, and URLs in error messages carry no query string.
 */

/** Error bodies are read up to this many bytes; the rest is discarded. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** Maximum length of any single piece of upstream text placed in an error message. */
export const MAX_ERROR_TEXT = 500;

/** Configured secrets shorter than this are not redacted by value (too likely to hit normal text). */
const MIN_SECRET_LENGTH = 8;

const registeredSecrets = new Set<string>();

/** Redact this exact value (and its URL-encoded form) wherever it appears in error text. */
export function registerSecret(value: string | undefined): void {
  if (!value || value.length < MIN_SECRET_LENGTH) {
    return;
  }
  registeredSecrets.add(value);
  const encoded = encodeURIComponent(value);
  if (encoded !== value) {
    registeredSecrets.add(encoded);
  }
}

/** Replaces every registered secret value with [REDACTED]. */
export function redactRegisteredSecrets(value: string): string {
  let result = value;
  for (const secret of registeredSecrets) {
    result = result.split(secret).join('[REDACTED]');
  }
  return result;
}

export function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** Origin and path of a URL, without query string or fragment. */
export function describeUrl(url: string | URL): string {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

/** Shortens text to `max` characters. Redact before truncating, so a secret is never cut in half. */
export function truncate(value: string, max: number = MAX_ERROR_TEXT): string {
  return value.length > max ? `${value.slice(0, max)}... [truncated]` : value;
}

/** Message for a refused redirect; the Location is shown without its query string. */
export function redirectRefusedMessage(
  service: string,
  response: Response,
  method: string,
  url: string,
): string {
  const location = response.headers.get('location');
  let target: string | undefined;
  if (location) {
    try {
      target = describeUrl(new URL(location, url));
    } catch {
      target = undefined;
    }
  }
  const where = target ? ` to ${target}` : '';
  return redactRegisteredSecrets(
    `${service} responded with a redirect (HTTP ${response.status})${where} for ${method} ${describeUrl(url)}; ` +
      'redirects are not followed. Check the configured base URL.',
  );
}

export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

/** Reads at most `limit` bytes of the body as UTF-8 text. */
export async function readTextUpTo(
  response: Response,
  limit: number,
): Promise<{ text: string; exceeded: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { text: '', exceeded: false };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      exceeded = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), exceeded };
}

/**
 * Reads an error response body up to MAX_ERROR_BODY_BYTES, only to find a
 * documented error code in it. JSON is parsed only when the body is complete.
 * An empty body, or one over the limit, gives null: nothing of it is kept.
 */
export async function readErrorBody(response: Response): Promise<unknown> {
  const { text, exceeded } = await readTextUpTo(response, MAX_ERROR_BODY_BYTES);
  if (!text || exceeded) {
    return null;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!exceeded && contentType.includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}
