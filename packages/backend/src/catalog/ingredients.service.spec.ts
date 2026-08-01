import { ForbiddenException } from '@nestjs/common';
import { SYSTEM_HOUSEHOLD_ID } from '@kitchen/shared-types';

import { IngredientsService, buildIngredientWhere, preferOwn } from './ingredients.service';

/**
 * A stand-in for the scoped Prisma client, implementing only what `update`
 * calls. Anything else is absent on purpose: a silent `undefined` would let a
 * broken query pass.
 */
function makeDb(existing: Record<string, unknown> | null) {
  return {
    ingredient: {
      findFirst: jest.fn().mockResolvedValue(existing),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 1, ...data }),
      ),
    },
    ingredientCategory: { findUnique: jest.fn().mockResolvedValue({ id: 3 }) },
    unit: { findFirst: jest.fn().mockResolvedValue({ id: 7 }) },
  };
}

const OWNED = { id: 1, householdId: 2, name: 'semolina' };

/** The `data` the update was called with. */
function writtenData(mock: jest.Mock): Record<string, unknown> {
  return mock.mock.calls[0][0].data as Record<string, unknown>;
}

/** Pulls the slug conditions out of the OR block for readable assertions. */
function slugMatches(term: string): string[] {
  const where = buildIngredientWhere({ q: term }) as { AND: { OR: unknown[] }[] };
  return where.AND[0].OR
    .filter((clause): clause is { slug: { contains: string } } =>
      typeof clause === 'object' && clause !== null && 'slug' in clause,
    )
    .map((clause) => clause.slug.contains);
}

describe('buildIngredientWhere', () => {
  it('has no filter at all when nothing was asked for', () => {
    expect(buildIngredientWhere({})).toBeUndefined();
  });

  it('filters by category alone', () => {
    expect(buildIngredientWhere({ categoryId: 3 })).toEqual({
      AND: [{ categoryId: 3 }],
    });
  });

  // People type plurals. "scallions" has to find the row stored as "scallion",
  // and a plain `contains` on the typed text cannot: the stored value is shorter
  // than the query, so it never contains it.
  it('also matches the singular of a plural search', () => {
    expect(slugMatches('scallions')).toContain('scallion');
  });

  it('matches irregular plurals through the singulariser', () => {
    expect(slugMatches('berries')).toContain('berry');
    expect(slugMatches('tomatoes')).toContain('tomato');
    expect(slugMatches('loaves')).toContain('loaf');
  });

  it('keeps the typed form too, so singular searches still work', () => {
    expect(slugMatches('carrot')).toContain('carrot');
  });

  // The singulariser is deliberately fallible — "molasses" is a mass noun, but
  // it stems like "glasses" -> "glass". Over-stemming is safe here because the
  // stem is always a prefix of the word, so `contains` still finds the row; the
  // typed form is kept as a candidate regardless.
  it('still finds a word its stemmer over-shortens', () => {
    const matches = slugMatches('molasses');
    expect(matches).toContain('molasses');
    expect(matches.every((stem) => 'molasses'.startsWith(stem))).toBe(true);
  });

  it('leaves words already ending in ss alone', () => {
    expect(slugMatches('watercress')).toEqual(['watercress']);
  });

  it('searches aliases with the same candidates as names', () => {
    const where = buildIngredientWhere({ q: 'scallions' }) as {
      AND: { OR: Record<string, { some?: { slug: { contains: string } } }>[] }[];
    };
    const aliasTerms = where.AND[0].OR.filter((c) => 'aliases' in c).map(
      (c) => c.aliases.some!.slug.contains,
    );
    expect(aliasTerms).toEqual(['scallions', 'scallion']);
  });

  it('combines a term and a category with AND', () => {
    const where = buildIngredientWhere({ q: 'flour', categoryId: 2 }) as {
      AND: unknown[];
    };
    expect(where.AND).toHaveLength(2);
  });

  it('ignores whitespace-only searches', () => {
    expect(buildIngredientWhere({ q: '   ' })).toBeUndefined();
  });
});

describe('preferOwn', () => {
  const global = { slug: 'all-purpose-flour', householdId: SYSTEM_HOUSEHOLD_ID, gramsPerMl: '0.53' };
  const mine = { slug: 'all-purpose-flour', householdId: 4, gramsPerMl: '0.60' };
  const other = { slug: 'sugar', householdId: SYSTEM_HOUSEHOLD_ID, gramsPerMl: '0.85' };

  // Two rows with the same slug look identical in a picker, and only one of them
  // carries the household's corrected density.
  it('hides the global row when the household has its own version', () => {
    expect(preferOwn([global, mine, other])).toEqual([mine, other]);
  });

  it('keeps a global row that has not been customized', () => {
    expect(preferOwn([global, other])).toEqual([global, other]);
  });

  it('keeps household rows that shadow nothing', () => {
    const invented = { slug: 'nonna-sauce', householdId: 4 };
    expect(preferOwn([other, invented])).toEqual([other, invented]);
  });

  it('is order-independent about which row it sees first', () => {
    expect(preferOwn([mine, global])).toEqual([mine]);
    expect(preferOwn([global, mine])).toEqual([mine]);
  });
});

/**
 * Absent and null mean different things here, and getting that wrong is what
 * made a mistaken density permanent: with only "absent means leave alone",
 * there was no value the editor could send to take one away.
 */
describe('IngredientsService.update', () => {
  it('clears a physical value given an explicit null', async () => {
    const db = makeDb(OWNED);
    const service = new IngredientsService(db as never);

    await service.update(1, { gramsPerMl: null, gramsPerPiece: null });

    const data = writtenData(db.ingredient.update);
    expect(data.gramsPerMl).toBeNull();
    expect(data.gramsPerPiece).toBeNull();
  });

  it('leaves a value alone when the field is absent', async () => {
    const db = makeDb(OWNED);
    const service = new IngredientsService(db as never);

    await service.update(1, { note: 'unchanged elsewhere' });

    const data = writtenData(db.ingredient.update);
    expect('gramsPerMl' in data).toBe(false);
    expect('shelfLifeDays' in data).toBe(false);
  });

  it('still writes a supplied value', async () => {
    const db = makeDb(OWNED);
    const service = new IngredientsService(db as never);

    await service.update(1, { gramsPerMl: '0.53', shelfLifeDays: 30 });

    const data = writtenData(db.ingredient.update);
    expect(data.gramsPerMl).toBe('0.53');
    expect(data.shelfLifeDays).toBe(30);
  });

  // Null here means "no category", so there is no id to look up. Passing it to
  // Prisma anyway was a query error — a 500 for an ordinary edit.
  it('clears a link without looking the missing id up', async () => {
    const db = makeDb(OWNED);
    const service = new IngredientsService(db as never);

    await service.update(1, { categoryId: null, defaultUnitId: null });

    expect(db.ingredientCategory.findUnique).not.toHaveBeenCalled();
    expect(db.unit.findFirst).not.toHaveBeenCalled();

    const data = writtenData(db.ingredient.update);
    expect(data.categoryId).toBeNull();
    expect(data.defaultUnitId).toBeNull();
  });

  it('still checks a link that was actually supplied', async () => {
    const db = makeDb(OWNED);
    const service = new IngredientsService(db as never);

    await service.update(1, { categoryId: 3 });

    expect(db.ingredientCategory.findUnique).toHaveBeenCalled();
  });

  it('refuses to edit a shared row in place', async () => {
    const db = makeDb({ id: 1, householdId: SYSTEM_HOUSEHOLD_ID, name: 'flour' });
    const service = new IngredientsService(db as never);

    await expect(service.update(1, { gramsPerMl: null })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
