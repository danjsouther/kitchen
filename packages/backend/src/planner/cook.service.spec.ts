import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UnitKind } from '@kitchen/shared-types';

import { CookService } from './cook.service';

/**
 * Covers the orchestration `deduction.spec.ts` cannot reach: which lots reach
 * the planner in the first place, and whether the preview keeps its promise not
 * to write.
 *
 * The pure allocation maths is tested there; this file only checks the seam.
 */

const GRAM = { id: 1, name: 'gram', kind: UnitKind.MASS, toBaseFactor: '1' };

/** Two lots of flour: one expiring sooner, one scanned from a US pack. */
const LOTS = [
  {
    id: 10,
    ingredientId: 5,
    quantity: '300',
    unitId: GRAM.id,
    unit: GRAM,
    productId: null,
    expiresOn: new Date('2026-08-01T00:00:00Z'),
  },
  {
    id: 11,
    ingredientId: 5,
    quantity: '1000',
    unitId: GRAM.id,
    unit: GRAM,
    // Stored in the EAN-13 form OFF uses.
    productId: '0041196010184',
    expiresOn: new Date('2026-12-01T00:00:00Z'),
  },
];

const RECIPE = {
  id: 2,
  title: 'Flatbread',
  servings: 4,
  ingredients: [
    {
      id: 100,
      rawText: '500 g flour',
      ingredientId: 5,
      quantity: '500',
      optional: false,
      unit: GRAM,
      ingredient: { id: 5, name: 'flour', gramsPerMl: null, gramsPerPiece: null },
    },
  ],
};

interface Writes {
  cookSessions: unknown[];
  lotUpdates: Array<{ id: number; quantity: string }>;
  ledger: Array<{ pantryItemId: number; delta: string }>;
}

/**
 * The narrowest stub the service actually touches.
 *
 * Deliberately hand-rolled rather than a mocked PrismaClient: the point of
 * these tests is which *arguments* reach `pantryItem.findMany` and whether the
 * transaction body runs at all, both of which a permissive auto-mock hides.
 */
function makeDb(lots = LOTS) {
  const writes: Writes = { cookSessions: [], lotUpdates: [], ledger: [] };

  const tx = {
    cookSession: {
      create: jest.fn(async (args: { data: unknown }) => {
        writes.cookSessions.push(args.data);
        return { id: 77 };
      }),
    },
    pantryItem: {
      update: jest.fn(async (args: { where: { id: number }; data: { quantity: string } }) => {
        writes.lotUpdates.push({ id: args.where.id, quantity: args.data.quantity });
        return {};
      }),
    },
    pantryTransaction: {
      create: jest.fn(async (args: { data: { pantryItemId: number; delta: string } }) => {
        writes.ledger.push({
          pantryItemId: args.data.pantryItemId,
          delta: args.data.delta,
        });
        return {};
      }),
    },
  };

  const db = {
    recipe: { findFirst: jest.fn(async () => RECIPE) },
    pantryItem: { findMany: jest.fn(async () => lots) },
    plannedMeal: {
      findFirst: jest.fn(async () => ({
        id: 1,
        recipeId: RECIPE.id,
        servings: 4,
        status: 'PLANNED',
        note: null,
      })),
      update: jest.fn(async () => ({})),
    },
    $transaction: jest.fn(async (body: (t: typeof tx) => Promise<unknown>) => body(tx)),
  };

  return { db, tx, writes };
}

function makeService(lots = LOTS) {
  const harness = makeDb(lots);
  return { ...harness, cook: new CookService(harness.db as never) };
}

describe('CookService pins', () => {
  it('spans lots soonest-expiry-first when nothing is pinned', async () => {
    const { cook, writes } = makeService();

    const report = await cook.previewRecipe(RECIPE.id, {});

    expect(report.deducted[0].fromLots).toEqual([
      { lotId: 10, took: '300', remaining: '0' },
      { lotId: 11, took: '200', remaining: '800' },
    ]);
    expect(report.deducted[0].pinned).toBeNull();
    expect(writes.lotUpdates).toEqual([]);
  });

  it('draws from only the pinned lot', async () => {
    const { cook } = makeService();

    const report = await cook.previewRecipe(RECIPE.id, {
      pins: [{ ingredientId: 5, lotId: 11 }],
    });

    expect(report.deducted[0].fromLots).toEqual([
      { lotId: 11, took: '500', remaining: '500' },
    ]);
    expect(report.deducted[0].pinned).toEqual({ lotId: 11, productId: undefined });
    expect(report.shortfalls).toEqual([]);
  });

  /**
   * The point of the whole feature: a pin must not quietly spill onto the lot
   * the cook deliberately did not choose.
   */
  it('reports a shortfall rather than spilling onto an unpinned lot', async () => {
    const { cook } = makeService();

    const report = await cook.previewRecipe(RECIPE.id, {
      pins: [{ ingredientId: 5, lotId: 10 }],
    });

    expect(report.deducted[0].fromLots).toEqual([
      { lotId: 10, took: '300', remaining: '0' },
    ]);
    expect(report.shortfalls).toHaveLength(1);
    expect(report.shortfalls[0].short).toBe('200');
    // The 1 kg lot sat untouched, which is what was asked for.
    expect(report.deducted[0].fromLots.some((l) => l.lotId === 11)).toBe(false);
  });

  it('pins by barcode across the forms a scan and the catalog disagree on', async () => {
    const { cook } = makeService();

    // Scanned as 12-digit UPC-A; stored as EAN-13.
    const report = await cook.previewRecipe(RECIPE.id, {
      pins: [{ ingredientId: 5, productId: '041196010184' }],
    });

    expect(report.deducted[0].fromLots).toEqual([
      { lotId: 11, took: '500', remaining: '500' },
    ]);
  });

  /**
   * A product pin is "use the Barilla", not "use this jar" — two half-used
   * packs of the same thing are still that thing, so it spans them, soonest
   * expiry first, exactly as an unpinned deduction would.
   */
  it('spans several lots of the pinned product when one is not enough', async () => {
    const twoPacks = [
      { ...LOTS[0], id: 20, quantity: '200', productId: '0041196010184' },
      { ...LOTS[1], id: 21, quantity: '400', productId: '0041196010184' },
      // A third lot of the same ingredient, different product: must stay out.
      { ...LOTS[1], id: 22, quantity: '5000', productId: '5000112637922' },
    ];
    const { cook } = makeService(twoPacks);

    const report = await cook.previewRecipe(RECIPE.id, {
      pins: [{ ingredientId: 5, productId: '0041196010184' }],
    });

    expect(report.deducted[0].fromLots).toEqual([
      { lotId: 20, took: '200', remaining: '0' },
      { lotId: 21, took: '300', remaining: '100' },
    ]);
    expect(report.shortfalls).toEqual([]);
  });

  it('stops at the pinned product rather than reaching for another one', async () => {
    const notEnough = [
      { ...LOTS[0], id: 20, quantity: '200', productId: '0041196010184' },
      { ...LOTS[1], id: 21, quantity: '100', productId: '0041196010184' },
      { ...LOTS[1], id: 22, quantity: '5000', productId: '5000112637922' },
    ];
    const { cook } = makeService(notEnough);

    const report = await cook.previewRecipe(RECIPE.id, {
      pins: [{ ingredientId: 5, productId: '0041196010184' }],
    });

    expect(report.deducted[0].fromLots.map((l) => l.lotId)).toEqual([20, 21]);
    expect(report.shortfalls[0].short).toBe('200');
  });

  it('refuses a pin naming a lot that is no longer there', async () => {
    const { cook } = makeService();

    await expect(
      cook.previewRecipe(RECIPE.id, { pins: [{ ingredientId: 5, lotId: 999 }] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses two pins for the same ingredient rather than picking one', async () => {
    const { cook } = makeService();

    await expect(
      cook.previewRecipe(RECIPE.id, {
        pins: [
          { ingredientId: 5, lotId: 10 },
          { ingredientId: 5, lotId: 11 },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('aborts a real cook on a stale pin instead of deducting elsewhere', async () => {
    const { cook, writes } = makeService();

    await expect(
      cook.cook(1, { pins: [{ ingredientId: 5, lotId: 999 }] }, 3),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(writes.cookSessions).toEqual([]);
    expect(writes.lotUpdates).toEqual([]);
  });
});

describe('CookService explicit draws', () => {
  it('takes exactly what the cook said, from the lots they said', async () => {
    const { cook, writes } = makeService();

    const pins = [
      { ingredientId: 5, draws: [{ lotId: 10, quantity: '120' }, { lotId: 11, quantity: '380' }] },
    ];
    const preview = await cook.previewRecipe(RECIPE.id, { pins });
    expect(preview.deducted[0].fromLots).toEqual([
      { lotId: 10, took: '120', remaining: '180' },
      { lotId: 11, took: '380', remaining: '620' },
    ]);
    expect(preview.deducted[0].explicit).toBe(true);
    expect(preview.shortfalls).toEqual([]);

    await cook.cookRecipe(RECIPE.id, { pins }, 3);
    expect(writes.lotUpdates).toEqual([
      { id: 10, quantity: '180' },
      { id: 11, quantity: '620' },
    ]);
    // The ledger records each lot in its own unit, as it always has.
    expect(writes.ledger).toEqual([
      { pantryItemId: 10, delta: '-120' },
      { pantryItemId: 11, delta: '-380' },
    ]);
  });

  it('reports the gap when the cook accounts for less than the recipe needed', async () => {
    const { cook } = makeService();

    const report = await cook.previewRecipe(RECIPE.id, {
      pins: [{ ingredientId: 5, draws: [{ lotId: 10, quantity: '100' }] }],
    });

    expect(report.deducted[0].took).toBe('100');
    expect(report.shortfalls[0].short).toBe('400');
  });

  it('leaves a lot given a zero draw completely alone', async () => {
    const { cook, writes } = makeService();

    await cook.cookRecipe(
      RECIPE.id,
      { pins: [{ ingredientId: 5, draws: [{ lotId: 10, quantity: '0' }, { lotId: 11, quantity: '500' }] }] },
      3,
    );

    expect(writes.lotUpdates).toEqual([{ id: 11, quantity: '500' }]);
    expect(writes.ledger).toEqual([{ pantryItemId: 11, delta: '-500' }]);
  });

  it('refuses draws and a pin together rather than guessing which wins', async () => {
    const { cook } = makeService();

    await expect(
      cook.previewRecipe(RECIPE.id, {
        pins: [{ ingredientId: 5, lotId: 11, draws: [{ lotId: 10, quantity: '100' }] }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses two amounts for the same lot', async () => {
    const { cook } = makeService();

    await expect(
      cook.previewRecipe(RECIPE.id, {
        pins: [
          { ingredientId: 5, draws: [{ lotId: 10, quantity: '100' }, { lotId: 10, quantity: '50' }] },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a draw naming a lot that is no longer there, writing nothing', async () => {
    const { cook, writes } = makeService();

    await expect(
      cook.cook(1, { pins: [{ ingredientId: 5, draws: [{ lotId: 999, quantity: '10' }] }] }, 3),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(writes.cookSessions).toEqual([]);
    expect(writes.lotUpdates).toEqual([]);
  });
});

describe('CookService preview', () => {
  it('writes nothing at all', async () => {
    const { cook, db, tx } = makeService();

    const report = await cook.previewRecipe(RECIPE.id, {});

    expect(report.cookSessionId).toBeNull();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.cookSession.create).not.toHaveBeenCalled();
    expect(tx.pantryItem.update).not.toHaveBeenCalled();
    expect(tx.pantryTransaction.create).not.toHaveBeenCalled();
  });

  /** What the user approved has to be what happens. */
  it('promises the same split the cook then performs', async () => {
    const { cook, writes } = makeService();
    const pins = [{ ingredientId: 5, lotId: 11 }];

    const preview = await cook.previewRecipe(RECIPE.id, { pins });
    const done = await cook.cookRecipe(RECIPE.id, { pins }, 3);

    expect(done.cookSessionId).toBe(77);
    expect(done.deducted).toEqual(preview.deducted);
    expect(writes.lotUpdates).toEqual([{ id: 11, quantity: '500' }]);
    expect(writes.ledger).toEqual([{ pantryItemId: 11, delta: '-500' }]);
  });
});
