import Decimal from 'decimal.js';
import { ConversionFailure, UnitKind } from '@recipes/shared-types';

import { balanceFor, chooseTargetUnit, shortfallAgainstPar } from './pantry-balance';

const GRAM = { id: 1, name: 'gram', kind: UnitKind.MASS, toBaseFactor: '1' };
const KILOGRAM = { id: 2, name: 'kilogram', kind: UnitKind.MASS, toBaseFactor: '1000' };
const CUP = { id: 3, name: 'cup', kind: UnitKind.VOLUME, toBaseFactor: '236.5882365' };
const EACH = { id: 4, name: 'each', kind: UnitKind.COUNT, toBaseFactor: '1' };

const FLOUR = { gramsPerMl: '0.53' };
const NO_PHYSICALS = {};

describe('chooseTargetUnit', () => {
  it('honours the ingredient default above everything else', () => {
    const lots = [{ id: 1, quantity: 1, unit: CUP }];
    expect(chooseTargetUnit(lots, GRAM)).toBe(GRAM);
  });

  // Reporting in the unit the household already stocks means the common case
  // needs no conversion at all, so it cannot fail.
  it('otherwise picks the unit most lots already use', () => {
    const lots = [
      { id: 1, quantity: 1, unit: CUP },
      { id: 2, quantity: 500, unit: GRAM },
      { id: 3, quantity: 250, unit: GRAM },
    ];
    expect(chooseTargetUnit(lots)).toBe(GRAM);
  });

  it('falls back to the first lot when every unit is equally common', () => {
    const lots = [
      { id: 1, quantity: 1, unit: CUP },
      { id: 2, quantity: 500, unit: GRAM },
    ];
    expect(chooseTargetUnit(lots)).toBe(CUP);
  });

  it('has no answer for an empty pantry', () => {
    expect(chooseTargetUnit([])).toBeNull();
  });
});

describe('balanceFor', () => {
  it('sums lots already in the same unit', () => {
    const balance = balanceFor([
      { id: 1, quantity: 500, unit: GRAM },
      { id: 2, quantity: 250, unit: GRAM },
    ]);
    expect(balance.total?.toString()).toBe('750');
    expect(balance.unit).toBe(GRAM);
    expect(balance.unconvertible).toEqual([]);
  });

  it('converts across units of the same kind', () => {
    const balance = balanceFor(
      [
        { id: 1, quantity: 500, unit: GRAM },
        { id: 2, quantity: 1, unit: KILOGRAM },
      ],
      NO_PHYSICALS,
      GRAM,
    );
    expect(balance.total?.toString()).toBe('1500');
  });

  // The case the whole app exists for: a bag measured by weight and a scoop
  // measured by volume are the same flour.
  it('bridges volume and mass using the ingredient density', () => {
    const balance = balanceFor(
      [
        { id: 1, quantity: 500, unit: GRAM },
        { id: 2, quantity: 2, unit: CUP },
      ],
      FLOUR,
      GRAM,
    );
    // 2 cups * 236.5882365 ml * 0.53 g/ml = 250.783...g, plus 500 g.
    expect(balance.total?.toFixed(4)).toBe('750.7835');
  });

  it('reports a lot it cannot convert instead of dropping it', () => {
    const balance = balanceFor(
      [
        { id: 1, quantity: 500, unit: GRAM },
        { id: 2, quantity: 2, unit: CUP },
      ],
      NO_PHYSICALS, // no density: cups cannot become grams
      GRAM,
    );
    expect(balance.total?.toString()).toBe('500');
    expect(balance.unconvertible).toEqual([
      { lotId: 2, quantity: '2', unit: CUP, reason: ConversionFailure.NO_DENSITY },
    ]);
  });

  it('names the missing piece weight for a count lot', () => {
    const balance = balanceFor(
      [
        { id: 1, quantity: 500, unit: GRAM },
        { id: 2, quantity: 3, unit: EACH },
      ],
      NO_PHYSICALS,
      GRAM,
    );
    expect(balance.unconvertible[0].reason).toBe(ConversionFailure.NO_PIECE_WEIGHT);
  });

  // "0 on hand" and "we couldn't add this up" are different claims, and only one
  // of them should make someone go shopping.
  it('reports null rather than zero when nothing could be converted', () => {
    const balance = balanceFor(
      [{ id: 1, quantity: 2, unit: CUP }],
      NO_PHYSICALS,
      GRAM,
    );
    expect(balance.total).toBeNull();
    expect(balance.unconvertible).toHaveLength(1);
  });

  it('reports an empty pantry as no total and no unit', () => {
    expect(balanceFor([])).toEqual({
      total: null,
      unit: null,
      lotCount: 0,
      unconvertible: [],
    });
  });

  it('counts every lot, convertible or not', () => {
    const balance = balanceFor(
      [
        { id: 1, quantity: 500, unit: GRAM },
        { id: 2, quantity: 2, unit: CUP },
      ],
      NO_PHYSICALS,
      GRAM,
    );
    expect(balance.lotCount).toBe(2);
  });
});

describe('shortfallAgainstPar', () => {
  const par = { quantity: 1000, unit: GRAM };

  it('reports the gap when stock is below par', () => {
    const balance = balanceFor([{ id: 1, quantity: 400, unit: GRAM }]);
    expect(shortfallAgainstPar(balance, par)).toEqual({
      short: true,
      by: new Decimal(600),
      unit: GRAM,
    });
  });

  it('reports no shortfall when stock is at or above par', () => {
    const balance = balanceFor([{ id: 1, quantity: 1200, unit: GRAM }]);
    const result = shortfallAgainstPar(balance, par);
    expect(result?.short).toBe(false);
    expect(result?.by.toString()).toBe('0');
  });

  it('converts the balance into the par unit before comparing', () => {
    const balance = balanceFor([{ id: 1, quantity: 2, unit: KILOGRAM }]);
    expect(shortfallAgainstPar(balance, par)?.short).toBe(false);
  });

  it('treats an empty pantry as short by the whole par', () => {
    const result = shortfallAgainstPar(balanceFor([]), par);
    expect(result).toEqual({ short: true, by: new Decimal(1000), unit: GRAM });
  });

  // Returning false here would claim "you have enough", which is exactly the
  // failure that leaves someone at the stove without an ingredient.
  it('returns unknown rather than false when the comparison cannot be made', () => {
    const balance = balanceFor([{ id: 1, quantity: 2, unit: CUP }], NO_PHYSICALS, CUP);
    expect(shortfallAgainstPar(balance, par, NO_PHYSICALS)).toBeNull();
  });

  it('returns unknown when the lots exist but none could be totalled', () => {
    const balance = balanceFor([{ id: 1, quantity: 3, unit: EACH }], NO_PHYSICALS, GRAM);
    expect(balance.total).toBeNull();
    expect(shortfallAgainstPar(balance, par, NO_PHYSICALS)).toBeNull();
  });

  it('compares across kinds when the ingredient has a density', () => {
    const balance = balanceFor([{ id: 1, quantity: 2, unit: CUP }], FLOUR, CUP);
    const result = shortfallAgainstPar(balance, par, FLOUR);
    // 2 cups of flour is about 251 g against a 1000 g par.
    expect(result?.short).toBe(true);
    expect(result?.by.toFixed(2)).toBe('749.22');
  });
});
