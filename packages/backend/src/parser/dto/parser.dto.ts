import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class ParseRecipeDto {
  /** The pasted recipe, as-is. Nothing is persisted. */
  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  text!: string;

  /** Overrides the title the parser guessed from the first line. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  servings?: number;
}
