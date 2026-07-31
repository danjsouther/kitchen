import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { HealthController } from './health/health.controller';
import { DecimalSerializerInterceptor } from './common/decimal-serializer.interceptor';
import { HouseholdContextMiddleware } from './common/household-context.middleware';
import { findRepoEnv } from './common/repo-env';
import { HouseholdsModule } from './households/households.module';
import { PantryModule } from './pantry/pantry.module';
import { ParserModule } from './parser/parser.module';
import { PlannerModule } from './planner/planner.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProductsModule } from './products/products.module';
import { RecipesModule } from './recipes/recipes.module';
import { ShoppingModule } from './shopping/shopping.module';
import { SuggestionsModule } from './suggestions/suggestions.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // One env file for the whole monorepo — the same one docker-compose mounts.
      envFilePath: findRepoEnv(),
    }),
    PrismaModule,
    AuthModule,
    CatalogModule,
    ParserModule,
    RecipesModule,
    PantryModule,
    PlannerModule,
    HouseholdsModule,
    SuggestionsModule,
    ShoppingModule,
    ProductsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: authenticate first, then check the role. Both are global so
    // that protection is the default and exemptions are explicit (`@Public()`).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // Global so no endpoint can forget it: an unserialized Decimal reaches the
    // client as the internals of the Decimal object, which is silently useless.
    { provide: APP_INTERCEPTOR, useClass: DecimalSerializerInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Opens the tenancy scope for every request, before any guard runs.
    consumer.apply(HouseholdContextMiddleware).forRoutes('*');
  }
}
