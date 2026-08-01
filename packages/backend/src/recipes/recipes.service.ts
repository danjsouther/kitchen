import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  TagKind,
  formatWithUnit,
  scaleForServings,
  slugify,
} from '@kitchen/shared-types';

import { uniqueSlug } from '../common/unique-slug';
import { IngredientsService } from '../catalog/ingredients.service';
import { UnitsService, toUnitDef } from '../catalog/units.service';
import { resolveLimit } from '../common/pagination';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.service';
import type {
  CreateRecipeDto,
  RecipeIngredientDto,
  RecipeQueryDto,
  RecipeTagDto,
  UpdateRecipeDto,
} from './dto/recipe.dto';

/** A unit row with everything needed both to convert and to label a quantity. */
interface UnitLabelRow {
  id: number;
  name: string;
  plural: string;
  abbrev: string | null;
  kind: string;
  toBaseFactor: { toString(): string };
}

/** Everything a detail view needs, in one round trip. */
const DETAIL_INCLUDE = {
  ingredients: {
    orderBy: { sortOrder: 'asc' },
    include: {
      ingredient: {
        select: {
          id: true,
          name: true,
          slug: true,
          gramsPerMl: true,
          gramsPerPiece: true,
          defaultUnitId: true,
        },
      },
      unit: true,
    },
  },
  steps: { orderBy: { sortOrder: 'asc' } },
  tags: { include: { tag: true } },
  createdBy: { select: { id: true, displayName: true } },
} as const;

@Injectable()
export class RecipesService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly units: UnitsService,
    private readonly ingredients: IngredientsService,
  ) {}

  // -- Reads ---------------------------------------------------------------

  /**
   * The collection view: title, timings, tags and counts, but not the full
   * ingredient and step bodies. A hundred recipes' worth of steps is a lot of
   * payload for a screen that shows none of it.
   */
  async findAll(query: RecipeQueryDto) {
    const limit = resolveLimit(query.limit);
    const where = buildRecipeWhere(query);

    const [total, rows] = await Promise.all([
      this.db.recipe.count({ where }),
      this.db.recipe.findMany({
        where,
        orderBy: { title: 'asc' },
        skip: query.offset ?? 0,
        take: limit,
        select: {
          id: true,
          title: true,
          slug: true,
          description: true,
          servings: true,
          prepMinutes: true,
          cookMinutes: true,
          imagePath: true,
          archivedOn: true,
          updatedOn: true,
          tags: { include: { tag: { select: { id: true, name: true, slug: true, kind: true } } } },
          _count: { select: { ingredients: true, steps: true } },
        },
      }),
    ]);

    return {
      total,
      limit,
      offset: query.offset ?? 0,
      items: rows.map((row) => ({
        ...row,
        tags: row.tags.map((link) => link.tag),
        ingredientCount: row._count.ingredients,
        stepCount: row._count.steps,
        _count: undefined,
      })),
    };
  }

  async findOne(id: number) {
    const recipe = await this.db.recipe.findFirst({
      where: { id },
      include: DETAIL_INCLUDE,
    });
    if (!recipe) throw new NotFoundException(`No recipe with id ${id}.`);
    return shapeDetail(recipe);
  }

  async findBySlug(slug: string) {
    const recipe = await this.db.recipe.findFirst({
      where: { slug },
      include: DETAIL_INCLUDE,
    });
    if (!recipe) throw new NotFoundException(`No recipe called "${slug}".`);
    return shapeDetail(recipe);
  }

  /**
   * The recipe with every quantity scaled to a different serving count.
   *
   * Scaling always runs from the stored values, never from a previous scaling —
   * `scaleForServings` is given the recipe's own `servings` every time, so
   * viewing at 6 then at 4 gives exactly the same numbers as going straight to 4.
   * Rounding happens only in the `display` string; `quantity` stays exact.
   */
  async scaled(id: number, servings: number) {
    const recipe = await this.findOne(id);
    const factorFrom = recipe.servings;

    return {
      ...recipe,
      servings,
      originalServings: factorFrom,
      ingredients: recipe.ingredients.map((line) => {
        if (line.quantity === null || line.quantity === undefined) {
          // "Salt to taste" does not scale, and inventing a number for it would
          // be worse than leaving it as written.
          return { ...line, scaled: null };
        }

        const quantity = scaleForServings(line.quantity as never, factorFrom, servings);
        const unit = line.unit as UnitLabelRow | null;
        return {
          ...line,
          scaled: {
            quantity: quantity.toString(),
            // `plural` and `abbrev` are carried alongside the conversion fields:
            // formatWithUnit needs them to render "750 g" and "2 cups" rather
            // than "750 grams" and "2 cups"'s clumsier fallback.
            display: unit
              ? formatWithUnit(quantity, {
                  ...toUnitDef(unit),
                  plural: unit.plural,
                  abbrev: unit.abbrev,
                })
              : quantity.toString(),
          },
        };
      }),
    };
  }

  // -- Writes --------------------------------------------------------------

  async create(dto: CreateRecipeDto, userId: number) {
    await this.validateLines(dto.ingredients);

    const slug = await uniqueSlug(dto.title, (candidate) => this.slugTaken(candidate));
    const tagIds = await this.resolveTags(dto.tags ?? []);

    const created = await this.db.recipe.create({
      data: {
        title: dto.title.trim(),
        slug,
        description: dto.description?.trim() || null,
        servings: dto.servings,
        prepMinutes: dto.prepMinutes ?? null,
        cookMinutes: dto.cookMinutes ?? null,
        sourceUrl: dto.sourceUrl ?? null,
        sourceNote: dto.sourceNote?.trim() || null,
        notes: dto.notes?.trim() || null,
        createdById: userId,
        ingredients: { create: dto.ingredients.map(toIngredientRow) },
        steps: { create: dto.steps.map(toStepRow) },
        tags: { create: tagIds.map((tagId) => ({ tagId })) },
      } as never,
      include: DETAIL_INCLUDE,
    });

    return shapeDetail(created);
  }

  /**
   * Scalars merge; collections replace.
   *
   * Supplying `ingredients` replaces the whole list rather than patching rows by
   * id, because `sortOrder` is positional — reordering, inserting and deleting
   * lines all rewrite it, and a merge would need the client to reconcile that
   * correctly on every edit. The edit screen sends the full list it is showing,
   * which is also exactly what the parse-review screen produces.
   */
  async update(id: number, dto: UpdateRecipeDto) {
    const existing = await this.db.recipe.findFirst({
      where: { id },
      select: { id: true, title: true, slug: true },
    });
    if (!existing) throw new NotFoundException(`No recipe with id ${id}.`);

    if (dto.ingredients) await this.validateLines(dto.ingredients);

    const data: Record<string, unknown> = {};

    if (dto.title !== undefined) {
      data.title = dto.title.trim();
      // Only re-slug when the title genuinely changed: a rename that happens to
      // produce the same slug should keep the URL, and re-slugging on every save
      // would churn `chili` into `chili-2`.
      if (slugify(dto.title) !== slugify(existing.title)) {
        data.slug = await uniqueSlug(dto.title, (candidate) =>
          this.slugTaken(candidate, id),
        );
      }
    }

    if (dto.servings !== undefined) data.servings = dto.servings;

    // An empty string clears a nullable text column rather than storing "".
    //
    // Without this an edit screen can add a description but never take one away,
    // since an absent field means "leave alone" — the same gap the catalog form
    // has with densities. The column is `String?`, so the honest representation
    // of "the cook removed this" is null, not "".
    for (const field of ['description', 'sourceUrl', 'sourceNote', 'notes'] as const) {
      const value = dto[field];
      if (value !== undefined) data[field] = value.trim() || null;
    }

    // Zero clears the minute columns for the same reason. `Int?` has no way to
    // say "exactly no prep", and the create path already treats 0 as absent, so
    // reading it as "not recorded" is what the app has always meant by it.
    for (const field of ['prepMinutes', 'cookMinutes'] as const) {
      const value = dto[field];
      if (value !== undefined) data[field] = value > 0 ? value : null;
    }

    if (dto.ingredients) {
      data.ingredients = {
        deleteMany: {},
        create: dto.ingredients.map(toIngredientRow),
      };
    }
    if (dto.steps) {
      data.steps = { deleteMany: {}, create: dto.steps.map(toStepRow) };
    }
    if (dto.tags) {
      const tagIds = await this.resolveTags(dto.tags);
      data.tags = { deleteMany: {}, create: tagIds.map((tagId) => ({ tagId })) };
    }

    const updated = await this.db.recipe.update({
      where: { id },
      data: data as never,
      include: DETAIL_INCLUDE,
    });

    return shapeDetail(updated);
  }

  /**
   * Archives rather than deletes.
   *
   * A recipe that has been planned or cooked is referenced by `PlannedMeal` and
   * `CookSession` rows that are history — deleting it would either destroy that
   * history or fail on a foreign key, neither of which is what "remove from my
   * collection" should mean.
   */
  async archive(id: number) {
    const { count } = await this.db.recipe.updateMany({
      where: { id, archivedOn: null },
      data: { archivedOn: new Date() },
    });
    if (count === 0) {
      // Either it does not exist or it is already archived; distinguish so the
      // second case is not reported as a missing recipe.
      await this.assertExists(id);
      throw new ConflictException('That recipe is already archived.');
    }
    return this.findOne(id);
  }

  async restore(id: number) {
    const { count } = await this.db.recipe.updateMany({
      where: { id, archivedOn: { not: null } },
      data: { archivedOn: null },
    });
    if (count === 0) {
      await this.assertExists(id);
      throw new ConflictException('That recipe is not archived.');
    }
    return this.findOne(id);
  }

  // -- Internals -----------------------------------------------------------

  private async assertExists(id: number): Promise<void> {
    const found = await this.db.recipe.findFirst({ where: { id }, select: { id: true } });
    if (!found) throw new NotFoundException(`No recipe with id ${id}.`);
  }

  private async slugTaken(slug: string, exceptId?: number): Promise<boolean> {
    const row = await this.db.recipe.findFirst({
      where: exceptId ? { slug, id: { not: exceptId } } : { slug },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * Checks every referenced ingredient and unit before writing anything.
   *
   * Done up front rather than relying on foreign keys so a bad id produces a 400
   * naming the field, not a 500 carrying a constraint name.
   */
  private async validateLines(lines: readonly RecipeIngredientDto[]): Promise<void> {
    for (const [index, line] of lines.entries()) {
      // A unit with no quantity means nothing — "cups of flour" is not an amount.
      if (line.unitId !== undefined && line.quantity === undefined) {
        throw new BadRequestException(
          `Ingredient line ${index + 1} ("${line.rawText}") has a unit but no quantity.`,
        );
      }
    }

    await this.units.resolve(
      lines.map((line) => line.unitId).filter((id): id is number => id !== undefined),
    );
    await this.ingredients.resolve(
      lines
        .map((line) => line.ingredientId)
        .filter((id): id is number => id !== undefined),
    );
  }

  /**
   * Turns tag names into tag ids, creating any the household has not used before.
   *
   * Matching is by slug, so "Weeknight" and "weeknight" are the same tag rather
   * than two entries that differ only in case.
   */
  private async resolveTags(tags: readonly RecipeTagDto[]): Promise<number[]> {
    const wanted = new Map<string, RecipeTagDto>();
    for (const tag of tags) {
      const slug = slugify(tag.name);
      if (slug) wanted.set(slug, tag);
    }
    if (wanted.size === 0) return [];

    const existing = await this.db.tag.findMany({
      where: { slug: { in: [...wanted.keys()] } },
      select: { id: true, slug: true },
    });
    const bySlug = new Map(existing.map((tag) => [tag.slug, tag.id]));

    for (const [slug, tag] of wanted) {
      if (bySlug.has(slug)) continue;
      const created = await this.db.tag.create({
        data: { name: tag.name.trim(), slug, kind: tag.kind ?? TagKind.FREE } as never,
        select: { id: true },
      });
      bySlug.set(slug, created.id);
    }

    return [...wanted.keys()].map((slug) => bySlug.get(slug)!);
  }
}

/** Builds the search filter. Exported so the combinations can be tested directly. */
export function buildRecipeWhere(query: RecipeQueryDto): Record<string, unknown> {
  const filters: Record<string, unknown>[] = [];

  // Archived recipes stay out of the way unless asked for by name.
  if (query.status === 'archived') filters.push({ archivedOn: { not: null } });
  else if (query.status !== 'all') filters.push({ archivedOn: null });

  const term = query.q?.trim();
  if (term) {
    filters.push({
      OR: [
        { title: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
        // Also match the raw ingredient text, so "anchovy" finds the recipe that
        // uses one even when it is not in the title.
        { ingredients: { some: { rawText: { contains: term, mode: 'insensitive' } } } },
      ],
    });
  }

  if (query.tag) {
    filters.push({ tags: { some: { tag: { slug: slugify(query.tag) } } } });
  }

  if (query.ingredientId) {
    filters.push({ ingredients: { some: { ingredientId: query.ingredientId } } });
  }

  return filters.length > 0 ? { AND: filters } : {};
}

function toIngredientRow(line: RecipeIngredientDto, index: number) {
  return {
    sortOrder: index,
    ingredientId: line.ingredientId ?? null,
    rawText: line.rawText.trim(),
    quantity: line.quantity ?? null,
    unitId: line.unitId ?? null,
    preparation: line.preparation?.trim() || null,
    groupLabel: line.groupLabel?.trim() || null,
    optional: line.optional ?? false,
  };
}

function toStepRow(step: { text: string }, index: number) {
  return { sortOrder: index, text: step.text.trim() };
}

/** Flattens the RecipeTag join rows into a plain tag list for the client. */
function shapeDetail<T extends { tags: { tag: unknown }[] }>(recipe: T) {
  return { ...recipe, tags: recipe.tags.map((link) => link.tag) };
}
