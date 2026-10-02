import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { formatUnknownError } from '../errors.js';
import { writeAuditEvent } from '../enablebanking/audit.js';
import type { Bank } from '../enablebanking/bank.js';
import {
  CAPABILITIES,
  CONSENT_ANNOTATIONS,
  READ_ANNOTATIONS,
  REVOKE_ANNOTATIONS,
  searchCapabilities,
} from '../enablebanking/capabilities.js';

export interface ToolOptions {
  /** Gateway-verified UPN of the caller. */
  actingAs: string;
  consentEnabled: boolean;
  /** Empty = the gateway duty group alone decides. */
  consentAdmins: string[];
  auditLog?: string;
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const account = z
  .string()
  .trim()
  .min(1)
  .describe('Account id from enablebanking_list_accounts (e.g. "drift") or the IBAN. Only this company’s registered accounts work.');

export function registerTools(server: McpServer, bank: Bank, options: ToolOptions): Set<string> {
  const available = new Set(
    CAPABILITIES.filter(capability => capability.kind === 'read' || options.consentEnabled).map(capability => capability.id),
  );

  const audited = async <T>(tool: string, input: Record<string, unknown>, call: () => Promise<T>) => {
    const base = {
      company: bank.company,
      actingAs: options.actingAs,
      tool,
      account: typeof input.account === 'string' ? input.account : typeof input.consent === 'string' ? input.consent : undefined,
      target: input,
    };
    const isConsent = CAPABILITIES.find(capability => capability.id === tool)?.kind === 'consent';
    if (isConsent && options.consentAdmins.length > 0 && !options.consentAdmins.includes(options.actingAs.toLowerCase())) {
      const reason = `${options.actingAs} may not manage bank consents for ${bank.companyInfo().name}`;
      await writeAuditEvent(options.auditLog, { ...base, action: 'denied', reason });
      return errorResult(reason);
    }
    await writeAuditEvent(options.auditLog, { ...base, action: 'start' });
    try {
      const result = await call();
      await writeAuditEvent(options.auditLog, { ...base, action: 'finish' });
      return jsonResult(result);
    } catch (error) {
      const message = formatUnknownError(error);
      await writeAuditEvent(options.auditLog, { ...base, action: 'error', error: message });
      return errorResult(message);
    }
  };

  server.registerTool(
    'enablebanking_search_capabilities',
    {
      title: 'Search Enable Banking capabilities',
      description: 'List the bank tools on this server, optionally filtered by a search text. Use first when unsure.',
      inputSchema: { query: z.string().trim().default('') },
      annotations: READ_ANNOTATIONS,
    },
    async input =>
      audited('enablebanking_search_capabilities', input, async () => ({
        company: bank.companyInfo().name,
        tools: searchCapabilities(input.query, available),
      })),
  );

  server.registerTool(
    'enablebanking_list_accounts',
    {
      title: 'List bank accounts',
      description:
        "This company's registered bank accounts (id, IBAN, name, bank, e-conomic ledger account), whether a consent covers each, " +
        'and when the consents expire. Accounts of other companies are never listed or readable here.',
      inputSchema: {},
      annotations: READ_ANNOTATIONS,
    },
    async input => audited('enablebanking_list_accounts', input, async () => bank.listAccounts()),
  );

  server.registerTool(
    'enablebanking_get_balances',
    {
      title: 'Get account balances',
      description: 'Current balances of one account as the bank reports them (booked and available). Amounts are decimal strings.',
      inputSchema: { account },
      annotations: READ_ANNOTATIONS,
    },
    async input => audited('enablebanking_get_balances', input, () => bank.balances(input.account)),
  );

  server.registerTool(
    'enablebanking_get_account_details',
    {
      title: 'Get account details',
      description: "The bank's description of one account: product, currency, cash account type, credit limit.",
      inputSchema: { account },
      annotations: READ_ANNOTATIONS,
    },
    async input => audited('enablebanking_get_account_details', input, () => bank.details(input.account)),
  );

  server.registerTool(
    'enablebanking_list_transactions',
    {
      title: 'List bank transactions',
      description:
        'Bank lines of one account in a period (default: the last 30 days, booked only), newest first, with in/out totals. ' +
        'Amounts are signed decimal strings: negative left the account. Filter by text (counterparty, remittance text, reference), ' +
        'direction and absolute amount.',
      inputSchema: {
        account,
        from: date.optional().describe('First booking date, YYYY-MM-DD. Default: 30 days before `to`.'),
        to: date.optional().describe('Last booking date, YYYY-MM-DD. Default: today.'),
        status: z.enum(['booked', 'pending', 'all']).default('booked'),
        search: z.string().trim().max(200).optional(),
        direction: z.enum(['in', 'out']).optional(),
        minAmount: z.number().nonnegative().optional().describe('Minimum absolute amount, e.g. 1000 for 1.000,00.'),
        maxAmount: z.number().nonnegative().optional(),
        limit: z.number().int().min(1).max(1000).default(200),
      },
      annotations: READ_ANNOTATIONS,
    },
    async input => audited('enablebanking_list_transactions', input, () => bank.transactions(input.account, input)),
  );

  if (!options.consentEnabled) return available;

  server.registerTool(
    'enablebanking_list_banks',
    {
      title: 'List banks',
      description: 'Banks Enable Banking can connect to in a country (exact names for enablebanking_start_consent), with maximum consent length.',
      inputSchema: {
        country: z.string().regex(/^[A-Za-z]{2}$/).default('DK'),
        psuType: z.enum(['business', 'personal']).default('business'),
        search: z.string().trim().optional(),
      },
      annotations: READ_ANNOTATIONS,
    },
    async input =>
      audited('enablebanking_list_banks', input, async () => {
        const banks = await bank.listBanks(input.country, input.psuType);
        const search = input.search?.toLowerCase();
        return search ? banks.filter(candidate => candidate.name.toLowerCase().includes(search)) : banks;
      }),
  );

  server.registerTool(
    'enablebanking_start_consent',
    {
      title: 'Start a bank consent (admin)',
      description:
        "Create or renew this company's consent at one bank. Returns a MitID link for someone authorised for the company at the bank. " +
        'Nothing is linked until enablebanking_complete_consent is called with the address the browser lands on. Renewing replaces ' +
        "(and revokes) the company's previous consent at the same bank.",
      inputSchema: {
        bank: z.string().trim().min(1).describe('Exact bank name from enablebanking_list_banks, e.g. "Danske Bank".'),
        country: z.string().regex(/^[A-Za-z]{2}$/).default('DK'),
        psuType: z.enum(['business', 'personal']).default('business'),
        validDays: z.number().int().min(1).max(730).default(180).describe('Capped at the bank’s maximum (often 180).'),
        language: z.string().regex(/^[a-z]{2}$/).optional().describe('Language of the bank pages, e.g. "da".'),
      },
      annotations: CONSENT_ANNOTATIONS,
    },
    async input => audited('enablebanking_start_consent', input, () => bank.startConsent({ ...input, user: options.actingAs })),
  );

  server.registerTool(
    'enablebanking_complete_consent',
    {
      title: 'Complete a bank consent (admin)',
      description:
        'Finish a consent started with enablebanking_start_consent: pass the whole address the browser landed on after MitID. ' +
        "Binds ONLY the accounts registered to this company in the account registry; other companies' accounts are discarded, " +
        'and unregistered accounts are listed so they can be added to the registry (then run enablebanking_refresh_consent).',
      inputSchema: {
        redirectUrl: z.string().trim().min(10).max(8000).describe('The full URL from the browser, including ?code=…&state=…'),
      },
      annotations: CONSENT_ANNOTATIONS,
    },
    async input => audited('enablebanking_complete_consent', {}, () => bank.completeConsent({ user: options.actingAs, redirectUrl: input.redirectUrl })),
  );

  server.registerTool(
    'enablebanking_refresh_consent',
    {
      title: 'Re-bind a consent (admin)',
      description:
        'Re-read which accounts an existing consent covers and bind them against the account registry as it is now — use after ' +
        'registering an account the consent already includes. No MitID needed.',
      inputSchema: { consent: z.string().trim().min(1).describe('Consent key from enablebanking_list_accounts, e.g. "dk-danske-bank-business".') },
      annotations: CONSENT_ANNOTATIONS,
    },
    async input => audited('enablebanking_refresh_consent', input, () => bank.refreshConsent(input.consent)),
  );

  server.registerTool(
    'enablebanking_revoke_consent',
    {
      title: 'Revoke a consent (admin)',
      description: 'Close a consent at the bank (Enable Banking DELETE /sessions) and remove it from this server.',
      inputSchema: { consent: z.string().trim().min(1) },
      annotations: REVOKE_ANNOTATIONS,
    },
    async input => audited('enablebanking_revoke_consent', input, () => bank.revokeConsent(input.consent)),
  );

  return available;
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}
