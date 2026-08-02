/**
 * Imports an Open Food Facts JSONL export into the global `product` table.
 *
 *   npm run off:import -- --file data/off/products.jsonl.gz
 *   npm run off:import -- --file <path> --all
 *   npm run off:import -- --file <path> --replace
 *
 * From the repo root — the root script builds @kitchen/shared-types, which this
 * imports and which resolves through its dist/. Paths are relative to
 * packages/backend, npm's cwd for a workspace script.
 *
 * **Run this monthly, by hand or by cron.** It is deliberately not part of
 * `dev:up`, the Docker entrypoint or any nightly job: the dump is measured in
 * gigabytes, OFF regenerates it on their own schedule, and an import wired into
 * startup would turn a five-second boot into a twenty-minute one for data that
 * changes slowly.
 *
 * Design notes worth keeping:
 *
 * - **Streamed, never buffered.** The uncompressed export does not fit in a
 *   Node heap. gunzip → line split → batch → write, with nothing accumulating.
 *   Backpressure through `readline` is real and was measured: the source
 *   advances in step with the writes rather than racing ahead.
 * - **One SQL statement per batch, deliberately.** See `writeBatch` — the
 *   obvious per-row Prisma version exhausted a 4 GB heap partway through a
 *   real import. Do not convert it back.
 * - **Unscoped Prisma.** `product` is global, and the tenancy extension throws
 *   on a scoped model with no household context. This runs outside a request
 *   and writes rows belonging to nobody, which is exactly what the raw client
 *   is for.
 * - **Idempotent.** Upsert by barcode, so re-running over the same dump is a
 *   no-op with fresher `importedOn` stamps rather than a duplicate catalog.
 *
 * Attribution: OFF data is ODbL, product images DbCL. See README.md.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { createGunzip } from 'node:zlib';

import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnv } from 'dotenv';

import { PrismaClient } from '../../generated/prisma/client';
import { dedupeByBarcode, mayMatchCountry } from './off-batch';
import { parseOffLine, type ParsedOffProduct, type SkipReason } from './off-row';
import { buildUnitTokenMap, resolveUnitToken } from './off-units';

const rootEnv = resolve(__dirname, '../../../../.env');
if (existsSync(rootEnv)) loadEnv({ path: rootEnv, quiet: true });

/**
 * Rows per write. Large enough that the round trips are not the bottleneck,
 * small enough that one batch's parameters stay well inside Postgres' limit.
 */
const BATCH_SIZE = 500;

/**
 * The default country filter.
 *
 * The full export is every product in the world, and importing all of it to
 * scan a jar of peanut butter bought locally is a poor trade. `--all` overrides
 * it; `--countries` replaces it.
 */
const DEFAULT_COUNTRIES = ['en:united-states'];

interface Options {
  file: string;
  countries: string[];
  replace: boolean;
  limit: number | null;
}

interface Stats {
  read: number;
  imported: number;
  skipped: Record<SkipReason, number>;
  packParsed: number;
  packUnresolvedUnit: number;
  /** Rows collapsed because another row in the same batch had that barcode. */
  duplicateBarcodes: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(options.file)) {
    fail(
      `No such file: ${options.file}\n` +
        'Paths are relative to packages/backend.\n' +
        'Fetch a dump first: npm run off:download',
    );
  }

  const sizeMb = Math.round(statSync(options.file).size / 1_000_000);
  console.log(`Importing ${options.file} (${sizeMb} MB)`);
  console.log(
    options.countries.length
      ? `Country filter: ${options.countries.join(', ')}`
      : 'Country filter: none (--all)',
  );

  const prisma = new PrismaClient({
    adapter: new PrismaPg(process.env.DATABASE_URL!),
  });

  try {
    const units = await prisma.unit.findMany({
      select: { id: true, householdId: true, name: true, plural: true, abbrev: true },
    });
    const unitTokens = buildUnitTokenMap(units);
    if (unitTokens.size === 0) {
      fail('No global units found. Run `npm run seed` before importing products.');
    }

    if (options.replace) {
      // Bindings and stocked lots reference products by barcode, so a blunt
      // truncate would either fail on the foreign keys or take real household
      // data with it. Refuse rather than damage anything: a stale global row is
      // a much smaller problem than a pantry lot that loses what it was.
      const referenced = await countReferences(prisma);
      if (referenced > 0) {
        fail(
          `--replace refuses to run: ${referenced} household row(s) reference a ` +
            'product (bindings, pantry lots, list items or prices). Import ' +
            'without --replace — the upsert refreshes existing rows in place.',
        );
      }
      const { count } = await prisma.product.deleteMany({});
      console.log(`--replace: removed ${count} existing product rows`);
    }

    const stats = await streamImport(prisma, options, unitTokens);
    report(stats);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * The pipeline itself.
 *
 * `crlfDelay: Infinity` matters: the dump is LF, but a file that has been
 * through a Windows tool is not, and without it every line would arrive with a
 * trailing `\r` that lands inside the JSON parse.
 */
async function streamImport(
  prisma: PrismaClient,
  options: Options,
  unitTokens: ReadonlyMap<string, number>,
): Promise<Stats> {
  const stats: Stats = {
    read: 0,
    imported: 0,
    skipped: {
      'unparseable-json': 0,
      'no-barcode': 0,
      'no-name': 0,
      'country-filtered': 0,
    },
    packParsed: 0,
    packUnresolvedUnit: 0,
    duplicateBarcodes: 0,
  };

  const source = options.file.endsWith('.gz')
    ? createReadStream(options.file).pipe(createGunzip())
    : createReadStream(options.file);

  const lines = createInterface({ input: source, crlfDelay: Infinity });

  let batch: ParsedOffProduct[] = [];

  for await (const line of lines) {
    if (line.trim() === '') continue;
    stats.read += 1;

    // Cheap pre-filter before the expensive parse.
    //
    // `JSON.parse` on a full OFF row is the single costliest thing in this
    // loop, and with the default country filter roughly six lines in seven are
    // parsed only to be thrown away. A substring test on the raw text is
    // orders of magnitude cheaper.
    //
    // It cannot produce a false negative: if `countries_tags` really contains
    // "en:united-states" then the raw JSON contains that substring. It can
    // produce false positives — the tag might appear in some other field — and
    // those cost nothing, because `parseOffLine` still does the real check
    // against the parsed array.
    // Progress is reported before anything can `continue` past it. Sitting
    // below the filter, it only printed on the multiples of 100,000 that
    // happened to survive — which on a twenty-minute job reads as a hang.
    if (stats.read % 100_000 === 0) {
      console.log(
        `  …${stats.read.toLocaleString()} lines, ${stats.imported.toLocaleString()} imported`,
      );
    }

    if (!mayMatchCountry(line, options.countries)) {
      stats.skipped['country-filtered'] += 1;
      continue;
    }

    const result = parseOffLine(line, options.countries);
    if (!result.ok) {
      stats.skipped[result.reason] += 1;
    } else {
      batch.push(result.product);
      if (batch.length >= BATCH_SIZE) {
        await writeBatch(prisma, batch, unitTokens, stats);
        batch = [];
      }
    }

    if (options.limit !== null && stats.imported + batch.length >= options.limit) break;
  }

  if (batch.length > 0) await writeBatch(prisma, batch, unitTokens, stats);
  return stats;
}

/** Columns per row in the bulk upsert, in the order `writeBatch` binds them. */
const COLUMNS = 12;

/**
 * Writes one batch as a single multi-row `INSERT ... ON CONFLICT DO UPDATE`.
 *
 * Upsert rather than `createMany({ skipDuplicates })`: the point of a monthly
 * refresh is that a product whose name, pack size or nutriments changed gets
 * the new values, and skipping duplicates would keep the old ones forever.
 *
 * **One statement, not 500.** This was originally
 * `prisma.$transaction(rows.map(row => prisma.product.upsert(...)))`, which is
 * the obvious way to write it and is quietly unusable at dump scale. Measured
 * over the same 400,000 lines of the real export:
 *
 * | | 500 upserts in a transaction | this |
 * |---|---|---|
 * | heap | 3,023 MB | 359 MB |
 * | RSS | 3,970 MB, pinned at the limit | 945 MB, flat |
 * | throughput | ~1,500 lines/s | ~3,000 lines/s |
 *
 * The memory was the fatal part: it climbed monotonically and did not come
 * back down even across stretches where no row matched the country filter and
 * nothing was written at all, so a full import died with
 * `FATAL ERROR: Reached heap limit` about a fifth of the way in. The retention
 * is in building and holding hundreds of Prisma operation objects per batch,
 * not in the parsing or the streaming — a parse-only pass over the same lines
 * sits at 153 MB and stays there.
 *
 * So: do not "tidy" this back into per-row Prisma calls. It is raw SQL on
 * purpose, and the shape is load-bearing.
 *
 * `$executeRawUnsafe` is safe here despite the name. The statement text is
 * assembled only from a fixed template plus generated `$1, $2, …` placeholders;
 * every value the dump supplies is bound as a parameter and none is
 * interpolated.
 */
async function writeBatch(
  prisma: PrismaClient,
  batch: readonly ParsedOffProduct[],
  unitTokens: ReadonlyMap<string, number>,
  stats: Stats,
): Promise<void> {
  // One duplicated barcode would make Postgres refuse the whole statement and
  // lose 500 good rows with it. See `dedupeByBarcode`.
  const rows = dedupeByBarcode(batch);

  const values: unknown[] = [];
  const tuples: string[] = [];

  rows.forEach((product, index) => {
    const packUnitId = resolveUnitToken(unitTokens, product.packUnitToken);

    // A quantity with no unit is not a size — it is a number with no meaning,
    // and storing it would let the UI render "500" of nothing. Both fields go
    // together or neither does; `quantityRaw` still carries the original text.
    const usablePack = product.packQuantity !== null && packUnitId !== null;
    if (product.packQuantity !== null) {
      if (usablePack) stats.packParsed += 1;
      else stats.packUnresolvedUnit += 1;
    }

    const base = index * COLUMNS;
    tuples.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5}::decimal,` +
        `$${base + 6}::int,$${base + 7}::text[],$${base + 8}::text[],$${base + 9},` +
        `$${base + 10}::jsonb,$${base + 11},$${base + 12}::timestamp)`,
    );

    values.push(
      product.barcode,
      product.name,
      product.brands,
      product.quantityRaw,
      // Bound as a string, never a JS number: this lands in a Decimal column
      // and routing it through a float is exactly what this app does not do.
      usablePack ? product.packQuantity : null,
      usablePack ? packUnitId : null,
      product.categoriesTags,
      product.countriesTags,
      product.imageSmallUrl,
      JSON.stringify(product.nutriments),
      product.nutriscoreGrade,
      new Date(),
    );
  });

  // `barcode` is the key and is not updated; everything else is refreshed so a
  // monthly run actually reflects OFF's current data.
  const sql =
    `INSERT INTO "product" ("barcode","name","brands","quantityRaw","packQuantity",` +
    `"packUnitId","categoriesTags","countriesTags","imageSmallUrl","nutriments",` +
    `"nutriscoreGrade","importedOn") VALUES ${tuples.join(',')} ` +
    `ON CONFLICT ("barcode") DO UPDATE SET ` +
    `"name"=EXCLUDED."name","brands"=EXCLUDED."brands",` +
    `"quantityRaw"=EXCLUDED."quantityRaw","packQuantity"=EXCLUDED."packQuantity",` +
    `"packUnitId"=EXCLUDED."packUnitId","categoriesTags"=EXCLUDED."categoriesTags",` +
    `"countriesTags"=EXCLUDED."countriesTags","imageSmallUrl"=EXCLUDED."imageSmallUrl",` +
    `"nutriments"=EXCLUDED."nutriments","nutriscoreGrade"=EXCLUDED."nutriscoreGrade",` +
    `"importedOn"=EXCLUDED."importedOn"`;

  await prisma.$executeRawUnsafe(sql, ...values);

  stats.imported += rows.length;
  stats.duplicateBarcodes += batch.length - rows.length;
}

async function countReferences(prisma: PrismaClient): Promise<number> {
  const [bindings, lots, items, prices] = await Promise.all([
    prisma.productBinding.count(),
    prisma.pantryItem.count({ where: { productId: { not: null } } }),
    prisma.shoppingListItem.count({ where: { productId: { not: null } } }),
    prisma.priceObservation.count({ where: { productId: { not: null } } }),
  ]);
  return bindings + lots + items + prices;
}

function report(stats: Stats): void {
  console.log('');
  console.log(`Lines read:     ${stats.read.toLocaleString()}`);
  console.log(`Products saved: ${stats.imported.toLocaleString()}`);
  console.log(`  with a usable pack size: ${stats.packParsed.toLocaleString()}`);
  if (stats.packUnresolvedUnit > 0) {
    console.log(
      `  pack size dropped, no such unit:  ${stats.packUnresolvedUnit.toLocaleString()}`,
    );
  }
  if (stats.duplicateBarcodes > 0) {
    console.log(
      `  duplicate barcodes collapsed:     ${stats.duplicateBarcodes.toLocaleString()}`,
    );
  }
  console.log('Skipped:');
  for (const [reason, count] of Object.entries(stats.skipped)) {
    if (count > 0) console.log(`  ${reason}: ${count.toLocaleString()}`);
  }
}

function parseArgs(argv: readonly string[]): Options {
  let file = '';
  let countries = DEFAULT_COUNTRIES;
  let replace = false;
  let limit: number | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--file':
        file = argv[i + 1] ?? '';
        i += 1;
        break;
      case '--countries':
        countries = (argv[i + 1] ?? '')
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean);
        i += 1;
        break;
      case '--all':
        countries = [];
        break;
      case '--replace':
        replace = true;
        break;
      case '--limit':
        limit = Number(argv[i + 1]);
        i += 1;
        break;
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        fail(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }

  if (!file) fail(`--file is required.\n\n${USAGE}`);
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
    fail('--limit must be a positive number.');
  }

  return { file, countries, replace, limit };
}

const USAGE = `Usage: npm run off:import -w packages/backend -- --file <path> [options]

  --file <path>        JSONL or JSONL.gz export from Open Food Facts (required)
  --countries a,b      OFF country tags to keep (default: ${DEFAULT_COUNTRIES.join(',')})
  --all                No country filter — the whole world
  --replace            Delete existing products first; refuses if any are in use
  --limit <n>          Stop after n products, for a quick trial run
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
