/**
 * The products service, against a stubbed Prisma client.
 *
 * The stub records the `where` clauses it is handed, which is the point: the
 * things worth proving here are about *which rows* each call touches — that a
 * binding write is a binding write and never a product write, and that a
 * barcode is normalized identically on the way in and the way out.
 *
 * Household filtering itself is not re-tested here. It happens in the Prisma
 * extension, is covered by `tenancy.spec.ts`, and is proved end-to-end against
 * a live database by `npm run verify:tenancy`.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';

import { ProductsService } from './products.service';

const FLOUR = { id: 11, name: 'all-purpose flour', slug: 'all-purpose-flour', defaultUnitId: 1 };

const CORN_FLAKES = {
  barcode: '0038000138416',
  name: 'Corn Flakes',
  brands: "Kellogg's",
  quantityRaw: '345 g',
  categoriesTags: ['en:breakfasts', 'en:breakfast-cereals'],
  nutriscoreGrade: 'c',
};

interface Call {
  model: string;
  operation: string;
  args: Record<string, unknown>;
}

function makeService(options: {
  products?: Record<string, unknown>[];
  bindings?: Record<string, unknown>[];
  ingredientHits?: Record<string, unknown>[];
} = {}) {
  const products = options.products ?? [CORN_FLAKES];
  const bindings = options.bindings ?? [];
  const calls: Call[] = [];

  const record = (model: string, operation: string, args: Record<string, unknown> = {}) => {
    calls.push({ model, operation, args });
  };

  const db = {
    product: {
      findUnique: (args: Record<string, unknown>) => {
        record('product', 'findUnique', args);
        const where = args.where as { barcode: string };
        return Promise.resolve(products.find((p) => p.barcode === where.barcode) ?? null);
      },
      findMany: (args: Record<string, unknown>) => {
        record('product', 'findMany', args);
        return Promise.resolve(products);
      },
    },
    productBinding: {
      findFirst: (args: Record<string, unknown>) => {
        record('productBinding', 'findFirst', args);
        const where = args.where as { productId: string };
        return Promise.resolve(bindings.find((b) => b.productId === where.productId) ?? null);
      },
      findMany: (args: Record<string, unknown>) => {
        record('productBinding', 'findMany', args);
        return Promise.resolve(bindings);
      },
      create: (args: Record<string, unknown>) => {
        record('productBinding', 'create', args);
        return Promise.resolve({ id: 1 });
      },
      update: (args: Record<string, unknown>) => {
        record('productBinding', 'update', args);
        return Promise.resolve({ id: 1 });
      },
      deleteMany: (args: Record<string, unknown>) => {
        record('productBinding', 'deleteMany', args);
        const where = args.where as { productId: string };
        return Promise.resolve({
          count: bindings.filter((b) => b.productId === where.productId).length,
        });
      },
    },
  };

  const ingredients = {
    resolve: jest.fn().mockResolvedValue(new Map()),
    search: jest.fn().mockResolvedValue(options.ingredientHits ?? []),
  };

  const service = new ProductsService(
    db as never,
    ingredients as never,
  );

  return { service, calls, ingredients };
}

describe('byBarcode', () => {
  /**
   * The load-bearing case for American products. The pack scans as 12-digit
   * UPC-A; OFF stores it as EAN-13 with a leading zero. Without normalization
   * here every US scan misses a row that is sitting in the table.
   */
  it('normalizes a 12-digit scan before looking it up', async () => {
    const { service, calls } = makeService({
      products: [{ ...CORN_FLAKES, barcode: '0041196010184' }],
    });

    const result = await service.byBarcode('041196010184');

    expect(result.barcode).toBe('0041196010184');
    expect(result.product).not.toBeNull();
    expect(calls[0].args.where).toEqual({ barcode: '0041196010184' });
  });

  it('strips the punctuation a person types off a packet', async () => {
    const { service } = makeService();
    const result = await service.byBarcode(' 0038000138416 ');
    expect(result.product).toMatchObject({ name: 'Corn Flakes' });
  });

  /**
   * A miss is an ordinary event — store-brand goods are frequently not in OFF —
   * and the pantry form's answer is to carry on with manual entry. A 404 would
   * make the client treat that as a failure, so the shape stays uniform.
   */
  it('returns a null product rather than throwing when nothing matches', async () => {
    const { service } = makeService({ products: [] });

    const result = await service.byBarcode('9999999999999');

    expect(result).toEqual({
      barcode: '9999999999999',
      product: null,
      binding: null,
      suggestedIngredients: [],
    });
  });

  it('refuses input with no digits in it', async () => {
    const { service } = makeService();
    await expect(service.byBarcode('not-a-barcode')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('returns the household binding alongside the global product', async () => {
    const { service } = makeService({
      bindings: [{ id: 3, productId: CORN_FLAKES.barcode, ingredientId: 11, ingredient: FLOUR }],
    });

    const result = await service.byBarcode(CORN_FLAKES.barcode);

    expect(result.binding).toMatchObject({ ingredientId: 11 });
  });

  describe('suggestions', () => {
    it('suggests ingredients when nothing is bound yet', async () => {
      const { service } = makeService({ ingredientHits: [FLOUR] });
      const result = await service.byBarcode(CORN_FLAKES.barcode);
      expect(result.suggestedIngredients).toEqual([FLOUR]);
    });

    // Once the household has said what this barcode means, suggesting
    // alternatives is noise on a screen that has already been decided.
    it('does not suggest anything once a binding exists', async () => {
      const { service, ingredients } = makeService({
        bindings: [{ id: 3, productId: CORN_FLAKES.barcode, ingredientId: 11, ingredient: FLOUR }],
        ingredientHits: [FLOUR],
      });

      const result = await service.byBarcode(CORN_FLAKES.barcode);

      expect(result.suggestedIngredients).toEqual([]);
      expect(ingredients.search).not.toHaveBeenCalled();
    });

    /**
     * "Corn Flakes" finds nothing in a catalog of raw ingredients, so the most
     * specific OFF category is tried next: `en:breakfast-cereals` becomes
     * "breakfast cereals", which does.
     */
    it('falls back to the most specific OFF category', async () => {
      const { service, ingredients } = makeService();
      ingredients.search
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 40, name: 'breakfast cereal' }]);

      const result = await service.byBarcode(CORN_FLAKES.barcode);

      expect(ingredients.search).toHaveBeenNthCalledWith(1, { q: 'Corn Flakes', limit: 5 });
      expect(ingredients.search).toHaveBeenNthCalledWith(2, {
        q: 'breakfast cereals',
        limit: 5,
      });
      expect(result.suggestedIngredients).toEqual([{ id: 40, name: 'breakfast cereal' }]);
    });
  });
});

describe('bind', () => {
  /**
   * The tenancy claim of this whole feature, asserted directly: linking a
   * barcode to flour writes a binding and touches no product row. If this ever
   * became a product write, one household would be editing the catalog every
   * other household reads.
   */
  it('writes a binding and never a product', async () => {
    const { service, calls } = makeService();

    await service.bind(CORN_FLAKES.barcode, 11);

    const writes = calls.filter((call) =>
      ['create', 'update', 'delete', 'deleteMany', 'upsert'].includes(call.operation),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].model).toBe('productBinding');
    expect(writes[0].args.data).toEqual({ productId: CORN_FLAKES.barcode, ingredientId: 11 });
  });

  it('stores the binding under the normalized barcode', async () => {
    const { service, calls } = makeService({
      products: [{ ...CORN_FLAKES, barcode: '0041196010184' }],
    });

    await service.bind('041196010184', 11);

    const create = calls.find((call) => call.operation === 'create')!;
    expect(create.args.data).toMatchObject({ productId: '0041196010184' });
  });

  it('re-points an existing binding rather than adding a second', async () => {
    const { service, calls } = makeService({
      bindings: [{ id: 3, productId: CORN_FLAKES.barcode, ingredientId: 11 }],
    });

    await service.bind(CORN_FLAKES.barcode, 22);

    expect(calls.some((call) => call.operation === 'create')).toBe(false);
    const update = calls.find((call) => call.operation === 'update')!;
    expect(update.args).toMatchObject({ where: { id: 3 }, data: { ingredientId: 22 } });
  });

  // Checked through the shared gate, so a request naming another household's
  // private ingredient is refused rather than surfacing as a foreign-key error.
  it('validates the ingredient is one this household can see', async () => {
    const { service, ingredients } = makeService();
    await service.bind(CORN_FLAKES.barcode, 11);
    expect(ingredients.resolve).toHaveBeenCalledWith([11]);
  });

  it('refuses a barcode that is not in the mirror', async () => {
    const { service } = makeService({ products: [] });
    await expect(service.bind('9999999999999', 11)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('unbind', () => {
  it('removes the binding', async () => {
    const { service, calls } = makeService({
      bindings: [{ id: 3, productId: CORN_FLAKES.barcode, ingredientId: 11 }],
    });

    await service.unbind(CORN_FLAKES.barcode);

    const del = calls.find((call) => call.operation === 'deleteMany')!;
    expect(del.model).toBe('productBinding');
    expect(del.args.where).toEqual({ productId: CORN_FLAKES.barcode });
  });

  it('says so when there was nothing bound', async () => {
    const { service } = makeService();
    await expect(service.unbind(CORN_FLAKES.barcode)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('search', () => {
  it('returns nothing for an empty query rather than the whole mirror', async () => {
    const { service, calls } = makeService();
    expect(await service.search({})).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('caps the limit however large a number is asked for', async () => {
    const { service, calls } = makeService();
    await service.search({ q: 'flour', limit: 5000 });
    expect(calls[0].args.take).toBe(50);
  });

  // Typing the 12 digits printed on a US pack has to find the 13-digit row.
  it('matches an all-digit term against the normalized barcode', async () => {
    const { service, calls } = makeService();

    await service.search({ q: '041196010184' });

    const where = calls[0].args.where as { OR: Array<Record<string, unknown>> };
    expect(where.OR).toContainEqual({ barcode: '0041196010184' });
  });

  it('searches name and brand for a text term', async () => {
    const { service, calls } = makeService();

    await service.search({ q: 'kellogg' });

    const where = calls[0].args.where as { OR: Array<Record<string, unknown>> };
    expect(where.OR).toEqual([
      { name: { contains: 'kellogg', mode: 'insensitive' } },
      { brands: { contains: 'kellogg', mode: 'insensitive' } },
    ]);
  });
});
