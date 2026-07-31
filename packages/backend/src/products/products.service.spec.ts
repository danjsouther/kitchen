/**
 * The products service, against a stubbed Prisma client.
 *
 * The stub records the `where` clauses it is handed, which is the point: the
 * things worth proving here are about *which rows* each call touches — that an
 * override write is a binding write and never a product write, that consensus
 * uses the unscoped client, and that a barcode is normalized identically on
 * the way in and the way out.
 *
 * Household filtering itself is not re-tested here. It happens in the Prisma
 * extension, is covered by `tenancy.spec.ts`, and is proved end-to-end against
 * a live database by `npm run verify:tenancy`.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';

import { ProductsService } from './products.service';

const FLOUR = { id: 11, name: 'all-purpose flour', slug: 'all-purpose-flour', defaultUnitId: 1 };
const CEREAL = { id: 40, name: 'breakfast cereal', slug: 'breakfast-cereal', defaultUnitId: 1 };

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
  overrides?: Record<string, unknown>[];
  consensusRanks?: Array<{ ingredientId: number; householdCount: number }>;
  consensusIngredients?: Record<string, unknown>[];
  ingredientHits?: Record<string, unknown>[];
} = {}) {
  const products = options.products ?? [CORN_FLAKES];
  const overrides = options.overrides ?? [];
  const consensusRanks = options.consensusRanks ?? [];
  const consensusIngredients = options.consensusIngredients ?? [];
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
        return Promise.resolve(overrides.find((b) => b.productId === where.productId) ?? null);
      },
      findMany: (args: Record<string, unknown>) => {
        record('productBinding', 'findMany', args);
        return Promise.resolve(overrides);
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
          count: overrides.filter((b) => b.productId === where.productId).length,
        });
      },
    },
    ingredient: {
      findMany: (args: Record<string, unknown>) => {
        record('ingredient', 'findMany', args);
        const where = args.where as { id: { in: number[] } };
        const ids = new Set(where.id.in);
        return Promise.resolve(consensusIngredients.filter((row) => ids.has(row.id as number)));
      },
    },
  };

  const prisma = {
    $queryRaw: () => {
      record('raw', '$queryRaw', {});
      return Promise.resolve(consensusRanks);
    },
  };

  const ingredients = {
    resolve: jest.fn().mockResolvedValue(new Map()),
    search: jest.fn().mockResolvedValue(options.ingredientHits ?? []),
  };

  const service = new ProductsService(db as never, prisma as never, ingredients as never);

  return { service, calls, ingredients, prisma };
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
      override: null,
      consensus: [],
      effectiveIngredient: null,
      source: null,
      suggestedIngredients: [],
    });
  });

  it('refuses input with no digits in it', async () => {
    const { service } = makeService();
    await expect(service.byBarcode('not-a-barcode')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('prefers the household override over consensus', async () => {
    const { service } = makeService({
      overrides: [
        { id: 3, productId: CORN_FLAKES.barcode, ingredientId: 11, ingredient: FLOUR },
      ],
      consensusRanks: [{ ingredientId: 40, householdCount: 9 }],
      consensusIngredients: [CEREAL],
    });

    const result = await service.byBarcode(CORN_FLAKES.barcode);

    expect(result.override).toMatchObject({ ingredientId: 11 });
    expect(result.source).toBe('override');
    expect(result.effectiveIngredient).toMatchObject({ id: 11 });
    expect(result.consensus[0]).toMatchObject({ ingredientId: 40, householdCount: 9 });
  });

  it('defaults to ranked consensus when there is no override', async () => {
    const { service } = makeService({
      consensusRanks: [
        { ingredientId: 40, householdCount: 5 },
        { ingredientId: 11, householdCount: 2 },
      ],
      consensusIngredients: [CEREAL, FLOUR],
    });

    const result = await service.byBarcode(CORN_FLAKES.barcode);

    expect(result.override).toBeNull();
    expect(result.source).toBe('consensus');
    expect(result.effectiveIngredient).toMatchObject({ id: 40 });
    expect(result.suggestedIngredients).toEqual([]);
  });

  describe('suggestions', () => {
    it('suggests ingredients only when override and consensus are both empty', async () => {
      const { service } = makeService({ ingredientHits: [FLOUR] });
      const result = await service.byBarcode(CORN_FLAKES.barcode);
      expect(result.suggestedIngredients).toEqual([FLOUR]);
      expect(result.source).toBeNull();
    });

    it('does not suggest once consensus supplies a default', async () => {
      const { service, ingredients } = makeService({
        consensusRanks: [{ ingredientId: 40, householdCount: 3 }],
        consensusIngredients: [CEREAL],
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

describe('effectiveCategory', () => {
  it('returns override then consensus', async () => {
    const withOverride = makeService({
      overrides: [
        { id: 3, productId: CORN_FLAKES.barcode, ingredientId: 11, ingredient: FLOUR },
      ],
      consensusRanks: [{ ingredientId: 40, householdCount: 9 }],
      consensusIngredients: [CEREAL],
    });
    await expect(withOverride.service.effectiveCategory(CORN_FLAKES.barcode)).resolves.toMatchObject(
      { ingredientId: 11, source: 'override' },
    );

    const withConsensus = makeService({
      consensusRanks: [{ ingredientId: 40, householdCount: 3 }],
      consensusIngredients: [CEREAL],
    });
    await expect(
      withConsensus.service.effectiveCategory(CORN_FLAKES.barcode),
    ).resolves.toMatchObject({ ingredientId: 40, source: 'consensus' });

    const empty = makeService();
    await expect(empty.service.effectiveCategory(CORN_FLAKES.barcode)).resolves.toBeNull();
  });
});

describe('ensureOverrideIfChanged', () => {
  it('does not write when stocking the consensus default', async () => {
    const { service, calls } = makeService({
      consensusRanks: [{ ingredientId: 40, householdCount: 3 }],
      consensusIngredients: [CEREAL],
    });

    await service.ensureOverrideIfChanged(CORN_FLAKES.barcode, 40);

    const writes = calls.filter((call) =>
      ['create', 'update', 'delete', 'deleteMany', 'upsert'].includes(call.operation),
    );
    expect(writes).toHaveLength(0);
  });

  it('writes when the chosen ingredient differs from effective', async () => {
    const { service, calls } = makeService({
      consensusRanks: [{ ingredientId: 40, householdCount: 3 }],
      consensusIngredients: [CEREAL],
    });

    await service.ensureOverrideIfChanged(CORN_FLAKES.barcode, 11);

    const writes = calls.filter((call) =>
      ['create', 'update'].includes(call.operation),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].model).toBe('productBinding');
    expect(writes[0].args.data).toEqual({ productId: CORN_FLAKES.barcode, ingredientId: 11 });
  });

  it('writes when there is no effective category yet', async () => {
    const { service, calls } = makeService();

    await service.ensureOverrideIfChanged(CORN_FLAKES.barcode, 11);

    expect(calls.some((call) => call.operation === 'create')).toBe(true);
  });
});

describe('setOverride', () => {
  /**
   * The tenancy claim of this whole feature: setting a category writes a
   * binding and touches no product row.
   */
  it('writes an override and never a product', async () => {
    const { service, calls } = makeService();

    await service.setOverride(CORN_FLAKES.barcode, 11);

    const writes = calls.filter((call) =>
      ['create', 'update', 'delete', 'deleteMany', 'upsert'].includes(call.operation),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].model).toBe('productBinding');
    expect(writes[0].args.data).toEqual({ productId: CORN_FLAKES.barcode, ingredientId: 11 });
  });

  it('stores the override under the normalized barcode', async () => {
    const { service, calls } = makeService({
      products: [{ ...CORN_FLAKES, barcode: '0041196010184' }],
    });

    await service.setOverride('041196010184', 11);

    const create = calls.find((call) => call.operation === 'create')!;
    expect(create.args.data).toMatchObject({ productId: '0041196010184' });
  });

  it('re-points an existing override rather than adding a second', async () => {
    const { service, calls } = makeService({
      overrides: [{ id: 3, productId: CORN_FLAKES.barcode, ingredientId: 11 }],
    });

    await service.setOverride(CORN_FLAKES.barcode, 22);

    expect(calls.some((call) => call.operation === 'create')).toBe(false);
    const update = calls.find((call) => call.operation === 'update')!;
    expect(update.args).toMatchObject({ where: { id: 3 }, data: { ingredientId: 22 } });
  });

  it('validates the ingredient is one this household can see', async () => {
    const { service, ingredients } = makeService();
    await service.setOverride(CORN_FLAKES.barcode, 11);
    expect(ingredients.resolve).toHaveBeenCalledWith([11]);
  });

  it('refuses a barcode that is not in the mirror', async () => {
    const { service } = makeService({ products: [] });
    await expect(service.setOverride('9999999999999', 11)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('clearOverride', () => {
  it('removes the override', async () => {
    const { service, calls } = makeService({
      overrides: [{ id: 3, productId: CORN_FLAKES.barcode, ingredientId: 11 }],
    });

    await service.clearOverride(CORN_FLAKES.barcode);

    const del = calls.find((call) => call.operation === 'deleteMany')!;
    expect(del.model).toBe('productBinding');
    expect(del.args.where).toEqual({ productId: CORN_FLAKES.barcode });
  });

  it('says so when there was no override', async () => {
    const { service } = makeService();
    await expect(service.clearOverride(CORN_FLAKES.barcode)).rejects.toBeInstanceOf(
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
