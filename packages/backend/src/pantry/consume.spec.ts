import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UnitKind } from '@kitchen/shared-types';

import { PantryService } from './pantry.service';

/**
 * `PantryService.consume`'s orchestration — which lots reach the planner, and
 * what a stale pin does.
 *
 * `pantry.service.spec.ts` covers this file's pure helpers; the allocation
 * maths lives in `deduction.spec.ts`. What is left, and what this covers, is
 * the seam between them.
 */

const GRAM = { id: 1, name: 'gram', kind: UnitKind.MASS, toBaseFactor: '1' };

const FLOUR = {
  id: 5,
  name: 'flour',
  gramsPerMl: null,
  gramsPerPiece: null,
  defaultUnitId: GRAM.id,
};

const LOTS = [
  {
    id: 10,
    quantity: '300',
    unit: GRAM,
    ingredient: FLOUR,
    productId: null,
    expiresOn: new Date('2026-08-01T00:00:00Z'),
  },
  {
    id: 11,
    quantity: '1000',
    unit: GRAM,
    ingredient: FLOUR,
    // The EAN-13 form OFF stores; a US pack of it scans 12 digits.
    productId: '0041196010184',
    expiresOn: new Date('2026-12-01T00:00:00Z'),
  },
];

function makeService(lots = LOTS) {
  const lotUpdates: Array<{ id: number; quantity: string }> = [];
  const ledger: Array<{ pantryItemId: number; delta: string }> = [];

  const tx = {
    pantryItem: {
      update: jest.fn(async (args: { where: { id: number }; data: { quantity: string } }) => {
        lotUpdates.push({ id: args.where.id, quantity: args.data.quantity });
        return {};
      }),
    },
    pantryTransaction: {
      create: jest.fn(async (args: { data: { pantryItemId: number; delta: string } }) => {
        ledger.push({ pantryItemId: args.data.pantryItemId, delta: args.data.delta });
        return {};
      }),
    },
  };

  const db = {
    ingredient: { findFirst: jest.fn(async () => FLOUR) },
    pantryItem: { findMany: jest.fn(async () => lots) },
    $transaction: jest.fn(async (body: (t: typeof tx) => Promise<unknown>) => body(tx)),
  };

  const units = { resolve: jest.fn(async () => new Map([[GRAM.id, GRAM]])) };

  const service = new PantryService(
    db as never,
    units as never,
    {} as never,
    {} as never,
  );

  return { service, lotUpdates, ledger };
}

const request = { ingredientId: FLOUR.id, quantity: '500', unitId: GRAM.id };

describe('PantryService.consume pins', () => {
  it('spans lots soonest-expiry-first when nothing is pinned', async () => {
    const { service, lotUpdates } = makeService();

    const result = await service.consume(request, 3);

    expect(result.allocations).toEqual([
      { lotId: 10, took: '300', remaining: '0' },
      { lotId: 11, took: '200', remaining: '800' },
    ]);
    expect(result.pinned).toBeNull();
    expect(lotUpdates).toEqual([
      { id: 10, quantity: '0' },
      { id: 11, quantity: '800' },
    ]);
  });

  it('takes only from the pinned lot', async () => {
    const { service, lotUpdates, ledger } = makeService();

    const result = await service.consume({ ...request, lotId: 11 }, 3);

    expect(result.allocations).toEqual([{ lotId: 11, took: '500', remaining: '500' }]);
    // The soonest-expiry lot was deliberately left alone.
    expect(lotUpdates).toEqual([{ id: 11, quantity: '500' }]);
    expect(ledger).toEqual([{ pantryItemId: 11, delta: '-500' }]);
  });

  it('reports a shortfall rather than spilling onto an unpinned lot', async () => {
    const { service, lotUpdates } = makeService();

    const result = await service.consume({ ...request, lotId: 10 }, 3);

    expect(result.applied).toBe('300');
    expect(result.shortfall).toBe('200');
    expect(lotUpdates).toEqual([{ id: 10, quantity: '0' }]);
  });

  it('pins by barcode across the forms a scan and the catalog disagree on', async () => {
    const { service } = makeService();

    const result = await service.consume({ ...request, productId: '041196010184' }, 3);

    expect(result.allocations).toEqual([{ lotId: 11, took: '500', remaining: '500' }]);
  });

  /**
   * A lot that is gone is a 404, not a silent full shortfall. "The jar you
   * picked is not there" and "you have none of this" are different facts, and
   * only one of them is true.
   */
  it('refuses a pin naming a lot that is no longer there', async () => {
    const { service, lotUpdates } = makeService();

    await expect(service.consume({ ...request, lotId: 999 }, 3)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(lotUpdates).toEqual([]);
  });

  it('refuses a barcode nothing on the shelf carries', async () => {
    const { service } = makeService();

    await expect(
      service.consume({ ...request, productId: '9999999999999' }, 3),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('takes exactly what was stated across several lots', async () => {
    const { service, lotUpdates, ledger } = makeService();

    const result = await service.consume(
      { ...request, draws: [{ lotId: 10, quantity: '120' }, { lotId: 11, quantity: '380' }] },
      3,
    );

    expect(result.allocations).toEqual([
      { lotId: 10, took: '120', remaining: '180' },
      { lotId: 11, took: '380', remaining: '620' },
    ]);
    expect(result.applied).toBe('500');
    expect(result.shortfall).toBe('0');
    expect(lotUpdates).toEqual([
      { id: 10, quantity: '180' },
      { id: 11, quantity: '620' },
    ]);
    expect(ledger).toEqual([
      { pantryItemId: 10, delta: '-120' },
      { pantryItemId: 11, delta: '-380' },
    ]);
  });

  it('never drives a lot negative however much was typed into it', async () => {
    const { service, lotUpdates } = makeService();

    const result = await service.consume(
      { ...request, draws: [{ lotId: 10, quantity: '99999' }] },
      3,
    );

    expect(lotUpdates).toEqual([{ id: 10, quantity: '0' }]);
    expect(result.applied).toBe('300');
  });

  it('refuses draws and a pin together rather than guessing which wins', async () => {
    const { service } = makeService();

    await expect(
      service.consume(
        { ...request, lotId: 11, draws: [{ lotId: 10, quantity: '100' }] },
        3,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a lot and a product together rather than guessing', async () => {
    const { service } = makeService();

    await expect(
      service.consume({ ...request, lotId: 10, productId: '0041196010184' }, 3),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
