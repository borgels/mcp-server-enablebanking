import { randomBytes } from 'node:crypto';
import { EnableBankingHttpError, formatUnknownError } from '../errors.js';
import { budgetRefusal, UnattendedBudget } from './budget.js';
import type { AccountResource, Aspsp, EnableBankingClient, TransactionResource } from './client.js';
import { parseDecimal } from './decimal.js';
import {
  accountDetailsView,
  balanceView,
  isoDate,
  isPending,
  matchesLine,
  newestFirst,
  summarize,
  summarizeByCounterparty,
  transactionView,
  type LineFilter,
  type TransactionView,
} from './format.js';
import { problemOf, ProblemError, type ProblemCode } from './problems.js';
import { maskIban, normalizeIban, type AccountRegistry, type Company, type RegisteredAccount } from './registry.js';
import type { BoundAccount, ConsentState, ExcludedAccount, SessionStore, StoredSession } from './store.js';

const STATE_TTL_MS = 30 * 60_000;
const DAY_MS = 86_400_000;

export interface BankOptions {
  company: string;
  client: EnableBankingClient;
  registry: AccountRegistry;
  store: SessionStore;
  redirectUrl?: string;
  /** The redirect lands on this server, which completes the consent itself. */
  consentCallback?: boolean;
  cacheSeconds?: number;
  /**
   * Reads at the bank allowed per consent in 24 hours. Every read of this server is one nobody is present for, as
   * the bank sees it. Default 0: no budget is kept here, and the bank's own limit decides.
   */
  unattendedFetchesPerDay?: number;
  now?: () => number;
}

/** What the transaction tools take: a period and what to look for in it. */
export interface TransactionQuery {
  from?: string;
  to?: string;
  status?: 'booked' | 'pending' | 'all';
  /** `longest`: as far back as the bank gives, up to today. `to` cannot be given with it. */
  strategy?: 'default' | 'longest';
  search?: string;
  direction?: 'in' | 'out';
  minAmount?: number | string;
  maxAmount?: number | string;
  limit?: number;
  offset?: number;
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
  /** Our own fixed code for what went wrong (src/enablebanking/problems.ts). */
  readonly problem: ProblemCode;
  constructor(message: string, problem: ProblemCode = 'no_consent') {
    super(message);
    this.name = 'ConsentError';
    this.problem = problem;
  }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function checkDate(value: string, name: string): string {
  const parsed = DATE_PATTERN.test(value) ? new Date(`${value}T00:00:00Z`) : undefined;
  if (!parsed || Number.isNaN(parsed.getTime()) || isoDate(parsed) !== value) {
    throw new ProblemError('invalid_period', `${name} must be a date, YYYY-MM-DD.`);
  }
  return value;
}

/** A filter amount as an exact decimal. A number is taken as written in decimal notation. */
function filterAmount(value: number | string | undefined, name: string) {
  if (value === undefined) return undefined;
  const amount = parseDecimal(typeof value === 'number' ? String(value) : value.trim());
  if (!amount || amount.units < 0n) throw new ProblemError('invalid_input', `${name} must be a decimal with a dot and no sign, such as 1000 or 99.50.`);
  return amount;
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
  private readonly cache = new Map<string, { expires: number; fetchedAt: string; value: unknown }>();
  private readonly cacheMs: number;
  private readonly budget: UnattendedBudget;
  private readonly now: () => number;

  constructor(private readonly options: BankOptions) {
    this.company = options.company;
    this.client = options.client;
    this.registry = options.registry;
    this.store = options.store;
    this.cacheMs = (options.cacheSeconds ?? 300) * 1000;
    this.now = options.now ?? Date.now;
    this.budget = new UnattendedBudget(options.unattendedFetchesPerDay ?? 0, this.now);
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
          // The registry's currency, else what the bank said when the consent was bound. Never assumed.
          currency: account.currency ?? session?.accounts.find(bound => bound.iban === account.iban)?.currency ?? null,
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
        'no_consent',
      );
    }
    if (Date.parse(session.validUntil) <= this.now()) {
      throw new ConsentError(
        `The ${session.aspsp.name} consent for ${this.companyInfo().name} expired on ${session.validUntil.slice(0, 10)}. ` +
          'An administrator must renew it with enablebanking_start_consent (the bank\u2019s own sign-in).',
        'consent_expired',
      );
    }
    const bound = session.accounts.find(candidate => candidate.iban === account.iban)!;
    return { account, session, uid: bound.uid };
  }

  async balances(reference: string) {
    const link = this.linked(reference);
    const read = await this.cached(`balances:${link.uid}`, () => this.call(link, () => this.client.getBalances(link.uid)));
    return { account: accountHeader(link), fetchedAt: read.fetchedAt, balances: read.value.map(balanceView) };
  }

  async details(reference: string) {
    const link = this.linked(reference);
    const read = await this.cached(`details:${link.uid}`, () => this.call(link, () => this.client.getAccountDetails(link.uid)));
    // Belt and braces: the bank must still say this uid is the registered IBAN.
    const iban = ibanOf(read.value);
    if (iban && iban !== link.account.iban) {
      throw new ConsentError('the bank returned a different account than the one registered; refusing to show it', 'account_not_connected');
    }
    return { account: accountHeader(link), fetchedAt: read.fetchedAt, details: accountDetailsView(read.value) };
  }

  /** The period and status of a query, checked. */
  private period(query: TransactionQuery) {
    const status = query.status ?? 'booked';
    const strategy = query.strategy ?? 'default';
    const today = isoDate(new Date(this.now()));
    if (strategy === 'longest') {
      // The API ignores an end date with this strategy; one that is given would promise a period that is not read.
      if (query.to) throw new ProblemError('invalid_period', 'to cannot be given with strategy longest: the bank reads up to today.');
      const from = query.from ? checkDate(query.from, 'from') : undefined;
      return { from, to: undefined, status, strategy };
    }
    const to = checkDate(query.to ?? today, 'to');
    const from = checkDate(query.from ?? isoDate(new Date(Date.parse(to) - 30 * DAY_MS)), 'from');
    if (from > to) throw new ProblemError('invalid_period', `from (${from}) is after to (${to})`);
    return { from, to, status, strategy };
  }

  /** Every line of a period as the bank gave it, read once and kept for the cache time. */
  private async lines(link: LinkedAccount, period: ReturnType<Bank['period']>) {
    const read = await this.cached(`tx:${link.uid}:${period.from ?? ''}:${period.to ?? ''}:${period.status}:${period.strategy}`, () =>
      this.call(link, () =>
        this.client.listTransactions(link.uid, {
          ...(period.from ? { dateFrom: period.from } : {}),
          ...(period.to ? { dateTo: period.to } : {}),
          ...(period.status === 'booked' ? { status: 'BOOK' as const } : period.status === 'pending' ? { status: 'PDNG' as const } : {}),
          ...(period.strategy === 'longest' ? { strategy: 'longest' as const } : {}),
        }),
      ),
    );
    // A line without a status, returned for a request that asked for one status, is taken to have it.
    const assumed = period.status === 'booked' ? 'BOOK' : period.status === 'pending' ? 'PDNG' : undefined;
    let rows: TransactionView[] = read.value.transactions.map((row: TransactionResource) => transactionView(row, assumed));
    // Some banks ignore transaction_status; filter here too.
    if (period.status === 'booked') rows = rows.filter(row => row.status === 'BOOK');
    if (period.status === 'pending') rows = rows.filter(row => isPending(row.status));
    rows.sort(newestFirst);
    // complete is false when the bank still had more after the last page this server follows.
    return { rows, complete: !read.value.truncated, fetchedAt: read.fetchedAt };
  }

  private filter(query: TransactionQuery): LineFilter {
    const search = query.search?.trim();
    const minAmount = filterAmount(query.minAmount, 'minAmount');
    const maxAmount = filterAmount(query.maxAmount, 'maxAmount');
    return {
      ...(search ? { search } : {}),
      ...(query.direction ? { direction: query.direction } : {}),
      ...(minAmount ? { minAmount } : {}),
      ...(maxAmount ? { maxAmount } : {}),
    };
  }

  async transactions(reference: string, query: TransactionQuery) {
    const link = this.linked(reference);
    const period = this.period(query);
    const filter = this.filter(query);
    const { rows: all, complete, fetchedAt } = await this.lines(link, period);
    const rows = all.filter(row => matchesLine(row, filter));
    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;
    const shown = rows.slice(offset, offset + limit);
    return {
      account: accountHeader(link),
      period: { from: period.from ?? null, to: period.to ?? null, status: period.status, ...(period.strategy === 'longest' ? { strategy: period.strategy } : {}) },
      fetchedAt,
      // The totals cover every matching line of the period that was read, not only the lines shown.
      totals: summarize(rows),
      count: rows.length,
      offset,
      returned: shown.length,
      // False: the bank had more lines for the period than this server reads in one go; count and totals then cover
      // only the lines read. Ask for a shorter period.
      complete,
      // True when lines are missing from this answer: more matching lines than shown, or an incomplete read.
      truncated: !complete || rows.length > offset + shown.length,
      ...(rows.length > offset + shown.length ? { nextOffset: offset + shown.length } : {}),
      transactions: shown,
    };
  }

  /** What more the bank has on one line, by the detailsId of a listing. */
  async transactionDetails(reference: string, transaction: string) {
    const link = this.linked(reference);
    const raw = await this.call(link, () => this.client.getTransaction(link.uid, transaction));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ProblemError('transaction_not_found', 'The bank has no further details for that transaction.');
    }
    return { account: accountHeader(link), fetchedAt: new Date(this.now()).toISOString(), transaction: transactionView(raw) };
  }

  /** Totals per counterparty and currency: computed here from the bank's lines and nothing else. */
  async summary(reference: string, query: TransactionQuery & { top?: number }) {
    const link = this.linked(reference);
    const period = this.period({ ...query, strategy: 'default' });
    const { rows, complete, fetchedAt } = await this.lines(link, period);
    const groups = summarizeByCounterparty(rows);
    const top = query.top ?? 50;
    return {
      account: accountHeader(link),
      period: { from: period.from ?? null, to: period.to ?? null, status: period.status },
      fetchedAt,
      derived: true,
      complete,
      lines: rows.length,
      totals: summarize(rows),
      counterparties: groups.slice(0, top),
      ...(groups.length > top ? { counterpartiesNotShown: groups.length - top } : {}),
    };
  }

  /** Lines that match a text or an amount across this company's accounts: computed here from the bank's lines. */
  async search(query: TransactionQuery & { accounts?: string[] }) {
    const period = this.period({ ...query, strategy: 'default' });
    const filter = this.filter(query);
    if (!filter.search && !filter.direction && !filter.minAmount && !filter.maxAmount) {
      throw new ProblemError('invalid_input', 'Give at least one of search, minAmount, maxAmount and direction.');
    }
    const company = this.companyInfo();
    // Named accounts are resolved against this company's registry first: an unknown one stops the search.
    const wanted = query.accounts?.length
      ? [...new Map(query.accounts.map(reference => this.registry.resolve(this.company, reference)).map(account => [account.id, account])).values()]
      : company.accounts;
    const accounts: Array<{ account: string; read: boolean; lines?: number; matches?: number; complete?: boolean; problem?: ProblemCode; reason?: string }> = [];
    const matches: Array<TransactionView & { account: string }> = [];
    let fetchedAt: string | undefined;
    let stopped: ProblemCode | undefined;
    for (const account of wanted) {
      if (stopped) {
        // The bank allows no more reads: the remaining accounts are not asked.
        accounts.push({ account: account.id, read: false, problem: stopped });
        continue;
      }
      try {
        const link = this.linked(account.id);
        const read = await this.lines(link, period);
        const found = read.rows.filter(row => matchesLine(row, filter));
        for (const row of found) matches.push({ account: account.id, ...row });
        accounts.push({ account: account.id, read: true, lines: read.rows.length, matches: found.length, complete: read.complete });
        if (!fetchedAt || read.fetchedAt < fetchedAt) fetchedAt = read.fetchedAt;
      } catch (error) {
        const problem = problemOf(error) ?? 'upstream_error';
        accounts.push({ account: account.id, read: false, problem, reason: formatUnknownError(error) });
        if (problem === 'rate_limited') stopped = problem;
      }
    }
    matches.sort(newestFirst);
    const limit = query.limit ?? 100;
    const shown = matches.slice(0, limit);
    return {
      period: { from: period.from ?? null, to: period.to ?? null, status: period.status },
      ...(fetchedAt ? { fetchedAt } : {}),
      derived: true,
      // True only when every account was read to the end of the period.
      complete: accounts.every(entry => entry.read && entry.complete),
      accounts,
      count: matches.length,
      returned: shown.length,
      truncated: matches.length > shown.length,
      totals: summarize(shown),
      transactions: shown,
    };
  }

  /** Each stored consent as Enable Banking holds it now. Not a read at the bank. */
  async consentStatus() {
    const company = this.companyInfo();
    const now = this.now();
    const consents = [];
    for (const session of this.store.sessions()) {
      const base = {
        consent: session.key,
        bank: session.aspsp.name,
        country: session.aspsp.country,
        psuType: session.psuType,
        accounts: company.accounts.filter(account => session.accounts.some(bound => bound.iban === account.iban)).map(account => account.id),
      };
      try {
        const status = await this.client.getSession(session.sessionId);
        const covered = new Set(Array.isArray(status.accounts) ? status.accounts : []);
        const validUntil = typeof status.access?.valid_until === 'string' ? status.access.valid_until : session.validUntil;
        const until = Date.parse(validUntil);
        consents.push({
          ...base,
          status: typeof status.status === 'string' ? status.status : null,
          validUntil,
          expiresInDays: Number.isNaN(until) ? null : Math.floor((until - now) / DAY_MS),
          authorizedAt: typeof status.authorized === 'string' ? status.authorized : null,
          // Registered accounts the stored consent bound that Enable Banking no longer lists in the session.
          noLongerCovered: company.accounts
            .filter(account => session.accounts.some(bound => bound.iban === account.iban && !covered.has(bound.uid)))
            .map(account => account.id),
          access: {
            balances: typeof status.access?.balances === 'boolean' ? status.access.balances : null,
            transactions: typeof status.access?.transactions === 'boolean' ? status.access.transactions : null,
          },
        });
      } catch (error) {
        consents.push({ ...base, status: null, validUntil: session.validUntil, problem: problemOf(error) ?? 'upstream_error', reason: formatUnknownError(error) });
      }
    }
    return { company: company.name, checkedAt: new Date(now).toISOString(), consents };
  }

  // ---------------------------------------------------------------- consent

  async listBanks(country?: string, psuType?: 'business' | 'personal') {
    const banks = await this.client.listAspsps(country ? country.toUpperCase() : undefined, psuType);
    return banks.map(bankSummary);
  }

  async startConsent(input: {
    user: string;
    bank: string;
    country: string;
    psuType: 'business' | 'personal';
    validDays: number;
    language?: string;
    /** One of the bank's authMethods (by name), when it offers several. */
    authMethod?: string;
    /** False: never ask the person for the extra approval some banks need for history older than 90 days. */
    extendedHistory?: boolean;
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
    const methods = (bank.auth_methods ?? []).filter(method => !method.psu_type || method.psu_type === input.psuType);
    if (input.authMethod && !methods.some(method => method.name === input.authMethod)) {
      throw new ConsentError(
        `${bank.name} offers no sign-in method named "${input.authMethod}" to ${input.psuType} customers` +
          (methods.length > 0 ? ` (it offers ${methods.map(method => method.name).join(', ')})` : ''),
        'invalid_input',
      );
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
      ...(input.authMethod ? { authMethod: input.authMethod } : {}),
      ...(input.extendedHistory === undefined ? {} : { extendedHistory: input.extendedHistory }),
    });
    const company = this.companyInfo();
    return {
      company: company.name,
      bank: bank.name,
      psuType: input.psuType,
      validDays,
      url: auth.url,
      expiresAt: new Date(expiresAt).toISOString(),
      next: this.options.consentCallback
        ? `Open the URL and sign in at the bank as someone authorised for ${company.name} (CVR ${company.cvr}) within 30 minutes. ` +
          'The bank then returns to a confirmation page that completes the consent and lists the accounts bound; nothing ' +
          'needs to be copied. Afterwards enablebanking_list_accounts shows the result. Only accounts registered to ' +
          `${company.name} in the account registry become readable; everything else in the consent is discarded.`
        : `Open the URL and sign in at the bank as someone authorised for ${company.name} (CVR ${company.cvr}). ` +
          `You land on ${this.options.redirectUrl}; copy the WHOLE address from the browser and pass it to ` +
          'enablebanking_complete_consent within 30 minutes. Only accounts registered to ' +
          `${company.name} in the account registry become readable; everything else in the consent is discarded.`,
    };
  }

  /** Complete from the address the admin pasted; the admin must be the one who started it. */
  async completeConsent(input: { user: string; redirectUrl: string }): Promise<BindingReport> {
    return (await this.finishConsent(input.redirectUrl, input.user.toLowerCase())).report;
  }

  /**
   * Complete from the bank's redirect arriving at this server. There is no
   * signed-in user on that request: the HMAC-signed, single-use, 30-minute
   * state names who started the consent and for which company, and the code
   * is worthless without this application's private key.
   */
  async completeConsentCallback(redirectUrl: string): Promise<{ report: BindingReport; user: string }> {
    return this.finishConsent(redirectUrl, null);
  }

  private async finishConsent(redirectUrl: string, expectedUser: string | null): Promise<{ report: BindingReport; user: string }> {
    let url: URL;
    try {
      url = new URL(redirectUrl.trim());
    } catch {
      throw new ConsentError('pass the full address you landed on after the bank\u2019s sign-in (it contains ?code=…&state=…)', 'invalid_input');
    }
    const bankError = url.searchParams.get('error');
    if (bankError) {
      throw new ConsentError(`the bank did not grant the consent: ${bankError} ${url.searchParams.get('error_description') ?? ''}`.trim());
    }
    const code = url.searchParams.get('code');
    const rawState = url.searchParams.get('state');
    if (!code || !rawState) throw new ConsentError('the address has no code/state; copy it again from the browser');

    let state: ConsentState;
    try {
      state = this.store.verifyState(rawState);
    } catch (error) {
      throw new ConsentError(error instanceof Error ? error.message : 'the consent state is invalid');
    }
    if (state.company !== this.company) {
      throw new ConsentError(`this consent was started for company ${state.company}, not ${this.company}; complete it on that company's endpoint`);
    }
    if (expectedUser !== null && state.user !== expectedUser) {
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
      return { report: this.report(state.aspsp.name, '(revoked)', binding), user: state.user };
    }
    const session: StoredSession = {
      key: sessionKey(state.aspsp, state.psuType),
      sessionId: created.session_id,
      aspsp: state.aspsp,
      psuType: state.psuType,
      validUntil: created.access?.valid_until || state.validUntil,
      createdAt: new Date(this.now()).toISOString(),
      createdBy: state.user,
      accounts: binding.bound,
      excluded: binding.excluded,
    };
    const replaced = this.store.upsert(session);
    if (replaced && replaced.sessionId !== session.sessionId) {
      await this.client.deleteSession(replaced.sessionId).catch(() => undefined);
    }
    this.cache.clear();
    return { report: this.report(state.aspsp.name, session.validUntil, binding), user: state.user };
  }

  /**
   * Re-read the accounts behind an existing consent and bind them against the
   * registry as it is NOW — after an admin registered an account the consent
   * already covered, no new sign-in at the bank is needed.
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
    // Counted before anything is sent: a read over the day's budget is refused here, not at the bank.
    const decision = this.budget.take(link.session.sessionId);
    if (!decision.ok) throw new ProblemError('unattended_limit', budgetRefusal(decision));
    try {
      return await fn();
    } catch (error) {
      if (error instanceof EnableBankingHttpError && error.consentLost) {
        // Nothing read under a consent is served once Enable Banking says the consent is gone.
        this.cache.clear();
        throw new ConsentError(
          `${link.session.aspsp.name} refused the consent for ${this.companyInfo().name} (${error.message}). ` +
            'It may have been revoked at the bank or expired; an administrator must renew it with enablebanking_start_consent.',
          error.problem,
        );
      }
      // The bank says its limit is reached: no further read for this consent until the pause is over.
      if (problemOf(error) === 'rate_limited') this.budget.block(link.session.sessionId);
      throw error;
    }
  }

  /**
   * Short cache per account and query. Banks may cap reads that the account
   * holder is not present for (PSD2: as few as 4 per account per day), so the
   * same question asked twice in a conversation must not cost two bank calls.
   *
   * What keeps a cached answer within its authority:
   * - Every key starts with the bank's uid of one account in one stored
   *   consent, and a caller only gets a uid from `linked()`, which resolves
   *   the account through this company's registry and stored consent on every
   *   call. An account taken out of the registry, and a consent past its
   *   date, is refused before the cache is looked at.
   * - A new consent has new uids, so answers of an old one cannot be reached.
   *   The cache is also emptied whenever a consent is completed, refreshed or
   *   revoked here, and when Enable Banking answers that a consent is gone.
   * - What is kept is what the bank answered for that account (balances,
   *   details, lines of a period), never a finished tool answer, so a tool
   *   reads only its own kind of data. An error is never kept.
   * - Not covered: a consent revoked at the bank is noticed at the next read
   *   at the bank, so an earlier answer can be repeated for up to cacheMs.
   */
  private async cached<T>(key: string, load: () => Promise<T>): Promise<{ value: T; fetchedAt: string }> {
    const hit = this.cacheMs > 0 ? this.cache.get(key) : undefined;
    if (hit && hit.expires > this.now()) return { value: hit.value as T, fetchedAt: hit.fetchedAt };
    const value = await load();
    // When the bank was read: an answer from the cache says how old it is.
    const fetchedAt = new Date(this.now()).toISOString();
    if (this.cacheMs > 0) this.cache.set(key, { expires: this.now() + this.cacheMs, fetchedAt, value });
    return { value, fetchedAt };
  }
}

/** A bank as the bank list shows it. Sandbox test users of the raw answer are not passed on. */
function bankSummary(bank: Aspsp) {
  const seconds = typeof bank.maximum_consent_validity === 'number' && bank.maximum_consent_validity > 0 ? bank.maximum_consent_validity : null;
  return {
    name: bank.name,
    country: bank.country,
    bic: bank.bic ?? null,
    psuTypes: bank.psu_types ?? [],
    maxConsentDays: seconds === null ? null : Math.floor(seconds / 86_400),
    // A new integration; usable as any other.
    beta: bank.beta ?? false,
    group: bank.group?.name ?? null,
    authMethods: (bank.auth_methods ?? []).map(method => ({
      name: method.name ?? null,
      title: method.title ?? null,
      psuType: method.psu_type ?? null,
      approach: method.approach ?? null,
    })),
    // Headers a bank requires before it counts a read as one a person asked for. This server sends none: it does
    // not see the person's browser, so every read here counts as a background read at the bank.
    requiredPsuHeaders: bank.required_psu_headers ?? [],
  };
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
