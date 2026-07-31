-- CreateEnum
CREATE TYPE "Role" AS ENUM ('MEMBER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UnitKind" AS ENUM ('MASS', 'VOLUME', 'COUNT');

-- CreateEnum
CREATE TYPE "TagKind" AS ENUM ('CUISINE', 'MEAL', 'DIET', 'FREE');

-- CreateEnum
CREATE TYPE "TxKind" AS ENUM ('PURCHASE', 'CONSUME', 'ADJUST', 'DISCARD', 'COOK');

-- CreateEnum
CREATE TYPE "MealSlot" AS ENUM ('BREAKFAST', 'LUNCH', 'DINNER', 'SNACK');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('PLANNED', 'COOKED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ListStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ItemSource" AS ENUM ('RECIPE', 'PAR', 'MANUAL');

-- CreateTable
CREATE TABLE "household" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "createdOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "household_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" SERIAL NOT NULL,
    "householdId" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "createdOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledOn" TIMESTAMP(3),
    "deletedOn" TIMESTAMP(3),

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "household_ai_config" (
    "householdId" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "encryptedKey" BYTEA NOT NULL,
    "keyIv" BYTEA NOT NULL,
    "keyAuthTag" BYTEA NOT NULL,
    "keyLastFour" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'claude-opus-5',
    "effort" TEXT NOT NULL DEFAULT 'medium',
    "verifiedOn" TIMESTAMP(3),
    "updatedById" INTEGER NOT NULL,
    "updatedOn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "household_ai_config_pkey" PRIMARY KEY ("householdId")
);

-- CreateTable
CREATE TABLE "unit" (
    "id" SERIAL NOT NULL,
    "householdId" INTEGER,
    "name" TEXT NOT NULL,
    "plural" TEXT NOT NULL,
    "abbrev" TEXT,
    "kind" "UnitKind" NOT NULL,
    "toBaseFactor" DECIMAL(20,10) NOT NULL,

    CONSTRAINT "unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingredient_category" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "ingredient_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingredient" (
    "id" SERIAL NOT NULL,
    "householdId" INTEGER,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "categoryId" INTEGER,
    "defaultUnitId" INTEGER,
    "gramsPerMl" DECIMAL(12,6),
    "gramsPerPiece" DECIMAL(12,4),
    "shelfLifeDays" INTEGER,
    "note" TEXT,

    CONSTRAINT "ingredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingredient_alias" (
    "id" SERIAL NOT NULL,
    "ingredientId" INTEGER NOT NULL,
    "alias" TEXT NOT NULL,
    "slug" TEXT NOT NULL,

    CONSTRAINT "ingredient_alias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe" (
    "id" SERIAL NOT NULL,
    "householdId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "servings" INTEGER NOT NULL,
    "prepMinutes" INTEGER,
    "cookMinutes" INTEGER,
    "sourceUrl" TEXT,
    "sourceNote" TEXT,
    "imagePath" TEXT,
    "notes" TEXT,
    "createdById" INTEGER NOT NULL,
    "createdOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedOn" TIMESTAMP(3) NOT NULL,
    "archivedOn" TIMESTAMP(3),

    CONSTRAINT "recipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_ingredient" (
    "id" SERIAL NOT NULL,
    "recipeId" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "ingredientId" INTEGER,
    "rawText" TEXT NOT NULL,
    "quantity" DECIMAL(12,4),
    "unitId" INTEGER,
    "preparation" TEXT,
    "groupLabel" TEXT,
    "optional" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "recipe_ingredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_step" (
    "id" SERIAL NOT NULL,
    "recipeId" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "recipe_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tag" (
    "id" SERIAL NOT NULL,
    "householdId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" "TagKind" NOT NULL DEFAULT 'FREE',

    CONSTRAINT "tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_tag" (
    "recipeId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,

    CONSTRAINT "recipe_tag_pkey" PRIMARY KEY ("recipeId","tagId")
);

-- CreateTable
CREATE TABLE "storage_location" (
    "id" SERIAL NOT NULL,
    "householdId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "storage_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pantry_item" (
    "id" SERIAL NOT NULL,
    "householdId" INTEGER NOT NULL,
    "ingredientId" INTEGER NOT NULL,
    "locationId" INTEGER NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL,
    "unitId" INTEGER NOT NULL,
    "brand" TEXT,
    "openedOn" TIMESTAMP(3),
    "expiresOn" TIMESTAMP(3),
    "note" TEXT,
    "createdOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pantry_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pantry_par" (
    "id" SERIAL NOT NULL,
    "householdId" INTEGER NOT NULL,
    "ingredientId" INTEGER NOT NULL,
    "minQuantity" DECIMAL(12,4) NOT NULL,
    "unitId" INTEGER NOT NULL,

    CONSTRAINT "pantry_par_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pantry_transaction" (
    "id" SERIAL NOT NULL,
    "householdId" INTEGER NOT NULL,
    "pantryItemId" INTEGER,
    "ingredientId" INTEGER NOT NULL,
    "delta" DECIMAL(12,4) NOT NULL,
    "unitId" INTEGER NOT NULL,
    "kind" "TxKind" NOT NULL,
    "cookSessionId" INTEGER,
    "note" TEXT,
    "createdById" INTEGER NOT NULL,
    "createdOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pantry_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planned_meal" (
    "id" SERIAL NOT NULL,
    "householdId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "slot" "MealSlot" NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "recipeId" INTEGER,
    "note" TEXT,
    "servings" INTEGER NOT NULL DEFAULT 1,
    "status" "PlanStatus" NOT NULL DEFAULT 'PLANNED',
    "createdById" INTEGER NOT NULL,
    "createdOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "planned_meal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cook_session" (
    "id" SERIAL NOT NULL,
    "householdId" INTEGER NOT NULL,
    "plannedMealId" INTEGER,
    "recipeId" INTEGER NOT NULL,
    "servings" INTEGER NOT NULL,
    "cookedOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "cook_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store" (
    "id" SERIAL NOT NULL,
    "householdId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,

    CONSTRAINT "store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_aisle" (
    "id" SERIAL NOT NULL,
    "storeId" INTEGER NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "store_aisle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopping_list" (
    "id" SERIAL NOT NULL,
    "householdId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "storeId" INTEGER,
    "status" "ListStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedOn" TIMESTAMP(3),

    CONSTRAINT "shopping_list_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopping_list_item" (
    "id" SERIAL NOT NULL,
    "listId" INTEGER NOT NULL,
    "ingredientId" INTEGER,
    "rawName" TEXT,
    "quantity" DECIMAL(12,4),
    "unitId" INTEGER,
    "source" "ItemSource" NOT NULL DEFAULT 'MANUAL',
    "sourcePlannedMealId" INTEGER,
    "storeId" INTEGER,
    "brand" TEXT,
    "estimatedPrice" DECIMAL(10,2),
    "actualPrice" DECIMAL(10,2),
    "unconvertible" BOOLEAN NOT NULL DEFAULT false,
    "checkedOn" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "shopping_list_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_observation" (
    "id" SERIAL NOT NULL,
    "householdId" INTEGER NOT NULL,
    "ingredientId" INTEGER NOT NULL,
    "storeId" INTEGER,
    "brand" TEXT,
    "quantity" DECIMAL(12,4) NOT NULL,
    "unitId" INTEGER NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "observedOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_observation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE INDEX "app_user_householdId_idx" ON "app_user"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "unit_householdId_name_key" ON "unit"("householdId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ingredient_category_name_key" ON "ingredient_category"("name");

-- CreateIndex
CREATE INDEX "ingredient_categoryId_idx" ON "ingredient"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ingredient_householdId_slug_key" ON "ingredient"("householdId", "slug");

-- CreateIndex
CREATE INDEX "ingredient_alias_slug_idx" ON "ingredient_alias"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "ingredient_alias_ingredientId_slug_key" ON "ingredient_alias"("ingredientId", "slug");

-- CreateIndex
CREATE INDEX "recipe_householdId_archivedOn_idx" ON "recipe"("householdId", "archivedOn");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_householdId_slug_key" ON "recipe"("householdId", "slug");

-- CreateIndex
CREATE INDEX "recipe_ingredient_recipeId_sortOrder_idx" ON "recipe_ingredient"("recipeId", "sortOrder");

-- CreateIndex
CREATE INDEX "recipe_ingredient_ingredientId_idx" ON "recipe_ingredient"("ingredientId");

-- CreateIndex
CREATE INDEX "recipe_step_recipeId_sortOrder_idx" ON "recipe_step"("recipeId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "tag_householdId_slug_key" ON "tag"("householdId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "storage_location_householdId_name_key" ON "storage_location"("householdId", "name");

-- CreateIndex
CREATE INDEX "pantry_item_householdId_ingredientId_idx" ON "pantry_item"("householdId", "ingredientId");

-- CreateIndex
CREATE INDEX "pantry_item_householdId_expiresOn_idx" ON "pantry_item"("householdId", "expiresOn");

-- CreateIndex
CREATE UNIQUE INDEX "pantry_par_householdId_ingredientId_key" ON "pantry_par"("householdId", "ingredientId");

-- CreateIndex
CREATE INDEX "pantry_transaction_householdId_ingredientId_createdOn_idx" ON "pantry_transaction"("householdId", "ingredientId", "createdOn");

-- CreateIndex
CREATE INDEX "pantry_transaction_cookSessionId_idx" ON "pantry_transaction"("cookSessionId");

-- CreateIndex
CREATE INDEX "planned_meal_householdId_date_idx" ON "planned_meal"("householdId", "date");

-- CreateIndex
CREATE INDEX "cook_session_householdId_cookedOn_idx" ON "cook_session"("householdId", "cookedOn");

-- CreateIndex
CREATE UNIQUE INDEX "store_householdId_name_key" ON "store"("householdId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "store_aisle_storeId_categoryId_key" ON "store_aisle"("storeId", "categoryId");

-- CreateIndex
CREATE INDEX "shopping_list_householdId_status_idx" ON "shopping_list"("householdId", "status");

-- CreateIndex
CREATE INDEX "shopping_list_item_listId_idx" ON "shopping_list_item"("listId");

-- CreateIndex
CREATE INDEX "price_observation_householdId_ingredientId_observedOn_idx" ON "price_observation"("householdId", "ingredientId", "observedOn");

-- AddForeignKey
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "household_ai_config" ADD CONSTRAINT "household_ai_config_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "household_ai_config" ADD CONSTRAINT "household_ai_config_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit" ADD CONSTRAINT "unit_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredient" ADD CONSTRAINT "ingredient_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredient" ADD CONSTRAINT "ingredient_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ingredient_category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredient" ADD CONSTRAINT "ingredient_defaultUnitId_fkey" FOREIGN KEY ("defaultUnitId") REFERENCES "unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredient_alias" ADD CONSTRAINT "ingredient_alias_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe" ADD CONSTRAINT "recipe_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe" ADD CONSTRAINT "recipe_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_ingredient" ADD CONSTRAINT "recipe_ingredient_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_ingredient" ADD CONSTRAINT "recipe_ingredient_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_ingredient" ADD CONSTRAINT "recipe_ingredient_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_step" ADD CONSTRAINT "recipe_step_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag" ADD CONSTRAINT "tag_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_tag" ADD CONSTRAINT "recipe_tag_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_tag" ADD CONSTRAINT "recipe_tag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_location" ADD CONSTRAINT "storage_location_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pantry_item" ADD CONSTRAINT "pantry_item_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pantry_item" ADD CONSTRAINT "pantry_item_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pantry_item" ADD CONSTRAINT "pantry_item_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "storage_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pantry_item" ADD CONSTRAINT "pantry_item_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pantry_par" ADD CONSTRAINT "pantry_par_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pantry_par" ADD CONSTRAINT "pantry_par_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pantry_par" ADD CONSTRAINT "pantry_par_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pantry_transaction" ADD CONSTRAINT "pantry_transaction_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pantry_transaction" ADD CONSTRAINT "pantry_transaction_pantryItemId_fkey" FOREIGN KEY ("pantryItemId") REFERENCES "pantry_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pantry_transaction" ADD CONSTRAINT "pantry_transaction_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pantry_transaction" ADD CONSTRAINT "pantry_transaction_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pantry_transaction" ADD CONSTRAINT "pantry_transaction_cookSessionId_fkey" FOREIGN KEY ("cookSessionId") REFERENCES "cook_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pantry_transaction" ADD CONSTRAINT "pantry_transaction_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planned_meal" ADD CONSTRAINT "planned_meal_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planned_meal" ADD CONSTRAINT "planned_meal_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "recipe"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planned_meal" ADD CONSTRAINT "planned_meal_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cook_session" ADD CONSTRAINT "cook_session_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cook_session" ADD CONSTRAINT "cook_session_plannedMealId_fkey" FOREIGN KEY ("plannedMealId") REFERENCES "planned_meal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cook_session" ADD CONSTRAINT "cook_session_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "recipe"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store" ADD CONSTRAINT "store_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_aisle" ADD CONSTRAINT "store_aisle_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_aisle" ADD CONSTRAINT "store_aisle_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ingredient_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopping_list" ADD CONSTRAINT "shopping_list_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopping_list" ADD CONSTRAINT "shopping_list_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopping_list_item" ADD CONSTRAINT "shopping_list_item_listId_fkey" FOREIGN KEY ("listId") REFERENCES "shopping_list"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopping_list_item" ADD CONSTRAINT "shopping_list_item_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopping_list_item" ADD CONSTRAINT "shopping_list_item_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopping_list_item" ADD CONSTRAINT "shopping_list_item_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
