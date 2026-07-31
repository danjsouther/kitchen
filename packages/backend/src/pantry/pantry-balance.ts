/**
 * On-hand balances across pantry lots.
 *
 * A household with two half-used bags of rice — one in grams, one in cups — has
 * one *balance* and two *lots*. Producing that single number is an application of
 * the conversion engine, and it inherits the engine's rule: a lot that cannot be
 * converted is reported, never dropped. "2 kg on hand" when a third lot silently
 * failed to convert is a worse answer than "2 kg, plus 3 sprigs we couldn't
 * combine".
 */

import Decimal from 'decimal.js';
import {
  ConversionFailure,
  IngredientPhysicals,
  UnitDef,
  convert,
} from '@recipes/shared-types';

/** The subset of a pantry lot the balance maths needs. */
export interface BalanceLot {
  id: number;
  quantity: Decimal.Value;
  unit: UnitDef;
  expiresOn?: Date | null;
}

export interface UnconvertibleLot {
  lotId: number;
  quantity: string;
  unit: UnitDef;
  reason: ConversionFailure;
}

export interface IngredientBalance {
  /** Total of every lot that converted, in `unit`. Null when none did. */
  total: Decimal | null;
  /** The unit `total` is expressed in. Null when nothing converted. */
  unit: UnitDef | null;
  lotCount: number;
  /**
   * Lots that could not be folded into the total, with the specific missing
   * datum. The UI shows these alongside the total rather than hiding them.
   */
  unconvertible: UnconvertibleLot[];
}

/**
 * Picks the unit a balance should be reported in.
 *
 * Preference order: the ingredient's declared default, then whichever unit the
 * most lots already use, then the first lot's. The middle rule matters more than
 * it looks — reporting in the unit the household actually stocks means the
 * common case needs no conversion at all, so it cannot fail.
 */
export function chooseTargetUnit(
  lots: readonly BalanceLot[],
  preferred?: UnitDef | null,
): UnitDef | null {
  if (preferred) return preferred;
  if (lots.length === 0) return null;

  const counts = new Map<number, { unit: UnitDef; count: number }>();
  for (const lot of lots) {
    const entry = counts.get(lot.unit.id);
    if (entry) entry.count += 1;
    else counts.set(lot.unit.id, { unit: lot.unit, count: 1 });
  }

  let best = counts.get(lots[0].unit.id)!;
  for (const entry of counts.values()) {
    if (entry.count > best.count) best = entry;
  }
  return best.unit;
}

/**
 * Sums one ingredient's lots into a single balance.
 *
 * `physicals` carries the ingredient's density and piece weight, which is what
 * lets a lot measured in cups join a total measured in grams. Without them a
 * cross-kind lot lands in `unconvertible` with the reason naming the datum the
 * user could supply to fix it.
 */
export function balanceFor(
  lots: readonly BalanceLot[],
  physicals?: IngredientPhysicals,
  preferred?: UnitDef | null,
): IngredientBalance {
  const unit = chooseTargetUnit(lots, preferred);
  if (!unit) {
    return { total: null, unit: null, lotCount: 0, unconvertible: [] };
  }

  let total = new Decimal(0);
  let converted = 0;
  const unconvertible: UnconvertibleLot[] = [];

  for (const lot of lots) {
    const result = convert(lot.quantity, lot.unit, unit, physicals);
    if (result.ok) {
      total = total.add(result.quantity);
      converted += 1;
    } else {
      unconvertible.push({
        lotId: lot.id,
        quantity: new Decimal(lot.quantity).toString(),
        unit: lot.unit,
        reason: result.reason,
      });
    }
  }

  return {
    // Reporting 0 when nothing converted would read as "none in stock", which is
    // a different and wrong claim from "we couldn't total this up".
    total: converted > 0 ? total : null,
    unit,
    lotCount: lots.length,
    unconvertible,
  };
}

/**
 * Whether a balance has fallen below its par level.
 *
 * Returns `null` — not false — when the comparison cannot be made, because a par
 * of "500 g" against a balance we could only express in sprigs is unknown, not
 * satisfied. A false "you have enough" is exactly the failure that leaves someone
 * at the stove without an ingredient.
 */
export function shortfallAgainstPar(
  balance: IngredientBalance,
  par: { quantity: Decimal.Value; unit: UnitDef },
  physicals?: IngredientPhysicals,
): { short: boolean; by: Decimal; unit: UnitDef } | null {
  const parQuantity = new Decimal(par.quantity);

  // Nothing on hand at all: the whole par is the shortfall, no conversion needed.
  if (balance.total === null || balance.unit === null) {
    return balance.lotCount === 0
      ? { short: parQuantity.gt(0), by: parQuantity, unit: par.unit }
      : null;
  }

  const onHand = convert(balance.total, balance.unit, par.unit, physicals);
  if (!onHand.ok) return null;

  const by = parQuantity.minus(onHand.quantity);
  return { short: by.gt(0), by: by.gt(0) ? by : new Decimal(0), unit: par.unit };
}
