import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { UnitDef } from '@recipes/shared-types';

import { toUnitDef } from '../catalog/units.service';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.service';
import { balanceFor, type BalanceLot } from '../pantry/pantry-balance';
import {
  rankMatches,
  type MatchRecipe,
  type PantryBalance,
  type RecipeMatch,
} from './pantry-match';
import type { PantrySuggestionQueryDto } from './dto/suggestions.dto';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

@Injectable()
export class SuggestionsService {
  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantPrisma) {}

  /**
   * The deterministic answer to "what can I cook right now".
   *
   * Two queries — every lot, every active recipe — then the scoring in memory.
   * At household scale (hundreds of recipes, thousands of lots) this is well
   * inside a single request, and the alternative shape, a query per recipe, gets
   * slower the more useful the app becomes.
   */
  async fromPantry(query: PantrySuggestionQueryDto): Promise<{
    matches: RecipeMatch[];
    pantryIngredientCount: number;
    recipeCount: number;
  }> {
    const [balances, recipes] = await Promise.all([
      this.pantryBalances(),
      this.activeRecipes(),
    ]);

    const matches = rankMatches(recipes, balances, {
      missingMax: query.missingMax,
      targetServings: query.servings,
    });

    return {
      matches: matches.slice(0, Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT)),
      pantryIngredientCount: balances.size,
      recipeCount: recipes.length,
    };
  }

  /**
   * Current on-hand totals, keyed by ingredient.
   *
   * Shared with the AI method, which is grounded on exactly the numbers the
   * deterministic method used — passing it anything else would let the two tabs
   * disagree about the same pantry.
   */
  async pantryBalances(): Promise<Map<number, PantryBalance>> {
    const lots = await this.db.pantryItem.findMany({
      include: {
        unit: true,
        ingredient: {
          select: {
            id: true,
            name: true,
            gramsPerMl: true,
            gramsPerPiece: true,
            defaultUnitId: true,
          },
        },
      },
      orderBy: { id: 'asc' },
    });

    const grouped = new Map<number, typeof lots>();
    for (const lot of lots) {
      const list = grouped.get(lot.ingredientId);
      if (list) list.push(lot);
      else grouped.set(lot.ingredientId, [lot]);
    }

    // The ingredient's own default unit, exactly as the pantry screen uses. Both
    // are correct arithmetic, but reporting the same flour as "7.98 cups" on one
    // tab and "1 kilogram" on another reads as two different answers, and the AI
    // method is grounded on these numbers — so the two must not diverge.
    const defaultUnits = await this.resolveDefaultUnits(
      [...grouped.values()].map((group) => group[0].ingredient.defaultUnitId),
    );

    const balances = new Map<number, PantryBalance>();
    for (const [ingredientId, group] of grouped) {
      const ingredient = group[0].ingredient;
      const physicals = {
        gramsPerMl: ingredient.gramsPerMl?.toString() ?? null,
        gramsPerPiece: ingredient.gramsPerPiece?.toString() ?? null,
      };

      const lotsForBalance: BalanceLot[] = group.map((lot) => ({
        id: lot.id,
        quantity: lot.quantity.toString(),
        unit: toUnitDef(lot.unit),
        expiresOn: lot.expiresOn,
      }));

      const preferred = ingredient.defaultUnitId
        ? (defaultUnits.get(ingredient.defaultUnitId) ?? null)
        : null;
      const balance = balanceFor(lotsForBalance, physicals, preferred);
      // A balance that could not be totalled has nothing to compare against, so
      // it is left out rather than entered as zero — which would read as "none
      // in stock" and is a different claim.
      if (balance.total === null || balance.unit === null) continue;
      if (balance.total.lte(0)) continue;

      balances.set(ingredientId, {
        total: new Decimal(balance.total),
        unit: balance.unit,
        physicals,
      });
    }

    return balances;
  }

  /** Loads the units ingredients declare as their default, in one query. */
  private async resolveDefaultUnits(
    ids: ReadonlyArray<number | null>,
  ): Promise<Map<number, UnitDef>> {
    const wanted = [...new Set(ids.filter((id): id is number => id !== null))];
    if (wanted.length === 0) return new Map();

    const units = await this.db.unit.findMany({ where: { id: { in: wanted } } });
    return new Map(units.map((unit) => [unit.id, toUnitDef(unit)]));
  }

  /** Every recipe worth suggesting: archived ones are deliberately put away. */
  async activeRecipes(): Promise<MatchRecipe[]> {
    const recipes = await this.db.recipe.findMany({
      where: { archivedOn: null },
      select: {
        id: true,
        title: true,
        slug: true,
        servings: true,
        ingredients: {
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            rawText: true,
            quantity: true,
            optional: true,
            ingredientId: true,
            ingredient: { select: { name: true } },
            unit: true,
          },
        },
      },
    });

    return recipes.map((recipe) => ({
      id: recipe.id,
      title: recipe.title,
      slug: recipe.slug,
      servings: recipe.servings,
      lines: recipe.ingredients.map((line) => ({
        lineId: line.id,
        ingredientId: line.ingredientId,
        ingredientName: line.ingredient?.name ?? null,
        rawText: line.rawText,
        quantity: line.quantity?.toString() ?? null,
        unit: line.unit ? toUnitDef(line.unit) : null,
        optional: line.optional,
      })),
    }));
  }

  /**
   * Ingredients expiring soonest, with what they are.
   *
   * Only used to give the AI method something to work with — "your buttermilk
   * goes off Thursday" is the kind of suggestion arithmetic cannot make.
   */
  async expiringSoon(withinDays = 7) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + withinDays);

    const lots = await this.db.pantryItem.findMany({
      where: { expiresOn: { not: null, lte: cutoff } },
      select: {
        id: true,
        quantity: true,
        expiresOn: true,
        unit: { select: { name: true, abbrev: true } },
        ingredient: { select: { id: true, name: true } },
      },
      orderBy: { expiresOn: 'asc' },
      take: 50,
    });

    return lots.map((lot) => ({
      ingredientId: lot.ingredient.id,
      name: lot.ingredient.name,
      quantity: lot.quantity.toString(),
      unit: lot.unit.abbrev ?? lot.unit.name,
      expiresOn: lot.expiresOn,
    }));
  }
}
