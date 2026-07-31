import { Module } from '@nestjs/common';

import { SuggestionsModule } from '../suggestions/suggestions.module';
import { ShoppingController, StoresController } from './shopping.controller';
import { ShoppingService } from './shopping.service';
import { StoresService } from './stores.service';

/**
 * Stores and shopping lists — the last of the four applications of the
 * conversion engine, and the one that closes the loop: receiving a list stocks
 * the pantry and records what things cost, so the next list is better informed.
 */
@Module({
  imports: [SuggestionsModule],
  controllers: [StoresController, ShoppingController],
  providers: [ShoppingService, StoresService],
  exports: [ShoppingService, StoresService],
})
export class ShoppingModule {}
