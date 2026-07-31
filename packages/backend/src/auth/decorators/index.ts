import { SetMetadata, createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Role } from '@recipes/shared-types';

import { IS_PUBLIC_KEY, ROLES_KEY } from '../auth.constants';
import type { AuthenticatedUser } from '../types';

/**
 * Marks a route as reachable without a session.
 *
 * Authentication is on by default via a global guard, so forgetting this
 * decorator makes a route inaccessible — a loud, immediate failure. Forgetting
 * the opposite (a guard on a route that needed one) would fail silently, which
 * is why the default runs this way round.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Restricts a route to the given roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Injects the authenticated user, or one of its properties. */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) return undefined;
    return field ? user[field] : user;
  },
);
