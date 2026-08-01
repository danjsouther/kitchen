# Working on this repo

Everything here has already gone wrong once, or is invisible until it bites.

## Frontend: read the Angular skill first

Vendored at `.claude/skills/angular-developer/` — `SKILL.md` plus
`references/` on signals, `linkedSignal`, `effect`, components, routing, forms,
DI, styling, migrations. Use `Skill(angular-developer)` to load it.

Consult it before writing components or wiring signals. Treat it as a strong
default, not gospel — some claims are stale against Angular 22.1 (e.g. it says
`submit()` marks fields touched; it does not). Verify in a browser.

## Forms are Signal Forms. Always.

`@angular/forms/signals` everywhere. No `FormsModule`, no `ngModel`, no reactive
forms — if you are importing any of them, you are doing it wrong.

**Read [docs/SIGNAL-FORMS.md](docs/SIGNAL-FORMS.md) before adding or changing a
form.** It
has the shape to copy and ten rules, each of which is a distinct silent failure:
a form that renders fine and then refuses to submit with nothing on screen, a
submit button that never fires, an editor that reopens showing errors.

Search boxes and filters are not forms — a plain `signal` with `[value]` +
`(input)`. That file covers those too.

## The rule the whole app rests on

A conversion that cannot be performed returns a typed failure. It never throws,
never guesses, never quietly becomes zero.

Every consumer handles `ok: false` explicitly. A pantry balance that could not
be summed shows **"not countable"**, not `0`. "Could not measure" is not "you
have run out" — the cook screen keeps `unknown` visually distinct from
`missing`. When something can't be computed, name the missing datum and link to
where it can be supplied.

## Money and quantities

Every quantity and price is a `Decimal` server-side and crosses the wire as a
**string**. Never route one through a JavaScript number in either direction —
that is how 0.33 cups and $3.99 rot. Round for display only, never in stored
values.

## Tenancy

Reads on catalog models see global rows (`householdId IS NULL`) plus the
household's own. **Writes are strictly scoped to the household.** That asymmetry
stops one household editing the shared catalog for everyone;
`packages/backend/src/prisma/tenancy.ts` enforces it.

Editing a shared ingredient forks a private copy first
(`POST /ingredients/:id/customize`) rather than patching in place.

## AI is bring-your-own-key

Deliberately **no server-wide `ANTHROPIC_API_KEY`**. Each household supplies its
own, stored AES-256-GCM encrypted; no endpoint returns a key, only
`keyLastFour`. Do not add a server-key fallback "for convenience" — that moves
everyone's costs and data onto one credential.

## Toolchain facts that look like mistakes

- **All three packages share TypeScript 6.0.x**, because Angular's compiler pins
  `>=6.0 <6.1`. Do not "fix" the backend to an older one.
- **OnPush default, zoneless bootstrap** (`provideZonelessChangeDetection()`).
  Template-bound state must be signals — a plain field mutated in a subscribe
  stays stale with nothing to point at.
- **The API serves `/api/*`** (`setGlobalPrefix('api')`); `nginx.conf` must not
  strip the prefix.
- **The backend listens on 3000 in the container**, not the 3001 in `.env`.
- **`.gitattributes` pins LF.** A CRLF `docker-entrypoint.sh` is a syntax error
  to the container's shell.
- **`prisma migrate dev` proposes dropping the `pg_trgm` indexes every time —
  delete those lines from the generated SQL.** `ingredient_name_trgm_idx` and
  `ingredient_alias_alias_trgm_idx` are raw SQL in the `add_pg_trgm` migration
  (Prisma cannot express `gin_trgm_ops`), so it reads them as drift. Letting a
  drop through breaks nothing loudly — search just falls back to a sequential
  scan. Editing an already-applied migration also needs its recorded checksum
  updated or `migrate` refuses to run.

## Products are global; category defaults to consensus

`Product` mirrors Open Food Facts and is the one global table that is not shared
catalog: no `householdId` column at all, deliberately — a barcode identifies a
physical pack, so a household-private duplicate defeats the point. It is written
by `npm run off:import` and by **no endpoint**; nothing enforces that except
that no service writes OFF fields. Keep it that way.

The **default** ingredient category for a barcode is live ranked consensus:
count `ProductBinding` rows per global ingredient (`householdId IS NULL`),
highest wins; household-created ingredients never enter the ranking. A household
owns only an optional **override** — present, it wins; cleared, the live default
returns. Stocking under the consensus default must **not** write an override, or
the household stops following the crowd. The consensus query is the one
deliberate cross-tenant aggregate (unscoped Prisma); it exposes counts and
global ingredients only.

Never auto-categorize from OFF tags or name suggestions. An override is written
only when the user explicitly changes the category (or picks one when consensus
is empty).

- **Normalize barcodes through `src/off/barcode.ts`, both directions.** A US
  pack scans as 12-digit UPC-A, OFF stores EAN-13 with a leading zero, small
  packs scan as UPC-E. Importer and lookup disagreeing means every affected scan
  misses a row that is sitting right there.
- **`packQuantity` and `packUnitId` are null together or not at all.** OFF's
  pack size is free text; the importer declines what it cannot read and keeps
  `quantityRaw`. A quantity with no unit is a number with no meaning.

### The import writes raw SQL on purpose

`writeBatch` in `import-off.cli.ts` is one multi-row
`INSERT ... ON CONFLICT DO UPDATE`. It looks like something to tidy into Prisma
calls. It is not: per-row `upsert` in a `$transaction` held a 3,023 MB heap and
died with `Reached heap limit` a fifth of the way through the 12.5 GB dump; the
bulk statement holds 359 MB and runs twice as fast. The parser and `readline`
backpressure were measured and are innocent.

- **Dedupe the batch by barcode first** (`dedupeByBarcode`). Postgres rejects
  the *entire statement* if a multi-row upsert touches one key twice, discarding
  500 good rows. Collisions are normal — `normalizeBarcode` maps UPC-A and
  EAN-13 forms onto one key by design.
- **`packQuantity` binds as a string**, cast `::decimal` in SQL.

### The JSONL dump is not the OFF API

Field names differ. `image_small_url` exists in API responses and **not in the
dump**, which has a nested `images` object the URL must be built from
(`buildImageUrl` in `off-row.ts`). Assuming the API shape failed silently: every
row parsed, every test passed, and an import of 925,530 products contained
exactly one image.

- **The image path uses the raw `code`, not the normalized barcode.** OFF splits
  the code as stored into groups of three, so a 12-digit code lives under
  `041/196/010/184`; padding to EAN-13 first asks for `004/119/601/0184`, which
  404s. Normalization makes *scanning* work and must not reach the image path.
- Codes of 8 digits or fewer are not split at all.

**Fixtures written from an API's documentation prove nothing about a dump.**
Check a real line — `zcat dump.jsonl.gz | head -1 | jq keys` — and confirm a
constructed URL resolves.

## Verify by running it, not by building it

Every serious bug here passed its unit tests and the compiler: the ordering bug,
the unit-agreement bug, the parser/API seam, the tenancy hole, the seed shipping
no data, the wrong-lot save.

`npm run dev:up` brings up Postgres, migrations, the catalog seed and both
servers. Drive it, check the browser console, clean up test households
afterwards.

When two checks contradict, distrust the cleverer one — a `grep` reporting CRLF
in every committed blob was wrong; a byte count settled it.
