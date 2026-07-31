/**
 * Stores an encrypted throwaway "API key" for a household, bypassing the
 * verify-on-save check.
 *
 * Used only to prove the read paths never disclose a stored key. Verification
 * would reject this value — which is the point of verification — so this writes
 * the row directly, exactly as a successfully verified save would have.
 *
 * Run: npx tsx scripts/seed-fake-ai-key.ts <householdId> <userId> <fakeKey>
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnv } from 'dotenv';

const rootEnv = resolve(__dirname, '../../../.env');
if (existsSync(rootEnv)) loadEnv({ path: rootEnv, quiet: true });

import { PrismaClient } from '../generated/prisma/client';
import { encryptSecret, lastFour, parseMasterKey } from '../src/common/secret-crypto.util';

const [householdId, userId, fakeKey] = process.argv.slice(2);
const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });

async function main(): Promise<void> {
  const encrypted = encryptSecret(fakeKey, parseMasterKey(process.env.AI_ENCRYPTION_KEY));

  await prisma.householdAiConfig.create({
    data: {
      householdId: Number(householdId),
      enabled: true,
      // Prisma's Bytes maps to Uint8Array; Node's Buffer is a subclass whose
      // backing store TypeScript will not assume is a plain ArrayBuffer.
      encryptedKey: new Uint8Array(encrypted.ciphertext),
      keyIv: new Uint8Array(encrypted.iv),
      keyAuthTag: new Uint8Array(encrypted.authTag),
      keyLastFour: lastFour(fakeKey),
      updatedById: Number(userId),
      verifiedOn: new Date(),
    },
  });

  const stored = await prisma.householdAiConfig.findUnique({
    where: { householdId: Number(householdId) },
  });
  const ciphertext = Buffer.from(stored!.encryptedKey).toString('utf8');
  console.log('stored lastFour:', stored!.keyLastFour);
  console.log('ciphertext contains plaintext:', ciphertext.includes(fakeKey));
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
