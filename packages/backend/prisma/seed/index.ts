/**
 * Seeds the reserved system household, then the global catalog it owns: units,
 * ingredient categories, and the ingredient catalog with the density and
 * piece-weight data the conversion engine needs.
 *
 * Idempotent — safe to re-run. Existing rows are updated in place rather than
 * duplicated, so editing the JSON and re-running is the normal workflow.
 *
 * Global rows carry householdId = SYSTEM_HOUSEHOLD_ID. That column is a real,
 * required value now, so the composite unique constraints
 * (`@@unique([householdId, name])`, `@@unique([householdId, slug])`) constrain
 * global rows the same way they constrain a household's own — no partial index
 * workaround needed, and this loader can use a plain `upsert`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { ARCHIVE_HOUSEHOLD_ID, SYSTEM_HOUSEHOLD_ID, slugify } from '@kitchen/shared-types';
import { config as loadEnv } from 'dotenv';

import { PrismaClient } from '../../generated/prisma/client';

// Read the repo-root .env, the same file docker-compose mounts and prisma.config.ts
// loads, so `npm run seed` works without the caller exporting anything first.
const rootEnv = resolve(__dirname, '../../../../.env');
if (existsSync(rootEnv)) loadEnv({ path: rootEnv, quiet: true });

interface UnitSeed {
  name: string;
  plural: string;
  abbrev: string | null;
  kind: 'MASS' | 'VOLUME' | 'COUNT';
  toBaseFactor: string;
}

interface CategorySeed {
  name: string;
  sortOrder: number;
}

interface IngredientSeed {
  name: string;
  category: string;
  defaultUnit?: string;
  gramsPerMl?: string;
  gramsPerPiece?: string;
  shelfLifeDays?: number;
  note?: string;
  aliases?: string[];
}

/**
 * Where the seed JSON lives, which differs depending on how this file is run.
 *
 * Run from source (`npm run seed` via tsx) __dirname is prisma/seed, and the
 * data sits right alongside. Run compiled (`node dist/prisma/seed/index.js`,
 * which is what the container does — tsx is pruned from the production image)
 * __dirname is dist/prisma/seed, and there is no data directory there at all:
 * tsc compiles .ts and does not copy .json that is read through fs at runtime.
 *
 * Resolved once, with a clear error rather than a bare ENOENT, because the
 * failure mode this had was silent: seeding is non-fatal on boot by design, so
 * a missing catalog surfaced much later as conversions that looked broken.
 */
const SEED_DATA_DIR = (() => {
  const candidates = [
    join(__dirname, 'data'),
    // From dist/prisma/seed back to the source tree, which the image ships.
    resolve(__dirname, '../../../prisma/seed/data'),
  ];

  const found = candidates.find((dir) => existsSync(join(dir, 'units.json')));
  if (!found) {
    throw new Error(
      `Seed data not found. Looked in:\n  ${candidates.join('\n  ')}`,
    );
  }
  return found;
})();

function readSeed<T>(file: string): T[] {
  return JSON.parse(readFileSync(join(SEED_DATA_DIR, file), 'utf8')) as T[];
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — copy .env.example to .env first.');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg(connectionString) });

  try {
    const counts = { units: 0, categories: 0, ingredients: 0, aliases: 0 };

    // ---- System household ---------------------------------------------------
    // Every catalog row below has a required FK to household(id), so this must
    // exist before any of them are written.
    await prisma.household.upsert({
      where: { id: SYSTEM_HOUSEHOLD_ID },
      update: {},
      create: { id: SYSTEM_HOUSEHOLD_ID, name: 'System' },
    });

    // ---- Archive household ---------------------------------------------------
    // Owns immutable recipe-lineage snapshots (see RecipesService.publish).
    // Same reasoning as System: the FK must exist before anything references it.
    await prisma.household.upsert({
      where: { id: ARCHIVE_HOUSEHOLD_ID },
      update: {},
      create: { id: ARCHIVE_HOUSEHOLD_ID, name: 'Archive' },
    });

    // ---- Units -------------------------------------------------------------
    for (const unit of readSeed<UnitSeed>('units.json')) {
      await prisma.unit.upsert({
        where: { householdId_name: { householdId: SYSTEM_HOUSEHOLD_ID, name: unit.name } },
        update: unit,
        create: { ...unit, householdId: SYSTEM_HOUSEHOLD_ID },
      });
      counts.units += 1;
    }

    // ---- Categories --------------------------------------------------------
    for (const category of readSeed<CategorySeed>('categories.json')) {
      await prisma.ingredientCategory.upsert({
        where: { name: category.name },
        update: { sortOrder: category.sortOrder },
        create: category,
      });
      counts.categories += 1;
    }

    // Resolve the lookups the ingredient loader needs, once.
    const categoryIds = new Map(
      (await prisma.ingredientCategory.findMany({ select: { id: true, name: true } })).map(
        (row) => [row.name, row.id],
      ),
    );
    const unitIds = new Map(
      (
        await prisma.unit.findMany({
          where: { householdId: SYSTEM_HOUSEHOLD_ID },
          select: { id: true, name: true },
        })
      ).map((row) => [row.name, row.id]),
    );

    // ---- Ingredients -------------------------------------------------------
    for (const ingredient of readSeed<IngredientSeed>('ingredients.json')) {
      const categoryId = categoryIds.get(ingredient.category);
      if (!categoryId) {
        throw new Error(
          `Ingredient "${ingredient.name}" names unknown category "${ingredient.category}".`,
        );
      }

      let defaultUnitId: number | null = null;
      if (ingredient.defaultUnit) {
        const unitId = unitIds.get(ingredient.defaultUnit);
        if (!unitId) {
          throw new Error(
            `Ingredient "${ingredient.name}" names unknown unit "${ingredient.defaultUnit}".`,
          );
        }
        defaultUnitId = unitId;
      }

      const slug = slugify(ingredient.name);
      const data = {
        name: ingredient.name,
        slug,
        categoryId,
        defaultUnitId,
        gramsPerMl: ingredient.gramsPerMl ?? null,
        gramsPerPiece: ingredient.gramsPerPiece ?? null,
        shelfLifeDays: ingredient.shelfLifeDays ?? null,
        note: ingredient.note ?? null,
      };

      const saved = await prisma.ingredient.upsert({
        where: { householdId_slug: { householdId: SYSTEM_HOUSEHOLD_ID, slug } },
        update: data,
        create: { ...data, householdId: SYSTEM_HOUSEHOLD_ID },
      });
      counts.ingredients += 1;

      // ---- Aliases ---------------------------------------------------------
      for (const alias of ingredient.aliases ?? []) {
        const aliasSlug = slugify(alias);
        if (!aliasSlug || aliasSlug === slug) continue;

        await prisma.ingredientAlias.upsert({
          where: {
            ingredientId_slug: { ingredientId: saved.id, slug: aliasSlug },
          },
          update: { alias },
          create: { ingredientId: saved.id, alias, slug: aliasSlug },
        });
        counts.aliases += 1;
      }
    }

    console.log(
      `Seeded ${counts.units} units, ${counts.categories} categories, ` +
        `${counts.ingredients} ingredients, ${counts.aliases} aliases.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
