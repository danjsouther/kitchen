/**
 * Batch preparation for the OFF import.
 *
 * Both functions here exist because the import writes a batch as one multi-row
 * `INSERT ... ON CONFLICT DO UPDATE` rather than as per-row upserts — a change
 * forced by memory, and one that brings two failure modes the per-row version
 * did not have. They live outside the CLI because the CLI runs `main()` on
 * import and cannot be loaded by a test.
 */

import type { ParsedOffProduct } from './off-row';

/**
 * Whether a raw line could possibly satisfy the country filter, without paying
 * for `JSON.parse`.
 *
 * `JSON.parse` on a full OFF row is the costliest thing in the import loop, and
 * under the default country filter most lines are parsed only to be discarded.
 * A substring test on the raw text is orders of magnitude cheaper.
 *
 * **Conservative by construction.** It may say yes to a line that turns out not
 * to match — the tag might appear in some other field — and that costs only a
 * parse, because the real check against `countries_tags` still runs. It can
 * never say no to a line that does match: if `countries_tags` contains
 * "en:united-states" then the raw JSON contains that substring.
 *
 * An empty filter means "keep everything", so everything may match.
 */
export function mayMatchCountry(line: string, countries: readonly string[]): boolean {
  if (countries.length === 0) return true;
  return countries.some((tag) => line.includes(tag));
}

/**
 * Collapses rows that share a barcode, keeping the last occurrence.
 *
 * Postgres refuses a multi-row upsert that touches the same key twice — "ON
 * CONFLICT DO UPDATE command cannot affect row a second time" — and it refuses
 * the *whole statement*, so one duplicated barcode would throw away every good
 * row in the batch alongside it.
 *
 * Duplicates are real rather than hypothetical. The export contains repeated
 * codes outright, and separately two different raw codes normalize to the same
 * barcode: a 12-digit UPC-A and its 13-digit EAN form are the same product, and
 * `normalizeBarcode` deliberately makes them equal.
 *
 * Last wins because the export is append-ordered, so a later row is the more
 * recent statement about that product.
 */
export function dedupeByBarcode(
  batch: readonly ParsedOffProduct[],
): ParsedOffProduct[] {
  const unique = new Map<string, ParsedOffProduct>();
  for (const product of batch) unique.set(product.barcode, product);
  return [...unique.values()];
}
