import { randomBytes } from 'node:crypto';
import { EnableBankingHttpError } from '../errors.js';
import type { AccountResource, EnableBankingClient } from './client.js';
import { balanceView, isoDate, summarize, transactionView, type TransactionView } from './format.js';
import { maskIban, normalizeIban, type AccountRegistry, type Company, type RegisteredAccount } from './registry.js';
import type { BoundAccount, ExcludedAccount, SessionStore, StoredSession } from './store.js';

const STATE_TTL_MS = 30 * 60_000;
const DAY_MS = 86_400_000;

export interface BankOptions {
  company: string;
  client: EnableBankingClient;
  registry: AccountRegistry;
  store: SessionStore;
  redirectUrl?: string;
  cacheSeconds?: number;
  now?: () => number;
}

export interface LinkedAccount {
  account: RegisteredAccount;
  session: StoredSession;
  uid: string;
}

/** What a completed (or refreshed) consent bound, for the admin who did it. */
export interface BindingReport {
  bank: string;
  validUntil: string;
  bound: Array<{ id: string; iban: string; name: string }>;
  /** Registered to another company: never readable here, shown masked. */
  otherCompany: string[];
  /** In nobody's registry: shown in full so an admin can register them (accounts.json). */
  unregistered: Array<{ iban: string; name: string | null; currency: string | null }>;
  noIban: number;
  registeredButNotInConsent: Array<{ id: string; iban: string }>;
}

export class ConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsentError';
  }
}

/**
 * The company boundary in one place. Every read goes through `linked()`,
 * which checks the registry (now, not at consent time) and the consent
 * expiry before an account uid is ever handed to the client.
 */
export class Bank {
  readonly company: string;
  private readonly client: EnableBankingClient;
  private readonly registry: AccountRegistry;
  private readonly store: SessionStore;
  private readonly cache = new Map<string, { expires: number; value: unknown }>();
  private readonly cacheMs: number;
  private readonly now: () => number;

  constructor(private readonly options: BankOptions) {
    this.company = options.company;
    this.client = options.client;
    this.registry = options.registry;
    this.store = options.store;
    this.cacheMs = (options.cacheSeconds ?? 300) * 1000;
    this.now = options.now ?? Date.now;
    // Fail at startup, not on the first call, if the instance is pinned to a
    // company the registry does not know.
    this.registry.company(this.company);
  }

  companyInfo(): Company {
    return this.registry.company(this.company);
  }

  // ------------------------------------------------------------------ reads

  listAccounts() {
    const company = this.companyInfo();
    const sessions = this.store.sessions();
    const now = this.now();
    return {
      company: { code: company.code, name: company.name, cvr: company.cvr },
      accounts: company.accounts.map(account => {
        const session = sessions.find(candidate => candidate.accounts.some(bound => bound.iban === account.iban));
        const expiresInDays = session ? Math.floor((Date.parse(session.validUntil) - now) / DAY_MS) : null;
        return {
          id: account.id,
          iban: account.iban,
          name: account.name,
          bank: account.bank ?? session?.aspsp.name ?? null,
          currency: account.currency,
          ledgerAccount: account.ledgerAccount ?? null,
          status: !session ? 'no_consent' : expiresInDays !== null && expiresInDays < 0 ? 'consent_expired' : 'linked',
          consentValidUntil: session?.validUntil ?? null,
          consentExpiresInDays: expiresInDays,
        };
      }),
      consents: sessions.map(session => ({
        consent: session.key,
        bank: `${session.aspsp.name} (${session.aspsp.country}, ${session.psuType})`,
        validUntil: session.validUntil,
        createdAt: session.createdAt,
        createdBy: session.createdBy,
        boundAccounts: session.accounts.length,
        excludedAccounts: session.excluded,
      })),
    };
  }

  /** Resolve a user reference to a readable account of THIS company, or throw. */
  linked(reference: string): LinkedAccount {
    const account = this.registry.resolve(this.company, reference);
    const sessions = this.store.sessions();
    const session = sessions.find(candidate => candidate.accounts.some(bound => bound.iban === account.iban));
    if (!session) {
      throw new ConsentError(
        `${account.name} (${maskIban(account.iban)}) is registered for ${this.companyInfo().name} but no bank consent covers it yet. ` +
          'An administrator must link it with enablebanking_start_consent.',
      );
    }
    if (Date.parse(session.validUntil) <= this.now()) {
      throw new ConsentError(
        `The ${session.aspsp.name} consent for ${this.companyInfo().name} expired on ${session.validUntil.slice(0, 10)}. ` +
          'An administrator must renew it with enablebanking_start_consent (MitID).',
      );
    }
    const bound = session.accounts.find(candidate => candidate.iban === account.iban)!;
    return { account, session, uid: bound.uid };
  }

  async balances(reference: string) {
    const link = this.linked(reference);
    const rows = await this.cached(`balances:${link.uid}`, () => this.call(link, () => this.client.getBalances(link.uid)));
    return { account: accountHeader(link), balances: rows.map(balanceView) };
  }

  async details(reference: string) {
    const link = this.linked(reference);
    const raw = await this.cached(`details:${link.uid}`, () => this.call(link, () => this.client.getAccountDetails(link.uid)));
    // Belt and braces: the bank must still say this uid is the registered IBAN.
    const iban = ibanOf(raw);
    if (iban && iban !== link.account.iban) {
      throw new ConsentError('the bank returned a different account than the one registered; refusing to show it');
    }
    return {
      account: accountHeader(link),
      bank: {
        name: raw.name ?? null,
        product: raw.product ?? null,
        currency: raw.currency ?? null,
        cashAccountType: raw.cash_account_type ?? null,
        usage: raw.usage ?? null,
        servicer: raw.account_servicer?.name ?? raw.account_servicer?.bic_fi ?? null,
        creditLimit: raw.credit_limit ?? null,
      },
    };
  }

  async transactions(
    reference: string,
    query: {
      from?: string;
      to?: string;
      status?: 'booked' | 'pending' | 'all';
      search?: string;
      direction?: 'in' | 'out';
      minAmount?: number;
      maxAmount?: number;
      limit?: number;
    },
  ) {
    const link = this.linked(reference);
    const to = query.to ?? isoDate(new Date(this.now()));
    const from = query.from ?? isoDate(new Date(Date.parse(to) - 30 * DAY_MS));
    if (from > to) throw new Error(`from (${from}) is after to (${to})`);
    const status = query.status ?? 'booked';
    const fetched = await this.cached(`tx:${link.uid}:${from}:${to}:${status}`, () =>
      this.call(link, () =>
        this.client.listTransactions(link.uid, {
          dateFrom: from,
          dateTo: to,
          status: status === 'booked' ? 'BOOK' : status === 'pending' ? 'PDNG' : undefined,
        }),
      ),
    );
    const search = query.search?.trim().toLowerCase();
    let rows: TransactionView[] = fetched.transactions.map(transactionView);
    // Some banks ignore transaction_status; filter here too.
    if (status === 'booked') rows = rows.filter(row => row.status === 'BOOK');
    if (status === 'pending') rows = rows.filter(row => row.status !== 'BOOK');
    if (query.direction) rows = rows.filter(row => row.direction === query.direction);
    if (search) {
      rows = rows.filter(row =>
        [row.counterparty, row.text, row.reference, row.counterpartyIban].some(value => value?.toLowerCase().includes(search)),
      );
    }
    if (query.minAmount !== undefined) rows = rows.filter(row => Math.abs(Number(row.amount)) >= query.minAmount!);
    if (query.maxAmount !== undefined) rows = rows.filter(row => Math.abs(Number(row.amount)) <= query.maxAmount!);
    rows.sort((a, b) => (b.bookingDate ?? b.valueDate ?? '').localeCompare(a.bookingDate ?? a.valueDate ?? ''));
    const limit = query.limit ?? 200;
    return {
      account: accountHeader(link),
      period: { from, to, status },
      totals: summarize(rows),
      count: rows.length,
      returned: Math.min(limit, rows.length),
      truncated: fetched.truncated || rows.length > limit,
      transactions: rows.slice(0, limit),
    };
  }

  // ---------------------------------------------------------------- consent

  async listBanks(country: string, psuType?: 'business' | 'personal') {
    const banks = await this.client.listAspsps(country.toUpperCase(), psuType);
    return banks.map(bank => ({
      name: bank.name,
      country: bank.country,
      bic: bank.bic ?? null,
      psuTypes: bank.psu_types ?? [],
      maxConsentDays: bank.maximum_consent_validity ? Math.floor(bank.maximum_consent_validity / 86_400) : null,
      beta: bank.beta ?? false,
    }));
  }

  async startConsent(input: {
    user: string;
    bank: string;
    country: string;
    psuType: 'business' | 'personal';
    validDays: number;
    language?: string;
  }) {
    if (!this.options.redirectUrl) throw new ConsentError('ENABLEBANKING_REDIRECT_URL is not configured on this server');
    const country = input.country.toUpperCase();
    const banks = await this.client.listAspsps(country);
    const bank = banks.find(candidate => candidate.name.toLowerCase() === input.bank.trim().toLowerCase());
    if (!bank) {
      throw new ConsentError(`no bank named "${input.bank}" in ${country}; list them with enablebanking_list_banks`);
    }
    if (bank.psu_types && !bank.psu_types.includes(input.psuType)) {
      throw new ConsentError(`${bank.name} does not offer ${input.psuType} consents (it offers ${bank.psu_types.join(', ')})`);
    }
    const maxDays = bank.maximum_consent_validity ? Math.floor(bank.maximum_consent_validity / 86_400) : input.validDays;
    const validDays = Math.min(input.validDays, maxDays);
    const expiresAt = this.now() + STATE_TTL_MS;
    const validUntil = new Date(this.now() + validDays * DAY_MS).toISOString();
    const state = this.store.signState({
      company: this.company,
      user: input.user.toLowerCase(),
      nonce: randomBytes(16).toString('base64url'),
      expiresAt,
      aspsp: { name: bank.name, country: bank.country },
      psuType: input.psuType,
      validUntil,
    });
    const auth = await this.client.startAuthorization({
      aspsp: { name: bank.name, country: bank.country },
      psuType: input.psuType,
      validUntil,
      redirectUrl: this.options.redirectUrl,
      state,
      language: input.language,
    });
    const company = this.companyInfo();
    return {
      company: company.name,
      bank: bank.name,
      psuType: input.psuType,
      validDays,
      url: auth.url,
      expiresAt: new Date(expiresAt).toISOString(),
      next:
        `Open the URL and approve with MitID as someone authorised for ${company.name} (CVR ${company.cvr}). ` +
        `You land on ${this.options.redirectUrl}; copy the WHOLE address from the browser and pass it to ` +
        'enablebanking_complete_consent within 30 minutes. Only accounts registered to ' +
        `${company.name} in the account registry become readable; everything else in the consent is discarded.`,
    };
  }

  async completeConsent(input: { user: string; redirectUrl: string }): Promise<BindingReport> {
    let url: URL;
    try {
      url = new URL(input.redirectUrl.trim());
    } catch {
      throw new ConsentError('pass the full address you landed on after MitID (it contains ?code=…&state=…)');
    }
    const bankError = url.searchParams.get('error');
    if (bankError) {
      throw new ConsentError(`the bank did not grant the consent: ${bankError} ${url.searchParams.get('error_description') ?? ''}`.trim());
    }
    const code = url.searchParams.get('code');
    const rawState = url.searchParams.get('state');
    if (!code || !rawState) throw new ConsentError('the address has no code/state; copy it again from the browser');

    const state = this.store.verifyState(rawState);
    if (state.company !== this.company) {
      throw new ConsentError(`this consent was started for company ${state.company}, not ${this.company}; complete it on that company's endpoint`);
    }
    if (state.user !== input.user.toLowerCase()) {
      throw new ConsentError('this consent was started by another user; the person who started it must complete it');
    }
    if (state.expiresAt <= this.now()) throw new ConsentError('the consent link is older than 30 minutes; start again');
    if (!this.store.consumeState(state.nonce, state.expiresAt)) throw new ConsentError('this consent was already completed');

    const created = await this.client.createSession(code);
    const binding = this.bind(created.accounts ?? []);
    if (binding.bound.length === 0) {
      // Nothing here belongs to this company: do not keep a consent that can
      // only read other companies' (or nobody's) accounts.
      await this.client.deleteSession(created.session_id).catch(() => undefined);
      return this.report(state.aspsp.name, '(revoked)', binding);
    }
    const session: StoredSession = {
      key: sessionKey(state.aspsp, state.psuType),
      sessionId: created.session_id,
      aspsp: state.aspsp,
      psuType: state.psuType,
      validUntil: created.access?.valid_until || state.validUntil,
      createdAt: new Date(this.now()).toISOString(),
      createdBy: input.user.toLowerCase(),
      accounts: binding.bound,
      excluded: binding.excluded,
    };
    const replaced = this.store.upsert(session);
    if (replaced && replaced.sessionId !== session.sessionId) {
      await this.client.deleteSession(replaced.sessionId).catch(() => undefined);
    }
    this.cache.clear();
    return this.report(state.aspsp.name, session.validUntil, binding);
  }

  /**
   * Re-read the accounts behind an existing consent and bind them against the
   * registry as it is NOW — after an admin registered an account the consent
   * already covered, no new MitID round is needed.
   */
  async refreshConsent(consent: string): Promise<BindingReport> {
    const session = this.store.sessions().find(candidate => candidate.key === consent);
    if (!session) throw new ConsentError(`no consent "${consent}"; see enablebanking_list_accounts`);
    const status = await this.client.getSession(session.sessionId);
    const details: AccountResource[] = [];
    for (const uid of status.accounts ?? []) {
      details.push({ ...(await this.client.getAccountDetails(uid)), uid });
    }
    const binding = this.bind(details);
    this.store.upsert({
      ...session,
      validUntil: status.access?.valid_until ?? session.validUntil,
      accounts: binding.bound,
      excluded: binding.excluded,
    });
    this.cache.clear();
    return this.report(session.aspsp.name, status.access?.valid_until ?? session.validUntil, binding);
  }

  async revokeConsent(consent: string) {
    const session = this.store.sessions().find(candidate => candidate.key === consent);
    if (!session) throw new ConsentError(`no consent "${consent}"; see enablebanking_list_accounts`);
    let revokedAtBank = true;
    try {
      await this.client.deleteSession(session.sessionId);
    } catch (error) {
      // Already gone at the bank is fine; anything else is reported but the
      // local copy is removed regardless, so this server stops using it.
      revokedAtBank = error instanceof EnableBankingHttpError && error.consentLost;
    }
    this.store.remove(consent);
    this.cache.clear();
    return { consent, bank: session.aspsp.name, removed: true, revokedAtBank };
  }

  // ---------------------------------------------------------------- helpers

  private bind(accounts: AccountResource[]) {
    const bound: BoundAccount[] = [];
    const excluded: ExcludedAccount[] = [];
    const unregistered: BindingReport['unregistered'] = [];
    const otherCompany: string[] = [];
    let noIban = 0;
    for (const account of accounts) {
      const iban = ibanOf(account);
      if (!iban || !account.uid) {
        noIban += 1;
        excluded.push({ iban: '(no IBAN)', reason: 'no_iban' });
        continue;
      }
      const owner = this.registry.ownerOf(iban);
      if (owner === this.company) {
        bound.push({ uid: account.uid, iban, name: account.name ?? undefined, currency: account.currency ?? undefined });
      } else if (owner) {
        otherCompany.push(maskIban(iban));
        excluded.push({ iban: maskIban(iban), reason: 'other_company' });
      } else {
        unregistered.push({ iban, name: account.name ?? null, currency: account.currency ?? null });
        excluded.push({ iban: maskIban(iban), reason: 'unregistered' });
      }
    }
    return { bound, excluded, unregistered, otherCompany, noIban };
  }

  private report(bank: string, validUntil: string, binding: ReturnType<Bank['bind']>): BindingReport {
    const boundIbans = new Set(binding.bound.map(account => account.iban));
    const company = this.companyInfo();
    return {
      bank,
      validUntil,
      bound: company.accounts
        .filter(account => boundIbans.has(account.iban))
        .map(account => ({ id: account.id, iban: account.iban, name: account.name })),
      otherCompany: binding.otherCompany,
      unregistered: binding.unregistered,
      noIban: binding.noIban,
      registeredButNotInConsent: company.accounts
        .filter(account => !boundIbans.has(account.iban) && (!account.bank || account.bank.toLowerCase() === bank.toLowerCase()))
        .map(account => ({ id: account.id, iban: maskIban(account.iban) })),
    };
  }

  private async call<T>(link: LinkedAccount, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof EnableBankingHttpError && error.consentLost) {
        throw new ConsentError(
          `${link.session.aspsp.name} refused the consent for ${this.companyInfo().name} (${error.message}). ` +
            'It may have been revoked at the bank or expired; an administrator must renew it with enablebanking_start_consent.',
        );
      }
      throw error;
    }
  }

  /**
   * Short cache per account and query. Banks may cap reads that the account
   * holder is not present for (PSD2: as few as 4 per account per day), so the
   * same question asked twice in a conversation must not cost two bank calls.
   */
  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (this.cacheMs <= 0) return load();
    const hit = this.cache.get(key);
    if (hit && hit.expires > this.now()) return hit.value as T;
    const value = await load();
    this.cache.set(key, { expires: this.now() + this.cacheMs, value });
    return value;
  }
}

export function sessionKey(aspsp: { name: string; country: string }, psuType: string): string {
  return `${aspsp.country.toLowerCase()}-${aspsp.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${psuType}`;
}

function ibanOf(account: AccountResource): string | undefined {
  const direct = account.account_id?.iban;
  if (direct) return normalizeIban(direct);
  const listed = account.all_account_ids?.find(id => id.scheme_name === 'IBAN')?.identification;
  return listed ? normalizeIban(listed) : undefined;
}

function accountHeader(link: LinkedAccount) {
  return { id: link.account.id, iban: link.account.iban, name: link.account.name, bank: link.session.aspsp.name };
}
