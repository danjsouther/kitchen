import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../generated/prisma/client';
import { tenancyExtension } from './tenancy';

/**
 * The raw client. Injecting this bypasses tenancy filtering entirely, so it is
 * reserved for the seeder, migrations and startup tasks. Feature code should
 * inject `TENANT_PRISMA` instead.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to Postgres');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

/**
 * Injection token for the household-scoped client.
 *
 * A single extended instance serves every request: the extension resolves the
 * active household from AsyncLocalStorage at query time rather than at
 * construction, so there is no need for a request-scoped provider.
 */
export const TENANT_PRISMA = Symbol('TENANT_PRISMA');

export function createTenantClient(prisma: PrismaService) {
  return prisma.$extends(tenancyExtension);
}

/** The scoped client's type, for injecting with `@Inject(TENANT_PRISMA)`. */
export type TenantPrisma = ReturnType<typeof createTenantClient>;
