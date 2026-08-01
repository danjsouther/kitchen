import { IsString, MaxLength, MinLength } from 'class-validator';

export class AddScanQueueEntryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  barcode!: string;
}
