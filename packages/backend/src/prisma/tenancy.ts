/**
 * Tenancy enforcement as a Prisma client extension.
 *
 * Guards check *who* you are; this checks *whose data you are touching*. One
 * service method that forgets a `where` clause is enough to leak another
 * household's recipes, so the filter is applied at the client level where it
 * cannot be forgotten, rather than in each query.
 *
 * The scoping functions below are pure and separately tested — the extension is a
 * thin wrapper that calls them.
 */

import {
  getHouseholdContext,
  isUnscoped,
  requireHouseholdId,
} from '../common/household-context';

/**
 * Models with a required `householdId`. Every read and write is filtered to the
 * active household.
 */
export const TENANT_SCOPED_MODELS = new Set([
  'User',
  'HouseholdAiConfig',
  'Recipe',
  'Tag',
  'StorageLocation',
  'PantryItem',
  'PantryPar',
  'PantryTransaction',
  'PlannedMeal',
  'CookSession',
  'Store',
  'ShoppingList',
  'ReceiveSession',
  'PriceObservation',
  'ProductBinding',
  'ScanQueueEntry',
]);

/**
 * Catalog models with a *nullable* `householdId`: null rows are the seeded global
 * catalog, non-null rows are a household's own additions. Reads see both; writes
 * create household-private rows.
 */
export const SHARED_CATALOG_MODELS = new Set(['Unit', 'Ingredient']);

/**
 * Models with no `householdId` of their own, reached only through a scoped parent
 * (a RecipeIngredient through its Recipe, a ShoppingListItem through its List).
 *
 * These are NOT auto-filtered — there is nothing to filter on. Services must load
 * the parent through the scoped client first and derive the child from it, rather
 * than querying children by id directly. `IngredientCategory` and `Household` are
 * here because they are genuinely not household-scoped.
 *
 * `Product` is the third of that kind, and the one to be careful about. It is the
 * Open Food Facts mirror: global, shared by every household, and owned by the
 * import CLI. Being in this set means the extension does not filter it, which is
 * correct for reads — but it also means nothing here stops a write. What stops a
 * write is that no service and no endpoint performs one; `ProductsService` reads
 * `product` and writes only `productBinding`, which is tenant-scoped above.
 */
export const PARENT_SCOPED_MODELS = new Set([
  'Household',
  'IngredientCategory',
  'IngredientAlias',
  'RecipeIngredient',
  'RecipeStep',
  'RecipeTag',
  'StoreAisle',
  'ShoppingListItem',
  'Product',
]);

/** Read operations whose `args.where` selects the rows returned. */
const WHERE_READ_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/**
 * Write operations whose `args.where` selects the rows changed or removed.
 *
 * Kept separate from reads because the catalog models treat them differently:
 * a household may *read* the global catalog but must never *write* to it.
 */
const WHERE_WRITE_OPERATIONS = new Set([
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
]);

/** Operations that create rows and therefore need `householdId` stamped on. */
const CREATE_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'upsert',
]);

type Args = Record<string, unknown>;

/**
 * Forces `householdId` onto a where clause.
 *
 * The caller's value is overwritten rather than merged: a request that arrives
 * asking for another household's id is either a bug or an attack, and in both
 * cases the right answer is to scope it to the caller's own household and return
 * nothing.
 */
export function scopeTenantWhere(where: unknown, householdId: number): Args {
  return { ...((where as Args) ?? {}), householdId };
}

/**
 * Restricts a catalog read to the global rows plus this household's own.
 *
 * Wrapped in AND so it composes with whatever the caller asked for instead of
 * overwriting it — a search for `name contains "flour"` still applies.
 */
export function scopeCatalogWhere(where: unknown, householdId: number): Args {
  const visibility = {
    OR: [{ householdId: null }, { householdId }],
  };

  const original = (where as Args) ?? {};
  if (Object.keys(original).length === 0) return visibility;

  return { AND: [original, visibility] };
}

/** Stamps `householdId` onto created rows, including `createMany` arrays. */
export function scopeCreateData(data: unknown, householdId: number): unknown {
  if (Array.isArray(data)) {
    return data.map((row) => ({ ...(row as Args), householdId }));
  }
  return { ...((data as Args) ?? {}), householdId };
}

/**
 * Applies the appropriate scoping for one operation, returning new args.
 * Pure: it does not read the ambient context, so it can be tested directly.
 */
export function scopeArgs(
  model: string,
  operation: string,
  args: Args,
  householdId: number,
): Args {
  const isTenant = TENANT_SCOPED_MODELS.has(model);
  const isCatalog = SHARED_CATALOG_MODELS.has(model);
  if (!isTenant && !isCatalog) return args;

  const scoped: Args = { ...args };

  if (WHERE_READ_OPERATIONS.has(operation)) {
    scoped.where = isTenant
      ? scopeTenantWhere(args.where, householdId)
      : scopeCatalogWhere(args.where, householdId);
  }

  // Catalog *writes* get the strict tenant filter, not the visibility rule.
  // Reads see the global rows plus the household's own; if writes used the same
  // rule, `ingredient.update({ where: { id } })` on a seeded global row would
  // succeed and one household could rewrite the shared catalog for everyone.
  // Editing global rows is the seeder's job, through the unscoped client.
  if (WHERE_WRITE_OPERATIONS.has(operation)) {
    scoped.where = scopeTenantWhere(args.where, householdId);
  }

  if (CREATE_OPERATIONS.has(operation)) {
    // upsert carries both a `create` and an `update`; only `create` makes a row.
    if (operation === 'upsert') {
      if (args.create) scoped.create = scopeCreateData(args.create, householdId);
    } else if (args.data !== undefined) {
      scoped.data = scopeCreateData(args.data, householdId);
    }
  }

  return scoped;
}

/**
 * The Prisma client extension. Applied once at startup; it reads the active
 * household from AsyncLocalStorage on every query, so a single extended client
 * serves every request.
 */
export const tenancyExtension = {
  name: 'household-tenancy',
  query: {
    $allModels: {
      async $allOperations({
        model,
        operation,
        args,
        query,
      }: {
        model: string;
        operation: string;
        args: Args;
        query: (args: Args) => Promise<unknown>;
      }): Promise<unknown> {
        // Deliberately exempt (login, registration, startup tasks).
        if (isUnscoped()) return query(args);

        const scopedModel =
          TENANT_SCOPED_MODELS.has(model) || SHARED_CATALOG_MODELS.has(model);
        if (!scopedModel) return query(args);

        // Fail closed: a scoped model reached without context would otherwise
        // read or write across every household.
        if (!getHouseholdContext()) {
          throw new Error(
            `Query on tenant-scoped model "${model}" ran without a household ` +
              'context. Wrap the request in runWithHousehold(), or use ' +
              'runUnscoped() if crossing households is genuinely intended.',
          );
        }

        return query(scopeArgs(model, operation, args, requireHouseholdId()));
      },
    },
  },
} as const;
