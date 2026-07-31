/**
 * Taking an amount out of the pantry, across lots.
 *
 * "Use 300 g of rice" may span three lots in two different units, and the order
 * matters: whatever expires soonest should be used first, or the pantry slowly
 * fills with things that went bad while newer stock was eaten.
 *
 * This module only *plans* the deduction. It performs no writes and makes no
 * decisions about what to do when the pantry is short — the caller gets a plan
 * describing exactly what would happen, including any shortfall, and decides
 * whether to apply it. Cooking a recipe (phase 5) reuses this unchanged.
 */

import Decimal from 'decimal.js';
import {
  ConversionFailure,
  IngredientPhysicals,
  UnitDef,
  convert,
} from '@recipes/shared-types';

import type { BalanceLot } from './pantry-balance';

export interface Allocation {
  lotId: number;
  /** How much to take, in the lot's own unit — what gets written to the row. */
  take: Decimal;
  /** What the lot holds afterwards. Never negative. */
  remaining: Decimal;
  /** The same amount expressed in the requested unit, for the ledger. */
  takeInRequestUnit: Decimal;
}

export interface DeductionPlan {
  allocations: Allocation[];
  /** Total actually allocated, in the requested unit. */
  allocated: Decimal;
  /** What the pantry could not cover, in the requested unit. Zero when satisfied. */
  shortfall: Decimal;
  /** Lots skipped because their unit could not be reconciled with the request. */
  unusable: Array<{ lotId: number; unit: UnitDef; reason: ConversionFailure }>;
}

/**
 * Orders lots for consumption: soonest expiry first.
 *
 * Undated lots sort *last*, not first. A lot with no expiry date is one that
 * either does not spoil or was never dated; either way it is not the one at risk,
 * so the dated stock should go first. Ties break on id to keep the order stable
 * across calls — an unstable order would make the same request produce different
 * ledger rows each time.
 */
export function byExpiryThenId(a: BalanceLot, b: BalanceLot): number {
  const aTime = a.expiresOn ? a.expiresOn.getTime() : Number.POSITIVE_INFINITY;
  const bTime = b.expiresOn ? b.expiresOn.getTime() : Number.POSITIVE_INFINITY;
  if (aTime !== bTime) return aTime - bTime;
  return a.id - b.id;
}

/**
 * Works out which lots to draw an amount from.
 *
 * The two rules that matter:
 *
 *  * **No lot is ever driven negative.** A lot contributes at most what it holds;
 *    anything left over becomes `shortfall`. Forcing a negative balance would
 *    turn one mis-scaled cook into a pantry full of impossible numbers.
 *  * **A lot that cannot be converted is skipped and reported**, not guessed at.
 *    It stays untouched and appears in `unusable`, so the caller can tell the
 *    user which lot needs a density before the maths can include it.
 */
export function planDeduction(
  request: { quantity: Decimal.Value; unit: UnitDef },
  lots: readonly BalanceLot[],
  physicals?: IngredientPhysicals,
): DeductionPlan {
  let outstanding = new Decimal(request.quantity);
  const allocations: Allocation[] = [];
  const unusable: DeductionPlan['unusable'] = [];

  if (outstanding.lte(0)) {
    return {
      allocations: [],
      allocated: new Decimal(0),
      shortfall: new Decimal(0),
      unusable: [],
    };
  }

  for (const lot of [...lots].sort(byExpiryThenId)) {
    if (outstanding.lte(0)) break;

    const held = new Decimal(lot.quantity);
    if (held.lte(0)) continue;

    // How much this lot holds, measured in the unit that was asked for.
    const heldInRequestUnit = convert(held, lot.unit, request.unit, physicals);
    if (!heldInRequestUnit.ok) {
      unusable.push({ lotId: lot.id, unit: lot.unit, reason: heldInRequestUnit.reason });
      continue;
    }

    const takeInRequestUnit = Decimal.min(outstanding, heldInRequestUnit.quantity);

    // Convert back rather than scaling `held`: the round trip is exact for the
    // whole-lot case, which is the common one, and keeps the stored quantity in
    // the lot's own unit where the user expects to see it.
    const takeInLotUnit = convert(takeInRequestUnit, request.unit, lot.unit, physicals);
    if (!takeInLotUnit.ok) {
      unusable.push({ lotId: lot.id, unit: lot.unit, reason: takeInLotUnit.reason });
      continue;
    }

    // Guard against a rounding overshoot leaving a lot fractionally negative.
    const take = Decimal.min(takeInLotUnit.quantity, held);

    allocations.push({
      lotId: lot.id,
      take,
      remaining: held.minus(take),
      takeInRequestUnit,
    });
    outstanding = outstanding.minus(takeInRequestUnit);
  }

  const requested = new Decimal(request.quantity);
  const shortfall = outstanding.gt(0) ? outstanding : new Decimal(0);

  return {
    allocations,
    allocated: requested.minus(shortfall),
    shortfall,
    unusable,
  };
}
