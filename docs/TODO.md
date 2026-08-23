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
