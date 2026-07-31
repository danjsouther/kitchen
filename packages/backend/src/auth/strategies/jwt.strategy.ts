import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { setHouseholdContext } from '../../common/household-context';
import { AuthService } from '../auth.service';
import { SESSION_COOKIE } from '../auth.constants';
import type { AuthenticatedUser, JwtPayload } from '../types';

/**
 * Reads the session token from the httpOnly cookie.
 *
 * The token is not accepted from an Authorization header: this is a browser app,
 * and a cookie the page's JavaScript cannot read is a materially better place for
 * a session than anywhere script-accessible.
 */
function fromSessionCookie(req: Request): string | null {
  const cookies = req.cookies as Record<string, string> | undefined;
  return cookies?.[SESSION_COOKIE] ?? null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly auth: AuthService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([fromSessionCookie]),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET!,
    });
  }

  /**
   * Establishes the tenancy context for the rest of the request.
   *
   * This is the single point where a request stops being anonymous, which makes
   * it the right place to record whose data the request may touch. The household
   * comes from the freshly re-read user rather than from the token, so a token
   * carrying a stale household cannot widen access.
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user = await this.auth.resolveTokenUser(payload);
    if (!user) {
      throw new UnauthorizedException('Session is no longer valid.');
    }

    setHouseholdContext({
      householdId: user.householdId,
      userId: user.id,
      role: user.role,
    });

    return user;
  }
}
