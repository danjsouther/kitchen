import Decimal from 'decimal.js';
import { ConversionFailure, ItemSource, UnitKind, type UnitDef } from '@kitchen/shared-types';

import {
  estimatePrice,
  generateProposal,
  type DemandLine,
  type IngredientInfo,
} from './shopping-generation';

const GRAM: UnitDef = { id: 1, name: 'gram', kind: UnitKind.MASS, toBaseFactor: '1' };
const KILOGRAM: UnitDef = { id: 2, name: 'kilogram', kind: UnitKind.MASS, toBaseFactor: '1000' };
const CUP: UnitDef = { id: 3, name: 'cup', kind: UnitKind.VOLUME, toBaseFactor: '236.5882365' };
const EACH: UnitDef = { id: 4, name: 'each', kind: UnitKind.COUNT, toBaseFactor: '1' };

const FLOUR = 10;
const EGG = 11;
const THYME = 12;

const DAY = new Date('2026-08-03T00:00:00Z');

function demand(overrides: Partial<DemandLine> = {}): DemandLine {
  return {
    plannedMealId: 1,
    recipeId: 100,
    recipeTitle: 'Bread',
    date: DAY,
    ingredientId: FLOUR,
    ingredientName: 'flour',
    rawText: '500 g flour',
    quantity: '500',
    unit: GRAM,
    ...overrides,
  };
}

function info(overrides: Partial<IngredientInfo> = {}): IngredientInfo {
  return { name: 'flour', categoryId: 1, categorySortOrder: 10, physicals: {}, ...overrides };
}

const CATALOG = new Map<number, IngredientInfo>([
  [FLOUR, info()],
  [EGG, info({ name: 'egg', categoryId: 2, categorySortOrder: 5 })],
  [THYME, info({ name: 'thyme', categoryId: 3, categorySortOrder: 1 })],
]);

function generate(overrides: Partial<Parameters<typeof generateProposal>[0]> = {}) {
  return generateProposal({
    demand: [],
    pars: [],
    balances: new Map(),
    ingredients: CATALOG,
    ...overrides,
  });
}

describe('generateProposal — demand', () => {
  it('proposes buying what the plan needs and the pantry lacks', () => {
    const items = generate({ demand: [demand()] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      ingredientId: FLOUR,
      quantity: '500',
      source: ItemSource.RECIPE,
      onHand: '0',
    });
  });

  it('subtracts what is already in the pantry', () => {
    const items = generate({
      demand: [demand()],
      balances: new Map([[FLOUR, { total: new Decimal('200'), unit: GRAM }]]),
    });
    expect(items[0]).toMatchObject({ quantity: '300', onHand: '200' });
  });

  it('leaves an ingredient off entirely when there is enough already', () => {
    const items = generate({
      demand: [demand()],
      balances: new Map([[FLOUR, { total: new Decimal('900'), unit: GRAM }]]),
    });
    expect(items).toEqual([]);
  });

  it('converts the pantry balance before subtracting', () => {
    const items = generate({
      demand: [demand()],
      balances: new Map([[FLOUR, { total: new Decimal('0.3'), unit: KILOGRAM }]]),
    });
    expect(items[0]).toMatchObject({ quantity: '200', onHand: '300' });
  });

  it('adds up the same ingredient across several meals', () => {
    const items = generate({
      demand: [
        demand({ plannedMealId: 1, quantity: '500' }),
        demand({ plannedMealId: 2, recipeTitle: 'Pizza', quantity: '300' }),
      ],
    });
    expect(items[0].quantity).toBe('800');
    expect(items[0].forMeals.map((m) => m.recipeTitle)).toEqual(['Bread', 'Pizza']);
  });

  it('folds mixed units into the ingredient default unit', () => {
    const items = generate({
      demand: [
        demand({ quantity: '500', unit: GRAM }),
        demand({ plannedMealId: 2, quantity: '1', unit: KILOGRAM }),
      ],
      ingredients: new Map([[FLOUR, info({ defaultUnit: KILOGRAM })]]),
    });
    expect(items[0]).toMatchObject({ quantity: '1.5', unit: KILOGRAM });
  });

  // "2 kg beef + 3 sprigs thyme" cannot become one number, and pretending
  // otherwise is exactly what this codebase refuses to do.
  it('keeps a line that will not fold in on its own row, and says why', () => {
    const items = generate({
      demand: [
        demand({ ingredientId: THYME, ingredientName: 'thyme', quantity: '20', unit: GRAM }),
        demand({
          plannedMealId: 2,
          ingredientId: THYME,
          ingredientName: 'thyme',
          quantity: '3',
          unit: CUP,
        }),
      ],
    });

    expect(items).toHaveLength(2);
    const stray = items.find((item) => item.unconvertible)!;
    expect(stray).toMatchObject({ quantity: '3', reason: ConversionFailure.NO_DENSITY });
    expect(items.find((item) => !item.unconvertible)?.quantity).toBe('20');
  });

  // Over-buying costs a shelf; arriving at the stove without an ingredient costs
  // a meal. When stock cannot be counted, buy the lot.
  it('does not subtract a balance it cannot convert, and flags the gap', () => {
    const items = generate({
      demand: [demand({ ingredientId: THYME, ingredientName: 'thyme', quantity: '20' })],
      balances: new Map([[THYME, { total: new Decimal('3'), unit: CUP }]]),
    });
    expect(items[0]).toMatchObject({ quantity: '20', onHand: null });
  });
});

describe('generateProposal — par levels', () => {
  const pars = [{ ingredientId: EGG, minQuantity: '12', unit: EACH }];

  it('tops an ingredient back up to its par', () => {
    const items = generate({
      pars,
      balances: new Map([[EGG, { total: new Decimal('4'), unit: EACH }]]),
    });
    expect(items[0]).toMatchObject({
      ingredientId: EGG,
      quantity: '8',
      source: ItemSource.PAR,
    });
  });

  it('buys the whole par when there is none at all', () => {
    expect(generate({ pars })[0].quantity).toBe('12');
  });

  it('leaves an ingredient at or above par alone', () => {
    const items = generate({
      pars,
      balances: new Map([[EGG, { total: new Decimal('12'), unit: EACH }]]),
    });
    expect(items).toEqual([]);
  });

  // Adding the par on top of what the plan already asks for would buy it twice.
  it('does not add a par for something the plan already covers', () => {
    const items = generate({
      demand: [demand({ ingredientId: EGG, ingredientName: 'egg', quantity: '6', unit: EACH })],
      pars,
    });
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe(ItemSource.RECIPE);
  });

  // Claiming a shortfall we cannot measure is a guess in the expensive
  // direction, and the pantry screen already reports this case as unknown.
  it('stays quiet about a par it cannot compare', () => {
    const items = generate({
      pars: [{ ingredientId: THYME, minQuantity: '50', unit: GRAM }],
      balances: new Map([[THYME, { total: new Decimal('3'), unit: CUP }]]),
    });
    expect(items).toEqual([]);
  });
});

describe('generateProposal — store order', () => {
  it('sorts by the ingredient category by default', () => {
    const items = generate({
      demand: [
        demand(),
        demand({ plannedMealId: 2, ingredientId: EGG, ingredientName: 'egg', quantity: '2', unit: EACH }),
      ],
    });
    // egg's category sorts at 5, flour's at 10.
    expect(items.map((i) => i.ingredientName)).toEqual(['egg', 'flour']);
  });

  it('lets a store aisle order override the category default', () => {
    const items = generate({
      demand: [
        demand(),
        demand({ plannedMealId: 2, ingredientId: EGG, ingredientName: 'egg', quantity: '2', unit: EACH }),
      ],
      // At this store the flour aisle comes before the eggs.
      aisleOrder: new Map([
        [1, 1],
        [2, 9],
      ]),
    });
    expect(items.map((i) => i.ingredientName)).toEqual(['flour', 'egg']);
  });

  it('puts uncategorised items last rather than first', () => {
    const items = generate({
      demand: [
        demand({ ingredientId: 99, ingredientName: 'mystery' }),
        demand({ plannedMealId: 2, ingredientId: EGG, ingredientName: 'egg', quantity: '2', unit: EACH }),
      ],
    });
    expect(items.map((i) => i.ingredientName)).toEqual(['egg', 'mystery']);
  });
});

describe('estimatePrice', () => {
  const priced = info({
    lastPrice: { pricePerUnit: new Decimal('0.004'), unit: GRAM, brand: 'King Arthur' },
  });

  it('multiplies the last price by the amount being bought', () => {
    expect(estimatePrice(new Decimal('500'), GRAM, priced)).toBe('2');
  });

  it('converts the past price into the unit being bought now', () => {
    expect(estimatePrice(new Decimal('1'), KILOGRAM, priced)).toBe('4');
  });

  it('rounds to the nearest cent', () => {
    const odd = info({
      lastPrice: { pricePerUnit: new Decimal('0.00333'), unit: GRAM, brand: null },
    });
    expect(estimatePrice(new Decimal('100'), GRAM, odd)).toBe('0.33');
  });

  // A running total built on a guessed conversion is worse than one with a
  // visible gap in it.
  it('declines to guess when the past price cannot be converted', () => {
    const volumePriced = info({
      lastPrice: { pricePerUnit: new Decimal('2'), unit: CUP, brand: null },
    });
    expect(estimatePrice(new Decimal('500'), GRAM, volumePriced)).toBeNull();
  });

  it('has nothing to say without a price history', () => {
    expect(estimatePrice(new Decimal('500'), GRAM, info())).toBeNull();
    expect(estimatePrice(new Decimal('500'), GRAM, undefined)).toBeNull();
  });

  it('carries the brand through onto the proposal', () => {
    const items = generateProposal({
      demand: [demand()],
      pars: [],
      balances: new Map(),
      ingredients: new Map([[FLOUR, priced]]),
    });
    expect(items[0]).toMatchObject({ brand: 'King Arthur', estimatedPrice: '2' });
  });
});
