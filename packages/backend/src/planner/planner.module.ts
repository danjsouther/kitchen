import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { PantryModule } from '../pantry/pantry.module';
import { CookService } from './cook.service';
import { CookSessionsController, PlannerController } from './planner.controller';
import { PlannerService } from './planner.service';

/**
 * The calendar, and the point where a recipe becomes a change to the pantry.
 * Cooking reuses `pantry/deduction.ts` unchanged — it is the same withdrawal,
 * applied to every line of a recipe at once.
 */
@Module({
  imports: [CatalogModule, PantryModule],
  controllers: [PlannerController, CookSessionsController],
  providers: [PlannerService, CookService],
  exports: [PlannerService],
})
export class PlannerModule {}
