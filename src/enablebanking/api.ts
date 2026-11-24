/**
 * The Enable Banking API's account information resources, as its OpenAPI
 * document describes them (version 1.0.0-1c03cf81, read 2026-11-24). Every
 * field is optional and nullable here: a bank fills what it has, and what
 * comes back is data from outside that is checked before it is used.
 */

/** GenericIdentification: an identifier in a named scheme (BBAN, IBAN, CPAN, BGNR and the rest of SchemeName). */
export interface GenericIdentification {
  identification?: string | null;
  scheme_name?: string | null;
  issuer?: string | null;
}

/** AccountIdentification: an IBAN, or an identifier in another scheme. */
export interface AccountIdentification {
  iban?: string | null;
  other?: GenericIdentification | null;
}

/** FinancialInstitutionIdentification: a bank, by BIC, clearing member id or name. */
export interface FinancialInstitutionIdentification {
  bic_fi?: string | null;
  clearing_system_member_id?: { clearing_system_id?: string | null; member_id?: string | null } | null;
  name?: string | null;
}

export interface PostalAddress {
  address_type?: string | null;
  department?: string | null;
  sub_department?: string | null;
  street_name?: string | null;
  building_number?: string | null;
  post_code?: string | null;
  town_name?: string | null;
  country_sub_division?: string | null;
  country?: string | null;
  address_line?: string[] | null;
}

/** PartyIdentification: who a transaction is with. */
export interface PartyIdentification {
  name?: string | null;
  postal_address?: PostalAddress | null;
  organisation_id?: GenericIdentification | null;
  private_id?: GenericIdentification | null;
  contact_details?: { email_address?: string | null; phone_number?: string | null } | null;
}

/** AmountType: a decimal string and an ISO 4217 currency. */
export interface Amount {
  currency?: string | null;
  amount?: string | null;
}

/** AuthMethod: one way a bank lets a person authenticate. */
export interface AuthMethod {
  name?: string | null;
  title?: string | null;
  psu_type?: string | null;
  credentials?: Array<{
    name?: string | null;
    title?: string | null;
    required?: boolean | null;
    description?: string | null;
    template?: string | null;
  }> | null;
  /** REDIRECT, DECOUPLED or EMBEDDED. */
  approach?: string | null;
  hidden_method?: boolean | null;
}

/** ASPSPData: a bank, as GET /aspsps lists it. */
export interface Aspsp {
  name: string;
  country: string;
  logo?: string | null;
  bic?: string | null;
  psu_types?: string[] | null;
  auth_methods?: AuthMethod[] | null;
  /** Seconds. */
  maximum_consent_validity?: number | null;
  /** SandboxInfo: test users of the bank's sandbox. Never passed on. */
  sandbox?: unknown;
  beta?: boolean | null;
  required_psu_headers?: string[] | null;
  /** ResponsePaymentType: payment initiation only; not read by this package. */
  payments?: unknown;
  group?: { name?: string | null; logo?: string | null } | null;
}

/** Access: what a consent covers. */
export interface Access {
  accounts?: AccountIdentification[] | null;
  balances?: boolean | null;
  transactions?: boolean | null;
  transactions_extended_history?: boolean | null;
  valid_until?: string | null;
}

export interface AccountResource {
  uid?: string | null;
  account_id?: AccountIdentification | null;
  all_account_ids?: GenericIdentification[] | null;
  account_servicer?: FinancialInstitutionIdentification | null;
  /** The name of the account holder(s). */
  name?: string | null;
  /** The account's description, by the person or the bank. */
  details?: string | null;
  /** PRIV (private personal) or ORGA (professional). */
  usage?: string | null;
  /** CACC, CARD, CASH, LOAN, OTHR or SVGS. */
  cash_account_type?: string | null;
  product?: string | null;
  /** ISO 4217; XXX for a multi-currency account or when the bank gives none. */
  currency?: string | null;
  psu_status?: string | null;
  credit_limit?: Amount | null;
  legal_age?: boolean | null;
  postal_address?: PostalAddress | null;
  identification_hash?: string | null;
  identification_hashes?: string[] | null;
}

/** AuthorizeSessionResponse: the answer to POST /sessions. */
export interface SessionResource {
  session_id: string;
  accounts?: AccountResource[] | null;
  aspsp?: { name: string; country: string } | null;
  psu_type?: string | null;
  access?: Access | null;
}

/** GetSessionResponse. */
export interface SessionStatus {
  /** AUTHORIZED, CANCELLED, CLOSED, EXPIRED, INVALID, PENDING_AUTHORIZATION, RETURNED_FROM_BANK or REVOKED. */
  status?: string | null;
  accounts?: string[] | null;
  /** Account uids with their identification hash, the same for the account across consents. */
  accounts_data?: Array<{ uid?: string | null; identification_hash?: string | null; identification_hashes?: string[] | null }> | null;
  access?: Access | null;
  aspsp?: { name: string; country: string } | null;
  psu_type?: string | null;
  psu_id_hash?: string | null;
  created?: string | null;
  authorized?: string | null;
  closed?: string | null;
}

export interface BalanceResource {
  name?: string | null;
  balance_amount?: Amount | null;
  /** BalanceStatus: CLAV, CLBD, FWAV, INFO, ITAV, ITBD, OPAV, OPBD, OTHR, PRCD, VALU or XPCD. */
  balance_type?: string | null;
  last_change_date_time?: string | null;
  reference_date?: string | null;
  last_committed_transaction?: string | null;
}

export interface TransactionResource {
  entry_reference?: string | null;
  merchant_category_code?: string | null;
  transaction_amount?: Amount | null;
  creditor?: PartyIdentification | null;
  creditor_account?: AccountIdentification | null;
  creditor_agent?: FinancialInstitutionIdentification | null;
  debtor?: PartyIdentification | null;
  debtor_account?: AccountIdentification | null;
  debtor_agent?: FinancialInstitutionIdentification | null;
  bank_transaction_code?: { description?: string | null; code?: string | null; sub_code?: string | null } | null;
  credit_debit_indicator?: 'CRDT' | 'DBIT' | string | null;
  /** TransactionStatus: BOOK, CNCL, HOLD, OTHR, PDNG, RJCT or SCHD. */
  status?: string | null;
  booking_date?: string | null;
  value_date?: string | null;
  transaction_date?: string | null;
  balance_after_transaction?: Amount | null;
  reference_number?: string | null;
  /** BERF, FIRF, INTL, NORF, SDDM or SEBG. */
  reference_number_schema?: string | null;
  remittance_information?: string[] | null;
  debtor_account_additional_identification?: GenericIdentification[] | null;
  creditor_account_additional_identification?: GenericIdentification[] | null;
  exchange_rate?: {
    unit_currency?: string | null;
    exchange_rate?: string | null;
    /** AGRD, SALE or SPOT. */
    rate_type?: string | null;
    contract_identification?: string | null;
    instructed_amount?: Amount | null;
  } | null;
  /** The person's own note on the transaction. */
  note?: string | null;
  /** For GET /accounts/{account_id}/transactions/{transaction_id} only: not unique, and it may change. */
  transaction_id?: string | null;
}

/** GetApplicationResponse. */
export interface ApplicationResource {
  name?: string | null;
  description?: string | null;
  kid?: string | null;
  /** SANDBOX or PRODUCTION. */
  environment?: string | null;
  redirect_urls?: string[] | null;
  active?: boolean | null;
  countries?: string[] | null;
  /** AIS and/or PIS. */
  services?: string[] | null;
}

/** TransactionsFetchStrategy. */
export type FetchStrategy = 'default' | 'longest';
