/**
 * "What can I cook right now?", answered by arithmetic.
 *
 * This is the source of truth about quantities. The AI method (phase 6, second
 * half) is grounded on this output and is not allowed to recompute any of it —
 * which only works if this never overstates what is on hand.
 *
 * So every recipe line lands in exactly one of three buckets:
 *
 *   have     — enough in the pantry, proven by conversion
 *   missing  — not enough, with the shortfall
 *   unknown  — the comparison could not be made at all
 *
 * `unknown` is the bucket that matters. An ingredient measured in sprigs against
 * a recipe calling for grams is *not* evidence that the cook has it, and folding
 * it into `have` would produce a confident "you can make this" that sends someone
 * to the kitchen to find out otherwise.
 */

import Decimal from 'decimal.js';
import {
  ConversionFailure,
  IngredientPhysicals,
  UnitDef,
  convert,
  scaleForServings,
} from '@kitchen/shared-types';

/** What the pantry holds for one ingredient, already folded into a single unit. */
export interface PantryBalance {
  total: Decimal;
  unit: UnitDef;
  physicals?: IngredientPhysicals;
}

export interface MatchLine {
  lineId: number;
  ingredientId: number | null;
  ingredientName: string | null;
  rawText: string;
  quantity: Decimal.Value | null;
  unit: UnitDef | null;
  optional: boolean;
}

export interface MatchRecipe {
  id: number;
  title: string;
  slug: string;
  servings: number;
  lines: MatchLine[];
}

export interface LineStatus {
  ingredientId: number;
  ingredientName: string | null;
  rawText: string;
  /** Amount the recipe needs at the requested servings. */
  need: string;
  needUnit: UnitDef;
  /** What the pantry holds, in the same unit. Null when it could not be compared. */
  onHand: string | null;
  /** How much more is required. Null unless the line is short. */
  shortBy: string | null;
  /** Why the comparison failed, for `unknown` lines only. */
  reason?: ConversionFailure;
}

export interface RecipeMatch {
  recipeId: number;
  title: string;
  slug: string;
  /** Servings this match was computed for. */
  servings: number;
  recipeServings: number;
  have: LineStatus[];
  missing: LineStatus[];
  unknown: LineStatus[];
  /**
   * Lines that took no part: unresolved text, no quantity, or optional. Reported
   * so a "you can cook this" is never quietly resting on ignored lines.
   */
  ignoredCount: number;
  requiredCount: number;
  score: number;
  /**
   * True only when every required line is proven satisfied. An `unknown` line is
   * enough to make this false — see the module comment.
   */
  canCook: boolean;
}

/**
 * Scores one recipe against the pantry.
 *
 * Requirements are summed **per ingredient** before comparing, so a recipe using
 * flour for the dough and again for dusting is checked against the total it
 * actually needs rather than each line separately — which would pass both
 * against the same stock and claim the recipe is cookable when it is not.
 */
export function matchRecipe(
  recipe: MatchRecipe,
  balances: ReadonlyMap<number, PantryBalance>,
  targetServings?: number,
): RecipeMatch {
  const servings = targetServings ?? recipe.servings;

  const required = new Map<number, RequiredAmount>();
  let ignoredCount = 0;

  for (const line of recipe.lines) {
    if (
      line.optional ||
      line.ingredientId === null ||
      line.quantity === null ||
      line.unit === null
    ) {
      ignoredCount += 1;
      continue;
    }

    const need = scaleForServings(line.quantity, recipe.servings, servings);
    if (need.lte(0)) {
      ignoredCount += 1;
      continue;
    }

    addRequirement(required, {
      ingredientId: line.ingredientId,
      ingredientName: line.ingredientName,
      rawText: line.rawText,
      quantity: need,
      unit: line.unit,
      balance: balances.get(line.ingredientId),
    });
  }

  const have: LineStatus[] = [];
  const missing: LineStatus[] = [];
  const unknown: LineStatus[] = [];

  for (const entry of required.values()) {
    const status = compare(entry, balances.get(entry.ingredientId));
    if (status.bucket === 'have') have.push(status.line);
    else if (status.bucket === 'missing') missing.push(status.line);
    else unknown.push(status.line);
  }

  const requiredCount = required.size;

  return {
    recipeId: recipe.id,
    title: recipe.title,
    slug: recipe.slug,
    servings,
    recipeServings: recipe.servings,
    have,
    missing,
    unknown,
    ignoredCount,
    requiredCount,
    // A recipe with no checkable requirements scores 0 rather than a misleading
    // 1 — nothing was proven about it either way.
    score: requiredCount === 0 ? 0 : have.length / requiredCount,
    canCook: requiredCount > 0 && missing.length === 0 && unknown.length === 0,
  };
}

/**
 * Ranks recipes for the "what can I cook" screen.
 *
 * Fewest missing first, then fewest unknown, then the higher score: a recipe
 * that is one ingredient short is more useful to see than one that is merely
 * hard to check.
 */
export function rankMatches(
  recipes: readonly MatchRecipe[],
  balances: ReadonlyMap<number, PantryBalance>,
  options: { missingMax?: number; targetServings?: number } = {},
): RecipeMatch[] {
  const matches = recipes
    .map((recipe) => matchRecipe(recipe, balances, options.targetServings))
    .filter((match) => match.requiredCount > 0);

  const filtered =
    options.missingMax === undefined
      ? matches
      : matches.filter((match) => match.missing.length <= options.missingMax!);

  return filtered.sort(
    (a, b) =>
      a.missing.length - b.missing.length ||
      a.unknown.length - b.unknown.length ||
      b.score - a.score ||
      a.title.localeCompare(b.title),
  );
}

interface RequiredAmount {
  ingredientId: number;
  ingredientName: string | null;
  rawText: string;
  /** Running total, expressed in `unit`. */
  quantity: Decimal;
  unit: UnitDef;
}

/**
 * Adds a line's requirement to the running per-ingredient total.
 *
 * Later lines are converted into the unit already chosen for that ingredient —
 * preferring the pantry balance's unit, so the final comparison needs no further
 * conversion. A line that will not convert is kept separate rather than dropped;
 * `compare` will surface it as unknown.
 */
function addRequirement(
  required: Map<number, RequiredAmount>,
  entry: {
    ingredientId: number;
    ingredientName: string | null;
    rawText: string;
    quantity: Decimal;
    unit: UnitDef;
    balance?: PantryBalance;
  },
): void {
  const existing = required.get(entry.ingredientId);

  if (!existing) {
    const target = entry.balance?.unit ?? entry.unit;
    const inTarget = convert(
      entry.quantity,
      entry.unit,
      target,
      entry.balance?.physicals,
    );

    required.set(entry.ingredientId, {
      ingredientId: entry.ingredientId,
      ingredientName: entry.ingredientName,
      rawText: entry.rawText,
      // Falling back to the line's own unit keeps the requirement honest; the
      // comparison against the balance will then fail and report unknown.
      quantity: inTarget.ok ? inTarget.quantity : entry.quantity,
      unit: inTarget.ok ? target : entry.unit,
    });
    return;
  }

  const converted = convert(
    entry.quantity,
    entry.unit,
    existing.unit,
    entry.balance?.physicals,
  );
  if (converted.ok) {
    existing.quantity = existing.quantity.add(converted.quantity);
    existing.rawText = `${existing.rawText}; ${entry.rawText}`;
  } else {
    // Cannot be added up, so the requirement is not knowable. Marking the unit
    // mismatched makes `compare` report unknown rather than under-stating it.
    existing.quantity = existing.quantity.add(0);
    existing.rawText = `${existing.rawText}; ${entry.rawText}`;
    existing.unit = entry.unit;
  }
}

function compare(
  entry: RequiredAmount,
  balance: PantryBalance | undefined,
): { bucket: 'have' | 'missing' | 'unknown'; line: LineStatus } {
  const base: LineStatus = {
    ingredientId: entry.ingredientId,
    ingredientName: entry.ingredientName,
    rawText: entry.rawText,
    need: entry.quantity.toString(),
    needUnit: entry.unit,
    onHand: null,
    shortBy: null,
  };

  // Nothing in the pantry at all is a known quantity — zero — not an unknown.
  if (!balance) {
    return {
      bucket: 'missing',
      line: { ...base, onHand: '0', shortBy: entry.quantity.toString() },
    };
  }

  const onHand = convert(balance.total, balance.unit, entry.unit, balance.physicals);
  if (!onHand.ok) {
    return { bucket: 'unknown', line: { ...base, reason: onHand.reason } };
  }

  const shortBy = entry.quantity.minus(onHand.quantity);
  const line: LineStatus = {
    ...base,
    onHand: onHand.quantity.toString(),
    shortBy: shortBy.gt(0) ? shortBy.toString() : null,
  };

  return { bucket: shortBy.gt(0) ? 'missing' : 'have', line };
}
