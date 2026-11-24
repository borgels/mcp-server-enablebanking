/**
 * Decimal amounts as the Enable Banking API gives them (AmountType): a string
 * of digits with an optional fraction after a dot, in the precision of the
 * currency (none for JPY, three for BHD or KWD, two for most). Kept exact:
 * nothing here goes through a float, and no number of decimals is assumed.
 */

export interface Decimal {
  /** The amount as an integer of 10^-scale units. */
  units: bigint;
  /** Digits after the dot, as the bank wrote them. */
  scale: number;
}

const DECIMAL = /^([+-]?)(\d{1,40})(?:\.(\d{1,18}))?$/;

/** The amount of a decimal string, or null when it is not one. */
export function parseDecimal(value: unknown): Decimal | null {
  if (typeof value !== 'string') return null;
  const match = DECIMAL.exec(value.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match;
  const units = BigInt(`${whole}${fraction}`);
  return { units: sign === '-' ? -units : units, scale: fraction.length };
}

function rescale(value: Decimal, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

/** The sum, in the larger of the two scales. */
export function addDecimal(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return { units: rescale(a, scale) + rescale(b, scale), scale };
}

export function negateDecimal(value: Decimal): Decimal {
  return { units: -value.units, scale: value.scale };
}

export function absDecimal(value: Decimal): Decimal {
  return value.units < 0n ? negateDecimal(value) : value;
}

/** -1, 0 or 1 as a is below, equal to or above b. */
export function compareDecimal(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const left = rescale(a, scale);
  const right = rescale(b, scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The decimal string, with exactly `scale` digits after the dot. */
export function formatDecimal(value: Decimal): string {
  const negative = value.units < 0n;
  const digits = String(negative ? -value.units : value.units).padStart(value.scale + 1, '0');
  const whole = digits.slice(0, digits.length - value.scale);
  const fraction = value.scale > 0 ? `.${digits.slice(digits.length - value.scale)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}
