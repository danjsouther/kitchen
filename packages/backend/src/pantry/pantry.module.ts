import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { ProductsModule } from '../products/products.module';
import { LocationsService } from './locations.service';
import { LocationsController, PantryController } from './pantry.controller';
import { PantryService } from './pantry.service';

@Module({
  imports: [CatalogModule, ProductsModule],
  controllers: [LocationsController, PantryController],
  providers: [PantryService, LocationsService],
  // Exported for the meal planner: cooking a recipe is the same deduction this
  // service already performs, applied to every line at once.
  exports: [PantryService],
})
export class PantryModule {}
