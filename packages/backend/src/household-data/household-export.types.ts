/**
 * The export document's JSON shape.
 *
 * Every reference to a household-owned row (recipe, unit fork, planned meal...)
 * is a `LocalRef` — a synthetic `key` assigned during export, never the DB `id`,
 * because the id will not exist on whatever household this file is later
 * imported into. Every reference to the *global* catalog (a seeded unit, a
 * seeded ingredient, a category, an OFF product) is encoded by its natural key
 * instead, since that global row is expected to already exist in the target
 * household's database under the same name/slug/barcode.
 */

/** Points at a household-owned row exported elsewhere in this same file. */
export interface LocalRef {
  key: number;
}

export interface UnitNaturalRef {
  name: string;
  kind: string;
}

export interface IngredientNaturalRef {
  slug: string;
}

export interface CategoryNaturalRef {
  name: string;
}

export type UnitRefJson = LocalRef | UnitNaturalRef;
export type IngredientRefJson = LocalRef | IngredientNaturalRef;
export type CategoryRefJson = CategoryNaturalRef;

export function isLocalRef(ref: unknown): ref is LocalRef {
  return (
    ref !== null &&
    typeof ref === 'object' &&
    typeof (ref as { key?: unknown }).key === 'number'
  );
}

export interface ExportedUnit {
  key: number;
  name: string;
  plural: string;
  abbrev: string | null;
  kind: string;
  toBaseFactor: string;
}

export interface ExportedIngredient {
  key: number;
  name: string;
  slug: string;
  category: CategoryRefJson | null;
  defaultUnit: UnitRefJson | null;
  gramsPerMl: string | null;
  gramsPerPiece: string | null;
  shelfLifeDays: number | null;
  note: string | null;
  aliases: string[];
}

export interface ExportedStorageLocation {
  key: number;
  name: string;
  sortOrder: number;
}

export interface ExportedTag {
  key: number;
  name: string;
  slug: string;
  kind: string;
}

export interface ExportedRecipeIngredient {
  sortOrder: number;
  ingredient: IngredientRefJson | null;
  rawText: string;
  quantity: string | null;
  unit: UnitRefJson | null;
  preparation: string | null;
  groupLabel: string | null;
  optional: boolean;
}

export interface ExportedRecipeStep {
  sortOrder: number;
  text: string;
}

export interface ExportedRecipe {
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
  createdOn: string;
  updatedOn: string;
  archivedOn: string | null;
  ingredients: ExportedRecipeIngredient[];
  steps: ExportedRecipeStep[];
  tags: LocalRef[];
}

export interface ExportedStoreAisle {
  category: CategoryNaturalRef;
  sortOrder: number;
}

export interface ExportedStore {
  key: number;
  name: string;
  sortOrder: number;
  note: string | null;
  aisles: ExportedStoreAisle[];
}

export interface ExportedPantryItem {
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
  createdOn: string;
}

export interface ExportedPantryPar {
  ingredient: IngredientRefJson;
  minQuantity: string;
  unit: UnitRefJson;
}

export interface ExportedPlannedMeal {
  key: number;
  date: string;
  slot: string;
  sortOrder: number;
  recipe: LocalRef | null;
  note: string | null;
  servings: number;
  status: string;
  createdOn: string;
}

export interface ExportedCookSession {
  key: number;
  plannedMeal: LocalRef | null;
  recipe: LocalRef;
  servings: number;
  cookedOn: string;
  note: string | null;
  reversedOn: string | null;
}

export interface ExportedShoppingListItem {
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
}

export interface ExportedShoppingList {
  key: number;
  name: string;
  store: LocalRef | null;
  status: string;
  createdOn: string;
  completedOn: string | null;
  items: ExportedShoppingListItem[];
}

export interface ExportedReceiveSession {
  key: number;
  shoppingList: LocalRef;
  receivedOn: string;
  reversedOn: string | null;
}

export interface ExportedPantryTransaction {
  pantryItem: LocalRef | null;
  ingredient: IngredientRefJson;
  delta: string;
  unit: UnitRefJson;
  kind: string;
  cookSession: LocalRef | null;
  receiveSession: LocalRef | null;
  note: string | null;
  createdOn: string;
}

export interface ExportedPriceObservation {
  ingredient: IngredientRefJson;
  store: LocalRef | null;
  brand: string | null;
  productBarcode: string | null;
  quantity: string;
  unit: UnitRefJson;
  price: string;
  observedOn: string;
  receiveSession: LocalRef | null;
}

export interface ExportedProductBinding {
  productBarcode: string;
  ingredient: IngredientRefJson;
}

export interface HouseholdExport {
  exportFormat: string;
  schemaVersion: number;
  exportedOn: string;
  householdName: string;

  storageLocations: ExportedStorageLocation[];
  catalog: {
    units: ExportedUnit[];
    ingredients: ExportedIngredient[];
  };
  tags: ExportedTag[];
  recipes: ExportedRecipe[];
  stores: ExportedStore[];
  pantryItems: ExportedPantryItem[];
  pantryPars: ExportedPantryPar[];
  plannedMeals: ExportedPlannedMeal[];
  cookSessions: ExportedCookSession[];
  shoppingLists: ExportedShoppingList[];
  receiveSessions: ExportedReceiveSession[];
  pantryTransactions: ExportedPantryTransaction[];
  priceObservations: ExportedPriceObservation[];
  productBindings: ExportedProductBinding[];
}

/** Row counts, returned to the client after a successful import. */
export interface ImportSummary {
  storageLocations: number;
  units: number;
  ingredients: number;
  tags: number;
  recipes: number;
  stores: number;
  pantryItems: number;
  pantryPars: number;
  plannedMeals: number;
  cookSessions: number;
  shoppingLists: number;
  receiveSessions: number;
  pantryTransactions: number;
  priceObservations: number;
  productBindings: number;
}
