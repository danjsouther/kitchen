import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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

const DATE_ONLY = { strict: true, strictSeparator: true };

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

  /** Ticking the box at the shelf. */
  @IsOptional()
  @IsBoolean()
  checked?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class ReceiveDto {
  /** Where the shopping gets put away. */
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  locationId!: number;
}
