import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';

import { BindProductDto, ProductQueryDto } from './dto/products.dto';
import { ProductsService } from './products.service';

/**
 * The Open Food Facts mirror, and this household's bindings onto it.
 *
 * Note what is *not* here: no POST, PATCH or DELETE on a product. The mirror is
 * written by `npm run off:import` and by nothing else. Every write below is on
 * `productBinding`, which is household-scoped.
 */
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  /**
   * Ahead of `:barcode/...` routes and of nothing else — Nest matches in
   * declaration order, and 'bindings' would otherwise be read as a barcode.
   */
  @Get('bindings')
  listBindings() {
    return this.products.listBindings();
  }

  @Get('by-barcode/:code')
  byBarcode(@Param('code') code: string) {
    return this.products.byBarcode(code);
  }

  @Get()
  search(@Query() query: ProductQueryDto) {
    return this.products.search(query);
  }

  @Put(':code/binding')
  bind(@Param('code') code: string, @Body() dto: BindProductDto) {
    return this.products.bind(code, dto.ingredientId);
  }

  @Delete(':code/binding')
  unbind(@Param('code') code: string) {
    return this.products.unbind(code);
  }
}
