/**
 * Turns a `selectPinnedLots` failure into the HTTP error it deserves.
 *
 * Kept out of `deduction.ts` on purpose: that module plans and decides nothing,
 * and a Nest exception is a decision. Both deduction paths — manual consume and
 * cooking a recipe — need the same wording, so it lives here rather than being
 * written twice slightly differently.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';

import { PinFailure, type DeductionPin } from './deduction';

/**
 * A stale pin is never softened into a shortfall.
 *
 * "You asked for this jar and it is gone" and "you have none of this" are
 * different facts, and quietly deducting from somewhere else would be the app
 * choosing for the user after being told exactly what they wanted.
 */
export function pinError(
  reason: PinFailure,
  ingredientName: string,
  pin: DeductionPin,
): BadRequestException | NotFoundException {
  switch (reason) {
    case PinFailure.BOTH_GIVEN:
      return new BadRequestException(
        'Give either a lot or a product to take from, not both.',
      );
    case PinFailure.NO_SUCH_LOT:
      return new NotFoundException(
        `No pantry lot ${pin.lotId} of ${ingredientName}. It may have been used ` +
          'up or thrown away since you picked it.',
      );
    case PinFailure.NO_SUCH_PRODUCT:
      return new BadRequestException(
        `Nothing in the pantry under barcode ${pin.productId} is ${ingredientName}. ` +
          'It may have been used up or thrown away since you picked it.',
      );
  }
}
