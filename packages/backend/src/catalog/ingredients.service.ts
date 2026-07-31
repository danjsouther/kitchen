import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { matchCandidates, slugify } from '@recipes/shared-types';

import { requireHouseholdId } from '../common/household-context';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.service';
import type {
  CreateIngredientDto,
  IngredientQueryDto,
  UpdateIngredientDto,
} from './dto/catalog.dto';

/** Search results are capped so an empty query cannot pull the whole catalog. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const LIST_SELECT = {
  id: true,
  householdId: true,
  name: true,
  slug: true,
  categoryId: true,
  defaultUnitId: true,
  gramsPerMl: true,
  gramsPerPiece: true,
  shelfLifeDays: true,
  note: true,
} as const;

@Injectable()
export class IngredientsService {
  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantPrisma) {}

  listCategories() {
    return this.db.ingredientCategory.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  /**
   * Searches the catalog the household can see: the seeded global rows plus its
   * own. Aliases are searched too, so "scallions" finds green onion.
   */
  async search(query: IngredientQueryDto) {
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    const rows = await this.db.ingredient.findMany({
      where: buildIngredientWhere(query),
      select: { ...LIST_SELECT, aliases: { select: { alias: true } } },
      orderBy: { name: 'asc' },
      // Over-fetch: preferOwn collapses global/own pairs, so taking exactly
      // `limit` here could return fewer rows than asked for.
      take: limit * 2,
    });

    return preferOwn(rows).slice(0, limit);
  }

  async findOne(id: number) {
    const ingredient = await this.db.ingredient.findFirst({
      where: { id },
      select: { ...LIST_SELECT, aliases: { select: { id: true, alias: true } } },
    });
    if (!ingredient) throw new NotFoundException(`No ingredient with id ${id}.`);
    return ingredient;
  }

  /** Adds an ingredient owned by this household. */
  async create(dto: CreateIngredientDto) {
    const name = dto.name.trim();
    const slug = slugify(name);
    if (!slug) {
      throw new BadRequestException('That name has no letters or digits to index on.');
    }

    const householdId = requireHouseholdId();
    const mine = await this.db.ingredient.findFirst({
      where: { slug, householdId },
      select: { id: true },
    });
    if (mine) {
      throw new ConflictException(`You already have an ingredient called "${name}".`);
    }

    await this.assertReferencesExist(dto);

    return this.db.ingredient.create({
      data: {
        name,
        slug,
        categoryId: dto.categoryId ?? null,
        defaultUnitId: dto.defaultUnitId ?? null,
        gramsPerMl: dto.gramsPerMl ?? null,
        gramsPerPiece: dto.gramsPerPiece ?? null,
        shelfLifeDays: dto.shelfLifeDays ?? null,
        note: dto.note?.trim() || null,
      } as never,
      select: LIST_SELECT,
    });
  }

  /**
   * Edits an ingredient this household owns.
   *
   * Global rows are refused rather than silently ignored. The tenancy extension
   * already scopes catalog *writes* to the household's own rows, so an attempt on
   * a global row would otherwise update nothing and report success — a confusing
   * result when the user is looking at the density they just typed.
   */
  async update(id: number, dto: UpdateIngredientDto) {
    const existing = await this.db.ingredient.findFirst({
      where: { id },
      select: { id: true, householdId: true, name: true },
    });
    if (!existing) throw new NotFoundException(`No ingredient with id ${id}.`);

    if (existing.householdId === null) {
      throw new ForbiddenException(
        `"${existing.name}" is part of the shared catalog and cannot be edited ` +
          'directly. Make your own copy of it first, then edit that.',
      );
    }

    await this.assertReferencesExist(dto);

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      data.name = dto.name.trim();
      data.slug = slugify(dto.name);
    }
    // Null is passed straight through, and that is the point: it is how the
    // caller says "this has no density" as opposed to "I am not touching the
    // density". Absent stays absent, so a partial edit still leaves the rest
    // alone.
    for (const field of [
      'categoryId',
      'defaultUnitId',
      'gramsPerMl',
      'gramsPerPiece',
      'shelfLifeDays',
      'note',
    ] as const) {
      if (dto[field] !== undefined) data[field] = dto[field];
    }

    return this.db.ingredient.update({
      where: { id },
      data: data as never,
      select: LIST_SELECT,
    });
  }

  /**
   * Copies a global ingredient into a household-owned one.
   *
   * This is how a household corrects or completes shared catalog data — a
   * missing density on an unusual item, a piece weight that does not match the
   * eggs they actually buy — without editing rows every other household reads.
   * The copy keeps the original slug, and `search` prefers it over the global
   * row, so from that point on the household sees only its own version.
   */
  async customize(id: number) {
    const source = await this.db.ingredient.findFirst({
      where: { id },
      select: { ...LIST_SELECT, aliases: { select: { alias: true, slug: true } } },
    });
    if (!source) throw new NotFoundException(`No ingredient with id ${id}.`);

    if (source.householdId !== null) {
      throw new ConflictException(
        `"${source.name}" already belongs to your household — edit it directly.`,
      );
    }

    const householdId = requireHouseholdId();
    const mine = await this.db.ingredient.findFirst({
      where: { slug: source.slug, householdId },
      select: { id: true },
    });
    if (mine) {
      throw new ConflictException(
        `You already have your own version of "${source.name}".`,
      );
    }

    return this.db.ingredient.create({
      data: {
        name: source.name,
        slug: source.slug,
        categoryId: source.categoryId,
        defaultUnitId: source.defaultUnitId,
        gramsPerMl: source.gramsPerMl,
        gramsPerPiece: source.gramsPerPiece,
        shelfLifeDays: source.shelfLifeDays,
        note: source.note,
        aliases: { create: source.aliases.map((a) => ({ alias: a.alias, slug: a.slug })) },
      } as never,
      select: LIST_SELECT,
    });
  }

  /**
   * Loads the given ingredient ids with the physical data conversions need,
   * failing if any is not visible to this household.
   */
  async resolve(ids: readonly number[]) {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return new Map<number, IngredientRow>();

    const rows = await this.db.ingredient.findMany({
      where: { id: { in: wanted } },
      select: LIST_SELECT,
    });

    const missing = wanted.filter((id) => !rows.some((row) => row.id === id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Unknown ingredient ${missing.length === 1 ? 'id' : 'ids'}: ${missing.join(', ')}.`,
      );
    }

    return new Map(rows.map((row) => [row.id, row as IngredientRow]));
  }

  /**
   * Checks category and unit references before writing.
   *
   * Without this a bad id surfaces as a raw foreign-key violation — a 500 with a
   * constraint name in it, rather than a message naming the field at fault.
   */
  /**
   * Checks the ids a write points at.
   *
   * Null is skipped rather than looked up: on an update it means "clear this
   * link", and there is no row with a null id to find. Handing it to Prisma
   * anyway is a query error — a 500 for what is a perfectly ordinary edit.
   */
  private async assertReferencesExist(dto: {
    categoryId?: number | null;
    defaultUnitId?: number | null;
  }): Promise<void> {
    if (dto.categoryId !== undefined && dto.categoryId !== null) {
      const category = await this.db.ingredientCategory.findUnique({
        where: { id: dto.categoryId },
        select: { id: true },
      });
      if (!category) {
        throw new BadRequestException(`Unknown category id: ${dto.categoryId}.`);
      }
    }

    if (dto.defaultUnitId !== undefined && dto.defaultUnitId !== null) {
      const unit = await this.db.unit.findFirst({
        where: { id: dto.defaultUnitId },
        select: { id: true },
      });
      if (!unit) {
        throw new BadRequestException(`Unknown unit id: ${dto.defaultUnitId}.`);
      }
    }
  }
}

/**
 * Builds the catalog search filter.
 *
 * Matching goes through `matchCandidates`, which yields the slug and its
 * singular form, because people type plurals: a search for "scallions" has to
 * find the ingredient stored as "scallion", and "carrots" has to find "carrot".
 * A plain `contains` on the typed text finds neither — the stored value is
 * shorter than the query, so it cannot contain it.
 *
 * Exported so the combinations can be tested without a database.
 */
export function buildIngredientWhere(
  query: IngredientQueryDto,
): Record<string, unknown> | undefined {
  const filters: Record<string, unknown>[] = [];
  if (query.categoryId) filters.push({ categoryId: query.categoryId });

  const term = query.q?.trim();
  if (term) {
    const candidates = matchCandidates(term);
    filters.push({
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        ...candidates.map((slug) => ({ slug: { contains: slug } })),
        ...candidates.map((slug) => ({
          aliases: { some: { slug: { contains: slug } } },
        })),
      ],
    });
  }

  return filters.length > 0 ? { AND: filters } : undefined;
}

export interface IngredientRow {
  id: number;
  householdId: number | null;
  name: string;
  slug: string;
  gramsPerMl: unknown;
  gramsPerPiece: unknown;
}

/**
 * Collapses global/own pairs of the same slug, keeping the household's own.
 *
 * A household that customized "all-purpose flour" has two rows with that slug:
 * the seeded one and theirs. Showing both in a picker is worse than useless —
 * they look identical and only one carries the corrected density.
 */
export function preferOwn<T extends { slug: string; householdId: number | null }>(
  rows: readonly T[],
): T[] {
  const owned = new Set(
    rows.filter((row) => row.householdId !== null).map((row) => row.slug),
  );
  return rows.filter((row) => row.householdId !== null || !owned.has(row.slug));
}
