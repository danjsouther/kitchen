import { Global, Module } from '@nestjs/common';

import {
  PrismaService,
  TENANT_PRISMA,
  createTenantClient,
} from './prisma.service';

/**
 * Global so feature modules can inject the scoped client without importing this
 * module everywhere. Both clients are exported, but `TENANT_PRISMA` is the one
 * feature code should use — `PrismaService` skips tenancy filtering.
 */
@Global()
@Module({
  providers: [
    PrismaService,
    {
      provide: TENANT_PRISMA,
      useFactory: createTenantClient,
      inject: [PrismaService],
    },
  ],
  exports: [PrismaService, TENANT_PRISMA],
})
export class PrismaModule {}
