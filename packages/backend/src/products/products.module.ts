import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

/**
 * The global product catalog and household category overrides.
 *
 * Exported because pantry and shopping both need to validate a `productId` and
 * resolve the effective ingredient category (override then consensus).
 */
@Module({
  imports: [CatalogModule],
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
