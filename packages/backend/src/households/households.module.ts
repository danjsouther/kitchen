import { Module } from '@nestjs/common';

import { AiConfigService } from './ai-config.service';
import { AiConfigController } from './households.controller';

@Module({
  controllers: [AiConfigController],
  providers: [AiConfigService],
  exports: [AiConfigService],
})
export class HouseholdsModule {}
