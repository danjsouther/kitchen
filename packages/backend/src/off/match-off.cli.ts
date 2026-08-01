/**
 * Bulk-matches the Open Food Facts mirror (`product`) to the global ingredient
 * catalog, writing the matches as `product_binding` rows under one designated
 * "system" household.
 *
 *   npm run off:match -w packages/backend
 *   npm run off:match -w packages/backend -- --dry-run
 *   npm run off:match -w packages/backend -- --limit 1000 --fuzzy-threshold 0.65
 *
 * **Why a system household, not "no household".** `product_binding` is
 * tenant-scoped (`@@unique([householdId, productId])`), and `rankedConsensus`
 * in `ProductsService` counts every household's votes for a barcode with no
 * special-casing — it does not exclude any particular household id. Writing
 * under one designated household therefore does exactly what a "starting
 * default" needs to do: it becomes the visible consensus for a barcode nobody
 * has voted on yet, and a real household's own override or vote still wins or
 * out-tallies it. This is deliberate, not an oversight — see the plan this
 * script was built from.
 *
 * **Always overwrites.** Every run replaces the system household's previous
 * guess for every product it can match, rather than skipping barcodes a real
 * household has already voted on — it is simply one more vote in the tally,
 * and it costs nothing where a real vote already dominates.
 *
 * **Matching**, see `off-match.ts`: exact slug → alias → singularized slug
 * (always written) → trigram similarity (written only above
 * `--fuzzy-threshold`, default 0.6). Only global ingredients
 * (`householdId IS NULL`) are candidates, matching what `rankedConsensus`
 * ranks.
 *
 * **Bare, unscoped Prisma client**, same reasoning as `import-off.cli.ts`:
 * this runs outside a request, writes rows that belong to the system
 * household explicitly rather than through `runWithHousehold`, and the
 * tenancy extension would only get in the way.
 *
 * **Batched raw SQL**, both for the trigram fallback and for the writes —
 * same reasoning as `import-off.cli.ts`'s `writeBatch`: one round trip per
 * page rather than one per product, at a scale (the whole OFF mirror) where
 * per-row Prisma calls are not viable.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnv } from 'dotenv';

import { PrismaClient } from '../../generated/prisma/client';
import {
  MatchKind,
  fuzzyResult,
  matchBySlugOrAlias,
  shouldWrite,
  type AliasesBySlug,
  type CatalogIngredient,
  type IngredientsBySlug,
  type MatchResult,
} from './off-match';

const rootEnv = resolve(__dirname, '../../../../.env');
if (existsSync(rootEnv)) loadEnv({ path: rootEnv, quiet: true });

/** The household every system-guessed binding is written under. */
const SYSTEM_HOUSEHOLD_NAME = 'OFF Auto-Match';

/** Products read, and bindings written, per round trip. */
const PAGE_SIZE = 1000;

const DEFAULT_FUZZY_THRESHOLD = 0.6;

interface Options {
  dryRun: boolean;
  fuzzyThreshold: number;
  limit: number | null;
  sample: number;
}

interface SampleRow {
  barcode: string;
  productName: string;
  ingredientName: string;
  confidence: number;
}

interface Stats {
  productsSeen: number;
  byKind: Record<MatchKind, number>;
  belowThreshold: number;
  written: number;
  samples: Record<MatchKind, SampleRow[]>;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  console.log(
    options.dryRun
      ? 'Dry run: matches will be computed and reported, nothing will be written.'
      : `Writing matches under household "${SYSTEM_HOUSEHOLD_NAME}".`,
  );
  console.log(`Fuzzy threshold: ${options.fuzzyThreshold}`);

  const prisma = new PrismaClient({
    adapter: new PrismaPg(process.env.DATABASE_URL!),
  });

  try {
    const householdId = options.dryRun ? null : await ensureSystemHousehold(prisma);
    const { ingredientsBySlug, aliasesBySlug } = await loadCatalog(prisma);

    if (ingredientsBySlug.size === 0) {
      fail('No global ingredients found. Run `npm run seed` before matching.');
    }

    const stats = await run(prisma, options, householdId, ingredientsBySlug, aliasesBySlug);
    report(stats, options);
  } finally {
    await prisma.$disconnect();
  }
}

async function ensureSystemHousehold(prisma: PrismaClient): Promise<number> {
  const existing = await prisma.household.findFirst({
    where: { name: SYSTEM_HOUSEHOLD_NAME },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await prisma.household.create({
    data: { name: SYSTEM_HOUSEHOLD_NAME },
    select: { id: true },
  });
  console.log(`Created household "${SYSTEM_HOUSEHOLD_NAME}" (id ${created.id}).`);
  return created.id;
}

/** Loads the whole global catalog into memory — low thousands of rows, not the product mirror. */
async function loadCatalog(
  prisma: PrismaClient,
): Promise<{ ingredientsBySlug: IngredientsBySlug; aliasesBySlug: AliasesBySlug }> {
  const [ingredients, aliases] = await Promise.all([
    prisma.ingredient.findMany({
      where: { householdId: null },
      select: { id: true, name: true, slug: true },
    }),
    prisma.ingredientAlias.findMany({
      where: { ingredient: { householdId: null } },
      select: { slug: true, ingredient: { select: { id: true, name: true, slug: true } } },
    }),
  ]);

  const ingredientsBySlug = new Map<string, CatalogIngredient>(
    ingredients.map((row) => [row.slug, row]),
  );
  const aliasesBySlug = new Map<string, CatalogIngredient>(
    aliases.map((row) => [row.slug, row.ingredient]),
  );

  return { ingredientsBySlug, aliasesBySlug };
}

async function run(
  prisma: PrismaClient,
  options: Options,
  householdId: number | null,
  ingredientsBySlug: IngredientsBySlug,
  aliasesBySlug: AliasesBySlug,
): Promise<Stats> {
  const stats: Stats = {
    productsSeen: 0,
    byKind: { EXACT: 0, ALIAS: 0, SINGULAR: 0, FUZZY: 0, NONE: 0 },
    belowThreshold: 0,
    written: 0,
    samples: { EXACT: [], ALIAS: [], SINGULAR: [], FUZZY: [], NONE: [] },
  };

  let cursor: string | undefined;

  for (;;) {
    const remaining = options.limit === null ? PAGE_SIZE : options.limit - stats.productsSeen;
    if (remaining <= 0) break;

    const page = await prisma.product.findMany({
      select: { barcode: true, name: true },
      orderBy: { barcode: 'asc' },
      take: Math.min(PAGE_SIZE, remaining),
      ...(cursor ? { cursor: { barcode: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;

    const namesByBarcode = new Map(page.map((p) => [p.barcode, p.name]));
    const matches = new Map<string, MatchResult | null>();
    const unresolved: { barcode: string; name: string }[] = [];

    for (const product of page) {
      const match = matchBySlugOrAlias(product.name, ingredientsBySlug, aliasesBySlug);
      if (match) matches.set(product.barcode, match);
      else unresolved.push(product);
    }

    if (unresolved.length > 0) {
      const fuzzy = await fuzzyMatchBatch(prisma, unresolved);
      for (const product of unresolved) {
        matches.set(product.barcode, fuzzy.get(product.barcode) ?? null);
      }
    }

    const writes: { barcode: string; ingredientId: number }[] = [];
    for (const [barcode, match] of matches) {
      stats.productsSeen += 1;
      const kind = match?.kind ?? MatchKind.NONE;
      stats.byKind[kind] += 1;

      if (options.sample > 0) {
        reservoirAdd(
          stats.samples[kind],
          options.sample,
          stats.byKind[kind],
          {
            barcode,
            productName: namesByBarcode.get(barcode) ?? '',
            ingredientName: match?.name ?? '',
            confidence: match?.confidence ?? 0,
          },
        );
      }

      if (!shouldWrite(match, options.fuzzyThreshold)) {
        if (match?.kind === MatchKind.FUZZY) stats.belowThreshold += 1;
        continue;
      }
      writes.push({ barcode, ingredientId: match!.ingredientId });
    }

    if (!options.dryRun && writes.length > 0 && householdId !== null) {
      await writeBindings(prisma, householdId, writes);
    }
    stats.written += writes.length;

    if (stats.productsSeen % 10_000 < PAGE_SIZE) {
      console.log(`  …${stats.productsSeen.toLocaleString()} products processed`);
    }

    cursor = page[page.length - 1].barcode;
    if (page.length < PAGE_SIZE) break;
  }

  return stats;
}

/**
 * Reservoir sampling (Algorithm R): keeps an unbiased random sample of size
 * `size` from a stream seen one item at a time, without knowing its length in
 * advance. `seenCount` is the count of this kind seen so far, including the
 * current item. Used so `--sample` reflects the whole run rather than just
 * whichever barcodes happen to sort first.
 */
function reservoirAdd<T>(reservoir: T[], size: number, seenCount: number, item: T): void {
  if (reservoir.length < size) {
    reservoir.push(item);
    return;
  }
  const index = Math.floor(Math.random() * seenCount);
  if (index < size) reservoir[index] = item;
}

/**
 * Best trigram hit per product, across both ingredient names and aliases,
 * restricted to global ingredients — the batched equivalent of
 * `ParserService.fuzzyMatch`.
 *
 * The `%` operator (not just `similarity() >=`) is what lets Postgres use
 * `ingredient_name_trgm_idx` / `ingredient_alias_alias_trgm_idx` to prune
 * candidates instead of scoring every ingredient against every product name.
 * Its default threshold (0.3) is below every fuzzy-write threshold this
 * script would sensibly be run with, so it never hides a candidate that would
 * otherwise have qualified.
 */
async function fuzzyMatchBatch(
  prisma: PrismaClient,
  products: readonly { barcode: string; name: string }[],
): Promise<Map<string, MatchResult>> {
  const rows = await prisma.$queryRaw<
    Array<{ barcode: string; id: number | null; name: string | null; slug: string | null; score: number | null }>
  >`
    WITH input(barcode, name) AS (
      SELECT * FROM unnest(${products.map((p) => p.barcode)}::text[], ${products.map((p) => p.name)}::text[])
    )
    SELECT i.barcode, best.id, best.name, best.slug, best.score
    FROM input i
    LEFT JOIN LATERAL (
      SELECT candidates.id, candidates.name, candidates.slug, candidates.score
      FROM (
        SELECT ing.id, ing.name, ing.slug, similarity(ing.name, i.name) AS score
          FROM "ingredient" ing
         WHERE ing."householdId" IS NULL AND ing.name % i.name
        UNION ALL
        SELECT ing.id, ing.name, ing.slug, similarity(a.alias, i.name) AS score
          FROM "ingredient_alias" a
          JOIN "ingredient" ing ON ing.id = a."ingredientId"
         WHERE ing."householdId" IS NULL AND a.alias % i.name
      ) candidates
      ORDER BY candidates.score DESC
      LIMIT 1
    ) best ON true
  `;

  const result = new Map<string, MatchResult>();
  for (const row of rows) {
    if (row.id === null || row.name === null || row.slug === null || row.score === null) continue;
    result.set(row.barcode, fuzzyResult({ id: row.id, name: row.name, slug: row.slug }, row.score));
  }
  return result;
}

/**
 * One multi-row `INSERT ... ON CONFLICT DO UPDATE` per page, always
 * overwriting — same shape as `import-off.cli.ts`'s `writeBatch`, and for the
 * same reason: this is the OFF mirror's scale, and per-row Prisma calls are
 * not viable here either.
 */
async function writeBindings(
  prisma: PrismaClient,
  householdId: number,
  writes: readonly { barcode: string; ingredientId: number }[],
): Promise<void> {
  const values: unknown[] = [];
  const tuples: string[] = [];

  writes.forEach((write, index) => {
    const base = index * 3;
    tuples.push(`($${base + 1}::int,$${base + 2},$${base + 3}::int)`);
    values.push(householdId, write.barcode, write.ingredientId);
  });

  const sql =
    `INSERT INTO "product_binding" ("householdId","productId","ingredientId") ` +
    `VALUES ${tuples.join(',')} ` +
    `ON CONFLICT ("householdId","productId") DO UPDATE SET ` +
    `"ingredientId"=EXCLUDED."ingredientId"`;

  await prisma.$executeRawUnsafe(sql, ...values);
}

function report(stats: Stats, options: Options): void {
  console.log('');
  console.log(`Products processed: ${stats.productsSeen.toLocaleString()}`);
  console.log('Best match found, by kind:');
  for (const kind of Object.keys(stats.byKind) as MatchKind[]) {
    const count = stats.byKind[kind];
    if (count > 0) console.log(`  ${kind}: ${count.toLocaleString()}`);
  }
  if (stats.belowThreshold > 0) {
    console.log(
      `Fuzzy matches below the ${options.fuzzyThreshold} threshold (not written): ` +
        stats.belowThreshold.toLocaleString(),
    );
  }
  console.log(
    options.dryRun
      ? `Would have written: ${stats.written.toLocaleString()} bindings`
      : `Bindings written:   ${stats.written.toLocaleString()}`,
  );

  if (options.sample > 0) {
    console.log('');
    console.log('Sample matches, for spot-checking:');
    for (const kind of Object.keys(stats.samples) as MatchKind[]) {
      const rows = stats.samples[kind];
      if (rows.length === 0) continue;
      console.log(`  ${kind}:`);
      for (const row of rows) {
        console.log(
          `    ${row.barcode}  "${row.productName}"  ->  "${row.ingredientName}"` +
            (kind === MatchKind.FUZZY ? `  (score ${row.confidence.toFixed(2)})` : ''),
        );
      }
    }
  }
}

function parseArgs(argv: readonly string[]): Options {
  let dryRun = false;
  let fuzzyThreshold = DEFAULT_FUZZY_THRESHOLD;
  let limit: number | null = null;
  let sample = 0;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        dryRun = true;
        break;
      case '--fuzzy-threshold':
        fuzzyThreshold = Number(argv[i + 1]);
        i += 1;
        break;
      case '--limit':
        limit = Number(argv[i + 1]);
        i += 1;
        break;
      case '--sample':
        sample = Number(argv[i + 1]);
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

  if (!Number.isFinite(fuzzyThreshold) || fuzzyThreshold < 0 || fuzzyThreshold > 1) {
    fail('--fuzzy-threshold must be a number between 0 and 1.');
  }
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
    fail('--limit must be a positive number.');
  }
  if (!Number.isFinite(sample) || sample < 0) {
    fail('--sample must be zero or a positive number.');
  }

  return { dryRun, fuzzyThreshold, limit, sample };
}

const USAGE = `Usage: npm run off:match -w packages/backend -- [options]

  --dry-run                  Compute and report matches, write nothing
  --fuzzy-threshold <0-1>    Minimum trigram similarity to write (default: ${DEFAULT_FUZZY_THRESHOLD})
  --limit <n>                Stop after n products, for a quick trial run
  --sample <n>                Print n random example matches per kind, for spot-checking
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
