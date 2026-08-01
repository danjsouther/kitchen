import Decimal from 'decimal.js';
import { UnitKind } from '@kitchen/shared-types';

import { SkipReason, mergeWithdrawals, planCook, type CookLine } from './cook-plan';

const GRAM = { id: 1, name: 'gram', kind: UnitKind.MASS, toBaseFactor: '1' };
const CUP = { id: 3, name: 'cup', kind: UnitKind.VOLUME, toBaseFactor: '236.5882365' };

function line(overrides: Partial<CookLine> = {}): CookLine {
  return {
    id: 1,
    rawText: '500 g flour',
    ingredientId: 10,
    quantity: '500',
    unit: GRAM,
    optional: false,
    ...overrides,
  };
}

function reasons(skipped: Array<{ reason: string }>) {
  return skipped.map((s) => s.reason);
}

describe('planCook', () => {
  it('passes a resolved line through unchanged when servings match', () => {
    const plan = planCook([line()], 4, 4);
    expect(plan.withdrawals).toHaveLength(1);
    expect(plan.withdrawals[0].quantity.toString()).toBe('500');
    expect(plan.factor.toString()).toBe('1');
  });

  it('scales by the serving ratio', () => {
    const plan = planCook([line()], 4, 6);
    expect(plan.withdrawals[0].quantity.toString()).toBe('750');
    expect(plan.factor.toString()).toBe('1.5');
  });

  it('scales down as readily as up', () => {
    const plan = planCook([line()], 4, 2);
    expect(plan.withdrawals[0].quantity.toString()).toBe('250');
  });

  it('keeps a repeating ratio exact rather than rounding it', () => {
    const plan = planCook([line({ quantity: '100' })], 3, 1);
    expect(plan.withdrawals[0].quantity.toFixed(6)).toBe('33.333333');
  });

  // "Salt and pepper to taste" has no catalog ingredient and no amount. It still
  // has to be reported, or a cook silently ignores part of its own recipe.
  it('reports an unresolved line rather than dropping it', () => {
    const plan = planCook([line({ ingredientId: null, rawText: 'salt to taste' })], 4, 4);
    expect(plan.withdrawals).toEqual([]);
    expect(plan.skipped).toEqual([
      { lineId: 1, rawText: 'salt to taste', reason: SkipReason.UNRESOLVED },
    ]);
  });

  it('reports a resolved line with no quantity', () => {
    expect(reasons(planCook([line({ quantity: null })], 4, 4).skipped)).toEqual([
      SkipReason.NO_QUANTITY,
    ]);
  });

  it('reports a quantified line with no unit', () => {
    expect(reasons(planCook([line({ unit: null })], 4, 4).skipped)).toEqual([
      SkipReason.NO_UNIT,
    ]);
  });

  it('reports a zero-quantity line as unquantified', () => {
    expect(reasons(planCook([line({ quantity: '0' })], 4, 4).skipped)).toEqual([
      SkipReason.NO_QUANTITY,
    ]);
  });

  // Over-deducting is worse than under-deducting: it sends someone shopping for
  // something still on the shelf.
  it('does not deduct optional lines', () => {
    const plan = planCook([line({ optional: true })], 4, 4);
    expect(plan.withdrawals).toEqual([]);
    expect(reasons(plan.skipped)).toEqual([SkipReason.OPTIONAL]);
  });

  it('checks optional before anything else, so the reason is the useful one', () => {
    const plan = planCook([line({ optional: true, ingredientId: null })], 4, 4);
    expect(reasons(plan.skipped)).toEqual([SkipReason.OPTIONAL]);
  });

  it('handles a real mixed recipe', () => {
    const plan = planCook(
      [
        line({ id: 1, quantity: '500' }),
        line({ id: 2, rawText: 'salt to taste', ingredientId: null, quantity: null }),
        line({ id: 3, rawText: 'parsley', optional: true }),
        line({ id: 4, rawText: '2 cups milk', quantity: '2', unit: CUP, ingredientId: 11 }),
      ],
      4,
      8,
    );

    expect(plan.withdrawals.map((w) => [w.lineId, w.quantity.toString()])).toEqual([
      [1, '1000'],
      [4, '4'],
    ]);
    expect(plan.skipped.map((s) => s.lineId)).toEqual([2, 3]);
  });

  it('treats a nonsensical recipe serving count as a factor of one', () => {
    const plan = planCook([line()], 0, 6);
    expect(plan.withdrawals[0].quantity.toString()).toBe('500');
  });
});

describe('mergeWithdrawals', () => {
  const flourDough = {
    lineId: 1,
    rawText: '1 cup flour',
    ingredientId: 10,
    quantity: new Decimal('1'),
    unit: CUP,
  };
  const flourDusting = {
    lineId: 2,
    rawText: '0.5 cup flour',
    ingredientId: 10,
    quantity: new Decimal('0.5'),
    unit: CUP,
  };
  const milk = {
    lineId: 3,
    rawText: '2 cups milk',
    ingredientId: 11,
    quantity: new Decimal('2'),
    unit: CUP,
  };

  // Deducting the same ingredient twice walks the lots twice, and the second
  // pass can report a shortfall on stock the first pass already took.
  it('adds up the same ingredient in the same unit', () => {
    const merged = mergeWithdrawals([flourDough, flourDusting]);
    expect(merged).toHaveLength(1);
    expect(merged[0].quantity.toString()).toBe('1.5');
  });

  it('keeps the text of both lines so the report still explains itself', () => {
    expect(mergeWithdrawals([flourDough, flourDusting])[0].rawText).toBe(
      '1 cup flour; 0.5 cup flour',
    );
  });

  it('leaves different ingredients alone', () => {
    expect(mergeWithdrawals([flourDough, milk])).toHaveLength(2);
  });

  // Merging across units would need the ingredient's density, and a conversion
  // failure here has nowhere honest to go — the deduction step handles it.
  it('leaves the same ingredient in different units separate', () => {
    const flourGrams = { ...flourDough, lineId: 4, unit: GRAM };
    expect(mergeWithdrawals([flourDough, flourGrams])).toHaveLength(2);
  });

  it('does not mutate the input withdrawals', () => {
    const original = new Decimal(flourDough.quantity);
    mergeWithdrawals([flourDough, flourDusting]);
    expect(flourDough.quantity.toString()).toBe(original.toString());
  });

  it('handles an empty list', () => {
    expect(mergeWithdrawals([])).toEqual([]);
  });
});
