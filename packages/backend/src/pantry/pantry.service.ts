import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { TxKind, type UnitDef } from '@recipes/shared-types';

import { IngredientsService } from '../catalog/ingredients.service';
import { UnitsService, toUnitDef } from '../catalog/units.service';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.service';
import { planDeduction } from './deduction';
import { balanceFor, type BalanceLot, shortfallAgainstPar } from './pantry-balance';
import type {
  ConsumeDto,
  CreatePantryItemDto,
  PantryQueryDto,
  SetParsDto,
  UpdatePantryItemDto,
} from './dto/pantry.dto';

/** A lot with everything needed to convert, label and date it. */
const LOT_INCLUDE = {
  unit: true,
  location: { select: { id: true, name: true, sortOrder: true } },
  ingredient: {
    select: {
      id: true,
      name: true,
      slug: true,
      gramsPerMl: true,
      gramsPerPiece: true,
      defaultUnitId: true,
      shelfLifeDays: true,
    },
  },
} as const;

type LotRow = {
  id: number;
  quantity: Decimal;
  expiresOn: Date | null;
  unit: { id: number; name: string; plural: string; abbrev: string | null; kind: string; toBaseFactor: Decimal };
  ingredient: { id: number; name: string; gramsPerMl: Decimal | null; gramsPerPiece: Decimal | null; defaultUnitId: number | null };
};

@Injectable()
export class PantryService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly units: UnitsService,
    private readonly ingredients: IngredientsService,
  ) {}

  // -- Lots ----------------------------------------------------------------

  async list(query: PantryQueryDto) {
    const where: Record<string, unknown> = {};
    if (query.locationId) where.locationId = query.locationId;
    if (query.ingredientId) where.ingredientId = query.ingredientId;
    if (query.expiringWithinDays !== undefined) {
      where.expiresOn = { not: null, lte: daysFromNow(query.expiringWithinDays) };
    }

    const lots = await this.db.pantryItem.findMany({
      where,
      include: LOT_INCLUDE,
      orderBy: [{ expiresOn: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    });

    return lots.map((lot) => ({ ...lot, expiry: expiryStatus(lot.expiresOn) }));
  }

  async findOne(id: number) {
    const lot = await this.db.pantryItem.findFirst({ where: { id }, include: LOT_INCLUDE });
    if (!lot) throw new NotFoundException(`No pantry item with id ${id}.`);
    return { ...lot, expiry: expiryStatus(lot.expiresOn) };
  }

  /**
   * Adds a lot and records the intake on the ledger in one transaction.
   *
   * The two must not be able to drift apart: a lot with no matching ledger entry
   * is a quantity nobody can explain, and undoing a cook depends on the ledger
   * being a complete account of how the pantry reached its current state.
   */
  async create(dto: CreatePantryItemDto, userId: number) {
    const quantity = this.parsePositive(dto.quantity, 'quantity');
    const [ingredient] = await Promise.all([
      this.requireIngredient(dto.ingredientId),
      this.units.resolve([dto.unitId]),
    ]);
    await this.requireLocation(dto.locationId);

    // An unset expiry falls back to the ingredient's shelf life; an explicit null
    // means "this does not expire" and is left alone.
    const expiresOn =
      dto.expiresOn === undefined
        ? shelfLifeExpiry(ingredient.shelfLifeDays)
        : dto.expiresOn === null
          ? null
          : new Date(dto.expiresOn);

    return this.db.$transaction(async (tx) => {
      const lot = await tx.pantryItem.create({
        data: {
          ingredientId: dto.ingredientId,
          locationId: dto.locationId,
          quantity,
          unitId: dto.unitId,
          brand: dto.brand?.trim() || null,
          openedOn: dto.openedOn ? new Date(dto.openedOn) : null,
          expiresOn,
          note: dto.note?.trim() || null,
        } as never,
        include: LOT_INCLUDE,
      });

      await tx.pantryTransaction.create({
        data: {
          pantryItemId: lot.id,
          ingredientId: dto.ingredientId,
          delta: quantity,
          unitId: dto.unitId,
          kind: TxKind.PURCHASE,
          createdById: userId,
        } as never,
      });

      return { ...lot, expiry: expiryStatus(lot.expiresOn) };
    });
  }

  /**
   * Edits a lot, recording any quantity movement as an ADJUST.
   *
   * A change of unit is recorded as two entries — the whole old amount out in the
   * old unit, the whole new amount in in the new one. Writing a single delta
   * would mean subtracting grams from cups, and the ledger has to stay arithmetic
   * that adds up within each unit.
   */
  async update(id: number, dto: UpdatePantryItemDto, userId: number) {
    const existing = await this.db.pantryItem.findFirst({
      where: { id },
      select: { id: true, ingredientId: true, quantity: true, unitId: true },
    });
    if (!existing) throw new NotFoundException(`No pantry item with id ${id}.`);

    if (dto.unitId !== undefined) await this.units.resolve([dto.unitId]);
    if (dto.locationId !== undefined) await this.requireLocation(dto.locationId);

    const newQuantity =
      dto.quantity !== undefined
        ? this.parseNonNegative(dto.quantity, 'quantity')
        : existing.quantity;
    const newUnitId = dto.unitId ?? existing.unitId;

    const data: Record<string, unknown> = {};
    if (dto.quantity !== undefined) data.quantity = newQuantity;
    if (dto.unitId !== undefined) data.unitId = dto.unitId;
    if (dto.locationId !== undefined) data.locationId = dto.locationId;
    if (dto.brand !== undefined) data.brand = dto.brand?.trim() || null;
    if (dto.note !== undefined) data.note = dto.note?.trim() || null;
    if (dto.openedOn !== undefined) {
      data.openedOn = dto.openedOn ? new Date(dto.openedOn) : null;
    }
    if (dto.expiresOn !== undefined) {
      data.expiresOn = dto.expiresOn ? new Date(dto.expiresOn) : null;
    }

    const ledger = adjustmentEntries({
      before: { quantity: new Decimal(existing.quantity), unitId: existing.unitId },
      after: { quantity: new Decimal(newQuantity), unitId: newUnitId },
    });

    return this.db.$transaction(async (tx) => {
      const lot = await tx.pantryItem.update({
        where: { id },
        data: data as never,
        include: LOT_INCLUDE,
      });

      for (const entry of ledger) {
        await tx.pantryTransaction.create({
          data: {
            pantryItemId: id,
            ingredientId: existing.ingredientId,
            delta: entry.delta.toString(),
            unitId: entry.unitId,
            kind: TxKind.ADJUST,
            note: dto.reason?.trim() || null,
            createdById: userId,
          } as never,
        });
      }

      return { ...lot, expiry: expiryStatus(lot.expiresOn) };
    });
  }

  /**
   * Throws a lot away, recording what was left as a DISCARD.
   *
   * The ledger entry outlives the lot: `pantryItemId` becomes null when the row
   * goes, but the ingredient, amount and reason survive, so a balance history
   * still adds up after a clear-out.
   */
  async remove(id: number, reason: string | undefined, userId: number) {
    const lot = await this.db.pantryItem.findFirst({
      where: { id },
      select: { id: true, ingredientId: true, quantity: true, unitId: true },
    });
    if (!lot) throw new NotFoundException(`No pantry item with id ${id}.`);

    return this.db.$transaction(async (tx) => {
      const remaining = new Decimal(lot.quantity);
      if (remaining.gt(0)) {
        await tx.pantryTransaction.create({
          data: {
            pantryItemId: lot.id,
            ingredientId: lot.ingredientId,
            delta: remaining.negated().toString(),
            unitId: lot.unitId,
            kind: TxKind.DISCARD,
            note: reason?.trim() || null,
            createdById: userId,
          } as never,
        });
      }

      await tx.pantryItem.delete({ where: { id } });
      return { id, discarded: remaining.toString() };
    });
  }

  // -- Balances ------------------------------------------------------------

  /**
   * On-hand totals per ingredient, each in a single unit.
   *
   * One query for every lot, then the maths in memory. At household scale this is
   * comfortably faster than a query per ingredient, and it is the same shape the
   * "what can I cook" screen needs later.
   */
  async balances() {
    // Ordered explicitly: `chooseTargetUnit` falls back to the first lot's unit
    // when no unit is more common than the others, so an unordered query would
    // let the same pantry report itself in cups one call and grams the next.
    const lots = (await this.db.pantryItem.findMany({
      include: LOT_INCLUDE,
      orderBy: { id: 'asc' },
    })) as unknown as LotRow[];

    const byIngredient = new Map<number, LotRow[]>();
    for (const lot of lots) {
      const list = byIngredient.get(lot.ingredient.id);
      if (list) list.push(lot);
      else byIngredient.set(lot.ingredient.id, [lot]);
    }

    const defaultUnitIds = [
      ...new Set(
        [...byIngredient.values()]
          .map((group) => group[0].ingredient.defaultUnitId)
          .filter((id): id is number => id !== null),
      ),
    ];
    const defaultUnits = await this.units.resolve(defaultUnitIds);

    const results = [...byIngredient.entries()].map(([ingredientId, group]) => {
      const ingredient = group[0].ingredient;
      const physicals = {
        gramsPerMl: ingredient.gramsPerMl?.toString() ?? null,
        gramsPerPiece: ingredient.gramsPerPiece?.toString() ?? null,
      };
      const preferred = ingredient.defaultUnitId
        ? (defaultUnits.get(ingredient.defaultUnitId) ?? null)
        : null;

      const balance = balanceFor(toBalanceLots(group), physicals, preferred);

      return {
        ingredientId,
        ingredient: { id: ingredient.id, name: ingredient.name },
        total: balance.total?.toString() ?? null,
        unit: balance.unit,
        lotCount: balance.lotCount,
        unconvertible: balance.unconvertible,
      };
    });

    return results.sort((a, b) => a.ingredient.name.localeCompare(b.ingredient.name));
  }

  // -- Consumption ---------------------------------------------------------

  /**
   * Takes an amount out of the pantry, spanning lots oldest-expiry-first.
   *
   * Applies what the pantry can actually cover and reports the rest rather than
   * refusing outright or driving a lot negative: if the record says 200 g and the
   * cook used 500 g, the 200 g really did leave the shelf, and the 300 g gap is
   * information the user needs rather than a reason to reject the whole request.
   */
  async consume(dto: ConsumeDto, userId: number) {
    const quantity = this.parsePositive(dto.quantity, 'quantity');
    const ingredient = await this.requireIngredient(dto.ingredientId);
    const unitMap = await this.units.resolve([dto.unitId]);
    const unit = unitMap.get(dto.unitId)!;

    const lots = (await this.db.pantryItem.findMany({
      where: { ingredientId: dto.ingredientId },
      include: LOT_INCLUDE,
      orderBy: { id: 'asc' },
    })) as unknown as LotRow[];

    const plan = planDeduction({ quantity, unit }, toBalanceLots(lots), {
      gramsPerMl: ingredient.gramsPerMl?.toString() ?? null,
      gramsPerPiece: ingredient.gramsPerPiece?.toString() ?? null,
    });

    await this.db.$transaction(async (tx) => {
      for (const allocation of plan.allocations) {
        const lot = lots.find((l) => l.id === allocation.lotId)!;

        await tx.pantryItem.update({
          where: { id: allocation.lotId },
          data: { quantity: allocation.remaining.toString() } as never,
        });

        await tx.pantryTransaction.create({
          data: {
            pantryItemId: allocation.lotId,
            ingredientId: dto.ingredientId,
            delta: allocation.take.negated().toString(),
            unitId: lot.unit.id,
            kind: TxKind.CONSUME,
            note: dto.note?.trim() || null,
            createdById: userId,
          } as never,
        });
      }
    });

    return {
      requested: quantity,
      unit,
      applied: plan.allocated.toString(),
      shortfall: plan.shortfall.toString(),
      allocations: plan.allocations.map((a) => ({
        lotId: a.lotId,
        took: a.take.toString(),
        remaining: a.remaining.toString(),
      })),
      // Named, not hidden: these lots need a density or piece weight before the
      // maths can reach them.
      unusable: plan.unusable,
    };
  }

  // -- Pars ----------------------------------------------------------------

  /** Par levels with each ingredient's current shortfall, if it can be computed. */
  async listPars() {
    const [pars, balances] = await Promise.all([
      this.db.pantryPar.findMany({
        include: {
          unit: true,
          ingredient: {
            select: { id: true, name: true, gramsPerMl: true, gramsPerPiece: true },
          },
        },
      }),
      this.balances(),
    ]);

    const balanceByIngredient = new Map(balances.map((b) => [b.ingredientId, b]));

    return pars.map((par) => {
      const balance = balanceByIngredient.get(par.ingredientId);
      const physicals = {
        gramsPerMl: par.ingredient.gramsPerMl?.toString() ?? null,
        gramsPerPiece: par.ingredient.gramsPerPiece?.toString() ?? null,
      };

      const shortfall = shortfallAgainstPar(
        {
          total: balance?.total ? new Decimal(balance.total) : null,
          unit: (balance?.unit as UnitDef | null) ?? null,
          lotCount: balance?.lotCount ?? 0,
          unconvertible: [],
        },
        { quantity: par.minQuantity, unit: toUnitDef(par.unit) },
        physicals,
      );

      return {
        ...par,
        onHand: balance?.total ?? null,
        onHandUnit: balance?.unit ?? null,
        // null means "cannot tell", which is deliberately not the same as false.
        below: shortfall === null ? null : shortfall.short,
        shortBy: shortfall?.short ? shortfall.by.toString() : null,
      };
    });
  }

  /** Replaces the par list wholesale — the settings screen sends what it shows. */
  async setPars(dto: SetParsDto) {
    const ingredientIds = dto.pars.map((par) => par.ingredientId);
    const duplicate = ingredientIds.find(
      (id, index) => ingredientIds.indexOf(id) !== index,
    );
    if (duplicate !== undefined) {
      throw new BadRequestException(
        `Ingredient ${duplicate} appears twice; one par per ingredient.`,
      );
    }

    await this.ingredients.resolve(ingredientIds);
    await this.units.resolve(dto.pars.map((par) => par.unitId));

    for (const par of dto.pars) {
      this.parsePositive(par.minQuantity, 'minQuantity');
    }

    await this.db.$transaction(async (tx) => {
      await tx.pantryPar.deleteMany({
        where: { ingredientId: { notIn: ingredientIds.length ? ingredientIds : [0] } },
      });

      for (const par of dto.pars) {
        const existing = await tx.pantryPar.findFirst({
          where: { ingredientId: par.ingredientId },
          select: { id: true },
        });

        if (existing) {
          await tx.pantryPar.update({
            where: { id: existing.id },
            data: { minQuantity: par.minQuantity, unitId: par.unitId } as never,
          });
        } else {
          await tx.pantryPar.create({
            data: {
              ingredientId: par.ingredientId,
              minQuantity: par.minQuantity,
              unitId: par.unitId,
            } as never,
          });
        }
      }
    });

    return this.listPars();
  }

  // -- Ledger --------------------------------------------------------------

  history(ingredientId?: number, limit = 100) {
    return this.db.pantryTransaction.findMany({
      where: ingredientId ? { ingredientId } : {},
      include: {
        unit: { select: { id: true, name: true, abbrev: true } },
        ingredient: { select: { id: true, name: true } },
        createdBy: { select: { id: true, displayName: true } },
      },
      orderBy: { createdOn: 'desc' },
      take: Math.min(limit, 500),
    });
  }

  // -- Internals -----------------------------------------------------------

  private parsePositive(value: string, field: string): string {
    const amount = new Decimal(value);
    if (!amount.isFinite() || amount.lte(0)) {
      throw new BadRequestException(`${field} must be greater than zero.`);
    }
    return amount.toString();
  }

  private parseNonNegative(value: string, field: string): string {
    const amount = new Decimal(value);
    if (!amount.isFinite() || amount.lt(0)) {
      throw new BadRequestException(`${field} cannot be negative.`);
    }
    return amount.toString();
  }

  private async requireIngredient(id: number) {
    const found = await this.db.ingredient.findFirst({
      where: { id },
      select: {
        id: true,
        name: true,
        gramsPerMl: true,
        gramsPerPiece: true,
        shelfLifeDays: true,
      },
    });
    if (!found) throw new BadRequestException(`Unknown ingredient id: ${id}.`);
    return found;
  }

  private async requireLocation(id: number): Promise<void> {
    const found = await this.db.storageLocation.findFirst({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new BadRequestException(`Unknown storage location id: ${id}.`);
  }
}

// -- Pure helpers ----------------------------------------------------------

/**
 * The ledger entries a quantity or unit change should produce.
 *
 * Exported for tests: this is where a mistake would silently corrupt history
 * rather than fail loudly.
 */
export function adjustmentEntries(change: {
  before: { quantity: Decimal; unitId: number };
  after: { quantity: Decimal; unitId: number };
}): Array<{ delta: Decimal; unitId: number }> {
  const { before, after } = change;

  if (before.unitId === after.unitId) {
    const delta = after.quantity.minus(before.quantity);
    return delta.isZero() ? [] : [{ delta, unitId: after.unitId }];
  }

  // Different units: the whole old amount leaves in the old unit and the whole
  // new amount arrives in the new one. A single delta would be subtracting
  // grams from cups.
  const entries: Array<{ delta: Decimal; unitId: number }> = [];
  if (!before.quantity.isZero()) {
    entries.push({ delta: before.quantity.negated(), unitId: before.unitId });
  }
  if (!after.quantity.isZero()) {
    entries.push({ delta: after.quantity, unitId: after.unitId });
  }
  return entries;
}

/** Days-from-now as a date, used for expiry filters and shelf-life defaults. */
function daysFromNow(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

function shelfLifeExpiry(shelfLifeDays: number | null | undefined): Date | null {
  return shelfLifeDays ? daysFromNow(shelfLifeDays) : null;
}

/**
 * How urgent a lot is. Exported because the same thresholds drive the pantry
 * screen's colours and the expiry filter, and they must not drift apart.
 */
export const EXPIRY_SOON_DAYS = 7;

export function expiryStatus(
  expiresOn: Date | null,
  now = new Date(),
): 'none' | 'expired' | 'soon' | 'ok' {
  if (!expiresOn) return 'none';
  if (expiresOn.getTime() <= now.getTime()) return 'expired';

  const soonest = new Date(now);
  soonest.setDate(soonest.getDate() + EXPIRY_SOON_DAYS);
  return expiresOn.getTime() <= soonest.getTime() ? 'soon' : 'ok';
}

/** Narrows database rows to what the pure balance and deduction code needs. */
function toBalanceLots(lots: readonly LotRow[]): BalanceLot[] {
  return lots.map((lot) => ({
    id: lot.id,
    quantity: lot.quantity.toString(),
    unit: toUnitDef(lot.unit),
    expiresOn: lot.expiresOn,
  }));
}
