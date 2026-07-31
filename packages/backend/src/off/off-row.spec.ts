/**
 * The import parser, exercised over the fixture dump.
 *
 * The fixtures are real-shaped Open Food Facts rows, awkward cases included:
 * a comma decimal separator, a multipack, a pack size that is prose, a unit the
 * seed has no row for, a row with no barcode, a row with no name, and a
 * truncated line. No network — `test/no-network.ts` would fail the suite if
 * anything here tried to reach OFF.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildImageUrl, parseOffLine, parsePackSize, type ParsedOffProduct } from './off-row';

const FIXTURE = resolve(__dirname, '../../prisma/seed/off-fixtures/products.jsonl');

function fixtureLines(): string[] {
  return readFileSync(FIXTURE, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

/** Every row the parser accepts with no country filter, keyed by barcode. */
function importedProducts(countries: string[] = []): Map<string, ParsedOffProduct> {
  const map = new Map<string, ParsedOffProduct>();
  for (const line of fixtureLines()) {
    const result = parseOffLine(line, countries);
    if (result.ok) map.set(result.product.barcode, result.product);
  }
  return map;
}

describe('parsePackSize', () => {
  it.each([
    ['345 g', '345', 'g'],
    ['400g', '400', 'g'],
    ['1 kg', '1', 'kg'],
    ['20 oz', '20', 'oz'],
    ['2 fl oz', '2', 'fl oz'],
    ['230 gram', '230', 'g'],
  ])('reads %p as %s %s', (input, quantity, unitToken) => {
    expect(parsePackSize(input)).toEqual({ quantity, unitToken });
  });

  // Most of OFF's contributors write 1,5 for one and a half.
  it('treats a comma as a decimal separator', () => {
    expect(parsePackSize('1,5 L')).toEqual({ quantity: '1.5', unitToken: 'l' });
  });

  // ...but not when it is plainly a thousands separator.
  it('treats a three-digit group as a thousands separator', () => {
    expect(parsePackSize('1,000 g')).toEqual({ quantity: '1000', unitToken: 'g' });
  });

  /**
   * A 6 x 330 ml pack really does hold 1980 ml. Storing 330 would be wrong in a
   * way nothing downstream could detect — the pantry would think a case of cola
   * was a single can.
   */
  it('multiplies through a multipack', () => {
    expect(parsePackSize('6 x 330 ml')).toEqual({ quantity: '1980', unitToken: 'ml' });
  });

  it('multiplies a multipack in fluid ounces', () => {
    expect(parsePackSize('12 x 12 fl oz')).toEqual({ quantity: '144', unitToken: 'fl oz' });
  });

  // Both of these carry a second unit in brackets. Taking the first pair is the
  // rule; taking the largest or the last would flip between them per row.
  it.each([
    ['5 lb (2.27 kg)', '5', 'lb'],
    ['8 oz (226 g)', '8', 'oz'],
  ])('takes the first amount in %p', (input, quantity, unitToken) => {
    expect(parsePackSize(input)).toEqual({ quantity, unitToken });
  });

  it.each([null, '', 'a family size box', 'one bag', '12 pieces'])(
    'declines %p rather than guessing',
    (input) => {
      expect(parsePackSize(input)).toBeNull();
    },
  );

  it('rejects a zero or negative pack size', () => {
    expect(parsePackSize('0 g')).toBeNull();
  });
});

/**
 * Image URLs are *constructed*, not read.
 *
 * The JSONL export has no `image_small_url` — that field exists only in the OFF
 * API — and assuming otherwise fails silently: every row parses, and every
 * product just has no picture. A real import of 925,530 products produced
 * exactly one image before this was fixed.
 */
describe('buildImageUrl', () => {
  const front = (lang: string, rev: string | number) => ({
    selected: { front: { [lang]: { imgid: '1', rev, sizes: { '200': { w: 150, h: 200 } } } } },
  });

  it('builds a 200px front image URL from the selected image', () => {
    expect(buildImageUrl('0000101209159', front('fr', '4'))).toBe(
      'https://images.openfoodfacts.org/images/products/000/010/120/9159/front_fr.4.200.jpg',
    );
  });

  /**
   * The path comes from the code **as OFF stores it**, not the normalized
   * barcode. A 12-digit code lives under `041/196/010/184`; normalizing to
   * EAN-13 first would ask for `004/119/601/0184`, which does not exist. So the
   * normalization that makes scanning work must not reach this function.
   */
  it('splits the raw code, not the padded barcode', () => {
    expect(buildImageUrl('041196010184', front('en', '7'))).toBe(
      'https://images.openfoodfacts.org/images/products/041/196/010/184/front_en.7.200.jpg',
    );
  });

  it('does not split a short code at all', () => {
    expect(buildImageUrl('96385074', front('en', '2'))).toBe(
      'https://images.openfoodfacts.org/images/products/96385074/front_en.2.200.jpg',
    );
  });

  it('prefers English when OFF has it', () => {
    const images = {
      selected: { front: { fr: { rev: '2' }, en: { rev: '9' }, de: { rev: '3' } } },
    };
    expect(buildImageUrl('0000101209159', images)).toContain('front_en.9.');
  });

  // A picture of the pack is useful whatever the label language.
  it('falls back to whatever language is present', () => {
    expect(buildImageUrl('0000101209159', front('de', '5'))).toContain('front_de.5.');
  });

  // OFF sends rev as a string in some rows and a number in others.
  it('accepts a numeric revision', () => {
    expect(buildImageUrl('0000101209159', front('en', 12))).toContain('front_en.12.');
  });

  it.each([
    ['no images at all', undefined],
    ['an empty images object', {}],
    ['no selected front', { selected: { ingredients: { en: { rev: '1' } } } }],
    ['a selected front with no revision', { selected: { front: { en: { imgid: '1' } } } }],
  ])('returns null for %s', (_label, images) => {
    expect(buildImageUrl('0000101209159', images)).toBeNull();
  });

  it('returns null with no code to build a path from', () => {
    expect(buildImageUrl(null, front('en', '4'))).toBeNull();
  });
});

describe('parseOffLine', () => {
  it('parses a plain row completely', () => {
    const products = importedProducts();
    const cornFlakes = products.get('0038000138416')!;

    expect(cornFlakes).toMatchObject({
      name: 'Corn Flakes',
      brands: "Kellogg's",
      quantityRaw: '345 g',
      packQuantity: '345',
      packUnitToken: 'g',
      nutriscoreGrade: 'c',
    });
    expect(cornFlakes.countriesTags).toContain('en:united-states');
    expect(cornFlakes.categoriesTags).toContain('en:breakfast-cereals');
  });

  it('prefers the English name where OFF has one', () => {
    const nutella = importedProducts().get('3017620422003')!;
    expect(nutella.name).toBe('Nutella Hazelnut Spread');
  });

  it('derives the image URL from the fixture images object', () => {
    const nutella = importedProducts().get('3017620422003')!;
    expect(nutella.imageSmallUrl).toBe(
      'https://images.openfoodfacts.org/images/products/301/762/042/2003/front_en.4.200.jpg',
    );
  });

  it('leaves the image null on a product with no picture', () => {
    expect(importedProducts().get('0001234000057')!.imageSmallUrl).toBeNull();
  });

  // A 12-digit US barcode has to normalize on the way in, or a scan of the
  // physical pack — which reads as UPC-A — never finds the row.
  it('stores a 12-digit UPC under its padded 13-digit form', () => {
    const products = importedProducts();
    expect(products.has('0041196010184')).toBe(true);
    expect(products.has('041196010184')).toBe(false);
  });

  it('expands a UPC-E row the same way', () => {
    expect(importedProducts().has('0001234000057')).toBe(true);
  });

  describe('nutriments', () => {
    it('keeps the per-100g values', () => {
      const nutella = importedProducts().get('3017620422003')!;
      expect(nutella.nutriments).toEqual({
        'energy-kcal_100g': 539,
        'fat_100g': 30.9,
        'saturated-fat_100g': 10.6,
        'carbohydrates_100g': 57.5,
        'sugars_100g': 56.3,
        'fiber_100g': 0,
        'proteins_100g': 6.3,
        'salt_100g': 0.107,
        'sodium_100g': 0.0428,
      });
    });

    // The dump carries per-serving and scoring keys too. Storing all of them
    // for two million rows is a large multiple of the useful data.
    it('drops the keys that are not per-100g', () => {
      const cornFlakes = importedProducts().get('0038000138416')!;
      expect(cornFlakes.nutriments).not.toHaveProperty('energy-kcal_serving');
      expect(cornFlakes.nutriments).not.toHaveProperty('nutrition-score-fr_100g');
      expect(cornFlakes.nutriments['energy_100g']).toBe(1494);
    });

    // OFF sends numbers as strings in some rows and empty strings for "not
    // filled in". An empty string coerces to 0, which would be a nutrition
    // claim nobody made.
    it('coerces numeric strings and drops empty ones', () => {
      const water = importedProducts().get('3274080005003')!;
      expect(water.nutriments['salt_100g']).toBe(0.0132);
      expect(water.nutriments).not.toHaveProperty('sodium_100g');
    });

    it('keeps a genuine zero, which is not the same as absent', () => {
      const water = importedProducts().get('3274080005003')!;
      expect(water.nutriments['energy-kcal_100g']).toBe(0);
    });
  });

  describe('rows it declines', () => {
    it.each([
      ['no barcode', 'no-barcode'],
      ['no name', 'no-name'],
    ])('skips a row with %s', (_label, reason) => {
      const reasons = fixtureLines()
        .map((line) => parseOffLine(line))
        .filter((result) => !result.ok)
        .map((result) => (result as { reason: string }).reason);
      expect(reasons).toContain(reason);
    });

    // One bad line a few million into a twenty-minute import must not end it.
    it('reports a truncated line rather than throwing', () => {
      const result = parseOffLine('{"code":"123","product_name":"nope"');
      expect(result).toEqual({ ok: false, reason: 'unparseable-json' });
    });

    it('is not fooled by an empty or whitespace line', () => {
      expect(parseOffLine('   ').ok).toBe(false);
    });
  });

  describe('country filter', () => {
    it('keeps only rows tagged with a wanted country', () => {
      const american = importedProducts(['en:united-states']);
      // Tagged for France and the Netherlands respectively.
      expect(american.has('3274080005003')).toBe(false);
      expect(american.has('8712566441174')).toBe(false);
      expect(american.has('0038000138416')).toBe(true);
    });

    it('keeps a multi-country row that includes the wanted one', () => {
      expect(importedProducts(['en:united-states']).has('3017620422003')).toBe(true);
    });

    it('keeps everything when the filter is empty', () => {
      expect(importedProducts().has('3274080005003')).toBe(true);
    });
  });

  /**
   * The app's governing rule, applied here: a pack size that will not parse
   * leaves `packQuantity` null and keeps `quantityRaw`, so the screen can still
   * show "a family size box" as text. It never becomes a number nobody meant.
   */
  it('keeps the raw text when the pack size will not parse', () => {
    const oatmeal = importedProducts().get('0018000001309')!;
    expect(oatmeal.quantityRaw).toBe('a family size box');
    expect(oatmeal.packQuantity).toBeNull();
    expect(oatmeal.packUnitToken).toBeNull();
  });

  // "unknown" and "" are OFF's ways of saying a grade was never computed.
  it.each([
    ['0041196010184', 'unknown'],
    ['0001234000057', 'an empty string'],
    ['3274080005003', 'null'],
  ])('reads the nutriscore of %s (%s) as absent', (barcode) => {
    expect(importedProducts().get(barcode)!.nutriscoreGrade).toBeNull();
  });

  it('reads a blank brand as absent rather than an empty string', () => {
    expect(importedProducts().get('0001234000057')!.brands).toBeNull();
  });
});
