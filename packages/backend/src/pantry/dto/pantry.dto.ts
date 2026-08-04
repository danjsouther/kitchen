import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNumberString,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * One "I used this much of this jar".
 *
 * Lives here rather than with the planner because deduction is the pantry's
 * concern; the cook endpoints import it so both speak the same shape.
 */
export class ExplicitDrawDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  lotId!: number;

  /** In the lot's own unit. A string, because it is a Decimal. */
  @IsNumberString({}, { message: 'quantity must be a number.' })
  quantity!: string;
}

export class CreateLocationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateLocationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class PantryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  locationId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  ingredientId?: number;

  /**
   * Lots expiring within this many days, including those already expired.
   * Zero means "expired only".
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expiringWithinDays?: number;

  /** Matches the ingredient name or brand on a lot. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class BalanceQueryDto {
  /** Matches the ingredient name. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class CreatePantryItemDto {
  /**
   * Optional when `productId` is sent and an effective category exists for it
   * (household override or ranked consensus). Required otherwise; the service
   * says so rather than inventing one. Sending an ingredient that differs from
   * the effective default writes a household override.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  ingredientId?: number;

  /** A scanned barcode. Normalized server-side, so any scan format is accepted. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  productId?: string;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  locationId!: number;

  @IsNumberString({}, { message: 'quantity must be a number.' })
  quantity!: string;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  unitId!: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  brand?: string;

  @IsOptional()
  @IsDateString({}, { message: 'openedOn must be a date.' })
  openedOn?: string;

  /**
   * Left off, the shelf life on the ingredient seeds one. Send an explicit null
   * to say "this genuinely has no expiry" rather than "I did not fill it in".
   */
  @IsOptional()
  @IsDateString({}, { message: 'expiresOn must be a date.' })
  expiresOn?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class UpdatePantryItemDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  locationId?: number;

  @IsOptional()
  @IsNumberString({}, { message: 'quantity must be a number.' })
  quantity?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  unitId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  brand?: string;

  @IsOptional()
  @IsDateString({}, { message: 'openedOn must be a date.' })
  openedOn?: string | null;

  @IsOptional()
  @IsDateString({}, { message: 'expiresOn must be a date.' })
  expiresOn?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  /** Recorded on the ledger entry this edit produces. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class ConsumeDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  ingredientId!: number;

  /**
   * How much was needed — what any shortfall is measured against.
   *
   * Optional only alongside `draws`: someone recording what they actually used
   * is stating a fact, not filling a requirement, and there is nothing for it
   * to fall short of.
   */
  @IsOptional()
  @IsNumberString({}, { message: 'quantity must be a number.' })
  quantity?: string;

  /** Always required: it is the unit `applied` comes back in. */
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  unitId!: number;

  /**
   * Take from this lot only, instead of the ingredient's whole shelf.
   *
   * Mutually exclusive with `productId`; the service rejects both together
   * rather than guessing at an intersection.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  lotId?: number;

  /** Take only from lots carrying this barcode, oldest of them first. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  productId?: string;

  /**
   * Exactly what came out of each lot, in each lot's own unit.
   *
   * Present, it replaces auto-allocation and `lotId`/`productId` must be
   * absent. `quantity` above stays meaningful: it is what was *needed*, which
   * is what the shortfall is measured against.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ExplicitDrawDto)
  draws?: ExplicitDrawDto[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class DiscardDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class SetParDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  ingredientId!: number;

  @IsNumberString({}, { message: 'minQuantity must be a number.' })
  minQuantity!: string;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  unitId!: number;
}

export class SetParsDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => SetParDto)
  pars!: SetParDto[];
}
