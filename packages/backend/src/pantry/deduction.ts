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
} from '@kitchen/shared-types';

import { normalizeBarcode } from '../off/barcode';
import type { BalanceLot } from './pantry-balance';

export interface Allocation {
  lotId: number;
  /** How much to take, in the lot's own unit — what gets written to the row. */
  take: Decimal;
  /** What the lot holds afterwards. Never negative. */
  remaining: Decimal;
  /**
   * The same amount expressed in the requested unit.
   *
   * Null only when a user stated this draw outright and it could not be
   * converted: the withdrawal is real and gets written, but what it was worth
   * against the request is genuinely unknown, and zero would be a lie.
   */
  takeInRequestUnit: Decimal | null;
}

export interface DeductionPlan {
  allocations: Allocation[];
  /** Total actually allocated, in the requested unit. */
  allocated: Decimal;
  /** What the pantry could not cover, in the requested unit. Zero when satisfied. */
  shortfall: Decimal;
  /**
   * Lots skipped because their unit could not be reconciled with the request.
   * These were **left untouched**.
   */
  unusable: Array<{ lotId: number; unit: UnitDef; reason: ConversionFailure }>;
  /**
   * Lots that **were** deducted on the user's instruction but could not be
   * counted towards the request.
   *
   * Deliberately not folded into `unusable`, which every consumer renders as
   * "left alone". "I took half a cup and cannot tell you what that is in grams"
   * is a third state, and collapsing it into either of the other two would
   * either hide a real withdrawal or invent one.
   */
  unmeasured: Array<{
    lotId: number;
    unit: UnitDef;
    reason: ConversionFailure;
    took: Decimal;
  }>;
}

/** One "I used this much of this jar", in the jar's own unit. */
export interface ExplicitDraw {
  lotId: number;
  /**
   * In the **lot's** unit, not the request's — it is the number the user was
   * looking at on the shelf, and converting what they typed before storing it
   * would show them back a figure they never entered.
   */
  quantity: Decimal.Value;
}

/**
 * A deduction narrowed to one lot, or to every lot carrying one product.
 *
 * The two are mutually exclusive. `lotId` is "use *this* jar"; `productId` is
 * "use the Barilla, whichever jar of it is oldest" — the second still spans
 * lots and still runs soonest-expiry-first within them.
 */
export interface DeductionPin {
  lotId?: number;
  productId?: string;
}

export const PinFailure = {
  /** Both fields given. There is no sensible intersection to guess at. */
  BOTH_GIVEN: 'BOTH_GIVEN',
  /** The lot is not among the ones offered — deleted, or another ingredient's. */
  NO_SUCH_LOT: 'NO_SUCH_LOT',
  /** No lot on offer carries that barcode. */
  NO_SUCH_PRODUCT: 'NO_SUCH_PRODUCT',
} as const;

export type PinFailure = (typeof PinFailure)[keyof typeof PinFailure];

export type PinResult<T> =
  | { ok: true; lots: readonly T[] }
  | { ok: false; reason: PinFailure };

/**
 * Narrows candidate lots to a pin, so a deduction can target one jar instead of
 * the ingredient's whole shelf.
 *
 * An empty match is a **failure, not an empty list.** Returning zero lots would
 * flow into `planDeduction` and come back as a full shortfall — "you have none
 * of this" — when the truth is "the lot you pinned is gone". A stale pin has to
 * be named, and naming it is the caller's job, so this returns a typed reason
 * rather than throwing or guessing.
 *
 * Barcodes are compared **normalized on both sides**. A lot stocked from a US
 * pack scans as 12-digit UPC-A while OFF stored the EAN-13 with its leading
 * zero; comparing the raw strings would miss the row sitting right there.
 */
export function selectPinnedLots<T extends { id: number; productId?: string | null }>(
  lots: readonly T[],
  pin: DeductionPin | undefined,
): PinResult<T> {
  const lotId = pin?.lotId;
  const productId = pin?.productId;

  if (lotId !== undefined && productId !== undefined && productId !== '') {
    return { ok: false, reason: PinFailure.BOTH_GIVEN };
  }

  if (lotId !== undefined) {
    const found = lots.find((lot) => lot.id === lotId);
    if (!found) return { ok: false, reason: PinFailure.NO_SUCH_LOT };
    return { ok: true, lots: [found] };
  }

  if (productId !== undefined && productId !== '') {
    const wanted = normalizeBarcode(productId);
    // An unreadable barcode cannot match anything, which is the same outcome as
    // matching nothing — report it the same way rather than inventing a reason.
    const matched = wanted
      ? lots.filter((lot) => normalizeBarcode(lot.productId) === wanted)
      : [];
    if (matched.length === 0) return { ok: false, reason: PinFailure.NO_SUCH_PRODUCT };
    return { ok: true, lots: matched };
  }

  return { ok: true, lots };
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
      unmeasured: [],
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
    // Auto-allocation never touches a lot it could not convert, so there is
    // never anything here — the state only arises when a user insists.
    unmeasured: [],
  };
}

/**
 * Applies a deduction the user worked out themselves, lot by lot.
 *
 * Auto-allocation answers "where should this come from?"; this answers nothing,
 * because the user already did. "I used 300 g of the old bag and 200 g of the
 * new one" is a statement about what happened in a kitchen, not a request for a
 * plan, so there is no expiry ordering here and no searching for cover.
 *
 * What it still enforces, because these are facts about the data rather than
 * about the user's intent:
 *
 *  * **No lot goes negative.** A draw is clamped to what the lot holds. Someone
 *    typing 900 into a 700 g bag has misread the bag, and recording -200 g of
 *    flour would poison every later sum.
 *  * **An amount that cannot be converted is still recorded, but never
 *    counted.** The withdrawal happened; what it was worth against the recipe
 *    is unknown, and `unmeasured` says so rather than quietly adding zero.
 *
 * Draws naming a lot that is not on offer are skipped here; callers validate
 * that first so they can name the lot in the error.
 */
export function planExplicitDeduction(
  request: { quantity: Decimal.Value; unit: UnitDef },
  draws: readonly ExplicitDraw[],
  lots: readonly BalanceLot[],
  physicals?: IngredientPhysicals,
): DeductionPlan {
  const byId = new Map(lots.map((lot) => [lot.id, lot]));
  const allocations: Allocation[] = [];
  const unmeasured: DeductionPlan['unmeasured'] = [];
  let allocated = new Decimal(0);

  for (const draw of draws) {
    const lot = byId.get(draw.lotId);
    if (!lot) continue;

    const wanted = new Decimal(draw.quantity);
    // Zero is how "leave this jar alone" is expressed, so it is not an error —
    // it simply produces no allocation and no ledger row.
    if (wanted.lte(0)) continue;

    const held = new Decimal(lot.quantity);
    if (held.lte(0)) continue;

    const take = Decimal.min(wanted, held);
    const takeInRequestUnit = convert(take, lot.unit, request.unit, physicals);

    if (takeInRequestUnit.ok) {
      allocated = allocated.plus(takeInRequestUnit.quantity);
    } else {
      unmeasured.push({
        lotId: lot.id,
        unit: lot.unit,
        reason: takeInRequestUnit.reason,
        took: take,
      });
    }

    allocations.push({
      lotId: lot.id,
      take,
      remaining: held.minus(take),
      takeInRequestUnit: takeInRequestUnit.ok ? takeInRequestUnit.quantity : null,
    });
  }

  const requested = new Decimal(request.quantity);
  // Drawing more than the recipe asked for is not an error — cooks do that —
  // so a surplus reports as no shortfall rather than a negative one.
  const shortfall = Decimal.max(requested.minus(allocated), 0);

  return { allocations, allocated, shortfall, unusable: [], unmeasured };
}
