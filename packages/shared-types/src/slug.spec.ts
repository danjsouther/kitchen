import { matchCandidates, singularize, slugify } from './slug';

describe('slugify', () => {
  it.each([
    ['All-Purpose Flour', 'all-purpose-flour'],
    ['Jalapeño Pepper', 'jalapeno-pepper'],
    ['Extra Virgin Olive Oil', 'extra-virgin-olive-oil'],
    ['half and half', 'half-and-half'],
    ['  Kosher   Salt  ', 'kosher-salt'],
    ["Grandma's Sauce!", 'grandmas-sauce'],
    ['crème fraîche', 'creme-fraiche'],
    ['2% milk', '2-milk'],
  ])('slugifies %p to %p', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('is idempotent', () => {
    const once = slugify('Jalapeño Pepper');
    expect(slugify(once)).toBe(once);
  });

  it('returns an empty string for input with nothing sluggable', () => {
    expect(slugify('!!!')).toBe('');
  });
});

describe('singularize', () => {
  it.each([
    ['carrots', 'carrot'],
    ['tomatoes', 'tomato'],
    ['berries', 'berry'],
    ['peaches', 'peach'],
    ['loaves', 'loaf'],
    ['eggs', 'egg'],
  ])('singularises %p to %p', (input, expected) => {
    expect(singularize(input)).toBe(expected);
  });

  it.each([
    ['asparagus'], // already singular, ends in -us
    ['molasses'], // ends in -ss
    ['oats'], // conventionally plural, but stemming to "oat" is harmless
  ])('does not mangle %p beyond recognition', (input) => {
    expect(singularize(input).length).toBeGreaterThan(2);
  });

  it('leaves short words alone', () => {
    expect(singularize('oil')).toBe('oil');
  });
});

describe('matchCandidates', () => {
  it('offers the exact slug first, then the singular', () => {
    expect(matchCandidates('Carrots')).toEqual(['carrots', 'carrot']);
  });

  it('de-duplicates when the word is already singular', () => {
    expect(matchCandidates('Carrot')).toEqual(['carrot']);
  });

  it('drops empty candidates', () => {
    expect(matchCandidates('!!!')).toEqual([]);
  });
});
