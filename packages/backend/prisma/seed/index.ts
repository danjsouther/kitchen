/**
 * Seeds the global catalog: units, ingredient categories, and the ingredient
 * catalog with the density and piece-weight data the conversion engine needs.
 *
 * Idempotent — safe to re-run. Existing rows are updated in place rather than
 * duplicated, so editing the JSON and re-running is the normal workflow.
 *
 * Global rows are those with householdId = null. Note that Postgres treats NULLs
 * as distinct in a unique index, so `@@unique([householdId, name])` does NOT stop
 * duplicate global rows on its own — migration `add_global_catalog_unique_indexes`
 * adds partial unique indexes for that, and this loader matches on
 * `householdId: null` explicitly rather than relying on upsert.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { slugify } from '@recipes/shared-types';
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

function readSeed<T>(file: string): T[] {
  const path = join(__dirname, 'data', file);
  return JSON.parse(readFileSync(path, 'utf8')) as T[];
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — copy .env.example to .env first.');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg(connectionString) });

  try {
    const counts = { units: 0, categories: 0, ingredients: 0, aliases: 0 };

    // ---- Units -------------------------------------------------------------
    for (const unit of readSeed<UnitSeed>('units.json')) {
      const existing = await prisma.unit.findFirst({
        where: { householdId: null, name: unit.name },
        select: { id: true },
      });

      if (existing) {
        await prisma.unit.update({ where: { id: existing.id }, data: unit });
      } else {
        await prisma.unit.create({ data: { ...unit, householdId: null } });
      }
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
          where: { householdId: null },
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

      const existing = await prisma.ingredient.findFirst({
        where: { householdId: null, slug },
        select: { id: true },
      });

      const saved = existing
        ? await prisma.ingredient.update({ where: { id: existing.id }, data })
        : await prisma.ingredient.create({ data: { ...data, householdId: null } });
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
