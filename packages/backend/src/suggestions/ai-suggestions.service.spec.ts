import { ConflictException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { UnitKind, type UnitDef } from '@kitchen/shared-types';

import { AiSuggestionsService, reconcileStale, summariseMatch } from './ai-suggestions.service';
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
  const parser = {
    resolveGeneratedIngredients: jest.fn().mockImplementation((lines: unknown[]) =>
      Promise.resolve(
        lines.map((generatedLine) => ({
          ...(generatedLine as object),
          ingredientId: null,
          match: { kind: 'NONE', confidence: 0, best: null, alternatives: [] },
          needsReview: true,
        })),
      ),
    ),
  };

  const db = {
    aiSuggestion: {
      create: jest.fn().mockResolvedValue(undefined),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({
        _count: 0,
        _sum: { inputTokens: null, outputTokens: null, cacheReadTokens: null },
      }),
    },
  };

  const service = new AiSuggestionsService(
    suggestions as never,
    aiConfig as never,
    parser as never,
    db as never,
  );
  return { service, suggestions, aiConfig, parser, db };
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

  // A network/auth failure never reaches a response, so there is no usage to
  // report — unlike a refusal or an unparseable response, it gets no row.
  it('persists nothing when the API call itself fails', async () => {
    const { service, db } = makeService({
      apiKey: 'sk-test',
      model: 'claude-opus-5',
      effort: 'low',
    });

    await service.suggest({});

    expect(db.aiSuggestion.create).not.toHaveBeenCalled();
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

describe('resolving a GENERATED suggestion body', () => {
  /** `resolveBodies` is private; exercised through the same path the service uses. */
  function resolveBodies(parsed: unknown) {
    const { service, parser } = makeService(null);
    return (
      service as unknown as {
        resolveBodies: (p: unknown) => Promise<{ suggestions: unknown[] }>;
      }
    ).resolveBodies(parsed).then((result) => ({ result, parser }));
  }

  it('resolves a GENERATED suggestion body against the catalog', async () => {
    const { result, parser } = await resolveBodies({
      summary: 's',
      suggestions: [
        {
          kind: 'GENERATED',
          recipeId: null,
          title: 'Improvised soup',
          body: {
            servings: 2,
            ingredients: [
              { quantity: '1', unit: 'cup', name: 'broth', preparation: null },
            ],
            steps: ['Heat the broth.'],
          },
        },
      ],
    });

    expect(parser.resolveGeneratedIngredients).toHaveBeenCalledWith([
      { quantity: '1', unit: 'cup', name: 'broth', preparation: null },
    ]);
    expect(result.suggestions[0]).toMatchObject({
      body: {
        servings: 2,
        ingredients: [
          expect.objectContaining({ name: 'broth', ingredientId: null, needsReview: true }),
        ],
        steps: [{ text: 'Heat the broth.' }],
      },
    });
  });

  it('does not resolve or touch a null body', async () => {
    const { result, parser } = await resolveBodies({
      summary: 's',
      suggestions: [{ kind: 'SAVED_RECIPE', recipeId: 7, title: 'Bread', body: null }],
    });

    expect(parser.resolveGeneratedIngredients).not.toHaveBeenCalled();
    expect(result.suggestions[0]).toMatchObject({ body: null });
  });

  it('leaves a body-less GENERATED suggestion alone, e.g. one reconciled from a dead recipeId', async () => {
    const { result, parser } = await resolveBodies({
      summary: 's',
      suggestions: [{ kind: 'GENERATED', recipeId: null, title: 'Ghost', body: null }],
    });

    expect(parser.resolveGeneratedIngredients).not.toHaveBeenCalled();
    expect(result.suggestions[0]).toMatchObject({ body: null });
  });
});

describe('persisting a run', () => {
  const USAGE = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 };

  /** `persist` is private; exercised through the same path the service uses. */
  function persist(run: unknown) {
    const { service, db } = makeService(null);
    return (service as unknown as { persist: (r: unknown) => Promise<void> })
      .persist(run)
      .then(() => db);
  }

  it('stores a successful run with its result and usage', async () => {
    const result = { summary: 's', suggestions: [] };
    const db = await persist({ ok: true, reason: null, result, usage: USAGE });

    expect(db.aiSuggestion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ok: true,
        reason: null,
        result,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
      }),
    });
  });

  // Still cost tokens, so it is still worth a row — with real usage, not zeros.
  it('stores a refusal with no result but real usage', async () => {
    const db = await persist({
      ok: false,
      reason: 'The model declined to answer that request.',
      result: null,
      usage: USAGE,
    });

    expect(db.aiSuggestion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ok: false,
        reason: 'The model declined to answer that request.',
        result: undefined,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
      }),
    });
  });
});

describe('AiSuggestionsService.history', () => {
  const USAGE_ROW = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1 };

  it('returns rows newest-first with usage, capped and offset as asked', async () => {
    const { service, db } = makeService(null);
    db.aiSuggestion.count.mockResolvedValue(3);
    db.aiSuggestion.findMany.mockResolvedValue([
      { id: 2, createdOn: new Date('2026-08-23'), ok: true, reason: null, result: { summary: 's', suggestions: [] }, ...USAGE_ROW },
    ]);

    const page = await service.history(10, 5);

    expect(db.aiSuggestion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdOn: 'desc' }, take: 10, skip: 5 }),
    );
    expect(page).toMatchObject({
      total: 3,
      limit: 10,
      offset: 5,
      items: [{ id: 2, ok: true, usage: USAGE_ROW }],
    });
  });

  // A limit request cannot be used to pull the whole table in one page.
  it('caps limit at 50 regardless of what was asked', async () => {
    const { service, db } = makeService(null);
    await service.history(500, 0);
    expect(db.aiSuggestion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
  });

  // A recipe a past suggestion pointed at can be archived after the fact —
  // reconcile() only ever ran once, at generation time.
  it('nulls a recipeId that is no longer active, without relabelling the kind', async () => {
    const { service, suggestions, db } = makeService(null, { recipes: [{ id: 7, title: 'Bread' }] });
    suggestions.activeRecipes.mockResolvedValue([{ id: 7, title: 'Bread' }]);
    db.aiSuggestion.count.mockResolvedValue(1);
    db.aiSuggestion.findMany.mockResolvedValue([
      {
        id: 1,
        createdOn: new Date('2026-08-23'),
        ok: true,
        reason: null,
        result: {
          summary: 's',
          suggestions: [{ kind: 'SAVED_RECIPE', recipeId: 999, title: 'Gone' }],
        },
        ...USAGE_ROW,
      },
    ]);

    const page = await service.history();

    expect(page.items[0].ai?.suggestions[0]).toMatchObject({
      kind: 'SAVED_RECIPE',
      recipeId: null,
    });
  });

  it('leaves ai null for a row with no result', async () => {
    const { service, db } = makeService(null);
    db.aiSuggestion.count.mockResolvedValue(1);
    db.aiSuggestion.findMany.mockResolvedValue([
      { id: 1, createdOn: new Date(), ok: false, reason: 'nope', result: null, ...USAGE_ROW },
    ]);

    const page = await service.history();

    expect(page.items[0].ai).toBeNull();
    expect(page.items[0].reason).toBe('nope');
  });
});

describe('AiSuggestionsService.usageSummary', () => {
  it('sums usage across every persisted run', async () => {
    const { service, db } = makeService(null);
    db.aiSuggestion.aggregate.mockResolvedValue({
      _count: 4,
      _sum: { inputTokens: 400, outputTokens: 80, cacheReadTokens: 20 },
    });

    expect(await service.usageSummary()).toEqual({
      runCount: 4,
      inputTokens: 400,
      outputTokens: 80,
      cacheReadTokens: 20,
    });
  });

  // No runs yet: Prisma's aggregate returns nulls, not zeros.
  it('reads zero rather than null when nothing has been persisted yet', async () => {
    const { service } = makeService(null);
    expect(await service.usageSummary()).toEqual({
      runCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    });
  });
});

describe('reconcileStale', () => {
  it('nulls a recipeId that has gone stale', () => {
    const result = reconcileStale(
      { summary: 's', suggestions: [{ kind: 'SUBSTITUTION', recipeId: 5, title: 'Gone' } as never] },
      new Set([1, 2]),
    );
    expect(result.suggestions[0]).toMatchObject({ kind: 'SUBSTITUTION', recipeId: null });
  });

  it('leaves an active recipeId alone', () => {
    const result = reconcileStale(
      { summary: 's', suggestions: [{ kind: 'SAVED_RECIPE', recipeId: 7, title: 'Bread' } as never] },
      new Set([7]),
    );
    expect(result.suggestions[0]).toMatchObject({ recipeId: 7 });
  });

  it('leaves a GENERATED suggestion (recipeId already null) alone', () => {
    const result = reconcileStale(
      { summary: 's', suggestions: [{ kind: 'GENERATED', recipeId: null, title: 'Soup' } as never] },
      new Set([]),
    );
    expect(result.suggestions[0]).toMatchObject({ recipeId: null });
  });
});
