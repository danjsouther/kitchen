import {
  MatchKind,
  fuzzyResult,
  matchBySlugOrAlias,
  productNamePhrases,
  shouldWrite,
  type CatalogIngredient,
} from './off-match';

function ingredient(id: number, name: string, slug: string): CatalogIngredient {
  return { id, name, slug };
}

describe('productNamePhrases', () => {
  it('includes the whole cleaned name, each word, and adjacent word pairs', () => {
    expect(productNamePhrases('Old Fashioned Oats')).toEqual(
      expect.arrayContaining([
        'Old Fashioned Oats',
        'Old',
        'Old Fashioned',
        'Fashioned',
        'Fashioned Oats',
        'Oats',
      ]),
    );
  });

  it('drops everything from the first comma on, where retail names keep pack size', () => {
    expect(productNamePhrases('Old Fashioned Oats, 42 oz')).not.toContain('42 oz');
    expect(productNamePhrases('Old Fashioned Oats, 42 oz')).toContain('Old Fashioned Oats');
  });

  it('returns nothing for a blank name', () => {
    expect(productNamePhrases('   ')).toEqual([]);
  });

  it('deduplicates repeated words', () => {
    expect(productNamePhrases('Oats Oats')).toEqual(['Oats Oats', 'Oats', 'Oats Oats']
      .filter((v, i, a) => a.indexOf(v) === i));
  });
});

describe('matchBySlugOrAlias', () => {
  const oats = ingredient(1, 'Rolled Oats', 'rolled-oats');
  const egg = ingredient(2, 'Egg', 'egg');
  const bySlug = new Map([[oats.slug, oats], [egg.slug, egg]]);
  const byAlias = new Map([['oatmeal', oats]]);

  it('matches a single-word phrase inside a noisy retail name', () => {
    // No phrase equals "rolled-oats" here, but "eggs" -> singular "egg" should hit.
    const result = matchBySlugOrAlias('Grade A Large Eggs, 12 ct', bySlug, byAlias);
    expect(result).toEqual(
      expect.objectContaining({ kind: MatchKind.SINGULAR, ingredientId: egg.id }),
    );
  });

  it('finds an exact slug match on a full phrase', () => {
    const result = matchBySlugOrAlias('Rolled Oats', bySlug, byAlias);
    expect(result).toEqual(
      expect.objectContaining({ kind: MatchKind.EXACT, ingredientId: oats.id, confidence: 1 }),
    );
  });

  it('finds an alias match', () => {
    const result = matchBySlugOrAlias('Quaker Oatmeal, 42 oz', bySlug, byAlias);
    expect(result).toEqual(
      expect.objectContaining({ kind: MatchKind.ALIAS, ingredientId: oats.id }),
    );
  });

  it('prefers an exact/alias hit found on an earlier, more specific phrase', () => {
    // "egg" would also match, but "rolled-oats" comes from the full phrase tried first.
    const result = matchBySlugOrAlias('Rolled Oats and Egg Mix', bySlug, byAlias);
    expect(result?.ingredientId).toBe(oats.id);
  });

  it('returns null when nothing in the name matches the catalog', () => {
    expect(matchBySlugOrAlias('Sparkling Mineral Water', bySlug, byAlias)).toBeNull();
  });
});

describe('shouldWrite', () => {
  const ingr = ingredient(1, 'Egg', 'egg');

  it('always writes EXACT, ALIAS and SINGULAR matches regardless of threshold', () => {
    expect(shouldWrite({ kind: MatchKind.EXACT, confidence: 1, ...idFields(ingr) }, 0.99)).toBe(
      true,
    );
    expect(shouldWrite({ kind: MatchKind.ALIAS, confidence: 0.95, ...idFields(ingr) }, 0.99)).toBe(
      true,
    );
    expect(
      shouldWrite({ kind: MatchKind.SINGULAR, confidence: 0.9, ...idFields(ingr) }, 0.99),
    ).toBe(true);
  });

  it('writes a FUZZY match only at or above the threshold', () => {
    expect(shouldWrite(fuzzyResult(ingr, 0.6), 0.6)).toBe(true);
    expect(shouldWrite(fuzzyResult(ingr, 0.59), 0.6)).toBe(false);
  });

  it('never writes a null match', () => {
    expect(shouldWrite(null, 0)).toBe(false);
  });
});

function idFields(ingr: CatalogIngredient) {
  return { ingredientId: ingr.id, name: ingr.name, slug: ingr.slug };
}
