# TODO / Roadmap

Backlog of larger initiatives not yet scheduled. Each is a multi-step effort —
plan it out (explore the relevant code, ask clarifying questions, write an
implementation plan) before starting work on it.

Grouped by priority. High = do next; Medium = queued behind it; Low = deferred,
not now. Priority reflects when it gets picked up, not size or importance —
read an entry's own notes for prerequisites rather than inferring them from the
tier.

## High

- [ ] **Let deduction target a specific pantry lot/product, not just an ingredient total**
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
  ```

## Medium

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
