import { UnitKind } from './enums';
import {
  ConversionFailure,
  canConvert,
  convert,
  scaleForServings,
  sumInUnit,
  type IngredientPhysicals,
  type UnitDef,
} from './units';

// Base units are gram / millilitre / each; toBaseFactor is the multiplier into them.
const gram: UnitDef = { id: 1, name: 'gram', kind: UnitKind.MASS, toBaseFactor: 1 };
const kilogram: UnitDef = { id: 2, name: 'kilogram', kind: UnitKind.MASS, toBaseFactor: 1000 };
const ounce: UnitDef = { id: 3, name: 'ounce', kind: UnitKind.MASS, toBaseFactor: '28.349523125' };
const pound: UnitDef = { id: 4, name: 'pound', kind: UnitKind.MASS, toBaseFactor: '453.59237' };

const millilitre: UnitDef = { id: 10, name: 'millilitre', kind: UnitKind.VOLUME, toBaseFactor: 1 };
const litre: UnitDef = { id: 11, name: 'litre', kind: UnitKind.VOLUME, toBaseFactor: 1000 };
const cup: UnitDef = { id: 12, name: 'cup', kind: UnitKind.VOLUME, toBaseFactor: '236.5882365' };
const tablespoon: UnitDef = { id: 13, name: 'tablespoon', kind: UnitKind.VOLUME, toBaseFactor: '14.78676478125' };
const teaspoon: UnitDef = { id: 14, name: 'teaspoon', kind: UnitKind.VOLUME, toBaseFactor: '4.92892159375' };

const each: UnitDef = { id: 20, name: 'each', kind: UnitKind.COUNT, toBaseFactor: 1 };
const dozen: UnitDef = { id: 21, name: 'dozen', kind: UnitKind.COUNT, toBaseFactor: 12 };

const water: IngredientPhysicals = { gramsPerMl: 1 };
const flour: IngredientPhysicals = { gramsPerMl: '0.53' };
const egg: IngredientPhysicals = { gramsPerPiece: 50 };
const onion: IngredientPhysicals = { gramsPerPiece: 150, gramsPerMl: '0.6' };
const thyme: IngredientPhysicals = {}; // a sprig has neither density nor piece weight

/** Unwraps a successful conversion, failing the test with the reason otherwise. */
function expectOk(result: ReturnType<typeof convert>): number {
  if (!result.ok) {
    throw new Error(`expected a successful conversion, got ${result.reason}`);
  }
  return result.quantity.toNumber();
}

describe('convert — same kind', () => {
  it.each([
    ['1 kg to g', 1, kilogram, gram, 1000],
    ['500 g to kg', 500, gram, kilogram, 0.5],
    ['1 lb to g', 1, pound, gram, 453.59237],
    ['16 oz to lb', 16, ounce, pound, 1],
    ['1 l to ml', 1, litre, millilitre, 1000],
    ['1 cup to ml', 1, cup, millilitre, 236.5882365],
    ['16 tbsp to cup', 16, tablespoon, cup, 1],
    ['3 tsp to tbsp', 3, teaspoon, tablespoon, 1],
    ['1 dozen to each', 1, dozen, each, 12],
    ['6 each to dozen', 6, each, dozen, 0.5],
  ])('%s', (_label, qty, from, to, expected) => {
    expect(expectOk(convert(qty, from, to))).toBeCloseTo(expected, 8);
  });

  it('needs no ingredient for same-kind conversions', () => {
    expect(convert(1, cup, millilitre).ok).toBe(true);
  });

  it('round-trips without drift', () => {
    const there = convert('2.5', cup, millilitre);
    expect(there.ok).toBe(true);
    if (!there.ok) return;
    const back = convert(there.quantity, millilitre, cup);
    expect(expectOk(back)).toBeCloseTo(2.5, 10);
  });
});

describe('convert — volume <-> mass via density', () => {
  it('converts cups of water to grams', () => {
    expect(expectOk(convert(1, cup, gram, water))).toBeCloseTo(236.5882365, 6);
  });

  it('converts cups of flour to grams using its density', () => {
    // 236.5882365 ml * 0.53 g/ml = 125.39 g — the familiar "a cup of flour is ~125 g".
    expect(expectOk(convert(1, cup, gram, flour))).toBeCloseTo(125.3917, 3);
  });

  it('converts grams of flour back to cups', () => {
    expect(expectOk(convert('125.3917653', gram, cup, flour))).toBeCloseTo(1, 6);
  });

  it('deducts a recipe amount from a bagged pantry quantity', () => {
    // The motivating case: 2 cups of flour out of a 5 lb bag.
    // 5 lb = 2267.96185 g; 2 cups flour = 2 * 236.5882365 ml * 0.53 g/ml = 250.78353 g
    const bagInGrams = expectOk(convert(5, pound, gram));
    const usedInGrams = expectOk(convert(2, cup, gram, flour));
    expect(bagInGrams).toBeCloseTo(2267.96185, 5);
    expect(usedInGrams).toBeCloseTo(250.78353, 5);
    expect(bagInGrams - usedInGrams).toBeCloseTo(2017.17832, 4);
  });
});

describe('convert — count <-> mass via piece weight', () => {
  it('converts eggs to grams', () => {
    expect(expectOk(convert(3, each, gram, egg))).toBeCloseTo(150, 8);
  });

  it('converts grams back to eggs', () => {
    expect(expectOk(convert(150, gram, each, egg))).toBeCloseTo(3, 8);
  });

  it('converts a dozen eggs to kilograms', () => {
    expect(expectOk(convert(1, dozen, kilogram, egg))).toBeCloseTo(0.6, 8);
  });
});

describe('convert — count <-> volume needs both constants', () => {
  it('succeeds when the ingredient has piece weight and density', () => {
    // 2 onions -> 300 g -> /0.6 g/ml -> 500 ml
    expect(expectOk(convert(2, each, millilitre, onion))).toBeCloseTo(500, 6);
  });

  it('fails with NO_DENSITY when only piece weight is known', () => {
    const result = convert(2, each, millilitre, egg);
    expect(result).toEqual({ ok: false, reason: ConversionFailure.NO_DENSITY });
  });

  it('fails with NO_PIECE_WEIGHT when only density is known', () => {
    const result = convert(200, millilitre, each, flour);
    expect(result).toEqual({
      ok: false,
      reason: ConversionFailure.NO_PIECE_WEIGHT,
    });
  });
});

// The most important behaviour in the codebase: refuse, never guess.
describe('convert — failures are reported, never guessed', () => {
  it('does not throw when it cannot convert', () => {
    expect(() => convert(3, each, gram, thyme)).not.toThrow();
  });

  it('reports NO_PIECE_WEIGHT rather than assuming a weight', () => {
    expect(convert(3, each, gram, thyme)).toEqual({
      ok: false,
      reason: ConversionFailure.NO_PIECE_WEIGHT,
    });
  });

  it('reports NO_DENSITY rather than assuming water', () => {
    expect(convert(1, cup, gram, thyme)).toEqual({
      ok: false,
      reason: ConversionFailure.NO_DENSITY,
    });
  });

  it('never returns a zero quantity in place of a failure', () => {
    const result = convert(1, cup, gram, thyme);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('quantity');
  });

  it('reports NO_INGREDIENT when a cross-kind conversion gets none', () => {
    expect(convert(1, cup, gram)).toEqual({
      ok: false,
      reason: ConversionFailure.NO_INGREDIENT,
    });
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['non-finite', Infinity],
  ])('reports INVALID_UNIT for a %s toBaseFactor', (_label, factor) => {
    const broken: UnitDef = { id: 99, name: 'broken', kind: UnitKind.MASS, toBaseFactor: factor };
    expect(convert(1, broken, gram)).toEqual({
      ok: false,
      reason: ConversionFailure.INVALID_UNIT,
    });
    expect(convert(1, gram, broken)).toEqual({
      ok: false,
      reason: ConversionFailure.INVALID_UNIT,
    });
  });

  it.each([
    ['zero', 0],
    ['negative', -2],
  ])('treats a %s density as absent rather than dividing by it', (_label, density) => {
    expect(convert(1, cup, gram, { gramsPerMl: density })).toEqual({
      ok: false,
      reason: ConversionFailure.NO_DENSITY,
    });
  });

  it('treats a null piece weight as absent', () => {
    expect(convert(1, each, gram, { gramsPerPiece: null })).toEqual({
      ok: false,
      reason: ConversionFailure.NO_PIECE_WEIGHT,
    });
  });
});

describe('canConvert', () => {
  it('is true for same-kind pairs with no ingredient', () => {
    expect(canConvert(cup, millilitre)).toBe(true);
  });

  it('is false for cross-kind pairs without the needed constant', () => {
    expect(canConvert(cup, gram, thyme)).toBe(false);
  });

  it('is true for cross-kind pairs once the constant exists', () => {
    expect(canConvert(cup, gram, flour)).toBe(true);
  });
});

describe('sumInUnit', () => {
  it('adds lots expressed in mixed units', () => {
    const result = sumInUnit(
      [
        { quantity: 1, unit: kilogram },
        { quantity: 500, unit: gram },
        { quantity: 1, unit: pound },
      ],
      gram,
    );
    expect(result.unconvertible).toHaveLength(0);
    expect(result.total.toNumber()).toBeCloseTo(1953.59237, 5);
  });

  it('crosses kinds when the ingredient allows it', () => {
    const result = sumInUnit(
      [
        { quantity: 1, unit: cup },
        { quantity: 100, unit: gram },
      ],
      gram,
      flour,
    );
    expect(result.unconvertible).toHaveLength(0);
    expect(result.total.toNumber()).toBeCloseTo(225.3917, 3);
  });

  it('reports unconvertible entries instead of dropping them', () => {
    const result = sumInUnit(
      [
        { quantity: 2, unit: kilogram },
        { quantity: 3, unit: each }, // sprigs — no piece weight
      ],
      gram,
      thyme,
    );
    expect(result.total.toNumber()).toBe(2000);
    expect(result.unconvertible).toHaveLength(1);
    expect(result.unconvertible[0].reason).toBe(
      ConversionFailure.NO_PIECE_WEIGHT,
    );
    expect(result.unconvertible[0].entry.quantity).toBe(3);
  });

  it('totals zero for an empty list without failing', () => {
    const result = sumInUnit([], gram);
    expect(result.total.toNumber()).toBe(0);
    expect(result.unconvertible).toHaveLength(0);
  });
});

describe('scaleForServings', () => {
  it('doubles a recipe', () => {
    expect(scaleForServings(2, 4, 8).toNumber()).toBe(4);
  });

  it('halves a recipe', () => {
    expect(scaleForServings(3, 4, 2).toNumber()).toBe(1.5);
  });

  it('keeps full precision on thirds so repeated scaling does not drift', () => {
    const once = scaleForServings(1, 3, 1);
    const restored = scaleForServings(once, 1, 3);
    expect(restored.toNumber()).toBeCloseTo(1, 12);
  });

  it('returns the original quantity when the recipe serving count is unusable', () => {
    expect(scaleForServings(2, 0, 8).toNumber()).toBe(2);
    expect(scaleForServings(2, -1, 8).toNumber()).toBe(2);
  });
});
