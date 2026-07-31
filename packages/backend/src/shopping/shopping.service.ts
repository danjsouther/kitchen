import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import {
  ItemSource,
  ListStatus,
  PlanStatus,
  TxKind,
  scaleForServings,
  type UnitDef,
} from '@recipes/shared-types';

import { toUnitDef } from '../catalog/units.service';
import { parseDate } from '../planner/planner.service';
import { SuggestionsService } from '../suggestions/suggestions.service';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.service';
import { StoresService } from './stores.service';
import {
  generateProposal,
  type DemandLine,
  type IngredientInfo,
  type PantryOnHand,
  type ProposedItem,
} from './shopping-generation';
import type {
  AddListItemDto,
  CreateListDto,
  GenerateListDto,
  ReceiveDto,
  UpdateListItemDto,
} from './dto/shopping.dto';

/**
 * Not `as const`: that would make the `orderBy` array readonly, which Prisma's
 * generated types reject.
 */
const LIST_INCLUDE = {
  store: { select: { id: true, name: true } },
  items: {
    orderBy: [{ checkedOn: 'asc' as const }, { id: 'asc' as const }],
    include: {
      ingredient: { select: { id: true, name: true, categoryId: true } },
      unit: true,
      store: { select: { id: true, name: true } },
    },
  },
};

@Injectable()
export class ShoppingService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly stores: StoresService,
    private readonly suggestions: SuggestionsService,
  ) {}

  // -- Lists ---------------------------------------------------------------

  list(status?: ListStatus) {
    return this.db.shoppingList.findMany({
      where: status ? { status } : {},
      orderBy: { createdOn: 'desc' },
      include: {
        store: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
    });
  }

  async findOne(id: number) {
    const found = await this.db.shoppingList.findFirst({
      where: { id },
      include: LIST_INCLUDE,
    });
    if (!found) throw new NotFoundException(`No shopping list with id ${id}.`);
    return withTotals(found);
  }

  /**
   * Builds a proposal without saving anything.
   *
   * A generated list is a guess about a week that has not happened yet, so it is
   * shown for review first. `create` runs the same generation and persists the
   * result.
   */
  async generate(dto: GenerateListDto): Promise<{
    from: string;
    to: string;
    storeId: number | null;
    items: ProposedItem[];
    mealCount: number;
  }> {
    const from = parseDate(dto.from, 'from');
    const to = parseDate(dto.to, 'to');
    if (to < from) throw new BadRequestException('`to` is before `from`.');

    if (dto.storeId) await this.stores.findOne(dto.storeId);

    const meals = await this.db.plannedMeal.findMany({
      where: { date: { gte: from, lte: to }, status: PlanStatus.PLANNED, recipeId: { not: null } },
      include: {
        recipe: {
          select: {
            id: true,
            title: true,
            servings: true,
            ingredients: {
              orderBy: { sortOrder: 'asc' },
              include: { unit: true, ingredient: { select: { id: true, name: true } } },
            },
          },
        },
      },
      orderBy: { date: 'asc' },
    });

    const demand: DemandLine[] = [];
    for (const meal of meals) {
      if (!meal.recipe) continue;

      for (const line of meal.recipe.ingredients) {
        // The same rules as cooking: optional lines are not assumed used, and a
        // line with no ingredient, quantity or unit cannot be shopped for.
        if (line.optional || !line.ingredient || line.quantity === null || !line.unit) {
          continue;
        }

        demand.push({
          plannedMealId: meal.id,
          recipeId: meal.recipe.id,
          recipeTitle: meal.recipe.title,
          date: meal.date,
          ingredientId: line.ingredient.id,
          ingredientName: line.ingredient.name,
          rawText: line.rawText,
          quantity: scaleForServings(
            line.quantity.toString(),
            meal.recipe.servings,
            meal.servings,
          ),
          unit: toUnitDef(line.unit),
        });
      }
    }

    const pars = dto.includePars === false ? [] : await this.parLines();

    const [balances, ingredients, aisleOrder] = await Promise.all([
      this.balancesForGenerator(),
      this.ingredientInfo(
        [...new Set([...demand.map((d) => d.ingredientId), ...pars.map((p) => p.ingredientId)])],
        dto.storeId ?? null,
      ),
      this.stores.aisleOrder(dto.storeId),
    ]);

    return {
      from: dto.from,
      to: dto.to,
      storeId: dto.storeId ?? null,
      mealCount: meals.length,
      items: generateProposal({ demand, pars, balances, ingredients, aisleOrder }),
    };
  }

  /** Generates and saves, so the review screen can accept a proposal in one call. */
  async create(dto: CreateListDto) {
    const proposal = await this.generate(dto);

    const list = await this.db.shoppingList.create({
      data: {
        name: dto.name?.trim() || `Shopping ${dto.from} to ${dto.to}`,
        storeId: dto.storeId ?? null,
        items: {
          create: proposal.items.map((item) => ({
            ingredientId: item.ingredientId,
            quantity: item.quantity,
            unitId: item.unit.id,
            source: item.source,
            sourcePlannedMealId: item.forMeals[0]?.plannedMealId ?? null,
            brand: item.brand,
            estimatedPrice: item.estimatedPrice,
            unconvertible: item.unconvertible,
          })),
        },
      } as never,
      include: LIST_INCLUDE,
    });

    return withTotals(list);
  }

  async addItem(listId: number, dto: AddListItemDto) {
    const list = await this.requireOpenList(listId);

    if (!dto.ingredientId && !dto.rawName?.trim()) {
      throw new BadRequestException('An item needs either an ingredient or a name.');
    }
    if (dto.unitId && !dto.quantity) {
      throw new BadRequestException('A unit with no quantity is not an amount.');
    }

    await this.db.shoppingListItem.create({
      data: {
        listId: list.id,
        ingredientId: dto.ingredientId ?? null,
        rawName: dto.rawName?.trim() || null,
        quantity: dto.quantity ?? null,
        unitId: dto.unitId ?? null,
        source: ItemSource.MANUAL,
        brand: dto.brand?.trim() || null,
        estimatedPrice: dto.estimatedPrice ?? null,
        note: dto.note?.trim() || null,
      },
    });

    return this.findOne(listId);
  }

  /**
   * Ticking an item off at the shelf, and recording what it actually cost.
   *
   * The item is reached through its list rather than by id alone: `ShoppingListItem`
   * has no `householdId` of its own, so the parent is what proves the caller may
   * touch it.
   */
  async updateItem(listId: number, itemId: number, dto: UpdateListItemDto) {
    await this.requireOpenList(listId);

    const item = await this.db.shoppingListItem.findFirst({
      where: { id: itemId, listId },
      select: { id: true },
    });
    if (!item) throw new NotFoundException(`No item ${itemId} on list ${listId}.`);

    const data: Record<string, unknown> = {};
    if (dto.quantity !== undefined) data.quantity = dto.quantity;
    if (dto.unitId !== undefined) data.unitId = dto.unitId;
    if (dto.brand !== undefined) data.brand = dto.brand?.trim() || null;
    if (dto.actualPrice !== undefined) data.actualPrice = dto.actualPrice;
    if (dto.storeId !== undefined) data.storeId = dto.storeId;
    if (dto.note !== undefined) data.note = dto.note?.trim() || null;
    if (dto.checked !== undefined) data.checkedOn = dto.checked ? new Date() : null;

    await this.db.shoppingListItem.update({ where: { id: itemId }, data: data as never });
    return this.findOne(listId);
  }

  async removeItem(listId: number, itemId: number) {
    await this.requireOpenList(listId);
    const { count } = await this.db.shoppingListItem.deleteMany({
      where: { id: itemId, listId },
    });
    if (count === 0) throw new NotFoundException(`No item ${itemId} on list ${listId}.`);
    return this.findOne(listId);
  }

  /**
   * Puts the shopping away: checked items become pantry lots, priced items become
   * price history, and the list is closed.
   *
   * This is what closes the loop — shopping updates the pantry *and* teaches the
   * next list what things cost, without anyone keeping a second set of books.
   *
   * Items with no quantity or unit cannot become a lot ("paper towels" is not an
   * amount of anything), so they are reported as skipped rather than guessed at.
   */
  async receive(listId: number, dto: ReceiveDto, userId: number) {
    const list = await this.requireOpenList(listId);

    const location = await this.db.storageLocation.findFirst({
      where: { id: dto.locationId },
      select: { id: true },
    });
    if (!location) {
      throw new BadRequestException(`Unknown storage location id: ${dto.locationId}.`);
    }

    const items = await this.db.shoppingListItem.findMany({
      where: { listId, checkedOn: { not: null } },
      include: { ingredient: { select: { id: true, shelfLifeDays: true } } },
    });
    if (items.length === 0) {
      throw new ConflictException('Nothing on that list is ticked off yet.');
    }

    const stocked: Array<{ itemId: number; pantryItemId: number }> = [];
    const skipped: Array<{ itemId: number; reason: string }> = [];
    const priced: number[] = [];

    await this.db.$transaction(async (tx) => {
      for (const item of items) {
        if (!item.ingredient || item.quantity === null || item.unitId === null) {
          skipped.push({
            itemId: item.id,
            reason: !item.ingredient
              ? 'not a catalog ingredient'
              : 'no quantity or unit to stock',
          });
        } else {
          const expiresOn = item.ingredient.shelfLifeDays
            ? addDays(new Date(), item.ingredient.shelfLifeDays)
            : null;

          const lot = await tx.pantryItem.create({
            data: {
              ingredientId: item.ingredient.id,
              locationId: dto.locationId,
              quantity: item.quantity,
              unitId: item.unitId,
              brand: item.brand,
              expiresOn,
            } as never,
          });

          await tx.pantryTransaction.create({
            data: {
              pantryItemId: lot.id,
              ingredientId: item.ingredient.id,
              delta: item.quantity.toString(),
              unitId: item.unitId,
              kind: TxKind.PURCHASE,
              note: `From shopping list ${listId}`,
              createdById: userId,
            } as never,
          });

          stocked.push({ itemId: item.id, pantryItemId: lot.id });
        }

        // Price history is recorded even for items that could not be stocked —
        // knowing what a thing costs does not depend on having shelved it.
        if (item.actualPrice !== null && item.quantity !== null && item.unitId !== null && item.ingredient) {
          const quantity = new Decimal(item.quantity);
          if (quantity.gt(0)) {
            await tx.priceObservation.create({
              data: {
                ingredientId: item.ingredient.id,
                storeId: item.storeId ?? list.storeId,
                brand: item.brand,
                quantity: item.quantity,
                unitId: item.unitId,
                price: item.actualPrice,
              } as never,
            });
            priced.push(item.id);
          }
        }
      }

      await tx.shoppingList.update({
        where: { id: listId },
        data: { status: ListStatus.COMPLETED, completedOn: new Date() },
      });
    });

    return { listId, stocked, priced, skipped };
  }

  async archive(id: number) {
    await this.findOne(id);
    await this.db.shoppingList.update({
      where: { id },
      data: { status: ListStatus.ARCHIVED },
    });
    return this.findOne(id);
  }

  // -- Internals -----------------------------------------------------------

  private async requireOpenList(id: number) {
    const list = await this.db.shoppingList.findFirst({
      where: { id },
      select: { id: true, status: true, storeId: true },
    });
    if (!list) throw new NotFoundException(`No shopping list with id ${id}.`);
    if (list.status !== ListStatus.ACTIVE) {
      throw new ConflictException(`That list is ${list.status.toLowerCase()} and cannot be changed.`);
    }
    return list;
  }

  /** Reuses the suggestion service's balances so every screen agrees on stock. */
  private async balancesForGenerator(): Promise<Map<number, PantryOnHand>> {
    const balances = await this.suggestions.pantryBalances();
    return new Map(
      [...balances.entries()].map(([id, balance]) => [
        id,
        { total: balance.total, unit: balance.unit },
      ]),
    );
  }

  private async parLines() {
    const pars = await this.db.pantryPar.findMany({ include: { unit: true } });
    return pars.map((par) => ({
      ingredientId: par.ingredientId,
      minQuantity: par.minQuantity.toString(),
      unit: toUnitDef(par.unit),
    }));
  }

  /**
   * Assembles what the generator needs to know about each ingredient: how to
   * convert it, where it lives in the shop, and what it cost last time.
   */
  private async ingredientInfo(
    ingredientIds: readonly number[],
    storeId: number | null,
  ): Promise<Map<number, IngredientInfo>> {
    if (ingredientIds.length === 0) return new Map();

    const ingredients = await this.db.ingredient.findMany({
      where: { id: { in: [...ingredientIds] } },
      select: {
        id: true,
        name: true,
        gramsPerMl: true,
        gramsPerPiece: true,
        defaultUnitId: true,
        categoryId: true,
        category: { select: { sortOrder: true } },
      },
    });

    const unitIds = ingredients
      .map((ingredient) => ingredient.defaultUnitId)
      .filter((id): id is number => id !== null);
    const units = unitIds.length
      ? await this.db.unit.findMany({ where: { id: { in: unitIds } } })
      : [];
    const unitById = new Map<number, UnitDef>(units.map((u) => [u.id, toUnitDef(u)]));

    const prices = await this.latestPrices([...ingredientIds], storeId);

    return new Map(
      ingredients.map((ingredient) => [
        ingredient.id,
        {
          name: ingredient.name,
          physicals: {
            gramsPerMl: ingredient.gramsPerMl?.toString() ?? null,
            gramsPerPiece: ingredient.gramsPerPiece?.toString() ?? null,
          },
          defaultUnit: ingredient.defaultUnitId
            ? (unitById.get(ingredient.defaultUnitId) ?? null)
            : null,
          categoryId: ingredient.categoryId,
          categorySortOrder: ingredient.category?.sortOrder ?? Number.MAX_SAFE_INTEGER,
          lastPrice: prices.get(ingredient.id) ?? null,
        },
      ]),
    );
  }

  /**
   * The most recent price for each ingredient, preferring the store being shopped.
   *
   * A price from the shop you are standing in beats a cheaper one from across
   * town, so the chosen store's observations are looked at first and anywhere
   * else only fills the gaps.
   */
  private async latestPrices(ingredientIds: number[], storeId: number | null) {
    const observations = await this.db.priceObservation.findMany({
      where: { ingredientId: { in: ingredientIds } },
      include: { unit: true },
      orderBy: { observedOn: 'desc' },
    });

    const result = new Map<
      number,
      { pricePerUnit: Decimal; unit: UnitDef; brand: string | null }
    >();

    for (const pass of [storeId, null]) {
      for (const observation of observations) {
        if (pass !== null && observation.storeId !== pass) continue;
        if (result.has(observation.ingredientId)) continue;

        const quantity = new Decimal(observation.quantity);
        if (quantity.lte(0)) continue;

        result.set(observation.ingredientId, {
          pricePerUnit: new Decimal(observation.price).div(quantity),
          unit: toUnitDef(observation.unit),
          brand: observation.brand,
        });
      }
      if (pass === null) break;
    }

    return result;
  }
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Adds the running totals a shopper actually wants: what this is going to cost,
 * and how much of it is still guesswork.
 */
export function withTotals<
  T extends {
    items: Array<{
      estimatedPrice: unknown;
      actualPrice: unknown;
      checkedOn: Date | null;
    }>;
  },
>(list: T) {
  let estimated = new Decimal(0);
  let actual = new Decimal(0);
  let unpriced = 0;
  let checked = 0;

  for (const item of list.items) {
    if (item.checkedOn) checked += 1;
    if (item.actualPrice !== null && item.actualPrice !== undefined) {
      actual = actual.add(new Decimal(String(item.actualPrice)));
    } else if (item.estimatedPrice !== null && item.estimatedPrice !== undefined) {
      estimated = estimated.add(new Decimal(String(item.estimatedPrice)));
    } else {
      unpriced += 1;
    }
  }

  return {
    ...list,
    totals: {
      // Actual where known, estimated elsewhere — the number that answers "what
      // will this come to at the till".
      projected: actual.add(estimated).toDecimalPlaces(2).toString(),
      actual: actual.toDecimalPlaces(2).toString(),
      // Stated plainly rather than hidden, so the total is never mistaken for
      // complete when part of the list has no price at all.
      unpricedItems: unpriced,
      checkedItems: checked,
      totalItems: list.items.length,
    },
  };
}
