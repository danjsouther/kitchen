/**
 * Turning a recipe into a list of pantry withdrawals.
 *
 * Cooking is the point where recipes and the pantry finally meet: a meal planned
 * for 6 from a recipe written for 4 needs every line scaled by 1.5 and then taken
 * out of stock. This module does the classifying and scaling; the actual
 * allocation across lots is `pantry/deduction.ts`, unchanged.
 *
 * Nothing here writes, and nothing here guesses. A line that cannot become a
 * withdrawal is returned in `skipped` with the reason, because a cook that
 * silently ignores three of its twelve ingredients leaves a pantry that quietly
 * disagrees with reality.
 */

import Decimal from 'decimal.js';
import { scaleForServings, type UnitDef } from '@kitchen/shared-types';

/** Why a recipe line took no part in the deduction. */
export const SkipReason = {
  /** No catalog ingredient — "salt and pepper to taste", or an unmatched parse. */
  UNRESOLVED: 'UNRESOLVED',
  /** Resolved, but with no amount to subtract. */
  NO_QUANTITY: 'NO_QUANTITY',
  /** Resolved and quantified, but no unit to measure it in. */
  NO_UNIT: 'NO_UNIT',
  /** Marked optional in the recipe, so we cannot assume it was used. */
  OPTIONAL: 'OPTIONAL',
} as const;
export type SkipReason = (typeof SkipReason)[keyof typeof SkipReason];

export interface CookLine {
  id: number;
  rawText: string;
  ingredientId: number | null;
  quantity: Decimal.Value | null;
  unit: UnitDef | null;
  optional: boolean;
}

export interface Withdrawal {
  lineId: number;
  rawText: string;
  ingredientId: number;
  /** The recipe amount scaled to the servings actually being cooked. */
  quantity: Decimal;
  unit: UnitDef;
}

export interface SkippedLine {
  lineId: number;
  rawText: string;
  reason: SkipReason;
}

export interface CookPlan {
  withdrawals: Withdrawal[];
  skipped: SkippedLine[];
  /** targetServings / recipeServings — 1 when the meal is cooked as written. */
  factor: Decimal;
}

/**
 * Works out what to take out of the pantry for one meal.
 *
 * Optional lines are deliberately *not* deducted. "Optional" means the recipe
 * does not require it, so assuming it was used would remove stock that is still
 * on the shelf — and an over-deduction is worse than an under-deduction, because
 * it sends someone shopping for something they already have. They are reported
 * rather than dropped, so the cook can adjust by hand if they did use them.
 */
export function planCook(
  lines: readonly CookLine[],
  recipeServings: number,
  targetServings: number,
): CookPlan {
  const withdrawals: Withdrawal[] = [];
  const skipped: SkippedLine[] = [];

  for (const line of lines) {
    const skip = (reason: SkipReason) =>
      skipped.push({ lineId: line.id, rawText: line.rawText, reason });

    if (line.optional) {
      skip(SkipReason.OPTIONAL);
      continue;
    }
    if (line.ingredientId === null) {
      skip(SkipReason.UNRESOLVED);
      continue;
    }
    if (line.quantity === null || line.quantity === undefined) {
      skip(SkipReason.NO_QUANTITY);
      continue;
    }
    if (line.unit === null) {
      skip(SkipReason.NO_UNIT);
      continue;
    }

    const quantity = scaleForServings(line.quantity, recipeServings, targetServings);
    // A zero or negative line has nothing to withdraw; treat it as unquantified
    // rather than issuing a no-op request the pantry would have to interpret.
    if (quantity.lte(0)) {
      skip(SkipReason.NO_QUANTITY);
      continue;
    }

    withdrawals.push({
      lineId: line.id,
      rawText: line.rawText,
      ingredientId: line.ingredientId,
      quantity,
      unit: line.unit,
    });
  }

  return {
    withdrawals,
    skipped,
    factor: scaleForServings(1, recipeServings, targetServings),
  };
}

/**
 * Merges withdrawals that name the same ingredient *in the same unit*.
 *
 * A recipe can list one ingredient twice — "1 cup flour" for the dough and
 * "2 tbsp flour" for dusting. Deducting them as separate requests would walk the
 * lots twice and could report a shortfall on the second when the first had
 * already emptied a lot.
 *
 * Lines in different units are left separate rather than converted here: merging
 * them would need the ingredient's density, and a conversion failure at this
 * stage has nowhere honest to go. The deduction step handles mixed units per
 * request already.
 */
export function mergeWithdrawals(withdrawals: readonly Withdrawal[]): Withdrawal[] {
  const merged = new Map<string, Withdrawal>();

  for (const withdrawal of withdrawals) {
    const key = `${withdrawal.ingredientId}:${withdrawal.unit.id}`;
    const existing = merged.get(key);
    if (existing) {
      existing.quantity = existing.quantity.add(withdrawal.quantity);
      existing.rawText = `${existing.rawText}; ${withdrawal.rawText}`;
    } else {
      merged.set(key, { ...withdrawal, quantity: new Decimal(withdrawal.quantity) });
    }
  }

  return [...merged.values()];
}
