import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class PantrySuggestionQueryDto {
  /** Only recipes missing at most this many ingredients. Zero means "cookable now". */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(50)
  missingMax?: number;

  /** Check against a different serving count than each recipe's own. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  servings?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class AiSuggestionDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  servings?: number;

  /** Free-text steer, e.g. "i want a salmon dish for breakfast". */
  @IsOptional()
  @IsString()
  @MaxLength(250)
  notes?: string;
}

export class AiSuggestionHistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
