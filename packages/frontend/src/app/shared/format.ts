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
 * A raw ingredient line with its own leading amount removed, when that amount
 * is recognisable — "2 cups dried beans" becomes "dried beans".
 *
 * An unmatched line has no catalog name, so `rawText` is the whole line and the
 * only text there is. Both the recipe screen and the recipe editor need the
 * name on its own: one to print an amount beside it rather than inside it, the
 * other to let the amount be edited without the stale one still sitting in the
 * text. They had better agree, hence one copy here.
 *
 * Several spellings are tried because the parser keeps the source wording:
 * "2 tsp salt", "2 teaspoons salt" and "2 teaspoon salt" all reduce to the same
 * quantity and unit, and only one of them is what `amountWithUnit` renders.
 * Anything unrecognised is left exactly as written — a wrong guess here would
 * silently delete part of an ingredient's name.
 */
export function withoutLeadingAmount(
  rawText: string,
  quantity: string | null,
  unit: UnitLike | null | undefined,
): string {
  const raw = rawText.trim();
  if (quantity === null) return raw;

  const amount = trimQuantity(quantity, 3);
  const candidates = unit
    ? [
        amountWithUnit(quantity, unit),
        `${amount} ${unit.abbrev ?? ''}`,
        `${amount} ${unit.plural ?? ''}`,
        `${amount} ${unit.name}`,
      ]
    : [amount];

  for (const candidate of candidates) {
    const prefix = candidate.trim();
    if (!prefix || !raw.toLowerCase().startsWith(prefix.toLowerCase())) continue;

    // Whole words only: "2" must not be shaved off "200 g", and "2 cup" must
    // not be shaved off "2 cupfuls".
    const rest = raw.slice(prefix.length);
    if (rest !== '' && !/^[\s,.]/.test(rest)) continue;

    const trimmed = rest.replace(/^[\s,.]+/, '');
    // Never leave the line nameless — "2 cups" on its own is all the text there
    // is, and an empty name would render a bare amount.
    if (trimmed) return trimmed;
  }

  return raw;
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
