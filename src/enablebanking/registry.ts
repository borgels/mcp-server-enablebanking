import { readFileSync } from 'node:fs';
import { z } from 'zod/v4';

/**
 * The account registry: which bank account belongs to which company.
 *
 * This file — not the bank, not the consent, not a tool argument — is the
 * authority. A bank session can (and with a business MitID often will) contain
 * accounts of several companies, or accounts nobody has decided about yet. The
 * server only ever touches an account whose IBAN is listed under the company the
 * instance is pinned to, and it re-checks that on every call, so removing an
 * IBAN here revokes access on the next request without touching the consent.
 *
 * One file holds every company, so a reviewer sees the whole mapping in one
 * place, and an IBAN listed under two companies is a startup error rather than
 * a question of which entry wins.
 */

export const COMPANY_CODE = /^[a-z]{3}$/;

const accountSchema = z.object({
  iban: z.string().trim().min(15),
  /** Short, stable handle users can say instead of the IBAN ("drift", "skat"). */
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase letters, digits and dashes').optional(),
  name: z.string().trim().min(1),
  bank: z.string().trim().min(1).optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).default('DKK'),
  /** The e-conomic ledger account the bank account is booked on, for reference. */
  ledgerAccount: z.number().int().positive().optional(),
});

const companySchema = z.object({
  name: z.string().trim().min(1),
  cvr: z.string().trim().regex(/^\d{8}$/, 'CVR is 8 digits'),
  accounts: z.array(accountSchema).default([]),
});

const registrySchema = z.object({
  $comment: z.string().optional(),
  companies: z.record(z.string(), companySchema),
});

export interface RegisteredAccount {
  iban: string;
  id: string;
  name: string;
  bank?: string;
  currency: string;
  ledgerAccount?: number;
}

export interface Company {
  code: string;
  name: string;
  cvr: string;
  accounts: RegisteredAccount[];
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

export class AccountRegistry {
  private readonly companies = new Map<string, Company>();
  private readonly owner = new Map<string, string>();

  constructor(raw: unknown) {
    const parsed = registrySchema.safeParse(raw);
    if (!parsed.success) {
      throw new RegistryError(`account registry is invalid: ${z.prettifyError(parsed.error)}`);
    }
    for (const [code, company] of Object.entries(parsed.data.companies)) {
      if (!COMPANY_CODE.test(code)) {
        throw new RegistryError(`company code "${code}" must be three lowercase letters`);
      }
      const ids = new Set<string>();
      const accounts = company.accounts.map(account => {
        const iban = normalizeIban(account.iban);
        if (!isValidIban(iban)) {
          throw new RegistryError(`${code}: ${account.iban} is not a valid IBAN (checksum)`);
        }
        const previous = this.owner.get(iban);
        if (previous) {
          throw new RegistryError(`${maskIban(iban)} is listed under both ${previous} and ${code}; an account belongs to one company`);
        }
        this.owner.set(iban, code);
        const id = account.id ?? iban.toLowerCase();
        if (ids.has(id)) throw new RegistryError(`${code}: account id "${id}" is used twice`);
        ids.add(id);
        return { ...account, iban, id };
      });
      this.companies.set(code, { code, name: company.name, cvr: company.cvr, accounts });
    }
  }

  static fromFile(path: string): AccountRegistry {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new RegistryError(`cannot read the account registry at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return new AccountRegistry(raw);
  }

  /** All company codes, in file order. */
  codes(): string[] {
    return [...this.companies.keys()];
  }

  company(code: string): Company {
    const company = this.companies.get(code);
    if (!company) throw new RegistryError(`company "${code}" is not in the account registry`);
    return company;
  }

  /** The company an IBAN is registered to, if any. */
  ownerOf(iban: string): string | undefined {
    return this.owner.get(normalizeIban(iban));
  }

  /** The registered account of `code` for `iban`, or undefined (also when it belongs to another company). */
  accountOf(code: string, iban: string): RegisteredAccount | undefined {
    const normalized = normalizeIban(iban);
    if (this.owner.get(normalized) !== code) return undefined;
    return this.company(code).accounts.find(account => account.iban === normalized);
  }

  /**
   * Resolve what a user typed — an IBAN (any spacing/case) or an account id —
   * to an account of `code`. An IBAN registered to ANOTHER company gets an
   * error that says so without naming the other company.
   */
  resolve(code: string, reference: string): RegisteredAccount {
    const company = this.company(code);
    const asId = reference.trim().toLowerCase();
    const byId = company.accounts.find(account => account.id === asId);
    if (byId) return byId;
    const iban = normalizeIban(reference);
    const owned = this.accountOf(code, iban);
    if (owned) return owned;
    if (this.owner.has(iban)) {
      throw new RegistryError(`account ${maskIban(iban)} does not belong to ${company.name}; this server only reads ${company.name}'s accounts`);
    }
    throw new RegistryError(
      `unknown account "${reference}". Registered accounts for ${company.name}: ` +
        (company.accounts.map(account => `${account.id} (${maskIban(account.iban)})`).join(', ') || 'none'),
    );
  }
}

export function normalizeIban(value: string): string {
  return value.replace(/[\s-]+/g, '').toUpperCase();
}

/** ISO 13616 mod-97 check. */
export function isValidIban(value: string): boolean {
  const iban = normalizeIban(value);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** DK50 0040 … 1234 → "DK50…1234": enough to recognise, not enough to pay into. */
export function maskIban(value: string): string {
  const iban = normalizeIban(value);
  return iban.length > 8 ? `${iban.slice(0, 4)}…${iban.slice(-4)}` : '…';
}
