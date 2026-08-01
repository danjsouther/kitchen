import { ConflictException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { UnitKind, type UnitDef } from '@kitchen/shared-types';

import { AiSuggestionsService, summariseMatch } from './ai-suggestions.service';
import type { RecipeMatch } from './pantry-match';

const GRAM: UnitDef = { id: 1, name: 'gram', kind: UnitKind.MASS, toBaseFactor: '1' };

function match(overrides: Partial<RecipeMatch> = {}): RecipeMatch {
  return {
    recipeId: 1,
    title: 'Pancakes',
    slug: 'pancakes',
    servings: 4,
    recipeServings: 4,
    have: [],
    missing: [],
    unknown: [],
    ignoredCount: 0,
    requiredCount: 1,
    score: 1,
    canCook: true,
    ...overrides,
  };
}

function line(name: string) {
  return {
    ingredientId: 1,
    ingredientName: name,
    rawText: `500 g ${name}`,
    need: '500',
    needUnit: GRAM,
    onHand: '1000',
    shortBy: null,
  };
}

/** Builds the service with stubbed collaborators — no network, ever. */
function makeService(config: unknown, data: Partial<Record<string, unknown>> = {}) {
  const suggestions = {
    pantryBalances: jest
      .fn()
      .mockResolvedValue(
        data.balances ?? new Map([[1, { total: new Decimal('1000'), unit: GRAM }]]),
      ),
    activeRecipes: jest.fn().mockResolvedValue(data.recipes ?? []),
    expiringSoon: jest.fn().mockResolvedValue(data.expiring ?? []),
  };
  const aiConfig = { resolveKey: jest.fn().mockResolvedValue(config) };

  const service = new AiSuggestionsService(suggestions as never, aiConfig as never);
  return { service, suggestions, aiConfig };
}

describe('AiSuggestionsService.suggest', () => {
  // Not an error state: a household that has not opted in is the normal case,
  // and the UI hides the tab rather than showing a failure.
  it('refuses with a conflict when no key is configured', async () => {
    const { service } = makeService(null);
    await expect(service.suggest({})).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not touch the pantry when there is no key to use', async () => {
    const { service, suggestions } = makeService(null);
    await service.suggest({}).catch(() => undefined);
    expect(suggestions.pantryBalances).not.toHaveBeenCalled();
  });

  // The whole feature enhances a screen that already works. Taking that screen
  // down because a third party had a bad minute would be a poor trade.
  it('falls back to the deterministic result when the API throws', async () => {
    const { service } = makeService({
      apiKey: 'sk-test',
      model: 'claude-opus-5',
      effort: 'low',
    });

    const result = await service.suggest({});

    expect(result.ok).toBe(false);
    expect(result.ai).toBeNull();
    expect(result).toHaveProperty('reason');
    expect(Array.isArray(result.deterministic)).toBe(true);
  });

  it('never puts the API key in the failure response', async () => {
    const { service } = makeService({
      apiKey: 'sk-ant-secret-value',
      model: 'claude-opus-5',
      effort: 'low',
    });

    const result = await service.suggest({});

    expect(JSON.stringify(result)).not.toContain('sk-ant-secret-value');
  });

  it('still returns the deterministic matches on failure', async () => {
    const recipes = [
      {
        id: 7,
        title: 'Bread',
        slug: 'bread',
        servings: 2,
        lines: [
          {
            lineId: 1,
            ingredientId: 1,
            ingredientName: 'flour',
            rawText: '500 g flour',
            quantity: '500',
            unit: GRAM,
            optional: false,
          },
        ],
      },
    ];
    const { service } = makeService(
      { apiKey: 'sk-test', model: 'claude-opus-5', effort: 'low' },
      { recipes },
    );

    const result = await service.suggest({});

    expect(result.deterministic).toHaveLength(1);
    expect(result.deterministic[0].canCook).toBe(true);
  });
});

describe('summariseMatch', () => {
  // The compression IS the grounding rule: quantities the model has no business
  // restating simply are not in what it receives.
  it('sends names and flags, never quantities', () => {
    const summary = summariseMatch(
      match({ have: [line('flour')], missing: [line('sugar')] }),
    );

    expect(summary).toEqual({
      recipeId: 1,
      title: 'Pancakes',
      canCookNow: true,
      have: ['flour'],
      short: ['sugar'],
      couldNotCheck: [],
    });
    expect(JSON.stringify(summary)).not.toContain('500');
    expect(JSON.stringify(summary)).not.toContain('1000');
  });

  it('carries the unknown bucket through as its own category', () => {
    const summary = summariseMatch(match({ unknown: [line('thyme')], canCook: false }));
    expect(summary.couldNotCheck).toEqual(['thyme']);
    expect(summary.canCookNow).toBe(false);
  });

  it('falls back to the raw text when a line has no catalog name', () => {
    const anonymous = { ...line('x'), ingredientName: null, rawText: 'a splash of oil' };
    expect(summariseMatch(match({ have: [anonymous] })).have).toEqual([
      'a splash of oil',
    ]);
  });
});

describe('recipe id reconciliation', () => {
  const recipes = [{ id: 7, title: 'Bread' }];

  /** `reconcile` is private; exercised through the same path the service uses. */
  function reconcile(parsed: unknown) {
    const { service } = makeService(null);
    return (
      service as unknown as {
        reconcile: (p: unknown, r: unknown) => { suggestions: unknown[] };
      }
    ).reconcile(parsed, recipes);
  }

  // Structured output guarantees the response's shape, not that the ids inside
  // it point at anything real — an invented id would be a dead link in the UI.
  it('downgrades a suggestion naming a recipe that does not exist', () => {
    const result = reconcile({
      summary: 's',
      suggestions: [{ kind: 'SAVED_RECIPE', recipeId: 999, title: 'Ghost' }],
    });

    expect(result.suggestions[0]).toMatchObject({ recipeId: null, kind: 'GENERATED' });
  });

  it('leaves a real recipe id alone', () => {
    const result = reconcile({
      summary: 's',
      suggestions: [{ kind: 'SAVED_RECIPE', recipeId: 7, title: 'Bread' }],
    });

    expect(result.suggestions[0]).toMatchObject({ recipeId: 7, kind: 'SAVED_RECIPE' });
  });

  it('leaves a genuinely generated suggestion alone', () => {
    const result = reconcile({
      summary: 's',
      suggestions: [{ kind: 'GENERATED', recipeId: null, title: 'Improvised soup' }],
    });

    expect(result.suggestions[0]).toMatchObject({ recipeId: null, kind: 'GENERATED' });
  });
});
