import { ConflictException, Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

import { AiConfigService } from '../households/ai-config.service';
import { SuggestionsService } from './suggestions.service';
import { rankMatches, type RecipeMatch } from './pantry-match';
import type { AiSuggestionDto } from './dto/suggestions.dto';

/**
 * The response contract.
 *
 * Note what is *absent*: there is no field anywhere for a quantity, an amount on
 * hand, or a count of what is missing. That is the grounding rule expressed in
 * the schema rather than only in the prompt — the deterministic match is the
 * source of truth about numbers, and the model is given nowhere to assert a
 * different one even if it wanted to.
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
      }),
    )
    .describe('Ranked best first. Between one and six.'),
  summary: z.string().describe('A single sentence overview of the options.'),
});

export type AiSuggestions = z.infer<typeof SuggestionSchema>;

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
        max_tokens: 8000,
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

      if (response.stop_reason === 'refusal') {
        return this.degrade(matches, 'The model declined to answer that request.');
      }
      if (!response.parsed_output) {
        return this.degrade(matches, 'The model returned something unreadable.');
      }

      return {
        ok: true as const,
        deterministic: matches.slice(0, MAX_MATCHES_IN_PROMPT),
        ai: this.reconcile(response.parsed_output as AiSuggestions, recipes),
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        },
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
