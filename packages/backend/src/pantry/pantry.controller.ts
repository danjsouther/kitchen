import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import { CurrentUser } from '../auth/decorators';
import {
  ConsumeDto,
  CreateLocationDto,
  CreatePantryItemDto,
  DiscardDto,
  PantryQueryDto,
  SetParsDto,
  UpdateLocationDto,
  UpdatePantryItemDto,
} from './dto/pantry.dto';
import { LocationsService } from './locations.service';
import { PantryService } from './pantry.service';

@Controller('storage-locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get()
  list() {
    return this.locations.list();
  }

  @Post()
  create(@Body() dto: CreateLocationDto) {
    return this.locations.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateLocationDto) {
    return this.locations.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.locations.remove(id);
  }
}

@Controller('pantry')
export class PantryController {
  constructor(private readonly pantry: PantryService) {}

  @Get()
  list(@Query() query: PantryQueryDto) {
    return this.pantry.list(query);
  }

  /** On-hand totals per ingredient, each folded into one unit. */
  @Get('balances')
  balances() {
    return this.pantry.balances();
  }

  @Get('pars')
  listPars() {
    return this.pantry.listPars();
  }

  @Put('pars')
  setPars(@Body() dto: SetParsDto) {
    return this.pantry.setPars(dto);
  }

  @Get('history')
  history(
    @Query('ingredientId') ingredientId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.pantry.history(
      ingredientId ? Number(ingredientId) : undefined,
      limit ? Number(limit) : undefined,
    );
  }

  /** Takes an amount out, spanning lots soonest-expiry-first. */
  @Post('consume')
  consume(@Body() dto: ConsumeDto, @CurrentUser('id') userId: number) {
    return this.pantry.consume(dto, userId);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.pantry.findOne(id);
  }

  @Post()
  create(@Body() dto: CreatePantryItemDto, @CurrentUser('id') userId: number) {
    return this.pantry.create(dto, userId);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePantryItemDto,
    @CurrentUser('id') userId: number,
  ) {
    return this.pantry.update(id, dto, userId);
  }

  @Delete(':id')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DiscardDto,
    @CurrentUser('id') userId: number,
  ) {
    return this.pantry.remove(id, dto?.reason, userId);
  }
}
