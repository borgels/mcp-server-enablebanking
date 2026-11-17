import { UPSTREAM, type UpstreamName } from './client.js';

/**
 * The gateway's tools and the Enable Banking requests each may make, in the
 * shape of the server family's gateway catalogs. Read-only: every tool is risk
 * `read`, and no payment endpoint exists anywhere in this table or the client.
 */

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue = string | number | boolean | null | GatewayJsonValue[] | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

/** Deeply read-only JSON, as found in the frozen catalogs. */
export type GatewayReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayReadonlyJsonValue[]
  | { readonly [key: string]: GatewayReadonlyJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

/** What a tool's answer contains, from least to most. */
export type EnableBankingExposure = 'accounts' | 'balances' | 'transactions';

/** One Enable Banking API request a tool may make. `path` is relative to the API origin. */
export interface GatewayUpstreamOperation {
  readonly access: 'read' | 'write';
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
}

/** What a tool reads when its input names nothing more than the account. */
export interface EnableBankingDefaultRead {
  readonly resource: EnableBankingExposure;
  /** For transactions: the period read when `from`/`to` are left out, in days ending today. */
  readonly days?: number;
  /** For transactions: the status read when `status` is left out. */
  readonly status?: 'booked';
}

export interface GatewayToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: { readonly [key: string]: GatewayReadonlyJsonValue };
  /** Every request the tool may make. */
  readonly upstream: readonly GatewayUpstreamOperation[];
  /** No tool here reads beyond its fixed targets; always false. */
  readonly broad: boolean;
  readonly defaultRead: EnableBankingDefaultRead;
  /** Enable Banking addition: one sentence for a person deciding about a role. */
  readonly summary: string;
  /**
   * Enable Banking addition: the most the answer contains. `accounts`: names,
   * masked IBANs, currencies. `balances`: also amounts on the accounts.
   * `transactions`: also individual bank lines.
   */
  readonly exposure: EnableBankingExposure;
  /**
   * Enable Banking addition: true when the answer contains transaction
   * details (counterparty names and accounts, remittance text, references).
   * A role that may see balances only gets the tools where this is false.
   */
  readonly transactionDetails: boolean;
}

export interface EnableBankingEndpointCatalogEntry {
  readonly id: UpstreamName;
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly pathTemplate: string;
  /** 'read' for GET, 'write' otherwise (consent bookkeeping, never money). */
  readonly access: 'read' | 'write';
  /** `tools`: reached through callTool. `consent`: only through the consent helpers. */
  readonly usedBy: 'tools' | 'consent';
}

export interface EnableBankingServiceCatalog {
  readonly services: readonly [
    { readonly id: 'ais'; readonly name: string; readonly description: string },
  ];
  readonly endpoints: readonly EnableBankingEndpointCatalogEntry[];
}

const ACCOUNT_PATTERN = '^[A-Za-z0-9-]{8,128}$';
export const MAX_RANGE_DAYS = 366;
export const DEFAULT_RANGE_DAYS = 30;

const accountProperty: GatewayJsonObject = {
  type: 'string',
  pattern: ACCOUNT_PATTERN,
  description: 'Account id from list_accounts.',
};

const dateProperty = (description: string): GatewayJsonObject => ({
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description,
});

interface ToolSpec extends GatewayToolDefinition {
  upstream: UpstreamName[];
  defaultRead: EnableBankingDefaultRead;
  summary: string;
  exposure: EnableBankingExposure;
  transactionDetails: boolean;
}

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'list_accounts',
    title: 'List bank accounts',
    description:
      "The company's bank accounts covered by its consent: id, name, masked IBAN, currency and product, and when the consent " +
      'expires. Use the id with get_balances and list_transactions. Reads each account at the bank once.',
    summary: 'Which bank accounts are connected: name, masked account number and currency. No amounts.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    upstream: ['getSession', 'accountDetails'],
    defaultRead: { resource: 'accounts' },
    exposure: 'accounts',
    transactionDetails: false,
  },
  {
    name: 'get_balances',
    title: 'Get account balances',
    description:
      'Balances of one account as the bank reports them (booked and available), as decimal strings. No transactions.',
    summary: 'The balance of an account. No individual transactions.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      properties: { account: accountProperty },
      required: ['account'],
      additionalProperties: false,
    },
    upstream: ['getSession', 'accountBalances'],
    defaultRead: { resource: 'balances' },
    exposure: 'balances',
    transactionDetails: false,
  },
  {
    name: 'list_transactions',
    title: 'List bank transactions',
    description:
      'Bank lines of one account in a period of at most 366 days (default: the last 30 days, booked only), with counterparty, ' +
      'text, reference and in/out totals. Amounts are signed decimal strings: negative left the account. A long period comes ' +
      'in pages: pass nextPageToken back as pageToken with the same account and period.',
    summary: 'Individual bank transactions with counterparty names, texts and references.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      properties: {
        account: accountProperty,
        from: dateProperty('First booking date, YYYY-MM-DD. Default: 29 days before `to`, so the period is 30 days including both.'),
        to: dateProperty('Last booking date, YYYY-MM-DD. Default: today.'),
        status: { type: 'string', enum: ['booked', 'pending', 'all'], description: 'Default: booked.' },
        pageToken: { type: 'string', maxLength: 4096, description: 'nextPageToken from the previous page.' },
      },
      required: ['account'],
      additionalProperties: false,
    },
    upstream: ['getSession', 'accountTransactions'],
    defaultRead: { resource: 'transactions', days: DEFAULT_RANGE_DAYS, status: 'booked' },
    exposure: 'transactions',
    transactionDetails: true,
  },
];

export const SPEC_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(TOOL_SPECS.map(spec => [spec.name, spec]));

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function operation(name: UpstreamName): GatewayUpstreamOperation {
  const target = UPSTREAM[name];
  return { access: target.method === 'GET' ? 'read' : 'write', method: target.method, path: target.path };
}

/**
 * Stable, unprefixed tool definitions. Deeply frozen, so no part of a host can
 * change the list another part reads; a gateway's `tools` returns a mutable copy.
 */
export const enableBankingGatewayTools: readonly GatewayToolDefinition[] = deepFreeze(TOOL_SPECS.map(spec => ({
  name: spec.name,
  title: spec.title,
  description: spec.description,
  riskLevel: spec.riskLevel,
  enabledByDefault: spec.enabledByDefault,
  inputSchema: structuredClone(spec.inputSchema),
})));

/**
 * The tool catalog: every tool with its definition, the requests it may make,
 * and what its answer exposes. Deeply frozen; usable without a gateway instance.
 */
export const enableBankingToolCatalog: readonly GatewayToolCatalogEntry[] = deepFreeze(
  TOOL_SPECS.map(
    (spec): GatewayToolCatalogEntry => ({
      name: spec.name,
      title: spec.title,
      description: spec.description,
      riskLevel: spec.riskLevel,
      enabledByDefault: spec.enabledByDefault,
      inputSchema: structuredClone(spec.inputSchema),
      upstream: spec.upstream.map(operation),
      broad: false,
      defaultRead: { ...spec.defaultRead },
      summary: spec.summary,
      exposure: spec.exposure,
      transactionDetails: spec.transactionDetails,
    }),
  ),
);

const CONSENT_ENDPOINTS: readonly UpstreamName[] = ['listAspsps', 'startAuthorization', 'createSession', 'deleteSession'];

/** The one service and every Enable Banking endpoint the package can call. Frozen. No payment endpoint. */
export const enableBankingServiceCatalog: EnableBankingServiceCatalog = deepFreeze({
  services: [
    {
      id: 'ais',
      name: 'Account information',
      description: 'PSD2 account information through Enable Banking: accounts, balances and transactions. Read-only.',
    },
  ] as const,
  endpoints: (Object.keys(UPSTREAM) as UpstreamName[]).map(id => ({
    id,
    method: UPSTREAM[id].method,
    pathTemplate: UPSTREAM[id].path,
    access: UPSTREAM[id].method === 'GET' ? ('read' as const) : ('write' as const),
    usedBy: CONSENT_ENDPOINTS.includes(id) ? ('consent' as const) : ('tools' as const),
  })),
});
