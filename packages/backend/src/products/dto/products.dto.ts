import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsPositive, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class ProductQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class ProductBindingQueryDto {
  /** Matches the product's name/brand, or the ingredient it's bound to. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
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

/**
 * Sets this household's category override for a barcode.
 *
 * There is deliberately no DTO for creating or editing a `Product`: the OFF
 * mirror is import-owned. Consensus is computed, not written here.
 */
export class BindProductDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  ingredientId!: number;
}

export class BarcodeParamDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;
}
