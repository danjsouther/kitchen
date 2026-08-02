-- Recipe sharing: SYSTEM_HOUSEHOLD_ID (0) owns published recipes, following
-- the same reserved-household convention Unit/Ingredient already use.
-- ARCHIVE_HOUSEHOLD_ID (-1) owns immutable lineage snapshots. Both are seeded
-- as real Household rows before any recipe references them (see seed/index.ts).
--
-- hash/parentHash carry lineage: hash is a content hash recomputed on every
-- write, parentHash records what a row was forked or republished from.

-- AlterTable
ALTER TABLE "recipe"
  ADD COLUMN "parentHash" TEXT,
  ADD COLUMN "hash" TEXT NOT NULL DEFAULT '',
  ALTER COLUMN "householdId" SET DEFAULT 0;

-- Backfill existing rows with a distinguishing placeholder hash so the NOT
-- NULL column and the new unique index below are satisfiable. Every
-- create/update recomputes hash for real (see RecipesService), so this
-- placeholder self-corrects the next time each recipe is saved.
UPDATE "recipe"
SET "hash" = encode(sha256(('placeholder:' || "id"::text || ':' || "updatedOn"::text)::bytea), 'hex');

-- The temporary default above was only needed to add the column against
-- existing rows; every write sets hash explicitly from here on.
ALTER TABLE "recipe" ALTER COLUMN "hash" DROP DEFAULT;

-- DropIndex
DROP INDEX "recipe_householdId_slug_key";

-- CreateIndex
CREATE UNIQUE INDEX "recipe_householdId_slug_hash_key" ON "recipe"("householdId", "slug", "hash");
