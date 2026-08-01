import { Module } from '@nestjs/common';

import { HouseholdDataController } from './household-data.controller';
import { HouseholdDataService } from './household-data.service';

@Module({
  controllers: [HouseholdDataController],
  providers: [HouseholdDataService],
})
export class HouseholdDataModule {}
