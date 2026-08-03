/**
 * Outgoing email, currently just password-reset links.
 *
 * SMTP is generic (nodemailer), not tied to one provider, matching this
 * app's "bring your own credentials" approach elsewhere (the household AI
 * key). A fresh self-hosted clone will not have SMTP_HOST set immediately,
 * so when it is unset this logs the link instead of failing — the feature
 * still works end to end for an operator with server log access, and
 * production deployments are expected to set SMTP_HOST for real delivery.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string | undefined;

  constructor(config: ConfigService) {
    const host = config.get<string>('SMTP_HOST');
    this.from = config.get<string>('SMTP_FROM') ?? config.get<string>('SMTP_USER');

    if (!host) {
      this.transporter = null;
      this.logger.warn(
        'SMTP_HOST is not set — password reset links will be logged to the console instead of emailed.',
      );
      return;
    }

    const port = Number(config.get<string>('SMTP_PORT') ?? 587);
    const user = config.get<string>('SMTP_USER');
    const pass = config.get<string>('SMTP_PASS');

    this.transporter = createTransport({
      host,
      port,
      secure: port === 465,
      auth: user ? { user, pass } : undefined,
    });
  }

  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
    if (!this.transporter) {
      this.logger.log(`Password reset link for ${to}: ${resetUrl}`);
      return;
    }

    await this.transporter.sendMail({
      from: this.from,
      to,
      subject: 'Reset your password',
      text:
        `A password reset was requested for this email address.\n\n` +
        `Reset your password: ${resetUrl}\n\n` +
        `This link expires in 1 hour. If you did not request this, ignore this email.`,
      html:
        `<p>A password reset was requested for this email address.</p>` +
        `<p><a href="${resetUrl}">Reset your password</a></p>` +
        `<p>This link expires in 1 hour. If you did not request this, ignore this email.</p>`,
    });
  }
}
