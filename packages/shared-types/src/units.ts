/**
 * Unit conversion engine.
 *
 * This is the foundation of the app: pantry deduction, "what can I cook now",
 * shopping-list aggregation and recipe scaling are all applications of `convert`.
 * It lives in shared-types so the frontend can preview a conversion live in a form
 * without a round trip, and the backend can run the identical logic server-side.
 *
 * THE RULE THAT MATTERS: a conversion that cannot be performed returns
 * `{ ok: false, reason }`. It never throws, and it never guesses a number. Every
 * caller must handle the failure explicitly and surface it to the user, because a
 * silently wrong quantity is worse than a visibly incomplete one.
 *
 * Base units are gram (MASS), millilitre (VOLUME) and each (COUNT). Every unit
 * carries `toBaseFactor`, the multiplier into its kind's base unit.
 */

import Decimal from 'decimal.js';

import { UnitKind } from './enums';

/** Anything decimal.js accepts — notably including Prisma's `Decimal`. */
export type Numeric = Decimal.Value;

/** The subset of a Unit row the conversion engine needs. */
export interface UnitDef {
  id: number;
  name: string;
  kind: UnitKind;
  /** Multiplier into the kind's base unit (gram / millilitre / each). */
  toBaseFactor: Numeric;
}

/**
 * The per-ingredient physical data that bridges unit kinds. Both are optional —
 * most ingredients have neither, and conversions that need one will report the
 * specific missing datum so the UI can offer to fill it in.
 */
export interface IngredientPhysicals {
  /** Density: grams per millilitre. Bridges VOLUME <-> MASS. Flour ~0.53, water 1.0. */
  gramsPerMl?: Numeric | null;
  /** Piece weight: grams per item. Bridges COUNT <-> MASS. One egg ~50g. */
  gramsPerPiece?: Numeric | null;
}

export const ConversionFailure = {
  /** VOLUME <-> MASS needs `gramsPerMl` and the ingredient has none. */
  NO_DENSITY: 'NO_DENSITY',
  /** COUNT <-> MASS/VOLUME needs `gramsPerPiece` and the ingredient has none. */
  NO_PIECE_WEIGHT: 'NO_PIECE_WEIGHT',
  /** No ingredient was supplied for a cross-kind conversion that requires one. */
  NO_INGREDIENT: 'NO_INGREDIENT',
  /** A unit row is unusable — a non-positive or non-finite `toBaseFactor`. */
  INVALID_UNIT: 'INVALID_UNIT',
} as const;
export type ConversionFailure =
  (typeof ConversionFailure)[keyof typeof ConversionFailure];

export type ConversionResult =
  | { ok: true; quantity: Decimal }
  | { ok: false; reason: ConversionFailure };

/**
 * A unit's `toBaseFactor` must be a positive finite number. A zero or negative
 * factor is a data bug rather than a conversion limitation, but we still report it
 * as a result instead of throwing — a bad seed row should degrade one line of a
 * shopping list, not take down the request.
 */
function baseFactor(unit: UnitDef): Decimal | null {
  const factor = new Decimal(unit.toBaseFactor);
  if (!factor.isFinite() || factor.lte(0)) return null;
  return factor;
}

/** Reads a physical constant, treating null/zero/negative/non-finite as absent. */
function physical(value: Numeric | null | undefined): Decimal | null {
  if (value === null || value === undefined) return null;
  const decimal = new Decimal(value);
  if (!decimal.isFinite() || decimal.lte(0)) return null;
  return decimal;
}

/**
 * Converts an amount in the kind's base unit into another kind's base unit,
 * i.e. between grams, millilitres and pieces.
 */
function bridgeKinds(
  base: Decimal,
  from: UnitKind,
  to: UnitKind,
  ingredient: IngredientPhysicals | undefined,
): ConversionResult {
  if (!ingredient) return { ok: false, reason: ConversionFailure.NO_INGREDIENT };

  const density = physical(ingredient.gramsPerMl);
  const pieceWeight = physical(ingredient.gramsPerPiece);

  // Normalise to grams first, then out to the target kind. COUNT <-> VOLUME
  // therefore needs both constants, which is correct: "2 onions in millilitres"
  // requires knowing what an onion weighs *and* how dense it is.
  let grams: Decimal;
  switch (from) {
    case UnitKind.MASS:
      grams = base;
      break;
    case UnitKind.VOLUME:
      if (!density) return { ok: false, reason: ConversionFailure.NO_DENSITY };
      grams = base.mul(density);
      break;
    case UnitKind.COUNT:
      if (!pieceWeight) {
        return { ok: false, reason: ConversionFailure.NO_PIECE_WEIGHT };
      }
      grams = base.mul(pieceWeight);
      break;
  }

  switch (to) {
    case UnitKind.MASS:
      return { ok: true, quantity: grams };
    case UnitKind.VOLUME:
      if (!density) return { ok: false, reason: ConversionFailure.NO_DENSITY };
      return { ok: true, quantity: grams.div(density) };
    case UnitKind.COUNT:
      if (!pieceWeight) {
        return { ok: false, reason: ConversionFailure.NO_PIECE_WEIGHT };
      }
      return { ok: true, quantity: grams.div(pieceWeight) };
  }
}

/**
 * Converts `quantity` from one unit to another.
 *
 * Same-kind conversions need no ingredient. Cross-kind conversions need the
 * ingredient's density and/or piece weight; without them the result is
 * `{ ok: false }` naming the missing datum.
 *
 * @example
 * convert(2, cups, millilitres)                  // { ok: true, quantity: 473.176 }
 * convert(2, cups, grams, flour)                 // { ok: true, quantity: 250.7... }
 * convert(2, cups, grams, { })                   // { ok: false, reason: 'NO_DENSITY' }
 */
export function convert(
  quantity: Numeric,
  from: UnitDef,
  to: UnitDef,
  ingredient?: IngredientPhysicals,
): ConversionResult {
  const fromFactor = baseFactor(from);
  const toFactor = baseFactor(to);
  if (!fromFactor || !toFactor) {
    return { ok: false, reason: ConversionFailure.INVALID_UNIT };
  }

  const amount = new Decimal(quantity);
  if (!amount.isFinite()) {
    return { ok: false, reason: ConversionFailure.INVALID_UNIT };
  }

  const base = amount.mul(fromFactor);

  if (from.kind === to.kind) {
    return { ok: true, quantity: base.div(toFactor) };
  }

  const bridged = bridgeKinds(base, from.kind, to.kind, ingredient);
  if (!bridged.ok) return bridged;

  return { ok: true, quantity: bridged.quantity.div(toFactor) };
}

/** True when `convert` would succeed. Handy for enabling/disabling UI affordances. */
export function canConvert(
  from: UnitDef,
  to: UnitDef,
  ingredient?: IngredientPhysicals,
): boolean {
  return convert(1, from, to, ingredient).ok;
}

export interface QuantityInUnit {
  quantity: Numeric;
  unit: UnitDef;
}

export interface SumResult {
  /** Total of every entry that converted, expressed in `target`. */
  total: Decimal;
  /** Entries that could not be converted, with the reason. Never silently dropped. */
  unconvertible: Array<{ entry: QuantityInUnit; reason: ConversionFailure }>;
}

/**
 * Adds up quantities expressed in mixed units — pantry lots of one ingredient, or
 * the same ingredient appearing in several planned recipes.
 *
 * Entries that cannot be converted are returned in `unconvertible` rather than
 * being skipped, so callers can show "2 kg + 3 sprigs (couldn't combine)" instead
 * of quietly under-reporting the total.
 */
export function sumInUnit(
  entries: readonly QuantityInUnit[],
  target: UnitDef,
  ingredient?: IngredientPhysicals,
): SumResult {
  let total = new Decimal(0);
  const unconvertible: SumResult['unconvertible'] = [];

  for (const entry of entries) {
    const result = convert(entry.quantity, entry.unit, target, ingredient);
    if (result.ok) {
      total = total.add(result.quantity);
    } else {
      unconvertible.push({ entry, reason: result.reason });
    }
  }

  return { total, unconvertible };
}

/**
 * Scales a recipe quantity from its original serving count to a target.
 *
 * Always scale from the recipe's stored values. Scaling an already-scaled amount
 * compounds rounding, which is why display rounding happens at render time only
 * (see `formatQuantity`) and never on the way into the database.
 */
export function scaleForServings(
  quantity: Numeric,
  recipeServings: number,
  targetServings: number,
): Decimal {
  if (!Number.isFinite(recipeServings) || recipeServings <= 0) {
    return new Decimal(quantity);
  }
  return new Decimal(quantity).mul(targetServings).div(recipeServings);
}
