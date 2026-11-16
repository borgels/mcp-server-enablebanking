import type { IncomingMessage } from 'node:http';
import { ConfigError } from '../config-env.js';
import { loadConfig } from '../enablebanking/config.js';
import { createBank, createServer as createMcpServer } from '../server.js';
import { consentCallbackPath, handleConsentCallback } from './consent-page.js';
import { configWarnings, getHttpConfig, type HttpConfig, HttpRequestError } from './http-helpers.js';
import { httpBankConfig } from './http-policy.js';
import { startHttpServer } from './http-server.js';

const NOT_STARTED = 'Enable Banking MCP HTTP server not started';

async function main(): Promise<void> {
  let config: HttpConfig;
  try {
    config = getHttpConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`${NOT_STARTED}: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  let bankConfig: ReturnType<typeof httpBankConfig>['config'];
  let bank: ReturnType<typeof createBank>;
  try {
    const { config: effective, warnings } = httpBankConfig(loadConfig(), config);
    for (const warning of warnings) console.error(`WARNING: ${warning}`);
    bankConfig = effective;
    // Built once, at startup: a bad registry, key or store fails the container
    // immediately instead of on the first user's call.
    bank = createBank(bankConfig);
  } catch (error) {
    console.error(`${NOT_STARTED}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  for (const warning of configWarnings(config)) {
    console.error(warning);
  }

  const callbackPath = consentCallbackPath(bankConfig);
  const defaultUser = process.env.ENABLEBANKING_DEFAULT_USER ?? 'local';

  const running = await startHttpServer(config, {
    healthPayload: () => ({ ok: true, company: bank.company, consent: bankConfig.consentEnabled }),
    // The bank's redirect (through the user's browser): no proxy identity, no
    // token. The signed, single-use state is what authorises it.
    extraRoute: async (req, res, path) => {
      if (!callbackPath || req.method !== 'GET' || path !== callbackPath) {
        return false;
      }
      await handleConsentCallback(bank, bankConfig, req.url ?? path, res);
      return true;
    },
    createMcpServer: (req: IncomingMessage) => {
      // With ENABLEBANKING_TRUST_FORWARDED_USER=true an authenticating proxy
      // in front forwards the verified user as X-MCP-User (never the client's
      // own header). Bank data without a named reader is not served.
      const forwarded = bankConfig.trustForwardedUser ? firstHeaderValue(req.headers['x-mcp-user']) : undefined;
      if (bankConfig.trustForwardedUser && !forwarded) {
        throw new HttpRequestError(401, 'Missing X-MCP-User from the gateway');
      }
      return createMcpServer({ bank, config: bankConfig, actingAs: forwarded ?? defaultUser });
    },
  });
  console.error(
    `Enable Banking MCP (${bank.company}) listening on http://${config.host}:${running.port}/mcp` +
      (callbackPath ? ` (consent callback on ${callbackPath})` : ''),
  );

  const shutdown = (signal: string) => {
    console.error(`Received ${signal}, shutting down`);
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
