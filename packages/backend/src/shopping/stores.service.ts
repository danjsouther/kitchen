import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.service';
import type { CreateStoreDto, SetAislesDto, UpdateStoreDto } from './dto/shopping.dto';

@Injectable()
export class StoresService {
  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantPrisma) {}

  list() {
    return this.db.store.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        aisles: {
          orderBy: { sortOrder: 'asc' },
          include: { category: { select: { id: true, name: true } } },
        },
      },
    });
  }

  async findOne(id: number) {
    const store = await this.db.store.findFirst({
      where: { id },
      include: {
        aisles: {
          orderBy: { sortOrder: 'asc' },
          include: { category: { select: { id: true, name: true } } },
        },
      },
    });
    if (!store) throw new NotFoundException(`No store with id ${id}.`);
    return store;
  }

  async create(dto: CreateStoreDto) {
    await this.assertNameFree(dto.name.trim());
    return this.db.store.create({
      data: {
        name: dto.name.trim(),
        sortOrder: dto.sortOrder ?? 0,
        note: dto.note?.trim() || null,
      } as never,
    });
  }

  async update(id: number, dto: UpdateStoreDto) {
    await this.findOne(id);
    if (dto.name !== undefined) await this.assertNameFree(dto.name.trim(), id);

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.note !== undefined) data.note = dto.note?.trim() || null;

    return this.db.store.update({ where: { id }, data: data as never });
  }

  /**
   * Replaces a store's aisle order wholesale.
   *
   * This is what makes a generated list read in the order the shopper actually
   * walks, which is the difference between a list you tick off in one pass and
   * one that sends you back across the shop three times.
   */
  async setAisles(id: number, dto: SetAislesDto) {
    await this.findOne(id);

    const categoryIds = dto.aisles.map((aisle) => aisle.categoryId);
    const duplicate = categoryIds.find((c, i) => categoryIds.indexOf(c) !== i);
    if (duplicate !== undefined) {
      throw new BadRequestException(
        `Category ${duplicate} appears twice; one position per category.`,
      );
    }

    const known = await this.db.ingredientCategory.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true },
    });
    const missing = categoryIds.filter((c) => !known.some((k) => k.id === c));
    if (missing.length > 0) {
      throw new BadRequestException(`Unknown category ids: ${missing.join(', ')}.`);
    }

    await this.db.$transaction(async (tx) => {
      await tx.storeAisle.deleteMany({ where: { storeId: id } });
      for (const aisle of dto.aisles) {
        await tx.storeAisle.create({
          data: { storeId: id, categoryId: aisle.categoryId, sortOrder: aisle.sortOrder },
        });
      }
    });

    return this.findOne(id);
  }

  /**
   * Removing a store that lists or price observations still point at would
   * either orphan them or take history with it, so it is refused while in use.
   */
  async remove(id: number) {
    await this.findOne(id);

    const [lists, prices] = await Promise.all([
      this.db.shoppingList.count({ where: { storeId: id } }),
      this.db.priceObservation.count({ where: { storeId: id } }),
    ]);

    if (lists > 0 || prices > 0) {
      throw new ConflictException(
        `That store is still referenced by ${lists} list(s) and ${prices} price ` +
          'record(s), which would lose their history.',
      );
    }

    await this.db.$transaction(async (tx) => {
      await tx.storeAisle.deleteMany({ where: { storeId: id } });
      await tx.store.delete({ where: { id } });
    });
    return { id };
  }

  /** The aisle order for one store, ready for the generator. */
  async aisleOrder(storeId: number | null | undefined): Promise<Map<number, number>> {
    if (!storeId) return new Map();
    const aisles = await this.db.storeAisle.findMany({
      where: { storeId },
      select: { categoryId: true, sortOrder: true },
    });
    return new Map(aisles.map((aisle) => [aisle.categoryId, aisle.sortOrder]));
  }

  private async assertNameFree(name: string, exceptId?: number): Promise<void> {
    const clash = await this.db.store.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash) throw new ConflictException(`You already have a store called "${name}".`);
  }
}
