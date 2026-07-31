import { UnitKind } from './enums';
import { formatQuantity, formatWithUnit, parseQuantity } from './format';
import type { UnitDef } from './units';

const cup: UnitDef & { plural: string } = {
  id: 12,
  name: 'cup',
  plural: 'cups',
  kind: UnitKind.VOLUME,
  toBaseFactor: '236.5882365',
};
const gram: UnitDef & { plural: string; abbrev: string } = {
  id: 1,
  name: 'gram',
  plural: 'grams',
  abbrev: 'g',
  kind: UnitKind.MASS,
  toBaseFactor: 1,
};

describe('formatQuantity', () => {
  it.each([
    [0.5, '½'],
    [0.25, '¼'],
    [0.75, '¾'],
    [1.5, '1 ½'],
    [2.25, '2 ¼'],
    [0.125, '⅛'],
    [2, '2'],
  ])('renders %p as %p', (value, expected) => {
    expect(formatQuantity(value)).toBe(expected);
  });

  it('snaps a scaled third to ⅓', () => {
    expect(formatQuantity(1 / 3)).toBe('⅓');
    expect(formatQuantity(2 / 3)).toBe('⅔');
  });

  it('snaps near-misses from repeated scaling', () => {
    expect(formatQuantity(0.4999)).toBe('½');
    expect(formatQuantity(1.998)).toBe('2');
  });

  it('keeps a decimal when the value is not near a common fraction', () => {
    // 0.3 is not a cooking fraction — showing "¼" or "⅓" here would be a lie.
    expect(formatQuantity(0.3)).toBe('0.3');
  });

  it('renders decimals when fractions are disabled', () => {
    expect(formatQuantity(1.5, { fractions: false })).toBe('1.5');
    expect(formatQuantity(236.5882, { fractions: false })).toBe('236.59');
  });

  it('handles negatives', () => {
    expect(formatQuantity(-1.5)).toBe('-1 ½');
  });

  it('returns an empty string for a non-finite value', () => {
    expect(formatQuantity(Infinity)).toBe('');
  });
});

describe('formatWithUnit', () => {
  it('pluralises and uses fractions for volume', () => {
    expect(formatWithUnit(1.5, cup)).toBe('1 ½ cups');
  });

  it('uses the singular for exactly one', () => {
    expect(formatWithUnit(1, cup)).toBe('1 cup');
  });

  it('prefers the abbreviation and skips fractions for mass', () => {
    expect(formatWithUnit(237.4, gram)).toBe('237.4 g');
  });
});

describe('parseQuantity', () => {
  it.each([
    ['2', 2],
    ['0.5', 0.5],
    ['.5', 0.5],
    ['1/2', 0.5],
    ['3/4', 0.75],
    ['1 1/2', 1.5],
    ['1 ½', 1.5],
    ['½', 0.5],
    ['2 ¾', 2.75],
  ])('parses %p as %p', (input, expected) => {
    expect(parseQuantity(input)?.toNumber()).toBeCloseTo(expected, 10);
  });

  it('round-trips a formatted mixed number', () => {
    expect(parseQuantity(formatQuantity(2.25))?.toNumber()).toBe(2.25);
  });

  it.each([['', 'abc', '1/0', '--3']])(
    'returns null for unparseable input %p',
    (input) => {
      expect(parseQuantity(input as string)).toBeNull();
    },
  );
});
