import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { ListStatus } from '@kitchen/shared-types';

import { CurrentUser } from '../auth/decorators';
import {
  AddListItemDto,
  CreateListDto,
  CreateStoreDto,
  GenerateListDto,
  ReceiveDto,
  SetAislesDto,
  UpdateListItemDto,
  UpdateStoreDto,
} from './dto/shopping.dto';
import { ShoppingService } from './shopping.service';
import { StoresService } from './stores.service';

@Controller('stores')
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  @Get()
  list() {
    return this.stores.list();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.stores.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateStoreDto) {
    return this.stores.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateStoreDto) {
    return this.stores.update(id, dto);
  }

  /** The order the shopper walks this store, which drives list ordering. */
  @Put(':id/aisles')
  setAisles(@Param('id', ParseIntPipe) id: number, @Body() dto: SetAislesDto) {
    return this.stores.setAisles(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.stores.remove(id);
  }
}

@Controller('shopping-lists')
export class ShoppingController {
  constructor(private readonly shopping: ShoppingService) {}

  @Get()
  list(@Query('status') status?: ListStatus) {
    return this.shopping.list(status);
  }

  /**
   * A proposal only — nothing is saved, hence 200 rather than 201. `POST /` runs
   * the same generation and keeps the result.
   */
  @Post('generate')
  @HttpCode(HttpStatus.OK)
  generate(@Body() dto: GenerateListDto) {
    return this.shopping.generate(dto);
  }

  @Post()
  create(@Body() dto: CreateListDto) {
    return this.shopping.create(dto);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.shopping.findOne(id);
  }

  @Post(':id/items')
  addItem(@Param('id', ParseIntPipe) id: number, @Body() dto: AddListItemDto) {
    return this.shopping.addItem(id, dto);
  }

  /** Ticking off at the shelf, and recording what it actually cost. */
  @Patch(':id/items/:itemId')
  updateItem(
    @Param('id', ParseIntPipe) id: number,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() dto: UpdateListItemDto,
  ) {
    return this.shopping.updateItem(id, itemId, dto);
  }

  @Delete(':id/items/:itemId')
  removeItem(
    @Param('id', ParseIntPipe) id: number,
    @Param('itemId', ParseIntPipe) itemId: number,
  ) {
    return this.shopping.removeItem(id, itemId);
  }

  /** Checked items become pantry lots and price history; the list closes. */
  @Post(':id/receive')
  receive(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReceiveDto,
    @CurrentUser('id') userId: number,
  ) {
    return this.shopping.receive(id, dto, userId);
  }

  /** Reverse a put-away: take stock back off the shelf and reopen the list. */
  @Delete(':id/receive')
  unreceive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser('id') userId: number,
  ) {
    return this.shopping.unreceive(id, userId);
  }

  @Delete(':id')
  archive(@Param('id', ParseIntPipe) id: number) {
    return this.shopping.archive(id);
  }
}
