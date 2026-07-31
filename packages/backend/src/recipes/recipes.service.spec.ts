import { BadRequestException, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';

import { RecipesService, buildRecipeWhere } from './recipes.service';
import type { CreateRecipeDto } from './dto/recipe.dto';

const CUP = { id: 1, name: 'cup', plural: 'cups', abbrev: null, kind: 'VOLUME', toBaseFactor: '236.5882365' };
const GRAM = { id: 2, name: 'gram', plural: 'grams', abbrev: 'g', kind: 'MASS', toBaseFactor: '1' };

/**
 * A hand-rolled stand-in for the scoped Prisma client. Only the calls the
 * service actually makes are implemented — anything else throwing is the point,
 * since a silent `undefined` would let a broken query pass the test.
 */
function makeDb(overrides: Record<string, unknown> = {}) {
  return {
    recipe: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 1, ...data, tags: [], ingredients: [], steps: [] }),
      ),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 1, ...data, tags: [], ingredients: [], steps: [] }),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    tag: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 100 }),
    },
    ...overrides,
  };
}

function makeService(db = makeDb()) {
  const units = { resolve: jest.fn().mockResolvedValue(new Map()) };
  const ingredients = { resolve: jest.fn().mockResolvedValue(new Map()) };
  const service = new RecipesService(db as never, units as never, ingredients as never);
  return { service, db, units, ingredients };
}

/** The `data` a write was called with, typed loosely enough to assert on. */
type WrittenData = Record<string, { create?: Record<string, unknown>[] } & Record<string, unknown>>;

function writtenData(mock: jest.Mock): WrittenData {
  return mock.mock.calls[0][0].data as WrittenData;
}

function dto(overrides: Partial<CreateRecipeDto> = {}): CreateRecipeDto {
  return {
    title: 'Weeknight Chili',
    servings: 4,
    ingredients: [{ rawText: '2 cups beans', quantity: '2', unitId: 1 }],
    steps: [{ text: 'Simmer.' }],
    ...overrides,
  } as CreateRecipeDto;
}

describe('buildRecipeWhere', () => {
  // Archived recipes are still real rows; the default view just should not be
  // cluttered by things the cook deliberately put away.
  it('hides archived recipes by default', () => {
    expect(buildRecipeWhere({})).toEqual({ AND: [{ archivedOn: null }] });
  });

  it('shows only archived when asked', () => {
    expect(buildRecipeWhere({ status: 'archived' })).toEqual({
      AND: [{ archivedOn: { not: null } }],
    });
  });

  it('applies no archive filter for status=all', () => {
    expect(buildRecipeWhere({ status: 'all' })).toEqual({});
  });

  it('searches title, description and the raw ingredient text', () => {
    const where = buildRecipeWhere({ q: 'anchovy' }) as { AND: Record<string, unknown>[] };
    const search = where.AND[1] as { OR: unknown[] };
    expect(search.OR).toEqual([
      { title: { contains: 'anchovy', mode: 'insensitive' } },
      { description: { contains: 'anchovy', mode: 'insensitive' } },
      { ingredients: { some: { rawText: { contains: 'anchovy', mode: 'insensitive' } } } },
    ]);
  });

  // The client may send a human-typed tag; matching is on the slug so "Quick
  // Dinner" and "quick-dinner" are the same filter.
  it('slugifies the tag filter', () => {
    const where = buildRecipeWhere({ tag: 'Quick Dinner' }) as { AND: unknown[] };
    expect(where.AND[1]).toEqual({ tags: { some: { tag: { slug: 'quick-dinner' } } } });
  });

  it('filters by a catalog ingredient', () => {
    const where = buildRecipeWhere({ ingredientId: 42 }) as { AND: unknown[] };
    expect(where.AND[1]).toEqual({ ingredients: { some: { ingredientId: 42 } } });
  });

  it('combines filters with AND rather than replacing them', () => {
    const where = buildRecipeWhere({ q: 'stew', tag: 'winter' }) as { AND: unknown[] };
    expect(where.AND).toHaveLength(3);
  });
});

describe('RecipesService.create', () => {
  it('numbers ingredients and steps by position', async () => {
    const { service, db } = makeService();
    await service.create(
      dto({
        ingredients: [
          { rawText: 'first', quantity: '1', unitId: 1 },
          { rawText: 'second' },
        ],
        steps: [{ text: 'a' }, { text: 'b' }],
      }),
      7,
    );

    const data = writtenData(db.recipe.create);
    expect(data.ingredients.create?.map((i) => i.sortOrder)).toEqual([0, 1]);
    expect(data.steps.create?.map((s) => s.sortOrder)).toEqual([0, 1]);
  });

  it('derives a slug from the title', async () => {
    const { service, db } = makeService();
    await service.create(dto(), 7);
    expect(writtenData(db.recipe.create).slug).toBe('weeknight-chili');
  });

  it('numbers the slug when the household already has that title', async () => {
    const db = makeDb();
    // 'weeknight-chili' is taken, 'weeknight-chili-2' is free.
    db.recipe.findFirst
      .mockResolvedValueOnce({ id: 9 })
      .mockResolvedValueOnce(null);

    const { service } = makeService(db);
    await service.create(dto(), 7);
    expect(writtenData(db.recipe.create).slug).toBe('weeknight-chili-2');
  });

  // A unit with no number attached is not a quantity — "cups of flour" cannot be
  // scaled, converted or subtracted from the pantry, so it must not be stored as
  // though it could.
  it('rejects a line with a unit but no quantity', async () => {
    const { service } = makeService();
    await expect(
      service.create(dto({ ingredients: [{ rawText: 'cups of flour', unitId: 1 }] }), 7),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('names the offending line in the error', async () => {
    const { service } = makeService();
    await expect(
      service.create(
        dto({
          ingredients: [
            { rawText: 'ok', quantity: '1', unitId: 1 },
            { rawText: 'cups of flour', unitId: 1 },
          ],
        }),
        7,
      ),
    ).rejects.toThrow(/line 2 \("cups of flour"\)/);
  });

  // An unresolved line is a first-class case, not an error: "salt and pepper to
  // taste" has no ingredient, no quantity and no unit, and must still save.
  it('accepts a line with no ingredient, quantity or unit', async () => {
    const { service, db } = makeService();
    await service.create(
      dto({ ingredients: [{ rawText: 'salt and pepper to taste' }] }),
      7,
    );
    expect(writtenData(db.recipe.create).ingredients.create?.[0]).toMatchObject({
      ingredientId: null,
      quantity: null,
      unitId: null,
      rawText: 'salt and pepper to taste',
    });
  });

  it('validates every referenced unit and ingredient before writing', async () => {
    const { service, units, ingredients, db } = makeService();
    await service.create(
      dto({
        ingredients: [
          { rawText: 'a', quantity: '1', unitId: 1, ingredientId: 5 },
          { rawText: 'b', quantity: '2', unitId: 2, ingredientId: 6 },
        ],
      }),
      7,
    );
    expect(units.resolve).toHaveBeenCalledWith([1, 2]);
    expect(ingredients.resolve).toHaveBeenCalledWith([5, 6]);
    expect(db.recipe.create).toHaveBeenCalled();
  });

  it('does not write anything when a referenced id is unknown', async () => {
    const { service, db, units } = makeService();
    units.resolve.mockRejectedValue(new BadRequestException('Unknown unit id: 99.'));
    await expect(service.create(dto(), 7)).rejects.toThrow('Unknown unit id: 99.');
    expect(db.recipe.create).not.toHaveBeenCalled();
  });

  it('reuses an existing tag rather than creating a duplicate', async () => {
    const db = makeDb();
    db.tag.findMany.mockResolvedValue([{ id: 3, slug: 'weeknight' }]);
    const { service } = makeService(db);

    await service.create(dto({ tags: [{ name: 'Weeknight' }] }), 7);

    expect(db.tag.create).not.toHaveBeenCalled();
    expect(writtenData(db.recipe.create).tags.create).toEqual([{ tagId: 3 }]);
  });

  it('treats tags differing only in case as one tag', async () => {
    const db = makeDb();
    const { service } = makeService(db);
    await service.create(dto({ tags: [{ name: 'Vegan' }, { name: 'vegan' }] }), 7);
    expect(db.tag.create).toHaveBeenCalledTimes(1);
  });
});

describe('RecipesService.update', () => {
  it('keeps the existing slug when the title change does not change the slug', async () => {
    const db = makeDb();
    db.recipe.findFirst.mockResolvedValue({ id: 1, title: 'Chili', slug: 'chili' });
    const { service } = makeService(db);

    await service.update(1, { title: 'CHILI' });

    expect(writtenData(db.recipe.update).slug).toBeUndefined();
  });

  it('re-slugs a real rename', async () => {
    const db = makeDb();
    db.recipe.findFirst
      .mockResolvedValueOnce({ id: 1, title: 'Chili', slug: 'chili' })
      .mockResolvedValue(null); // the new slug is free
    const { service } = makeService(db);

    await service.update(1, { title: 'Turkey Chili' });

    expect(writtenData(db.recipe.update).slug).toBe('turkey-chili');
  });

  // Positional sortOrder is why: a merge would need the client to reconcile
  // inserts, deletes and reorders against row ids on every save.
  it('replaces the ingredient list wholesale', async () => {
    const db = makeDb();
    db.recipe.findFirst.mockResolvedValue({ id: 1, title: 'Chili', slug: 'chili' });
    const { service } = makeService(db);

    await service.update(1, { ingredients: [{ rawText: 'only line' }] });

    expect(writtenData(db.recipe.update).ingredients).toEqual({
      deleteMany: {},
      create: [expect.objectContaining({ sortOrder: 0, rawText: 'only line' })],
    });
  });

  it('leaves collections alone when they are not supplied', async () => {
    const db = makeDb();
    db.recipe.findFirst.mockResolvedValue({ id: 1, title: 'Chili', slug: 'chili' });
    const { service } = makeService(db);

    await service.update(1, { servings: 8 });

    const data = writtenData(db.recipe.update);
    expect(data.servings).toBe(8);
    expect(data.ingredients).toBeUndefined();
    expect(data.steps).toBeUndefined();
    expect(data.tags).toBeUndefined();
  });

  it('404s on a recipe this household cannot see', async () => {
    const { service } = makeService();
    await expect(service.update(1, { servings: 8 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('RecipesService.scaled', () => {
  function recipeWith(lines: unknown[]) {
    const db = makeDb();
    db.recipe.findFirst.mockResolvedValue({
      id: 1,
      title: 'Chili',
      servings: 4,
      ingredients: lines,
      steps: [],
      tags: [],
    });
    return makeService(db).service;
  }

  it('scales quantities by the serving ratio', async () => {
    const service = recipeWith([
      { rawText: '2 cups beans', quantity: new Decimal('2'), unit: CUP },
    ]);

    const result = await service.scaled(1, 6);

    expect(result.servings).toBe(6);
    expect(result.originalServings).toBe(4);
    expect(result.ingredients[0].scaled?.quantity).toBe('3');
  });

  it('formats the scaled amount for display without rounding the value', async () => {
    const service = recipeWith([
      { rawText: '1 cup rice', quantity: new Decimal('1'), unit: CUP },
    ]);

    const result = await service.scaled(1, 6);

    // 1 * 6/4 = 1.5 exactly; the display picks the readable fraction.
    expect(result.ingredients[0].scaled?.quantity).toBe('1.5');
    expect(result.ingredients[0].scaled?.display).toBe('1 ½ cups');
  });

  // Scaling always runs from the stored value, so there is no drift from
  // repeatedly scaling an already-scaled number.
  it('gives the same answer whether or not another scaling happened first', async () => {
    const service = recipeWith([
      { rawText: '1 cup', quantity: new Decimal('1'), unit: CUP },
    ]);

    await service.scaled(1, 3);
    const direct = await service.scaled(1, 5);

    expect(direct.ingredients[0].scaled?.quantity).toBe('1.25');
  });

  it('produces a repeating value exactly rather than rounding it away', async () => {
    const service = recipeWith([
      { rawText: '1 cup', quantity: new Decimal('1'), unit: CUP },
    ]);

    const result = await service.scaled(1, 3);

    // 3/4 of a cup, expressed exactly.
    expect(result.ingredients[0].scaled?.quantity).toBe('0.75');
  });

  // "Salt to taste" has no number; scaling must not invent one.
  it('leaves an unquantified line unscaled', async () => {
    const service = recipeWith([
      { rawText: 'salt to taste', quantity: null, unit: null },
    ]);

    const result = await service.scaled(1, 8);

    expect(result.ingredients[0].scaled).toBeNull();
    expect(result.ingredients[0].rawText).toBe('salt to taste');
  });

  it('scales a line with no unit', async () => {
    const service = recipeWith([
      { rawText: '3 eggs', quantity: new Decimal('3'), unit: null },
    ]);

    const result = await service.scaled(1, 8);

    expect(result.ingredients[0].scaled?.quantity).toBe('6');
    expect(result.ingredients[0].scaled?.display).toBe('6');
  });

  it('uses whole grams rather than fractions for mass', async () => {
    const service = recipeWith([
      { rawText: '500 g flour', quantity: new Decimal('500'), unit: GRAM },
    ]);

    const result = await service.scaled(1, 6);

    expect(result.ingredients[0].scaled?.display).toBe('750 g');
  });
});

describe('RecipesService.archive', () => {
  it('stamps archivedOn rather than deleting', async () => {
    const db = makeDb();
    db.recipe.findFirst.mockResolvedValue({
      id: 1,
      servings: 4,
      ingredients: [],
      steps: [],
      tags: [],
    });
    const { service } = makeService(db);

    await service.archive(1);

    expect(db.recipe.updateMany).toHaveBeenCalledWith({
      where: { id: 1, archivedOn: null },
      data: { archivedOn: expect.any(Date) },
    });
  });

  // Distinguishing these matters: "already archived" and "no such recipe" lead
  // the user to different next actions.
  it('reports an already-archived recipe as a conflict, not a 404', async () => {
    const db = makeDb();
    db.recipe.updateMany.mockResolvedValue({ count: 0 });
    db.recipe.findFirst.mockResolvedValue({ id: 1 });
    const { service } = makeService(db);

    await expect(service.archive(1)).rejects.toThrow('already archived');
  });

  it('404s when the recipe does not exist at all', async () => {
    const db = makeDb();
    db.recipe.updateMany.mockResolvedValue({ count: 0 });
    db.recipe.findFirst.mockResolvedValue(null);
    const { service } = makeService(db);

    await expect(service.archive(1)).rejects.toBeInstanceOf(NotFoundException);
  });
});
