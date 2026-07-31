/**
 * The shapes the API actually returns.
 *
 * Quantities arrive as **strings**, never numbers. The backend stores them as
 * decimals precisely because binary floating point mangles values like 0.333 and
 * 3.99, and parsing them into a JS number here would undo that at the last step.
 * Anything doing arithmetic on these should go through decimal.js.
 */

export interface Unit {
  id: number;
  name: string;
  plural: string;
  abbrev: string | null;
  kind: 'MASS' | 'VOLUME' | 'COUNT';
  toBaseFactor: string;
}

export interface Ingredient {
  id: number;
  householdId: number | null;
  name: string;
  slug: string;
  categoryId: number | null;
  defaultUnitId: number | null;
  gramsPerMl: string | null;
  gramsPerPiece: string | null;
  shelfLifeDays: number | null;
  note: string | null;
}

export interface IngredientCategory {
  id: number;
  name: string;
  sortOrder: number;
}

/**
 * What the catalog endpoints accept, mirroring CreateIngredientDto /
 * UpdateIngredientDto on the backend.
 *
 * The physical values are strings, not numbers, for the same reason every
 * quantity in this app is: they are Decimals server-side, and routing a density
 * like 0.53 through a JavaScript float to get it there defeats the point.
 *
 * **Absent and null differ.** Omitting a field leaves it unchanged; sending
 * `null` clears it, which is the only way to say that an ingredient someone
 * once gave a density does not actually have one. `name` is the exception — it
 * is `NOT NULL`, and the API rejects a null one.
 */
export interface IngredientWrite {
  name?: string;
  categoryId?: number | null;
  defaultUnitId?: number | null;
  /** Grams per millilitre. Null means unknown — never assume 1.0. */
  gramsPerMl?: string | null;
  /** Grams per single item: one egg, one onion. */
  gramsPerPiece?: string | null;
  shelfLifeDays?: number | null;
  note?: string | null;
}

/** Mirrors CreatePantryItemDto / UpdatePantryItemDto. */
export interface PantryItemWrite {
  ingredientId?: number;
  locationId?: number;
  quantity?: string;
  unitId?: number;
  brand?: string;
  openedOn?: string | null;
  /**
   * Left off entirely, the backend seeds one from the ingredient's shelf life.
   * Explicit null means "this genuinely does not expire", which is a different
   * claim and is stored as such.
   */
  expiresOn?: string | null;
  note?: string;
}

export interface AuthUser {
  id: number;
  householdId: number;
  role: 'MEMBER' | 'ADMIN';
  email: string;
  displayName: string;
}

export interface Tag {
  id: number;
  name: string;
  slug: string;
  kind: string;
}

export interface RecipeIngredient {
  id: number;
  sortOrder: number;
  rawText: string;
  quantity: string | null;
  preparation: string | null;
  groupLabel: string | null;
  optional: boolean;
  ingredientId: number | null;
  ingredient: { id: number; name: string; slug: string } | null;
  unit: Unit | null;
  scaled?: { quantity: string; display: string } | null;
}

export interface RecipeStep {
  id: number;
  sortOrder: number;
  text: string;
}

export interface RecipeSummary {
  id: number;
  title: string;
  slug: string;
  description: string | null;
  servings: number;
  prepMinutes: number | null;
  cookMinutes: number | null;
  archivedOn: string | null;
  tags: Tag[];
  ingredientCount: number;
  stepCount: number;
}

export interface Recipe {
  id: number;
  title: string;
  slug: string;
  description: string | null;
  servings: number;
  prepMinutes: number | null;
  cookMinutes: number | null;
  archivedOn: string | null;
  notes: string | null;
  sourceUrl: string | null;
  sourceNote: string | null;
  tags: Tag[];
  ingredients: RecipeIngredient[];
  steps: RecipeStep[];
  originalServings?: number;
}

/**
 * What the recipe endpoints accept, mirroring CreateRecipeDto on the backend.
 *
 * `rawText` is required on every line and never derived away, even when the
 * line resolved to a catalog ingredient: it is the record of what was actually
 * written, and the only thing left to show when a match later turns out wrong.
 *
 * Quantity is a string for the usual reason — it is a Decimal server-side.
 */
export interface RecipeIngredientWrite {
  /** Absent means the line saves as plain text and sits out of pantry maths. */
  ingredientId?: number;
  rawText: string;
  quantity?: string;
  unitId?: number;
  preparation?: string;
  groupLabel?: string;
  optional?: boolean;
}

export interface RecipeWrite {
  title: string;
  description?: string;
  servings: number;
  prepMinutes?: number;
  cookMinutes?: number;
  sourceUrl?: string;
  sourceNote?: string;
  notes?: string;
  ingredients: RecipeIngredientWrite[];
  steps: { text: string }[];
  /** Matched by slug server-side, so casing does not fork a tag. */
  tags?: { name: string }[];
}

export interface Paged<T> {
  total: number;
  limit: number;
  offset: number;
  items: T[];
}

export type ExpiryStatus = 'none' | 'expired' | 'soon' | 'ok';

export interface PantryLot {
  id: number;
  quantity: string;
  brand: string | null;
  openedOn: string | null;
  expiresOn: string | null;
  note: string | null;
  expiry: ExpiryStatus;
  unit: Unit;
  location: { id: number; name: string };
  ingredient: { id: number; name: string; slug: string };
}

export interface StorageLocation {
  id: number;
  name: string;
  sortOrder: number;
  _count?: { items: number };
}

export interface Balance {
  ingredientId: number;
  ingredient: { id: number; name: string };
  total: string | null;
  unit: Unit | null;
  lotCount: number;
  unconvertible: Array<{ lotId: number; quantity: string; unit: Unit; reason: string }>;
}

export interface PlannedMeal {
  id: number;
  date: string;
  slot: 'BREAKFAST' | 'LUNCH' | 'DINNER' | 'SNACK';
  sortOrder: number;
  servings: number;
  note: string | null;
  status: 'PLANNED' | 'COOKED' | 'SKIPPED';
  recipe: { id: number; title: string; slug: string; servings: number } | null;
  cookSessions: Array<{ id: number; cookedOn: string; reversedOn: string | null }>;
}

/**
 * What `POST /planner` accepts, mirroring CreatePlannedMealDto.
 *
 * Either `recipeId` or `note` must be present — the calendar holds "leftovers"
 * and "dinner out" as well as recipes, but an entry that names neither is an
 * empty slot rather than a plan, and the API says so.
 *
 * Omitting `servings` lets the recipe's own count stand, which is what the
 * common case — cooking it as written — actually wants.
 */
export interface PlannedMealWrite {
  date: string;
  slot: PlannedMeal['slot'];
  recipeId?: number;
  note?: string;
  servings?: number;
}

export interface LineStatus {
  ingredientId: number;
  ingredientName: string | null;
  rawText: string;
  need: string;
  needUnit: Unit;
  onHand: string | null;
  shortBy: string | null;
  reason?: string;
}

export interface RecipeMatch {
  recipeId: number;
  title: string;
  slug: string;
  servings: number;
  have: LineStatus[];
  missing: LineStatus[];
  unknown: LineStatus[];
  requiredCount: number;
  score: number;
  canCook: boolean;
}

export interface PantrySuggestions {
  matches: RecipeMatch[];
  pantryIngredientCount: number;
  recipeCount: number;
}

export interface AiSuggestionResult {
  ok: boolean;
  reason?: string;
  deterministic: RecipeMatch[];
  ai: {
    summary: string;
    suggestions: Array<{
      kind: 'SAVED_RECIPE' | 'SUBSTITUTION' | 'GENERATED';
      recipeId: number | null;
      title: string;
      why: string;
      substitutions: Array<{ missing: string; useInstead: string; note: string }>;
      usesExpiring: string[];
    }>;
  } | null;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

export interface Store {
  id: number;
  name: string;
  sortOrder: number;
  note: string | null;
  aisles: Array<{
    categoryId: number;
    sortOrder: number;
    category: { id: number; name: string };
  }>;
}

export interface ProposedItem {
  ingredientId: number;
  ingredientName: string;
  quantity: string;
  unit: Unit;
  source: 'RECIPE' | 'PAR' | 'MANUAL';
  forMeals: Array<{ plannedMealId: number; recipeTitle: string; date: string }>;
  onHand: string | null;
  unconvertible: boolean;
  reason?: string;
  estimatedPrice: string | null;
  brand: string | null;
}

export interface Proposal {
  from: string;
  to: string;
  storeId: number | null;
  mealCount: number;
  items: ProposedItem[];
}

export interface ShoppingListItem {
  id: number;
  quantity: string | null;
  rawName: string | null;
  brand: string | null;
  estimatedPrice: string | null;
  actualPrice: string | null;
  unconvertible: boolean;
  checkedOn: string | null;
  note: string | null;
  source: string;
  ingredient: { id: number; name: string } | null;
  unit: Unit | null;
}

export interface ShoppingList {
  id: number;
  name: string;
  status: 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
  createdOn: string;
  completedOn: string | null;
  store: { id: number; name: string } | null;
  items: ShoppingListItem[];
  totals: {
    projected: string;
    actual: string;
    unpricedItems: number;
    checkedItems: number;
    totalItems: number;
  };
}

export interface ShoppingListSummary {
  id: number;
  name: string;
  status: 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
  createdOn: string;
  store: { id: number; name: string } | null;
  _count: { items: number };
}

export interface ParsedLine {
  rawText: string;
  quantity: string | null;
  unitId: number | null;
  unitToken: string | null;
  name: string;
  preparation: string | null;
  groupLabel: string | null;
  optional: boolean;
  isRange: boolean;
  inferredQuantity: boolean;
  ingredientId: number | null;
  needsReview: boolean;
  match: {
    kind: 'EXACT' | 'ALIAS' | 'SINGULAR' | 'FUZZY' | 'NONE';
    confidence: number;
    best: { ingredientId: number; name: string; slug: string; score: number } | null;
    alternatives: Array<{ ingredientId: number; name: string; slug: string; score: number }>;
  };
}

export interface ParseResult {
  title: string | null;
  servings: number | null;
  ingredients: ParsedLine[];
  steps: Array<{ text: string }>;
  ignored: string[];
  summary: { total: number; resolved: number; needsReview: number };
}

export interface AiConfig {
  configured: boolean;
  enabled: boolean;
  keyLastFour: string | null;
  model: string;
  effort: string;
  verifiedOn: string | null;
}

export interface CookReport {
  cookSessionId: number;
  recipe: { id: number; title: string };
  servings: number;
  scaledFrom: number;
  deducted: Array<{
    ingredientId: number;
    rawText: string;
    took: string;
    unit: Unit;
    fromLots: Array<{ lotId: number; took: string; remaining: string }>;
  }>;
  shortfalls: Array<{
    ingredientId: number;
    rawText: string;
    wanted: string;
    got: string;
    short: string;
    unit: Unit;
    unusableLots: Array<{ lotId: number; unit: Unit; reason: string }>;
  }>;
  skipped: Array<{ lineId: number; rawText: string; reason: string }>;
}
