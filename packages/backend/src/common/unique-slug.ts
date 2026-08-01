import { slugify } from '@kitchen/shared-types';

/** Tried before giving up and falling back to a random suffix. */
const MAX_ATTEMPTS = 100;

/**
 * Finds a slug derived from `title` that no existing row is using.
 *
 * Slugs are what the URL bar shows, so two recipes both called "Chili" must not
 * fight over `/recipes/chili`. The second one becomes `chili-2`.
 *
 * `taken` is supplied by the caller rather than the query being written here,
 * because uniqueness is per household and only the caller's scoped client knows
 * which household that is. It should return true when the slug is already used
 * by a *different* row — passing the row's own id through lets a rename keep its
 * existing slug instead of gaining a pointless `-2`.
 */
export async function uniqueSlug(
  title: string,
  taken: (slug: string) => Promise<boolean>,
  fallback = 'untitled',
): Promise<string> {
  // A title of only punctuation or emoji slugifies to an empty string, which
  // would produce `/recipes/` and a unique-constraint collision on the next one.
  const base = slugify(title) || fallback;

  if (!(await taken(base))) return base;

  for (let suffix = 2; suffix <= MAX_ATTEMPTS; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!(await taken(candidate))) return candidate;
  }

  // A hundred recipes with the same title is implausible enough that the right
  // response is to stop scanning rather than to keep hammering the database.
  return `${base}-${Date.now().toString(36)}`;
}
