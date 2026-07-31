import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@recipes/shared-types';

import { ROLES_KEY } from '../auth.constants';
import type { AuthenticatedUser } from '../types';

/**
 * Enforces `@Roles(...)`. Routes without the decorator are open to any
 * authenticated member of the household — the JWT guard has already run.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;

    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException(
        'This action is restricted to household administrators.',
      );
    }

    return true;
  }
}
