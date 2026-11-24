export interface Capability {
  id: string;
  title: string;
  description: string;
  kind: 'read' | 'consent';
  keywords: string[];
}

export const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
export const CONSENT_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
export const REVOKE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;

export const CAPABILITIES: Capability[] = [
  {
    id: 'enablebanking_search_capabilities',
    title: 'Search capabilities',
    description: 'Find the right tool. Start here.',
    kind: 'read',
    keywords: ['help', 'hjælp', 'tools', 'capabilities'],
  },
  {
    id: 'enablebanking_list_accounts',
    title: 'List accounts',
    description: "This company's registered bank accounts, whether a consent covers them, and when it expires.",
    kind: 'read',
    keywords: ['konti', 'konto', 'accounts', 'iban', 'samtykke', 'consent', 'udløb', 'expiry', 'status'],
  },
  {
    id: 'enablebanking_get_balances',
    title: 'Get balances',
    description: 'Booked and available balance of one account (saldo, disponibel).',
    kind: 'read',
    keywords: ['saldo', 'balance', 'disponibel', 'available', 'likviditet', 'cash'],
  },
  {
    id: 'enablebanking_get_account_details',
    title: 'Get account details',
    description: "The bank's own description of one account: holder, product, currency, credit limit, every account number.",
    kind: 'read',
    keywords: ['detaljer', 'details', 'produkt', 'kredit', 'credit limit', 'trækningsret', 'holder', 'owner', 'bban', 'bic'],
  },
  {
    id: 'enablebanking_list_transactions',
    title: 'List transactions',
    description: 'Bank lines (posteringer) of one account in a period, with totals; filter by text, direction and amount.',
    kind: 'read',
    keywords: ['posteringer', 'bevægelser', 'transaktioner', 'transactions', 'kontoudtog', 'statement', 'betaling', 'indbetaling', 'udbetaling'],
  },
  {
    id: 'enablebanking_get_transaction_details',
    title: 'Get transaction details',
    description: 'What more the bank has on one bank line, by the detailsId of a listing.',
    kind: 'read',
    keywords: ['details', 'detaljer', 'transaction', 'postering', 'line'],
  },
  {
    id: 'enablebanking_summarize_transactions',
    title: 'Summarize transactions',
    description: 'Totals per counterparty and currency for one account in a period, computed from the bank lines.',
    kind: 'read',
    keywords: ['summary', 'oversigt', 'totals', 'counterparty', 'modpart', 'supplier', 'customer', 'spend', 'forbrug'],
  },
  {
    id: 'enablebanking_search_transactions',
    title: 'Search transactions',
    description: 'Bank lines that match a text or an amount across all of this company\u2019s accounts.',
    kind: 'read',
    keywords: ['search', 'find', 'søg', 'reference', 'invoice', 'faktura', 'amount', 'beløb', 'all accounts'],
  },
  {
    id: 'enablebanking_get_consent_status',
    title: 'Get consent status',
    description: 'Each bank consent as Enable Banking holds it now: status, expiry and the accounts it covers.',
    kind: 'read',
    keywords: ['consent', 'samtykke', 'status', 'expiry', 'udløb', 'session', 'revoked', 'expired'],
  },
  {
    id: 'enablebanking_list_banks',
    title: 'List banks',
    description: 'Banks Enable Banking can connect to, per country: customer types, sign-in methods and maximum consent length.',
    kind: 'consent',
    keywords: ['bank', 'banker', 'aspsp', 'danske bank', 'jyske', 'nordea'],
  },
  {
    id: 'enablebanking_start_consent',
    title: 'Start consent (admin)',
    description: 'Create or renew a bank consent for this company: returns a link to the bank\u2019s own sign-in.',
    kind: 'consent',
    keywords: ['samtykke', 'consent', 'mitid', 'bankid', 'sign-in', 'forny', 'renew', 'tilknyt', 'link'],
  },
  {
    id: 'enablebanking_complete_consent',
    title: 'Complete consent (admin)',
    description: 'Finish a consent with the address you landed on after the bank\u2019s sign-in; binds only this company’s registered accounts.',
    kind: 'consent',
    keywords: ['samtykke', 'consent', 'mitid', 'code', 'redirect'],
  },
  {
    id: 'enablebanking_refresh_consent',
    title: 'Re-bind consent (admin)',
    description: 'Re-read the accounts behind a consent and bind them against the registry as it is now.',
    kind: 'consent',
    keywords: ['rebind', 'refresh', 'registry', 'ny konto', 'new account'],
  },
  {
    id: 'enablebanking_revoke_consent',
    title: 'Revoke consent (admin)',
    description: 'Close a consent at the bank and forget it here.',
    kind: 'consent',
    keywords: ['tilbagekald', 'revoke', 'slet', 'delete', 'luk'],
  },
];

export function searchCapabilities(query: string, available: Set<string>) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return CAPABILITIES.filter(capability => available.has(capability.id))
    .map(capability => {
      const haystack = [capability.id, capability.title, capability.description, ...capability.keywords].join(' ').toLowerCase();
      return { capability, score: terms.filter(term => haystack.includes(term)).length };
    })
    .filter(entry => terms.length === 0 || entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.capability);
}
