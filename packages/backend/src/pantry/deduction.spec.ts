import { ConversionFailure, UnitKind } from '@kitchen/shared-types';

import { byExpiryThenId, planDeduction } from './deduction';

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
    expect(plan.allocations[0].takeInRequestUnit.toString()).toBe('1500');
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
