import { DecimalAmount, ORIGINAL_NUMBER_UNITS, SerializedDecimalAmount } from './DecimalAmount';

export interface SerializedOriginalInfVal extends SerializedDecimalAmount { precision: number; }
type InfValInput = OriginalInfVal | number;
const MAX_SERIALIZED_PRECISION = 100000;

function validatePrecision(precision: number): void {
  if (!Number.isSafeInteger(precision) || precision < 1 || precision > MAX_SERIALIZED_PRECISION) throw new Error('Invalid InfVal precision');
}
function input(value: InfValInput): OriginalInfVal {
  return value instanceof OriginalInfVal ? value : Number.isInteger(value) ? OriginalInfVal.fromInt(value) : OriginalInfVal.fromDouble(value);
}
/** Long integer division, avoiding BigInt on the WeChat runtime. */
function integerQuotient(numerator: string, denominator: string): string {
  const divisor = DecimalAmount.from(denominator), multiples = Array.from({ length: 10 }, (_, i) => divisor.mul(i));
  let remainder = DecimalAmount.from(0), quotient = '';
  for (const digit of numerator) {
    remainder = remainder.mul(10).add(+digit);
    let q = 9;
    while (q > 0 && remainder.compare(multiples[q]) < 0) q--;
    quotient += q; remainder = remainder.sub(multiples[q]);
  }
  return quotient.replace(/^0+/, '') || '0';
}
/** InfVal's amount and significant-digit precision are separate, including trailing zeroes.
 * Recovered from ARM64 InfVal constructors/operators and MathInfVal.Pow (1.1.61).
 * DecimalAmount remains the exact underlying arithmetic; gameplay wallets retain
 * their source precision through this wrapper. */
export class OriginalInfVal {
  readonly amount: DecimalAmount;
  readonly precision: number;
  private readonly zeroExponent: number;
  private constructor(amount: DecimalAmount, precision: number, zeroExponent = 1 - precision) {
    validatePrecision(precision);
    this.amount = amount.truncateSignificant(precision); this.zeroExponent = zeroExponent;
    this.precision = amount.isZero ? Math.max(1, 1 - zeroExponent) : precision;
    Object.freeze(this);
  }
  static fromInt(value: number): OriginalInfVal {
    if (!Number.isSafeInteger(value)) throw new Error('InfVal integer must be safe and finite');
    return new OriginalInfVal(DecimalAmount.from(value), String(Math.abs(value)).length);
  }
  static fromDouble(value: number): OriginalInfVal {
    if (!Number.isFinite(value)) throw new Error('InfVal double must be finite');
    // The native double constructor parses invariant G17 then explicitly sets precision 17.
    return new OriginalInfVal(DecimalAmount.from(value.toPrecision(17)), 17);
  }
  static fromAmount(amount: DecimalAmount, precision?: number): OriginalInfVal {
    const coefficientLength = amount.digits.replace('-', '').length;
    return new OriginalInfVal(amount, precision === undefined ? Math.max(coefficientLength, amount.scientificExponent + 1) : precision);
  }
  static fromSerialized(value: unknown): OriginalInfVal {
    if (typeof value !== 'object' || value === null) throw new Error('Invalid serialized InfVal');
    const saved = value as Partial<SerializedOriginalInfVal>;
    if (typeof saved.digits !== 'string' || !/^-?\d+$/.test(saved.digits) || saved.digits.length > MAX_SERIALIZED_PRECISION + 1 ||
      typeof saved.exponent !== 'number' || !Number.isSafeInteger(saved.exponent) || typeof saved.precision !== 'number') throw new Error('Invalid serialized InfVal');
    validatePrecision(saved.precision);
    const amount = DecimalAmount.from({ digits: saved.digits, exponent: saved.exponent });
    if (amount.truncateSignificant(saved.precision).compare(amount) !== 0) throw new Error('InfVal amount exceeds its saved precision');
    if (amount.isZero && saved.exponent > 0 && saved.precision !== 1) throw new Error('Invalid zero InfVal precision');
    return new OriginalInfVal(amount, saved.precision, amount.isZero && saved.exponent > 0 ? saved.exponent : 1 - saved.precision);
  }
  /** Native raw exponent; zero uses 1-precision, just as InfVal.get_precision does. */
  private get rawExponent(): number { return this.amount.isZero ? this.zeroExponent : this.amount.scientificExponent + 1 - this.precision; }
  private rawCoefficient(): string {
    return this.amount.digits.replace('-', '').padEnd(this.precision, '0');
  }
  private truncateAt(exponent: number): DecimalAmount {
    if (this.amount.isZero || this.amount.exponent >= exponent) return this.amount;
    const digits = this.amount.digits.replace('-', ''), keep = digits.length + this.amount.exponent - exponent;
    return keep <= 0 ? DecimalAmount.from(0) : DecimalAmount.from({ digits: (this.amount.isNegative ? '-' : '') + digits.slice(0, keep), exponent });
  }
  private sum(other: OriginalInfVal, subtract: boolean): OriginalInfVal {
    const precision = Math.max(this.precision, other.precision);
    if (this.amount.isZero) return subtract ? new OriginalInfVal(other.amount.mul(-1), other.precision, other.rawExponent).toPrecision(precision) : other.toPrecision(precision);
    if (other.amount.isZero) return this.toPrecision(precision);
    // Native addition/subtraction aligns and cuts BOTH operands before adding their coefficients.
    const exponent = Math.max(this.amount.scientificExponent, other.amount.scientificExponent) + 1 - precision;
    const left = this.truncateAt(exponent), right = other.truncateAt(exponent);
    const amount = subtract ? left.sub(right) : left.add(right);
    return amount.isZero ? new OriginalInfVal(amount, 1, exponent).toPrecision(precision) : new OriginalInfVal(amount, precision);
  }
  add(value: InfValInput): OriginalInfVal { return this.sum(input(value), false); }
  sub(value: InfValInput): OriginalInfVal { return this.sum(input(value), true); }
  mul(value: InfValInput): OriginalInfVal {
    const other = input(value);
    return new OriginalInfVal(this.amount.mul(other.amount), Math.max(this.precision, other.precision));
  }
  div(value: InfValInput): OriginalInfVal {
    const other = input(value), precision = Math.max(this.precision, other.precision);
    if (other.amount.isZero) throw new Error('InfVal division by zero');
    if (this.amount.isZero) return new OriginalInfVal(this.amount, precision);
    // Native division expands the original numerator coefficient by 10^maxPrecision,
    // performs integer division, adjusts exponent, then calls ToPrecision.
    const coefficient = integerQuotient(this.rawCoefficient() + '0'.repeat(precision), other.rawCoefficient());
    const sign = this.amount.isNegative !== other.amount.isNegative ? '-' : '';
    return new OriginalInfVal(DecimalAmount.from({ digits: sign + coefficient, exponent: this.rawExponent - other.rawExponent - precision }), precision);
  }
  pow(power: number, conservePrecision = true): OriginalInfVal {
    if (!Number.isSafeInteger(power) || Math.abs(power) > 2147483647) throw new Error('Invalid InfVal integer power');
    if (power === 0) return OriginalInfVal.fromInt(1).toPrecision(this.precision);
    // These native fast paths deliberately also apply to negative powers.
    if (this.amount.isZero || this.amount.compare(1) === 0) return this;
    let value: OriginalInfVal = this, result = OriginalInfVal.fromInt(1), remaining = Math.abs(power);
    while (remaining > 0) {
      if (remaining % 2) result = result.mul(value);
      value = value.mul(value); remaining = Math.floor(remaining / 2);
    }
    if (power < 0) result = OriginalInfVal.fromInt(1).toPrecision(this.precision).div(result);
    return conservePrecision ? result.toPrecision(this.precision) : result;
  }
  toPrecision(precision: number): OriginalInfVal {
    return new OriginalInfVal(this.amount, precision, this.amount.isZero ? this.rawExponent + this.precision - precision : 1 - precision);
  }
  discardDecimal(): OriginalInfVal {
    if (this.rawExponent >= 0) return this;
    const amount = this.amount.discardDecimal();
    return new OriginalInfVal(amount, amount.isZero ? 1 : Math.max(1, amount.scientificExponent + 1));
  }
  format(units: readonly string[] = ORIGINAL_NUMBER_UNITS, maxDigits = 5): string { return this.amount.format(units, maxDigits); }
  toJSON(): SerializedOriginalInfVal {
    return { ...this.amount.toJSON(), exponent: this.amount.isZero && this.rawExponent > 0 ? this.rawExponent : this.amount.exponent, precision: this.precision };
  }
  toString(): string { return this.amount.toString(); }
}

/** Enemy.Damaged subtracts InfVal values, retaining the larger operand precision.
 * Main and challenge trees carry HP metadata; custom callers without it retain
 * their existing exact DecimalAmount subtraction in the combat world.
 * The combat representation clamps a dead enemy to zero after the source sum. */
export function subtractOriginalHealth(health: DecimalAmount, healthPrecision: number,
  damage: DecimalAmount, damagePrecision: number): { health: DecimalAmount; precision: number } {
  const remaining = OriginalInfVal.fromAmount(health, healthPrecision)
    .sub(OriginalInfVal.fromAmount(damage, damagePrecision));
  return { health: remaining.amount.isNegative ? DecimalAmount.from(0) : remaining.amount, precision: remaining.precision };
}
