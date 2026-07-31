import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { IngredientsService } from '../catalog/ingredients.service';
import { normalizeBarcode } from '../off/barcode';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.service';
import type { ProductQueryDto } from './dto/products.dto';

/** Search results are capped so a one-letter query cannot pull the whole mirror. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

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

/**
 * Reads the global Open Food Facts mirror, and owns this household's bindings
 * from a barcode to an ingredient.
 *
 * The tenancy split is the whole point of this service, so it is worth stating
 * plainly: **every `product` operation here is a read.** The mirror is written
 * only by `npm run off:import`. What a household owns is the `productBinding`
 * row saying which ingredient it means by a barcode — nothing more. There is no
 * fork-a-private-copy path as there is for ingredients, because correcting OFF
 * data is OFF's job and a private duplicate of a barcode would break the one
 * thing a barcode is good for.
 */
@Injectable()
export class ProductsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly ingredients: IngredientsService,
  ) {}

  /**
   * Everything a scan needs, in one call: the global product, this household's
   * binding if it has one, and — when it does not — ingredients it might mean.
   *
   * A miss is **not** an error. Scanning something OFF has never heard of is an
   * ordinary event (store-brand goods especially), and the pantry form's answer
   * is to carry on with manual entry. Returning 404 would make the client treat
   * a normal outcome as a failure, so the shape is uniform and `product` is
   * simply null.
   */
  async byBarcode(code: string) {
    const barcode = this.requireBarcode(code);

    const product = await this.db.product.findUnique({
      where: { barcode },
      select: PRODUCT_SELECT,
    });

    if (!product) {
      return { barcode, product: null, binding: null, suggestedIngredients: [] };
    }

    const binding = await this.db.productBinding.findFirst({
      where: { productId: barcode },
      select: {
        id: true,
        ingredientId: true,
        ingredient: { select: { id: true, name: true, slug: true, defaultUnitId: true } },
      },
    });

    return {
      barcode,
      product,
      binding,
      // Only worth computing when there is nothing bound yet — and never
      // applied automatically. A wrong auto-binding writes the wrong ingredient
      // onto every future scan of that barcode, silently.
      suggestedIngredients: binding ? [] : await this.suggestIngredients(product),
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

  /** This household's bindings, for the admin list. */
  listBindings() {
    return this.db.productBinding.findMany({
      select: {
        id: true,
        productId: true,
        ingredientId: true,
        product: { select: { barcode: true, name: true, brands: true, imageSmallUrl: true } },
        ingredient: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { id: 'desc' },
    });
  }

  /**
   * Points a barcode at an ingredient for this household.
   *
   * Both sides are checked first: the product must exist in the mirror, and the
   * ingredient must be one this household can actually see. `ingredients.resolve`
   * is the shared gate for the latter — without it a request naming another
   * household's private ingredient would surface as a foreign-key error, or
   * worse, succeed.
   */
  async bind(code: string, ingredientId: number) {
    const barcode = this.requireBarcode(code);
    await this.requireProduct(barcode);
    await this.ingredients.resolve([ingredientId]);

    const existing = await this.db.productBinding.findFirst({
      where: { productId: barcode },
      select: { id: true },
    });

    // Not `upsert`: the unique key is (householdId, productId), and householdId
    // comes from the ambient context rather than the caller, so there is no
    // compound `where` to hand Prisma without naming a household id here.
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

  async unbind(code: string) {
    const barcode = this.requireBarcode(code);

    const { count } = await this.db.productBinding.deleteMany({
      where: { productId: barcode },
    });
    if (count === 0) {
      throw new NotFoundException(`Your household has no binding for barcode ${barcode}.`);
    }

    return this.byBarcode(barcode);
  }

  // -- Internals -----------------------------------------------------------

  /**
   * Loads a bound ingredient for a barcode, or null.
   *
   * The seam the pantry and shopping services use, so "what does this household
   * mean by this barcode" is answered in one place rather than each caller
   * writing its own query and drifting.
   */
  async bindingFor(barcode: string) {
    return this.db.productBinding.findFirst({
      where: { productId: barcode },
      select: { ingredientId: true },
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
   * Ingredients this product might be, for the user to choose from.
   *
   * Searched on the product name first, then its most specific OFF category as
   * a fallback — "en:wheat-flours" becomes "wheat flours", which finds flour
   * where the brand-heavy product name would not. Suggestions only; nothing
   * here binds anything.
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
