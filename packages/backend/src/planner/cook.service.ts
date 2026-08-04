import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { PlanStatus, TxKind } from '@kitchen/shared-types';

import { toUnitDef } from '../catalog/units.service';
import {
  planDeduction,
  planExplicitDeduction,
  type DeductionPin,
  type DeductionPlan,
  type ExplicitDraw,
} from '../pantry/deduction';
import { resolveSelection, type Selection } from '../pantry/selection';
import type { BalanceLot } from '../pantry/pantry-balance';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.service';
import { mergeWithdrawals, planCook, type CookLine, type Withdrawal } from './cook-plan';
import type { CookDto } from './dto/planner.dto';

/**
 * "For this ingredient, use this jar."
 *
 * Keyed by ingredient rather than by withdrawal because `mergeWithdrawals`
 * splits one ingredient into several withdrawals when a recipe asks for it in
 * two units, and the cook is pinning a jar to a *line*, not to a unit.
 */
export type CookPin = DeductionPin & {
  ingredientId: number;
  /** Exactly what came out of each lot, when the cook worked it out themselves. */
  draws?: ReadonlyArray<{ lotId: number; quantity: string }>;
};

@Injectable()
export class CookService {
  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantPrisma) {}

  /**
   * Cooks a planned meal: deducts every resolved ingredient from the pantry and
   * records the whole thing as one reversible session.
   *
   * Three commitments hold throughout, inherited from the deduction engine:
   *
   *  * A shortfall is **reported, not forced.** The pantry gives what it has and
   *    the gap comes back in the response; no lot goes negative.
   *  * A line the maths cannot reach — unresolved, unquantified, or a lot with no
   *    density — is **named**, never silently skipped.
   *  * Everything lands in **one transaction** with one `CookSession`, so undo is
   *    a single operation rather than a dozen partial reversals.
   */
  async cook(plannedMealId: number, dto: CookDto, userId: number) {
    const meal = await this.requireCookableMeal(plannedMealId);

    const servings = dto.servings ?? meal.servings;
    const report = await this.deduct(meal.recipeId!, servings, userId, {
      plannedMealId: meal.id,
      note: dto.note,
      pins: dto.pins,
    });

    await this.db.plannedMeal.update({
      where: { id: meal.id },
      data: { status: PlanStatus.COOKED },
    });

    return report;
  }

  /** Cooks a recipe that was never on the calendar — an unplanned meal. */
  async cookRecipe(recipeId: number, dto: CookDto, userId: number) {
    const recipe = await this.db.recipe.findFirst({
      where: { id: recipeId },
      select: { id: true, servings: true },
    });
    if (!recipe) throw new NotFoundException(`No recipe with id ${recipeId}.`);

    return this.deduct(recipeId, dto.servings ?? recipe.servings, userId, {
      note: dto.note,
      pins: dto.pins,
    });
  }

  /**
   * Works out what cooking *would* take, and writes nothing.
   *
   * The cook screen needs this to be honest about the split before anyone
   * commits: which jar each line comes out of, what is short, what could not be
   * measured. It shares `planFor` with the real thing rather than reimplementing
   * it, so what the user approves is what actually happens.
   */
  async previewMeal(plannedMealId: number, dto: CookDto) {
    const meal = await this.requireCookableMeal(plannedMealId);
    const planned = await this.planFor(
      meal.recipeId!,
      dto.servings ?? meal.servings,
      dto.pins,
    );
    return this.buildReport(planned, null);
  }

  /** The same preview for a recipe that is not on the calendar. */
  async previewRecipe(recipeId: number, dto: CookDto) {
    const recipe = await this.db.recipe.findFirst({
      where: { id: recipeId },
      select: { id: true, servings: true },
    });
    if (!recipe) throw new NotFoundException(`No recipe with id ${recipeId}.`);

    const planned = await this.planFor(recipeId, dto.servings ?? recipe.servings, dto.pins);
    return this.buildReport(planned, null);
  }

  private async requireCookableMeal(plannedMealId: number) {
    const meal = await this.db.plannedMeal.findFirst({
      where: { id: plannedMealId },
      select: { id: true, recipeId: true, servings: true, status: true, note: true },
    });
    if (!meal) throw new NotFoundException(`No planned meal with id ${plannedMealId}.`);

    if (meal.recipeId === null) {
      throw new BadRequestException(
        `"${meal.note ?? 'That entry'}" is a note, not a recipe, so there is ` +
          'nothing to deduct from the pantry.',
      );
    }
    if (meal.status === PlanStatus.COOKED) {
      throw new ConflictException(
        'That meal is already marked cooked. Undo the cook session first if you ' +
          'want to deduct it again.',
      );
    }

    return meal;
  }

  /**
   * Everything up to the point of writing: what the recipe needs, what the
   * pantry holds, and which lots each line would come out of.
   *
   * Split out from `deduct` so the preview and the real cook cannot drift. A
   * preview computed by a second code path would eventually promise one thing
   * and do another, which is worse than having no preview at all.
   */
  private async planFor(recipeId: number, servings: number, pins?: readonly CookPin[]) {
    const recipe = await this.db.recipe.findFirst({
      where: { id: recipeId },
      select: {
        id: true,
        title: true,
        servings: true,
        ingredients: {
          orderBy: { sortOrder: 'asc' },
          include: { unit: true, ingredient: { select: INGREDIENT_SELECT } },
        },
      },
    });
    if (!recipe) throw new NotFoundException(`No recipe with id ${recipeId}.`);

    const plan = planCook(toCookLines(recipe.ingredients), recipe.servings, servings);
    const withdrawals = mergeWithdrawals(plan.withdrawals);
    const pinByIngredient = indexPins(pins);

    // One query for every lot involved, rather than one per line.
    const lots = await this.db.pantryItem.findMany({
      where: { ingredientId: { in: withdrawals.map((w) => w.ingredientId) } },
      include: { unit: true },
      orderBy: { id: 'asc' },
    });

    const nameByIngredient = new Map(
      recipe.ingredients
        .filter((line) => line.ingredient !== null)
        .map((line) => [line.ingredient!.id, line.ingredient!.name]),
    );

    const physicalsByIngredient = new Map(
      recipe.ingredients
        .filter((line) => line.ingredient !== null)
        .map((line) => [
          line.ingredient!.id,
          {
            gramsPerMl: line.ingredient!.gramsPerMl?.toString() ?? null,
            gramsPerPiece: line.ingredient!.gramsPerPiece?.toString() ?? null,
          },
        ]),
    );

    const deductions = withdrawals.map((withdrawal) => {
      const ofIngredient = lots.filter(
        (lot) => lot.ingredientId === withdrawal.ingredientId,
      );

      const chosen = pinByIngredient.get(withdrawal.ingredientId) ?? {};
      const name = nameByIngredient.get(withdrawal.ingredientId) ?? withdrawal.rawText;

      // Aborts the whole cook rather than quietly ignoring the selection.
      // Deducting from a different jar than the one the cook named is the one
      // outcome they explicitly ruled out.
      const selected = resolveSelection(ofIngredient, chosen, name);

      const relevant: BalanceLot[] = selected.lots.map((lot) => ({
        id: lot.id,
        quantity: lot.quantity.toString(),
        unit: toUnitDef(lot.unit),
        expiresOn: lot.expiresOn,
      }));

      const need = { quantity: withdrawal.quantity, unit: withdrawal.unit };
      const physicals = physicalsByIngredient.get(withdrawal.ingredientId);

      return {
        withdrawal,
        pin: selected.kind === 'auto' ? selected.pin : null,
        explicit: selected.kind === 'explicit',
        result:
          selected.kind === 'explicit'
            ? planExplicitDeduction(need, selected.draws, relevant, physicals)
            : planDeduction(need, relevant, physicals),
      };
    });

    return {
      recipe,
      servings,
      skipped: plan.skipped,
      deductions,
      unitByLot: new Map(lots.map((lot) => [lot.id, lot.unitId])),
    };
  }

  private async deduct(
    recipeId: number,
    servings: number,
    userId: number,
    context: { plannedMealId?: number; note?: string; pins?: readonly CookPin[] },
  ) {
    const planned = await this.planFor(recipeId, servings, context.pins);
    const { recipe, deductions, unitByLot } = planned;

    const session = await this.db.$transaction(async (tx) => {
      const created = await tx.cookSession.create({
        data: {
          plannedMealId: context.plannedMealId ?? null,
          recipeId: recipe.id,
          servings,
          note: context.note?.trim() || null,
        } as never,
      });

      for (const { withdrawal, result } of deductions) {
        for (const allocation of result.allocations) {
          await tx.pantryItem.update({
            where: { id: allocation.lotId },
            data: { quantity: allocation.remaining.toString() } as never,
          });

          await tx.pantryTransaction.create({
            data: {
              pantryItemId: allocation.lotId,
              ingredientId: withdrawal.ingredientId,
              delta: allocation.take.negated().toString(),
              unitId: unitByLot.get(allocation.lotId)!,
              kind: TxKind.COOK,
              cookSessionId: created.id,
              createdById: userId,
            } as never,
          });
        }
      }

      return created;
    });

    return this.buildReport(planned, session.id);
  }

  /**
   * The report both the preview and the real cook return.
   *
   * `cookSessionId` is null for a preview — the one field that tells the two
   * apart, and the only thing a caller needs to know about which it is holding.
   */
  private buildReport(planned: PlannedCook, cookSessionId: number | null) {
    const { recipe, servings, deductions, skipped } = planned;

    const shortfalls = deductions
      .filter(
        ({ result }) =>
          result.shortfall.gt(0) ||
          result.unusable.length > 0 ||
          result.unmeasured.length > 0,
      )
      .map(({ withdrawal, pin, result }) => ({
        ingredientId: withdrawal.ingredientId,
        rawText: withdrawal.rawText,
        wanted: withdrawal.quantity.toString(),
        got: result.allocated.toString(),
        short: result.shortfall.toString(),
        unit: withdrawal.unit,
        pinned: pin,
        unusableLots: result.unusable,
        // Taken as instructed, but not countable towards the need above.
        unmeasuredLots: result.unmeasured.map((entry) => ({
          lotId: entry.lotId,
          unit: entry.unit,
          reason: entry.reason,
          took: entry.took.toString(),
        })),
      }));

    return {
      cookSessionId,
      recipe: { id: recipe.id, title: recipe.title },
      servings,
      scaledFrom: recipe.servings,
      deducted: deductions.map(({ withdrawal, pin, explicit, result }) => ({
        ingredientId: withdrawal.ingredientId,
        rawText: withdrawal.rawText,
        took: result.allocated.toString(),
        // What the recipe asked for. Only ever equalled `took` before amounts
        // could be typed by hand; now a cook can knowingly use more or less.
        needed: withdrawal.quantity.toString(),
        // Computed here, in Decimal, rather than left for the client to
        // subtract — a displayed quantity must never go through a float.
        // Empty when nothing was used beyond the recipe.
        over: Decimal.max(result.allocated.minus(withdrawal.quantity), 0)
          .toString()
          .replace(/^0$/, ''),
        unit: withdrawal.unit,
        pinned: pin,
        explicit,
        fromLots: result.allocations.map((a) => ({
          lotId: a.lotId,
          took: a.take.toString(),
          remaining: a.remaining.toString(),
        })),
      })),
      // Everything the deduction could not reach, so nothing is silently lost.
      shortfalls,
      skipped,
    };
  }

  listSessions(limit = 50) {
    return this.db.cookSession.findMany({
      include: {
        recipe: { select: { id: true, title: true, slug: true } },
        _count: { select: { transactions: true } },
      },
      orderBy: { cookedOn: 'desc' },
      take: Math.min(limit, 200),
    });
  }

  /**
   * Reverses a cook, putting every deducted amount back where it came from.
   *
   * The original ledger entries are **not deleted** — the ledger is append-only,
   * and "this was cooked then un-cooked" is a truer history than "this never
   * happened". Undo writes the opposite entries and stamps `reversedOn`, which is
   * what stops a second undo from restoring the same quantities twice.
   *
   * A lot thrown away since the cook cannot receive its stock back. That is
   * reported rather than recreated: inventing a lot that the user deliberately
   * discarded would put food back on a shelf that is empty.
   */
  async undo(cookSessionId: number, userId: number) {
    const session = await this.db.cookSession.findFirst({
      where: { id: cookSessionId },
      include: {
        transactions: {
          select: { id: true, pantryItemId: true, ingredientId: true, delta: true, unitId: true },
        },
      },
    });
    if (!session) throw new NotFoundException(`No cook session with id ${cookSessionId}.`);
    if (session.reversedOn) {
      throw new ConflictException('That cook has already been undone.');
    }

    const lotIds = session.transactions
      .map((tx) => tx.pantryItemId)
      .filter((id): id is number => id !== null);
    const survivingLots = await this.db.pantryItem.findMany({
      where: { id: { in: lotIds } },
      select: { id: true, quantity: true },
    });
    const quantityByLot = new Map(survivingLots.map((lot) => [lot.id, lot.quantity]));

    const restored: Array<{ lotId: number; by: string }> = [];
    const lostLots: Array<{ lotId: number; wouldRestore: string }> = [];

    await this.db.$transaction(async (tx) => {
      for (const entry of session.transactions) {
        const putBack = new Decimal(entry.delta).negated();
        if (putBack.lte(0)) continue;

        const current = entry.pantryItemId
          ? quantityByLot.get(entry.pantryItemId)
          : undefined;

        if (current === undefined) {
          lostLots.push({
            lotId: entry.pantryItemId ?? -1,
            wouldRestore: putBack.toString(),
          });
          continue;
        }

        await tx.pantryItem.update({
          where: { id: entry.pantryItemId! },
          data: { quantity: new Decimal(current).add(putBack).toString() } as never,
        });

        await tx.pantryTransaction.create({
          data: {
            pantryItemId: entry.pantryItemId,
            ingredientId: entry.ingredientId,
            delta: putBack.toString(),
            unitId: entry.unitId,
            kind: TxKind.ADJUST,
            // Deliberately not linked to the session: linking would make the
            // reversal look like part of the cook it undoes.
            note: `Undo of cook session ${cookSessionId}`,
            createdById: userId,
          } as never,
        });

        restored.push({ lotId: entry.pantryItemId!, by: putBack.toString() });
      }

      await tx.cookSession.update({
        where: { id: cookSessionId },
        data: { reversedOn: new Date() },
      });

      if (session.plannedMealId) {
        await tx.plannedMeal.updateMany({
          where: { id: session.plannedMealId },
          data: { status: PlanStatus.PLANNED },
        });
      }
    });

    return { cookSessionId, restored, lostLots };
  }
}

const INGREDIENT_SELECT = {
  id: true,
  name: true,
  gramsPerMl: true,
  gramsPerPiece: true,
} as const;

/** What `planFor` hands to `buildReport` and to the transaction. */
interface PlannedCook {
  recipe: { id: number; title: string; servings: number };
  servings: number;
  skipped: ReturnType<typeof planCook>['skipped'];
  deductions: Array<{
    withdrawal: Withdrawal;
    pin: DeductionPin | null;
    /** True when the cook stated the split rather than letting it be worked out. */
    explicit: boolean;
    result: DeductionPlan;
  }>;
  unitByLot: Map<number, number>;
}

/**
 * Indexes the cook's pins by ingredient.
 *
 * Two pins for one ingredient is rejected rather than last-one-wins: the two
 * say different things about the same line, and silently honouring one of them
 * would deduct from a jar the user did not choose.
 */
function indexPins(pins: readonly CookPin[] | undefined): Map<number, Selection> {
  const byIngredient = new Map<number, Selection>();
  for (const pin of pins ?? []) {
    if (byIngredient.has(pin.ingredientId)) {
      throw new BadRequestException(
        `Two different lots were picked for the same ingredient (${pin.ingredientId}).`,
      );
    }
    byIngredient.set(pin.ingredientId, {
      pin: { lotId: pin.lotId, productId: pin.productId },
      draws: pin.draws,
    });
  }
  return byIngredient;
}

/** Narrows recipe rows into the shape the pure cook planner expects. */
function toCookLines(
  lines: ReadonlyArray<{
    id: number;
    rawText: string;
    ingredientId: number | null;
    quantity: unknown;
    optional: boolean;
    unit: { id: number; name: string; kind: string; toBaseFactor: unknown } | null;
  }>,
): CookLine[] {
  return lines.map((line) => ({
    id: line.id,
    rawText: line.rawText,
    ingredientId: line.ingredientId,
    quantity: line.quantity === null ? null : String(line.quantity),
    unit: line.unit ? toUnitDef(line.unit as never) : null,
    optional: line.optional,
  }));
}
