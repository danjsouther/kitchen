import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { TagKind } from '@recipes/shared-types';

/** Bounds chosen to be generous for real recipes but to stop absurd payloads. */
const MAX_INGREDIENTS = 200;
const MAX_STEPS = 200;
const MAX_TAGS = 30;
const MAX_SERVINGS = 1000;

export class RecipeIngredientDto {
  /**
   * The catalog ingredient this line resolved to, if any.
   *
   * Nullable on purpose. An unresolved line ("salt and pepper to taste", a
   * one-off the cook does not want in the catalog, a parse that did not match)
   * still displays and still saves — it simply sits out of pantry maths.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  ingredientId?: number;

  /** Always kept verbatim, even when the line resolved cleanly. */
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  rawText!: string;

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
  @MaxLength(200)
  preparation?: string;

  /** "For the sauce" — groups lines under a sub-heading. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  groupLabel?: string;

  @IsOptional()
  @IsBoolean()
  optional?: boolean;
}

export class RecipeStepDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text!: string;
}

export class RecipeTagDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @IsIn(Object.values(TagKind))
  kind?: TagKind;
}

export class CreateRecipeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /** The basis for all scaling, so it must be a real count and never zero. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_SERVINGS)
  servings!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  prepMinutes?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cookMinutes?: number;

  @IsOptional()
  @IsUrl({}, { message: 'sourceUrl must be a valid URL.' })
  @MaxLength(2000)
  sourceUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  sourceNote?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;

  @IsArray()
  @ArrayMaxSize(MAX_INGREDIENTS)
  @ValidateNested({ each: true })
  @Type(() => RecipeIngredientDto)
  ingredients!: RecipeIngredientDto[];

  @IsArray()
  @ArrayMaxSize(MAX_STEPS)
  @ValidateNested({ each: true })
  @Type(() => RecipeStepDto)
  steps!: RecipeStepDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TAGS)
  @ValidateNested({ each: true })
  @Type(() => RecipeTagDto)
  tags?: RecipeTagDto[];
}

/**
 * Written out rather than derived with PartialType so the replace-vs-merge
 * semantics are visible at the point of use: scalar fields merge, but supplying
 * `ingredients`, `steps` or `tags` replaces that collection wholesale.
 */
export class UpdateRecipeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_SERVINGS)
  servings?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  prepMinutes?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cookMinutes?: number;

  @IsOptional()
  @IsUrl({}, { message: 'sourceUrl must be a valid URL.' })
  @MaxLength(2000)
  sourceUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  sourceNote?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_INGREDIENTS)
  @ValidateNested({ each: true })
  @Type(() => RecipeIngredientDto)
  ingredients?: RecipeIngredientDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_STEPS)
  @ValidateNested({ each: true })
  @Type(() => RecipeStepDto)
  steps?: RecipeStepDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TAGS)
  @ValidateNested({ each: true })
  @Type(() => RecipeTagDto)
  tags?: RecipeTagDto[];
}

export class RecipeQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  /** Tag slug, e.g. `weeknight`. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  tag?: string;

  /** Recipes using this catalog ingredient — "what can I make with leeks". */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  ingredientId?: number;

  /** Archived recipes are hidden unless explicitly asked for. */
  @IsOptional()
  @IsIn(['active', 'archived', 'all'])
  status?: 'active' | 'archived' | 'all';

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

export class ScaleQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'servings must be at least 1.' })
  @Max(MAX_SERVINGS)
  servings!: number;
}

export const RECIPE_LIMITS = {
  MAX_INGREDIENTS,
  MAX_STEPS,
  MAX_TAGS,
  MAX_SERVINGS,
} as const;
