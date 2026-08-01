import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { IngredientsService } from '../catalog/ingredients.service';
import { normalizeBarcode } from '../off/barcode';
import { paged, resolveLimit } from '../common/pagination';
import { PrismaService, TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.service';
import type { ProductBindingQueryDto, ProductQueryDto } from './dto/products.dto';

/** Search results are capped so a one-letter query cannot pull the whole mirror. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** How many consensus ranks the barcode lookup returns for the UI. */
const CONSENSUS_LIMIT = 5;

/**
 * What a product card needs. `nutriments` is included — it is a small curated
 * object, not the whole OFF document — so the card can show a Nutri-Score
 * without a second round trip.
 */
const PRODUCT_SELECT = {
  barcode: true,
  name: true,
  brands: true,
  quantityRaw: true,
  packQuantity: true,
  packUnitId: true,
  categoriesTags: true,
  imageSmallUrl: true,
  nutriments: true,
  nutriscoreGrade: true,
  importedOn: true,
  packUnit: { select: { id: true, name: true, plural: true, abbrev: true, kind: true } },
} as const;

const INGREDIENT_SELECT = {
  id: true,
  name: true,
  slug: true,
  defaultUnitId: true,
} as const;

export type CategorySource = 'override' | 'consensus';

export type EffectiveCategory = {
  ingredientId: number;
  ingredient: {
    id: number;
    name: string;
    slug: string;
    defaultUnitId: number | null;
  };
  source: CategorySource;
};

/**
 * Reads the global Open Food Facts mirror, and owns this household's optional
 * category overrides for barcodes.
 *
 * **Every `product` operation here is a read.** The mirror is written only by
 * `npm run off:import`. The default ingredient category for a barcode is live
 * ranked consensus across all households' overrides (global ingredients only).
 * What a household owns is an optional `productBinding` override — when present
 * it wins; when absent the household follows consensus. Stocking under the
 * default does not write an override.
 *
 * Consensus is the one deliberate cross-tenant read in this feature: it uses
 * the unscoped Prisma client so household filtering does not hide other
 * households' votes. It never exposes household ids, and never ranks
 * household-created ingredients.
 */
@Injectable()
export class ProductsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly prisma: PrismaService,
    private readonly ingredients: IngredientsService,
  ) {}

  /**
   * Everything a scan needs: the global product, this household's override if
   * any, ranked consensus, and the effective category (override then consensus).
   *
   * A miss is **not** an error. Scanning something OFF has never heard of is an
   * ordinary event, and the pantry form carries on with manual entry.
   */
  async byBarcode(code: string) {
    const barcode = this.requireBarcode(code);

    const product = await this.db.product.findUnique({
      where: { barcode },
      select: PRODUCT_SELECT,
    });

    if (!product) {
      return {
        barcode,
        product: null,
        override: null,
        consensus: [],
        effectiveIngredient: null,
        source: null,
        suggestedIngredients: [],
      };
    }

    const [override, consensus] = await Promise.all([
      this.overrideFor(barcode),
      this.rankedConsensus(barcode),
    ]);

    const effective = override
      ? { ingredient: override.ingredient, source: 'override' as const }
      : consensus[0]
        ? { ingredient: consensus[0].ingredient, source: 'consensus' as const }
        : null;

    return {
      barcode,
      product,
      override,
      consensus,
      effectiveIngredient: effective?.ingredient ?? null,
      source: effective?.source ?? null,
      // Catalog search only when nothing effective — consensus is the primary
      // uncategized path when the crowd has spoken.
      suggestedIngredients: effective ? [] : await this.suggestIngredients(product),
    };
  }

  /** Free-text search across the global mirror: name, brand, or the barcode itself. */
  async search(query: ProductQueryDto) {
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const term = query.q?.trim();
    if (!term) return [];

    // A term that is all digits is a barcode, and normalizing it means typing
    // the 12 digits off a US pack finds the 13-digit row it is stored under.
    const asBarcode = /^\d+$/.test(term) ? normalizeBarcode(term) : null;

    return this.db.product.findMany({
      where: {
        OR: [
          ...(asBarcode ? [{ barcode: asBarcode }] : []),
          { name: { contains: term, mode: 'insensitive' as const } },
          { brands: { contains: term, mode: 'insensitive' as const } },
        ],
      },
      select: PRODUCT_SELECT,
      orderBy: { name: 'asc' },
      take: limit,
    });
  }

  /** This household's category overrides, for the admin list. */
  async listOverrides(query: ProductBindingQueryDto = {}) {
    const term = query.q?.trim();
    const where = term
      ? {
          OR: [
            { product: { name: { contains: term, mode: 'insensitive' as const } } },
            { product: { brands: { contains: term, mode: 'insensitive' as const } } },
            { ingredient: { name: { contains: term, mode: 'insensitive' as const } } },
          ],
        }
      : {};

    const limit = resolveLimit(query.limit);
    const offset = query.offset ?? 0;

    const [total, rows] = await Promise.all([
      this.db.productBinding.count({ where }),
      this.db.productBinding.findMany({
        where,
        select: {
          id: true,
          productId: true,
          ingredientId: true,
          product: { select: { barcode: true, name: true, brands: true, imageSmallUrl: true } },
          ingredient: { select: { id: true, name: true, slug: true } },
        },
        orderBy: { id: 'desc' },
        skip: offset,
        take: limit,
      }),
    ]);

    return paged(rows, total, limit, offset);
  }

  /**
   * Pins this household's category for a barcode (override).
   *
   * Both sides are checked first: the product must exist in the mirror, and the
   * ingredient must be one this household can actually see.
   */
  async setOverride(code: string, ingredientId: number) {
    const barcode = this.requireBarcode(code);
    await this.requireProduct(barcode);
    await this.ingredients.resolve([ingredientId]);

    const existing = await this.db.productBinding.findFirst({
      where: { productId: barcode },
      select: { id: true },
    });

    // Not `upsert`: the unique key is (householdId, productId), and householdId
    // comes from the ambient context rather than the caller.
    if (existing) {
      await this.db.productBinding.update({
        where: { id: existing.id },
        data: { ingredientId } as never,
      });
    } else {
      await this.db.productBinding.create({
        data: { productId: barcode, ingredientId } as never,
      });
    }

    return this.byBarcode(barcode);
  }

  /** Clears the override so this household follows live consensus again. */
  async clearOverride(code: string) {
    const barcode = this.requireBarcode(code);

    const { count } = await this.db.productBinding.deleteMany({
      where: { productId: barcode },
    });
    if (count === 0) {
      throw new NotFoundException(
        `Your household has no category override for barcode ${barcode}.`,
      );
    }

    return this.byBarcode(barcode);
  }

  // -- Internals -----------------------------------------------------------

  /**
   * Effective category for pantry/shopping: household override, else top
   * consensus, else null.
   */
  async effectiveCategory(barcode: string): Promise<EffectiveCategory | null> {
    const override = await this.overrideFor(barcode);
    if (override) {
      return {
        ingredientId: override.ingredientId,
        ingredient: override.ingredient,
        source: 'override',
      };
    }

    const consensus = await this.rankedConsensus(barcode);
    const top = consensus[0];
    if (!top) return null;

    return {
      ingredientId: top.ingredientId,
      ingredient: top.ingredient,
      source: 'consensus',
    };
  }

  /**
   * Writes an override only when the chosen ingredient differs from the current
   * effective category, or when there is no effective category yet.
   *
   * Stocking under the consensus default must not pin the household — otherwise
   * they stop following the crowd as rankings change.
   */
  async ensureOverrideIfChanged(barcode: string, ingredientId: number): Promise<void> {
    const effective = await this.effectiveCategory(barcode);
    if (effective && effective.ingredientId === ingredientId) return;
    await this.setOverride(barcode, ingredientId);
  }

  /** This household's override row, or null. */
  async overrideFor(barcode: string) {
    return this.db.productBinding.findFirst({
      where: { productId: barcode },
      select: {
        id: true,
        ingredientId: true,
        ingredient: { select: INGREDIENT_SELECT },
      },
    });
  }

  /**
   * Ranked consensus across all households for a barcode.
   *
   * Uses the unscoped client so tenancy filtering does not hide other
   * households' overrides. Only global ingredients (`householdId IS NULL`)
   * enter the ranking — a private fork never becomes anyone else's default.
   */
  async rankedConsensus(barcode: string) {
    const ranks = await this.prisma.$queryRaw<
      Array<{ ingredientId: number; householdCount: number }>
    >`
      SELECT pb."ingredientId", COUNT(*)::int AS "householdCount"
      FROM "product_binding" pb
      INNER JOIN "ingredient" i ON i.id = pb."ingredientId"
      WHERE pb."productId" = ${barcode}
        AND i."householdId" IS NULL
      GROUP BY pb."ingredientId"
      ORDER BY COUNT(*) DESC, pb."ingredientId" ASC
      LIMIT ${CONSENSUS_LIMIT}
    `;

    if (ranks.length === 0) return [];

    const ingredients = await this.db.ingredient.findMany({
      where: { id: { in: ranks.map((r) => r.ingredientId) } },
      select: INGREDIENT_SELECT,
    });
    const byId = new Map(ingredients.map((row) => [row.id, row]));

    return ranks.flatMap((rank) => {
      const ingredient = byId.get(rank.ingredientId);
      if (!ingredient) return [];
      return [
        {
          ingredientId: rank.ingredientId,
          ingredient,
          householdCount: rank.householdCount,
        },
      ];
    });
  }

  /** Validates a barcode exists in the mirror, returning the fields others denormalize from. */
  async requireProduct(barcode: string) {
    const product = await this.db.product.findUnique({
      where: { barcode },
      select: { barcode: true, name: true, brands: true },
    });
    if (!product) {
      throw new BadRequestException(
        `No product with barcode ${barcode} in the catalog. It may not be in the ` +
          'Open Food Facts mirror, or the mirror may need refreshing.',
      );
    }
    return product;
  }

  /**
   * Normalizes a barcode from client input, refusing one with no digits in it.
   *
   * The same normalizer the importer uses, which is the only reason a scan of a
   * US pack (UPC-A, 12 digits) finds the row OFF stored as EAN-13.
   */
  requireBarcode(code: string): string {
    const barcode = normalizeBarcode(code);
    if (!barcode) throw new BadRequestException(`"${code}" is not a barcode.`);
    return barcode;
  }

  /**
   * Ingredients this product might be, for the user to choose from when there
   * is no override and no consensus yet. Suggestions only — nothing here
   * writes an override.
   */
  private async suggestIngredients(product: { name: string; categoriesTags: string[] }) {
    const byName = await this.ingredients.search({ q: product.name, limit: 5 });
    if (byName.length > 0) return byName;

    // OFF orders categories general-to-specific, so the last is the most useful.
    const specific = product.categoriesTags.at(-1);
    if (!specific) return [];

    const term = specific.replace(/^[a-z]{2}:/, '').replace(/-/g, ' ');
    return this.ingredients.search({ q: term, limit: 5 });
  }
}
