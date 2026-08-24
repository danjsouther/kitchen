import { Module } from '@nestjs/common';

import { HouseholdsModule } from '../households/households.module';
import { ParserModule } from '../parser/parser.module';
import { AiSuggestionsService } from './ai-suggestions.service';
import { SuggestionsController } from './suggestions.controller';
import { SuggestionsService } from './suggestions.service';

/**
 * "What can I cook right now", by two methods that share one input. The
 * deterministic match is computed first either way, and is what the AI method is
 * grounded on — so the two tabs can never disagree about the same pantry.
 *
 * Also imports ParserModule: a GENERATED suggestion's ingredient lines are
 * resolved against the catalog with the exact same matcher a pasted recipe
 * uses, via ParserService.
 */
@Module({
  imports: [HouseholdsModule, ParserModule],
  controllers: [SuggestionsController],
  providers: [SuggestionsService, AiSuggestionsService],
  exports: [SuggestionsService],
})
export class SuggestionsModule {}
