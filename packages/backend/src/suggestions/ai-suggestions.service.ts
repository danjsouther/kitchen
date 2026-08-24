import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

import { AiConfigService } from '../households/ai-config.service';
import { ParserService } from '../parser/parser.service';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.service';
import { SuggestionsService } from './suggestions.service';
import { rankMatches, type RecipeMatch } from './pantry-match';
import type { AiSuggestionDto } from './dto/suggestions.dto';

/**
 * The response contract.
 *
 * Note what is *absent* from every field but `body`: there is no quantity, no
 * amount on hand, no count of what is missing. That is the grounding rule
 * expressed in the schema rather than only in the prompt — the deterministic
 * match is the source of truth about an *existing* recipe's numbers, and the
 * model is given nowhere to assert a different one even if it wanted to.
 *
 * `body` is the one deliberate exception: a GENERATED dish has no existing
 * recipe for MATCHES to be grounded on, so the model is expected to invent
 * its own quantities there — see SYSTEM_PROMPT.
 */
const SuggestionSchema = z.object({
  suggestions: z
    .array(
      z.object({
        kind: z
          .enum(['SAVED_RECIPE', 'SUBSTITUTION', 'GENERATED'])
          .describe(
            'SAVED_RECIPE: cook one of their recipes as-is. SUBSTITUTION: cook one ' +
              'of their recipes with a swap for something missing. GENERATED: a dish ' +
              'not in their collection.',
          ),
        recipeId: z
          .number()
          .nullable()
          .describe('The id of the saved recipe, copied exactly. Null for GENERATED.'),
        title: z.string().describe('The dish name.'),
        why: z
          .string()
          .describe(
            'One or two sentences on why this suits them right now. Mention ' +
              'expiring ingredients by name where relevant.',
          ),
        substitutions: z
          .array(
            z.object({
              missing: z.string().describe('The ingredient they lack.'),
              useInstead: z.string().describe('What to use from their pantry.'),
              note: z.string().describe('How the dish changes, honestly.'),
            }),
          )
          .describe('Empty unless kind is SUBSTITUTION.'),
        usesExpiring: z
          .array(z.string())
          .describe('Names of soon-to-expire ingredients this uses up.'),
        body: z
          .object({
            servings: z.number().int().min(1).max(50),
            ingredients: z
              .array(
                z.object({
                  quantity: z
                    .string()
                    .describe(
                      'Decimal string, e.g. "2" or "0.5". Never a fraction character or a range.',
                    ),
                  unit: z
                    .string()
                    .nullable()
                    .describe(
                      'Unit as written, e.g. "cup", "tsp", "clove". Null when the ' +
                        'ingredient has no unit, e.g. "3 eggs".',
                    ),
                  name: z
                    .string()
                    .describe('The ingredient itself — no quantity, unit or preparation.'),
                  preparation: z
                    .string()
                    .nullable()
                    .describe('How it is prepared, e.g. "diced", "melted". Null if not applicable.'),
                }),
              )
              .min(1)
              .max(40),
            steps: z
              .array(z.string())
              .min(1)
              .max(30)
              .describe('Ordered instructions, one plain imperative sentence per entry.'),
          })
          .nullable()
          .describe(
            'A full recipe body, good enough to cook from. Required when kind is ' +
              'GENERATED; null for every other kind.',
          ),
      }),
    )
    .describe('Ranked best first. Between one and six.'),
  summary: z.string().describe('A single sentence overview of the options.'),
});

export type AiSuggestions = z.infer<typeof SuggestionSchema>;

/**
 * The shape actually stored and served back: `AiSuggestions` after
 * `resolveBodies()` has replaced each GENERATED body's raw ingredient lines
 * with catalog-matched ones. This, not `AiSuggestions`, is what a persisted
 * row's `result` column holds.
 */
type ResolvedAiSuggestions = Awaited<ReturnType<AiSuggestionsService['resolveBodies']>>;

/**
 * Kept verbatim and first in the request so it can be cached across calls. The
 * minimum cacheable prefix on Opus 5 is 512 tokens; `cache_read_input_tokens` in
 * the response is what proves it is actually being reused, rather than assuming.
 */
const SYSTEM_PROMPT = `You are helping someone decide what to cook from what is already in their kitchen.

You will be given:
- PANTRY: what they have, with amounts and units.
- EXPIRING: items going off soon.
- MATCHES: the result of an exact arithmetic check of each of their recipes against that pantry, already computed. Each match lists which ingredients are satisfied, which are short, and which could not be checked.
- RECIPES: their saved recipe titles and ids.

THE RULE THAT MATTERS MOST: the arithmetic in MATCHES is already correct and is not yours to redo. Never state a quantity, never claim an ingredient is present or absent contrary to MATCHES, and never recompute how much of something is needed. Your value is judgement the arithmetic cannot supply: which substitutions genuinely work, what to cook before it spoils, and what to make when nothing matches cleanly.

An ingredient listed as "unknown" in MATCHES is one the system could not measure — not one they are out of. Treat it as uncertain and say so rather than assuming either way.

That rule governs MATCHES and any SAVED_RECIPE or SUBSTITUTION suggestion, because those numbers are already computed and yours to report, not invent. A GENERATED suggestion is different: nothing about it exists yet, so when kind is GENERATED you must write a real, cookable body — every ingredient with its own quantity and unit, and ordered steps — good enough to actually cook from. Keep quantities plain decimals ("2", "0.5"), never a fraction character or a range. Leave body null for every other kind.

How to choose:
1. Prefer recipes they can cook now, especially ones using EXPIRING items.
2. Then recipes one or two ingredients short where a pantry item genuinely substitutes. Only suggest a substitution you would actually stand behind — say plainly how the dish will differ.
3. Only if neither helps, invent a simple dish from what they have and mark it GENERATED.

Use the exact recipeId from RECIPES when referring to a saved recipe. Be specific and brief; assume a competent home cook.`;

const MAX_RECIPES_IN_PROMPT = 120;
const MAX_MATCHES_IN_PROMPT = 25;

@Injectable()
export class AiSuggestionsService {
  private readonly logger = new Logger(AiSuggestionsService.name);

  constructor(
    private readonly suggestions: SuggestionsService,
    private readonly aiConfig: AiConfigService,
    private readonly parser: ParserService,
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
  ) {}

  /**
   * The AI tab. Runs the deterministic match first and hands it over as context.
   *
   * Failure is non-fatal by design: an API error, a refusal, or a response that
   * will not parse all fall back to the deterministic result with a note. The
   * whole feature is an enhancement to a screen that already works, and taking
   * that screen down because a third party had a bad minute would be a poor
   * trade.
   */
  async suggest(dto: AiSuggestionDto) {
    const credentials = await this.aiConfig.resolveKey();
    if (!credentials) {
      throw new ConflictException(
        'No Anthropic API key is configured for this household. An admin can add ' +
          'one in Settings.',
      );
    }

    const [balances, recipes, expiring] = await Promise.all([
      this.suggestions.pantryBalances(),
      this.suggestions.activeRecipes(),
      this.suggestions.expiringSoon(),
    ]);

    const matches = rankMatches(recipes, balances, { targetServings: dto.servings });

    const payload = {
      PANTRY: [...balances.entries()].map(([ingredientId, balance]) => ({
        ingredientId,
        name: recipes
          .flatMap((recipe) => recipe.lines)
          .find((line) => line.ingredientId === ingredientId)?.ingredientName,
        have: balance.total.toString(),
        unit: balance.unit.name,
      })),
      EXPIRING: expiring,
      MATCHES: matches.slice(0, MAX_MATCHES_IN_PROMPT).map(summariseMatch),
      // Titles and ids only. Sending full recipe bodies would multiply the
      // request size for information the model does not need to rank them.
      RECIPES: recipes.slice(0, MAX_RECIPES_IN_PROMPT).map((recipe) => ({
        id: recipe.id,
        title: recipe.title,
      })),
    };

    try {
      const client = new Anthropic({ apiKey: credentials.apiKey, maxRetries: 1 });

      const response = await client.messages.parse({
        model: credentials.model,
        // A GENERATED suggestion can now carry a full recipe body (up to 40
        // ingredients and 30 steps, across up to 6 suggestions), which needs
        // real headroom beyond what ranking-and-a-sentence used to cost.
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: {
          effort: credentials.effort as 'low' | 'medium' | 'high',
          format: zodOutputFormat(SuggestionSchema),
        },
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: JSON.stringify(payload) }],
      });

      const usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      };

      if (response.stop_reason === 'refusal') {
        const reason = 'The model declined to answer that request.';
        await this.persist({ ok: false, reason, result: null, usage });
        return this.degrade(matches, reason);
      }
      // A truncated response can still coincidentally satisfy the schema (an
      // empty summary and an empty suggestions array both validate), which is
      // worse than an outright parse failure: it looks like a real, if
      // useless, answer rather than an obvious one to retry.
      if (response.stop_reason === 'max_tokens') {
        const reason = 'The response was cut off before it finished — try asking again.';
        await this.persist({ ok: false, reason, result: null, usage });
        return this.degrade(matches, reason);
      }
      if (!response.parsed_output) {
        const reason = 'The model returned something unreadable.';
        await this.persist({ ok: false, reason, result: null, usage });
        return this.degrade(matches, reason);
      }

      const reconciled = this.reconcile(response.parsed_output as AiSuggestions, recipes);
      const ai = await this.resolveBodies(reconciled);

      await this.persist({ ok: true, reason: null, result: ai, usage });

      return {
        ok: true as const,
        deterministic: matches.slice(0, MAX_MATCHES_IN_PROMPT),
        ai,
        usage,
      };
    } catch (error) {
      // The key must never reach a log line or a response body.
      this.logger.warn(
        `AI suggestions failed: ${(error as { status?: number }).status ?? 'no status'}`,
      );
      return this.degrade(matches, 'Could not reach Anthropic just now.');
    }
  }

  /**
   * Drops any recipeId the model invented.
   *
   * Structured output guarantees the *shape* of the response, not that the ids in
   * it are real. A suggestion pointing at a recipe that does not exist would give
   * the UI a dead link, so an unrecognised id is downgraded to a generated idea
   * rather than passed through.
   */
  private reconcile(
    parsed: AiSuggestions,
    recipes: ReadonlyArray<{ id: number; title: string }>,
  ): AiSuggestions {
    const known = new Set(recipes.map((recipe) => recipe.id));

    return {
      ...parsed,
      suggestions: parsed.suggestions.map((suggestion) =>
        suggestion.recipeId !== null && !known.has(suggestion.recipeId)
          ? { ...suggestion, recipeId: null, kind: 'GENERATED' as const }
          : suggestion,
      ),
    };
  }

  /**
   * Resolves a GENERATED suggestion's ingredient names/units against the
   * catalog, the same way a pasted recipe's lines are resolved.
   *
   * Runs after `reconcile()` on purpose: a suggestion `reconcile()` demoted
   * to GENERATED because its recipeId was invented has no body — the model
   * believed it was pointing at a real recipe and never wrote one — so it
   * passes through untouched here, and the frontend simply has nothing to
   * offer a save action for.
   */
  private async resolveBodies(parsed: AiSuggestions) {
    const suggestions = await Promise.all(
      parsed.suggestions.map(async (suggestion) => {
        if (suggestion.kind !== 'GENERATED' || !suggestion.body) return suggestion;

        const ingredients = await this.parser.resolveGeneratedIngredients(
          suggestion.body.ingredients,
        );

        return {
          ...suggestion,
          body: {
            servings: suggestion.body.servings,
            ingredients,
            steps: suggestion.body.steps.map((text) => ({ text })),
          },
        };
      }),
    );

    return { ...parsed, suggestions };
  }

  /**
   * Records one run. The household paid for this call, refusal and unparseable
   * output included, so it is kept even when there is nothing usable in
   * `result` — only a network/auth failure that never reached Anthropic (the
   * `catch` block in `suggest()`) has no usage to report and gets no row.
   */
  private async persist(run: {
    ok: boolean;
    reason: string | null;
    result: ResolvedAiSuggestions | null;
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  }): Promise<void> {
    await this.db.aiSuggestion.create({
      data: {
        ok: run.ok,
        reason: run.reason,
        result: run.result ?? undefined,
        inputTokens: run.usage.inputTokens,
        outputTokens: run.usage.outputTokens,
        cacheReadTokens: run.usage.cacheReadTokens,
        // householdId is stamped by the tenancy extension at query time; the
        // generated client type does not know that (see cook.service.ts for
        // the same pattern).
      } as never,
    });
  }

  /**
   * Past runs, newest first, so the Ideas tab can show the last one on arrival
   * and page back through the rest.
   *
   * Re-checks every stored `recipeId` against the recipes that are still
   * active: `reconcile()` only ever ran once, at generation time, and a
   * SAVED_RECIPE or SUBSTITUTION suggestion can outlive the recipe it points
   * at if that recipe is archived afterward. Ingredient references inside a
   * GENERATED body need no such check — ingredients are never hard-deleted in
   * this app, only forked.
   */
  async history(limit = 10, offset = 0) {
    const cappedLimit = Math.min(Math.max(limit, 1), 50);
    const cappedOffset = Math.max(offset, 0);

    const [total, rows, activeRecipes] = await Promise.all([
      this.db.aiSuggestion.count(),
      this.db.aiSuggestion.findMany({
        orderBy: { createdOn: 'desc' },
        take: cappedLimit,
        skip: cappedOffset,
      }),
      this.suggestions.activeRecipes(),
    ]);

    const activeIds = new Set(activeRecipes.map((recipe) => recipe.id));

    return {
      total,
      limit: cappedLimit,
      offset: cappedOffset,
      items: rows.map((row) => ({
        id: row.id,
        createdOn: row.createdOn,
        ok: row.ok,
        reason: row.reason ?? undefined,
        ai: row.result ? reconcileStale(row.result as ResolvedAiSuggestions, activeIds) : null,
        usage: {
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
        },
      })),
    };
  }

  /** Cumulative spend, summed on read rather than kept as a running counter. */
  async usageSummary() {
    const agg = await this.db.aiSuggestion.aggregate({
      _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true },
      _count: true,
    });

    return {
      runCount: agg._count,
      inputTokens: agg._sum.inputTokens ?? 0,
      outputTokens: agg._sum.outputTokens ?? 0,
      cacheReadTokens: agg._sum.cacheReadTokens ?? 0,
    };
  }

  /** Falls back to the deterministic answer, saying plainly why. */
  private degrade(matches: RecipeMatch[], reason: string) {
    return {
      ok: false as const,
      deterministic: matches.slice(0, MAX_MATCHES_IN_PROMPT),
      ai: null,
      reason,
    };
  }
}

/**
 * Read-time counterpart to `AiSuggestionsService.reconcile()`, for a stored
 * run being served back later.
 *
 * `reconcile()` only ever runs once, at generation time, against the recipes
 * that existed then. A recipe a stored SAVED_RECIPE or SUBSTITUTION pointed at
 * can be archived afterward, so this nulls out any `recipeId` no longer in
 * `activeIds` — unlike `reconcile()`, it leaves `kind` alone: the suggestion
 * genuinely was that kind when generated, this only records that the link has
 * since gone stale. The frontend already renders a plain title instead of a
 * link whenever `recipeId` is falsy, so nothing else needs to change.
 */
export function reconcileStale(
  result: ResolvedAiSuggestions,
  activeIds: ReadonlySet<number>,
): ResolvedAiSuggestions {
  return {
    ...result,
    suggestions: result.suggestions.map((suggestion) =>
      suggestion.recipeId !== null && !activeIds.has(suggestion.recipeId)
        ? { ...suggestion, recipeId: null }
        : suggestion,
    ),
  };
}

/**
 * Compresses a match for the prompt.
 *
 * Names and counts only — the full `LineStatus` rows carry quantities the model
 * has no business restating, and leaving them out is cheaper as well as safer.
 */
export function summariseMatch(match: RecipeMatch) {
  return {
    recipeId: match.recipeId,
    title: match.title,
    canCookNow: match.canCook,
    have: match.have.map((line) => line.ingredientName ?? line.rawText),
    short: match.missing.map((line) => line.ingredientName ?? line.rawText),
    couldNotCheck: match.unknown.map((line) => line.ingredientName ?? line.rawText),
  };
}
