import { Inject, Injectable } from '@nestjs/common';
import { matchCandidates } from '@kitchen/shared-types';

import { PrismaService } from '../prisma/prisma.service';
import { requireHouseholdId } from '../common/household-context';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.service';
import {
  nameCandidates,
  parseRecipeText,
  type ParsedIngredient,
  type UnitLexicon,
} from './recipe-text';
import type { ParseRecipeDto } from './dto/parser.dto';

/**
 * How a name was resolved. The reviewer needs to know *why* a suggestion is
 * being made, because "an exact catalog match" and "something that looked a bit
 * like it" deserve very different amounts of trust.
 */
export const MatchKind = {
  EXACT: 'EXACT',
  ALIAS: 'ALIAS',
  SINGULAR: 'SINGULAR',
  FUZZY: 'FUZZY',
  NONE: 'NONE',
} as const;
export type MatchKind = (typeof MatchKind)[keyof typeof MatchKind];

/** Below this, a trigram hit is noise and is not offered at all. */
const FUZZY_FLOOR = 0.4;
/** Alternatives offered alongside the best guess, for the reviewer's picker. */
const MAX_ALTERNATIVES = 4;

export interface CatalogMatch {
  ingredientId: number;
  name: string;
  slug: string;
  score: number;
}

@Injectable()
export class ParserService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly raw: PrismaService,
  ) {}

  /**
   * Turns pasted text into a reviewable draft. **Persists nothing.**
   *
   * The response is deliberately shaped like the create-recipe payload with
   * extra advice attached, so the review screen can hand it straight back once
   * the human has corrected it.
   */
  async parse(dto: ParseRecipeDto) {
    const units = await this.unitLexicon();
    const parsed = parseRecipeText(dto.text, units);

    const ingredients = await Promise.all(
      parsed.ingredients.map((line) => this.resolveLine(line)),
    );

    return {
      title: dto.title?.trim() || parsed.title,
      servings: dto.servings ?? null,
      ingredients,
      steps: parsed.steps.map((step) => ({ text: step.text })),
      ignored: parsed.ignored,
      summary: {
        total: ingredients.length,
        resolved: ingredients.filter((line) => line.match.kind !== MatchKind.NONE).length,
        needsReview: ingredients.filter((line) => line.needsReview).length,
      },
    };
  }

  /**
   * Builds the token → unit id map the parser matches against.
   *
   * Names, plurals and abbreviations all point at the same unit, and the map is
   * built from the household's own catalog so a unit they invented is understood
   * on the very next paste.
   */
  private async unitLexicon(): Promise<UnitLexicon> {
    const units = await this.db.unit.findMany({
      select: { id: true, name: true, plural: true, abbrev: true },
    });

    const lexicon: UnitLexicon = new Map();
    for (const unit of units) {
      for (const token of [unit.name, unit.plural, unit.abbrev]) {
        if (token) lexicon.set(token.toLowerCase(), unit.id);
      }
    }
    return lexicon;
  }

  private async resolveLine(line: ParsedIngredient) {
    const match = await this.matchName(line.name);

    // Anything short of a clean hit gets flagged, plus any line where a choice
    // was made on the user's behalf.
    const needsReview =
      match.kind === MatchKind.NONE ||
      match.kind === MatchKind.FUZZY ||
      line.isRange ||
      (line.quantity !== null && line.unitId === null && !/\bto taste\b/i.test(line.rawText));

    return {
      rawText: line.rawText,
      quantity: line.quantity,
      unitId: line.unitId,
      unitToken: line.unitToken,
      name: line.name,
      preparation: line.preparation,
      groupLabel: line.groupLabel,
      optional: line.optional,
      isRange: line.isRange,
      inferredQuantity: line.inferredQuantity,
      ingredientId: match.best?.ingredientId ?? null,
      match,
      needsReview,
    };
  }

  /**
   * Resolves one name against the catalog, most trustworthy route first.
   *
   * Exact slug, then alias, then the singularised form, then trigram similarity.
   * The order matters more than the individual steps: stopping at the first hit
   * means a real catalog entry is never passed over in favour of something that
   * merely looks similar.
   */
  private async matchName(name: string): Promise<{
    kind: MatchKind;
    confidence: number;
    best: CatalogMatch | null;
    alternatives: CatalogMatch[];
  }> {
    const none = { kind: MatchKind.NONE, confidence: 0, best: null, alternatives: [] };

    const phrases = nameCandidates(name);
    if (phrases.length === 0) return none;

    // Each phrase and its singular: "large eggs" -> large-eggs, large-egg.
    const slugs = [...new Set(phrases.flatMap((phrase) => matchCandidates(phrase)))];

    const [bySlug, byAlias] = await Promise.all([
      this.db.ingredient.findMany({
        where: { slug: { in: slugs } },
        select: { id: true, name: true, slug: true, householdId: true },
      }),
      this.db.ingredientAlias.findMany({
        where: { slug: { in: slugs } },
        select: { slug: true, ingredient: { select: { id: true, name: true, slug: true } } },
      }),
    ]);

    // Walk the candidates in priority order rather than the results: the first
    // phrase is the most specific, and its match should win.
    for (const phrase of phrases) {
      for (const [index, slug] of matchCandidates(phrase).entries()) {
        const exact = preferOwnIngredient(bySlug.filter((row) => row.slug === slug));
        if (exact) {
          return {
            kind: index === 0 ? MatchKind.EXACT : MatchKind.SINGULAR,
            confidence: index === 0 ? 1 : 0.9,
            best: { ingredientId: exact.id, name: exact.name, slug: exact.slug, score: 1 },
            alternatives: [],
          };
        }

        const alias = byAlias.find((row) => row.slug === slug);
        if (alias) {
          return {
            kind: MatchKind.ALIAS,
            confidence: 0.95,
            best: {
              ingredientId: alias.ingredient.id,
              name: alias.ingredient.name,
              slug: alias.ingredient.slug,
              score: 1,
            },
            alternatives: [],
          };
        }
      }
    }

    return this.fuzzyMatch(name);
  }

  /**
   * Last resort: trigram similarity against names and aliases.
   *
   * This is what turns a typo into a one-click correction instead of a retype.
   * It uses raw SQL because `similarity()` is a Postgres function Prisma cannot
   * express — which means the household filter has to be written by hand here
   * rather than coming from the tenancy extension, so it is stated explicitly
   * and takes the household id from the same request context the extension uses.
   */
  private async fuzzyMatch(name: string) {
    const householdId = requireHouseholdId();

    const rows = await this.raw.$queryRaw<
      Array<{ id: number; name: string; slug: string; score: number }>
    >`
      SELECT id, name, slug, score FROM (
        SELECT i.id, i.name, i.slug, similarity(i.name, ${name}) AS score
          FROM "ingredient" i
         WHERE (i."householdId" IS NULL OR i."householdId" = ${householdId})
        UNION ALL
        SELECT i.id, i.name, i.slug, similarity(a.alias, ${name}) AS score
          FROM "ingredient_alias" a
          JOIN "ingredient" i ON i.id = a."ingredientId"
         WHERE (i."householdId" IS NULL OR i."householdId" = ${householdId})
      ) matches
      WHERE score >= ${FUZZY_FLOOR}
      ORDER BY score DESC, name ASC
      LIMIT ${MAX_ALTERNATIVES + 1}
    `;

    // The same ingredient can surface via both its name and an alias.
    const seen = new Set<number>();
    const unique = rows.filter((row) => !seen.has(row.id) && seen.add(row.id));

    if (unique.length === 0) {
      return { kind: MatchKind.NONE, confidence: 0, best: null, alternatives: [] };
    }

    const [best, ...rest] = unique.map((row) => ({
      ingredientId: row.id,
      name: row.name,
      slug: row.slug,
      score: Number(row.score),
    }));

    return {
      kind: MatchKind.FUZZY,
      confidence: best.score,
      best,
      alternatives: rest.slice(0, MAX_ALTERNATIVES),
    };
  }
}

/**
 * Prefers a household's own version of an ingredient over the global one.
 *
 * Both can share a slug once a household has forked a catalog row to fix its
 * density; the fork is the one carrying their correction.
 */
function preferOwnIngredient<T extends { householdId: number | null }>(
  rows: readonly T[],
): T | undefined {
  return rows.find((row) => row.householdId !== null) ?? rows[0];
}
