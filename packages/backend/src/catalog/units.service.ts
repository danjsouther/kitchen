import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { UnitDef } from '@recipes/shared-types';

import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.service';
import type { CreateUnitDto } from './dto/catalog.dto';

/** A unit as stored, including the fields the conversion engine needs. */
export interface UnitRow {
  id: number;
  householdId: number | null;
  name: string;
  plural: string;
  abbrev: string | null;
  kind: string;
  toBaseFactor: { toString(): string };
}

@Injectable()
export class UnitsService {
  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantPrisma) {}

  /**
   * Every unit this household can use: the seeded global set plus its own.
   * Ordered by kind then name so a picker groups sensibly without client sorting.
   */
  list() {
    return this.db.unit.findMany({ orderBy: [{ kind: 'asc' }, { name: 'asc' }] });
  }

  /**
   * Adds a household-private unit.
   *
   * The name is checked against everything *visible* — global rows included —
   * rather than only the household's own. A second "cup" that converts
   * differently is the kind of thing that produces a wrong number months later,
   * with no clue where it came from.
   */
  async create(dto: CreateUnitDto) {
    const name = dto.name.trim();

    const clash = await this.db.unit.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true, householdId: true },
    });
    if (clash) {
      throw new ConflictException(
        clash.householdId === null
          ? `"${name}" is already a standard unit.`
          : `You already have a unit called "${name}".`,
      );
    }

    return this.db.unit.create({
      data: {
        name,
        plural: dto.plural.trim(),
        abbrev: dto.abbrev?.trim() || null,
        kind: dto.kind,
        toBaseFactor: dto.toBaseFactor,
      } as never,
    });
  }

  /**
   * Loads the given unit ids, failing if any is not visible to this household.
   *
   * Recipes, pantry lots and shopping lines all reference units by id from
   * client input, so this is the shared gate that stops a request naming a unit
   * from another household — or one that simply does not exist, which would
   * otherwise surface as an opaque foreign-key error.
   */
  async resolve(ids: readonly number[]): Promise<Map<number, UnitDef>> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return new Map();

    const rows = await this.db.unit.findMany({ where: { id: { in: wanted } } });

    const missing = wanted.filter((id) => !rows.some((row) => row.id === id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Unknown unit ${missing.length === 1 ? 'id' : 'ids'}: ${missing.join(', ')}.`,
      );
    }

    return new Map(rows.map((row) => [row.id, toUnitDef(row)]));
  }
}

/**
 * Converts a stored unit into the shape the pure conversion engine expects.
 * `toBaseFactor` crosses as a string so the Decimal is reconstructed exactly
 * rather than passing through a float.
 */
export function toUnitDef(row: {
  id: number;
  name: string;
  kind: string;
  toBaseFactor: { toString(): string };
}): UnitDef {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as UnitDef['kind'],
    toBaseFactor: row.toBaseFactor.toString(),
  };
}
