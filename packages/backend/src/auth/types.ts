import type { Role } from '@kitchen/shared-types';

/** The JWT payload. Kept small — it is re-sent on every request. */
export interface JwtPayload {
  /** User id. */
  sub: number;
  /** Household id, so tenancy does not need a database round trip per request. */
  hid: number;
  role: Role;
}

/** What the JWT strategy puts on `req.user`. */
export interface AuthenticatedUser {
  id: number;
  householdId: number;
  role: Role;
  email: string;
  displayName: string;
}
