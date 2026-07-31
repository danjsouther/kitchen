import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { ParseRecipeDto } from './dto/parser.dto';
import { ParserService } from './parser.service';

@Controller('recipes')
export class ParserController {
  constructor(private readonly parser: ParserService) {}

  /**
   * Turns pasted text into a reviewable draft. Persists nothing, which is why it
   * answers 200 rather than 201 — nothing was created.
   */
  @Post('parse')
  @HttpCode(HttpStatus.OK)
  parse(@Body() dto: ParseRecipeDto) {
    return this.parser.parse(dto);
  }
}
