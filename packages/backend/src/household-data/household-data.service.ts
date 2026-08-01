import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { slugify } from '@kitchen/shared-types';

import { requireHouseholdId } from '../common/household-context';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.service';
import { EXPORT_FORMAT, SCHEMA_VERSION } from './household-data.constants';
import {
  isLocalRef,
  type CategoryNaturalRef,
  type ExportedCookSession,
  type ExportedIngredient,
  type ExportedPantryItem,
  type ExportedPantryPar,
  type ExportedPantryTransaction,
  type ExportedPlannedMeal,
  type ExportedPriceObservation,
  type ExportedProductBinding,
  type ExportedReceiveSession,
  type ExportedRecipe,
  type ExportedShoppingList,
  type ExportedStorageLocation,
  type ExportedStore,
  type ExportedTag,
  type ExportedUnit,
  type HouseholdExport,
  type IngredientRefJson,
  type ImportSummary,
  type LocalRef,
  type UnitRefJson,
} from './household-export.types';
import type { ImportHouseholdDto } from './dto/household-data.dto';

/** Assigns each row a synthetic 1-based export key, keyed by its current DB id. */
function keyMap<T extends { id: number }>(rows: readonly T[]): Map<number, number> {
  return new Map(rows.map((row, index) => [row.id, index + 1]));
}

@Injectable()
export class HouseholdDataService {
  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantPrisma) {}

  // ---------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------

  async export(): Promise<HouseholdExport> {
    const householdId = requireHouseholdId();
    const household = await this.db.household.findFirst({
      where: { id: householdId },
      select: { name: true },
    });
    if (!household) throw new NotFoundException('Household not found.');

    // The global catalog, looked up once and referenced by natural key rather
    // than id — the id will not mean the same thing on whatever install this
    // file is later imported into.
    const [globalUnits, globalIngredients, categories] = await Promise.all([
      this.db.unit.findMany({
        where: { householdId: null },
        select: { id: true, name: true, kind: true },
      }),
      this.db.ingredient.findMany({
        where: { householdId: null },
        select: { id: true, slug: true },
      }),
      this.db.ingredientCategory.findMany({ select: { id: true, name: true } }),
    ]);
    const globalUnitById = new Map(globalUnits.map((u) => [u.id, { name: u.name, kind: u.kind }]));
    const globalIngredientById = new Map(globalIngredients.map((i) => [i.id, i.slug]));
    const categoryById = new Map(categories.map((c) => [c.id, c.name]));

    const ownUnits = await this.db.unit.findMany({
      where: { householdId: { not: null } },
      orderBy: { id: 'asc' },
    });
    const unitKeyByDbId = keyMap(ownUnits);

    const ownIngredients = await this.db.ingredient.findMany({
      where: { householdId: { not: null } },
      orderBy: { id: 'asc' },
      include: { aliases: { select: { alias: true } } },
    });
    const ingredientKeyByDbId = keyMap(ownIngredients);

    const unitRef = (id: number | null): UnitRefJson | null => {
      if (id === null) return null;
      const key = unitKeyByDbId.get(id);
      if (key !== undefined) return { key };
      const global = globalUnitById.get(id);
      if (!global) throw new Error(`Unit ${id} is neither household-owned nor global.`);
      return { name: global.name, kind: global.kind };
    };

    const ingredientRef = (id: number | null): IngredientRefJson | null => {
      if (id === null) return null;
      const key = ingredientKeyByDbId.get(id);
      if (key !== undefined) return { key };
      const slug = globalIngredientById.get(id);
      if (slug === undefined) throw new Error(`Ingredient ${id} is neither household-owned nor global.`);
      return { slug };
    };

    const categoryRef = (id: number | null): CategoryNaturalRef | null => {
      if (id === null) return null;
      const name = categoryById.get(id);
      if (name === undefined) throw new Error(`Category ${id} not found.`);
      return { name };
    };

    const storageLocationRows = await this.db.storageLocation.findMany({ orderBy: { id: 'asc' } });
    const locationKeyByDbId = keyMap(storageLocationRows);

    const tagRows = await this.db.tag.findMany({ orderBy: { id: 'asc' } });
    const tagKeyByDbId = keyMap(tagRows);

    const recipeRows = await this.db.recipe.findMany({
      orderBy: { id: 'asc' },
      include: {
        ingredients: { orderBy: { sortOrder: 'asc' } },
        steps: { orderBy: { sortOrder: 'asc' } },
        tags: true,
      },
    });
    const recipeKeyByDbId = keyMap(recipeRows);

    const storeRows = await this.db.store.findMany({
      orderBy: { id: 'asc' },
      include: { aisles: { orderBy: { sortOrder: 'asc' } } },
    });
    const storeKeyByDbId = keyMap(storeRows);

    const pantryItemRows = await this.db.pantryItem.findMany({ orderBy: { id: 'asc' } });
    const pantryItemKeyByDbId = keyMap(pantryItemRows);

    const plannedMealRows = await this.db.plannedMeal.findMany({ orderBy: { id: 'asc' } });
    const plannedMealKeyByDbId = keyMap(plannedMealRows);

    const cookSessionRows = await this.db.cookSession.findMany({ orderBy: { id: 'asc' } });
    const cookSessionKeyByDbId = keyMap(cookSessionRows);

    const shoppingListRows = await this.db.shoppingList.findMany({
      orderBy: { id: 'asc' },
      include: { items: { orderBy: { id: 'asc' } } },
    });
    const shoppingListKeyByDbId = keyMap(shoppingListRows);

    const receiveSessionRows = await this.db.receiveSession.findMany({ orderBy: { id: 'asc' } });
    const receiveSessionKeyByDbId = keyMap(receiveSessionRows);

    const local = (map: Map<number, number>, id: number): LocalRef => {
      const key = map.get(id);
      if (key === undefined) throw new Error('Internal error: local reference not found while exporting.');
      return { key };
    };
    const localOrNull = (map: Map<number, number>, id: number | null): LocalRef | null =>
      id === null ? null : local(map, id);

    const units: ExportedUnit[] = ownUnits.map((u) => ({
      key: unitKeyByDbId.get(u.id)!,
      name: u.name,
      plural: u.plural,
      abbrev: u.abbrev,
      kind: u.kind,
      toBaseFactor: u.toBaseFactor.toString(),
    }));

    const ingredients: ExportedIngredient[] = ownIngredients.map((i) => ({
      key: ingredientKeyByDbId.get(i.id)!,
      name: i.name,
      slug: i.slug,
      category: categoryRef(i.categoryId),
      defaultUnit: unitRef(i.defaultUnitId),
      gramsPerMl: i.gramsPerMl?.toString() ?? null,
      gramsPerPiece: i.gramsPerPiece?.toString() ?? null,
      shelfLifeDays: i.shelfLifeDays,
      note: i.note,
      aliases: i.aliases.map((a) => a.alias),
    }));

    const storageLocations: ExportedStorageLocation[] = storageLocationRows.map((l) => ({
      key: locationKeyByDbId.get(l.id)!,
      name: l.name,
      sortOrder: l.sortOrder,
    }));

    const tags: ExportedTag[] = tagRows.map((t) => ({
      key: tagKeyByDbId.get(t.id)!,
      name: t.name,
      slug: t.slug,
      kind: t.kind,
    }));

    const recipes: ExportedRecipe[] = recipeRows.map((r) => ({
      key: recipeKeyByDbId.get(r.id)!,
      title: r.title,
      slug: r.slug,
      description: r.description,
      servings: r.servings,
      prepMinutes: r.prepMinutes,
      cookMinutes: r.cookMinutes,
      sourceUrl: r.sourceUrl,
      sourceNote: r.sourceNote,
      imagePath: r.imagePath,
      notes: r.notes,
      createdOn: r.createdOn.toISOString(),
      updatedOn: r.updatedOn.toISOString(),
      archivedOn: r.archivedOn?.toISOString() ?? null,
      ingredients: r.ingredients.map((line) => ({
        sortOrder: line.sortOrder,
        ingredient: ingredientRef(line.ingredientId),
        rawText: line.rawText,
        quantity: line.quantity?.toString() ?? null,
        unit: unitRef(line.unitId),
        preparation: line.preparation,
        groupLabel: line.groupLabel,
        optional: line.optional,
      })),
      steps: r.steps.map((s) => ({ sortOrder: s.sortOrder, text: s.text })),
      tags: r.tags.map((t) => local(tagKeyByDbId, t.tagId)),
    }));

    const stores: ExportedStore[] = storeRows.map((s) => ({
      key: storeKeyByDbId.get(s.id)!,
      name: s.name,
      sortOrder: s.sortOrder,
      note: s.note,
      aisles: s.aisles.map((a) => ({
        category: categoryRef(a.categoryId)!,
        sortOrder: a.sortOrder,
      })),
    }));

    const pantryItems: ExportedPantryItem[] = pantryItemRows.map((p) => ({
      key: pantryItemKeyByDbId.get(p.id)!,
      ingredient: ingredientRef(p.ingredientId)!,
      location: local(locationKeyByDbId, p.locationId),
      quantity: p.quantity.toString(),
      unit: unitRef(p.unitId)!,
      brand: p.brand,
      productBarcode: p.productId,
      openedOn: p.openedOn?.toISOString() ?? null,
      expiresOn: p.expiresOn?.toISOString() ?? null,
      note: p.note,
      createdOn: p.createdOn.toISOString(),
    }));

    const pantryParRows = await this.db.pantryPar.findMany({ orderBy: { id: 'asc' } });
    const pantryPars: ExportedPantryPar[] = pantryParRows.map((p) => ({
      ingredient: ingredientRef(p.ingredientId)!,
      minQuantity: p.minQuantity.toString(),
      unit: unitRef(p.unitId)!,
    }));

    const plannedMeals: ExportedPlannedMeal[] = plannedMealRows.map((m) => ({
      key: plannedMealKeyByDbId.get(m.id)!,
      date: m.date.toISOString(),
      slot: m.slot,
      sortOrder: m.sortOrder,
      recipe: localOrNull(recipeKeyByDbId, m.recipeId),
      note: m.note,
      servings: m.servings,
      status: m.status,
      createdOn: m.createdOn.toISOString(),
    }));

    const cookSessions: ExportedCookSession[] = cookSessionRows.map((c) => ({
      key: cookSessionKeyByDbId.get(c.id)!,
      plannedMeal: localOrNull(plannedMealKeyByDbId, c.plannedMealId),
      recipe: local(recipeKeyByDbId, c.recipeId),
      servings: c.servings,
      cookedOn: c.cookedOn.toISOString(),
      note: c.note,
      reversedOn: c.reversedOn?.toISOString() ?? null,
    }));

    const shoppingLists: ExportedShoppingList[] = shoppingListRows.map((l) => ({
      key: shoppingListKeyByDbId.get(l.id)!,
      name: l.name,
      store: localOrNull(storeKeyByDbId, l.storeId),
      status: l.status,
      createdOn: l.createdOn.toISOString(),
      completedOn: l.completedOn?.toISOString() ?? null,
      items: l.items.map((i) => ({
        ingredient: ingredientRef(i.ingredientId),
        rawName: i.rawName,
        quantity: i.quantity?.toString() ?? null,
        unit: unitRef(i.unitId),
        source: i.source,
        sourcePlannedMeal: localOrNull(plannedMealKeyByDbId, i.sourcePlannedMealId),
        store: localOrNull(storeKeyByDbId, i.storeId),
        brand: i.brand,
        productBarcode: i.productId,
        estimatedPrice: i.estimatedPrice?.toString() ?? null,
        actualPrice: i.actualPrice?.toString() ?? null,
        unconvertible: i.unconvertible,
        checkedOn: i.checkedOn?.toISOString() ?? null,
        note: i.note,
      })),
    }));

    const receiveSessions: ExportedReceiveSession[] = receiveSessionRows.map((r) => ({
      key: receiveSessionKeyByDbId.get(r.id)!,
      shoppingList: local(shoppingListKeyByDbId, r.shoppingListId),
      receivedOn: r.receivedOn.toISOString(),
      reversedOn: r.reversedOn?.toISOString() ?? null,
    }));

    const pantryTransactionRows = await this.db.pantryTransaction.findMany({ orderBy: { id: 'asc' } });
    const pantryTransactions: ExportedPantryTransaction[] = pantryTransactionRows.map((t) => ({
      pantryItem: localOrNull(pantryItemKeyByDbId, t.pantryItemId),
      ingredient: ingredientRef(t.ingredientId)!,
      delta: t.delta.toString(),
      unit: unitRef(t.unitId)!,
      kind: t.kind,
      cookSession: localOrNull(cookSessionKeyByDbId, t.cookSessionId),
      receiveSession: localOrNull(receiveSessionKeyByDbId, t.receiveSessionId),
      note: t.note,
      createdOn: t.createdOn.toISOString(),
    }));

    const priceObservationRows = await this.db.priceObservation.findMany({ orderBy: { id: 'asc' } });
    const priceObservations: ExportedPriceObservation[] = priceObservationRows.map((p) => ({
      ingredient: ingredientRef(p.ingredientId)!,
      store: localOrNull(storeKeyByDbId, p.storeId),
      brand: p.brand,
      productBarcode: p.productId,
      quantity: p.quantity.toString(),
      unit: unitRef(p.unitId)!,
      price: p.price.toString(),
      observedOn: p.observedOn.toISOString(),
      receiveSession: localOrNull(receiveSessionKeyByDbId, p.receiveSessionId),
    }));

    const productBindingRows = await this.db.productBinding.findMany({ orderBy: { id: 'asc' } });
    const productBindings: ExportedProductBinding[] = productBindingRows.map((b) => ({
      productBarcode: b.productId,
      ingredient: ingredientRef(b.ingredientId)!,
    }));

    return {
      exportFormat: EXPORT_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      exportedOn: new Date().toISOString(),
      householdName: household.name,
      storageLocations,
      catalog: { units, ingredients },
      tags,
      recipes,
      stores,
      pantryItems,
      pantryPars,
      plannedMeals,
      cookSessions,
      shoppingLists,
      receiveSessions,
      pantryTransactions,
      priceObservations,
      productBindings,
    };
  }

  // ---------------------------------------------------------------------
  // Import
  // ---------------------------------------------------------------------

  /**
   * Restores a previously exported file into the *current* household.
   *
   * Intended for a fresh household with no conflicting data — a restore after
   * a wipe or reinstall, not a merge into a live one. Any collision (a
   * same-slug recipe, a same-name store, ...) aborts the whole import inside
   * one transaction, so nothing is left half-applied.
   */
  async import(dto: ImportHouseholdDto, userId: number): Promise<ImportSummary> {
    if (dto.schemaVersion !== SCHEMA_VERSION) {
      throw new BadRequestException(
        `This file is export schema version ${dto.schemaVersion}; this server ` +
          `supports version ${SCHEMA_VERSION}.`,
      );
    }

    const householdId = requireHouseholdId();

    const [globalUnits, globalIngredients, categories] = await Promise.all([
      this.db.unit.findMany({ where: { householdId: null }, select: { id: true, name: true } }),
      this.db.ingredient.findMany({ where: { householdId: null }, select: { id: true, slug: true } }),
      this.db.ingredientCategory.findMany({ select: { id: true, name: true } }),
    ]);
    const globalUnitIdByName = new Map(globalUnits.map((u) => [u.name, u.id]));
    const globalIngredientIdBySlug = new Map(globalIngredients.map((i) => [i.slug, i.id]));
    const categoryIdByName = new Map(categories.map((c) => [c.name, c.id]));

    return this.db.$transaction(
      async (tx) => {
        const locationIdByKey = new Map<number, number>();
        const unitIdByKey = new Map<number, number>();
        const ingredientIdByKey = new Map<number, number>();
        const tagIdByKey = new Map<number, number>();
        const recipeIdByKey = new Map<number, number>();
        const storeIdByKey = new Map<number, number>();
        const pantryItemIdByKey = new Map<number, number>();
        const plannedMealIdByKey = new Map<number, number>();
        const cookSessionIdByKey = new Map<number, number>();
        const shoppingListIdByKey = new Map<number, number>();
        const receiveSessionIdByKey = new Map<number, number>();

        const resolveCategory = (ref: { name: string } | null): number | null => {
          if (!ref) return null;
          const id = categoryIdByName.get(ref.name);
          if (id === undefined) {
            throw new BadRequestException(`Import aborted: unknown ingredient category "${ref.name}".`);
          }
          return id;
        };

        const resolveUnit = (ref: UnitRefJson | null): number | null => {
          if (!ref) return null;
          if (isLocalRef(ref)) {
            const id = unitIdByKey.get(ref.key);
            if (id === undefined) {
              throw new BadRequestException(`Import aborted: unit reference key ${ref.key} was never defined.`);
            }
            return id;
          }
          const id = globalUnitIdByName.get(ref.name);
          if (id === undefined) {
            throw new BadRequestException(`Import aborted: unknown standard unit "${ref.name}".`);
          }
          return id;
        };

        const resolveIngredient = (ref: IngredientRefJson | null): number | null => {
          if (!ref) return null;
          if (isLocalRef(ref)) {
            const id = ingredientIdByKey.get(ref.key);
            if (id === undefined) {
              throw new BadRequestException(
                `Import aborted: ingredient reference key ${ref.key} was never defined.`,
              );
            }
            return id;
          }
          const id = globalIngredientIdBySlug.get(ref.slug);
          if (id === undefined) {
            throw new BadRequestException(`Import aborted: unknown catalog ingredient "${ref.slug}".`);
          }
          return id;
        };

        const resolveLocal = (model: string, map: Map<number, number>, ref: LocalRef): number => {
          const id = map.get(ref.key);
          if (id === undefined) {
            throw new BadRequestException(`Import aborted: ${model} reference key ${ref.key} was never defined.`);
          }
          return id;
        };
        const resolveLocalOrNull = (
          model: string,
          map: Map<number, number>,
          ref: LocalRef | null,
        ): number | null => (ref ? resolveLocal(model, map, ref) : null);

        /**
         * Looks up a barcode in the target install's Product mirror, natural-key
         * style like every other global reference. A product that no longer
         * exists there (a different OFF snapshot) is treated as "not scanned"
         * rather than failing the whole import — the barcode is informational,
         * never load-bearing for the row it is attached to.
         */
        const resolveProduct = async (barcode: string | null): Promise<string | null> => {
          if (!barcode) return null;
          const product = await tx.product.findUnique({ where: { barcode }, select: { barcode: true } });
          return product?.barcode ?? null;
        };

        // 1. Storage locations ------------------------------------------------
        for (const loc of dto.storageLocations as ExportedStorageLocationInput[]) {
          await assertFree(
            tx.storageLocation.findFirst({ where: { name: loc.name } }),
            `Import aborted: a storage location called "${loc.name}" already exists in this household.`,
          );
          const created = await tx.storageLocation.create({
            data: { name: loc.name, sortOrder: loc.sortOrder } as never,
          });
          locationIdByKey.set(loc.key, created.id);
        }

        // 2. Household units ---------------------------------------------------
        for (const unit of dto.catalog.units as ExportedUnitInput[]) {
          await assertFree(
            tx.unit.findFirst({ where: { name: { equals: unit.name, mode: 'insensitive' } } }),
            `Import aborted: a unit called "${unit.name}" already exists.`,
          );
          const created = await tx.unit.create({
            data: {
              name: unit.name,
              plural: unit.plural,
              abbrev: unit.abbrev,
              kind: unit.kind,
              toBaseFactor: unit.toBaseFactor,
            } as never,
          });
          unitIdByKey.set(unit.key, created.id);
        }

        // 3. Household ingredients ---------------------------------------------
        for (const ingredient of dto.catalog.ingredients as ExportedIngredientInput[]) {
          await assertFree(
            tx.ingredient.findFirst({ where: { slug: ingredient.slug, householdId } }),
            `Import aborted: an ingredient called "${ingredient.name}" already exists in this household.`,
          );
          const created = await tx.ingredient.create({
            data: {
              name: ingredient.name,
              slug: ingredient.slug,
              categoryId: resolveCategory(ingredient.category),
              defaultUnitId: resolveUnit(ingredient.defaultUnit),
              gramsPerMl: ingredient.gramsPerMl,
              gramsPerPiece: ingredient.gramsPerPiece,
              shelfLifeDays: ingredient.shelfLifeDays,
              note: ingredient.note,
              aliases: {
                create: ingredient.aliases.map((alias) => ({
                  alias,
                  slug: slugify(alias),
                })),
              },
            } as never,
          });
          ingredientIdByKey.set(ingredient.key, created.id);
        }

        // 4. Tags ----------------------------------------------------------------
        for (const tag of dto.tags as ExportedTagInput[]) {
          await assertFree(
            tx.tag.findFirst({ where: { slug: tag.slug } }),
            `Import aborted: a tag called "${tag.name}" already exists.`,
          );
          const created = await tx.tag.create({
            data: { name: tag.name, slug: tag.slug, kind: tag.kind } as never,
          });
          tagIdByKey.set(tag.key, created.id);
        }

        // 5. Recipes ---------------------------------------------------------------
        for (const recipe of dto.recipes as ExportedRecipeInput[]) {
          await assertFree(
            tx.recipe.findFirst({ where: { slug: recipe.slug } }),
            `Import aborted: a recipe with slug "${recipe.slug}" already exists in this household.`,
          );
          const created = await tx.recipe.create({
            data: {
              title: recipe.title,
              slug: recipe.slug,
              description: recipe.description,
              servings: recipe.servings,
              prepMinutes: recipe.prepMinutes,
              cookMinutes: recipe.cookMinutes,
              sourceUrl: recipe.sourceUrl,
              sourceNote: recipe.sourceNote,
              imagePath: recipe.imagePath,
              notes: recipe.notes,
              createdById: userId,
              archivedOn: recipe.archivedOn ? new Date(recipe.archivedOn) : null,
              ingredients: {
                create: recipe.ingredients.map((line) => ({
                  sortOrder: line.sortOrder,
                  ingredientId: resolveIngredient(line.ingredient),
                  rawText: line.rawText,
                  quantity: line.quantity,
                  unitId: resolveUnit(line.unit),
                  preparation: line.preparation,
                  groupLabel: line.groupLabel,
                  optional: line.optional,
                })),
              },
              steps: { create: recipe.steps },
              tags: {
                create: recipe.tags.map((ref) => ({
                  tagId: resolveLocal('tag', tagIdByKey, ref),
                })),
              },
            } as never,
          });
          recipeIdByKey.set(recipe.key, created.id);
        }

        // 6. Stores ------------------------------------------------------------
        for (const store of dto.stores as ExportedStoreInput[]) {
          await assertFree(
            tx.store.findFirst({ where: { name: { equals: store.name, mode: 'insensitive' } } }),
            `Import aborted: a store called "${store.name}" already exists.`,
          );
          const created = await tx.store.create({
            data: {
              name: store.name,
              sortOrder: store.sortOrder,
              note: store.note,
              aisles: {
                create: store.aisles.map((aisle) => ({
                  categoryId: resolveCategory(aisle.category)!,
                  sortOrder: aisle.sortOrder,
                })),
              },
            } as never,
          });
          storeIdByKey.set(store.key, created.id);
        }

        // 7. Pantry items --------------------------------------------------------
        for (const item of dto.pantryItems as ExportedPantryItemInput[]) {
          const created = await tx.pantryItem.create({
            data: {
              ingredientId: resolveIngredient(item.ingredient)!,
              locationId: resolveLocal('storage location', locationIdByKey, item.location),
              quantity: item.quantity,
              unitId: resolveUnit(item.unit)!,
              brand: item.brand,
              productId: await resolveProduct(item.productBarcode),
              openedOn: item.openedOn ? new Date(item.openedOn) : null,
              expiresOn: item.expiresOn ? new Date(item.expiresOn) : null,
              note: item.note,
            } as never,
          });
          pantryItemIdByKey.set(item.key, created.id);
        }

        // 8. Pantry pars ---------------------------------------------------------
        for (const par of dto.pantryPars as ExportedPantryParInput[]) {
          await tx.pantryPar.create({
            data: {
              ingredientId: resolveIngredient(par.ingredient)!,
              minQuantity: par.minQuantity,
              unitId: resolveUnit(par.unit)!,
            } as never,
          });
        }

        // 9. Planned meals ---------------------------------------------------------
        for (const meal of dto.plannedMeals as ExportedPlannedMealInput[]) {
          const created = await tx.plannedMeal.create({
            data: {
              date: new Date(meal.date),
              slot: meal.slot,
              sortOrder: meal.sortOrder,
              recipeId: resolveLocalOrNull('recipe', recipeIdByKey, meal.recipe),
              note: meal.note,
              servings: meal.servings,
              status: meal.status,
              createdById: userId,
            } as never,
          });
          plannedMealIdByKey.set(meal.key, created.id);
        }

        // 10. Cook sessions ---------------------------------------------------------
        for (const session of dto.cookSessions as ExportedCookSessionInput[]) {
          const created = await tx.cookSession.create({
            data: {
              plannedMealId: resolveLocalOrNull('planned meal', plannedMealIdByKey, session.plannedMeal),
              recipeId: resolveLocal('recipe', recipeIdByKey, session.recipe),
              servings: session.servings,
              cookedOn: new Date(session.cookedOn),
              note: session.note,
              reversedOn: session.reversedOn ? new Date(session.reversedOn) : null,
            } as never,
          });
          cookSessionIdByKey.set(session.key, created.id);
        }

        // 11. Shopping lists ---------------------------------------------------------
        for (const list of dto.shoppingLists as ExportedShoppingListInput[]) {
          const created = await tx.shoppingList.create({
            data: {
              name: list.name,
              storeId: resolveLocalOrNull('store', storeIdByKey, list.store),
              status: list.status,
              completedOn: list.completedOn ? new Date(list.completedOn) : null,
              items: {
                create: await Promise.all(
                  list.items.map(async (item) => ({
                    ingredientId: resolveIngredient(item.ingredient),
                    rawName: item.rawName,
                    quantity: item.quantity,
                    unitId: resolveUnit(item.unit),
                    source: item.source,
                    sourcePlannedMealId: resolveLocalOrNull(
                      'planned meal',
                      plannedMealIdByKey,
                      item.sourcePlannedMeal,
                    ),
                    storeId: resolveLocalOrNull('store', storeIdByKey, item.store),
                    brand: item.brand,
                    productId: await resolveProduct(item.productBarcode),
                    estimatedPrice: item.estimatedPrice,
                    actualPrice: item.actualPrice,
                    unconvertible: item.unconvertible,
                    checkedOn: item.checkedOn ? new Date(item.checkedOn) : null,
                    note: item.note,
                  })),
                ),
              },
            } as never,
          });
          shoppingListIdByKey.set(list.key, created.id);
        }

        // 12. Receive sessions ---------------------------------------------------------
        for (const session of dto.receiveSessions as ExportedReceiveSessionInput[]) {
          const created = await tx.receiveSession.create({
            data: {
              shoppingListId: resolveLocal('shopping list', shoppingListIdByKey, session.shoppingList),
              receivedOn: new Date(session.receivedOn),
              reversedOn: session.reversedOn ? new Date(session.reversedOn) : null,
            } as never,
          });
          receiveSessionIdByKey.set(session.key, created.id);
        }

        // 13. Pantry transactions ---------------------------------------------------------
        for (const entry of dto.pantryTransactions as ExportedPantryTransactionInput[]) {
          await tx.pantryTransaction.create({
            data: {
              pantryItemId: resolveLocalOrNull('pantry item', pantryItemIdByKey, entry.pantryItem),
              ingredientId: resolveIngredient(entry.ingredient)!,
              delta: entry.delta,
              unitId: resolveUnit(entry.unit)!,
              kind: entry.kind,
              cookSessionId: resolveLocalOrNull('cook session', cookSessionIdByKey, entry.cookSession),
              receiveSessionId: resolveLocalOrNull(
                'receive session',
                receiveSessionIdByKey,
                entry.receiveSession,
              ),
              note: entry.note,
              createdById: userId,
            } as never,
          });
        }

        // 14. Price observations ---------------------------------------------------------
        for (const observation of dto.priceObservations as ExportedPriceObservationInput[]) {
          await tx.priceObservation.create({
            data: {
              ingredientId: resolveIngredient(observation.ingredient)!,
              storeId: resolveLocalOrNull('store', storeIdByKey, observation.store),
              brand: observation.brand,
              productId: await resolveProduct(observation.productBarcode),
              quantity: observation.quantity,
              unitId: resolveUnit(observation.unit)!,
              price: observation.price,
              observedOn: new Date(observation.observedOn),
              receiveSessionId: resolveLocalOrNull(
                'receive session',
                receiveSessionIdByKey,
                observation.receiveSession,
              ),
            } as never,
          });
        }

        // 15. Product bindings ---------------------------------------------------------
        let productBindingsWritten = 0;
        for (const binding of dto.productBindings as ExportedProductBindingInput[]) {
          const productId = await resolveProduct(binding.productBarcode);
          if (!productId) continue; // The product no longer exists in this install's OFF mirror.
          await tx.productBinding.create({
            data: {
              productId,
              ingredientId: resolveIngredient(binding.ingredient)!,
            } as never,
          });
          productBindingsWritten += 1;
        }

        return {
          storageLocations: locationIdByKey.size,
          units: unitIdByKey.size,
          ingredients: ingredientIdByKey.size,
          tags: tagIdByKey.size,
          recipes: recipeIdByKey.size,
          stores: storeIdByKey.size,
          pantryItems: pantryItemIdByKey.size,
          pantryPars: (dto.pantryPars as unknown[]).length,
          plannedMeals: plannedMealIdByKey.size,
          cookSessions: cookSessionIdByKey.size,
          shoppingLists: shoppingListIdByKey.size,
          receiveSessions: receiveSessionIdByKey.size,
          pantryTransactions: (dto.pantryTransactions as unknown[]).length,
          priceObservations: (dto.priceObservations as unknown[]).length,
          productBindings: productBindingsWritten,
        };
      },
      { timeout: 30_000 },
    );
  }
}

// -- Row shapes as they arrive from the uploaded JSON -----------------------
//
// The DTO validates only the envelope (see dto/household-data.dto.ts); these
// narrow the section arrays to what the import loop expects. A row that does
// not actually match — a missing field, a wrong type — surfaces as a Prisma
// error from the `create` call, which is caught the same way a collision is.

type ExportedStorageLocationInput = { key: number; name: string; sortOrder: number };
type ExportedUnitInput = {
  key: number;
  name: string;
  plural: string;
  abbrev: string | null;
  kind: string;
  toBaseFactor: string;
};
type ExportedIngredientInput = {
  key: number;
  name: string;
  slug: string;
  category: { name: string } | null;
  defaultUnit: UnitRefJson | null;
  gramsPerMl: string | null;
  gramsPerPiece: string | null;
  shelfLifeDays: number | null;
  note: string | null;
  aliases: string[];
};
type ExportedTagInput = { key: number; name: string; slug: string; kind: string };
type ExportedRecipeInput = {
  key: number;
  title: string;
  slug: string;
  description: string | null;
  servings: number;
  prepMinutes: number | null;
  cookMinutes: number | null;
  sourceUrl: string | null;
  sourceNote: string | null;
  imagePath: string | null;
  notes: string | null;
  archivedOn: string | null;
  ingredients: Array<{
    sortOrder: number;
    ingredient: IngredientRefJson | null;
    rawText: string;
    quantity: string | null;
    unit: UnitRefJson | null;
    preparation: string | null;
    groupLabel: string | null;
    optional: boolean;
  }>;
  steps: Array<{ sortOrder: number; text: string }>;
  tags: LocalRef[];
};
type ExportedStoreInput = {
  key: number;
  name: string;
  sortOrder: number;
  note: string | null;
  aisles: Array<{ category: { name: string }; sortOrder: number }>;
};
type ExportedPantryItemInput = {
  key: number;
  ingredient: IngredientRefJson;
  location: LocalRef;
  quantity: string;
  unit: UnitRefJson;
  brand: string | null;
  productBarcode: string | null;
  openedOn: string | null;
  expiresOn: string | null;
  note: string | null;
};
type ExportedPantryParInput = { ingredient: IngredientRefJson; minQuantity: string; unit: UnitRefJson };
type ExportedPlannedMealInput = {
  key: number;
  date: string;
  slot: string;
  sortOrder: number;
  recipe: LocalRef | null;
  note: string | null;
  servings: number;
  status: string;
};
type ExportedCookSessionInput = {
  key: number;
  plannedMeal: LocalRef | null;
  recipe: LocalRef;
  servings: number;
  cookedOn: string;
  note: string | null;
  reversedOn: string | null;
};
type ExportedShoppingListInput = {
  key: number;
  name: string;
  store: LocalRef | null;
  status: string;
  completedOn: string | null;
  items: Array<{
    ingredient: IngredientRefJson | null;
    rawName: string | null;
    quantity: string | null;
    unit: UnitRefJson | null;
    source: string;
    sourcePlannedMeal: LocalRef | null;
    store: LocalRef | null;
    brand: string | null;
    productBarcode: string | null;
    estimatedPrice: string | null;
    actualPrice: string | null;
    unconvertible: boolean;
    checkedOn: string | null;
    note: string | null;
  }>;
};
type ExportedReceiveSessionInput = {
  key: number;
  shoppingList: LocalRef;
  receivedOn: string;
  reversedOn: string | null;
};
type ExportedPantryTransactionInput = {
  pantryItem: LocalRef | null;
  ingredient: IngredientRefJson;
  delta: string;
  unit: UnitRefJson;
  kind: string;
  cookSession: LocalRef | null;
  receiveSession: LocalRef | null;
  note: string | null;
};
type ExportedPriceObservationInput = {
  ingredient: IngredientRefJson;
  store: LocalRef | null;
  brand: string | null;
  productBarcode: string | null;
  quantity: string;
  unit: UnitRefJson;
  price: string;
  observedOn: string;
  receiveSession: LocalRef | null;
};
type ExportedProductBindingInput = { productBarcode: string; ingredient: IngredientRefJson };

/**
 * Throws with `message` if `query` finds a row — the pre-insert collision
 * check every household-owned create runs before writing, so the error names
 * the exact conflicting row instead of surfacing a bare constraint violation.
 */
async function assertFree(query: Promise<unknown>, message: string): Promise<void> {
  const found = await query;
  if (found) throw new BadRequestException(message);
}
