import { Module } from '@nestjs/common';

import {
  IngredientCategoriesController,
  IngredientsController,
  UnitsController,
} from './catalog.controller';
import { IngredientsService } from './ingredients.service';
import { UnitsService } from './units.service';

/**
 * Units and ingredients — the shared vocabulary every other feature references.
 * Exported because recipes, pantry and shopping all need to validate ids against
 * what this household can actually see.
 */
@Module({
  controllers: [UnitsController, IngredientCategoriesController, IngredientsController],
  providers: [UnitsService, IngredientsService],
  exports: [UnitsService, IngredientsService],
})
export class CatalogModule {}
