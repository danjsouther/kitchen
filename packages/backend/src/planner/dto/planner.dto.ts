import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumberString,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MealSlot, PlanStatus } from '@kitchen/shared-types';

import { ExplicitDrawDto } from '../../pantry/dto/pantry.dto';

export { ExplicitDrawDto };

const SLOTS = Object.values(MealSlot);
const STATUSES = Object.values(PlanStatus);

/** Calendar dates only — a planned meal belongs to a day, not an instant. */
const DATE_ONLY = { strict: true, strictSeparator: true };

export class PlannerQueryDto {
  @IsISO8601(DATE_ONLY, { message: 'from must be a date (YYYY-MM-DD).' })
  from!: string;

  @IsISO8601(DATE_ONLY, { message: 'to must be a date (YYYY-MM-DD).' })
  to!: string;
}

export class CreatePlannedMealDto {
  @IsISO8601(DATE_ONLY, { message: 'date must be a date (YYYY-MM-DD).' })
  date!: string;

  @IsIn(SLOTS, { message: `slot must be one of: ${SLOTS.join(', ')}` })
  slot!: MealSlot;

  /**
   * Null for a free-text entry. The calendar has to hold "leftovers" and "dinner
   * out" as well as recipes; those display on the grid and are skipped by cooking
   * and shopping-list generation.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  recipeId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  /** Defaults to the recipe's own serving count when omitted. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  servings?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdatePlannedMealDto {
  /** Moving an entry to another day is how drag-to-reschedule is expressed. */
  @IsOptional()
  @IsISO8601(DATE_ONLY, { message: 'date must be a date (YYYY-MM-DD).' })
  date?: string;

  @IsOptional()
  @IsIn(SLOTS)
  slot?: MealSlot;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  servings?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  @IsOptional()
  @IsIn(STATUSES, { message: `status must be one of: ${STATUSES.join(', ')}` })
  status?: PlanStatus;
}

/**
 * "For this ingredient, take it out of this jar."
 *
 * Without one, an ingredient is drawn soonest-expiry-first across every lot of
 * it, which is the right default and the wrong answer when the cook has a
 * particular pack in their hand.
 */
export class DeductionPinDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  ingredientId!: number;

  /** Mutually exclusive with `productId`. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  lotId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  productId?: string;

  /**
   * Exactly what came out of each lot, as the cook worked it out.
   *
   * Present, it replaces auto-allocation entirely and `lotId`/`productId` must
   * be absent — those narrow a search this has already finished.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ExplicitDrawDto)
  draws?: ExplicitDrawDto[];
}

export class CookDto {
  /** Overrides the planned serving count for this one cook. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  servings?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  /** At most one per ingredient; the service rejects duplicates. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => DeductionPinDto)
  pins?: DeductionPinDto[];
}

/** Cooking something that was never on the calendar. */
export class CookRecipeDto extends CookDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  recipeId!: number;
}
