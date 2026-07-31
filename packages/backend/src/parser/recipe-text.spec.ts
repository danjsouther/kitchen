import {
  nameCandidates,
  parseIngredientLine,
  parseRecipeText,
  splitPreparation,
  type UnitLexicon,
} from './recipe-text';

/** A stand-in for the household's unit vocabulary. */
const UNITS: UnitLexicon = new Map([
  ['cup', 1], ['cups', 1],
  ['tablespoon', 2], ['tablespoons', 2], ['tbsp', 2],
  ['teaspoon', 3], ['teaspoons', 3], ['tsp', 3],
  ['gram', 4], ['grams', 4], ['g', 4],
  ['kilogram', 5], ['kg', 5],
  ['ounce', 6], ['ounces', 6], ['oz', 6],
  ['pound', 7], ['pounds', 7], ['lb', 7],
  ['pinch', 8], ['pinches', 8],
  ['clove', 9], ['cloves', 9],
  ['can', 10], ['cans', 10],
  ['each', 11],
]);

const parse = (line: string) => parseIngredientLine(line, UNITS);

describe('parseIngredientLine — quantities', () => {
  it('reads a whole number', () => {
    expect(parse('2 cups flour')).toMatchObject({ quantity: '2', unitId: 1, name: 'flour' });
  });

  it('reads a decimal', () => {
    expect(parse('1.5 cups milk').quantity).toBe('1.5');
  });

  it('reads a plain fraction', () => {
    expect(parse('1/2 cup sugar').quantity).toBe('0.5');
  });

  it('reads a mixed number', () => {
    expect(parse('1 1/2 cups water').quantity).toBe('1.5');
  });

  it('reads a vulgar fraction', () => {
    expect(parse('½ cup cream').quantity).toBe('0.5');
  });

  it('reads a mixed vulgar fraction', () => {
    expect(parse('1 ½ cups milk').quantity).toBe('1.5');
  });

  // Under-buying is recoverable; over-buying fills a cupboard with things nobody
  // wanted. The flag is what lets the review screen say a choice was made.
  it('takes the lower bound of a range and says so', () => {
    expect(parse('1-2 tablespoons oil')).toMatchObject({
      quantity: '1',
      isRange: true,
      unitId: 2,
      name: 'oil',
    });
  });

  it('handles a worded range', () => {
    expect(parse('2 to 3 cloves garlic')).toMatchObject({
      quantity: '2',
      isRange: true,
      name: 'garlic',
    });
  });

  it('handles an en-dash range', () => {
    expect(parse('1–2 cups stock')).toMatchObject({ quantity: '1', isRange: true });
  });

  // A unit with no number in front of it means one of them. Leaving this null
  // would emit a unit without an amount — not a measurement anything can scale
  // or subtract, and one the create-recipe endpoint rejects outright.
  it('reads a bare unit as one of that unit, and says the amount was inferred', () => {
    expect(parse('a pinch of saffron')).toMatchObject({
      quantity: '1',
      unitId: 8,
      name: 'saffron',
      inferredQuantity: true,
    });
  });

  it('infers the same way with no article at all', () => {
    expect(parse('pinch of salt')).toMatchObject({
      quantity: '1',
      unitId: 8,
      inferredQuantity: true,
    });
  });

  it('does not claim to have inferred an amount that was written down', () => {
    expect(parse('2 cups flour').inferredQuantity).toBe(false);
  });

  // Without a unit there is nothing to count, so nothing is inferred.
  it('leaves a line with neither amount nor unit alone', () => {
    expect(parse('salt and pepper to taste')).toMatchObject({
      quantity: null,
      unitId: null,
      inferredQuantity: false,
    });
  });

  it('leaves an unquantified line alone', () => {
    expect(parse('salt and pepper to taste')).toMatchObject({
      quantity: null,
      unitId: null,
      name: 'salt and pepper to taste',
    });
  });
});

describe('parseIngredientLine — units and names', () => {
  it('drops the "of" between unit and ingredient', () => {
    expect(parse('2 cups of flour').name).toBe('flour');
  });

  it('matches an abbreviated unit', () => {
    expect(parse('500 g flour')).toMatchObject({ unitId: 4, name: 'flour' });
  });

  it('leaves an unknown unit word in the name', () => {
    expect(parse('2 sprigs thyme')).toMatchObject({
      unitId: null,
      unitToken: null,
      name: 'sprigs thyme',
    });
  });

  it('handles a count with no unit at all', () => {
    expect(parse('3 eggs')).toMatchObject({ quantity: '3', unitId: null, name: 'eggs' });
  });

  it('always keeps the original text verbatim', () => {
    expect(parse('  2 cups of flour, sifted  ').rawText).toBe('2 cups of flour, sifted');
  });

  it('strips a bullet or numbered marker', () => {
    expect(parse('- 2 cups flour').name).toBe('flour');
    expect(parse('1. 2 cups flour').quantity).toBe('2');
  });

  it('notices an optional ingredient and removes the marker from the name', () => {
    expect(parse('2 tbsp parsley (optional)')).toMatchObject({
      optional: true,
      name: 'parsley',
    });
  });
});

describe('splitPreparation', () => {
  // "eggs, beaten" matches nothing in the catalog; "eggs" matches an egg.
  it('splits on the first comma', () => {
    expect(splitPreparation('large eggs, beaten')).toEqual({
      name: 'large eggs',
      preparation: 'beaten',
    });
  });

  it('splits on a parenthetical', () => {
    expect(splitPreparation('onion (finely chopped)')).toEqual({
      name: 'onion',
      preparation: 'finely chopped',
    });
  });

  it('keeps text after the parenthetical in the name', () => {
    expect(splitPreparation('canned (whole) tomatoes')).toEqual({
      name: 'canned tomatoes',
      preparation: 'whole',
    });
  });

  it('leaves a plain name alone', () => {
    expect(splitPreparation('flour')).toEqual({ name: 'flour', preparation: null });
  });

  it('keeps everything after the first comma as preparation', () => {
    expect(splitPreparation('chicken, skinned, boned and diced')).toEqual({
      name: 'chicken',
      preparation: 'skinned, boned and diced',
    });
  });
});

describe('nameCandidates', () => {
  // Most specific first: the seed catalog carries aliases like "large egg", so
  // the full phrase deserves a try before it is whittled down.
  it('tries the full phrase before dropping modifiers', () => {
    expect(nameCandidates('large eggs')).toEqual(['large-eggs', 'eggs']);
  });

  it('peels modifiers one at a time', () => {
    expect(nameCandidates('extra virgin olive oil')).toEqual([
      'extra-virgin-olive-oil',
      'virgin-olive-oil',
      'olive-oil',
      'oil',
    ]);
  });

  it('returns a single candidate for a single word', () => {
    expect(nameCandidates('flour')).toEqual(['flour']);
  });

  it('returns nothing for an empty name', () => {
    expect(nameCandidates('   ')).toEqual([]);
  });
});

describe('parseRecipeText', () => {
  it('reads a recipe with explicit headings', () => {
    const result = parseRecipeText(
      `Buttermilk Pancakes

Ingredients
2 cups all-purpose flour
1 1/2 cups buttermilk
2 large eggs, beaten
salt to taste

Instructions
1. Whisk the dry ingredients together in a large bowl.
2. Add the buttermilk and eggs and stir until just combined.
3. Fry in a hot pan until golden on both sides.`,
      UNITS,
    );

    expect(result.title).toBe('Buttermilk Pancakes');
    expect(result.ingredients.map((i) => [i.quantity, i.unitId, i.name])).toEqual([
      ['2', 1, 'all-purpose flour'],
      ['1.5', 1, 'buttermilk'],
      ['2', null, 'large eggs'],
      [null, null, 'salt to taste'],
    ]);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0].text).toBe(
      'Whisk the dry ingredients together in a large bowl.',
    );
  });

  // Numbered steps start with a digit, exactly like "2 cups flour" does. The
  // list marker has to come off before anything else is considered.
  it('does not mistake numbered steps for ingredients', () => {
    const result = parseRecipeText(
      `1. Preheat the oven to 200C and line a tray with baking paper.
2. Toss the vegetables in oil and season them well.`,
      UNITS,
    );
    expect(result.ingredients).toEqual([]);
    expect(result.steps).toHaveLength(2);
  });

  it('classifies by shape when there are no headings', () => {
    const result = parseRecipeText(
      `Simple Salad
2 cups spinach
1 tbsp olive oil
Toss everything together in a bowl and serve immediately.`,
      UNITS,
    );
    expect(result.title).toBe('Simple Salad');
    expect(result.ingredients.map((i) => i.name)).toEqual(['spinach', 'olive oil']);
    expect(result.steps.map((s) => s.text)).toEqual([
      'Toss everything together in a bowl and serve immediately.',
    ]);
  });

  it('carries a "For the ..." heading down as a group label', () => {
    const result = parseRecipeText(
      `Ingredients
For the sauce
2 tbsp butter
1 cup cream
For the topping
1/2 cup breadcrumbs`,
      UNITS,
    );
    expect(result.ingredients.map((i) => [i.name, i.groupLabel])).toEqual([
      ['butter', 'Sauce'],
      ['cream', 'Sauce'],
      ['breadcrumbs', 'Topping'],
    ]);
  });

  it('sets aside notes and metadata rather than treating them as steps', () => {
    const result = parseRecipeText(
      `Ingredients
2 cups flour

Notes: this freezes well.
Prep time: 10 minutes`,
      UNITS,
    );
    expect(result.ingredients).toHaveLength(1);
    expect(result.steps).toEqual([]);
    expect(result.ignored).toHaveLength(2);
  });

  it('handles bulleted ingredients', () => {
    const result = parseRecipeText(
      `Ingredients
• 2 cups flour
- 1 tsp salt
* 3 eggs`,
      UNITS,
    );
    expect(result.ingredients.map((i) => i.name)).toEqual(['flour', 'salt', 'eggs']);
  });

  it('survives blank input', () => {
    expect(parseRecipeText('', UNITS)).toEqual({
      title: null,
      ingredients: [],
      steps: [],
      ignored: [],
    });
  });

  it('treats a lone ingredient list as ingredients', () => {
    const result = parseRecipeText('2 cups flour\n1 tsp salt', UNITS);
    expect(result.ingredients).toHaveLength(2);
    expect(result.steps).toEqual([]);
  });

  // Once the method starts, a recipe does not go back to listing ingredients.
  it('does not return to ingredients after the steps begin', () => {
    const result = parseRecipeText(
      `Chili
2 cups beans
Simmer the beans gently for about an hour until they are tender.
3 cups stock`,
      UNITS,
    );
    expect(result.ingredients.map((i) => i.name)).toEqual(['beans']);
    expect(result.steps).toHaveLength(2);
  });
});
