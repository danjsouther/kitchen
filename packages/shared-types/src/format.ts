/**
 * Display formatting for quantities.
 *
 * Rounding lives here and *only* here — it is applied when rendering, never when
 * storing. Recipes keep their exact decimal amounts so that scaling twice does not
 * drift; the cook just wants to read "1 ½ cups".
 */

import Decimal from 'decimal.js';

import { UnitKind } from './enums';
import type { Numeric, UnitDef } from './units';

/** The fractions cooks actually use, with their glyphs. */
const COMMON_FRACTIONS: ReadonlyArray<{ value: number; glyph: string }> = [
  { value: 1 / 8, glyph: '⅛' }, // ⅛
  { value: 1 / 4, glyph: '¼' }, // ¼
  { value: 1 / 3, glyph: '⅓' }, // ⅓
  { value: 3 / 8, glyph: '⅜' }, // ⅜
  { value: 1 / 2, glyph: '½' }, // ½
  { value: 5 / 8, glyph: '⅝' }, // ⅝
  { value: 2 / 3, glyph: '⅔' }, // ⅔
  { value: 3 / 4, glyph: '¾' }, // ¾
  { value: 7 / 8, glyph: '⅞' }, // ⅞
];

/** How far a fractional part may sit from a common fraction and still snap to it. */
const SNAP_TOLERANCE = 0.021; // ~1/48, tight enough that 0.3 stays decimal

export interface FormatOptions {
  /**
   * Render fractions as vulgar glyphs ("1 ½") rather than decimals ("1.5").
   * Defaults to true for VOLUME and COUNT, false for MASS — nobody asks for
   * ⅜ of a gram.
   */
  fractions?: boolean;
  /** Maximum decimal places when not using fractions. Default 2. */
  maxDecimals?: number;
}

/**
 * Formats a quantity for display, snapping to a common cooking fraction when the
 * value is close to one. Values that are not near any common fraction keep a
 * decimal representation rather than being forced into a misleading fraction.
 */
export function formatQuantity(
  value: Numeric,
  options: FormatOptions = {},
): string {
  const amount = new Decimal(value);
  if (!amount.isFinite()) return '';

  const { fractions = true, maxDecimals = 2 } = options;
  const negative = amount.isNegative();
  const magnitude = amount.abs();

  if (fractions) {
    const whole = magnitude.floor();
    const remainder = magnitude.minus(whole).toNumber();

    // Close enough to a whole number that the fraction is noise.
    if (remainder <= SNAP_TOLERANCE) {
      return `${negative ? '-' : ''}${whole.toFixed(0)}`;
    }
    if (remainder >= 1 - SNAP_TOLERANCE) {
      return `${negative ? '-' : ''}${whole.plus(1).toFixed(0)}`;
    }

    const match = COMMON_FRACTIONS.find(
      (candidate) => Math.abs(candidate.value - remainder) <= SNAP_TOLERANCE,
    );
    if (match) {
      const sign = negative ? '-' : '';
      return whole.isZero()
        ? `${sign}${match.glyph}`
        : `${sign}${whole.toFixed(0)} ${match.glyph}`;
    }
  }

  // No clean fraction — show a decimal with trailing zeros stripped.
  return amount.toDecimalPlaces(maxDecimals, Decimal.ROUND_HALF_UP).toString();
}

/**
 * Formats a quantity together with its unit, choosing sensible defaults per unit
 * kind and pluralising the unit name.
 *
 * @example formatWithUnit(1.5, cups)   // "1 ½ cups"
 * @example formatWithUnit(237, grams)  // "237 g"
 */
export function formatWithUnit(
  value: Numeric,
  unit: UnitDef & { plural?: string; abbrev?: string | null },
  options: FormatOptions = {},
): string {
  const useFractions = options.fractions ?? unit.kind !== UnitKind.MASS;
  const text = formatQuantity(value, { ...options, fractions: useFractions });

  const label = unit.abbrev ?? pluralise(unit, value);
  return label ? `${text} ${label}` : text;
}

function pluralise(
  unit: UnitDef & { plural?: string },
  value: Numeric,
): string {
  const amount = new Decimal(value);
  const isOne = amount.abs().equals(1);
  return isOne ? unit.name : (unit.plural ?? `${unit.name}s`);
}

/**
 * Parses user input that may contain a vulgar fraction or a mixed number —
 * "1 1/2", "1 ½", ".5", "2" — into a Decimal. Returns null if unparseable, so
 * callers can show a validation message rather than silently storing NaN.
 */
export function parseQuantity(input: string): Decimal | null {
  const normalised = input
    .trim()
    .replace(/[⅛]/g, ' 1/8')
    .replace(/[¼]/g, ' 1/4')
    .replace(/[⅓]/g, ' 1/3')
    .replace(/[⅜]/g, ' 3/8')
    .replace(/[½]/g, ' 1/2')
    .replace(/[⅝]/g, ' 5/8')
    .replace(/[⅔]/g, ' 2/3')
    .replace(/[¾]/g, ' 3/4')
    .replace(/[⅞]/g, ' 7/8')
    .trim();

  if (!normalised) return null;

  const mixed = normalised.match(/^(-?\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) {
    const [, whole, numerator, denominator] = mixed;
    if (Number(denominator) === 0) return null;
    const wholePart = new Decimal(whole);
    const fraction = new Decimal(numerator).div(denominator);
    return wholePart.isNegative()
      ? wholePart.minus(fraction)
      : wholePart.plus(fraction);
  }

  const simple = normalised.match(/^(-?\d+)\s*\/\s*(\d+)$/);
  if (simple) {
    const [, numerator, denominator] = simple;
    if (Number(denominator) === 0) return null;
    return new Decimal(numerator).div(denominator);
  }

  try {
    const parsed = new Decimal(normalised);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}
