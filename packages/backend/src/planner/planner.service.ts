import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PlanStatus } from '@recipes/shared-types';

import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.service';
import type {
  CreatePlannedMealDto,
  PlannerQueryDto,
  UpdatePlannedMealDto,
} from './dto/planner.dto';

/** A range wider than this is a mistake, not a plan. */
const MAX_RANGE_DAYS = 400;

const MEAL_INCLUDE = {
  recipe: {
    select: {
      id: true,
      title: true,
      slug: true,
      servings: true,
      prepMinutes: true,
      cookMinutes: true,
      imagePath: true,
      archivedOn: true,
    },
  },
  cookSessions: {
    select: { id: true, cookedOn: true, servings: true, reversedOn: true },
    orderBy: { cookedOn: 'desc' },
  },
} as const;

@Injectable()
export class PlannerService {
  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantPrisma) {}

  /**
   * The calendar between two dates, inclusive.
   *
   * Returned flat and already ordered by (date, slot, sortOrder) rather than
   * pre-grouped into a grid: the week view, the month view and shopping-list
   * generation all want different groupings of the same rows.
   */
  async range(query: PlannerQueryDto) {
    const from = parseDate(query.from, 'from');
    const to = parseDate(query.to, 'to');

    if (to < from) {
      throw new BadRequestException('`to` is before `from`.');
    }
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (days > MAX_RANGE_DAYS) {
      throw new BadRequestException(
        `That range covers ${days} days; ${MAX_RANGE_DAYS} is the most at once.`,
      );
    }

    return this.db.plannedMeal.findMany({
      where: { date: { gte: from, lte: to } },
      include: MEAL_INCLUDE,
      orderBy: [{ date: 'asc' }, { slot: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    });
  }

  async findOne(id: number) {
    const meal = await this.db.plannedMeal.findFirst({
      where: { id },
      include: MEAL_INCLUDE,
    });
    if (!meal) throw new NotFoundException(`No planned meal with id ${id}.`);
    return meal;
  }

  async create(dto: CreatePlannedMealDto, userId: number) {
    const date = parseDate(dto.date, 'date');

    if (dto.recipeId === undefined && !dto.note?.trim()) {
      throw new BadRequestException(
        'A planned meal needs either a recipe or a note — "leftovers" is a plan, ' +
          'an empty slot is not.',
      );
    }

    const recipe = dto.recipeId ? await this.requireRecipe(dto.recipeId) : null;

    return this.db.plannedMeal.create({
      data: {
        date,
        slot: dto.slot,
        recipeId: dto.recipeId ?? null,
        note: dto.note?.trim() || null,
        // Defaulting to the recipe's own count means the common case — cooking it
        // as written — needs no scaling and no decision from the user.
        servings: dto.servings ?? recipe?.servings ?? 1,
        sortOrder: dto.sortOrder ?? (await this.nextSortOrder(date, dto.slot)),
        createdById: userId,
      } as never,
      include: MEAL_INCLUDE,
    });
  }

  async update(id: number, dto: UpdatePlannedMealDto) {
    await this.findOne(id);

    const data: Record<string, unknown> = {};
    if (dto.date !== undefined) data.date = parseDate(dto.date, 'date');
    if (dto.slot !== undefined) data.slot = dto.slot;
    if (dto.servings !== undefined) data.servings = dto.servings;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.note !== undefined) data.note = dto.note?.trim() || null;
    if (dto.status !== undefined) data.status = dto.status;

    return this.db.plannedMeal.update({
      where: { id },
      data: data as never,
      include: MEAL_INCLUDE,
    });
  }

  /**
   * Removes an entry from the calendar.
   *
   * A meal that has been cooked keeps its `CookSession` rows, so removing it from
   * the plan does not erase the pantry history it caused — the session simply
   * stops pointing at a planned meal.
   */
  async remove(id: number) {
    await this.findOne(id);
    await this.db.cookSession.updateMany({
      where: { plannedMealId: id },
      data: { plannedMealId: null },
    });
    await this.db.plannedMeal.delete({ where: { id } });
    return { id };
  }

  private async requireRecipe(id: number) {
    const recipe = await this.db.recipe.findFirst({
      where: { id },
      select: { id: true, servings: true, archivedOn: true, title: true },
    });
    if (!recipe) throw new BadRequestException(`Unknown recipe id: ${id}.`);
    if (recipe.archivedOn) {
      throw new BadRequestException(
        `"${recipe.title}" is archived. Restore it before planning it.`,
      );
    }
    return recipe;
  }

  /** Appends to the end of the slot so a new entry does not displace an existing one. */
  private async nextSortOrder(date: Date, slot: string): Promise<number> {
    const last = await this.db.plannedMeal.findFirst({
      where: { date, slot: slot as never },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    return last ? last.sortOrder + 1 : 0;
  }
}

/**
 * Parses a `YYYY-MM-DD` into the UTC midnight Postgres stores in a `date` column.
 *
 * Going through `new Date('2026-08-01')` alone is right, but constructing from
 * local parts is not: on a machine behind UTC, `new Date(2026, 7, 1)` is the 31st
 * of July once converted, and a meal planned for Saturday shows up on Friday.
 */
export function parseDate(value: string, field: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new BadRequestException(`${field} must be a date (YYYY-MM-DD).`);
  }

  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));

  // Rejects 2026-02-30, which Date would happily roll into March.
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    throw new BadRequestException(`${field} is not a real date: ${value}.`);
  }

  return date;
}

export { PlanStatus };
