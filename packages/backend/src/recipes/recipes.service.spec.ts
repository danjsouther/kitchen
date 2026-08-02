import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ARCHIVE_HOUSEHOLD_ID, SYSTEM_HOUSEHOLD_ID } from '@kitchen/shared-types';
import Decimal from 'decimal.js';

import { runWithHousehold } from '../common/household-context';
import { RecipesService, buildRecipeWhere } from './recipes.service';
import type { CreateRecipeDto } from './dto/recipe.dto';

const CUP = { id: 1, name: 'cup', plural: 'cups', abbrev: null, kind: 'VOLUME', toBaseFactor: '236.5882365' };
const GRAM = { id: 2, name: 'gram', plural: 'grams', abbrev: 'g', kind: 'MASS', toBaseFactor: '1' };

const HOUSEHOLD = 7;
const USER = 7;
/** The context every test runs in unless it deliberately runs unwrapped. */
function withHousehold<T>(fn: () => T): T {
  return runWithHousehold({ householdId: HOUSEHOLD, userId: USER, role: 'MEMBER' as never }, fn);
}

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

/** The raw, unscoped client `publish` writes SYSTEM_HOUSEHOLD_ID/ARCHIVE_HOUSEHOLD_ID rows through. */
function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    recipe: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 900, ...data, tags: [], ingredients: [], steps: [] }),
      ),
    },
    ingredient: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

function makeService(db = makeDb(), prisma = makePrisma()) {
  const units = { resolve: jest.fn().mockResolvedValue(new Map()) };
  const ingredients = { resolve: jest.fn().mockResolvedValue(new Map()) };
  const service = new RecipesService(db as never, prisma as never, units as never, ingredients as never);
  return { service, db, prisma, units, ingredients };
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

  // 'mine' relies on the catalog visibility rule already excluding every other
  // household — excluding SYSTEM_HOUSEHOLD_ID from what's already "SYSTEM or
  // own" leaves only "own".
  it('scopes to the caller own rows for scope=mine', () => {
    const where = buildRecipeWhere({ scope: 'mine' }) as { AND: unknown[] };
    expect(where.AND).toContainEqual({ householdId: { not: SYSTEM_HOUSEHOLD_ID } });
  });

  it('scopes to the shared catalog for scope=shared', () => {
    const where = buildRecipeWhere({ scope: 'shared' }) as { AND: unknown[] };
    expect(where.AND).toContainEqual({ householdId: SYSTEM_HOUSEHOLD_ID });
  });

  it('applies no scope filter for scope=all', () => {
    // status still applies its own default filter; only the scope clause is
    // asserted absent here.
    const where = buildRecipeWhere({ scope: 'all' }) as { AND: unknown[] };
    expect(where.AND).toEqual([{ archivedOn: null }]);
  });
});

describe('RecipesService.create', () => {
  it('numbers ingredients and steps by position', async () => {
    const { service, db } = makeService();
    await withHousehold(() =>
      service.create(
        dto({
          ingredients: [
            { rawText: 'first', quantity: '1', unitId: 1 },
            { rawText: 'second' },
          ],
          steps: [{ text: 'a' }, { text: 'b' }],
        }),
        7,
      ),
    );

    const data = writtenData(db.recipe.create);
    expect(data.ingredients.create?.map((i) => i.sortOrder)).toEqual([0, 1]);
    expect(data.steps.create?.map((s) => s.sortOrder)).toEqual([0, 1]);
  });

  it('derives a slug from the title', async () => {
    const { service, db } = makeService();
    await withHousehold(() => service.create(dto(), 7));
    expect(writtenData(db.recipe.create).slug).toBe('weeknight-chili');
  });

  it('numbers the slug when the household already has that title', async () => {
    const db = makeDb();
    // 'weeknight-chili' is taken, 'weeknight-chili-2' is free.
    db.recipe.findFirst
      .mockResolvedValueOnce({ id: 9 })
      .mockResolvedValueOnce(null);

    const { service } = makeService(db);
    await withHousehold(() => service.create(dto(), 7));
    expect(writtenData(db.recipe.create).slug).toBe('weeknight-chili-2');
  });

  // Content hash is a first-class field of every write, not something bolted
  // on only for sharing — it is what `publish` later dedupes on.
  it('stamps a content hash and no parentHash on a fresh recipe', async () => {
    const { service, db } = makeService();
    await withHousehold(() => service.create(dto(), 7));

    const data = writtenData(db.recipe.create);
    expect(typeof data.hash).toBe('string');
    expect(String(data.hash).length).toBe(64);
    expect(data.parentHash).toBeUndefined();
  });

  it('gives identical content the same hash regardless of who writes it', async () => {
    const dbA = makeDb();
    const dbB = makeDb();
    await withHousehold(() => makeService(dbA).service.create(dto(), 7));
    await runWithHousehold({ householdId: 8, userId: 8, role: 'MEMBER' as never }, () =>
      makeService(dbB).service.create(dto(), 8),
    );

    expect(writtenData(dbA.recipe.create).hash).toBe(writtenData(dbB.recipe.create).hash);
  });

  // A unit with no number attached is not a quantity — "cups of flour" cannot be
  // scaled, converted or subtracted from the pantry, so it must not be stored as
  // though it could.
  it('rejects a line with a unit but no quantity', async () => {
    const { service } = makeService();
    await expect(
      withHousehold(() =>
        service.create(dto({ ingredients: [{ rawText: 'cups of flour', unitId: 1 }] }), 7),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('names the offending line in the error', async () => {
    const { service } = makeService();
    await expect(
      withHousehold(() =>
        service.create(
          dto({
            ingredients: [
              { rawText: 'ok', quantity: '1', unitId: 1 },
              { rawText: 'cups of flour', unitId: 1 },
            ],
          }),
          7,
        ),
      ),
    ).rejects.toThrow(/line 2 \("cups of flour"\)/);
  });

  // An unresolved line is a first-class case, not an error: "salt and pepper to
  // taste" has no ingredient, no quantity and no unit, and must still save.
  it('accepts a line with no ingredient, quantity or unit', async () => {
    const { service, db } = makeService();
    await withHousehold(() =>
      service.create(dto({ ingredients: [{ rawText: 'salt and pepper to taste' }] }), 7),
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
    await withHousehold(() =>
      service.create(
        dto({
          ingredients: [
            { rawText: 'a', quantity: '1', unitId: 1, ingredientId: 5 },
            { rawText: 'b', quantity: '2', unitId: 2, ingredientId: 6 },
          ],
        }),
        7,
      ),
    );
    expect(units.resolve).toHaveBeenCalledWith([1, 2]);
    expect(ingredients.resolve).toHaveBeenCalledWith([5, 6]);
    expect(db.recipe.create).toHaveBeenCalled();
  });

  it('does not write anything when a referenced id is unknown', async () => {
    const { service, db, units } = makeService();
    units.resolve.mockRejectedValue(new BadRequestException('Unknown unit id: 99.'));
    await expect(withHousehold(() => service.create(dto(), 7))).rejects.toThrow(
      'Unknown unit id: 99.',
    );
    expect(db.recipe.create).not.toHaveBeenCalled();
  });

  it('reuses an existing tag rather than creating a duplicate', async () => {
    const db = makeDb();
    db.tag.findMany.mockResolvedValue([{ id: 3, slug: 'weeknight' }]);
    const { service } = makeService(db);

    await withHousehold(() => service.create(dto({ tags: [{ name: 'Weeknight' }] }), 7));

    expect(db.tag.create).not.toHaveBeenCalled();
    expect(writtenData(db.recipe.create).tags.create).toEqual([{ tagId: 3 }]);
  });

  it('treats tags differing only in case as one tag', async () => {
    const db = makeDb();
    const { service } = makeService(db);
    await withHousehold(() => service.create(dto({ tags: [{ name: 'Vegan' }, { name: 'vegan' }] }), 7));
    expect(db.tag.create).toHaveBeenCalledTimes(1);
  });
});

describe('RecipesService.update', () => {
  it('keeps the existing slug when the title change does not change the slug', async () => {
    const db = makeDb();
    db.recipe.findFirst.mockResolvedValue({
      id: 1,
      householdId: HOUSEHOLD,
      title: 'Chili',
      slug: 'chili',
      ingredients: [],
      steps: [],
    });
    const { service } = makeService(db);

    await withHousehold(() => service.update(1, { title: 'CHILI' }));

    expect(writtenData(db.recipe.update).slug).toBeUndefined();
  });

  it('re-slugs a real rename', async () => {
    const db = makeDb();
    db.recipe.findFirst
      .mockResolvedValueOnce({
        id: 1,
        householdId: HOUSEHOLD,
        title: 'Chili',
        slug: 'chili',
        ingredients: [],
        steps: [],
      })
      .mockResolvedValue(null); // the new slug is free
    const { service } = makeService(db);

    await withHousehold(() => service.update(1, { title: 'Turkey Chili' }));

    expect(writtenData(db.recipe.update).slug).toBe('turkey-chili');
  });

  // Positional sortOrder is why: a merge would need the client to reconcile
  // inserts, deletes and reorders against row ids on every save.
  it('replaces the ingredient list wholesale', async () => {
    const db = makeDb();
    db.recipe.findFirst.mockResolvedValue({
      id: 1,
      householdId: HOUSEHOLD,
      title: 'Chili',
      slug: 'chili',
      ingredients: [],
      steps: [],
    });
    const { service } = makeService(db);

    await withHousehold(() => service.update(1, { ingredients: [{ rawText: 'only line' }] }));

    expect(writtenData(db.recipe.update).ingredients).toEqual({
      deleteMany: {},
      create: [expect.objectContaining({ sortOrder: 0, rawText: 'only line' })],
    });
  });

  it('leaves collections alone when they are not supplied', async () => {
    const db = makeDb();
    db.recipe.findFirst.mockResolvedValue({
      id: 1,
      householdId: HOUSEHOLD,
      title: 'Chili',
      slug: 'chili',
      ingredients: [],
      steps: [],
    });
    const { service } = makeService(db);

    await withHousehold(() => service.update(1, { servings: 8 }));

    const data = writtenData(db.recipe.update);
    expect(data.servings).toBe(8);
    expect(data.ingredients).toBeUndefined();
    expect(data.steps).toBeUndefined();
    expect(data.tags).toBeUndefined();
  });

  it('404s on a recipe this household cannot see', async () => {
    const { service } = makeService();
    await expect(withHousehold(() => service.update(1, { servings: 8 }))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // Global rows are refused rather than silently ignored: the tenancy write
  // filter would otherwise touch zero rows and report success.
  it('refuses to edit a recipe owned by the shared catalog', async () => {
    const db = makeDb();
    db.recipe.findFirst.mockResolvedValue({
      id: 1,
      householdId: SYSTEM_HOUSEHOLD_ID,
      title: 'Chili',
      slug: 'chili',
      ingredients: [],
      steps: [],
    });
    const { service } = makeService(db);

    await expect(withHousehold(() => service.update(1, { servings: 8 }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(db.recipe.update).not.toHaveBeenCalled();
  });

  // An absent field means "leave alone", so without a value that means "clear
  // it" an edit screen can add a description but never take one away.
  it('clears a nullable text column when given an empty string', async () => {
    const db = makeDb();
    db.recipe.findFirst.mockResolvedValue({
      id: 1,
      householdId: HOUSEHOLD,
      title: 'Chili',
      slug: 'chili',
      ingredients: [],
      steps: [],
    });
    const { service } = makeService(db);

    await withHousehold(() =>
      service.update(1, {
        description: '',
        sourceUrl: '',
        sourceNote: '   ',
        notes: '',
      }),
    );

    const data = writtenData(db.recipe.update);
    expect(data.description).toBeNull();
    expect(data.sourceUrl).toBeNull();
    expect(data.sourceNote).toBeNull();
    expect(data.notes).toBeNull();
  });

  it('still writes text that was actually supplied', async () => {
    const db = makeDb();
    db.recipe.findFirst.mockResolvedValue({
      id: 1,
      householdId: HOUSEHOLD,
      title: 'Chili',
      slug: 'chili',
      ingredients: [],
      steps: [],
    });
    const { service } = makeService(db);

    await withHousehold(() => service.update(1, { description: 'A weeknight one.' }));

    expect(writtenData(db.recipe.update).description).toBe('A weeknight one.');
  });

  it('leaves untouched text columns alone', async () => {
    const db = makeDb();
    db.recipe.findFirst.mockResolvedValue({
      id: 1,
      householdId: HOUSEHOLD,
      title: 'Chili',
      slug: 'chili',
      ingredients: [],
      steps: [],
    });
    const { service } = makeService(db);

    await withHousehold(() => service.update(1, { servings: 8 }));

    const data = writtenData(db.recipe.update);
    expect('description' in data).toBe(false);
    expect('notes' in data).toBe(false);
  });

  // `Int?` has no way to say "exactly no prep", and create already drops a 0,
  // so 0 has only ever meant "not recorded" in this app.
  it('clears the minute columns on zero', async () => {
    const db = makeDb();
    db.recipe.findFirst.mockResolvedValue({
      id: 1,
      householdId: HOUSEHOLD,
      title: 'Chili',
      slug: 'chili',
      ingredients: [],
      steps: [],
    });
    const { service } = makeService(db);

    await withHousehold(() => service.update(1, { prepMinutes: 0, cookMinutes: 45 }));

    const data = writtenData(db.recipe.update);
    expect(data.prepMinutes).toBeNull();
    expect(data.cookMinutes).toBe(45);
  });

  // Recomputed from the merged content, not just the patch — editing only
  // `servings` still changes the hash, since the row as a whole is different.
  it('recomputes the hash from merged content, not just the patch', async () => {
    const db = makeDb();
    db.recipe.findFirst.mockResolvedValue({
      id: 1,
      householdId: HOUSEHOLD,
      title: 'Chili',
      slug: 'chili',
      description: null,
      servings: 4,
      prepMinutes: null,
      cookMinutes: null,
      sourceUrl: null,
      sourceNote: null,
      notes: null,
      ingredients: [],
      steps: [],
    });
    const { service } = makeService(db);

    await withHousehold(() => service.update(1, { servings: 8 }));

    const data = writtenData(db.recipe.update);
    expect(typeof data.hash).toBe('string');
    expect(String(data.hash).length).toBe(64);
    expect(data.parentHash).toBeUndefined();
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
      householdId: HOUSEHOLD,
      servings: 4,
      ingredients: [],
      steps: [],
      tags: [],
    });
    const { service } = makeService(db);

    await withHousehold(() => service.archive(1));

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
    db.recipe.findFirst.mockResolvedValue({ id: 1, householdId: HOUSEHOLD });
    const { service } = makeService(db);

    await expect(withHousehold(() => service.archive(1))).rejects.toThrow('already archived');
  });

  it('404s when the recipe does not exist at all', async () => {
    const db = makeDb();
    db.recipe.updateMany.mockResolvedValue({ count: 0 });
    db.recipe.findFirst.mockResolvedValue(null);
    const { service } = makeService(db);

    await expect(withHousehold(() => service.archive(1))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses to archive a recipe owned by the shared catalog', async () => {
    const db = makeDb();
    db.recipe.findFirst.mockResolvedValue({ id: 1, householdId: SYSTEM_HOUSEHOLD_ID });
    const { service } = makeService(db);

    await expect(withHousehold(() => service.archive(1))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(db.recipe.updateMany).not.toHaveBeenCalled();
  });
});

describe('RecipesService.publish', () => {
  function sourceRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 1,
      householdId: HOUSEHOLD,
      title: 'Chili',
      slug: 'chili',
      description: null,
      servings: 4,
      prepMinutes: null,
      cookMinutes: null,
      sourceUrl: null,
      sourceNote: null,
      notes: null,
      imagePath: null,
      hash: 'source-hash',
      createdById: USER,
      ingredients: [],
      steps: [],
      ...overrides,
    };
  }

  it('creates a new row owned by SYSTEM_HOUSEHOLD_ID', async () => {
    const db = makeDb();
    db.recipe.findFirst
      .mockResolvedValueOnce(sourceRow()) // load source
      .mockResolvedValueOnce(null) // no existing global match
      .mockResolvedValueOnce(null); // slug not taken
    const { service, prisma } = makeService(db);

    await withHousehold(() => service.publish(1));

    expect(prisma.recipe.create).toHaveBeenCalled();
    const data = writtenData(prisma.recipe.create as jest.Mock);
    expect(data.householdId).toBe(SYSTEM_HOUSEHOLD_ID);
    expect(data.hash).toBe('source-hash');
    expect(data.parentHash).toBe('source-hash');
  });

  it('archives the private source under ARCHIVE_HOUSEHOLD_ID', async () => {
    const db = makeDb();
    db.recipe.findFirst
      .mockResolvedValueOnce(sourceRow())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const prisma = makePrisma();
    prisma.recipe.findFirst.mockResolvedValue(null); // not already archived
    const { service } = makeService(db, prisma);

    await withHousehold(() => service.publish(1));

    expect(prisma.recipe.create).toHaveBeenCalledTimes(2);
    const archiveCall = (prisma.recipe.create as jest.Mock).mock.calls[1][0].data;
    expect(archiveCall.householdId).toBe(ARCHIVE_HOUSEHOLD_ID);
    expect(archiveCall.hash).toBe('source-hash');
    expect(archiveCall.parentHash).toBeNull();
  });

  it('does not archive twice for the same content', async () => {
    const db = makeDb();
    db.recipe.findFirst
      .mockResolvedValueOnce(sourceRow())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const prisma = makePrisma();
    prisma.recipe.findFirst.mockResolvedValue({ id: 500 }); // already archived
    const { service } = makeService(db, prisma);

    await withHousehold(() => service.publish(1));

    // Only the SYSTEM_HOUSEHOLD_ID row gets created; the archive step is skipped.
    expect(prisma.recipe.create).toHaveBeenCalledTimes(1);
  });

  it('does not archive a source that is already published', async () => {
    const db = makeDb();
    db.recipe.findFirst
      .mockResolvedValueOnce(sourceRow({ householdId: SYSTEM_HOUSEHOLD_ID }))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const { service, prisma } = makeService(db);

    await withHousehold(() => service.publish(1));

    expect(prisma.recipe.create).toHaveBeenCalledTimes(1);
  });

  // A duplicate under SYSTEM_HOUSEHOLD_ID is what the (householdId, slug,
  // hash) constraint exists to prevent — publish resolves to the match
  // instead of colliding with it.
  it('returns the existing global row instead of creating a duplicate', async () => {
    const db = makeDb();
    const existing = { id: 42, tags: [], ingredients: [], steps: [] };
    db.recipe.findFirst
      .mockResolvedValueOnce(sourceRow())
      .mockResolvedValueOnce(existing);
    const { service, prisma } = makeService(db);

    const result = await withHousehold(() => service.publish(1));

    expect(result.id).toBe(42);
    expect(prisma.recipe.create).not.toHaveBeenCalled();
  });

  it('404s when the recipe does not exist', async () => {
    const { service } = makeService();
    await expect(withHousehold(() => service.publish(1))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // A line pointing at a private ingredient would be invisible or broken for
  // every other household — the published copy keeps the wording, not the link.
  it('drops a link to a household-private ingredient but keeps the raw text', async () => {
    const db = makeDb();
    db.recipe.findFirst
      .mockResolvedValueOnce(
        sourceRow({
          ingredients: [
            {
              sortOrder: 0,
              ingredientId: 55,
              rawText: 'a splash of nonna sauce',
              quantity: null,
              unitId: null,
              preparation: null,
              groupLabel: null,
              optional: false,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const prisma = makePrisma();
    prisma.ingredient.findMany.mockResolvedValue([]); // 55 is not global
    const { service } = makeService(db, prisma);

    await withHousehold(() => service.publish(1));

    const data = writtenData(prisma.recipe.create as jest.Mock);
    expect(data.ingredients.create?.[0]).toMatchObject({
      ingredientId: null,
      rawText: 'a splash of nonna sauce',
    });
  });
});

describe('RecipesService.copy', () => {
  function globalRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 1,
      householdId: SYSTEM_HOUSEHOLD_ID,
      title: 'Chili',
      slug: 'chili',
      description: null,
      servings: 4,
      prepMinutes: null,
      cookMinutes: null,
      sourceUrl: null,
      sourceNote: null,
      notes: null,
      imagePath: null,
      hash: 'global-hash',
      ingredients: [],
      steps: [],
      ...overrides,
    };
  }

  it('forks a global recipe into a household-owned copy', async () => {
    const db = makeDb();
    db.recipe.findFirst
      .mockResolvedValueOnce(globalRow()) // load source
      .mockResolvedValueOnce(null); // no existing copy
    const { service } = makeService(db);

    await withHousehold(() => service.copy(1, USER));

    const data = writtenData(db.recipe.create);
    expect(data.householdId).toBeUndefined(); // stamped by the tenancy extension, not here
    expect(data.parentHash).toBe('global-hash');
    expect(data.hash).toBe('global-hash');
    expect(data.createdById).toBe(USER);
  });

  it('refuses to copy a recipe the household already owns', async () => {
    const db = makeDb();
    db.recipe.findFirst.mockResolvedValueOnce(globalRow({ householdId: HOUSEHOLD }));
    const { service } = makeService(db);

    await expect(withHousehold(() => service.copy(1, USER))).rejects.toThrow(
      'already belongs to your household',
    );
  });

  it('refuses a second copy of the same recipe', async () => {
    const db = makeDb();
    db.recipe.findFirst
      .mockResolvedValueOnce(globalRow())
      .mockResolvedValueOnce({ id: 55 }); // already has one
    const { service } = makeService(db);

    await expect(withHousehold(() => service.copy(1, USER))).rejects.toThrow(
      'already have your own copy',
    );
  });

  it('404s when the recipe does not exist', async () => {
    const { service } = makeService();
    await expect(withHousehold(() => service.copy(1, USER))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
