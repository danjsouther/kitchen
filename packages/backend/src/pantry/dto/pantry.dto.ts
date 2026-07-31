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
}

export class CreatePantryItemDto {
  /**
   * Optional when `productId` is sent and this household has a binding for it —
   * the binding then says which ingredient the barcode means. Required in every
   * other case, and the service says so rather than inventing one.
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

  @IsNumberString({}, { message: 'quantity must be a number.' })
  quantity!: string;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  unitId!: number;

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
