import { createHash } from 'node:crypto';

export interface RecipeHashIngredientLine {
  sortOrder: number;
  ingredientId: number | null;
  rawText: string;
  quantity: string | null;
  unitId: number | null;
  preparation: string | null;
  groupLabel: string | null;
  optional: boolean;
}

export interface RecipeHashStepLine {
  sortOrder: number;
  text: string;
}

export interface RecipeHashInput {
  title: string;
  description: string | null;
  servings: number;
  prepMinutes: number | null;
  cookMinutes: number | null;
  sourceUrl: string | null;
  sourceNote: string | null;
  notes: string | null;
  ingredients: readonly RecipeHashIngredientLine[];
  steps: readonly RecipeHashStepLine[];
}

/**
 * SHA-256 of a recipe's content — title, description, servings, timings,
 * source fields, notes, and the ingredient/step lists in their stored order.
 * Deliberately excludes id, householdId, slug, and every timestamp: two rows
 * with the same content hash identically regardless of who owns them or when
 * they were written, which is what lets `publish` recognise "this content is
 * already published" instead of minting a duplicate.
 *
 * Sorted by `sortOrder` explicitly rather than trusting caller order, so a
 * list rebuilt in a different order (same lines, same positions) still
 * hashes the same.
 */
export function computeRecipeHash(input: RecipeHashInput): string {
  const canonical = JSON.stringify({
    title: input.title,
    description: input.description,
    servings: input.servings,
    prepMinutes: input.prepMinutes,
    cookMinutes: input.cookMinutes,
    sourceUrl: input.sourceUrl,
    sourceNote: input.sourceNote,
    notes: input.notes,
    ingredients: [...input.ingredients]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((line) => ({
        ingredientId: line.ingredientId,
        rawText: line.rawText,
        quantity: line.quantity,
        unitId: line.unitId,
        preparation: line.preparation,
        groupLabel: line.groupLabel,
        optional: line.optional,
      })),
    steps: [...input.steps]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((step) => step.text),
  });

  return createHash('sha256').update(canonical).digest('hex');
}
