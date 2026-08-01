/**
 * Pure matching logic for `match-off.cli.ts`.
 *
 * Mirrors `ParserService.matchName` (`../parser/parser.service.ts`) — exact
 * slug, then alias, then singularized slug, then trigram similarity — but
 * adapted for this script's shape: no household context (only global
 * ingredients are candidates, since this only ever writes under the system
 * household and `rankedConsensus` only ranks global ingredients anyway), and
 * driven off a preloaded in-memory catalog rather than one query per name.
 *
 * Split out from the CLI so it can be unit tested without a database, the
 * same way `off-batch.ts` and `off-row.ts` are split from `import-off.cli.ts`.
 */

import { matchCandidates } from '@kitchen/shared-types';

export const MatchKind = {
  EXACT: 'EXACT',
  ALIAS: 'ALIAS',
  SINGULAR: 'SINGULAR',
  FUZZY: 'FUZZY',
  NONE: 'NONE',
} as const;
export type MatchKind = (typeof MatchKind)[keyof typeof MatchKind];

export interface CatalogIngredient {
  id: number;
  name: string;
  slug: string;
}

export interface MatchResult {
  kind: MatchKind;
  confidence: number;
  ingredientId: number;
  name: string;
  slug: string;
}

/** Ingredient lookup by slug, and alias lookup by alias-slug pointing at its ingredient. */
export type IngredientsBySlug = ReadonlyMap<string, CatalogIngredient>;
export type AliasesBySlug = ReadonlyMap<string, CatalogIngredient>;

/**
 * Splits a product name into the phrases worth trying against the catalog.
 *
 * Retail names are noisy ("Quaker Old Fashioned Oats, 42 oz") compared to the
 * short phrases `nameCandidates` (recipe-text.ts) was built for, and rarely
 * equal a single ingredient slug outright. So this tries the whole name, then
 * each individual word, then each adjacent word pair — cheap because the
 * catalog side is a hash lookup, and it's what turns "Old Fashioned Oats" into
 * a hit on the word "oats" even though the full phrase never matches.
 */
export function productNamePhrases(name: string): string[] {
  const cleaned = name.replace(/[,;].*$/, '').trim();
  if (!cleaned) return [];

  const words = cleaned.split(/\s+/).filter(Boolean);
  const phrases = [cleaned];

  for (let i = 0; i < words.length; i += 1) {
    phrases.push(words[i]);
    if (i + 1 < words.length) phrases.push(`${words[i]} ${words[i + 1]}`);
  }

  return [...new Set(phrases)];
}

/**
 * Exact slug → alias → singularized slug cascade over every candidate phrase
 * in the product name. Order matters twice over: phrases are tried longest
 * (most specific) first, and within a phrase exact beats alias beats singular
 * — a real catalog entry should never lose to something that merely sounds
 * like it.
 */
export function matchBySlugOrAlias(
  productName: string,
  ingredientsBySlug: IngredientsBySlug,
  aliasesBySlug: AliasesBySlug,
): MatchResult | null {
  for (const phrase of productNamePhrases(productName)) {
    const [slug, singularSlug] = matchCandidates(phrase);

    const exact = ingredientsBySlug.get(slug);
    if (exact) return toResult(exact, MatchKind.EXACT, 1);

    const alias = aliasesBySlug.get(slug);
    if (alias) return toResult(alias, MatchKind.ALIAS, 0.95);

    if (singularSlug && singularSlug !== slug) {
      const singularExact = ingredientsBySlug.get(singularSlug);
      if (singularExact) return toResult(singularExact, MatchKind.SINGULAR, 0.9);

      const singularAlias = aliasesBySlug.get(singularSlug);
      if (singularAlias) return toResult(singularAlias, MatchKind.SINGULAR, 0.9);
    }
  }

  return null;
}

function toResult(ingredient: CatalogIngredient, kind: MatchKind, confidence: number): MatchResult {
  return {
    kind,
    confidence,
    ingredientId: ingredient.id,
    name: ingredient.name,
    slug: ingredient.slug,
  };
}

/** Builds a `MatchResult` from a trigram hit, for the CLI's batched SQL fallback. */
export function fuzzyResult(ingredient: CatalogIngredient, score: number): MatchResult {
  return toResult(ingredient, MatchKind.FUZZY, score);
}

/**
 * Whether a match is trustworthy enough to write unattended.
 *
 * EXACT/ALIAS/SINGULAR always qualify — they are a real catalog entry, just
 * reached by different routes. A FUZZY hit only qualifies above the caller's
 * threshold: the same 0.4 floor `ParserService.fuzzyMatch` uses is tuned for
 * "worth suggesting to a human", not "safe to write with nobody reviewing it".
 */
export function shouldWrite(match: MatchResult | null, fuzzyThreshold: number): boolean {
  if (!match) return false;
  if (match.kind === MatchKind.FUZZY) return match.confidence >= fuzzyThreshold;
  return true;
}
