/**
 * Regression tests for the two hazards introduced by writing each batch as one
 * multi-row upsert instead of per-row Prisma upserts.
 *
 * That change was forced by memory — the per-row version exhausted a 4 GB heap
 * partway through a real import — and it is not going back, so these two
 * properties have to hold.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { dedupeByBarcode, mayMatchCountry } from './off-batch';
import { parseOffLine, type ParsedOffProduct } from './off-row';

const FIXTURE = resolve(__dirname, '../../prisma/seed/off-fixtures/products.jsonl');
const US = ['en:united-states'];

function product(barcode: string, name: string): ParsedOffProduct {
  return {
    barcode,
    name,
    brands: null,
    quantityRaw: null,
    packQuantity: null,
    packUnitToken: null,
    categoriesTags: [],
    countriesTags: [],
    imageSmallUrl: null,
    nutriments: {},
    nutriscoreGrade: null,
  };
}

describe('mayMatchCountry', () => {
  /**
   * The property the whole optimization rests on: **no false negatives.**
   *
   * The pre-filter runs before `JSON.parse` and `continue`s past anything it
   * rejects, so a line it wrongly rejects is silently dropped from the import —
   * a product that quietly never appears, with nothing to indicate why. Checked
   * against every fixture line rather than a hand-picked few.
   */
  it('never rejects a line the real parser would accept', () => {
    const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim() !== '');

    for (const line of lines) {
      if (parseOffLine(line, US).ok) {
        expect(mayMatchCountry(line, US)).toBe(true);
      }
    }
  });

  it('rejects a line with none of the wanted tags', () => {
    const line = JSON.stringify({ code: '1', countries_tags: ['en:france'] });
    expect(mayMatchCountry(line, US)).toBe(false);
  });

  it('accepts a line carrying the tag among others', () => {
    const line = JSON.stringify({
      code: '1',
      countries_tags: ['en:france', 'en:united-states'],
    });
    expect(mayMatchCountry(line, US)).toBe(true);
  });

  it('accepts any of several wanted countries', () => {
    const line = JSON.stringify({ code: '1', countries_tags: ['en:canada'] });
    expect(mayMatchCountry(line, ['en:united-states', 'en:canada'])).toBe(true);
  });

  // --all
  it('keeps everything when the filter is empty', () => {
    expect(mayMatchCountry('{"code":"1"}', [])).toBe(true);
  });

  /**
   * False positives are allowed and cost only a parse — the real check against
   * the parsed `countries_tags` still runs and rejects this.
   */
  it('may accept a line that only mentions the tag elsewhere, which is harmless', () => {
    const line = JSON.stringify({
      code: '1',
      product_name: 'imported from en:united-states',
      countries_tags: ['en:france'],
    });

    expect(mayMatchCountry(line, US)).toBe(true);
    expect(parseOffLine(line, US)).toEqual({ ok: false, reason: 'country-filtered' });
  });
});

describe('dedupeByBarcode', () => {
  /**
   * Postgres refuses a multi-row upsert that touches the same key twice, and
   * refuses the *whole statement* — so without this, one duplicated barcode
   * takes 500 good rows down with it.
   */
  it('collapses repeated barcodes', () => {
    const rows = dedupeByBarcode([
      product('0000000000017', 'first'),
      product('0000000000024', 'other'),
      product('0000000000017', 'second'),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.barcode)).toEqual(['0000000000017', '0000000000024']);
  });

  // The export is append-ordered, so a later row is the more recent statement.
  it('keeps the last occurrence', () => {
    const rows = dedupeByBarcode([
      product('0000000000017', 'stale'),
      product('0000000000017', 'fresh'),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('fresh');
  });

  it('leaves a batch with no duplicates untouched', () => {
    const batch = [product('0000000000017', 'a'), product('0000000000024', 'b')];
    expect(dedupeByBarcode(batch)).toEqual(batch);
  });

  it('handles an empty batch', () => {
    expect(dedupeByBarcode([])).toEqual([]);
  });

  /**
   * The case that makes this more than theoretical. `normalizeBarcode`
   * deliberately maps a 12-digit UPC-A and its 13-digit EAN form onto the same
   * key — that is what makes scanning a US pack work at all — so two distinct
   * lines in the export genuinely collide here.
   */
  it('collapses a UPC-A and EAN-13 form of the same product', () => {
    const upcA = parseOffLine(
      JSON.stringify({ code: '012345678905', product_name: 'UPC-A form' }),
    );
    const ean13 = parseOffLine(
      JSON.stringify({ code: '0012345678905', product_name: 'EAN-13 form' }),
    );

    expect(upcA.ok && ean13.ok).toBe(true);
    if (!upcA.ok || !ean13.ok) return;
    expect(upcA.product.barcode).toBe(ean13.product.barcode);

    expect(dedupeByBarcode([upcA.product, ean13.product])).toHaveLength(1);
  });
});
