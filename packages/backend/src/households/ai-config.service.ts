import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

import {
  decryptSecret,
  encryptSecret,
  lastFour,
  parseMasterKey,
} from '../common/secret-crypto.util';
import { requireHouseholdId } from '../common/household-context';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.service';
import type { UpdateAiConfigDto } from './dto/ai-config.dto';

/**
 * What a household's AI settings look like from outside.
 *
 * There is deliberately no field here that could hold the key. Anything the API
 * returns is built from this shape, so a future `select: *` or a careless spread
 * cannot leak the secret — the type simply has nowhere to put it.
 */
export interface AiConfigView {
  configured: boolean;
  enabled: boolean;
  /** Enough to recognise which key is stored, and nothing more. */
  keyLastFour: string | null;
  model: string;
  effort: string;
  verifiedOn: Date | null;
  updatedOn: Date | null;
}

const ALLOWED_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
const ALLOWED_EFFORTS = ['low', 'medium', 'high'];

@Injectable()
export class AiConfigService {
  private readonly logger = new Logger(AiConfigService.name);

  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantPrisma) {}

  /** Never returns the key itself — only whether one exists and its last four. */
  async view(): Promise<AiConfigView> {
    const config = await this.db.householdAiConfig.findFirst();

    if (!config) {
      return {
        configured: false,
        enabled: false,
        keyLastFour: null,
        model: 'claude-opus-5',
        effort: 'medium',
        verifiedOn: null,
        updatedOn: null,
      };
    }

    return {
      configured: true,
      enabled: config.enabled,
      keyLastFour: config.keyLastFour,
      model: config.model,
      effort: config.effort,
      verifiedOn: config.verifiedOn,
      updatedOn: config.updatedOn,
    };
  }

  /**
   * Stores or replaces a household's key.
   *
   * The key is **verified against the real API before it is stored.** Saving an
   * unverified key means the first failure surfaces later, inside a feature the
   * user was trying to use, as an opaque error from a third party — rather than
   * here, on the settings screen, where the fix is obvious.
   */
  async update(dto: UpdateAiConfigDto, userId: number): Promise<AiConfigView> {
    const householdId = requireHouseholdId();
    const existing = await this.db.householdAiConfig.findFirst();

    if (dto.model && !ALLOWED_MODELS.includes(dto.model)) {
      throw new BadRequestException(
        `model must be one of: ${ALLOWED_MODELS.join(', ')}.`,
      );
    }
    if (dto.effort && !ALLOWED_EFFORTS.includes(dto.effort)) {
      throw new BadRequestException(
        `effort must be one of: ${ALLOWED_EFFORTS.join(', ')}.`,
      );
    }

    if (!dto.apiKey && !existing) {
      throw new BadRequestException(
        'No key is stored for this household yet, so one must be supplied.',
      );
    }

    const data: Record<string, unknown> = {
      updatedById: userId,
    };
    if (dto.model !== undefined) data.model = dto.model;
    if (dto.effort !== undefined) data.effort = dto.effort;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;

    if (dto.apiKey) {
      const key = dto.apiKey.trim();
      await this.verifyKey(key, dto.model ?? existing?.model ?? 'claude-opus-5');

      const encrypted = encryptSecret(key, parseMasterKey(process.env.AI_ENCRYPTION_KEY));
      data.encryptedKey = encrypted.ciphertext;
      data.keyIv = encrypted.iv;
      data.keyAuthTag = encrypted.authTag;
      data.keyLastFour = lastFour(key);
      data.verifiedOn = new Date();
      // A brand-new key with no explicit instruction is meant to be used.
      if (dto.enabled === undefined) data.enabled = true;
    }

    if (existing) {
      await this.db.householdAiConfig.update({
        where: { householdId },
        data: data as never,
      });
    } else {
      await this.db.householdAiConfig.create({ data: data as never });
    }

    return this.view();
  }

  /** Removes the key entirely. The row goes with it — there is nothing left to keep. */
  async clear(): Promise<AiConfigView> {
    const householdId = requireHouseholdId();
    const existing = await this.db.householdAiConfig.findFirst();
    if (!existing) throw new NotFoundException('No AI key is configured.');

    await this.db.householdAiConfig.delete({ where: { householdId } });
    return this.view();
  }

  /**
   * Decrypts the household's key for one request.
   *
   * Returns null rather than throwing when nothing is configured, because "this
   * household has not set up AI" is an ordinary state the caller answers with a
   * 409, not an error. The plaintext is returned to a single caller that uses it
   * immediately and lets it fall out of scope — it is never logged, never put in
   * an error message, and never attached to the request object.
   */
  async resolveKey(): Promise<{ apiKey: string; model: string; effort: string } | null> {
    const config = await this.db.householdAiConfig.findFirst();
    if (!config || !config.enabled) return null;

    const apiKey = decryptSecret(
      {
        ciphertext: Buffer.from(config.encryptedKey),
        iv: Buffer.from(config.keyIv),
        authTag: Buffer.from(config.keyAuthTag),
      },
      parseMasterKey(process.env.AI_ENCRYPTION_KEY),
    );

    return { apiKey, model: config.model, effort: config.effort };
  }

  /**
   * Makes the smallest possible real call to confirm a key works.
   *
   * Deliberately tiny — one token of output — because this runs on every save and
   * its only job is to separate "this key is valid" from "this key is not".
   */
  private async verifyKey(apiKey: string, model: string): Promise<void> {
    try {
      const client = new Anthropic({ apiKey, maxRetries: 1 });
      await client.messages.create({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
      });
    } catch (error) {
      const status = (error as { status?: number }).status;

      // The key must not reach the log or the response. Only the status does.
      this.logger.warn(`API key verification failed with status ${status ?? 'unknown'}`);

      if (status === 401 || status === 403) {
        throw new BadRequestException(
          'Anthropic rejected that API key. Check it was copied in full.',
        );
      }
      if (status === 429) {
        throw new BadRequestException(
          'That key is rate-limited right now, so it could not be verified. Try again shortly.',
        );
      }
      throw new BadRequestException(
        'Could not reach Anthropic to verify that key. Check the server has network access, then try again.',
      );
    }
  }
}
