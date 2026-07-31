-- Postgres treats NULLs as distinct in a unique index, so the schema-level
-- @@unique([householdId, name]) does NOT prevent duplicate GLOBAL catalog rows
-- (those with household_id IS NULL). Without these partial indexes, re-running
-- the seed loader or two concurrent writers could create a second "gram" unit or
-- a second "all-purpose flour", and every conversion lookup would then depend on
-- which row it happened to find.
--
-- These enforce uniqueness for the global rows specifically. The household-scoped
-- rows are already covered by the composite unique constraints, which behave
-- normally because household_id is NOT NULL there.

CREATE UNIQUE INDEX "unit_global_name_key"
  ON "unit" ("name")
  WHERE "householdId" IS NULL;

CREATE UNIQUE INDEX "ingredient_global_slug_key"
  ON "ingredient" ("slug")
  WHERE "householdId" IS NULL;
