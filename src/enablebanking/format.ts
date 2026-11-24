import type {
  AccountIdentification,
  AccountResource,
  Amount,
  BalanceResource,
  FinancialInstitutionIdentification,
  GenericIdentification,
  PostalAddress,
  TransactionResource,
} from './api.js';
import { absDecimal, addDecimal, formatDecimal, parseDecimal, type Decimal } from './decimal.js';
import { normalizeIban } from './registry.js';

/**
 * How bank data is shown. One shape for the standalone server and the
 * embedded gateway. Nothing is invented: a field the bank did not give is
 * null or left out, an amount keeps the bank's precision, and a date stays
 * the bank's calendar date.
 */

/** An identifier in a scheme other than IBAN (BBAN, a Swedish Bankgiro number, a masked card number). */
export interface IdentifierView {
  /** The scheme as the API names it, e.g. IBAN, BBAN, BGNR, PGNR, CPAN, MIBN. */
  scheme: string;
  identification: string;
  issuer?: string;
}

export interface AgentView {
  bic?: string;
  name?: string;
  clearingSystem?: string;
  clearingMemberId?: string;
}

export interface TransactionView {
  /** The best stable key the line has: the bank's entry reference, else the details id, else a composite of the line. */
  reference: string;
  /** The bank's entry reference: unique and unchanging for the account. Null when the bank gives none (often for pending lines). */
  entryReference: string | null;
  /** For the transaction details tool only; it is not a stable key and may change between listings. */
  detailsId?: string;
  bookingDate: string | null;
  valueDate: string | null;
  /** When the transaction itself took place, e.g. the card purchase. */
  transactionDate?: string;
  /** Signed decimal string in the bank's precision: negative left the account. Never a float. */
  amount: string;
  /** ISO 4217. Null when the bank gave none. */
  currency: string | null;
  direction: 'in' | 'out';
  /** BOOK booked, PDNG pending, HOLD reserved, SCHD scheduled, CNCL cancelled, RJCT rejected, OTHR other. */
  status: string;
  counterparty: string | null;
  counterpartyIban: string | null;
  /** The counterparty's account in another scheme than IBAN, and any further identifiers the bank gave. */
  counterpartyAccounts?: IdentifierView[];
  /** A company identifier of the counterparty (organisation id), when the bank gives one. */
  counterpartyOrganisationId?: IdentifierView;
  counterpartyAddress?: string;
  counterpartyBank?: AgentView;
  /** The remittance lines and the reference number as one text. */
  text: string;
  /** The unstructured remittance lines exactly as the bank gave them. */
  remittance: string[];
  /** The structured payment reference (a creditor reference, a Bankgiro OCR, a SEPA mandate id). */
  referenceNumber?: string;
  /** BERF Belgian, FIRF Finnish, INTL international (RF), NORF Norwegian KID, SDDM SEPA mandate id, SEBG Swedish Bankgiro OCR. */
  referenceNumberSchema?: string;
  /** The bank's own wording or code for the kind of transaction. */
  bankCode?: string;
  bankTransactionCode?: { description?: string; code?: string; subCode?: string };
  /** ISO 18245 category of the merchant (card purchases). */
  merchantCategoryCode?: string;
  exchangeRate?: {
    unitCurrency?: string;
    rate?: string;
    /** AGRD agreed, SALE sale, SPOT spot. */
    rateType?: string;
    contractId?: string;
    instructedAmount?: string;
    instructedCurrency?: string;
  };
  balanceAfter?: string;
  balanceAfterCurrency?: string;
  /** The account holder's own note on the line. */
  note?: string;
}

const MAX_TEXT = 2_000;

/** A text from the bank: a non-empty string of at most MAX_TEXT characters, trimmed. Anything else is left out. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_TEXT ? trimmed : undefined;
}

/** Leaves out the fields that are undefined, and the object itself when nothing is left. */
function compact<T extends object>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

/**
 * The amount without its sign, in the bank's own precision. A value that is
 * not a decimal is kept as the bank wrote it rather than replaced.
 */
function magnitude(value: unknown): { shown: string; decimal: Decimal | null } {
  const decimal = parseDecimal(value);
  if (decimal) return { shown: formatDecimal(absDecimal(decimal)), decimal: absDecimal(decimal) };
  return { shown: typeof value === 'string' ? value.trim().replace(/^[+-]/, '') : '', decimal: null };
}

/**
 * The bank's calendar date as YYYY-MM-DD, or null. The date is kept as the
 * bank gave it, never converted between time zones: a value that starts
 * with a valid YYYY-MM-DD (alone or followed by a time) keeps that date, so
 * `2026-11-02T00:30:00+01:00` is 2 November. Anything else is null.
 */
function isoDay(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(value);
  if (!match) return null;
  const day = match[1]!;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null;
}

/** Card numbers are never shown whole: the last four digits only. */
function maskCard(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? `…${digits.slice(-4)}` : '…';
}

/** An identifier in a named scheme. A card number (CPAN) is masked whatever the bank sent. */
export function identifierView(value: GenericIdentification | null | undefined): IdentifierView | undefined {
  const identification = text(value?.identification);
  if (!identification) return undefined;
  const scheme = text(value?.scheme_name) ?? 'OTHR';
  const issuer = text(value?.issuer);
  return {
    scheme,
    identification: scheme === 'CPAN' ? maskCard(identification) : scheme === 'IBAN' ? normalizeIban(identification) : identification,
    ...(issuer ? { issuer } : {}),
  };
}

function sameIdentifier(a: IdentifierView, b: IdentifierView): boolean {
  return a.scheme === b.scheme && a.identification === b.identification;
}

/** Every identifier of an account, IBAN first, without repeats. */
export function identifiersOf(
  account: AccountIdentification | null | undefined,
  further: GenericIdentification[] | null | undefined,
): IdentifierView[] {
  const found: IdentifierView[] = [];
  const add = (candidate: IdentifierView | undefined) => {
    if (candidate && !found.some(existing => sameIdentifier(existing, candidate))) found.push(candidate);
  };
  const iban = text(account?.iban);
  if (iban) add({ scheme: 'IBAN', identification: normalizeIban(iban) });
  add(identifierView(account?.other));
  for (const entry of Array.isArray(further) ? further : []) add(identifierView(entry));
  return found;
}

export function agentView(agent: FinancialInstitutionIdentification | null | undefined): AgentView | undefined {
  return compact({
    bic: text(agent?.bic_fi),
    name: text(agent?.name),
    clearingSystem: text(agent?.clearing_system_member_id?.clearing_system_id),
    clearingMemberId: text(agent?.clearing_system_member_id?.member_id),
  });
}

/** A postal address on one line, in the order the API lists its parts. */
export function addressLine(address: PostalAddress | null | undefined): string | undefined {
  if (!address || typeof address !== 'object') return undefined;
  const lines = Array.isArray(address.address_line) ? address.address_line.map(text) : [];
  const street = [text(address.street_name), text(address.building_number)].filter(Boolean).join(' ');
  const town = [text(address.post_code), text(address.town_name)].filter(Boolean).join(' ');
  const parts = [text(address.department), text(address.sub_department), ...lines, street, town, text(address.country_sub_division), text(address.country)];
  const line = parts.filter(Boolean).join(', ');
  return line && line.length <= MAX_TEXT ? line : undefined;
}

function amountOf(value: Amount | null | undefined): { amount?: string; currency?: string } {
  const decimal = parseDecimal(value?.amount);
  return { amount: decimal ? formatDecimal(decimal) : text(value?.amount), currency: text(value?.currency) };
}

/**
 * One bank line. `assumedStatus` is used only when the bank left the status
 * out of a line it returned for a request that asked for that status.
 */
export function transactionView(row: TransactionResource, assumedStatus?: string): TransactionView {
  const debit = row.credit_debit_indicator === 'DBIT';
  const { shown, decimal } = magnitude(row.transaction_amount?.amount);
  const zero = decimal !== null && decimal.units === 0n;
  const remittance = Array.isArray(row.remittance_information)
    ? row.remittance_information.filter((line): line is string => typeof line === 'string')
    : [];
  const bookingDate = isoDay(row.booking_date);
  const party = debit ? row.creditor : row.debtor;
  const account = debit ? row.creditor_account : row.debtor_account;
  const further = debit ? row.creditor_account_additional_identification : row.debtor_account_additional_identification;
  const identifiers = identifiersOf(account, further);
  const iban = identifiers.find(identifier => identifier.scheme === 'IBAN');
  const others = identifiers.filter(identifier => identifier !== iban);
  const entryReference = text(row.entry_reference) ?? null;
  const detailsId = text(row.transaction_id);
  const referenceNumber = text(row.reference_number);
  const code = compact({
    description: text(row.bank_transaction_code?.description),
    code: text(row.bank_transaction_code?.code),
    subCode: text(row.bank_transaction_code?.sub_code),
  });
  const instructed = amountOf(row.exchange_rate?.instructed_amount);
  const exchangeRate = compact({
    unitCurrency: text(row.exchange_rate?.unit_currency),
    rate: text(row.exchange_rate?.exchange_rate),
    rateType: text(row.exchange_rate?.rate_type),
    contractId: text(row.exchange_rate?.contract_identification),
    instructedAmount: instructed.amount,
    instructedCurrency: instructed.currency,
  });
  const balanceAfter = amountOf(row.balance_after_transaction);
  const transactionDate = isoDay(row.transaction_date);
  const view: TransactionView = {
    reference:
      entryReference ??
      detailsId ??
      // Some banks give neither; the composite is the most stable key left.
      `${bookingDate ?? ''}:${debit ? '-' : ''}${shown}:${remittance.join('|')}`,
    entryReference,
    ...(detailsId ? { detailsId } : {}),
    bookingDate,
    valueDate: isoDay(row.value_date),
    ...(transactionDate ? { transactionDate } : {}),
    amount: debit && !zero && shown ? `-${shown}` : shown,
    currency: text(row.transaction_amount?.currency) ?? null,
    direction: debit ? 'out' : 'in',
    status: text(row.status) ?? assumedStatus ?? 'OTHR',
    counterparty: text(party?.name) ?? null,
    counterpartyIban: iban?.identification ?? null,
    text: [...remittance, referenceNumber ?? ''].join(' ').replace(/\s+/g, ' ').trim(),
    remittance,
  };
  if (others.length > 0) view.counterpartyAccounts = others;
  const organisation = identifierView(party?.organisation_id);
  if (organisation) view.counterpartyOrganisationId = organisation;
  const address = addressLine(party?.postal_address);
  if (address) view.counterpartyAddress = address;
  const agent = agentView(debit ? row.creditor_agent : row.debtor_agent);
  if (agent) view.counterpartyBank = agent;
  if (referenceNumber) view.referenceNumber = referenceNumber;
  const schema = text(row.reference_number_schema);
  if (schema) view.referenceNumberSchema = schema;
  const bankCode = code?.description ?? code?.code;
  if (bankCode) view.bankCode = bankCode;
  if (code) view.bankTransactionCode = code;
  const merchant = text(row.merchant_category_code);
  if (merchant) view.merchantCategoryCode = merchant;
  if (exchangeRate) view.exchangeRate = exchangeRate;
  if (balanceAfter.amount) view.balanceAfter = balanceAfter.amount;
  if (balanceAfter.amount && balanceAfter.currency) view.balanceAfterCurrency = balanceAfter.currency;
  const note = text(row.note);
  if (note) view.note = note;
  return view;
}

/** Whether a line counts as pending: not yet booked, and not cancelled or rejected. */
export function isPending(status: string): boolean {
  return status !== 'BOOK' && status !== 'CNCL' && status !== 'RJCT';
}

/** Newest first, by booking date, else value date, else transaction date. */
export function newestFirst(a: TransactionView, b: TransactionView): number {
  const key = (row: TransactionView) => row.bookingDate ?? row.valueDate ?? row.transactionDate ?? '';
  return key(b).localeCompare(key(a));
}

export interface BalanceView {
  /** The balance type and what it means, e.g. "CLBD — closing booked: ...". */
  type: string;
  /** The balance type code alone (ISO 20022, as the API's BalanceStatus). */
  code: string;
  name: string | null;
  amount: string;
  /** ISO 4217. Null when the bank gave none. A multi-currency account has one balance per currency. */
  currency: string | null;
  /** The date the balance refers to. */
  referenceDate: string | null;
  /** When the balance last changed, as the bank states it. */
  lastChange: string | null;
  /** The bank's reference of the last transaction included in the balance. */
  lastCommittedTransaction?: string;
}

/** The API's BalanceStatus values and what each means. */
export const BALANCE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  CLAV: 'closing available: what was at the disposal of the account holder at the end of the day',
  CLBD: 'closing booked: the booked balance at the end of the day (the accounting balance)',
  FWAV: 'forward available: what will be at the disposal of the account holder on a given later date',
  INFO: 'information: a balance given for information only',
  ITAV: 'interim available: what is at the disposal of the account holder right now',
  ITBD: 'interim booked: the booked balance right now, during the day',
  OPAV: 'opening available: what was at the disposal of the account holder at the start of the day',
  OPBD: 'opening booked: the booked balance at the start of the day',
  OTHR: 'other: a balance of a kind the bank does not specify',
  PRCD: 'previously closed booked: the closing booked balance of the previous day',
  VALU: 'value date: the balance by value date',
  XPCD: 'expected: booked entries and pending items together (an instant balance)',
});

export function balanceView(row: BalanceResource): BalanceView {
  const code = text(row.balance_type) ?? 'OTHR';
  const meaning = Object.hasOwn(BALANCE_TYPES, code) ? BALANCE_TYPES[code] : 'a type this server does not know';
  const decimal = parseDecimal(row.balance_amount?.amount);
  const committed = text(row.last_committed_transaction);
  return {
    type: `${code} — ${meaning}`,
    code,
    name: text(row.name) ?? null,
    // A balance that is not a decimal is shown as the bank wrote it; one that is missing is empty, never a zero.
    amount: decimal ? formatDecimal(decimal) : (text(row.balance_amount?.amount) ?? ''),
    currency: text(row.balance_amount?.currency) ?? null,
    referenceDate: text(row.reference_date) ?? null,
    lastChange: text(row.last_change_date_time) ?? null,
    ...(committed ? { lastCommittedTransaction: committed } : {}),
  };
}

const USAGE: Readonly<Record<string, string>> = Object.freeze({ PRIV: 'private personal account', ORGA: 'professional account' });
const CASH_ACCOUNT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  CACC: 'current account',
  CARD: 'card account',
  CASH: 'cash payment account',
  LOAN: 'loan account',
  OTHR: 'other',
  SVGS: 'savings account',
});

function coded(value: unknown, meanings: Readonly<Record<string, string>>): { code: string; meaning?: string } | null {
  const code = text(value);
  if (!code) return null;
  return Object.hasOwn(meanings, code) ? { code, meaning: meanings[code]! } : { code };
}

export interface AccountDetailsView {
  /** The name of the account holder(s), as the bank states it. */
  holderName: string | null;
  /** The account's own description, by the account holder or the bank. */
  description: string | null;
  product: string | null;
  /** ISO 4217. XXX means a multi-currency account, or that the bank gave no currency. */
  currency: string | null;
  /** True when the currency is XXX: the balances then come one per currency. */
  multiCurrency: boolean;
  usage: { code: string; meaning?: string } | null;
  cashAccountType: { code: string; meaning?: string } | null;
  /** The role of the person who gave the consent: account holder, co-account holder or attorney. */
  holderRole: string | null;
  creditLimit: { amount: string; currency: string | null } | null;
  /** Every identifier the bank gave, IBAN first. A card number is masked. */
  identifiers: IdentifierView[];
  servicer: AgentView | null;
  postalAddress: string | null;
}

/** The bank's description of an account. The identification hash and the legal-age flag are not part of it. */
export function accountDetailsView(raw: AccountResource | null | undefined): AccountDetailsView {
  const currency = text(raw?.currency) ?? null;
  const limit = amountOf(raw?.credit_limit);
  return {
    holderName: text(raw?.name) ?? null,
    description: text(raw?.details) ?? null,
    product: text(raw?.product) ?? null,
    currency,
    multiCurrency: currency === 'XXX',
    usage: coded(raw?.usage, USAGE),
    cashAccountType: coded(raw?.cash_account_type, CASH_ACCOUNT_TYPES),
    holderRole: text(raw?.psu_status) ?? null,
    creditLimit: limit.amount ? { amount: limit.amount, currency: limit.currency ?? null } : null,
    identifiers: identifiersOf(raw?.account_id, raw?.all_account_ids),
    servicer: agentView(raw?.account_servicer) ?? null,
    postalAddress: addressLine(raw?.postal_address) ?? null,
  };
}

export interface CurrencyTotals {
  currency: string | null;
  count: number;
  in: string;
  out: string;
  net: string;
}

/** A running total per currency, exact, in the largest precision seen. */
export class Totals {
  private readonly entries = new Map<string, { currency: string | null; in: Decimal; out: Decimal; count: number }>();

  /** Adds one signed amount. An amount that is not a decimal is not counted. Returns whether it was. */
  add(currency: string | null, amount: string): boolean {
    const decimal = parseDecimal(amount);
    if (!decimal) return false;
    const key = currency ?? '';
    const entry = this.entries.get(key) ?? { currency, in: { units: 0n, scale: 0 }, out: { units: 0n, scale: 0 }, count: 0 };
    if (decimal.units < 0n) entry.out = addDecimal(entry.out, decimal);
    else entry.in = addDecimal(entry.in, decimal);
    entry.count += 1;
    this.entries.set(key, entry);
    return true;
  }

  list(): CurrencyTotals[] {
    return [...this.entries.values()].map(entry => {
      // One precision for the three numbers of a currency.
      const net = addDecimal(entry.in, entry.out);
      const zero: Decimal = { units: 0n, scale: net.scale };
      return {
        currency: entry.currency,
        count: entry.count,
        in: formatDecimal(addDecimal(entry.in, zero)),
        out: formatDecimal(addDecimal(entry.out, zero)),
        net: formatDecimal(net),
      };
    });
  }
}

/** Totals in and out per currency, summed exactly. A line whose amount is not a decimal is left out of the totals. */
export function summarize(rows: TransactionView[]): CurrencyTotals[] {
  const totals = new Totals();
  for (const row of rows) totals.add(row.currency, row.amount);
  return totals.list();
}

export interface CounterpartySummary {
  counterparty: string;
  /** The counterparty's account (IBAN, else another identifier), when every line of the group has the same one. */
  account?: string;
  currency: string | null;
  count: number;
  in: string;
  out: string;
  net: string;
  firstDate: string | null;
  lastDate: string | null;
}

/** What a line is grouped under when the bank gave no counterparty name. */
export const NO_COUNTERPARTY = '(no counterparty name)';

function counterpartyAccount(row: TransactionView): string | undefined {
  return row.counterpartyIban ?? row.counterpartyAccounts?.[0]?.identification;
}

/**
 * The lines grouped per counterparty and currency: a pure function of the
 * bank's lines. Lines are grouped on the counterparty name as the bank wrote
 * it (compared without case and surrounding spaces), or on the counterparty's
 * account when there is no name. Largest turnover first.
 */
export function summarizeByCounterparty(rows: TransactionView[]): CounterpartySummary[] {
  interface Group {
    counterparty: string;
    account: string | undefined | null;
    currency: string | null;
    totals: Totals;
    turnover: Decimal;
    first: string | null;
    last: string | null;
  }
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const account = counterpartyAccount(row);
    const name = row.counterparty ?? account ?? NO_COUNTERPARTY;
    const key = `${name.trim().toLowerCase()}\u0000${row.currency ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = { counterparty: name, account, currency: row.currency, totals: new Totals(), turnover: { units: 0n, scale: 0 }, first: null, last: null };
      groups.set(key, group);
    } else if (group.account !== account) {
      // Lines of one name with different accounts: no single account is shown.
      group.account = null;
    }
    if (!group.totals.add(row.currency, row.amount)) continue;
    group.turnover = addDecimal(group.turnover, absDecimal(parseDecimal(row.amount)!));
    const day = row.bookingDate ?? row.valueDate ?? row.transactionDate ?? null;
    if (day && (!group.first || day < group.first)) group.first = day;
    if (day && (!group.last || day > group.last)) group.last = day;
  }
  return [...groups.values()]
    .filter(group => group.totals.list().length > 0)
    .sort((a, b) => {
      const scale = Math.max(a.turnover.scale, b.turnover.scale);
      const left = addDecimal(a.turnover, { units: 0n, scale }).units;
      const right = addDecimal(b.turnover, { units: 0n, scale }).units;
      return left === right ? a.counterparty.localeCompare(b.counterparty) : left < right ? 1 : -1;
    })
    .map(group => {
      const totals = group.totals.list()[0]!;
      return {
        counterparty: group.counterparty,
        ...(group.account ? { account: group.account } : {}),
        currency: group.currency,
        count: totals.count,
        in: totals.in,
        out: totals.out,
        net: totals.net,
        firstDate: group.first,
        lastDate: group.last,
      };
    });
}

export interface LineFilter {
  /** Matched without case against counterparty, texts, references and account identifiers. */
  search?: string;
  direction?: 'in' | 'out';
  /** Smallest and largest absolute amount, as decimals. */
  minAmount?: Decimal;
  maxAmount?: Decimal;
}

/** Whether a line passes a filter. A pure function of the line. */
export function matchesLine(row: TransactionView, filter: LineFilter): boolean {
  if (filter.direction && row.direction !== filter.direction) return false;
  if (filter.minAmount || filter.maxAmount) {
    const amount = parseDecimal(row.amount);
    if (!amount) return false;
    const size = absDecimal(amount);
    const scale = (other: Decimal) => Math.max(size.scale, other.scale);
    const units = (value: Decimal, to: number) => addDecimal(value, { units: 0n, scale: to }).units;
    if (filter.minAmount && units(size, scale(filter.minAmount)) < units(filter.minAmount, scale(filter.minAmount))) return false;
    if (filter.maxAmount && units(size, scale(filter.maxAmount)) > units(filter.maxAmount, scale(filter.maxAmount))) return false;
  }
  const search = filter.search?.trim().toLowerCase();
  if (!search) return true;
  const haystack = [
    row.counterparty,
    row.text,
    ...row.remittance,
    row.reference,
    row.referenceNumber,
    row.counterpartyIban,
    ...(row.counterpartyAccounts ?? []).map(identifier => identifier.identification),
    row.counterpartyOrganisationId?.identification,
    row.bankCode,
    row.note,
    row.amount,
  ];
  return haystack.some(value => typeof value === 'string' && value.toLowerCase().includes(search));
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

