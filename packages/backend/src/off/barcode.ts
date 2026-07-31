/**
 * Barcode normalization, shared by the import CLI and the API.
 *
 * There is exactly one normalizer on purpose. A barcode is a primary key here,
 * so if the importer and the lookup disagreed about what "the same barcode"
 * means — one keeping a leading zero the other strips — every scan of an
 * affected product would miss a row that is sitting right there.
 */

/**
 * Reduces a scanned or typed barcode to the digits-only form stored as
 * `Product.barcode`, or returns null when there is nothing usable in it.
 *
 * What it does, and why each step:
 *
 * - **Strips everything that is not a digit.** Scanners and OFF exports both
 *   emit stray whitespace, and people typing from a packet add hyphens.
 * - **Left-pads 12-digit UPC-A to 13.** A US pack scans as UPC-A and OFF stores
 *   the same product as EAN-13 with a leading zero. Without this every American
 *   barcode misses.
 * - **Expands 8-digit UPC-E to its UPC-A form**, then pads that, for the same
 *   reason: small packs scan short and are stored long.
 * - **Leaves other lengths alone.** EAN-8 is genuinely 8 digits, and a code of
 *   an unexpected length is more likely a real oddity in the data than
 *   something to reshape into a guess.
 *
 * The check digit is deliberately *not* verified. A mis-scan produces a code
 * that finds nothing, which is already the right outcome; rejecting outright
 * would only turn "no product found, add it by hand" into an error message.
 */
export function normalizeBarcode(input: string | null | undefined): string | null {
  if (!input) return null;

  const digits = input.replace(/\D/g, '');
  if (digits.length === 0) return null;

  if (digits.length === 8) {
    const expanded = expandUpcE(digits);
    if (expanded) return expanded.padStart(13, '0');
    return digits;
  }

  if (digits.length === 12) return digits.padStart(13, '0');

  return digits;
}

/**
 * Expands a UPC-E code to the equivalent 12-digit UPC-A.
 *
 * UPC-E compresses a UPC-A that contains a run of zeroes; the last digit before
 * the check digit says where they were removed from. The six cases below are
 * the GS1 table, not a heuristic. Returns null for anything that is not a
 * zero-system UPC-E, since only systems 0 and 1 are compressible and anything
 * else is an 8-digit code of a different kind (EAN-8), which must be left as-is.
 */
function expandUpcE(code: string): string | null {
  const system = code[0];
  if (system !== '0' && system !== '1') return null;

  const check = code[7];
  const body = code.slice(1, 7);
  const manufacturer = body.slice(0, 5);
  const mode = body[5];

  let expanded: string;
  switch (mode) {
    case '0':
    case '1':
    case '2':
      expanded =
        manufacturer.slice(0, 2) + mode + '0000' + manufacturer.slice(2, 5);
      break;
    case '3':
      expanded = manufacturer.slice(0, 3) + '00000' + manufacturer.slice(3, 5);
      break;
    case '4':
      expanded = manufacturer.slice(0, 4) + '00000' + manufacturer.slice(4, 5);
      break;
    default:
      // 5-9: the last digit is itself part of the product number.
      expanded = manufacturer + '0000' + mode;
      break;
  }

  return system + expanded + check;
}
