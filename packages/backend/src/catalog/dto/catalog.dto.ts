import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { UnitKind } from '@recipes/shared-types';

const UNIT_KINDS = Object.values(UnitKind);

export class CreateUnitDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(50)
  plural!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  abbrev?: string;

  @IsIn(UNIT_KINDS, { message: `kind must be one of: ${UNIT_KINDS.join(', ')}` })
  kind!: UnitKind;

  /**
   * How many base units one of these is: grams for MASS, millilitres for VOLUME,
   * pieces for COUNT. Taken as a string so a value like 28.349523125 survives the
   * trip without being rounded through a float.
   */
  @IsNumberString({ no_symbols: false }, { message: 'toBaseFactor must be a number.' })
  toBaseFactor!: string;
}

export class IngredientQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  categoryId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class CreateIngredientDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  categoryId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  defaultUnitId?: number;

  /** Density in grams per millilitre. Omitted means "unknown", never assumed 1.0. */
  @IsOptional()
  @IsNumberString({}, { message: 'gramsPerMl must be a number.' })
  gramsPerMl?: string;

  @IsOptional()
  @IsNumberString({}, { message: 'gramsPerPiece must be a number.' })
  gramsPerPiece?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  shelfLifeDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdateIngredientDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  categoryId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  defaultUnitId?: number;

  @IsOptional()
  @IsNumberString({}, { message: 'gramsPerMl must be a number.' })
  gramsPerMl?: string;

  @IsOptional()
  @IsNumberString({}, { message: 'gramsPerPiece must be a number.' })
  gramsPerPiece?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  shelfLifeDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
