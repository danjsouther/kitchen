-- GIN trigram indexes so product name/brand search stays indexable at OFF
-- catalog size (~1M rows). Without them, `ILIKE '%term%'` sequential-scans.
--
-- Prisma cannot express `gin_trgm_ops`, so every later `migrate dev` will see
-- these as drift and propose `DROP INDEX` for `product_name_trgm_idx` and
-- `product_brands_trgm_idx` (same story as `ingredient_name_trgm_idx`). Delete
-- those drops from the generated SQL every time. Letting them through does not
-- fail anything loudly — name search still returns answers, just via a
-- sequential scan.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS product_name_trgm_idx
  ON "product" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS product_brands_trgm_idx
  ON "product" USING gin ("brands" gin_trgm_ops);
