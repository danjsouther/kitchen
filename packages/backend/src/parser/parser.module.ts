import { Module } from '@nestjs/common';

import { ParserController } from './parser.controller';
import { ParserService } from './parser.service';

/**
 * Paste-and-parse. Registered after RecipesModule so that `/recipes/parse` is
 * matched before the `/recipes/:id` route would swallow it.
 */
@Module({
  controllers: [ParserController],
  providers: [ParserService],
  exports: [ParserService],
})
export class ParserModule {}
