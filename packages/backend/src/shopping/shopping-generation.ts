/**
 * Turning a week of planned meals into one shopping list.
 *
 * This is the last of the four applications of the conversion engine, and the
 * one with the most steps: gather what the plan demands, fold repeated
 * ingredients together, subtract what is already in the pantry, add anything
 * below its par level, then sort the result into store-walk order.
 *
 * Nothing here writes. It produces a *proposal* the user reviews before anything
 * is persisted, because a generated list is a guess about a week that has not
 * happened yet.
 */

import Decimal from 'decimal.js';
import {
  ConversionFailure,
  IngredientPhysicals,
  ItemSource,
  UnitDef,
  convert,
} from '@recipes/shared-types';

/** One scaled requirement from one planned meal. */
export interface DemandLine {
  plannedMealId: number;
  recipeId: number;
  recipeTitle: string;
  date: Date;
  ingredientId: number;
  ingredientName: string;
  rawText: string;
  quantity: Decimal.Value;
  unit: UnitDef;
}

export interface ParLine {
  ingredientId: number;
  minQuantity: Decimal.Value;
  unit: UnitDef;
}

export interface PantryOnHand {
  total: Decimal;
  unit: UnitDef;
}

/** Everything known about an ingredient that shapes its line on the list. */
export interface IngredientInfo {
  name: string;
  physicals?: IngredientPhysicals;
  /** The unit the list should buy in, when the ingredient declares one. */
  defaultUnit?: UnitDef | null;
  categoryId: number | null;
  categorySortOrder: number;
  /** Most recent observation, used to prefill a price and a brand. */
  lastPrice?: { pricePerUnit: Decimal; unit: UnitDef; brand: string | null } | null;
}

export interface ProposedItem {
  ingredientId: number;
  ingredientName: string;
  quantity: string;
  unit: UnitDef;
  source: ItemSource;
  /** The meals that asked for this, so the review screen can explain the line. */
  forMeals: Array<{ plannedMealId: number; recipeTitle: string; date: Date }>;
  /** What the pantry already holds, in `unit`. Null when it could not be counted. */
  onHand: string | null;
  /** True when this line could not be folded in with the rest of its ingredient. */
  unconvertible: boolean;
  /** Why, when `unconvertible`. */
  reason?: ConversionFailure;
  estimatedPrice: string | null;
  brand: string | null;
  categoryId: number | null;
  sortOrder: number;
}

export interface GenerationInput {
  demand: readonly DemandLine[];
  pars: readonly ParLine[];
  balances: ReadonlyMap<number, PantryOnHand>;
  ingredients: ReadonlyMap<number, IngredientInfo>;
  /** Per-store aisle order, overriding the ingredient category's own. */
  aisleOrder?: ReadonlyMap<number, number>;
}

/**
 * Builds the proposal.
 *
 * The direction of every guess is deliberate: when the pantry balance cannot be
 * converted into the unit being bought, the amount on hand is **not** subtracted
 * and the line is flagged. That over-buys, which is the safe direction here —
 * arriving at the stove without an ingredient costs a meal, while a spare bag of
 * something costs a shelf. (This is the opposite of how the recipe parser treats
 * an ambiguous range, and for the opposite reason: a range is a recipe author's
 * latitude, where less is a valid choice, whereas an uncountable balance is
 * missing information.)
 */
export function generateProposal(input: GenerationInput): ProposedItem[] {
  const groups = groupDemand(input);

  const items: ProposedItem[] = [];
  const seenIngredients = new Set<number>();

  for (const group of groups) {
    seenIngredients.add(group.ingredientId);
    const info = input.ingredients.get(group.ingredientId);

    // Lines that would not fold in with the rest keep their own row rather than
    // being dropped or silently added to a total they do not belong in.
    if (group.unconvertible) {
      items.push(
        toItem(group, info, {
          source: ItemSource.RECIPE,
          onHand: null,
          quantity: group.quantity,
          unconvertible: true,
          reason: group.reason,
          aisleOrder: input.aisleOrder,
        }),
      );
      continue;
    }

    const onHand = onHandIn(group.unit, input.balances.get(group.ingredientId), info);
    const stillNeeded = onHand.known
      ? group.quantity.minus(onHand.amount)
      : group.quantity;

    if (stillNeeded.lte(0)) continue;

    items.push(
      toItem(group, info, {
        source: ItemSource.RECIPE,
        onHand: onHand.known ? onHand.amount.toString() : null,
        quantity: stillNeeded,
        unconvertible: false,
        aisleOrder: input.aisleOrder,
      }),
    );
  }

  // Par shortfalls for anything the plan did not already cover. An ingredient the
  // plan needs is handled above; adding its par on top would buy it twice.
  for (const par of input.pars) {
    if (seenIngredients.has(par.ingredientId)) continue;

    const info = input.ingredients.get(par.ingredientId);
    const onHand = onHandIn(par.unit, input.balances.get(par.ingredientId), info);
    if (!onHand.known && input.balances.has(par.ingredientId)) {
      // Stock exists but cannot be counted in the par's unit. Claiming a
      // shortfall would be a guess in the expensive direction, so the line is
      // left off and the pantry screen's `below: null` remains the honest answer.
      continue;
    }

    const shortfall = new Decimal(par.minQuantity).minus(onHand.amount);
    if (shortfall.lte(0)) continue;

    items.push(
      toItem(
        {
          ingredientId: par.ingredientId,
          ingredientName: info?.name ?? `Ingredient ${par.ingredientId}`,
          quantity: shortfall,
          unit: par.unit,
          forMeals: [],
          unconvertible: false,
        },
        info,
        {
          source: ItemSource.PAR,
          onHand: onHand.amount.toString(),
          quantity: shortfall,
          unconvertible: false,
          aisleOrder: input.aisleOrder,
        },
      ),
    );
  }

  return items.sort(
    (a, b) => a.sortOrder - b.sortOrder || a.ingredientName.localeCompare(b.ingredientName),
  );
}

interface DemandGroup {
  ingredientId: number;
  ingredientName: string;
  quantity: Decimal;
  unit: UnitDef;
  forMeals: ProposedItem['forMeals'];
  unconvertible: boolean;
  reason?: ConversionFailure;
}

/**
 * Folds every demand line for one ingredient into a single amount.
 *
 * The target unit is the ingredient's declared default where it has one — that
 * is the unit the household thinks in for it — falling back to whatever the first
 * line used.
 */
function groupDemand(input: GenerationInput): DemandGroup[] {
  const groups = new Map<number, DemandGroup>();
  const strays: DemandGroup[] = [];

  for (const line of input.demand) {
    const info = input.ingredients.get(line.ingredientId);
    const existing = groups.get(line.ingredientId);

    if (!existing) {
      const target = info?.defaultUnit ?? line.unit;
      const converted = convert(line.quantity, line.unit, target, info?.physicals);

      groups.set(line.ingredientId, {
        ingredientId: line.ingredientId,
        ingredientName: line.ingredientName,
        quantity: converted.ok ? converted.quantity : new Decimal(line.quantity),
        unit: converted.ok ? target : line.unit,
        forMeals: [
          { plannedMealId: line.plannedMealId, recipeTitle: line.recipeTitle, date: line.date },
        ],
        unconvertible: false,
      });
      continue;
    }

    const converted = convert(line.quantity, line.unit, existing.unit, info?.physicals);
    if (converted.ok) {
      existing.quantity = existing.quantity.add(converted.quantity);
      existing.forMeals.push({
        plannedMealId: line.plannedMealId,
        recipeTitle: line.recipeTitle,
        date: line.date,
      });
    } else {
      // "2 kg beef + 3 sprigs thyme" cannot become one number. The stray keeps
      // its own row and says why, rather than being added in or thrown away.
      strays.push({
        ingredientId: line.ingredientId,
        ingredientName: line.ingredientName,
        quantity: new Decimal(line.quantity),
        unit: line.unit,
        forMeals: [
          { plannedMealId: line.plannedMealId, recipeTitle: line.recipeTitle, date: line.date },
        ],
        unconvertible: true,
        reason: converted.reason,
      });
    }
  }

  return [...groups.values(), ...strays];
}

/** The pantry balance expressed in `unit`, or a flag saying it could not be. */
function onHandIn(
  unit: UnitDef,
  balance: PantryOnHand | undefined,
  info: IngredientInfo | undefined,
): { known: boolean; amount: Decimal } {
  if (!balance) return { known: true, amount: new Decimal(0) };

  const converted = convert(balance.total, balance.unit, unit, info?.physicals);
  return converted.ok
    ? { known: true, amount: converted.quantity }
    : { known: false, amount: new Decimal(0) };
}

function toItem(
  group: DemandGroup,
  info: IngredientInfo | undefined,
  options: {
    source: ItemSource;
    onHand: string | null;
    quantity: Decimal;
    unconvertible: boolean;
    reason?: ConversionFailure;
    aisleOrder?: ReadonlyMap<number, number>;
  },
): ProposedItem {
  const categoryId = info?.categoryId ?? null;

  // The store's own aisle order wins where it has one, so the list reads in the
  // order the shopper actually walks; the category's default is the fallback.
  const sortOrder =
    (categoryId !== null ? options.aisleOrder?.get(categoryId) : undefined) ??
    info?.categorySortOrder ??
    Number.MAX_SAFE_INTEGER;

  const price = estimatePrice(options.quantity, group.unit, info);

  return {
    ingredientId: group.ingredientId,
    ingredientName: group.ingredientName,
    quantity: options.quantity.toString(),
    unit: group.unit,
    source: options.source,
    forMeals: group.forMeals,
    onHand: options.onHand,
    unconvertible: options.unconvertible,
    ...(options.reason ? { reason: options.reason } : {}),
    estimatedPrice: price,
    brand: info?.lastPrice?.brand ?? null,
    categoryId,
    sortOrder,
  };
}

/**
 * Prefills a price from the last time this was bought.
 *
 * Returns null rather than a number whenever the past purchase cannot be
 * converted into the unit being bought now — a running total built from a
 * guessed conversion is worse than one with a gap in it, because the gap is
 * visible.
 */
export function estimatePrice(
  quantity: Decimal,
  unit: UnitDef,
  info: IngredientInfo | undefined,
): string | null {
  const last = info?.lastPrice;
  if (!last) return null;

  const oneUnit = convert(1, unit, last.unit, info?.physicals);
  if (!oneUnit.ok) return null;

  return quantity.mul(oneUnit.quantity).mul(last.pricePerUnit).toDecimalPlaces(2).toString();
}
