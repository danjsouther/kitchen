/**
 * Per-request household context.
 *
 * Tenancy is enforced by a Prisma client extension (see prisma/tenancy.ts) that
 * reads the current household from here at query time. AsyncLocalStorage is used
 * rather than NestJS request-scoped providers because request scope is viral —
 * every service that touched Prisma would become request-scoped too — and because
 * it keeps the enforcement out of individual service signatures, where it could be
 * forgotten.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { Role } from '@recipes/shared-types';

export interface HouseholdContext {
  householdId: number;
  userId: number;
  role: Role;
}

interface Store {
  context: HouseholdContext | null;
  /** True inside runUnscoped — tenancy filters are deliberately not applied. */
  unscoped: boolean;
}

const storage = new AsyncLocalStorage<Store>();

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

/**
 * Runs `fn` inside `store`, making sure lazy thenables start within the scope.
 *
 * Prisma's query builders return a *lazy* PrismaPromise: calling
 * `db.recipe.findMany()` builds a promise but does not execute anything until
 * something calls `.then()` on it. Without the `Promise.resolve` below,
 * `run(store, () => db.recipe.findMany())` would return that unstarted promise,
 * the AsyncLocalStorage scope would close, and the query would then execute
 * *outside* any household context — failing closed at best, and silently
 * unscoped at worst. Resolving here forces `.then()` to be called while the
 * scope is still open.
 */
function runInScope<T>(store: Store, fn: () => T): T {
  return storage.run(store, () => {
    const result = fn();
    return (isThenable(result) ? Promise.resolve(result) : result) as T;
  });
}

/** Runs `fn` with the given household as the active tenant. */
export function runWithHousehold<T>(context: HouseholdContext, fn: () => T): T {
  return runInScope({ context, unscoped: false }, fn);
}

/**
 * Opens an empty context for the whole request, to be filled in once the request
 * is authenticated.
 *
 * This exists because of ordering: the store has to be established before the
 * auth guard runs (so it covers the entire request), but the household is not
 * known until after it runs. A middleware opens the scope here, and the JWT
 * strategy calls `setHouseholdContext` from inside it. Until that happens the
 * context is null and any query against a scoped model fails closed.
 */
export function runWithEmptyContext<T>(fn: () => T): T {
  return storage.run({ context: null, unscoped: false }, fn);
}

/** Fills in the household for the current request. Called once, after auth. */
export function setHouseholdContext(context: HouseholdContext): void {
  const store = storage.getStore();
  if (!store) {
    throw new Error(
      'setHouseholdContext called outside a request scope — is ' +
        'HouseholdContextMiddleware registered?',
    );
  }
  store.context = context;
}

/**
 * Runs `fn` with tenancy filtering switched off.
 *
 * This is the deliberate escape hatch for the handful of operations that cannot be
 * household-scoped: authenticating a user by email before we know their household,
 * registration, and startup tasks. Every call site should be obvious and rare —
 * if you find yourself reaching for it inside feature code, the query is probably
 * missing a scope rather than needing an exemption.
 */
export function runUnscoped<T>(fn: () => T): T {
  return runInScope({ context: null, unscoped: true }, fn);
}

/** The active household context, or null outside a request. */
export function getHouseholdContext(): HouseholdContext | null {
  return storage.getStore()?.context ?? null;
}

/** True when the current execution deliberately opted out of tenancy filtering. */
export function isUnscoped(): boolean {
  return storage.getStore()?.unscoped ?? false;
}

/**
 * The active household id, throwing if there isn't one.
 *
 * Failing closed is the point: a query that reaches the database with no tenant
 * context and no explicit exemption is a bug that would return or modify another
 * household's rows, so it must not be allowed to proceed quietly.
 */
export function requireHouseholdId(): number {
  const context = getHouseholdContext();
  if (!context) {
    throw new Error(
      'No household context for this operation. Requests must run inside ' +
        'runWithHousehold(); deliberately unscoped work must use runUnscoped().',
    );
  }
  return context.householdId;
}
