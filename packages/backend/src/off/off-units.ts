/**
 * Mapping Open Food Facts' unit tokens onto this app's seeded `Unit` rows.
 *
 * Kept separate from the importer and pure, because getting this wrong is
 * silent: resolving "oz" to the wrong row would store every American pack at
 * roughly a thirtieth of its real size and nothing downstream would notice.
 */

/** The minimum a unit row needs to be matchable. */
export interface MatchableUnit {
  id: number;
  householdId: number | null;
  name: string;
  plural: string;
  abbrev: string | null;
}

/**
 * OFF tokens that do not equal any seeded unit's name or abbreviation.
 *
 * "fl oz" is here because the seeded abbreviation carries a space and OFF
 * writes it several ways. "cl" is deliberately *absent*: there is no centilitre
 * in the seed, and inventing a mapping to millilitres would be a conversion
 * this table has no business performing. An unmapped token means the pack size
 * does not parse, which is the honest outcome.
 */
const TOKEN_ALIASES: Readonly<Record<string, string>> = {
  g: 'gram',
  kg: 'kilogram',
  mg: 'milligram',
  oz: 'ounce',
  lb: 'pound',
  ml: 'millilitre',
  l: 'litre',
  dl: 'decilitre',
  'fl oz': 'fluid ounce',
};

/**
 * Builds a token → unit id lookup from the units table.
 *
 * **Global rows only.** A household's private "cup" that converts differently
 * must never end up on a global product row, which every other household reads.
 * Callers pass the full table; this is where the filtering happens, so no caller
 * can forget it.
 */
export function buildUnitTokenMap(units: readonly MatchableUnit[]): Map<string, number> {
  const global = units.filter((unit) => unit.householdId === null);
  const byName = new Map<string, number>();

  for (const unit of global) {
    for (const key of [unit.name, unit.plural, unit.abbrev]) {
      if (key) byName.set(key.toLowerCase(), unit.id);
    }
  }

  const map = new Map<string, number>(byName);
  for (const [token, unitName] of Object.entries(TOKEN_ALIASES)) {
    const id = byName.get(unitName);
    if (id !== undefined) map.set(token, id);
  }

  return map;
}

/** Resolves one token, or null when the seed has no unit for it. */
export function resolveUnitToken(
  map: ReadonlyMap<string, number>,
  token: string | null,
): number | null {
  if (!token) return null;
  return map.get(token.toLowerCase()) ?? null;
}
