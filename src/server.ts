import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Bank } from './enablebanking/bank.js';
import { EnableBankingClient } from './enablebanking/client.js';
import { loadConfig, type EnableBankingConfig } from './enablebanking/config.js';
import { AccountRegistry } from './enablebanking/registry.js';
import { parseKey, SessionStore } from './enablebanking/store.js';
import { registerTools } from './tools/enablebanking.js';

export const VERSION = '0.1.0';

/** One Bank per process: it holds the read cache, and the config never changes at runtime. */
export function createBank(config: EnableBankingConfig = loadConfig(), client?: EnableBankingClient): Bank {
  return new Bank({
    company: config.company,
    client:
      client ??
      EnableBankingClient.fromKeyFile({
        applicationId: config.applicationId,
        privateKeyPath: config.privateKeyPath,
        baseUrl: config.apiBaseUrl,
        timeoutMs: config.timeoutMs,
      }),
    registry: AccountRegistry.fromFile(config.accountsPath),
    store: new SessionStore(config.company, config.dataDir, parseKey(config.encryptionKey)),
    redirectUrl: config.redirectUrl,
    cacheSeconds: config.cacheSeconds,
  });
}

export function createServer(options: { bank: Bank; config: EnableBankingConfig; actingAs: string }): McpServer {
  const company = options.bank.companyInfo();
  const server = new McpServer(
    { name: 'mcp-server-enablebanking', version: VERSION },
    {
      instructions: `Bank accounts of ${company.name} (CVR ${company.cvr}), read through Enable Banking (PSD2). Read-only: nothing here can pay or move money.

This server acts for ${company.name} only. Which accounts belong to the company is decided by a reviewed registry on the server, not by the bank consent and not by tool arguments; other companies' accounts are not readable here even when they appear in the same bank login. Start with enablebanking_list_accounts.

Amounts are decimal strings in the account currency; negative means money left the account. Banks may limit how often an account can be read without the account holder present, so results are cached for a few minutes; ask for the period you need in one call rather than many small ones.`,
    },
  );
  registerTools(server, options.bank, {
    actingAs: options.actingAs,
    consentEnabled: options.config.consentEnabled,
    consentAdmins: options.config.consentAdmins,
    auditLog: options.config.auditLog,
  });
  return server;
}
