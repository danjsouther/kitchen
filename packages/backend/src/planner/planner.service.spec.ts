import { BadRequestException } from '@nestjs/common';

import { parseDate } from './planner.service';

describe('parseDate', () => {
  it('reads a plain calendar date', () => {
    expect(parseDate('2026-08-01', 'date').toISOString()).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });

  // Constructing from local parts would land on the previous day once converted
  // to UTC on any machine behind it — a Saturday dinner showing up on Friday.
  it('anchors to UTC regardless of the server timezone', () => {
    const date = parseDate('2026-08-01', 'date');
    expect(date.getUTCFullYear()).toBe(2026);
    expect(date.getUTCMonth()).toBe(7);
    expect(date.getUTCDate()).toBe(1);
    expect(date.getUTCHours()).toBe(0);
  });

  it('handles a leap day', () => {
    expect(parseDate('2028-02-29', 'date').toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  // Date would roll this into 1 March rather than rejecting it, which would
  // silently plan a meal for a day the user did not choose.
  it('rejects a date that does not exist', () => {
    expect(() => parseDate('2026-02-30', 'date')).toThrow(BadRequestException);
    expect(() => parseDate('2027-02-29', 'date')).toThrow(/not a real date/);
  });

  it('rejects an out-of-range month or day', () => {
    expect(() => parseDate('2026-13-01', 'date')).toThrow(/not a real date/);
    expect(() => parseDate('2026-00-10', 'date')).toThrow(/not a real date/);
  });

  it('rejects anything that is not a plain date', () => {
    for (const value of ['2026-8-1', '01/08/2026', '2026-08-01T12:00:00Z', 'tomorrow', '']) {
      expect(() => parseDate(value, 'date')).toThrow(BadRequestException);
    }
  });

  it('names the field it was checking', () => {
    expect(() => parseDate('nope', 'from')).toThrow(/from must be a date/);
  });
});
