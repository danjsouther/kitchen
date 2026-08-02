/**
 * The reserved household that owns the global catalog (seeded units and
 * ingredients) and the OFF auto-match product bindings. Never assigned to a
 * real user's household — `Household.id` is a Postgres identity sequence
 * starting at 1, so this value is never produced by registration.
 */
export const SYSTEM_HOUSEHOLD_ID = 0;

/**
 * The reserved household that owns immutable recipe-lineage snapshots — the
 * frozen content of a private recipe at the moment it was published, kept so
 * a published recipe's `parentHash` always resolves to something permanent
 * even after the household that published it edits their copy further. Never
 * assigned to a real user's household, and never surfaced through any read
 * path a household or the frontend can reach.
 */
export const ARCHIVE_HOUSEHOLD_ID = -1;
