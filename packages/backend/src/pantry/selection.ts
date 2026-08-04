/**
 * Working out *which lots* a deduction touches, and how.
 *
 * Three ways a caller can say where an amount comes from, in increasing order
 * of how much the user has already decided:
 *
 *  1. **Nothing** — auto-allocate across every lot, soonest expiry first.
 *  2. **A pin** (`lotId`/`productId`) — auto-allocate, but only within that jar
 *     or that product.
 *  3. **Draws** — the user has done the arithmetic themselves and is stating
 *     what came out of each lot.
 *
 * Both services resolve through here so the three cannot drift apart, and so a
 * bad selection produces the same error text from the cook screen and the
 * pantry screen.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';

import { type DeductionPin, type ExplicitDraw, selectPinnedLots } from './deduction';
import { pinError } from './pin-error';

export interface Selection {
  pin?: DeductionPin;
  draws?: ReadonlyArray<{ lotId: number; quantity: string }>;
}

export type ResolvedSelection<T> =
  | { kind: 'auto'; lots: readonly T[]; pin: DeductionPin | null }
  | { kind: 'explicit'; lots: readonly T[]; draws: ExplicitDraw[] };

/**
 * Narrows the candidate lots and decides which planner applies.
 *
 * Throws rather than returning a failure: unlike a shortfall, every problem
 * here is the request being wrong about the world — a jar that is gone, or two
 * contradictory instructions — and there is no sensible partial answer to give.
 */
export function resolveSelection<T extends { id: number; productId?: string | null }>(
  lots: readonly T[],
  selection: Selection,
  ingredientName: string,
): ResolvedSelection<T> {
  const { pin, draws } = selection;
  const hasPin = pin !== undefined && (pin.lotId !== undefined || !!pin.productId);

  if (draws && draws.length > 0) {
    if (hasPin) {
      throw new BadRequestException(
        `For ${ingredientName}, either say which lot to use or say how much came ` +
          'out of each one — not both.',
      );
    }

    const known = new Set(lots.map((lot) => lot.id));
    const seen = new Set<number>();
    for (const draw of draws) {
      if (!known.has(draw.lotId)) {
        // Same shape as a stale pin, and for the same reason: the lot the user
        // was looking at has been used up or thrown away since.
        throw new NotFoundException(
          `No pantry lot ${draw.lotId} of ${ingredientName}. It may have been ` +
            'used up or thrown away since you picked it.',
        );
      }
      if (seen.has(draw.lotId)) {
        throw new BadRequestException(
          `Lot ${draw.lotId} of ${ingredientName} was given two different amounts.`,
        );
      }
      seen.add(draw.lotId);
    }

    return {
      kind: 'explicit',
      lots,
      draws: draws.map((draw) => ({ lotId: draw.lotId, quantity: draw.quantity })),
    };
  }

  const selected = selectPinnedLots(lots, pin);
  if (!selected.ok) throw pinError(selected.reason, ingredientName, pin!);

  return { kind: 'auto', lots: selected.lots, pin: hasPin ? pin! : null };
}
