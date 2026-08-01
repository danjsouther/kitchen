# Changelog

Notable changes, newest first. Dates are the day the work landed.

## Unreleased

## 0.2.1 (2026-08-01)

### Changed — Deployable frontend port (2026-08-01)

`docker-compose.yml`'s frontend host port and the backend's CORS
`FRONTEND_URL` are now overridable (`FRONTEND_PORT`, `FRONTEND_URL`), so a
second deployment on a host that already has something bound to
`127.0.0.1:8080` doesn't clash. Needed to run this app alongside another one
behind nginx vhosts for different domains on the same box.

## 0.2.0 (2026-08-01)

### Added — Scan several pantry items before stocking them (2026-08-01)

Added a "Scan multiple" flow on the pantry page: `app-barcode-scan` gained an
opt-in `continuous` mode (camera stays on, with a per-code cooldown and an
outline-flash/vibration confirmation on each read) so a shopping bag's worth
of barcodes can be scanned back-to-back into a queue, then stocked one at a
time afterward through the existing per-lot form. The queue lives server-side
(`ScanQueueEntry`, household-scoped, barcode-only — everything else is
re-resolved from `ProductsService.byBarcode()` on read) rather than in page
state, so it survives a refresh and shows up on another device via a "N
scanned items waiting to be stocked" banner. New `pantry/scan-queue`
endpoints (`GET`/`POST`/`DELETE :id`/`DELETE`); `PantryItemFormComponent`
gained a `prefill` input so it can seed straight from a queued lookup instead
of showing its own scan UI. Every scan (camera or manual) now also gets a
snackbar confirming what happened — "Added <product>." or "Already in the
queue." — instead of the queue changing with no acknowledgment.

### Added — Pantry form fills amount and unit from the scanned product (2026-07-31)

Picking a product by barcode or by name now prefills `how much` and `unit`
from the product's pack size (`packQuantity`/`packUnitId`), which are null
together or not at all. Only fills fields still at their empty/unset default,
so a rescan can't clobber an amount typed by hand.

### Added — mkcert HTTPS dev setup for phone camera scanning (2026-07-31)

Camera access requires a secure context, and the dev server was LAN-reachable
but plain HTTP — so `navigator.mediaDevices` was `undefined` when a phone
opened it over the network, and the barcode scanner's "Scan" button never
appeared even though the component itself was already correct. Added an
`https` `ng serve` configuration (`packages/frontend/angular.json`), a
`dev:frontend:https` script, and `docs/DEV-HTTPS.md` walking through mkcert
setup and trusting the local CA on iOS. `packages/frontend/tls/` is
gitignored — the certs are machine-specific and never committed.

## 0.1.0 (2026-07-31)

### Added — Vendor the git and playwright-skill Claude Code skills (2026-07-31)

Checked in `.claude/skills/git/` (this repo's commit/branch/changelog rules)
and `.claude/skills/playwright-skill/` (browser automation for manual UI
verification) so they travel with the repo instead of living only on one
machine. `playwright-skill`'s `node_modules/` is npm-installed on first use and
stays out of git (`.claude/skills/*/node_modules/` added to `.gitignore`). Also
added `.agents/plan.md` (the original build spec) and
`.cursor/plans/open_food_facts_products_68668fa1.plan.md` for reference.

### Added — GIN trigram indexes on product name/brand (2026-07-31)

`product_name_trgm_idx` and `product_brands_trgm_idx` keep OFF-catalog product
search (~1M rows) off a sequential scan, mirroring the existing ingredient
trigram indexes. Raw SQL migration, same reason as `add_pg_trgm`: Prisma cannot
express `gin_trgm_ops`, so `migrate dev` will propose dropping these as drift —
delete those lines from the generated SQL.

### Fixed — Recipe editor: amount edits now recompose the ingredient line (2026-07-31)

An unmatched ingredient line carries its amount inside `rawText` (no catalog
name to hold it separately). Editing the quantity or unit on such a line saved
fine but left the old amount sitting in the printed text — "200 g flour"
stayed "200 g flour" after the unit was changed to milligrams. `lineText()` now
recomposes `rawText` when the amount changes, not just on rename, and the
leading-amount-stripping logic shared by the recipe screen and the editor moved
to `withoutLeadingAmount()` in `shared/format.ts` so both stay in agreement.

### Changed — Move ERD and TODO under docs/ (2026-07-31)

Moved `ERD.md` and `TODO.md` into `docs/`, added `docs/README.md` as an index,
and added `docs/SIGNAL-FORMS.md` covering how Signal Forms are written here.
Trimmed `CLAUDE.md` to point at the vendored Angular skill and
`docs/SIGNAL-FORMS.md` instead of duplicating their content.

### Changed — Frontend OnPush + zoneless (2026-07-31)

Dropped `ChangeDetectionStrategy.Eager` from every component (Angular 22’s
OnPush default), switched bootstrap to `provideZonelessChangeDetection()`, and
removed the `zone.js` dependency. Template-bound state was already signals.

### Added — Shopping put-away: multi-location + undo (2026-07-31)

Receiving a shopping list now takes a default storage location plus optional
per-item overrides, so one trip can put milk in the fridge and pasta in the
pantry. Effects are grouped under a `ReceiveSession`;
`DELETE /shopping-lists/:id/receive` undoes a mistaken put-away (reverse
surviving lots, delete price observations, reopen the list as `ACTIVE`),
mirroring cook undo. The shopping list screen offers **Undo put-away** on every
completed list so a bad receive is fixable from the same place it happened.

### Changed — Product categories: consensus default + household override

Effective ingredient category for a barcode is now **live ranked consensus**
across households (global ingredients only), with an optional household
`product_binding` override. Stocking under the consensus default does not write
an override; changing the category (or picking one when consensus is empty)
does. Clearing the override restores the crowd default.

- `GET /products/by-barcode/:code` returns `override`, `consensus`,
  `effectiveIngredient`, and `source` (`override` | `consensus` | null).
- Pantry and shopping resolve via `effectiveCategory` (override then consensus).
- `/pantry/barcodes` retitled to product category overrides.

### Added — Open Food Facts product catalog (2026-07-31)

Barcode scanning on pantry intake, backed by an offline mirror of Open Food
Facts rather than a live API.

- **Global `product` table**, no `householdId`. Barcode is the primary key;
  name, brands, pack size, category and country tags, image URL, per-100g
  nutriments and Nutri-Score. Written by the import CLI and by no endpoint.
- **Household `product_binding`**, optional category override for a barcode.
  Default category is ranked consensus across households (see above).
- **`productId` on `pantry_item`, `shopping_list_item` and `price_observation`**,
  all optional. `brand` is kept alongside it and denormalized from the product
  on intake, so existing screens and the shopping generator are unchanged.
- **`npm run off:download`** fetches the monthly JSONL export;
  **`npm run off:import`** streams it into Postgres with a country filter
  (`en:united-states` by default), batched idempotent upserts, and a `--replace`
  that refuses to run while any product is referenced.
- **`GET /products/by-barcode/:code`** returns the global product, override,
  consensus, and effective category. Also `GET /products?q=`,
  `GET /products/bindings`, `PUT|DELETE /products/:code/binding`.
- **Barcode field on the pantry form**, with camera capture via `BarcodeDetector`
  where the browser has it and `@zxing/browser` (lazily loaded) where it does
  not. Manual entry is always available and is not a fallback.
- **`/pantry/barcodes`** lists and clears this household's category overrides.

Notes on the decisions that are easy to get wrong later:

- Barcodes are normalized identically by the importer and the API — 12-digit
  UPC-A left-padded to EAN-13, UPC-E expanded — because a US pack scans in a
  different format from the one OFF stores it under.
- A pack size that will not parse leaves `packQuantity` **and** `packUnitId`
  null and keeps `quantityRaw`. A number with no unit is not a size.
- Nothing is ever categorized automatically from OFF tags or name suggestions.
  An override is written only when the user changes the category (or picks one
  when consensus is empty). Stocking the consensus default does not pin one.
- A barcode that is not in the mirror is not an error; the manual flow takes
  over.

### Fixed

- **The OFF import ran out of memory on the real dump.** Writing each batch as
  `prisma.$transaction(rows.map(row => prisma.product.upsert(...)))` retained
  memory that was never reclaimed; a full import died with `Reached heap limit`
  about a fifth of the way through 12.5 GB. Measured over the same 400,000
  lines, per-row upserts held a 3,023 MB heap and 3,970 MB RSS against 359 MB /
  945 MB for a single multi-row `INSERT ... ON CONFLICT DO UPDATE`, which is
  also twice as fast. A parse-only pass over the same lines stays at 153 MB, so
  the streaming and parsing were never the problem.
- **Product images never loaded.** The importer read `image_small_url`, which
  exists in the Open Food Facts *API* but not in the JSONL export — so the
  column was always null and the product card never showed a picture. Nothing
  errored and every test passed, because the fixtures had been written to the
  API's shape; a completed import of 925,530 products contained one image. URLs
  are now constructed from the dump's nested `images` object, using the raw code
  for the directory path rather than the normalized barcode (a 12-digit code
  lives under `041/196/010/184`, and padding it to EAN-13 first 404s). Fixtures
  were rewritten to the real export shape.
- Batches are now deduplicated by barcode before writing. Postgres refuses a
  multi-row upsert that touches one key twice, and refuses the whole statement
  with it — and duplicates are ordinary here, since a 12-digit UPC-A and its
  13-digit EAN form normalize to the same barcode by design.
- Lines are pre-filtered for the country tag with a substring test before
  `JSON.parse`, which is the costliest step in the loop. The test can only
  produce false positives, which the real check then rejects.
- `prisma migrate dev` proposes dropping the hand-written `pg_trgm` GIN indexes
  every time, because they exist only in raw SQL. The drops were removed from
  `20260731180117_add_off_product_catalog` and must be removed from any future
  migration that regenerates them.
