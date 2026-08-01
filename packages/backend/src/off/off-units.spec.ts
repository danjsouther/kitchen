import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SYSTEM_HOUSEHOLD_ID } from '@kitchen/shared-types';

import { buildUnitTokenMap, resolveUnitToken, type MatchableUnit } from './off-units';

/**
 * The real seeded units, read from the same JSON the seeder loads.
 *
 * Using the actual seed rather than a handful of invented rows is the point: a
 * unit renamed or removed there should break this test, because it would
 * silently stop resolving on the next import otherwise.
 */
const SEED = resolve(__dirname, '../../prisma/seed/data/units.json');

function seededUnits(): MatchableUnit[] {
  const rows = JSON.parse(readFileSync(SEED, 'utf8')) as Array<{
    name: string;
    plural: string;
    abbrev: string | null;
  }>;
  return rows.map((row, index) => ({ id: index + 1, householdId: SYSTEM_HOUSEHOLD_ID, ...row }));
}

describe('buildUnitTokenMap', () => {
  const units = seededUnits();
  const map = buildUnitTokenMap(units);
  const idOf = (name: string) => units.find((unit) => unit.name === name)!.id;

  it.each([
    ['g', 'gram'],
    ['kg', 'kilogram'],
    ['mg', 'milligram'],
    ['oz', 'ounce'],
    ['lb', 'pound'],
    ['ml', 'millilitre'],
    ['l', 'litre'],
    ['dl', 'decilitre'],
    ['fl oz', 'fluid ounce'],
  ])('resolves the OFF token %p to %s', (token, unitName) => {
    expect(resolveUnitToken(map, token)).toBe(idOf(unitName));
  });

  it('resolves a unit by its own name and plural too', () => {
    expect(resolveUnitToken(map, 'gram')).toBe(idOf('gram'));
    expect(resolveUnitToken(map, 'grams')).toBe(idOf('gram'));
  });

  it('is case-insensitive, since OFF writes "1,5 L"', () => {
    expect(resolveUnitToken(map, 'L')).toBe(idOf('litre'));
  });

  /**
   * There is no centilitre in the seed, and inventing a mapping to millilitres
   * would be a conversion this table has no business doing. An unresolved token
   * means the pack size is dropped and `quantityRaw` kept — the app's usual
   * rule, applied to unit data.
   */
  it('returns null for a unit the seed does not have', () => {
    expect(resolveUnitToken(map, 'cl')).toBeNull();
  });

  it.each([null, '', 'furlong', 'per 100g'])('returns null for %p', (token) => {
    expect(resolveUnitToken(map, token)).toBeNull();
  });

  /**
   * Products are global. A household's private "cup" that converts differently
   * must never end up on a row every other household reads, so the filtering
   * lives in the builder where no caller can forget it.
   */
  it('ignores household-private units entirely', () => {
    const withPrivate = buildUnitTokenMap([
      ...units,
      { id: 9001, householdId: 42, name: 'gram', plural: 'grams', abbrev: 'g' },
      { id: 9002, householdId: 42, name: 'schooner', plural: 'schooners', abbrev: 'sch' },
    ]);

    expect(resolveUnitToken(withPrivate, 'g')).toBe(idOf('gram'));
    expect(resolveUnitToken(withPrivate, 'schooner')).toBeNull();
  });
});
