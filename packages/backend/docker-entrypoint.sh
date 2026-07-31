#!/bin/sh
# Runs before the API starts, every boot.
set -e

# `migrate deploy` only applies committed migrations — it never generates one
# and never resets, so it is safe to run unattended against real data. This is
# deliberately fatal: starting an API against a schema it does not match
# produces confusing runtime errors rather than an obvious failure.
echo "Applying database migrations..."
npx prisma migrate deploy

# The seeded catalog (units, categories, ingredients, aliases) is idempotent and
# a no-op when unchanged, so re-running it on every boot is fine and keeps a
# long-lived deployment current with the committed seed data.
#
# Non-fatal, unlike migrations: a catalog hiccup should not stop the API from
# serving a household's own recipes and pantry.
echo "Seeding the ingredient catalog..."
node dist/prisma/seed/index.js || echo "WARNING: catalog seeding failed; continuing startup."

exec "$@"
