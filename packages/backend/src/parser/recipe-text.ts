/**
 * Reading a recipe out of pasted text.
 *
 * Everything here is pure and takes its vocabulary as an argument, so it can be
 * tested against real pasted recipes without a database.
 *
 * The design assumption is that **this is often wrong**. Recipes on the web are
 * written for people, not parsers, and no set of rules survives contact with all
 * of them. So the output is a *proposal*: every line keeps its original text, is
 * marked with how confident the parse is, and lands on a review screen where
 * correcting a row must be faster than typing it from scratch. Nothing here
 * persists anything.
 */

import Decimal from 'decimal.js';
import { parseQuantity, slugify } from '@recipes/shared-types';

export const LineKind = {
  INGREDIENT: 'INGREDIENT',
  STEP: 'STEP',
  /** A section heading — "For the sauce" — that groups the lines beneath it. */
  GROUP: 'GROUP',
} as const;
export type LineKind = (typeof LineKind)[keyof typeof LineKind];

export interface ParsedIngredient {
  kind: typeof LineKind.INGREDIENT;
  rawText: string;
  quantity: string | null;
  /** The unit token as written ("cups"), before it is resolved to a Unit row. */
  unitToken: string | null;
  unitId: number | null;
  /** What is left after quantity and unit — the thing to match against the catalog. */
  name: string;
  preparation: string | null;
  groupLabel: string | null;
  /** True when the source said "1-2 onions"; the lower bound was taken. */
  isRange: boolean;
  /** True when "a pinch of salt" was read as one pinch rather than no amount. */
  inferredQuantity: boolean;
  optional: boolean;
}

export interface ParsedStep {
  kind: typeof LineKind.STEP;
  text: string;
}

export interface ParsedRecipeText {
  title: string | null;
  ingredients: ParsedIngredient[];
  steps: ParsedStep[];
  /** Lines that were dropped, so the review screen can offer them back. */
  ignored: string[];
}

/** Maps a written unit token to a unit id. Built from the household's catalog. */
export type UnitLexicon = Map<string, number>;

const INGREDIENT_HEADINGS = /^(ingredients?|you will need|shopping list)\s*:?\s*$/i;
const STEP_HEADINGS =
  /^(instructions?|directions?|method|steps?|preparation|to serve)\s*:?\s*$/i;
/** "For the sauce", "For the topping" — a group label, not a heading to skip. */
const GROUP_HEADING = /^for the\s+(.{1,60}?)\s*:?\s*$/i;
const NOTES_HEADING = /^(notes?|tips?|nutrition|yield|serves|prep time|cook time)\b/i;

/** A leading "1.", "2)", or a bullet — decoration around the real content. */
const LIST_MARKER = /^\s*(?:[-*•·]|\d{1,2}\s*[.)])\s+/;

const OPTIONAL_MARKER = /\boptional\b/i;

/** Words that mean "an unspecified amount", which is not a quantity. */
const VAGUE_QUANTITY = /^(?:a|an|some|few)\s+/i;

/**
 * Splits pasted text into a title, ingredient lines and steps.
 *
 * Explicit headings are trusted when present, because almost every pasted recipe
 * has them and they are far more reliable than guessing. Without them each line
 * is scored on its own — see `looksLikeIngredient`.
 */
export function parseRecipeText(input: string, units: UnitLexicon): ParsedRecipeText {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const ingredients: ParsedIngredient[] = [];
  const steps: ParsedStep[] = [];
  const ignored: string[] = [];

  let title: string | null = null;
  let section: 'unknown' | 'ingredients' | 'steps' = 'unknown';
  let groupLabel: string | null = null;
  let sawHeading = false;

  for (const [index, line] of lines.entries()) {
    if (INGREDIENT_HEADINGS.test(line)) {
      section = 'ingredients';
      groupLabel = null;
      sawHeading = true;
      continue;
    }
    if (STEP_HEADINGS.test(line)) {
      section = 'steps';
      groupLabel = null;
      sawHeading = true;
      continue;
    }

    const group = GROUP_HEADING.exec(line);
    if (group) {
      groupLabel = titleCase(group[1]);
      // A "For the sauce" heading implies ingredients follow, but only when we
      // have not already been told we are in the steps.
      if (section === 'unknown') section = 'ingredients';
      continue;
    }

    if (title === null && index === 0 && looksLikeTitle(line, units)) {
      title = line.trim();
      continue;
    }

    if (NOTES_HEADING.test(line)) {
      ignored.push(line);
      continue;
    }

    const isIngredient =
      section === 'ingredients'
        ? true
        : section === 'steps'
          ? false
          : looksLikeIngredient(line, units);

    if (isIngredient) {
      ingredients.push(parseIngredientLine(line, units, groupLabel));
    } else {
      steps.push({ kind: LineKind.STEP, text: stripMarker(line) });
    }

    // Without headings, the first step-looking line ends the ingredient list:
    // recipes do not go back to listing ingredients after the method starts.
    if (!sawHeading && !isIngredient && section === 'unknown') {
      section = 'steps';
    }
  }

  return { title, ingredients, steps, ignored };
}

/**
 * Decides whether the first line is the recipe's name.
 *
 * Being "not an ingredient" is not enough — a paste that starts straight into
 * "1. Preheat the oven..." would lose its first step to the title. A title is
 * short, carries no list marker, and does not end like a sentence.
 */
export function looksLikeTitle(line: string, units: UnitLexicon): boolean {
  const text = line.trim();
  if (LIST_MARKER.test(text)) return false;
  if (/[.!?]\s*$/.test(text)) return false;
  if (text.split(/\s+/).filter(Boolean).length > 10) return false;
  return !looksLikeIngredient(text, units);
}

/**
 * Decides whether a line is an ingredient rather than a step, without headings.
 *
 * The signals that actually separate them: ingredient lines start with an amount
 * and are short; steps are sentences. "1. Whisk the flour and eggs together
 * until smooth." starts with a digit too, which is why the list marker is
 * stripped before anything else is considered.
 */
export function looksLikeIngredient(line: string, units: UnitLexicon): boolean {
  const text = stripMarker(line);
  const words = text.split(/\s+/).filter(Boolean);

  // Sentences are steps, whatever they start with.
  if (words.length > 12) return false;
  if (/[.!?]\s*$/.test(text) && words.length > 6) return false;

  const first = words[0]?.toLowerCase() ?? '';
  const startsWithAmount = /^[\d¼½¾⅓⅔⅛⅜⅝⅞]/.test(first);
  if (startsWithAmount) return true;

  // "Salt and pepper to taste" — no amount, but unmistakably an ingredient.
  if (/\bto taste\b/i.test(text)) return true;

  // A unit word early in a short line: "pinch of saffron", "handful of parsley".
  if (words.length <= 8 && words.slice(0, 2).some((word) => units.has(normalise(word)))) {
    return true;
  }

  return false;
}

/**
 * Pulls quantity, unit, name and preparation out of one ingredient line.
 *
 * Ranges ("1-2 onions") take the **lower** bound and set `isRange`. Taking the
 * lower bound means a shopping list under-buys rather than over-buys, and the
 * flag lets the review screen show that a choice was made.
 */
export function parseIngredientLine(
  line: string,
  units: UnitLexicon,
  groupLabel: string | null = null,
): ParsedIngredient {
  const rawText = line.trim();
  let working = stripMarker(rawText);

  const optional = OPTIONAL_MARKER.test(working);
  if (optional) {
    working = working.replace(/[,(]?\s*\boptional\b\s*[)]?/i, ' ').trim();
  }

  const { quantity, isRange, rest: afterQuantity } = takeQuantity(working);
  const { unitToken, unitId, rest: afterUnit } = takeUnit(afterQuantity, units);
  const { name, preparation } = splitPreparation(afterUnit);

  // A unit with no number in front of it means one of them: "a pinch of salt"
  // and "pinch of salt" are both one pinch. Leaving the quantity null here would
  // emit a unit without an amount, which is not a measurement anyone can scale
  // or subtract from the pantry — and which the create-recipe endpoint rejects.
  const inferredQuantity = quantity === null && unitId !== null;
  const resolved = inferredQuantity ? new Decimal(1) : quantity;

  return {
    kind: LineKind.INGREDIENT,
    rawText,
    quantity: resolved ? resolved.toString() : null,
    unitToken,
    unitId,
    name,
    preparation,
    groupLabel,
    isRange,
    inferredQuantity,
    optional,
  };
}

/** Reads a leading amount, including mixed numbers, fractions and ranges. */
function takeQuantity(text: string): {
  quantity: Decimal | null;
  isRange: boolean;
  rest: string;
} {
  // "1 1/2", "1 ½", "½", "1.5", "2" — optionally followed by a range partner.
  const pattern =
    /^((?:\d+\s+\d+\s*\/\s*\d+)|(?:\d+\s*\/\s*\d+)|(?:\d+(?:\.\d+)?\s*[¼½¾⅓⅔⅛⅜⅝⅞])|[¼½¾⅓⅔⅛⅜⅝⅞]|(?:\d+(?:\.\d+)?))/;

  const match = pattern.exec(text);
  if (!match) {
    // "a pinch of salt" is one pinch, but "a" is too weak a signal to record as
    // a number — leave it unquantified and let the reviewer decide.
    return { quantity: null, isRange: false, rest: text.replace(VAGUE_QUANTITY, '') };
  }

  const quantity = parseQuantity(match[1]);
  let rest = text.slice(match[0].length).trim();

  // A range: "1-2 onions", "1 to 2 tablespoons". Take the lower bound.
  let isRange = false;
  const range = /^(?:-|–|—|to)\s*(?:\d+(?:\.\d+)?|\d+\s*\/\s*\d+)/.exec(rest);
  if (range) {
    isRange = true;
    rest = rest.slice(range[0].length).trim();
  }

  return { quantity, isRange, rest };
}

/** Reads a leading unit word against the household's unit vocabulary. */
function takeUnit(
  text: string,
  units: UnitLexicon,
): { unitToken: string | null; unitId: number | null; rest: string } {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { unitToken: null, unitId: null, rest: '' };

  const candidate = normalise(words[0]);
  const unitId = units.get(candidate);
  if (unitId === undefined) return { unitToken: null, unitId: null, rest: text };

  let rest = words.slice(1).join(' ');
  // "2 cups of flour" — the "of" belongs to the unit phrase, not the name.
  rest = rest.replace(/^of\s+/i, '');

  return { unitToken: words[0], unitId, rest };
}

/**
 * Separates the ingredient name from how it is prepared.
 *
 * "2 large eggs, beaten" and "1 onion (finely chopped)" both name an ingredient
 * and then say what to do to it. Keeping them apart is what lets the name match
 * the catalog — "eggs, beaten" matches nothing.
 */
export function splitPreparation(text: string): {
  name: string;
  preparation: string | null;
} {
  const trimmed = text.trim();

  const parenthetical = /^(.*?)\s*\(([^)]*)\)\s*(.*)$/.exec(trimmed);
  if (parenthetical) {
    const name = `${parenthetical[1]} ${parenthetical[3]}`.trim();
    return { name: cleanName(name), preparation: parenthetical[2].trim() || null };
  }

  const comma = trimmed.indexOf(',');
  if (comma > 0) {
    return {
      name: cleanName(trimmed.slice(0, comma)),
      preparation: trimmed.slice(comma + 1).trim() || null,
    };
  }

  return { name: cleanName(trimmed), preparation: null };
}

/**
 * The slugs to try when resolving a name against the catalog, most specific
 * first. Exported so the resolver and its tests agree on the order.
 *
 * "2 large eggs, beaten" gives ["large eggs", "eggs", "large egg", "egg"] — the
 * full phrase first because the seed catalog carries aliases like "large egg",
 * then progressively less of it.
 */
export function nameCandidates(name: string): string[] {
  const cleaned = cleanName(name);
  if (!cleaned) return [];

  const words = cleaned.split(/\s+/).filter(Boolean);
  const phrases = [cleaned];

  // Drop leading modifiers one at a time: "large free-range eggs" -> "free-range
  // eggs" -> "eggs". The head noun is what the catalog is keyed on.
  for (let start = 1; start < words.length && start < 4; start += 1) {
    phrases.push(words.slice(start).join(' '));
  }

  return [...new Set(phrases.map((phrase) => slugify(phrase)).filter(Boolean))];
}

function cleanName(text: string): string {
  return text
    .replace(/^\s*of\s+/i, '')
    .replace(/[.;:]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripMarker(text: string): string {
  return text.replace(LIST_MARKER, '').trim();
}

function normalise(word: string): string {
  return word.toLowerCase().replace(/[.,]/g, '');
}

function titleCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
