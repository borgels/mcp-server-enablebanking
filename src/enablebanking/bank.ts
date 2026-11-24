import { randomBytes } from 'node:crypto';
import { EnableBankingHttpError, formatUnknownError } from '../errors.js';
import { budgetRefusal, UnattendedBudget } from './budget.js';
import type { AccountResource, Aspsp, EnableBankingClient, SessionStatus, TransactionResource } from './client.js';
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
import { problemFromSessionStatus, problemOf, ProblemError, type ProblemCode } from './problems.js';
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
 * which checks the registry (now, not at consent time), the consent expiry
 * and what this server has learned about the consent since it was stored,
 * before an account uid is ever handed to the client.
 *
 * No answer from the bank is kept between calls, not even briefly in memory:
 * every read asks the bank, and what it answers is passed on and forgotten.
 * The bank's limit on reads nobody is present for is met by the unattended
 * budget (ENABLEBANKING_UNATTENDED_FETCHES_PER_DAY), not by a cache.
 *
 * The invariant of read access:
 *
 *   An answer is returned only for an account whose consent this server has
 *   no word against at the moment the answer is returned. The moment any
 *   answer from Enable Banking says a consent is over, or that an account has
 *   left it, reads of it are refused here, until Enable Banking shows it in
 *   order again or a new consent is completed.
 *
 * Calls run side by side. When the bank answers, the account is resolved
 * anew from the store and must still be the same account of the same consent,
 * without a word against it, or the answer is dropped. An answer put together
 * from several reads (a search over several accounts) is checked the same way
 * for every account in it once the last read is done, and what an account gave
 * is dropped from it when its consent or the account was withdrawn meanwhile.
 *
 * Every binding has a version (`versions`, by session id) that every
 * withdrawal, refresh, replacement and revocation raises. A word against a
 * consent or an account (ended, expired, revoked, an account no longer
 * listed) is acted on whenever it arrives, whatever the version. What lifts a
 * word against a consent or binds accounts to it (a status answer in order, a
 * refresh) is acted on only when the version has not moved while Enable
 * Banking was asked: a withdrawal learned meanwhile is newer and wins.
 *
 * Every way this server can learn it ends in `withdraw` or `withdrawAccount`:
 * - a read at the bank that fails with an ended consent or a missing account
 *   (`call`), from any tool;
 * - the consent status tool: an error for the session, a status that is not
 *   AUTHORIZED, a date that has passed, an account no longer listed
 *   (`learn`);
 * - refreshing a consent: the same, before anything is bound (`learn`);
 * - revoking or replacing a consent here (`forget`);
 * - the bank answering with another account than the registered one.
 * A refusal that speaks of the application or of access in general, not of
 * the consent, leaves read access as it is: the next read asks the bank again.
 */
export class Bank {
  readonly company: string;
  private readonly client: EnableBankingClient;
  private readonly registry: AccountRegistry;
  private readonly store: SessionStore;
  /** Consents (by session id) Enable Banking no longer honours, with why. In memory only. */
  private readonly lostConsents = new Map<string, ProblemCode>();
  /** Accounts (by the bank's uid) that have left their consent, with why. */
  private readonly lostAccounts = new Map<string, ProblemCode>();
  /** The version of each consent's binding (by session id): raised by every withdrawal, refresh, replacement and revocation. */
  private readonly versions = new Map<string, number>();
  private readonly budget: UnattendedBudget;
  private readonly now: () => number;

  constructor(private readonly options: BankOptions) {
    this.company = options.company;
    this.client = options.client;
    this.registry = options.registry;
    this.store = options.store;
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
        const uid = session?.accounts.find(bound => bound.iban === account.iban)?.uid;
        // What this server has learned since the consent was stored: ended, or without this account.
        const ended = session !== undefined && (this.lostConsents.has(session.sessionId) || (uid !== undefined && this.lostAccounts.has(uid)));
        return {
          id: account.id,
          iban: account.iban,
          name: account.name,
          bank: account.bank ?? session?.aspsp.name ?? null,
          // The registry's currency, else what the bank said when the consent was bound. Never assumed.
          currency: account.currency ?? session?.accounts.find(bound => bound.iban === account.iban)?.currency ?? null,
          ledgerAccount: account.ledgerAccount ?? null,
          status: !session ? 'no_consent' : expiresInDays !== null && expiresInDays < 0 ? 'consent_expired' : ended ? 'consent_ended' : 'linked',
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
    const link = { account, session, uid: bound.uid };
    this.standing(link);
    return link;
  }

  /** Throws when this server has learned that the consent is over or that the account has left it. */
  private standing(link: LinkedAccount): void {
    const { account, session } = link;
    const lost = this.lostConsents.get(session.sessionId);
    if (lost) {
      throw new ConsentError(
        `Enable Banking no longer honours the ${session.aspsp.name} consent for ${this.companyInfo().name}. ` +
          'An administrator must renew it with enablebanking_start_consent; enablebanking_get_consent_status shows how it stands now.',
        lost,
      );
    }
    const gone = this.lostAccounts.get(link.uid);
    if (gone) {
      throw new ConsentError(
        `${account.name} (${maskIban(account.iban)}) is no longer part of the ${session.aspsp.name} consent for ${this.companyInfo().name}. ` +
          'An administrator must renew the consent with enablebanking_start_consent; enablebanking_get_consent_status shows how it stands now.',
        gone,
      );
    }
  }

  async balances(reference: string) {
    const link = this.linked(reference);
    const read = await this.read(link, () => this.client.getBalances(link.uid));
    return { account: accountHeader(link), fetchedAt: read.fetchedAt, balances: read.value.map(balanceView) };
  }

  async details(reference: string) {
    const link = this.linked(reference);
    const read = await this.read(link, () => this.client.getAccountDetails(link.uid));
    // Belt and braces: the bank must still say this uid is the registered IBAN.
    const iban = ibanOf(read.value);
    if (iban && iban !== link.account.iban) {
      // What is behind this uid is not this company's account: it is not read again.
      this.withdrawAccount(link.session, link.uid, 'account_not_connected');
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

  /** Every line of a period as the bank gave it, read for this call only. */
  private async lines(link: LinkedAccount, period: ReturnType<Bank['period']>) {
    const read = await this.read(link, () =>
      this.client.listTransactions(link.uid, {
        ...(period.from ? { dateFrom: period.from } : {}),
        ...(period.to ? { dateTo: period.to } : {}),
        ...(period.status === 'booked' ? { status: 'BOOK' as const } : period.status === 'pending' ? { status: 'PDNG' as const } : {}),
        ...(period.strategy === 'longest' ? { strategy: 'longest' as const } : {}),
      }),
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
    const { value: raw, fetchedAt } = await this.read(link, () => this.client.getTransaction(link.uid, transaction));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ProblemError('transaction_not_found', 'The bank has no further details for that transaction.');
    }
    return { account: accountHeader(link), fetchedAt, transaction: transactionView(raw) };
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
    // What each account that could be read gave, kept apart until every account has been asked.
    const read: Array<{ at: number; link: LinkedAccount; found: TransactionView[]; fetchedAt: string }> = [];
    let stopped: ProblemCode | undefined;
    for (const account of wanted) {
      if (stopped) {
        // The bank allows no more reads: the remaining accounts are not asked.
        accounts.push({ account: account.id, read: false, problem: stopped });
        continue;
      }
      try {
        const link = this.linked(account.id);
        const lines = await this.lines(link, period);
        const found = lines.rows.filter(row => matchesLine(row, filter));
        read.push({ at: accounts.length, link, found, fetchedAt: lines.fetchedAt });
        accounts.push({ account: account.id, read: true, lines: lines.rows.length, matches: found.length, complete: lines.complete });
      } catch (error) {
        const problem = problemOf(error) ?? 'upstream_error';
        accounts.push({ account: account.id, read: false, problem, reason: formatUnknownError(error) });
        if (problem === 'rate_limited') stopped = problem;
      }
    }
    // The accounts were read one after another: a consent revoked, or an account withdrawn, while a later account was
    // read is known now. Every account is checked again before anything it gave is returned; what an account that no
    // longer stands gave is dropped, and the account is shown as not read, with why.
    const matches: Array<TransactionView & { account: string }> = [];
    let fetchedAt: string | undefined;
    for (const { at, link, found, fetchedAt: when } of read) {
      try {
        this.confirm(link);
      } catch (error) {
        accounts[at] = { account: link.account.id, read: false, problem: problemOf(error) ?? 'consent_not_active', reason: formatUnknownError(error) };
        continue;
      }
      for (const row of found) matches.push({ account: link.account.id, ...row });
      if (!fetchedAt || when < fetchedAt) fetchedAt = when;
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
    const consents: Array<Record<string, unknown>> = [];
    const checked: Array<{ at: number; session: StoredSession; version: number }> = [];
    for (const session of this.store.sessions()) {
      const base = {
        consent: session.key,
        bank: session.aspsp.name,
        country: session.aspsp.country,
        psuType: session.psuType,
        accounts: company.accounts.filter(account => session.accounts.some(bound => bound.iban === account.iban)).map(account => account.id),
      };
      try {
        const asked = this.version(session.sessionId);
        const status = await this.sessionAt(session);
        // What the answer says about the consent is acted on before it is shown: an ended consent, and an account
        // that has left it, is no longer read. A word against it learned while this answer was on its way is newer
        // and is not lifted by it.
        const unchanged = this.version(session.sessionId) === asked;
        const problem = this.learn(session, status, this.now(), unchanged);
        // An answer in order is shown as it is only when nothing changed here since it was asked (checked below).
        if (!problem) checked.push({ at: consents.length, session, version: unchanged ? this.version(session.sessionId) : -1 });
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
    // An answer in order for a consent that was withdrawn, revoked, replaced or refreshed here while its answer, or a
    // later consent's, was on its way is not shown as Enable Banking gave it, but as changed, with why.
    for (const { at, session, version } of checked) {
      if (this.version(session.sessionId) === version) continue;
      consents[at] = {
        ...consents[at],
        status: null,
        problem: this.lostConsents.get(session.sessionId) ?? 'consent_not_active',
        reason: 'The consent changed here while its status was being checked; ask again.',
      };
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
    if (replaced) this.forget(replaced);
    if (replaced && replaced.sessionId !== session.sessionId) {
      await this.client.deleteSession(replaced.sessionId).catch(() => undefined);
    }
    this.forget(session);
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
    const asked = this.version(session.sessionId);
    const status = await this.sessionAt(session);
    // A word against the consent in this answer (over, expired, an account no longer listed) is acted on whatever
    // happened while Enable Banking was asked. Only lifting and binding wait on the version: something learned about
    // the consent meanwhile is newer than an answer in order.
    const unchanged = this.version(session.sessionId) === asked;
    // Nothing is bound to a consent Enable Banking no longer honours.
    const problem = this.learn(session, status, this.now(), unchanged);
    if (problem) {
      throw new ConsentError(
        `Enable Banking no longer honours the ${session.aspsp.name} consent for ${this.companyInfo().name}. ` +
          'An administrator must renew it with enablebanking_start_consent.',
        problem,
      );
    }
    if (!unchanged) throw this.changedMeanwhile(session);
    const learned = this.version(session.sessionId);
    const details: AccountResource[] = [];
    for (const uid of Array.isArray(status.accounts) ? status.accounts : []) {
      try {
        details.push({ ...(await this.client.getAccountDetails(uid)), uid });
      } catch (error) {
        this.failed(session, uid, error);
        throw error;
      }
    }
    // While the accounts were read, the consent may have been withdrawn, revoked or replaced, or an account may have
    // left it: what was learned meanwhile wins, and this refresh binds nothing and lifts nothing.
    const current = this.store.sessions().find(candidate => candidate.key === consent);
    if (this.version(session.sessionId) !== learned || current?.sessionId !== session.sessionId) throw this.changedMeanwhile(session);
    const binding = this.bind(details);
    this.store.upsert({
      ...session,
      validUntil: status.access?.valid_until ?? session.validUntil,
      accounts: binding.bound,
      excluded: binding.excluded,
    });
    // The binding is new: it starts without a word against it, and reads begun under the old one are checked anew.
    this.forget(session);
    return this.report(session.aspsp.name, status.access?.valid_until ?? session.validUntil, binding);
  }

  /** A refresh that lost the race to something learned about the consent meanwhile. Nothing was bound. */
  private changedMeanwhile(session: StoredSession): ConsentError {
    return new ConsentError(
      `The ${session.aspsp.name} consent for ${this.companyInfo().name} changed while it was being refreshed; nothing was bound. ` +
        'enablebanking_get_consent_status shows how it stands now; refresh again if it is in order.',
      this.lostConsents.get(session.sessionId) ?? 'consent_not_active',
    );
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
    this.forget(session);
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
      // What the failure says about the consent or the account is acted on first, whatever tool asked.
      this.failed(link.session, link.uid, error);
      if (error instanceof EnableBankingHttpError && error.consentLost) {
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

  // ------------------------------------------------------- what was learned

  /** The session as Enable Banking holds it. A failure that says the consent is over is acted on before it is thrown. */
  private async sessionAt(session: StoredSession): Promise<SessionStatus> {
    try {
      return await this.client.getSession(session.sessionId);
    } catch (error) {
      this.failed(session, undefined, error);
      throw error;
    }
  }

  /**
   * Acts on what Enable Banking answered for a session. Returns the problem
   * when the consent is over, undefined while it is authorised and in date.
   * Then the accounts it no longer lists are withdrawn one by one, and the
   * rest stand without a word against them again, but only when `lift`: no
   * word against the consent was learned while this answer was on its way.
   * A withdrawal is always acted on.
   */
  private learn(session: StoredSession, status: SessionStatus | undefined, now: number, lift: boolean): ProblemCode | undefined {
    const state = typeof status?.status === 'string' ? status.status : undefined;
    const until = typeof status?.access?.valid_until === 'string' ? Date.parse(status.access.valid_until) : Number.NaN;
    const problem = state !== 'AUTHORIZED' ? problemFromSessionStatus(state) : until <= now ? 'consent_expired' : undefined;
    if (problem) {
      this.withdraw(session, problem);
      return problem;
    }
    // An answer without a list of accounts covers none. An account it does not list is withdrawn, also one a refresh
    // bound to the same consent while this answer was on its way: a word against an account is never ignored.
    const covered = new Set(Array.isArray(status?.accounts) ? status.accounts : []);
    const stored = this.store.sessions().find(candidate => candidate.sessionId === session.sessionId);
    for (const uid of new Set([...session.accounts, ...(stored?.accounts ?? [])].map(bound => bound.uid))) {
      if (!covered.has(uid)) this.withdrawAccount(session, uid, 'account_not_in_consent');
    }
    if (lift) {
      this.lostConsents.delete(session.sessionId);
      for (const bound of session.accounts) if (covered.has(bound.uid)) this.lostAccounts.delete(bound.uid);
    }
    return undefined;
  }

  /** Acts on a failed request at Enable Banking, for a consent and (when the request was for one) an account. */
  private failed(session: StoredSession, uid: string | undefined, error: unknown): void {
    const problem = problemOf(error);
    if (problem === 'consent_expired' || problem === 'consent_revoked' || problem === 'consent_not_active') {
      this.withdraw(session, problem);
    } else if (problem === 'account_not_in_consent') {
      if (uid === undefined) this.withdraw(session, problem);
      else this.withdrawAccount(session, uid, problem);
    }
    // Anything else (the bank refuses one account for now, the application is refused, the bank is down) says
    // nothing about the consent: nothing is kept that could answer for it, and the next read asks the bank again.
  }

  /** The consent is over: it is not read, and no answer under it is returned, until it is seen in order again. */
  private withdraw(session: StoredSession, problem: ProblemCode): void {
    this.lostConsents.set(session.sessionId, problem);
    this.raise(session.sessionId);
  }

  /** The account has left its consent: it is not read, and no answer from it is returned. */
  private withdrawAccount(session: StoredSession, uid: string, problem: ProblemCode): void {
    this.lostAccounts.set(uid, problem);
    this.raise(session.sessionId);
  }

  /**
   * A consent stored anew, refreshed, replaced or removed here: what was held against it is dropped, and a read
   * that began under the old binding is checked against the store before its answer is returned.
   */
  private forget(session: StoredSession): void {
    this.lostConsents.delete(session.sessionId);
    for (const bound of session.accounts) this.lostAccounts.delete(bound.uid);
    this.raise(session.sessionId);
  }

  private version(sessionId: string): number {
    return this.versions.get(sessionId) ?? 0;
  }

  private raise(sessionId: string): void {
    this.versions.set(sessionId, this.version(sessionId) + 1);
  }

  /**
   * One read at the bank for one account, for this call only: nothing of the
   * answer is kept. Calls run side by side, so the answer is returned only
   * when, at the moment it arrives, the account is still bound as it was when
   * the read began and nothing stands against it (the invariant at the top of
   * this class). When the binding's version moved meanwhile, the account is
   * resolved anew from the store: revoked, replaced, refreshed without it,
   * bound to another uid, expired or withdrawn, and the answer is dropped.
   */
  private async read<T>(link: LinkedAccount, load: () => Promise<T>): Promise<{ value: T; fetchedAt: string }> {
    const value = await this.call(link, load);
    this.confirm(link);
    return { value, fetchedAt: new Date(this.now()).toISOString() };
  }

  /**
   * Throws unless the account still stands as it did when it was read: resolved anew from the registry and the
   * store, the same account of the same consent under the same uid, in date, and without a word against it.
   */
  private confirm(link: LinkedAccount): void {
    const now = this.linked(link.account.id);
    if (now.session.sessionId !== link.session.sessionId || now.uid !== link.uid) {
      throw new ConsentError(
        `The ${link.session.aspsp.name} consent for ${link.account.name} (${maskIban(link.account.iban)}) changed while the bank was read; ` +
          'the answer was dropped. Ask again.',
        'consent_not_active',
      );
    }
    this.standing(link);
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
