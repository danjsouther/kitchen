import { Body, Controller, Delete, Get, Put } from '@nestjs/common';
import { Role } from '@recipes/shared-types';

import { CurrentUser, Roles } from '../auth/decorators';
import { AiConfigService } from './ai-config.service';
import { UpdateAiConfigDto } from './dto/ai-config.dto';

@Controller('households/me/ai-config')
export class AiConfigController {
  constructor(private readonly aiConfig: AiConfigService) {}

  /** Readable by any member: they need to know whether the AI tab will work. */
  @Get()
  view() {
    return this.aiConfig.view();
  }

  /**
   * ADMIN only. Members use the feature but never see or change the key — it is
   * the household's billing relationship, not theirs.
   */
  @Roles(Role.ADMIN)
  @Put()
  update(@Body() dto: UpdateAiConfigDto, @CurrentUser('id') userId: number) {
    return this.aiConfig.update(dto, userId);
  }

  @Roles(Role.ADMIN)
  @Delete()
  clear() {
    return this.aiConfig.clear();
  }
}
