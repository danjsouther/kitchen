import { ConversionFailure, UnitKind } from '@kitchen/shared-types';

import {
  PinFailure,
  byExpiryThenId,
  planDeduction,
  planExplicitDeduction,
  selectPinnedLots,
} from './deduction';

const GRAM = { id: 1, name: 'gram', kind: UnitKind.MASS, toBaseFactor: '1' };
const KILOGRAM = { id: 2, name: 'kilogram', kind: UnitKind.MASS, toBaseFactor: '1000' };
const CUP = { id: 3, name: 'cup', kind: UnitKind.VOLUME, toBaseFactor: '236.5882365' };
const EACH = { id: 4, name: 'each', kind: UnitKind.COUNT, toBaseFactor: '1' };

const FLOUR = { gramsPerMl: '0.53' };
const NO_PHYSICALS = {};

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('byExpiryThenId', () => {
  it('puts the soonest expiry first', () => {
    const lots = [
      { id: 1, quantity: 1, unit: GRAM, expiresOn: day('2026-09-01') },
      { id: 2, quantity: 1, unit: GRAM, expiresOn: day('2026-08-01') },
    ];
    expect([...lots].sort(byExpiryThenId).map((l) => l.id)).toEqual([2, 1]);
  });

  // An undated lot is not the one at risk, so dated stock goes first.
  it('sorts undated lots last', () => {
    const lots = [
      { id: 1, quantity: 1, unit: GRAM, expiresOn: null },
      { id: 2, quantity: 1, unit: GRAM, expiresOn: day('2026-08-01') },
    ];
    expect([...lots].sort(byExpiryThenId).map((l) => l.id)).toEqual([2, 1]);
  });

  // An unstable order would make the same request write different ledger rows
  // each time it ran.
  it('breaks ties on id so the order is stable', () => {
    const lots = [
      { id: 9, quantity: 1, unit: GRAM, expiresOn: day('2026-08-01') },
      { id: 3, quantity: 1, unit: GRAM, expiresOn: day('2026-08-01') },
    ];
    expect([...lots].sort(byExpiryThenId).map((l) => l.id)).toEqual([3, 9]);
  });
});

describe('selectPinnedLots', () => {
  const LOTS = [
    { id: 1, productId: null },
    // The same product, two jars: pinning it must keep both.
    { id: 2, productId: '0041196010184' },
    { id: 3, productId: '0041196010184' },
    { id: 4, productId: '5000112637922' },
  ];

  it('returns every lot when there is no pin', () => {
    const result = selectPinnedLots(LOTS, undefined);
    expect(result.ok && result.lots).toEqual(LOTS);
  });

  it('treats an empty pin object as no pin', () => {
    const result = selectPinnedLots(LOTS, {});
    expect(result.ok && result.lots).toEqual(LOTS);
  });

  it('narrows to a single lot', () => {
    const result = selectPinnedLots(LOTS, { lotId: 3 });
    expect(result.ok && result.lots.map((l) => l.id)).toEqual([3]);
  });

  it('narrows to every lot carrying the product, in the order given', () => {
    const result = selectPinnedLots(LOTS, { productId: '0041196010184' });
    expect(result.ok && result.lots.map((l) => l.id)).toEqual([2, 3]);
  });

  // A US pack scans as 12-digit UPC-A while OFF stored the EAN-13 with its
  // leading zero. Comparing raw strings misses a row sitting right there.
  it('matches a UPC-A pin against an EAN-13 stored code', () => {
    const result = selectPinnedLots(LOTS, { productId: '041196010184' });
    expect(result.ok && result.lots.map((l) => l.id)).toEqual([2, 3]);
  });

  it('matches an EAN-13 pin against a UPC-A stored code', () => {
    const lots = [{ id: 7, productId: '041196010184' }];
    const result = selectPinnedLots(lots, { productId: '0041196010184' });
    expect(result.ok && result.lots.map((l) => l.id)).toEqual([7]);
  });

  it('ignores lots that were never scanned', () => {
    const result = selectPinnedLots(LOTS, { productId: '5000112637922' });
    expect(result.ok && result.lots.map((l) => l.id)).toEqual([4]);
  });

  it('refuses a lot and a product together rather than guessing', () => {
    const result = selectPinnedLots(LOTS, { lotId: 2, productId: '5000112637922' });
    expect(result).toEqual({ ok: false, reason: PinFailure.BOTH_GIVEN });
  });

  // Reporting an empty list would flow into planDeduction and come back as a
  // full shortfall — "you have none of this" — when the truth is "the lot you
  // picked is gone".
  it('names a lot that is not on offer instead of returning nothing', () => {
    const result = selectPinnedLots(LOTS, { lotId: 99 });
    expect(result).toEqual({ ok: false, reason: PinFailure.NO_SUCH_LOT });
  });

  it('names a product no lot carries instead of returning nothing', () => {
    const result = selectPinnedLots(LOTS, { productId: '9999999999999' });
    expect(result).toEqual({ ok: false, reason: PinFailure.NO_SUCH_PRODUCT });
  });

  it('treats an unreadable barcode as matching nothing', () => {
    const result = selectPinnedLots(LOTS, { productId: 'not-a-barcode' });
    expect(result).toEqual({ ok: false, reason: PinFailure.NO_SUCH_PRODUCT });
  });

  it('does not mutate the lots it was given', () => {
    const lots = [...LOTS];
    selectPinnedLots(lots, { productId: '0041196010184' });
    expect(lots).toEqual(LOTS);
  });
});

describe('planExplicitDeduction', () => {
  const TWO_LOTS = [
    { id: 1, quantity: 300, unit: GRAM, expiresOn: day('2026-08-01') },
    { id: 2, quantity: 1000, unit: GRAM, expiresOn: day('2026-12-01') },
  ];

  it('takes exactly what was stated from each lot', () => {
    const plan = planExplicitDeduction(
      { quantity: 500, unit: GRAM },
      [
        { lotId: 1, quantity: 200 },
        { lotId: 2, quantity: 300 },
      ],
      TWO_LOTS,
    );

    expect(plan.allocations.map((a) => [a.lotId, a.take.toString(), a.remaining.toString()]))
      .toEqual([
        [1, '200', '100'],
        [2, '300', '700'],
      ]);
    expect(plan.allocated.toString()).toBe('500');
    expect(plan.shortfall.toString()).toBe('0');
  });

  // The whole point: the user's order is the answer, not a starting guess.
  it('does not reorder by expiry or top up a shortfall', () => {
    const plan = planExplicitDeduction(
      { quantity: 500, unit: GRAM },
      [{ lotId: 2, quantity: 100 }],
      TWO_LOTS,
    );

    expect(plan.allocations.map((a) => a.lotId)).toEqual([2]);
    expect(plan.allocated.toString()).toBe('100');
    expect(plan.shortfall.toString()).toBe('400');
  });

  it('treats a zero draw as "leave this jar alone"', () => {
    const plan = planExplicitDeduction(
      { quantity: 500, unit: GRAM },
      [
        { lotId: 1, quantity: 0 },
        { lotId: 2, quantity: 500 },
      ],
      TWO_LOTS,
    );

    expect(plan.allocations.map((a) => a.lotId)).toEqual([2]);
  });

  // Someone typing 900 into a 300 g bag has misread the bag; recording -600 g
  // would poison every later sum.
  it('never drives a lot negative, however much was typed', () => {
    const plan = planExplicitDeduction(
      { quantity: 900, unit: GRAM },
      [{ lotId: 1, quantity: 900 }],
      TWO_LOTS,
    );

    expect(plan.allocations[0].take.toString()).toBe('300');
    expect(plan.allocations[0].remaining.toString()).toBe('0');
    expect(plan.shortfall.toString()).toBe('600');
  });

  it('converts a draw in the lot unit into the requested unit to count it', () => {
    const plan = planExplicitDeduction(
      { quantity: 1500, unit: GRAM },
      [{ lotId: 5, quantity: 1.5 }],
      [{ id: 5, quantity: 2, unit: KILOGRAM }],
    );

    // Written back in the lot's own unit, counted in the request's.
    expect(plan.allocations[0].take.toString()).toBe('1.5');
    expect(plan.allocated.toString()).toBe('1500');
    expect(plan.shortfall.toString()).toBe('0');
  });

  it('reports no shortfall when more was used than the recipe asked for', () => {
    const plan = planExplicitDeduction(
      { quantity: 100, unit: GRAM },
      [{ lotId: 1, quantity: 250 }],
      TWO_LOTS,
    );

    expect(plan.allocated.toString()).toBe('250');
    expect(plan.shortfall.toString()).toBe('0');
  });

  /**
   * The decision that separates this from auto-allocation: the user watched
   * themselves use it, so the withdrawal is real even though its worth against
   * the request is unknowable.
   */
  it('records a draw it cannot convert, but does not count it', () => {
    const lots = [{ id: 9, quantity: 2, unit: CUP }];
    const plan = planExplicitDeduction(
      { quantity: 100, unit: GRAM },
      [{ lotId: 9, quantity: 0.5 }],
      lots,
      NO_PHYSICALS,
    );

    // Deducted.
    expect(plan.allocations).toEqual([
      expect.objectContaining({ lotId: 9 }),
    ]);
    expect(plan.allocations[0].take.toString()).toBe('0.5');
    expect(plan.allocations[0].remaining.toString()).toBe('1.5');
    // Not counted, and not silently zero either.
    expect(plan.allocations[0].takeInRequestUnit).toBeNull();
    expect(plan.allocated.toString()).toBe('0');
    expect(plan.shortfall.toString()).toBe('100');
    expect(plan.unmeasured).toEqual([
      expect.objectContaining({ lotId: 9, reason: ConversionFailure.NO_DENSITY }),
    ]);
    expect(plan.unmeasured[0].took.toString()).toBe('0.5');
    // `unusable` means "left alone" everywhere else and must keep meaning that.
    expect(plan.unusable).toEqual([]);
  });

  it('counts a convertible draw beside an unmeasurable one', () => {
    const lots = [
      { id: 9, quantity: 2, unit: CUP },
      { id: 10, quantity: 500, unit: GRAM },
    ];
    const plan = planExplicitDeduction(
      { quantity: 300, unit: GRAM },
      [
        { lotId: 9, quantity: 1 },
        { lotId: 10, quantity: 200 },
      ],
      lots,
      NO_PHYSICALS,
    );

    expect(plan.allocations).toHaveLength(2);
    expect(plan.allocated.toString()).toBe('200');
    expect(plan.shortfall.toString()).toBe('100');
    expect(plan.unmeasured.map((u) => u.lotId)).toEqual([9]);
  });

  it('ignores a draw naming a lot that is not on offer', () => {
    const plan = planExplicitDeduction(
      { quantity: 500, unit: GRAM },
      [{ lotId: 99, quantity: 100 }],
      TWO_LOTS,
    );
    expect(plan.allocations).toEqual([]);
  });

  it('does not mutate its inputs', () => {
    const lots = TWO_LOTS.map((l) => ({ ...l }));
    const draws = [{ lotId: 1, quantity: 200 }];
    planExplicitDeduction({ quantity: 500, unit: GRAM }, draws, lots);
    expect(lots).toEqual(TWO_LOTS);
    expect(draws).toEqual([{ lotId: 1, quantity: 200 }]);
  });
});

describe('planDeduction', () => {
  it('takes from a single lot that covers the request', () => {
    const plan = planDeduction({ quantity: 300, unit: GRAM }, [
      { id: 1, quantity: 1000, unit: GRAM },
    ]);
    expect(plan.allocations).toEqual([
      expect.objectContaining({ lotId: 1 }),
    ]);
    expect(plan.allocations[0].take.toString()).toBe('300');
    expect(plan.allocations[0].remaining.toString()).toBe('700');
    expect(plan.shortfall.toString()).toBe('0');
  });

  it('spans lots, consuming the soonest to expire first', () => {
    const plan = planDeduction({ quantity: 300, unit: GRAM }, [
      { id: 1, quantity: 200, unit: GRAM, expiresOn: day('2026-09-01') },
      { id: 2, quantity: 200, unit: GRAM, expiresOn: day('2026-08-01') },
    ]);

    expect(plan.allocations.map((a) => [a.lotId, a.take.toString()])).toEqual([
      [2, '200'],
      [1, '100'],
    ]);
    expect(plan.shortfall.toString()).toBe('0');
  });

  it('stops as soon as the request is covered', () => {
    const plan = planDeduction({ quantity: 50, unit: GRAM }, [
      { id: 1, quantity: 200, unit: GRAM, expiresOn: day('2026-08-01') },
      { id: 2, quantity: 200, unit: GRAM, expiresOn: day('2026-09-01') },
    ]);
    expect(plan.allocations).toHaveLength(1);
    expect(plan.allocations[0].lotId).toBe(1);
  });

  it('converts between the lot unit and the requested unit', () => {
    const plan = planDeduction({ quantity: 1500, unit: GRAM }, [
      { id: 1, quantity: 2, unit: KILOGRAM },
    ]);
    // Stored in kilograms, so the lot is written back in kilograms.
    expect(plan.allocations[0].take.toString()).toBe('1.5');
    expect(plan.allocations[0].remaining.toString()).toBe('0.5');
    // Never null from auto-allocation: it skips what it cannot convert.
    expect(plan.allocations[0].takeInRequestUnit?.toString()).toBe('1500');
  });

  it('bridges kinds when the ingredient has a density', () => {
    const plan = planDeduction(
      { quantity: 100, unit: GRAM },
      [{ id: 1, quantity: 4, unit: CUP }],
      FLOUR,
    );
    expect(plan.shortfall.toString()).toBe('0');
    // 100 g / 0.53 g per ml = 188.679 ml, / 236.588 ml per cup = 0.7975 cups.
    expect(plan.allocations[0].take.toFixed(4)).toBe('0.7975');
    expect(plan.allocations[0].remaining.toFixed(4)).toBe('3.2025');
  });

  // Forcing a negative balance turns one mis-scaled cook into a pantry full of
  // impossible numbers.
  it('never drives a lot negative, reporting the gap instead', () => {
    const plan = planDeduction({ quantity: 500, unit: GRAM }, [
      { id: 1, quantity: 200, unit: GRAM },
    ]);
    expect(plan.allocations[0].take.toString()).toBe('200');
    expect(plan.allocations[0].remaining.toString()).toBe('0');
    expect(plan.allocated.toString()).toBe('200');
    expect(plan.shortfall.toString()).toBe('300');
  });

  it('reports the whole request as shortfall when the pantry is empty', () => {
    const plan = planDeduction({ quantity: 500, unit: GRAM }, []);
    expect(plan.allocations).toEqual([]);
    expect(plan.shortfall.toString()).toBe('500');
  });

  // A lot whose unit cannot be reconciled is left alone and named, so the user
  // can supply the density that would let it count.
  it('skips and reports a lot it cannot convert', () => {
    const plan = planDeduction(
      { quantity: 300, unit: GRAM },
      [
        { id: 1, quantity: 2, unit: CUP },
        { id: 2, quantity: 1000, unit: GRAM },
      ],
      NO_PHYSICALS,
    );

    expect(plan.unusable).toEqual([
      { lotId: 1, unit: CUP, reason: ConversionFailure.NO_DENSITY },
    ]);
    expect(plan.allocations.map((a) => a.lotId)).toEqual([2]);
    expect(plan.shortfall.toString()).toBe('0');
  });

  it('can be short and blocked at the same time', () => {
    const plan = planDeduction(
      { quantity: 300, unit: GRAM },
      [
        { id: 1, quantity: 3, unit: EACH },
        { id: 2, quantity: 100, unit: GRAM },
      ],
      NO_PHYSICALS,
    );
    expect(plan.allocated.toString()).toBe('100');
    expect(plan.shortfall.toString()).toBe('200');
    expect(plan.unusable[0].reason).toBe(ConversionFailure.NO_PIECE_WEIGHT);
  });

  it('ignores empty and negative lots', () => {
    const plan = planDeduction({ quantity: 100, unit: GRAM }, [
      { id: 1, quantity: 0, unit: GRAM, expiresOn: day('2026-08-01') },
      { id: 2, quantity: -5, unit: GRAM, expiresOn: day('2026-08-02') },
      { id: 3, quantity: 400, unit: GRAM, expiresOn: day('2026-08-03') },
    ]);
    expect(plan.allocations.map((a) => a.lotId)).toEqual([3]);
  });

  it('does nothing for a zero or negative request', () => {
    const lots = [{ id: 1, quantity: 400, unit: GRAM }];
    for (const quantity of [0, -5]) {
      const plan = planDeduction({ quantity, unit: GRAM }, lots);
      expect(plan.allocations).toEqual([]);
      expect(plan.shortfall.toString()).toBe('0');
    }
  });

  it('leaves the input lots untouched', () => {
    const lots = [
      { id: 1, quantity: 200, unit: GRAM, expiresOn: day('2026-09-01') },
      { id: 2, quantity: 200, unit: GRAM, expiresOn: day('2026-08-01') },
    ];
    planDeduction({ quantity: 300, unit: GRAM }, lots);
    expect(lots.map((l) => l.id)).toEqual([1, 2]);
    expect(lots[0].quantity).toBe(200);
  });

  // The whole-lot case is the common one and has to come out exact, or lots
  // accumulate dust like 0.0000001 g that never quite empties.
  it('empties a lot exactly when it is fully consumed across units', () => {
    const plan = planDeduction(
      { quantity: 1000, unit: GRAM },
      [{ id: 1, quantity: 1, unit: KILOGRAM }],
    );
    expect(plan.allocations[0].remaining.toString()).toBe('0');
    expect(plan.shortfall.toString()).toBe('0');
  });
});
