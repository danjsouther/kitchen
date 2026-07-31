import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.service';
import type { CreateLocationDto, UpdateLocationDto } from './dto/pantry.dto';

/**
 * Where things are kept — fridge, freezer, larder. Ordering is the household's
 * own, so the pantry screen can read in the order they actually walk.
 */
@Injectable()
export class LocationsService {
  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantPrisma) {}

  list() {
    return this.db.storageLocation.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { items: true } } },
    });
  }

  async create(dto: CreateLocationDto) {
    const name = dto.name.trim();
    await this.assertNameFree(name);

    return this.db.storageLocation.create({
      data: { name, sortOrder: dto.sortOrder ?? 0 } as never,
    });
  }

  async update(id: number, dto: UpdateLocationDto) {
    await this.assertExists(id);
    if (dto.name !== undefined) await this.assertNameFree(dto.name.trim(), id);

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

    return this.db.storageLocation.update({ where: { id }, data: data as never });
  }

  /**
   * Removing a location with lots in it would either orphan them or cascade the
   * lots away, and neither is what "rename my shelves" should do. The user moves
   * the lots first.
   */
  async remove(id: number) {
    await this.assertExists(id);

    const inUse = await this.db.pantryItem.count({ where: { locationId: id } });
    if (inUse > 0) {
      throw new ConflictException(
        `That location still holds ${inUse} item${inUse === 1 ? '' : 's'}. ` +
          'Move or use them up first.',
      );
    }

    await this.db.storageLocation.delete({ where: { id } });
    return { id };
  }

  private async assertExists(id: number): Promise<void> {
    const found = await this.db.storageLocation.findFirst({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException(`No storage location with id ${id}.`);
  }

  private async assertNameFree(name: string, exceptId?: number): Promise<void> {
    const clash = await this.db.storageLocation.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash) throw new ConflictException(`You already have a "${name}".`);
  }
}
