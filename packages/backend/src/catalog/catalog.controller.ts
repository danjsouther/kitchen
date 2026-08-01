import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import {
  CreateIngredientDto,
  CreateUnitDto,
  IngredientQueryDto,
  UpdateIngredientDto,
} from './dto/catalog.dto';
import { IngredientsService } from './ingredients.service';
import { UnitsService } from './units.service';

@Controller('units')
export class UnitsController {
  constructor(private readonly units: UnitsService) {}

  @Get()
  list() {
    return this.units.list();
  }

  @Post()
  create(@Body() dto: CreateUnitDto) {
    return this.units.create(dto);
  }
}

@Controller('ingredient-categories')
export class IngredientCategoriesController {
  constructor(private readonly ingredients: IngredientsService) {}

  @Get()
  list() {
    return this.ingredients.listCategories();
  }
}

@Controller('ingredients')
export class IngredientsController {
  constructor(private readonly ingredients: IngredientsService) {}

  @Get()
  search(@Query() query: IngredientQueryDto) {
    return this.ingredients.search(query);
  }

  /**
   * The paged catalog admin screen. A distinct route (rather than reshaping
   * `GET /ingredients`) because pickers rely on that endpoint returning a
   * flat array — see `IngredientsService.searchPaged` for why paging this
   * query needs different logic entirely.
   *
   * Declared ahead of `:id` so 'page' isn't parsed as an ingredient id.
   */
  @Get('page')
  searchPaged(@Query() query: IngredientQueryDto) {
    return this.ingredients.searchPaged(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.ingredients.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateIngredientDto) {
    return this.ingredients.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateIngredientDto) {
    return this.ingredients.update(id, dto);
  }

  /** Forks a shared-catalog ingredient into one this household owns and can edit. */
  @Post(':id/customize')
  customize(@Param('id', ParseIntPipe) id: number) {
    return this.ingredients.customize(id);
  }
}
