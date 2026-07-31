// Prisma CLI configuration. The runtime client uses the PrismaPg driver adapter
// (see src/prisma/prisma.service.ts); the CLI needs the datasource URL here.
//
// DATABASE_URL is read from the repo-root .env so there is a single env file for
// the whole monorepo, matching what docker-compose mounts in production.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

const rootEnv = resolve(__dirname, '../../.env');
if (existsSync(rootEnv)) loadEnv({ path: rootEnv });

// Prisma 7 requires the connection URL here rather than in schema.prisma.
// That makes this file load-bearing for `migrate deploy` inside the container,
// which is why dotenv is a runtime dependency: pruning it would leave the
// production image unable to read its own Prisma config.
//
// In the container there is no repo-root .env to read; DATABASE_URL is injected
// by docker-compose instead, and the existsSync guard above makes that fine.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node prisma/seed/index.ts',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
