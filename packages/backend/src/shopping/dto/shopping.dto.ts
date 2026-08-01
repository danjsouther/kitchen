import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumberString,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ListStatus } from '@kitchen/shared-types';

const DATE_ONLY = { strict: true, strictSeparator: true };

export class ShoppingListQueryDto {
  @IsOptional()
  @IsIn(Object.values(ListStatus))
  status?: ListStatus;

  /** Matches the list's name. */
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

export class CreateStoreDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class UpdateStoreDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class AisleDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  categoryId!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder!: number;
}

export class SetAislesDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AisleDto)
  aisles!: AisleDto[];
}

export class GenerateListDto {
  @IsISO8601(DATE_ONLY, { message: 'from must be a date (YYYY-MM-DD).' })
  from!: string;

  @IsISO8601(DATE_ONLY, { message: 'to must be a date (YYYY-MM-DD).' })
  to!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  storeId?: number;

  /** Include ingredients that have fallen below their par level. */
  @IsOptional()
  @IsBoolean()
  includePars?: boolean;
}

export class CreateListDto extends GenerateListDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;
}

export class AddListItemDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  ingredientId?: number;

  /** For an ad-hoc item that is not in the catalog at all — "paper towels". */
  @IsOptional()
  @IsString()
  @MaxLength(150)
  rawName?: string;

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
  @IsNumberString({}, { message: 'estimatedPrice must be a number.' })
  estimatedPrice?: string;

  /**
   * A specific product, when the shopper knows which one they want. Supplies
   * the ingredient via this household's binding if none is given, the same way
   * the pantry form does.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  productId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class UpdateListItemDto {
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
  @IsNumberString({}, { message: 'actualPrice must be a number.' })
  actualPrice?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  storeId?: number;

  /** Scanning at the shelf: attach the product actually being bought. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  productId?: string;

  /** Ticking the box at the shelf. */
  @IsOptional()
  @IsBoolean()
  checked?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class ReceiveItemLocationDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  itemId!: number;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  locationId!: number;
}

export class ReceiveDto {
  /** Default location for checked lines that do not override it. */
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  locationId!: number;

  /** Per-item location overrides. Lines omitted here use `locationId`. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReceiveItemLocationDto)
  items?: ReceiveItemLocationDto[];
}
