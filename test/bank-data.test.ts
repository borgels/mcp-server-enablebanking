// How bank data is shown, checked against the shapes of Enable Banking's OpenAPI document (Transaction,
// BalanceResource, AccountResource) with made-up data: nothing is invented, amounts stay exact, and no country or
// currency is assumed.
import { describe, expect, it } from 'vitest';
import type { AccountResource, BalanceResource, TransactionResource } from '../src/enablebanking/api.js';
import { addDecimal, compareDecimal, formatDecimal, parseDecimal } from '../src/enablebanking/decimal.js';
import {
  accountDetailsView,
  balanceView,
  BALANCE_TYPES,
  isPending,
  matchesLine,
  NO_COUNTERPARTY,
  summarize,
  summarizeByCounterparty,
  transactionView,
} from '../src/enablebanking/format.js';
import { dkIban } from './helpers.js';

/** A valid IBAN for a made-up account number, computed here so no account number stands in this file. */
function iban(country: string, bban: string): string {
  const numeric = (bban + country + '00').replace(/[A-Z]/g, char => String(char.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  return country + String(98 - remainder).padStart(2, '0') + bban;
}

const SE_IBAN = iban('SE', '50000000050000000001');
const FI_IBAN = iban('FI', '50000000000001');
/** A made-up card number: sixteen digits ending in 1234. */
const CARD = ['9999', '0000', '0000', '1234'].join(' ');

/** A line with every field of the API's Transaction schema, made up. */
const FULL: TransactionResource = {
  entry_reference: 'ENTRY-0001',
  merchant_category_code: '5411',
  transaction_amount: { currency: 'SEK', amount: '1500.50' },
  creditor: {
    name: 'Påhittad Leverantör AB',
    postal_address: { street_name: 'Exempelgatan', building_number: '1', post_code: '111 22', town_name: 'Stockholm', country: 'SE' },
    organisation_id: { identification: '5560000000', scheme_name: 'COID' },
    private_id: { identification: 'made-up-private-id', scheme_name: 'NIDN' },
    contact_details: { email_address: 'kontakt@example.com', phone_number: 'made-up-phone' },
  },
  creditor_account: { other: { identification: '123-4567', scheme_name: 'BGNR' } },
  creditor_account_additional_identification: [{ identification: CARD, scheme_name: 'CPAN' }],
  creditor_agent: { bic_fi: 'EXMPSEXX', name: 'Exempelbanken', clearing_system_member_id: { clearing_system_id: 'SESBA', member_id: '5000' } },
  debtor: { name: 'Eget Bolag AB' },
  debtor_account: { iban: SE_IBAN },
  bank_transaction_code: { description: 'Bankgiro payment', code: 'PMNT', sub_code: 'ICDT' },
  credit_debit_indicator: 'DBIT',
  status: 'BOOK',
  booking_date: '2026-11-03',
  value_date: '2026-11-04',
  transaction_date: '2026-11-02',
  balance_after_transaction: { currency: 'SEK', amount: '98499.50' },
  reference_number: '1234567897',
  reference_number_schema: 'SEBG',
  remittance_information: ['Faktura 2026-1001', 'Tack för din beställning'],
  debtor_account_additional_identification: null,
  exchange_rate: {
    unit_currency: 'EUR',
    exchange_rate: '11.4321',
    rate_type: 'SPOT',
    contract_identification: 'FX-1',
    instructed_amount: { currency: 'EUR', amount: '131.25' },
  },
  note: 'Godkänd av ekonomi',
  transaction_id: 'details-0001',
};

describe('decimals', () => {
  it('keeps the precision of the bank and never goes through a float', () => {
    expect(formatDecimal(parseDecimal('0.10')!)).toBe('0.10');
    expect(formatDecimal(parseDecimal('1500')!)).toBe('1500');
    expect(formatDecimal(parseDecimal('-0.005')!)).toBe('-0.005');
    expect(formatDecimal(addDecimal(parseDecimal('0.1')!, parseDecimal('0.20')!))).toBe('0.30');
    expect(formatDecimal(addDecimal(parseDecimal('90071992547409930000.01')!, parseDecimal('0.02')!))).toBe('90071992547409930000.03');
    expect(compareDecimal(parseDecimal('10')!, parseDecimal('9.999')!)).toBe(1);
    for (const bad of ['1,50', '1.5e3', '', ' ', 'NaN', '1.', '.5', '12 000', 15, null, undefined, {}]) expect(parseDecimal(bad)).toBeNull();
  });
});

describe('a bank line', () => {
  it('shows every documented field of an outgoing line, with the counterparty side chosen by direction', () => {
    expect(transactionView(FULL)).toEqual({
      reference: 'ENTRY-0001',
      entryReference: 'ENTRY-0001',
      detailsId: 'details-0001',
      bookingDate: '2026-11-03',
      valueDate: '2026-11-04',
      transactionDate: '2026-11-02',
      amount: '-1500.50',
      currency: 'SEK',
      direction: 'out',
      status: 'BOOK',
      counterparty: 'Påhittad Leverantör AB',
      counterpartyIban: null,
      counterpartyAccounts: [
        { scheme: 'BGNR', identification: '123-4567' },
        // A card number is never shown whole.
        { scheme: 'CPAN', identification: '…1234' },
      ],
      counterpartyOrganisationId: { scheme: 'COID', identification: '5560000000' },
      counterpartyAddress: 'Exempelgatan 1, 111 22 Stockholm, SE',
      counterpartyBank: { bic: 'EXMPSEXX', name: 'Exempelbanken', clearingSystem: 'SESBA', clearingMemberId: '5000' },
      text: 'Faktura 2026-1001 Tack för din beställning 1234567897',
      remittance: ['Faktura 2026-1001', 'Tack för din beställning'],
      referenceNumber: '1234567897',
      referenceNumberSchema: 'SEBG',
      bankCode: 'Bankgiro payment',
      bankTransactionCode: { description: 'Bankgiro payment', code: 'PMNT', subCode: 'ICDT' },
      merchantCategoryCode: '5411',
      exchangeRate: { unitCurrency: 'EUR', rate: '11.4321', rateType: 'SPOT', contractId: 'FX-1', instructedAmount: '131.25', instructedCurrency: 'EUR' },
      balanceAfter: '98499.50',
      balanceAfterCurrency: 'SEK',
      note: 'Godkänd av ekonomi',
    });
    // A person's identity number and contact details of a counterparty are not shown.
    const shown = JSON.stringify(transactionView(FULL));
    for (const hidden of ['made-up-private-id', 'kontakt@example.com', 'made-up-phone', CARD, '9999']) expect(shown).not.toContain(hidden);
  });

  it('takes the other side for an incoming line and normalises its IBAN', () => {
    const view = transactionView({ ...FULL, credit_debit_indicator: 'CRDT', debtor: { name: 'Fiktiv Kund Oy' }, debtor_account: { iban: FI_IBAN.toLowerCase().replace(/(.{4})/g, '$1 ') } });
    expect(view).toMatchObject({ amount: '1500.50', direction: 'in', counterparty: 'Fiktiv Kund Oy', counterpartyIban: FI_IBAN });
    expect(view.counterpartyAccounts).toBeUndefined();
  });

  it('invents nothing: no currency, no status, no zero amount', () => {
    const bare = transactionView({ credit_debit_indicator: 'DBIT', booking_date: '2026-11-03' });
    expect(bare).toMatchObject({ amount: '', currency: null, status: 'OTHR', counterparty: null, counterpartyIban: null, entryReference: null, text: '', remittance: [] });
    // A line without a status is taken to have the one that was asked for, and only then.
    expect(transactionView({ transaction_amount: { amount: '1' } }, 'PDNG').status).toBe('PDNG');
    expect(transactionView({ transaction_amount: { amount: '1' }, status: 'HOLD' }, 'PDNG').status).toBe('HOLD');
    // Precision as the bank wrote it: none for yen, three for dinars.
    expect(transactionView({ transaction_amount: { amount: '1200', currency: 'JPY' }, credit_debit_indicator: 'DBIT' }).amount).toBe('-1200');
    expect(transactionView({ transaction_amount: { amount: '12.345', currency: 'KWD' }, credit_debit_indicator: 'CRDT' }).amount).toBe('12.345');
    // Zero has no sign.
    expect(transactionView({ transaction_amount: { amount: '0.00' }, credit_debit_indicator: 'DBIT' }).amount).toBe('0.00');
    // Without the bank's references the key is a composite of the line.
    expect(transactionView({ transaction_amount: { amount: '5.00' }, credit_debit_indicator: 'DBIT', booking_date: '2026-11-03', remittance_information: ['a', 'b'] }).reference).toBe(
      '2026-11-03:-5.00:a|b',
    );
  });

  it('drops what is not a text instead of passing it on', () => {
    const odd = transactionView({
      entry_reference: 42,
      transaction_amount: { amount: 12.5, currency: { code: 'DKK' } },
      remittance_information: ['kept', 7, { text: 'x' }, null],
      creditor: { name: ['a'] },
      status: 1,
    } as never);
    expect(odd).toMatchObject({ entryReference: null, amount: '', currency: null, remittance: ['kept'], counterparty: null, status: 'OTHR' });
  });

  it('knows which statuses are pending', () => {
    expect(['PDNG', 'HOLD', 'SCHD'].every(isPending)).toBe(true);
    // A positive list: cancelled, rejected, unspecified and unknown statuses are neither booked nor pending.
    expect(['BOOK', 'CNCL', 'RJCT', 'OTHR', '', 'pdng', 'NOT-A-STATUS'].some(isPending)).toBe(false);
  });
});

describe('balances', () => {
  it('names every balance type of the API with its meaning, and keeps amount, date and time as given', () => {
    // BalanceStatus in the API reference.
    expect(Object.keys(BALANCE_TYPES).sort()).toEqual(['CLAV', 'CLBD', 'FWAV', 'INFO', 'ITAV', 'ITBD', 'OPAV', 'OPBD', 'OTHR', 'PRCD', 'VALU', 'XPCD']);
    const row: BalanceResource = {
      name: 'Booked balance',
      balance_amount: { currency: 'EUR', amount: '-250.00' },
      balance_type: 'CLBD',
      last_change_date_time: '2026-11-03T07:15:00+01:00',
      reference_date: '2026-11-02',
      last_committed_transaction: 'ENTRY-0001',
    };
    expect(balanceView(row)).toEqual({
      type: `CLBD — ${BALANCE_TYPES.CLBD}`,
      code: 'CLBD',
      name: 'Booked balance',
      amount: '-250.00',
      currency: 'EUR',
      referenceDate: '2026-11-02',
      lastChange: '2026-11-03T07:15:00+01:00',
      lastCommittedTransaction: 'ENTRY-0001',
    });
    // A missing amount is empty, never zero; a missing currency is null, never a guess.
    expect(balanceView({ balance_type: 'ITAV' })).toMatchObject({ code: 'ITAV', amount: '', currency: null, referenceDate: null, lastChange: null });
    expect(balanceView({ balance_type: 'ZZZZ', balance_amount: { amount: '1' } }).type).toMatch(/does not know/);
  });
});

describe('account details', () => {
  const RAW: AccountResource = {
    account_id: { iban: dkIban('54700001234567') },
    all_account_ids: [
      { identification: '54700001234567', scheme_name: 'BBAN' },
      { identification: dkIban('54700001234567'), scheme_name: 'IBAN' },
    ],
    account_servicer: { bic_fi: 'OPDIDKKK', name: 'Opdigtet Bank' },
    name: 'Fiktiv Handel ApS',
    details: 'Driftskonto',
    usage: 'ORGA',
    cash_account_type: 'CACC',
    product: 'Erhvervskonto',
    currency: 'DKK',
    psu_status: 'Account Holder',
    credit_limit: { currency: 'DKK', amount: '50000.00' },
    legal_age: true,
    postal_address: { address_line: ['Eksempelvej 1', '9999 Eksempelby'], country: 'DK' },
    uid: '07cc67f4-45d6-494b-adac-09b5cbc7e2b5',
    identification_hash: 'made-up-hash',
    identification_hashes: ['made-up-hash'],
  };

  it('shows holder, product, usage and every identifier, IBAN first and without repeats', () => {
    expect(accountDetailsView(RAW)).toEqual({
      holderName: 'Fiktiv Handel ApS',
      description: 'Driftskonto',
      product: 'Erhvervskonto',
      currency: 'DKK',
      multiCurrency: false,
      usage: { code: 'ORGA', meaning: 'professional account' },
      cashAccountType: { code: 'CACC', meaning: 'current account' },
      holderRole: 'Account Holder',
      creditLimit: { amount: '50000.00', currency: 'DKK' },
      identifiers: [
        { scheme: 'IBAN', identification: dkIban('54700001234567') },
        { scheme: 'BBAN', identification: '54700001234567' },
      ],
      servicer: { bic: 'OPDIDKKK', name: 'Opdigtet Bank' },
      postalAddress: 'Eksempelvej 1, 9999 Eksempelby, DK',
    });
    // The hash and the legal-age flag are not part of the view.
    expect(JSON.stringify(accountDetailsView(RAW))).not.toMatch(/made-up-hash|legal/);
  });

  it('handles an account without an IBAN, a card account and a multi-currency account', () => {
    const bankgiro = accountDetailsView({ account_id: { other: { identification: '123-4567', scheme_name: 'BGNR' } }, currency: 'SEK' });
    expect(bankgiro.identifiers).toEqual([{ scheme: 'BGNR', identification: '123-4567' }]);
    const card = accountDetailsView({ account_id: { other: { identification: CARD.replace(/ /g, ''), scheme_name: 'CPAN' } }, cash_account_type: 'CARD' });
    expect(card.identifiers).toEqual([{ scheme: 'CPAN', identification: '…1234' }]);
    expect(accountDetailsView({ currency: 'XXX' })).toMatchObject({ currency: 'XXX', multiCurrency: true });
    expect(accountDetailsView(undefined)).toMatchObject({ holderName: null, currency: null, identifiers: [], creditLimit: null });
  });
});

describe('derived views are pure functions of the lines', () => {
  const line = (amount: string, indicator: 'CRDT' | 'DBIT', party: string | undefined, currency = 'EUR', day = '2026-11-03', extra: Partial<TransactionResource> = {}) =>
    transactionView({
      transaction_amount: { amount, currency },
      credit_debit_indicator: indicator,
      status: 'BOOK',
      booking_date: day,
      ...(party ? (indicator === 'DBIT' ? { creditor: { name: party } } : { debtor: { name: party } }) : {}),
      ...extra,
    });

  it('sums exactly per currency and never across currencies', () => {
    const rows = [line('0.10', 'CRDT', 'A'), line('0.20', 'CRDT', 'A'), line('1.005', 'DBIT', 'B'), line('100', 'CRDT', 'C', 'JPY'), line('x', 'CRDT', 'D')];
    expect(summarize(rows)).toEqual([
      { currency: 'EUR', count: 3, in: '0.300', out: '-1.005', net: '-0.705' },
      { currency: 'JPY', count: 1, in: '100', out: '0', net: '100' },
    ]);
    expect(summarize([])).toEqual([]);
  });

  it('groups per counterparty and currency, largest turnover first', () => {
    const rows = [
      line('100.00', 'DBIT', 'Fiktiv Leverandør ApS', 'EUR', '2026-11-01'),
      line('50.00', 'DBIT', 'fiktiv leverandør aps ', 'EUR', '2026-11-05'),
      line('20.00', 'CRDT', 'Fiktiv Leverandør ApS', 'EUR', '2026-11-03'),
      line('999.00', 'CRDT', 'Opdigtet Kunde A/S', 'DKK', '2026-11-02'),
      line('5.00', 'DBIT', undefined, 'EUR', '2026-11-04'),
      line('7.00', 'DBIT', 'Fiktiv Leverandør ApS', 'DKK', '2026-11-04'),
    ];
    expect(summarizeByCounterparty(rows)).toEqual([
      { counterparty: 'Opdigtet Kunde A/S', currency: 'DKK', count: 1, in: '999.00', out: '0.00', net: '999.00', firstDate: '2026-11-02', lastDate: '2026-11-02' },
      { counterparty: 'Fiktiv Leverandør ApS', currency: 'EUR', count: 3, in: '20.00', out: '-150.00', net: '-130.00', firstDate: '2026-11-01', lastDate: '2026-11-05' },
      { counterparty: 'Fiktiv Leverandør ApS', currency: 'DKK', count: 1, in: '0.00', out: '-7.00', net: '-7.00', firstDate: '2026-11-04', lastDate: '2026-11-04' },
      { counterparty: NO_COUNTERPARTY, currency: 'EUR', count: 1, in: '0.00', out: '-5.00', net: '-5.00', firstDate: '2026-11-04', lastDate: '2026-11-04' },
    ]);
  });

  it('filters by text, direction and exact amount', () => {
    const row = line('1500.50', 'DBIT', 'Påhittad Leverantör AB', 'SEK', '2026-11-03', {
      remittance_information: ['Faktura 2026-1001'],
      reference_number: '1234567897',
      creditor_account: { other: { identification: '123-4567', scheme_name: 'BGNR' } },
    });
    expect(matchesLine(row, {})).toBe(true);
    for (const search of ['påhittad', 'FAKTURA 2026', '1234567897', '123-4567', '1500.50']) expect(matchesLine(row, { search }), search).toBe(true);
    expect(matchesLine(row, { search: 'someone else' })).toBe(false);
    expect(matchesLine(row, { direction: 'in' })).toBe(false);
    expect(matchesLine(row, { minAmount: parseDecimal('1500.5')!, maxAmount: parseDecimal('1500.50')! })).toBe(true);
    expect(matchesLine(row, { minAmount: parseDecimal('1500.51')! })).toBe(false);
    expect(matchesLine(row, { maxAmount: parseDecimal('1500.499')! })).toBe(false);
    // A line whose amount is not a decimal never passes an amount filter.
    expect(matchesLine(line('x', 'DBIT', 'A'), { minAmount: parseDecimal('0')! })).toBe(false);
  });
});
