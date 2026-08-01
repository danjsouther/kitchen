import { Body, Controller, Get, Post } from '@nestjs/common';
import { Role } from '@kitchen/shared-types';

import { CurrentUser, Roles } from '../auth/decorators';
import { HouseholdDataService } from './household-data.service';
import { ImportHouseholdDto } from './dto/household-data.dto';

/**
 * Whole-household export/import. Admin-only: the export contains every
 * recipe, pantry lot and price record the household has, and import is a
 * large, blast-radius write — the same trust level as the AI-key settings.
 */
@Controller('household-data')
export class HouseholdDataController {
  constructor(private readonly householdData: HouseholdDataService) {}

  @Roles(Role.ADMIN)
  @Get('export')
  export() {
    return this.householdData.export();
  }

  @Roles(Role.ADMIN)
  @Post('import')
  import(@Body() dto: ImportHouseholdDto, @CurrentUser('id') userId: number) {
    return this.householdData.import(dto, userId);
  }
}
