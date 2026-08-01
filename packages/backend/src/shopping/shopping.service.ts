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
} from '@kitchen/shared-types';

import { toUnitDef } from '../catalog/units.service';
import { parseDate } from '../planner/planner.service';
import { ProductsService } from '../products/products.service';
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
      // Null on most lines. When set, the list can show exactly which pack to
      // pick up rather than "flour, 1 kg".
      product: {
        select: { barcode: true, name: true, brands: true, imageSmallUrl: true },
      },
    },
  },
  receiveSessions: {
    orderBy: { receivedOn: 'desc' as const },
    select: { id: true, receivedOn: true, reversedOn: true },
  },
};

@Injectable()
export class ShoppingService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly stores: StoresService,
    private readonly suggestions: SuggestionsService,
    private readonly products: ProductsService,
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

    const scanned = await this.resolveScannedProduct(dto.productId);
    const ingredientId = dto.ingredientId ?? scanned.ingredientId;

    // A scanned product with an effective category is a perfectly good
    // "what is it", so the check runs after the barcode has had its say.
    if (!ingredientId && !dto.rawName?.trim() && !scanned.barcode) {
      throw new BadRequestException('An item needs either an ingredient or a name.');
    }
    if (dto.unitId && !dto.quantity) {
      throw new BadRequestException('A unit with no quantity is not an amount.');
    }

    if (scanned.barcode && dto.ingredientId) {
      await this.products.ensureOverrideIfChanged(scanned.barcode, dto.ingredientId);
    }

    await this.db.shoppingListItem.create({
      data: {
        listId: list.id,
        ingredientId: ingredientId ?? null,
        // An uncategized scan still needs something to read on the list, so the
        // product name stands in rather than leaving a blank line.
        rawName: dto.rawName?.trim() || (ingredientId ? null : scanned.name),
        quantity: dto.quantity ?? null,
        unitId: dto.unitId ?? null,
        source: ItemSource.MANUAL,
        brand: dto.brand?.trim() || scanned.brand,
        productId: scanned.barcode,
        estimatedPrice:
          dto.estimatedPrice ??
          (await this.lastPriceForProduct(scanned.barcode, dto.quantity, dto.unitId)),
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
    if (dto.productId !== undefined) {
      // Scanning at the shelf. An empty string detaches the product; a barcode
      // attaches it and refreshes the brand, since the two now come as a pair.
      const scanned = await this.resolveScannedProduct(dto.productId);
      data.productId = scanned.barcode;
      if (scanned.brand && dto.brand === undefined) data.brand = scanned.brand;
    }
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
   * A default `locationId` covers the whole basket; individual checked lines may
   * override it so milk can go in the fridge while pasta goes in the pantry.
   * Everything is grouped under a ReceiveSession so a mistaken put-away can be
   * undone as a unit.
   *
   * Items with no quantity or unit cannot become a lot ("paper towels" is not an
   * amount of anything), so they are reported as skipped rather than guessed at.
   */
  async receive(listId: number, dto: ReceiveDto, userId: number) {
    const list = await this.requireOpenList(listId);

    const locationIds = new Set<number>([dto.locationId]);
    for (const override of dto.items ?? []) locationIds.add(override.locationId);

    const locations = await this.db.storageLocation.findMany({
      where: { id: { in: [...locationIds] } },
      select: { id: true },
    });
    if (locations.length !== locationIds.size) {
      const known = new Set(locations.map((l) => l.id));
      const missing = [...locationIds].find((id) => !known.has(id));
      throw new BadRequestException(`Unknown storage location id: ${missing}.`);
    }

    const items = await this.db.shoppingListItem.findMany({
      where: { listId, checkedOn: { not: null } },
      include: { ingredient: { select: { id: true, shelfLifeDays: true } } },
    });
    if (items.length === 0) {
      throw new ConflictException('Nothing on that list is ticked off yet.');
    }

    const checkedIds = new Set(items.map((item) => item.id));
    const locationByItem = new Map<number, number>();
    for (const override of dto.items ?? []) {
      if (!checkedIds.has(override.itemId)) {
        throw new BadRequestException(
          `Item ${override.itemId} is not a checked line on list ${listId}.`,
        );
      }
      locationByItem.set(override.itemId, override.locationId);
    }

    const stocked: Array<{ itemId: number; pantryItemId: number }> = [];
    const skipped: Array<{ itemId: number; reason: string }> = [];
    const priced: number[] = [];
    let receiveSessionId = 0;

    await this.db.$transaction(async (tx) => {
      const session = await tx.receiveSession.create({
        data: { shoppingListId: listId } as never,
      });
      receiveSessionId = session.id;

      for (const item of items) {
        const locationId = locationByItem.get(item.id) ?? dto.locationId;

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
              locationId,
              quantity: item.quantity,
              unitId: item.unitId,
              brand: item.brand,
              // Carried through, so the lot on the shelf knows which pack it
              // is. Scanning it again later finds the same product.
              productId: item.productId,
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
              receiveSessionId: session.id,
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
                // A price for a barcode is a far better estimate than a price
                // for "flour", and this is the only moment it can be recorded.
                productId: item.productId,
                quantity: item.quantity,
                unitId: item.unitId,
                price: item.actualPrice,
                receiveSessionId: session.id,
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

    return { listId, receiveSessionId, stocked, priced, skipped };
  }

  /**
   * Reverses a put-away: removes purchased quantities from surviving lots,
   * deletes the price observations that receive wrote, stamps the session as
   * reversed, and reopens the list.
   *
   * Mirror of cook undo. A lot that was discarded or partly cooked since receive
   * cannot give back the full purchase — that shortfall is reported as
   * `lostLots` rather than inventing stock. Price observations are deleted
   * (they are not a ledger); leaving a mistaken price would poison the next
   * list's estimates.
   *
   * Lists put away before ReceiveSession existed are recovered from the purchase
   * ledger notes (`From shopping list N`) so they are not stuck sealed forever.
   */
  async unreceive(listId: number, userId: number) {
    const list = await this.db.shoppingList.findFirst({
      where: { id: listId },
      select: { id: true, status: true },
    });
    if (!list) throw new NotFoundException(`No shopping list with id ${listId}.`);
    if (list.status !== ListStatus.COMPLETED) {
      throw new ConflictException('Only a completed list can have its put-away undone.');
    }

    const session = await this.db.receiveSession.findFirst({
      where: { shoppingListId: listId, reversedOn: null },
      orderBy: { receivedOn: 'desc' },
      include: {
        transactions: {
          where: { kind: TxKind.PURCHASE },
          select: {
            id: true,
            pantryItemId: true,
            ingredientId: true,
            delta: true,
            unitId: true,
          },
        },
      },
    });

    // Prefer the session's PURCHASE rows; fall back to the free-text note that
    // every receive has always written, so lists sealed before ReceiveSession
    // can still be reopened.
    const purchases = session
      ? session.transactions
      : await this.db.pantryTransaction.findMany({
          where: {
            kind: TxKind.PURCHASE,
            note: `From shopping list ${listId}`,
          },
          select: {
            id: true,
            pantryItemId: true,
            ingredientId: true,
            delta: true,
            unitId: true,
          },
        });

    if (!session && purchases.length === 0) {
      // Nothing was stocked (everything skipped) but the list still closed —
      // just reopen it.
      await this.db.shoppingList.update({
        where: { id: listId },
        data: { status: ListStatus.ACTIVE, completedOn: null },
      });
      return {
        listId,
        receiveSessionId: null as number | null,
        restored: [] as Array<{ lotId: number; by: string }>,
        lostLots: [] as Array<{ lotId: number; wouldRestore: string }>,
        list: await this.findOne(listId),
      };
    }

    const lotIds = purchases
      .map((entry) => entry.pantryItemId)
      .filter((id): id is number => id !== null);
    const survivingLots = await this.db.pantryItem.findMany({
      where: { id: { in: lotIds } },
      select: { id: true, quantity: true },
    });
    const quantityByLot = new Map(
      survivingLots.map((lot) => [lot.id, new Decimal(lot.quantity.toString())]),
    );

    const restored: Array<{ lotId: number; by: string }> = [];
    const lostLots: Array<{ lotId: number; wouldRestore: string }> = [];

    await this.db.$transaction(async (tx) => {
      for (const entry of purchases) {
        const purchased = new Decimal(entry.delta);
        if (purchased.lte(0)) continue;

        if (entry.pantryItemId === null) {
          lostLots.push({
            lotId: -1,
            wouldRestore: purchased.toString(),
          });
          continue;
        }

        const current = quantityByLot.get(entry.pantryItemId);
        if (current === undefined) {
          lostLots.push({
            lotId: entry.pantryItemId,
            wouldRestore: purchased.toString(),
          });
          continue;
        }

        // Take back as much of the purchase as is still on the lot. Anything
        // already cooked or discarded is reported rather than invented.
        const takeBack = Decimal.min(current, purchased);
        const shortfall = purchased.minus(takeBack);
        if (shortfall.gt(0)) {
          lostLots.push({
            lotId: entry.pantryItemId,
            wouldRestore: shortfall.toString(),
          });
        }
        if (takeBack.lte(0)) continue;

        const nextQty = current.minus(takeBack);
        quantityByLot.set(entry.pantryItemId, nextQty);

        await tx.pantryItem.update({
          where: { id: entry.pantryItemId },
          data: { quantity: nextQty.toString() } as never,
        });

        await tx.pantryTransaction.create({
          data: {
            pantryItemId: entry.pantryItemId,
            ingredientId: entry.ingredientId,
            delta: takeBack.negated().toString(),
            unitId: entry.unitId,
            kind: TxKind.ADJUST,
            // Deliberately not linked to the session: linking would make the
            // reversal look like part of the receive it undoes.
            note: session
              ? `Undo of receive session ${session.id}`
              : `Undo of shopping list ${listId}`,
            createdById: userId,
          } as never,
        });

        restored.push({ lotId: entry.pantryItemId, by: takeBack.negated().toString() });
      }

      if (session) {
        await tx.priceObservation.deleteMany({
          where: { receiveSessionId: session.id },
        });

        await tx.receiveSession.update({
          where: { id: session.id },
          data: { reversedOn: new Date() },
        });
      }

      await tx.shoppingList.update({
        where: { id: listId },
        data: { status: ListStatus.ACTIVE, completedOn: null },
      });
    });

    return {
      listId,
      receiveSessionId: session?.id ?? null,
      restored,
      lostLots,
      list: await this.findOne(listId),
    };
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

  /**
   * Resolves an optional barcode from client input.
   *
   * Mirrors `PantryService.resolveScannedProduct` deliberately: both normalize
   * through the same function, check the product exists, and read the
   * effective category (override then consensus), so a barcode means the same
   * thing on a list as it does on a shelf. An empty string is "detach", which
   * is distinct from the field being absent — that means "leave it alone" and
   * never reaches here.
   */
  private async resolveScannedProduct(productId: string | undefined): Promise<{
    barcode: string | null;
    ingredientId: number | null;
    brand: string | null;
    name: string | null;
  }> {
    if (!productId?.trim()) {
      return { barcode: null, ingredientId: null, brand: null, name: null };
    }

    const barcode = this.products.requireBarcode(productId);
    const product = await this.products.requireProduct(barcode);
    const effective = await this.products.effectiveCategory(barcode);

    return {
      barcode,
      ingredientId: effective?.ingredientId ?? null,
      brand: product.brands?.split(',')[0]?.trim() || null,
      name: product.name,
    };
  }

  /**
   * What this exact product cost last time, as an estimate for this line.
   *
   * A price for a barcode beats a price for "flour" by a wide margin — it is
   * the same pack, the same size, usually the same shop. Only the household's
   * own observations are visible here, which the tenancy extension guarantees
   * rather than this method having to remember it.
   *
   * Returns null rather than a guess in the two cases where the arithmetic
   * would be invented:
   *
   * - the line names a **different unit** from the observation, which would
   *   need a density this method does not have;
   * - there is no observation at all.
   *
   * A line with no quantity gets the observed price as-is, because that is what
   * one of this product cost.
   */
  private async lastPriceForProduct(
    barcode: string | null,
    quantity: string | undefined,
    unitId: number | undefined,
  ): Promise<string | null> {
    if (!barcode) return null;

    const observation = await this.db.priceObservation.findFirst({
      where: { productId: barcode },
      orderBy: { observedOn: 'desc' },
      select: { price: true, quantity: true, unitId: true },
    });
    if (!observation) return null;

    if (quantity === undefined) return observation.price.toString();
    if (unitId !== observation.unitId) return null;

    const observed = new Decimal(observation.quantity);
    if (observed.lte(0)) return null;

    return new Decimal(observation.price)
      .div(observed)
      .times(new Decimal(quantity))
      .toDecimalPlaces(2)
      .toString();
  }

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
