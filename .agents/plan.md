# Recipe, Pantry & Meal Planning App — Build Spec

## Context

`c:\Users\danjs\Documents\Development\recipes` is empty. The goal is an app that tracks
**what ingredients you have**, **what recipes you know**, **what you're eating this week**,
and **what you need to buy** — self-hosted for a household, with the door left open to
multi-tenant hosting later.

The whole thing hinges on one idea: a recipe calling for *2 cups of flour* and a pantry
holding *a 5 lb bag of flour* must be understood as the same substance in different units.
Get that right and pantry deduction, "what can I cook right now", and shopping-list
aggregation all fall out of it. Get it wrong and the app is a note-taking tool with extra
steps. So the **canonical ingredient catalog + unit conversion engine is the foundation**,
built and tested before any feature that depends on it.

Decisions already made (confirmed with the user):

| Decision | Choice |
|---|---|
| v1 scope | Recipes, pantry inventory, **meal planner**, shopping list |
| Deployment | Self-hosted household, multi-tenant-ready schema from day one |
| Stack | Mirror `sc_material_management` — npm workspaces, NestJS + Prisma/Postgres, Angular Material |
| Recipe input | Manual form + paste-and-parse (no URL import, no OCR in v1) |
| Ingredient model | Canonical catalog with unit conversions |
| Shopping list sources | Meal plan + par-level restock + manual items |
| Shopping list fields | Store, brand, and cost tracked per item (all optional) |
| "What can I cook" | Two methods — deterministic pantry match, plus LLM-extended analysis |
| AI credentials | Bring-your-own Anthropic key, configured per household, encrypted at rest |
| Auth | Local email + password, roles `MEMBER` / `ADMIN` |

Prior art to copy from, not reinvent — `c:\Users\danjs\Documents\Development\sc_material_management`:

- [package.json](../../Documents/Development/sc_material_management/package.json) — workspace layout, `dev`/`build`/`test`/`prisma:*` script conventions
- `packages/backend/src/inventory/` — service/controller/dto/spec module shape
- `packages/backend/src/common/inventory-scope.util.ts` — prior art for scoping queries to an owner
- `packages/backend/src/common/decimal-serializer.interceptor.ts` — **reuse**; Prisma `Decimal` must not reach JSON as an object
- `packages/backend/src/auth/{guards,decorators,strategies}` — passport-jwt + httpOnly cookie pattern (swap `passport-discord` for a local strategy)
- `docker-compose.yml`, `scripts/dev-up.js` — deployment and local dev orchestration
- `ERD.md` — hand-maintained schema documentation; do the same here

---

## Repo layout

```
recipes/
  package.json                 # npm workspaces, scripts mirroring sc_material_management
  docker-compose.yml           # postgres + backend + frontend
  .env.example
  ERD.md  README.md  CHANGELOG.md
  scripts/dev-up.js            # adapt from sc_material_management
  packages/
    shared-types/              # @recipes/shared-types — DTO types, enums, PURE unit math
    backend/                   # NestJS + Prisma
      prisma/schema.prisma
      prisma/seed/             # units, categories, ~250 ingredients w/ densities
      src/{auth,households,users,prisma,common,
           ingredients,units,recipes,pantry,planner,shopping,stores,
           parser,suggestions,seed}
    frontend/                  # Angular standalone + Material
      src/app/{core,shared,recipes,pantry,planner,shopping,settings,admin}
```

Pure unit math lives in **`shared-types`**, not the backend, so the frontend can preview a
conversion live in a form without a round trip. The backend imports the same functions —
one implementation, one set of tests.

---

## Data model

Full Prisma schema sketch. Conventions follow the existing app: `@@map` to snake_case
tables, `Decimal` for every quantity and price (never `Float` — floating point on 0.33 cups
or $3.99 compounds badly), `createdOn`/`deletedOn` datetime naming.

### Tenancy

`Household` is the tenant. Every user-owned row carries `householdId`. Catalog rows
(`Unit`, `Ingredient`, `IngredientCategory`) use a **nullable** `householdId`: `null` means
seeded/global, non-null means a household's private addition. This is what makes the
multi-tenant future a config change rather than a migration across every table.

```prisma
enum Role { MEMBER ADMIN }

model Household {
  id        Int      @id @default(autoincrement())
  name      String
  createdOn DateTime @default(now())
  users     User[]
  @@map("household")
}

model User {
  id           Int       @id @default(autoincrement())
  householdId  Int
  email        String    @unique
  passwordHash String
  displayName  String
  role         Role      @default(MEMBER)
  createdOn    DateTime  @default(now())
  disabledOn   DateTime?
  deletedOn    DateTime?
  household    Household @relation(fields: [householdId], references: [id])
  @@map("app_user")
}

model HouseholdAiConfig {                  // bring-your-own Anthropic key, per household
  householdId    Int       @id
  enabled        Boolean   @default(false)
  encryptedKey   Bytes                     // AES-256-GCM ciphertext — never leaves the server
  keyIv          Bytes
  keyAuthTag     Bytes
  keyLastFour    String                    // the only part ever shown in the UI
  model          String    @default("claude-opus-5")
  effort         String    @default("medium")
  verifiedOn     DateTime?                 // last time a test call succeeded
  updatedById    Int
  updatedOn      DateTime  @updatedAt
  household      Household @relation(fields: [householdId], references: [id])
  @@map("household_ai_config")
}
```

### Units & the conversion engine

```prisma
enum UnitKind { MASS VOLUME COUNT }

model Unit {
  id           Int      @id @default(autoincrement())
  householdId  Int?                    // null = global
  name         String                  // "cup"
  plural       String                  // "cups"
  abbrev       String?                 // "c"
  kind         UnitKind
  toBaseFactor Decimal  @db.Decimal(20, 10)   // → gram | milliliter | each
  @@unique([householdId, name])
  @@map("unit")
}
```

Base units: **gram** (MASS), **milliliter** (VOLUME), **each** (COUNT). Same-kind conversion
is pure arithmetic. Cross-kind conversion is the interesting case and needs per-ingredient
physical data:

- `Ingredient.gramsPerMl` — density, bridges VOLUME ↔ MASS (flour ≈ 0.53, water = 1.0)
- `Ingredient.gramsPerPiece` — bridges COUNT ↔ MASS (1 egg ≈ 50 g, 1 onion ≈ 150 g)

`packages/shared-types/src/units.ts` exports:

```ts
type ConversionResult =
  | { ok: true;  quantity: Decimal }
  | { ok: false; reason: 'NO_DENSITY' | 'NO_PIECE_WEIGHT' | 'INCOMPATIBLE' };

function convert(qty, fromUnit, toUnit, ingredient?): ConversionResult
```

**The failure case is a first-class result, never a throw and never a silent zero.** When
the app can't convert "3 sprigs of thyme" to grams, the shopping list shows both lines side
by side with a "couldn't combine" marker, and the pantry deduction asks the user rather than
guessing. Every downstream feature must handle `ok: false` explicitly — this is the single
most important rule in the codebase, because silently wrong quantities are worse than
visibly incomplete ones.

### Ingredient catalog

```prisma
model IngredientCategory {           // default shopping-list aisle grouping
  id        Int    @id @default(autoincrement())
  name      String @unique           // "Produce", "Dairy", "Baking"
  sortOrder Int                      // default store walk order
  @@map("ingredient_category")
}

model Ingredient {
  id             Int      @id @default(autoincrement())
  householdId    Int?                       // null = seeded/global
  name           String                     // "all-purpose flour"
  slug           String                     // "all-purpose-flour"
  categoryId     Int?
  defaultUnitId  Int?
  gramsPerMl     Decimal? @db.Decimal(12, 6)
  gramsPerPiece  Decimal? @db.Decimal(12, 4)
  shelfLifeDays  Int?                       // seeds a default expiry on intake
  note           String?
  @@unique([householdId, slug])
  @@map("ingredient")
}

model IngredientAlias {                     // parser matching: "scallions" → green onion
  id           Int    @id @default(autoincrement())
  ingredientId Int
  alias        String
  slug         String
  @@unique([ingredientId, slug])
  @@index([slug])
  @@map("ingredient_alias")
}
```

### Recipes

```prisma
model Recipe {
  id           Int       @id @default(autoincrement())
  householdId  Int
  title        String
  slug         String
  description  String?
  servings     Int                      // the basis for all scaling
  prepMinutes  Int?
  cookMinutes  Int?
  sourceUrl    String?                  // leaves room for URL import later
  sourceNote   String?                  // "Grandma's card", "Bittman p.212"
  imagePath    String?
  notes        String?
  createdById  Int
  createdOn    DateTime  @default(now())
  updatedOn    DateTime  @updatedAt
  archivedOn   DateTime?
  @@unique([householdId, slug])
  @@map("recipe")
}

model RecipeIngredient {
  id           Int      @id @default(autoincrement())
  recipeId     Int
  sortOrder    Int
  ingredientId Int?                     // NULLABLE — see note below
  rawText      String                   // always preserved verbatim
  quantity     Decimal? @db.Decimal(12, 4)
  unitId       Int?
  preparation  String?                  // "finely chopped", "at room temperature"
  groupLabel   String?                  // "For the sauce"
  optional     Boolean  @default(false)
  @@map("recipe_ingredient")
}

model RecipeStep { id Int @id @default(autoincrement())  recipeId Int  sortOrder Int  text String  @@map("recipe_step") }
model Tag        { id Int @id @default(autoincrement())  householdId Int  name String  slug String  kind TagKind  @@unique([householdId, slug])  @@map("tag") }
model RecipeTag  { recipeId Int  tagId Int  @@id([recipeId, tagId])  @@map("recipe_tag") }
```

`ingredientId` is nullable and `rawText` is always kept. This carries three real cases: a
parse that didn't resolve, an unquantified line ("salt and pepper to taste"), and a one-off
the user doesn't want polluting the catalog. Anything unresolved simply doesn't participate
in pantry math — it still displays, and the recipe still saves.

### Pantry

```prisma
model StorageLocation { id Int @id @default(autoincrement())  householdId Int  name String  sortOrder Int  @@map("storage_location") }

model PantryItem {                         // one physical lot
  id           Int       @id @default(autoincrement())
  householdId  Int
  ingredientId Int
  locationId   Int
  quantity     Decimal   @db.Decimal(12, 4)
  unitId       Int
  brand        String?
  openedOn     DateTime?
  expiresOn    DateTime?
  note         String?
  createdOn    DateTime  @default(now())
  @@index([householdId, ingredientId])
  @@map("pantry_item")
}

model PantryPar {                          // restock threshold, per ingredient
  id           Int     @id @default(autoincrement())
  householdId  Int
  ingredientId Int
  minQuantity  Decimal @db.Decimal(12, 4)
  unitId       Int
  @@unique([householdId, ingredientId])
  @@map("pantry_par")
}

model PantryTransaction {                  // append-only ledger
  id             Int          @id @default(autoincrement())
  householdId    Int
  pantryItemId   Int?
  ingredientId   Int
  delta          Decimal      @db.Decimal(12, 4)   // signed
  unitId         Int
  kind           TxKind       // PURCHASE | CONSUME | ADJUST | DISCARD | COOK
  cookSessionId  Int?
  note           String?
  createdById    Int
  createdOn      DateTime     @default(now())
  @@index([householdId, ingredientId, createdOn])
  @@map("pantry_transaction")
}
```

Multiple `PantryItem` rows per ingredient are intentional — two half-used bags of rice with
different expiry dates are genuinely two lots. On-hand totals sum lots, converting each into
a common unit.

The ledger exists because cooking a recipe deducts a dozen ingredients at once. Without an
audit trail, one mis-scaled cook silently corrupts the whole pantry with no way back.
`CookSession` groups a deduction so it can be undone as a unit. This mirrors the
`MaterialsBatch` / ledger approach already in `sc_material_management`.

### Meal planner

```prisma
enum MealSlot   { BREAKFAST LUNCH DINNER SNACK }
enum PlanStatus { PLANNED COOKED SKIPPED }

model PlannedMeal {
  id          Int        @id @default(autoincrement())
  householdId Int
  date        DateTime   @db.Date          // the calendar day
  slot        MealSlot
  sortOrder   Int                          // multiple entries per slot
  recipeId    Int?                         // null for a free-text entry
  note        String?                      // "leftovers", "dinner out", "grandma's"
  servings    Int                          // may differ from recipe.servings → scale factor
  status      PlanStatus @default(PLANNED)
  createdById Int
  createdOn   DateTime   @default(now())
  @@index([householdId, date])
  @@map("planned_meal")
}

model CookSession {
  id            Int      @id @default(autoincrement())
  householdId   Int
  plannedMealId Int?
  recipeId      Int
  servings      Int
  cookedOn      DateTime @default(now())
  note          String?
  @@map("cook_session")
}
```

`recipeId` is nullable so the calendar can hold real-life entries that aren't recipes —
"leftovers", "takeout". Those display on the plan and are skipped by shopping-list
generation and cook deduction. The `(date, slot, sortOrder)` shape is what makes the week
grid and drag-to-reschedule straightforward.

### Stores & shopping list

```prisma
enum ListStatus { ACTIVE COMPLETED ARCHIVED }
enum ItemSource { RECIPE PAR MANUAL }

model Store {
  id          Int     @id @default(autoincrement())
  householdId Int
  name        String                       // "Kroger — Elm St"
  sortOrder   Int
  note        String?
  @@map("store")
}

model StoreAisle {                          // optional per-store walk order override
  id         Int @id @default(autoincrement())
  storeId    Int
  categoryId Int
  sortOrder  Int
  @@unique([storeId, categoryId])
  @@map("store_aisle")
}

model ShoppingList {
  id          Int        @id @default(autoincrement())
  householdId Int
  name        String
  storeId     Int?                          // default store for the list
  status      ListStatus @default(ACTIVE)
  createdOn   DateTime   @default(now())
  completedOn DateTime?
  @@map("shopping_list")
}

model ShoppingListItem {
  id                  Int        @id @default(autoincrement())
  listId              Int
  ingredientId        Int?                  // null for ad-hoc items
  rawName             String?               // "paper towels"
  quantity            Decimal?   @db.Decimal(12, 4)
  unitId              Int?
  source              ItemSource
  sourcePlannedMealId Int?
  storeId             Int?                  // per-item override of the list's store
  brand               String?               // "King Arthur"
  estimatedPrice      Decimal?   @db.Decimal(10, 2)   // prefilled from price history
  actualPrice         Decimal?   @db.Decimal(10, 2)   // entered at checkout
  unconvertible       Boolean    @default(false)
  checkedOn           DateTime?
  note                String?
  @@map("shopping_list_item")
}

model PriceObservation {                    // powers estimatedPrice on future lists
  id           Int      @id @default(autoincrement())
  householdId  Int
  ingredientId Int
  storeId      Int?
  brand        String?
  quantity     Decimal  @db.Decimal(12, 4)
  unitId       Int
  price        Decimal  @db.Decimal(10, 2)
  observedOn   DateTime @default(now())
  @@index([householdId, ingredientId, observedOn])
  @@map("price_observation")
}
```

Store, brand, and price are all optional — an item with none of them is just a name and a
quantity, and the UI must not nag for them. When they *are* filled in they compound: closing
out a list writes a `PriceObservation` per priced item, which prefills `estimatedPrice` next
time and gives a running list total before you reach the register.

---

## Key algorithms

**Serving scaling.** `scaled = quantity * (targetServings / recipe.servings)` in Decimal.
Round to friendly fractions (⅛ precision for volumes, whole grams for mass) **at display
time only** — never in stored values, or scaling twice drifts.

**Shopping list generation** (`shopping/shopping-generation.service.ts`). Takes a date range
from the meal plan and returns a *proposal* the user reviews; nothing persists until
accepted:

1. Pull `PLANNED` meals in `[from, to]` that have a `recipeId`; scale each recipe's
   ingredients by its serving ratio.
2. Group by `ingredientId`, converting each line to the ingredient's default unit. Lines
   that fail conversion stay separate with `unconvertible: true`.
3. Subtract pantry on-hand for each ingredient (sum of lots, converted).
4. Add par shortfalls: `PantryPar.minQuantity - onHand` where positive.
5. Drop non-positive results; prefill `estimatedPrice` and `brand` from the most recent
   `PriceObservation` for that ingredient at the list's store.
6. Sort by `StoreAisle.sortOrder` for the chosen store, falling back to
   `IngredientCategory.sortOrder`, so the list reads in store-walk order.

**Cook a meal** (`POST /planner/:id/cook`). One Prisma transaction: create `CookSession`,
then per resolved ingredient convert the scaled quantity into each lot's unit and deduct
oldest-expiry-first across lots, writing a `PantryTransaction` per deduction. Anything
unconvertible or short is reported back and **skipped, not forced negative**. Mark the
`PlannedMeal` `COOKED`. `DELETE /cook-sessions/:id` reverses every transaction in the
session.

**Paste-and-parse** (`POST /recipes/parse` — pure function, persists nothing):

1. Split into lines; classify blocks — ingredient lines are short, usually lead with a digit
   or unit word; step lines are sentences with verbs and terminal punctuation.
2. Per ingredient line: normalize unicode fractions (`½` → `0.5`) and ranges (`1-2` → take
   the lower, flag it), then `^(qty)?\s*(unit)?\s+(rest)$`.
3. Split `rest` into name and preparation on the first comma or parenthetical.
4. Match name against `Ingredient.slug` and `IngredientAlias.slug` — exact, then
   singularized, then trigram similarity via Postgres `pg_trgm` (needs
   `CREATE EXTENSION IF NOT EXISTS pg_trgm` in the first migration).
5. Return each line with its match, a confidence score, and alternatives.

The UI is a two-column review screen — raw text beside the parse — where low-confidence rows
get an ingredient picker with inline "create new ingredient". Parsing is a suggestion engine,
and the design should assume it is wrong often enough that correcting it must be faster than
typing from scratch.

---

## "What can I cook?" — two methods

Both live in `suggestions/`, share one input (a pantry balance snapshot), and are surfaced
as two tabs on the same screen. The deterministic method is the source of truth about
quantities; the LLM method is the source of ideas.

### Method 1 — deterministic pantry match

`GET /suggestions/pantry?missingMax=N`. Load pantry balances into a
`Map<ingredientId, Decimal>` in one query, then score recipes in memory: fraction of
required (non-optional, resolved) ingredients satisfiable at the planned serving count.
Returns each recipe with `haveCount`, `missingCount`, and the specific missing lines.

Avoid the per-recipe query this obviously invites. At household scale (hundreds of recipes,
thousands of pantry rows) in-memory scoring is comfortably fast; revisit only if the
multi-tenant future arrives. **This method never guesses** — an ingredient it can't convert
is reported as unknown, not assumed present.

### Method 2 — LLM-extended analysis

`POST /suggestions/ai`. Answers the questions arithmetic can't: *"you're one ingredient short
on three recipes — here's which substitution actually works"*, *"your cilantro and the half
carton of buttermilk both expire Thursday; here's something that uses both"*, *"nothing in
your catalog fits, but here's a dish you could make from what's on hand."*

**Grounding is the whole design.** The endpoint runs Method 1 first and passes its output in
as context. The model explains, ranks, and extends — it never recomputes quantities, and the
response schema gives it no field in which to assert one. Suggestions referencing a saved
recipe carry its real ID; invented dishes are marked `GENERATED` and can be saved as a draft
recipe (routed through the same paste-and-parse review screen, so nothing enters the catalog
unreviewed).

Implementation in `suggestions/ai-suggestions.service.ts`, using the official
`@anthropic-ai/sdk` (the backend is TypeScript — do not hand-roll HTTP):

```ts
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const response = await client.messages.parse({
  model: 'claude-opus-5',
  max_tokens: 16000,
  thinking: { type: 'adaptive' },
  output_config: {
    effort: 'medium',
    format: zodOutputFormat(SuggestionsSchema),
  },
  system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: JSON.stringify(promptPayload) }],
});
```

- **Model** `claude-opus-5`, adaptive thinking, `effort: 'medium'` — the reasoning here is
  substitution logic over a modest payload, not a long agentic run. Sweep `low`/`medium` on
  real pantry data before settling; `low` may be plenty.
- **Structured output** via `output_config.format` with a Zod schema (`zodOutputFormat`), so
  the response parses into typed suggestions rather than prose the frontend has to scrape.
  Assistant prefills are rejected on this model — structured outputs are the mechanism.
- **Prompt caching** on the system prompt (rules, substitution guidance, output contract).
  Minimum cacheable prefix is 512 tokens on `claude-opus-5`; verify with
  `response.usage.cache_read_input_tokens` rather than assuming.
- **Payload shape**: pantry balances (with expiry dates), the Method-1 match results, the
  recipe catalog as `{id, title, tags, ingredientIds}` — titles and IDs only, never full
  recipe bodies, or the request bloats for no gain.
- **Failure is non-fatal.** No key configured → the tab is hidden and the endpoint returns
  409. An API error, a `stop_reason` of `refusal`, or a schema-parse failure → the UI falls
  back to Method 1 with a quiet notice. Check `stop_reason` before reading content.
- **Cost control**: cache suggestions per (household, pantry-hash) for an hour, and put the
  call behind an explicit button — never fire it on page load. Costs land on the household's
  own key, which is also what makes the multi-tenant future viable.

### Bring-your-own key (per household)

There is **no server-wide `ANTHROPIC_API_KEY`.** Each household supplies its own, stored in
`HouseholdAiConfig` and used only for that household's requests.

- **At rest**: AES-256-GCM via Node's `crypto`, in `common/secret-crypto.util.ts`. The one
  server-level secret is `AI_ENCRYPTION_KEY` (32 random bytes, base64) in `.env.example` —
  it encrypts household keys and nothing else. Document that rotating it invalidates every
  stored household key, which then need re-entry.
- **Write-only**: `PUT /households/me/ai-config` accepts a key; **no endpoint ever returns
  one.** `GET` responds with `{enabled, configured, keyLastFour, model, effort, verifiedOn}`.
  Add the field to a response-DTO denylist so it can't leak through a future `select: *`.
- **Verify on save**: before storing, make a throwaway call (`max_tokens: 16`, "reply OK")
  with the submitted key. Reject on 401 with a clear message rather than storing a key that
  fails later inside a user-facing feature. Record success as `verifiedOn`.
- **ADMIN only** to set, rotate, or clear — `MEMBER` accounts use the feature but never see
  or change the key. Reuse the existing role-guard/decorator pattern from
  `packages/backend/src/auth/`.
- **At call time**: decrypt, construct `new Anthropic({ apiKey })` for the request, and let
  it fall out of scope. Never log it, never put it in an error message, never attach it to a
  Nest request object that gets serialized. Prompt caching is per-key, which per-household
  isolation gives for free.
- Model and effort are per household too, so one household can dial to `low` for cost while
  another runs `medium` — the sweep recommendation above becomes a setting, not a rebuild.

---

## API surface

```
POST   /auth/register  /auth/login  /auth/logout      GET /auth/me
GET    /ingredients?q=&categoryId=                    POST/PATCH/DELETE /ingredients/:id
GET    /units                                         POST /units
GET    /stores  POST /stores  PATCH /stores/:id       PUT /stores/:id/aisles
GET    /recipes?q=&tag=&ingredientId=
GET    /recipes/:slug   POST /recipes   PATCH /recipes/:id   DELETE /recipes/:id
POST   /recipes/parse                                 # draft only, no persistence
GET    /recipes/:id/scaled?servings=N
GET    /pantry?locationId=&expiringWithinDays=        POST /pantry  PATCH/DELETE /pantry/:id
GET    /pantry/balances                               # on-hand per ingredient, common units
GET/PUT /pantry/pars
GET    /planner?from=&to=                             # the week/month grid
POST   /planner   PATCH/DELETE /planner/:id           # add / move / remove a meal
POST   /planner/:id/cook                              DELETE /cook-sessions/:id   # undo
GET    /suggestions/pantry?missingMax=                # deterministic
POST   /suggestions/ai                                # LLM-extended; 409 if no key
GET    /households/me/ai-config                       # never returns the key
PUT    /households/me/ai-config                       # ADMIN only; verifies before storing
DELETE /households/me/ai-config                       # ADMIN only; clears the key
GET    /shopping-lists   POST /shopping-lists
POST   /shopping-lists/generate  { from, to, storeId } # proposal, not persisted
PATCH  /shopping-lists/:id/items/:itemId              # check off, set brand/price
POST   /shopping-lists/:id/receive                    # checked items → pantry + price history
DELETE /shopping-lists/:id/receive                    # undo put-away; reopen the list
```

`POST /shopping-lists/:id/receive` closes the loop: shopping updates the pantry *and*
records prices, so the data stays true without separate bookkeeping. A default
location covers the basket; checked lines may override it. Effects are grouped
under a `ReceiveSession` so `DELETE .../receive` can reverse a mistaken put-away.

---

## Frontend routes

Angular standalone components + Material, mirroring `packages/frontend/src/app` structure in
the existing app (`core/` for API services + auth interceptor + guards, `shared/` for reusable
components).

| Route | Screen |
|---|---|
| `/recipes`, `/recipes/:slug`, `/recipes/new` | Collection, detail with serving scaler, manual entry |
| `/recipes/import` | Paste-and-parse two-column review |
| `/pantry` | Lots grouped by location, expiry warnings |
| `/pantry/ingredients` | Catalog admin (densities, aliases, categories) |
| `/plan` | **Week calendar grid** — slots down, days across; drag to reschedule; per-day servings |
| `/cook` | Both "what can I cook" tabs |
| `/shopping` | Lists, check-off with brand/price entry, running total, receive-to-pantry |
| `/settings`, `/admin` | Stores, locations, pars; users and household; **AI key** (ADMIN only — masked `••••abcd`, rotate, clear) |

Shared components worth building once: quantity input (fraction-aware), unit select,
ingredient autocomplete (catalog + create-inline).

---

## Tenancy enforcement

Guards alone are not enough — one service method that forgets a `where` clause leaks another
household's data. Use a **Prisma client extension** in `prisma/prisma.service.ts` that
injects `householdId` into every query against a tenant-scoped model, sourced from a
request-scoped context. Guards then handle role checks only.
`common/inventory-scope.util.ts` in the existing app is the closest prior art for the
scoping helpers.

---

## Seed data

The unglamorous work that decides whether the app feels good on day one:

- ~40 units (metric, US volume/mass, "pinch", "clove", "can", "bunch")
- ~15 categories in store-walk order
- ~250 common ingredients with `gramsPerMl` / `gramsPerPiece` / `shelfLifeDays` and aliases
  (cilantro/coriander, scallion/green onion, aubergine/eggplant)

Budget real time for this — thin or wrong density data makes every conversion feature look
broken. Keep it as versioned JSON in `prisma/seed/`, idempotent on re-run, following the
`packages/backend/src/seed/` pattern.

---

## Build order

| Phase | Deliverable |
|---|---|
| 0 | Monorepo scaffold, docker-compose, Prisma bootstrap, local auth, health check |
| 1 | **Units + ingredient catalog + `convert()` with tests + seed data** |
| 2 | Recipes: manual CRUD, steps, tags, scaling, search |
| 3 | Pantry: locations, lots, transaction ledger, expiry warnings |
| 4 | Paste-and-parse + review UI |
| 5 | Meal planner calendar, cook/deduct, undo |
| 6 | "What can I cook" — deterministic first, then BYOK key config + LLM tab |
| 7 | Stores, shopping list generation, check-off with price capture, receive-to-pantry |
| 8 | Polish: PWA/offline read cache, dark mode, images, `ERD.md` |

Phase 1 before everything else, and it should not be rushed — phases 3, 5, 6, and 7 are all
just applications of `convert()`. Within phase 6, ship the deterministic method before the
LLM one; it's the fallback the AI path depends on and the grounding the prompt needs.

---

## Verification

- **Unit tests** — `shared-types/src/units.spec.ts`: a conversion table (same-kind,
  volume↔mass via density, count↔mass via piece weight) plus explicit assertions that
  missing density returns `ok: false` rather than throwing or guessing.
- **Service specs** — mirror `packages/backend/src/inventory/inventory.service.spec.ts` for
  shopping generation (date-range pull, aggregation, pantry subtraction, par shortfall,
  price prefill, unconvertible passthrough) and cook deduction (multi-lot oldest-first,
  partial shortfall, undo restoring exact prior balances).
- **AI suggestions** — unit-test the prompt payload builder and the Zod schema parse against
  recorded fixtures; assert the service degrades to Method 1 on a thrown API error, a
  `refusal` stop reason, and a malformed response. **No live API calls in the test suite.**
- **Key handling** — round-trip `secret-crypto.util.ts` (encrypt → decrypt → original);
  assert a wrong `AI_ENCRYPTION_KEY` fails the GCM auth tag rather than returning garbage;
  assert `GET /households/me/ai-config` never contains the plaintext key; assert `MEMBER`
  gets 403 on `PUT`/`DELETE`; assert one household's key is never used for another's request.
- **End-to-end smoke** (`scripts/smoke.js`, run against a disposable Postgres): seed →
  register → create recipe via `/recipes/parse` + confirm → stock pantry → plan three dinners
  across a week at 2× servings → generate list for that range → assert quantities and aisle
  order → receive with prices → assert pantry and `PriceObservation` rows → cook one meal →
  assert deductions → undo → assert restored.
- **Manual** — `npm run dev:up`, then walk the loop in the browser: import a real recipe by
  paste, stock a few pantry items, plan a week, confirm "what can I cook now" is honest,
  run the AI tab once against a real key and sanity-check that its substitutions make sense,
  generate a list, check items off with prices, cook, and confirm the pantry moved.
- `npm test` at the root runs everything, matching the existing repo's script convention.

---

## Deliberately out of scope for v1

URL/JSON-LD recipe import (`sourceUrl` is ready for it), OCR, nutrition data, leftovers
tracking, and recipe sharing between households.
