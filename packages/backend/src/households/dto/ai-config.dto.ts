import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateAiConfigDto {
  /**
   * Write-only. No endpoint returns this, and the response DTO has no field it
   * could occupy — see `AiConfigView`.
   */
  @IsOptional()
  @IsString()
  @MinLength(20, { message: 'That does not look like a complete API key.' })
  @MaxLength(500)
  apiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  model?: string;

  @IsOptional()
  @IsIn(['low', 'medium', 'high'])
  effort?: string;

  /** Turns the feature off without discarding the key. */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
