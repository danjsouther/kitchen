/**
 * Walks the whole loop against a running server, over HTTP.
 *
 * Every serious bug this repo has had passed its unit tests and the compiler:
 * the ordering bug, the unit-agreement bug, the parser/API seam, the tenancy
 * hole, the seed shipping no data. They were found by exercising the real
 * thing, and until now the only thing that exercised it was a person. This is
 * that walk, written down.
 *
 * HTTP on purpose, not the services directly. Calling the services would
 * re-test what the unit suites already cover and would skip every seam that has
 * actually broken — DTO validation, the `/api` prefix, the guards, and the
 * interceptor that renders Decimals as strings.
 *
 * Prisma appears here for one thing only: taking the scratch household away
 * again afterwards, since no endpoint deletes a household.
 *
 * Run with: npm run smoke   (needs `npm run dev:up` in another terminal)
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnv } from 'dotenv';

const rootEnv = resolve(__dirname, '../../../.env');
if (existsSync(rootEnv)) loadEnv({ path: rootEnv, quiet: true });

import { PrismaClient } from '../generated/prisma/client';
import { runUnscoped } from '../src/common/household-context';

const BASE_URL =
  process.env.SMOKE_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}/api`;

const base = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });

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

function equal(label: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(label, same, same ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/**
 * The session lives in an httpOnly cookie, so it has to be carried by hand —
 * there is no browser here to do it.
 */
let cookie = '';

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const setCookie = response.headers.getSetCookie();
  if (setCookie.length > 0) {
    cookie = setCookie.map((entry) => entry.split(';')[0]).join('; ');
  }

  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(
      `${method} ${path} → ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload as T;
}

// -- Shapes, only as far as this script reads them ---------------------------

interface Ingredient {
  id: number;
  name: string;
}
interface Unit {
  id: number;
  name: string;
}
interface ParsedLine {
  rawText: string;
  ingredientId: number | null;
  quantity: string | null;
  unitId: number | null;
  needsReview: boolean;
  match: { kind: string };
}
interface ParseResult {
  title: string | null;
  servings: number | null;
  ingredients: ParsedLine[];
  steps: { text: string }[];
  summary: { total: number; resolved: number; needsReview: number };
}
interface RecipeLine {
  id: number;
  rawText: string;
  quantity: string | null;
  ingredient: { id: number; name: string } | null;
  unit: Unit | null;
  scaled?: { quantity: string; display: string } | null;
}
interface Recipe {
  id: number;
  title: string;
  servings: number;
  ingredients: RecipeLine[];
  steps: { text: string }[];
}
interface PantryLot {
  id: number;
  quantity: string;
  unit: Unit;
  ingredient: { id: number; name: string };
}
interface Balance {
  ingredientId: number;
  ingredient: { name: string };
  total: string | null;
  unit: Unit | null;
}
interface ProposedItem {
  ingredientId: number;
  ingredientName: string;
  quantity: string;
  unit: Unit;
  onHand: string | null;
  unconvertible: boolean;
  categoryId: number | null;
}
interface Proposal {
  mealCount: number;
  items: ProposedItem[];
}
interface ListItem {
  id: number;
  quantity: string | null;
  ingredient: { id: number; name: string } | null;
  unit: Unit | null;
  checkedOn: string | null;
}
interface ShoppingList {
  id: number;
  items: ListItem[];
  totals: { actual: string; checkedItems: number; unpricedItems: number };
}
interface PlannedMeal {
  id: number;
  servings: number;
  cookSessions: { id: number; reversedOn: string | null }[];
}
interface CookReport {
  cookSessionId: number;
  servings: number;
  deducted: { ingredientId: number; took: string; unit: Unit }[];
  shortfalls: { ingredientId: number }[];
}

// -- Catalog rows the walk leans on ------------------------------------------
//
// Looked up by name rather than hardcoded by id: ids shift whenever the seed
// gains a row, and a smoke test that fails because the catalog grew would teach
// everyone to ignore it.

async function findIngredient(name: string): Promise<Ingredient> {
  const hits = await api<Ingredient[]>('GET', `/ingredients?q=${encodeURIComponent(name)}&limit=20`);
  const exact = hits.find((row) => row.name.toLowerCase() === name.toLowerCase());
  if (!exact) throw new Error(`The seed has no ingredient called "${name}".`);
  return exact;
}

async function findUnit(name: string): Promise<Unit> {
  const units = await api<Unit[]>('GET', '/units');
  const unit = units.find((row) => row.name === name);
  if (!unit) throw new Error(`The seed has no unit called "${name}".`);
  return unit;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const stamp = Date.now();

  section(`Reaching the API at ${BASE_URL}`);
  let health: { status: string; database: string };
  try {
    health = await api('GET', '/health');
  } catch (error) {
    console.error(
      `\nCould not reach the API at ${BASE_URL}.\n` +
        'Start it first with `npm run dev:up`, or point SMOKE_BASE_URL somewhere else.\n',
    );
    throw error;
  }
  check('the API answers and can reach Postgres', health.database === 'ok', health.database);

  const email = `smoke-${stamp}@test.local`;
  const user = await api<{ id: number; householdId: number }>('POST', '/auth/register', {
    email,
    password: 'smoke test password',
    displayName: 'Smoke',
    householdName: `ZZ Smoke ${stamp}`,
  });
  check('registering returns a session', cookie.length > 0);

  try {
    await walk(stamp);
  } finally {
    await cleanup(user.householdId);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

async function walk(stamp: number): Promise<void> {
  const gram = await findUnit('gram');
  const cup = await findUnit('cup');
  const each = await findUnit('each');
  const millilitre = await findUnit('millilitre');

  const flour = await findIngredient('all-purpose flour');
  const egg = await findIngredient('egg');
  const milk = await findIngredient('whole milk');
  const carrot = await findIngredient('carrot');
  const banana = await findIngredient('banana');

  // A household ingredient with no density, deliberately. The list has to be
  // honest about a quantity it cannot compare rather than quietly assuming one,
  // and that is the app's central claim.
  const mystery = await api<Ingredient>('POST', '/ingredients', {
    name: `Smoke Mystery Powder ${stamp}`,
  });

  // -- Paste and parse -------------------------------------------------------

  section('Paste-and-parse turns text into a draft');
  const text = [
    'Smoke Pancakes',
    'Serves 2',
    '',
    'Ingredients',
    '2 cups all-purpose flour',
    '3 eggs',
    '1 cup whole milk',
    '2 carrots',
    '2 bananas',
    `50 g Smoke Mystery Powder ${stamp}`,
    '',
    'Method',
    '1. Mix everything.',
    '2. Fry until golden.',
  ].join('\n');

  const parsed = await api<ParseResult>('POST', '/recipes/parse', { text });

  equal('the title is read off the paste', parsed.title, 'Smoke Pancakes');
  // The serving count is *not* read off the text — "Serves 2" is treated as a
  // notes heading and dropped. Pinned rather than glossed over, because the
  // review screen's `result.servings ?? 4` fallback is load-bearing because of
  // it, and a parser that started filling this in would change what that screen
  // shows without anything else noticing.
  equal('but the serving count is left for the human', parsed.servings, null);
  equal('every ingredient line is found', parsed.summary.total, 6);
  equal('all six resolve to the catalog', parsed.summary.resolved, 6);
  equal('both method steps are found', parsed.steps.length, 2);

  const flourLine = parsed.ingredients.find((line) => line.ingredientId === flour.id);
  check('the flour line matched the catalog', flourLine !== undefined);
  equal('with its quantity as a string', flourLine?.quantity, '2');
  equal('and the right unit', flourLine?.unitId, cup.id);

  const eggLine = parsed.ingredients.find((line) => line.ingredientId === egg.id);
  check('a plural resolves to the singular catalog row', eggLine !== undefined);
  equal('an unquantified unit is not invented', eggLine?.unitId, null);
  equal('the egg count survives', eggLine?.quantity, '3');

  const mysteryLine = parsed.ingredients.find((line) => line.ingredientId === mystery.id);
  check("a household's own ingredient is matched too", mysteryLine !== undefined);

  // -- Confirming the draft --------------------------------------------------
  //
  // The parse result is handed back as a create payload, which is the seam the
  // review screen actually uses. A drift between the two shapes is exactly the
  // sort of thing that compiles and then 400s at the worst moment.

  section('Confirming the draft stores it');

  // Standing in for the reviewer at the picker: "3 eggs" parses with a count but
  // no unit, and a line with no unit is skipped by the shopping generator and
  // the cook alike — deliberately, since there is nothing to convert. So the
  // units get filled in here, exactly as a human would fill them.
  //
  // The bananas are left alone on purpose, as the line the reviewer did not get
  // to. What happens to it is asserted further down.
  const unitFor = new Map<number, number>([
    [egg.id, each.id],
    [carrot.id, each.id],
  ]);

  const recipe = await api<Recipe>('POST', '/recipes', {
    title: parsed.title,
    // Supplied here exactly as the review screen supplies it, since the parse
    // does not carry one.
    servings: 2,
    ingredients: parsed.ingredients.map((line) => {
      const filledUnit =
        line.unitId ?? (line.ingredientId ? unitFor.get(line.ingredientId) : undefined);
      return {
        ...(line.ingredientId ? { ingredientId: line.ingredientId } : {}),
        rawText: line.rawText,
        ...(line.quantity ? { quantity: line.quantity } : {}),
        ...(filledUnit ? { unitId: filledUnit } : {}),
      };
    }),
    steps: parsed.steps,
  });

  equal('the recipe saves with all six lines', recipe.ingredients.length, 6);
  equal('and both steps', recipe.steps.length, 2);
  check('nothing was created before confirming', recipe.id > 0);

  section('Scaling runs from the stored values');
  const scaledTo4 = await api<Recipe>('GET', `/recipes/${recipe.id}/scaled?servings=4`);
  const scaledFlour = scaledTo4.ingredients.find((l) => l.ingredient?.id === flour.id);
  equal('4 servings doubles 2 cups to 4', scaledFlour?.scaled?.quantity, '4');

  const scaledTo6 = await api<Recipe>('GET', `/recipes/${recipe.id}/scaled?servings=6`);
  const backTo4 = await api<Recipe>('GET', `/recipes/${recipe.id}/scaled?servings=4`);
  equal(
    'and viewing 6 first does not change the answer for 4',
    backTo4.ingredients.find((l) => l.ingredient?.id === flour.id)?.scaled?.quantity,
    scaledFlour?.scaled?.quantity,
  );
  check(
    '6 servings is a different number again',
    scaledTo6.ingredients.find((l) => l.ingredient?.id === flour.id)?.scaled?.quantity === '6',
  );

  // -- Stocking the pantry ---------------------------------------------------

  section('Stocking the pantry');
  const larder = await api<{ id: number }>('POST', '/storage-locations', {
    name: `Smoke Larder ${stamp}`,
  });

  // 6 eggs against a demand of 18: enough to prove subtraction happens without
  // covering the line entirely.
  await api<PantryLot>('POST', '/pantry', {
    ingredientId: egg.id,
    locationId: larder.id,
    quantity: '6',
    unitId: each.id,
  });
  // Millilitres of something with no density, against a recipe asking for
  // grams. Nothing can compare these two, and the list must say so.
  await api<PantryLot>('POST', '/pantry', {
    ingredientId: mystery.id,
    locationId: larder.id,
    quantity: '100',
    unitId: millilitre.id,
  });
  await api<PantryLot>('POST', '/pantry', {
    ingredientId: flour.id,
    locationId: larder.id,
    quantity: '1000',
    unitId: gram.id,
  });

  const balances = await api<Balance[]>('GET', '/pantry/balances');
  const eggBalance = balances.find((b) => b.ingredientId === egg.id);
  equal('the egg balance totals what was stocked', eggBalance?.total, '6');

  // -- The week --------------------------------------------------------------

  section('Planning three dinners at double the servings');
  const monday = new Date();
  monday.setHours(12, 0, 0, 0);
  const days = [0, 1, 2].map((offset) => {
    const day = new Date(monday);
    day.setDate(day.getDate() + offset);
    return isoDate(day);
  });

  const meals: PlannedMeal[] = [];
  for (const day of days) {
    meals.push(
      await api<PlannedMeal>('POST', '/planner', {
        date: day,
        slot: 'DINNER',
        recipeId: recipe.id,
        servings: 4,
      }),
    );
  }
  equal('three meals are on the calendar', meals.length, 3);
  equal('each at the serving count asked for', meals[0].servings, 4);

  // -- The shop --------------------------------------------------------------

  section('The store carries its own aisle order');
  const store = await api<{ id: number }>('POST', '/stores', { name: `Smoke Mart ${stamp}` });
  const categories = await api<{ id: number; name: string }[]>('GET', '/ingredient-categories');
  const categoryId = (name: string): number => {
    const found = categories.find((c) => c.name === name);
    if (!found) throw new Error(`The seed has no category called "${name}".`);
    return found.id;
  };

  // Deliberately the reverse of the catalog's own order (Produce, Dairy,
  // Baking), so a list that came back in catalog order would fail rather than
  // coincidentally pass.
  const walkOrder = ['Baking', 'Dairy & Eggs', 'Produce'];
  await api('PUT', `/stores/${store.id}/aisles`, {
    aisles: walkOrder.map((name, index) => ({ categoryId: categoryId(name), sortOrder: index })),
  });

  section('Generating a list for that week');
  const proposal = await api<Proposal>('POST', '/shopping-lists/generate', {
    from: days[0],
    to: days[2],
    storeId: store.id,
  });

  equal('it saw all three meals', proposal.mealCount, 3);

  const line = (id: number): ProposedItem | undefined =>
    proposal.items.find((item) => item.ingredientId === id);

  // Three meals at 4 servings from a recipe serving 2 is six times the recipe.
  // Eggs and carrots are counts, so the arithmetic is exact with no conversion
  // in the way — which is the point of asserting on them.
  equal('18 eggs are needed, less the 6 on hand', line(egg.id)?.quantity, '12');
  equal('the eggs on hand are reported', line(egg.id)?.onHand, '6');
  equal('12 carrots are needed', line(carrot.id)?.quantity, '12');

  // The distinction the whole app rests on, at the one place it decides what to
  // buy. Having none of something is a number we are sure of; a balance that
  // could not be converted into the unit being bought is not a number at all,
  // and reporting it as 0 would under-buy on a guess.
  equal('nothing in the pantry reads as a confident 0', line(milk.id)?.onHand, '0');

  const mysteryItem = line(mystery.id);
  check('the line we cannot measure is still on the list', mysteryItem !== undefined);
  equal('what is on hand is reported as unknown, not as 0', mysteryItem?.onHand, null);
  equal(
    'so the full amount is bought — over-buying is the safe direction',
    mysteryItem?.quantity,
    '300',
  );
  // `unconvertible` is a narrower flag than the name suggests: it marks demand
  // lines that would not fold together, not a balance that would not subtract.
  // Pinned so the two stop being confused for one another.
  equal('the demand itself folded together fine', mysteryItem?.unconvertible, false);

  // Left without a unit at review, so there is nothing to convert and nothing to
  // total. The generator skips it by the same rule the cook does, rather than
  // inventing a unit for it.
  check('a line with no unit is not shopped for', line(banana.id) === undefined);

  const walkPosition = new Map(walkOrder.map((name, index) => [categoryId(name), index]));
  const positions = proposal.items
    .map((item) => (item.categoryId === null ? undefined : walkPosition.get(item.categoryId)))
    .filter((position): position is number => position !== undefined);
  check(
    'the list is sorted by the walk, not the catalog',
    positions.length >= 3 &&
      positions.every((position, index) => index === 0 || position >= positions[index - 1]),
    `walk positions came back as ${JSON.stringify(positions)}`,
  );

  // -- The shop, done --------------------------------------------------------

  section('Ticking items off puts them away and records what they cost');
  const list = await api<ShoppingList>('POST', '/shopping-lists', {
    from: days[0],
    to: days[2],
    storeId: store.id,
    name: `Smoke List ${stamp}`,
  });
  check('the saved list has the same lines as the proposal', list.items.length === proposal.items.length);

  const eggItem = list.items.find((item) => item.ingredient?.id === egg.id);
  const carrotItem = list.items.find((item) => item.ingredient?.id === carrot.id);
  check('the egg line is on the saved list', eggItem !== undefined);

  await api('PATCH', `/shopping-lists/${list.id}/items/${eggItem!.id}`, {
    checked: true,
    actualPrice: '4.99',
  });
  await api('PATCH', `/shopping-lists/${list.id}/items/${carrotItem!.id}`, {
    checked: true,
    actualPrice: '3.50',
  });

  const priced = await api<ShoppingList>('GET', `/shopping-lists/${list.id}`);
  equal('two items are ticked', priced.totals.checkedItems, 2);
  equal('the total is exact, not a float', priced.totals.actual, '8.49');

  const received = await api<{
    stocked: unknown[];
    priced: number[];
    skipped: { itemId: number; reason: string }[];
  }>('POST', `/shopping-lists/${list.id}/receive`, { locationId: larder.id });

  equal('both ticked items became pantry lots', received.stocked.length, 2);
  equal('and both were recorded as prices', received.priced.length, 2);
  equal('nothing was silently dropped', received.skipped.length, 0);

  const afterShopping = await api<Balance[]>('GET', '/pantry/balances');
  equal(
    'the eggs bought are added to the ones already there',
    afterShopping.find((b) => b.ingredientId === egg.id)?.total,
    '18',
  );
  equal(
    'and the carrots arrive',
    afterShopping.find((b) => b.ingredientId === carrot.id)?.total,
    '12',
  );

  const observations = await base.priceObservation.count({
    where: { ingredientId: { in: [egg.id, carrot.id] } },
  });
  check('price history was written', observations >= 2, `found ${observations}`);

  // -- Cooking ---------------------------------------------------------------

  section('Cooking one meal moves the pantry, and undo puts it back');
  const before = await api<Balance[]>('GET', '/pantry/balances');

  const report = await api<CookReport>('POST', `/planner/${meals[0].id}/cook`, {});
  equal('it cooked the planned serving count', report.servings, 4);

  const eggDeduction = report.deducted.find((d) => d.ingredientId === egg.id);
  equal('6 eggs come out for a doubled recipe calling for 3', eggDeduction?.took, '6');

  const afterCook = await api<Balance[]>('GET', '/pantry/balances');
  equal(
    'the egg balance drops by exactly that',
    afterCook.find((b) => b.ingredientId === egg.id)?.total,
    '12',
  );

  // The mystery powder cannot be measured against the recipe's grams, so its
  // lot is left alone and named rather than guessed at or quietly skipped.
  const mysteryShort = report.shortfalls.find((s) => s.ingredientId === mystery.id);
  check('the uncomparable line is reported as a shortfall', mysteryShort !== undefined);
  equal(
    'and its lot is untouched',
    afterCook.find((b) => b.ingredientId === mystery.id)?.total,
    before.find((b) => b.ingredientId === mystery.id)?.total,
  );

  await api('DELETE', `/cook-sessions/${report.cookSessionId}`);

  const afterUndo = await api<Balance[]>('GET', '/pantry/balances');
  const summarise = (rows: Balance[]) =>
    rows
      .map((row) => `${row.ingredient.name}=${row.total ?? 'null'}${row.unit?.name ?? ''}`)
      .sort();
  equal('undo restores every balance exactly', summarise(afterUndo), summarise(before));

  const reopened = await api<PlannedMeal[]>('GET', `/planner?from=${days[0]}&to=${days[2]}`);
  const cooked = reopened.find((meal) => meal.id === meals[0].id);
  check(
    'the reversed session is stamped rather than deleted',
    cooked?.cookSessions.length === 1 && cooked.cookSessions[0].reversedOn !== null,
  );
}

/**
 * Takes the scratch household away again.
 *
 * In a `finally`, because a failed assertion part-way through would otherwise
 * leave a household behind for every later run — and this script asserts on
 * balances, so yesterday's leftovers would make today's run fail for the wrong
 * reason.
 */
async function cleanup(householdId: number): Promise<void> {
  await runUnscoped(async () => {
    await base.priceObservation.deleteMany({ where: { householdId } });
    await base.shoppingList.deleteMany({ where: { householdId } });
    await base.store.deleteMany({ where: { householdId } });
    await base.pantryTransaction.deleteMany({ where: { householdId } });
    await base.cookSession.deleteMany({ where: { householdId } });
    await base.plannedMeal.deleteMany({ where: { householdId } });
    await base.pantryPar.deleteMany({ where: { householdId } });
    await base.pantryItem.deleteMany({ where: { householdId } });
    await base.storageLocation.deleteMany({ where: { householdId } });
    await base.recipe.deleteMany({ where: { householdId } });
    await base.tag.deleteMany({ where: { householdId } });
    await base.ingredient.deleteMany({ where: { householdId } });
    await base.unit.deleteMany({ where: { householdId } });
    await base.user.deleteMany({ where: { householdId } });
    await base.household.deleteMany({ where: { id: householdId } });
  });
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => base.$disconnect());
