import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
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
  ValidateIf,
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

export class RecipeServingsDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  recipeId!: number;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  servings!: number;
}

export class GenerateListDto {
  /**
   * Demand comes from either a date range against the meal plan, or a
   * chosen set of recipes — never both. `ShoppingService.generate` throws if
   * neither or both are given; `class-validator` cannot express "exactly one
   * of two groups" on its own.
   */
  @ValidateIf((dto: GenerateListDto) => !dto.recipes?.length)
  @IsISO8601(DATE_ONLY, { message: 'from must be a date (YYYY-MM-DD).' })
  from?: string;

  @ValidateIf((dto: GenerateListDto) => !dto.recipes?.length)
  @IsISO8601(DATE_ONLY, { message: 'to must be a date (YYYY-MM-DD).' })
  to?: string;

  @ValidateIf((dto: GenerateListDto) => !dto.from && !dto.to)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RecipeServingsDto)
  recipes?: RecipeServingsDto[];

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

export class AddRecipesToListDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RecipeServingsDto)
  recipes!: RecipeServingsDto[];
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
