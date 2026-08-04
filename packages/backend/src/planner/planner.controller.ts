import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { CurrentUser } from '../auth/decorators';
import { CookService } from './cook.service';
import {
  CookDto,
  CookRecipeDto,
  CreatePlannedMealDto,
  PlannerQueryDto,
  UpdatePlannedMealDto,
} from './dto/planner.dto';
import { PlannerService } from './planner.service';

@Controller('planner')
export class PlannerController {
  constructor(
    private readonly planner: PlannerService,
    private readonly cook: CookService,
  ) {}

  @Get()
  range(@Query() query: PlannerQueryDto) {
    return this.planner.range(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.planner.findOne(id);
  }

  @Post()
  create(@Body() dto: CreatePlannedMealDto, @CurrentUser('id') userId: number) {
    return this.planner.create(dto, userId);
  }

  /** Moving date/slot is how drag-to-reschedule is expressed. */
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePlannedMealDto) {
    return this.planner.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.planner.remove(id);
  }

  /** Deducts the meal from the pantry as one reversible session. */
  @Post(':id/cook')
  cookMeal(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CookDto,
    @CurrentUser('id') userId: number,
  ) {
    return this.cook.cook(id, dto, userId);
  }

  /**
   * What that cook would take, without taking it.
   *
   * A POST because it carries the pins that shape the answer, but it writes
   * nothing — the cook screen calls it again on every change of jar.
   */
  @HttpCode(200)
  @Post(':id/cook/preview')
  previewMeal(@Param('id', ParseIntPipe) id: number, @Body() dto: CookDto) {
    return this.cook.previewMeal(id, dto);
  }
}

@Controller('cook-sessions')
export class CookSessionsController {
  constructor(private readonly cook: CookService) {}

  @Get()
  list(@Query('limit') limit?: string) {
    return this.cook.listSessions(limit ? Number(limit) : undefined);
  }

  /** Cooking something that was never planned. */
  @Post()
  cookRecipe(@Body() dto: CookRecipeDto, @CurrentUser('id') userId: number) {
    return this.cook.cookRecipe(dto.recipeId, dto, userId);
  }

  /** The same, without writing anything. */
  @HttpCode(200)
  @Post('preview')
  preview(@Body() dto: CookRecipeDto) {
    return this.cook.previewRecipe(dto.recipeId, dto);
  }

  /** Puts every deducted amount back and marks the session reversed. */
  @Delete(':id')
  undo(@Param('id', ParseIntPipe) id: number, @CurrentUser('id') userId: number) {
    return this.cook.undo(id, userId);
  }
}
