import type { BalanceResource, TransactionResource } from './client.js';
import { normalizeIban } from './registry.js';

export interface TransactionView {
  reference: string;
  bookingDate: string | null;
  valueDate: string | null;
  /** Signed decimal string: negative left the account. Never a float. */
  amount: string;
  currency: string;
  direction: 'in' | 'out';
  status: string;
  counterparty: string | null;
  counterpartyIban: string | null;
  text: string;
  bankCode?: string;
  balanceAfter?: string;
}

/** "123.4" → 12340n; signed. Throws on anything that is not a plain decimal with ≤ 2 decimals. */
export function toMinor(value: string): bigint {
  const match = /^([+-]?)(\d+)(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`not a decimal amount: ${value}`);
  const [, sign, whole, fraction = ''] = match;
  const minor = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  return sign === '-' ? -minor : minor;
}

export function fromMinor(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

function magnitude(value: string | undefined): string {
  const raw = (value ?? '0').trim().replace(/^[+-]/, '');
  try {
    return fromMinor(toMinor(raw));
  } catch {
    return raw;
  }
}

export function transactionView(row: TransactionResource): TransactionView {
  const debit = row.credit_debit_indicator === 'DBIT';
  const amount = magnitude(row.transaction_amount?.amount);
  const remittance = Array.isArray(row.remittance_information) ? row.remittance_information.map(String) : [];
  const bookingDate = (row.booking_date ?? null)?.slice(0, 10) ?? null;
  const counterpartyAccount = debit ? row.creditor_account?.iban : row.debtor_account?.iban;
  const reference =
    row.entry_reference ||
    row.transaction_id ||
    // Some banks leave both empty; the composite is the most stable key left.
    `${bookingDate ?? ''}:${debit ? '-' : ''}${amount}:${remittance.join('|')}`;
  const view: TransactionView = {
    reference,
    bookingDate,
    valueDate: (row.value_date ?? null)?.slice(0, 10) ?? null,
    amount: debit && amount !== '0.00' ? `-${amount}` : amount,
    currency: row.transaction_amount?.currency ?? 'DKK',
    direction: debit ? 'out' : 'in',
    status: row.status ?? 'BOOK',
    counterparty: (debit ? row.creditor?.name : row.debtor?.name) ?? null,
    counterpartyIban: counterpartyAccount ? normalizeIban(counterpartyAccount) : null,
    text: [...remittance, row.reference_number ?? ''].join(' ').replace(/\s+/g, ' ').trim(),
  };
  const bankCode = row.bank_transaction_code?.description ?? row.bank_transaction_code?.code;
  if (bankCode) view.bankCode = bankCode;
  if (row.balance_after_transaction?.amount) view.balanceAfter = row.balance_after_transaction.amount;
  return view;
}

export interface BalanceView {
  type: string;
  name: string | null;
  amount: string;
  currency: string;
  referenceDate: string | null;
  lastChange: string | null;
}

/** ISO 20022 balance types, the ones Danish banks actually return. */
const BALANCE_TYPES: Record<string, string> = {
  CLBD: 'closing booked (bogført saldo)',
  ITBD: 'interim booked',
  CLAV: 'closing available (disponibel)',
  ITAV: 'interim available (disponibel)',
  XPCD: 'expected',
  OPBD: 'opening booked',
  PRCD: 'previous closing booked',
  OTHR: 'other',
};

export function balanceView(row: BalanceResource): BalanceView {
  const type = row.balance_type ?? 'OTHR';
  return {
    type: `${type} — ${BALANCE_TYPES[type] ?? 'unknown type'}`,
    name: row.name ?? null,
    amount: row.balance_amount?.amount ?? '0',
    currency: row.balance_amount?.currency ?? 'DKK',
    referenceDate: row.reference_date ?? null,
    lastChange: row.last_change_date_time ?? null,
  };
}

/** Totals in and out per currency, summed in minor units. */
export function summarize(rows: TransactionView[]) {
  const totals = new Map<string, { in: bigint; out: bigint; count: number }>();
  for (const row of rows) {
    let minor: bigint;
    try {
      minor = toMinor(row.amount);
    } catch {
      continue;
    }
    const entry = totals.get(row.currency) ?? { in: 0n, out: 0n, count: 0 };
    if (minor < 0n) entry.out += minor;
    else entry.in += minor;
    entry.count += 1;
    totals.set(row.currency, entry);
  }
  return [...totals].map(([currency, entry]) => ({
    currency,
    count: entry.count,
    in: fromMinor(entry.in),
    out: fromMinor(entry.out),
    net: fromMinor(entry.in + entry.out),
  }));
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
