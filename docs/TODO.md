# TODO / Roadmap

Backlog of larger initiatives not yet scheduled. Each is a multi-step effort —
plan it out (explore the relevant code, ask clarifying questions, write an
implementation plan) before starting work on it.

Grouped by priority. High = do next; Medium = queued behind it; Low = deferred,
not now. Priority reflects when it gets picked up, not size or importance —
read an entry's own notes for prerequisites rather than inferring them from the
tier.

## High

- [x] **Let deduction target a specific pantry lot/product, not just an ingredient total**
  ```
  Today every deduction path — cooking a recipe (CookService.deduct in
  packages/backend/src/planner/cook.service.ts) and the manual "use N of this
  ingredient" endpoint (PantryService.consume, POST /pantry/consume) — takes an
  ingredientId and a quantity, then hands every lot of that ingredient to
  planDeduction (packages/backend/src/pantry/deduction.ts), which always
  auto-allocates soonest-expiry-first across all of them. There is no way for a
  user to say "use *this* jar, the one I scanned/bought", only "use N grams of
  flour, wherever it comes from." Wanted: an optional lotId (or productId) on
  the deduction request that, when present, restricts planDeduction's candidate
  lots to that one instead of the full ingredient set, for both the cook flow
  and manual consume — reusing the existing shortfall/unusable reporting
  unchanged rather than adding a second code path. Recipe cooking multiplies
  the problem: a single recipe line can span several withdrawals resolved
  automatically, so the UI needs a way to let the cook optionally pin a
  specific product per ingredient line before confirming.

  Note: marking a lot fully empty/used already exists — DELETE /pantry/:id
  (PantryService.remove) discards the whole lot and logs a DISCARD
  PantryTransaction with an optional reason. What's missing is *partial*,
  targeted deduction against one specific lot rather than the ingredient
  aggregate.

  Done: `selectPinnedLots` (packages/backend/src/pantry/deduction.ts) narrows
  the candidate set to one lot or to every lot of one product before
  planDeduction runs — which is untouched, so shortfall/unusable reporting is
  unchanged. Both `lotId` and `productId` are supported, mutually exclusive;
  barcodes compare through normalizeBarcode on *both* sides, so a 12-digit
  UPC-A scan matches the EAN-13 OFF stored. A pin matching nothing is a typed
  failure (`pin-error.ts` maps it to 404/400) rather than an empty lot list —
  that would have flowed through as a full shortfall and read as "you have none
  of this" when the truth is "the jar you picked is gone". No migration:
  PantryTransaction.pantryItemId already records the lot.

  ConsumeDto gained the two fields; CookDto gained `pins[]` keyed by
  ingredientId (mergeWithdrawals can split one ingredient across units, and the
  cook pins a *line*). CookService.deduct was split into planFor/buildReport so
  the new preview routes — POST /cook-sessions/preview and
  POST /planner/:id/cook/preview — share one code path with the real cook
  instead of a second one that could drift.

  Frontend: cooking no longer fires straight off the planner menu. A new inline
  app-cook-confirm renders the CookReport nothing previously displayed and
  offers a per-ingredient lot picker that re-previews live. /pantry/consume got
  its first UI at all — a "Use some" Signal Form on each lot card, with the pin
  implicit.

  Then extended past pinning, because a pin still leaves the split to the app:
  `planExplicitDeduction` (deduction.ts) applies a division the user worked out
  themselves, lot by lot. A `pins[]` entry gains `draws: [{lotId, quantity}]`,
  in each **lot's own unit** — the number on the jar in front of them — and
  ConsumeDto takes the same. `resolveSelection` (pantry/selection.ts) is the one
  place all three modes (auto / pinned / explicit) are chosen between, so the
  cook and pantry screens cannot drift.

  Explicit draws keep the two invariants that are facts about the data rather
  than about intent: a draw is clamped to what the lot holds (typing 900 into a
  700 g bag records 700, never -200), and an amount that cannot be converted to
  the request's unit is **still deducted but never counted**. That third state
  is `DeductionPlan.unmeasured`, deliberately not folded into `unusable` —
  every consumer renders `unusable` as "left untouched", and "I used half a cup
  and cannot tell you what that is in grams" is neither that nor zero.
  `Allocation.takeInRequestUnit` became nullable for the same reason.
  ConsumeDto.quantity is now optional alongside draws: recording what was used
  states a fact rather than filling a requirement, so nothing can fall short.

  UI: the cook panel's lot picker was replaced by an amount box per lot,
  pre-filled with the proposed split and committed on blur; editing one box
  adopts the whole proposal so untouched lots are not silently zeroed, and
  "Let the app choose" hands the line back. `deducted` gained `needed` and
  `over` (computed as Decimal server-side — a displayed quantity must not go
  through a float) so a line reads "700 g of 500 g · 200 g over". The pantry
  balances tab gained an across-lots version.

  Deliberately not done: no way to pin or split from the /cook suggestions
  screen (it is read-only and has no deduction path); CookReport units are
  still bare UnitDefs, with the confirm panel resolving abbreviations through
  the unit catalog rather than adding display fields to the conversion
  contract; and there is no per-lot ordering preference ("prefer this jar, then
  fall back") — a draw is an amount, not a ranking.
  ```

- [ ] **Persist AI suggestions — they cost the household money and are currently thrown away**
  ```
  AiSuggestionsService.suggest (packages/backend/src/suggestions/ai-suggestions.service.ts)
  calls Anthropic on the household's own key, returns the parsed result straight
  out of POST /suggestions/ai, and writes nothing anywhere. There is no
  AiSuggestion model in packages/backend/prisma/schema.prisma. On the frontend
  the result lands in a plain `ai` signal in CookComponent
  (packages/frontend/src/app/cook/cook.component.ts:265), set only by askAi(),
  so navigating away from /cook — or reloading — destroys a paid response with
  no way to get it back except paying again. The service already computes
  `usage` (input/output/cacheRead tokens) and hands it to the client, where
  nothing stores it either, so a household cannot see what it has spent.

  Wanted: suggestions and their usage persisted per household, so a past run can
  be reopened, and so the AI tab shows the last result instead of an empty panel
  on arrival.

  Note: the degraded path is deliberate and should stay — `degrade()` returns
  `ok: false` with a reason and a null `ai` on refusal/parse failure/transport
  error. A failed call has nothing worth persisting but arguably still cost
  tokens; decide whether it gets a row.

  Open: schema shape (one row per run holding the whole JSON blob, versus
  normalised suggestion rows joinable to Recipe) — the response is already
  shape-guaranteed by SuggestionSchema, which argues for the blob, but a
  normalised form is what "cook the thing it suggested" would want later;
  retention (keep forever, cap per household, expire); whether the stored copy
  is re-reconciled on read, since reconcile() drops invented recipeIds against
  the recipe list *at request time* and a saved recipe can be archived
  afterwards, turning a stored SAVED_RECIPE into a dead link.
  ```

- [ ] **Return AI suggestions in recipe form, not just a title and a rationale**
  ```
  SuggestionSchema (packages/backend/src/suggestions/ai-suggestions.service.ts)
  gives each suggestion only `kind`, `recipeId`, `title`, `why`,
  `substitutions[]` and `usesExpiring[]` — no ingredient lines, no steps, no
  servings. For kind GENERATED that is the whole dish: the model proposes
  something not in their collection and the cook gets a name and a sentence,
  with nothing to actually cook from and no way to save it. CookComponent's AI
  panel renders exactly those fields, and the /cook screen has no deduction path
  at all (already noted in the pinned-lot entry above).

  Wanted: a GENERATED suggestion comes back as a real recipe body — ingredient
  lines with quantity/unit/name and ordered steps — good enough to cook from and
  to save into the household's collection.

  Already solved, do not rebuild: POST /parser/parse (ParserService.parse,
  packages/backend/src/parser/parser.service.ts:55) turns free-text ingredient
  lines into resolved ingredientId/unitId/quantity with fuzzy matching, and the
  import screen already feeds that into api.createRecipe
  (packages/frontend/src/app/recipes/recipe-import.component.ts:603,828). The
  gap is only that the AI response has no body to feed in.

  Open: whether the model emits free text lines that go through ParserService
  (keeps one resolution path, keeps quantities out of the model's structured
  contract) or emits structured quantity/unit/ingredient fields directly — note
  the schema's existing comment that the *absence* of quantity fields is the
  grounding rule, so putting amounts in the model's output needs a deliberate
  answer for how recipe amounts differ from pantry amounts; whether bodies are
  generated for every suggestion or only on demand for one the user picks
  (a second, cheaper call versus one large response); and whether SAVED_RECIPE /
  SUBSTITUTION suggestions get a body too, given the recipe already exists and
  only the swap is new.
  ```

- [x] **Fix stale quantity/unit/brand carrying over between items in the scan-queue stocking flow**
  ```
  ScanQueueComponent (packages/frontend/src/app/pantry/scan-queue.component.ts:114-120)
  keeps one `<app-pantry-item-form>` instance alive across the whole queue, only
  rebinding `[prefill]` to `current()` as the cook moves item to item.
  PantryItemFormComponent's `model` linkedSignal
  (pantry-item-form.component.ts:361-397) resets only from its declared source
  `{ lot, locations }` — `prefill` isn't part of that source, so nothing clears
  `model` when the queue advances to the next barcode. The doc comment right
  above it even names this exact failure mode for `lot` swaps ("one-time seeding
  left the previous lot's numbers under the new lot's name") but the fix was
  never extended to `prefill`, which has the identical component-stays-alive
  shape.

  The constructor effect that seeds from `prefill` (lines 427-434) calls
  `applyLookup` (lines 484-513), which only fills quantity/unitId/brand when the
  field is *currently empty* (`m.quantity || product.packQuantity`,
  `unitId === 0 ? ... : m.unitId`, `m.brand || brand`) — a guard meant to protect
  a hand-typed value from being clobbered by a rescan. Combined with `model`
  never resetting, whatever quantity/unit/brand item 1 ends up with (typed or
  prefilled) reads as "already filled" for item 2, so item 2's own pack
  size/brand from the food db is silently skipped and item 1's numbers stay
  attached to the new product instead. `ingredientId` doesn't have this problem
  — `applyIngredient` (line 562) always overwrites it regardless of the previous
  value — so only quantity/unitId/brand/expiresOn are affected, which is why the
  ingredient category looks right while the amount is wrong.

  Wanted: advancing to a new scan-queue entry resets the form to the same empty
  state a fresh add would have, then lets `applyLookup` fill in from that
  entry's own product.

  Open: whether `model`'s linkedSignal source grows to include `prefill`
  (matching how `lot` already resets it, simplest to reason about) versus giving
  ScanQueueComponent a keyed `@if`/`@for` that recreates `app-pantry-item-form`
  per entry (also resets `scan`/`pickerText`, which live outside `model` and
  have the same staleness risk).

  Done: `prefill` joined `lot` and `locations` in `model`'s linkedSignal source,
  taking the first option. Recreating the component per entry was rejected for
  one concrete reason: `previous` in that computation is what carries a
  hand-picked location forward, and a fresh instance per item would send every
  scan back to `locations[0]` — putting one shop away means picking "Cupboard"
  once, not nine times. Verified in the browser: the location chosen on item 1
  is still selected on items 2 and 3.

  Resetting the value was necessary but not sufficient, and the two extra
  pieces are the interesting part:

  Touched/dirty do not follow the value. Signal Forms hangs field state off the
  form, so item 2 opened in red on fields nobody had been near — the exact
  "editor reopens showing errors" failure SIGNAL-FORMS.md warns about, and one
  the old code never hit only because it never cleared the value either. The
  seeding effect now calls `itemForm().reset()` (plus clearing `error`, `scan`
  and `pickerText`) and is keyed on `${lot.id}:${prefill.id}` so it covers
  clicking lot-to-lot in the pantry list as well as advancing a queue. Removing
  just that one line reproduces "How much is required. / Pick a unit. / Pick an
  ingredient." on arrival at a product OFF has no pack size for.

  `applyLookup` also paired `packQuantity` with `packUnitId` and moved ahead of
  `applyIngredient`. It previously ran after, so the ingredient's default unit
  claimed `unitId === 0` first and the pack's number landed beside the wrong
  unit: McCormick vanilla extract (2 fl oz, ingredient default teaspoon)
  displayed **2 teaspoon**, and a 16 oz jar of Rao's displayed **16 each**. The
  pack describes the physical thing in your hand, so it wins; the pair is
  written together or not at all, matching the null-together invariant in
  CLAUDE.md. A quantity already typed by hand still keeps its own unit.

  Verified by driving the real app rather than by building it. Three queued
  barcodes with deliberately different pack units — Rao's 16 ounce, McCormick 2
  fluid ounce, Kirkland 244 millilitre. Before: every item read `16 each ·
  Rao's`. After: each reads its own. The same script run against HEAD
  reproduces the bug, so it is a real regression test and not a screenshot.

  Deliberately not done: no frontend test suite exists to park these scripts in
  (`npm test -w packages/frontend` is still a stub), so the Playwright drivers
  were throwaway. `expiresOn` was in the same stale set and is fixed by the
  same reset, but nothing prefills it from OFF — shelf life is still the
  server's job at save time.
  ```

## Medium

- [x] **Let a recipe be cooked without ever going on the calendar**
  ```
  The backend already supports this — CookService.cookRecipe and
  .previewRecipe (packages/backend/src/planner/cook.service.ts:74,106) deduct
  against a bare recipeId with no PlannedMeal involved, exposed as
  POST /cook-sessions and POST /cook-sessions/preview
  (CookSessionsController, packages/backend/src/planner/planner.controller.ts:81)
  and explicitly commented "cooking something that was never planned." But
  nothing in the frontend reaches it: api.service.ts has previewCookRecipe
  (line 323) calling /cook-sessions/preview, but no method at all for the
  commit endpoint, and app-cook-confirm (plan/cook-confirm.component.ts) is
  only ever instantiated from plan.component.ts against a plannedMealId. The
  recipe detail page (recipes/recipe-detail.component.ts) has no cook action —
  the only way to cook today is to first add the recipe to a calendar day,
  then cook it from there, which also leaves a COOKED entry sitting on the
  calendar for something the user never meant to plan (e.g. cooking dinner
  spontaneously from what's in the pantry).

  Wanted: a "Cook" entry point on the recipe detail page (or elsewhere a
  recipe is browsed) that opens the same confirm/pin/preview flow
  app-cook-confirm already renders, backed by the existing
  /cook-sessions[/preview] endpoints instead of /planner/:id/cook.

  Open: whether app-cook-confirm is generalized to accept either a
  plannedMealId or a bare recipeId (it already receives a CookReport shape
  from either preview call) or a second thin wrapper component is added;
  whether a spontaneous cook should offer to backfill a COOKED calendar entry
  for the day, or stay calendar-invisible entirely.

  Done: no backend changes — CookService.cookRecipe/.previewRecipe and their
  routes were already there. api.service.ts gained `cookRecipe` (POST
  /cook-sessions) alongside the existing `previewCookRecipe`.
  app-cook-confirm was generalized rather than duplicated: `meal:
  PlannedMeal` became a `target: CookTarget` discriminated union (`{ kind:
  'planned'; meal }` | `{ kind: 'recipe'; recipe: { id, title, servings } }`),
  branching only at the two API call sites and the title/effect-key — every
  other line of the 600-line pin/lot/draft/report logic was already generic
  over CookReport and needed no change. plan.component.ts's one usage was
  updated to wrap its meal in `{ kind: 'planned', meal }`.

  Two entry points: a "Cook" button on the recipe detail page's servings
  scaler, passing the *currently scaled* serving count (not the recipe's
  base) as an explicit override — the one chance to carry what's on screen
  into the deduction, since there's no planned-meal row to hold it. And a
  quick-cook icon on each recipe-list card, which just navigates to
  `/recipes/:id?cook=1` (a new `cook` input bound the same way `?q=` already
  is on the ingredients page) rather than duplicating the lot-picker inline —
  the list DTO has no ingredient data and the card grid has no room for it
  anyway.

  Decided calendar-invisible, not backfillable: verified end-to-end against a
  real household — cooking a recipe writes a CookSession with
  `plannedMealId: null`, deducts the pantry by exactly the scaled amount,
  produces no /planner row for the week, and undoes cleanly via the existing
  DELETE /cook-sessions/:id. The pre-existing planned-meal cook flow on /plan
  was re-verified unchanged.
  ```

- [ ] **Meal prep: let a planned meal span multiple days on the calendar**
  ```
  PlannedMeal.date (packages/backend/prisma/schema.prisma) is a single Date, so
  a batch-cooked meal eaten across several days has no way to occupy more than
  one calendar cell today — it either gets duplicated as separate entries (no
  shared cook session) or only shows on the day it was cooked. Needs a
  date-range or leftover-linked representation, plus deciding how cooking one
  such entry interacts with CookSession (does eating it later re-deduct, or is
  the deduction one-time at cook and the extra days purely a calendar display?).
  ```

- [ ] **Let the paste-import review screen set a description**
  ```
  The review step after pasting a recipe has no description input. The word
  does not appear anywhere in
  packages/frontend/src/app/recipes/recipe-import.component.ts: `draftModel` is
  `{ title, servings, ingredients, steps }` (line 538), the template offers
  Title and Servings and nothing else alongside them (lines 192-207), and the
  payload built in save() (line 811) omits `description`, so every imported
  recipe is created with it null. The only way to add one is to save, land on
  the detail page, and open the edit form — a second trip for something the user
  had in front of them at paste time.

  ParserService.parse (packages/backend/src/parser/parser.service.ts:55) also
  returns no description, so a blurb sitting in the pasted blob above the
  ingredients is discarded rather than offered back.

  Wanted: a description on the review form that reaches createRecipe with the
  rest of the draft.

  Already solved, do not rebuild: everything downstream. CreateRecipeDto takes
  `description` (recipes/dto/recipe.dto.ts:101), RecipesService.create trims and
  nulls it (recipes.service.ts:206), recipeHash covers it, search matches it
  (recipes.service.ts:767), and it renders on the list card
  (recipe-list.component.ts:93) and detail page (recipe-detail.component.ts:47).
  The gap is only the import form.

  Open: whether the parser attempts to extract a description from the blob (the
  free text before the first ingredient is a plausible heuristic and a plausible
  source of junk) or the field is purely manual; and whether it copies the
  edit form's 2000-char maxLength validator (recipe-form.component.ts:485) or
  the two forms should share one validation definition rather than repeating it.
  ```

- [ ] **Google/Discord (or other) OAuth login**
  ```
  Auth today is local (packages/backend/src/auth/) with no external identity
  provider wired in. Add OAuth login via Google and/or Discord as an
  alternative to the existing email/password + reset-link flow. Decide:
  account linking (does an OAuth login merge into an existing email-matched
  household user, or always create a new one), and whether AES-256-GCM
  household API key storage or any tenancy assumption needs to change for
  OAuth-only users.
  ```
