import { normalizeBarcode } from './barcode';

describe('normalizeBarcode', () => {
  it('keeps a 13-digit EAN as it is', () => {
    expect(normalizeBarcode('3017620422003')).toBe('3017620422003');
  });

  it('strips the punctuation and whitespace scanners and people add', () => {
    expect(normalizeBarcode(' 3017-6204-22003 \n')).toBe('3017620422003');
  });

  // The case that makes American barcodes work at all: the pack scans as
  // 12-digit UPC-A, OFF stores the same product as EAN-13 with a leading zero.
  it('pads a 12-digit UPC-A to 13', () => {
    expect(normalizeBarcode('041196010184')).toBe('0041196010184');
  });

  /**
   * The four GS1 expansion cases, one each. Written as `N S1..S6 C` and expanded
   * by the rule the last digit selects — these are derived from the table, not
   * from running the code, which is the only way this test can catch the
   * implementation drifting.
   *
   *   S6 = 0,1,2  ->  N S1 S2 S6 0 0 0 0 S3 S4 S5 C
   *   S6 = 3      ->  N S1 S2 S3 0 0 0 0 0 S4 S5 C
   *   S6 = 4      ->  N S1 S2 S3 S4 0 0 0 0 0 S5 C
   *   S6 = 5..9   ->  N S1 S2 S3 S4 S5 0 0 0 0 S6 C
   *
   * Each result is then left-padded to the 13-digit EAN form OFF stores.
   */
  it.each([
    // S6=0: 0 | 12 0 0000 013 | 6
    ['01201306', '0012000000136'],
    // S6=3: 0 | 123 00000 45 | 4
    ['01234534', '0012300000454'],
    // S6=4: 0 | 1234 00000 5 | 3
    ['01234543', '0012340000053'],
    // S6=5: 0 | 01234 0000 5 | 7
    ['00123457', '0001234000057'],
  ])('expands UPC-E %s to the UPC-A the GS1 table gives', (input, expected) => {
    expect(normalizeBarcode(input)).toBe(expected);
  });

  // EAN-8 is a real 8-digit code, not a compressed UPC-A. Systems other than
  // 0 and 1 are not compressible, so reshaping one would invent a barcode.
  it('leaves a non-compressible 8-digit code alone', () => {
    expect(normalizeBarcode('96385074')).toBe('96385074');
  });

  it('leaves unusual lengths alone rather than guessing at them', () => {
    expect(normalizeBarcode('12345')).toBe('12345');
    expect(normalizeBarcode('12345678901234')).toBe('12345678901234');
  });

  it.each([null, undefined, '', '   ', 'not a barcode'])(
    'returns null for %p',
    (input) => {
      expect(normalizeBarcode(input)).toBeNull();
    },
  );

  // The scan path and the import path must agree on identity, or a scanned
  // product misses a row that is sitting in the table.
  it('is idempotent, so normalizing twice cannot drift', () => {
    for (const code of ['041196010184', '00123457', '3017620422003', '96385074']) {
      const once = normalizeBarcode(code)!;
      expect(normalizeBarcode(once)).toBe(once);
    }
  });
});
