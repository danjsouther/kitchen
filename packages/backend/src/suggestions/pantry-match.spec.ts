import Decimal from 'decimal.js';
import { ConversionFailure, UnitKind, type UnitDef } from '@kitchen/shared-types';

import {
  matchRecipe,
  rankMatches,
  type MatchRecipe,
  type PantryBalance,
} from './pantry-match';

const GRAM: UnitDef = { id: 1, name: 'gram', kind: UnitKind.MASS, toBaseFactor: '1' };
const KILOGRAM: UnitDef = { id: 2, name: 'kilogram', kind: UnitKind.MASS, toBaseFactor: '1000' };
const CUP: UnitDef = { id: 3, name: 'cup', kind: UnitKind.VOLUME, toBaseFactor: '236.5882365' };
const EACH: UnitDef = { id: 4, name: 'each', kind: UnitKind.COUNT, toBaseFactor: '1' };

const FLOUR = 10;
const EGG = 11;
const THYME = 12;

/**
 * Physicals default to `{}` — an ingredient with no density or piece weight
 * recorded — because that is what the service always passes. Leaving them
 * `undefined` would test a caller bug rather than a real pantry state.
 */
function balance(
  total: string,
  unit = GRAM,
  physicals: Record<string, string> = {},
): PantryBalance {
  return { total: new Decimal(total), unit, physicals };
}

function recipe(lines: Partial<MatchRecipe['lines'][number]>[], servings = 4): MatchRecipe {
  return {
    id: 1,
    title: 'Test Recipe',
    slug: 'test-recipe',
    servings,
    lines: lines.map((line, index) => ({
      lineId: index + 1,
      ingredientId: FLOUR,
      ingredientName: 'flour',
      rawText: '500 g flour',
      quantity: '500',
      unit: GRAM,
      optional: false,
      ...line,
    })),
  };
}

describe('matchRecipe', () => {
  it('counts a satisfied ingredient as have', () => {
    const match = matchRecipe(recipe([{}]), new Map([[FLOUR, balance('1000')]]));
    expect(match.have).toHaveLength(1);
    expect(match.have[0].onHand).toBe('1000');
    expect(match.canCook).toBe(true);
    expect(match.score).toBe(1);
  });

  it('treats exactly enough as enough', () => {
    const match = matchRecipe(recipe([{}]), new Map([[FLOUR, balance('500')]]));
    expect(match.canCook).toBe(true);
    expect(match.have[0].shortBy).toBeNull();
  });

  it('reports a shortfall with the amount still needed', () => {
    const match = matchRecipe(recipe([{}]), new Map([[FLOUR, balance('200')]]));
    expect(match.missing).toHaveLength(1);
    expect(match.missing[0].shortBy).toBe('300');
    expect(match.canCook).toBe(false);
  });

  // Nothing in the pantry is a known amount — zero — not an unknown.
  it('treats an ingredient with no pantry entry as missing, not unknown', () => {
    const match = matchRecipe(recipe([{}]), new Map());
    expect(match.missing[0]).toMatchObject({ onHand: '0', shortBy: '500' });
    expect(match.unknown).toEqual([]);
  });

  it('converts across units before comparing', () => {
    const match = matchRecipe(recipe([{}]), new Map([[FLOUR, balance('1', KILOGRAM)]]));
    expect(match.canCook).toBe(true);
  });

  it('bridges kinds when the ingredient has a density', () => {
    const match = matchRecipe(
      recipe([{ quantity: '2', unit: CUP }]),
      new Map([[FLOUR, balance('1000', GRAM, { gramsPerMl: '0.53' })]]),
    );
    // 2 cups of flour is about 251 g against 1000 g on hand.
    expect(match.canCook).toBe(true);
  });

  // The rule the whole method rests on. An ingredient measured in sprigs against
  // a recipe calling for grams is not evidence that the cook has it.
  it('reports an uncomparable ingredient as unknown, never as have', () => {
    const match = matchRecipe(
      recipe([{ ingredientId: THYME, ingredientName: 'thyme', quantity: '20', unit: GRAM }]),
      new Map([[THYME, balance('3', CUP)]]), // no density
    );
    expect(match.have).toEqual([]);
    expect(match.missing).toEqual([]);
    expect(match.unknown).toHaveLength(1);
    expect(match.unknown[0].reason).toBe(ConversionFailure.NO_DENSITY);
  });

  it('will not claim a recipe is cookable while anything is unknown', () => {
    const match = matchRecipe(
      recipe([
        { lineId: 1 },
        { ingredientId: THYME, ingredientName: 'thyme', quantity: '20', unit: GRAM },
      ]),
      new Map([
        [FLOUR, balance('1000')],
        [THYME, balance('3', CUP)],
      ]),
    );
    expect(match.have).toHaveLength(1);
    expect(match.unknown).toHaveLength(1);
    expect(match.canCook).toBe(false);
  });

  // Distinct from NO_DENSITY: this one means the *caller* forgot the physicals,
  // which is a bug in the service rather than missing catalog data.
  it('distinguishes physicals never being supplied', () => {
    const match = matchRecipe(
      recipe([{ ingredientId: THYME, ingredientName: 'thyme', quantity: '20', unit: GRAM }]),
      new Map([[THYME, { total: new Decimal('3'), unit: CUP }]]),
    );
    expect(match.unknown[0].reason).toBe(ConversionFailure.NO_INGREDIENT);
  });

  it('names the missing piece weight for a count comparison', () => {
    const match = matchRecipe(
      recipe([{ ingredientId: EGG, ingredientName: 'egg', quantity: '100', unit: GRAM }]),
      new Map([[EGG, balance('6', EACH)]]),
    );
    expect(match.unknown[0].reason).toBe(ConversionFailure.NO_PIECE_WEIGHT);
  });

  it('scales requirements to the target servings', () => {
    const match = matchRecipe(recipe([{}], 4), new Map([[FLOUR, balance('1000')]]), 8);
    expect(match.servings).toBe(8);
    expect(match.have[0].need).toBe('1000');
    expect(match.canCook).toBe(true);
  });

  it('can turn a cookable recipe uncookable by scaling up', () => {
    const match = matchRecipe(recipe([{}], 4), new Map([[FLOUR, balance('600')]]), 8);
    expect(match.missing[0].shortBy).toBe('400');
  });

  // Checking each line against the same stock separately would pass both and
  // claim a recipe is cookable when it needs twice as much as it has.
  it('sums an ingredient used twice before comparing', () => {
    const twice = recipe([
      { lineId: 1, rawText: '500 g flour', quantity: '500' },
      { lineId: 2, rawText: '300 g flour for dusting', quantity: '300' },
    ]);

    expect(matchRecipe(twice, new Map([[FLOUR, balance('600')]])).canCook).toBe(false);
    expect(matchRecipe(twice, new Map([[FLOUR, balance('800')]])).canCook).toBe(true);
  });

  it('sums repeated lines across different units', () => {
    const twice = recipe([
      { lineId: 1, rawText: '1 kg flour', quantity: '1', unit: KILOGRAM },
      { lineId: 2, rawText: '500 g flour', quantity: '500', unit: GRAM },
    ]);
    const match = matchRecipe(twice, new Map([[FLOUR, balance('1400')]]));
    expect(match.missing[0].shortBy).toBe('100');
  });

  it('ignores optional, unresolved and unquantified lines', () => {
    const match = matchRecipe(
      recipe([
        { lineId: 1 },
        { lineId: 2, optional: true },
        { lineId: 3, ingredientId: null },
        { lineId: 4, quantity: null },
        { lineId: 5, unit: null },
      ]),
      new Map([[FLOUR, balance('1000')]]),
    );
    expect(match.requiredCount).toBe(1);
    expect(match.ignoredCount).toBe(4);
  });

  // Scoring 1 would read as "you have everything", which is not what "we could
  // not check anything" means.
  it('scores a recipe with nothing checkable as zero', () => {
    const match = matchRecipe(recipe([{ ingredientId: null }]), new Map());
    expect(match.score).toBe(0);
    expect(match.canCook).toBe(false);
  });
});

describe('rankMatches', () => {
  const flourOnly = { ...recipe([{}]), id: 1, title: 'Flour Only' };
  const twoThings = {
    ...recipe([
      { lineId: 1 },
      { lineId: 2, ingredientId: EGG, ingredientName: 'egg', quantity: '2', unit: EACH },
    ]),
    id: 2,
    title: 'Two Things',
  };

  it('puts recipes you can cook first', () => {
    const ranked = rankMatches(
      [twoThings, flourOnly],
      new Map([[FLOUR, balance('1000')]]),
    );
    expect(ranked.map((m) => m.title)).toEqual(['Flour Only', 'Two Things']);
  });

  it('filters by how many ingredients are missing', () => {
    const ranked = rankMatches([twoThings, flourOnly], new Map([[FLOUR, balance('1000')]]), {
      missingMax: 0,
    });
    expect(ranked.map((m) => m.title)).toEqual(['Flour Only']);
  });

  // A recipe one ingredient short is more useful to see than one we simply
  // could not check.
  it('prefers a knowable shortfall over an unknown', () => {
    const unknownOne = {
      ...recipe([
        { ingredientId: THYME, ingredientName: 'thyme', quantity: '20', unit: GRAM },
      ]),
      id: 3,
      title: 'Unknown',
    };
    const shortOne = { ...recipe([{}]), id: 4, title: 'Short' };

    const ranked = rankMatches(
      [unknownOne, shortOne],
      new Map([
        [THYME, balance('3', CUP)],
        [FLOUR, balance('100')],
      ]),
    );
    expect(ranked[0].title).toBe('Unknown');
    expect(ranked[0].missing).toHaveLength(0);
    expect(ranked[1].missing).toHaveLength(1);
  });

  it('leaves out recipes with nothing to check', () => {
    const nothing = { ...recipe([{ ingredientId: null }]), id: 5, title: 'Nothing' };
    expect(rankMatches([nothing], new Map())).toEqual([]);
  });

  it('breaks ties on title so the order is stable', () => {
    const b = { ...recipe([{}]), id: 6, title: 'Bravo' };
    const a = { ...recipe([{}]), id: 7, title: 'Alpha' };
    const ranked = rankMatches([b, a], new Map([[FLOUR, balance('1000')]]));
    expect(ranked.map((m) => m.title)).toEqual(['Alpha', 'Bravo']);
  });
});
