/**
 * Enums shared by the backend (Prisma) and the frontend.
 *
 * These are declared as plain const objects rather than TypeScript `enum`s so the
 * literal string values match Prisma's generated enums exactly and survive JSON
 * round-trips without a conversion layer.
 */

export const Role = {
  MEMBER: 'MEMBER',
  ADMIN: 'ADMIN',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

/**
 * The physical dimension a unit measures. Conversion within a kind is pure
 * arithmetic; conversion across kinds needs per-ingredient physical data
 * (density or piece weight) — see `units.ts`.
 */
export const UnitKind = {
  MASS: 'MASS',
  VOLUME: 'VOLUME',
  COUNT: 'COUNT',
} as const;
export type UnitKind = (typeof UnitKind)[keyof typeof UnitKind];

export const TagKind = {
  CUISINE: 'CUISINE',
  MEAL: 'MEAL',
  DIET: 'DIET',
  FREE: 'FREE',
} as const;
export type TagKind = (typeof TagKind)[keyof typeof TagKind];

/** Movement kinds in the append-only pantry ledger. */
export const TxKind = {
  PURCHASE: 'PURCHASE',
  CONSUME: 'CONSUME',
  ADJUST: 'ADJUST',
  DISCARD: 'DISCARD',
  COOK: 'COOK',
} as const;
export type TxKind = (typeof TxKind)[keyof typeof TxKind];

export const MealSlot = {
  BREAKFAST: 'BREAKFAST',
  LUNCH: 'LUNCH',
  DINNER: 'DINNER',
  SNACK: 'SNACK',
} as const;
export type MealSlot = (typeof MealSlot)[keyof typeof MealSlot];

export const PlanStatus = {
  PLANNED: 'PLANNED',
  COOKED: 'COOKED',
  SKIPPED: 'SKIPPED',
} as const;
export type PlanStatus = (typeof PlanStatus)[keyof typeof PlanStatus];

export const ListStatus = {
  ACTIVE: 'ACTIVE',
  COMPLETED: 'COMPLETED',
  ARCHIVED: 'ARCHIVED',
} as const;
export type ListStatus = (typeof ListStatus)[keyof typeof ListStatus];

/** Why a line ended up on a shopping list. */
export const ItemSource = {
  RECIPE: 'RECIPE',
  PAR: 'PAR',
  MANUAL: 'MANUAL',
} as const;
export type ItemSource = (typeof ItemSource)[keyof typeof ItemSource];
