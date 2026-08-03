import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import { Role } from '@kitchen/shared-types';

import { runUnscoped } from '../common/household-context';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  generateResetToken,
  hashResetToken,
  RESET_TOKEN_TTL_MS,
} from './password-reset-token.util';
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
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
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
      tokenVersion: user.tokenVersion,
    };
    return this.jwt.sign(payload);
  }

  /**
   * Re-reads the user named by a token.
   *
   * Done on every request so that disabling or deleting an account, or
   * resetting the password, takes effect immediately instead of when the
   * token happens to expire. A tokenVersion mismatch means this cookie was
   * issued before the most recent password reset.
   */
  async resolveTokenUser(payload: JwtPayload): Promise<AuthenticatedUser | null> {
    const user = await runUnscoped(() =>
      this.prisma.user.findUnique({ where: { id: payload.sub } }),
    );

    if (!user || user.disabledOn || user.deletedOn) return null;
    if (user.tokenVersion !== payload.tokenVersion) return null;
    return this.toAuthenticatedUser(user);
  }

  /**
   * Starts a password reset. Always resolves, whether or not the email is
   * registered — mirroring validateCredentials()'s refusal to say which part
   * of a login failed, so this endpoint cannot be used to enumerate accounts.
   */
  async forgotPassword(emailInput: string): Promise<void> {
    const email = emailInput.trim().toLowerCase();

    const user = await runUnscoped(() => this.prisma.user.findUnique({ where: { email } }));
    if (!user || user.disabledOn || user.deletedOn) return;

    // A stale link from an earlier request must not still be redeemable
    // alongside the new one.
    await runUnscoped(() =>
      this.prisma.passwordResetToken.deleteMany({
        where: { userId: user.id, usedOn: null },
      }),
    );

    const { token, tokenHash } = generateResetToken();
    await runUnscoped(() =>
      this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresOn: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        },
      }),
    );

    const frontendUrl = this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:4201';
    const resetUrl = `${frontendUrl}/reset-password?token=${token}`;

    try {
      await this.mail.sendPasswordResetEmail(user.email, resetUrl);
    } catch (error) {
      // A broken SMTP config must not turn into a different HTTP response
      // than "email not registered" would produce.
      this.logger.error(`Failed to send password reset email to ${user.email}`, error);
    }
  }

  /**
   * Redeems a reset token, setting a new password.
   *
   * Bumps tokenVersion in the same transaction, which invalidates every
   * other session already issued for this user — a cookie sitting in another
   * browser was signed with the old tokenVersion and will fail
   * resolveTokenUser on its next request. The caller must sign a fresh
   * cookie from the returned user so this request's own session keeps
   * working.
   */
  async resetPassword(tokenInput: string, newPassword: string): Promise<AuthenticatedUser> {
    const tokenHash = hashResetToken(tokenInput);

    const record = await runUnscoped(() =>
      this.prisma.passwordResetToken.findUnique({
        where: { tokenHash },
        include: { user: true },
      }),
    );

    const invalid =
      !record ||
      record.usedOn !== null ||
      record.expiresOn < new Date() ||
      record.user.disabledOn ||
      record.user.deletedOn;
    if (invalid) {
      throw new BadRequestException('This reset link is invalid or has expired.');
    }

    const passwordHash = await hash(newPassword);

    const [updatedUser] = await runUnscoped(() =>
      this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: record.user.id },
          data: { passwordHash, tokenVersion: { increment: 1 } },
        }),
        this.prisma.passwordResetToken.update({
          where: { id: record.id },
          data: { usedOn: new Date() },
        }),
      ]),
    );

    return this.toAuthenticatedUser(updatedUser);
  }

  private toAuthenticatedUser(user: {
    id: number;
    householdId: number;
    role: string;
    email: string;
    displayName: string;
    tokenVersion: number;
  }): AuthenticatedUser {
    return {
      id: user.id,
      householdId: user.householdId,
      role: user.role as Role,
      email: user.email,
      displayName: user.displayName,
      tokenVersion: user.tokenVersion,
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
