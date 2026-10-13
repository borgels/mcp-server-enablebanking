import type { EnableBankingConfig } from '../enablebanking/config.js';
import { assertForwardedUserRequiresToken, type HttpConfig } from './http-helpers.js';

/**
 * Effective configuration for the HTTP transport.
 *
 * - With ENABLEBANKING_TRUST_FORWARDED_USER=true the server refuses to start
 *   unless MCP_HTTP_TOKEN is set (otherwise any client could claim any user).
 * - Without the trust flag every HTTP caller acts as the same static default
 *   user, so the consent-admin tools (and the consent callback) are disabled
 *   over HTTP regardless of ENABLEBANKING_ENABLE_CONSENT: who manages bank
 *   consents must come from the gateway, not from a default. stdio keeps the
 *   configured behaviour.
 */
export function httpBankConfig(
  bankConfig: EnableBankingConfig,
  httpConfig: Pick<HttpConfig, 'httpToken'>,
  env: NodeJS.ProcessEnv = process.env,
): { config: EnableBankingConfig; warnings: string[] } {
  assertForwardedUserRequiresToken(['ENABLEBANKING_TRUST_FORWARDED_USER'], httpConfig, env);
  const warnings: string[] = [];
  if (bankConfig.consentEnabled && !bankConfig.trustForwardedUser) {
    warnings.push(
      'ENABLEBANKING_ENABLE_CONSENT=true is ignored over HTTP without ENABLEBANKING_TRUST_FORWARDED_USER=true: ' +
        'consent tools need a gateway-verified user.',
    );
    return { config: { ...bankConfig, consentEnabled: false }, warnings };
  }
  return { config: bankConfig, warnings };
}
