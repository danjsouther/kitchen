import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { ProductsService } from '../products/products.service';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.service';
import type { AddScanQueueEntryDto } from './dto/scan-queue.dto';

/**
 * Barcodes scanned in one continuous session, waiting to become pantry lots.
 *
 * Only the barcode is stored. Everything else a queue entry needs to display
 * — product name, image, effective category — comes fresh from
 * `ProductsService.byBarcode()` on every read, the same call the single-scan
 * form already makes, so the queue can never drift from a stored copy of a
 * lookup result.
 */
@Injectable()
export class ScanQueueService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly products: ProductsService,
  ) {}

  async list() {
    const entries = await this.db.scanQueueEntry.findMany({
      orderBy: { createdOn: 'asc' },
    });

    return Promise.all(
      entries.map(async (entry) => ({
        id: entry.id,
        ...(await this.products.byBarcode(entry.barcode)),
      })),
    );
  }

  /**
   * Adds a barcode to the queue, or returns the existing entry unchanged.
   *
   * Not `upsert`: the unique key is (householdId, barcode) and householdId
   * comes from the ambient tenancy context rather than the caller, the same
   * reason `ProductsService.setOverride` uses find-then-create instead.
   */
  async add(dto: AddScanQueueEntryDto) {
    const barcode = this.products.requireBarcode(dto.barcode);

    const existing = await this.db.scanQueueEntry.findFirst({ where: { barcode } });
    const entry = existing ?? (await this.db.scanQueueEntry.create({ data: { barcode } as never }));

    return { id: entry.id, ...(await this.products.byBarcode(barcode)) };
  }

  async remove(id: number) {
    const entry = await this.db.scanQueueEntry.findFirst({ where: { id } });
    if (!entry) throw new NotFoundException(`No scan queue entry with id ${id}.`);
    await this.db.scanQueueEntry.delete({ where: { id } });
  }

  async clear() {
    await this.db.scanQueueEntry.deleteMany({});
  }
}
