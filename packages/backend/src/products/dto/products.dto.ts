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

/**
 * The one write path for "using" a product.
 *
 * There is deliberately no DTO for creating or editing a `Product`: the OFF
 * mirror is import-owned, and an endpoint that wrote to it would let one
 * household change what every other household sees.
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
