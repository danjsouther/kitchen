/**
 * Slug generation and normalisation.
 *
 * Slugs are the join key between free text and the ingredient catalog: the seed
 * loader derives them from names, and the paste-and-parse matcher derives them
 * from whatever the user pasted. Both must agree, which is why this lives in
 * shared-types rather than being reimplemented on each side.
 */

/**
 * Normalises a name into a slug: lowercase, accents stripped, punctuation
 * collapsed to single hyphens.
 *
 * @example slugify('Jalapeño Pepper')      // 'jalapeno-pepper'
 * @example slugify('All-Purpose Flour')    // 'all-purpose-flour'
 * @example slugify("Grandma's  Sauce!")    // 'grandmas-sauce'
 */
export function slugify(input: string): string {
  return input
    .normalize('NFD')
    // Strip combining diacritical marks so "jalapeño" and "jalapeno" agree.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Apostrophes vanish rather than becoming separators: "grandma's" -> "grandmas".
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Very small English singulariser, used only to widen ingredient matching
 * ("carrots" -> "carrot") before falling back to fuzzy search. It is deliberately
 * conservative: a wrong stem produces a bad match, and the parse review screen
 * exists precisely because matching is fallible.
 */
export function singularize(slug: string): string {
  if (slug.length <= 3) return slug;

  // Words that are already singular despite the trailing 's'.
  if (/(?:ss|us|is)$/.test(slug)) return slug;

  if (/ies$/.test(slug)) return slug.replace(/ies$/, 'y'); // berries -> berry
  if (/(?:ch|sh|x|z|s)es$/.test(slug)) return slug.replace(/es$/, ''); // peaches -> peach
  if (/oes$/.test(slug)) return slug.replace(/es$/, ''); // tomatoes -> tomato
  if (/ves$/.test(slug)) return slug.replace(/ves$/, 'f'); // loaves -> loaf
  if (/s$/.test(slug)) return slug.replace(/s$/, ''); // carrots -> carrot

  return slug;
}

/**
 * The candidate slugs to try when resolving free text to an ingredient, in
 * priority order and de-duplicated. Callers try each in turn before falling back
 * to trigram similarity.
 */
export function matchCandidates(input: string): string[] {
  const slug = slugify(input);
  const candidates = [slug, singularize(slug)];
  return [...new Set(candidates.filter(Boolean))];
}
