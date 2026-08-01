import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MealSlot, PlanStatus } from '@kitchen/shared-types';

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
}

/** Cooking something that was never on the calendar. */
export class CookRecipeDto extends CookDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  recipeId!: number;
}
