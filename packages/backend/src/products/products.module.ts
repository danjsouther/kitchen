import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

/**
 * The global product catalog and household bindings.
 *
 * Exported because pantry and shopping both need to validate a `productId` and
 * ask what this household means by it — and both must do so through the one
 * service rather than querying `product` themselves.
 */
@Module({
  imports: [CatalogModule],
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
