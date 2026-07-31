import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { PlanStatus, TxKind } from '@recipes/shared-types';

import { toUnitDef } from '../catalog/units.service';
import { planDeduction } from '../pantry/deduction';
import type { BalanceLot } from '../pantry/pantry-balance';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.service';
import { mergeWithdrawals, planCook, type CookLine } from './cook-plan';
import type { CookDto } from './dto/planner.dto';

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

    const servings = dto.servings ?? meal.servings;
    const report = await this.deduct(meal.recipeId, servings, userId, {
      plannedMealId: meal.id,
      note: dto.note,
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
    });
  }

  private async deduct(
    recipeId: number,
    servings: number,
    userId: number,
    context: { plannedMealId?: number; note?: string },
  ) {
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

    // One query for every lot involved, rather than one per line.
    const lots = await this.db.pantryItem.findMany({
      where: { ingredientId: { in: withdrawals.map((w) => w.ingredientId) } },
      include: { unit: true },
      orderBy: { id: 'asc' },
    });

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
      const relevant: BalanceLot[] = lots
        .filter((lot) => lot.ingredientId === withdrawal.ingredientId)
        .map((lot) => ({
          id: lot.id,
          quantity: lot.quantity.toString(),
          unit: toUnitDef(lot.unit),
          expiresOn: lot.expiresOn,
        }));

      return {
        withdrawal,
        result: planDeduction(
          { quantity: withdrawal.quantity, unit: withdrawal.unit },
          relevant,
          physicalsByIngredient.get(withdrawal.ingredientId),
        ),
      };
    });

    const unitByLot = new Map(lots.map((lot) => [lot.id, lot.unitId]));

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

    const shortfalls = deductions
      .filter(({ result }) => result.shortfall.gt(0) || result.unusable.length > 0)
      .map(({ withdrawal, result }) => ({
        ingredientId: withdrawal.ingredientId,
        rawText: withdrawal.rawText,
        wanted: withdrawal.quantity.toString(),
        got: result.allocated.toString(),
        short: result.shortfall.toString(),
        unit: withdrawal.unit,
        unusableLots: result.unusable,
      }));

    return {
      cookSessionId: session.id,
      recipe: { id: recipe.id, title: recipe.title },
      servings,
      scaledFrom: recipe.servings,
      deducted: deductions.map(({ withdrawal, result }) => ({
        ingredientId: withdrawal.ingredientId,
        rawText: withdrawal.rawText,
        took: result.allocated.toString(),
        unit: withdrawal.unit,
        fromLots: result.allocations.map((a) => ({
          lotId: a.lotId,
          took: a.take.toString(),
          remaining: a.remaining.toString(),
        })),
      })),
      // Everything the deduction could not reach, so nothing is silently lost.
      shortfalls,
      skipped: plan.skipped,
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
