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
  ValidateIf,
} from 'class-validator';
import { UnitKind } from '@kitchen/shared-types';

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

  /** Only read by the paged catalog screen (`searchPaged`); `search` ignores it. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
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

/**
 * A partial edit, where **absent and null mean different things**.
 *
 * Absent is "leave this alone". Explicit `null` is "this genuinely has no
 * value" — the only way to say that an ingredient someone gave a density to
 * does not really have one, and without it a wrong density is permanent.
 *
 * `@IsOptional()` is what permits the null: it skips every other validator when
 * the value is null or undefined. That is deliberate on the nullable columns
 * and wrong on `name`, which is `NOT NULL` — hence `@ValidateIf` there, so an
 * absent name is skipped but a null one is rejected as the bad request it is
 * rather than reaching Postgres and coming back a 500.
 */
export class UpdateIngredientDto {
  @ValidateIf((_dto, value) => value !== undefined)
  @IsString({ message: 'name cannot be null — an ingredient has to be called something.' })
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  /** Null clears the category. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  categoryId?: number | null;

  /** Null clears the usual unit. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  defaultUnitId?: number | null;

  /** Null means "this has no known density", which is not the same as 0. */
  @IsOptional()
  @IsNumberString({}, { message: 'gramsPerMl must be a number.' })
  gramsPerMl?: string | null;

  /** Null means "one of these has no meaningful weight" — a sprig, a splash. */
  @IsOptional()
  @IsNumberString({}, { message: 'gramsPerPiece must be a number.' })
  gramsPerPiece?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  shelfLifeDays?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}
