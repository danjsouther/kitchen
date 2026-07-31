import Decimal from 'decimal.js';

import { EXPIRY_SOON_DAYS, adjustmentEntries, expiryStatus } from './pantry.service';

const GRAM = 1;
const KILOGRAM = 2;

function change(before: [string, number], after: [string, number]) {
  return adjustmentEntries({
    before: { quantity: new Decimal(before[0]), unitId: before[1] },
    after: { quantity: new Decimal(after[0]), unitId: after[1] },
  });
}

function summarise(entries: Array<{ delta: Decimal; unitId: number }>) {
  return entries.map((entry) => [entry.delta.toString(), entry.unitId]);
}

describe('adjustmentEntries', () => {
  it('records an increase as a positive delta', () => {
    expect(summarise(change(['500', GRAM], ['800', GRAM]))).toEqual([['300', GRAM]]);
  });

  it('records a decrease as a negative delta', () => {
    expect(summarise(change(['500', GRAM], ['200', GRAM]))).toEqual([['-300', GRAM]]);
  });

  // A no-op edit — renaming a brand, moving a shelf — should not leave a trail of
  // zero-delta rows that make the history unreadable.
  it('writes nothing when the quantity did not move', () => {
    expect(change(['500', GRAM], ['500', GRAM])).toEqual([]);
  });

  it('records emptying a lot', () => {
    expect(summarise(change(['500', GRAM], ['0', GRAM]))).toEqual([['-500', GRAM]]);
  });

  // Subtracting grams from cups is not arithmetic. The whole old amount leaves in
  // the old unit and the whole new amount arrives in the new one, so every unit's
  // column in the ledger still adds up on its own.
  it('splits a unit change into an out and an in', () => {
    expect(summarise(change(['1000', GRAM], ['1', KILOGRAM]))).toEqual([
      ['-1000', GRAM],
      ['1', KILOGRAM],
    ]);
  });

  it('does not emit a zero leg when the old lot was already empty', () => {
    expect(summarise(change(['0', GRAM], ['1', KILOGRAM]))).toEqual([['1', KILOGRAM]]);
  });

  it('does not emit a zero leg when the new quantity is zero', () => {
    expect(summarise(change(['500', GRAM], ['0', KILOGRAM]))).toEqual([['-500', GRAM]]);
  });

  it('keeps fractional quantities exact', () => {
    expect(summarise(change(['0.3333', GRAM], ['0.1111', GRAM]))).toEqual([
      ['-0.2222', GRAM],
    ]);
  });
});

describe('expiryStatus', () => {
  const now = new Date('2026-07-30T12:00:00Z');
  const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

  it('reports lots with no date as none', () => {
    expect(expiryStatus(null, now)).toBe('none');
  });

  it('reports a past date as expired', () => {
    expect(expiryStatus(at('2026-07-29'), now)).toBe('expired');
  });

  // Today's date counts as expired: something dated today is not something to
  // plan a meal around tomorrow.
  it('reports today as expired', () => {
    expect(expiryStatus(now, now)).toBe('expired');
  });

  it('reports a date inside the warning window as soon', () => {
    expect(expiryStatus(at('2026-08-02'), now)).toBe('soon');
  });

  it('includes the last day of the window', () => {
    expect(expiryStatus(at('2026-08-06'), now)).toBe('soon');
    expect(EXPIRY_SOON_DAYS).toBe(7);
  });

  it('reports a date beyond the window as ok', () => {
    expect(expiryStatus(at('2026-08-30'), now)).toBe('ok');
  });
});
