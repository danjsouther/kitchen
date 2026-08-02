import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ARCHIVE_HOUSEHOLD_ID,
  SYSTEM_HOUSEHOLD_ID,
  TagKind,
  formatWithUnit,
  scaleForServings,
  slugify,
} from '@kitchen/shared-types';

import { requireHouseholdId } from '../common/household-context';
import { uniqueSlug } from '../common/unique-slug';
import { IngredientsService } from '../catalog/ingredients.service';
import { UnitsService, toUnitDef } from '../catalog/units.service';
import { resolveLimit } from '../common/pagination';
import { PrismaService, TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.service';
import { computeRecipeHash } from './recipe-hash';
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
    // The raw, unscoped client. Publishing and archiving-on-publish both write
    // rows under a reserved household (SYSTEM_HOUSEHOLD_ID, ARCHIVE_HOUSEHOLD_ID)
    // that is never the caller's own, and TENANT_PRISMA creates on
    // SHARED_CATALOG_MODELS always stamp the caller's own household — see
    // ProductsService for the same pattern used for its one cross-tenant read.
    private readonly prisma: PrismaService,
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
          householdId: true,
          title: true,
          slug: true,
          description: true,
          servings: true,
          prepMinutes: true,
          cookMinutes: true,
          imagePath: true,
          archivedOn: true,
          updatedOn: true,
          hash: true,
          parentHash: true,
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

    const slug = await uniqueSlug(dto.title, (candidate) =>
      this.slugTaken(candidate, requireHouseholdId()),
    );
    const tagIds = await this.resolveTags(dto.tags ?? []);

    const title = dto.title.trim();
    const description = dto.description?.trim() || null;
    const prepMinutes = dto.prepMinutes ?? null;
    const cookMinutes = dto.cookMinutes ?? null;
    const sourceUrl = dto.sourceUrl ?? null;
    const sourceNote = dto.sourceNote?.trim() || null;
    const notes = dto.notes?.trim() || null;
    const ingredients = dto.ingredients.map(toIngredientRow);
    const steps = dto.steps.map(toStepRow);

    const hash = computeRecipeHash({
      title,
      description,
      servings: dto.servings,
      prepMinutes,
      cookMinutes,
      sourceUrl,
      sourceNote,
      notes,
      ingredients,
      steps,
    });

    const created = await this.db.recipe.create({
      data: {
        title,
        slug,
        description,
        servings: dto.servings,
        prepMinutes,
        cookMinutes,
        sourceUrl,
        sourceNote,
        notes,
        hash,
        createdById: userId,
        ingredients: { create: ingredients },
        steps: { create: steps },
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
      select: {
        id: true,
        householdId: true,
        title: true,
        slug: true,
        description: true,
        servings: true,
        prepMinutes: true,
        cookMinutes: true,
        sourceUrl: true,
        sourceNote: true,
        notes: true,
        ingredients: {
          select: {
            sortOrder: true,
            ingredientId: true,
            rawText: true,
            quantity: true,
            unitId: true,
            preparation: true,
            groupLabel: true,
            optional: true,
          },
        },
        steps: { select: { sortOrder: true, text: true } },
      },
    });
    if (!existing) throw new NotFoundException(`No recipe with id ${id}.`);

    // Global rows are refused rather than silently ignored — the tenancy
    // extension already scopes catalog *writes* to the household's own rows,
    // so an attempt on a system-owned row would otherwise update nothing and
    // report success. Publishing a new version is `publish`'s job, through the
    // household's own fork.
    if (existing.householdId === SYSTEM_HOUSEHOLD_ID) {
      throw new ForbiddenException(
        'This recipe is part of the shared catalog and cannot be edited ' +
          'directly. Make your own copy of it first, then edit that.',
      );
    }

    if (dto.ingredients) await this.validateLines(dto.ingredients);

    const data: Record<string, unknown> = {};

    if (dto.title !== undefined) {
      data.title = dto.title.trim();
      // Only re-slug when the title genuinely changed: a rename that happens to
      // produce the same slug should keep the URL, and re-slugging on every save
      // would churn `chili` into `chili-2`.
      if (slugify(dto.title) !== slugify(existing.title)) {
        data.slug = await uniqueSlug(dto.title, (candidate) =>
          this.slugTaken(candidate, requireHouseholdId(), id),
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

    const ingredients = dto.ingredients
      ? dto.ingredients.map(toIngredientRow)
      : existing.ingredients.map((line) => ({
          ...line,
          quantity: line.quantity === null ? null : String(line.quantity),
        }));
    const steps = dto.steps ? dto.steps.map(toStepRow) : existing.steps;

    if (dto.ingredients) {
      data.ingredients = { deleteMany: {}, create: ingredients };
    }
    if (dto.steps) {
      data.steps = { deleteMany: {}, create: steps };
    }
    if (dto.tags) {
      const tagIds = await this.resolveTags(dto.tags);
      data.tags = { deleteMany: {}, create: tagIds.map((tagId) => ({ tagId })) };
    }

    // Recomputed from the full resulting content — merging what changed
    // (`data`) over what didn't (`existing`) — not just the patch, since a
    // partial update still produces one concrete row with one concrete hash.
    // `parentHash` is deliberately never touched here: an in-place edit of a
    // private recipe is not a new lineage node, just the same one moving on.
    data.hash = computeRecipeHash({
      title: (data.title as string | undefined) ?? existing.title,
      description:
        'description' in data ? (data.description as string | null) : existing.description,
      servings: (data.servings as number | undefined) ?? existing.servings,
      prepMinutes:
        'prepMinutes' in data ? (data.prepMinutes as number | null) : existing.prepMinutes,
      cookMinutes:
        'cookMinutes' in data ? (data.cookMinutes as number | null) : existing.cookMinutes,
      sourceUrl: 'sourceUrl' in data ? (data.sourceUrl as string | null) : existing.sourceUrl,
      sourceNote: 'sourceNote' in data ? (data.sourceNote as string | null) : existing.sourceNote,
      notes: 'notes' in data ? (data.notes as string | null) : existing.notes,
      ingredients,
      steps,
    });

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
    await this.assertOwned(id);

    const { count } = await this.db.recipe.updateMany({
      where: { id, archivedOn: null },
      data: { archivedOn: new Date() },
    });
    // Existence and ownership are already settled above, so a count of zero
    // here can only mean it was already archived.
    if (count === 0) throw new ConflictException('That recipe is already archived.');
    return this.findOne(id);
  }

  async restore(id: number) {
    await this.assertOwned(id);

    const { count } = await this.db.recipe.updateMany({
      where: { id, archivedOn: { not: null } },
      data: { archivedOn: null },
    });
    if (count === 0) throw new ConflictException('That recipe is not archived.');
    return this.findOne(id);
  }

  /**
   * Publishes a copy of this household's recipe into the shared catalog —
   * `SYSTEM_HOUSEHOLD_ID` — so every household can see and copy it.
   *
   * The source may already be published: publishing an edited fork of a
   * public recipe is how a new public *version* is made, each one a brand-new
   * row rather than an edit of the old one. Publishing content that already
   * exists under `SYSTEM_HOUSEHOLD_ID` resolves to that existing row instead
   * of creating a duplicate — the `(householdId, slug, hash)` constraint would
   * refuse the duplicate anyway, but returning the match is friendlier than
   * surfacing that as an error.
   */
  async publish(id: number) {
    const source = await this.db.recipe.findFirst({
      where: { id },
      select: {
        id: true,
        householdId: true,
        title: true,
        slug: true,
        description: true,
        servings: true,
        prepMinutes: true,
        cookMinutes: true,
        sourceUrl: true,
        sourceNote: true,
        notes: true,
        imagePath: true,
        hash: true,
        createdById: true,
        ingredients: {
          select: {
            sortOrder: true,
            ingredientId: true,
            rawText: true,
            quantity: true,
            unitId: true,
            preparation: true,
            groupLabel: true,
            optional: true,
          },
        },
        steps: { select: { sortOrder: true, text: true } },
      },
    });
    if (!source) throw new NotFoundException(`No recipe with id ${id}.`);
    if (source.householdId === ARCHIVE_HOUSEHOLD_ID) {
      throw new NotFoundException(`No recipe with id ${id}.`);
    }

    const existingGlobal = await this.db.recipe.findFirst({
      where: { householdId: SYSTEM_HOUSEHOLD_ID, hash: source.hash },
      include: DETAIL_INCLUDE,
    });
    if (existingGlobal) return shapeDetail(existingGlobal);

    const slug = await uniqueSlug(source.title, (candidate) =>
      this.slugTaken(candidate, SYSTEM_HOUSEHOLD_ID),
    );

    // A line that points at a household-private ingredient would be invisible
    // or broken for every other household — drop the link and keep `rawText`,
    // the same "unresolved line" representation an unmatched paste already
    // uses.
    const ingredientIds = source.ingredients
      .map((line) => line.ingredientId)
      .filter((lineId): lineId is number => lineId !== null);
    const globalIngredientIds =
      ingredientIds.length === 0
        ? new Set<number>()
        : new Set(
            (
              await this.prisma.ingredient.findMany({
                where: { id: { in: ingredientIds }, householdId: SYSTEM_HOUSEHOLD_ID },
                select: { id: true },
              })
            ).map((row) => row.id),
          );

    const ingredients = source.ingredients.map((line) => ({
      sortOrder: line.sortOrder,
      ingredientId:
        line.ingredientId !== null && globalIngredientIds.has(line.ingredientId)
          ? line.ingredientId
          : null,
      rawText: line.rawText,
      quantity: line.quantity === null ? null : String(line.quantity),
      unitId: line.unitId,
      preparation: line.preparation,
      groupLabel: line.groupLabel,
      optional: line.optional,
    }));
    const steps = source.steps.map((step) => ({ sortOrder: step.sortOrder, text: step.text }));

    // Both this row and, below, the archive row need an explicit householdId
    // that is never the caller's own, so both go through the raw unscoped
    // client — TENANT_PRISMA creates on SHARED_CATALOG_MODELS always stamp the
    // caller's own household, which is exactly wrong here.
    const published = await this.prisma.recipe.create({
      data: {
        householdId: SYSTEM_HOUSEHOLD_ID,
        title: source.title,
        slug,
        description: source.description,
        servings: source.servings,
        prepMinutes: source.prepMinutes,
        cookMinutes: source.cookMinutes,
        sourceUrl: source.sourceUrl,
        sourceNote: source.sourceNote,
        notes: source.notes,
        imagePath: source.imagePath,
        hash: source.hash,
        parentHash: source.hash,
        createdById: source.createdById,
        ingredients: { create: ingredients },
        steps: { create: steps },
      },
      include: DETAIL_INCLUDE,
    });

    // A real household's row is mutable, so the moment it becomes a parent its
    // content at this exact hash has to be frozen — otherwise `parentHash`
    // above would go stale the next time the household edits their recipe.
    // System-owned sources need no archive copy: they are never edited in
    // place (see `update`'s guard), so they are already permanent.
    if (source.householdId !== SYSTEM_HOUSEHOLD_ID) {
      const alreadyArchived = await this.prisma.recipe.findFirst({
        where: { householdId: ARCHIVE_HOUSEHOLD_ID, hash: source.hash },
        select: { id: true },
      });
      if (!alreadyArchived) {
        await this.prisma.recipe.create({
          data: {
            householdId: ARCHIVE_HOUSEHOLD_ID,
            title: source.title,
            slug: source.slug,
            description: source.description,
            servings: source.servings,
            prepMinutes: source.prepMinutes,
            cookMinutes: source.cookMinutes,
            sourceUrl: source.sourceUrl,
            sourceNote: source.sourceNote,
            notes: source.notes,
            imagePath: source.imagePath,
            hash: source.hash,
            parentHash: null,
            createdById: source.createdById,
            ingredients: { create: ingredients },
            steps: { create: steps },
          },
        });
      }
    }

    return shapeDetail(published);
  }

  /**
   * Forks a shared-catalog recipe into a household-owned copy — the recipe
   * analogue of `IngredientsService.customize`.
   */
  async copy(id: number, userId: number) {
    const source = await this.db.recipe.findFirst({
      where: { id },
      select: {
        id: true,
        householdId: true,
        title: true,
        slug: true,
        description: true,
        servings: true,
        prepMinutes: true,
        cookMinutes: true,
        sourceUrl: true,
        sourceNote: true,
        notes: true,
        imagePath: true,
        hash: true,
        ingredients: {
          select: {
            sortOrder: true,
            ingredientId: true,
            rawText: true,
            quantity: true,
            unitId: true,
            preparation: true,
            groupLabel: true,
            optional: true,
          },
        },
        steps: { select: { sortOrder: true, text: true } },
      },
    });
    if (!source) throw new NotFoundException(`No recipe with id ${id}.`);
    if (source.householdId !== SYSTEM_HOUSEHOLD_ID) {
      throw new ConflictException(
        `"${source.title}" already belongs to your household — edit it directly.`,
      );
    }

    const householdId = requireHouseholdId();
    const mine = await this.db.recipe.findFirst({
      where: { slug: source.slug, householdId },
      select: { id: true },
    });
    if (mine) {
      throw new ConflictException(`You already have your own copy of "${source.title}".`);
    }

    const ingredients = source.ingredients.map((line) => ({
      sortOrder: line.sortOrder,
      ingredientId: line.ingredientId,
      rawText: line.rawText,
      quantity: line.quantity === null ? null : String(line.quantity),
      unitId: line.unitId,
      preparation: line.preparation,
      groupLabel: line.groupLabel,
      optional: line.optional,
    }));
    const steps = source.steps.map((step) => ({ sortOrder: step.sortOrder, text: step.text }));

    // Identical content to the source at fork time is expected, not a
    // collision: the caller's own household id differs from
    // SYSTEM_HOUSEHOLD_ID, so (householdId, slug, hash) is still unique.
    const created = await this.db.recipe.create({
      data: {
        title: source.title,
        slug: source.slug,
        description: source.description,
        servings: source.servings,
        prepMinutes: source.prepMinutes,
        cookMinutes: source.cookMinutes,
        sourceUrl: source.sourceUrl,
        sourceNote: source.sourceNote,
        notes: source.notes,
        imagePath: source.imagePath,
        hash: source.hash,
        parentHash: source.hash,
        createdById: userId,
        ingredients: { create: ingredients },
        steps: { create: steps },
      } as never,
      include: DETAIL_INCLUDE,
    });

    return shapeDetail(created);
  }

  // -- Internals -----------------------------------------------------------

  /** Loads a recipe's id/householdId and refuses a system-owned (or missing) one. */
  private async assertOwned(id: number): Promise<void> {
    const found = await this.db.recipe.findFirst({
      where: { id },
      select: { id: true, householdId: true },
    });
    if (!found) throw new NotFoundException(`No recipe with id ${id}.`);
    if (found.householdId === SYSTEM_HOUSEHOLD_ID) {
      throw new ForbiddenException(
        'This recipe is part of the shared catalog and cannot be changed ' +
          'directly. Make your own copy of it first.',
      );
    }
  }

  private async slugTaken(slug: string, householdId: number, exceptId?: number): Promise<boolean> {
    const where: Record<string, unknown> = exceptId
      ? { slug, householdId, id: { not: exceptId } }
      : { slug, householdId };
    const row = await this.db.recipe.findFirst({ where, select: { id: true } });
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

  // 'mine' resolves to "my own": the catalog visibility rule already limits
  // reads to SYSTEM_HOUSEHOLD_ID plus the caller's own, so excluding
  // SYSTEM_HOUSEHOLD_ID here leaves only the caller's own rows.
  if (query.scope === 'mine') filters.push({ householdId: { not: SYSTEM_HOUSEHOLD_ID } });
  else if (query.scope === 'shared') filters.push({ householdId: SYSTEM_HOUSEHOLD_ID });

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
