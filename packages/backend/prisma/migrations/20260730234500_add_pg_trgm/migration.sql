-- Trigram similarity, used by the paste-and-parse matcher as its last resort.
--
-- Exact and singularised slug lookups resolve most lines; this catches the rest
-- ("corriander" -> cilantro's alias, "tomatoe" -> tomato). Without it a typo
-- means the reviewer retypes the whole line instead of accepting a suggestion.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN indexes make similarity() searches usable at catalog size rather than
-- forcing a sequential scan with a similarity computation per row.
CREATE INDEX IF NOT EXISTS ingredient_name_trgm_idx
  ON "ingredient" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS ingredient_alias_alias_trgm_idx
  ON "ingredient_alias" USING gin ("alias" gin_trgm_ops);
