import { SYSTEM_HOUSEHOLD_ID } from '@kitchen/shared-types';

import {
  PARENT_SCOPED_MODELS,
  SHARED_CATALOG_MODELS,
  TENANT_SCOPED_MODELS,
  scopeArgs,
  scopeCatalogWhere,
  scopeCreateData,
  scopeTenantWhere,
} from './tenancy';

const HOUSEHOLD = 7;
const OTHER = 99;

describe('scopeTenantWhere', () => {
  it('adds householdId to an empty where', () => {
    expect(scopeTenantWhere(undefined, HOUSEHOLD)).toEqual({ householdId: HOUSEHOLD });
  });

  it('preserves the caller filters', () => {
    expect(scopeTenantWhere({ id: 3, archivedOn: null }, HOUSEHOLD)).toEqual({
      id: 3,
      archivedOn: null,
      householdId: HOUSEHOLD,
    });
  });

  // A request asking for someone else's household is a bug or an attack; either
  // way it must be rewritten to the caller's own, not honoured.
  it('overrides an attacker-supplied householdId', () => {
    expect(scopeTenantWhere({ id: 3, householdId: OTHER }, HOUSEHOLD)).toEqual({
      id: 3,
      householdId: HOUSEHOLD,
    });
  });
});

describe('scopeCatalogWhere', () => {
  it('shows global rows plus the household own rows', () => {
    expect(scopeCatalogWhere(undefined, HOUSEHOLD)).toEqual({
      OR: [{ householdId: SYSTEM_HOUSEHOLD_ID }, { householdId: HOUSEHOLD }],
    });
  });

  it('composes with caller filters rather than replacing them', () => {
    expect(scopeCatalogWhere({ slug: 'flour' }, HOUSEHOLD)).toEqual({
      AND: [
        { slug: 'flour' },
        { OR: [{ householdId: SYSTEM_HOUSEHOLD_ID }, { householdId: HOUSEHOLD }] },
      ],
    });
  });

  it('does not expose another household private catalog rows', () => {
    const scoped = scopeCatalogWhere({ householdId: OTHER }, HOUSEHOLD);
    // The caller filter survives, but it is ANDed with the visibility rule, so
    // a row belonging to household 99 can never satisfy both.
    expect(scoped).toEqual({
      AND: [
        { householdId: OTHER },
        { OR: [{ householdId: SYSTEM_HOUSEHOLD_ID }, { householdId: HOUSEHOLD }] },
      ],
    });
  });
});

describe('scopeCreateData', () => {
  it('stamps householdId on a single row', () => {
    expect(scopeCreateData({ title: 'Soup' }, HOUSEHOLD)).toEqual({
      title: 'Soup',
      householdId: HOUSEHOLD,
    });
  });

  it('stamps householdId on every row of a createMany', () => {
    expect(scopeCreateData([{ title: 'A' }, { title: 'B' }], HOUSEHOLD)).toEqual([
      { title: 'A', householdId: HOUSEHOLD },
      { title: 'B', householdId: HOUSEHOLD },
    ]);
  });

  it('overrides a supplied householdId', () => {
    expect(scopeCreateData({ title: 'X', householdId: OTHER }, HOUSEHOLD)).toEqual({
      title: 'X',
      householdId: HOUSEHOLD,
    });
  });
});

describe('scopeArgs', () => {
  it.each([
    'findUnique',
    'findUniqueOrThrow',
    'findFirst',
    'findMany',
    'count',
    'update',
    'updateMany',
    'delete',
    'deleteMany',
  ])('scopes the where clause for %s on a tenant model', (operation) => {
    const scoped = scopeArgs('Recipe', operation, { where: { id: 1 } }, HOUSEHOLD);
    expect(scoped.where).toEqual({ id: 1, householdId: HOUSEHOLD });
  });

  it('scopes create data on a tenant model', () => {
    const scoped = scopeArgs('Recipe', 'create', { data: { title: 'Soup' } }, HOUSEHOLD);
    expect(scoped.data).toEqual({ title: 'Soup', householdId: HOUSEHOLD });
  });

  it('scopes both halves of an upsert', () => {
    const scoped = scopeArgs(
      'PantryPar',
      'upsert',
      { where: { id: 2 }, create: { minQuantity: 1 }, update: { minQuantity: 2 } },
      HOUSEHOLD,
    );
    expect(scoped.where).toEqual({ id: 2, householdId: HOUSEHOLD });
    expect(scoped.create).toEqual({ minQuantity: 1, householdId: HOUSEHOLD });
    // `update` touches an existing row already constrained by `where` — stamping
    // householdId there would be a no-op at best and a silent reassignment at worst.
    expect(scoped.update).toEqual({ minQuantity: 2 });
  });

  it('applies catalog visibility rather than a hard filter for Ingredient', () => {
    const scoped = scopeArgs('Ingredient', 'findMany', {}, HOUSEHOLD);
    expect(scoped.where).toEqual({
      OR: [{ householdId: SYSTEM_HOUSEHOLD_ID }, { householdId: HOUSEHOLD }],
    });
  });

  // Reads and writes on the catalog are asymmetric on purpose. Sharing the read
  // rule with writes would let any household edit or delete the seeded global
  // rows — which in a multi-tenant deployment means rewriting the catalog for
  // everyone, and in a single household means silently losing the seed data.
  it.each(['update', 'updateMany', 'delete', 'deleteMany'])(
    'confines catalog %s to the household own rows',
    (operation) => {
      const scoped = scopeArgs('Ingredient', operation, { where: { id: 1 } }, HOUSEHOLD);
      expect(scoped.where).toEqual({ id: 1, householdId: HOUSEHOLD });
    },
  );

  it('confines unit writes the same way', () => {
    const scoped = scopeArgs('Unit', 'update', { where: { id: 5 } }, HOUSEHOLD);
    expect(scoped.where).toEqual({ id: 5, householdId: HOUSEHOLD });
  });

  it('makes catalog writes household-private', () => {
    const scoped = scopeArgs(
      'Ingredient',
      'create',
      { data: { name: 'Nonna sauce' } },
      HOUSEHOLD,
    );
    expect(scoped.data).toEqual({ name: 'Nonna sauce', householdId: HOUSEHOLD });
  });

  it('leaves parent-scoped models untouched', () => {
    const args = { where: { recipeId: 4 } };
    expect(scopeArgs('RecipeIngredient', 'findMany', args, HOUSEHOLD)).toEqual(args);
  });

  it('leaves operations without a where or data untouched', () => {
    const scoped = scopeArgs('Recipe', 'findMany', { take: 10 }, HOUSEHOLD);
    expect(scoped.take).toBe(10);
    expect(scoped.where).toEqual({ householdId: HOUSEHOLD });
  });

  it('does not mutate the caller args object', () => {
    const args = { where: { id: 1 } };
    scopeArgs('Recipe', 'findMany', args, HOUSEHOLD);
    expect(args).toEqual({ where: { id: 1 } });
  });
});

// The classification drives everything above, so a model landing in the wrong
// bucket — or in none — is the failure mode worth guarding against.
describe('model classification', () => {
  it('puts every model in exactly one bucket', () => {
    const all = [
      ...TENANT_SCOPED_MODELS,
      ...SHARED_CATALOG_MODELS,
      ...PARENT_SCOPED_MODELS,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it('covers every model in the schema', () => {
    // Kept in sync by hand with schema.prisma. If you add a model and this fails,
    // decide which bucket it belongs in rather than deleting the assertion —
    // an unclassified model silently skips tenancy filtering.
    const schemaModels = [
      'Household', 'User', 'HouseholdAiConfig', 'Unit', 'IngredientCategory',
      'Ingredient', 'IngredientAlias', 'Recipe', 'RecipeIngredient', 'RecipeStep',
      'Tag', 'RecipeTag', 'StorageLocation', 'PantryItem', 'PantryPar',
      'PantryTransaction', 'PlannedMeal', 'CookSession', 'Store', 'StoreAisle',
      'ShoppingList', 'ShoppingListItem', 'ReceiveSession', 'PriceObservation',
      'Product', 'ProductBinding', 'ScanQueueEntry',
    ];
    const classified = new Set([
      ...TENANT_SCOPED_MODELS,
      ...SHARED_CATALOG_MODELS,
      ...PARENT_SCOPED_MODELS,
    ]);

    expect(schemaModels.filter((m) => !classified.has(m))).toEqual([]);
    expect([...classified].filter((m) => !schemaModels.includes(m))).toEqual([]);
  });

  it('scopes the models that hold household data', () => {
    for (const model of ['Recipe', 'PantryItem', 'PlannedMeal', 'ShoppingList', 'HouseholdAiConfig']) {
      expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
    }
  });

  // The Open Food Facts mirror is shared by every household and owned by the
  // import CLI. Putting it in either of the other two buckets would be a real
  // bug: tenant-scoped would stamp a householdId onto a global row and hide the
  // catalog from everyone, and shared-catalog would advertise a fork-and-edit
  // path that must not exist for OFF data.
  it('keeps Product global and never household-scoped', () => {
    expect(TENANT_SCOPED_MODELS.has('Product')).toBe(false);
    expect(SHARED_CATALOG_MODELS.has('Product')).toBe(false);
    expect(PARENT_SCOPED_MODELS.has('Product')).toBe(true);
  });

  // The binding is the *only* tenant-scoped part of the product feature: which
  // ingredient this household means by this barcode.
  it('scopes ProductBinding to the household', () => {
    expect(TENANT_SCOPED_MODELS.has('ProductBinding')).toBe(true);
  });

  it('does not filter Product reads', () => {
    const args = { where: { barcode: '0123456789012' } };
    expect(scopeArgs('Product', 'findFirst', args, HOUSEHOLD)).toEqual(args);
  });
});
