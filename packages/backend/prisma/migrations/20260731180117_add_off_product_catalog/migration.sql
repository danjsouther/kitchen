-- The two `DROP INDEX` statements `prisma migrate dev` generated here have been
-- removed by hand, and must stay removed.
--
-- `ingredient_name_trgm_idx` and `ingredient_alias_alias_trgm_idx` are the GIN
-- trigram indexes created by `add_pg_trgm`. They exist only in raw SQL, because
-- Prisma cannot express `gin_trgm_ops`, so every later `migrate dev` sees them
-- as drift and proposes dropping them. Letting it do so does not fail anything:
-- the parser's similarity() fallback keeps working and simply degrades to a
-- sequential scan with a similarity computation per row.
--
-- If a future migration reintroduces them, delete the drops again.

-- AlterTable
ALTER TABLE "pantry_item" ADD COLUMN     "productId" TEXT;

-- AlterTable
ALTER TABLE "price_observation" ADD COLUMN     "productId" TEXT;

-- AlterTable
ALTER TABLE "shopping_list_item" ADD COLUMN     "productId" TEXT;

-- CreateTable
CREATE TABLE "product" (
    "barcode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brands" TEXT,
    "quantityRaw" TEXT,
    "packQuantity" DECIMAL(12,4),
    "packUnitId" INTEGER,
    "categoriesTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "countriesTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "imageSmallUrl" TEXT,
    "nutriments" JSONB NOT NULL DEFAULT '{}',
    "nutriscoreGrade" TEXT,
    "importedOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_pkey" PRIMARY KEY ("barcode")
);

-- CreateTable
CREATE TABLE "product_binding" (
    "id" SERIAL NOT NULL,
    "householdId" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "ingredientId" INTEGER NOT NULL,

    CONSTRAINT "product_binding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_name_idx" ON "product"("name");

-- CreateIndex
CREATE INDEX "product_binding_householdId_ingredientId_idx" ON "product_binding"("householdId", "ingredientId");

-- CreateIndex
CREATE UNIQUE INDEX "product_binding_householdId_productId_key" ON "product_binding"("householdId", "productId");

-- CreateIndex
CREATE INDEX "price_observation_householdId_productId_observedOn_idx" ON "price_observation"("householdId", "productId", "observedOn");

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_packUnitId_fkey" FOREIGN KEY ("packUnitId") REFERENCES "unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_binding" ADD CONSTRAINT "product_binding_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_binding" ADD CONSTRAINT "product_binding_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("barcode") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_binding" ADD CONSTRAINT "product_binding_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pantry_item" ADD CONSTRAINT "pantry_item_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("barcode") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopping_list_item" ADD CONSTRAINT "shopping_list_item_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("barcode") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("barcode") ON DELETE SET NULL ON UPDATE CASCADE;
