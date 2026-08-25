-- A recipe can suit more than one meal (breakfast and brunch, say), so
-- recipeType becomes a list. Existing single values are preserved by
-- wrapping each one in a one-element array rather than dropping the column.

-- AlterTable
ALTER TABLE "recipe" ALTER COLUMN "recipeType" DROP DEFAULT;
ALTER TABLE "recipe" ALTER COLUMN "recipeType" TYPE "RecipeType"[] USING ARRAY["recipeType"];
ALTER TABLE "recipe" ALTER COLUMN "recipeType" SET DEFAULT ARRAY['ANY']::"RecipeType"[];
