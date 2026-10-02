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
    description: "The bank's own description of one account: product, currency, credit limit.",
    kind: 'read',
    keywords: ['detaljer', 'details', 'produkt', 'kredit', 'credit limit', 'trækningsret'],
  },
  {
    id: 'enablebanking_list_transactions',
    title: 'List transactions',
    description: 'Bank lines (posteringer) of one account in a period, with totals; filter by text, direction and amount.',
    kind: 'read',
    keywords: ['posteringer', 'bevægelser', 'transaktioner', 'transactions', 'kontoudtog', 'statement', 'betaling', 'indbetaling', 'udbetaling'],
  },
  {
    id: 'enablebanking_list_banks',
    title: 'List banks',
    description: 'Banks Enable Banking can connect to in a country, with their maximum consent length.',
    kind: 'consent',
    keywords: ['bank', 'banker', 'aspsp', 'danske bank', 'jyske', 'nordea'],
  },
  {
    id: 'enablebanking_start_consent',
    title: 'Start consent (admin)',
    description: 'Create or renew a bank consent for this company: returns a MitID link.',
    kind: 'consent',
    keywords: ['samtykke', 'consent', 'mitid', 'forny', 'renew', 'tilknyt', 'link'],
  },
  {
    id: 'enablebanking_complete_consent',
    title: 'Complete consent (admin)',
    description: 'Finish a consent with the address you landed on after MitID; binds only this company’s registered accounts.',
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
