/**
 * Verifies household isolation against a real database.
 *
 * The tenancy extension is the single thing standing between one household and
 * another's recipes, so "the unit tests pass" is not enough — the scoping has to
 * be proven against real Prisma queries. This exercises the extended client under
 * two different household contexts and asserts that neither can see, change or
 * delete the other's rows.
 *
 * Run with: npm run verify:tenancy -w packages/backend
 * Requires a migrated database (npm run prisma:migrate).
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnv } from 'dotenv';

const rootEnv = resolve(__dirname, '../../../.env');
if (existsSync(rootEnv)) loadEnv({ path: rootEnv, quiet: true });

import { Role } from '@recipes/shared-types';

import { PrismaClient } from '../generated/prisma/client';
import { runUnscoped, runWithHousehold } from '../src/common/household-context';
import { tenancyExtension } from '../src/prisma/tenancy';

const base = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
const db = base.$extends(tenancyExtension);

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function expectThrows(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    check(label, false, 'expected it to throw, but it succeeded');
  } catch {
    check(label, true);
  }
}

interface Scratch {
  id: number;
  householdId: number;
}

async function main(): Promise<void> {
  const stamp = Date.now();

  // Set up two households with the raw client, bypassing tenancy deliberately.
  const { alice, bob } = await runUnscoped(async () => {
    const alice = await base.user.create({
      data: {
        email: `verify-alice-${stamp}@test.local`,
        passwordHash: 'x',
        displayName: 'Alice',
        role: Role.ADMIN,
        household: { create: { name: `Verify A ${stamp}` } },
      },
    });
    const bob = await base.user.create({
      data: {
        email: `verify-bob-${stamp}@test.local`,
        passwordHash: 'x',
        displayName: 'Bob',
        role: Role.ADMIN,
        household: { create: { name: `Verify B ${stamp}` } },
      },
    });
    return { alice, bob };
  });

  // Cleanup runs from a `finally`: a check that throws part-way would otherwise
  // leave its households behind for every later run to trip over.
  try {
    await runChecks(alice, bob, stamp);
  } finally {
    await cleanup(alice, bob);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

async function runChecks(alice: Scratch, bob: Scratch, stamp: number): Promise<void> {
  const asAlice = <T>(fn: () => Promise<T>) =>
    runWithHousehold(
      { householdId: alice.householdId, userId: alice.id, role: Role.ADMIN },
      fn,
    );
  const asBob = <T>(fn: () => Promise<T>) =>
    runWithHousehold({ householdId: bob.householdId, userId: bob.id, role: Role.ADMIN }, fn);

  console.log('\nWrites are stamped with the caller household');
  const aliceRecipe = await asAlice(() =>
    db.recipe.create({
      data: {
        title: 'Alice Soup',
        slug: `alice-soup-${stamp}`,
        servings: 4,
        createdById: alice.id,
        // householdId deliberately omitted — the extension supplies it.
      } as never,
    }),
  );
  check('create stamps the caller household', aliceRecipe.householdId === alice.householdId);

  const bobRecipe = await asBob(() =>
    db.recipe.create({
      data: {
        title: 'Bob Stew',
        slug: `bob-stew-${stamp}`,
        servings: 2,
        createdById: bob.id,
      } as never,
    }),
  );
  check('a second household gets its own stamp', bobRecipe.householdId === bob.householdId);

  console.log('\nReads are confined to the caller household');
  const aliceList = await asAlice(() => db.recipe.findMany());
  check('findMany returns own recipes', aliceList.some((r) => r.id === aliceRecipe.id));
  check(
    'findMany hides the other household recipes',
    !aliceList.some((r) => r.id === bobRecipe.id),
    `saw ${aliceList.length} rows`,
  );

  check(
    'count is scoped',
    (await asAlice(() => db.recipe.count())) === aliceList.length,
  );

  console.log("\nSingle-record lookups cannot reach across households");
  check(
    'findUnique on another household id returns null',
    (await asBob(() => db.recipe.findUnique({ where: { id: aliceRecipe.id } }))) === null,
  );
  check(
    'findFirst on another household id returns null',
    (await asBob(() => db.recipe.findFirst({ where: { id: aliceRecipe.id } }))) === null,
  );
  await expectThrows('findUniqueOrThrow on another household id throws', () =>
    asBob(() => db.recipe.findUniqueOrThrow({ where: { id: aliceRecipe.id } })),
  );

  console.log('\nA forged householdId in the query is overridden, not honoured');
  const forged = await asBob(() =>
    db.recipe.findMany({ where: { householdId: alice.householdId } as never }),
  );
  // The filter is rewritten to Bob's own household rather than rejected, so he
  // gets his own rows back. What matters is that Alice's are not among them.
  check(
    'forged householdId never returns the other household rows',
    !forged.some((r) => r.id === aliceRecipe.id),
  );
  check(
    'forged householdId falls back to the caller own rows',
    forged.every((r) => r.householdId === bob.householdId),
  );

  console.log('\nWrites cannot reach across households');
  const updated = await asBob(() =>
    db.recipe.updateMany({
      where: { id: aliceRecipe.id },
      data: { title: 'Hijacked' },
    }),
  );
  check('updateMany matches nothing', updated.count === 0);

  const deleted = await asBob(() =>
    db.recipe.deleteMany({ where: { id: aliceRecipe.id } }),
  );
  check('deleteMany matches nothing', deleted.count === 0);

  const stillThere = await asAlice(() =>
    db.recipe.findUnique({ where: { id: aliceRecipe.id } }),
  );
  check('the target recipe is untouched', stillThere?.title === 'Alice Soup');

  console.log('\nShared catalog: global rows visible, private rows are not');
  const flour = await asAlice(() =>
    db.ingredient.findFirst({ where: { slug: 'all-purpose-flour' } }),
  );
  check('seeded global ingredient is visible', flour !== null);
  check('global ingredient has no household', flour?.householdId === null);

  const privateIngredient = await asAlice(() =>
    db.ingredient.create({
      data: { name: `Nonna Sauce ${stamp}`, slug: `nonna-sauce-${stamp}` } as never,
    }),
  );
  check(
    'a household own ingredient is stamped',
    privateIngredient.householdId === alice.householdId,
  );
  check(
    'the other household cannot see it',
    (await asBob(() =>
      db.ingredient.findFirst({ where: { slug: `nonna-sauce-${stamp}` } }),
    )) === null,
  );
  check(
    'but can still see the global catalog',
    (await asBob(() => db.ingredient.findFirst({ where: { slug: 'all-purpose-flour' } }))) !==
      null,
  );

  console.log('\nThe global catalog is readable but not writable');
  // Catalog reads intentionally see global rows, so the write path has to be
  // scoped separately — otherwise `update({ where: { id } })` on a seeded row
  // would pass the visibility check and let one household edit the shared
  // catalog for everyone.
  const globalUpdate = await asAlice(() =>
    db.ingredient.updateMany({
      where: { slug: 'all-purpose-flour' },
      data: { gramsPerMl: '9.9' },
    }),
  );
  check('updateMany on a global row matches nothing', globalUpdate.count === 0);

  const flourAfter = await asAlice(() =>
    db.ingredient.findFirst({ where: { slug: 'all-purpose-flour' } }),
  );
  check(
    'the global ingredient density is untouched',
    flourAfter?.gramsPerMl?.toString() !== '9.9',
    `saw ${String(flourAfter?.gramsPerMl)}`,
  );

  const globalDelete = await asAlice(() =>
    db.ingredient.deleteMany({ where: { slug: 'all-purpose-flour' } }),
  );
  check('deleteMany on a global row matches nothing', globalDelete.count === 0);

  const ownUpdate = await asAlice(() =>
    db.ingredient.updateMany({
      where: { id: privateIngredient.id },
      data: { gramsPerMl: '1.2' },
    }),
  );
  check('but the household can still edit its own row', ownUpdate.count === 1);

  console.log('\nNo context fails closed');
  await expectThrows('a scoped query with no household context throws', () =>
    db.recipe.findMany(),
  );
  check(
    'runUnscoped is still allowed to cross households',
    (await runUnscoped(() => db.recipe.findMany({ where: { id: aliceRecipe.id } }))).length ===
      1,
  );

}

/** Removes the two scratch households and everything they own. */
async function cleanup(alice: Scratch, bob: Scratch): Promise<void> {
  await runUnscoped(async () => {
    await base.recipe.deleteMany({
      where: { householdId: { in: [alice.householdId, bob.householdId] } },
    });
    await base.ingredient.deleteMany({ where: { householdId: alice.householdId } });
    await base.user.deleteMany({
      where: { householdId: { in: [alice.householdId, bob.householdId] } },
    });
    await base.household.deleteMany({
      where: { id: { in: [alice.householdId, bob.householdId] } },
    });
  });
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => base.$disconnect());
