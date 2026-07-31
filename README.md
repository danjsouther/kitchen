# Recipes

Recipe collection, pantry inventory, meal planning and shopping lists for a household.
Self-hosted, with a schema that is ready for multi-tenant hosting later.

## The idea

A recipe calling for *2 cups of flour* and a pantry holding *a 5 lb bag of flour* are the
same substance in different units. Once the app understands that, everything else follows:
deducting a cooked meal from the pantry, answering "what can I cook right now", and
aggregating a week of planned meals into one shopping list are all applications of a single
conversion engine.

That engine is [`packages/shared-types/src/units.ts`](packages/shared-types/src/units.ts),
and it has one rule: **a conversion it cannot perform returns a failure, never a guess.**
It does not throw and it does not fall back to a plausible number, because a silently wrong
quantity is worse than a visibly incomplete one.

## Stack

| Package | What it is |
|---|---|
| `packages/shared-types` | Shared enums, DTO types, and the pure unit-conversion + formatting logic. No framework dependencies, so the frontend can preview a conversion without a round trip and the backend runs the identical code. |
| `packages/backend` | NestJS + Prisma + PostgreSQL |
| `packages/frontend` | Angular 22 (standalone components) + Angular Material 22 |

All three packages build with the **same TypeScript version (6.0.x)**. That is not a
preference, it is a constraint: Angular 22's compiler requires `>=6.0 <6.1`, and letting
the backend drift to a different major would mean two copies of `tsc` type-checking the
same shared package differently. If Angular pins a new range, all three move together.

Two consequences of TypeScript 6 worth knowing before you touch a `tsconfig`:

- **`node10` module resolution and `baseUrl` are deprecated** (removed in 7). `shared-types`
  is on `node16` and the backend on `nodenext`.
- **Only the *nearest* `node_modules/@types` is auto-included.** npm hoists `@types/jest` to
  the workspace root, so packages that leave a nested `@types` behind stop seeing it. Both
  test configs name their types explicitly rather than relying on discovery.

### Change detection

Angular 22 makes **`OnPush` the default**, so every component here carries an explicit
`ChangeDetectionStrategy.Eager` and `main.ts` calls `provideZoneChangeDetection()`. That is
deliberate, and it is a debt rather than a preference: several components hold plain
non-signal fields that are assigned inside an HTTP `subscribe` and then rendered, which
`OnPush` and zoneless would both leave stale on screen. Converting that state to signals is
what unblocks dropping the shim — until then, removing it silently breaks rendering rather
than failing a build.

## Getting started

```sh
npm install
cp .env.example .env         # then fill in the blanks — see below
npm run dev:up               # Postgres, migrations, catalog seed, then watch
```

`dev:up` is the whole loop: it starts the Postgres container, waits for it to actually
accept connections, applies migrations, seeds the catalog, and hands off to `npm run dev`.
Migrations are fatal if they fail; seeding is not, since a stale catalog should not stop
you working. Re-running it is safe — both steps are idempotent.

To stop:

```sh
npm run dev:down             # stop containers, keep the data
npm run dev:down -- --destroy   # ...and delete the database volume
```

The steps individually, if you want them:

```sh
docker compose up -d postgres
npm run prisma:migrate       # create the schema
npm run seed                 # 40 units, 16 categories, 311 ingredients
npm run dev                  # backend + frontend with watch
```

Three values in `.env` have no default and must be generated:

```sh
# JWT_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"

# AI_ENCRYPTION_KEY — exactly 32 bytes, base64
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`POSTGRES_PASSWORD` is yours to choose; keep it in sync with `DATABASE_URL`. The dev
database listens on **5433**, not the usual 5432, so it can run alongside another local
Postgres — change `POSTGRES_PORT` if you'd rather it didn't.

### A note on the catalog

Conversions only work as well as the ingredient data behind them. The seed ships densities
for 263 ingredients and piece weights for 120, which is what lets "2 cups of flour" become
250.78 g and "3 eggs" become 150 g. Where an ingredient has neither — a sprig of something,
an unusual item you added yourself — the app says so rather than inventing a number, and
offers to let you fill the value in.

### Deployment

```sh
docker compose up -d --build
```

That builds three images and serves the app at **http://localhost:8080**. Nothing else is
needed: the backend container applies migrations and seeds the catalog on every boot, so a
first run against an empty volume comes up ready to use.

The frontend image is nginx serving the built bundle, and it proxies `/api` to the backend
over the compose network — so the app and the API share an origin and the session cookie
stays first-party. No CORS, and no `SameSite=None`.

Postgres and the frontend bind to loopback only. Put a reverse proxy in front if you want
the app reachable beyond the host, and set `FRONTEND_URL` to match.

Two things worth knowing before changing the compose file:

- **The backend listens on 3000 inside the container**, not the 3001 in `.env`. That local
  default exists only to dodge a port clash on the host; compose overrides it, and
  `nginx.conf` proxies to `backend:3000`.
- **`nginx.conf` must not strip the `/api` prefix.** The API genuinely serves `/api/*`
  (`setGlobalPrefix('api')`), so a rewrite that removes it turns every call into a 404.

## AI suggestions are bring-your-own-key

The "what can I cook" screen has two tabs. The first is a deterministic pantry match — it
is the source of truth about quantities and never guesses. The second sends that match, plus
your pantry and recipe titles, to Claude for substitution ideas and expiry-driven
suggestions.

There is deliberately **no server-wide `ANTHROPIC_API_KEY`.** Each household supplies its
own key in Settings, an `ADMIN` can set or clear it, and it is stored AES-256-GCM-encrypted
with the server's `AI_ENCRYPTION_KEY`. No endpoint ever returns the key — only its last four
characters, so the UI can render `••••abcd`. Without a key the tab is hidden and everything
else works normally.

Rotating `AI_ENCRYPTION_KEY` makes every stored household key undecryptable; each household
then re-enters its own.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Backend and frontend in watch mode |
| `npm test` | Every workspace's tests |
| `npm run build` | Build all packages |
| `npm run prisma:migrate` | Create/apply a migration |
| `npm run prisma:studio` | Browse the database |
| `npm run seed` | Load units, categories and the ingredient catalog |
| `npm run verify:tenancy -w packages/backend` | Prove household isolation against a real database |
| `npm run smoke` | Walk the whole loop over HTTP against a running server |

The backend runs on **3001** and the Angular dev server on **4201**, which proxies
`/api` to it (`packages/frontend/proxy.conf.json`).

## How tenancy is enforced

Guards decide *who you are*; they say nothing about *whose data you are touching*. One
service method that forgets a `where` clause is all it takes to serve another household's
recipes, so the filter is applied in a
[Prisma client extension](packages/backend/src/prisma/tenancy.ts) where it cannot be
forgotten:

- Every read and write on a household-owned model is filtered to the caller's household.
- A `householdId` supplied by the caller is **overwritten**, not trusted.
- Catalog models (units, ingredients) *read* the global rows plus the household's own, but
  *write* only to the household's own. The asymmetry is the point: without it, one
  household could edit or delete the seeded catalog that every household reads.
- A query that reaches a scoped model with no household context **throws** rather than
  running unfiltered. Crossing households requires an explicit `runUnscoped()`, which
  exists in exactly one place: authenticating someone before we know their household.

Because the shared catalog is read-only, a household corrects it by forking a row —
`POST /ingredients/:id/customize` copies a global ingredient into one it owns, keeping the
slug. Searches then prefer the household's copy, so the corrected density is the one it
sees from that point on, and every other household is unaffected.

`npm run verify:tenancy` exercises all of that against real Prisma queries with two live
households — unit tests alone can't prove the extension is actually wired in.

## The pantry keeps a ledger

Every change to stock writes a `PantryTransaction` in the same database
transaction as the change itself: adding a lot is a `PURCHASE`, editing one an
`ADJUST`, throwing it out a `DISCARD`. Cooking a meal will deduct a dozen
ingredients at once, and without an audit trail one mis-scaled cook silently
corrupts the pantry with no way back.

Changing a lot's *unit* writes two entries — the whole old amount out in the old
unit, the whole new amount in in the new one — because a single delta would mean
subtracting grams from cups. Each unit's column adds up on its own.

Taking stock out spans lots **soonest-expiry-first**, and two rules hold
throughout ([deduction.ts](packages/backend/src/pantry/deduction.ts)):

- **No lot is ever driven negative.** A lot gives at most what it holds; the rest
  is reported as a shortfall.
- **A lot that cannot be converted is left untouched and named**, with the
  specific missing datum (`NO_DENSITY`, `NO_PIECE_WEIGHT`) so the user can fill it
  in. It is never guessed at or quietly skipped.

The same asymmetry runs through balances and par levels. A balance that could not
total anything reports `null`, not `0` — "we couldn't add this up" is a different
claim from "you have none". A par whose comparison can't be made reports `below:
null`, not `false`, because a wrong "you have enough" is the failure that leaves
someone at the stove without an ingredient.

## The shopping list closes the loop

`POST /shopping-lists/generate` turns a date range of planned meals into a
proposal — and saves nothing, because a generated list is a guess about a week
that has not happened yet. It scales each meal, folds repeated ingredients
together, subtracts what the pantry already holds, adds anything below its par
level, prefills prices from what was last paid, and sorts the result into
store-walk order.

`POST /shopping-lists/:id/receive` is what makes the next list better: ticked
items become pantry lots *and* price observations in one transaction. Shopping
updates the pantry and teaches the app what things cost, without anyone keeping a
second set of books.

The direction of each guess is deliberate, and differs by context:

- When a pantry balance **cannot be converted** into the unit being bought, the
  amount on hand is *not* subtracted and the line is flagged. That over-buys —
  the safe direction here, since arriving at the stove without an ingredient
  costs a meal while a spare bag costs a shelf.
- A **par level that cannot be compared** produces no line at all, because
  claiming a shortfall nobody can measure is a guess in the expensive direction.
- This is the opposite of how [the parser](#paste-and-parse-assumes-it-is-wrong)
  treats an ambiguous range, and for the opposite reason: a range is the recipe
  author's latitude, where less is a valid choice; an uncountable balance is
  missing information.

A store's aisle order is edited at `/settings/stores/:id`, and that screen places
**every** category rather than offering a partial list. The generator falls back
to the *catalog's* own position for any category a store has not placed, and both
numberings share one scale — so a half-finished walk interleaves with the default
instead of overriding it, putting position 11 of your walk between "Produce" (10)
and "Bakery" (20). Ordering the whole list makes that impossible, and the catalog
has 16 categories, so it costs nothing.

Items that cannot become a pantry lot — "paper towels" is not an amount of
anything — are reported in `skipped` with a reason rather than silently dropped.
Totals state `unpricedItems` outright, so a running total is never mistaken for
complete.

## "What can I cook" has two tabs, and only one does arithmetic

`GET /suggestions/pantry` is the source of truth. Every recipe line lands in one
of three buckets — `have`, `missing`, or **`unknown`** — and the third is the one
that matters: an ingredient measured in sprigs against a recipe calling for grams
is not evidence the cook has it. A single `unknown` line is enough to make
`canCook` false, because a confident "you can make this" that sends someone to
the kitchen to find out otherwise is worse than an honest shrug.

Requirements are summed **per ingredient** before comparing, so a recipe using
flour for the dough and again for dusting is checked against what it actually
needs rather than passing both lines against the same stock.

`POST /suggestions/ai` runs that same match first and hands it over as context.
The model explains, ranks and extends; it never recomputes. That rule is enforced
by the **response schema**, not just the prompt — there is no field anywhere in it
for a quantity or an amount on hand, so there is nowhere to assert a different
number. Recipe ids that do not exist are downgraded to "generated" rather than
passed through as dead links.

Failure is non-fatal in every direction. No key configured → 409 and the tab is
hidden. An API error, a refusal, or an unparseable response → the deterministic
answer comes back with a plain explanation. It is a `POST` and never fires on page
load, because it spends the household's own money.

`npm test` runs with **all network access blocked**
([test/no-network.ts](packages/backend/test/no-network.ts)), so a test that
quietly starts depending on a live API call fails loudly instead of becoming slow,
costly and flaky.

## The smoke run walks the whole thing

```sh
npm run dev:up     # in one terminal
npm run smoke      # in another
```

[`packages/backend/scripts/smoke.ts`](packages/backend/scripts/smoke.ts) registers a
scratch household and drives the real loop: paste a recipe and confirm the draft,
scale it, stock the pantry, plan three dinners at double the servings, generate a
list against a store with its own aisle order, tick items off with prices, receive
them, cook a meal, and undo it. 51 checks, then it deletes the household it made.

**Over HTTP, deliberately.** Calling the services directly would re-test what the
unit suites already cover and skip every seam that has actually broken here — DTO
validation, the `/api` prefix, the guards, and the interceptor that renders
Decimals as strings. It needs a running server for the same reason, and says so
plainly rather than timing out if it cannot find one.

It is not part of `npm test`, which blocks network access on purpose. Prisma
appears in it for exactly one job: removing the scratch household afterwards,
from a `finally`, since no endpoint deletes one and a failed run would otherwise
leave balances behind for the next one to trip over.

It earns its keep by pinning the claims this README makes where they are easiest
to break by accident — that an unconvertible balance reports `null` while an
empty pantry reports `0`, that undo restores every balance exactly, and that a
reversed cook session is stamped rather than deleted.

(The plan called this `scripts/smoke.js`. It lives with `verify-tenancy.ts`
instead, because the root `scripts/` are plain CommonJS and the generated Prisma
client is TypeScript, so cleanup could not run from there.)

## Paste-and-parse assumes it is wrong

`POST /recipes/parse` turns pasted text into a draft and **persists nothing** —
it answers 200, not 201, because nothing was created. The response is shaped like
the create-recipe payload with advice attached, so a review screen can hand it
straight back once a human has corrected it.

Names resolve through four routes, most trustworthy first: exact slug, alias,
singularised slug, then `pg_trgm` trigram similarity. Stopping at the first hit
means a real catalog entry is never passed over for something that merely looks
similar. Every line reports **which** route matched it, because "exact catalog
match" and "something a bit like it" deserve different amounts of trust — and
anything fuzzy, ranged, or inferred comes back with `needsReview` set.

Two places the parser makes a choice and says so: a range ("1-2 tsp") takes the
**lower** bound, since under-buying is recoverable and over-buying fills a
cupboard; and a bare unit ("a pinch of salt") reads as **one** of that unit,
because a unit with no number is not a measurement anything can scale.

The fuzzy matcher is the one place in the codebase writing raw SQL —
`similarity()` is a Postgres function Prisma cannot express — so it sits outside
the tenancy extension and states its household filter by hand. `npm test` and a
live check both cover that it cannot reach another household's private catalog.

## Editing, and how a field gets cleared

`/recipes/:id/edit` is the same component as `/recipes/new`, because `PATCH`
replaces ingredients, steps and tags wholesale exactly as `POST` writes them.
Only two things differ: where the model starts, and which method the save calls.

Editing raises a problem creating never does. On a `PATCH` an **absent field
means "leave alone"**, so a screen that omits its empty fields — which is right
on create, where absent and empty mean the same thing — can add a description
but never take one away. So on the nullable columns:

- an **empty string clears** `description`, `sourceUrl`, `sourceNote` and
  `notes`, and the edit screen always sends them;
- **zero clears** `prepMinutes` and `cookMinutes`, since `Int?` has no way to
  say "exactly no prep" and the create path has always dropped a 0;
- `sourceUrl` is exempted from `IsUrl` when empty, because otherwise the one
  value that means "remove the link" is the one value validation rejects.

The catalog says the same thing with **null**, because `""` is not a value a
`Decimal` DTO can take. `PATCH /ingredients/:id` reads an explicit null as "this
genuinely has no density", distinct from an absent field's "leave it alone", and
the editor sends one for every box the cook emptied.

That distinction was half-built by accident and worth knowing about, because the
accident is load-bearing: `@IsOptional()` skips every other validator when a
value is null, so nulls already reached Prisma and already cleared the column.
What it also did was let a null `name` through to a `NOT NULL` column, and hand
a null `categoryId` to a `findUnique` that cannot look one up — two 500s for
what should have been a 400 and an ordinary edit. So nullability is now stated
per field rather than inherited: `@ValidateIf` on `name`, which cannot be null,
and null skipped explicitly in the foreign-key check.

**`rawText` is not recomposed unless the line was renamed.** It is the record of
the line's *wording* — on a pasted recipe, the cook's own — while the amount
lives in its own column and is rendered separately. Folding a changed amount
back in would print it twice. A rename is the case that does need it, since the
stored wording no longer names the right thing.

The recipe screen holds up the other end of that. An unmatched line has no name
of its own, so `rawText` — the whole line, amount included — is what it shows;
printing the quantity column beside it gave "2 cups **2 cups** dried beans" for
every unresolved line the parser produced. The amount is now taken back off the
front of the raw text where it can be identified, several spellings deep
("2 tsp", "2 teaspoons", "2 teaspoon"), and anything unrecognised is left
exactly as written — shaving "2" off "200 g flour" would silently corrupt a
name.

Where the amount could not be identified, a **scaled** view still prints the
scaled figure beside the untouched text. Two numbers on one line is confusing;
showing only the unscaled wording after someone asked for six servings is
wrong, and the bad-but-visible option wins.

## Cooking closes the loop

`POST /planner/:id/cook` is where a recipe becomes a change to the pantry. It
scales every line to the servings actually being cooked, merges lines that name
the same ingredient in the same unit — a recipe that uses flour for the dough
*and* for dusting should walk the lots once, not twice — and deducts the result
soonest-expiry-first through the same [deduction
engine](packages/backend/src/pantry/deduction.ts) the pantry already uses.

What it will not do is guess. Lines it cannot deduct come back named rather than
dropped: `UNRESOLVED` for "salt and pepper to taste", `NO_QUANTITY`, `NO_UNIT`,
and `OPTIONAL`. Optional ingredients are deliberately left in stock — an
over-deduction is worse than an under-deduction, because it sends someone
shopping for something still on the shelf.

`DELETE /cook-sessions/:id` reverses a cook. It **writes the opposite ledger
entries rather than deleting the originals** — "cooked, then un-cooked" is a truer
history than "never happened" — and stamps `reversedOn` so a second undo cannot
restore the same quantities twice. A lot discarded since the cook cannot receive
its stock back; that is reported in `lostLots` rather than recreated, because
inventing a lot the user deliberately threw out would put food back on an empty
shelf.

Undo restores from the recorded delta, not from a snapshot, so it stays correct
when a lot was topped up between cooking and undoing. Quantities are stored to
four decimal places, which bounds any round-trip drift at 0.0001 of a unit.

## The screens

| Route | What it does |
|---|---|
| `/recipes` | The collection, searchable by title, description or an ingredient |
| `/recipes/import` | Paste-and-review — raw text beside the parse, with a picker on anything uncertain |
| `/recipes/new`, `/recipes/:id/edit` | Write one by hand, or correct one already saved |
| `/recipes/:id` | The recipe, with a serving scaler |
| `/pantry` | On-hand totals and every individual lot, with expiry warnings |
| `/plan` | The week grid; cook a meal from here, or undo one |
| `/cook` | Both "what can I cook" tabs |
| `/shopping` | Generate from the plan, tick off with prices, receive into the pantry |
| `/settings` | Locations, stores, and (for an admin) the AI key |

Two things the UI is careful about, because the backend went to the trouble of
being careful about them:

- A balance that could not be totalled shows **"not countable"**, never `0`, with
  the specific missing datum named in a tooltip the user can act on.
- The cook screen keeps `unknown` ingredients visually distinct from `missing`
  ones, because "we could not measure this" is not "you have run out".

Rescaling a recipe re-asks the server rather than multiplying in the browser, so
going 4 → 6 → 5 servings gives exactly what going straight to 5 would.

## Quantities on the wire

Decimal columns are serialized as **strings**, not JSON numbers. Storing `0.3333` cups and
`3.99` in `Decimal` and then handing it to the client as a float would undo the precision at
the last step, so `DecimalSerializerInterceptor` renders them as text and the frontend reads
them straight back into decimal.js.

Scaling follows the same rule. `GET /recipes/:id/scaled?servings=N` always scales from the
recipe's stored values, so viewing at 6 and then at 4 gives exactly what going straight to 4
would; each line carries both an exact `quantity` and a rounded `display` (`"1 ½ cups"`).
Lines with no quantity — "salt and pepper to taste" — come back unscaled rather than being
assigned an invented number.

## Status

Under construction. Built so far:

- [x] Monorepo scaffold, docker-compose, `.env.example`
- [x] Unit conversion engine, formatting and slug matching — 94 tests passing
- [x] Full Prisma schema, migrated against a live Postgres
- [x] Seed catalog — 40 units, 16 categories, 311 ingredients, 157 aliases; idempotent
- [x] Auth — register/login/logout/me, argon2, httpOnly session cookie, global guards
- [x] Tenancy enforcement — Prisma extension, 24/24 isolation checks against a live DB
- [x] AES-256-GCM secret storage for household API keys
- [x] Catalog API — unit and ingredient search, household-private additions, forked overrides
- [x] Recipes — CRUD with ingredients/steps/tags, search, serving scaler, archive/restore
- [x] Pantry — lots, locations, balances, expiry warnings, append-only ledger
- [x] Meal planner — week calendar, cook-and-deduct, reversible cook sessions
- [x] Paste-and-parse import — line classification, unit/ingredient matching, fuzzy fallback
- [x] "What can I cook" — deterministic pantry match, plus the BYOK Claude tab
- [x] Shopping lists — generation from the plan, aisle order, price capture, receive-to-pantry
- [x] Angular frontend — auth, recipes, parse review, pantry, planner, cook, shopping
- [x] Container build — backend and frontend images, `docker compose up` works from a
      clean clone, migrations and catalog seeding on boot
- [x] `dev:up` / `dev:down`

- [x] Pantry write screens — add, edit and discard a lot
- [x] Catalog admin (`/pantry/ingredients`) — densities, item weights, shelf life, with
      copy-on-write for shared ingredients

Not done yet, and worth knowing before you rely on it:

- [ ] **The remaining write screens.** There is still no way to add a meal to the planner
      and no store aisle editing. The endpoints exist and are tested; the screens do not.
      (`/recipes/new` is done — a recipe can now be written out by hand as well as pasted.)
- [ ] **Editing a saved recipe.** `PATCH /recipes/:id` exists and is tested, but nothing
      calls it: `/recipes/new` only creates. A typo in a saved recipe currently means
      writing it again.
- [ ] **Clearing a physical value.** The catalog form can set a density or item weight but
      cannot unset one — the API treats an absent field as "leave alone", so there is no way
      to express "this genuinely has no density". Fixing it properly means the API accepting
      an explicit null, not the UI sending an empty string.
- [ ] `ERD.md` — the schema is documented only by the comments in `schema.prisma`
- [ ] `scripts/smoke.js` — the end-to-end run described in the plan. The loop has been
      walked by hand against a live database, but nothing re-runs it.
- [ ] Recipe images — `Recipe.imagePath` exists in the schema; no upload endpoint or UI
- [ ] PWA / offline read cache

The full plan lives in `~/.claude/plans/help-me-spec-out-snuggly-hollerith.md`.
