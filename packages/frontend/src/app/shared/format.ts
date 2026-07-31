/**
 * Display helpers shared by every screen that shows a quantity.
 *
 * These live in one place because they kept drifting: the recipe view, the
 * pantry and the cook screen each grew their own version, and two of them said
 * "3 clove" while the server-rendered one said "3 cloves".
 */

interface UnitLike {
  name: string;
  plural?: string;
  abbrev?: string | null;
}

/**
 * Trims a decimal string for display.
 *
 * Display only — the exact string the server sent is what any write sends back.
 * Rounding here and storing the result is how a recipe slowly drifts.
 */
export function trimQuantity(value: string, places = 2): string {
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) return value;
  const factor = 10 ** places;
  return String(Math.round(asNumber * factor) / factor);
}

/** The unit's short form, or its name pluralised to match the amount. */
export function unitLabel(unit: UnitLike | null | undefined, quantity: string | number): string {
  if (!unit) return '';
  if (unit.abbrev) return unit.abbrev;
  return Number(quantity) === 1 ? unit.name : (unit.plural ?? `${unit.name}s`);
}

/** "500 g", "3 cloves", "1.5" when there is no unit at all. */
export function amountWithUnit(
  quantity: string,
  unit: UnitLike | null | undefined,
): string {
  const amount = trimQuantity(quantity, 3);
  const label = unitLabel(unit, quantity);
  return label ? `${amount} ${label}` : amount;
}
