import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';

import { AiSuggestionsService } from './ai-suggestions.service';
import { AiSuggestionDto, PantrySuggestionQueryDto } from './dto/suggestions.dto';
import { SuggestionsService } from './suggestions.service';

@Controller('suggestions')
export class SuggestionsController {
  constructor(
    private readonly suggestions: SuggestionsService,
    private readonly ai: AiSuggestionsService,
  ) {}

  /** Method 1: arithmetic against the pantry. The source of truth about quantities. */
  @Get('pantry')
  fromPantry(@Query() query: PantrySuggestionQueryDto) {
    return this.suggestions.fromPantry(query);
  }

  /**
   * Method 2: the same match, explained and extended by Claude.
   *
   * POST rather than GET, and never fired on page load — it spends the
   * household's own money, so it takes a deliberate press of a button.
   */
  @Post('ai')
  @HttpCode(HttpStatus.OK)
  fromAi(@Body() dto: AiSuggestionDto) {
    return this.ai.suggest(dto);
  }
}
