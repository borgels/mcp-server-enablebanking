/** Non-2xx answer from the Enable Banking API. */
export class EnableBankingHttpError extends Error {
  readonly status: number;
  readonly path: string;
  readonly code?: string;

  constructor(init: { status: number; method: string; path: string; payload?: unknown }) {
    const payload = (typeof init.payload === 'object' && init.payload !== null ? init.payload : {}) as Record<string, unknown>;
    const code = typeof payload.error === 'string' ? payload.error : typeof payload.code === 'string' ? payload.code : undefined;
    const message = [payload.message, payload.detail]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .map(part => redactSecrets(part))
      .join(' — ');
    super(
      `Enable Banking ${init.method} ${redactPath(init.path)} failed with HTTP ${init.status}` +
        (code ? ` (${code})` : '') +
        (message ? `: ${message}` : ''),
    );
    this.name = 'EnableBankingHttpError';
    this.status = init.status;
    this.path = redactPath(init.path);
    this.code = code;
  }

  /** The bank or Enable Banking no longer honours the consent behind this call. */
  get consentLost(): boolean {
    return (
      this.status === 401 ||
      this.status === 403 ||
      /EXPIRED_SESSION|CLOSED_SESSION|REVOKED_SESSION|SESSION_DOES_NOT_EXIST|ACCOUNT_DOES_NOT_EXIST/i.test(this.code ?? '')
    );
  }
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
    (current, pattern) => current.replace(pattern, match => `${match.split(/[\s=]/)[0]} [REDACTED]`),
    value,
  );
}

export function formatUnknownError(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}
