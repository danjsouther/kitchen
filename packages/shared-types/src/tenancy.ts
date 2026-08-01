/**
 * The reserved household that owns the global catalog (seeded units and
 * ingredients) and the OFF auto-match product bindings. Never assigned to a
 * real user's household — `Household.id` is a Postgres identity sequence
 * starting at 1, so this value is never produced by registration.
 */
export const SYSTEM_HOUSEHOLD_ID = 0;
