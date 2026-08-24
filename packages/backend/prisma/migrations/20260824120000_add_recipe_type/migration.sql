-- What meal a recipe suits. Distinct from MealSlot (a calendar time-of-day):
-- DESSERT is a course, not a slot to plan a whole day around, and ANY is a
-- real "no restriction" value here rather than an absence.

CREATE TYPE "RecipeType" AS ENUM ('BREAKFAST', 'LUNCH', 'DINNER', 'DESSERT', 'SNACK', 'ANY');

-- AlterTable
ALTER TABLE "recipe" ADD COLUMN     "recipeType" "RecipeType" NOT NULL DEFAULT 'ANY';
