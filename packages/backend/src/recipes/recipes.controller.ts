import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { CurrentUser } from '../auth/decorators';
import {
  CreateRecipeDto,
  RecipeQueryDto,
  ScaleQueryDto,
  UpdateRecipeDto,
} from './dto/recipe.dto';
import { RecipesService } from './recipes.service';

@Controller('recipes')
export class RecipesController {
  constructor(private readonly recipes: RecipesService) {}

  @Get()
  findAll(@Query() query: RecipeQueryDto) {
    return this.recipes.findAll(query);
  }

  /**
   * Declared before `:id` so a numeric id is not swallowed by the slug route.
   * Slugs never start with a digit-only segment, but route order is the thing
   * that guarantees it rather than the slug format.
   */
  @Get('by-slug/:slug')
  findBySlug(@Param('slug') slug: string) {
    return this.recipes.findBySlug(slug);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.recipes.findOne(id);
  }

  /** The same recipe with every quantity scaled to a different serving count. */
  @Get(':id/scaled')
  scaled(@Param('id', ParseIntPipe) id: number, @Query() query: ScaleQueryDto) {
    return this.recipes.scaled(id, query.servings);
  }

  @Post()
  create(@Body() dto: CreateRecipeDto, @CurrentUser('id') userId: number) {
    return this.recipes.create(dto, userId);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateRecipeDto) {
    return this.recipes.update(id, dto);
  }

  /**
   * Archives the recipe. It keeps its planning and cooking history and can be
   * restored; nothing is destroyed.
   */
  @Delete(':id')
  archive(@Param('id', ParseIntPipe) id: number) {
    return this.recipes.archive(id);
  }

  @Post(':id/restore')
  restore(@Param('id', ParseIntPipe) id: number) {
    return this.recipes.restore(id);
  }
}
