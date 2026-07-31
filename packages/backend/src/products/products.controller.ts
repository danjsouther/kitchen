import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';

import { BindProductDto, ProductQueryDto } from './dto/products.dto';
import { ProductsService } from './products.service';

/**
 * The Open Food Facts mirror, and this household's optional category overrides.
 *
 * Note what is *not* here: no POST, PATCH or DELETE on a product. The mirror is
 * written by `npm run off:import` and by nothing else. Every write below is on
 * `productBinding` (household override only). The default category is live
 * ranked consensus and is never stored on Product.
 */
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  /**
   * Ahead of `:barcode/...` routes — Nest matches in declaration order, and
   * 'bindings' would otherwise be read as a barcode.
   */
  @Get('bindings')
  listOverrides() {
    return this.products.listOverrides();
  }

  @Get('by-barcode/:code')
  byBarcode(@Param('code') code: string) {
    return this.products.byBarcode(code);
  }

  @Get()
  search(@Query() query: ProductQueryDto) {
    return this.products.search(query);
  }

  /** Sets this household's category override for a barcode. */
  @Put(':code/binding')
  setOverride(@Param('code') code: string, @Body() dto: BindProductDto) {
    return this.products.setOverride(code, dto.ingredientId);
  }

  /** Clears the override so this household follows consensus again. */
  @Delete(':code/binding')
  clearOverride(@Param('code') code: string) {
    return this.products.clearOverride(code);
  }
}
