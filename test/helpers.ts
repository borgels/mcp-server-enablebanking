import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bank } from '../src/enablebanking/bank.js';
import { EnableBankingClient } from '../src/enablebanking/client.js';
import { AccountRegistry } from '../src/enablebanking/registry.js';
import { SessionStore } from '../src/enablebanking/store.js';

/** A valid DK IBAN for a 14-digit BBAN. */
export function dkIban(bban: string): string {
  const numeric = `${bban}DK00`.replace(/[A-Z]/g, char => String(char.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  return `DK${String(98 - remainder).padStart(2, '0')}${bban}`;
}

export const IBAN = {
  aaaDrift: dkIban('54700001234567'),
  aaaSkat: dkIban('54700007654321'),
  bbbDrift: dkIban('54700001111111'),
  stray: dkIban('54700009999999'),
};

export const REGISTRY = {
  companies: {
    aaa: {
      name: 'Alfa Drift ApS',
      cvr: '12345678',
      accounts: [
        { iban: IBAN.aaaDrift, id: 'drift', name: 'Driftskonto', bank: 'Danske Bank', ledgerAccount: 5820 },
        { iban: IBAN.aaaSkat, id: 'skat', name: 'Skattekonto', bank: 'Danske Bank' },
      ],
    },
    bbb: {
      name: 'Beta Handel ApS',
      cvr: '87654321',
      accounts: [{ iban: IBAN.bbbDrift, id: 'drift', name: 'Driftskonto', bank: 'Danske Bank' }],
    },
  },
};

export const KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });

export interface FakeCall {
  method: string;
  path: string;
  body?: unknown;
  authorization?: string;
}

/** A minimal Enable Banking API: one bank, one login that sees aaa, bbb and an unregistered account. */
export function fakeApi(overrides: Partial<Record<string, (call: FakeCall) => unknown>> = {}) {
  const calls: FakeCall[] = [];
  const deleted: string[] = [];
  let sessionCounter = 0;
  let sessionAccounts = [
    { uid: 'uid-aaa-drift', account_id: { iban: IBAN.aaaDrift }, name: 'Drift', currency: 'DKK' },
    { uid: 'uid-bbb-drift', account_id: { iban: IBAN.bbbDrift }, name: 'Beta drift', currency: 'DKK' },
    { uid: 'uid-stray', account_id: { iban: IBAN.stray }, name: 'Ukendt', currency: 'DKK' },
  ];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const call: FakeCall = {
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: (init?.headers as Record<string, string>)?.Authorization,
    };
    calls.push(call);
    const route = `${call.method} ${url.pathname}`;
    const custom = Object.entries(overrides).find(([pattern]) => new RegExp(`^${pattern}$`).test(route));
    let payload: unknown;
    let status = 200;
    if (custom) {
      payload = custom[1]!(call);
      if (payload instanceof Response) return payload;
    } else if (route === 'GET /aspsps') {
      payload = { aspsps: [{ name: 'Danske Bank', country: 'DK', psu_types: ['business', 'personal'], maximum_consent_validity: 180 * 86400 }] };
    } else if (route === 'POST /auth') {
      payload = { url: 'https://bank.example/mitid?x=1', authorization_id: 'a1' };
    } else if (route === 'POST /sessions') {
      sessionCounter += 1;
      payload = { session_id: `s${sessionCounter}`, accounts: sessionAccounts, access: { valid_until: '2099-01-01T00:00:00Z' } };
    } else if (route.startsWith('DELETE /sessions/')) {
      deleted.push(url.pathname.split('/')[2]!);
      payload = {};
    } else if (route.startsWith('GET /sessions/')) {
      payload = { status: 'AUTHORIZED', accounts: sessionAccounts.map(a => a.uid), access: { valid_until: '2099-01-01T00:00:00Z' } };
    } else if (/^GET \/accounts\/[^/]+\/details$/.test(route)) {
      const uid = url.pathname.split('/')[2];
      payload = sessionAccounts.find(a => a.uid === uid);
    } else if (/^GET \/accounts\/[^/]+\/balances$/.test(route)) {
      payload = { balances: [{ balance_type: 'CLBD', balance_amount: { amount: '1234.50', currency: 'DKK' }, reference_date: '2026-10-01' }] };
    } else if (/^GET \/accounts\/[^/]+\/transactions$/.test(route)) {
      payload = url.searchParams.get('continuation_key')
        ? { transactions: [tx('t3', 'CRDT', '100.00', '2026-09-03', 'Kunde A/S', 'Faktura 1001')] }
        : {
            transactions: [
              tx('t1', 'DBIT', '250.00', '2026-09-01', 'Leverandør ApS', 'Husleje'),
              tx('t2', 'DBIT', '49.95', '2026-09-02', 'Software Inc', 'Abonnement'),
            ],
            continuation_key: 'next',
          };
    } else {
      status = 404;
      payload = { error: 'NOT_FOUND' };
    }
    return new Response(JSON.stringify(payload ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return {
    calls,
    deleted,
    fetch: fetchImpl,
    setSessionAccounts(accounts: typeof sessionAccounts) {
      sessionAccounts = accounts;
    },
  };
}

function tx(id: string, indicator: string, amount: string, date: string, party: string, text: string) {
  return {
    entry_reference: id,
    credit_debit_indicator: indicator,
    transaction_amount: { amount, currency: 'DKK' },
    booking_date: date,
    value_date: date,
    status: 'BOOK',
    ...(indicator === 'DBIT' ? { creditor: { name: party } } : { debtor: { name: party } }),
    remittance_information: [text],
  };
}

export const MASTER_KEY = Buffer.alloc(32, 7);

export function makeBank(options: {
  company?: string;
  api?: ReturnType<typeof fakeApi>;
  registry?: unknown;
  dataDir?: string;
  now?: () => number;
  cacheSeconds?: number;
} = {}) {
  const api = options.api ?? fakeApi();
  const company = options.company ?? 'aaa';
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'eb-test-'));
  const bank = new Bank({
    company,
    client: new EnableBankingClient({ applicationId: 'app-1', privateKey: KEY.privateKey, baseUrl: 'https://eb.test', fetch: api.fetch }),
    registry: new AccountRegistry(options.registry ?? REGISTRY),
    store: new SessionStore(company, dataDir, MASTER_KEY),
    redirectUrl: 'https://consent.example.com/bank-consent',
    cacheSeconds: options.cacheSeconds ?? 300,
    now: options.now,
  });
  return { bank, api, dataDir };
}

/** Run the MitID round: start, then build the redirect the bank would send back. */
export async function linkConsent(bank: Bank, api: ReturnType<typeof fakeApi>, user = 'anna@example.com') {
  const started = await bank.startConsent({ user, bank: 'Danske Bank', country: 'DK', psuType: 'business', validDays: 365 });
  const auth = [...api.calls].reverse().find(call => call.method === 'POST' && call.path === '/auth')!;
  const state = (auth.body as { state: string }).state;
  return { started, state, redirect: `https://consent.example.com/bank-consent?code=c-1&state=${encodeURIComponent(state)}` };
}
