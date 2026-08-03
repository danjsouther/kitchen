import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import type { CookieOptions, Response } from 'express';

import { SESSION_COOKIE } from './auth.constants';
import { AuthService } from './auth.service';
import { CurrentUser, Public } from './decorators';
import {
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
} from './dto/auth.dto';
import type { AuthenticatedUser } from './types';

/** How long a session lasts before the user must sign in again. */
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function sessionCookieOptions(): CookieOptions {
  return {
    // Not readable by page JavaScript, so an XSS bug cannot lift the session.
    httpOnly: true,
    // Only sent over HTTPS in production; relaxed locally so dev works over http.
    secure: process.env.NODE_ENV === 'production',
    // 'lax' still sends the cookie on top-level navigations, which keeps ordinary
    // links working while blocking cross-site form posts.
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_MS,
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Creates a household with its first user as ADMIN. */
  @Public()
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthenticatedUser> {
    const user = await this.auth.register(dto);
    res.cookie(SESSION_COOKIE, this.auth.signToken(user), sessionCookieOptions());
    return user;
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthenticatedUser> {
    const user = await this.auth.validateCredentials(dto.email, dto.password);
    res.cookie(SESSION_COOKIE, this.auth.signToken(user), sessionCookieOptions());
    return user;
  }

  /**
   * Public so that signing out of an already-expired session still clears the
   * cookie rather than returning 401 and leaving it in place.
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) res: Response): void {
    res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  /**
   * Always 204, whether or not the email is registered — the response shape
   * must not reveal which, or it becomes an enumeration oracle.
   */
  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<void> {
    await this.auth.forgotPassword(dto.email);
  }

  /**
   * Unlike forgot-password this legitimately sets a cookie: the user who just
   * reset their password is signed in on the spot, under the new
   * tokenVersion, while every other session they held is now invalid.
   */
  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthenticatedUser> {
    const user = await this.auth.resetPassword(dto.token, dto.newPassword);
    res.cookie(SESSION_COOKIE, this.auth.signToken(user), sessionCookieOptions());
    return user;
  }
}
