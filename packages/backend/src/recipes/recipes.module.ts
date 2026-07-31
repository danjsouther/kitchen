import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { RecipesController } from './recipes.controller';
import { RecipesService } from './recipes.service';

@Module({
  // Recipes validate every referenced ingredient and unit against what this
  // household can see, which is what the catalog services already know.
  imports: [CatalogModule],
  controllers: [RecipesController],
  providers: [RecipesService],
  exports: [RecipesService],
})
export class RecipesModule {}
