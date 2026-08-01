import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { ProductsModule } from '../products/products.module';
import { LocationsService } from './locations.service';
import {
  LocationsController,
  PantryController,
  ScanQueueController,
} from './pantry.controller';
import { PantryService } from './pantry.service';
import { ScanQueueService } from './scan-queue.service';

@Module({
  imports: [CatalogModule, ProductsModule],
  // ScanQueueController ahead of PantryController: its `pantry/scan-queue`
  // routes must match before PantryController's `pantry/:id` catch-all.
  controllers: [LocationsController, ScanQueueController, PantryController],
  providers: [PantryService, LocationsService, ScanQueueService],
  // Exported for the meal planner: cooking a recipe is the same deduction this
  // service already performs, applied to every line at once.
  exports: [PantryService],
})
export class PantryModule {}
