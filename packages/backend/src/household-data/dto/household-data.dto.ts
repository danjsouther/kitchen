import { IsArray, IsIn, IsInt, IsObject, IsOptional, IsString } from 'class-validator';

import { EXPORT_FORMAT, SCHEMA_VERSION } from '../household-data.constants';

/**
 * Validates only the envelope shell — `exportFormat`/`schemaVersion` plus that
 * every section is the right JSON *kind*. What is actually inside each section
 * is the service's job to validate row by row as it inserts, because that is
 * also where an actionable "which row, which field" error comes from. Hand-
 * modelling every nested Recipe/PantryItem shape a second time here would just
 * be the Prisma schema restated in class-validator, with no extra safety.
 */
export class ImportHouseholdDto {
  @IsIn([EXPORT_FORMAT], { message: `exportFormat must be "${EXPORT_FORMAT}".` })
  exportFormat!: string;

  @IsInt({ message: `schemaVersion must be an integer (this build supports ${SCHEMA_VERSION}).` })
  schemaVersion!: number;

  @IsOptional()
  @IsString()
  exportedOn?: string;

  @IsOptional()
  @IsString()
  householdName?: string;

  @IsArray()
  storageLocations!: unknown[];

  @IsObject()
  catalog!: { units: unknown[]; ingredients: unknown[] };

  @IsArray()
  tags!: unknown[];

  @IsArray()
  recipes!: unknown[];

  @IsArray()
  stores!: unknown[];

  @IsArray()
  pantryItems!: unknown[];

  @IsArray()
  pantryPars!: unknown[];

  @IsArray()
  plannedMeals!: unknown[];

  @IsArray()
  cookSessions!: unknown[];

  @IsArray()
  shoppingLists!: unknown[];

  @IsArray()
  receiveSessions!: unknown[];

  @IsArray()
  pantryTransactions!: unknown[];

  @IsArray()
  priceObservations!: unknown[];

  @IsArray()
  productBindings!: unknown[];
}
