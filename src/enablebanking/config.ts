import { COMPANY_CODE } from './registry.js';

/**
 * Everything that decides WHICH company and WHICH bank data this instance can
 * reach is read from the environment, never from a tool argument. One
 * container serves one company.
 */
export interface EnableBankingConfig {
  /** Company code this instance is pinned to (a key under `companies` in the account registry). */
  company: string;
  applicationId: string;
  privateKeyPath: string;
  accountsPath: string;
  dataDir: string;
  /** 32-byte key (hex or base64) for the session store and the consent state. */
  encryptionKey?: string;
  redirectUrl?: string;
  /**
   * Serve the bank's redirect at the path of redirectUrl and complete the
   * consent right there, instead of the admin pasting the address into
   * enablebanking_complete_consent.
   */
  consentCallback: boolean;
  /** Where the confirmation page's button leads (e.g. the chat client). */
  returnUrl?: string;
  consentEnabled: boolean;
  /** Optional UPN allowlist for consent tools, on top of the gateway duty group. */
  consentAdmins: string[];
  trustForwardedUser: boolean;
  cacheSeconds: number;
  apiBaseUrl: string;
  timeoutMs: number;
  auditLog?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EnableBankingConfig {
  const company = (env.ENABLEBANKING_COMPANY ?? '').trim().toLowerCase();
  if (!COMPANY_CODE.test(company)) {
    throw new Error('ENABLEBANKING_COMPANY must be set to the company code this instance serves (e.g. aaa)');
  }
  const apiBaseUrl = (env.ENABLEBANKING_API_BASE_URL ?? 'https://api.enablebanking.com').replace(/\/+$/, '');
  if (!apiBaseUrl.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiBaseUrl)) {
    throw new Error('ENABLEBANKING_API_BASE_URL must be https');
  }
  return {
    company,
    applicationId: (env.ENABLEBANKING_APPLICATION_ID ?? '').trim(),
    privateKeyPath: env.ENABLEBANKING_PRIVATE_KEY_PATH ?? '/secrets/enablebanking.pem',
    accountsPath: env.ENABLEBANKING_ACCOUNTS_PATH ?? '/config/accounts.json',
    dataDir: env.ENABLEBANKING_DATA_DIR ?? '/data',
    encryptionKey: env.ENABLEBANKING_ENCRYPTION_KEY?.trim() || undefined,
    redirectUrl: env.ENABLEBANKING_REDIRECT_URL?.trim() || undefined,
    consentCallback: env.ENABLEBANKING_CONSENT_CALLBACK === 'true',
    returnUrl: httpsOrUndefined(env.ENABLEBANKING_RETURN_URL, 'ENABLEBANKING_RETURN_URL'),
    consentEnabled: env.ENABLEBANKING_ENABLE_CONSENT === 'true',
    consentAdmins: (env.ENABLEBANKING_CONSENT_ADMINS ?? '')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean),
    trustForwardedUser: env.ENABLEBANKING_TRUST_FORWARDED_USER === 'true',
    cacheSeconds: clampInt(env.ENABLEBANKING_CACHE_SECONDS, 300, 0, 86_400),
    apiBaseUrl,
    timeoutMs: clampInt(env.ENABLEBANKING_TIMEOUT_MS, 30_000, 1_000, 120_000),
    auditLog: env.ENABLEBANKING_AUDIT_LOG?.trim() || undefined,
  };
}

function httpsOrUndefined(value: string | undefined, name: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith('https://')) throw new Error(`${name} must be https`);
  return trimmed;
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!value || !Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
