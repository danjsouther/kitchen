import { buildIngredientWhere, preferOwn } from './ingredients.service';

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
  const global = { slug: 'all-purpose-flour', householdId: null, gramsPerMl: '0.53' };
  const mine = { slug: 'all-purpose-flour', householdId: 4, gramsPerMl: '0.60' };
  const other = { slug: 'sugar', householdId: null, gramsPerMl: '0.85' };

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
