import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import { Role } from '@recipes/shared-types';

import { runUnscoped } from '../common/household-context';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser, JwtPayload } from './types';

/**
 * Authentication uses the RAW Prisma client, deliberately.
 *
 * Looking a user up by email happens before we know which household they belong
 * to, so it is one of the few operations that genuinely cannot be
 * household-scoped. Every such call is wrapped in `runUnscoped` to make the
 * exemption explicit at the call site rather than implicit in the client choice.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Registers a new household with its first user as ADMIN.
   *
   * Further members are added by that ADMIN from Settings, rather than by
   * self-registration, so a household is never joined by someone who merely knows
   * it exists.
   */
  async register(input: {
    email: string;
    password: string;
    displayName: string;
    householdName: string;
  }): Promise<AuthenticatedUser> {
    const email = input.email.trim().toLowerCase();

    const existing = await runUnscoped(() =>
      this.prisma.user.findUnique({ where: { email }, select: { id: true } }),
    );
    if (existing) {
      throw new ConflictException('That email address is already registered.');
    }

    const passwordHash = await hash(input.password);

    const user = await runUnscoped(() =>
      this.prisma.user.create({
        data: {
          email,
          passwordHash,
          displayName: input.displayName.trim(),
          role: Role.ADMIN,
          household: { create: { name: input.householdName.trim() } },
        },
      }),
    );

    return this.toAuthenticatedUser(user);
  }

  /**
   * Verifies credentials.
   *
   * Returns the same failure whether the email is unknown or the password is
   * wrong, so the response cannot be used to enumerate registered addresses. The
   * hash is still verified against a dummy when the user is missing, so the reply
   * takes comparable time either way.
   */
  async validateCredentials(
    emailInput: string,
    password: string,
  ): Promise<AuthenticatedUser> {
    const email = emailInput.trim().toLowerCase();

    const user = await runUnscoped(() =>
      this.prisma.user.findUnique({ where: { email } }),
    );

    if (!user || user.disabledOn || user.deletedOn) {
      // Burn comparable time so a missing account is not measurably faster.
      await verify(DUMMY_HASH, password).catch(() => false);
      throw new UnauthorizedException('Incorrect email address or password.');
    }

    const valid = await verify(user.passwordHash, password).catch(() => false);
    if (!valid) {
      throw new UnauthorizedException('Incorrect email address or password.');
    }

    return this.toAuthenticatedUser(user);
  }

  /** Signs the session token embedded in the httpOnly cookie. */
  signToken(user: AuthenticatedUser): string {
    const payload: JwtPayload = {
      sub: user.id,
      hid: user.householdId,
      role: user.role,
    };
    return this.jwt.sign(payload);
  }

  /**
   * Re-reads the user named by a token.
   *
   * Done on every request so that disabling or deleting an account takes effect
   * immediately, instead of when its token happens to expire.
   */
  async resolveTokenUser(payload: JwtPayload): Promise<AuthenticatedUser | null> {
    const user = await runUnscoped(() =>
      this.prisma.user.findUnique({ where: { id: payload.sub } }),
    );

    if (!user || user.disabledOn || user.deletedOn) return null;
    return this.toAuthenticatedUser(user);
  }

  private toAuthenticatedUser(user: {
    id: number;
    householdId: number;
    role: string;
    email: string;
    displayName: string;
  }): AuthenticatedUser {
    return {
      id: user.id,
      householdId: user.householdId,
      role: user.role as Role,
      email: user.email,
      displayName: user.displayName,
    };
  }
}

/**
 * A real argon2 hash of a throwaway value, used only to spend comparable time
 * when the account does not exist. Verifying against a malformed string would
 * fail fast and reintroduce the timing difference this avoids.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Zt5aVoRPJvBGVFN0FEqQGvLNJPPJKBPBRXPPAdVhVXo';
