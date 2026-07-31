import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Locates the repo-root `.env` by walking up from this file.
 *
 * A fixed relative path is fragile here: the same code runs from `src/` under
 * ts-node and from `dist/src/` after a build, so any hard-coded `../../..` is
 * wrong in one of those cases — and the failure looks like a missing environment
 * variable rather than a missing file, which is a confusing thing to debug.
 */
export function findRepoEnv(startDir: string = __dirname): string | undefined {
  let dir = startDir;

  // Stop at the filesystem root, where dirname(dir) === dir.
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return undefined;
}
